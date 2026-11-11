/**
 * Electron main process — Sprint 0 desktop shell.
 *
 * What it does (and deliberately nothing more): boots a hardened window, serves
 * the built renderer, answers the three allow-listed IPC channels, opens the
 * SQLite database through the migration runner, and writes structured logs.
 *
 * What it must NOT do in Sprint 0 (planning-document §六 STEP 6): no model calls,
 * no scheduler, no agent runtime, no workflow execution. There is no code path
 * here that reaches a network.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { resolveOpenAiCompatibleConfig } from './models/openai-compatible-provider.js';
import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from 'electron';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConsoleSink,
  createLogger,
  createRotatingFileSink,
  nullLogger,
  type Logger,
} from '@companyos/observability';
import { isMigrationFromNewerVersionError, openDurableDatabase, shippedMigrationNames, type DurableDatabase } from '@companyos/persistence';
import { DomainError, defineEvent } from '@companyos/core';
import { switchWorkspace } from './workspace-switch.js';
import {
  createStartupRecoveryOrchestrator,
  createDeterministicModelRouter,
  createHandoffService,
  createMemoryService,
  createDecisionService,
  createRouterApplicationService,
  ROUTER_TERMINAL_AUDIT_EVENT_TYPES,
  reconcileAndRepairRouterAudit,
  registryRevisionOf,
  verifyArtifactMemoryProvenance,
  verifyValidationMemoryProvenance,
} from '@companyos/engine';
import type { ModelRecord } from '@companyos/core';
import type { RouterAuditEmitter, RouterAuditPayload, HandoffAuditPayload } from '@companyos/engine';

import { composeCoreServices as composeCoreServicesImpl, lastCoreCompositionError, type ComposeCoreServicesOptions, type CoreServices } from './core-services.js';
import { createDesktopAutonomyRunner, type DesktopAutonomyRunner } from './autonomy/desktop-autonomy-runner.js';
import { recoveryFailurePolicy } from './startup-recovery-policy.js';
import { createRuntimeStarter } from './startup-runtime.js';
import {
  exportArtifactCopy,
  readArtifactPreview,
  resolveArtifactTarget,
} from './artifacts.js';
import { projectReadiness } from './readiness.js';
import { isDatabaseBootstrapRetryable } from './database-bootstrap-policy.js';
import {
  applyPendingDatabaseRestore,
  createDatabaseBackupScheduler,
  databaseBackupDir,
  databaseBackupSettings,
  preMigrationBackupHook,
  type DatabaseBackupScheduler,
} from './db-backup.js';
import { BRIDGE_KEY, CHANNELS, type DatabaseFailure, type DatabaseStatus, type PlatformInfo, type ServicesFailure } from './channels.js';
import { resolveRendererEntry, startupErrorUrl, type StartupErrorPage } from './renderer-entry.js';
import { productionCompositionOptions, productionIsolationResourcesDir, productionResourcesRoot } from './production-composition.js';
import { captureRuntimeEnv, createProviderRuntimeEnv, readProviderSetup, PROVIDER_SETUP_DIR, PROVIDER_SETUP_KEY_FILE } from './provider-setup.js';
import { loadProviderSetupDpapi, loadProviderSetupUnprotect } from './provider-setup-dpapi.js';
import { createProviderSettingsIpcHandler, createProviderSettingsService, providerSettingsConfirmText, providerSettingsFingerprint, type ProviderSettingsService } from './provider-settings.js';
import { parseProviderSetupProfile, PROVIDER_SETUP_PROFILE_FILE, type ProviderSetupProfile } from './provider-setup-write.js';
import { productionIsolationLaunchConfig } from './executor/isolation/isolation-status-runner.js';
import { createDeploymentBudgetProofSource, readDeploymentBudgetReadiness } from './deployment-budget-proof.js';
import { CSP, createWindowOptions, denyAllPermissions } from './security.js';
import { createWorkflowApi, type WorkflowApi } from './workflows.js';
import { createControlPlaneIpcHandler, neverReject } from './control-plane-ipc.js';
import { openArtifactFoundation, type ArtifactFoundation } from './artifact-stack.js';
import {
  clearPersistedSelection,
  isExistingDirectory,
  readPersistedSelection,
  writePersistedSelection,
} from './workspace-selection.js';

const mainDir = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let logger: Logger = nullLogger;
/** The single durable handle for the whole app (Sprint 6 carry-over). */
let shellDatabase: DurableDatabase | null = null;
let databaseError: string | null = null;
/** H12c: typed bootstrap failure surfaced through databaseStatus (never a raw stack). */
let databaseFailure: DatabaseFailure | null = null;
/**
 * Sprint 13 (Task-13-11): the reconciled artifact/CAS foundation. Built ONCE during
 * quiescent startup — BEFORE the window, the IPC handlers and the workflow API exist,
 * so reconciliation runs without concurrent artifact writes. A fatal integrity finding
 * fails startup closed, so a non-null value here proves the CAS was healthy when the
 * application surface was exposed.
 */
let artifactFoundation: Extract<ArtifactFoundation, { ok: true }> | null = null;
/**
 * DB-BACKUP (db-backup.ts, docs/hark-lane/DB_BACKUP.md): start / periodic snapshots of the
 * durable database into <userData>/backups. Created in main() before the first open; its
 * failures are diagnostics (databaseStatus.backup), never startup blockers.
 */
let backupScheduler: DatabaseBackupScheduler | null = null;
const DATABASE_FILE_NAME = 'companyos.sqlite';
const databaseDataDir = (): string => join(app.getPath('userData'), 'data');

function createAppLogger(): Logger {
  const logDir = join(app.getPath('userData'), 'logs');
  return createLogger({
    name: 'desktop',
    level: isDev ? 'debug' : 'info',
    sinks: [
      createConsoleSink(),
      createRotatingFileSink({ dir: logDir, fileName: 'desktop.log' }),
    ],
  });
}

/**
 * Boot the ONE durable database (Sprint 6 carry-over: previously the shell opened a
 * second handle without the workflow/provider chains, so two connections existed on the
 * same file and "single writer" rested on SQLite locking). All chains are enabled here,
 * so the shell status, the workflow governance and the provider registry share a single
 * connection and one transaction coordinator.
 *
 * A failure is reported, never fatal: the shell must open.
 */
function bootstrapDatabase(activeLogger: Logger): DurableDatabase | null {
  try {
    const dataDir = databaseDataDir();
    const backupKeep = backupScheduler?.status().keep ?? databaseBackupSettings(runtimeEnv).keep;
    const opened = openDurableDatabase({
      dataDir,
      fileName: DATABASE_FILE_NAME,
      appliedAt: new Date().toISOString(),
      // DB-BACKUP: existing data is snapshotted before any pending migration; a failed
      // snapshot aborts the open (typed OPEN_FAILED below) instead of migrating unprotected.
      beforeMigrations: preMigrationBackupHook({
        backupDir: databaseBackupDir(app.getPath('userData')),
        keep: backupKeep,
        logger: activeLogger,
        onSnapshot: (snapshot) => backupScheduler?.recordSnapshot(snapshot),
      }),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'router', 'handoff', 'memory', 'artifact', 'pack'],
      logger: activeLogger,
    });
    // AUDIT-D8: a database that opens (boot or retry) clears any earlier refusal.
    databaseError = null;
    databaseFailure = null;
    activeLogger.info('database ready', {
      path: opened.path,
      journalMode: opened.journalMode,
      schemaVersion: opened.migrations.core.currentVersion,
      chains: opened.chains,
      migrationsApplied:
        opened.migrations.core.applied.length +
        opened.migrations.engine.applied.length +
        (opened.migrations.lifecycle?.applied.length ?? 0) +
        (opened.migrations.provider?.applied.length ?? 0),
    });
    return opened;
  } catch (error) {
    databaseError = error instanceof Error ? error.message : String(error);
    databaseFailure = isMigrationFromNewerVersionError(error)
      ? { code: 'SCHEMA_FROM_NEWER_VERSION', unknownMigrations: [...error.unknownMigrations] }
      : { code: 'OPEN_FAILED', message: databaseError };
    activeLogger.error('database bootstrap failed', { error: databaseError, failure: databaseFailure.code });
    return null;
  }
}

/**
 * Workflow governance is a SECOND durable handle over the same SQLite file, because it
 * needs the checksum-protected `lifecycle` chain that the shell database does not carry.
 * Built lazily on the first Designer call: a failure is reported to the renderer instead
 * of killing the shell (the same rule as `bootstrapDatabase`).
 */
let workflowApi: WorkflowApi | null = null;
/** In-flight construction, so concurrent IPC calls share one bootstrap (Closeout-7.5 M-4). */
let workflowApiPending: Promise<WorkflowApi | null> | null = null;
let workflowError: string | null = null;

/**
 * The renderer never chooses who it is (Sprint 5 review MEDIUM-2). Every request gets the
 * main process's session actor stamped onto its payload, so the audit trail records the
 * session, not a client claim. V1 is single-user; a real sign-in replaces this later.
 *
 * DESKTOP RUNTIME FIX: this constant MUST equal the runtime composition's session actor
 * (core-services SESSION_ACTOR = 'user_owner', the single-user V1 session identity that
 * every authorize gate checks). Deriving it from USERNAME instead silently broke every
 * IPC request and startup recovery with POLICY_DENIED on any machine whose OS user is not
 * 'owner' — the real-boot smoke caught it. The env override remains the (future) sign-in
 * seam; the DEFAULT is the runtime's single actor, never an OS identity.
 */
const SESSION_ACTOR = process.env['COMPANYOS_ACTOR'] ?? 'user_owner';

/**
 * AUDIT-D3 — the PRIVATE runtime environment every composition reads (vault, model config,
 * attempt timeout). Captured at module load, and every secret-shaped name (the model API key,
 * COMPANYOS_*KEY/TOKEN/SECRET…) is removed from process.env at the same moment, so ShellExecute
 * (打开/链接), execFile without `env` and Chromium children never inherit a credential. The
 * H17a setup overlay is applied to this copy, never to process.env.
 */
let runtimeEnv: Readonly<Record<string, string | undefined>> = captureRuntimeEnv(process.env);
/** The single V1 company every desktop-created Goal belongs to (matches the renderer). */
const COMPANY_ID = 'company_default';

function withSessionActor(request: unknown): unknown {
  if (typeof request !== 'object' || request === null) return request;
  const record = request as { readonly operation?: unknown; readonly requestId?: unknown; readonly payload?: unknown };
  const payload =
    typeof record.payload === 'object' && record.payload !== null
      ? (record.payload as Record<string, unknown>)
      : {};
  return { ...record, payload: { ...payload, actorId: SESSION_ACTOR } };
}

async function ensureWorkflowApi(activeLogger: Logger): Promise<WorkflowApi | null> {
  if (workflowApi !== null) return workflowApi;
  // Single-flight (Closeout-7.5 MEDIUM-4): two concurrent IPC calls must not both bootstrap
  // the owner role. The first caller creates the promise, later ones await the same one.
  if (workflowApiPending !== null) return workflowApiPending;
  workflowApiPending = buildWorkflowApi(activeLogger).finally(() => {
    workflowApiPending = null;
  });
  return workflowApiPending;
}

/** The quiescent-startup core composition, reused by the workflow API (single instance). */
let coreServices: CoreServices | null = null;

/**
 * STAGE 2 — the desktop autonomy launcher. Created with the composition; exactly one
 * active driver per Goal run, and every non-terminal goal run is resumed on startup from
 * canonical durable truth (never from renderer memory).
 */
let autonomyRunner: DesktopAutonomyRunner | null = null;
/** AUDIT-E2: runs startup recovery could not recover (never driven in this process). */
const quarantinedRunIds = new Set<string>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function composeCoreServices(
  database: DurableDatabase,
  activeLogger: Logger,
  options: ComposeCoreServicesOptions,
): Promise<CoreServices | null> {
  const composed = await composeCoreServicesImpl(database, activeLogger, options);
  if (composed === null) {
    // AUDIT-D13: the UI shows the composition's own reason, not a generic "unavailable".
    workflowError = lastCoreCompositionError() ?? 'core services composition failed';
    return null;
  }
  if (composed.compositionError !== null) workflowError = composed.compositionError;
  return composed as CoreServices;
}

/**
 * AUDIT-D8 - the ONE startup sequence (startup-runtime.ts), shared by the boot and the lazy
 * workflow path. Module state (shellDatabase, artifactFoundation, coreServices, autonomyRunner)
 * is written only by these steps: the handle when it opens, the composition only after recovery.
 */
const runtimeStarter = createRuntimeStarter<DurableDatabase, Extract<ArtifactFoundation, { ok: true }>, CoreServices>({
  openDatabase: () => {
    const opened = bootstrapDatabase(logger);
    if (opened !== null) {
      shellDatabase = opened;
      // DB-BACKUP: the `start` snapshot (once per process, best effort) + the periodic timer.
      backupScheduler?.start();
    }
    return opened;
  },
  databaseRetryable: () => isDatabaseBootstrapRetryable(databaseFailure),
  // Sprint 13 (Task-13-11) - the CAS reconciliation gate runs in QUIESCENT STARTUP: no
  // artifact write can be in flight. Fatal integrity (CAS missing/hash/size mismatch, reparse
  // violation, chain disabled) fails startup CLOSED.
  openFoundation: async (database) => {
    const foundation = await openArtifactFoundation({
      // User-local, restart-stable, main-process-only: a sibling of the `data` (SQLite)
      // and `logs` directories under Electron's userData. Never cwd, never a temp dir,
      // never renderer/IPC/caller supplied.
      casRoot: join(app.getPath('userData'), 'artifacts'),
      database,
      logger,
    });
    if (!foundation.ok) {
      logger.error('startup failed: artifact CAS integrity is fatal', {
        casRoot: join(app.getPath('userData'), 'artifacts'),
        reason: foundation.error.code,
        detail: foundation.error.message,
        fatalFindings: foundation.report.fatal.length,
      });
      return { ok: false, code: foundation.error.code, message: foundation.error.message };
    }
    artifactFoundation = foundation;
    return { ok: true, value: foundation };
  },
  compose: async (database, foundation) =>
    composeCoreServices(database, logger, {
      artifactFoundation: foundation,
      // The ONE production wiring seam (BUG-BB-001 closeout): executor kinds, provider routing
      // and repository capability come from productionCompositionOptions() - the same function
      // the production-reachability tests exercise. A missing or unknown adapter fails loud at
      // dispatch, never a silent mock.
      ...productionCompositionOptions(runtimeEnv, deploymentBudgetOptions()),
      runtimeEnv,
      usageReconciliationDir: join(app.getPath('userData'), 'budget'),
      embeddedDshStateRoot: join(app.getPath('userData'), 'agent-kernel-state'),
      validatorTrustedStateRoot: app.getPath('userData'),
      embeddedDshIsolation: productionIsolationLaunchConfig({ resourcesDir: productionIsolationResourcesDir(), userDataDir: app.getPath('userData') }),
    }),
  // Sprint 14 (Task-14-02, ADR-0021): startup recovery - AFTER CAS integrity PASS, BEFORE any
  // exposure. Manual states (PAUSED / WAITING_* / INTERRUPTED awaiting humans) are reported,
  // never mutated.
  recover: async (database, core) => {
    const recovery = await createStartupRecoveryOrchestrator({
      actorId: SESSION_ACTOR,
      runtime: core.runtime,
      tools: core.tools,
      engine: core.sprint13.engine,
      runs: database.runs,
    }).run();
    if (recovery.ok) {
      logger.info('startup recovery complete', { ...recovery.value });
      return { kind: 'ok' };
    }
    // AUDIT-E2: runs the engine could not recover are quarantined (untouched, no driver),
    // every other recovery failure stays fatal.
    const policy = recoveryFailurePolicy(recovery.error);
    if (policy.kind === 'quarantine') {
      for (const runId of policy.runIds) quarantinedRunIds.add(runId);
      logger.error('startup recovery: runs could not be recovered; quarantined', {
        code: recovery.error.code,
        detail: recovery.error.message,
        runIds: policy.runIds,
      });
      void dialog.showMessageBox({
        type: 'warning',
        title: 'CompanyOS',
        message: `有 ${policy.runIds.length} 个运行在启动恢复时无法恢复，已保持原状且不会自动继续。`,
        detail: `${policy.runIds.join('\n')}\n\n其他目标照常运行。详情见日志 desktop.log。`,
      });
      return { kind: 'ok' };
    }
    logger.error('startup failed: recovery safety failure', {
      code: recovery.error.code,
      detail: recovery.error.message,
    });
    return { kind: 'fatal', code: recovery.error.code, message: recovery.error.message };
  },
  commit: (_database, _foundation, core) => {
    coreServices = core;
  },
  // ---- STAGE 2 autonomy resume (canonical, main-process-owned) ----
  // Every goal run that durable truth still shows as non-terminal gets its driver back. The
  // driver re-reads canonical state at every step (never renderer memory).
  startAutonomy: async (database, core) => {
    if (core.autonomyDriver === null) {
      logger.warn('autonomy driver not composed; manual advance remains required', {});
      return;
    }
    autonomyRunner = createDesktopAutonomyRunner({
      companyId: COMPANY_ID,
      driver: core.autonomyDriver,
      logger,
      quarantinedRunIds,
      goalRunState: async (runId: string) => {
        const row = await database.runs.get(runId);
        return row === null ? null : row.state;
      },
    });
    const resumed = await autonomyRunner.resumeNonTerminalGoalRuns(core);
    logger.info('autonomy resume complete', { resumedRuns: resumed.length, runIds: resumed });
  },
  // ---- DESKTOP STAGE 1 restart rehydration (operational context) ----
  // Re-open the persisted workspace when it still exists. A vanished directory is downgraded
  // to a cleared selection - the UI asks the user again; no hidden fallback directory.
  rehydrate: async (core) => {
    const persisted = readPersistedSelection(app.getPath('userData'));
    if (persisted === null) return;
    if (!isExistingDirectory(persisted.root)) {
      clearPersistedSelection(app.getPath('userData'));
      logger.warn('persisted workspace directory no longer exists; selection cleared', { root: persisted.root });
      return;
    }
    const reopened = await core.repositoryRuntime.openWorkspace({ root: persisted.root, commandProfile: {} });
    if (reopened.ok) logger.info('workspace rehydrated from persisted selection', { root: persisted.root });
    else logger.warn('persisted workspace failed to re-open', { root: persisted.root, code: reopened.error.code });
  },
  closeDatabase: (database) => {
    database.db.close();
    if (shellDatabase === database) shellDatabase = null;
    artifactFoundation = null;
  },
});

async function buildWorkflowApi(activeLogger: Logger): Promise<WorkflowApi | null> {
  try {
    // AUDIT-D8: the lazy path runs the SAME startup sequence as the boot (one database handle,
    // CAS reconcile, composition, recovery, autonomy, rehydrate), resuming at the first step
    // that has not succeeded yet; it never opens a second handle.
    const started = await runtimeStarter.start();
    if (started.kind !== 'ready') {
      if (started.kind === 'fatal') workflowError = `${started.code}: ${started.message}`;
      else if (started.stage === 'database') workflowError = databaseError ?? 'durable database unavailable';
      return null;
    }
    const core = started.core;
    const { database, clock, ids, authz, sessionAuthorize, providers, models, policies, tools, runtime, sprint13, durableReferenceResolver } = core;
    void sprint13;

    // ---- model router (Sprint 10B/10B.1): RECOMMENDS, audited durably, never executes ----------
    // The runtime above does NOT construct or call the router: model selection belongs to this
    // application layer, and the runtime still requires an explicit modelKey.
    // Audit: the six router.* events go to the DURABLE event store (payload whitelist unchanged -
    // metadata + reason codes only; never a whole RouterRequest/ModelRecommendation/prompt/secret).
    const routerAudit =
      (type: string) =>
      async (payload: RouterAuditPayload): Promise<void> => {
        await database.events.append([
          defineEvent(
            {
              type,
              aggregateId: payload.requestId,
              aggregateType: 'ModelRouter',
              traceId: payload.traceId,
              actorId: SESSION_ACTOR,
              payload: { ...payload },
            },
            ids,
            clock.nowIso(),
          ),
        ]);
      };
    const routerAuditEmitter: RouterAuditEmitter = {
      requested: routerAudit('router.requested'),
      candidatesBuilt: routerAudit('router.candidates_built'),
      recommendationCreated: routerAudit('router.recommendation_created'),
      noCandidate: routerAudit('router.no_candidate'),
      overrideRequested: routerAudit('router.override_requested'),
      overrideConfirmed: routerAudit('router.override_confirmed'),
    };
    // Registry revision + provider health come from the REAL services: content-derived revision,
    // and an unknown provider stays `unknown` (never silently healthy). No fabricated metadata.
    let registrySnapshot: readonly ModelRecord[] = await models.list({ includeDisabled: true });
    const providerHealth: Record<string, 'healthy' | 'degraded' | 'unknown'> = {};
    let providerHealthObservedAt = clock.now();
    const applyProviderHealth = async (): Promise<void> => {
      for (const providerId of providers.boundProviderIds()) {
        const report = await providers.health(providerId);
        const status = report.ok ? report.value.status : 'unknown';
        providerHealth[providerId] = status === 'healthy' ? 'healthy' : status === 'degraded' ? 'degraded' : 'unknown';
      }
      providerHealthObservedAt = clock.now();
    };
    await applyProviderHealth();
    // 10B.2 §十: the observation is timestamped; once it is stale the ranking degrades it to
    // `unknown` instead of pretending a startup snapshot is live health. It is re-observed on every
    // recommendation (listModels runs first), so the freshness window is a safety net, not a cap.
    const router = createDeterministicModelRouter({
      audit: routerAuditEmitter,
      clock,
      ids: { next: (prefix) => ids.id(prefix) },
      modelRegistryRevision: () => registryRevisionOf(registrySnapshot),
      rankingContext: () => ({ providerHealth, providerHealthObservedAt }),
      ...(database.routerDecisions === null ? {} : { decisions: database.routerDecisions }),
    });
    // ---- startup reconciliation (10B.2 §三/§四): decision+event are NOT atomic, so a crash can
    // leave a persisted decision without its `router.recommendation_created` event. This pass
    // finds those gaps and re-emits the event ONCE (idempotent: after the repair the event exists,
    // so the next start finds no gap).
    const reconcileRouterAuditOnStartup = async (): Promise<void> => {
      if (database.routerDecisions === null) return;
      const result = await reconcileAndRepairRouterAudit({
        listDecisions: () => database.routerDecisions?.listRecent(500) ?? Promise.resolve([]),
        listAuditedRequestIds: async () =>
          (await database.events.all())
            // BOTH terminal router event types: a NO_ELIGIBLE_MODEL decision emits `no_candidate`,
            // so counting only `recommendation_created` would create false gaps (review HIGH).
            .filter((stored) => (ROUTER_TERMINAL_AUDIT_EVENT_TYPES as readonly string[]).includes(stored.event.type))
            .map((stored) => stored.event.aggregateId),
        emitRepair: (payload, eventType) => routerAudit(eventType)(payload),
      });
      activeLogger.info('router audit reconciled', { decisions: result.decisions, repaired: result.repaired });
    };
    await reconcileRouterAuditOnStartup();
    // The application layer owns the request shape: the renderer can only ask for a scope.
    const routerService = createRouterApplicationService({
      policyView: ({ scopes, requiredCapabilities, actorId }) =>
        policies.routerPolicyView({ scopes, requiredCapabilities, actorId }),
      listModels: async () => {
        registrySnapshot = await models.list({ includeDisabled: true });
        // Re-observe provider health before every recommendation (10B.2 §十 review MEDIUM).
        await applyProviderHealth();
        return registrySnapshot;
      },
      router,
      // BLOCKER fix (review 10B.1): the override flow MUST write its two events durably.
      audit: routerAuditEmitter,
      scopes: (input) => [
        { scopeType: 'TASK' as const, scopeId: input.taskId },
        { scopeType: 'ROLE' as const, scopeId: input.roleId },
        ...(input.workflowId === undefined || input.workflowId === null
          ? []
          : [{ scopeType: 'WORKFLOW' as const, scopeId: input.workflowId }]),
        { scopeType: 'COMPANY' as const, scopeId: input.companyId },
      ],
    });
    // The router serves AUTO/HYBRID recommendations only; the runtime still needs an explicit key.
    activeLogger.info('model router ready', {
      routerVersion: router.policy.version,
      benchmarkWeightCap: router.policy.benchmarkWeightCap,
      stageOrder: router.policy.stageOrder.join(' → '),
      audit: 'durable',
    });
    void routerService;

    // ---- structured handoff (Sprint 11): production assembly + DURABLE audit -------------------
    // The handoff store is part of the production chain: if it is missing we FAIL LOUDLY instead of
    // silently running without handoff persistence.
    if (database.handoffStore === null) {
      throw new Error('The "handoff" migration chain is not enabled: handoff persistence is unavailable.');
    }
    const handoffAudit =
      (type: string) =>
      async (payload: HandoffAuditPayload): Promise<void> => {
        await database.events.append([
          defineEvent(
            {
              type,
              aggregateId: payload.handoffId,
              aggregateType: 'Handoff',
              traceId: payload.traceId,
              actorId: payload.actorId,
              payload: { ...payload },
            },
            ids,
            clock.nowIso(),
          ),
        ]);
      };
    const handoffService = createHandoffService({
      store: database.handoffStore,
      clock,
      authorize: ({ actorId, authority }) => authz.decide({ actorId, authority }),
      // TRUSTED roles: derived from the authorization service, never from the caller.
      actorRoleIds: async (actorId) => (await authz.assignmentsOf(actorId)).map((assignment) => assignment.roleId),
      // Sprint 13 (Task-13-09/11): handoff artifact/validation refs resolve durably
      // before the draft is persisted.
      durableReferenceResolver,
      audit: {
        created: handoffAudit('handoff.created'),
        ready: handoffAudit('handoff.ready'),
        accepted: handoffAudit('handoff.accepted'),
        rejected: handoffAudit('handoff.rejected'),
        superseded: handoffAudit('handoff.superseded'),
        cancelled: handoffAudit('handoff.cancelled'),
      },
    });
    activeLogger.info('handoff service ready', { durable: true });

    if (database.memories === null || database.decisions === null) throw new Error('The "memory" migration chain is not enabled.');
    const memoryAudit = async (type: string, payload: any): Promise<void> => {
      const safePayload = { memoryId: payload.memoryId, version: payload.version, actorId: payload.actorId, scope: payload.scope, kind: payload.kind, status: payload.status, sourceType: payload.sourceType, traceId: payload.traceId };
      await database.events.append([defineEvent({ type, aggregateId: payload.memoryId, aggregateType: 'Memory', traceId: payload.traceId, actorId: payload.actorId, payload: safePayload }, ids, clock.nowIso())]);
    };
    const decisionAudit = async (type: string, payload: any): Promise<void> => {
      const safePayload = { decisionId: payload.decisionId, version: payload.version, actorId: payload.actorId, status: payload.status, traceId: payload.traceId };
      await database.events.append([defineEvent({ type, aggregateId: payload.decisionId, aggregateType: 'Decision', traceId: payload.traceId, actorId: payload.actorId, payload: safePayload }, ids, clock.nowIso())]);
    };
    const provenance = {
      verify: async ({ sourceType, sourceRefs, companyId }: { sourceType: string; sourceRefs: readonly string[]; companyId: string }) => {
        if (sourceType === 'USER') return { ok: true as const, value: 'ASSERTED' as const };
        if (sourceType === 'SYSTEM' || sourceRefs.length === 0) return { ok: false as const, error: new DomainError('VALIDATION_FAILED', 'This provenance type requires a server-verified source reference.') };
        if (sourceType === 'HANDOFF') {
          const match = /^(.*)@v(\d+)$/.exec(sourceRefs[0] ?? '');
          if (!match || database.handoffStore === null) return { ok: false as const, error: new DomainError('VALIDATION_FAILED', 'Handoff provenance must include handoffId@vN.') };
          const packet = await database.handoffStore.get(match[1]!, Number(match[2]));
          if (packet === null || packet.companyId !== companyId || packet.status !== 'ACCEPTED') return { ok: false as const, error: new DomainError('VALIDATION_FAILED', 'Only an existing ACCEPTED handoff may be VERIFIED provenance.') };
          return { ok: true as const, value: 'VERIFIED' as const };
        }
        if (sourceType === 'DECISION') {
          const match = /^(.*)@v(\d+)$/.exec(sourceRefs[0] ?? '');
          if (!match) return { ok: false as const, error: new DomainError('VALIDATION_FAILED', 'Decision provenance must include decisionId@vN.') };
          const record = await database.decisions?.get(match[1]!, Number(match[2]));
          if (record === null || record === undefined || record.companyId !== companyId || !['ACTIVE','SUPERSEDED'].includes(record.status)) return { ok: false as const, error: new DomainError('VALIDATION_FAILED', 'Decision provenance reference is missing or not referenceable.') };
          return { ok: true as const, value: 'VERIFIED' as const };
        }
        if (sourceType === 'WORKFLOW') {
          const found = (await database.templates.list({ limit: 500 })).items.some(t => t.id === sourceRefs[0] && t.orgId === companyId);
          if (!found) return { ok: false as const, error: new DomainError('VALIDATION_FAILED', 'Workflow provenance reference does not exist.') };
          return { ok: true as const, value: 'VERIFIED' as const };
        }
        // Sprint 13 (Task-13-08, ADR-0015 D10): durable identity verification for the
        // two Sprint 13 source types. Stores are null until the composition root
        // enables the artifact chain (T11) — the helpers FAIL CLOSED on null, they
        // never treat "chain not wired" as verified. Identity only: no CAS/content
        // reads, no gate re-evaluation, no service calls.
        if (sourceType === 'ARTIFACT') {
          return verifyArtifactMemoryProvenance({ sourceRefs, artifactStore: database.artifactStore }) as never;
        }
        if (sourceType === 'VALIDATION') {
          return verifyValidationMemoryProvenance({ sourceRefs, validationStore: database.validationStore }) as never;
        }
        return { ok: false as const, error: new DomainError('VALIDATION_FAILED', 'Unsupported provenance source type for Sprint 12.') };
      },
    };
    const memory = createMemoryService({ store: database.memories, ids, clock, provenance, authorize: sessionAuthorize as any, transaction: database.unitOfWork.transaction.bind(database.unitOfWork) as any, audit: { emit: memoryAudit } });
    // Sprint 13 (Task-13-09/11): decision relatedArtifactRefs resolve durably against
    // the artifact store before the decision row is written (related refs only).
    const decision = createDecisionService({ store: database.decisions, ids, clock, authorize: sessionAuthorize as any, transaction: database.unitOfWork.transaction.bind(database.unitOfWork) as any, audit: { emit: decisionAudit }, durableReferenceResolver: durableReferenceResolver as any, artifactStore: database.artifactStore as any });

    workflowApi = createWorkflowApi({
      models,
      policies,
      // STAGE 2 — the model selector lists what a configured provider ACTUALLY offers.
      // Read from the durable `provider_models` snapshot: no provider call, no credential
      // ever leaves the main process, and an unconfigured provider answers an empty list.
      providerCatalogue: async () => {
        const rows = (await database.providerModels.list({ limit: 500 })).items;
        // LIVE-CONTRACT-FILL UI defect c: mark the deployment-configured model (read from the
        // PRIVATE runtime environment; only the boolean leaves the main process).
        const resolved = resolveOpenAiCompatibleConfig(runtimeEnv);
        const configured = resolved.ok ? resolved.value : null;
        // UI-AUDIT-2: rows of a provider that is not bound in this process (an earlier setup or
        // endpoint) are listed as such, never offered for a Goal.
        const core = coreServices;
        return rows.map((row) => ({
          configured: configured !== null && row.providerId === configured.providerId && row.modelId === configured.modelId,
          bound: core !== null && core.providers.get(row.providerId) !== null,
          metadata: row.metadata,
          providerId: row.providerId,
          modelId: row.modelId,
          displayName: row.displayName,
          contextWindow: row.contextWindow,
          maxOutputTokens: row.maxOutputTokens,
          capabilities: row.capabilities,
          pricing: row.pricing,
        }));
      },
      // UI-AUDIT-2 — the budget facts the composer needs before a Goal is sent.
      budgetReadiness: () => readDeploymentBudgetReadiness(join(app.getPath('userData'), 'budget'), deploymentBudgetLoaded),
      configuredModel: () => {
        const resolved = resolveOpenAiCompatibleConfig(runtimeEnv);
        return resolved.ok && resolved.value !== null ? { providerId: resolved.value.providerId, modelId: resolved.value.modelId } : null;
      },
      // STAGE 3 — the derived readiness projection. Computed from facts the trusted main
      // process already owns; the renderer never owns any of them.
      readiness: async () => {
        const core = coreServices;
        if (core === null) {
          return projectReadiness({
            providerRegistered: false,
            providerHealthy: false,
            providerDetail: '核心服务组合未就绪。',
            modelSelected: false,
            modelDetail: '核心服务组合未就绪。',
            executorConfigured: false,
            executorDetail: '核心服务组合未就绪。',
            workspaceOpen: false,
            workspaceDetail: '核心服务组合未就绪。',
          });
        }
        const registeredProviders = await core.providers.list();
        // PROVIDER-RECONCILE: a persisted row whose adapter is not bound in this process
        // (refused / not configured) is not a usable provider.
        const provider = registeredProviders.find((entry) => core.providers.get(entry.providerId) !== null) ?? null;
        const refusedAdapter = core.modelAdapterStatus.state === 'REFUSED' ? core.modelAdapterStatus : null;
        const health = provider === null ? null : await core.providers.health(provider.providerId).catch(() => null);
        const healthStatus = health === null || !health.ok ? 'unknown' : health.value.status;
        const policy = await policies.resolveFor([{ scopeType: 'COMPANY', scopeId: 'company_default' }]).catch(() => null);
        const modelKey =
          policy !== null && policy.manualModelKey !== null && policy.manualModelKey !== ''
            ? policy.manualModelKey
            : (policy?.preferredModels[0] ?? null);
        const workspace = core.repositoryRuntime.currentWorkspace();
        return projectReadiness({
          providerRegistered: provider !== null,
          providerHealthy: healthStatus === 'healthy',
          providerDetail:
            provider === null
              ? (refusedAdapter?.message ?? '尚未注册模型提供商（受信外部配置路径）。')
              : `${readinessProviderName(provider)} · ${READINESS_HEALTH_WORDS[healthStatus] ?? '连接状态未知'}`,
          modelSelected: typeof modelKey === 'string' && modelKey.length > 0,
          modelDetail:
            typeof modelKey === 'string' && modelKey.length > 0 ? `默认模型：${readinessModelName(modelKey)}` : '尚未选择默认模型。',
          // The executor route is PRODUCT configuration; when it cannot be resolved the
          // canonical external precondition is EXECUTOR_PROVIDER_UNKNOWN.
          executorConfigured: core.executorProviders !== null,
          executorDetail:
            core.executorProviders === null
              ? '执行器提供方未配置（COMPANYOS_EXECUTOR_PROVIDER）。'
              : '执行器提供方已配置。',
          workspaceOpen: workspace !== null,
          workspaceDetail: workspace === null ? '尚未打开工作空间。' : `工作空间 ${workspace.canonicalRoot}`,
        });
      },
      runtime,
      tools,
      router: routerService,
      handoff: handoffService,
      memory,
      decision,
      lifecycle: core.lifecycle,
      listTemplates: async () => (await database.templates.list({ limit: 500 })).items,
      // Real proposals, not a template list (Sprint 5 review MEDIUM-3).
      listProposals: async () => (await database.proposals.list({ limit: 500 })).items,
      // Production rule: every published stage must bind a role (review MEDIUM-1).
      defaultRequireRole: true,
      usageCounts: async () => {
        const runs = (await database.runs.list({ limit: 500 })).items;
        return runs.reduce<Record<string, number>>((accumulator, run) => {
          accumulator[run.templateId] = (accumulator[run.templateId] ?? 0) + 1;
          return accumulator;
        }, {});
      },
    });
    activeLogger.info('workflow governance ready', { chains: database.chains });
    return workflowApi;
  } catch (error) {
    workflowError = error instanceof Error ? error.message : String(error);
    activeLogger.error('workflow governance bootstrap failed', { error: workflowError });
    return null;
  }
}

/**
 * UI-AUDIT-2 — readiness detail strings are shown to the user verbatim; they carry the
 * provider's display name and a plain health word, never a raw provider id / status enum.
 */
const READINESS_HEALTH_WORDS: Readonly<Record<string, string>> = {
  healthy: '连接正常',
  degraded: '连接不稳定',
  unavailable: '暂时无法连接',
  unknown: '连接状态未知',
};

function readinessProviderName(provider: { readonly providerId: string; readonly displayName: string }): string {
  const name = provider.displayName.trim();
  return name.length > 0 && name !== provider.providerId ? name : '模型服务';
}

/** A model key is `<providerId>:<modelId>`; the user knows the model id they registered. */
function readinessModelName(modelKey: string): string {
  const index = modelKey.lastIndexOf(':');
  return index >= 0 && index < modelKey.length - 1 ? modelKey.slice(index + 1) : modelKey;
}

/**
 * H17a — the ordinary user's provider setup ("CompanyOS 首次配置", resources/setup). Applied to
 * the PRIVATE runtime environment (AUDIT-D3; never process.env) once, before any composition reads it; a deployment environment
 * that declares the model wins whole. The DPAPI binding is loaded only when a key file exists.
 * Logged by state and counts only — never a name of a secret, never a value.
 */
async function applyInstalledProviderSetup(): Promise<void> {
  const userData = app.getPath('userData');
  const keyExists = existsSync(join(userData, PROVIDER_SETUP_DIR, PROVIDER_SETUP_KEY_FILE));
  const dpapi = keyExists ? await loadProviderSetupUnprotect(productionResourcesRoot()) : { unprotect: null, detail: null };
  // UI-AUDIT-3: what this run applied, so 设置 → 模型服务 can tell the user a restart is needed.
  providerSetupAppliedFingerprint = providerSettingsFingerprint(userData);
  const applied = createProviderRuntimeEnv(runtimeEnv, readProviderSetup(userData, dpapi.unprotect));
  runtimeEnv = applied.runtimeEnv;
  const result = applied.result;
  providerSetupSource = result.source;
  logger.info('provider setup', {
    source: result.source,
    setupState: result.setupState,
    reasonCode: result.reasonCode,
    appliedCount: result.applied.length,
    ...(dpapi.detail === null ? {} : { unprotectDetail: dpapi.detail }),
  });
}

let providerSetupAppliedFingerprint = '';
let providerSetupSource: 'environment' | 'provider-setup' | 'none' = 'none';
let appWindow: BrowserWindow | null = null;

/** UI-AUDIT-3: the shipped preset (deployment data), installed beside the Start-menu helper; dev falls back to the repo copy. */
function readShippedProviderProfile(): ProviderSetupProfile | null {
  for (const path of [
    join(productionResourcesRoot(), 'setup', PROVIDER_SETUP_PROFILE_FILE),
    join(mainDir, '..', '..', '..', 'scripts', 'hark', 'setup', PROVIDER_SETUP_PROFILE_FILE),
  ]) {
    try {
      if (!existsSync(path)) continue;
      return parseProviderSetupProfile(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * UI-AUDIT-3 — 设置 → 模型服务, built on first use (the DPAPI binding loads only then). The
 * confirm is THIS process's native dialog on the app window: the only thing that can approve a
 * budget, remove the setup or restart. Logged by operation + result code only.
 */
let providerSettingsService: Promise<ProviderSettingsService> | null = null;
function providerSettings(): Promise<ProviderSettingsService> {
  providerSettingsService ??= (async () => {
    const dpapi = await loadProviderSetupDpapi(productionResourcesRoot());
    let approvedBy = 'user';
    try {
      approvedBy = userInfo().username || 'user';
    } catch { /* keep the fallback */ }
    return createProviderSettingsService({
      userDataDir: app.getPath('userData'),
      readShippedProfile: readShippedProviderProfile,
      protect: dpapi.protect,
      unprotect: dpapi.unprotect,
      environmentDeclared: providerSetupSource === 'environment',
      appliedFingerprint: providerSetupAppliedFingerprint,
      confirm: async (request) => {
        const text = providerSettingsConfirmText(request);
        const options = { type: request.kind === 'approve-budget' ? 'question' as const : 'warning' as const, title: 'CompanyOS', buttons: ['取消', text.confirmLabel], defaultId: 0, cancelId: 0, noLink: true, message: text.message, detail: text.detail };
        const answer = appWindow === null ? await dialog.showMessageBox(options) : await dialog.showMessageBox(appWindow, options);
        return answer.response === 1;
      },
      fetch: async (url, init) => net.fetch(url, init),
      approvedBy,
      relaunch: () => {
        app.relaunch();
        app.quit();
      },
      log: (message, fields) => logger.info(message, fields),
    });
  })();
  return providerSettingsService;
}

/**
 * H10 — the operator-attested budget (userData/budget). Read once per composition; with
 * no valid approval this returns {} and the fail-closed default admission stands.
 */
let deploymentBudgetLoaded = false;
function deploymentBudgetOptions(): { trustedBudgetProofs?: NonNullable<ReturnType<typeof createDeploymentBudgetProofSource>>['source']; budgetCap?: NonNullable<ReturnType<typeof createDeploymentBudgetProofSource>>['cap'] } {
  const deployment = createDeploymentBudgetProofSource(join(app.getPath('userData'), 'budget'));
  // UI-AUDIT-2: budget.readiness reports whether THIS composition took an approval.
  deploymentBudgetLoaded = deployment !== undefined;
  if (deployment === undefined) return {};
  logger.info('deployment budget approval loaded', {
    currency: deployment.source.currency,
    providerId: deployment.source.billingScope.providerId,
    maxCalls: deployment.cap.maxCalls,
    maxTokens: deployment.cap.maxTokens,
    maxCostMicros: deployment.cap.maxCostMicros,
  });
  return { trustedBudgetProofs: deployment.source, budgetCap: deployment.cap };
}

let controlPlaneIpcHandler: ((request: unknown) => Promise<unknown>) | null = null;
let controlPlaneIpcCore: CoreServices | null = null;
/** AUDIT-D7: one wrapper per composed core (single-flight approval resume lives in it). */
function controlPlaneIpc(core: CoreServices): (request: unknown) => Promise<unknown> {
  if (controlPlaneIpcHandler === null || controlPlaneIpcCore !== core) {
    controlPlaneIpcCore = core;
    controlPlaneIpcHandler = createControlPlaneIpcHandler({
      companyId: COMPANY_ID,
      handle: async (request) => core.controlPlane!.handle(request as never),
      autonomy: () => (autonomyRunner === null ? null : {
        start: (companyId: string, runId: string) => autonomyRunner?.start(companyId, runId),
        resumeNonTerminalGoalRuns: async () => (autonomyRunner === null ? [] : autonomyRunner.resumeNonTerminalGoalRuns(core)),
      }),
      logger,
    });
  }
  return controlPlaneIpcHandler;
}

/**
 * PROVIDER-RECONCILE / STARTUP-VISIBLE: what the renderer banner says when the core is not
 * fully usable. The database failure has its own typed banner, so it is not repeated here.
 */
function servicesFailure(): ServicesFailure | null {
  if (databaseFailure !== null) return null;
  if (coreServices === null) {
    return workflowError === null ? null : { code: 'CORE_SERVICES_UNAVAILABLE', message: workflowError };
  }
  const adapter = coreServices.modelAdapterStatus;
  if (adapter.state === 'REFUSED') {
    return { code: 'MODEL_PROVIDER_REFUSED', message: adapter.message ?? '模型提供商未启用。' };
  }
  return null;
}

function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.appVersion, (): string => app.getVersion());

  // ONE entry point for the Designer: every request is schema-validated inside the API.
  ipcMain.handle(
    CHANNELS.workflow,
    async (_event: unknown, request: unknown): Promise<unknown> => {
      const api = await ensureWorkflowApi(logger);
      if (api === null) {
        return {
          ok: false,
          operation: null,
          error: { code: 'PERSISTENCE_FAILED', message: workflowError ?? 'workflow service unavailable', details: {} },
        };
      }
      // AUDIT-D7/R7: never reject the renderer's invoke.
      return neverReject(async () => api.handle(withSessionActor(request)), 'WORKFLOW_HANDLER_FAILED', logger);
    },
  );

  // Sprint26 — the Goal-to-Outcome runtime: ONE channel, validated inside the trusted
  // control-plane service (schema + company scope + ownership + revision rules).
  ipcMain.handle(
    CHANNELS.controlPlane,
    async (_event: unknown, request: unknown): Promise<unknown> => {
      const api = await ensureWorkflowApi(logger);
      const core = api === null ? null : coreServices;
      if (core === null || core.controlPlane === null) {
        return {
          ok: false,
          error: {
            code: 'PERSISTENCE_FAILED',
            message: workflowError ?? 'control plane unavailable',
            details: { reason: 'CONTROL_PLANE_UNAVAILABLE' },
          },
        };
      }
      // STAGE 2 + AUDIT-D7: goal.create starts the Goal's autonomy driver, an approve resumes the
      // waiting Goals, and a throwing handler answers with the typed envelope (control-plane-ipc.ts).
      return controlPlaneIpc(core)(withSessionActor(request));
    },
  );

  ipcMain.handle(
    CHANNELS.platformInfo,
    (): PlatformInfo => ({
      platform: process.platform,
      arch: process.arch,
      electron: process.versions['electron'] ?? 'unknown',
      node: process.versions.node,
      chrome: process.versions['chrome'] ?? 'unknown',
    }),
  );

  ipcMain.handle(
    CHANNELS.databaseStatus,
    (): DatabaseStatus => ({
      path: shellDatabase?.path ?? null,
      journalMode: shellDatabase?.journalMode ?? null,
      schemaVersion: shellDatabase?.migrations.core.currentVersion ?? 0,
      failure: databaseFailure,
      backup: backupScheduler?.status() ?? null,
      services: servicesFailure(),
    }),
  );

  // ---- DESKTOP STAGE 1: workspace selection (OPERATIONAL CONTEXT, not truth) ----
  // The renderer asks; the main process drives the NATIVE chooser and the ONE trusted
  // repository-runtime open seam. The renderer never touches the filesystem itself.
  ipcMain.handle(CHANNELS.workspaceSelect, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select the CompanyOS workspace directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    CHANNELS.workspaceOpen,
    async (_event: unknown, root: unknown): Promise<{ ok: boolean; root: string; error?: string }> => {
      if (typeof root !== 'string' || root.trim() === '') {
        return { ok: false, root: '', error: 'WORKSPACE_PATH_REQUIRED' };
      }
      if (!isExistingDirectory(root)) {
        return { ok: false, root, error: 'WORKSPACE_DIRECTORY_NOT_FOUND' };
      }
      const core = await ensureWorkflowApi(logger).then(() => coreServices);
      if (core === null) {
        return { ok: false, root, error: workflowError ?? 'CORE_SERVICES_UNAVAILABLE' };
      }
      const opened = await core.repositoryRuntime.openWorkspace({ root, commandProfile: {} });
      if (!opened.ok) {
        return { ok: false, root, error: opened.error.code };
      }
      // Operational context only: remember WHICH directory the user chose so a
      // restart can re-offer it. Never canonical workflow truth.
      // AUDIT-D14: persist and return the CANONICAL root the engine bound, never the raw
      // renderer string (a case/trailing-separator/subst variant would later defeat the
      // workspaceSwitch identity check and turn a no-op re-affirm into close→reopen).
      const canonicalRoot = opened.value.canonicalRoot;
      writePersistedSelection(app.getPath('userData'), { root: canonicalRoot, selectedAt: new Date().toISOString() });
      logger.info('workspace opened', { root: canonicalRoot });
      return { ok: true, root: canonicalRoot };
    },
  );

  // BUG BASH closure — the canonical single-workspace CHANGE command. The engine refuses a
  // second open by design, so switching is THIS trusted close→open lifecycle (fail-closed:
  // on any refusal the previous workspace stays canonical). The renderer only updates its
  // display from the returned canonical root.
  ipcMain.handle(
    CHANNELS.workspaceSwitch,
    async (_event: unknown, root: unknown): Promise<{ ok: boolean; root: string; error?: string }> => {
      const core = await ensureWorkflowApi(logger).then(() => coreServices);
      if (core === null) {
        return { ok: false, root: typeof root === 'string' ? root : '', error: workflowError ?? 'CORE_SERVICES_UNAVAILABLE' };
      }
      const result = await switchWorkspace(
        {
          currentRoot: () => core.repositoryRuntime.currentWorkspace()?.canonicalRoot ?? null,
          canonicalize: (candidate) => {
            try {
              return realpathSync.native(candidate);
            } catch {
              return null;
            }
          },
          close: () => core.repositoryRuntime.closeWorkspace(),
          open: async (next) => {
            const opened = await core.repositoryRuntime.openWorkspace({ root: next, commandProfile: {} });
            return opened.ok ? { ok: true as const, value: { canonicalRoot: opened.value.canonicalRoot } } : { ok: false as const, error: opened.error };
          },
        },
        typeof root === 'string' ? root : '',
      );
      if (result.ok) {
        // Operational context only, exactly like workspaceOpen: WHICH directory the user
        // chose, so a restart can re-offer it. Never canonical workflow truth.
        writePersistedSelection(app.getPath('userData'), { root: result.root, selectedAt: new Date().toISOString() });
        logger.info('workspace switched', { root: result.root });
      } else {
        logger.warn('workspace switch refused', { root: result.root, error: result.error });
      }
      return result;
    },
  );

  ipcMain.handle(CHANNELS.workspaceCurrent, (): string | null => {
    const current = coreServices?.repositoryRuntime.currentWorkspace() ?? null;
    if (current !== null) return current.canonicalRoot;
    // Startup rehydration may not have run (composition failure); still surface the
    // persisted selection so the UI can offer to re-open it.
    const persisted = readPersistedSelection(app.getPath('userData'));
    return persisted !== null && isExistingDirectory(persisted.root) ? persisted.root : null;
  });

  // UI-AUDIT-3 — 设置 → 模型服务: only the app window's top frame; the key never comes back.
  const providerSettingsIpc = createProviderSettingsIpcHandler(
    { handle: async (operation, payload) => (await providerSettings()).handle(operation, payload) },
    (event) => {
      const e = event as { sender?: unknown; senderFrame?: unknown } | null;
      return appWindow !== null && e !== null && e.sender === appWindow.webContents && e.senderFrame === appWindow.webContents.mainFrame;
    },
  );
  ipcMain.handle(CHANNELS.providerSettings, async (event: unknown, request: unknown): Promise<unknown> => providerSettingsIpc(event, request));

  // STAGE 3 — the bounded artifact surface. The renderer names a canonical artifact id
  // and nothing else: every path is resolved here, inside the CAS root, and any action
  // that cannot be proven fails closed. No generic openAnyPath primitive exists.
  ipcMain.handle(CHANNELS.artifacts, async (_event: unknown, request: unknown): Promise<unknown> => {
    if (!isRecord(request)) {
      return { ok: false, code: 'ARTIFACT_REQUEST_INVALID', message: 'A typed artifact request is required.' };
    }
    const operation = request['operation'];
    const artifactId = request['artifactId'];
    if (
      (operation !== 'preview' && operation !== 'open' && operation !== 'reveal') ||
      typeof artifactId !== 'string'
    ) {
      return { ok: false, code: 'ARTIFACT_REQUEST_INVALID', message: 'Unknown artifact operation.' };
    }
    const core = coreServices;
    if (core === null || artifactFoundation === null) {
      return { ok: false, code: 'ARTIFACT_SURFACE_UNAVAILABLE', message: '产物表面不可用。' };
    }
    const target = await resolveArtifactTarget(
      artifactFoundation.casRoot,
      {
        get: async (id: string) => {
          const row = (await core.database.artifactStore?.get(id as never)) ?? null;
          if (row === null) return null;
          return {
            id: row.id,
            contentRef: row.contentRef,
            contentHash: row.contentHash,
            kind: row.kind,
            sizeBytes: row.sizeBytes,
          };
        },
      },
      artifactId,
    );
    if (!target.ok) return target;
    if (operation === 'reveal' || operation === 'open') {
      // AUDIT-D4: a hash-verified read-only copy, never the canonical CAS object.
      const copy = await exportArtifactCopy(target.value, artifactFoundation.contentStore, join(tmpdir(), 'companyos-open'));
      if (!copy.ok) return copy;
      if (operation === 'reveal') {
        shell.showItemInFolder(copy.value.path);
        return { ok: true, operation, artifactId };
      }
      const failure = await shell.openPath(copy.value.path);
      return failure === ''
        ? { ok: true, operation, artifactId }
        : { ok: false, code: 'ARTIFACT_OPEN_FAILED', message: failure };
    }
    const preview = await readArtifactPreview(target.value, artifactFoundation.contentStore);
    if (!preview.ok) return { ...preview, operation };
    return { ok: true, operation, value: preview.value };
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow(createWindowOptions(mainDir));
  appWindow = window;
  window.on('closed', () => {
    if (appWindow === window) appWindow = null;
  });

  // No new windows, ever: external links go to the OS browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The renderer may never navigate away from the app shell.
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      logger.warn('navigation blocked', { url });
    }
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // STARTUP-VISIBLE (renderer-entry.ts): a missing or failing renderer is answered with the
  // built-in error page - never an unhandled loadFile rejection and an empty window.
  const entry = resolveRendererEntry(mainDir, process.env, existsSync);
  const showStartupError = async (page: StartupErrorPage): Promise<void> => {
    logger.error('renderer unavailable; showing the built-in startup page', { ...page });
    try {
      await window.loadURL(startupErrorUrl(page));
    } catch (error) {
      logger.error('startup page failed to load', { error: error instanceof Error ? error.message : String(error) });
    }
    if (!window.isVisible()) window.show();
  };
  if (entry.kind === 'missing') {
    await showStartupError({ reason: 'RENDERER_MISSING', target: entry.path, detail: null, packaged: !isDev });
    return window;
  }
  try {
    if (entry.kind === 'dev-server') await window.loadURL(entry.url);
    else await window.loadFile(entry.path);
  } catch (error) {
    await showStartupError({
      reason: 'RENDERER_LOAD_FAILED',
      target: entry.kind === 'dev-server' ? entry.url : entry.path,
      detail: error instanceof Error ? error.message : String(error),
      packaged: !isDev,
    });
    return window;
  }

  logger.info('window ready', { bridge: BRIDGE_KEY, dev: isDev });
  return window;
}

/**
 * Serve the strict CSP on every response in packaged builds. Development keeps
 * the Vite dev-server defaults so HMR works (see PROJECT_HANDOFF known limitations).
 * AUDIT-D9: the packaged renderer is a file:// load, where this header is not delivered;
 * the same CSP is embedded as a <meta http-equiv> in the built index.html
 * (apps/renderer/vite.config.ts → csp.ts), which is what applies there.
 */
function applyContentSecurityPolicy(activeLogger: Logger): void {
  // AUDIT-D9: default-deny permission policy in every mode (Electron grants by default).
  denyAllPermissions(session.defaultSession);
  if (isDev) {
    activeLogger.warn('csp header injection skipped in development');
    return;
  }
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });
}

/**
 * DB-BACKUP — runs in quiescent startup, BEFORE the database is opened: builds the backup
 * scheduler and applies a staged restore (restore-request.json, written by
 * resources/setup/restore-database.mjs). The live database is closed by construction here;
 * the normal bootstrap then reopens the restored file. A refused restore keeps the current
 * database and is reported in the log, a dialog and databaseStatus.backup.lastRestore.
 */
function prepareDatabaseBackups(): void {
  const userData = app.getPath('userData');
  const settings = databaseBackupSettings(runtimeEnv);
  for (const warning of settings.warnings) logger.warn('database backup setting ignored', { warning });
  const backupDir = databaseBackupDir(userData);
  backupScheduler = createDatabaseBackupScheduler({
    sourcePath: () => shellDatabase?.path ?? null,
    backupDir,
    intervalMs: settings.intervalMs,
    keep: settings.keep,
    logger,
  });
  const restore = applyPendingDatabaseRestore({
    backupDir,
    livePath: join(databaseDataDir(), DATABASE_FILE_NAME),
    knownMigrationNames: shippedMigrationNames(),
    keep: settings.keep,
    logger,
  });
  if (restore.kind === 'none') return;
  backupScheduler.recordRestore(restore);
  if (restore.kind === 'refused') {
    void dialog.showMessageBox({
      type: 'warning',
      title: 'CompanyOS',
      message: '数据库恢复未执行，当前数据保持不变。',
      detail: `${restore.backup ?? ''}\n${restore.code}: ${restore.message}\n\n详情见日志 desktop.log。`,
    });
  }
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  await app.whenReady();
  logger = createAppLogger();
  logger.info('companyos desktop starting', {
    version: app.getVersion(),
    mode: isDev ? 'development' : 'production',
  });

  await applyInstalledProviderSetup();
  prepareDatabaseBackups();
  // Sprint 13/14 + AUDIT-D8: the quiescent startup sequence (DB -> CAS gate -> composition ->
  // recovery -> autonomy -> rehydrate) runs BEFORE any IPC handler / window exists. A fatal
  // finding fails startup CLOSED - never a partially healthy runtime.
  const started = await runtimeStarter.start();
  if (started.kind === 'fatal') {
    // AUDIT-D4: a fatal startup is never silent - the user sees why before the app exits.
    const what = started.stage === 'recovery' ? '启动恢复安全检查失败' : '产物存储完整性检查失败';
    dialog.showErrorBox('CompanyOS 无法启动', `${what}（${started.code}）：${started.message}\n\n详情见日志 desktop.log。`);
    app.exit(1);
    return;
  }
  if (started.kind === 'unavailable' && started.stage === 'composition') {
    // Composition failure keeps the frozen Sprint 5/6 shell rule: the window still opens and
    // the workflow surface reports the error; the lazy path retries the remaining steps.
    logger.error('core services composition failed; startup recovery skipped', { error: workflowError });
  }
  applyContentSecurityPolicy(logger);
  registerIpcHandlers();
  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });

  app.on('before-quit', () => {
    backupScheduler?.stop();
    shellDatabase?.db.close();
    logger.info('companyos desktop stopping', { databaseError });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

void main();

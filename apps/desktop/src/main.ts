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
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConsoleSink,
  createLogger,
  createRotatingFileSink,
  nullLogger,
  type Logger,
} from '@companyos/observability';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
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

import { composeCoreServices as composeCoreServicesImpl, type ComposeCoreServicesOptions, type CoreServices } from './core-services.js';
import { createDesktopAutonomyRunner, type DesktopAutonomyRunner } from './autonomy/desktop-autonomy-runner.js';
import {
  readArtifactPreview,
  resolveArtifactTarget,
} from './artifacts.js';
import { projectReadiness } from './readiness.js';
import { BRIDGE_KEY, CHANNELS, type DatabaseStatus, type PlatformInfo } from './channels.js';
import { productionCompositionOptions } from './production-composition.js';
import { createDeploymentBudgetProofSource } from './deployment-budget-proof.js';
import { CSP, createWindowOptions } from './security.js';
import { createWorkflowApi, type WorkflowApi } from './workflows.js';
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
/**
 * Sprint 13 (Task-13-11): the reconciled artifact/CAS foundation. Built ONCE during
 * quiescent startup — BEFORE the window, the IPC handlers and the workflow API exist,
 * so reconciliation runs without concurrent artifact writes. A fatal integrity finding
 * fails startup closed, so a non-null value here proves the CAS was healthy when the
 * application surface was exposed.
 */
let artifactFoundation: Extract<ArtifactFoundation, { ok: true }> | null = null;

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
    const dataDir = join(app.getPath('userData'), 'data');
    const opened = openDurableDatabase({
      dataDir,
      appliedAt: new Date().toISOString(),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'router', 'handoff', 'memory', 'artifact', 'pack'],
      logger: activeLogger,
    });
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
    activeLogger.error('database bootstrap failed', { error: databaseError });
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function composeCoreServices(
  database: DurableDatabase,
  activeLogger: Logger,
  options: ComposeCoreServicesOptions,
): Promise<CoreServices | null> {
  const composed = await composeCoreServicesImpl(database, activeLogger, options);
  if (composed === null) return null;
  if (composed.compositionError !== null) workflowError = composed.compositionError;
  return composed as CoreServices;
}

async function buildWorkflowApi(activeLogger: Logger): Promise<WorkflowApi | null> {  try {
    // ONE durable handle for the whole app (Sprint 6 carry-over): the shell opened it with
    // every chain enabled, so the workflow service and the provider registry share the
    // same connection and the same transaction coordinator.
    const opened: DurableDatabase | null = shellDatabase ?? bootstrapDatabase(activeLogger);
    if (opened === null) {
      workflowError = databaseError ?? 'durable database unavailable';
      return null;
    }
    // Sprint 14 (Task-14-02): the core services were composed during quiescent
    // startup (before recovery, before any exposure) whenever the database was up;
    // reuse that instance — one composition, one set of stores, no double registry.
    const core: CoreServices | null =
      coreServices !== null && coreServices.database === opened
        ? coreServices
        : await composeCoreServices(opened, activeLogger, {
            artifactFoundation,
            // The ONE production wiring seam (BUG-BB-001 closeout): executor kinds,
            // provider routing and repository capability come from
            // productionCompositionOptions() — the same function the
            // production-reachability tests exercise. The routed adapter id is a
            // deployment value (COMPANYOS_EXECUTOR_PROVIDER); a missing or unknown
            // adapter fails loud at dispatch, never a silent mock.
            ...productionCompositionOptions(process.env, deploymentBudgetOptions()),
          });
    if (core === null) return null;
    coreServices = core;
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
        return rows.map((row) => ({
          providerId: row.providerId,
          modelId: row.modelId,
          displayName: row.displayName,
          contextWindow: row.contextWindow,
          maxOutputTokens: row.maxOutputTokens,
          capabilities: row.capabilities,
          pricing: row.pricing,
        }));
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
        const provider = registeredProviders[0] ?? null;
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
              ? '尚未注册模型提供商（受信外部配置路径）。'
              : `提供商 ${provider.providerId} · 健康 ${healthStatus}`,
          modelSelected: typeof modelKey === 'string' && modelKey.length > 0,
          modelDetail:
            typeof modelKey === 'string' && modelKey.length > 0 ? `已选择 ${modelKey}` : '尚未选择公司模型。',
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
 * H10 — the operator-attested budget (userData/budget). Read once per composition; with
 * no valid approval this returns {} and the fail-closed default admission stands.
 */
function deploymentBudgetOptions(): { trustedBudgetProofs?: NonNullable<ReturnType<typeof createDeploymentBudgetProofSource>>['source']; budgetCap?: NonNullable<ReturnType<typeof createDeploymentBudgetProofSource>>['cap'] } {
  const deployment = createDeploymentBudgetProofSource(join(app.getPath('userData'), 'budget'));
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
      return api.handle(withSessionActor(request));
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
      // STAGE 2 — after a canonical Goal is created the main process starts its autonomy
      // driver, so the operator never has to press 继续 again. The renderer only asked for
      // the Goal; the loop below lives here, outside the untrusted renderer.
      const response = await core.controlPlane.handle(withSessionActor(request));
      if (
        autonomyRunner !== null &&
        isRecord(request) &&
        request['operation'] === 'goal.create' &&
        isRecord(response) &&
        response['ok'] === true &&
        isRecord(response['value']) &&
        typeof response['value']['runId'] === 'string'
      ) {
        autonomyRunner.start(COMPANY_ID, response['value']['runId'] as string);
      }
      return response;
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
      writePersistedSelection(app.getPath('userData'), { root, selectedAt: new Date().toISOString() });
      logger.info('workspace opened', { root });
      return { ok: true, root };
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
    if (operation === 'reveal') {
      shell.showItemInFolder(target.value.absolutePath);
      return { ok: true, operation, artifactId };
    }
    if (operation === 'open') {
      const failure = await shell.openPath(target.value.absolutePath);
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

  const devServerUrl = process.env['COMPANYOS_RENDERER_URL'];
  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(join(mainDir, '..', '..', 'renderer', 'dist', 'index.html'));
  }

  logger.info('window ready', { bridge: BRIDGE_KEY, dev: isDev });
  return window;
}

/**
 * Serve the strict CSP on every response in packaged builds. Development keeps
 * the Vite dev-server defaults so HMR works (see PROJECT_HANDOFF known limitations).
 */
function applyContentSecurityPolicy(activeLogger: Logger): void {
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

  shellDatabase = bootstrapDatabase(logger);
  // Sprint 13 (Task-13-11) — the CAS reconciliation gate runs in QUIESCENT STARTUP:
  // the window, the IPC handlers and the workflow API do not exist yet, so no artifact
  // write can be in flight. Fatal integrity (CAS missing/hash/size mismatch, reparse
  // violation, chain disabled) fails startup CLOSED — the window and the commands are
  // never exposed, so the application runtime cannot become "partially healthy".
  if (shellDatabase !== null) {
    const foundation = await openArtifactFoundation({
      // User-local, restart-stable, main-process-only: a sibling of the `data` (SQLite)
      // and `logs` directories under Electron's userData. Never cwd, never a temp dir,
      // never renderer/IPC/caller supplied.
      casRoot: join(app.getPath('userData'), 'artifacts'),
      database: shellDatabase,
      logger,
    });
    if (!foundation.ok) {
      logger.error('startup failed: artifact CAS integrity is fatal', {
        casRoot: join(app.getPath('userData'), 'artifacts'),
        reason: foundation.error.code,
        detail: foundation.error.message,
        fatalFindings: foundation.report.fatal.length,
      });
      shellDatabase.db.close();
      app.exit(1);
      return;
    }
    artifactFoundation = foundation;

    // Sprint 14 (Task-14-02, ADR-0021): quiescent startup recovery — AFTER CAS
    // integrity PASS, BEFORE any IPC handler / window / command exposure. The core
    // services are the SAME instances the normal runtime will reuse (no double
    // composition). A SAFETY FAILURE fails startup closed, exactly like a fatal CAS
    // finding: no partially healthy runtime. Manual states (PAUSED / WAITING_* /
    // INTERRUPTED awaiting humans) are reported, never mutated.
    const core = await composeCoreServices(shellDatabase, logger, {
      artifactFoundation,
      // The ONE production wiring seam (BUG-BB-001 closeout) — identical to the
      // workflow-API composition: this quiescent-startup instance is REUSED as the
      // product instance whenever the database was up at boot, so both sites must
      // carry the same wiring.
      ...productionCompositionOptions(process.env, deploymentBudgetOptions()),
    });
    if (core === null) {
      // Composition failure keeps the frozen Sprint 5/6 shell rule: the window may
      // still open and the workflow surface reports the error lazily. Recovery is
      // simply unavailable — there is nothing durable it could act on.
      logger.error('core services composition failed; startup recovery skipped', {
        error: workflowError,
      });
    } else {
      coreServices = core;
      const recovery = await createStartupRecoveryOrchestrator({
        actorId: SESSION_ACTOR,
        runtime: core.runtime,
        tools: core.tools,
        engine: core.sprint13.engine,
        runs: shellDatabase.runs,
      }).run();
      if (!recovery.ok) {
        logger.error('startup failed: recovery safety failure', {
          code: recovery.error.code,
          detail: recovery.error.message,
        });
        shellDatabase.db.close();
        app.exit(1);
        return;
      }
      logger.info('startup recovery complete', { ...recovery.value });

      // ---- STAGE 2 autonomy resume (canonical, main-process-owned) ----
      // Every goal run that durable truth still shows as non-terminal gets its driver
      // back. Nothing here reads renderer memory: the driver re-reads canonical state at
      // every step and stops on terminal success/failure, PAUSED, an approval/authority
      // decision, or a true external blocker.
      if (core.autonomyDriver !== null) {
        autonomyRunner = createDesktopAutonomyRunner({
          companyId: COMPANY_ID,
          driver: core.autonomyDriver,
          logger,
          goalRunState: async (runId: string) => {
            const row = await shellDatabase!.runs.get(runId);
            return row === null ? null : row.state;
          },
        });
        const resumed = await autonomyRunner.resumeNonTerminalGoalRuns(core);
        logger.info('autonomy resume complete', { resumedRuns: resumed.length, runIds: resumed });
      } else {
        logger.warn('autonomy driver not composed; manual advance remains required', {});
      }
    }

    // ---- DESKTOP STAGE 1 restart rehydration (operational context) ----
    // Re-open the persisted workspace when it still exists. The GOALS themselves are
    // durable canonical truth (nothing to rehydrate); only the directory binding is
    // restored here. A vanished directory is downgraded to a cleared selection — the
    // UI asks the user again; there is no hidden fallback to any other directory.
    const persisted = readPersistedSelection(app.getPath('userData'));
    if (persisted !== null && coreServices !== null) {
      if (isExistingDirectory(persisted.root)) {
        const reopened = await coreServices.repositoryRuntime.openWorkspace({
          root: persisted.root,
          commandProfile: {},
        });
        if (reopened.ok) {
          logger.info('workspace rehydrated from persisted selection', { root: persisted.root });
        } else {
          logger.warn('persisted workspace failed to re-open', { root: persisted.root, code: reopened.error.code });
        }
      } else {
        clearPersistedSelection(app.getPath('userData'));
        logger.warn('persisted workspace directory no longer exists; selection cleared', {
          root: persisted.root,
        });
      }
    }
  }
  applyContentSecurityPolicy(logger);
  registerIpcHandlers();
  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });

  app.on('before-quit', () => {
    shellDatabase?.db.close();
    logger.info('companyos desktop stopping', { databaseError });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

void main();

/**
 * `@companyos/persistence` durable layer (Sprint 3).
 *
 * Everything the Workflow Engine needs to survive a restart, wired to the Core ports:
 * `EntityStore<WorkflowRun|Task|Approval>`, `EventStorePort`, `CommandLedgerPort` and
 * `UnitOfWork`. The engine imports none of this — it only sees Core ports, and the
 * composition root (desktop app / tests) passes these implementations in.
 *
 * Two checksum-protected migration chains share one `schema_migrations` ledger:
 *   - `migrations/`         → core schema (Sprint 0, `0001_init`)
 *   - `migrations/engine/`  → engine durability schema (Sprint 3)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AgentExecution,
  AgentExecutionStatus,
  Approval,
  BenchmarkResult,
  ChangeProposal,
  CommandLedgerPort,
  EntityId,
  EntityStore,
  ExecutionBudgetStore,
  LogicalAlias,
  ModelRecord,
  ModelSelectionPolicy,
  ProviderModelRecord,
  ProviderRegistration,
  Role,
  RoleAssignment,
  RunSnapshot,
  SecretRef,
  Task,
  TemplateLock,
  ToolInvocation,
  ToolRecord,
  WorkflowRun,
  WorkflowTemplate,
  MemoryStorePort,
  DecisionStorePort,
  ArtifactStorePort,
  ValidationStorePort,
  PackVersionStore,
  PackInstallationStore,
  PackContentRefStore,
} from '@companyos/core';

import { openDatabase, type Database, type OpenDatabaseOptions } from '../db.js';
import { DomainError, type Result } from '@companyos/core';

import { MigrationFormatError, applyMigrations, loadMigrations, type MigrationReport } from '../migrations.js';
import { createSqliteApprovalStore } from './sqlite-approval-store.js';
import { createSqliteCommandLedger } from './sqlite-command-ledger.js';
import { createSqliteEventStore, type SqliteEventStore } from './sqlite-event-store.js';
import {
  activeLockOf,
  createSqliteLockStore,
  createSqliteProposalStore,
  createSqliteSnapshotStore,
  snapshotOfRun,
} from './sqlite-lifecycle-stores.js';
import { createSqliteRunStore, type RunCreationGuardedStore } from './sqlite-run-store.js';
import { createSqliteExecutionBudgetStore } from './sqlite-execution-budget.js';
import { createSqliteAgentExecutionStore, createSqliteExecutionArtifactStore } from './sqlite-agent-stores.js';
import { createSqliteRouterDecisionStore, type RouterDecisionStore } from './sqlite-router-decisions.js';
import { createSqliteHandoffStore } from './sqlite-handoff-store.js';
import { createSqliteMemoryStore, createSqliteDecisionStore } from './sqlite-memory-stores.js';
import { createSqliteArtifactStore } from './sqlite-artifact-store.js';
import {
  createSqlitePackContentRefStore,
  createSqlitePackInstallationStore,
  createSqlitePackVersionStore,
} from './sqlite-pack-stores.js';
import { createSqliteSessionStore } from './sqlite-session-store.js';
import type { SessionStorePort } from '@companyos/core';
import { createSqliteValidationStore } from './sqlite-validation-store.js';
import type { HandoffStorePort } from '@companyos/core';
import type { ExecutionArtifactRecord } from './sqlite-agent-stores.js';
import {
  createSqliteToolInvocationArtifactStore,
  createSqliteToolInvocationClaimStore,
  createSqliteToolInvocationIndexStore,
  createSqliteToolInvocationStore,
  createSqliteToolRecordStore,
} from './sqlite-tool-stores.js';
import type { ToolInvocationIndexStore } from './sqlite-tool-stores.js';
import type { ToolInvocationArtifactRecord } from './sqlite-tool-stores.js';
import type { ToolInvocationClaimStore } from './sqlite-tool-stores.js';
import { createSqliteAliasStore, createSqliteModelRecordStore } from './sqlite-registry-stores.js';
import { fenceStoreWrites } from './store-write-fence.js';
import {
  createSqliteBenchmarkResultStore,
  createSqlitePolicyStore,
} from './sqlite-selection-stores.js';
import {
  createSqliteAssignmentStore,
  createSqliteProviderModelStore,
  createSqliteProviderStore,
  createSqliteRoleStore,
  createSqliteSecretRefStore,
} from './sqlite-provider-stores.js';
import { createSqliteTaskStore } from './sqlite-task-store.js';
import { createSqliteExecutionAttemptStore, type ExecutionAttemptStore } from './sqlite-execution-attempt-store.js';
import { createSqliteProviderDispatchStore, type ProviderDispatchStore } from './sqlite-provider-dispatch-store.js';
import { createSqliteTemplateStore, type TemplateCreationGuardedStore } from './sqlite-template-store.js';
import { createSqliteUnitOfWork, toPersistenceError, type SqliteUnitOfWork } from './unit-of-work.js';

export {
  activeLockOf,
  createSqliteAgentExecutionStore,
  createSqliteAliasStore,
  createSqliteApprovalStore,
  createSqliteAssignmentStore,
  createSqliteBenchmarkResultStore,
  createSqliteCommandLedger,
  createSqliteEventStore,
  createSqliteExecutionArtifactStore,
  createSqliteLockStore,
  createSqliteModelRecordStore,
  createSqlitePolicyStore,
  createSqliteProposalStore,
  createSqliteProviderModelStore,
  createSqliteProviderStore,
  createSqliteRoleStore,
  createSqliteRunStore,
  createSqliteSecretRefStore,
  createSqliteSessionStore,
  createSqliteSnapshotStore,
  createSqliteTaskStore,
  createSqliteTemplateStore,
  createSqliteUnitOfWork,
  snapshotOfRun,
  toPersistenceError,
  type SqliteEventStore,
  type SqliteUnitOfWork,
  createSqliteMemoryStore,
  createSqliteDecisionStore,
  createSqliteArtifactStore,
  createSqliteValidationStore,
};

/**
 * T20-03A: the creation-identity-guarded write result (replay vs conflict).
 */
export type TaskGuardedWriteResult = Result<
  { readonly taskId: string; readonly replayed: boolean },
  DomainError
>;

/** `packages/persistence/migrations` — core schema (checksum-frozen, Sprint 0). */
export const coreMigrationsDir = (): string => fileURLToPath(new URL('../../migrations/', import.meta.url));
/** `packages/persistence/migrations/engine` — engine durability schema (Sprint 3). */
export const engineMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/engine/', import.meta.url));
/** `packages/persistence/migrations/lifecycle` — template governance schema (Sprint 4). */
export const lifecycleMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/lifecycle/', import.meta.url));
/** `packages/persistence/migrations/provider` — providers/roles/secrets (Sprint 6). */
export const providerMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/provider/', import.meta.url));
/** `packages/persistence/migrations/registry` — curated model registry (Sprint 7). */
export const registryMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/registry/', import.meta.url));
/** `packages/persistence/migrations/selection` — selection policy + benchmarks (Sprint 7.5). */
export const selectionMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/selection/', import.meta.url));
/** `packages/persistence/migrations/agent` — agent executions (Sprint 8). */
export const agentMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/agent/', import.meta.url));
/** `packages/persistence/migrations/tools` — tool registry (Sprint 9). */
export const toolMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/tools/', import.meta.url));

/** Sprint 10B: router decision persistence (opt-in chain). */
export const routerMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/router/', import.meta.url));

/** Sprint 11: structured handoff persistence (opt-in chain). */
export const handoffMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/handoff/', import.meta.url));
export const memoryMigrationsDir = (): string => fileURLToPath(new URL('../../migrations/memory/', import.meta.url));
/** Sprint 13: durable artifact + validation evidence (opt-in chain). */
export const artifactMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/artifact/', import.meta.url));
/** Sprint 15: Industry Pack persistence (opt-in chain). */
export const packMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/pack/', import.meta.url));
/** `packages/persistence/migrations/session` — the durable Session kernel (Sprint 19). */
export const sessionMigrationsDir = (): string =>
  fileURLToPath(new URL('../../migrations/session/', import.meta.url));

/**
 * Schema sets are versioned per concern. `core` and `engine` are applied by default
 * (the historical chains); the workflow-governance and provider chains are added by the
 * composition root that actually needs them.
 */
export type MigrationChainName =
  | 'core'
  | 'engine'
  | 'lifecycle'
  | 'provider'
  | 'registry'
  | 'selection'
  | 'agent'
  | 'tools'
  | 'router'
  | 'handoff'
  | 'memory'
  | 'artifact'
  | 'pack'
  | 'session';

export const DEFAULT_CHAINS: readonly MigrationChainName[] = ['core', 'engine'];

const ALL_CHAINS: readonly MigrationChainName[] = [
  'core',
  'engine',
  'lifecycle',
  'provider',
  'registry',
  'selection',
  'agent',
  'tools',
  'router',
  'handoff',
  'memory',
  'artifact',
  'pack',
  'session',
];

const migrationsDirFor = (chain: MigrationChainName): string => {
  switch (chain) {
    case 'core':
      return coreMigrationsDir();
    case 'engine':
      return engineMigrationsDir();
    case 'lifecycle':
      return lifecycleMigrationsDir();
    case 'provider':
      return providerMigrationsDir();
    case 'registry':
      return registryMigrationsDir();
    case 'selection':
      return selectionMigrationsDir();
    case 'agent':
      return agentMigrationsDir();
    case 'tools':
      return toolMigrationsDir();
    case 'router':
      return routerMigrationsDir();
    case 'handoff':
      return handoffMigrationsDir();
    case 'memory':
      return memoryMigrationsDir();
    case 'artifact':
      return artifactMigrationsDir();
    case 'pack':
      return packMigrationsDir();
    case 'session':
      return sessionMigrationsDir();
  }
};

/**
 * H12c: every migration name this build ships, across ALL chains. `schema_migrations` is
 * one table shared by every chain, so each chain's runner must know the other chains'
 * names: rows from a sibling chain are expected, a row no chain knows means a newer
 * CompanyOS version wrote this database (downgrade → typed refusal before any apply).
 * Names are globally unique across chains (asserted here, so a future collision fails loudly).
 */
export function shippedMigrationNames(extraDirs: readonly string[] = []): ReadonlySet<string> {
  const names = new Set<string>();
  const dirs = [...ALL_CHAINS.map(migrationsDirFor), ...extraDirs];
  const seenDirs = new Set<string>();
  for (const dir of dirs) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (const migration of loadMigrations(dir)) {
      if (names.has(migration.name) && !extraDirs.includes(dir)) {
        throw new MigrationFormatError(`Migration name "${migration.name}" is shipped by more than one chain`, {
          name: migration.name,
        });
      }
      names.add(migration.name);
    }
  }
  return names;
}

export interface OpenDurableDatabaseOptions extends Omit<OpenDatabaseOptions, 'path'> {
  readonly dataDir: string;
  readonly fileName?: string;
  readonly appliedAt: string;
  /** Which checksum-protected chains to bring up. Defaults to `['core', 'engine']`. */
  readonly chains?: readonly MigrationChainName[];
  readonly logger?: { info(message: string, fields?: Record<string, unknown>): void };
}

export interface DurableDatabase {
  readonly executionBudget: ExecutionBudgetStore;
  readonly db: Database;
  readonly path: string;
  readonly journalMode: string;
  readonly unitOfWork: SqliteUnitOfWork;
  readonly runs: EntityStore<WorkflowRun> & Partial<RunCreationGuardedStore>;
  /**
   * T20-03A: the canonical task store — run-scoped claim read (`listByRun`) plus the
   * creation-identity-guarded write (`putGuarded`).
   */
  /** Sprint21 final: the generic execution-claim owner (chain: engine). */
  readonly executionAttempts: ExecutionAttemptStore;
  /** Sprint24: the provider dispatch binding — SUBORDINATE to ExecutionAttempt. */
  readonly providerDispatches: ProviderDispatchStore;
  readonly tasks: EntityStore<Task> & {
    listByRun(runId: string): Promise<readonly Task[]>;
    putGuarded(entity: Task): Promise<
      TaskGuardedWriteResult
    >;
  };
  readonly approvals: EntityStore<Approval>;
  readonly events: SqliteEventStore;
  readonly ledger: CommandLedgerPort;
  /* ------------------------------------------- workflow governance (Sprint 4) -- */
  readonly templates: EntityStore<WorkflowTemplate> & Partial<TemplateCreationGuardedStore>;
  readonly locks: EntityStore<TemplateLock>;
  readonly proposals: EntityStore<ChangeProposal>;
  readonly snapshots: EntityStore<RunSnapshot>;
  /** DB-authoritative active lock of a template (partial unique index). */
  readonly activeLockOf: (templateId: string) => TemplateLock | null;
  readonly snapshotOfRun: (runId: string) => Promise<RunSnapshot | null>;
  /* --------------------------------------- providers / authorization (Sprint 6) -- */
  readonly roles: EntityStore<Role>;
  readonly roleAssignments: EntityStore<RoleAssignment>;
  readonly providers: EntityStore<ProviderRegistration>;
  readonly providerModels: EntityStore<ProviderModelRecord>;
  /** Secret POINTERS only - there is no column able to hold a value. */
  readonly secretRefs: EntityStore<SecretRef>;
  /* --------------------------------------- curated model registry (Sprint 7) ------ */
  readonly modelRecords: EntityStore<ModelRecord>;
  readonly modelAliases: EntityStore<LogicalAlias>;
  /* --------------------------- selection policy + benchmarks (Sprint 7.5) -------- */
  readonly selectionPolicies: EntityStore<ModelSelectionPolicy>;
  readonly benchmarkResults: EntityStore<BenchmarkResult>;
  /* ------------------------------------- agent execution runtime (Sprint 8) -------- */
  /**
   * The execution store plus its canonical CONDITIONAL lifecycle writes (F5-D/F5-C-R1):
   * `putIfStatus` (terminal transition CAS), `createIfAbsent` / `startIfPreTerminal`
   * (creation / pre-terminal progress) and `commitOutcome` (the durable post-commit
   * stamp). Generic `put` remains for non-lifecycle metadata and fixture-grade stores —
   * lifecycle writers use the conditional methods exclusively.
   */
  readonly agentExecutions: EntityStore<AgentExecution> & {
    putIfStatus(entity: AgentExecution, expectedStatus: AgentExecutionStatus): Promise<boolean>;
    createIfAbsent(entity: AgentExecution): Promise<boolean>;
    startIfPreTerminal(entity: AgentExecution): Promise<boolean>;
    commitOutcome(executionId: string, decisionId: string, at: string, nowIso: string): Promise<boolean>;
    /** 25b98d1 — the ACTIVE logical-turn claim holder (durable single-flight arbiter). */
    activeOwnerOfLogicalTurn(logicalTurnId: string): Promise<AgentExecution | null>;
  };
  readonly executionArtifacts: EntityStore<ExecutionArtifactRecord>;
  /* ----------------------------------------------- tool registry (Sprint 9) -------- */
  readonly toolRecords: EntityStore<ToolRecord>;
  readonly toolInvocations: EntityStore<ToolInvocation>;
  readonly toolInvocationArtifacts: EntityStore<ToolInvocationArtifactRecord>;
  readonly toolInvocationClaims: ToolInvocationClaimStore | null;
  readonly toolInvocationIndex: ToolInvocationIndexStore | null;
  /** Sprint 10B.1: router decisions (null unless the `router` chain was requested). */
  readonly routerDecisions: RouterDecisionStore | null;
  /** Sprint 11: structured handoff store (null unless the `handoff` chain was requested). */
  readonly handoffStore: HandoffStorePort | null;
  /** Sprint 13: durable evidence stores (null unless the `artifact` chain was requested). */
  readonly artifactStore: ArtifactStorePort | null;
  readonly validationStore: ValidationStorePort | null;
  /** Sprint 15: Industry Pack stores (null unless the `pack` chain was requested). */
  readonly packVersions: PackVersionStore | null;
  readonly packInstallations: PackInstallationStore | null;
  readonly packContentRefs: PackContentRefStore | null;
  readonly memories: MemoryStorePort | null;
  readonly decisions: DecisionStorePort | null;
  /** Sprint 19: durable Session kernel store (null unless the `session` chain was requested). */
  readonly sessionStore: SessionStorePort | null;
  readonly migrations: {
    readonly core: MigrationReport;
    readonly engine: MigrationReport;
    readonly lifecycle: MigrationReport | null;
    readonly provider: MigrationReport | null;
    readonly registry: MigrationReport | null;
    readonly selection: MigrationReport | null;
    readonly agent: MigrationReport | null;
    readonly tools: MigrationReport | null;
    readonly router: MigrationReport | null;
    readonly handoff: MigrationReport | null;
    readonly memory: MigrationReport | null;
    readonly artifact: MigrationReport | null;
    readonly pack: MigrationReport | null;
    readonly session: MigrationReport | null;
  };
  readonly chains: readonly MigrationChainName[];
  close(): void;
}

/**
 * A store whose table does not exist yet (the `lifecycle` chain was not requested).
 *
 * Failing loudly beats "no such table": the message tells the caller exactly how to get
 * the schema (`chains: ['core', 'engine', 'lifecycle']`).
 */
function unavailable<T extends EntityId>(table: string): EntityStore<T> {
  const refuse = (): never => {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Table "${table}" does not exist: this database was opened without the migration chain that owns it.`,
      {
        details: {
          table,
          hint: "the composition root must request every chain it needs, e.g. openDurableDatabase({ chains: ['core','engine','lifecycle','provider','registry','selection'] })",
        },
      },
    );
  };
  return {
    get: async () => refuse(),
    put: async () => refuse(),
    delete: async () => refuse(),
    list: async () => refuse(),
  };
}

/**
 * Open (creating if needed) the durable CompanyOS database and bring the requested
 * migration chains up to date. Used by tests and by the composition root; the engine
 * itself never calls this.
 */
export function openDurableDatabase(options: OpenDurableDatabaseOptions): DurableDatabase {
  const fileName = options.fileName ?? 'companyos.sqlite';
  const inMemory = options.dataDir === ':memory:';
  if (!inMemory) mkdirSync(options.dataDir, { recursive: true });
  const path = inMemory ? ':memory:' : join(options.dataDir, fileName);

  const db = openDatabase({
    path,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.journalMode === undefined ? {} : { journalMode: options.journalMode }),
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.foreignKeys === undefined ? {} : { foreignKeys: options.foreignKeys }),
  });

  const knownNames = shippedMigrationNames();
  const apply = (chain: MigrationChainName): MigrationReport =>
    applyMigrations({
      db,
      migrations: loadMigrations(migrationsDirFor(chain)),
      appliedAt: options.appliedAt,
      knownNames,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

  const coreReport = apply('core');
  const engineReport = apply('engine');
  const requested = options.chains ?? DEFAULT_CHAINS;
  // `core` + `engine` are the historical baseline; extra chains are opt-in.
  const chains = ALL_CHAINS.filter(
    (chain) => chain === 'core' || chain === 'engine' || requested.includes(chain),
  );
  const lifecycleReport = chains.includes('lifecycle') ? apply('lifecycle') : null;
  const providerReport = chains.includes('provider') ? apply('provider') : null;
  const registryReport = chains.includes('registry') ? apply('registry') : null;
  const selectionReport = chains.includes('selection') ? apply('selection') : null;
  const agentReport = chains.includes('agent') ? apply('agent') : null;
  const toolsReport = chains.includes('tools') ? apply('tools') : null;
  const routerReport = chains.includes('router') ? apply('router') : null;
  const handoffReport = chains.includes('handoff') ? apply('handoff') : null;
  const memoryReport = chains.includes('memory') ? apply('memory') : null;
  const artifactReport = chains.includes('artifact') ? apply('artifact') : null;
  const packReport = chains.includes('pack') ? apply('pack') : null;
  const sessionReport = chains.includes('session') ? apply('session') : null;
  const hasLifecycle = chains.includes('lifecycle');
  const hasProvider = chains.includes('provider');
  const hasRegistry = chains.includes('registry');
  const hasSelection = chains.includes('selection');
  const hasAgent = chains.includes('agent');
  const hasTools = chains.includes('tools');
  const hasRouter = chains.includes('router');
  const hasHandoff = chains.includes('handoff');
  const hasMemory = chains.includes('memory');
  const hasArtifact = chains.includes('artifact');
  const hasPack = chains.includes('pack');
  const hasSession = chains.includes('session');

  const journalRow = db.prepare('PRAGMA journal_mode').get();
  const journalMode =
    journalRow === undefined
      ? 'unknown'
      : String(Object.values(journalRow as Record<string, unknown>)[0] ?? 'unknown');

  return {
    db,
    executionBudget: createSqliteExecutionBudgetStore(db),
    path,
    journalMode,
    unitOfWork: createSqliteUnitOfWork(db),
    runs: fenceStoreWrites(db, 'runs', createSqliteRunStore(db)),
    executionAttempts: fenceStoreWrites(db, 'execution_attempts', createSqliteExecutionAttemptStore(db)),
    providerDispatches: fenceStoreWrites(db, 'provider_dispatches', createSqliteProviderDispatchStore(db)),
    tasks: fenceStoreWrites(db, 'tasks', createSqliteTaskStore(db)),
    approvals: fenceStoreWrites(db, 'approvals', createSqliteApprovalStore(db)),
    events: fenceStoreWrites(db, 'events', createSqliteEventStore(db), { skip: ['append'] }),
    ledger: fenceStoreWrites(db, 'command_ledger', createSqliteCommandLedger(db)),
    templates: hasLifecycle ? fenceStoreWrites(db, 'workflow_templates', createSqliteTemplateStore(db)) : unavailable<WorkflowTemplate>('workflow_templates'),
    locks: hasLifecycle ? fenceStoreWrites(db, 'workflow_template_locks', createSqliteLockStore(db)) : unavailable<TemplateLock>('workflow_template_locks'),
    proposals: hasLifecycle ? fenceStoreWrites(db, 'workflow_change_requests', createSqliteProposalStore(db)) : unavailable<ChangeProposal>('workflow_change_requests'),
    snapshots: hasLifecycle ? fenceStoreWrites(db, 'run_snapshots', createSqliteSnapshotStore(db)) : unavailable<RunSnapshot>('run_snapshots'),
    activeLockOf: (templateId: string) => (hasLifecycle ? activeLockOf(db, templateId) : null),
    snapshotOfRun: (runId: string) => (hasLifecycle ? snapshotOfRun(db, runId) : Promise.resolve(null)),
    roles: hasProvider ? fenceStoreWrites(db, 'roles', createSqliteRoleStore(db)) : unavailable<Role>('roles'),
    roleAssignments: hasProvider
      ? fenceStoreWrites(db, 'role_assignments', createSqliteAssignmentStore(db))
      : unavailable<RoleAssignment>('role_assignments'),
    providers: hasProvider
      ? fenceStoreWrites(db, 'providers', createSqliteProviderStore(db))
      : unavailable<ProviderRegistration>('providers'),
    providerModels: hasProvider
      ? fenceStoreWrites(db, 'provider_models', createSqliteProviderModelStore(db))
      : unavailable<ProviderModelRecord>('provider_models'),
    secretRefs: hasProvider ? fenceStoreWrites(db, 'secret_refs', createSqliteSecretRefStore(db)) : unavailable<SecretRef>('secret_refs'),
    modelRecords: hasRegistry
      ? createSqliteModelRecordStore(db)
      : unavailable<ModelRecord>('model_records'),
    modelAliases: hasRegistry ? createSqliteAliasStore(db) : unavailable<LogicalAlias>('logical_aliases'),
    selectionPolicies: hasSelection
      ? fenceStoreWrites(db, 'model_selection_policies', createSqlitePolicyStore(db))
      : unavailable<ModelSelectionPolicy>('model_selection_policies'),
    benchmarkResults: hasSelection
      ? fenceStoreWrites(db, 'benchmark_results', createSqliteBenchmarkResultStore(db))
      : unavailable<BenchmarkResult>('benchmark_results'),
    agentExecutions: hasAgent
      ? fenceStoreWrites(db, 'agent_executions', createSqliteAgentExecutionStore(db))
      : (unavailable<AgentExecution>('agent_executions') as ReturnType<typeof createSqliteAgentExecutionStore>),
    executionArtifacts: hasAgent
      ? fenceStoreWrites(db, 'agent_execution_artifacts', createSqliteExecutionArtifactStore(db))
      : unavailable<ExecutionArtifactRecord>('agent_execution_artifacts'),
    toolRecords: hasTools
      ? fenceStoreWrites(db, 'tool_records', createSqliteToolRecordStore(db))
      : unavailable<ToolRecord>('tool_records'),
    toolInvocations: hasTools
      ? fenceStoreWrites(db, 'tool_invocations', createSqliteToolInvocationStore(db))
      : unavailable<ToolInvocation>('tool_invocations'),
    toolInvocationArtifacts: hasTools
      ? fenceStoreWrites(db, 'tool_invocation_artifacts', createSqliteToolInvocationArtifactStore(db))
      : unavailable<ToolInvocationArtifactRecord>('tool_invocation_artifacts'),
    toolInvocationClaims: hasTools ? fenceStoreWrites(db, 'tool_invocation_claims', createSqliteToolInvocationClaimStore(db)) : null,
    toolInvocationIndex: hasTools ? fenceStoreWrites(db, 'tool_invocation_index', createSqliteToolInvocationIndexStore(db)) : null,
    routerDecisions: hasRouter ? fenceStoreWrites(db, 'router_decisions', createSqliteRouterDecisionStore(db)) : null,
    handoffStore: hasHandoff ? fenceStoreWrites(db, 'handoffs', createSqliteHandoffStore(db)) : null,
    memories: hasMemory ? fenceStoreWrites(db, 'memories', createSqliteMemoryStore(db)) : null,
    decisions: hasMemory ? fenceStoreWrites(db, 'decisions', createSqliteDecisionStore(db)) : null,
    artifactStore: hasArtifact ? fenceStoreWrites(db, 'artifacts', createSqliteArtifactStore(db)) : null,
    validationStore: hasArtifact ? fenceStoreWrites(db, 'validations', createSqliteValidationStore(db)) : null,
    packVersions: hasPack ? fenceStoreWrites(db, 'pack_versions', createSqlitePackVersionStore(db, { nowIso: () => new Date().toISOString() })) : null,
    packInstallations: hasPack ? fenceStoreWrites(db, 'pack_installations', createSqlitePackInstallationStore(db)) : null,
    packContentRefs: hasPack ? fenceStoreWrites(db, 'pack_content_refs', createSqlitePackContentRefStore(db, { nowIso: () => new Date().toISOString() })) : null,
    sessionStore: hasSession ? fenceStoreWrites(db, 'sessions', createSqliteSessionStore(db)) : null,
    migrations: {
      core: coreReport,
      engine: engineReport,
      lifecycle: lifecycleReport,
      provider: providerReport,
      registry: registryReport,
      selection: selectionReport,
      agent: agentReport,
      tools: toolsReport,
      router: routerReport,
      handoff: handoffReport,
      memory: memoryReport,
      artifact: artifactReport,
      pack: packReport,
      session: sessionReport,
    },
    chains,
    close: (): void => {
      db.close();
    },
  };
}

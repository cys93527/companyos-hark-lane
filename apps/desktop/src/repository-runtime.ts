/**
 * Production repository runtime composition (Sprint 17 — Task-17-08).
 *
 * This module is the ONE place the desktop application (and the production E2E) wires the
 * Sprint 17 repository runtime together:
 *
 *   - the process-local workspace manager (T17-02) with the T17-07 lease guard,
 *   - the repository tool ADAPTERS (exactly the ten production tools, T17-03…T17-06) and
 *     their idempotent ToolRecord registration,
 *   - the repository process runner with the REAL Artifact/CAS content store,
 *   - the ONE revision-anchor provider shared by repo.git, the QA tools and the validator,
 *   - the durable QA-evidence source and tool-record reader for `repo.validation-evidence`,
 *   - the repository-capable stage handlers (T17-07) for the kinds this deployment declares,
 *   - and the trusted application seam that opens a workspace.
 *
 * Nothing here is a Tool, an IPC channel or a renderer API. The workspace root and the
 * command profile arrive ONLY from a trusted host call: `openWorkspace({root, commandProfile})`.
 * With no workspace open the runtime starts normally and every repository tool fails closed.
 *
 * There is no DevCompany special case: a task kind is repository-capable because this
 * composition is CONFIGURED to register a repository handler for it.
 */
import type {
  ArtifactContentStore,
  Clock,
  DomainError,
  IdFactory,
  Result,
  ToolPort,
  ToolRecord,
} from '@companyos/core';
import type { FaultCheckpointPort } from '@companyos/core';
import type { DurableDatabase } from '@companyos/persistence';
import {
  REPOSITORY_GIT_TOOL_SPEC,
  REPOSITORY_PROCESS_TOOL_SPECS,
  REPOSITORY_TOOL_SPECS,
  REPOSITORY_VALIDATION_EVIDENCE_SPEC,
  createRepositoryGitToolPort,
  createRepositoryGitToolRecord,
  createRepositoryProcessRunner,
  createRepositoryProcessToolPort,
  createRepositoryProcessToolRecord,
  createRepositoryRevisionAnchorProvider,
  createRepositoryStageHandler,
  createRepositoryToolPort,
  createRepositoryToolRecord,
  createRepositoryValidationEvidencePort,
  createRepositoryValidationEvidenceRecord,
  createTaskBaselineService,
  createWorkspaceExecutionLease,
  createWorkspaceManager,
  workspaceInUseError,
  type RepositoryCommandProfile,
  type RepositoryEvidenceSource,
  type RepositoryEvidenceToolRecordReader,
  type RepositoryRevisionAnchorProvider,
  type StageHandler,
  type TaskBaselineService,
  type ToolRegistry,
  type WorkspaceContext,
  type WorkspaceExecutionLeaseService,
  type WorkspaceManager,
} from '@companyos/engine';

/** The trusted input a host supplies when it opens a repository workspace. */
export interface OpenRepositoryWorkspaceInput {
  /** Trusted application/composition root — never a model, prompt, tool input or payload. */
  readonly root: string;
  /** Trusted command profile: executable/argv/cwd/env for the QA command slots. */
  readonly commandProfile: RepositoryCommandProfile;
}

/** The trusted repository runtime a composition root (and the production E2E) drives. */
export interface RepositoryRuntime {
  readonly workspace: WorkspaceManager;
  readonly lease: WorkspaceExecutionLeaseService;
  /** The task-start baseline service (lazily bound to the host registry). */
  readonly getBaseline: () => TaskBaselineService;
  readonly anchors: RepositoryRevisionAnchorProvider;
  readonly evidenceSource: RepositoryEvidenceSource;
  readonly toolRecords: RepositoryEvidenceToolRecordReader;
  /** The adapter bindings to hand the ToolRegistry the host constructs. */
  readonly toolPorts: ReadonlyMap<string, ToolPort>;
  /** Register the ten ToolRecords idempotently (restart-safe). */
  readonly registerTools: (actorId: string) => Promise<Result<readonly string[], DomainError>>;
  /** The trusted seam: open a workspace. NOT a tool, NOT IPC, NOT renderer-reachable. */
  readonly openWorkspace: (
    input: OpenRepositoryWorkspaceInput,
  ) => Promise<Result<WorkspaceContext, DomainError>>;
  readonly closeWorkspace: () => Result<true, DomainError>;
  readonly currentWorkspace: () => WorkspaceContext | null;
  /** The task kinds this deployment treats as repository-capable. */
  readonly repositoryKinds: () => readonly string[];
  /** The handlers to merge into the engine's EXISTING StageHandlerRegistry. */
  readonly handlers: () => ReadonlyMap<string, StageHandler>;
}

export interface RepositoryRuntimeDeps {
  /** The durable database (read-only evidence/tool-record queries). */
  readonly db: DurableDatabase;
  /**
   * Late-bound accessor for the host's ToolRegistry. The registry is constructed from this
   * module's `toolPorts`, so it does not exist yet while the runtime is composed.
   */
  readonly registry: () => ToolRegistry;
  /** The real Artifact/CAS content store; null degrades stream externalization honestly. */
  readonly contentStore: ArtifactContentStore | null;
  readonly clock: Clock;
  readonly ids: IdFactory;
  /** Trusted application actor used by the task-start baseline invocation. */
  readonly actorId: string;
  /**
   * The task kinds this deployment treats as repository-capable. EMPTY by default: no kind
   * becomes repository-capable until a trusted host configures it (fail closed).
   */
  readonly repositoryCapableKinds?: readonly string[];
  /** Task-18-08 deterministic fault-injection seam (trusted test harness only). */
  readonly faultCheckpoints?: FaultCheckpointPort;
}

/** The durable evidence source: a read-only query over the EXISTING invocation table. */
const createDurableEvidenceSource = (db: DurableDatabase): RepositoryEvidenceSource => ({
  async selectLatestTerminal(input) {
    const placeholders = input.toolIds.map(() => '?').join(', ');
    const rows = db.db
      .prepare(
        `SELECT id FROM tool_invocations
          WHERE run_id = ? AND task_id = ? AND tool_id IN (${placeholders})
          ORDER BY created_at DESC, id DESC`,
      )
      .all(input.runId, input.taskId, ...input.toolIds) as { id: string }[];
    const invocations = [];
    for (const row of rows) {
      const found = await db.toolInvocations.get(row.id);
      if (found !== null) invocations.push(found);
    }
    return { ok: true as const, value: invocations };
  },
});

const createDurableToolRecordReader = (db: DurableDatabase): RepositoryEvidenceToolRecordReader => ({
  async read(toolId) {
    const record = await db.toolRecords.get(toolId);
    return {
      ok: true as const,
      value: record === null ? null : { version: record.version, enabled: record.enabled },
    };
  },
});

/**
 * Compose the production repository runtime. Called ONCE by the desktop composition (and by
 * the production E2E with temp paths); no global state, no singleton.
 */
export const composeRepositoryRuntime = (deps: RepositoryRuntimeDeps): RepositoryRuntime => {
  const lease = createWorkspaceExecutionLease();
  const workspace = createWorkspaceManager({
    // T17-07: a leased repository execution owns the workspace until it terminates.
    busy: () => {
      const held = lease.current();
      return held === null
        ? ({ ok: true as const, value: true as const } as const)
        : ({ ok: false as const, error: workspaceInUseError(held) } as const);
    },
  });

  const runner = createRepositoryProcessRunner({
    clock: deps.clock,
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    contentStore: deps.contentStore ?? undefined,
    resolveExecutionId: async (invocationId) => {
      const invocation = await deps.db.toolInvocations.get(invocationId);
      return invocation === null ? null : invocation.executionId;
    },
  });

  const anchors = createRepositoryRevisionAnchorProvider({
    workspace: () => workspace.current(),
    runner,
    gitExecutable: 'git',
    timeoutMs: REPOSITORY_GIT_TOOL_SPEC.timeoutMs,
  });

  // ---- the tool adapters (the production set is exactly these TEN tools) ---------------
  const toolPorts = new Map<string, ToolPort>();
  for (const spec of REPOSITORY_TOOL_SPECS) {
    toolPorts.set(
      spec.toolId,
      createRepositoryToolPort(spec, { workspace: () => workspace.current(), clock: deps.clock }),
    );
  }
  for (const spec of REPOSITORY_PROCESS_TOOL_SPECS) {
    toolPorts.set(
      spec.toolId,
      createRepositoryProcessToolPort(spec, {
        workspace: () => workspace.current(),
        clock: deps.clock,
        runner,
        // T17-05/06: pre/post anchors on every QA success, fail closed without a repository.
        anchorProvider: anchors,
        contentStore: deps.contentStore ?? undefined,
      }),
    );
  }
  toolPorts.set(
    REPOSITORY_GIT_TOOL_SPEC.toolId,
    createRepositoryGitToolPort(REPOSITORY_GIT_TOOL_SPEC, {
      workspace: () => workspace.current(),
      clock: deps.clock,
      runner,
      gitExecutable: 'git',
      timeoutMs: REPOSITORY_GIT_TOOL_SPEC.timeoutMs,
      anchorProvider: anchors,
    }),
  );
  const evidenceSource = createDurableEvidenceSource(deps.db);
  toolPorts.set(
    REPOSITORY_VALIDATION_EVIDENCE_SPEC.toolId,
    createRepositoryValidationEvidencePort(REPOSITORY_VALIDATION_EVIDENCE_SPEC, {
      workspace: () => workspace.current(),
      evidenceSource,
      toolRecords: createDurableToolRecordReader(deps.db),
      anchorProvider: anchors,
      clock: deps.clock,
    }),
  );

  const registerTools = async (actorId: string): Promise<Result<readonly string[], DomainError>> => {
    const registered: string[] = [];
    const makeRecord = (toolId: string): Result<ToolRecord, DomainError> => {
      const now = deps.clock.nowIso();
      const filesystem = REPOSITORY_TOOL_SPECS.find((spec) => spec.toolId === toolId);
      if (filesystem !== undefined) return createRepositoryToolRecord(filesystem, now);
      const process = REPOSITORY_PROCESS_TOOL_SPECS.find((spec) => spec.toolId === toolId);
      if (process !== undefined) return createRepositoryProcessToolRecord(process, now);
      if (toolId === REPOSITORY_GIT_TOOL_SPEC.toolId) {
        return createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, now);
      }
      return createRepositoryValidationEvidenceRecord(REPOSITORY_VALIDATION_EVIDENCE_SPEC, now);
    };
    const toolIds = [
      ...REPOSITORY_TOOL_SPECS.map((spec) => spec.toolId),
      ...REPOSITORY_PROCESS_TOOL_SPECS.map((spec) => spec.toolId),
      REPOSITORY_GIT_TOOL_SPEC.toolId,
      REPOSITORY_VALIDATION_EVIDENCE_SPEC.toolId,
    ];
    for (const toolId of toolIds) {
      const record = makeRecord(toolId);
      if (!record.ok) return record;
      const stored = await deps.registry().register(record.value, { actorId });
      if (!stored.ok && stored.error.code !== 'CONFLICT') return stored;
      registered.push(toolId);
    }
    return { ok: true, value: registered };
  };

  let baselineService: TaskBaselineService | null = null;
  /** The task-start baseline service (lazy: it needs the registry to exist first). */
  const getBaseline = (): TaskBaselineService => {
    baselineService ??= createTaskBaselineService({
      registry: deps.registry(),
      executionIds: { next: () => deps.ids.id('exc') },
      clock: { nowIso: () => deps.clock.nowIso() },
    });
    return baselineService;
  };

  // ---- the repository-capable stage handlers (T17-07) ----------------------------------
  // Built LAZILY: a handler needs the host registry, which is constructed from this module's
  // own toolPorts and therefore does not exist while the runtime is being composed.
  const kinds = [...new Set(deps.repositoryCapableKinds ?? [])];
  const handlers = (): ReadonlyMap<string, StageHandler> => {
    const built = new Map<string, StageHandler>();
    for (const kind of kinds) {
      built.set(
        kind,
        createRepositoryStageHandler({
          id: `repository.agent:${kind}`,
          // The repository work itself is deployment work (an agent round). The host may
          // substitute its own runtime; the default is a no-op that reports success after
          // the baseline is durably captured.
          execute: () => 'succeeded',
          workspace: () => workspace.current(),
          registry: deps.registry(),
          actorId: deps.actorId,
          clock: deps.clock,
          executionIds: { next: () => deps.ids.id('exc') },
          faultCheckpoints: deps.faultCheckpoints,
          lease,
          baseline: getBaseline(),
        }),
      );
    }
    return built;
  };

  return {
    workspace,
    lease,
    getBaseline,
    anchors,
    evidenceSource,
    toolRecords: createDurableToolRecordReader(deps.db),
    toolPorts,
    registerTools,
    openWorkspace: async (input) =>
      workspace.openWorkspace({ root: input.root, commandProfile: input.commandProfile }),
    closeWorkspace: () => workspace.closeWorkspace(),
    currentWorkspace: () => workspace.current(),
    repositoryKinds: () => kinds,
    handlers,
  };
};

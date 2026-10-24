/**
 * Shared fixture for the Sprint 2 engine suite. Not a test file itself.
 *
 * Everything is deterministic: fixed clock, sequence ids, scripted handlers,
 * in-memory stores. No timers, no randomness, no network.
 */
import {
  FixedClock,
  SequenceIdFactory,
  createTask,
  createWorkflowRun,
  type Approval,
  type RoleId,
  type RunCommand,
  type RunCommandType,
  type RunSnapshotId,
  type StageId,
  type Task,
  type TaskId,
  type WorkflowId,
  type WorkflowRun,
  type WorkflowTemplateId,
  type WorkflowVersionId,
} from '@companyos/core';
import {
  createInMemoryEntityStore,
  createInMemoryEventStore,
  createScriptedRegistry,
  createWorkflowEngine,
  type InMemoryEventStore,
  type ObservableEntityStore,
  type StageHandlerOutcome,
  type WorkflowEngine,
} from '@companyos/engine';

export const EPOCH = Date.parse('2026-04-01T00:00:00.000Z');

export interface FixtureOptions {
  readonly maxRework?: number;
  readonly script?: Readonly<Record<string, readonly StageHandlerOutcome[]>>;
}

export interface Fixture {
  readonly engine: WorkflowEngine;
  readonly clock: FixedClock;
  readonly ids: SequenceIdFactory;
  readonly runs: ObservableEntityStore<WorkflowRun>;
  readonly tasks: ObservableEntityStore<Task>;
  readonly approvals: ObservableEntityStore<Approval>;
  readonly events: InMemoryEventStore;
  nextCommandId(): string;
  command(run: WorkflowRun, type: RunCommandType, extra?: Partial<RunCommand>): RunCommand;
  seedRun(options?: { maxRework?: number }): Promise<WorkflowRun>;
  seedTask(options?: { kind?: string; maxAttempts?: number }): Promise<Task>;
}

export function makeFixture(options: FixtureOptions = {}): Fixture {
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const runs = createInMemoryEntityStore<WorkflowRun>();
  const tasks = createInMemoryEntityStore<Task>();
  const approvals = createInMemoryEntityStore<Approval>();
  const events = createInMemoryEventStore();
  const handlers = createScriptedRegistry(options.script ?? {});
  const engine = createWorkflowEngine({ ids, clock, runs, tasks, approvals, events, handlers });

  let counter = 0;
  const nextCommandId = (): string => {
    counter += 1;
    clock.advance(1_000);
    return `cmd_test_${String(counter).padStart(4, '0')}`;
  };

  let lastRunId: string | null = null;
  return {
    engine,
    clock,
    ids,
    runs,
    tasks,
    approvals,
    events,
    nextCommandId,
    command(run: WorkflowRun, type: RunCommandType, extra: Partial<RunCommand> = {}): RunCommand {
      return {
        commandId: nextCommandId(),
        runId: run.id,
        type,
        expectedRevision: run.revision,
        actorId: 'tester',
        traceId: 'trace_test',
        issuedAt: clock.nowIso(),
        ...extra,
      };
    },
    async seedRun(runOptions = {}): Promise<WorkflowRun> {
      const created = createWorkflowRun({
        companyId: 'cmp_1' as never,
        workflowId: 'wfl_1' as WorkflowId,
        templateId: 'tpl_1' as WorkflowTemplateId,
        versionId: 'ver_1' as WorkflowVersionId,
        snapshotId: 'snp_1' as RunSnapshotId,
        startedBy: 'user_owner',
        now: clock.nowIso(),
        ids,
        ...(runOptions.maxRework === undefined ? {} : { maxRework: runOptions.maxRework }),
      });
      if (!created.ok) throw new Error(`seedRun failed: ${created.error.message}`);
      await runs.put(created.value);
      lastRunId = created.value.id;
      return created.value;
    },
    async seedTask(taskOptions: { kind?: string; maxAttempts?: number; runId?: string } = {}): Promise<Task> {
      if (taskOptions.runId === undefined && lastRunId === null) {
        throw new Error('seedTask requires a runId (or a prior seedRun) — canonical run ownership.');
      }
      const created = createTask({
        runId: (taskOptions.runId ?? lastRunId) as never,
        stageId: 'stg_1' as StageId,
        roleId: 'rol_1' as RoleId,
        kind: taskOptions.kind ?? 'pack-a:build',
        now: clock.nowIso(),
        ids,
        ...(taskOptions.maxAttempts === undefined ? {} : { maxAttempts: taskOptions.maxAttempts }),
      });
      if (!created.ok) throw new Error(`seedTask failed: ${created.error.message}`);
      await tasks.put(created.value);
      return created.value;
    },
  };
}

/** Unwrap a Result in tests, failing loudly with the domain error. */
export function must<T, E extends { message: string; code?: string }>(
  result: { ok: true; value: T } | { ok: false; error: E },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code ?? ''}: ${result.error.message}`);
  return result.value;
}

export const STAGE_ID = 'stg_1' as StageId;
export const taskIdsOf = (tasks: readonly Task[]): readonly TaskId[] => tasks.map((task) => task.id);

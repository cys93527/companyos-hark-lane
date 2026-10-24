/**
 * Integration fixture: the Workflow Engine wired to the REAL SQLite durable layer.
 *
 * It lives outside `packages/*` on purpose: the composition "engine over persistence"
 * belongs to neither package, and keeping it here means `@companyos/persistence` never
 * gains a dependency on `@companyos/engine` (Sprint 3 requirement 15).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FixedClock,
  SequenceIdFactory,
  createTask,
  createWorkflowRun,
  type CommandLedgerPort,
  type CommandLedgerRecord,
  type EntityStore,
  type EventStorePort,
  type RunCommand,
  type RunCommandType,
  type Task,
  type WorkflowRun,
} from '@companyos/core';
import {
  createScriptedRegistry,
  createWorkflowEngine,
  type StageHandlerOutcome,
  type WorkflowEngine,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

export const EPOCH = Date.parse('2026-05-01T00:00:00.000Z');
export const STAGE_ID = 'stg_1' as never;

export interface DurableFixtureOptions {
  readonly script?: Readonly<Record<string, readonly StageHandlerOutcome[]>>;
  readonly maxLedgerEntries?: number;
  readonly fileName?: string;
}

export interface DurableFixture {
  readonly dataDir: string;
  readonly filePath: string;
  readonly clock: FixedClock;
  readonly ids: SequenceIdFactory;
  database(): DurableDatabase;
  engine(): WorkflowEngine;
  /** Close the database and rebuild everything over the same file ("process restart"). */
  restart(options?: { script?: Readonly<Record<string, readonly StageHandlerOutcome[]>> }): void;
  seedRun(): Promise<WorkflowRun>;
  seedTask(options?: { kind?: string; maxAttempts?: number }): Promise<Task>;
  command(run: WorkflowRun, type: RunCommandType, extra?: Partial<RunCommand>): RunCommand;
  cleanup(): void;
}

export function makeDurableFixture(options: DurableFixtureOptions = {}): DurableFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-durable-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();

  const open = (): DurableDatabase =>
    openDurableDatabase({
      dataDir,
      appliedAt: clock.nowIso(),
      ...(options.fileName === undefined ? {} : { fileName: options.fileName }),
    });

  const buildEngine = (
    database: DurableDatabase,
    script: Readonly<Record<string, readonly StageHandlerOutcome[]>> | undefined,
  ): WorkflowEngine =>
    createWorkflowEngine({
      ids,
      clock,
      runs: database.runs,
      tasks: database.tasks,
      approvals: database.approvals,
      events: database.events,
      ledger: database.ledger,
      unitOfWork: database.unitOfWork,
      handlers: createScriptedRegistry(script ?? {}),
      ...(options.maxLedgerEntries === undefined ? {} : { maxLedgerEntries: options.maxLedgerEntries }),
    });

  let database = open();
  let engine = buildEngine(database, options.script);
  let counter = 0;
  let lastRunId: string | null = null;

  const fixture: DurableFixture = {
    dataDir,
    filePath: database.path,
    clock,
    ids,
    database: () => database,
    engine: () => engine,
    restart(restartOptions = {}): void {
      database.close();
      database = open();
      engine = buildEngine(database, restartOptions.script ?? options.script);
    },
    async seedRun(): Promise<WorkflowRun> {
      const created = createWorkflowRun({
        companyId: 'cmp_1' as never,
        workflowId: 'wfl_1' as never,
        templateId: 'tpl_1' as never,
        versionId: 'ver_1' as never,
        snapshotId: `snp_${++counter}` as never,
        startedBy: 'user_owner',
        now: clock.nowIso(),
        ids,
      });
      if (!created.ok) throw new Error(`seedRun failed: ${created.error.message}`);
      await database.runs.put(created.value);
      lastRunId = created.value.id;
      return created.value;
    },
    async seedTask(taskOptions: { kind?: string; maxAttempts?: number; runId?: string } = {}): Promise<Task> {
      if (taskOptions.runId === undefined && lastRunId === null) {
        throw new Error('seedTask requires a runId (or a prior seedRun) — canonical run ownership.');
      }
      const created = createTask({
        runId: (taskOptions.runId ?? lastRunId) as never,
        stageId: STAGE_ID,
        roleId: 'rol_1' as never,
        kind: taskOptions.kind ?? 'pack-a:build',
        now: clock.nowIso(),
        ids,
        ...(taskOptions.maxAttempts === undefined ? {} : { maxAttempts: taskOptions.maxAttempts }),
      });
      if (!created.ok) throw new Error(`seedTask failed: ${created.error.message}`);
      await database.tasks.put(created.value);
      return created.value;
    },
    command(run: WorkflowRun, type: RunCommandType, extra: Partial<RunCommand> = {}): RunCommand {
      counter += 1;
      clock.advance(1_000);
      return {
        commandId: `cmd_${String(counter).padStart(4, '0')}`,
        runId: run.id,
        type,
        expectedRevision: run.revision,
        actorId: 'tester',
        traceId: 'trace_durable',
        issuedAt: clock.nowIso(),
        ...extra,
      };
    },
    cleanup(): void {
      try {
        database.close();
      } catch {
        // already closed by a test
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };

  return fixture;
}

/** Unwrap a Result in tests, failing loudly. */
export function must<T, E extends { message: string; code?: string }>(
  result: { ok: true; value: T } | { ok: false; error: E },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code ?? ''}: ${result.error.message}`);
  return result.value;
}

/** Wrap a port so the Nth call throws — used to prove rollback (requirements B/C/J). */
export function failingEventStore(base: EventStorePort, failOnCall = 1): EventStorePort {
  let calls = 0;
  return {
    async append(events) {
      calls += 1;
      if (calls >= failOnCall) throw new Error('injected event-store failure');
      return base.append(events);
    },
    readFrom: (position, limit) => base.readFrom(position, limit),
    lastPosition: () => base.lastPosition(),
    readByAggregate: (type, id) => base.readByAggregate(type, id),
  };
}

export function failingLedger(base: CommandLedgerPort, failOnCall = 1): CommandLedgerPort {
  let calls = 0;
  return {
    async get(commandId) {
      return base.get(commandId);
    },
    async put(record: CommandLedgerRecord) {
      calls += 1;
      if (calls >= failOnCall) throw new Error('injected ledger failure');
      return base.put(record);
    },
    count: () => base.count(),
    trim: (limit) => base.trim(limit),
  };
}

export function failingRunStore(base: EntityStore<WorkflowRun>, failOnCall = 1): EntityStore<WorkflowRun> {
  let calls = 0;
  return {
    get: (id) => base.get(id),
    async put(entity) {
      calls += 1;
      if (calls >= failOnCall) throw new Error('injected run-store failure');
      return base.put(entity);
    },
    delete: (id) => base.delete(id),
    list: (page) => base.list(page),
  };
}

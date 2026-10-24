/**
 * Sprint 4 integration fixture: the Workflow Lifecycle service (engine package) over the
 * real SQLite persistence layer, plus the execution engine over the same database.
 *
 * Lives outside `packages/*` for the same reason as the Sprint 3 fixture: the
 * composition belongs to neither package, and `@companyos/persistence` must never gain a
 * dependency on `@companyos/engine`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FixedClock,
  SequenceIdFactory,
  type ChangeOp,
  type WorkflowGraph,
} from '@companyos/core';
import {
  createScriptedRegistry,
  createWorkflowEngine,
  createWorkflowLifecycle,
  type StageHandlerOutcome,
  type WorkflowEngine,
  type WorkflowLifecycle,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

export const EPOCH = Date.parse('2026-06-01T00:00:00.000Z');
export const STAGE_ID = 'stg_lifecycle' as never;

export interface LifecycleFixtureOptions {
  readonly script?: Readonly<Record<string, readonly StageHandlerOutcome[]>>;
  readonly failEvents?: boolean;
}

export interface LifecycleFixture {
  readonly dataDir: string;
  readonly clock: FixedClock;
  readonly ids: SequenceIdFactory;
  database(): DurableDatabase;
  lifecycle(): WorkflowLifecycle;
  engine(): WorkflowEngine;
  restart(): void;
  graph(nodeCount?: number): WorkflowGraph;
  ops(): readonly ChangeOp[];
  cleanup(): void;
}

export function makeLifecycleFixture(options: LifecycleFixtureOptions = {}): LifecycleFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-lifecycle-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();

  const open = (): DurableDatabase =>
    openDurableDatabase({
      dataDir,
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine', 'lifecycle'],
    });

  let database = open();

  const buildLifecycle = (db: DurableDatabase): WorkflowLifecycle =>
    createWorkflowLifecycle({
      ids,
      clock,
      templates: db.templates,
      locks: db.locks,
      proposals: db.proposals,
      snapshots: db.snapshots,
      runs: db.runs,
      // Optionally break the event sink to prove rollback (requirement 17).
      events:
        options.failEvents === true
          ? {
              append: async () => {
                throw new Error('injected event-store failure');
              },
              readFrom: (position: number, limit: number) => db.events.readFrom(position, limit),
              lastPosition: () => db.events.lastPosition(),
              readByAggregate: (type: string, id: string) => db.events.readByAggregate(type, id),
            }
          : db.events,
      unitOfWork: db.unitOfWork,
    });

  const buildEngine = (db: DurableDatabase): WorkflowEngine =>
    createWorkflowEngine({
      ids,
      clock,
      runs: db.runs,
      tasks: db.tasks,
      approvals: db.approvals,
      events: db.events,
      ledger: db.ledger,
      unitOfWork: db.unitOfWork,
      handlers: createScriptedRegistry(options.script ?? {}),
    });

  let lifecycle = buildLifecycle(database);
  let engine = buildEngine(database);

  return {
    dataDir,
    clock,
    ids,
    database: () => database,
    lifecycle: () => lifecycle,
    engine: () => engine,
    restart(): void {
      database.close();
      database = open();
      lifecycle = buildLifecycle(database);
      engine = buildEngine(database);
    },
    graph(nodeCount = 2): WorkflowGraph {
      const nodes = Array.from({ length: nodeCount }, (_value, index) => ({
        id: `n${index + 1}`,
        kind: 'pack-a:step',
        title: `Step ${index + 1}`,
        config: {},
      }));
      const edges = nodes.slice(1).map((node, index) => ({
        from: nodes[index]?.id ?? 'n1',
        to: node.id,
      }));
      return { nodes, edges };
    },
    ops(): readonly ChangeOp[] {
      return [{ op: 'update_node', path: 'nodes.1.config', after: { validated: true } }];
    },
    cleanup(): void {
      try {
        database.close();
      } catch {
        // already closed
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function must<T, E extends { message: string; code?: string }>(
  result: { ok: true; value: T } | { ok: false; error: E },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code ?? ''}: ${result.error.message}`);
  return result.value;
}

export const shouldFail = async <E extends { code: string }>(
  result:
    | { ok: true; value: unknown }
    | { ok: false; error: E },
): Promise<E> => {
  if (result.ok) throw new Error('expected a failure, but the operation succeeded');
  return result.error;
};

/**
 * Stage handlers — the engine's extension point (Sprint 2: FAKE/STUB ONLY).
 *
 * What a real deployment plugs in here (P1/P2) is an Agent Runtime / tool
 * invocation. Sprint 2 deliberately ships deterministic stubs only, so every
 * execution scenario (success, retry, exhaustion, block) is reproducible without
 * a network call. See the Sprint 2 prohibition list in `AGENTS.md` §3.
 */
import {
  normalizeStageHandlerResult,
  type StageHandlerResult,
  type StageHandlerStatus,
} from '@companyos/core';
import type { StageId, TaskId } from '@companyos/core';

export interface StageExecutionContext {
  readonly runId: string;
  readonly stageId: StageId;
  readonly taskId: TaskId;
  /** Opaque, pack-defined work kind (e.g. `pack-a:build`). */
  readonly kind: string;
  /** 1-based attempt number for this task. */
  readonly attempt: number;
  /** Branch selected at planning time, or `null` when no branch was declared. */
  readonly branch: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type StageHandlerOutcome = StageHandlerStatus;

/**
 * What a handler may RETURN: the bare status (Sprint 2 form, still legal) or the canonical
 * structured result carrying a bounded, versioned output envelope (Task-18-07). The engine
 * normalizes at ONE boundary (`normalizeStageHandlerResult`) and then operates on the
 * structured form only, so no handler has to migrate to keep working.
 */
export type StageHandlerReturn = StageHandlerOutcome | StageHandlerResult;

/**
 * A stage handler.
 *
 * CONTRACT (review finding MEDIUM): a handler runs **inside** the engine's per-run
 * critical section. It must therefore NEVER call back into `engine.dispatch()` for
 * its own run — that would await the promise chain it is already inside. The engine
 * refuses such a call with `CONFLICT` (`details.reason = 'reentrant_dispatch'`)
 * instead of deadlocking, but a correct handler simply reports an outcome.
 *
 * Task-18-07 CONTRACT: a handler may attach a bounded `StageHandlerOutput` to a `succeeded`
 * result. That envelope is the ONLY carrier between a handler's structured result and the
 * canonical Review/Validation sinks — the engine persists it on `Task.outputs` and a trusted
 * carrier routes it. A handler must NOT parse or invent lifecycle facts; it reports what it
 * actually did.
 */
export interface StageHandler {
  readonly id: string;
  /** Must be deterministic for a given context in Sprint 2. */
  execute(context: StageExecutionContext): Promise<StageHandlerReturn> | StageHandlerReturn;
}

/**
 * Normalize a handler's return value into the ONE canonical form the engine operates on.
 * This is the single boundary the Boss's migration rule asks for: legacy strings lift, and a
 * malformed structured result is a refusal rather than a silent downgrade.
 */
export const normalizeHandlerResult = (
  value: StageHandlerReturn,
): ReturnType<typeof normalizeStageHandlerResult> => normalizeStageHandlerResult(value);

export interface StageHandlerRegistry {
  /** Resolve the handler for a task, preferring a branch-specific binding. */
  resolve(kind: string, branch: string | null): StageHandler | null;
}

/** Always succeeds. */
export const alwaysSucceed = (id = 'stub.always-succeed'): StageHandler => ({
  id,
  execute: (): StageHandlerReturn => 'succeeded',
});

/** Always fails — used for exhaustion and failure-path tests. */
export const alwaysFail = (id = 'stub.always-fail'): StageHandler => ({
  id,
  execute: (): StageHandlerReturn => 'failed',
});

/** Fails the first `failures` attempts, then succeeds (retry-success test). */
export const failTimes = (failures: number, id = 'stub.fail-times'): StageHandler => {
  let seen = 0;
  return {
    id,
    execute: () => {
      seen += 1;
      return seen <= failures ? 'failed' : 'succeeded';
    },
  };
};

/**
 * A registry driven by an explicit, ordered script per task kind — the most
 * deterministic double available: the Nth call for a kind returns the Nth outcome.
 * When a script is exhausted the handler succeeds (so tests never hang on an
 * accidental extra call).
 */
export function createScriptedRegistry(
  script: Readonly<Record<string, readonly StageHandlerOutcome[]>> = {},
): StageHandlerRegistry {
  const queues = new Map<string, StageHandlerOutcome[]>(
    Object.entries(script).map(([kind, outcomes]) => [kind, [...outcomes]]),
  );
  const handlerFor = (key: string): StageHandler => ({
    id: `stub.scripted:${key}`,
    execute: () => {
      const queue = queues.get(key);
      if (queue === undefined || queue.length === 0) return 'succeeded';
      const next = queue.shift();
      return next ?? 'succeeded';
    },
  });
  return {
    resolve: (kind: string, branch: string | null): StageHandler => {
      const branchKey = branch === null ? null : `${branch}:${kind}`;
      if (branchKey !== null && queues.has(branchKey)) return handlerFor(branchKey);
      return handlerFor(kind);
    },
  };
}

/** Map of `kind → handler` (convenience for simple cases). */
export function createStaticRegistry(
  handlers: Readonly<Record<string, StageHandler>>,
): StageHandlerRegistry {
  return {
    resolve: (kind: string, branch: string | null): StageHandler | null =>
      handlers[`${branch ?? ''}:${kind}`] ?? handlers[kind] ?? null,
  };
}

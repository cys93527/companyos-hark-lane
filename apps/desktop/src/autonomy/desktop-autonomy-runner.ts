/**
 * STAGE 2/4 — the desktop-side autonomy starter (removes the manual 继续 requirement).
 *
 * What it is: a THIN, main-process-only launcher around the ALREADY-COMPOSED canonical
 * autonomy driver (`CoreServices.autonomyDriver`, Stage 9). It owns NO domain truth, keeps
 * NO run state, decides nothing about Tasks/Attempts/Validation and is NOT a second
 * scheduler — the canonical driver re-reads durable state every step and invokes the
 * canonical `goal.advance`.
 *
 * Invariants enforced here:
 *   - exactly ONE active driver per Goal run (a second start for the same run is refused);
 *   - a Goal created through the client starts its driver immediately, so the user never
 *     clicks 继续 again;
 *   - on app start, every non-terminal goal run gets its driver back — restart relies on
 *     canonical durable recovery, never on renderer memory;
 *   - the loop stops on terminal success/failure, PAUSED, an approval/authority decision
 *     or a true external blocker — all classified canonically inside the driver.
 *
 * STAGE 4 — bounded stall-resume: the driver's stall detector watches the GOAL run's
 * canonical fingerprint, which legitimately stays `EXECUTING` for a long stretch while the
 * EXECUTION run progresses through REVIEWING/VALIDATING. When a driver generation ends in
 * `AUTONOMY_STALLED` while durable truth still shows the goal run non-terminal, the
 * launcher starts a NEW generation after a bounded cool-down (at most
 * `maxStallResumes` consecutive times). This is not a second scheduler and not a replay
 * loop: each generation re-reads canonical truth, the guard is counted, and terminal /
 * approval / external-blocker classifications are never restarted.
 */
import type { Logger } from '@companyos/observability';
import { isRunTerminal, type RunState } from '@companyos/core';
import { storageBoundaryErrorOf } from '@companyos/persistence';

import type { CoreServices } from '../core-services.js';

/** The canonical goal workflow id every desktop-created Goal belongs to. */
const GOAL_WORKFLOW_ID = 'wf-companyos-goal';

export interface DesktopAutonomyRunner {
  /** Start the driver for one run. Returns false when one is already active for it. */
  readonly start: (companyId: string, runId: string) => boolean;
  /** Runs with an active driver (bounded by the goal runs in this database). */
  readonly activeRunIds: () => readonly string[];
  /**
   * Restart-time recovery: every non-terminal goal run in durable truth gets its driver
   * back. Terminal, paused and approval-bound runs are left to canonical recovery.
   */
  readonly resumeNonTerminalGoalRuns: (core: Pick<CoreServices, 'database'>) => Promise<readonly string[]>;
}

export interface DesktopAutonomyRunnerDeps {
  readonly companyId: string;
  readonly driver: CoreServices['autonomyDriver'];
  readonly logger: Logger | null;
  /** Bounded consecutive stall-resumes per goal run (default 3). */
  readonly maxStallResumes?: number;
  /** Cool-down between a stall terminal and the resumed generation (default 30s). */
  readonly stallResumeDelayMs?: number;
  /** Injectable timer for deterministic tests (defaults to global setTimeout). */
  readonly scheduleDelay?: (fn: () => void, ms: number) => void;
  /**
   * Re-read the canonical state of one goal run from durable truth (wired to the durable
   * run store). A null/terminal answer cancels the resume.
   */
  readonly goalRunState?: (runId: string) => Promise<string | null>;
}

export const createDesktopAutonomyRunner = (deps: DesktopAutonomyRunnerDeps): DesktopAutonomyRunner => {
  const active = new Map<string, Promise<unknown>>();
  const stallResumes = new Map<string, number>();
  const maxStallResumes = deps.maxStallResumes ?? 3;
  const stallResumeDelayMs = deps.stallResumeDelayMs ?? 30_000;
  const scheduleDelay =
    deps.scheduleDelay ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref?.();
    });

  /**
   * 25b98d1/N25-R1 — RECOVERABLE LAUNCHER OUTCOMES. A transient PERSISTENCE failure
   * (the driver exits typed, or a reconciliation/settlement write throws) is NOT a
   * completed run and NOT an unhandled crash: it is a supported recoverable outcome —
   * the EXISTING bounded stall-resume (counted, delayed) keeps the canonical
   * progression owner alive so a later scheduled resume advances the SAME Run once
   * storage is healthy. Fatal non-persistence errors are never retried forever.
   */
  const isRecoverablePersistenceFailure = (error: { readonly code?: unknown; readonly details?: unknown } | null): boolean => {
    if (error === null) return false;
    if (String(error.code ?? '') !== 'PERSISTENCE_FAILED') return false;
    const details = (error.details ?? {}) as Record<string, unknown>;
    return String(details['reason'] ?? '') !== 'FATAL_INVARIANT';
  };
  /**
   * 4a6e362 re-audit (N25-R1/N4-M1) — THE CANONICAL GOAL-RUN STATE READ. The four
   * outcomes are DISTINCT and never substitute for one another:
   *
   *   'terminal'      — read OK, the Goal is canonically finished → recovery ends.
   *   'non_terminal'  — read OK, the Goal still needs progression → keep an owner.
   *   'not_found'     — read OK, no such Goal → nothing to recover.
   *   'unknown'       — the READ FAILED with a recoverable storage fault → the state is
   *                     UNKNOWN; a database outage is NEVER interpreted as "the Goal is
   *                     terminal or gone", so the recovery owner is KEPT and re-queried
   *                     at the next legitimate scheduling point.
   *
   * A non-storage failure (programmer/validation) is re-thrown: it is never recovery
   * material and never loops.
   */
  type GoalRunRead =
    | { readonly kind: 'terminal' }
    | { readonly kind: 'non_terminal' }
    | { readonly kind: 'not_found' }
    | { readonly kind: 'unknown'; readonly operation: string };
  const readGoalRunState = async (runId: string): Promise<GoalRunRead> => {
    if (deps.goalRunState === undefined) return { kind: 'unknown', operation: 'goal.run.state.reader.unwired' };
    let raw: string | null;
    try {
      raw = await deps.goalRunState(runId);
    } catch (error) {
      const typed = storageBoundaryErrorOf(error, { operation: 'goal.run.state.read', pure: true });
      if (typed === null || typed.code !== 'PERSISTENCE_FAILED') {
        if (typed === null) throw error;
        throw typed;
      }
      return { kind: 'unknown', operation: 'goal.run.state.read' };
    }
    if (raw === null) return { kind: 'not_found' };
    return isRunTerminal(raw as RunState) ? { kind: 'terminal' } : { kind: 'non_terminal' };
  };
  const scheduleBoundedResume = async (companyId: string, runId: string, why: string): Promise<void> => {
    if (deps.goalRunState === undefined) return;
    const used = stallResumes.get(runId) ?? 0;
    if (used >= maxStallResumes) return;
    const read = await readGoalRunState(runId);
    if (read.kind === 'terminal' || read.kind === 'not_found') {
      // Canonically the state is KNOWN: stop the bounded mechanism and release the owner.
      stallResumes.delete(runId);
      releaseRecoveryOwner(runId);
      return;
    }
    if (read.kind === 'unknown') {
      // UNKNOWN never consumes the stall budget and never cancels recovery: the
      // non-exhausting persistence owner owns it.
      await schedulePersistenceRecovery(companyId, runId);
      return;
    }
    stallResumes.set(runId, used + 1);
    deps.logger?.info(why, { runId, resume: used + 1, maxStallResumes, delayMs: stallResumeDelayMs });
    scheduleDelay(() => {
      start(companyId, runId);
    }, stallResumeDelayMs);
  };
  /**
   * 6ec4d81 (N25-R1) → 4a6e362 (N4-R2) — RATE-BOUNDED, GOAL-SCOPED, NON-EXHAUSTING
   * PERSISTENCE RECOVERY. The recovery owner is keyed by the canonical Goal/Run identity:
   *   - the SAME Goal keeps at most ONE pending recovery timer;
   *   - DIFFERENT Goals own their recovery INDEPENDENTLY (a shared outage cannot make
   *     one Goal's recovery suppress another's);
   *   - ownership is never exhausted by a fixed attempt count — while durable truth says
   *     non-terminal (or UNKNOWN through a read failure) a future recovery owner exists,
   *     with capped exponential backoff (no busy loop, no provider call);
   *   - the registry is process-local SCHEDULING state only: it decides nothing durable
   *     and is cleaned up when truth is known terminal/gone or the timer fires;
   *   - after the app exits, the existing boot recovery re-derives everything from
   *     durable truth (this registry is never a second truth).
   */
  const recoveryOwners = new Map<string, { pending: boolean; generation: number }>();
  const recoveryOwnerOf = (runId: string): { pending: boolean; generation: number } => {
    const existing = recoveryOwners.get(runId);
    if (existing !== undefined) return existing;
    const created = { pending: false, generation: 0 };
    recoveryOwners.set(runId, created);
    return created;
  };
  const releaseRecoveryOwner = (runId: string): void => {
    recoveryOwners.delete(runId);
  };
  const persistRecoveryDelayMs = (generation: number): number => {
    const base = stallResumeDelayMs;
    return Math.min(base * 2 ** Math.min(generation, 5), 5 * 60_000);
  };
  const schedulePersistenceRecovery = async (companyId: string, runId: string): Promise<void> => {
    const owner = recoveryOwnerOf(runId);
    if (owner.pending) return; // exactly ONE scheduled recovery timer per Goal
    const read = await readGoalRunState(runId);
    if (read.kind === 'terminal' || read.kind === 'not_found') {
      releaseRecoveryOwner(runId); // truth is KNOWN and final: recovery ends and cleans up
      return;
    }
    // 'non_terminal' (keep progressing) or 'unknown' (read failed: UNKNOWN ≠ terminal).
    owner.pending = true;
    const delayMs = persistRecoveryDelayMs(owner.generation);
    deps.logger?.info('autonomy driver persistence-recovery scheduled', {
      runId,
      generation: owner.generation,
      delayMs,
      state: read.kind,
    });
    scheduleDelay(() => {
      owner.pending = false;
      owner.generation += 1;
      start(companyId, runId);
    }, delayMs);
  };
  const start = (companyId: string, runId: string): boolean => {
    const driver = deps.driver;
    if (active.has(runId) || driver === null) return false;
    const attempt = (async () => {
      const result = await driver.run({ companyId, runId });
      if (result.ok) {
        deps.logger?.info('autonomy driver finished', {
          runId,
          terminal: result.value.terminal,
          terminalReason: result.value.terminalReason,
          steps: result.value.stepsExecuted,
          durationMs: result.value.durationMs,
        });
        // STAGE 4 — bounded stall-resume (see module doc). Only when durable truth still
        // shows the goal run non-terminal, and never past the counted guard.
        if (result.value.terminal === 'AUTONOMY_STALLED') {
          await scheduleBoundedResume(companyId, runId, 'autonomy driver stall-resume scheduled');
        }
      } else {
        deps.logger?.warn('autonomy driver refused', { runId, code: result.error.code });
        // 25b98d1/N25-R1 — a transient persistence refusal keeps the progression owner.
        if (isRecoverablePersistenceFailure(result.error)) {
          await schedulePersistenceRecovery(companyId, runId);
        }
      }
    })()
      .catch(async (error: unknown) => {
        deps.logger?.error('autonomy driver crashed', {
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
        // 25b98d1/N25-R1 — a recoverable persistence crash keeps the owner (the fatal
        // class stops here: no infinite recovery for invariant corruption).
        if (
          error !== null &&
          typeof error === 'object' &&
          isRecoverablePersistenceFailure(error as { code?: unknown; details?: unknown })
        ) {
          await schedulePersistenceRecovery(companyId, runId);
        }
      })
      .finally(() => {
        active.delete(runId);
      });
    active.set(runId, attempt);
    deps.logger?.info('autonomy driver started', { runId, companyId });
    return true;
  };

  return {
    start,
    activeRunIds: () => [...active.keys()],

    resumeNonTerminalGoalRuns: async (core) => {
      const runs = (await core.database.runs.list({ limit: 500 })).items.filter(
        (run) => run.workflowId === GOAL_WORKFLOW_ID && !isRunTerminal(run.state),
      );
      const started: string[] = [];
      for (const run of runs) {
        if (start(deps.companyId, run.id)) started.push(run.id);
      }
      return started;
    },
  };
};

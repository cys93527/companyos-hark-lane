/**
 * Quiescent Startup Recovery Orchestrator (Sprint 14 — Task-14-02; ADR-0021).
 *
 * COMPOSES the frozen recovery primitives — AgentRuntime.recoverInterrupted,
 * ToolRegistry.recoverInvocations, WorkflowEngine.recover — it never re-implements
 * them and never touches Task rows. Electron/filesystem/SQLite-free: everything
 * arrives through ports and services.
 *
 * Frozen order (ADR-0021 D2): agent executions FIRST (external-side-effect residue
 * is archived to the safe durable state before anything else moves), then tool
 * invocations, then workflow runs.
 *
 * Single-flight (ADR-0021 D8, clarified by Task-14-02 §23): CONCURRENT run() calls
 * share the in-flight promise; a SEQUENTIAL second call RE-SCANS (durable state may
 * have changed) and naturally reports 0 new actions with zero duplicate events,
 * because every underlying scan is status-filtered idempotent.
 *
 * Safety failure (enumeration/store error, authorization denial, engine.recover
 * failure on a run this pass just classified as recoverable) → the whole result is
 * err: production must fail startup closed. Successfully completed interruptions are
 * NEVER rolled back — the next startup re-scans (ADR-0021 D7).
 */
import {
  domainError,
  err,
  ok,
  type DomainError,
  type EntityStore,
  type Result,
  type ToolRecoveryReport,
  type WorkflowRun,
  type AgentExecution,
} from '@companyos/core';

import { CRASHABLE_STATES, type RunRecoveryOutcome } from '../engine.js';

/** AUDIT-E2: one run the scan could not recover (JSON-serializable, no secrets/paths). */
export interface RunRecoveryFailure {
  readonly runId: string;
  readonly runState: string;
  readonly phase: 'RECOVERING_COMPLETE' | 'CRASH_RECOVER';
  readonly cause?: string;
}

/** Transient, JSON-serializable, no content bytes / secrets / absolute paths (ADR-0021 D9). */
export interface StartupRecoveryReport {
  readonly agentsInterrupted: number;
  readonly toolsInterrupted: number;
  readonly toolsWaitingApproval: number;
  readonly runsScanned: number;
  readonly runsRecovered: number;
  /**
   * AUDIT-E2: crash residue whose DURABLE cancel intent recovery honoured (the run is
   * now terminal-cancelled). A successful recovery outcome, not a safety failure.
   */
  readonly runsCancelled: number;
  readonly recoveringRunsCompleted: number;
  readonly runsPaused: number;
  readonly runsWaitingApproval: number;
  /** Everything now waiting on a human: paused / waiting-approval runs and tools, interrupted agents/tools. */
  readonly manualInterventionRequired: number;
}

export interface StartupRecoveryDeps {
  /** The repo's trusted startup actor (bootstrap-owner session actor convention). */
  readonly actorId: string;
  readonly runtime: {
    recoverInterrupted(actorId: string): Promise<Result<readonly AgentExecution[], DomainError>>;
    /** 25b98d1 — boot-scope stale admission-claim reclaim (optional wiring). */
    reclaimStaleClaims?(actorId: string): Promise<Result<readonly AgentExecution[], DomainError>>;
  };
  readonly tools: {
    recoverInvocations(actorId: string): Promise<Result<ToolRecoveryReport, DomainError>>;
  };
  readonly engine: {
    recover(runId: string): Promise<'resumed' | 'unrecoverable'>;
    /**
     * AUDIT-E2: the precise verdict (WorkflowEngine.recoverOutcome). Preferred when
     * wired; a bare frozen-port engine falls back to `recover`.
     */
    recoverOutcome?(runId: string): Promise<RunRecoveryOutcome>;
  };
  readonly runs: EntityStore<WorkflowRun>;
  /** Scan page size for run enumeration (default 200; exhaustiveness is mandatory). */
  readonly runsPageSize?: number;
}

export interface StartupRecoveryOrchestrator {
  run(): Promise<Result<StartupRecoveryReport, DomainError>>;
}

export function createStartupRecoveryOrchestrator(deps: StartupRecoveryDeps): StartupRecoveryOrchestrator {
  let inFlight: Promise<Result<StartupRecoveryReport, DomainError>> | null = null;
  /**
   * Runs THIS instance already recovered (ADR-0021 §17: "already recovered Run → no
   * duplicate crash/recovery cycle"). A recovered run legitimately rests in a crashable
   * state (its resumePoint) awaiting EXPLICIT continuation, so a sequential re-scan
   * must recognize its own output instead of re-issuing CRASH.DETECTED. Genuinely NEW
   * residue (a run that crashed after the first scan) is not in the memo and is still
   * recovered; a fresh process starts with an empty memo, so a real new crash cycle
   * across restarts still recovers.
   */
  const recoveredRunIds = new Set<string>();

  const fail = (reason: string, details: Record<string, unknown>): DomainError =>
    domainError('PERSISTENCE_FAILED', `Startup recovery failed: ${reason}.`, {
      reason,
      ...details,
    });

  const scan = async (): Promise<Result<StartupRecoveryReport, DomainError>> => {
    // ---- A. Agent executions: RUNNING/WAITING_EXTERNAL → INTERRUPTED (provider calls = 0) ----
    const agents = await deps.runtime.recoverInterrupted(deps.actorId);
    if (!agents.ok) return agents;
    // ---- A2. 25b98d1: stale pre-start ADMISSION CLAIMS (a dead process's logical-turn
    // owners) are reclaimed so their partial unique index entries free the turn. ----
    if (deps.runtime.reclaimStaleClaims !== undefined) {
      const claims = await deps.runtime.reclaimStaleClaims(deps.actorId);
      if (!claims.ok) return claims;
    }

    // ---- B. Tool invocations: STARTED → INTERRUPTED; WAITING_APPROVAL untouched ----
    const toolReport = await deps.tools.recoverInvocations(deps.actorId);
    if (!toolReport.ok) return toolReport;

    // ---- C. Workflow runs: exhaustive pagination over the run store ----
    const pageSize = deps.runsPageSize ?? 200;
    let runsScanned = 0;
    let runsRecovered = 0;
    let runsCancelled = 0;
    let recoveringRunsCompleted = 0;
    let runsPaused = 0;
    let runsWaitingApproval = 0;
    const failures: RunRecoveryFailure[] = [];
    for (let offset = 0; ; offset += pageSize) {
      let page: Awaited<ReturnType<EntityStore<WorkflowRun>['list']>>;
      try {
        page = await deps.runs.list({ limit: pageSize, offset });
      } catch (error) {
        return err(fail('RUN_ENUMERATION_FAILED', { cause: String(error) }));
      }
      runsScanned += page.items.length;
      for (const run of page.items) {
        if (run.state === 'PAUSED') {
          // Never auto-resumed (human decision, Sprint 2 test K).
          runsPaused += 1;
          continue;
        }
        if (run.state === 'WAITING_APPROVAL') {
          // Durable waiting state, not crash residue.
          runsWaitingApproval += 1;
          continue;
        }
        if (recoveredRunIds.has(run.id)) {
          // This instance's own prior output resting at its resumePoint — skip.
          continue;
        }
        const recovering = run.state === 'RECOVERING';
        if (recovering || (CRASHABLE_STATES as readonly string[]).includes(run.state)) {
          // RECOVERING: finish the EXISTING cycle only — engine.recover's RECOVERING
          // branch never re-issues CRASH.DETECTED.
          const phase: RunRecoveryFailure['phase'] = recovering ? 'RECOVERING_COMPLETE' : 'CRASH_RECOVER';
          let outcome: RunRecoveryOutcome;
          try {
            outcome = deps.engine.recoverOutcome !== undefined
              ? await deps.engine.recoverOutcome(run.id)
              : await deps.engine.recover(run.id);
          } catch (error) {
            // AUDIT-E2: a rejected recover is the typed per-run safety failure, never an
            // unhandled rejection escaping the startup path.
            failures.push({ runId: run.id, runState: run.state, phase, cause: String(error) });
            continue;
          }
          if (outcome === 'unrecoverable') {
            // AUDIT-E2: one bad run never stops the scan — every other crash residue is
            // still recovered on THIS boot; the failure is reported per run below.
            failures.push({ runId: run.id, runState: run.state, phase });
            continue;
          }
          if (outcome === 'cancelled') runsCancelled += 1;
          else if (recovering) recoveringRunsCompleted += 1;
          else runsRecovered += 1;
          recoveredRunIds.add(run.id);
          continue;
        }
        // Terminal + pre-execution states: nothing to do.
      }
      if (page.items.length < pageSize) break;
    }

    const firstFailure = failures[0];
    if (firstFailure !== undefined) {
      // Still fail closed (§43), but only AFTER the exhaustive scan, naming EVERY run that
      // could not be recovered (the first one's fields stay top-level for existing callers).
      return err(fail('RUN_RECOVERY_FAILED', { ...firstFailure, failures }));
    }

    return ok({
      agentsInterrupted: agents.value.length,
      toolsInterrupted: toolReport.value.interrupted.length,
      toolsWaitingApproval: toolReport.value.waitingApproval.length,
      runsScanned,
      runsRecovered,
      runsCancelled,
      recoveringRunsCompleted,
      runsPaused,
      runsWaitingApproval,
      manualInterventionRequired:
        agents.value.length +
        toolReport.value.interrupted.length +
        toolReport.value.waitingApproval.length +
        runsPaused +
        runsWaitingApproval,
    });
  };

  return {
    run() {
      // Concurrent single-flight: a second caller while a scan is in progress shares
      // the SAME promise (never a second scan). After settlement the next sequential
      // call starts a fresh scan.
      if (inFlight !== null) return inFlight;
      inFlight = scan().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

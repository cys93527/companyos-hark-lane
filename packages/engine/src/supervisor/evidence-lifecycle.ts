/**
 * Evidence → Run lifecycle applicator (Sprint 18 / Task-18-07).
 *
 * The `EVIDENCE_TO_RUN_LIFECYCLE_GAP` was that a run's lifecycle transitions could only be
 * driven by hand (or by a test), so an autonomous run could never legally reach COMPLETED: the
 * Supervisor's model output is NOT authority over the Run state machine.
 *
 * This is the deterministic, non-reasoning seam that closes it: the CANONICAL durable evidence
 * (the latest T18-04 review report, the latest durable Validation batch) implies exactly one
 * legal Run event, and this applicator dispatches it through the engine's own command surface.
 * It never rewrites a Run row, never invents a transition, and re-reads the evidence
 * immediately before applying (TOCTOU: an old PASS cannot advance a newer failed state).
 *
 *   latest canonical Review PASS          + run REVIEWING  → REVIEW.PASS    (→ VALIDATING)
 *   latest canonical Review CHANGES/BLOCKED + run REVIEWING → REVIEW.REJECT (→ REWORK)
 *   latest canonical Validation satisfied + run VALIDATING → VALIDATION.PASS (→ FINALIZING)
 *   latest canonical Validation failed     + run VALIDATING → VALIDATION.FAIL (→ REWORK)
 *
 * A verdict a REQUEST_CORRECTIVE Decision already cited is consumed: the run acted on it, so
 * re-applying it after the corrective work would discard durable progress.
 */
import {
  domainError,
  err,
  ok,
  FAULT_CHECKPOINTS,
  type DomainError,
  type FaultCheckpointPort,
  type Result,
} from '@companyos/core';

import { reviewVerdictConsumedBy } from './supervisor-runtime.js';
import { latestCanonicalReportOf, type CanonicalReportOrder } from './canonical-report-order.js';

/** The canonical evidence readers this applicator consults (the SAME seams T18-06 uses). */
export interface EvidenceLifecycleReaders {
  /** The latest review report of one review task — the latest report, never the latest PASS. */
  getLatestReviewReport(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly actorId: string;
  }): Promise<
    Result<
      { readonly verdict: string; readonly artifactId: string; readonly createdAt: string } | null,
      DomainError
    >
  >;
  /**
   * STAGE 9B-FIX: the corrective GENERATION of a review anchor (the lineage round of its own
   * task, 0 when it has none). Optional; when it is absent every anchor ranks as generation 0.
   * Supplying it is what keeps the cross-anchor "latest report" choice semantic: a later
   * round's report is the newer work regardless of the wall clock, and an id only ever breaks
   * a tie between semantically equivalent reports.
   */
  lineageRoundOf?(taskId: string): Promise<number>;
  /**
   * The run's durable validation rows, newest first. Each row carries its own validator id,
   * stage and target artifact, so the applicator can supply the evidence gate's anchors from
   * DURABLE data instead of asking a caller (or a model) for them.
   */
  listValidations(runId: string): Promise<
    readonly {
      readonly id: string;
      readonly validatorId: string;
      readonly status: string;
      readonly stageId: string | null;
      readonly targetRef: string | null;
    }[]
  >;
  /** The required validators of the stage the gate must satisfy (the stage snapshot). */
  requiredValidators(input: {
    readonly runId: string;
    readonly stageId: string;
  }): Promise<Result<readonly string[], DomainError>>;
  /**
   * F1 closure (release-blocker re-audit): the cause ids every CORRECTIVE CHILD of the run
   * already cites (durable task truth). A failing validation named here is CONSUMED — the
   * run acted on it, so re-applying its FAIL would preempt the re-validation of the
   * corrected work (the gate unit would never run) and burn the corrective budget into
   * REWORK.EXHAUST. Optional: without it the applicator stays conservative and re-applies
   * the durable verdict.
   */
  correctiveCauseIds?(runId: string): Promise<readonly string[]>;
  /**
   * The run's supervisor decisions, newest first. Optional: without it the applicator cannot
   * recognize a review verdict that corrective work already consumed, so it stays conservative
   * and re-applies the transition the durable evidence implies.
   */
  listRunDecisions?(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly actorId: string;
  }): Promise<Result<readonly { readonly action: string; readonly evidenceRefs: readonly string[] }[], DomainError>>;
}

export interface EvidenceLifecycleEngine {
  dispatch(command: {
    readonly commandId: string;
    readonly runId: string;
    readonly type: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly traceId: string;
    readonly issuedAt: string;
    readonly reason?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  }): Promise<{ ok: boolean; error?: DomainError }>;
}

export interface EvidenceLifecycleDeps {
  /**
   * Task-18-08 deterministic fault-injection seam: absent in production (zero overhead),
   * armed by a test harness to prove the sink→lifecycle windows.
   */
  readonly faultCheckpoints?: FaultCheckpointPort;
  readonly runs: {
    get(
      runId: string,
    ): Promise<{ readonly id: string; readonly state: string; readonly revision: number } | null>;
  };
  readonly engine: EvidenceLifecycleEngine;
  readonly readers: EvidenceLifecycleReaders;
  readonly clock: { nowIso: () => string };
  readonly ids: { id: (prefix?: string) => string };
}

export interface AppliedLifecycleEvent {
  readonly runId: string;
  readonly event: string;
  readonly from: string;
  readonly to: string;
  /** The durable evidence that implied this event. */
  readonly evidence: string;
  /** True when the durable state already satisfied the transition (replay). */
  readonly replayed: boolean;
}

export interface EvidenceLifecycleApplicator {
  /**
   * Apply the ONE legal event the current durable evidence implies for this run. A run whose
   * state implies no event returns `applied: null` — nothing is invented.
   */
  applyEvidence(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly reviewTaskId?: string | null;
    /**
     * The run's review tasks, when the caller knows them: a corrective round's second review is
     * a NEW task, so the verdict that counts is the newest report ACROSS the run's review
     * tasks — never one anchored task's possibly-consumed report. Absent ⇒ the single anchor.
     */
    readonly reviewTaskIds?: readonly string[] | null;
    readonly actorId: string;
    readonly traceId?: string;
  }): Promise<Result<AppliedLifecycleEvent | null, DomainError>>;
}

const FAILED_VALIDATION_STATUSES: readonly string[] = ['fail', 'error'];

export function createEvidenceLifecycleApplicator(
  deps: EvidenceLifecycleDeps,
): EvidenceLifecycleApplicator {
  const applyEvidence = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly reviewTaskId?: string | null;
    readonly reviewTaskIds?: readonly string[] | null;
    readonly actorId: string;
    readonly traceId?: string;
  }): Promise<Result<AppliedLifecycleEvent | null, DomainError>> => {
    const run = await deps.runs.get(input.runId);
    if (run === null) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist.`, { reason: 'RUN_MISSING' }),
      );
    }
    const traceId = input.traceId ?? deps.ids.id('trace');

    /* ---- REVIEWING: the latest canonical review decides ------------------------- */
    if (run.state === 'REVIEWING' && (input.reviewTaskId != null || input.reviewTaskIds != null)) {
      /*
       * TOCTOU: re-read the latest review immediately before applying. When the caller names the
       * run's review tasks, the verdict that counts is the NEWEST report across them, because a
       * corrective round's second review is a different task whose PASS must outrank the
       * consumed first-round verdict. "Newest" is the STAGE 9B-FIX semantic order — corrective
       * generation first, then createdAt inside one generation, then artifactId only between
       * equivalent candidates — never an id choice between non-equivalent reports.
       */
      const anchors =
        input.reviewTaskIds != null && input.reviewTaskIds.length > 0
          ? input.reviewTaskIds
          : input.reviewTaskId != null
            ? [input.reviewTaskId]
            : [];
      const candidates: ({
        readonly verdict: string;
        readonly artifactId: string;
        readonly createdAt: string;
      } & CanonicalReportOrder)[] = [];
      for (const anchor of [...new Set(anchors)].slice(0, 8)) {
        const report = await deps.readers.getLatestReviewReport({
          companyId: input.companyId,
          runId: run.id,
          reviewTaskId: anchor,
          actorId: input.actorId,
        });
        if (!report.ok) return report;
        if (report.value === null) continue;
        candidates.push({
          ...report.value,
          lineageRound: deps.readers.lineageRoundOf === undefined ? 0 : await deps.readers.lineageRoundOf(anchor),
        });
      }
      const latest = latestCanonicalReportOf(candidates);
      if (latest === null) return ok(null);
      const verdict = latest.verdict;
      /*
       * A verdict that corrective work already consumed is NOT re-applied. The run that comes
       * back from REWORK re-enters REVIEWING through the frozen machine's own EXECUTION.COMPLETE,
       * and its review task may legitimately have no second round yet: re-applying the SAME
       * CHANGES_REQUESTED would undo work that is already durable. The Decision that cited this
       * report is the durable proof the verdict was acted on — never a counter, never a race.
       */
      if (verdict !== 'PASS' && deps.readers.listRunDecisions !== undefined) {
        const history = await deps.readers.listRunDecisions({
          companyId: input.companyId,
          runId: run.id,
          actorId: input.actorId,
        });
        if (!history.ok) return history;
        // The SAME predicate the turn context uses for its blocking conditions (T18-07 authority
        // corrective): one rule, two seams, no fork.
        if (reviewVerdictConsumedBy(history.value, latest.artifactId)) return ok(null);
      }
      const event = verdict === 'PASS' ? 'REVIEW.PASS' : 'REVIEW.REJECT';
      // Task-18-08: the canonical review is durable and the lifecycle event has not landed.
      await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.reviewSinkBeforeLifecycle);
      const dispatched = await deps.engine.dispatch({
        commandId: `evidence-review:${run.id}:${String(run.revision)}:${verdict}`,
        runId: run.id,
        type: event,
        expectedRevision: run.revision,
        actorId: input.actorId,
        traceId,
        issuedAt: deps.clock.nowIso(),
        reason: `latest canonical review verdict is ${verdict}`,
      });
      if (!dispatched.ok) {
        return err(dispatched.error ?? domainError('PERSISTENCE_FAILED', `${event} was refused.`));
      }
      const after = await deps.runs.get(run.id);
      return ok({
        runId: run.id,
        event,
        from: run.state,
        to: after?.state ?? run.state,
        evidence: `review:${verdict}`,
        replayed: false,
      });
    }

    /* ---- VALIDATING: the latest durable validation batch decides ---------------- */
    if (run.state === 'VALIDATING') {
      const rows = await deps.readers.listValidations(run.id);
      // The stage comes from the durable rows themselves (never a caller's claim), and the
      // required validators are read from that stage's PINNED snapshot.
      const stageId = rows.find((row) => row.stageId !== null)?.stageId ?? null;
      if (stageId === null) return ok(null);
      const required = await deps.readers.requiredValidators({ runId: run.id, stageId });
      if (!required.ok) return required;
      if (required.value.length === 0) return ok(null);
      const requiredIds = new Set(required.value);
      // The latest row per required validator wins; an older PASS can never override a newer
      // failure (latest evidence semantics, the same rule the corrective provisioner uses).
      const latestByValidator = new Map<
        string,
        {
          readonly id: string;
          readonly status: string;
          readonly stageId: string | null;
          readonly targetRef: string | null;
        }
      >();
      for (const row of rows) {
        if (!requiredIds.has(row.validatorId)) continue;
        // rows are newest-first, so the first row seen for a validator is the latest one.
        if (!latestByValidator.has(row.validatorId)) {
          latestByValidator.set(row.validatorId, {
            id: row.id,
            status: row.status,
            stageId: row.stageId,
            targetRef: row.targetRef,
          });
        }
      }
      const decided = [...latestByValidator.values()];
      if (decided.length === 0) return ok(null);
      /*
       * F1 closure (release-blocker re-audit): a failing row a corrective child of this run
       * already CITED as its cause is CONSUMED. Re-applying the stale FAIL here would move the
       * run straight back to REWORK — the VALIDATING gate unit that runs the NEW batch against
       * the corrected descendant would never get its turn, and the run would cycle corrective
       * rounds until REWORK.EXHAUST. Consumed failures neither fail the gate nor count as
       * satisfied: while one is the latest verdict of a required validator, the gate waits for
       * the re-validation batch (ok(null)) instead of guessing either way.
       */
      const consumed =
        deps.readers.correctiveCauseIds === undefined
          ? new Set<string>()
          : new Set(await deps.readers.correctiveCauseIds(run.id));
      const actionableFailure =
        decided.find(
          (row) => FAILED_VALIDATION_STATUSES.includes(row.status) && !consumed.has(row.id),
        ) ?? null;
      if (actionableFailure === null) {
        const revalidationOwed = decided.some((row) =>
          FAILED_VALIDATION_STATUSES.includes(row.status),
        );
        if (revalidationOwed) return ok(null);
      }
      const failed = actionableFailure !== null;
      const event = failed ? 'VALIDATION.FAIL' : 'VALIDATION.PASS';
      // Task-18-08: the canonical validation batch is durable and the lifecycle event has not
      // landed. Old PASS/FAIL cannot resurrect across this window.
      await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.validationSinkBeforeLifecycle);
      // The gate's anchors come from the DURABLE validation rows (their own stage and target),
      // never from a caller and never from a model. A FAIL anchors on the actionable row.
      const anchorStageId =
        (failed ? actionableFailure?.stageId ?? null : null) ??
        decided.find((row) => row.stageId !== null)?.stageId ??
        null;
      const targetRef =
        (failed ? actionableFailure?.targetRef ?? null : null) ??
        decided.find((row) => row.targetRef !== null)?.targetRef ??
        null;
      const artifactId =
        targetRef !== null && targetRef.startsWith('artifact:')
          ? targetRef.slice('artifact:'.length)
          : null;
      if (event === 'VALIDATION.PASS' && (artifactId === null || anchorStageId === null)) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The durable validation rows carry no gate anchors; the transition is refused rather than guessed.',
            {
              reason: 'EVIDENCE_LIFECYCLE_ANCHORS_MISSING',
              runId: run.id,
            },
          ),
        );
      }
      const dispatched = await deps.engine.dispatch({
        commandId: `evidence-validation:${run.id}:${String(run.revision)}:${event}`,
        runId: run.id,
        type: event,
        expectedRevision: run.revision,
        actorId: input.actorId,
        traceId,
        issuedAt: deps.clock.nowIso(),
        reason: failed
          ? 'the latest canonical validation failed'
          : 'the latest canonical validation satisfied the gate',
        ...(event === 'VALIDATION.PASS' ? { payload: { artifactId, stageId: anchorStageId } } : {}),
      });
      if (!dispatched.ok) {
        return err(dispatched.error ?? domainError('PERSISTENCE_FAILED', `${event} was refused.`));
      }
      const after = await deps.runs.get(run.id);
      return ok({
        runId: run.id,
        event,
        from: run.state,
        to: after?.state ?? run.state,
        evidence: `validation:${failed ? 'fail' : 'pass'}`,
        replayed: false,
      });
    }

    return ok(null);
  };

  return { applyEvidence };
}

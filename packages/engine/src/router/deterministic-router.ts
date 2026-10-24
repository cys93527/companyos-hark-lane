/**
 * Deterministic Model Router v1 (Sprint 10B) — the ONE implementation of `ModelRouterPort`.
 *
 * Pipeline (frozen by ADR-0014 §28):
 *   assertRouterRequestAllowed -> applyHardFilters (which itself validates the policy view)
 *   -> rankCandidates (frozen v1 weights) -> selectWinner (stable tie-break)
 *   -> buildRecommendation -> validateRecommendation -> audit
 *
 * The router RECOMMENDS. It never calls a provider, never executes an agent, never mutates policy
 * or registry data, and never executes a fallback: `decideFallback` is returned as a CONTRACT.
 */
import {
  applyHardFilters,
  assertRouterRequestAllowed,
  decideFallback,
  domainError,
  err,
  noCandidateOutcome,
  ok,
  rankCandidates,
  routerV1Policy,
  selectWinner,
  validateRecommendation,
  type Clock,
  type DomainError,
  type FallbackDecision,
  type FilteredCandidateSet,
  type ModelRecommendation,
  type ModelRecord,
  type ModelRouterPort,
  type RankingContext,
  type RankedCandidateEvaluation,
  type Result,
  type RouterDecisionRecord,
  type RouterDecisionStorePort,
  type RouterPositiveReason,
  type RouterRequest,
} from '@companyos/core';
import { ROUTER_VERSION } from '@companyos/core';

/** The audit payload surface (frozen): metadata + reason codes only. Never secrets or prompt text. */
export interface RouterAuditPayload {
  readonly requestId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly selectionMode: RouterRequest['selectionMode'];
  readonly routerVersion: string;
  readonly policySnapshotVersion: string;
  readonly modelRegistryRevision: string;
  readonly candidateCount: number;
  readonly rejectedCount: number;
  readonly selectedModelKey: string | null;
  readonly reasonCodes: readonly string[];
  readonly traceId: string;
  /** 10B.2 §五: repair provenance on a startup-reconciled event (same event type, extra marker). */
  readonly reconciled?: boolean;
  readonly repairReason?: 'MISSING_RECOMMENDATION_EVENT' | 'MISSING_NO_CANDIDATE_EVENT';
}

export interface RouterAuditEmitter {
  requested(payload: RouterAuditPayload): Promise<void>;
  candidatesBuilt(payload: RouterAuditPayload): Promise<void>;
  recommendationCreated(payload: RouterAuditPayload): Promise<void>;
  noCandidate(payload: RouterAuditPayload): Promise<void>;
  overrideRequested(payload: RouterAuditPayload): Promise<void>;
  overrideConfirmed(payload: RouterAuditPayload): Promise<void>;
}

/** Optional persistence of the decision, so "why then" stays answerable after a restart. */
export type { RouterDecisionRecord, RouterDecisionStorePort };

export interface DeterministicRouterDeps {
  readonly audit: RouterAuditEmitter;
  readonly clock: Clock;
  /** Optional id factory; defaults to a deterministic id derived from the request trace. */
  readonly ids?: { readonly next: (prefix: string) => string };
  /** Persistence bounds (10B.1 §十二): hard caps, never unbounded growth. */
  readonly maxStoredEvaluations?: number;
  readonly maxStoredRejections?: number;
  /** Registry snapshot revision, recorded for provenance. */
  readonly modelRegistryRevision: () => string;
  readonly decisions?: RouterDecisionStorePort;
  /** Provenance snapshots (optional): they are recorded, never used to pick a model. */
  readonly benchmarkVersion?: () => string | null;
  readonly performanceSnapshot?: () => string | null;
  /** Optional ranking inputs (provider health / latency / historical / benchmark snapshots). */
  readonly rankingContext?: (request: RouterRequest) => Partial<Omit<RankingContext, 'preferredModels'>>;
}

export interface DeterministicModelRouter extends ModelRouterPort {
  /** The frozen v1 policy this router obeys (weights + caps + stage order). */
  readonly policy: ReturnType<typeof routerV1Policy>;
  /** Pure fallback CONTRACT for a recommendation: the router never executes it. */
  fallbackContract(
    request: RouterRequest,
    outcome: Result<ModelRecommendation, DomainError>,
  ): FallbackDecision | null;
}

const contextFor = (request: RouterRequest, deps: DeterministicRouterDeps): RankingContext => ({
  estimatedInputTokens: request.estimatedInputTokens,
  requiredOutputTokens: request.requiredOutputTokens ?? null,
  requiredCapabilityCount: request.policyView.requiredCapabilities.length,
  nowMs: deps.clock.now(),
  ...(deps.rankingContext === undefined ? {} : deps.rankingContext(request)),
  preferredModels: request.policyView.preferredModels,
});

const auditPayload = (
  request: RouterRequest,
  deps: DeterministicRouterDeps,
  parts: {
    readonly candidates: number;
    readonly rejected: number;
    readonly selectedModelKey: string | null;
    readonly reasonCodes: readonly RouterPositiveReason[] | readonly string[];
  },
): RouterAuditPayload => ({
  requestId: request.requestId,
  taskId: request.taskId,
  roleId: request.roleId,
  selectionMode: request.selectionMode,
  routerVersion: ROUTER_VERSION,
  policySnapshotVersion: request.policyView.source.snapshotVersion,
  modelRegistryRevision: deps.modelRegistryRevision(),
  candidateCount: parts.candidates,
  rejectedCount: parts.rejected,
  selectedModelKey: parts.selectedModelKey,
  reasonCodes: [...parts.reasonCodes],
  traceId: request.traceId,
});

const emptyRecommendation = (
  request: RouterRequest,
  deps: DeterministicRouterDeps,
  decision: ModelRecommendation['decision'],
  parts: {
    readonly reasonCodes?: readonly RouterPositiveReason[];
    readonly rejected?: ModelRecommendation['rejectedCandidates'];
    readonly evaluations?: ModelRecommendation['candidateEvaluations'];
    readonly rejectionSummary?: ModelRecommendation['rejectionSummary'];
    readonly confidence?: number | null;
  } = {},
): ModelRecommendation => ({
  selectedModelKey: null,
  decision,
  reasonCodes: parts.reasonCodes ?? [],
  rejectedCandidates: parts.rejected ?? [],
  candidateEvaluations: parts.evaluations ?? [],
  rejectionSummary: parts.rejectionSummary ?? null,
  policySource: request.policyView.source,
  selectionMode: request.selectionMode,
  fallbackPolicy: request.policyView.fallback,
  estimatedCost: null,
  estimatedLatency: null,
  confidence: parts.confidence ?? null,
  routerVersion: ROUTER_VERSION,
  traceId: request.traceId,
  provenance: {
    routerVersion: ROUTER_VERSION,
    policySnapshotVersion: request.policyView.source.snapshotVersion,
    modelRegistryRevision: deps.modelRegistryRevision(),
    benchmarkVersion: deps.benchmarkVersion?.() ?? null,
    performanceSnapshot: deps.performanceSnapshot?.() ?? null,
  },
});

/** Hard caps for the persisted detail (10B.1 §十二): a 5000-model registry must not bloat a row. */
export const MAX_STORED_EVALUATIONS = 20;
export const MAX_STORED_REJECTIONS = 20;

const decisionRecord = (
  request: RouterRequest,
  deps: DeterministicRouterDeps,
  decisionId: string,
  recommendation: ModelRecommendation,
  ranked: readonly RankedCandidateEvaluation[],
): RouterDecisionRecord => {
  const maxEvaluations = deps.maxStoredEvaluations ?? MAX_STORED_EVALUATIONS;
  const maxRejections = deps.maxStoredRejections ?? MAX_STORED_REJECTIONS;
  const storedEvaluations = ranked.slice(0, maxEvaluations).map((entry) => ({
    modelKey: entry.modelKey,
    normalisedScore: entry.normalisedScore,
    availableWeights: entry.availableWeights,
    signalScores: entry.signalScores,
    reasonCodes: entry.reasonCodes,
  }));
  const storedRejections = recommendation.rejectedCandidates.slice(0, maxRejections);
  return {
    decisionId,
    requestId: request.requestId,
    taskId: request.taskId,
    roleId: request.roleId,
    selectionMode: request.selectionMode,
    selectedModelKey: recommendation.selectedModelKey,
    decision: recommendation.decision,
    reasonCodesJson: JSON.stringify(recommendation.reasonCodes),
    candidateEvaluationsJson: JSON.stringify({
      // 10B.2 §九: `totalCandidateCount` is what ENTERED the router; `eligibleCandidateCount` is
      // what survived the hard filters. Writing 0 total candidates for a no-eligible decision that
      // actually saw 10 candidates was ambiguous.
      totalCandidateCount: request.candidateModels.length,
      eligibleCandidateCount: ranked.length,
      storedEvaluationCount: storedEvaluations.length,
      truncated: ranked.length > storedEvaluations.length,
      evaluations: storedEvaluations,
    }),
    rejectedCandidatesJson: JSON.stringify({
      totalRejectedCount: recommendation.rejectedCandidates.length,
      storedRejectionCount: storedRejections.length,
      truncated: recommendation.rejectedCandidates.length > storedRejections.length,
      rejections: storedRejections,
      summary: recommendation.rejectionSummary?.summaryText ?? null,
    }),
    policySnapshotVersion: recommendation.provenance.policySnapshotVersion,
    modelRegistryRevision: recommendation.provenance.modelRegistryRevision,
    benchmarkVersion: recommendation.provenance.benchmarkVersion,
    performanceSnapshot: recommendation.provenance.performanceSnapshot,
    routerVersion: ROUTER_VERSION,
    traceId: request.traceId,
    createdAt: deps.clock.nowIso(),
  };
};

/** One gap the startup reconciliation found: a persisted decision without its audit event. */
export interface RouterAuditGap {
  readonly decisionId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly selectedModelKey: string | null;
  readonly reasonCodes: readonly string[];
  /** Real values copied from the decision row (the repair event must not invent them). */
  readonly selectionMode: RouterDecisionRecord['selectionMode'];
  readonly candidateCount: number;
  readonly rejectedCount: number;
  /** The outcome of the decision: it decides WHICH terminal event must be repaired. */
  readonly decision: RouterDecisionRecord['decision'];
}

export const ROUTER_TERMINAL_AUDIT_EVENT_TYPES = [
  'router.recommendation_created',
  'router.no_candidate',
] as const;

export type RouterTerminalAuditEventType = (typeof ROUTER_TERMINAL_AUDIT_EVENT_TYPES)[number];

/**
 * Repair with the SAME event type the live run would have emitted (review MEDIUM): a
 * NO_ELIGIBLE_MODEL decision must be repaired as `router.no_candidate`, never as
 * `router.recommendation_created` (which would claim a recommendation that never existed).
 */
export const repairEventTypeOf = (gap: RouterAuditGap): RouterTerminalAuditEventType =>
  gap.decision === 'NO_ELIGIBLE_MODEL' ? 'router.no_candidate' : 'router.recommendation_created';

export const repairReasonOf = (gap: RouterAuditGap): RouterAuditPayload['repairReason'] =>
  gap.decision === 'NO_ELIGIBLE_MODEL' ? 'MISSING_NO_CANDIDATE_EVENT' : 'MISSING_RECOMMENDATION_EVENT';

/**
 * Startup reconciliation (10B.1 §2 / 10B.2 §三/§四): decision persistence and event persistence are
 * NOT atomic, so a crash between them can leave a decision without its terminal audit event.
 *
 * IMPORTANT: a decision is "audited" when the CALLER reports its requestId as covered by EITHER
 * `router.recommendation_created` (RECOMMENDED) or `router.no_candidate` (NO_ELIGIBLE_MODEL).
 * Reporting only one type would turn every other outcome into a false gap and write a spurious
 * repair event (audit falsification).
 */
export function reconcileRouterAudit(input: {
  readonly decisions: readonly RouterDecisionRecord[];
  /** requestIds the durable event log already covers (both terminal router.* types). */
  readonly auditedRequestIds: readonly string[];
}): readonly RouterAuditGap[] {
  const audited = new Set(input.auditedRequestIds);
  return input.decisions
    .filter((decision) => !audited.has(decision.requestId))
    .map((decision) => {
      const evaluations = JSON.parse(decision.candidateEvaluationsJson) as {
        readonly totalCandidateCount?: number;
      };
      const rejections = JSON.parse(decision.rejectedCandidatesJson) as { readonly totalRejectedCount?: number };
      return {
        decisionId: decision.decisionId,
        requestId: decision.requestId,
        traceId: decision.traceId,
        selectedModelKey: decision.selectedModelKey,
        reasonCodes: JSON.parse(decision.reasonCodesJson) as readonly string[],
        selectionMode: decision.selectionMode,
        candidateCount: evaluations.totalCandidateCount ?? 0,
        rejectedCount: rejections.totalRejectedCount ?? 0,
        decision: decision.decision,
      };
    });
}

/** The audit payload a repaired decision needs (same whitelist + repair provenance). */
export function repairPayloadOf(gap: RouterAuditGap): RouterAuditPayload {
  return {
    requestId: gap.requestId,
    taskId: 'unknown:repaired',
    roleId: 'unknown:repaired',
    selectionMode: gap.selectionMode,
    routerVersion: ROUTER_VERSION,
    policySnapshotVersion: 'unknown:repaired',
    modelRegistryRevision: 'unknown:repaired',
    candidateCount: gap.candidateCount,
    rejectedCount: gap.rejectedCount,
    selectedModelKey: gap.selectedModelKey,
    reasonCodes: gap.reasonCodes,
    traceId: gap.traceId,
    reconciled: true,
    repairReason: repairReasonOf(gap),
  };
}

/** The ONLY extra payload keys a repair event may add to the live 12-field whitelist. */
export const ROUTER_AUDIT_REPAIR_KEYS = ['reconciled', 'repairReason'] as const;

/**
 * The requestIds a reconciliation pass must treat as already audited: BOTH terminal router event
 * types, because a NO_ELIGIBLE_MODEL decision emits `router.no_candidate` instead.
 */
export { ROUTER_TERMINAL_AUDIT_EVENT_TYPES as ROUTER_TERMINAL_EVENT_TYPES };

/**
 * Startup reconciliation pass (10B.2 §三/§四): find decisions without a `router.recommendation_created`
 * event, re-emit the event for each gap, and report how many were repaired. Idempotent: once the
 * event exists the next pass finds no gap. The caller supplies the durable read/write functions, so
 * the SAME logic is exercised in tests and by the composition root.
 */
export async function reconcileAndRepairRouterAudit(input: {
  readonly listDecisions: () => Promise<readonly RouterDecisionRecord[]>;
  readonly listAuditedRequestIds: () => Promise<readonly string[]>;
  /** Receives the payload AND the terminal event type the repair must use (review MEDIUM fix). */
  readonly emitRepair: (payload: RouterAuditPayload, eventType: RouterTerminalAuditEventType) => Promise<void>;
}): Promise<{ readonly decisions: number; readonly repaired: number; readonly gaps: readonly RouterAuditGap[] }> {
  const decisions = await input.listDecisions();
  const auditedRequestIds = await input.listAuditedRequestIds();
  const gaps = reconcileRouterAudit({ decisions, auditedRequestIds });
  for (const gap of gaps) {
    await input.emitRepair(repairPayloadOf(gap), repairEventTypeOf(gap));
  }
  return { decisions: decisions.length, repaired: gaps.length, gaps };
}

/**
 * Build the deterministic router. Note the dependency direction: engine -> core contracts only.
 * It has no provider, no runtime and no persistence handle beyond the optional decision store.
 */
export function createDeterministicModelRouter(deps: DeterministicRouterDeps): DeterministicModelRouter {
  const policy = routerV1Policy();
  const nextDecisionId = (request: RouterRequest): string =>
    deps.ids?.next(`rtd_${request.requestId}`) ?? `rtd_${request.requestId}:${request.traceId}`;

  /** Persist the decision; a collision/storage fault surfaces as a Result error, never silently. */
  const persist = async (
    request: RouterRequest,
    recommendation: ModelRecommendation,
    ranked: readonly RankedCandidateEvaluation[],
  ): Promise<DomainError | null> => {
    if (deps.decisions === undefined) return null;
    const decisionId = nextDecisionId(request);
    try {
      await deps.decisions.save(decisionRecord(request, deps, decisionId, recommendation, ranked));
      return null;
    } catch (error) {
      return domainError('PERSISTENCE_FAILED', 'The router decision could not be persisted.', {
        reason: 'DECISION_PERSISTENCE_FAILED',
        decisionId,
        traceId: request.traceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const fallbackContract: DeterministicModelRouter['fallbackContract'] = (request, outcome) => {
    if (!outcome.ok) return null;
    const candidates: readonly ModelRecord[] = request.candidateModels.filter(
      (record) => record.modelKey === outcome.value.selectedModelKey,
    );
    return decideFallback({
      fallbackPolicy: request.policyView.fallback,
      candidates: outcome.value.decision === 'RECOMMENDED' ? candidates : [],
    });
  };

  return {
    policy,
    fallbackContract,

    async recommend(request: RouterRequest): Promise<Result<ModelRecommendation, DomainError>> {
      // 1. The FIRST rule: MANUAL never reaches the router.
      const allowed = assertRouterRequestAllowed(request);
      if (!allowed.ok) return allowed;
      await deps.audit.requested(auditPayload(request, deps, { candidates: request.candidateModels.length, rejected: 0, selectedModelKey: null, reasonCodes: [] }));

      // 2. Hard filters (they verify the derived policy view themselves).
      const filtered = applyHardFilters(request);
      if (!filtered.ok) return filtered;
      const outcome = filtered.value;
      const survivors: FilteredCandidateSet = outcome.candidates;
      await deps.audit.candidatesBuilt(
        auditPayload(request, deps, {
          candidates: survivors.length,
          rejected: outcome.rejected.length,
          selectedModelKey: null,
          reasonCodes: [],
        }),
      );

      // 3. No candidate -> NO_ELIGIBLE_MODEL with the real rejection summary. Never guess one.
      if (survivors.length === 0) {
        const summary = noCandidateOutcome(outcome);
        const recommendation = emptyRecommendation(request, deps, 'NO_ELIGIBLE_MODEL', {
          rejected: outcome.rejected,
          evaluations: [],
          rejectionSummary: summary.summary,
        });
        const validated = validateRecommendation(recommendation);
        if (!validated.ok) return validated;
        // Same frozen ordering as the success path: decision first, event second.
        if (deps.decisions !== undefined) {
          const failure = await persist(request, recommendation, []);
          if (failure !== null) return err(failure);
        }
        await deps.audit.noCandidate(
          auditPayload(request, deps, {
            candidates: 0,
            rejected: outcome.rejected.length,
            selectedModelKey: null,
            reasonCodes: recommendation.reasonCodes,
          }),
        );
        return ok(recommendation);
      }

      // 4./5. Rank the survivors with the frozen v1 weights, then the stable tie-break.
      const ranked = rankCandidates(survivors, contextFor(request, deps));
      const { winner, decidedByTieBreak } = selectWinner(ranked);
      if (winner === null) {
        return err(
          domainError('ROUTER_NOT_AVAILABLE', 'The ranking produced no winner.', { traceId: request.traceId }),
        );
      }

      const reasonCodes: readonly RouterPositiveReason[] = decidedByTieBreak
        ? [
            ...winner.reasonCodes.filter((code) => code !== 'TIE_BREAK_APPLIED'),
            'TIE_BREAK_APPLIED',
          ]
        : winner.reasonCodes.filter((code) => code !== 'TIE_BREAK_APPLIED');
      const recommendation: ModelRecommendation = {
        ...emptyRecommendation(request, deps, 'RECOMMENDED', {
          reasonCodes,
          rejected: outcome.rejected,
          evaluations: ranked,
          confidence: winner.availableWeights === 0 ? 0 : winner.normalisedScore,
        }),
        selectedModelKey: winner.modelKey,
        estimatedCost: winner.estimatedCost,
        estimatedLatency: winner.estimatedLatencyMs,
      };
      const validated = validateRecommendation(recommendation);
      if (!validated.ok) return validated;
      // 10B.1 §2 ordering: the DECISION is persisted first, the audit event second. The two are
      // NOT in one transaction, so a gap can exist and `reconcileRouterAudit()` repairs it.
      if (deps.decisions !== undefined) {
        const failure = await persist(request, recommendation, ranked);
        if (failure !== null) return err(failure);
      }
      await deps.audit.recommendationCreated(
        auditPayload(request, deps, {
          candidates: survivors.length,
          rejected: outcome.rejected.length,
          selectedModelKey: winner.modelKey,
          reasonCodes,
        }),
      );
      return ok(recommendation);
    },
  };
}

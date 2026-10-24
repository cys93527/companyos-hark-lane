/**
 * Model Router port (Sprint 10A, CONTRACT ONLY).
 *
 * The port exists so Sprint 10B has a frozen boundary to implement against. Nothing in the
 * codebase implements it yet: there is no router service, no binding in the composition root and
 * no call site. In particular the Agent Runtime does NOT depend on this port - the runtime still
 * requires an explicit `modelKey`, and an AUTO request without one keeps returning
 * `MODEL_SELECTION_REQUIRED` until a router is actually wired.
 */
import type { DomainError } from '../kernel/errors.js';
import type { Result } from '../kernel/result.js';
import type { ModelRecommendation, RouterRequest } from '../domain/model-router.js';
import type { FallbackMode } from '../domain/model-selection-policy.js';

export interface ModelRouterPort {
  /**
   * Produce a recommendation for an authorised request.
   *
   * Contract (frozen in ADR-0014, hardened in 10A.0.3):
   *  - the FIRST rule an implementation must run is `assertRouterRequestAllowed(request)`, which
   *    refuses a MANUAL request with `MANUAL_NOT_ROUTED` (MANUAL is never routed);
   *  - the candidate set must come from `applyHardFilters(request)`, which itself verifies
   *    `assertDerivedPolicyView(request.policyView)` before filtering;
   *  - the router may only order what survived those hard filters;
   *  - the recommendation must pass `validateRecommendation(recommendation)` BEFORE it is returned
   *    (an inconsistent recommendation is refused with `RECOMMENDATION_INVALID`);
   *  - it must never mutate policy, benchmark or registry data;
   *  - identical requests produce identical recommendations (§十一/O), because the semantic
   *    `snapshotVersion` and the view digest are content-derived and clock-independent.
   */
  recommend(request: RouterRequest): Promise<Result<ModelRecommendation, DomainError>>;
}

/** The reason codes callers must be able to render without asking the router again (§七). */
export interface RouterExplanation {
  readonly decision: ModelRecommendation['decision'];
  readonly selectedModelKey: string | null;
  readonly positiveReasons: readonly string[];
  readonly rejectedCandidates: readonly {
    readonly modelKey: string;
    readonly reasons: readonly string[];
  }[];
}

/** Whether a recommendation may be executed without further human input (§十二). */
export interface RouterExecutionContext {
  readonly fallbackPolicy: FallbackMode;
  readonly requiresUserConfirmation: boolean;
  readonly automaticWithinCandidates: boolean;
}

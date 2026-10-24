/**
 * Router application service (Sprint 10B.1 §四–§七).
 *
 * This is the ONLY production entry point for a recommendation. It accepts a *scope request*
 * (company/workflow/run/stage/task/role + requirements + mode) and builds everything the router
 * needs itself:
 *
 *   Policy Service   -> RouterPolicyView        (the renderer may never supply one)
 *   Model Registry   -> candidate snapshot      (the renderer may never supply candidates)
 *   health/snapshots -> ranking context         (never a UI-supplied "healthy")
 *
 * It returns a `ModelRecommendation` and nothing else: no execution, no provider call, no fallback.
 */
import {
  ROUTER_VERSION,
  applyHumanOverride,
  domainError,
  err,
  ok,
  type DomainError,
  type ModelRecommendation,
  type ModelRecord,
  type ModelRouterPort,
  type PolicyScopeRef,
  type Result,
  type RouterPolicyView,
} from '@companyos/core';

import type { RouterAuditEmitter, RouterAuditPayload } from './deterministic-router.js';

export interface RouterRecommendationInput {
  readonly companyId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly workflowId?: string | null;
  readonly runId?: string | null;
  readonly stageId?: string | null;
  readonly selectionMode: 'AUTO' | 'HYBRID';
  readonly requiredCapabilities?: readonly string[];
  readonly estimatedInputTokens: number;
  readonly requiredOutputTokens?: number | null;
  readonly traceId: string;
  readonly actorId: string;
}

export interface RouterRecommendationDeps {
  /** Derives the resolved policy view (the model selection policy service). */
  readonly policyView: (input: {
    readonly scopes: readonly PolicyScopeRef[];
    readonly requiredCapabilities: readonly string[];
    readonly actorId: string;
  }) => Promise<Result<RouterPolicyView, DomainError>>;
  /** Curated registry snapshot: enabled/disabled records the router may consider. */
  readonly listModels: () => Promise<readonly ModelRecord[]>;
  readonly router: ModelRouterPort;
  /** Scope ladder (Task -> Role -> Workflow -> Company). */
  readonly scopes: (input: RouterRecommendationInput) => readonly PolicyScopeRef[];
  /** Optional provenance snapshots (recorded, never used to choose). */
  readonly benchmarkVersion?: () => string | null;
  readonly performanceSnapshot?: () => string | null;
  /** Durable audit for the override flow (10B.1 §6). REQUIRED: a silently dropped audit is a bug. */
  readonly audit: RouterAuditEmitter;
}

/**
 * Stable registry revision (10B.1 §六): derived from registry CONTENT only - no clock, no random.
 * The same registry state always yields the same revision; any content change yields a new one.
 */
export function registryRevisionOf(records: readonly ModelRecord[]): string {
  const canonical = records
    .map((record) =>
      [
        record.modelKey,
        record.providerId,
        record.enabled ? 'on' : 'off',
        record.availability,
        String(record.contextWindow),
        String(record.maxOutputTokens ?? ''),
        record.pricing === null || record.pricing === undefined
          ? 'no-price'
          : `${String(record.pricing.inputPerMillion)}/${String(record.pricing.outputPerMillion)}`,
        Object.keys(record.capabilities)
          .sort()
          .map((key) => `${key}=${String((record.capabilities as unknown as Record<string, unknown>)[key])}`)
          .join('+'),
      ].join('|'),
    )
    .sort();
  // FNV-1a over the canonical form: deterministic, dependency-free, content-bound.
  let hash = 0x811c9dc5;
  for (const char of canonical.join('\u0000')) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `registry-content/${hash.toString(16).padStart(8, '0')}/${String(records.length)}`;
}

export interface RouterOverrideInput extends RouterRecommendationInput {
  readonly userModelKey: string;
  readonly recommendedModelKey: string | null;
  readonly confirm: boolean;
}

export interface RouterOverrideOutcome {
  readonly accepted: boolean;
  readonly agreement: 'SAME_AS_RECOMMENDATION' | 'DIFFERENT_FROM_RECOMMENDATION' | 'NO_RECOMMENDATION';
  readonly userFinalSelection: string;
  readonly routerRecommendation: string | null;
  readonly refusals: readonly string[];
  readonly confirmed: boolean;
}

export interface RouterApplicationService {
  recommend(input: RouterRecommendationInput): Promise<Result<ModelRecommendation, DomainError>>;
  /** 10B.1 §6: override goes through policy validation and is durably audited. */
  override(input: RouterOverrideInput): Promise<Result<RouterOverrideOutcome, DomainError>>;
  /** Exposed for tests/tools: the revision the router would record for a snapshot. */
  registryRevision(records: readonly ModelRecord[]): string;
}

export function createRouterApplicationService(deps: RouterRecommendationDeps): RouterApplicationService {
  const auditPayload = (input: RouterRecommendationInput, extra: Record<string, unknown>): RouterAuditPayload => ({
    requestId: `req_${input.traceId}`,
    taskId: input.taskId,
    roleId: input.roleId,
    selectionMode: input.selectionMode,
    routerVersion: ROUTER_VERSION,
    policySnapshotVersion: 'view-derived',
    modelRegistryRevision: 'registry-derived',
    candidateCount: 0,
    rejectedCount: 0,
    selectedModelKey: null,
    reasonCodes: [],
    traceId: input.traceId,
    ...extra,
  });
  return {
    registryRevision: registryRevisionOf,
    async override(input: RouterOverrideInput): Promise<Result<RouterOverrideOutcome, DomainError>> {
      const scopes = deps.scopes(input);
      const view = await deps.policyView({
        scopes,
        requiredCapabilities: input.requiredCapabilities ?? [],
        actorId: input.actorId,
      });
      if (!view.ok) return view;
      const records = await deps.listModels();
      const outcome = applyHumanOverride({
        recommendation: {
          selectedModelKey: input.recommendedModelKey,
          traceId: input.traceId,
          routerVersion: ROUTER_VERSION,
        },
        userModelKey: input.userModelKey,
        policyView: view.value,
        records,
      });
      const payload = auditPayload(input, { selectedModelKey: input.userModelKey });
      await deps.audit.overrideRequested(payload);
      if (input.confirm && outcome.accepted) await deps.audit.overrideConfirmed(payload);
      return ok({
        accepted: outcome.accepted,
        agreement: outcome.agreement,
        userFinalSelection: outcome.userFinalSelection,
        routerRecommendation: outcome.routerRecommendation,
        refusals: outcome.refusals,
        confirmed: input.confirm && outcome.accepted,
      });
    },
    async recommend(input: RouterRecommendationInput): Promise<Result<ModelRecommendation, DomainError>> {
      const scopes = deps.scopes(input);
      const view = await deps.policyView({
        scopes,
        requiredCapabilities: input.requiredCapabilities ?? [],
        actorId: input.actorId,
      });
      if (!view.ok) return view;
      const records = await deps.listModels();
      if (records.length === 0) {
        return err(
          domainError('ROUTER_NOT_AVAILABLE', 'The model registry snapshot is empty.', {
            reason: 'NO_REGISTERED_MODELS',
            traceId: input.traceId,
          }),
        );
      }
      const request = {
        requestId: `req_${input.traceId}`,
        companyId: input.companyId,
        ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
        taskId: input.taskId,
        roleId: input.roleId,
        selectionMode: input.selectionMode,
        policyView: view.value,
        estimatedInputTokens: input.estimatedInputTokens,
        ...(input.requiredOutputTokens === undefined ? {} : { requiredOutputTokens: input.requiredOutputTokens }),
        candidateModels: records,
        performanceMetadata: null,
        benchmarkMetadata: null,
        traceId: input.traceId,
      } as const;
      return deps.router.recommend(request);
    },
  };
}

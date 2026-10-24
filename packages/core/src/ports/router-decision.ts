/**
 * Router decision persistence port (Sprint 10B §二十四).
 *
 * It lives in Core so the dependency direction stays correct: the engine PRODUCES decisions and
 * the persistence layer STORES them, while Core owns the shape both sides agree on.
 */
import type { ModelRecommendation, RouterRequest } from '../domain/model-router.js';

export interface RouterDecisionRecord {
  readonly decisionId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly selectionMode: RouterRequest['selectionMode'];
  readonly selectedModelKey: string | null;
  readonly decision: ModelRecommendation['decision'];
  readonly reasonCodesJson: string;
  readonly candidateEvaluationsJson: string;
  readonly rejectedCandidatesJson: string;
  readonly policySnapshotVersion: string;
  readonly modelRegistryRevision: string;
  readonly benchmarkVersion: string | null;
  readonly performanceSnapshot: string | null;
  readonly routerVersion: string;
  readonly traceId: string;
  readonly createdAt: string;
}

export interface RouterDecisionStorePort {
  save(record: RouterDecisionRecord): Promise<void>;
}

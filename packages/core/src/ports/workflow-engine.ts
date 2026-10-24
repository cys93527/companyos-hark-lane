/**
 * Port: workflow engine — CONTRACT ONLY (Sprint 1 Task 7, ADR-0002).
 *
 * This port was missing from the earlier port list (flagged by the open-source
 * research §10.3): without it, "execute this run's stages" had no boundary and the
 * domain model would have been shaped by whatever implementation arrived first.
 *
 * Sprint 1 ships TYPES ONLY. The first implementation is Sprint 2 (Workflow
 * Engine, P0) and any later one (e.g. an external graph runtime) can only be
 * plugged in through this contract, in the outer ring.
 */
import type { RunSnapshotRef } from '../lifecycle/snapshot.js';
import type { ArtifactId, StageId, TaskId, ValidationId, WorkflowRunId } from '../kernel/identifiers.js';

/** Ask the engine to execute one stage of a run. */
export interface StageExecutionRequest {
  readonly runId: WorkflowRunId;
  readonly stageId: StageId;
  readonly taskIds: readonly TaskId[];
  /** The frozen pin the run executes against (planning §十一). */
  readonly snapshot: RunSnapshotRef;
}

export type StageExecutionOutcome = 'completed' | 'failed' | 'blocked' | 'waiting_approval';

export interface StageExecutionResult {
  readonly runId: WorkflowRunId;
  readonly stageId: StageId;
  readonly outcome: StageExecutionOutcome;
  readonly artifactIds: readonly ArtifactId[];
  readonly validationIds: readonly ValidationId[];
}

export interface WorkflowEnginePort {
  /** Move a run from routing into execution (L1 `ROUTING → EXECUTING`). */
  start(runId: WorkflowRunId): Promise<void>;
  /** Execute the next stage and report a structured outcome. */
  advance(request: StageExecutionRequest): Promise<StageExecutionResult>;
  /** Request cancellation of everything this run owns. */
  cancel(runId: WorkflowRunId): Promise<void>;
  /** Resume after a crash (L1 `RECOVERING → EXECUTING`), or report it unrecoverable. */
  recover(runId: WorkflowRunId): Promise<'resumed' | 'unrecoverable'>;
}

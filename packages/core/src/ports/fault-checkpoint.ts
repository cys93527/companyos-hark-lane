/**
 * Deterministic fault-injection seam (Sprint 18 / Task-18-08).
 *
 * PURPOSE: crash/recovery PROOF. A checkpoint is a named, stable point in a trusted service's
 * durable step sequence where a TEST HARNESS may deterministically simulate a process crash
 * (by throwing the crash sentinel) or observe ordering. The production default is the ABSENCE
 * of the dependency: every service takes it as an optional injection and a composition that
 * supplies nothing executes exactly the code it always executed — no environment variable, no
 * wall-clock race, no Math.random, and nothing a model, a user or a payload can reach.
 *
 * THIS IS NOT A WORKFLOW. Checkpoints never carry state, never form a state machine, never
 * ledger anything and never retry anything: canonical state remains CompanyOS's existing
 * durable state. A crash sentinel is deliberately NOT a DomainError, so no service can catch
 * it and misreport a crash as a domain failure (Task FAILED / Decision FAILED / Validation
 * FAIL); it must propagate out of the process, exactly like a real crash.
 */
import { domainError, type DomainError } from '../kernel/errors.js';

/** One named point in a trusted service's durable sequence. Names are frozen diagnostics. */
export type FaultCheckpointName = string;

/**
 * The port trusted services accept. Implementations must be deterministic: the same armed
 * checkpoint fires the same way every run, so a recovery test is a proof, not a race.
 */
export interface FaultCheckpointPort {
  /** Observe / crash at a named checkpoint. Throwing `FaultCrashError` simulates a crash. */
  checkpoint(name: FaultCheckpointName): Promise<void>;
}

/**
 * The CRASH SENTINEL: distinguishable from every domain failure by construction (it is not a
 * DomainError), so no `catch` that maps errors to domain results can swallow it silently.
 */
export class FaultCrashError extends Error {
  public readonly checkpoint: FaultCheckpointName;

  public constructor(checkpoint: FaultCheckpointName) {
    super(`fault-injection crash at "${checkpoint}"`);
    this.name = 'FaultCrashError';
    this.checkpoint = checkpoint;
  }
}

/** A checkpoint that refused to proceed can still be REPORTED with this helper. */
export const faultCheckpointRefused = (checkpoint: FaultCheckpointName): DomainError =>
  domainError('PERSISTENCE_FAILED', `The fault checkpoint "${checkpoint}" refused to proceed.`, {
    reason: 'FAULT_CHECKPOINT_REFUSED',
    checkpoint,
  });

/**
 * The frozen checkpoint vocabulary (Task-18-08 §6). Names follow the repo convention
 * (`after_<step>_before_<step>`). Adding a name is a diagnostic decision, never a behavior
 * change: the production default is absence.
 */
export const FAULT_CHECKPOINTS = {
  runGoalBeforeCommit: 'before_run_goal_commit',
  runGoalDuringTransaction: 'during_run_goal_creation_transaction',
  runGoalAfterCommit: 'after_run_goal_commit',
  supervisorExecutionCreated: 'after_supervisor_execution_created',
  providerResultBeforeDecision: 'after_provider_result_before_decision',
  decisionCommitBeforeExecutionComplete: 'after_decision_commit_before_execution_complete',
  decisionActionBeforeReceipt: 'after_decision_action_before_receipt',
  // Sprint21 final migration: the GENERIC EXECUTION-CLAIM timeline windows. Non-durable,
  // test/diagnostic hooks only — they can never alter Task/Attempt semantics.
  executionClaimBeforeExecutor: 'after_execution_claim_before_executor',
  executorResultBeforeSettlement: 'after_executor_result_before_settlement',
  taskSettledBeforeCarrier: 'after_task_settled_before_carrier',
  correctiveTaskCommitBeforeReceipt: 'after_corrective_task_commit_before_receipt',
  agentExecutionBeforeHandlerOutput: 'after_agent_execution_before_handler_output',
  reviewSinkBeforeTaskDone: 'after_review_sink_before_task_done',
  validationSinkBeforeTaskDone: 'after_validation_sink_before_task_done',
  reviewSinkBeforeLifecycle: 'after_review_sink_before_lifecycle',
  validationSinkBeforeLifecycle: 'after_validation_sink_before_lifecycle',
  reworkExhaustBeforeReturn: 'after_rework_exhaust_before_return',
  resumeTransitionBeforeNextTurn: 'after_resume_transition_before_next_turn',
  providerDescriptorBeforeRuntimeBind: 'after_provider_descriptor_before_runtime_bind',
  sessionBeforeProvider: 'after_session_before_provider',
  providerResultBeforeSessionResidue: 'after_provider_result_before_session_residue',
  sessionResidueBeforeExecutionSettlement: 'after_session_residue_before_execution_settlement',
  planArtifactBeforeExecutionSettlement: 'after_plan_artifact_before_execution_settlement',
  planContextBeforePlanProvider: 'after_plan_context_before_plan_provider',
  planProposalValidatedBeforePlanArtifact: 'after_plan_proposal_validated_before_plan_artifact',
  planExecutionSettledBeforeTaskSettlement: 'after_plan_execution_settled_before_task_settlement',
  plannerTaskSettledBeforeReturn: 'after_planner_task_settled_before_return',
  compiledGraphBeforeWorkflowPublish: 'after_compiled_graph_before_workflow_publish',
  workflowPublishedBeforeExecutionRun: 'after_workflow_published_before_execution_run',
  executionRunDurableBeforeTasks: 'after_execution_run_durable_before_tasks',
  taskMaterializationProgress: 'after_task_materialization_progress',
  compilationCompleteBeforeReturn: 'after_compilation_complete_before_return',
  // The repository handler's baseline window carries the vertical word by design (it names the
  // Sprint-17 seam), so its literal lives with that seam in the engine package — Core stays
  // industry-neutral (ADR-0002).
  // 6ec4d81 re-audit (N25-C1 / N6-A1 / N25-R1): the AgentExecution WRITE classes, emitted
  // immediately BEFORE the serialized write (outside any transaction): a harness can pause a
  // contender exactly before the claim, or interleave a cancellation into the start/settle
  // window, without holding the connection's write order.
  agentExecutionClaimBeforeWrite: 'before_agent_execution_claim_write',
  agentExecutionStartBeforeWrite: 'before_agent_execution_start_write',
  agentExecutionSettleBeforeWrite: 'before_agent_execution_settle_write',
  // 4a6e362 re-audit (N4-A1): the checkpoints AROUND the ONE decision-commit transaction —
  // transaction — the sink's write window and its pre-COMMIT tail. A harness can slow THIS
  // transaction alone without inflating any other transaction on the shared connection.
  decisionCommitBeforeTransaction: 'before_decision_commit_transaction',
  decisionCommitAfterTransaction: 'after_decision_commit_transaction',
} as const;

export type FaultCheckpointKey = keyof typeof FAULT_CHECKPOINTS;

/**
 * UI-PAPER-INK — the plan timeline's step states, projected from canonical truth only.
 *
 * Inputs: the plan the planner produced (run.budget plan: items with the compiled stageId
 * the main process derives as compiledNodeId(planId, planItemId)) and the overview of the
 * Goal's newest EXECUTION run (its stages carry per-state task counts; `executing` carries
 * the running task + its live attempt). Nothing here guesses: a step whose stage is not in
 * the execution overview (not compiled yet, or the compile read failed) is 待开始 only when
 * the Goal is still live; on an ended Goal it is 未执行. No durations are shown (no
 * canonical per-stage timing exists), no percentages, no ETA.
 */
import type { RuntimePhase } from './runtime-panel.js';
import type { TerminalOutcome } from './run-outcome.js';

export type PlanStepState = 'DONE' | 'EXECUTING' | 'AWAITING' | 'PENDING' | 'FAILED' | 'CANCELLED' | 'NOT_RUN';

export interface PlanStepInput {
  readonly planItemId: string;
  readonly objective: string;
  readonly taskKind: string | null;
  readonly stageId?: string | null;
}

export interface ExecutionStageObservation {
  readonly stageId: string;
  readonly taskCounts: Readonly<Record<string, number>>;
  readonly terminalSuccessful: boolean;
}

export interface ExecutionOverviewInput {
  readonly runId: string;
  readonly stages: readonly ExecutionStageObservation[];
  readonly executing: readonly { readonly taskId: string; readonly stageId: string; readonly attempt: { readonly attemptNumber: number } | null }[];
  readonly progress?: { readonly tasksTotal: number; readonly tasksDone: number; readonly stagesTotal?: number; readonly stagesTerminalSuccessful?: number };
}

export interface PlanStepView {
  readonly planItemId: string;
  readonly title: string;
  readonly state: PlanStepState;
  /** The right-hand state words, e.g. `执行中 · 尝试 1`. */
  readonly label: string;
}

export const PLAN_STEP_WORDS: Readonly<Record<PlanStepState, string>> = {
  DONE: '已完成',
  EXECUTING: '执行中',
  AWAITING: '等待批准',
  PENDING: '待开始',
  FAILED: '失败',
  CANCELLED: '已取消',
  NOT_RUN: '未执行',
};

const count = (counts: Readonly<Record<string, number>>, state: string): number => {
  const value = counts[state];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

export const projectPlanSteps = (input: {
  readonly items: readonly PlanStepInput[];
  readonly execution: ExecutionOverviewInput | null;
  readonly phase: RuntimePhase;
  readonly outcome: TerminalOutcome | null;
}): readonly PlanStepView[] =>
  input.items.map((item) => {
    const stage = item.stageId == null || input.execution === null
      ? undefined
      : input.execution.stages.find((entry) => entry.stageId === item.stageId);
    const running = item.stageId == null || input.execution === null
      ? undefined
      : input.execution.executing.find((entry) => entry.stageId === item.stageId);
    let state: PlanStepState;
    if (stage?.terminalSuccessful === true) state = 'DONE';
    else if (running !== undefined) state = input.phase === 'awaiting-user' ? 'AWAITING' : input.outcome === null ? 'EXECUTING' : 'NOT_RUN';
    else if (stage !== undefined && count(stage.taskCounts, 'FAILED') > 0) state = 'FAILED';
    else if (stage !== undefined && count(stage.taskCounts, 'CANCELLED') > 0) state = 'CANCELLED';
    else if (stage !== undefined && count(stage.taskCounts, 'RUNNING') > 0 && input.outcome === null) state = input.phase === 'awaiting-user' ? 'AWAITING' : 'EXECUTING';
    else if (input.outcome === 'CANCELLED') state = 'CANCELLED';
    else if (input.outcome !== null) state = 'NOT_RUN';
    else state = 'PENDING';
    const attempt = state === 'EXECUTING' && running?.attempt != null ? ` · 尝试 ${String(running.attempt.attemptNumber)}` : '';
    return {
      planItemId: item.planItemId,
      title: item.objective === '' ? item.planItemId : item.objective,
      state,
      label: `${PLAN_STEP_WORDS[state]}${attempt}`,
    };
  });

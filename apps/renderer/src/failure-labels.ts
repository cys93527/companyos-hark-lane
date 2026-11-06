/**
 * LIVE-CONTRACT-FILL (hark-live-goal 42075419348, UI defect b): the boss saw
 * "RUN_FAILED · Run is FAILED (execution_failed)." — a raw code and an English sentence,
 * and no hint that the real cause was the model hitting its per-response output limit.
 * Every canonical blocker code, run failure reason and typed provider detail has a Chinese
 * label here; an unknown code is shown as itself inside a Chinese frame and an unknown
 * free-text failure reason verbatim (never hidden, never guessed).
 */

export const BLOCKER_LABELS: Readonly<Record<string, string>> = {
  RUN_PAUSED: '运行已暂停',
  RUN_FAILED: '运行失败',
  RUN_CANCELLED: '运行已取消',
  RUN_TIMED_OUT: '运行超时',
  APPROVAL_REQUIRED: '等待批准',
  UNRESOLVED_FINDING: '审查发现未处理',
  VALIDATION_FAILED: '验证未通过',
  VALIDATION_REQUIREMENTS_MISSING: '缺少必需的验证',
  ROUND_LIMIT_EXHAUSTED: '返工轮次已用尽',
  EXECUTION_FAILURE: '任务执行失败',
  CAUSAL_CORRECTIVE_WAIT: '等待纠正任务完成',
  UNRECONCILED_CARRIER: '执行结果待核对',
};

export const RUN_FAILURE_REASON_LABELS: Readonly<Record<string, string>> = {
  execution_failed: '执行失败',
  timed_out: '超时',
  cancelled: '已取消',
  route_failed: '没有可用的执行路线',
  approval_denied: '审批被拒绝',
  delivery_failed: '交付失败',
  recovery_failed: '恢复失败',
};

export const FAILURE_DETAIL_LABELS: Readonly<Record<string, string>> = {
  EXECUTOR_KERNEL_OUTPUT_CEILING: '模型单次回复达到输出上限（一次写入的文件或回复过大）',
  PROVIDER_FAILED: '执行器（智能体内核）运行失败',
  PROVIDER_TIMEOUT: '执行器运行超时',
  EXECUTOR_CRASH: '执行器异常退出',
  GOAL_BUDGET_EXHAUSTED: '本目标的预算已用完',
  GOAL_USAGE_UNKNOWN: '上一次模型调用的用量未知，已停止继续调用',
  GOAL_DEADLINE_EXCEEDED: '已超过目标的截止时间',
  GOAL_ADMISSION_REFUSED: '模型调用未获准入',
  PROVIDER_OUTPUT_TRUNCATED: '模型回答达到输出上限被截断',
  PROVIDER_REASONING_EXHAUSTED: '模型的思考过程用完了输出上限，没有给出回答',
  CAPABILITY_MISSING: '模型未能给出可用的回答',
  PROVIDER_UNAVAILABLE: '模型服务暂时不可用',
};

const KERNEL_TURN_PREFIX = 'EXECUTOR_KERNEL_TURN_';

export const blockerLabel = (code: string): string => BLOCKER_LABELS[code] ?? `阻塞（${code}）`;

export const runFailureReasonLabel = (reason: string | null | undefined): string | null =>
  reason === null || reason === undefined || reason === '' ? null : (RUN_FAILURE_REASON_LABELS[reason] ?? reason);

export const failureDetailLabel = (code: string | null | undefined): string | null => {
  if (code === null || code === undefined || code === '') return null;
  const known = FAILURE_DETAIL_LABELS[code];
  if (known !== undefined) return known;
  if (code.startsWith(KERNEL_TURN_PREFIX)) return `智能体内核异常结束（${code.slice(KERNEL_TURN_PREFIX.length).toLowerCase()}）`;
  return `未归类的失败原因（${code}）`;
};

/** The typed failure behind a failed goal, as goal.workspace reads it back. */
export interface CanonicalAttemptFailure {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly failureCode: string | null;
  readonly detailCode: string | null;
  readonly settledAt: string | null;
}

/** The most specific Chinese reason: provider detail first, then the canonical attempt code. */
export const attemptFailureLabel = (failure: CanonicalAttemptFailure | null | undefined): string | null =>
  failure === null || failure === undefined ? null : (failureDetailLabel(failure.detailCode) ?? failureDetailLabel(failure.failureCode));

/** One blocker as the boss reads it: Chinese label, plus the real reason for a failed run. */
export const blockerText = (
  blocker: { readonly code: string },
  failure: CanonicalAttemptFailure | null | undefined,
  failureReason?: string | null,
): string => {
  const label = blockerLabel(blocker.code);
  if (blocker.code !== 'RUN_FAILED' && blocker.code !== 'RUN_TIMED_OUT' && blocker.code !== 'EXECUTION_FAILURE') return label;
  const why = attemptFailureLabel(failure) ?? runFailureReasonLabel(failureReason);
  return why === null ? label : `${label} · ${why}`;
};

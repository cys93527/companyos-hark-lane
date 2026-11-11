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
  // LIVE-CONTRACT-FILL run 5: the Goal's standing admission refusals (goal.workspace).
  GOAL_USAGE_UNKNOWN: '已阻塞 · 一次模型调用的用量未知，核对后才能继续',
  GOAL_BUDGET_EXHAUSTED: '已阻塞 · 本目标的预算已用完',
  GOAL_DEADLINE_EXCEEDED: '已阻塞 · 已超过目标的截止时间',
  // LIVE-CONTRACT-FILL run 6: one step reached its share of the goal budget.
  GOAL_STEP_SPEND_CAP_REACHED: '已阻塞 · 单个步骤的花费已达上限（目标预算的一部分），确认后才能继续',
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
  GOAL_STEP_SPEND_CAP_REACHED: '单个步骤的花费已达上限，已停止该步骤',
  EXECUTOR_KERNEL_CONTEXT_WINDOW_TOO_SMALL: '模型工作窗口过小，无法安全压缩上下文（需调高输入上限）',
  GOAL_ADMISSION_REFUSED: '模型调用未获准入',
  PROVIDER_OUTPUT_TRUNCATED: '模型回答达到输出上限被截断',
  PROVIDER_REASONING_EXHAUSTED: '模型的思考过程用完了输出上限，没有给出回答',
  CAPABILITY_MISSING: '所选模型不支持执行目标需要的对话（结构化文字）回答',
  PROVIDER_UNAVAILABLE: '模型服务暂时不可用',
  // UI-AUDIT-2 (user report 2026-11-11: "未归类的失败原因（POLICY_REFUSED）"): the engine's
  // execution error kinds and the typed admission / policy reasons, in plain Chinese.
  POLICY_REFUSED: '模型调用被公司规则拒绝（通常是预算未批准或模型不允许）',
  POLICY_DENIED: '模型调用被公司规则拒绝（通常是预算未批准或模型不允许）',
  GOAL_ADMISSION_BOUND_UNPROVEN: '所选模型没有批准的预算（预算为 0），付费调用被拒绝',
  GOAL_ADMISSION_IDENTITY_UNPROVEN: '无法确认所选模型的计费身份，付费调用被拒绝',
  GOAL_BUDGET_READ_FAILED: '读取目标预算失败，已停止调用模型',
  GOAL_BUDGET_STATE_INVALID: '目标预算记录异常，已停止调用模型',
  GOAL_BUDGET_OWNER_INVALID: '目标预算记录异常，已停止调用模型',
  GOAL_BUDGET_OWNER_CONFLICT: '目标预算记录冲突，已停止调用模型',
  GOAL_WORKSPACE_NOT_OPEN: '目标的工作空间没有打开',
  GOAL_WORKSPACE_NOT_BOUND: '目标没有绑定工作空间',
  GOAL_WORKSPACE_MISMATCH: '当前打开的工作空间不是这个目标的工作空间',
  GOAL_CANCEL_REQUESTED: '目标已请求取消',
  MODEL_BLOCKED_BY_POLICY: '公司规则不允许使用所选模型',
  MODEL_NOT_REGISTERED: '所选模型还没有添加（注册）',
  MODEL_UNAVAILABLE: '所选模型当前不可用（没有添加，或模型服务里找不到它）',
  MODEL_DISABLED: '所选模型已停用',
  COST_LIMIT_EXCEEDED: '超出公司规则允许的费用',
  LATENCY_LIMIT_EXCEEDED: '超出公司规则允许的响应时间',
  UNKNOWN_CAPABILITY: '所选模型缺少执行目标需要的能力',
  INVALID_OUTPUT: '模型的回答格式不对，无法使用',
  TIMEOUT: '模型调用超时',
  CANCELLED: '已取消',
  RATE_LIMITED: '模型服务限流，请稍后再试',
  AUTH_FAILED: '模型服务拒绝了 API Key（Key 无效、过期或余额不足）',
  PROVIDER_AUTH_FAILED: '模型服务拒绝了 API Key（Key 无效、过期或余额不足）',
};

/**
 * UI-AUDIT-2: the one action that fixes a failure, when there is one the user can take.
 * `budget` = approve a per-Goal budget (first-run setup), `model` = pick / add a chat model.
 */
export type FailureRemedy = 'budget' | 'model';

const REMEDIES: Readonly<Record<string, FailureRemedy>> = {
  GOAL_ADMISSION_BOUND_UNPROVEN: 'budget',
  GOAL_ADMISSION_IDENTITY_UNPROVEN: 'budget',
  GOAL_BUDGET_EXHAUSTED: 'budget',
  POLICY_REFUSED: 'budget',
  POLICY_DENIED: 'budget',
  COST_LIMIT_EXCEEDED: 'budget',
  CAPABILITY_MISSING: 'model',
  UNKNOWN_CAPABILITY: 'model',
  MODEL_BLOCKED_BY_POLICY: 'model',
  MODEL_NOT_REGISTERED: 'model',
  MODEL_UNAVAILABLE: 'model',
  MODEL_DISABLED: 'model',
};

export const failureRemedyOf = (failure: CanonicalAttemptFailure | null | undefined): FailureRemedy | null => {
  if (failure === null || failure === undefined) return null;
  return (failure.detailCode === null ? undefined : REMEDIES[failure.detailCode]) ?? (failure.failureCode === null ? undefined : REMEDIES[failure.failureCode]) ?? null;
};

export const REMEDY_LABELS: Readonly<Record<FailureRemedy, string>> = {
  budget: '查看预算设置',
  model: '选择对话模型',
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
  // UI-AUDIT-2: an unknown code is never the main text; it stays available in 详情.
  return '运行失败（原因代码见详情）';
};

/** The typed failure behind a failed goal, as goal.workspace reads it back. */
export interface CanonicalAttemptFailure {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly failureCode: string | null;
  readonly detailCode: string | null;
  /** The kernel's own error line ("CODE: message"), when the attempt carried one. */
  readonly detailMessage?: string | null;
  readonly settledAt: string | null;
}

const DETAIL_MESSAGE_MAX = 160;

/**
 * The most specific Chinese reason: provider detail first, then the canonical attempt code;
 * the kernel's own error line follows it (LIVE-CONTRACT-FILL run 6: "智能体内核异常结束（error）"
 * alone hid the cause).
 */
export const attemptFailureLabel = (failure: CanonicalAttemptFailure | null | undefined): string | null => {
  if (failure === null || failure === undefined) return null;
  const label = failureDetailLabel(failure.detailCode) ?? failureDetailLabel(failure.failureCode);
  const message = typeof failure.detailMessage === 'string' ? failure.detailMessage.trim() : '';
  if (message === '') return label;
  const shown = message.length <= DETAIL_MESSAGE_MAX ? message : `${message.slice(0, DETAIL_MESSAGE_MAX - 1)}…`;
  return label === null ? `失败原因：${shown}` : `${label}：${shown}`;
};

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

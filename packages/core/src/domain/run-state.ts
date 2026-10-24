/**
 * L1 — the GLOBAL execution state machine (17 states, 规划书 §三十三 / ADR-0003).
 *
 * This is the canonical "what is the company doing right now" machine. It is a
 * DIFFERENT LAYER from the template lifecycle (`lifecycle/machine.ts`, L2) and from
 * the Task/Stage local states (`stage.ts`, `task.ts`, L3). Never mix them.
 *
 * `docs/STATE_MACHINE.md` §4 mirrors this table — change both together.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

export const RUN_STATES = [
  'IDLE',
  'INITIALIZING',
  'DESIGNING_WORKFLOW',
  'WORKFLOW_REVIEW',
  'WORKFLOW_PUBLISHED',
  'PLANNING',
  'ROUTING',
  'WAITING_APPROVAL',
  'EXECUTING',
  'REVIEWING',
  'VALIDATING',
  'REWORK',
  'FINALIZING',
  'COMPLETED',
  'FAILED',
  'PAUSED',
  'RECOVERING',
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const RUN_EVENTS = [
  'START',
  'TEMPLATE_RESOLVED',
  'TEMPLATE_MISSING',
  'SUBMIT_DRAFT',
  'DRAFT_APPROVED',
  'DRAFT_REJECTED',
  'RUN_CREATED',
  'PLAN_READY',
  'ROUTE_RESOLVED',
  'ROUTE_FAILED',
  'APPROVAL_REQUIRED',
  'APPROVAL_GRANTED',
  'APPROVAL_DENIED',
  'EXECUTION_DONE',
  'EXECUTION_FAILED',
  'REVIEW_PASSED',
  'REVIEW_REJECTED',
  'REWORK_READY',
  'REWORK_EXHAUSTED',
  'VALIDATION_PASSED',
  'VALIDATION_FAILED',
  'DELIVERED',
  'OUTCOME_DELIVERED',
  'DELIVERY_FAILED',
  'PAUSE',
  'RESUME',
  'CRASH_DETECTED',
  'RECOVERED',
  'RECOVERY_FAILED',
  'CANCEL',
  'TIMEOUT',
] as const;

export type RunEvent = (typeof RUN_EVENTS)[number];

export interface RunTransitionRule {
  readonly event: RunEvent;
  readonly from: readonly RunState[];
  readonly to: RunState;
  /** Why this edge exists (planning reference or invariant it protects). */
  readonly effect: string;
  readonly emits: readonly string[];
}

/**
 * States a run may be PAUSED from.
 *
 * Deliberately NOT every non-terminal state (review finding HIGH-2): pausing is an
 * *execution-phase* concept — it writes a checkpoint so the run can continue. If
 * `IDLE` / `INITIALIZING` / `DESIGNING_WORKFLOW` / `WORKFLOW_REVIEW` /
 * `WORKFLOW_PUBLISHED` could pause, then `PAUSE` + `RESUME` would be two events
 * that jump straight into execution, skipping planning, routing and the approval
 * gate entirely.
 */
export const PAUSABLE_RUN_STATES: readonly RunState[] = [
  'PLANNING',
  'ROUTING',
  'WAITING_APPROVAL',
  'EXECUTING',
  'REVIEWING',
  'VALIDATING',
  'REWORK',
  'FINALIZING',
];

/** Where a resume/recovery may return to — the execution-phase set above. */
export const RESUMABLE_RUN_STATES: readonly RunState[] = PAUSABLE_RUN_STATES;

/** States a run may be cancelled from (every non-terminal state). */
const CANCELLABLE: readonly RunState[] = RUN_STATES.filter(
  (state) => state !== 'COMPLETED' && state !== 'FAILED',
);

export const RUN_TRANSITIONS: readonly RunTransitionRule[] = [
  { event: 'START', from: ['IDLE'], to: 'INITIALIZING', effect: '建立执行上下文', emits: ['run.started'] },
  {
    event: 'TEMPLATE_RESOLVED',
    from: ['INITIALIZING'],
    to: 'PLANNING',
    effect: '固定并校验 RunSnapshot（规划书 §十一）',
    emits: ['run.snapshot_pinned'],
  },
  {
    event: 'TEMPLATE_MISSING',
    from: ['INITIALIZING'],
    to: 'DESIGNING_WORKFLOW',
    effect: '没有可用 SOP，转 Chief 设计（规划书 §十二原则 12）',
    emits: ['run.sop_design_started'],
  },
  {
    event: 'SUBMIT_DRAFT',
    from: ['DESIGNING_WORKFLOW'],
    to: 'WORKFLOW_REVIEW',
    effect: 'Draft 提交评审',
    emits: ['run.draft_submitted'],
  },
  {
    event: 'DRAFT_APPROVED',
    from: ['WORKFLOW_REVIEW'],
    to: 'WORKFLOW_PUBLISHED',
    effect: 'Draft 通过评审并发布（L2 层另行记录版本）',
    emits: ['workflow.template.published'],
  },
  {
    event: 'DRAFT_REJECTED',
    from: ['WORKFLOW_REVIEW'],
    to: 'DESIGNING_WORKFLOW',
    effect: '退回修改',
    emits: ['run.draft_rejected'],
  },
  {
    event: 'RUN_CREATED',
    from: ['WORKFLOW_PUBLISHED'],
    to: 'PLANNING',
    effect: '由已发布模板创建 Run',
    emits: ['run.created'],
  },
  {
    event: 'PLAN_READY',
    from: ['PLANNING'],
    to: 'ROUTING',
    effect: 'Stage / Task 与验收标准已落定',
    emits: ['run.plan_ready'],
  },
  {
    event: 'ROUTE_RESOLVED',
    from: ['ROUTING'],
    to: 'EXECUTING',
    effect: '模型与工具绑定完成',
    emits: ['run.route_resolved'],
  },
  {
    event: 'ROUTE_FAILED',
    from: ['ROUTING'],
    to: 'FAILED',
    effect: '无可用模型或工具（规划书 §二十七 Fallback 的上层语义）',
    emits: ['run.route_failed'],
  },
  {
    event: 'APPROVAL_REQUIRED',
    from: ['PLANNING', 'ROUTING', 'EXECUTING'],
    to: 'WAITING_APPROVAL',
    effect: '进入人工审批门（规划书 §十一 / §三十六）',
    emits: ['run.approval_required'],
  },
  {
    event: 'APPROVAL_GRANTED',
    from: ['WAITING_APPROVAL'],
    to: 'EXECUTING',
    effect: '审批通过，继续执行',
    emits: ['run.approval_granted'],
  },
  {
    event: 'APPROVAL_DENIED',
    from: ['WAITING_APPROVAL'],
    to: 'FAILED',
    effect: '审批拒绝',
    emits: ['run.approval_denied'],
  },
  {
    event: 'EXECUTION_DONE',
    from: ['EXECUTING'],
    to: 'REVIEWING',
    effect: '进入独立评审（规划书 §二十）',
    emits: ['run.execution_done'],
  },
  {
    event: 'EXECUTION_FAILED',
    from: ['EXECUTING'],
    to: 'FAILED',
    effect: '不可恢复的执行失败',
    emits: ['run.execution_failed'],
  },
  {
    event: 'REVIEW_PASSED',
    from: ['REVIEWING'],
    to: 'VALIDATING',
    effect: '评审通过，进入验证',
    emits: ['run.review_passed'],
  },
  {
    event: 'REVIEW_REJECTED',
    from: ['REVIEWING'],
    to: 'REWORK',
    effect: 'REQUEST_CHANGES → 返工（规划书 §三十五）',
    emits: ['run.review_rejected'],
  },
  {
    event: 'REWORK_READY',
    from: ['REWORK'],
    to: 'EXECUTING',
    effect: '返工完成，重回执行',
    emits: ['run.rework_ready'],
  },
  {
    event: 'REWORK_EXHAUSTED',
    from: ['REWORK'],
    to: 'PAUSED',
    effect: '返工超过上限，交 Chief / 用户重新决策（规划书 §三十五）',
    emits: ['run.rework_exhausted'],
  },
  {
    event: 'VALIDATION_PASSED',
    from: ['VALIDATING'],
    to: 'FINALIZING',
    effect: '质量门通过（规划书 §三十二）',
    emits: ['run.validation_passed'],
  },
  {
    event: 'VALIDATION_FAILED',
    from: ['VALIDATING'],
    to: 'REWORK',
    effect: '质量门失败',
    emits: ['run.validation_failed'],
  },
  {
    event: 'DELIVERED',
    from: ['FINALIZING'],
    to: 'COMPLETED',
    effect: '交付完成（吸收态）',
    emits: ['run.delivered', 'run.completed'],
  },
  {
    /*
     * LIVE-SMOKE-FIX-09 — container-run terminal convergence. The goal (planning)
     * container run reaches engine-terminal COMPLETED when its OUTCOME was delivered
     * by a child execution run: a child run only reaches COMPLETED through the full
     * evidence-gated chain (REVIEW → VALIDATION.PASS with durable batches →
     * DELIVERY.COMPLETE), so the child's terminal state IS the canonical proof that
     * the container's validation and delivery semantics were satisfied. The engine
     * refuses this command unless the named child run is proven COMPLETED and
     * company-owned (typed guard in the engine dispatch); a run with its OWN
     * validator requirements still cannot skip them — this edge never bypasses
     * VALIDATING (a run that entered VALIDATING settles through VALIDATION_PASSED
     * only; OUTCOME_DELIVERED from VALIDATING applies solely to delegated-outcome
     * containers whose validation truth lives on the child).
     */
    event: 'OUTCOME_DELIVERED',
    from: ['EXECUTING', 'REVIEWING', 'VALIDATING', 'FINALIZING'],
    to: 'COMPLETED',
    effect: '目标结果由子执行运行交付（容器运行终态收敛；引擎先证明子运行 COMPLETED）',
    emits: ['run.delivered', 'run.completed'],
  },
  {
    event: 'DELIVERY_FAILED',
    from: ['FINALIZING'],
    to: 'FAILED',
    effect: '交付失败',
    emits: ['run.delivery_failed'],
  },
  {
    event: 'PAUSE',
    from: PAUSABLE_RUN_STATES,
    to: 'PAUSED',
    effect: '写入 checkpoint 后暂停（仅执行期状态可暂停）',
    emits: ['run.paused'],
  },
  {
    event: 'RESUME',
    from: ['PAUSED'],
    to: 'EXECUTING',
    effect: '从 checkpoint 恢复；若记录了恢复点则返回该状态（见 nextRunState 的 resumePoint），永不自动恢复',
    emits: ['run.resumed'],
  },
  {
    event: 'CRASH_DETECTED',
    from: ['PLANNING', 'ROUTING', 'EXECUTING', 'REVIEWING', 'VALIDATING', 'FINALIZING'],
    to: 'RECOVERING',
    effect: '启动时发现孤儿执行（规划书 §四十五）',
    emits: ['run.crash_detected'],
  },
  {
    event: 'RECOVERED',
    from: ['RECOVERING'],
    to: 'EXECUTING',
    effect: '按事件日志恢复到最近安全点；若记录了恢复点则返回该状态',
    emits: ['run.recovered'],
  },
  { event: 'RECOVERY_FAILED', from: ['RECOVERING'], to: 'FAILED', effect: '无法恢复', emits: ['run.recovery_failed'] },
  {
    event: 'CANCEL',
    from: CANCELLABLE,
    to: 'FAILED',
    effect: '取消（reason=cancelled，不单列状态）',
    emits: ['run.cancelled'],
  },
  {
    event: 'TIMEOUT',
    from: ['INITIALIZING', 'PLANNING', 'ROUTING', 'WAITING_APPROVAL', 'EXECUTING', 'REVIEWING', 'VALIDATING', 'REWORK', 'FINALIZING'],
    to: 'FAILED',
    effect: '超时（reason=timed_out，不单列状态）',
    emits: ['run.timed_out'],
  },
];

export const RUN_TERMINAL_STATES: readonly RunState[] = ['COMPLETED', 'FAILED'];

export const findRunTransition = (event: RunEvent, from: RunState): RunTransitionRule | null =>
  RUN_TRANSITIONS.find((rule) => rule.event === event && rule.from.includes(from)) ?? null;

export const canRunTransition = (event: RunEvent, from: RunState): boolean =>
  findRunTransition(event, from) !== null;

export const allowedRunEvents = (state: RunState): readonly RunEvent[] =>
  RUN_TRANSITIONS.filter((rule) => rule.from.includes(state)).map((rule) => rule.event);

export const isRunTerminal = (state: RunState): boolean => RUN_TERMINAL_STATES.includes(state);

export const isRunState = (value: unknown): value is RunState =>
  typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value);

export const isRunEvent = (value: unknown): value is RunEvent =>
  typeof value === 'string' && (RUN_EVENTS as readonly string[]).includes(value);

/** Guard/transition resolution with the canonical domain error. */
export interface RunTransitionOptions {
  /**
   * Where the run was when it was paused or crashed. `RESUME` / `RECOVERED` return
   * there instead of jumping to `EXECUTING` (review finding HIGH-2), so pausing can
   * never shortcut a gate.
   *
   * `null`/absent means "nothing recorded" → the fallback target of the rule is used.
   * A point that is NOT an execution-phase state is a hard error
   * (`ILLEGAL_TRANSITION`), never a silent fallback.
   */
  readonly resumePoint?: RunState | null;
}

export function nextRunState(
  event: RunEvent,
  from: RunState,
  options: RunTransitionOptions = {},
): Result<RunState, DomainError> {
  const rule = findRunTransition(event, from);
  if (rule === null) {
    return err(
      domainError('ILLEGAL_TRANSITION', `Run event "${event}" is not legal in state "${from}".`, {
        from,
        event,
        allowed: allowedRunEvents(from),
      }),
    );
  }
  const resumePoint = options.resumePoint ?? null;
  if (event === 'RESUME' || event === 'RECOVERED') {
    if (resumePoint === null) return ok(rule.to);
    if (!RESUMABLE_RUN_STATES.includes(resumePoint)) {
      // Fail-closed (review finding LOW): an unusable resume point is an error, not a
      // silent fallback — otherwise SM-L1-10 ("only when nothing is recorded") would
      // not match the implementation.
      return err(
        domainError('ILLEGAL_TRANSITION', `Cannot resume to "${resumePoint}": not an execution-phase state.`, {
          event,
          from,
          resumePoint,
          allowed: [...RESUMABLE_RUN_STATES],
        }),
      );
    }
    return ok(resumePoint);
  }
  return ok(rule.to);
}

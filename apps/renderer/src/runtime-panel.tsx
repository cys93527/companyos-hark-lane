/**
 * STAGE 2 — the collapsible CompanyOS Runtime Panel (the right-hand differentiator).
 *
 * Everything shown here is a projection of canonical durable truth read through the typed
 * control-plane channel (`goal.workspace`, `run.overview`, `run.timeline`, `run.task`,
 * `run.artifacts`, `decisions.pending`). The panel holds NO state of its own, has NO
 * independent state machine, and never converts activity into a percentage.
 *
 * Tabs: 运行 (lifecycle) · 文件 (canonical artifacts) · 产出 (deliverables + validation +
 * handoffs) · 详情 (run/goal facts). Default: collapsed — the centre stays conversation-first.
 */
import { blockerText, failureRemedyOf, REMEDY_LABELS, type CanonicalAttemptFailure, type FailureRemedy } from './failure-labels.js';
import { TypedErrorLine } from './typed-error.js';
import { createElement as h, type JSX } from 'react';
import { budgetRows, formatMoney, type GoalBudgetRead } from './budget.js';
import { terminalOutcomeOf } from './run-outcome.js';
import { artifactKindWord, clockStamp, riskWord, stateWord } from './format.js';
import type { ModelRuntimeView } from './telemetry.js';

/* ------------------------------------------------- canonical input shapes --- */

export interface CanonicalBlocker {
  readonly code: string;
  readonly scope: string;
  readonly subjectId?: string;
  readonly explanation: string;
}

export interface CanonicalStageObservation {
  readonly stageId: string;
  readonly taskCounts: Readonly<Record<string, number>>;
  readonly terminalSuccessful: boolean;
}

export interface CanonicalAttemptObservation {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly state: string;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

export interface CanonicalExecutingTask {
  readonly taskId: string;
  readonly stageId: string;
  readonly kind: string;
  readonly attempt: CanonicalAttemptObservation | null;
}

export interface CanonicalOverview {
  readonly runId: string;
  readonly state: string;
  readonly revision: number;
  readonly reworkCount: number;
  readonly maxRework: number;
  readonly failureReason: string | null;
  /** H12b: typed terminal outcome from the main process (absent on older payloads). */
  readonly terminalOutcome?: string | null;
  readonly resumePoint: string | null;
  readonly pinnedVersion: { readonly templateId: string; readonly versionId: string } | null;
  readonly stages: readonly CanonicalStageObservation[];
  readonly executing: readonly CanonicalExecutingTask[];
  readonly attempts: {
    readonly active: number;
    readonly interrupted: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly validation: {
    readonly requiredValidatorIds: readonly string[];
    readonly completed: readonly { readonly validatorId: string; readonly status: string }[];
    readonly failed: boolean;
    readonly missing: readonly string[];
  };
  readonly correctiveActivity: {
    readonly rounds: number;
    readonly latest: { readonly taskId: string; readonly round: number } | null;
  } | null;
  readonly handoffCount: number;
  readonly progress: {
    readonly stagesTotal: number;
    readonly stagesTerminalSuccessful: number;
    readonly tasksTotal: number;
    readonly tasksDone: number;
    readonly tasksActive: number;
    readonly tasksBlocked: number;
  };
  readonly artifacts: readonly { readonly id: string; readonly kind: string; readonly taskId: string | null }[];
}

export interface CanonicalGoalWorkspace {
  readonly runId: string;
  /** AUDIT-R1: goal.workspace read-back of a durable cancel intent (main: cancellationRequested). */
  readonly cancellationRequested?: boolean;
  /** STAGE 4: the Goal's canonical access policy (read-back through goal.workspace). */
  readonly accessPolicy?: 'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS';
  readonly goal: { readonly objective: string } | null;
  readonly planningRun: { readonly state: string; readonly revision: number } | null;
  readonly overview: CanonicalOverview | null;
  readonly blockers: readonly CanonicalBlocker[];
  readonly executionRuns: readonly { readonly runId: string; readonly state: string }[];
  /** LIVE-CONTRACT-FILL: the latest failed attempt with the provider's typed reason. */
  readonly attemptFailure?: CanonicalAttemptFailure | null;
}

export interface CanonicalTaskObservation {
  readonly taskId: string;
  readonly stageId: string;
  readonly roleId: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly executionAttempts: readonly CanonicalAttemptObservation[];
  readonly provenance: readonly {
    readonly executionId: string;
    readonly status: string;
    readonly modelKey: string | null;
    readonly providerId: string | null;
  }[];
  readonly provider: { readonly providerKey: string; readonly state: string } | null;
  readonly blockers: readonly CanonicalBlocker[];
}

export interface CanonicalTimelineEntry {
  readonly key: string;
  readonly kind: string;
  readonly summary: string;
  readonly occurredAt: string | null;
}

/* ------------------------------------------------------------- projections --- */

export type RuntimePhase = 'planning' | 'executing' | 'validating' | 'correcting' | 'awaiting-user' | 'completed' | 'cancelled' | 'timed-out' | 'blocked' | 'failed' | 'idle';

/** The lifecycle phase is a projection of canonical run state + blockers, never a UI timer. */
export const projectRuntimePhase = (input: {
  readonly runState: string | null;
  readonly blockers: readonly CanonicalBlocker[];
  /** H12b: the canonical failureReason / typed terminal outcome of the same run. */
  readonly failureReason?: string | null;
  readonly terminalOutcome?: string | null;
}): RuntimePhase => {
  if (input.runState === null) return 'idle';
  // A terminal run is decided by its typed outcome first: a stale APPROVAL_REQUIRED
  // blocker can never make a cancelled/failed run look like it awaits the user.
  const outcome = terminalOutcomeOf({
    state: input.runState,
    ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
    ...(input.terminalOutcome === undefined ? {} : { terminalOutcome: input.terminalOutcome }),
  });
  if (outcome === 'COMPLETED') return 'completed';
  if (outcome === 'CANCELLED') return 'cancelled';
  if (outcome === 'TIMED_OUT') return 'timed-out';
  if (outcome === 'FAILED') return 'failed';
  if (input.blockers.some((blocker) => blocker.code === 'APPROVAL_REQUIRED')) return 'awaiting-user';
  if (input.blockers.length > 0) return 'blocked';
  if (input.runState === 'WAITING_APPROVAL') return 'awaiting-user';
  if (['RUNNING', 'EXECUTING'].includes(input.runState)) return 'executing';
  if (input.runState === 'PLANNING') return 'planning';
  return 'executing';
};

export const PHASE_LABELS: Readonly<Record<RuntimePhase, string>> = {
  planning: '规划中',
  executing: '执行中',
  validating: '验证中',
  correcting: '纠正中',
  'awaiting-user': '等待用户决策',
  completed: '已完成',
  cancelled: '已取消',
  'timed-out': '已超时',
  // LIVE-CONTRACT-FILL run 5: a stopped Goal reads 已阻塞 (never 执行中).
  blocked: '已阻塞',
  failed: '失败',
  idle: '空闲',
};

export interface RuntimeLifecycleTaskRow {
  readonly taskId: string;
  readonly stageId: string;
  readonly kind: string;
  readonly roleId: string | null;
  readonly modelKey: string | null;
  readonly state: string;
  readonly attemptLabel: string | null;
}

export interface RuntimeLifecycleView {
  readonly runId: string;
  readonly phase: RuntimePhase;
  readonly runState: string;
  readonly objective: string | null;
  /**
   * The PLANNING phase's own status: DONE once its plan was compiled into an execution run
   * (live contract-fill run 4 showed "规划 · FAILED" for a planning phase that had succeeded,
   * because the goal run's state also carries the execution failure).
   */
  readonly planningState: string | null;
  /** The EXECUTION phase's status (latest execution run state); null before the plan compiled. */
  readonly executionState?: string | null;
  readonly tasks: readonly RuntimeLifecycleTaskRow[];
  readonly validation: { readonly completed: number; readonly failed: number; readonly missing: number };
  readonly correctiveRounds: number;
  readonly handoffCount: number;
  readonly outcomeDelivered: boolean;
  /** LIVE-CONTRACT-FILL: the canonical run failureReason (Chinese-labelled in the blocker strip). */
  readonly failureReason?: string | null;
}

/** A compiled execution run proves the planning phase completed; otherwise the planning run's own state. */
export const planningPhaseStateOf = (workspace: Pick<CanonicalGoalWorkspace, 'planningRun' | 'executionRuns'>): string | null =>
  workspace.executionRuns.length > 0 ? 'DONE' : workspace.planningRun?.state ?? null;

export const projectRuntimeLifecycle = (
  workspace: CanonicalGoalWorkspace,
  taskDetails?: readonly CanonicalTaskObservation[],
): RuntimeLifecycleView => {
  const overview = workspace.overview;
  const details = new Map((taskDetails ?? []).map((task) => [task.taskId, task]));
  const tasks: RuntimeLifecycleTaskRow[] = [];
  const seen = new Set<string>();
  for (const entry of overview?.executing ?? []) {
    seen.add(entry.taskId);
    const detail = details.get(entry.taskId);
    tasks.push({
      taskId: entry.taskId,
      stageId: entry.stageId,
      kind: entry.kind,
      roleId: detail?.roleId ?? null,
      modelKey: detail?.provenance[0]?.modelKey ?? null,
      state: detail?.state ?? 'RUNNING',
      attemptLabel:
        entry.attempt === null ? null : `第 ${entry.attempt.attemptNumber} 次尝试 · ${stateWord(entry.attempt.state)}`,
    });
  }
  for (const detail of taskDetails ?? []) {
    if (seen.has(detail.taskId)) continue;
    tasks.push({
      taskId: detail.taskId,
      stageId: detail.stageId,
      kind: detail.kind,
      roleId: detail.roleId,
      modelKey: detail.provenance[0]?.modelKey ?? null,
      state: detail.state,
      attemptLabel: null,
    });
  }
  return {
    runId: workspace.runId,
    phase: projectRuntimePhase({
      runState: overview?.state ?? null,
      blockers: workspace.blockers,
      failureReason: overview?.failureReason ?? null,
      ...(overview?.terminalOutcome === undefined ? {} : { terminalOutcome: overview.terminalOutcome }),
    }),
    runState: overview?.state ?? 'UNKNOWN',
    failureReason: overview?.failureReason ?? null,
    objective: workspace.goal?.objective ?? null,
    planningState: planningPhaseStateOf(workspace),
    executionState: workspace.executionRuns.length === 0 ? null : workspace.executionRuns[workspace.executionRuns.length - 1]!.state,
    tasks,
    validation: {
      completed: overview?.validation.completed.length ?? 0,
      failed: overview?.validation.failed === true ? 1 : 0,
      missing: overview?.validation.missing.length ?? 0,
    },
    correctiveRounds: overview?.correctiveActivity?.rounds ?? 0,
    handoffCount: overview?.handoffCount ?? 0,
    outcomeDelivered: overview?.state === 'COMPLETED',
  };
};

export const formatCounts = (counts: Readonly<Record<string, number>>): string => {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${state} ${count}`);
  return parts.length === 0 ? '无任务' : parts.join(' · ');
};

/* ---------------------------------------------------------------- views --- */

export type RuntimeTab = 'run' | 'files' | 'output' | 'detail';

export const RUNTIME_TABS: readonly { readonly id: RuntimeTab; readonly label: string }[] = [
  { id: 'run', label: '运行' },
  { id: 'files', label: '文件' },
  { id: 'output', label: '产出' },
  { id: 'detail', label: '详情' },
];

export interface RuntimePanelViewProps {
  readonly open: boolean;
  readonly expanded: boolean;
  readonly tab: RuntimeTab;
  readonly lifecycle: RuntimeLifecycleView | null;
  readonly artifacts: readonly { readonly artifactId: string; readonly kind: string }[];
  readonly timeline: readonly CanonicalTimelineEntry[];
  readonly taskDetail: CanonicalTaskObservation | null;
  /** STAGE 3: canonical blockers + the pending approval behind them. */
  readonly blockers?: readonly CanonicalBlocker[];
  /** LIVE-CONTRACT-FILL: the typed reason behind a failed goal (goal.workspace attemptFailure). */
  readonly attemptFailure?: CanonicalAttemptFailure | null;
  readonly pendingApproval?: { readonly riskLevel: string; readonly reason: string; readonly runId: string } | null;
  /** H11: canonical budget/spend projection + the previewed plan (read-only). */
  readonly budget?: GoalBudgetRead | null;
  /** UI-PAPER-INK: the model telemetry projection (UNKNOWN renders --) + the coverage note. */
  readonly model?: ModelRuntimeView | null;
  readonly usageNote?: string | null;
  /** Stage progress of the newest execution run (canonical counts), when known. */
  readonly stageProgress?: { readonly done: number; readonly total: number } | null;
  readonly onToggleExpanded: () => void;
  readonly onSelectTab: (tab: RuntimeTab) => void;
  readonly onSelectTask: (taskId: string) => void;
  /** STAGE 3: bounded artifact actions (canonical artifact id only). */
  readonly onArtifactPreview?: (artifactId: string, kind: string) => void;
  readonly onArtifactOpen?: (artifactId: string, kind: string) => void;
  readonly onArtifactReveal?: (artifactId: string, kind: string) => void;
  readonly artifactPreview?: { readonly artifactId: string; readonly text: string; readonly truncated: boolean; readonly kind: string } | null;
  readonly artifactFailure?: { readonly code: string; readonly message: string } | null;
  /** UI-AUDIT-2: open the setting that fixes a failure (budget / model). */
  readonly onRemedy?: (remedy: FailureRemedy) => void;
}

/** Canonical elapsed wall time between two ISO stamps — measured, never estimated. */
export const formatElapsed = (from: string, to: string): string => {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '--';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** The failure classification comes from canonical attempt state, never a guess. */
export const failureClassificationOf = (task: CanonicalTaskObservation | null): string => {
  if (task === null) return '--';
  if (task.state !== 'FAILED') return '—';
  return task.executionAttempts.some((attempt) => attempt.state === 'FAILED')
    ? '失败（有执行尝试记录）'
    : '失败（没有执行尝试记录）';
};

const LIVE_PHASES: ReadonlySet<RuntimePhase> = new Set(['planning', 'executing', 'validating', 'correcting', 'awaiting-user', 'blocked']);

const ENDED_PHASES: ReadonlySet<RuntimePhase> = new Set(['completed', 'failed', 'cancelled', 'timed-out']);
/** UI-AUDIT-19: a live Goal is 进行中, never 未交付; unknown is --. */
const outcomeWord = (lifecycle: RuntimeLifecycleView | null): string =>
  lifecycle === null ? '--' : lifecycle.outcomeDelivered ? '已交付' : ENDED_PHASES.has(lifecycle.phase) ? '未交付' : '进行中';

/** Cents for amounts of at least 0.01 (a known value rounded for display); tiny amounts stay exact. */
const displayMoney = (micros: number, currency: Parameters<typeof formatMoney>[1]): string => {
  if (micros < 10_000) return formatMoney(micros, currency);
  const exact = formatMoney(micros, currency);
  const value = (Math.round(micros / 10_000) / 100).toFixed(2);
  return exact.replace(/[0-9]+(?:\.[0-9]+)?/u, value);
};

/**
 * UI-AUDIT-2 — the model(s) this goal actually ran on, from task provenance (`<providerId>:<modelId>`
 * keys shown as the model id). Empty until a task has made a model call.
 */
export const goalRanModels = (lifecycle: Pick<RuntimeLifecycleView, 'tasks'> | null): readonly string[] => {
  if (lifecycle === null) return [];
  const names: string[] = [];
  for (const task of lifecycle.tasks) {
    const key = task.modelKey;
    if (key === null || key === '') continue;
    const index = key.lastIndexOf(':');
    const name = index >= 0 && index < key.length - 1 ? key.slice(index + 1) : key;
    if (!names.includes(name)) names.push(name);
  }
  return names;
};

const kvRow = (label: string, value: string, key: string): JSX.Element[] => [
  h('dt', { key: `${key}-k` }, label),
  h('dd', { key: `${key}-v`, className: value === '--' ? 'unk' : undefined }, value),
];

const section = (label: string, key: string, ...children: (JSX.Element | JSX.Element[] | null)[]): JSX.Element =>
  h('section', { className: 'rt-sec', key, 'aria-label': label }, h('h4', { className: 'label' }, label), ...children);

export function RuntimePanelView(props: RuntimePanelViewProps): JSX.Element {
  if (!props.open) {
    return h(
      'button', { type: 'button', className: 'runtime-rail__expand', onClick: props.onToggleExpanded },
      '运行视图',
    );
  }

  const lifecycle = props.lifecycle;
  const tabLabel = (entry: { readonly id: RuntimeTab; readonly label: string }) =>
    entry.id === 'files' && props.artifacts.length > 0
      ? [entry.label, h('em', { key: 'n', className: 'num' }, String(props.artifacts.length))]
      : entry.label;
  const head = h(
    'div',
    { className: 'runtime-panel__head' },
    props.expanded
      ? h(
          'div',
          { className: 'runtime-panel__tabs', role: 'tablist', 'aria-label': '运行视图' },
          RUNTIME_TABS.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                role: 'tab',
                'aria-selected': props.tab === entry.id,
                className: props.tab === entry.id ? 'runtime-tab runtime-tab--active' : 'runtime-tab',
                onClick: () => props.onSelectTab(entry.id),
              },
              tabLabel(entry),
            ),
          ),
        )
      : h('span', { className: 'runtime-panel__title' }, '运行视图'),
    h(
      'button',
      { type: 'button', className: 'runtime-panel__collapse', onClick: props.onToggleExpanded, 'aria-expanded': props.expanded },
      props.expanded ? '收起' : '展开',
    ),
  );
  if (!props.expanded) {
    return h(
      'aside',
      { className: 'runtime-panel runtime-panel--collapsed', 'data-testid': 'runtime-panel', 'aria-label': '运行面板' },
      head,
      h('p', { className: 'sr-only runtime-panel__hint' }, '已收起 — 对话优先。'),
    );
  }

  const phaseLive = lifecycle !== null && LIVE_PHASES.has(lifecycle.phase);
  const budget = props.budget ?? null;
  const pending = props.pendingApproval ?? null;
  const blockers = props.blockers ?? [];
  const model = props.model ?? null;
  const ranModels = goalRanModels(lifecycle);
  const remedy = failureRemedyOf(props.attemptFailure ?? null);
  const zeroBudget = budget !== null && budget.budget.state === 'ZERO_COST_POLICY';

  const runTab = h(
    'div',
    { className: 'runtime-tree', 'data-testid': 'runtime-lifecycle', 'aria-label': '运行阶段' },
    lifecycle === null
      ? h('p', { className: 'rt-empty muted' }, '尚未打开目标。打开左侧的一个目标，或在下方描述新目标。')
      : section(
          '阶段',
          'phase',
          // UI-AUDIT-3: the per-run state words (目标 · 规划 · 执行) are support detail: tooltip only.
          h(
            'div',
            {
              className: phaseLive ? 'phase phase--live' : 'phase',
              title: `目标 ${stateWord(lifecycle.runState)} · 规划 ${lifecycle.planningState === null ? '--' : stateWord(lifecycle.planningState)}${lifecycle.executionState == null ? '' : ` · 执行 ${stateWord(lifecycle.executionState)}`} (goal ${lifecycle.runState} · planning ${lifecycle.planningState ?? '--'}${lifecycle.executionState == null ? '' : ` · execution ${lifecycle.executionState}`})`,
            },
            PHASE_LABELS[lifecycle.phase],
            props.stageProgress == null || props.stageProgress.total === 0
              ? null
              : h('small', { className: 'num' }, `${lifecycle.executionState == null ? '' : '执行 · '}阶段 ${String(props.stageProgress.done)}/${String(props.stageProgress.total)} 完成`),
          ),
        ),
    blockers.length === 0 && pending === null
      ? null
      : h(
          'div',
          { className: 'runtime-blockers', 'data-testid': 'runtime-blockers', 'aria-label': '阻塞项', key: 'blockers' },
          pending === null
            ? null
            : h(
                'p',
                { className: 'blocker blocker--approval runtime-blockers__approval', role: 'status', title: pending.reason },
                h('b', null, '需要批准'),
                // One strip for the approval: the APPROVAL_REQUIRED blocker is the same fact.
                h('span', { className: 'blocker__text', title: blockers.some((blocker) => blocker.code === 'APPROVAL_REQUIRED') ? 'APPROVAL_REQUIRED' : undefined }, `${blockers.some((blocker) => blocker.code === 'APPROVAL_REQUIRED') ? '等待批准 · ' : ''}${pending.reason === '' ? '（未提供原因）' : pending.reason}`),
                h('span', { className: 'blocker__risk', title: `风险等级 ${pending.riskLevel}` }, `风险 ${riskWord(pending.riskLevel)}`),
              ),
          blockers
            .filter((blocker) => pending === null || blocker.code !== 'APPROVAL_REQUIRED')
            .map((blocker, index) =>
              h(
                'p',
                { key: `b${String(index)}`, className: blocker.code === 'APPROVAL_REQUIRED' ? 'blocker runtime-blockers__item' : 'blocker blocker--plain runtime-blockers__item' },
                h('b', null, '阻塞'),
                // LIVE-CONTRACT-FILL: Chinese label + the real typed reason; code + English evidence in the tooltip.
                h('span', { className: 'blocker__text', title: `${blocker.code} · ${blocker.explanation}` }, blockerText(blocker, props.attemptFailure ?? null, lifecycle?.failureReason ?? null)),
              ),
            ),
          remedy === null || props.onRemedy === undefined
            ? null
            : h('button', { type: 'button', className: 'btn btn--quiet btn--small', 'data-testid': 'runtime-remedy', onClick: () => props.onRemedy?.(remedy) }, REMEDY_LABELS[remedy]),
        ),
    budget === null
      ? null
      : section(
          '预算',
          'budget',
          h(
            'div',
            { className: 'runtime-budget', 'data-testid': 'runtime-budget', 'aria-label': '预算' },
            h(
              'div',
              { className: 'cost' },
              // Display figure: money to the cent (the exact settled amount is in the lines below).
              h('span', { className: 'cost__big num', title: zeroBudget ? undefined : formatMoney(budget.budget.settled.costMicros, budget.budget.currency) }, zeroBudget && budget.budget.currency === null ? '0' : displayMoney(budget.budget.settled.costMicros, budget.budget.currency)),
              // UI-AUDIT-2: a zero cap is "no budget approved", not "0.00 单位".
              zeroBudget
                ? h('span', { className: 'cost__of' }, '/ 未批准预算')
                : budget.budget.cap === null
                  ? h('span', { className: 'cost__of' }, '/ 上限 --')
                  : h('span', { className: 'cost__of num' }, `/ 上限 ${displayMoney(budget.budget.cap.costMicros, budget.budget.currency)}`),
            ),
            budget.budget.cap === null || budget.budget.cap.costMicros <= 0
              ? null
              : h(
                  'div',
                  { className: 'meter', 'aria-hidden': true },
                  h('i', { style: { transform: `scaleX(${String(Math.min(1, budget.budget.settled.costMicros / budget.budget.cap.costMicros))})` } }),
                ),
            // UI-AUDIT-3: calls / tokens / holds are detail; the figure and the meter are the answer.
            h(
              'details',
              { className: 'tech runtime-budget__detail' },
              h('summary', null, '明细'),
              h(
                'ul',
                { className: 'rt-lines num' },
                budgetRows(budget.budget).map((line, index) => h('li', { key: `b${String(index)}` }, line)),
              ),
            ),
            zeroBudget && props.onRemedy !== undefined
              ? h('button', { type: 'button', className: 'btn btn--text', onClick: () => props.onRemedy?.('budget') }, REMEDY_LABELS.budget)
              : null,
          ),
        ),
    model === null
      ? null
      : section(
          '模型',
          'model',
          h(
            'dl',
            { className: 'kv', 'data-testid': 'runtime-model' },
            // UI-AUDIT-2: the goal's own model (task provenance), not the company default.
            ...(ranModels.length > 0
              ? kvRow('本目标所用模型', ranModels.join('、'), 'm')
              : kvRow('默认模型（尚未调用）', model.modelLabel, 'm')),
          ),
          // UI-AUDIT-3: telemetry (context window, tokens, speed, cache) is technical detail, collapsed.
          h(
            'details',
            { className: 'tech runtime-model__detail' },
            h('summary', null, '技术细节'),
            h(
              'dl',
              { className: 'kv' },
              kvRow('上下文窗口', model.contextWindow, 'w'),
              kvRow('已用 tokens', model.used, 'u'),
              kvRow('生成速度', model.speed, 's'),
              kvRow('缓存命中', model.cacheHit, 'c'),
              kvRow('上下文剩余', model.remaining, 'r'),
              kvRow('会话费用', model.cost, 'f'),
            ),
            props.usageNote === undefined || props.usageNote === null || props.usageNote === ''
              ? null
              : h('p', { className: 'rt-note' }, props.usageNote),
          ),
        ),
    // UI-AUDIT-3: 验证 lives on the 产出 tab only (it was shown twice).
    lifecycle === null || lifecycle.tasks.length === 0
      ? null
      : section(
          '执行中的任务',
          'tasks',
          h(
            'ul',
            { className: 'files' },
            lifecycle.tasks.map((task, index) =>
              h(
                'li',
                { className: 'runtime-tree__row--task', key: task.taskId },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'runtime-task',
                    onClick: () => props.onSelectTask(task.taskId),
                    // UI-AUDIT-2: ids / role / model keys are support details (tooltip), not list text.
                    title: ['查看任务明细', task.taskId, task.roleId === null ? null : `角色 ${task.roleId}`, task.modelKey === null ? null : `模型 ${task.modelKey}`]
                      .filter((part): part is string => part !== null)
                      .join(' · '),
                  },
                  h('span', { className: 'runtime-task__id' }, `任务 ${String(index + 1)}`),
                  h('span', { className: 'runtime-task__meta' }, `${stateWord(task.state)}${task.attemptLabel === null ? '' : ` · ${task.attemptLabel}`}`),
                  // UI-AUDIT-3: the task id stays in the tooltip and on 详情, not in the list.
                ),
              ),
            ),
          ),
        ),
    props.artifacts.length === 0
      ? null
      : section(
          '产出文件',
          'artifacts',
          h(
            'ul',
            { className: 'files' },
            props.artifacts.slice(0, 6).map((artifact) =>
              h('li', { key: artifact.artifactId, title: `${artifact.kind} · ${artifact.artifactId}` }, h('span', null, artifactKindWord(artifact.kind))),
            ),
          ),
          props.artifacts.length > 6
            ? h('button', { type: 'button', className: 'btn btn--text', onClick: () => props.onSelectTab('files') }, `全部 ${String(props.artifacts.length)} 个 · 在「文件」查看`)
            : null,
        ),
    // UI-AUDIT-3: 最近活动 was the conversation's own timeline repeated (the Goal page shows it,
    // with 技术记录); the "unknown values show --" note is self-evident.
  );

  const filesTab = h(
    'div',
    { className: 'runtime-files-tab' },
    h(
      'ul',
      { key: 'files', className: 'files runtime-files', 'data-testid': 'runtime-artifacts', 'aria-label': '产出文件' },
      props.artifacts.length === 0
        ? h('li', { className: 'muted' }, '尚无产物文件。')
        : props.artifacts.map((artifact) =>
            h(
              'li',
              { key: artifact.artifactId },
              // UI-AUDIT-3: the artifact id is support detail (tooltip), not list text.
              h('span', { className: 'runtime-files__kind', title: `${artifact.kind} · ${artifact.artifactId}` }, artifactKindWord(artifact.kind)),
              h(
                'span',
                { className: 'runtime-files__actions' },
                h('button', { type: 'button', className: 'btn btn--text', onClick: () => props.onArtifactPreview?.(artifact.artifactId, artifact.kind) }, '预览'),
                h('button', { type: 'button', className: 'btn btn--text', onClick: () => props.onArtifactOpen?.(artifact.artifactId, artifact.kind) }, '打开'),
                h('button', { type: 'button', className: 'btn btn--text', onClick: () => props.onArtifactReveal?.(artifact.artifactId, artifact.kind) }, '显示'),
              ),
            ),
          ),
    ),
    (props.artifactPreview ?? null) === null
      ? null
      : h(
          'pre',
          { key: 'preview', className: 'artifact-actions__preview mono' },
          props.artifactPreview!.text,
          props.artifactPreview!.truncated ? h('span', { className: 'muted' }, '\n…（已截断，仅显示前 16 KiB）') : null,
        ),
    (props.artifactFailure ?? null) === null
      ? null
      : h('div', { key: 'failure' }, h(TypedErrorLine, { failure: props.artifactFailure! })),
  );

  const outputTab = h(
    'div',
    { className: 'runtime-output' },
    section(
      '结果',
      'outcome',
      h('dl', { className: 'kv' },
        kvRow('结果', outcomeWord(lifecycle), 'o'),
        kvRow('验证完成', lifecycle === null ? '--' : String(lifecycle.validation.completed), 'c'),
        kvRow('验证失败', lifecycle === null ? '--' : String(lifecycle.validation.failed), 'f'),
        kvRow('待验证', lifecycle === null ? '--' : String(lifecycle.validation.missing), 'm'),
        kvRow('纠正轮次', lifecycle === null ? '--' : String(lifecycle.correctiveRounds), 'r'),
      ),
    ),
    h('p', { className: 'rt-note' }, '有产物不等于已交付：是否交付以验证结果为准。'),
  );

  const detailTab = h(
    'div',
    { className: 'runtime-detail' },
    props.taskDetail === null
      ? h('p', { className: 'muted' }, '在「运行」页点一个任务，查看它的明细。')
      : section(
          '任务明细',
          'task',
          h(
            'dl',
            { className: 'kv kv--wrap' },
            kvRow('状态', stateWord(props.taskDetail.state), 's'),
            kvRow('开始', clockStamp(props.taskDetail.createdAt), 'b'),
            kvRow('角色', props.taskDetail.roleId, 'r'),
            kvRow('模型', props.taskDetail.provenance[0]?.modelKey ?? '--', 'm'),
            kvRow('执行方', props.taskDetail.provider?.providerKey ?? '--', 'p'),
            kvRow('执行方状态', props.taskDetail.provider === null ? '--' : stateWord(props.taskDetail.provider.state), 'ps'),
            kvRow('任务编号', props.taskDetail.taskId, 't'),
            kvRow('耗时', formatElapsed(props.taskDetail.createdAt, props.taskDetail.updatedAt), 'e'),
            kvRow('尝试', `${String(props.taskDetail.attempts)}/${String(props.taskDetail.maxAttempts)}`, 'a'),
            kvRow('失败分类', failureClassificationOf(props.taskDetail), 'fc'),
          ),
        ),
  );

  return h(
    'aside',
    { className: 'runtime-panel', 'data-testid': 'runtime-panel', 'aria-label': '运行面板' },
    head,
    h(
      'div',
      { className: 'runtime-panel__body', role: 'tabpanel' },
      props.tab === 'run' ? runTab : props.tab === 'files' ? filesTab : props.tab === 'output' ? outputTab : detailTab,
    ),
  );
}

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
import { createElement as h, type JSX } from 'react';
import { budgetRows, type GoalBudgetRead } from './budget.js';

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
  /** STAGE 4: the Goal's canonical access policy (read-back through goal.workspace). */
  readonly accessPolicy?: 'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS';
  readonly goal: { readonly objective: string } | null;
  readonly planningRun: { readonly state: string; readonly revision: number } | null;
  readonly overview: CanonicalOverview | null;
  readonly blockers: readonly CanonicalBlocker[];
  readonly executionRuns: readonly { readonly runId: string; readonly state: string }[];
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

export type RuntimePhase = 'planning' | 'executing' | 'validating' | 'correcting' | 'awaiting-user' | 'completed' | 'blocked' | 'failed' | 'idle';

/** The lifecycle phase is a projection of canonical run state + blockers, never a UI timer. */
export const projectRuntimePhase = (input: {
  readonly runState: string | null;
  readonly blockers: readonly CanonicalBlocker[];
}): RuntimePhase => {
  if (input.runState === null) return 'idle';
  if (input.blockers.some((blocker) => blocker.code === 'APPROVAL_REQUIRED')) return 'awaiting-user';
  if (input.runState === 'COMPLETED') return 'completed';
  if (input.runState === 'FAILED' || input.runState === 'CANCELLED') return 'failed';
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
  blocked: '受阻',
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
  readonly planningState: string | null;
  readonly tasks: readonly RuntimeLifecycleTaskRow[];
  readonly validation: { readonly completed: number; readonly failed: number; readonly missing: number };
  readonly correctiveRounds: number;
  readonly handoffCount: number;
  readonly outcomeDelivered: boolean;
}

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
        entry.attempt === null ? null : `#${entry.attempt.attemptNumber} ${entry.attempt.state}`,
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
    phase: projectRuntimePhase({ runState: overview?.state ?? null, blockers: workspace.blockers }),
    runState: overview?.state ?? 'UNKNOWN',
    objective: workspace.goal?.objective ?? null,
    planningState: workspace.planningRun?.state ?? null,
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
  readonly pendingApproval?: { readonly riskLevel: string; readonly reason: string; readonly runId: string } | null;
  /** H11: canonical budget/spend projection + the previewed plan (read-only). */
  readonly budget?: GoalBudgetRead | null;
  readonly onToggleExpanded: () => void;
  readonly onSelectTab: (tab: RuntimeTab) => void;
  readonly onSelectTask: (taskId: string) => void;
  /** STAGE 3: bounded artifact actions (canonical artifact id only). */
  readonly onArtifactPreview?: (artifactId: string, kind: string) => void;
  readonly onArtifactOpen?: (artifactId: string, kind: string) => void;
  readonly onArtifactReveal?: (artifactId: string, kind: string) => void;
  readonly artifactPreview?: { readonly artifactId: string; readonly text: string; readonly truncated: boolean; readonly kind: string } | null;
  readonly artifactFailure?: { readonly code: string; readonly message: string } | null;
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
    ? 'FAILED（attempt 已判定）'
    : 'FAILED（无 attempt 明细）';
};

export function RuntimePanelView(props: RuntimePanelViewProps): JSX.Element {
  if (!props.open) {
    return h(
      'button', { type: 'button', className: 'runtime-rail__expand', onClick: props.onToggleExpanded },
      '运行视图',
    );
  }

  const lifecycle = props.lifecycle;
  return h(
    'aside',
    { className: `runtime-panel${props.expanded ? '' : ' runtime-panel--collapsed'}`, 'aria-label': 'runtime-panel' },
    h(
      'div',
      { className: 'runtime-panel__head' },
      h('span', { className: 'runtime-panel__title' }, 'CompanyOS 运行视图'),
      h(
        'button', { type: 'button', className: 'runtime-panel__collapse', onClick: props.onToggleExpanded },
        props.expanded ? '收起' : '展开',
      ),
    ),
    props.expanded
      ? h(
          'div',
          { className: 'runtime-panel__body' },
          h(
            'div',
            { className: 'runtime-panel__tabs', role: 'tablist' },
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
                entry.label,
              ),
            ),
          ),
          props.tab === 'run'
            ? h(
                'div',
                { className: 'runtime-tree', 'aria-label': 'runtime-lifecycle' },
                lifecycle === null
                  ? h('div', { className: 'runtime-tree__row muted' }, '尚未选择目标。')
                  : h(
                      'div',
                      { className: 'runtime-tree__row runtime-tree__row--goal' },
                      `目标 · ${lifecycle.runState}`,
                    ),
                lifecycle === null
                  ? null
                  : h('div', { className: 'runtime-tree__row' }, `规划 · ${lifecycle.planningState ?? '—'}`),
                props.budget === undefined || props.budget === null
                  ? null
                  : h(
                      'div',
                      { className: 'runtime-budget', 'aria-label': 'runtime-budget' },
                      ...budgetRows(props.budget.budget).map((row, index) =>
                        h('div', { className: index === 0 ? 'runtime-tree__row runtime-tree__row--goal' : 'runtime-tree__row', key: `b${String(index)}` }, row),
                      ),
                    ),
                props.budget === undefined || props.budget === null || props.budget.plan === null || (lifecycle !== null && lifecycle.tasks.length > 0)
                  ? null
                  : h(
                      'div',
                      { className: 'runtime-plan-preview', 'aria-label': 'runtime-plan-preview' },
                      h('div', { className: 'runtime-tree__row runtime-tree__row--goal' }, `计划预览（未执行） · ${String(props.budget.plan.items.length)} 步`),
                      ...props.budget.plan.items.map((item) =>
                        h('div', { className: 'runtime-tree__row runtime-tree__row--task', key: `p${item.planItemId}` }, `${item.planItemId} · ${item.objective}`),
                      ),
                      ...props.budget.plan.criteria.map((c) =>
                        h('div', { className: 'runtime-tree__row muted', key: `c${c.criterionId}` }, `验收 · ${c.requirement}`),
                      ),
                    ),
                lifecycle === null || lifecycle.tasks.length === 0
                  ? h('div', { className: 'runtime-tree__row muted' }, '任务 0/0 · 编译前')
                    : lifecycle.tasks.map((task) =>
                        h(
                          'div',
                          { className: 'runtime-tree__row runtime-tree__row--task', key: task.taskId },
                          h(
                            'button',
                            { type: 'button', className: 'runtime-task', onClick: () => props.onSelectTask(task.taskId) },
                            h('span', { className: 'runtime-task__id' }, task.taskId),
                            h('span', { className: 'runtime-task__meta' }, `${task.state}${task.attemptLabel === null ? '' : ` · 尝试 ${task.attemptLabel}`}`),
                          ),
                          h(
                            'span',
                            { className: 'runtime-task__bindings' },
                            [
                              task.roleId === null ? null : `角色 ${task.roleId}`,
                              task.modelKey === null ? null : `模型 ${task.modelKey}`,
                            ]
                              .filter((part): part is string => part !== null)
                              .join(' · '),
                          ),
                        ),
                      ),
                  lifecycle === null
                    ? null
                    : h(
                        'div',
                        { className: 'runtime-tree__row' },
                        `验证 · 完成 ${lifecycle?.validation.completed ?? 0} · 失败 ${lifecycle?.validation.failed ?? 0} · 缺失 ${lifecycle?.validation.missing ?? 0}`,
                      ),
                  lifecycle === null
                    ? null
                    : h('div', { className: 'runtime-tree__row' }, `纠正轮次 · ${lifecycle.correctiveRounds}`),
                  lifecycle === null
                    ? null
                    : h('div', { className: 'runtime-tree__row' }, `移交 · ${lifecycle.handoffCount}`),
                  h(
                    'div',
                    { className: 'runtime-tree__row' },
                    `结果 · ${lifecycle === null ? '未知' : lifecycle.outcomeDelivered ? '已交付' : '未交付'}`,
                  ),
                  (props.blockers ?? []).length === 0 && props.pendingApproval === null
                    ? null
                    : h(
                        'div',
                        { className: 'runtime-blockers', 'aria-label': 'runtime-blockers' },
                        (props.pendingApproval ?? null) === null
                          ? null
                          : h(
                              'p',
                              { className: 'runtime-blockers__approval', role: 'alert' },
                              `需要批准 · 风险 ${props.pendingApproval!.riskLevel} · ${props.pendingApproval!.reason}`,
                            ),
                        (props.blockers ?? []).map((blocker, index) =>
                          h('p', { key: `b${index}`, className: 'runtime-blockers__item' }, `${blocker.code} · ${blocker.explanation}`),
                        ),
                      ),
                  props.timeline.length === 0
                    ? null
                    : h(
                        'ul',
                        { className: 'runtime-activity', 'aria-label': 'runtime-activity' },
                        props.timeline.map((entry) =>
                          h('li', { key: entry.key }, `${entry.kind} · ${entry.summary}`),
                        ),
                      ),
                )
              : props.tab === 'files'
                ? [
                    h(
                      'ul',
                      { key: 'files', className: 'runtime-files', 'aria-label': 'runtime-artifacts' },
                      props.artifacts.length === 0
                        ? h('li', { className: 'muted' }, '尚无产物文件。')
                        : props.artifacts.map((artifact) =>
                            h(
                              'li',
                              { key: artifact.artifactId },
                              h('span', { className: 'runtime-files__kind' }, artifact.kind),
                              h('span', { className: 'runtime-files__id' }, artifact.artifactId),
                              h(
                                'span',
                                { className: 'runtime-files__actions' },
                                h(
                                  'button',
                                  { type: 'button', onClick: () => props.onArtifactPreview?.(artifact.artifactId, artifact.kind) },
                                  '预览',
                                ),
                                h(
                                  'button',
                                  { type: 'button', onClick: () => props.onArtifactOpen?.(artifact.artifactId, artifact.kind) },
                                  '打开',
                                ),
                                h(
                                  'button',
                                  { type: 'button', onClick: () => props.onArtifactReveal?.(artifact.artifactId, artifact.kind) },
                                  '显示',
                                ),
                              ),
                            ),
                          ),
                    ),
                    props.artifactPreview === null
                      ? null
                      : h(
                          'pre',
                          { key: 'preview', className: 'artifact-actions__preview' },
                          (props.artifactPreview!).text,
                          (props.artifactPreview!).truncated
                            ? h('span', { className: 'muted' }, '\n…（已截断，仅显示前 16 KiB）')
                            : null,
                        ),
                    (props.artifactFailure ?? null) === null
                      ? null
                      : h(
                          'p',
                          { key: 'failure', className: 'typed-error__message', role: 'alert' },
                          `${props.artifactFailure!.code} ${props.artifactFailure!.message}`,
                        ),
                  ]
                : props.tab === 'output'
                  ? h(
                      'div',
                      { className: 'runtime-output' },
                      h('p', null, `Outcome · ${lifecycle === null ? '未知' : lifecycle.outcomeDelivered ? '已交付' : '未交付'}`),
                      h(
                        'p',
                        null,
                        `验证 · 完成 ${lifecycle?.validation.completed ?? 0} · 失败 ${lifecycle?.validation.failed ?? 0} · 缺失 ${lifecycle?.validation.missing ?? 0}`,
                      ),
                      h('p', null, `移交 · ${lifecycle?.handoffCount ?? 0}`),
                      h('p', { className: 'muted' }, '产物说明不能替代 canonical 验证结果；此处只投影 canonical 状态。'),
                    )
                  : h(
                      'div',
                      { className: 'runtime-detail' },
                      props.taskDetail === null
                        ? h('p', { className: 'muted' }, '选择运行页中的任务以查看 canonical 明细。')
                        : h(
                            'dl',
                            { className: 'kv' },
                            h('dt', null, '任务'),
                            h('dd', null, props.taskDetail.taskId),
                            h('dt', null, '角色'),
                            h('dd', null, props.taskDetail.roleId),
                            h('dt', null, '模型'),
                            h('dd', null, props.taskDetail.provenance[0]?.modelKey ?? '—'),
                            h('dt', null, 'Provider'),
                            h('dd', null, props.taskDetail.provider?.providerKey ?? '—'),
                            h('dt', null, '状态'),
                            h('dd', null, `${props.taskDetail.state} · 尝试 ${props.taskDetail.attempts}/${props.taskDetail.maxAttempts}`),
                            h('dt', null, '开始'),
                            h('dd', null, props.taskDetail.createdAt),
                            h('dt', null, 'Provider 状态'),
                            h('dd', null, props.taskDetail.provider?.state ?? '—'),
                            h('dt', null, '耗时'),
                            h('dd', null, formatElapsed(props.taskDetail.createdAt, props.taskDetail.updatedAt)),
                            h('dt', null, '尝试'),
                            h(
                              'dd',
                              null,
                              `${props.taskDetail.attempts}/${props.taskDetail.maxAttempts}`,
                            ),
                            h('dt', null, '失败分类'),
                            h('dd', null, failureClassificationOf(props.taskDetail)),
                          ),
                    ),
          )
      : h('p', { className: 'muted runtime-panel__hint' }, '已收起 — 对话优先。'),
  );
}

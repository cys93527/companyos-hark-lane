/**
 * STAGE 2 — the ChatGPT-like centre: ONE conversation per Goal.
 *
 * The user's message is the Goal (natural language). Everything CompanyOS says back is
 * DERIVED PRESENTATION projected from canonical durable state — it is never a second
 * conversation/workflow/event truth. There is no streaming model text here: the desktop
 * client shows canonical phases, activity facts, validation, artifacts and the Outcome.
 *
 * Activity is never progress. A FAILED Goal stays FAILED and is never relabelled
 * "completed with warning".
 */
import { attemptFailureLabel, failureRemedyOf, REMEDY_LABELS, runFailureReasonLabel, type FailureRemedy } from './failure-labels.js';
import { plainActivity } from './activity.js';
import { TypedErrorLine } from './typed-error.js';
import { createElement as h, type JSX, type ReactNode } from 'react';

import { projectRuntimePhase, type RuntimePhase, type CanonicalTimelineEntry, type CanonicalGoalWorkspace } from './runtime-panel.js';
import { terminalOutcomeOf } from './run-outcome.js';
import { artifactKindWord, clockTime } from './format.js';
import type { PlanStepView } from './plan-steps.js';

export type ChatEntry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'goal-accepted'; readonly runId: string; readonly objective: string }
  | { readonly kind: 'phase'; readonly phase: RuntimePhase; readonly runState: string }
  | { readonly kind: 'activity'; readonly entryKind: string; readonly summary: string; readonly occurredAt?: string | null; readonly key?: string }
  | { readonly kind: 'validation'; readonly completed: number; readonly failed: boolean; readonly missing: number }
  | { readonly kind: 'artifacts'; readonly artifacts: readonly { readonly artifactId: string; readonly kind: string }[] }
  | { readonly kind: 'outcome'; readonly delivered: boolean }
  | {
      readonly kind: 'failed';
      readonly reason: string | null;
      readonly blockerCodes: readonly string[];
      readonly detail?: string | null;
      /** UI-AUDIT-2: the one fix the user can take (budget / model), when there is one. */
      readonly remedy?: FailureRemedy | null;
      /** UI-AUDIT-2: the internal codes, shown only under 详情. */
      readonly codes?: readonly string[];
    }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'cancel-requested' };

/**
 * Project the canonical state of ONE goal run into the conversation surface.
 * `objective` is the submitted text; everything else comes from projections.
 */
export const projectConversation = (
  workspace: CanonicalGoalWorkspace,
  objective: string,
  timeline: readonly CanonicalTimelineEntry[],
): readonly ChatEntry[] => {
  const entries: ChatEntry[] = [{ kind: 'user', text: objective }];
  entries.push({ kind: 'goal-accepted', runId: workspace.runId, objective });
  const phase = projectRuntimePhase({
    runState: workspace.overview?.state ?? null,
    blockers: workspace.blockers,
    failureReason: workspace.overview?.failureReason ?? null,
    ...(workspace.overview?.terminalOutcome === undefined ? {} : { terminalOutcome: workspace.overview.terminalOutcome }),
  });
  entries.push({ kind: 'phase', phase, runState: workspace.overview?.state ?? 'UNKNOWN' });

  // H12b: a cancelled Goal is its own typed ending, never "目标失败".
  const outcome = terminalOutcomeOf(workspace.overview);
  if (outcome === 'CANCELLED') entries.push({ kind: 'cancelled' });
  // AUDIT-R1: a durable cancel intent on a Goal that has not ended yet.
  else if (workspace.cancellationRequested === true && outcome === null) entries.push({ kind: 'cancel-requested' });
  const failed = outcome === 'FAILED' || outcome === 'TIMED_OUT';
  if (failed) {
    entries.push({
      kind: 'failed',
      reason: workspace.overview?.failureReason ?? null,
      blockerCodes: workspace.blockers.map((blocker) => blocker.code),
      detail: attemptFailureLabel(workspace.attemptFailure ?? null),
      remedy: failureRemedyOf(workspace.attemptFailure ?? null),
      codes: [
        workspace.overview?.failureReason ?? null,
        workspace.attemptFailure?.failureCode ?? null,
        workspace.attemptFailure?.detailCode ?? null,
        ...workspace.blockers.map((blocker) => blocker.code),
      ].filter((code, index, all): code is string => code !== null && code !== '' && all.indexOf(code) === index),
    });
  }

  for (const entry of timeline.slice(-8)) {
    entries.push({ kind: 'activity', entryKind: entry.kind, summary: entry.summary, occurredAt: entry.occurredAt, key: entry.key });
  }

  const overview = workspace.overview;
  if (overview !== null) {
    entries.push({
      kind: 'validation',
      completed: overview.validation.completed.length,
      failed: overview.validation.failed === true,
      missing: overview.validation.missing.length,
    });
    entries.push({
      kind: 'artifacts',
      artifacts: overview.artifacts.map((artifact) => ({ artifactId: artifact.id, kind: artifact.kind })),
    });
    // UI-AUDIT-19: the outcome is a fact of an ENDED Goal; a live Goal is not "未交付".
    if (outcome !== null) entries.push({ kind: 'outcome', delivered: overview.state === 'COMPLETED' });
  }
  return entries;
};

export interface GoalHeaderView {
  readonly stateWord: string;
  readonly live: boolean;
  readonly runId: string;
  readonly tasksText: string | null;
  readonly startedText: string | null;
}

export interface ChatViewProps {
  readonly objective: string | null;
  readonly entries: readonly ChatEntry[];
  readonly loading: boolean;
  readonly failure: { readonly code: string; readonly message: string } | null;
  /** UI-PAPER-INK goal page extras (all optional; absent = plain conversation). */
  readonly header?: GoalHeaderView | null;
  readonly createdAt?: string | null;
  readonly planSteps?: readonly PlanStepView[] | null;
  readonly criteria?: readonly { readonly criterionId: string; readonly requirement: string }[] | null;
  /** The inline approval block of THIS Goal. */
  readonly approval?: ReactNode;
  /** The one live line (what is running right now), accent dot. */
  readonly liveLine?: string | null;
  /** UI-AUDIT-17: an ended Goal can hand its description back to the composer (never auto-sends). */
  readonly onReuseObjective?: (() => void) | null;
  readonly reuseDisabledReason?: string | null;
  /** UI-AUDIT-2: the failure's fix action (opens the budget / model settings). */
  readonly onRemedy?: ((remedy: FailureRemedy) => void) | null;
}

const TITLE_MAX = 48;
/** The H1 is the first line of the objective, bounded; the full text stays in the quote. */
export const goalTitleOf = (objective: string): { readonly title: string; readonly truncated: boolean } => {
  const firstLine = objective.split(/\r?\n/u)[0]?.trim() ?? '';
  const base = firstLine === '' ? objective.trim() : firstLine;
  if (base.length <= TITLE_MAX && base === objective.trim()) return { title: base, truncated: false };
  return { title: base.length <= TITLE_MAX ? base : `${base.slice(0, TITLE_MAX)}…`, truncated: true };
};

const stepGlyphClass: Readonly<Record<PlanStepView['state'], string>> = {
  DONE: 'step--done',
  EXECUTING: 'step--exec',
  AWAITING: 'step--wait',
  BLOCKED: 'step--wait',
  PENDING: 'step--pend',
  FAILED: 'step--fail',
  CANCELLED: 'step--cancel',
  NOT_RUN: 'step--cancel',
};

/** Pure view: the goal page (or the empty prompt when no Goal is open). */
export function ChatView(props: ChatViewProps): JSX.Element {
  if (props.objective === null) {
    return h(
      'div',
      { className: 'chat chat--empty', 'data-testid': 'conversation', 'aria-label': '对话' },
      h('h1', { className: 'chat__title' }, '你想把什么事情变成现实？'),
      h('p', { className: 'chat__subtitle muted' }, '在下方用一句话描述目标，CompanyOS 会规划、执行并交付；高风险操作会停下来等你批准。'),
      // AUDIT R3: a failure is never swallowed by the empty state.
      props.failure === null ? null : h(TypedErrorLine, { failure: props.failure }),
    );
  }
  const { title, truncated } = goalTitleOf(props.objective);
  const accepted = clockTime(props.createdAt ?? null);
  const rows: JSX.Element[] = [];
  const row = (key: string, time: string | null, content: ReactNode, className = ''): void => {
    rows.push(
      h('div', { key: `t${key}`, className: 'tl__time num', 'aria-hidden': time === null ? true : undefined }, time ?? ''),
      h('div', { key: `e${key}`, className: `tl__ev ${className}`.trim() }, content),
    );
  };
  const steps = props.planSteps ?? null;
  const criteria = props.criteria ?? [];
  let lastActivityTime: string | null = null;
  let activityBuffer: { key: string; kind: string; summary: string }[] = [];
  // UI-AUDIT-2: plain Chinese steps are the activity; the raw timeline is 技术记录 (collapsed).
  const flushActivity = (): void => {
    if (activityBuffer.length === 0) return;
    const lines = activityBuffer;
    activityBuffer = [];
    const plain = plainActivity(lines.map((line) => ({ key: line.key, kind: line.kind, summary: line.summary })));
    row(`act${lines[0]!.key}`, lastActivityTime, h(
      'div',
      { className: 'activity' },
      plain.length === 0
        ? null
        : h(
            'div',
            { role: 'list', 'aria-label': '活动' },
            plain.map((line) => h('div', { key: line.key, className: 'chat__row chat__row--activity', role: 'listitem' }, line.text)),
          ),
      h(
        'details',
        { className: 'tech activity__tech' },
        h('summary', null, `技术记录 · ${String(lines.length)} 条`),
        h(
          'ul',
          { className: 'tech__list mono' },
          lines.map((line) => h('li', { key: line.key }, h('span', { className: 'activity__k' }, line.kind), ' · ', line.summary)),
        ),
      ),
    ));
  };
  props.entries.forEach((entry, index) => {
    if (entry.kind !== 'activity') flushActivity();
    switch (entry.kind) {
      case 'user':
      case 'phase':
        return;
      case 'goal-accepted':
        row(`g${String(index)}`, accepted, h(
          'span',
          { className: 'chat__row chat__row--system' },
          h('b', null, '已接受目标'),
          steps === null
            ? null
            : `，规划完成 · ${String(steps.length)} 步${criteria.length === 0 ? '' : ` · ${String(criteria.length)} 条验收标准`}`,
        ));
        if (steps !== null && steps.length > 0) {
          row('plan', '计划', h(
            'div',
            { className: 'plan', 'data-testid': 'plan-steps' },
            h(
              'ol',
              { className: 'steps', 'aria-label': '计划步骤' },
              steps.map((step) =>
                h(
                  'li',
                  { key: step.planItemId, className: `step ${stepGlyphClass[step.state]}`, 'data-state': step.state },
                  h('span', { className: 'step__glyph', 'aria-hidden': true }),
                  h('span', { className: 'step__title' }, step.title),
                  h('span', { className: 'step__state num' }, step.label),
                ),
              ),
            ),
            criteria.length === 0
              ? null
              : h(
                  'ul',
                  { className: 'criteria', 'aria-label': '验收标准' },
                  criteria.map((criterion) =>
                    h(
                      'li',
                      { key: criterion.criterionId },
                      h('span', { className: 'criteria__glyph', 'aria-hidden': true }),
                      h('span', null, `验收 · ${criterion.requirement}`),
                    ),
                  ),
                ),
          ));
        }
        return;
      case 'activity': {
        const time = clockTime(entry.occurredAt ?? null);
        if (activityBuffer.length > 0 && time !== lastActivityTime) flushActivity();
        if (activityBuffer.length === 0) lastActivityTime = time;
        activityBuffer.push({ key: `a${String(index)}`, kind: entry.entryKind, summary: entry.summary });
        return;
      }
      case 'validation':
        row(`v${String(index)}`, null, h('span', { className: 'chat__row chat__row--meta num' },
          `验证 · 完成 ${entry.completed} · 失败 ${entry.failed ? 1 : 0} · 缺失 ${entry.missing}`));
        return;
      case 'artifacts':
        row(`f${String(index)}`, null, h('span', { className: 'chat__row chat__row--meta' },
          entry.artifacts.length === 0 ? '产物 · 暂无' : `产物 · ${[...new Set(entry.artifacts.map((a) => artifactKindWord(a.kind)))].join('、')}`));
        return;
      case 'outcome':
        row(`o${String(index)}`, null, h('span', { className: entry.delivered ? 'chat__row chat__row--outcome' : 'chat__row chat__row--meta' },
          entry.delivered ? '结果 · 已交付' : '结果 · 未交付'));
        return;
      case 'cancelled':
        row(`c${String(index)}`, null, h('span', { className: 'chat__row chat__row--cancelled' }, '目标已取消 · 不再启动新的工作或模型调用'));
        return;
      case 'cancel-requested':
        row(`q${String(index)}`, null, h('span', { className: 'chat__row chat__row--cancelled', role: 'status' }, '已请求取消，不再启动新的工作；正在收尾'));
        return;
      case 'failed': {
        const remedy = entry.remedy ?? null;
        row(`x${String(index)}`, null, h(
          'div',
          { className: 'chat__failure' },
          h('span', { className: 'chat__row chat__row--failed', role: 'alert' },
            h('span', { className: 'chat__fail-glyph', 'aria-hidden': true }),
            `目标失败 · ${entry.detail ?? runFailureReasonLabel(entry.reason) ?? '未给出原因'}`),
          remedy === null || props.onRemedy === undefined || props.onRemedy === null
            ? null
            : h('button', { type: 'button', className: 'btn btn--quiet btn--small', 'data-testid': 'failure-remedy', onClick: () => props.onRemedy?.(remedy) }, REMEDY_LABELS[remedy]),
          entry.codes === undefined || entry.codes.length === 0
            ? null
            : h('details', { className: 'tech' }, h('summary', null, '详情'), h('code', { className: 'tech__code' }, entry.codes.join(' · '))),
        ));
        return;
      }
      default:
        return;
    }
  });
  flushActivity();
  if (props.approval !== undefined && props.approval !== null && props.approval !== false) {
    row('approval', null, props.approval);
  }
  if (props.liveLine !== undefined && props.liveLine !== null) {
    row('live', null, h('div', { className: 'live-line', role: 'status' }, props.liveLine));
  }
  if (props.onReuseObjective !== undefined && props.onReuseObjective !== null) {
    row('reuse', null, h(
      'div',
      { className: 'chat__next' },
      h('button', {
        type: 'button',
        className: 'btn btn--quiet btn--small',
        onClick: props.onReuseObjective,
        disabled: props.reuseDisabledReason != null,
        title: props.reuseDisabledReason ?? '把这个目标的描述放进输入框，修改后再发送（不会自动发送）',
      }, '用这个描述新建目标'),
      props.reuseDisabledReason == null ? null : h('span', { className: 'muted' }, props.reuseDisabledReason),
    ));
  }
  return h(
    'article',
    { className: 'chat goal-page', 'data-testid': 'conversation', 'aria-label': '对话' },
    props.header === undefined || props.header === null
      ? null
      : h(
          'div',
          { className: 'goal-meta' },
          // UI-AUDIT-2: the run id is a support detail (tooltip), not page text.
          h('span', { className: props.header.live ? 'goal-meta__state goal-meta__state--live' : 'goal-meta__state', title: `目标编号 ${props.header.runId}` }, props.header.stateWord),
          props.header.tasksText === null ? null : h('span', { className: 'num' }, props.header.tasksText),
          props.header.startedText === null ? null : h('span', { className: 'num' }, props.header.startedText),
        ),
    h('h1', { className: 'goal-page__title', title: props.objective }, title),
    truncated
      ? h('blockquote', { className: 'ask' }, h('span', { className: 'ask__who' }, accepted === null ? '你' : `你 · ${accepted}`), props.objective)
      : null,
    props.loading ? h('p', { className: 'muted', role: 'status' }, '正在读取目标状态…') : null,
    props.failure === null ? null : h(TypedErrorLine, { failure: props.failure }),
    rows.length === 0 ? null : h('div', { className: 'tl' }, rows),
  );
}

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
import { createElement as h, type JSX } from 'react';

import { projectRuntimePhase, type RuntimePhase, type CanonicalTimelineEntry, type CanonicalGoalWorkspace } from './runtime-panel.js';
import { PHASE_LABELS } from './runtime-panel.js';

export type ChatEntry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'goal-accepted'; readonly runId: string; readonly objective: string }
  | { readonly kind: 'phase'; readonly phase: RuntimePhase; readonly runState: string }
  | { readonly kind: 'activity'; readonly entryKind: string; readonly summary: string }
  | { readonly kind: 'validation'; readonly completed: number; readonly failed: boolean; readonly missing: number }
  | { readonly kind: 'artifacts'; readonly artifacts: readonly { readonly artifactId: string; readonly kind: string }[] }
  | { readonly kind: 'outcome'; readonly delivered: boolean }
  | { readonly kind: 'failed'; readonly reason: string | null; readonly blockerCodes: readonly string[] };

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
  });
  entries.push({ kind: 'phase', phase, runState: workspace.overview?.state ?? 'UNKNOWN' });

  const failed = workspace.overview !== null && ['FAILED', 'CANCELLED'].includes(workspace.overview.state);
  if (failed) {
    entries.push({
      kind: 'failed',
      reason: workspace.overview?.failureReason ?? null,
      blockerCodes: workspace.blockers.map((blocker) => blocker.code),
    });
  }

  for (const entry of timeline.slice(-8)) {
    entries.push({ kind: 'activity', entryKind: entry.kind, summary: entry.summary });
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
    entries.push({ kind: 'outcome', delivered: overview.state === 'COMPLETED' });
  }
  return entries;
};

export interface ChatViewProps {
  readonly objective: string | null;
  readonly entries: readonly ChatEntry[];
  readonly loading: boolean;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

/** Pure view: the conversation. User rows carry light chrome; responses do not. */
export function ChatView(props: ChatViewProps): JSX.Element {
  if (props.objective === null) {
    return h(
      'div',
      { className: 'chat chat--empty', 'aria-label': 'conversation' },
      h('h1', { className: 'chat__title' }, '你想把什么事情变成现实？'),
      h('p', { className: 'chat__subtitle muted' }, '用一句话描述目标，CompanyOS 会规划、执行并交付。'),
    );
  }
  return h(
    'div',
    { className: 'chat', 'aria-label': 'conversation' },
    props.loading ? h('p', { className: 'muted' }, '读取 canonical 状态…') : null,
    props.failure === null
      ? null
      : h('p', { className: 'typed-error__message', role: 'alert' }, `${props.failure.code} ${props.failure.message}`),
    props.entries.map((entry, index) => {
      switch (entry.kind) {
        case 'user':
          return h('div', { key: `u${index}`, className: 'chat__row chat__row--user' }, entry.text);
        case 'goal-accepted':
          return h(
            'div',
            { key: `g${index}`, className: 'chat__row chat__row--system' },
            `已接受目标 · ${entry.runId}`,
          );
        case 'phase':
          return h(
            'div',
            { key: `p${index}`, className: 'chat__row' },
            `阶段 · ${PHASE_LABELS[entry.phase]}（canonical 状态 ${entry.runState}）`,
          );
        case 'activity':
          return h('div', { key: `a${index}`, className: 'chat__row chat__row--activity' }, `${entry.entryKind} · ${entry.summary}`);
        case 'validation':
          return h(
            'div',
            { key: `v${index}`, className: 'chat__row' },
            `验证 · 完成 ${entry.completed} · 失败 ${entry.failed ? 1 : 0} · 缺失 ${entry.failed === true ? 1 : 0}`,
          );
        case 'artifacts':
          return h(
            'div',
            { key: `f${index}`, className: 'chat__row' },
            entry.artifacts.length === 0 ? '产物 · 暂无' : `产物 · ${entry.artifacts.map((a) => a.kind).join('、')}`,
          );
        case 'outcome':
          return h(
            'div',
            { key: `o${index}`, className: entry.delivered ? 'chat__row chat__row--outcome' : 'chat__row' },
            entry.delivered ? '结果 · 已交付' : '结果 · 未交付',
          );
        case 'failed':
          return h(
            'div',
            { key: `x${index}`, className: 'chat__row chat__row--failed', role: 'alert' },
            `目标失败 · ${entry.reason ?? '未给出原因'}${entry.blockerCodes.length === 0 ? '' : ` · ${entry.blockerCodes.join('、')}`}`,
          );
        default:
          return null;
      }
    }),
  );
}

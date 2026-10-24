/**
 * STAGE 2 — the ChatGPT-like composer, the model selector and the model runtime popover.
 *
 * The composer carries FOUR affordances and nothing else:
 *   [ + ]            change the workspace (the ONE operational context a Goal runs in)
 *   [ 访问权限 ▾ ]   the CURRENT EFFECTIVE authority, read from canonical run state —
 *                    display-only. CompanyOS Authority owns permission truth; the renderer
 *                    never invents, stores or mutates it.
 *   [ 工具 ]         the canonical tool registry (one bounded invocation per request)
 *   [ model ▾ ]      the canonical COMPANY model selection
 *   [ send ]         ONE submission intent (see submission-intent.ts)
 *
 * No permanent token card lives in the composer: telemetry belongs in the model popover,
 * runtime detail belongs in the collapsible runtime panel.
 */
import { createElement as h, type JSX } from 'react';

import type { ModelOptionRow } from './models.js';
import { projectModelRuntime, type ModelRuntimeSnapshot } from './telemetry.js';

/** Canonical, display-only authority modes derived from run state + blocker codes. */
export type EffectiveAuthorityMode = 'read-only' | 'workspace-operations' | 'ask-permission';

export interface EffectiveAuthority {
  readonly mode: EffectiveAuthorityMode;
  /** The canonical projection this mode was derived from (never a UI opinion). */
  readonly basis: string;
  readonly mutable: false;
}

const AUTHORITY_LABELS: Readonly<Record<EffectiveAuthorityMode, string>> = {
  'ask-permission': '询问权限',
  'read-only': '只读',
  'workspace-operations': '工作区操作',
};

/**
 * Derive the effective authority from canonical state only. A run that is blocked on
 * APPROVAL_REQUIRED is in ask-permission; a run that is executing performs workspace
 * operations; anything else (no run, terminal run, failed run) is read-only for the
 * operator. The renderer cannot switch modes — mutation is deferred to Stage 3, where a
 * canonical authority seam is mapped.
 */
export const projectEffectiveAuthority = (input: {
  readonly runState: string | null;
  readonly blockerCodes: readonly string[];
}): EffectiveAuthority => {
  if (input.blockerCodes.includes('APPROVAL_REQUIRED')) {
    return { mode: 'ask-permission', basis: 'blocker:APPROVAL_REQUIRED', mutable: false };
  }
  if (input.runState !== null && ['RUNNING', 'EXECUTING'].includes(input.runState)) {
    return { mode: 'workspace-operations', basis: `runState:${input.runState}`, mutable: false };
  }
  return { mode: 'read-only', basis: input.runState === null ? 'no-active-run' : `runState:${input.runState}`, mutable: false };
};

export const authorityLabel = (mode: EffectiveAuthorityMode): string => AUTHORITY_LABELS[mode];

/* ------------------------------------------------------- model selector --- */

export interface ModelSelectorViewProps {
  readonly options: readonly ModelOptionRow[];
  readonly selectedModelKey: string | null;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onChoose: (option: ModelOptionRow) => void;
  readonly onOpenSettings: () => void;
  readonly providerConfigured: boolean;
}

export function ModelSelectorView(props: ModelSelectorViewProps): JSX.Element {
  const selected = props.options.find((option) => option.modelKey === props.selectedModelKey) ?? null;
  const label = selected === null ? '选择模型' : selected.displayName;
  return h(
    'div',
    { className: 'composer__model', 'aria-label': 'model-selector' },
    h(
      'button',
      { type: 'button', className: 'composer__model-button', onClick: props.onToggle, disabled: props.busy },
      h('span', { className: 'composer__model-label' }, label),
      h('span', { className: 'composer__caret' }, '▾'),
    ),
    props.open
      ? h(
          'div',
          { className: 'popover', role: 'dialog', 'aria-label': 'model-selector-popover' },
          props.providerConfigured
            ? h(
                'ul',
                { className: 'popover__list' },
                props.options.map((option) =>
                  h(
                    'li',
                    { key: `${option.providerId}/${option.providerModelId}` },
                    h(
                      'button',
                      {
                        type: 'button',
                        className:
                          option.modelKey !== null && option.modelKey === props.selectedModelKey
                            ? 'popover__item popover__item--active'
                            : 'popover__item',
                        disabled: props.busy,
                        onClick: () => props.onChoose(option),
                      },
                      h('span', null, option.displayName),
                      h('span', { className: 'muted' }, option.registered ? '已注册' : '待注册'),
                    ),
                  ),
                ),
              )
            : h(
                'div',
                { className: 'popover__empty' },
                h('p', { className: 'muted' }, '尚未配置模型提供商'),
                h('button', { type: 'button', onClick: props.onOpenSettings }, '前往设置'),
              ),
        )
      : null,
  );
}

/* -------------------------------------------------- model runtime popover --- */

export interface ModelRuntimePopoverProps {
  readonly snapshot: ModelRuntimeSnapshot;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** STAGE 3: the honest usage note (coverage truth), rendered under the metric rows. */
  readonly usageNote?: string | null;
}

/** The compact telemetry popover. Every slot is honest: UNKNOWN renders "--" (never 0%). */
export function ModelRuntimePopover(props: ModelRuntimePopoverProps): JSX.Element {
  const view = projectModelRuntime(props.snapshot);
  return h(
    'div',
    { className: 'composer__runtime', 'aria-label': 'model-runtime' },
    h(
      'button',
      { type: 'button', className: 'composer__model-button', onClick: props.onToggle, 'aria-expanded': props.open },
      h('span', { className: 'composer__model-label' }, view.modelLabel),
      h('span', { className: 'composer__caret' }, '▾'),
    ),
    props.open
      ? h(
          'div',
          { className: 'popover popover--runtime', role: 'dialog', 'aria-label': 'model-runtime-popover' },
          h('div', { className: 'popover__row' }, h('span', { className: 'muted' }, '上下文'), h('span', null, view.contextWindow)),
          h(
            'div',
            { className: 'popover__row' },
            h('span', { className: 'muted' }, '剩余'),
            h('span', { className: view.remaining === '--' ? 'popover__unknown' : undefined }, view.remaining),
          ),
          h('div', { className: 'popover__row' }, h('span', { className: 'muted' }, '已使用'), h('span', null, view.used)),
          h(
            'div',
            { className: 'popover__row' },
            h('span', { className: 'muted' }, '生成速度'),
            h('span', null, view.speed),
          ),
          h('div', { className: 'popover__row' }, h('span', { className: 'muted' }, '缓存命中'), h('span', null, view.cacheHit)),
          h('div', { className: 'popover__row' }, h('span', { className: 'muted' }, '会话费用'), h('span', null, view.cost)),
          view.telemetryUnavailable
            ? h('p', { className: 'popover__note muted' }, '暂无可用遥测（未知值显示 --）')
            : null,
          props.usageNote === undefined || props.usageNote === null || props.usageNote === ''
            ? null
            : h('p', { className: 'popover__note muted' }, props.usageNote),
        )
      : null,
  );
}

/* ------------------------------------------------------------- composer --- */

export interface ComposerViewProps {
  readonly draft: string;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly authority: EffectiveAuthority;
  readonly modelLabel: string;
  readonly workspaceLabel: string | null;
  readonly pendingIntent: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onChangeWorkspace: () => void;
  readonly onOpenTools: () => void;
  readonly onOpenAuthority: () => void;
  readonly onOpenModel: () => void;
  readonly authorityOpen: boolean;
  readonly modelOpen: boolean;
}

export function ComposerView(props: ComposerViewProps): JSX.Element {
  return h(
    'div',
    { className: 'composer', 'aria-label': 'composer' },
    h(
      'div',
      { className: 'composer__left' },
      h(
        'button',
        { type: 'button', className: 'composer__chip', onClick: props.onChangeWorkspace, title: '切换工作空间' },
        '+',
      ),
      h(
        'button',
        { type: 'button', className: 'composer__chip', onClick: props.onOpenAuthority, 'aria-expanded': props.authorityOpen },
        `${authorityLabel(props.authority.mode)} ▾`,
      ),
      h('button', { type: 'button', className: 'composer__chip', onClick: props.onOpenTools }, '工具'),
    ),
    h(
      'div',
      { className: 'composer__center' },
      h('textarea', {
        className: 'composer__input',
        'aria-label': 'goal-objective',
        placeholder: '用自然语言描述你想达成的目标…',
        rows: 3,
        value: props.draft,
        disabled: props.busy,
        onChange: (event: { target: { value: string } }) => props.onDraftChange(event.target.value),
      }),
    ),
    h(
      'div',
      { className: 'composer__right' },
      h('span', { className: 'composer__model-slot' }, props.modelLabel),
      h(
        'button',
        {
          type: 'button',
          className: 'composer__send',
          disabled: !props.ready || props.busy,
          onClick: props.onSubmit,
        },
        props.busy ? '提交中…' : '提交并开始执行',
      ),
    ),
  );
}

/* --------------------------------------------------- authority popover --- */

export interface AuthorityPopoverProps {
  readonly authority: EffectiveAuthority;
  readonly open: boolean;
  /** STAGE 4: the REAL selection (canonical values). Absent → display-only fallback. */
  readonly selectedPolicy?: 'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS' | null;
  readonly onSelectPolicy?: (policy: 'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS') => void;
  /** The current Goal's canonical policy (read-back), shown as effective truth. */
  readonly effectiveGoalPolicy?: string | null;
}

/** The three canonical policies with their user-facing labels (Section A vocabulary). */
export const ACCESS_POLICY_OPTIONS: readonly { readonly value: 'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS'; readonly label: string; readonly hint: string }[] = [
  { value: 'ASK_PERMISSION', label: '询问权限', hint: '正常自主执行；高风险操作停在 canonical 审批边界' },
  { value: 'READ_ONLY', label: '只读', hint: '内核沙箱强制只读——一切写操作被 DSH 拒绝' },
  { value: 'WORKSPACE_OPERATIONS', label: '工作区操作', hint: '仅限受信工作空间内的变更；仍需 canonical 审批' },
];

export function AuthorityPopover(props: AuthorityPopoverProps): JSX.Element {
  if (!props.open) return h('div', { className: 'popover-host' });
  const selectable = typeof props.onSelectPolicy === 'function';
  return h(
    'div',
    { className: 'popover', role: 'dialog', 'aria-label': 'authority-popover' },
    h('div', { className: 'popover__row' }, h('span', { className: 'muted' }, '当前权限'), h('span', null, authorityLabel(props.authority.mode))),
    h('div', { className: 'popover__row' }, h('span', { className: 'muted' }, '依据'), h('span', null, props.authority.basis)),
    props.effectiveGoalPolicy === undefined || props.effectiveGoalPolicy === null
      ? null
      : h(
          'div',
          { className: 'popover__row' },
          h('span', { className: 'muted' }, '当前目标策略'),
          h('span', null, props.effectiveGoalPolicy),
        ),
    selectable
      ? h(
          'div',
          { className: 'authority-options', 'aria-label': 'authority-options' },
          ACCESS_POLICY_OPTIONS.map((option) =>
            h(
              'button',
              {
                key: option.value,
                type: 'button',
                className: props.selectedPolicy === option.value ? 'popover__item popover__item--active' : 'popover__item',
                onClick: () => props.onSelectPolicy?.(option.value),
              },
              h('span', null, option.label),
              h('span', { className: 'muted' }, option.hint),
            ),
          ),
        )
      : null,
    h(
      'p',
      { className: 'popover__note muted' },
      selectable
        ? '所选策略随下一个目标以 canonical 命令持久化，并由 DSH 内核沙箱在渲染器之下强制。'
        : '只读展示：权限由 CompanyOS Authority / Approval 治理，界面不创建、不保存、不切换权限。',
    ),
  );
}

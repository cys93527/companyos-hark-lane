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
import { createElement as h, type JSX, type ReactNode } from 'react';

import type { ModelOptionRow } from './models.js';
import { projectModelRuntime, type ModelRuntimeSnapshot } from './telemetry.js';

/**
 * AUDIT-R14: a popover dialog takes focus when it opens and closes on Escape, so keyboard and
 * screen-reader users are not left on the trigger with an unannounced dialog.
 */
export const popoverDialogProps = (onClose: (() => void) | undefined): {
  readonly tabIndex: number;
  readonly ref: (element: { focus?: () => void } | null) => void;
  readonly onKeyDown: (event: { readonly key: string; readonly stopPropagation?: () => void }) => void;
} => ({
  tabIndex: -1,
  ref: (element) => {
    if (element !== null && typeof element.focus === 'function') element.focus();
  },
  onKeyDown: (event) => {
    if (event.key !== 'Escape' || onClose === undefined) return;
    event.stopPropagation?.();
    onClose();
  },
});

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

/**
 * AUDIT-R4: the run-state projection above is a STATUS of the open Goal, never a permission: shown as such
 * ("等待批准 / 执行中 / 未在执行") so it can't be read as the access policy. The chip shows the policy the NEXT
 * Goal will be created with (the real selection).
 */
const AUTHORITY_STATUS_LABELS: Readonly<Record<EffectiveAuthorityMode, string>> = {
  'ask-permission': '等待批准',
  'workspace-operations': '执行中',
  'read-only': '未在执行',
};
export const authorityStatusLabel = (authority: { readonly mode: string; readonly basis: string }): string =>
  authority.basis === 'no-active-run'
    ? '没有打开的目标'
    : (AUTHORITY_STATUS_LABELS as Readonly<Record<string, string>>)[authority.mode] ?? authority.mode;

export const accessPolicyLabel = (policy: string | null | undefined): string | null =>
  ACCESS_POLICY_OPTIONS.find((option) => option.value === policy)?.label ?? null;

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
  /** UI-PAPER-INK: the trigger lives in the composer row (the model chip); render the popover only. */
  readonly triggerless?: boolean;
}

export function ModelSelectorView(props: ModelSelectorViewProps): JSX.Element {
  const selected = props.options.find((option) => option.modelKey === props.selectedModelKey) ?? null;
  const label = selected === null ? '选择模型' : selected.displayName;
  return h(
    'div',
    { className: props.triggerless === true ? 'composer__model composer__model--popover-only' : 'composer__model', 'data-testid': 'model-selector', 'aria-label': '模型选择' },
    props.triggerless === true
      ? null
      : h(
          'button',
          { type: 'button', className: 'composer__model-button', onClick: props.onToggle, disabled: props.busy, 'aria-expanded': props.open, 'aria-haspopup': 'dialog' },
          h('span', { className: 'composer__model-label' }, label),
          h('span', { className: 'composer__caret' }, '▾'),
        ),
    props.open
      ? h(
          'div',
          { className: 'popover', role: 'dialog', 'data-testid': 'model-selector-popover', 'aria-label': '选择模型', ...popoverDialogProps(props.onToggle) },
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
    { className: 'composer__runtime', 'data-testid': 'model-runtime', 'aria-label': '模型运行状态' },
    h(
      'button',
      { type: 'button', className: 'composer__model-button', onClick: props.onToggle, 'aria-expanded': props.open },
      h('span', { className: 'composer__model-label' }, view.modelLabel),
      h('span', { className: 'composer__caret' }, '▾'),
    ),
    props.open
      ? h(
          'div',
          { className: 'popover popover--runtime', role: 'dialog', 'data-testid': 'model-runtime-popover', 'aria-label': '模型运行详情', ...popoverDialogProps(props.onToggle) },
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
  /** AUDIT-R4: the access policy the next Goal is created with (the chip's label). */
  readonly nextPolicy?: 'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS' | null;
  readonly modelLabel: string;
  readonly workspaceLabel: string | null;
  readonly pendingIntent: boolean;
  /** AUDIT R2: the objective of the unconfirmed submission, shown with 重试 / 放弃. */
  readonly pendingObjective?: string | null;
  readonly onRetryPending?: () => void;
  readonly onDiscardPending?: () => void;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onChangeWorkspace: () => void;
  readonly onOpenTools: () => void;
  readonly onOpenAuthority: () => void;
  readonly onOpenModel: () => void;
  readonly authorityOpen: boolean;
  readonly modelOpen: boolean;
  /** UI-PAPER-INK: why Send is unavailable (database down, no model, …), shown under the field. */
  readonly blockedReason?: string | null;
  /** The line under the field: the approval-boundary hint and the session cost (`--` when unknown). */
  readonly footHint?: string | null;
  readonly sessionCost?: string | null;
  /** Popovers anchored to the composer (model selector, access policy). */
  readonly popovers?: ReactNode;
  /** Secondary controls under the field (file requirement, local draft). */
  readonly extras?: ReactNode;
}

/**
 * UI-AUDIT-01: Ctrl+Enter (⌘+Enter) sends; plain Enter is a newline. A key event that is part
 * of an IME composition (Chinese/Japanese input: `isComposing`, or the legacy keyCode 229 that
 * Chromium reports for the composition-confirming Enter) NEVER sends.
 */
export const isSubmitShortcut = (event: {
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly keyCode?: number;
  readonly isComposing?: boolean;
  readonly nativeEvent?: { readonly isComposing?: boolean; readonly keyCode?: number };
}): boolean => {
  if (event.key !== 'Enter') return false;
  if (event.isComposing === true || event.nativeEvent?.isComposing === true) return false;
  if (event.keyCode === 229 || event.nativeEvent?.keyCode === 229) return false;
  if (event.altKey === true || event.shiftKey === true) return false;
  return event.ctrlKey === true || event.metaKey === true;
};

/** UI-AUDIT-02: Send needs a non-blank objective (whitespace never "sends" into a silent no-op). */
export const canSend = (props: { readonly ready: boolean; readonly busy: boolean; readonly draft: string }): boolean =>
  props.ready && !props.busy && props.draft.trim() !== '';

export function ComposerView(props: ComposerViewProps): JSX.Element {
  const sendable = canSend(props);
  return h(
    'div',
    { className: 'composer', 'data-testid': 'composer', 'aria-label': '目标输入区' },
    props.popovers ?? null,
    props.pendingIntent
      ? h(
          'div',
          { className: 'composer__pending', role: 'status', 'data-testid': 'pending-submission' },
          h(
            'p',
            null,
            props.pendingObjective === null || props.pendingObjective === undefined
              ? '上一次提交尚未确认。'
              : `上一次提交尚未确认：「${props.pendingObjective}」`,
          ),
          props.onRetryPending === undefined
            ? null
            : h('button', { type: 'button', className: 'btn btn--quiet', disabled: props.busy, onClick: props.onRetryPending }, '重试'),
          props.onDiscardPending === undefined
            ? null
            : h('button', { type: 'button', className: 'btn btn--text', disabled: props.busy, onClick: props.onDiscardPending }, '放弃'),
        )
      : null,
    h(
      'div',
      { className: 'composer__field' },
      h('textarea', {
        className: 'composer__input',
        'data-testid': 'goal-objective', 'aria-label': '目标描述',
        placeholder: '描述一个新目标…（Ctrl+Enter 发送）',
        rows: 2,
        value: props.draft,
        // UI-AUDIT-25: read-only (not disabled) while sending, so keyboard focus stays in the field.
        readOnly: props.busy,
        'aria-busy': props.busy,
        'aria-keyshortcuts': 'Control+Enter',
        onChange: (event: { target: { value: string } }) => props.onDraftChange(event.target.value),
        onKeyDown: (event: Parameters<typeof isSubmitShortcut>[0] & { preventDefault: () => void }) => {
          if (!isSubmitShortcut(event)) return;
          event.preventDefault();
          if (canSend(props)) props.onSubmit();
        },
      }),
      h(
        'div',
        { className: 'composer__row' },
        h(
          'button',
          { type: 'button', className: 'composer__chip composer__chip--mono', onClick: props.onChangeWorkspace, title: props.workspaceLabel === null ? '选择工作空间' : `切换工作空间（当前 ${props.workspaceLabel}）`, 'aria-label': '切换工作空间' },
          props.workspaceLabel ?? '选择工作空间',
        ),
        h('span', { className: 'composer__sep', 'aria-hidden': true }),
        h(
          'button',
          { type: 'button', className: 'composer__chip', onClick: props.onOpenAuthority, 'aria-expanded': props.authorityOpen, 'aria-haspopup': 'dialog', title: '下一个目标的访问权限' },
          h('span', { className: 'composer__chip-k' }, '权限'),
          `${accessPolicyLabel(props.nextPolicy) ?? '访问权限'} ▾`,
        ),
        h('span', { className: 'composer__sep', 'aria-hidden': true }),
        h('button', { type: 'button', className: 'composer__chip', onClick: props.onOpenTools }, '工具'),
        h(
          'span',
          { className: 'composer__right' },
          h(
            'button',
            { type: 'button', className: 'composer__chip composer__model-slot', onClick: props.onOpenModel, 'aria-expanded': props.modelOpen, 'aria-haspopup': 'dialog', title: '选择公司模型' },
            props.modelLabel,
            h('span', { className: 'composer__chip-k', 'aria-hidden': true }, '▾'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'composer__send',
              disabled: !sendable,
              onClick: props.onSubmit,
              'aria-keyshortcuts': 'Control+Enter',
            },
            props.busy ? '提交中…' : '发送',
            props.busy ? null : h('kbd', { 'aria-hidden': true }, 'Ctrl ↵'),
          ),
        ),
      ),
    ),
    props.blockedReason === undefined || props.blockedReason === null
      ? null
      : h('p', { className: 'composer__blocked', role: 'status', 'data-testid': 'composer-blocked' }, props.blockedReason),
    h(
      'div',
      { className: 'composer__foot' },
      h('span', null, props.footHint ?? '发送会创建一个新目标；高风险操作会停在批准边界，由你决定'),
      props.sessionCost === undefined || props.sessionCost === null
        ? null
        : h('span', { className: 'num', 'data-testid': 'session-cost' }, `会话费用 ${props.sessionCost}`),
    ),
    props.extras ?? null,
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
  /** AUDIT-R14: Escape closes the popover. */
  readonly onClose?: () => void;
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
    { className: 'popover', role: 'dialog', 'data-testid': 'authority-popover', 'aria-label': '访问权限', ...popoverDialogProps(props.onClose) },
    // AUDIT-R4: the next Goal's policy is the selection; the open Goal's run state is a status, not a permission.
    h('div', { className: 'popover__row' }, h('span', { className: 'muted' }, '下一个目标'), h('span', null, accessPolicyLabel(props.selectedPolicy) ?? '访问权限')),
    h('div', { className: 'popover__row' }, h('span', { className: 'muted' }, '当前目标状态'), h('span', null, authorityStatusLabel(props.authority))),
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
          { className: 'authority-options', 'data-testid': 'authority-options', 'aria-label': '访问权限选项' },
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

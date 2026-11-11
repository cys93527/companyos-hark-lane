/**
 * STAGE 2 — the ChatGPT-like composer, the model selector and the model runtime popover.
 *
 * UI-AUDIT-3: the composer carries only what a user needs per message:
 *   [ workspace ]    change the workspace (the ONE operational context a Goal runs in)
 *   [ model ▾ ]      the canonical COMPANY model selection
 *   [ send ]         ONE submission intent (see submission-intent.ts)
 * The access policy is a 设置 → 新目标默认 choice (bound canonically at goal.create), 工具 is a
 * sidebar page, the file-delivery requirement and the approval explainer live in 设置, and the
 * draft is autosaved (local-draft-controls.tsx).
 *
 * No permanent token card lives in the composer: telemetry belongs in the model popover,
 * runtime detail belongs in the collapsible runtime panel.
 */
import { createElement as h, type JSX, type ReactNode } from 'react';

import { goalModelOptions, type ModelOptionRow } from './models.js';
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
  /** UI-AUDIT-2: a per-model budget note (e.g. 未批准预算), from main's budget.readiness. */
  readonly budgetNote?: (option: ModelOptionRow) => string | null;
}

/**
 * UI-AUDIT-2 (user report 2026-11-11): the popover lists ONLY the models the user set up
 * (configured by first-run setup, or registered + enabled in Settings) that main says can run
 * a Goal. The provider's catalogue (image / video / embedding … models, "待注册") is never a
 * choice here; adding a model is a Settings action ("管理模型").
 */
export function ModelSelectorView(props: ModelSelectorViewProps): JSX.Element {
  const choices = goalModelOptions(props.options);
  const selected = props.options.find((option) => option.modelKey === props.selectedModelKey) ?? null;
  const label = selected === null ? '选择模型' : selected.displayName;
  const manage = h(
    'button',
    { type: 'button', className: 'popover__manage btn btn--text', 'data-testid': 'model-manage', onClick: props.onOpenSettings },
    '管理模型（在设置中添加或停用）',
  );
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
          !props.providerConfigured
            ? h(
                'div',
                { className: 'popover__empty' },
                h('p', { className: 'muted' }, '尚未配置模型提供商'),
                h('p', { className: 'muted' }, '在 设置 → 模型服务 里填写 API Key 和预算。'),
                h('button', { type: 'button', className: 'btn btn--quiet', onClick: props.onOpenSettings }, '前往设置'),
              )
            : choices.length === 0
              ? h(
                  'div',
                  { className: 'popover__empty' },
                  h('p', { className: 'muted' }, '还没有可以执行目标的对话模型'),
                  manage,
                )
              : h(
                  'div',
                  null,
                  h('p', { className: 'popover__label label' }, '执行目标用的模型'),
                  h(
                    'ul',
                    { className: 'popover__list', 'data-testid': 'model-choices' },
                    choices.map((option) => {
                      const note = props.budgetNote?.(option) ?? null;
                      return h(
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
                            'aria-current': option.modelKey !== null && option.modelKey === props.selectedModelKey ? 'true' : undefined,
                            onClick: () => props.onChoose(option),
                          },
                          h('span', null, option.displayName),
                          h('span', { className: note === null ? 'muted' : 'popover__warn' }, note ?? (option.configured === true ? '模型服务' : '已添加')),
                        ),
                      );
                    }),
                  ),
                  manage,
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
  /** UI-AUDIT-3: no longer rendered (工具 is in the sidebar; 权限 is a 设置 default). Kept optional for callers. */
  readonly onOpenTools?: () => void;
  readonly onOpenAuthority?: () => void;
  readonly onOpenModel: () => void;
  readonly authorityOpen?: boolean;
  readonly modelOpen: boolean;
  /** UI-PAPER-INK: why Send is unavailable (database down, no model, …), shown under the field. */
  readonly blockedReason?: string | null;
  /** UI-AUDIT-2: the one fix for the blocked reason (e.g. 去设置预算 / 改用对话模型). */
  readonly blockedAction?: { readonly label: string; readonly onClick: () => void } | null;
  /**
   * The line under the field. UI-AUDIT-3: absent by default — the approval-boundary explainer
   * moved to 设置 → 新目标默认 and the session cost is on the Goal's 运行 panel.
   */
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
        // UI-AUDIT-3: 权限 (a 设置 default now) and 工具 (only a link to the sidebar's 工具) left the composer.
        h(
          'span',
          { className: 'composer__right' },
          h(
            'button',
            { type: 'button', className: 'composer__chip composer__model-slot', onClick: props.onOpenModel, 'aria-expanded': props.modelOpen, 'aria-haspopup': 'dialog', title: '下一个目标使用的模型' },
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
      : h(
          'div',
          { className: 'composer__blocked', role: 'status', 'data-testid': 'composer-blocked' },
          h('span', null, props.blockedReason),
          props.blockedAction === undefined || props.blockedAction === null
            ? null
            : h('button', { type: 'button', className: 'btn btn--text composer__blocked-action', onClick: props.blockedAction.onClick }, props.blockedAction.label),
        ),
    (props.footHint ?? null) === null && (props.sessionCost ?? null) === null
      ? null
      : h(
          'div',
          { className: 'composer__foot' },
          h('span', null, props.footHint ?? ''),
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
  { value: 'ASK_PERMISSION', label: '询问权限', hint: '自动执行；高风险操作会先停下来等你批准' },
  { value: 'READ_ONLY', label: '只读', hint: '只能读取，任何写入都会被拒绝' },
  { value: 'WORKSPACE_OPERATIONS', label: '工作区操作', hint: '只能修改当前工作空间里的文件；高风险操作仍需你批准' },
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
        ? '所选权限随下一个目标一起保存，执行时由系统强制；已创建的目标不受影响。'
        : '这里只显示当前权限；权限由系统的批准规则决定。',
    ),
  );
}

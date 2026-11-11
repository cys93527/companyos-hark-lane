/**
 * STAGE 2 — the shell: LEFT navigation + history, CENTRE conversation, RIGHT runtime panel.
 *
 * Frozen visual direction: ChatGPT-desktop-like — light neutral surfaces, subtle borders,
 * minimal shadows, generous whitespace, low visual noise. No enterprise dashboard, no
 * permanent metric wall, no marketing graphics, no dense DevOps console by default.
 *
 * Settings stays BOTTOM LEFT. There is no Team Plan, Pro badge, monthly-task quota or
 * subscription-usage card anywhere in this shell.
 */
import { createElement as h, type JSX, type ReactNode } from 'react';
import { goalStateWord, isGoalLive } from './format.js';
import { goalModelOptions, MODALITY_WORDS, selectionFailureText, type ModelOptionRow } from './models.js';
import { budgetGateFor, formatMoney, type BudgetReadiness } from './budget.js';
import { TypedErrorLine } from './typed-error.js';

export type ShellView = 'home' | 'chat' | 'knowledge' | 'tools' | 'agents' | 'settings';

export interface ShellNavItem {
  readonly id: ShellView;
  readonly label: string;
}

/** Only surfaces with real canonical value behind them; nothing decorative. */
export const SHELL_NAV: readonly ShellNavItem[] = [
  { id: 'home', label: '首页' },
  { id: 'chat', label: '对话与任务' },
  { id: 'knowledge', label: '知识库' },
  { id: 'tools', label: '工具' },
  { id: 'agents', label: '智能体' },
];

export interface RecentGoalRow {
  readonly runId: string;
  readonly objective: string | null;
  readonly state: string;
  /** H12b: typed terminal outcome (absent on older payloads). */
  readonly terminalOutcome?: string | null;
  readonly createdAt?: string;
}

/** UI-AUDIT-12: the sidebar shows the newest Goals first, like the goal list (bounded). */
export const RECENT_LIMIT = 30;
export const sortRecentNewestFirst = (rows: readonly RecentGoalRow[]): readonly RecentGoalRow[] =>
  [...rows].sort((a, b) => {
    const at = a.createdAt ?? '';
    const bt = b.createdAt ?? '';
    if (at !== bt) return at < bt ? 1 : -1;
    return a.runId < b.runId ? 1 : -1;
  });

export interface SidebarViewProps {
  readonly view: ShellView;
  readonly recent: readonly RecentGoalRow[];
  readonly activeGoalRunId: string | null;
  readonly busy: boolean;
  readonly onNewGoal: () => void;
  readonly onNavigate: (view: ShellView) => void;
  readonly onOpenGoal: (runId: string) => void;
  /** UI-PAPER-INK: the brand line's version and the workspace path in the footer. */
  readonly appVersion?: string | null;
  readonly workspaceRoot?: string | null;
  /** Run ids of Goals known to wait on THIS user's approval (state word 待批准). */
  readonly approvalPendingRunIds?: ReadonlySet<string>;
}

export function SidebarView(props: SidebarViewProps): JSX.Element {
  const recent = sortRecentNewestFirst(props.recent).slice(0, RECENT_LIMIT);
  return h(
    'nav',
    { className: 'sidebar', 'data-testid': 'sidebar', 'aria-label': '侧边栏' },
    h(
      'div',
      { className: 'sidebar__brand' },
      h('span', { className: 'sidebar__logo' }, 'CompanyOS'),
      props.appVersion == null ? null : h('span', { className: 'sidebar__version' }, props.appVersion),
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'sidebar__new',
        onClick: props.onNewGoal,
        disabled: props.busy,
        'aria-keyshortcuts': 'Control+N',
        title: '新建目标（Ctrl+N）',
      },
      h('span', null, '新建目标'),
      h('kbd', null, 'Ctrl N'),
    ),
    h(
      'ul',
      { className: 'sidebar__nav', 'data-testid': 'shell-nav', 'aria-label': '导航' },
      SHELL_NAV.map((item) =>
        h(
          'li',
          { key: item.id },
          h(
            'button',
            {
              type: 'button',
              className: props.view === item.id ? 'sidebar__item sidebar__item--active' : 'sidebar__item',
              'aria-current': props.view === item.id ? 'page' : undefined,
              onClick: () => props.onNavigate(item.id),
            },
            item.label,
          ),
        ),
      ),
    ),
    h(
      'div',
      { className: 'sidebar__recent', 'data-testid': 'recent-goals', 'aria-label': '最近目标' },
      h('p', { className: 'sidebar__section label' }, '最近'),
      recent.length === 0
        ? h('p', { className: 'sidebar__empty muted' }, '还没有目标')
        : h(
            'ul',
            null,
            recent.map((goal) => {
              const active = props.activeGoalRunId === goal.runId;
              const live = isGoalLive(goal);
              const word = goalStateWord({ ...goal, approvalPending: props.approvalPendingRunIds?.has(goal.runId) === true });
              return h(
                'li',
                { key: goal.runId },
                h(
                  'button',
                  {
                    type: 'button',
                    className: active ? 'sidebar__goal sidebar__goal--active' : 'sidebar__goal',
                    'aria-current': active ? 'true' : undefined,
                    title: goal.objective ?? '(未命名目标)',
                    onClick: () => props.onOpenGoal(goal.runId),
                  },
                  h('span', { className: 'sidebar__goal-text' }, goal.objective ?? '(未命名目标)'),
                  h('span', { className: live ? 'sidebar__goal-state sidebar__goal-state--live' : 'sidebar__goal-state' }, word),
                ),
              );
            }),
          ),
    ),
    h(
      'div',
      { className: 'sidebar__bottom' },
      // UI-AUDIT-3: the workspace is shown once, on the composer chip (and in 设置); not repeated here.
      h(
        'button',
        {
          type: 'button',
          className: props.view === 'settings' ? 'sidebar__item sidebar__item--active' : 'sidebar__item',
          'aria-current': props.view === 'settings' ? 'page' : undefined,
          onClick: () => props.onNavigate('settings'),
        },
        '设置',
      ),
    ),
  );
}

/* --------------------------------------------------------------- top bar --- */

export interface TopBarViewProps {
  /** Breadcrumb trail, e.g. ['对话与任务', '修复库存…']; the last part is the current page. */
  readonly crumbs: readonly string[];
  /** Right side (elapsed time, the cancel control). */
  readonly actions?: ReactNode;
}

export function TopBarView(props: TopBarViewProps): JSX.Element {
  return h(
    'header',
    { className: 'topbar', 'data-testid': 'topbar' },
    h(
      'nav',
      { className: 'topbar__crumb', 'aria-label': '位置' },
      props.crumbs.map((crumb, index) =>
        index === props.crumbs.length - 1
          ? h('b', { key: `c${String(index)}`, 'aria-current': 'page', title: crumb }, crumb)
          : [h('span', { key: `c${String(index)}` }, crumb), h('i', { key: `s${String(index)}`, 'aria-hidden': true }, '/')],
      ),
    ),
    props.actions === undefined || props.actions === null ? null : h('div', { className: 'topbar__actions' }, props.actions),
  );
}

/* -------------------------------------------------------------- settings --- */

export interface SettingsViewProps {
  readonly workspaceRoot: string | null;
  readonly modelStatus:
    | { readonly kind: 'provider-not-configured' }
    | { readonly kind: 'no-models' }
    | { readonly kind: 'no-selection' }
    | { readonly kind: 'selected'; readonly modelKey: string; readonly displayName: string | null };
  readonly catalogueCount: number;
  readonly registeredCount: number;
  readonly appVersion: string;
  readonly databasePath: string | null;
  readonly schemaVersion: number | null;
  readonly allowedChannels: readonly string[];
  /** STAGE 3: the derived readiness projection (provider / model / executor / workspace). */
  readonly readiness?: readonly ReadinessRow[] | null;
  /** STAGE 3: the effective authority presentation (display-only) for the authority section. */
  readonly authority?: { readonly mode: string; readonly basis: string; readonly mutable: false } | null;
  readonly electronVersion?: string | null;
  readonly nodeVersion?: string | null;
  readonly onOpenModelSelector?: () => void;
  readonly onChangeWorkspace?: () => void;
  /** UI-AUDIT-2: model management (only the user's models choose Goals; the catalogue is added from here). */
  readonly models?: readonly ModelOptionRow[];
  readonly modelBusy?: boolean;
  readonly modelFailure?: { readonly code: string; readonly message: string } | null;
  readonly onChooseModel?: (option: ModelOptionRow) => void;
  readonly onAddModel?: (option: ModelOptionRow) => void;
  readonly onSetModelEnabled?: (option: ModelOptionRow, enabled: boolean) => void;
  /** UI-AUDIT-2: budget readiness (main's budget.readiness); null = unknown. */
  readonly budgetReadiness?: BudgetReadiness | null;
  /** UI-AUDIT-3: the 模型服务 section (service + key + budget), rendered by App with the bridge. */
  readonly modelService?: JSX.Element | null;
  /** UI-AUDIT-3: the default access policy for new Goals (moved out of the composer). */
  readonly defaultPolicy?: AccessPolicyValue;
  readonly onSetDefaultPolicy?: (policy: AccessPolicyValue) => void;
  /** UI-AUDIT-3: the optional file-delivery requirement for the next Goal (moved out of the composer). */
  readonly deliveryRequirement?: JSX.Element | null;
}

export interface ReadinessRow {
  readonly label: string;
  readonly state: 'READY' | 'NOT_CONFIGURED' | 'DEGRADED' | 'REQUIRED' | 'ERROR';
  readonly detail: string;
}

const READINESS_LABELS: Readonly<Record<ReadinessRow['state'], string>> = {
  READY: '就绪',
  NOT_CONFIGURED: '未配置',
  DEGRADED: '降级',
  REQUIRED: '需要选择',
  ERROR: '异常',
};

/** UI-AUDIT-3: the one place a budget or key is set is 设置 → 模型服务 (the Start-menu helper still works). */
const SETUP_STEPS = '在上面的「模型服务」里选择服务、粘贴 API Key 并填写每个目标最多花多少钱，保存后重启 CompanyOS。';

/** UI-AUDIT-2/3: the budget section's lines (pure; tested without a DOM). */
export const budgetSettingsLines = (readiness: BudgetReadiness | null | undefined): readonly string[] => {
  if (readiness === null || readiness === undefined) return ['预算状态读取中…'];
  if (readiness.state === 'NOT_APPROVED') return ['预算为 0：还没有批准每个目标的花费上限，所有付费模型调用都会被拒绝，目标无法执行。'];
  const cap = readiness.capCostMicros === null ? '--' : formatMoney(readiness.capCostMicros, readiness.currency);
  const lines = [
    `每个目标最多花费 ${cap}${readiness.source === 'operator' ? '（部署方设置）' : ''}`,
  ];
  if (readiness.state === 'RESTART_REQUIRED') lines.push('预算已更新，重启 CompanyOS 后生效。');
  for (const entry of readiness.covered) {
    const until = Number.isFinite(entry.validUntilMs) ? new Date(entry.validUntilMs).toLocaleDateString('zh-CN') : '--';
    lines.push(`适用模型 ${entry.modelId} · ${entry.valid ? `价格确认有效至 ${until}` : '价格确认已过期（在「模型服务」里重新保存即可）'}`);
  }
  if (readiness.covered.length === 0) lines.push('没有适用的模型：预算对任何模型都不生效。');
  return lines;
};

export type AccessPolicyValue = 'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS';

/**
 * Settings — UI-AUDIT-3 order, most-used first:
 *   模型服务 (service + API key + per-Goal budget, in-app) · 模型 (which models run Goals) ·
 *   新目标默认 (access policy, the approval explainer, the optional file-delivery requirement — moved
 *   out of the composer) · 工作区 · 高级与技术信息 (readiness, versions, paths, IPC) · 关于.
 * The key is entered in 模型服务 and goes one way to the main process; nothing here shows it.
 */
export function SettingsView(props: SettingsViewProps): JSX.Element {
  const providerConfigured = props.modelStatus.kind !== 'provider-not-configured';
  const models = props.models ?? [];
  const goalModels = goalModelOptions(models);
  const selectedKey = props.modelStatus.kind === 'selected' ? props.modelStatus.modelKey : null;
  const addable = models.filter((option) => !option.registered && option.configured !== true && option.goalUsable !== false);
  const disabled = models.filter((option) => option.registered && option.enabled === false && option.goalUsable !== false);
  const nonChat = models.filter((option) => option.goalUsable === false && option.unusableReason !== 'PROVIDER_NOT_BOUND');
  const busy = props.modelBusy === true;
  const budgetLines = budgetSettingsLines(props.budgetReadiness);
  const budgetMissing = props.budgetReadiness?.state === 'NOT_APPROVED';
  return h(
    'section',
    { className: 'card settings', 'data-testid': 'settings', 'aria-label': '设置' },
    h('h2', null, '设置'),

    h('h3', { id: 'settings-budget' }, '模型服务'),
    h('p', { className: 'muted' }, '执行目标要用到的模型服务、API Key 和每个目标的预算。'),
    props.modelService ?? null,
    h(
      'div',
      { 'data-testid': 'settings-budget' },
      h('ul', { className: budgetMissing ? 'settings-budget__lines model-onboarding__warn' : 'settings-budget__lines muted' }, budgetLines.map((line, index) => h('li', { key: `l${String(index)}` }, line))),
      props.modelService === undefined || props.modelService === null ? h('p', { className: 'muted' }, `设置或修改预算：${SETUP_STEPS}`) : null,
    ),

    h('h3', { id: 'settings-models' }, '模型'),
    !providerConfigured
      ? h('div', { 'data-testid': 'settings-models-empty' },
          h('p', { className: 'muted' }, '先在上面的「模型服务」里配置服务和 API Key，重启后这里会列出可用的模型。'))
      : h(
          'div',
          { 'data-testid': 'settings-models' },
          h('p', { className: 'muted' }, '执行目标只会使用下面这些模型。输入框右下角可以为下一个目标换模型。'),
          goalModels.length === 0
            ? h('p', { className: 'model-onboarding__warn' }, '还没有可以执行目标的对话模型。')
            : h(
                'ul',
                { className: 'settings-models__list', 'aria-label': '执行目标用的模型' },
                goalModels.map((option) => {
                  const gate = budgetGateFor(props.budgetReadiness ?? null, option);
                  const isDefault = option.modelKey !== null && option.modelKey === selectedKey;
                  return h(
                    'li',
                    { key: `${option.providerId}/${option.providerModelId}`, className: 'settings-models__row' },
                    h('span', { className: 'settings-models__name' }, option.displayName),
                    h(
                      'span',
                      { className: 'settings-models__meta muted' },
                      [option.configured === true ? '模型服务' : '已添加', gate === null ? null : gate.ok ? '预算已批准' : gate.short, isDefault ? '默认' : null]
                        .filter((part): part is string => part !== null)
                        .join(' · '),
                    ),
                    h(
                      'span',
                      { className: 'settings-models__actions' },
                      isDefault
                        ? null
                        : h('button', { type: 'button', className: 'btn btn--text', disabled: busy, onClick: () => props.onChooseModel?.(option) }, '设为默认'),
                      option.registered && option.configured !== true && option.modelKey !== null && !isDefault
                        ? h('button', { type: 'button', className: 'btn btn--text', disabled: busy, onClick: () => props.onSetModelEnabled?.(option, false) }, '停用')
                        : null,
                    ),
                  );
                }),
              ),
          disabled.length === 0
            ? null
            : h(
                'ul',
                { className: 'settings-models__list', 'aria-label': '已停用的模型' },
                disabled.map((option) =>
                  h('li', { key: `${option.providerId}/${option.providerModelId}`, className: 'settings-models__row' },
                    h('span', { className: 'settings-models__name muted' }, option.displayName),
                    h('span', { className: 'settings-models__meta muted' }, '已停用'),
                    h('span', { className: 'settings-models__actions' },
                      h('button', { type: 'button', className: 'btn btn--text', disabled: busy, onClick: () => props.onSetModelEnabled?.(option, true) }, '启用'))),
                ),
              ),
          addable.length === 0
            ? null
            : h(
                'details',
                { className: 'settings-models__add', 'data-testid': 'settings-models-add' },
                h('summary', null, `从模型服务添加对话模型（${String(addable.length)} 个可添加）`),
                h('p', { className: 'muted' }, '添加后可以在输入框右下角选择。注意：预算只对「模型服务」里填写的模型生效。'),
                h(
                  'ul',
                  { className: 'settings-models__list' },
                  addable.map((option) =>
                    h('li', { key: `${option.providerId}/${option.providerModelId}`, className: 'settings-models__row' },
                      h('span', { className: 'settings-models__name' }, option.displayName),
                      h('span', { className: 'settings-models__actions' },
                        h('button', { type: 'button', className: 'btn btn--text', disabled: busy, onClick: () => props.onAddModel?.(option) }, '添加'))),
                  ),
                ),
              ),
          nonChat.length === 0
            ? null
            : h(
                'details',
                { className: 'settings-models__nonchat' },
                h('summary', null, `不能执行目标的模型（${String(nonChat.length)} 个：图像、视频、向量、语音等）`),
                h('ul', { className: 'settings-models__list muted' }, nonChat.map((option) =>
                  h('li', { key: `${option.providerId}/${option.providerModelId}` }, `${option.displayName} · ${MODALITY_WORDS[option.modality ?? ''] ?? '非对话模型'}`))),
              ),
          props.modelFailure === null || props.modelFailure === undefined
            ? null
            : h(TypedErrorLine, { failure: props.modelFailure, text: selectionFailureText(props.modelFailure) }),
        ),

    // UI-AUDIT-3: moved out of the composer (rarely changed per message).
    h('h3', { id: 'settings-defaults' }, '新目标默认'),
    h(
      'div',
      { 'data-testid': 'settings-defaults' },
      h(
        'fieldset',
        { className: 'settings-policy', 'aria-label': '访问权限' },
        h('legend', { className: 'settings-field__label' }, '访问权限'),
        ACCESS_POLICY_CHOICES.map((choice) =>
          h(
            'label',
            { key: choice.value, className: 'settings-radio' },
            h('input', { type: 'radio', name: 'default-policy', checked: (props.defaultPolicy ?? 'ASK_PERMISSION') === choice.value, onChange: () => props.onSetDefaultPolicy?.(choice.value) }),
            h('span', null, choice.label),
            h('span', { className: 'muted' }, choice.hint),
          ),
        ),
        h('p', { className: 'muted' }, '随每个新目标一起保存并在执行时强制；已创建的目标不受影响。高风险操作总会先停下来，等你在目标页面批准或拒绝。'),
      ),
      props.deliveryRequirement ?? null,
    ),

    h('h3', null, '工作区'),
    h('dl', { className: 'kv' },
      h('dt', null, '当前工作空间'),
      h('dd', null, props.workspaceRoot ?? '未选择'),
      h('dt', null, '操作'),
      h('dd', null, h('button', { type: 'button', className: 'btn btn--quiet', onClick: props.onChangeWorkspace }, '更换工作空间')),
    ),

    h('h3', null, '关于'),
    h('dl', { className: 'kv' },
      h('dt', null, 'CompanyOS 版本'),
      h('dd', null, props.appVersion),
    ),
    // UI-AUDIT-3: developer/technical information lives here, collapsed.
    h(
      'details',
      { className: 'tech settings-advanced', 'data-testid': 'settings-advanced' },
      h('summary', null, '高级与技术信息'),
      h('h4', { className: 'label' }, '运行与诊断'),
      (props.readiness ?? null) === null
        ? h('p', { className: 'muted' }, '就绪状态读取中…')
        : h(
            'dl',
            { className: 'kv' },
            (props.readiness ?? []).map((row) =>
              h('div', { key: row.label, className: 'readiness-row' },
                h('dt', null, row.label),
                h('dd', null, `${READINESS_LABELS[row.state]}${row.detail === '' ? '' : ` · ${row.detail}`}`),
              ),
            ),
          ),
      h('h4', { className: 'label' }, '技术信息'),
      h('dl', { className: 'kv' },
        h('dt', null, 'Electron 版本'),
        h('dd', null, props.electronVersion ?? '--'),
        h('dt', null, 'Node 版本'),
        h('dd', null, props.nodeVersion ?? '--'),
        h('dt', null, '数据库'),
        h('dd', null, props.databasePath ?? '--'),
        h('dt', null, 'schema 版本'),
        h('dd', null, props.schemaVersion === null ? '--' : String(props.schemaVersion)),
        h('dt', null, '模型服务目录'),
        h('dd', null, `${String(props.catalogueCount)} 个模型 · 已添加 ${String(props.registeredCount)} 个`),
        h('dt', null, 'IPC 通道'),
        h('dd', null, props.allowedChannels.length === 0 ? '--' : props.allowedChannels.join(', ')),
      ),
    ),
  );
}

/** The three policies, same words as the composer used to show (composer.ACCESS_POLICY_OPTIONS). */
const ACCESS_POLICY_CHOICES: readonly { readonly value: AccessPolicyValue; readonly label: string; readonly hint: string }[] = [
  { value: 'ASK_PERMISSION', label: '询问权限（推荐）', hint: '自动执行；高风险操作会先停下来等你批准' },
  { value: 'WORKSPACE_OPERATIONS', label: '工作区操作', hint: '只能修改当前工作空间里的文件；高风险操作仍需你批准' },
  { value: 'READ_ONLY', label: '只读', hint: '只能读取，任何写入都会被拒绝' },
];

/* ----------------------------------------------------------------- shell --- */

export interface AppShellViewProps {
  readonly view: ShellView;
  readonly sidebar: SidebarViewProps;
  readonly center: JSX.Element;
  readonly composer: JSX.Element | null;
  /** UI-AUDIT-3: null = no run panel on this page (only 对话与任务 has one). */
  readonly runtime: JSX.Element | null;
  /** UI-PAPER-INK: the 44px bar above the centre (breadcrumb + goal actions). */
  readonly topbar?: JSX.Element | null;
  /** A banner every view shows above its content (e.g. the database failure). */
  readonly banner?: JSX.Element | null;
  readonly runtimeCollapsed?: boolean;
}

export function AppShellView(props: AppShellViewProps): JSX.Element {
  return h(
    'div',
    {
      className: props.runtime === null ? 'shell-v2 shell-v2--no-runtime' : props.runtimeCollapsed === true ? 'shell-v2 shell-v2--runtime-collapsed' : 'shell-v2',
      'data-testid': 'app-shell',
      'aria-label': 'CompanyOS',
    },
    h(SidebarView, props.sidebar),
    h(
      'main',
      { className: 'shell-v2__center' },
      props.topbar ?? null,
      h(
        'div',
        { className: 'shell-v2__scroll' },
        h('div', { className: 'shell-v2__content' }, props.banner ?? null, props.center),
      ),
      props.composer,
    ),
    props.runtime === null ? null : h('div', { className: 'shell-v2__right' }, props.runtime),
  );
}

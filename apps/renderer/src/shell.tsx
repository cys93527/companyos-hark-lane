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
import { authorityStatusLabel } from './composer.js';
import { goalStateWord, isGoalLive } from './format.js';

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
      h(
        'p',
        { className: 'sidebar__workspace' },
        h('span', { className: 'sidebar__workspace-label' }, '工作空间'),
        h('span', { className: 'sidebar__workspace-path mono', title: props.workspaceRoot ?? undefined }, props.workspaceRoot ?? '--'),
      ),
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

/**
 * STAGE 3 settings — five real sections only: 工作区 / 模型与提供商 / 权限与安全 /
 * 运行与诊断 / 关于. No subscription, team or quota advertising; no raw secret storage
 * (there is no safe client-side credential-write seam, so provisioning stays on the
 * trusted external configuration path — `SECURE_PROVIDER_ONBOARDING_PENDING`).
 */
export function SettingsView(props: SettingsViewProps): JSX.Element {
  const providerConfigured = props.modelStatus.kind !== 'provider-not-configured';
  const modelSelected = props.modelStatus.kind === 'selected';
  return h(
    'section',
    { className: 'card settings', 'data-testid': 'settings', 'aria-label': '设置' },
    h('h2', null, '设置'),

    h('h3', null, '工作区'),
    h('dl', { className: 'kv' },
      h('dt', null, '当前工作空间'),
      h('dd', null, props.workspaceRoot ?? '未选择'),
      h('dt', null, '操作'),
      h('dd', null, h('button', { type: 'button', onClick: props.onChangeWorkspace }, '更换工作空间')),
    ),

    h('h3', null, '模型与提供商'),
    h('dl', { className: 'kv' },
      h('dt', null, '提供商'),
      h('dd', null, providerConfigured ? '已配置' : '未配置'),
      h('dt', null, '鉴权状态'),
      h('dd', null, providerConfigured ? '已配置' : '未配置'),
      h('dt', null, '可用模型（provider 目录）'),
      h('dd', null, String(props.catalogueCount)),
      h('dt', null, '已注册模型'),
      h('dd', null, String(props.registeredCount)),
      h('dt', null, '公司模型策略'),
      h(
        'dd',
        null,
        modelSelected
          ? `${props.modelStatus.kind === 'selected' ? (props.modelStatus.displayName ?? props.modelStatus.modelKey) : ''}（公司策略 · 手动固定）`
          : '未选择',
      ),
      h('dt', null, '操作'),
      h(
        'dd',
        null,
        h('button', { type: 'button', onClick: props.onOpenModelSelector }, '选择模型'),
      ),
    ),
    h(
      'p',
      { className: 'muted' },
      // UI-AUDIT-13: the real provisioning path since H17a (trusted helper outside the renderer).
      '提供商凭证与预算不在界面中管理：请在开始菜单运行「CompanyOS 首次配置」（DPAPI 加密保存 Key 并设置每个目标的预算），完成后重新打开 CompanyOS。',
    ),

    h('h3', null, '权限与安全'),
    h('dl', { className: 'kv' },
      // AUDIT-R4: the run-state projection is a status, the access policy is chosen per Goal.
      h('dt', null, '当前目标状态'),
      h('dd', null, (props.authority ?? null) === null ? '--' : authorityStatusLabel(props.authority!)),
      h('dt', null, '访问策略'),
      h('dd', null, '在输入框的权限按钮中为下一个目标选择（询问权限 / 只读 / 工作区操作），随目标提交并由内核沙箱强制；已创建目标的策略不能在界面中修改。'),
      h('dt', null, '高风险操作'),
      h('dd', null, '仍需 canonical 批准（approval.respond），界面不代替引擎决定。'),
    ),

    h('h3', null, '运行与诊断'),
    (props.readiness ?? null) === null
      ? h('p', { className: 'muted' }, '就绪状态读取中…')
      : h(
          'dl',
          { className: 'kv' },
          (props.readiness ?? []).map((row) =>
            h('div', { key: row.label, className: 'readiness-row' },
              h('dt', null, row.label),
              h('dd', null, `${READINESS_LABELS[row.state]} · ${row.detail}`),
            ),
          ),
        ),

    h('h3', null, '关于'),
    h('dl', { className: 'kv' },
      h('dt', null, 'CompanyOS 版本'),
      h('dd', null, props.appVersion),
      h('dt', null, 'Electron 版本'),
      h('dd', null, props.electronVersion ?? '--'),
      h('dt', null, 'Node 版本'),
      h('dd', null, props.nodeVersion ?? '--'),
      h('dt', null, '数据库'),
      h('dd', null, props.databasePath ?? '--'),
      h('dt', null, 'schema 版本'),
      h('dd', null, props.schemaVersion === null ? '--' : String(props.schemaVersion)),
      h('dt', null, 'IPC 通道'),
      h('dd', null, props.allowedChannels.length === 0 ? '--' : props.allowedChannels.join(', ')),
    ),
  );
}

/* ----------------------------------------------------------------- shell --- */

export interface AppShellViewProps {
  readonly view: ShellView;
  readonly sidebar: SidebarViewProps;
  readonly center: JSX.Element;
  readonly composer: JSX.Element | null;
  readonly runtime: JSX.Element;
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
      className: props.runtimeCollapsed === true ? 'shell-v2 shell-v2--runtime-collapsed' : 'shell-v2',
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
    h('div', { className: 'shell-v2__right' }, props.runtime),
  );
}

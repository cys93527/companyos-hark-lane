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
import { createElement as h, type JSX } from 'react';

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
}

export interface SidebarViewProps {
  readonly view: ShellView;
  readonly recent: readonly RecentGoalRow[];
  readonly activeGoalRunId: string | null;
  readonly busy: boolean;
  readonly onNewGoal: () => void;
  readonly onNavigate: (view: ShellView) => void;
  readonly onOpenGoal: (runId: string) => void;
}

export function SidebarView(props: SidebarViewProps): JSX.Element {
  return h(
    'nav',
    { className: 'sidebar', 'aria-label': 'sidebar' },
    h(
      'div',
      { className: 'sidebar__brand' },
      h('span', { className: 'sidebar__logo' }, 'CompanyOS'),
    ),
    h(
      'button',
      { type: 'button', className: 'sidebar__new', onClick: props.onNewGoal, disabled: props.busy },
      '+ 新建对话 / 新建目标',
    ),
    h(
      'ul',
      { className: 'sidebar__nav', 'aria-label': 'shell-nav' },
      SHELL_NAV.map((item) =>
        h(
          'li',
          { key: item.id },
          h(
            'button',
            {
              type: 'button',
              className: props.view === item.id ? 'sidebar__item sidebar__item--active' : 'sidebar__item',
              onClick: () => props.onNavigate(item.id),
            },
            item.label,
          ),
        ),
      ),
    ),
    h(
      'div',
      { className: 'sidebar__recent', 'aria-label': 'recent-goals' },
      h('p', { className: 'sidebar__section' }, '最近'),
      props.recent.length === 0
        ? h('p', { className: 'sidebar__empty muted' }, '还没有目标')
        : h(
            'ul',
            null,
            props.recent.map((goal) =>
              h(
                'li',
                { key: goal.runId },
                h(
                  'button',
                  {
                    type: 'button',
                    className:
                      props.activeGoalRunId === goal.runId ? 'sidebar__goal sidebar__goal--active' : 'sidebar__goal',
                    onClick: () => props.onOpenGoal(goal.runId),
                  },
                  h('span', { className: 'sidebar__goal-text' }, goal.objective ?? '(未命名目标)'),
                  h('span', { className: 'sidebar__goal-state' }, goal.state),
                ),
              ),
            ),
          ),
    ),
    h(
      'div',
      { className: 'sidebar__bottom' },
      h(
        'button',
        {
          type: 'button',
          className: props.view === 'settings' ? 'sidebar__item sidebar__item--active' : 'sidebar__item',
          onClick: () => props.onNavigate('settings'),
        },
        '设置',
      ),
    ),
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
    { className: 'card settings', 'aria-label': 'settings' },
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
      h('dd', null, providerConfigured ? 'CONFIGURED' : 'NOT CONFIGURED'),
      h('dt', null, '可用模型（provider 目录）'),
      h('dd', null, String(props.catalogueCount)),
      h('dt', null, '已注册模型'),
      h('dd', null, String(props.registeredCount)),
      h('dt', null, '公司模型策略'),
      h(
        'dd',
        null,
        modelSelected
          ? `${props.modelStatus.kind === 'selected' ? (props.modelStatus.displayName ?? props.modelStatus.modelKey) : ''}（COMPANY 策略，MANUAL）`
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
      '提供商凭证不在界面中管理（SECURE_PROVIDER_ONBOARDING_PENDING）：没有安全的客户端写入缝隙前，配置保持为受信外部配置路径。',
    ),

    h('h3', null, '权限与安全'),
    h('dl', { className: 'kv' },
      h('dt', null, '当前权限呈现'),
      h(
        'dd',
        null,
        (props.authority ?? null) === null
          ? '--'
          : `${props.authority!.mode}（${props.authority!.basis}）`,
      ),
      h('dt', null, '权限可否在界面中切换'),
      h('dd', null, '不可切换：权限由 CompanyOS Authority / Approval 治理，界面只呈现当前有效权限。'),
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
      h('dd', null, props.databasePath ?? 'unavailable'),
      h('dt', null, 'schema 版本'),
      h('dd', null, props.schemaVersion === null ? '-' : String(props.schemaVersion)),
      h('dt', null, 'IPC 通道'),
      h('dd', null, props.allowedChannels.join(', ')),
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
}

export function AppShellView(props: AppShellViewProps): JSX.Element {
  return h(
    'div',
    { className: 'shell-v2', 'aria-label': 'app-shell' },
    h(SidebarView, props.sidebar),
    h(
      'main',
      { className: 'shell-v2__center' },
      h('div', { className: 'shell-v2__content' }, props.center),
      props.composer,
    ),
    h('div', { className: 'shell-v2__right' }, props.runtime),
  );
}

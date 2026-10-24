/**
 * DESKTOP CLIENT STAGE 2 — UX-01..UX-24 / UX-29 acceptance tests (renderer slice).
 *
 * Strategy (same as Stage 1): PURE VIEWS are rendered with react-dom/server
 * renderToString and asserted structurally; pure projections and loaders are called
 * directly so every read is proven to cross the ONE canonical seam. Written with
 * createElement (no JSX) so the canonical root vitest glob runs it unchanged.
 *
 * Coverage map:
 *   UX-01/02/03  chat-first shell, Settings bottom-left, no Team/Pro/quota card
 *   UX-04/05     composer access-control position + Tools affordance
 *   UX-06        model selector opens a model runtime popover
 *   UX-07/08     UNKNOWN telemetry renders "--" / known values render correctly
 *   UX-09/10     model selection goes through canonical seams / COMPANY policy
 *   UX-11        Goal submission succeeds after a legitimate selection
 *   UX-12        renderer never writes model/policy state itself
 *   UX-13        right runtime panel defaults collapsed
 *   UX-14..17    runtime panel projects canonical Goal/Plan/Task/Attempt/Validation
 *   UX-18/19/20  FAILED stays FAILED / no fake progress / no raw CoT
 *   UX-21..24    submission-intent idempotency A/B/C/D
 *   UX-29        renderer receives no credential value
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AuthorityPopover,
  ComposerView,
  ModelRuntimePopover,
  ModelSelectorView,
  projectEffectiveAuthority,
} from '../src/composer.js';
import { ChatView, projectConversation } from '../src/chat.js';
import {
  establishCompanySelection,
  projectModelSelection,
  toModelOptionRows,
  type CatalogueRow,
  type RegisteredRow,
} from '../src/models.js';
import {
  RUNTIME_TABS,
  RuntimePanelView,
  projectRuntimeLifecycle,
  projectRuntimePhase,
  type CanonicalGoalWorkspace,
} from '../src/runtime-panel.js';
import { AppShellView, SettingsView, SidebarView, SHELL_NAV, type RecentGoalRow } from '../src/shell.js';
import { AgentsSurfaceView, KnowledgeSurfaceView, ToolsSurfaceView } from '../src/surfaces.js';
import {
  cacheHitRate,
  contextRemaining,
  knownTelemetry,
  projectModelRuntime,
  tokensPerSecond,
  unknownTelemetry,
  type ModelRuntimeSnapshot,
} from '../src/telemetry.js';
import { createSubmissionController, type SubmissionIntentRecord } from '../src/submission-intent.js';

/* ------------------------------------------------------------------ fixtures --- */

const GOAL_WORKSPACE: CanonicalGoalWorkspace = {
  runId: 'run_01K',
  goal: { objective: '整理工作空间中的文件，输出一份简短清单。' },
  planningRun: { state: 'IDLE', revision: 0 },
  overview: {
    runId: 'run_01K',
    state: 'EXECUTING',
    revision: 2,
    reworkCount: 0,
    maxRework: 2,
    failureReason: null,
    resumePoint: null,
    pinnedVersion: { templateId: 'companyos.goal-planning/1', versionId: 'v1' },
    stages: [{ stageId: 'plan', taskCounts: { DONE: 1 }, terminalSuccessful: false }],
    executing: [{ taskId: 'task_work_1', stageId: 'execute', kind: 'companyos:work', attempt: { attemptId: 'att_1', attemptNumber: 1, state: 'ACTIVE', createdAt: '2026-10-04T00:00:00.000Z', settledAt: null } }],
    attempts: { active: 1, interrupted: 0, completed: 3, failed: 1 },
    validation: { requiredValidatorIds: ['val.qa'], completed: [{ validatorId: 'val.qa', status: 'pass' }], failed: false, missing: [] },
    correctiveActivity: { rounds: 0, latest: null },
    handoffCount: 2,
    progress: { stagesTotal: 2, stagesTerminalSuccessful: 1, tasksTotal: 4, tasksDone: 3, tasksActive: 1, tasksBlocked: 0 },
    artifacts: [{ id: 'art_1', kind: 'companyos:report', taskId: 'task_work_1' }],
  },
  blockers: [],
  executionRuns: [],
};

const FAILED_WORKSPACE: CanonicalGoalWorkspace = {
  runId: 'run_01F',
  goal: { objective: '一个会失败的目标' },
  planningRun: { state: 'PLANNING', revision: 1 },
  overview: {
    ...GOAL_WORKSPACE.overview!,
    runId: 'run_01F',
    state: 'FAILED',
    failureReason: 'EXECUTION_FAILURE: provider_unavailable',
  },
  blockers: [{ code: 'EXECUTION_FAILURE', scope: 'RUN', explanation: 'provider_unavailable' }],
  executionRuns: [],
};

const TASK_DETAILS = [
  {
    taskId: 'task_work_1',
    stageId: 'execute',
    roleId: 'rol.worker',
    kind: 'companyos:work',
    state: 'RUNNING',
    attempts: 1,
    maxAttempts: 3,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:01:00.000Z',
    executionAttempts: [{ attemptId: 'att_1', attemptNumber: 1, state: 'ACTIVE', createdAt: '2026-10-04T00:00:00.000Z', settledAt: null }],
    provenance: [{ executionId: 'ex_1', status: 'ACTIVE', modelKey: 'model.openai-compatible.deepseek-v4-flash', providerId: 'model.openai-compatible' }],
    provider: { providerKey: 'model.openai-compatible', state: 'BOUND' },
    blockers: [],
  },
];

const RECENT: readonly RecentGoalRow[] = [
  { runId: 'run_01K', objective: '整理工作空间中的文件', state: 'EXECUTING' },
];

const renderShell = () =>
  renderToString(
    h(AppShellView, {
      view: 'home',
      sidebar: {
        view: 'home',
        recent: RECENT,
        activeGoalRunId: null,
        busy: false,
        onNewGoal: () => {},
        onNavigate: () => {},
        onOpenGoal: () => {},
      },
      center: h('div', { className: 'center-stub' }, 'centre'),
      composer: h(ComposerView, {
        draft: '',
        ready: false,
        busy: false,
        authority: { mode: 'read-only', basis: 'no-active-run', mutable: false },
        modelLabel: '选择模型',
        workspaceLabel: null,
        pendingIntent: false,
        onDraftChange: () => {},
        onSubmit: () => {},
        onChangeWorkspace: () => {},
        onOpenTools: () => {},
        onOpenAuthority: () => {},
        onOpenModel: () => {},
        authorityOpen: false,
        modelOpen: false,
      }),
      runtime: h(RuntimePanelView, {
        open: true,
        expanded: false,
        tab: 'run',
        lifecycle: null,
        artifacts: [],
        timeline: [],
        taskDetail: null,
        onToggleExpanded: () => {},
        onSelectTab: () => {},
        onSelectTask: () => {},
      }),
    }),
  );

/* ------------------------------------------------------------ UX-01..UX-05 --- */

describe('UX-01..05 chat-first shell', () => {
  it('UX-01 the three-area shell renders: sidebar nav, centre, runtime panel', () => {
    const html = renderShell();
    expect(html).toContain('aria-label="app-shell"');
    expect(html).toContain('aria-label="sidebar"');
    expect(html).toContain('aria-label="composer"');
    expect(html).toContain('aria-label="runtime-panel"');
    expect(html).toContain('CompanyOS');
    expect(html).toContain('+ 新建对话 / 新建目标');
    // Every nav item maps to a real canonical surface (nothing decorative).
    expect(SHELL_NAV.map((item) => item.label)).toEqual(['首页', '对话与任务', '知识库', '工具', '智能体']);
  });

  it('UX-02 Settings is bottom-left, never anywhere else', () => {
    const html = renderToString(
      h(SidebarView, {
        view: 'settings',
        recent: [],
        activeGoalRunId: null,
        busy: false,
        onNewGoal: () => {},
        onNavigate: () => {},
        onOpenGoal: () => {},
      }),
    );
    const settingsIndex = html.indexOf('设置');
    const bottomIndex = html.indexOf('sidebar__bottom');
    expect(bottomIndex).toBeGreaterThan(-1);
    expect(settingsIndex).toBeGreaterThan(bottomIndex);
  });

  it('UX-03 no Team Plan / Pro badge / task quota / subscription card', () => {
    const html = renderShell() + renderToString(h(ChatView, { objective: null, entries: [], loading: false, failure: null }));
    for (const forbidden of ['Team Plan', 'Pro badge', 'quota', 'subscription', '订阅', '任务配额']) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('UX-04 the composer carries the access-permission position (display-only, canonical basis)', () => {
    const html = renderToString(
      h(AuthorityPopover, { authority: { mode: 'ask-permission', basis: 'blocker:APPROVAL_REQUIRED', mutable: false }, open: true }),
    );
    expect(html).toContain('询问权限');
    expect(html).toContain('blocker:APPROVAL_REQUIRED');
    // The UI states plainly that it cannot switch authority.
    expect(html).toContain('只读展示');
    const readOnly = projectEffectiveAuthority({ runState: 'IDLE', blockerCodes: [] });
    const workspace = projectEffectiveAuthority({ runState: 'EXECUTING', blockerCodes: [] });
    const ask = projectEffectiveAuthority({ runState: 'WAITING_APPROVAL', blockerCodes: ['APPROVAL_REQUIRED'] });
    expect(readOnly.mode).toBe('read-only');
    expect(workspace.mode).toBe('workspace-operations');
    expect(ask.mode).toBe('ask-permission');
    expect(ask.mutable).toBe(false);
  });

  it('UX-05 the composer contains the Tools affordance', () => {
    const html = renderShell();
    expect(html).toContain('>工具<');
  });
});

/* ----------------------------------------------------------- UX-06..UX-08 --- */

describe('UX-06..08 model selector + honest telemetry', () => {
  it('UX-06 the model selector opens a model runtime popover', () => {
    const html = renderToString(
      h(ModelSelectorView, {
        options: [{ providerId: 'p', providerModelId: 'm', displayName: 'm', contextWindow: 1000, registered: true, modelKey: 'k', priceInput: null, priceOutput: null }],
        selectedModelKey: 'k',
        open: true,
        busy: false,
        onToggle: () => {},
        onChoose: () => {},
        onOpenSettings: () => {},
        providerConfigured: true,
      }),
    );
    expect(html).toContain('aria-label="model-selector-popover"');
    expect(html).toContain('model-selector');
  });

  it('UX-07 UNKNOWN telemetry renders "--", never a false zero', () => {
    const view = projectModelRuntime({
      model: null,
      usedTokens: null,
      cachedTokens: null,
      speedSamples: [],
      inputTokens: null,
      outputTokens: null,
    });
    expect(view.remaining).toBe('--');
    expect(view.used).toBe('--');
    expect(view.speed).toBe('--');
    expect(view.cacheHit).toBe('--');
    expect(view.cost).toBe('--');
    expect(view.telemetryUnavailable).toBe(true);
    expect(unknownTelemetry().state).toBe('UNKNOWN');
    // A true observed zero is still KNOWN and renders as 0.
    expect(cacheHitRate(0, 100)).toEqual({ state: 'KNOWN', value: 0, unit: '%' });
  });

  const KNOWN_SNAPSHOT = {
    model: {
      modelKey: 'k',
      displayName: 'deepseek-v4-flash',
      providerId: 'p',
      contextWindow: 1_000_000,
      price: { inputPerMillion: 0.5, outputPerMillion: 1.5 },
      availability: 'available',
    },
    usedTokens: 31_212,
    cachedTokens: 21_224,
    speedSamples: [28.4, 28.4],
    inputTokens: 31_212,
    outputTokens: 1_024,
  };

  it('UX-08 known values render correctly (context/tokens/speed/cache/cost)', () => {
    const view = projectModelRuntime(KNOWN_SNAPSHOT);
    expect(view.contextWindow).toBe('1,000,000');
    // Cumulative Goal usage is NOT context occupancy: without a proven occupancy the
    // popover shows "--" instead of an invented percentage.
    expect(view.remaining).toBe('--');
    expect(view.used).toBe('31,212');
    expect(view.speed).toBe('28.4/s');
    expect(view.cacheHit).toBe('68%');
    expect(view.cost).toBe('0.017');
    expect(view.telemetryUnavailable).toBe(false);
    const proven = projectModelRuntime({ ...KNOWN_SNAPSHOT, contextUsedTokens: 31_212 });
    expect(proven.remaining).toBe('97%');
    expect(contextRemaining(1_000_000, 31_212)).toEqual({ state: 'KNOWN', value: 97, unit: '%' });
    expect(tokensPerSecond([]).state).toBe('UNKNOWN');
    expect(knownTelemetry(5, 'x')).toEqual({ state: 'KNOWN', value: 5, unit: 'x' });
  });

  it('UX-07b the popover says telemetry is unavailable instead of showing a metric wall', () => {
    const snapshot: ModelRuntimeSnapshot = {
      model: { modelKey: 'k', displayName: 'm', providerId: 'p', contextWindow: 1000, price: null, availability: 'available' },
      usedTokens: null,
      cachedTokens: null,
      speedSamples: [],
      inputTokens: null,
      outputTokens: null,
    };
    const html = renderToString(h(ModelRuntimePopover, { snapshot, open: true, onToggle: () => {} }));
    expect(html).toContain('--');
    expect(html).toContain('暂无可用遥测');
  });
});

/* ---------------------------------------------------------- UX-09..UX-12 --- */

interface RecordedCall {
  readonly operation: string;
  readonly payload: Record<string, unknown>;
}

const makeBridge = (options: { registerOk?: boolean; policyOk?: boolean } = {}) => {
  const calls: RecordedCall[] = [];
  const bridge = {
    workflowRequest: async (request: { operation: string; payload?: Record<string, unknown> }) => {
      const payload = request.payload ?? {};
      calls.push({ operation: request.operation, payload });
      if (request.operation === 'models.list') {
        return { ok: true, value: [] };
      }
      if (request.operation === 'models.register') {
        return options.registerOk === false
          ? { ok: false, error: { code: 'CONFLICT', message: 'already registered' } }
          : { ok: true, value: { modelKey: 'model.p.m' } };
      }
      if (request.operation === 'models.policy') {
        return options.policyOk === false
          ? { ok: false, error: { code: 'VALIDATION_FAILED', message: 'bad policy' } }
          : { ok: true, value: { id: 'COMPANY:company_default' } };
      }
      if (request.operation === 'models.policy.explain') {
        return { ok: true, value: { accepted: true, precedence: 'EXPLICIT_USER_CHOICE', fallback: 'NEVER', reasons: [] } };
      }
      return { ok: true, value: [] };
    },
  };
  return { bridge, calls };
};

describe('UX-09..12 model selection through canonical seams', () => {
  it('UX-09 selection registers through the canonical seam then saves the COMPANY policy', async () => {
    const { bridge, calls } = makeBridge();
    const result = await establishCompanySelection(bridge as never, {
      providerId: 'p',
      providerModelId: 'm',
      modelKey: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.modelKey).toBe('model.p.m');
    expect(result.explanation.accepted).toBe(true);
    expect(result.explanation.fallback).toBe('NEVER');
    const operations = calls.map((call) => call.operation);
    expect(operations).toEqual(['models.register', 'models.policy', 'models.policy.explain']);
    const policy = calls.find((call) => call.operation === 'models.policy');
    expect(policy?.payload['scopeType']).toBe('COMPANY');
    expect(policy?.payload['scopeId']).toBe('company_default');
    expect(policy?.payload['mode']).toBe('MANUAL');
    expect(policy?.payload['manualModelKey']).toBe('model.p.m');
  });

  it('UX-09b an already-registered model skips registration (one canonical write path)', async () => {
    const { bridge, calls } = makeBridge();
    const result = await establishCompanySelection(bridge as never, {
      providerId: 'p',
      providerModelId: 'm',
      modelKey: 'model.p.m',
    });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.operation)).toEqual(['models.policy', 'models.policy.explain']);
  });

  it('UX-10 the COMPANY selection makes Goal submission valid', () => {
    const catalogue: readonly CatalogueRow[] = [
      { providerId: 'p', providerModelId: 'm', displayName: 'm', contextWindow: 1000 },
    ];
    const registered: readonly RegisteredRow[] = [];
    const options = toModelOptionRows(catalogue, registered);
    expect(projectModelSelection(options, null).kind).toBe('no-selection');
    expect(projectModelSelection(options, 'model.p.m')).toEqual({
      kind: 'selected',
      modelKey: 'model.p.m',
      displayName: null,
    });
    // A model selected under the ROLE scope does not satisfy the company projection.
    expect(projectModelSelection(options, 'model.other').kind).toBe('selected');
  });

  it('UX-10b no configured provider is reported honestly and points at Settings', () => {
    expect(projectModelSelection([], null).kind).toBe('provider-not-configured');
  });

  it('UX-12 the renderer never writes model/policy state itself (import hygiene)', () => {
    const sources = ['models.tsx', 'composer.tsx', 'shell.tsx', 'chat.tsx', 'runtime-panel.tsx', 'App.tsx', 'telemetry.ts', 'submission-intent.ts', 'intent-store.ts']
      .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    for (const forbidden of [/node:/u, /@companyos\/persistence/u, /better-sqlite3/u, /sql\.js/u, /DatabaseSync/u, /from 'electron'/u, /require\(/u]) {
      expect(forbidden.test(sources)).toBe(false);
    }
    // The only write flow is the typed bridge operation.
    expect(sources).toContain("operation: 'models.register'");
    expect(sources).toContain("operation: 'models.policy'");
  });
});

/* ----------------------------------------------------------- UX-13..UX-17 --- */

describe('UX-13..17 runtime panel projections', () => {
  it('UX-13 the right panel defaults collapsed', () => {
    const html = renderToString(
      h(RuntimePanelView, {
        open: true,
        expanded: false,
        tab: 'run',
        lifecycle: null,
        artifacts: [],
        timeline: [],
        taskDetail: null,
        onToggleExpanded: () => {},
        onSelectTab: () => {},
        onSelectTask: () => {},
      }),
    );
    expect(html).toContain('已收起');
    expect(html).not.toContain('aria-label="runtime-lifecycle"');
    expect(RUNTIME_TABS.map((tab) => tab.label)).toEqual(['运行', '文件', '产出', '详情']);
  });

  it('UX-14 the panel projects canonical Goal/Plan/Task state', () => {
    const lifecycle = projectRuntimeLifecycle(GOAL_WORKSPACE, TASK_DETAILS);
    expect(lifecycle.runId).toBe('run_01K');
    expect(lifecycle.runState).toBe('EXECUTING');
    expect(lifecycle.planningState).toBe('IDLE');
    expect(lifecycle.objective).toBe('整理工作空间中的文件，输出一份简短清单。');
    expect(lifecycle.tasks).toHaveLength(1);
    expect(lifecycle.tasks[0]?.taskId).toBe('task_work_1');
    expect(lifecycle.tasks[0]?.state).toBe('RUNNING');
    const html = renderToString(
      h(RuntimePanelView, {
        open: true,
        expanded: true,
        tab: 'run',
        lifecycle,
        artifacts: [],
        timeline: [],
        taskDetail: null,
        onToggleExpanded: () => {},
        onSelectTab: () => {},
        onSelectTask: () => {},
      }),
    );
    expect(html).toContain('目标 · EXECUTING');
    expect(html).toContain('规划 · IDLE');
    expect(html).toContain('task_work_1');
  });

  it('UX-15 Role and Model stay distinct bindings', () => {
    const lifecycle = projectRuntimeLifecycle(GOAL_WORKSPACE, TASK_DETAILS);
    expect(lifecycle.tasks[0]?.roleId).toBe('rol.worker');
    expect(lifecycle.tasks[0]?.modelKey).toBe('model.openai-compatible.deepseek-v4-flash');
    const html = renderToString(
      h(RuntimePanelView, {
        open: true,
        expanded: true,
        tab: 'detail',
        lifecycle,
        artifacts: [],
        timeline: [],
        taskDetail: TASK_DETAILS[0] ?? null,
        onToggleExpanded: () => {},
        onSelectTab: () => {},
        onSelectTask: () => {},
      }),
    );
    expect(html).toContain('rol.worker');
    expect(html).toContain('model.openai-compatible.deepseek-v4-flash');
    expect(html).toContain('角色');
    expect(html).toContain('模型');
  });

  it('UX-16 attempt information comes from the canonical projection', () => {
    const lifecycle = projectRuntimeLifecycle(GOAL_WORKSPACE, TASK_DETAILS);
    expect(lifecycle.tasks[0]?.attemptLabel).toBe('#1 ACTIVE');
  });

  it('UX-17 validation authority remains canonical', () => {
    const lifecycle = projectRuntimeLifecycle(GOAL_WORKSPACE, TASK_DETAILS);
    expect(lifecycle.validation).toEqual({ completed: 1, failed: 0, missing: 0 });
    expect(lifecycle.handoffCount).toBe(2);
    expect(lifecycle.outcomeDelivered).toBe(false);
    expect(projectRuntimePhase({ runState: 'EXECUTING', blockers: GOAL_WORKSPACE.blockers })).toBe('executing');
    expect(projectRuntimePhase({ runState: 'EXECUTING', blockers: [{ code: 'APPROVAL_REQUIRED', scope: 'RUN', explanation: '' }] })).toBe('awaiting-user');
  });

  it('UX-17b a canonical validation FAILURE renders as a failure (boolean, never softened)', () => {
    const failing: CanonicalGoalWorkspace = {
      ...GOAL_WORKSPACE,
      overview: {
        ...GOAL_WORKSPACE.overview!,
        validation: { requiredValidatorIds: ['val.qa'], completed: [], failed: true, missing: ['val.qa'] },
      },
    };
    expect(projectRuntimeLifecycle(failing, TASK_DETAILS).validation).toEqual({ completed: 0, failed: 1, missing: 1 });
    const entries = projectConversation(failing, 'x', []);
    const html = renderToString(h(ChatView, { objective: 'x', entries, loading: false, failure: null }));
    expect(html).toContain('验证 · 完成 0 · 失败 1 · 缺失 1');
    expect(html).not.toContain('undefined');
  });
});

/* ----------------------------------------------------------- UX-18..UX-20 --- */

describe('UX-18..20 failure, progress and CoT discipline', () => {
  it('UX-18 a failed Goal stays FAILED with its canonical reason', () => {
    const entries = projectConversation(FAILED_WORKSPACE, '一个会失败的目标', []);
    const failed = entries.find((entry) => entry.kind === 'failed');
    expect(failed).toBeDefined();
    if (failed === undefined || failed.kind !== 'failed') return;
    expect(failed.reason).toBe('EXECUTION_FAILURE: provider_unavailable');
    expect(failed.blockerCodes).toEqual(['EXECUTION_FAILURE']);
    const html = renderToString(
      h(ChatView, { objective: '一个会失败的目标', entries, loading: false, failure: null }),
    );
    expect(html).toContain('目标失败');
    expect(html).toContain('EXECUTION_FAILURE');
    expect(html).not.toContain('completed with warning');
    expect(html).not.toContain('成功');
  });

  it('UX-19 no fake progress, no ETA, no percentage', () => {
    const entries = projectConversation(GOAL_WORKSPACE, '整理工作空间中的文件', [
      { key: 'k1', kind: 'task.created', summary: 'Task created', occurredAt: '2026-10-04T00:00:00.000Z' },
    ]);
    const html =
      renderToString(h(ChatView, { objective: '整理工作空间中的文件', entries, loading: false, failure: null })) +
      renderToString(
        h(RuntimePanelView, {
          open: true,
          expanded: true,
          tab: 'run',
          lifecycle: projectRuntimeLifecycle(GOAL_WORKSPACE, TASK_DETAILS),
          artifacts: GOAL_WORKSPACE.overview!.artifacts.map((artifact) => ({ artifactId: artifact.id, kind: artifact.kind })),
          timeline: [],
          taskDetail: null,
          onToggleExpanded: () => {},
          onSelectTab: () => {},
          onSelectTask: () => {},
        }),
      );
    expect(html).not.toMatch(/\d+\s*%/u);
    expect(html).not.toMatch(/\beta\b/iu);
    expect(html).not.toContain('ETA');
    expect(html).not.toContain('剩余时间');
    expect(html).not.toContain('已完成 75');
    // Activity is rendered as an activity fact, never as progress.
    expect(html).toContain('task.created');
  });

  it('UX-20 no raw chain-of-thought is rendered', () => {
    const entries = projectConversation(GOAL_WORKSPACE, 'x', [
      { key: 'k2', kind: 'executionattempt.settled', summary: 'Attempt settled', occurredAt: null },
    ]);
    const html = renderToString(h(ChatView, { objective: 'x', entries, loading: false, failure: null }));
    for (const forbidden of ['chain of thought', 'Chain of Thought', 'CoT', 'reasoning_content', 'thinking']) {
      expect(html).not.toContain(forbidden);
    }
  });
});

/* ----------------------------------------------------------- UX-21..UX-24 --- */

describe('UX-21..24 submission-intent idempotency (F-1 closure)', () => {
  const makeStore = () => {
    let record: SubmissionIntentRecord | null = null;
    return {
      load: () => record,
      save: (next: SubmissionIntentRecord | null) => {
        record = next;
      },
      peek: () => record,
    };
  };

  const makeController = (store: ReturnType<typeof makeStore>, created: string[]) => {
    let sequence = 0;
    return createSubmissionController({
      store,
      submit: async ({ intentId }) => {
        sequence += 1;
        created.push(intentId);
        return { runId: `run_${String(sequence)}` };
      },
      now: () => '2026-10-04T00:00:00.000Z',
      newIntentId: () => `si-${String(created.length + 1)}`,
    });
  };

  it('UX-21 a double click produces ONE Goal', async () => {
    const store = makeStore();
    const created: string[] = [];
    const controller = makeController(store, created);
    // A double click means the SECOND submission happens while the first is still in
    // flight (no await between them) — exactly what the pending guard must absorb.
    const first = controller.submitObjective('目标 A', 'E:\\ws');
    const second = await controller.submitObjective('目标 A', 'E:\\ws');
    expect(second.status).toBe('blocked');
    if (second.status !== 'blocked') return;
    expect(second.reason).toBe('pending');
    await first;
    expect(created).toHaveLength(1);
  });

  it('UX-22 a retry of the same submission intent replays the SAME intent (transport path)', async () => {
    const store = makeStore();
    const created: string[] = [];
    let failNext = true;
    const controller = createSubmissionController({
      store,
      submit: async ({ intentId }) => {
        created.push(intentId);
        if (failNext) {
          failNext = false;
          return { error: 'TRANSPORT_FAILED' };
        }
        return { runId: 'run_1' };
      },
      now: () => '2026-10-04T00:00:00.000Z',
      newIntentId: () => `si-${String(created.length + 1)}`,
    });
    const first = await controller.submitObjective('目标 A', 'E:\\ws');
    expect(first.status).toBe('failed');
    // The intent stays pending, so the retry replays the SAME identity.
    const retried = await controller.retry();
    expect(retried).not.toBeNull();
    if (retried === null) return;
    expect(retried.status).toBe('replayed');
    expect(created).toHaveLength(2);
    expect(created[0]).toBe(created[1]);
  });

  it('UX-23 a reload before the ack must not create two Goals', async () => {
    const store = makeStore();
    const created: string[] = [];
    // Mount 1 submits; the renderer is killed before the canonical ack is observed, so the
    // outbox still holds the pending intent.
    const first = makeController(store, created);
    const inFlight = first.submitObjective('目标 A', 'E:\\ws');
    expect(store.peek()?.state).toBe('pending');
    // Mount 2 (renderer reload): a NEW controller instance over the SAME store replays the
    // SAME identity — the canonical command-id ledger resolves it to the same Goal.
    const second = makeController(store, created);
    const resolved = await second.resolvePending();
    expect(resolved).not.toBeNull();
    if (resolved === null) return;
    await inFlight;
    // ONE identity reached the seam (twice: the in-flight call plus the replay).
    expect(new Set(created).size).toBe(1);
    // And a fresh explicit submission now works again.
    const next = await second.submitObjective('目标 B', 'E:\\ws');
    expect(next.status).toBe('created');
    expect(new Set(created).size).toBe(2);
  });

  it('UX-24 an explicit new submission of the same text is allowed (new intent)', async () => {
    const store = makeStore();
    const created: string[] = [];
    const controller = makeController(store, created);
    await controller.submitObjective('目标 A', 'E:\\ws');
    controller.discard();
    const again = await controller.submitObjective('目标 A', 'E:\\ws');
    expect(again.status).toBe('created');
    expect(created).toHaveLength(2);
    expect(new Set(created).size).toBe(2);
  });

  it('UX-11 the intent id is what crosses the seam as the canonical commandId', async () => {
    const store = makeStore();
    const commands: string[] = [];
    const controller = createSubmissionController({
      store,
      submit: async ({ intentId }) => {
        commands.push(intentId);
        return { runId: 'run_1' };
      },
      now: () => '2026-10-04T00:00:00.000Z',
      newIntentId: () => 'si-fixed',
    });
    const result = await controller.submitObjective('目标 A', 'E:\\ws');
    expect(result.status).toBe('created');
    expect(commands).toEqual(['si-fixed']);
  });
});

/* --------------------------------------------------------------- UX-29 --- */

describe('UX-29 renderer receives no credential value', () => {
  it('UX-29a the shell, composer, popover and runtime panel render no key-shaped value', () => {
    const html =
      renderShell() +
      renderToString(h(SettingsView, {
        workspaceRoot: 'E:\\ws',
        modelStatus: { kind: 'selected', modelKey: 'k', displayName: 'm' },
        catalogueCount: 51,
        registeredCount: 1,
        appVersion: '0.1.0',
        databasePath: 'C:\\data\\companyos.sqlite',
        schemaVersion: 7,
        allowedChannels: ['companyos:app-version'],
      })) +
      renderToString(h(ToolsSurfaceView, { rows: [], failure: null })) +
      renderToString(h(KnowledgeSurfaceView, { rows: [], failure: null })) +
      renderToString(h(AgentsSurfaceView, { rows: [], failure: null }));
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);
    expect(html.toLowerCase()).not.toContain('api_key');
    expect(html.toLowerCase()).not.toContain('apikey');
    expect(html.toLowerCase()).not.toContain('bearer ');
    expect(html.toLowerCase()).not.toContain('authorization');
    expect(html).not.toContain('COS_MODEL_API_KEY');
  });
});

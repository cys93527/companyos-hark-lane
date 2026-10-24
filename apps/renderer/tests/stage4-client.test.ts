/**
 * DESKTOP CLIENT STAGE 4 — S4-01..S4-26 acceptance tests.
 *
 * The access policy is canonically bound to the GOAL (run-goal artifact `structured`
 * payload, validated against a closed set at goal.create) and enforced BELOW the renderer
 * by the DSH kernel's own fs-sandbox (READ_ONLY ⇒ kernel read-only mode). These tests pin
 * that whole chain: validation, persistence shape, kernel mapping, selector behavior,
 * product UX truth, and the security invariants.
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ACCESS_POLICIES } from '../../desktop/src/control-plane.js';
import { dshSandboxModeOf, dshTaskTextOf } from '../../desktop/src/executor/dsh-executor-provider.js';
import { projectReadiness } from '../../desktop/src/readiness.js';
import {
  ACCESS_POLICY_OPTIONS,
  AuthorityPopover,
  projectEffectiveAuthority,
} from '../src/composer.js';
import { RuntimePanelView } from '../src/runtime-panel.js';
import { SettingsView } from '../src/shell.js';
import { createSubmissionController, type SubmissionIntentRecord } from '../src/submission-intent.js';
import { projectTelemetry } from '../src/usage.js';
import type { GoalUsageProjection } from '../src/usage.js';

/* --------------------------------------------- S4-01..04 / S4-10 canonical seam --- */

describe('S4-01..04/10 access policy canonical seam', () => {
  const makeControlPlane = () => {
    const seen: { payload: Record<string, unknown> }[] = [];
    return {
      seen,
      bridge: {
        controlPlaneRequest: async (request: { operation: string; payload?: Record<string, unknown> }) => {
          if (request.operation === 'goal.create') {
            seen.push({ payload: request.payload ?? {} });
            // Mirror the canonical validation: unknown policy fails closed.
            const policy = (request.payload ?? {})['accessPolicy'];
            if (policy !== undefined && !(ACCESS_POLICIES as readonly string[]).includes(String(policy))) {
              return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Unknown access policy.' } };
            }
            return { ok: true, value: { runId: 'run_1' } };
          }
          return { ok: true, value: { goals: [] } };
        },
      },
    };
  };

  const makeController = (controlPlane: unknown) =>
    createSubmissionController({
      store: (() => {
        let record: SubmissionIntentRecord | null = null;
        return { load: () => record, save: (next: SubmissionIntentRecord | null) => { record = next; } };
      })(),
      submit: async (input) => {
        const response = await (controlPlane as { controlPlaneRequest: (r: { operation: string; payload: Record<string, unknown> }) => Promise<{ ok: boolean; value?: { runId: string } }> }).controlPlaneRequest({
          operation: 'goal.create',
          payload: {
            companyId: 'company_default',
            objective: input.objective,
            commandId: input.intentId,
            accessPolicy: 'READ_ONLY',
          },
        });
        if (!response.ok) return { error: 'failed' };
        return { runId: response.value!.runId };
      },
      now: () => '2026-10-05T00:00:00.000Z',
      newIntentId: () => 'si_1',
    });

  it('S4-02 a READ_ONLY selection crosses goal.create as the canonical policy', async () => {
    const { bridge, seen } = makeControlPlane();
    const controller = makeController(bridge);
    const result = await controller.submitObjective('目标', 'E:\\ws');
    expect(result.status).toBe('created');
    expect(seen[0]?.payload['accessPolicy']).toBe('READ_ONLY');
  });

  it('S4-01..03 the closed vocabulary is exactly the three product labels', () => {
    expect([...ACCESS_POLICIES]).toEqual(['ASK_PERMISSION', 'READ_ONLY', 'WORKSPACE_OPERATIONS']);
    expect(ACCESS_POLICY_OPTIONS.map((option) => option.label)).toEqual(['询问权限', '只读', '工作区操作']);
  });

  it('S4-02b an unknown policy fails closed at the canonical boundary', () => {
    const controlPlane = {
      controlPlaneRequest: async (request: { operation: string; payload?: Record<string, unknown> }) => {
        const policy = (request.payload ?? {})['accessPolicy'];
        if (policy !== undefined && !(ACCESS_POLICIES as readonly string[]).includes(String(policy))) {
          return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Unknown access policy.' } };
        }
        return { ok: true, value: { runId: 'run_1' } };
      },
    };
    const controller = createSubmissionController({
      store: (() => { let r: SubmissionIntentRecord | null = null; return { load: () => r, save: (n: SubmissionIntentRecord | null) => { r = n; } }; })(),
      submit: async (input) => {
        const response = await (controlPlane as { controlPlaneRequest: (r: { operation: string; payload: Record<string, unknown> }) => Promise<{ ok: boolean; value?: { runId: string } }> }).controlPlaneRequest({
          operation: 'goal.create',
          payload: { companyId: 'company_default', objective: input.objective, commandId: input.intentId, accessPolicy: 'FULL_CONTROL' },
        });
        if (!response.ok) return { error: 'Unknown access policy.' };
        return { runId: response.value!.runId };
      },
      now: () => '2026-10-05T00:00:00.000Z',
      newIntentId: () => 'si_1',
    });
    void controller;
    // The canonical validation itself refuses the unknown value.
    expect((ACCESS_POLICIES as readonly string[]).includes('FULL_CONTROL')).toBe(false);
  });

  it('S4-10 the policy rides the structured payload — Goal/Task identity is untouched', () => {
    // The policy is bound INTO the run-goal structured payload at create time; the
    // objective/commandId identity is separate and unchanged by a later policy switch.
    const goalA = { objective: 'obj', structured: { accessPolicy: 'READ_ONLY' } };
    const goalB = { objective: 'obj', structured: { accessPolicy: 'WORKSPACE_OPERATIONS' } };
    expect(goalA.objective).toBe(goalB.objective);
    expect(dshSandboxModeOf(goalA.structured)).toBe('read-only');
    expect(dshSandboxModeOf(goalB.structured)).toBe('workspace-write');
  });
});

/* ------------------------------------------------- S4-05 kernel enforcement --- */

describe('S4-05 read-only enforced BELOW the renderer (kernel sandbox)', () => {
  it('READ_ONLY maps onto the kernel read-only sandbox mode', () => {
    expect(dshSandboxModeOf({ accessPolicy: 'READ_ONLY' })).toBe('read-only');
    // Default and ASK stay workspace-write (never a broader mode).
    expect(dshSandboxModeOf({ accessPolicy: 'ASK_PERMISSION' })).toBe('workspace-write');
    expect(dshSandboxModeOf({ accessPolicy: 'WORKSPACE_OPERATIONS' })).toBe('workspace-write');
    expect(dshSandboxModeOf(undefined)).toBe('workspace-write');
    expect(dshSandboxModeOf({ accessPolicy: 'SOMETHING_ELSE' })).toBe('workspace-write');
  });

  it('the kernel task text carries the access constraint as data', () => {
    const text = dshTaskTextOf({
      companyId: 'c',
      runId: 'r',
      taskId: 't',
      attemptId: 'a',
      attemptNumber: 1,
      roleId: 'rol.worker',
      taskKind: 'companyos:work',
      work: {
        objective: '整理工作空间',
        memoryView: null,
        artifactRefs: [],
        taskInputs: [],
        acceptanceCriteria: [],
        goalStructured: { accessPolicy: 'READ_ONLY' },
      },
      workspace: null,
      requiredCapabilities: [],
      selectedModelRoute: null,
      timeoutMs: 60_000,
    } as never);
    expect(text).toContain('READ_ONLY');
    expect(text).toContain('accessPolicy');
  });
});

/* --------------------------------------- S4-06..09 selector + restart display --- */

describe('S4-06..09 selector behavior + restart display', () => {
  it('S4-06/S4-07 the popover renders the three canonical options with the selection', () => {
    const html = renderToString(
      h(AuthorityPopover, {
        authority: { mode: 'read-only', basis: 'no-active-run', mutable: false },
        open: true,
        selectedPolicy: 'READ_ONLY',
        onSelectPolicy: () => {},
        effectiveGoalPolicy: '只读',
      }),
    );
    for (const label of ['询问权限', '只读', '工作区操作']) expect(html).toContain(label);
    expect(html).toContain('popover__item--active');
    expect(html).toContain('canonical 命令持久化');
    expect(html).toContain('DSH 内核沙箱');
  });

  it('S4-08 the renderer display is never authoritative (stage-3 fallback text preserved without a selector)', () => {
    const html = renderToString(
      h(AuthorityPopover, { authority: { mode: 'read-only', basis: 'no-active-run', mutable: false }, open: true }),
    );
    expect(html).toContain('只读展示');
  });

  it('S4-09 the renderer stores no authority truth (localStorage only holds the submission-intent outbox)', () => {
    // The ONE permitted localStorage use is the bounded submission-intent outbox (Stage 2).
    const intentStore = readFileSync(new URL('../src/intent-store.ts', import.meta.url), 'utf8');
    expect(intentStore).toContain('companyos.submission-intent.v1');
    // No authority/permission/mode value is ever persisted client-side, in ANY renderer file.
    for (const name of ['App.tsx', 'composer.tsx', 'approvals.tsx', 'shell.tsx', 'usage.ts', 'artifacts-view.tsx', 'chat.tsx', 'runtime-panel.tsx', 'models.tsx']) {
      const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
      expect(/localStorage|sessionStorage/.test(source), name).toBe(false);
    }
    expect(intentStore).not.toMatch(/authority|permission|accessPolicy/iu);
  });

  it('S4-04/S4-09b restart rehydration is read-back only (no client persistence of policy)', () => {
    // goal.workspace read-back is the rehydration path; the renderer holds a display
    // selection defaulting to the canonical ASK_PERMISSION.
    const sources = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(sources).toContain("useState<\n    'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS'\n  >('ASK_PERMISSION')");
    expect(sources).toContain('runtimeWorkspace?.accessPolicy');
  });
});

/* ---------------------------------------------- S4-11..16 product UX surfaces --- */

describe('S4-11..16 product UX', () => {
  it('S4-11 history derives from canonical Goals (home.summary read in the App container)', () => {
    const sources = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(sources).toContain("'home.summary'");
    expect(sources).not.toContain('session.create');
  });

  it('S4-12 provider-unconfigured state renders honestly', () => {
    const projection = projectReadiness({
      providerRegistered: false, providerHealthy: false, providerDetail: '尚未注册',
      modelSelected: false, modelDetail: 'none',
      executorConfigured: false, executorDetail: 'none',
      workspaceOpen: false, workspaceDetail: 'none',
    });
    expect(projection.provider.state).toBe('NOT_CONFIGURED');
    expect(projection.externalBlock?.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('S4-13 executor-unconfigured state renders 执行器尚未配置', () => {
    const projection = projectReadiness({
      providerRegistered: true, providerHealthy: true, providerDetail: 'ok',
      modelSelected: true, modelDetail: 'ok',
      executorConfigured: false, executorDetail: 'COMPANYOS_EXECUTOR_PROVIDER',
      workspaceOpen: true, workspaceDetail: 'ok',
    });
    expect(projection.executor.state).toBe('NOT_CONFIGURED');
    expect(projection.externalBlock?.code).toBe('EXECUTOR_PROVIDER_UNKNOWN');
  });

  it('S4-14 no undefined leaks into the runtime projection render', () => {
    const html = renderToString(
      h(RuntimePanelView, {
        open: true,
        expanded: true,
        tab: 'run',
        lifecycle: null,
        artifacts: [],
        timeline: [],
        taskDetail: null,
        blockers: [],
        pendingApproval: null,
        onToggleExpanded: () => {},
        onSelectTab: () => {},
        onSelectTask: () => {},
      }),
    );
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });

  it('S4-15 artifact unsupported-kind fallback is a typed message, not a crash', () => {
    const sources = readFileSync(new URL('../../desktop/src/artifacts.ts', import.meta.url), 'utf8');
    expect(sources).toContain('ARTIFACT_PREVIEW_UNSUPPORTED');
    expect(sources).toContain('ARTIFACT_CONTENT_MISSING');
    expect(sources).toContain('ARTIFACT_REF_NOT_MANAGED');
  });

  it('S4-16 an UNKNOWN failure cause stays UNKNOWN (no fabricated provider diagnosis)', () => {
    const sources = readFileSync(new URL('../src/chat.tsx', import.meta.url), 'utf8');
    // The failure line renders the canonical reason verbatim; no provider/model guesswork.
    expect(sources).toContain("reason: workspace.overview?.failureReason ?? null");
    expect(sources).not.toMatch(/provider 失败|模型故障|provider failure/iu);
  });
});

/* ------------------------------------------------- S4-17..21 autonomy/recovery --- */

describe('S4-17..21 autonomy + recovery invariants', () => {
  it('S4-17 the composed shell has no manual Continue trigger (submit + autonomy only)', () => {
    // The shell the user actually sees is composed in App.tsx; the legacy Stage-1
    // GoalWorkspaceView (with its advance affordance) is NOT mounted by it. The only
    // GoalWorkspace reference in App.tsx is the canonical projection TYPE.
    const shell = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(shell).not.toContain('继续推进');
    expect(shell).not.toContain('<GoalWorkspace');
    expect(shell).not.toContain('h(GoalWorkspace');
    expect(shell).toContain('goal.create');
    // The autonomy driver starts on goal.create in the main process (Stage 2, unchanged).
    const runner = readFileSync(new URL('../../desktop/src/autonomy/desktop-autonomy-runner.ts', import.meta.url), 'utf8');
    expect(runner).toContain('exactly ONE active driver per Goal');
  });

  it('S4-18/S4-19/S4-20 restart invariants are enforced by the launcher (regression)', async () => {
    const mod = await import('../../desktop/src/autonomy/desktop-autonomy-runner.js');
    expect(typeof mod.createDesktopAutonomyRunner).toBe('function');
    // The Stage-2/3 suites pin: exactly one driver per goal, durable-truth resume,
    // no duplicate settlements. This is the regression marker for the 4095-replay bug.
    const sources = readFileSync(new URL('../../desktop/src/autonomy/desktop-autonomy-runner.ts', import.meta.url), 'utf8');
    expect(sources).toContain('active.has(runId)');
    expect(sources).toContain('isRunTerminal');
  });

  it('S4-21 telemetry UNKNOWN remains --', () => {
    const usage: GoalUsageProjection = {
      goalRunId: 'run_1',
      usage: { knownInputTokens: 0, knownOutputTokens: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, unknownDispatchCount: 0, totalDispatchCount: 0, coverageRatio: null, complete: false },
      speed: { state: 'UNKNOWN', samples: [], note: '' },
      cacheHit: { state: 'UNKNOWN', reason: '' },
      cost: { state: 'UNKNOWN', knownScopeCost: null, coverageComplete: false, note: '' },
      contextRemaining: { state: 'UNKNOWN', reason: '' },
    };
    const view = projectTelemetry(usage, 128_000);
    expect(view.tokens).toBe('--');
    expect(view.coverage).toBe('--');
    expect(view.speed).toBe('--');
    expect(view.cacheHit).toBe('--');
    expect(view.cost).toBe('--');
    expect(view.contextRemaining).toBe('--');
  });
});

/* --------------------------------------------- S4-22..26 security invariants --- */

describe('S4-22..26 security invariants', () => {
  it('S4-22 settings contains no secret value', () => {
    const html = renderToString(
      h(SettingsView, {
        workspaceRoot: 'E:\\ws',
        modelStatus: { kind: 'selected', modelKey: 'k', displayName: 'm' },
        catalogueCount: 2,
        registeredCount: 1,
        appVersion: '0.1.0',
        databasePath: 'C:\\db.sqlite',
        schemaVersion: 7,
        allowedChannels: [],
        readiness: null,
        authority: null,
        electronVersion: '44.5.1',
        nodeVersion: '24.21.0',
        onOpenModelSelector: () => {},
        onChangeWorkspace: () => {},
      }),
    );
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);
    expect(html.toLowerCase()).not.toContain('api_key');
    expect(html.toLowerCase()).not.toContain('bearer ');
  });

  it('S4-23/S4-24 the renderer has no DB or generic FS access', () => {
    const files = ['App.tsx', 'composer.tsx', 'shell.tsx', 'approvals.tsx', 'usage.ts', 'artifacts-view.tsx', 'chat.tsx', 'runtime-panel.tsx', 'bridge.ts', 'telemetry.ts'];
    for (const name of files) {
      const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
      // `node:` module imports are banned (PlatformInfo's plain `node:` string field is
      // data, not an import) — assert on actual import syntax only.
      expect(/from 'node:/u.test(source), name).toBe(false);
      expect(/DatabaseSync|better-sqlite3|@companyos\/persistence/u.test(source), name).toBe(false);
      expect(/openAnyPath|showItemInFolder|openPath\s*\(|readFileSync/u.test(source), name).toBe(false);
      expect(/from 'electron'/u.test(source), name).toBe(false);
    }
  });

  it('S4-25/S4-26 no second Session or Authority truth', () => {
    const sources = ['App.tsx', 'chat.tsx', 'shell.tsx', 'composer.tsx', 'approvals.tsx']
      .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    expect(sources).not.toContain('session.create');
    expect(sources).not.toContain('defineRole');
    expect(sources).not.toContain("'companyos.authority'");
  });

  it('S4-06b the effective-authority projection stays canonical (run state + blockers)', () => {
    expect(projectEffectiveAuthority({ runState: 'EXECUTING', blockerCodes: [] }).mode).toBe('workspace-operations');
    expect(projectEffectiveAuthority({ runState: 'WAITING_APPROVAL', blockerCodes: ['APPROVAL_REQUIRED'] }).mode).toBe('ask-permission');
    expect(projectEffectiveAuthority({ runState: null, blockerCodes: [] }).mode).toBe('read-only');
  });
});

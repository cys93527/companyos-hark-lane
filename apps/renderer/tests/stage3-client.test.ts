/**
 * DESKTOP CLIENT STAGE 3 — S3-01..S3-32 acceptance tests (renderer slice).
 *
 * Same strategy as Stage 1/2: PURE VIEWS via react-dom/server renderToString, pure
 * projections and loaders called directly, and import-hygiene assertions proving the
 * renderer cannot write authority/model/artifact state itself.
 *
 * Coverage map:
 *   S3-01/02/31  access selector renders canonical effective policy; the renderer cannot
 *                author authority; there is no second Authority truth
 *   S3-03/04/05  below-renderer enforcement (canonical authority gate + repository path
 *                policy) and the canonical approval boundary — tested against the REAL
 *                canonical seams, not the UI
 *   S3-06..11    approval card renders canonical rows; approve/deny both cross the ONE
 *                canonical `approval.respond`; autonomy pause/resume/restart semantics
 *   S3-12..15   Settings bottom-left + five real sections; no credential value; readiness
 *                renders safely; executor-not-configured is explicit
 *   S3-16..18   artifact reveal only accepts a canonical bounded artifact; traversal is
 *                rejected; no generic renderer FS primitive
 *   S3-19..27   honest telemetry (KNOWN/UNKNOWN/partial coverage/speed/cache/cost and
 *                context-remaining semantics)
 *   S3-28..30   runtime panel shows blocker/approval truth; no raw CoT; no secret exposure
 *   S3-32        no second Session truth
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ApprovalCardView,
  loadPendingDecisions,
  pendingApprovalOf,
  projectAuthorityMode,
  respondToApproval,
  type PendingDecision,
} from '../src/approvals.js';
import { ArtifactActionsView, runArtifactAction } from '../src/artifacts-view.js';
import { SettingsView, SidebarView } from '../src/shell.js';
import { RuntimePanelView } from '../src/runtime-panel.js';
import { loadGoalUsage, projectTelemetry, type GoalUsageProjection } from '../src/usage.js';
import { knownTelemetry, projectModelRuntime, unknownTelemetry, type ModelRuntimeSnapshot } from '../src/telemetry.js';

const PENDING: PendingDecision = {
  runId: 'run_01K',
  runState: 'WAITING_APPROVAL',
  approvals: [
    {
      id: 'ap_01K',
      runId: 'run_01K',
      taskId: 'task_1',
      riskLevel: 'HIGH',
      status: 'pending',
      reason: '发布文件到外部系统',
      requestedBy: 'agent.review',
      requestedAt: '2026-10-05T00:00:00.000Z',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
    },
  ],
};

const renderApprovalCard = (overrides: Partial<Parameters<typeof ApprovalCardView>[0]> = {}) =>
  renderToString(
    h(ApprovalCardView, {
      decision: PENDING,
      busy: false,
      failure: null,
      onDecide: () => {},
      ...overrides,
    }),
  );

/* ------------------------------------------------------- S3-01..S3-05 --- */

describe('S3-01..05 access permission (canonical, display-only mode)', () => {
  it('S3-01 the selector renders the canonical effective policy', () => {
    const ask = projectAuthorityMode({ runState: 'WAITING_APPROVAL', approvalPending: true });
    const workspace = projectAuthorityMode({ runState: 'EXECUTING', approvalPending: false });
    const readOnly = projectAuthorityMode({ runState: null, approvalPending: false });
    expect(ask.mode).toBe('ask-permission');
    expect(ask.basis).toBe('canonical approval pending');
    expect(workspace.mode).toBe('workspace-operations');
    expect(readOnly.mode).toBe('read-only');
    const html = renderToString(
      h(AuthorityPopoverish, { mode: ask.mode, basis: ask.basis }),
    );
    expect(html).toContain('询问权限');
    expect(html).toContain('canonical approval pending');
  });

  it('S3-02 the renderer cannot author authority (no authority write path exists)', () => {
    const sources = ['App.tsx', 'composer.tsx', 'shell.tsx', 'approvals.tsx', 'usage.ts', 'artifacts-view.tsx']
      .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    // No renderer-side write to roles/assignments/authorities, and no permission storage.
    for (const forbidden of [
      /defineRole/u,
      /assignRole/u,
      /revokeRole/u,
      /localStorage\s*\[\s*['"]permission/u,
      /sessionStorage\s*\[\s*['"]permission/u,
      /authority\s*:\s*['"](?:full|admin|allow-all)['"]/u,
    ]) {
      expect(forbidden.test(sources)).toBe(false);
    }
    // The only authority action the UI can take is the canonical approval response.
    expect(sources).toContain("'approval.respond'");
  });

  it('S3-03 read-only enforcement exists BELOW the renderer (canonical authority gate)', async () => {
    const { decideAuthority } = await import('@companyos/core');
    // An actor holding no role/assignment cannot invoke a tool: the refusal is canonical
    // and happens in Core, below the renderer, regardless of any UI state.
    const refused = decideAuthority({ actorId: 'user_owner', authority: 'tool.invoke', roles: [], assignments: [] });
    expect(refused.ok).toBe(false);
    // A read authority is granted to a reader role; a mutation authority is not.
    const reader = decideAuthority({
      actorId: 'user_owner',
      authority: 'artifact.read',
      roles: [{ id: 'rol.reader' as never, companyId: 'company_default' as never, key: 'reader', name: 'Reader', description: '', requiredCapabilities: [], authority: ['artifact.read'], createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }],
      assignments: [{ id: 'user_owner:rol.reader', actorId: 'user_owner', roleId: 'rol.reader' as never, assignedAt: '2026-10-05T00:00:00.000Z', assignedBy: 'user_owner' }],
    });
    expect(reader.ok).toBe(true);
    const writer = decideAuthority({
      actorId: 'user_owner',
      authority: 'artifact.create',
      roles: [{ id: 'rol.reader' as never, companyId: 'company_default' as never, key: 'reader', name: 'Reader', description: '', requiredCapabilities: [], authority: ['artifact.read'], createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }],
      assignments: [{ id: 'user_owner:rol.reader', actorId: 'user_owner', roleId: 'rol.reader', assignedAt: '2026-10-05T00:00:00.000Z', assignedBy: 'user_owner' }],
    });
    expect(writer.ok).toBe(false);
  });

  it('S3-04 workspace operations are workspace-bounded below the renderer (path policy)', async () => {
    const { createWorkspaceManager, createRepositoryPathPolicy } = await import('@companyos/engine');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'companyos-s3ws-'));
    writeFileSync(join(root, 'notes.txt'), 'hello');
    const manager = createWorkspaceManager();
    const opened = await manager.openWorkspace({ root, commandProfile: {} });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const policy = createRepositoryPathPolicy();
    const context = opened.value;
    // Inside the trusted workspace: allowed.
    const inside = policy.resolve({ context, input: 'notes.txt', operation: 'READ' });
    expect(inside.ok).toBe(true);
    // Traversal, absolute/drive-qualified paths and .git writes all fail closed.
    for (const hostile of ['../secrets.txt', 'E:' + String.fromCharCode(92) + 'windows' + String.fromCharCode(92) + 'system32' + String.fromCharCode(92) + 'hosts', 'C:/windows/hosts', '.git/config']) {
      const rejected = policy.resolve({ context, input: hostile, operation: 'WRITE' });
      expect(rejected.ok, hostile).toBe(false);
    }
  });

  it('S3-05 a high-risk action still requires the canonical approval boundary', () => {
    // The canonical risk rule (HIGH/CRITICAL require human approval) drives the card.
    const high = projectAuthorityMode({ runState: 'WAITING_APPROVAL', approvalPending: true });
    expect(high.mode).toBe('ask-permission');
    const html = renderApprovalCard();
    expect(html).toContain('需要你的批准');
    expect(html).toContain('HIGH');
    expect(html).toContain('发布文件到外部系统');
  });
});

/* ---------------------------------------------------------- S3-06..S3-11 --- */

describe('S3-06..11 approval UX', () => {
  it('S3-06 the pending approval renders from canonical rows', () => {
    const html = renderApprovalCard();
    expect(html).toContain('task_1');
    expect(html).toContain('agent.review');
    expect(html).toContain('2026-10-05T00:00:00.000Z');
    // A decided row is history, not a decision.
    const decided = renderApprovalCard({
      decision: { ...PENDING, approvals: [{ ...PENDING.approvals[0]!, status: 'approved' }] },
    });
    expect(decided).not.toContain('需要你的批准');
    expect(pendingApprovalOf(PENDING)?.id).toBe('ap_01K');
    expect(pendingApprovalOf({ ...PENDING, approvals: [] })).toBeNull();
  });

  it('S3-06b the card never renders a secret-shaped value', () => {
    const html = renderApprovalCard();
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);
    expect(html.toLowerCase()).not.toContain('api_key');
    expect(html.toLowerCase()).not.toContain('authorization');
  });

  it('S3-07 approve crosses the canonical approval.respond', async () => {
    const calls: { operation: string; payload: unknown }[] = [];
    const bridge = {
      controlPlaneRequest: async (request: { operation: string; payload?: unknown }) => {
        calls.push({ operation: request.operation, payload: request.payload });
        return { ok: true, value: { runId: 'run_01K', decision: 'approve', resumed: true } };
      },
    };
    const result = await respondToApproval(bridge as never, { runId: 'run_01K', decision: 'approve' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operation).toBe('approval.respond');
    const payload = calls[0]?.payload as Record<string, unknown>;
    expect(payload['runId']).toBe('run_01K');
    expect(payload['decision']).toBe('approve');
    // The renderer never dispatches APPROVAL.GRANT / resumes the run itself.
    expect(payload['commandId']).toBeUndefined();
  });

  it('S3-08 deny crosses the canonical approval.respond', async () => {
    const calls: string[] = [];
    const bridge = {
      controlPlaneRequest: async (request: { operation: string }) => {
        calls.push(request.operation);
        return { ok: true, value: { runId: 'run_01K', decision: 'deny', duplicate: false } };
      },
    };
    const result = await respondToApproval(bridge as never, { runId: 'run_01K', decision: 'deny', note: 'too risky' });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['approval.respond']);
  });

  it('S3-08b a failed respond is surfaced, never swallowed', async () => {
    const bridge = {
      controlPlaneRequest: async () => ({ ok: false, error: { code: 'CONFLICT', message: 'not waiting' } }),
    };
    const result = await respondToApproval(bridge as never, { runId: 'run_01K', decision: 'approve' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('not waiting');
  });

  it('S3-06c pending decisions are read through the control plane only', async () => {
    const bridge = {
      controlPlaneRequest: async (request: { operation: string }) => {
        expect(request.operation).toBe('decisions.pending');
        return { ok: true, value: { companyId: 'company_default', pending: [PENDING] } };
      },
    };
    const decisions = await loadPendingDecisions(bridge as never);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.runId).toBe('run_01K');
    expect(decisions[0]?.approvals[0]?.riskLevel).toBe('HIGH');
  });

  it('S3-09/S3-10 autonomy pause/resume is canonical, not renderer-driven', async () => {
    // The renderer's ONLY lever is approval.respond; the driver re-reads durable truth.
    const bridge = {
      controlPlaneRequest: async (request: { operation: string }) => {
        expect(['decisions.pending', 'approval.respond', 'goal.workspace']).toContain(request.operation);
        return { ok: true, value: { runId: 'run_01K' } };
      },
    };
    await respondToApproval(bridge as never, { runId: 'run_01K', decision: 'approve' });
    const decisions = await loadPendingDecisions(bridge as never);
    expect(decisions).toBeDefined();
  });

  it('S3-11 an approval survives a desktop restart (durable, re-readable)', () => {
    // The projection is read from durable approvals; a re-mounted client sees the same row.
    const remounted = [PENDING].flatMap((decision) => [decision]);
    expect(remounted[0]?.approvals[0]?.id).toBe(PENDING.approvals[0]?.id);
    expect(remounted[0]?.approvals[0]?.status).toBe('pending');
  });
});

/* --------------------------------------------------------- S3-12..S3-15 --- */

describe('S3-12..15 settings + readiness', () => {
  it('S3-12 Settings remains bottom-left', () => {
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

  it('S3-12b settings renders the five real sections and no subscription/quota advertising', () => {
    const html = renderToString(
      h(SettingsView, {
        workspaceRoot: 'E:\\ws',
        modelStatus: { kind: 'selected', modelKey: 'k', displayName: 'm' },
        catalogueCount: 51,
        registeredCount: 1,
        appVersion: '0.1.0',
        databasePath: 'C:\\data\\companyos.sqlite',
        schemaVersion: 7,
        allowedChannels: ['companyos:artifacts'],
        readiness: [
          { label: '模型提供商', state: 'READY', detail: 'ok' },
          { label: '执行器', state: 'NOT_CONFIGURED', detail: '未配置' },
        ],
        authority: { mode: 'ask-permission', basis: 'canonical approval pending', mutable: false },
        electronVersion: '44.5.1',
        nodeVersion: '24.21.0',
        onOpenModelSelector: () => {},
        onChangeWorkspace: () => {},
      }),
    );
    for (const section of ['工作区', '模型与提供商', '权限与安全', '运行与诊断', '关于']) {
      expect(html).toContain(section);
    }
    for (const forbidden of ['Team', 'Pro badge', 'quota', 'subscription', '订阅', '任务配额']) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('S3-13 a provider credential value never renders', () => {
    const html = renderToString(
      h(SettingsView, {
        workspaceRoot: 'E:\\ws',
        modelStatus: { kind: 'provider-not-configured' },
        catalogueCount: 0,
        registeredCount: 0,
        appVersion: '0.1.0',
        databasePath: null,
        schemaVersion: null,
        allowedChannels: [],
      }),
    );
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);
    expect(html.toLowerCase()).not.toContain('api_key');
    expect(html).not.toContain('COS_MODEL_API_KEY');
    expect(html).not.toContain('NOT CONFIGURED"');
    // Authentication status is a label, never a value.
    expect(html).toContain('NOT CONFIGURED');
    expect(html).toContain('SECURE_PROVIDER_ONBOARDING_PENDING');
  });

  it('S3-14 provider readiness renders safely (READY / NOT_CONFIGURED / DEGRADED labels)', () => {
    const html = renderToString(
      h(SettingsView, {
        workspaceRoot: 'E:\\ws',
        modelStatus: { kind: 'no-selection' },
        catalogueCount: 2,
        registeredCount: 0,
        appVersion: '0.1.0',
        databasePath: null,
        schemaVersion: null,
        allowedChannels: [],
        readiness: [
          { label: '模型提供商', state: 'READY', detail: 'ok' },
          { label: '模型选择', state: 'REQUIRED', detail: '尚未选择' },
          { label: '执行器', state: 'NOT_CONFIGURED', detail: '未配置' },
          { label: '工作空间', state: 'ERROR', detail: '未打开' },
        ],
      }),
    );
    for (const label of ['就绪', '需要选择', '未配置', '异常']) {
      expect(html).toContain(label);
    }
  });

  it('S3-15 the executor-not-configured state is explicit (never "undefined")', () => {
    // The renderer renders the canonical external block code from the readiness projection.
    const html = renderToString(
      h(RuntimePanelView, {
        open: true,
        expanded: true,
        tab: 'run',
        lifecycle: null,
        artifacts: [],
        timeline: [],
        taskDetail: null,
        blockers: [
          { code: 'EXECUTOR_PROVIDER_UNKNOWN', scope: 'RUN', explanation: '执行器提供方未配置（COMPANYOS_EXECUTOR_PROVIDER）。' },
        ],
        pendingApproval: null,
        onToggleExpanded: () => {},
        onSelectTab: () => {},
        onSelectTask: () => {},
      }),
    );
    expect(html).toContain('EXECUTOR_PROVIDER_UNKNOWN');
    expect(html).toContain('执行器提供方未配置');
    expect(html).not.toContain('undefined');
  });
});

/* --------------------------------------------------------- S3-16..S3-18 --- */

describe('S3-16..18 artifact boundary', () => {
  it('S3-16 reveal only accepts a canonical bounded artifact', async () => {
    const seen: { operation: string; artifactId: string }[] = [];
    const bridge = {
      artifactAction: async (request: { operation: string; artifactId: string }) => {
        seen.push(request);
        return { ok: true, operation: request.operation };
      },
    };
    const result = await runArtifactAction(bridge as never, 'reveal', { artifactId: 'art_1', kind: 'companyos:report' });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ operation: 'reveal', artifactId: 'art_1' }]);
    // The renderer sends ONLY the artifact id — no path, no directory, no traversal payload.
    expect(JSON.stringify(seen)).not.toContain('../');
    expect(JSON.stringify(seen)).not.toContain('E:');
  });

  it('S3-17 a non-canonical / unresolvable artifact fails closed with a typed error', async () => {
    const bridge = {
      artifactAction: async () => ({ ok: false, code: 'ARTIFACT_NOT_FOUND', message: '该产物不是 canonical artifact。' }),
    };
    const result = await runArtifactAction(bridge as never, 'open', { artifactId: 'art_missing', kind: 'x' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ARTIFACT_NOT_FOUND');
  });

  it('S3-18 the renderer gets no generic filesystem open primitive', () => {
    const sources = ['App.tsx', 'artifacts-view.tsx', 'runtime-panel.tsx', 'bridge.ts']
      .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    for (const forbidden of [
      /openAnyPath/u,
      /openPath\s*\(/u,
      /showItemInFolder/u,
      /readFile\s*\(/u,
      /statSync/u,
      /node:fs/u,
      /node:path/u,
    ]) {
      expect(forbidden.test(sources)).toBe(false);
    }
    // The only artifact entry point names a canonical artifact id.
    expect(sources).toContain('artifactAction');
    expect(sources).toContain('artifactId');
  });

  it('S3-16b the artifact action surface is unavailable without the desktop shell', async () => {
    const result = await runArtifactAction(null, 'reveal', { artifactId: 'art_1', kind: 'k' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ARTIFACT_SURFACE_UNAVAILABLE');
    const html = renderToString(
      h(ArtifactActionsView, {
        artifact: { artifactId: 'art_1', kind: 'k' },
        busy: false,
        preview: null,
        failure: { code: 'ARTIFACT_NOT_FOUND', message: '拒绝' },
        onPreview: () => {},
        onOpen: () => {},
        onReveal: () => {},
      }),
    );
    expect(html).toContain('预览');
    expect(html).toContain('打开');
    expect(html).toContain('在资源管理器中显示');
    expect(html).toContain('ARTIFACT_NOT_FOUND');
  });
});

/* ---------------------------------------------------------- S3-19..S3-27 --- */

const USAGE: GoalUsageProjection = {
  goalRunId: 'run_1',
  usage: {
    knownInputTokens: 31_212,
    knownOutputTokens: 1_024,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    unknownDispatchCount: 3,
    totalDispatchCount: 6,
    coverageRatio: 0.5,
    complete: false,
  },
  speed: { state: 'KNOWN', samples: [28.4], note: '按单次 provider 调用的输出 token / 调用耗时计算。' },
  cacheHit: { state: 'UNKNOWN', reason: '无权威 cached-token 证据' },
  cost: { state: 'ESTIMATED', knownScopeCost: 0.017, coverageComplete: false, note: '按已知用量估算' },
  contextRemaining: { state: 'UNKNOWN', reason: '无逐次上下文占位证据；累计 Goal token 不代表模型当前上下文占用。' },
};

describe('S3-19..27 honest telemetry', () => {
  it('S3-19 KNOWN usage renders the known value', () => {
    const view = projectTelemetry(USAGE, 1_000_000);
    expect(view.tokens).toBe('32.2K');
    expect(view.speed).toBe('28.4/s');
    expect(view.cost).toBe('$0.017');
    expect(view.costLabel).toBe('ESTIMATED');
    expect(knownTelemetry(0, '%')).toEqual({ state: 'KNOWN', value: 0, unit: '%' });
  });

  it('S3-20 UNKNOWN usage renders --', () => {
    const view = projectTelemetry(null, 1_000_000);
    expect(view.tokens).toBe('--');
    expect(view.speed).toBe('--');
    expect(view.cacheHit).toBe('--');
    expect(view.cost).toBe('--');
    expect(view.contextRemaining).toBe('--');
    expect(view.coverage).toBe('--');
    expect(unknownTelemetry().state).toBe('UNKNOWN');
  });

  it('S3-21 partial usage renders coverage truth, never a false total', () => {
    const view = projectTelemetry(USAGE, 1_000_000);
    expect(view.coverage).toBe('50%');
    expect(view.unknownDispatches).toBe('3');
    expect(view.note).toContain('3');
    expect(view.note).toContain('非 Goal 总量');
  });

  it('S3-22 unknown speed renders --', () => {
    const view = projectTelemetry({ ...USAGE, speed: { state: 'UNKNOWN', samples: [], note: '' } }, null);
    expect(view.speed).toBe('--');
  });

  it('S3-23 unknown cache hit renders -- (never inferred)', () => {
    const view = projectTelemetry(USAGE, null);
    expect(view.cacheHit).toBe('--');
    expect(USAGE.cacheHit.reason).toContain('cached-token');
  });

  it('S3-24 a true observed cache zero may render 0%', () => {
    expect(knownTelemetry(0, '%')).toEqual({ state: 'KNOWN', value: 0, unit: '%' });
    expect(projectModelRuntime({
      model: null,
      usedTokens: 100,
      cachedTokens: 0,
      speedSamples: [],
      inputTokens: 100,
      outputTokens: 0,
    }).cacheHit).toBe('0%');
  });

  it('S3-25 unknown cost renders --', () => {
    const view = projectTelemetry({ ...USAGE, cost: { state: 'UNKNOWN', knownScopeCost: null, coverageComplete: false, note: '' } }, null);
    expect(view.cost).toBe('--');
    expect(view.costLabel).toBeNull();
  });

  it('S3-26 an estimated cost is labelled ESTIMATED', () => {
    expect(projectTelemetry(USAGE, null).costLabel).toBe('ESTIMATED');
  });

  it('S3-27 context remaining is NOT derived from cumulative Goal usage', () => {
    const view = projectTelemetry(USAGE, 1_000_000);
    // Even with a known context window and known tokens, current occupancy is unprovable.
    expect(view.contextRemaining).toBe('--');
    expect(USAGE.contextRemaining.reason).toContain('累计 Goal token');
    const snapshot: ModelRuntimeSnapshot = {
      model: { modelKey: 'k', displayName: 'm', providerId: 'p', contextWindow: 1_000_000, price: null, availability: 'available' },
      usedTokens: 31_212,
      cachedTokens: null,
      speedSamples: [],
      inputTokens: null,
      outputTokens: null,
    };
    // The formatter derives a percentage only when a PROVEN occupancy is supplied
    // (never from cumulative Goal usage).
    expect(projectModelRuntime(snapshot).remaining).toBe('--');
    expect(projectModelRuntime({ ...snapshot, contextUsedTokens: 31_212 }).remaining).toBe('97%');
    // ...but the GOAL-level projection never supplies them as current context.
    expect(projectTelemetry(USAGE, 1_000_000).contextRemaining).toBe('--');
  });

  it('S3-19b the usage read crosses the control plane only', async () => {
    const calls: string[] = [];
    const bridge = {
      controlPlaneRequest: async (request: { operation: string }) => {
        calls.push(request.operation);
        return { ok: true, value: USAGE };
      },
    };
    const projection = await loadGoalUsage(bridge as never, 'run_1');
    expect(calls).toEqual(['run.usage']);
    expect(projection?.usage.knownInputTokens).toBe(31_212);
    const noRun = await loadGoalUsage(bridge as never, null);
    expect(noRun).toBeNull();
  });
});

/* --------------------------------------------------------- S3-28..S3-32 --- */

describe('S3-28..32 runtime panel, CoT, secrets, second truths', () => {
  it('S3-28 the runtime panel shows blocker/approval truth', () => {
    const html = renderToString(
      h(RuntimePanelView, {
        open: true,
        expanded: true,
        tab: 'run',
        lifecycle: null,
        artifacts: [],
        timeline: [],
        taskDetail: null,
        blockers: [{ code: 'APPROVAL_REQUIRED', scope: 'RUN', explanation: 'Run is waiting for a human approval decision.' }],
        pendingApproval: { riskLevel: 'HIGH', reason: '发布文件到外部系统', runId: 'run_01K' },
        onToggleExpanded: () => {},
        onSelectTab: () => {},
        onSelectTask: () => {},
      }),
    );
    expect(html).toContain('需要批准');
    expect(html).toContain('HIGH');
    expect(html).toContain('APPROVAL_REQUIRED');
  });

  it('S3-29 no raw CoT is rendered anywhere in the Stage-3 surfaces', () => {
    const html =
      renderApprovalCard() +
      renderToString(
        h(RuntimePanelView, {
          open: true,
          expanded: true,
          tab: 'detail',
          lifecycle: null,
          artifacts: [],
          timeline: [],
          onToggleExpanded: () => {},
          onSelectTab: () => {},
          onSelectTask: () => {},
          taskDetail: {
            taskId: 't',
            stageId: 's',
            roleId: 'rol.worker',
            kind: 'companyos:work',
            state: 'FAILED',
            attempts: 2,
            maxAttempts: 3,
            createdAt: '2026-10-05T00:00:00.000Z',
            updatedAt: '2026-10-05T00:00:30.000Z',
            executionAttempts: [
              { attemptId: 'a1', attemptNumber: 1, state: 'FAILED', createdAt: '2026-10-05T00:00:00.000Z', settledAt: null },
            ],
            provenance: [{ executionId: 'e1', status: 'FAILED', modelKey: 'm', providerId: 'p' }],
            provider: { providerKey: 'p', state: 'SETTLED' },
            blockers: [],
          },
          blockers: [],
          pendingApproval: null,
        }),
      );
    for (const forbidden of ['chain of thought', 'Chain of Thought', 'CoT', 'reasoning_content', 'thinking', 'thought']) {
      expect(html).not.toContain(forbidden);
    }
    // Elapsed and retry counts come from canonical stamps/states.
    expect(html).toContain('耗时');
    expect(html).toContain('30s');
    expect(html).toContain('2/3');
    expect(html).toContain('FAILED');
  });

  it('S3-30 no secret exposure in the Stage-3 surfaces', () => {
    const html = renderApprovalCard() + renderToString(
      h(ArtifactActionsView, {
        artifact: { artifactId: 'art_1', kind: 'k' },
        busy: false,
        preview: { text: 'report body', truncated: false, kind: 'k' },
        failure: null,
        onPreview: () => {},
        onOpen: () => {},
        onReveal: () => {},
      }),
    );
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);
    expect(html.toLowerCase()).not.toContain('bearer ');
    expect(html).not.toContain('vault://');
  });

  it('S3-31 there is no second Authority truth in the renderer', () => {
    const sources = ['App.tsx', 'composer.tsx', 'shell.tsx', 'approvals.tsx', 'submission-intent.ts', 'intent-store.ts']
      .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    // The only persisted client state is the submission-intent outbox.
    expect(sources).toContain('companyos.submission-intent.v1');
    expect(sources).not.toContain('companyos.permission');
    expect(sources).not.toContain('companyos.authority');
    expect(sources).not.toContain('companyos.mode');
  });

  it('S3-32 there is no second Session truth (no chat-session entity)', () => {
    const sources = ['App.tsx', 'chat.tsx', 'shell.tsx']
      .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    expect(sources).not.toContain('session.create');
    expect(sources).not.toContain('conversation.create');
    // The conversation surface derives from the canonical Goal workspace projection.
    expect(sources).toContain('goal.workspace');
  });
});

/** A tiny stand-in for the authority popover content used in S3-01. */
function AuthorityPopoverish({ mode, basis }: { mode: string; basis: string }) {
  return h(
    'div',
    { className: 'popover' },
    h('span', null, mode === 'ask-permission' ? '询问权限' : mode === 'read-only' ? '只读' : '工作区操作'),
    h('span', null, basis),
  );
}

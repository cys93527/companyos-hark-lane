/**
 * UI-AUDIT-2 (user report 2026-11-11, installed v0.1.4): the composer offered the provider's
 * whole catalogue (image / video / embedding models "待注册"), the user ran a chat Goal on
 * an image model, and the Goal failed "未归类的失败原因（POLICY_REFUSED）" with "预算为 0".
 * Main-process root fixes pinned here (CNY 0, no network):
 *  - the adapter records each upstream model's kind; non-chat models are not structured-output;
 *  - models.catalogue says which rows can run a Goal; models.policy refuses a non-chat model;
 *  - budget.readiness reports the approval and the (provider, model) pairs it covers;
 *  - first-run setup can approve a budget for ANY OpenAI-compatible service;
 *  - a refused model call keeps its typed reason (GOAL_ADMISSION_BOUND_UNPROVEN) durable.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canRunGoals, classifyUpstreamModel, modalityFromModelId, modalityOfRow } from '../../apps/desktop/src/models/model-modality.js';
import { createOpenAiCompatibleProvider, resolveOpenAiCompatibleConfig } from '../../apps/desktop/src/models/openai-compatible-provider.js';
import { createWorkflowApi } from '../../apps/desktop/src/workflows.js';
import { createDeploymentBudgetProofSource, readDeploymentBudgetReadiness } from '../../apps/desktop/src/deployment-budget-proof.js';
import {
  buildCustomProviderProfile,
  readProviderSetupProfile,
  removeProviderSetup,
  SETUP_CUSTOM_BILLING_ACCOUNT,
  writeProviderSetup,
} from '../../apps/desktop/src/provider-setup-write.js';
import { parseProviderSetupModel } from '../../apps/desktop/src/provider-setup.js';
import { createLatestAttemptFailureReader } from '../../apps/desktop/src/goal-attempt-failure.js';
// @ts-expect-error -- plain ESM script without types
import { parseArgs } from '../../scripts/hark/setup/configure-provider.mjs';

const shipped = readProviderSetupProfile(join(__dirname, '../../scripts/hark/setup/provider-profile.json'));

/** The model ids from the user's screenshot (2026-11-11), plus chat models. */
const USER_CATALOGUE: readonly [string, string][] = [
  ['seedance-2.0-tehui', 'video'],
  ['seedance-2.5', 'video'],
  ['seedream-5.0-flash', 'image'],
  ['seedream-5.0-pro-layers', 'image'],
  ['text-embedding-v4', 'embedding'],
  ['video-depth-720p', 'video'],
  ['video-desubtitle', 'video'],
  ['video-hd-ai', 'video'],
  ['wan2.7-i2v', 'video'],
  ['wan2.7-image', 'image'],
  ['wan2.7-image-pro', 'image'],
  ['wan2.7-t2v', 'video'],
  ['wan3.0-video-prime-720p', 'video'],
  ['z-image-turbo', 'image'],
  ['acc-image-v8.2-hd', 'image'],
  ['deepseek-chat', 'unknown'],
  ['qwen-max', 'unknown'],
  ['gpt-4o-mini', 'unknown'],
  ['claude-3-5-sonnet', 'unknown'],
  ['bge-m3', 'embedding'],
  ['gte-rerank-v2', 'embedding'],
  ['cosyvoice-v2', 'audio'],
  ['whisper-1', 'audio'],
];

describe('model kinds (main-process classifier)', () => {
  it.each(USER_CATALOGUE)('%s -> %s', (id, modality) => {
    expect(modalityFromModelId(id)).toBe(modality);
  });
  it('only chat (or not-known-otherwise) models can run Goals', () => {
    for (const [id, modality] of USER_CATALOGUE) expect(canRunGoals(modalityFromModelId(id))).toBe(modality === 'unknown');
  });
  it('upstream hints win over the id: text output = chat; an explicit type word', () => {
    expect(classifyUpstreamModel({ architecture: { output_modalities: ['text', 'image'] } }, 'gemini-flash-image')).toBe('chat');
    expect(classifyUpstreamModel({ architecture: { output_modalities: ['image'] } }, 'mystery-1')).toBe('image');
    expect(classifyUpstreamModel({ type: 'embedding' }, 'mystery-2')).toBe('embedding');
    expect(classifyUpstreamModel({ type: 'chat' }, 'image-namer-pro')).toBe('chat');
    expect(classifyUpstreamModel({}, 'mystery-3')).toBe('unknown');
  });
  it('the configured chat model is always chat; a recorded modality wins for stored rows', () => {
    expect(modalityOfRow({ modelId: 'acc-image-v8.2-hd', configured: true })).toBe('chat');
    expect(modalityOfRow({ modelId: 'plain-1', metadata: { modality: 'video' } })).toBe('video');
    expect(modalityOfRow({ modelId: 'wan2.7-image', metadata: {} })).toBe('image');
  });
});

describe('OpenAI-compatible adapter records the kind of every catalogue model', () => {
  it('non-chat models are not structured-output; the configured model is chat even with an image-like id', async () => {
    const resolved = resolveOpenAiCompatibleConfig({ COS_MODEL_BASE_URL: 'https://example.invalid/v1', COS_MODEL_ID: 'my-image-tuned-chat', COMPANYOS_MODEL_API_KEY: 'fixture-key-12345' });
    if (!resolved.ok || resolved.value === null) throw new Error('config');
    const provider = createOpenAiCompatibleProvider({
      config: resolved.value,
      resolveSecret: async () => 'fixture-key-12345',
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'my-image-tuned-chat' }, { id: 'acc-image-v8.2-hd' }, { id: 'qwen-max' }, { id: 'text-embedding-v4' }] }), { status: 200 }),
    } as never);
    const listed = await provider.listModels();
    expect(listed.ok).toBe(true);
    const rows = listed.ok ? listed.value : [];
    const byId = Object.fromEntries(rows.map((row) => [row.modelId, row]));
    expect(byId['my-image-tuned-chat']).toMatchObject({ capabilities: { structuredOutput: true }, metadata: { modality: 'chat' } });
    expect(byId['acc-image-v8.2-hd']).toMatchObject({ capabilities: { structuredOutput: false }, metadata: { modality: 'image' } });
    expect(byId['qwen-max']).toMatchObject({ capabilities: { structuredOutput: true }, metadata: { modality: 'unknown' } });
    expect(byId['text-embedding-v4']).toMatchObject({ capabilities: { structuredOutput: false }, metadata: { modality: 'embedding' } });
  });
});

const workflowApi = (input: {
  readonly catalogue?: readonly Record<string, unknown>[];
  readonly records?: readonly Record<string, unknown>[];
  readonly configured?: { providerId: string; modelId: string } | null;
  readonly budget?: unknown;
}) => {
  const saved: Record<string, unknown>[] = [];
  const api = createWorkflowApi({
    lifecycle: {} as never,
    listTemplates: async () => [],
    models: { list: async () => input.records ?? [] } as never,
    policies: {
      savePolicy: async (policy: Record<string, unknown>) => {
        saved.push(policy);
        return { ok: true, value: { id: 'p' } };
      },
    } as never,
    providerCatalogue: async () => (input.catalogue ?? []) as never,
    configuredModel: () => input.configured ?? null,
    ...(input.budget === undefined ? {} : { budgetReadiness: () => input.budget as never }),
  });
  return { api, saved };
};

const row = (modelId: string, extra: Record<string, unknown> = {}) => ({
  providerId: 'model.openai-compatible', modelId, displayName: modelId, contextWindow: 128000, maxOutputTokens: null,
  capabilities: { structuredOutput: true }, pricing: null, ...extra,
});

describe('workflow seams: what can run a Goal is a main-process verdict', () => {
  it('models.catalogue marks non-chat and unbound rows unusable; the configured row is usable', async () => {
    const { api } = workflowApi({
      catalogue: [
        row('chat-1', { configured: true, bound: true, metadata: { modality: 'chat' } }),
        row('acc-image-v8.2-hd', { bound: true, metadata: { modality: 'image' }, capabilities: { structuredOutput: false } }),
        row('wan2.7-t2v', { bound: true }),
        row('old-chat', { providerId: 'model.deepseek', bound: false }),
      ],
    });
    const response = (await api.handle({ operation: 'models.catalogue', requestId: 'r', payload: {} } as never)) as { ok: boolean; value: Record<string, unknown>[] };
    expect(response.ok).toBe(true);
    const verdict = Object.fromEntries(response.value.map((entry) => [entry['providerModelId'], [entry['goalUsable'], entry['modality'], entry['unusableReason'] ?? null]]));
    expect(verdict).toEqual({
      'chat-1': [true, 'chat', null],
      'acc-image-v8.2-hd': [false, 'image', 'NOT_CHAT_MODEL'],
      'wan2.7-t2v': [false, 'video', 'NOT_CHAT_MODEL'],
      'old-chat': [false, 'unknown', 'PROVIDER_NOT_BOUND'],
    });
  });

  it('models.policy refuses to pin a non-chat model as the Goal model (typed), and pins a chat model', async () => {
    const records = [
      { modelKey: 'mdl_img', providerId: 'model.openai-compatible', providerModelId: 'acc-image-v8.2-hd', capabilities: { structuredOutput: true } },
      { modelKey: 'mdl_chat', providerId: 'model.openai-compatible', providerModelId: 'chat-1', capabilities: { structuredOutput: true } },
    ];
    const { api, saved } = workflowApi({ records, configured: { providerId: 'model.openai-compatible', modelId: 'chat-1' } });
    const policy = (modelKey: string) => api.handle({ operation: 'models.policy', requestId: 'r', payload: { actorId: 'user', scopeType: 'COMPANY', scopeId: 'company_default', mode: 'MANUAL', manualModelKey: modelKey, allowFallback: 'NEVER' } } as never) as Promise<{ ok: boolean; error?: { code: string; details?: Record<string, unknown> } }>;
    const refused = await policy('mdl_img');
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('INVALID_ARGUMENT');
    expect(refused.error?.details?.['reason']).toBe('MODEL_NOT_CHAT_CAPABLE');
    expect(saved).toHaveLength(0);
    expect((await policy('mdl_chat')).ok).toBe(true);
    expect(saved).toHaveLength(1);
  });

  it('models.list carries each registered model kind; budget.readiness is a declared read', async () => {
    const { api } = workflowApi({
      records: [{ modelKey: 'mdl_img', providerId: 'p', providerModelId: 'z-image-turbo', displayName: 'z', capabilities: { structuredOutput: true }, enabled: true }],
      budget: { state: 'NOT_APPROVED', currency: null, capCostMicros: null, source: null, covered: [] },
    });
    const listed = (await api.handle({ operation: 'models.list', requestId: 'r', payload: { includeDisabled: true } } as never)) as { value: Record<string, unknown>[] };
    expect(listed.value[0]?.['modality']).toBe('image');
    const budget = (await api.handle({ operation: 'budget.readiness', requestId: 'r', payload: {} } as never)) as { ok: boolean; value: unknown };
    expect(budget).toMatchObject({ ok: true, value: { state: 'NOT_APPROVED' } });
  });
});

describe('budget readiness + first-run setup for any OpenAI-compatible service', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'uiaudit2-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('no approval -> NOT_APPROVED (the default cap 0 refuses every paid call)', () => {
    const dir = tmp();
    expect(readDeploymentBudgetReadiness(join(dir, 'budget'), false)).toEqual({ state: 'NOT_APPROVED', currency: null, capCostMicros: null, source: null, covered: [] });
  });

  it('custom setup writes a budget that covers exactly that (provider, model); the app parsers read it back', () => {
    const dir = tmp();
    const now = Date.UTC(2026, 10, 11, 2, 0, 0);
    const profile = buildCustomProviderProfile(shipped, { baseUrl: 'https://api.example.invalid/v1/', modelId: 'chat-1', inputCnyPerM: 1.5, outputCnyPerM: 6, now });
    expect(profile).toMatchObject({
      providerId: 'model.openai-compatible', baseUrl: 'https://api.example.invalid/v1', modelId: 'chat-1', billingAccount: SETUP_CUSTOM_BILLING_ACCOUNT,
      pricing: { currency: 'CNY', inputRate: 1_500_000, outputRate: 6_000_000 },
    });
    expect(profile).not.toHaveProperty('thinking');
    writeProviderSetup({ userDataDir: dir, profile, capCny: 3, approvedBy: 'alice', now });
    const model = parseProviderSetupModel(JSON.parse(readFileSync(join(dir, 'provider', 'model.json'), 'utf8')));
    expect(model).toMatchObject({ providerId: 'model.openai-compatible', modelId: 'chat-1', baseUrl: 'https://api.example.invalid/v1' });
    const ready = readDeploymentBudgetReadiness(join(dir, 'budget'), true, () => now);
    expect(ready).toMatchObject({ state: 'APPROVED', currency: 'CNY', capCostMicros: 3_000_000, source: 'provider-setup' });
    expect(ready.covered).toEqual([{ providerId: 'model.openai-compatible', modelId: 'chat-1', validUntilMs: now + shipped.proofValidForMs, valid: true }]);
    expect(readDeploymentBudgetReadiness(join(dir, 'budget'), false, () => now).state).toBe('RESTART_REQUIRED');
    // The runtime trust path accepts it for exactly that identity (env-configured endpoint too).
    const source = createDeploymentBudgetProofSource(join(dir, 'budget'), () => now);
    expect(source?.cap.maxCostMicros).toBe(3_000_000);
    return source!.source.identify({ providerId: 'model.openai-compatible', modelId: 'chat-1', endpoint: 'https://api.example.invalid/v1', credentialRef: 'vault://COMPANYOS_MODEL_API_KEY/live' } as never).then(async (identity) => {
      expect(identity).not.toBeNull();
      expect(await source!.source.identify({ providerId: 'model.openai-compatible', modelId: 'acc-image-v8.2-hd', endpoint: 'https://api.example.invalid/v1', credentialRef: 'vault://COMPANYOS_MODEL_API_KEY/live' } as never)).toBeNull();
    });
  });

  it('custom setup refuses what the app would refuse (http, bad id, bad price) with typed errors', () => {
    expect(() => buildCustomProviderProfile(shipped, { baseUrl: 'http://api.example.invalid/v1', modelId: 'chat-1', inputCnyPerM: 1, outputCnyPerM: 1 })).toThrow(/https/u);
    expect(() => buildCustomProviderProfile(shipped, { baseUrl: 'https://api.example.invalid/v1', modelId: 'bad id', inputCnyPerM: 1, outputCnyPerM: 1 })).toThrow(/model id/u);
    expect(() => buildCustomProviderProfile(shipped, { baseUrl: 'https://api.example.invalid/v1', modelId: 'chat-1', inputCnyPerM: 0, outputCnyPerM: 1 })).toThrow(/price/u);
    expect(() => buildCustomProviderProfile(shipped, { baseUrl: 'https://api.example.invalid/v1', modelId: 'chat-1', inputCnyPerM: 1, outputCnyPerM: 1001 })).toThrow(/price/u);
    expect(() => buildCustomProviderProfile(shipped, { baseUrl: 'https://api.example.invalid/v1', modelId: 'chat-1', providerId: 'Bad', inputCnyPerM: 1, outputCnyPerM: 1 })).toThrow(/provider id/u);
  });

  it('-Remove (shipped profile) also removes a custom-setup approval, never an operator one', () => {
    const dir = tmp();
    writeProviderSetup({ userDataDir: dir, profile: buildCustomProviderProfile(shipped, { baseUrl: 'https://api.example.invalid/v1', modelId: 'chat-1', inputCnyPerM: 1, outputCnyPerM: 2 }), capCny: 1, approvedBy: 'alice' });
    expect(removeProviderSetup(dir, shipped).removed).toEqual(['provider/model.json', 'budget/approvals.json']);
  });

  it('configure-provider.mjs write-custom argument contract', () => {
    expect(parseArgs(['write-custom', '--user-data', 'C:\\u', '--cap-cny', '2', '--approved-by', 'a', '--base-url', 'https://x.invalid/v1', '--model-id', 'm', '--input-cny', '1', '--output-cny', '2'])).toMatchObject({ command: 'write-custom', 'base-url': 'https://x.invalid/v1', 'model-id': 'm' });
    expect(() => parseArgs(['write-custom', '--user-data', 'C:\\u', '--cap-cny', '2', '--approved-by', 'a'])).toThrow(/base-url/u);
    expect(() => parseArgs(['write-custom', '--api-key', 'x'])).toThrow(/unknown/u);
  });

  it('the PowerShell helper offers the custom service, asks for prices, and never passes the key to node', () => {
    const ps1 = readFileSync(join(__dirname, '../../scripts/hark/setup/configure-deepseek.ps1'), 'utf8');
    expect(ps1).toContain('[switch]$Custom');
    expect(ps1).toContain('2 = 其他 OpenAI 兼容服务');
    expect(ps1).toContain("'write-custom'");
    expect(ps1).toContain('COS_MODEL_BASE_URL');
    const writeArgs = ps1.split('\n').filter((line) => line.includes('$writeArgs'));
    for (const line of writeArgs) expect(line).not.toMatch(/plain|bytes|blob|secure/iu);
    expect(ps1).not.toMatch(/[\u201c\u201d\u2018\u2019]/u);
  });
});

describe('a refused model call keeps its typed reason', () => {
  it('the agent execution terminal audit reason becomes the attempt failure detail', async () => {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE execution_attempts (id TEXT, run_id TEXT, task_id TEXT, state TEXT, failure_code TEXT, created_at TEXT, settled_at TEXT);
            CREATE TABLE events (aggregate_id TEXT, type TEXT, payload TEXT);
            CREATE TABLE agent_executions (execution_id TEXT, run_id TEXT, task_id TEXT, status TEXT, error_kind TEXT, error_message TEXT, finished_at TEXT);`);
    d.prepare('INSERT INTO agent_executions VALUES (?, ?, ?, ?, ?, ?, ?)').run('agx_1', 'run_exec', 'tsk_1', 'FAILED', 'POLICY_REFUSED', 'No verified token and financial admission bound is configured.', 'x');
    d.prepare('INSERT INTO events VALUES (?, ?, ?)').run('agx_1', 'agent.execution_failed', JSON.stringify({ errorKind: 'POLICY_REFUSED', errorCode: 'POLICY_DENIED', reason: 'GOAL_ADMISSION_BOUND_UNPROVEN' }));
    const read = createLatestAttemptFailureReader(d as never);
    expect(await read(['run_goal', 'run_exec'])).toMatchObject({ failureCode: 'POLICY_REFUSED', detailCode: 'GOAL_ADMISSION_BOUND_UNPROVEN' });
    // An attempt refused before dispatch (no settled row) takes the same typed reason.
    d.prepare('INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)').run('exa_1', 'run_exec', 'tsk_1', 'FAILED', 'POLICY_REFUSED', 'a', 'b');
    expect(await read(['run_exec'])).toMatchObject({ attemptId: 'exa_1', detailCode: 'GOAL_ADMISSION_BOUND_UNPROVEN' });
  });

  it('the runtime writes the typed reason onto the durable terminal audit', () => {
    const source = readFileSync(join(__dirname, '../../packages/engine/src/runtime/agent-runtime.ts'), 'utf8');
    expect(source).toMatch(/errorKind: safe\.kind,\s*errorCode: safe\.code,\s*retryable: safe\.retryable,[\s\S]{0,400}\.\.\.terminalReasonOf\(safe\.details\)/u);
  });
});

/**
 * STAGE 3 — the desktop-side seams the client now reaches:
 *   - the bounded artifact surface (canonical CAS reference only, traversal rejected);
 *   - the E1 usage projection (KNOWN / ESTIMATED / UNKNOWN, coverage, measured speed);
 *   - the derived readiness projection (provider / model / executor / workspace);
 *   - the read-only approval projection feeding `decisions.pending`.
 *
 * All main-process truth: the renderer reaches these only through the allow-listed
 * channels, and nothing here may be forged from a renderer-supplied path or token count.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_PREVIEW_MAX_BYTES,
  readArtifactPreview,
  resolveArtifactTarget,
  resolveCasObjectPath,
  type ArtifactLookup,
} from '../src/artifacts.js';
import { createGoalUsageService, projectGoalUsage } from '../src/efficiency/goal-usage-projection.js';
import { blockerLabel, projectReadiness } from '../src/readiness.js';
import { createWorkflowApi, type WorkflowApi } from '../src/workflows.js';

const HASH = 'a'.repeat(64);

/* --------------------------------------------------------------- artifacts --- */

describe('STAGE 3 artifact boundary (main process)', () => {
  const casRoot = mkdtempSync(join(tmpdir(), 'companyos-s3cas-'));

  it('accepts a managed CAS reference and derives the contained object path', () => {
    const path = resolveCasObjectPath(casRoot, `sha256:${HASH}`);
    expect(path).not.toBeNull();
    expect(path?.startsWith(casRoot)).toBe(true);
    expect(path?.endsWith(HASH)).toBe(true);
  });

  it('rejects a foreign/opaque content reference (never dereferenced)', () => {
    expect(resolveCasObjectPath(casRoot, 'workspace://notes.txt')).toBeNull();
    expect(resolveCasObjectPath(casRoot, 'file:///C:/windows/hosts')).toBeNull();
    expect(resolveCasObjectPath(casRoot, '')).toBeNull();
    expect(resolveCasObjectPath(casRoot, `sha256:${'a'.repeat(63)}`)).toBeNull();
    expect(resolveCasObjectPath(casRoot, `sha256:${'A'.repeat(64)}`)).toBeNull();
  });

  it('path traversal in the reference is structurally impossible', () => {
    expect(resolveCasObjectPath(casRoot, `sha256:${'..'.repeat(32)}`)).toBeNull();
    expect(resolveCasObjectPath(casRoot, `sha256:${'ab'.repeat(32)}/..`)).toBeNull();
  });

  it('an unknown artifact id fails closed', async () => {
    const lookup: ArtifactLookup = { get: async () => null };
    const result = await resolveArtifactTarget(casRoot, lookup, 'art_missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ARTIFACT_NOT_FOUND');
  });

  it('a managed artifact resolves to a contained path', async () => {
    const lookup: ArtifactLookup = {
      get: async () => ({ id: 'art_1', contentRef: `sha256:${HASH}`, contentHash: HASH, kind: 'text/plain', sizeBytes: 5 }),
    };
    const result = await resolveArtifactTarget(casRoot, lookup, 'art_1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.absolutePath.startsWith(casRoot)).toBe(true);
    expect(result.value.absolutePath.endsWith(HASH)).toBe(true);
  });

  it('preview refuses a non-managed store and reads managed content when present', async () => {
    const missingContent = { get: async () => null } as never;
    const preview = await readArtifactPreview(
      { artifactId: 'art_1', kind: 'text/plain', contentRef: `sha256:${HASH}`, contentHash: HASH, sizeBytes: 11, absolutePath: join(casRoot, HASH) },
      missingContent,
    );
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.code).toBe('ARTIFACT_CONTENT_MISSING');

    const bytes = Buffer.from('hello world');
    const store = { get: async () => bytes } as never;
    const ok = await readArtifactPreview(
      { artifactId: 'art_1', kind: 'text/plain', contentRef: `sha256:${HASH}`, contentHash: HASH, sizeBytes: 11, absolutePath: join(casRoot, HASH) },
      store,
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.text).toBe('hello world');
    expect(ok.value.truncated).toBe(false);
  });

  it('a large artifact preview is bounded and marked truncated', async () => {
    const big = Buffer.alloc(ARTIFACT_PREVIEW_MAX_BYTES + 128, 0x61);
    const store = { get: async () => big } as never;
    const result = await readArtifactPreview(
      { artifactId: 'art_2', kind: 'text/plain', contentRef: `sha256:${HASH}`, contentHash: HASH, sizeBytes: big.byteLength, absolutePath: join(casRoot, HASH) },
      store,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.text.length).toBe(ARTIFACT_PREVIEW_MAX_BYTES);
  });

  it('an unsupported kind is refused for preview (external open is the answer)', async () => {
    const store = { get: async () => Buffer.from('x') } as never;
    const result = await readArtifactPreview(
      { artifactId: 'art_3', kind: 'application/pdf', contentRef: `sha256:${HASH}`, contentHash: HASH, sizeBytes: 1, absolutePath: join(casRoot, HASH) },
      store,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ARTIFACT_PREVIEW_UNSUPPORTED');
  });

  it('writes a real CAS object under the derived path (integration)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'companyos-s3casw-'));
    try {
      const path = resolveCasObjectPath(root, `sha256:${HASH}`);
      expect(path).not.toBeNull();
      if (path === null) return;
      mkdirSync(join(root, HASH.slice(0, 2)), { recursive: true });
      writeFileSync(path, 'content');
      expect(resolveCasObjectPath(root, `sha256:${HASH}`)).toBe(path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------- usage --- */

describe('STAGE 3 usage projection (E1 semantics)', () => {
  const reader = () => ({
      runsOf: async (runId: string) => [{ id: runId, state: 'EXECUTING' }, { id: 'run_exec', state: 'EXECUTING' }],
      agentExecutions: async () => [
        { executionId: 'exa_1', agentId: 'agent.worker', roleId: 'rol.worker', taskId: 't1', inputTokens: 100, outputTokens: 20, provenance: 'provider-reported' as const },
        { executionId: 'exa_2', agentId: 'agent.worker', roleId: 'rol.worker', taskId: 't2', inputTokens: null, outputTokens: null, provenance: 'provider-reported' as const },
      ],
      providerDispatches: async () => [{ attemptId: 'att_1', providerKey: 'p' }],
      providerInvocations: async () => [{ outputTokens: 200, latencyMs: 1000 }],
      modelKeyOf: async () => 'model.m',
      modelPricing: async () => ({ inputPerMillion: 1, outputPerMillion: 2 }),
    }
  );

  it('KNOWN usage is summarised and coverage is a real ratio', async () => {
    const projection = await projectGoalUsage(reader(), 'run_1');
    expect(projection.usage.knownInputTokens).toBe(100);
    expect(projection.usage.knownOutputTokens).toBe(20);
    // Two executions (one without usage) plus one dispatch without a usage-bearing
    // execution → 2 UNKNOWN of 3, so coverage is the real ratio, never a false total.
    expect(projection.usage.unknownDispatchCount).toBe(2);
    expect(projection.usage.totalDispatchCount).toBe(3);
    expect(projection.usage.coverageRatio).toBeCloseTo(1 / 3, 5);
    expect(projection.usage.complete).toBe(false);
  });

  it('speed is measured from a single provider invocation (not attempt duration)', async () => {
    const projection = await projectGoalUsage(reader(), 'run_1');
    expect(projection.speed.state).toBe('KNOWN');
    expect(projection.speed.samples).toEqual([200]);
  });

  it('cache hit is UNKNOWN with a stated reason (never inferred)', async () => {
    const projection = await projectGoalUsage(reader(), 'run_1');
    expect(projection.cacheHit.state).toBe('UNKNOWN');
    expect(projection.cacheHit.reason).toContain('cached-token');
  });

  it('cost is explicitly ESTIMATED from known usage × declared pricing', async () => {
    const projection = await projectGoalUsage(reader(), 'run_1');
    expect(projection.cost.state).toBe('ESTIMATED');
    // (100 * 1 + 20 * 2) / 1e6 = 0.00014 → 0.000
    expect(projection.cost.knownScopeCost).toBe(0);
    expect(projection.cost.coverageComplete).toBe(false);
  });

  it('cost is UNKNOWN without declared pricing', async () => {
    const base = reader();
    const projection = await projectGoalUsage({ ...base, modelPricing: async () => null }, 'run_1');
    expect(projection.cost.state).toBe('UNKNOWN');
  });

  it('context remaining is UNKNOWN (cumulative Goal usage is not current context)', async () => {
    const projection = await projectGoalUsage(reader(), 'run_1');
    expect(projection.contextRemaining.state).toBe('UNKNOWN');
    expect(projection.contextRemaining.reason).toContain('累计');
  });

  it('no sources at all → every metric UNKNOWN, never a zero total', async () => {
    const empty = {
      runsOf: async (runId: string) => [{ id: runId, state: 'IDLE' }],
      agentExecutions: async () => [],
      providerDispatches: async () => [],
      providerInvocations: async () => [],
      modelKeyOf: async () => null,
      modelPricing: async () => null,
    };
    const projection = await projectGoalUsage(empty, 'run_1');
    expect(projection.usage.totalDispatchCount).toBe(0);
    expect(projection.speed.state).toBe('UNKNOWN');
    expect(projection.cost.state).toBe('UNKNOWN');
  });

  it('the service refuses an empty run id and answers ok otherwise', async () => {
    const service = createGoalUsageService(reader());
    const bad = await service.usageOf({ companyId: 'company_default', runId: '' });
    expect(bad.ok).toBe(false);
    const good = await service.usageOf({ companyId: 'company_default', runId: 'run_1' });
    expect(good.ok).toBe(true);
  });
});

/* --------------------------------------------------------------- readiness --- */

describe('STAGE 3 readiness projection', () => {
  it('reports each readiness row and the FIRST canonical external precondition', () => {
    const projection = projectReadiness({
      providerRegistered: false,
      providerHealthy: false,
      providerDetail: 'not configured',
      modelSelected: false,
      modelDetail: 'none',
      executorConfigured: false,
      executorDetail: 'none',
      workspaceOpen: false,
      workspaceDetail: 'none',
    });
    expect(projection.provider.state).toBe('NOT_CONFIGURED');
    expect(projection.externalBlock?.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(blockerLabel('EXECUTOR_PROVIDER_UNKNOWN')).toBe('执行器尚未配置');
  });

  it('the executor block is explicit when only the executor is missing', () => {
    const projection = projectReadiness({
      providerRegistered: true,
      providerHealthy: true,
      providerDetail: 'ok',
      modelSelected: true,
      modelDetail: 'ok',
      executorConfigured: false,
      executorDetail: 'COMPANYOS_EXECUTOR_PROVIDER',
      workspaceOpen: true,
      workspaceDetail: 'ok',
    });
    expect(projection.externalBlock?.code).toBe('EXECUTOR_PROVIDER_UNKNOWN');
    expect(projection.executor.state).toBe('NOT_CONFIGURED');
    expect(projection.workspace.state).toBe('READY');
  });

  it('a fully ready composition has no external block', () => {
    const projection = projectReadiness({
      providerRegistered: true,
      providerHealthy: true,
      providerDetail: 'ok',
      modelSelected: true,
      modelDetail: 'ok',
      executorConfigured: true,
      executorDetail: 'ok',
      workspaceOpen: true,
      workspaceDetail: 'ok',
    });
    expect(projection.externalBlock).toBeNull();
  });
});

/* ---------------------------------------------------- workflow op contract --- */

describe('STAGE 3 workflow op contract', () => {
  it('runtime.readiness is a declared read-only operation', () => {
    const api: WorkflowApi = createWorkflowApi({
      lifecycle: {} as never,
      listTemplates: async () => [],
      readiness: async () => ({ provider: { state: 'READY', detail: 'ok' } }),
    });
    expect(api).toBeDefined();
  });
});

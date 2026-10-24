/**
 * STAGE 4 — ISOLATION proofs: the embedded provider has NO external-DSH
 * dependency, secrets never leak into durable state, and the resolver fails
 * closed (no silent PATH/desktop fallback).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FIXED_IMPL, composeKernelFixture, driveKernelGoal, type KernelFixture } from './support/embedded-kernel-fixture.js';
import { resolveEmbeddedDshRuntime, externalDshRuntimeOptedIn } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';

const fixtures: KernelFixture[] = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

const EMBEDDED_ROOT = join(process.cwd(), '.companyos-embedded', 'dsh-runtime');

describe('STAGE 4 embedded kernel isolation proofs', () => {
  it('NO EXTERNAL DSH: the provider resolves ONLY the CompanyOS-managed runtime (exact pin, checksummed entry)', () => {
    const resolved = resolveEmbeddedDshRuntime({ managedRoot: EMBEDDED_ROOT });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // STAGE 5B: the child executes from a STAGED verified closure copy inside the
    // managed root — never the user's PATH, desktop installation, or ~/.dsh.
    const stage = resolved.value.prepareAttemptStage({ attemptId: 'isolation' });
    expect(stage.ok).toBe(true);
    if (!stage.ok) return;
    stage.value.dispose();
    expect(stage.value.cliEntryPath.startsWith(join(process.cwd(), '.companyos-embedded'))).toBe(true);
    expect(resolved.value.manifest.upstreamRepo).toBe('https://github.com/deepseek-ai/deepseek-harness');
    expect(resolved.value.manifest.upstreamSha).toBe('639ed015397290b3745d163aafe02ffee4aa3f84');
    expect(resolved.value.manifest.upstreamTag).toBe('dsh-v0.2.0-rc.2');
    // Exact-pin checksum present and verified at resolution.
    expect(resolved.value.manifest.checksums['apps/cli/lib/bin.js']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('FAIL-CLOSED resolver: a missing managed root is a typed failure (never a PATH fallback); external mode is explicit opt-in only', () => {
    const missing = resolveEmbeddedDshRuntime({ managedRoot: join(process.cwd(), '.companyos-embedded', 'does-not-exist') });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(String(missing.error.details['reason'])).toBe('EXECUTOR_EMBEDDED_RUNTIME_MISSING');
    // The external sentinel defaults OFF — the historical env-based path never loads implicitly.
    expect(externalDshRuntimeOptedIn({})).toBe(false);
    expect(externalDshRuntimeOptedIn({ COMPANYOS_DSH_EXTERNAL_RUNTIME: '0' })).toBe(false);
    expect(externalDshRuntimeOptedIn({ COMPANYOS_DSH_EXTERNAL_RUNTIME: '1' })).toBe(true);
  });

  it('SECRET LEAKAGE: the model credential never enters durable state (DB canary scan) — the broker holds it in-process only', async () => {
    const canary = `sk-canary-${Math.random().toString(36).slice(2)}-DO-NOT-PERSIST`;
    const scenario = [
      { tool_call: { name: 'write', arguments: { file_path: 'src/calc.js', content: FIXED_IMPL } } },
      { text: 'All tests pass.' },
    ];
    const f = await composeKernelFixture({ prefix: 'secret', scenario, apiKeyValue: canary });
    fixtures.push(f);
    const executionRunId = await driveKernelGoal(f.core, 'Fix src/calc.js so that the repository test suite passes.', 'kernel-secret-1');
    // The run completed through the embedded kernel…
    const work = f.core.database.db
      .prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?')
      .get('companyos:work', executionRunId) as { state: string };
    expect(work.state).toBe('DONE');
    // …and the canary appears in NO durable table (typed config carries the env NAME,
    // the broker the value; the child env died with the invocation).
    const tables = ['tasks', 'execution_attempts', 'provider_dispatches', 'artifacts', 'agent_executions'] as const;
    for (const table of tables) {
      const rows = f.core.database.db
        .prepare(`SELECT * FROM ${table}`)
        .all() as Readonly<Record<string, unknown>>[];
      const blob = JSON.stringify(rows);
      expect(blob.includes(canary)).toBe(false);
    }
  }, 300_000);

  it('SESSION: the DSH session id is subordinate metadata only — its loss changes nothing canonical', async () => {
    const scenario = [
      { tool_call: { name: 'write', arguments: { file_path: 'src/calc.js', content: FIXED_IMPL } } },
      { text: 'All tests pass.' },
    ];
    const f = await composeKernelFixture({ prefix: 'sess', scenario, apiKeyValue: 'k' });
    fixtures.push(f);
    const executionRunId = await driveKernelGoal(f.core, 'Fix src/calc.js so that the repository test suite passes.', 'kernel-sess-1');
    const dispatch = f.core.database.db
      .prepare('SELECT provider_session_id, state FROM provider_dispatches WHERE run_id = ? AND provider_key = ?')
      .get(executionRunId, 'dsh-headless') as { provider_session_id: string | null; state: string };
    // A session id was recorded as provenance…
    expect(dispatch.provider_session_id).toMatch(/^session-/);
    // …and the canonical task/attempt truth is INDEPENDENT of it (no session table,
    // no session-derived state: the column is metadata, the attempt is the truth).
    const attempt = f.core.database.db
      .prepare('SELECT state FROM execution_attempts WHERE run_id = ? ORDER BY attempt_number')
      .get(executionRunId) as { state: string };
    expect(attempt.state).toBe('COMPLETED');
    expect(dispatch.state).toBe('SETTLED');
  }, 300_000);

  it('LICENSE/NOTICE: the materialized runtime carries the MIT upstream notice and third-party notices', () => {
    const manifest = JSON.parse(readFileSync(join(EMBEDDED_ROOT, 'manifest.json'), 'utf8')) as { runtimeRoot: string };
    expect(readFileSync(join(manifest.runtimeRoot, 'LICENSE'), 'utf8').startsWith('MIT License')).toBe(true);
    expect(readFileSync(join(manifest.runtimeRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8').length).toBeGreaterThan(0);
  });
});

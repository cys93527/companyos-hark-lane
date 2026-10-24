/**
 * STAGE 4 — the DETERMINISTIC EMBEDDED KERNEL E2E (the MVP chain proof).
 *
 *   Canonical Goal/Task → WorkPackage → ExecutorWorkInput → EXISTING dsh-headless
 *   ExecutorProvider → CompanyOS-MANAGED EMBEDDED official kernel (pinned
 *   dsh-v0.2.0-rc.2, materialized manifest) → loopback scenario model → REAL tool
 *   actions (file write + PowerShell + git) in a DISPOSABLE fixture repo → result
 *   → CompanyOS settlement → canonical artifacts.
 *
 * LAB-ONLY POSTURE: every run happens in an isolated, disposable, non-production
 * workspace (temp dir with spaces + unicode). PRODUCTION_SECURITY_CERTIFIED = NO
 * (Stage 5 pending). The scenario model is the DETERMINISTIC protocol proof; the
 * real-model proof is the separate live operator smoke.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { BROKEN_IMPL, FIXED_IMPL, VERIFY_KIND, composeKernelFixture, driveKernelGoal, type KernelFixture } from './support/embedded-kernel-fixture.js';

const fixtures: KernelFixture[] = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

const taskStates = (f: KernelFixture, executionRunId: string) =>
  (f.core.database.db
    .prepare('SELECT kind, state, attempts FROM tasks WHERE run_id = ? ORDER BY kind')
    .all(executionRunId) as { kind: string; state: string; attempts: number }[]);

describe('STAGE 4 deterministic embedded kernel E2E (lab-only disposable workspaces)', () => {
  it('the full production chain runs through the EMBEDDED kernel: tools act, CompanyOS settles, evidence is canonical', async () => {
    const scenario = [
      { tool_call: { name: 'write', arguments: { file_path: 'src/calc.js', content: FIXED_IMPL } } },
      { tool_call: { name: 'pwsh', arguments: { command: 'git status --porcelain' } } },
      { text: 'All tests pass.' },
    ];
    const f = await composeKernelFixture({ prefix: 'pass', scenario, apiKeyValue: 'kernel-e2e-not-a-real-key' });
    fixtures.push(f);

    const executionRunId = await driveKernelGoal(f.core, 'Fix src/calc.js so that the repository test suite passes, then verify by running the tests.', 'kernel-e2e-pass-1');

    // The AGENT's tool action REALLY changed the disposable repo (Model→Tool→Observe→Continue).
    expect(readFileSync(f.repo.srcPath, 'utf8')).toBe(FIXED_IMPL);
    const diff = execFileSync('git', ['status', '--porcelain'], { cwd: f.repo.root }).toString();
    expect(diff).toContain('src/calc.js');

    // BOTH canonical tasks settled through the REAL composition (agentic + native verify).
    const states = taskStates(f, executionRunId);
    expect(states).toHaveLength(2);
    const byKind = new Map(states.map((row) => [row.kind, row.state]));
    expect(byKind.get('companyos:work')).toBe('DONE');
    expect(byKind.get(VERIFY_KIND)).toBe('DONE');

    // The embedded provider's dispatch row carries the managed identity + honest session.
    const dispatch = f.core.database.db
      .prepare('SELECT provider_key, state, provider_session_id, config_fingerprint FROM provider_dispatches WHERE run_id = ? AND provider_key = ?')
      .get(executionRunId, 'dsh-headless') as { provider_key: string; state: string; provider_session_id: string | null; config_fingerprint: string | null };
    expect(dispatch.state).toBe('SETTLED');
    expect(dispatch.provider_session_id).toMatch(/^session-/);
    expect(dispatch.config_fingerprint).toMatch(/^scfg_/);

    // §20 — the kernel diagnostics summary became a CANONICAL artifact through the
    // existing Sprint-13 materialization seam (tool calls recorded; never a row the
    // provider wrote itself).
    const summary = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'companyos:executor-output' AND run_id = ?")
      .get(executionRunId) as { n: number };
    expect(summary.n).toBeGreaterThanOrEqual(1);
    const artifactRow = f.core.database.db
      .prepare("SELECT artifact_id FROM artifacts WHERE kind = 'companyos:executor-output' AND run_id = ? LIMIT 1")
      .get(executionRunId) as { artifact_id: string };
    // The artifact content is read through the canonical CAS seam (proven by the
    // Stage-3 gate); here the row identity + downstream envelope suffice.
    const envelope = f.core.database.db
      .prepare('SELECT outputs_json FROM tasks WHERE kind = ? AND run_id = ?')
      .get('companyos:work', executionRunId) as { outputs_json: string };
    expect(envelope.outputs_json).toContain(artifactRow.artifact_id);
  }, 300_000);

  it('§19 — the agent CLAIMING success does not decide: the real test evidence does (CompanyOS FAILS the run on a broken implementation)', async () => {
    // The scenario writes the BROKEN implementation and the model STILL claims
    // success in its final text — the canonical native verify task runs the REAL
    // test command and CompanyOS settles it FAILED. Agent text alone ≠ success.
    const scenario = [
      { tool_call: { name: 'write', arguments: { file_path: 'src/calc.js', content: BROKEN_IMPL } } },
      { text: 'All tests pass. Everything is complete and correct.' },
    ];
    const f = await composeKernelFixture({ prefix: 'fail', scenario, apiKeyValue: 'kernel-e2e-not-a-real-key' });
    fixtures.push(f);

    const executionRunId = await driveKernelGoal(f.core, 'Fix src/calc.js so that the repository test suite passes, then verify by running the tests.', 'kernel-e2e-fail-1');

    const states = taskStates(f, executionRunId);
    const byKind = new Map(states.map((row) => [row.kind, row.state]));
    // The agentic task completed (its transport succeeded, its text claimed success)…
    expect(byKind.get('companyos:work')).toBe('DONE');
    // …but the REAL validator evidence (node test.js exit 1) settled the verify task
    // FAILED — CompanyOS, not the agent's claim, decided the outcome.
    expect(byKind.get(VERIFY_KIND)).toBe('FAILED');
    // And the agent's claim is recorded as mere payload, never as verdict:
    const envelope = f.core.database.db
      .prepare('SELECT outputs_json FROM tasks WHERE kind = ? AND run_id = ?')
      .get('companyos:work', executionRunId) as { outputs_json: string };
    expect(envelope.outputs_json).toContain('All tests pass');
  }, 300_000);

  it('the Canonical Work Envelope reaches the kernel (the scenario model SEES the projected context)', async () => {
    // The scenario server's served requests are asserted via the fixture's canonical
    // state; here we prove the envelope projection directly at the provider seam by
    // capturing what the scenario model received. The scenario-model-server records
    // nothing itself, so this proof rides the FIRST e2e's assertions + this direct
    // projection unit check on the adapter's exported projection.
    const { dshTaskTextOf } = await import('../../apps/desktop/src/executor/dsh-executor-provider.js');
    const text = dshTaskTextOf({
      companyId: 'c', runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1,
      roleId: 'drole_probe0123456789', taskKind: 'companyos:work',
      work: {
        objective: 'Fix the calculator.',
        memoryView: ['Goal: fix it'],
        artifactRefs: ['art_1'],
        taskInputs: { threshold: 2 },
        acceptanceCriteria: [{ criterionId: 'impl', requirement: 'doubles input' }],
        goalStructured: { rules: { strict: true } },
      },
      workspace: { cwd: 'C:\\ws', root: 'C:\\ws' },
      requiredCapabilities: [], dispatchKey: 'dsp_x', taskText: '', structured: false,
    });
    // First line = the objective (the frozen S24 one-task contract shape)…
    expect(text.split('\n')[0]).toBe('Fix the calculator.');
    // …and every envelope field is present as data.
    expect(text).toContain('Role: drole_probe0123456789');
    expect(text).toContain('[impl] doubles input');
    expect(text).toContain('rules');
    expect(text).toContain('threshold');
    expect(text).toContain('art_1');
    expect(text).toContain('Goal: fix it');
  }, 30_000);
});

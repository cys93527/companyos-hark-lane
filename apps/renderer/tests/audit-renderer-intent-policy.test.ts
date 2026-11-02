/**
 * AUDIT R5 — an unconfirmed submission replays with the access policy and workspace it was made with: the outbox
 * records the chosen policy, a reload round-trips policy/attempted/goalRunId, and the submit seam never substitutes
 * the current chip (a policy-less legacy record or another workspace is refused, nothing sent).
 */
import { describe, expect, it } from 'vitest';

import { createSubmissionIntentStore } from '../src/intent-store.js';
import { createSubmissionController } from '../src/submission-intent.js';
import { memoryStorage } from './support/audit-app-harness.js';

describe('AUDIT R5 — intent keeps its access policy', () => {
  it('a READ_ONLY submission that failed with an unknown outcome is retried as READ_ONLY after a reload', async () => {
    const storage = memoryStorage();
    const sent: { accessPolicy?: string; intentId: string }[] = [];
    let fail = true;
    const make = () => createSubmissionController({
      store: createSubmissionIntentStore(storage),
      submit: async (input) => { sent.push(input); return fail ? { error: 'ipc broke', code: 'IPC_FAILED' } : { runId: 'run_1' }; },
      now: () => '2026-11-02T00:00:00Z',
      newIntentId: () => 'si-1',
    });
    const first = await make().submitObjective('目标', '/ws', undefined, 'READ_ONLY');
    expect(first.status).toBe('failed');
    const stored = JSON.parse([...storage.data.values()][0]!) as Record<string, unknown>;
    expect(stored['accessPolicy']).toBe('READ_ONLY');
    // "reload": a fresh controller over the same storage
    fail = false;
    const again = await make().retry();
    expect(again).toEqual({ status: 'replayed', runId: 'run_1', intentId: 'si-1' });
    expect(sent.map((s) => s.accessPolicy)).toEqual(['READ_ONLY', 'READ_ONLY']);
    expect(sent.map((s) => s.intentId)).toEqual(['si-1', 'si-1']);
  });

  it('an invalid stored policy is dropped by the parser (never guessed)', () => {
    const storage = memoryStorage();
    storage.setItem('companyos.submission-intent.v1', JSON.stringify({ intentId: 'x', objective: 'o', workspaceRoot: '/ws', state: 'pending', createdAt: '', accessPolicy: 'GOD_MODE', attempted: true, goalRunId: 'g' }));
    const loaded = createSubmissionIntentStore(storage).load();
    expect(loaded?.accessPolicy).toBeUndefined();
    expect(loaded?.attempted).toBe(true);
    expect(loaded?.goalRunId).toBe('g');
  });

  it('App submits the intent policy, refuses legacy/mismatched intents before main', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('accessPolicy: input.accessPolicy,');
    expect(app).not.toContain('accessPolicy: selectedAccessPolicy,');
    expect(app).toContain("code: 'INTENT_POLICY_MISSING'");
    expect(app).toContain("code: 'INTENT_WORKSPACE_MISMATCH'");
    expect(app).toContain('active.submitObjective(draft, workspaceRoot, structured, selectedAccessPolicy)');
  });
});

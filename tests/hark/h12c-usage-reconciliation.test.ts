// H12c — operator reconciliation of an UNKNOWN charge: canonical budget transaction rules,
// storage invariant, the operator-file reader, and the boss-facing rows. No provider, CNY 0.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { type CostAdmissionBound, type GoalBudgetPolicy } from '@companyos/core';
import { createGoalExecutionBudget } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { applyOperatorUsageReconciliations } from '../../apps/desktop/src/usage-reconciliation.js';
import { projectGoalBudget } from '../../apps/desktop/src/efficiency/goal-budget-projection.js';
import { budgetRows, parseGoalBudgetRead } from '../../apps/renderer/src/budget.js';

const dirs: string[] = [];
const databases: DurableDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const policy: GoalBudgetPolicy = { policyId: 'offline-policy-1', maxCalls: 3, maxTokens: 1000, maxCostMicros: 1000, deadlineMs: 2000 };
const bound: CostAdmissionBound = { modelKey: 'offline-only', inputTokens: 30, outputTokens: 10, costMicros: 40, evidenceRef: 'OFFLINE_TEST_BOUND', validUntilMs: 2000 };
const att = (id = 'rec-1') => ({ reconciliationId: id, attestedBy: 'operator', attestedAt: '2026-10-26T00:00:00.000Z', evidenceRef: `sha256:${'a'.repeat(64)}` });

const fixture = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h12c-rec-')); dirs.push(dir);
  const db = openDurableDatabase({ dataDir: dir, appliedAt: 'offline' }); databases.push(db);
  db.db.prepare(`INSERT INTO runs (id,company_id,workflow_id,template_id,version_id,snapshot_id,state,revision,rework_count,max_rework,history_json,created_at,updated_at,started_by) VALUES ('goal','company','workflow','template','version','snapshot','IDLE',0,0,3,'[]','now','now','actor')`).run();
  const authority = createGoalExecutionBudget(db.executionBudget, () => 1000);
  await authority.initialize('goal', policy);
  return { db, dir, authority };
};

describe('H12c reconcile (canonical budget transaction)', () => {
  it('UNKNOWN -> KNOWN with the attestation; unblocks admission; identical re-apply is a no-op', async () => {
    const f = await fixture();
    await f.authority.reserve({ runId: 'goal', callId: 'c1', ownerId: 'x', bound });
    await f.authority.recover('goal');
    await expect(f.authority.check('goal')).rejects.toMatchObject({ details: { reason: 'GOAL_USAGE_UNKNOWN' } });
    expect(await f.authority.reconcile('goal', 'c1', { tokens: 20, costMicros: 15 }, att())).toBe('APPLIED');
    const state = await f.authority.read('goal');
    expect(state.reservations[0]).toMatchObject({ status: 'KNOWN', usage: { tokens: 20, costMicros: 15 }, reconciliation: att() });
    await expect(f.authority.check('goal')).resolves.toBeUndefined();
    expect(await f.authority.reconcile('goal', 'c1', { tokens: 20, costMicros: 15 }, att())).toBe('ALREADY_APPLIED');
    await expect(f.authority.reconcile('goal', 'c1', { tokens: 21, costMicros: 15 }, att())).rejects.toMatchObject({ details: { reason: 'GOAL_RECONCILIATION_CONFLICT' } });
    await expect(f.authority.reconcile('goal', 'c1', { tokens: 20, costMicros: 15 }, att('rec-2'))).rejects.toMatchObject({ details: { reason: 'GOAL_RECONCILIATION_CONFLICT' } });
  });

  it('refuses: in-flight RESERVED, exceeding the trusted bound, an unknown call, malformed attestation, a normally settled KNOWN', async () => {
    const f = await fixture();
    await f.authority.reserve({ runId: 'goal', callId: 'c1', ownerId: 'x', bound });
    await expect(f.authority.reconcile('goal', 'c1', { tokens: 1, costMicros: 1 }, att())).rejects.toMatchObject({ details: { reason: 'GOAL_RECONCILIATION_NOT_UNKNOWN' } });
    await f.authority.recover('goal');
    await expect(f.authority.reconcile('goal', 'c1', { tokens: 41, costMicros: 1 }, att())).rejects.toMatchObject({ details: { reason: 'GOAL_RECONCILIATION_EXCEEDS_BOUND' } });
    await expect(f.authority.reconcile('goal', 'c1', { tokens: 1, costMicros: 41 }, att())).rejects.toMatchObject({ details: { reason: 'GOAL_RECONCILIATION_EXCEEDS_BOUND' } });
    await expect(f.authority.reconcile('goal', 'nope', { tokens: 1, costMicros: 1 }, att())).rejects.toMatchObject({ details: { reason: 'GOAL_RESERVATION_NOT_FOUND' } });
    await expect(f.authority.reconcile('goal', 'c1', { tokens: 1, costMicros: 1 }, { ...att(), evidenceRef: 'invoice.pdf' })).rejects.toMatchObject({ details: { reason: 'GOAL_RECONCILIATION_INVALID' } });
    await expect(f.authority.reconcile('goal', 'c1', { tokens: -1, costMicros: 1 }, att())).rejects.toMatchObject({ details: { reason: 'GOAL_RECONCILIATION_INVALID' } });
    expect((await f.authority.read('goal')).reservations[0]?.status).toBe('UNKNOWN');
    await f.authority.reserve({ runId: 'goal', callId: 'c2', ownerId: 'x', bound }).catch(() => undefined); // refused: UNKNOWN blocks
    const g = await fixture();
    await g.authority.reserve({ runId: 'goal', callId: 'k', ownerId: 'x', bound });
    await g.authority.settle('goal', 'k', { tokens: 5, costMicros: 5 });
    await expect(g.authority.reconcile('goal', 'k', { tokens: 5, costMicros: 5 }, att())).rejects.toMatchObject({ details: { reason: 'GOAL_RECONCILIATION_CONFLICT' } });
  });

  it('storage refuses a reconciliation attached to a non-KNOWN reservation (persisted invariant)', async () => {
    const f = await fixture();
    await f.authority.reserve({ runId: 'goal', callId: 'c1', ownerId: 'x', bound });
    await f.authority.recover('goal');
    const raw = JSON.parse((f.db.db.prepare('SELECT execution_budget_json AS b FROM runs WHERE id = ?').get('goal') as { b: string }).b) as { reservations: Record<string, unknown>[] };
    raw.reservations[0]!['reconciliation'] = att();
    f.db.db.prepare('UPDATE runs SET execution_budget_json = ? WHERE id = ?').run(JSON.stringify(raw), 'goal');
    await expect(f.authority.read('goal')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_STATE_INVALID' } });
  });
});

describe('H12c operator file reader', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'h12c-op-')); dirs.push(dir);
    const evidence = Buffer.from('invoice line');
    const hex = createHash('sha256').update(evidence).digest('hex');
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'evidence', hex), evidence);
    const entry = { reconciliationId: 'r1', goalRunId: 'goal', callId: 'c1', tokens: 3, costMicros: 4, attestedBy: 'op', attestedAt: '2026-10-26T00:00:00Z', evidence: `sha256:${hex}` };
    return { dir, hex, entry };
  };
  const recorder = () => {
    const seen: unknown[] = [];
    return { seen, reconcile: async (...args: unknown[]) => { seen.push(args); return 'APPLIED' as const; } };
  };

  it('absent / invalid file applies nothing', async () => {
    const { dir } = setup(); const r = recorder();
    expect(await applyOperatorUsageReconciliations(dir, r.reconcile)).toEqual({ file: 'ABSENT', outcomes: [] });
    writeFileSync(join(dir, 'reconciliations.json'), '{"schema":"other","entries":[]}');
    expect((await applyOperatorUsageReconciliations(dir, r.reconcile)).file).toBe('INVALID');
    writeFileSync(join(dir, 'reconciliations.json'), '{not json');
    expect((await applyOperatorUsageReconciliations(dir, r.reconcile)).file).toBe('INVALID');
    expect(r.seen).toEqual([]);
  });

  it('verifies each entry: shape, duplicate id, evidence hash; applies only valid ones; surfaces typed refusals', async () => {
    const { dir, entry } = setup(); const r = recorder();
    writeFileSync(join(dir, 'reconciliations.json'), JSON.stringify({ schema: 'companyos:usage-reconciliation:1', entries: [
      entry,
      entry,
      { ...entry, reconciliationId: 'r2', evidence: `sha256:${'b'.repeat(64)}` },
      { ...entry, reconciliationId: 'r3', tokens: 1.5 },
      { ...entry, reconciliationId: 'r4', attestedAt: 'yesterday' },
    ] }));
    const report = await applyOperatorUsageReconciliations(dir, r.reconcile);
    expect(report.outcomes.map((o) => [o.reconciliationId, o.outcome, o.reason])).toEqual([
      ['r1', 'APPLIED', null],
      ['r1', 'REFUSED', 'RECONCILIATION_ID_DUPLICATE'],
      ['r2', 'REFUSED', 'RECONCILIATION_EVIDENCE_MISSING_OR_MISMATCHED'],
      ['r3', 'REFUSED', 'RECONCILIATION_ENTRY_INVALID'],
      ['r4', 'REFUSED', 'RECONCILIATION_ENTRY_INVALID'],
    ]);
    expect(r.seen).toEqual([['goal', 'c1', { tokens: 3, costMicros: 4 }, { reconciliationId: 'r1', attestedBy: 'op', attestedAt: '2026-10-26T00:00:00Z', evidenceRef: entry.evidence }]]);
    // A tampered evidence file no longer matches its reference.
    writeFileSync(join(dir, 'evidence', entry.evidence.slice(7)), 'edited');
    writeFileSync(join(dir, 'reconciliations.json'), JSON.stringify({ schema: 'companyos:usage-reconciliation:1', entries: [entry] }));
    expect((await applyOperatorUsageReconciliations(dir, r.reconcile)).outcomes[0]?.reason).toBe('RECONCILIATION_EVIDENCE_MISSING_OR_MISMATCHED');
  });

  it('a refusal from the budget transaction is reported with its typed reason, never thrown', async () => {
    const { dir, entry } = setup();
    writeFileSync(join(dir, 'reconciliations.json'), JSON.stringify({ schema: 'companyos:usage-reconciliation:1', entries: [entry] }));
    const report = await applyOperatorUsageReconciliations(dir, async () => { throw Object.assign(new Error('x'), { code: 'POLICY_DENIED', details: { reason: 'GOAL_RECONCILIATION_EXCEEDS_BOUND' } }); });
    expect(report.outcomes).toEqual([{ reconciliationId: 'r1', goalRunId: 'goal', callId: 'c1', outcome: 'REFUSED', reason: 'GOAL_RECONCILIATION_EXCEEDS_BOUND' }]);
  });

  it('no IPC / renderer path can write the operator file (main-process only)', () => {
    const preload = readFileSync('apps/desktop/preload/preload.cjs', 'utf8');
    const channels = readFileSync('apps/desktop/src/channels.ts', 'utf8');
    for (const src of [preload, channels]) expect(src).not.toMatch(/reconcil/iu);
    expect(readFileSync('apps/desktop/src/main.ts', 'utf8')).toContain("usageReconciliationDir: join(app.getPath('userData'), 'budget')");
  });
});

describe('H12c projection + boss rows', () => {
  it('reconciled calls are settled, listed separately; UNKNOWN no longer counted', () => {
    const p = projectGoalBudget('goal', { goalRunId: 'goal', policy, cancellation: null, reservations: [
      { callId: 'c1', runId: 'goal', ownerId: 'x', bound, status: 'KNOWN', usage: { tokens: 20, costMicros: 15 }, reconciliation: att() },
      { callId: 'c2', runId: 'goal', ownerId: 'x', bound, status: 'KNOWN', usage: { tokens: 5, costMicros: 5 } },
    ] }, { nowMs: 1000, currency: 'CNY' });
    expect(p.settled).toEqual({ calls: 2, tokens: 25, costMicros: 20 });
    expect(p.reconciled).toEqual({ calls: 1, tokens: 20, costMicros: 15 });
    expect(p.unknown.calls).toBe(0);
    const view = parseGoalBudgetRead({ budget: p, plan: null });
    expect(view).not.toBeNull();
    expect(budgetRows(view!.budget)).toContain('其中运营者凭证对账 · 1 次 · ¥0.000015');
    // Older payload without `reconciled` still parses (0); a malformed one renders nothing.
    const { reconciled: _drop, ...older } = p;
    expect(parseGoalBudgetRead({ budget: older, plan: null })?.budget.reconciled).toEqual({ calls: 0, tokens: 0, costMicros: 0 });
    expect(parseGoalBudgetRead({ budget: { ...p, reconciled: { calls: 'x' } }, plan: null })).toBeNull();
  });
});

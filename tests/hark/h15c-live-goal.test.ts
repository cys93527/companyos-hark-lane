/**
 * Hark lane H15c — the real-goal execution harness stays inside the user's CNY 1 cap and
 * is wired as an explicit manual mode (never the default planning preview).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const template = JSON.parse(readFileSync('installer/budget/deepseek-flash.h15c.approval-template.json', 'utf8')) as {
  cap: { maxCalls: number; maxTokens: number; maxCostMicros: number };
  proof: { identity: { modelId: string }; pricing: { inputRate: number; outputRate: number; currency: string }; tokens: { inputUpperBound: number; outputUpperBound: number } };
};

describe('H15c live goal (execute mode)', () => {
  it('worst case of every admitted call at peak rates fits what remains of the cumulative CNY 1 cap', () => {
    const { cap, proof } = template;
    const perCall = Math.ceil((proof.tokens.inputUpperBound * proof.pricing.inputRate + proof.tokens.outputUpperBound * proof.pricing.outputRate) / 1e6);
    expect(proof.pricing.currency).toBe('CNY');
    expect(proof.identity.modelId).toBe('deepseek-flash');
    // The CNY 1 cap is CUMULATIVE across live runs: prior settlements (UNKNOWN at worst case) are in the ledger.
    const ledger = JSON.parse(readFileSync('installer/budget/h15c-real-spend-ledger.json', 'utf8')) as { capMicros: number; entries: { micros: number }[] };
    expect(ledger.capMicros).toBe(1_000_000);
    const spent = ledger.entries.reduce((n, e) => n + e.micros, 0);
    expect(cap.maxCostMicros).toBeLessThanOrEqual(ledger.capMicros - spent);
    expect(perCall * cap.maxCalls).toBeLessThanOrEqual(cap.maxCostMicros);
    expect(cap.maxCalls * (proof.tokens.inputUpperBound + proof.tokens.outputUpperBound)).toBeLessThanOrEqual(cap.maxTokens);
  });

  it('the workflow runs the execute harness only on explicit mode=execute; planning stays the default', () => {
    const wf = readFileSync('.github/workflows/hark-live-goal.yml', 'utf8');
    expect(wf).toMatch(/workflow_dispatch:/u);
    expect(wf).toMatch(/default: planning/u);
    expect(wf).toMatch(/COS_PLAN_PREVIEW_WITHOUT_EXECUTOR: \$\{\{ inputs\.mode == 'planning' && '1' \|\| '0' \}\}/u);
    expect(wf).toMatch(/options: \[planning, execute, acceptance\]/u);
    expect(wf).toMatch(/live-goal-execute\.mjs/u);
    expect(wf).toMatch(/deepseek-flash\.h15c\.approval-template\.json/u);
    const harness = readFileSync('scripts/hark/live-goal-execute.mjs', 'utf8');
    expect(harness).toMatch(/PREVIEW_MODE_SET/u);
    for (const table of ['artifacts', 'validations', 'handoffs']) expect(harness).toContain(`FROM ${table}`);
    expect(harness).toMatch(/embeddedDshStateRoot/u);
  });
});

/*
 * H15d (user approval 2026-10-26 16:44): ONE realistic acceptance run on a SEPARATE CNY 5
 * budget with its own ledger; worst case of every admitted call must fit what remains.
 */
describe('H15d realistic acceptance run budget', () => {
  const t = JSON.parse(readFileSync('installer/budget/deepseek-flash.h15d.approval-template.json', 'utf8')) as typeof template;
  it('44 worst-case calls fit the separate CNY 5 ledger; input bound is the enforced body-byte bound', () => {
    const perCall = Math.ceil((t.proof.tokens.inputUpperBound * t.proof.pricing.inputRate + t.proof.tokens.outputUpperBound * t.proof.pricing.outputRate) / 1e6);
    const ledger = JSON.parse(readFileSync('installer/budget/h15d-acceptance-ledger.json', 'utf8')) as { capMicros: number; entries: { micros: number }[] };
    expect(ledger.capMicros).toBe(5_000_000);
    const spent = ledger.entries.reduce((n, e) => n + e.micros, 0);
    expect(t.cap.maxCostMicros).toBeLessThanOrEqual(ledger.capMicros - spent);
    expect(perCall * t.cap.maxCalls).toBeLessThanOrEqual(t.cap.maxCostMicros);
    expect(t.cap.maxCalls * (t.proof.tokens.inputUpperBound + t.proof.tokens.outputUpperBound)).toBeLessThanOrEqual(t.cap.maxTokens);
    expect(t.proof.tokens.outputUpperBound).toBe(2048);
  });
  it('the acceptance scenario seeds the fixture and checks the result independently of the model', () => {
    const harness = readFileSync('scripts/hark/live-goal-execute.mjs', 'utf8');
    expect(harness).toMatch(/acceptance-fixture/u);
    expect(harness).toMatch(/npm test/u);
    expect(harness).toMatch(/reorderPlanExample/u);
    const wf = readFileSync('.github/workflows/hark-live-goal.yml', 'utf8');
    expect(wf).toMatch(/deepseek-flash\.h15d\.approval-template\.json/u);
  });
});

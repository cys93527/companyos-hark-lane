/**
 * Hark lane LIVE-CUSTOM (user 2026-11-06 00:16/00:17 CST): the user's own requirement runs
 * through the INSTALLED GUI on a per-run cap of CNY 8, every run reserved in its own ledger
 * before dispatch. These checks keep the wiring honest without any model call.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wf = readFileSync('.github/workflows/hark-live-goal.yml', 'utf8');
const customJob = wf.slice(wf.indexOf('  live-goal-custom:'));
const t = JSON.parse(readFileSync('installer/budget/deepseek-flash.contract-fill.approval-template.json', 'utf8')) as {
  cap: { maxCalls: number; maxTokens: number; maxCostMicros: number; durationMs: number };
  proof: { pricing: { inputRate: number; outputRate: number; currency: string }; tokens: { inputUpperBound: number; outputUpperBound: number } };
};

describe('live custom goal (real GUI, per-run cap CNY 8)', () => {
  it('the money cap is the user-approved per-run CNY 8 and every worst-case call fits it', () => {
    const ledger = JSON.parse(readFileSync('installer/budget/live-contract-fill-ledger.json', 'utf8')) as { perRunCapMicros: number; currency: string };
    expect(ledger.currency).toBe('CNY');
    expect(ledger.perRunCapMicros).toBe(8_000_000);
    expect(t.cap.maxCostMicros).toBeLessThanOrEqual(ledger.perRunCapMicros);
    expect(t.proof.pricing.currency).toBe('CNY');
    const perCall = Math.ceil((t.proof.tokens.inputUpperBound * t.proof.pricing.inputRate + t.proof.tokens.outputUpperBound * t.proof.pricing.outputRate) / 1e6);
    expect(perCall).toBeLessThanOrEqual(t.cap.maxCostMicros);
    expect(t.cap.maxCalls).toBeLessThanOrEqual(1000);
    // Every single worst-case call is admissible under the token cap (approval ceiling 100M).
    expect(t.proof.tokens.inputUpperBound + t.proof.tokens.outputUpperBound).toBeLessThanOrEqual(t.cap.maxTokens);
    expect(t.cap.maxTokens).toBeLessThanOrEqual(100_000_000);
  });

  it('live contract-fill run 11 (42564411429): the call guard is not sized by worst-case tokens and does not stop a run long before its money cap', () => {
    // Run 11 ended GOAL_BUDGET_EXHAUSTED at 450 calls (= 93.77M / 208 384 worst-case tokens) after 5 of 6
    // steps with CNY 3.157935 of 8 spent. Settled calls count at their REAL usage in the goal envelope, so
    // the worst-case product is not a bound the run can reach; money and real tokens bound it instead.
    const run11 = { calls: 450, micros: 3_157_935 };
    expect(t.cap.maxCalls).toBe(1000);
    expect(t.cap.maxCalls * (run11.micros / run11.calls)).toBeGreaterThanOrEqual(0.85 * t.cap.maxCostMicros);
    expect(t.cap.maxCalls * (t.proof.tokens.inputUpperBound + t.proof.tokens.outputUpperBound)).toBeGreaterThan(t.cap.maxTokens);
    // live contract-fill run 4: 4096 cut whole-file writes -> 8192; run 5: documented max output 384K
    // (api-docs.deepseek.com/quick_start/pricing) -> 16384 headroom, configurable down.
    expect(customJob).toMatch(/COS_MODEL_MAX_OUTPUT_TOKENS: \$\{\{ vars\.HARK_LIVE_MAX_OUTPUT_TOKENS \|\| '16384' \}\}/u);
    expect(t.proof.tokens.outputUpperBound).toBe(16384);
  });

  it('runs only on explicit mode=custom, with job time covering the approved duration and the watchdog', () => {
    expect(wf).toMatch(/options: \[planning, execute, acceptance, custom\]/u);
    expect(wf).toMatch(/default: planning/u);
    expect(wf).toMatch(/live-goal:\n\s+if: inputs\.mode != 'custom'/u);
    expect(customJob).toMatch(/if: inputs\.mode == 'custom'/u);
    const jobMinutes = Number(/timeout-minutes:\s*(\d+)/u.exec(customJob)?.[1] ?? 0);
    const watchdog = Number(/LIVE_WATCHDOG_MS: '(\d+)'/u.exec(customJob)?.[1] ?? 0);
    expect(watchdog).toBeGreaterThan(t.cap.durationMs);
    expect(watchdog + 10 * 60_000).toBeLessThanOrEqual(jobMinutes * 60_000);
    expect(customJob).toMatch(/deepseek-flash\.contract-fill\.approval-template\.json/u);
    expect(customJob).toMatch(/verify-workflow-runs\.mjs --mode installer/u);
  });

  it('the goal text reaches the driver only through env (never interpolated into a script) and evidence is key-scanned', () => {
    expect(customJob).toMatch(/GOAL_TEXT: \$\{\{ inputs\.goal_text \}\}/u);
    const runBlocks = customJob.split('\n').filter((l) => !/^\s+GOAL_TEXT:/u.test(l)).join('\n');
    expect(runBlocks).not.toMatch(/inputs\.goal_text/u);
    expect(customJob).toMatch(/KEY LEAKED/u);
    expect(customJob).toMatch(/upload-artifact/u);
  });

  it('the driver acts only through the GUI, the app bridge and a read-only DB connection', () => {
    const driver = readFileSync('scripts/hark/live-goal-gui.mjs', 'utf8');
    expect(driver).not.toMatch(/apps\/desktop\/dist|@companyos\//u);
    expect(driver).toMatch(/readOnly: true/u);
    // run 11: the independent project check runs Python with UTF-8 stdio (runner cp1252 broke Chinese output)
    expect(driver).toMatch(/PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'/u);
    expect(driver).toMatch(/--remote-debugging-port/u);
    expect(driver).toMatch(/Page\.captureScreenshot/u);
    expect(driver).toMatch(/approval-card__approve/u);
    expect(driver).not.toMatch(/console\.log\([^)]*COMPANYOS_MODEL_API_KEY/u);
    for (const f of ['events.ndjson', 'progress.ndjson', 'live-goal.json', 'app-logs', 'workspace']) expect(driver).toContain(f);
  });
});

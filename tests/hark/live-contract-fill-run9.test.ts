/**
 * Live contract-fill run 9 (hark-live-goal 42429421366) regression: step 1 ran its whole 30-min
 * attempt (178 calls) with passing tests but never gave a final answer (prompt-only "answer when
 * done"; PDF export needed LibreOffice, which the runner lacked); the retry started over and the
 * step's spend share ran out (GOAL_STEP_SPEND_CAP_REACHED). Fixes:
 *  1. the live runner installs LibreOffice; the kernel task text says which external tools exist;
 *  2. wrap-up is a mechanism: each turn carries time/spend left, a forced WRAP-UP below threshold,
 *     and the attempt drains after a bounded wrap-up window (env-configurable thresholds);
 *  3. a timed-out / capped attempt whose last test run passed and proved every criterion is
 *     credited as done (files kept) instead of a blind retry;
 *  4. the planner keeps environment-dependent capabilities in their own step.
 */
import { readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTurnNoter,
  DEFAULT_WRAP_UP_THRESHOLDS,
  detectExternalTools,
  externalToolsLineOf,
  injectTurnNote,
  turnNoteOf,
  wrapUpThresholdsOf,
} from '../../apps/desktop/src/executor/attempt-wrap-up.js';
import {
  createVerifiedWorkTracker,
  criterionTestStatesOf,
  endedByTimeOrCap,
  testRunCountsOf,
  verifiedWorkCreditOf,
} from '../../apps/desktop/src/executor/verified-work-credit.js';
import { dshTaskTextOf, VERIFICATION_DIRECTIVE } from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import { startModelBroker, type ModelBrokerHandle } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';

const servers: Server[] = [];
const brokers: ModelBrokerHandle[] = [];
afterEach(async () => {
  brokers.splice(0).forEach((b) => b.close());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

/* ------------------------------------------------------------------ fix 2: wrap-up */

describe('run 9 fix 2: wrap-up thresholds are configurable', () => {
  it('defaults: 20% of the step cap left, 5 min to the attempt deadline, 12 wrap-up turns', () => {
    expect(DEFAULT_WRAP_UP_THRESHOLDS).toEqual({ stepSpendLeftRatio: 0.2, attemptMsLeft: 300_000, maxWrapUpTurns: 12 });
    expect(wrapUpThresholdsOf({})).toEqual(DEFAULT_WRAP_UP_THRESHOLDS);
  });
  it('reads COS_WRAPUP_* and rejects invalid values', () => {
    expect(wrapUpThresholdsOf({ COS_WRAPUP_STEP_SPEND_LEFT_RATIO: '0.3', COS_WRAPUP_ATTEMPT_MS_LEFT: '120000', COS_WRAPUP_MAX_TURNS: '4' }))
      .toEqual({ stepSpendLeftRatio: 0.3, attemptMsLeft: 120_000, maxWrapUpTurns: 4 });
    expect(wrapUpThresholdsOf({ COS_WRAPUP_STEP_SPEND_LEFT_RATIO: '1.5', COS_WRAPUP_ATTEMPT_MS_LEFT: '-1', COS_WRAPUP_MAX_TURNS: '0' })).toEqual(DEFAULT_WRAP_UP_THRESHOLDS);
    expect(wrapUpThresholdsOf({ COS_WRAPUP_STEP_SPEND_LEFT_RATIO: 'x', COS_WRAPUP_ATTEMPT_MS_LEFT: '1.5', COS_WRAPUP_MAX_TURNS: ' ' })).toEqual(DEFAULT_WRAP_UP_THRESHOLDS);
  });
});

describe('run 9 fix 2: every turn carries time and spend left; low resources force WRAP-UP', () => {
  const t = DEFAULT_WRAP_UP_THRESHOLDS;
  it('a plain status note while resources are ample', () => {
    const note = turnNoteOf({ attemptMsLeft: 20 * 60_000, stepSpentMicros: 1_000_000, stepCapMicros: 2_800_000 }, t);
    expect(note.wrapUp).toBe(false);
    expect(note.text).toMatch(/^\[CompanyOS status\] about 20 min left in this attempt, CNY 1\.80 of this step's CNY 2\.80 budget left\./u);
    expect(note.text).toContain('forces a wrap-up at 5 min or 20% of the step budget left');
  });
  it('without a step cap the note carries the time only', () => {
    const note = turnNoteOf({ attemptMsLeft: 10 * 60_000 }, t);
    expect(note.wrapUp).toBe(false);
    expect(note.text).not.toMatch(/CNY/u);
  });
  it('time at the threshold forces WRAP-UP (run 9: the attempt ran to its deadline)', () => {
    const note = turnNoteOf({ attemptMsLeft: 300_000, stepSpentMicros: 1_572_000, stepCapMicros: 2_800_000 }, t);
    expect(note).toMatchObject({ wrapUp: true, trigger: 'time' });
    expect(note.text).toMatch(/^\[CompanyOS WRAP-UP — mandatory\]/u);
    expect(note.text).toMatch(/Stop all new work now/u);
    expect(note.text).toMatch(/Run the project's tests once/u);
    expect(note.text).toMatch(/what is done .* and what remains/u);
  });
  it('spend at 20% of the step cap left forces WRAP-UP; both low names both', () => {
    expect(turnNoteOf({ attemptMsLeft: 20 * 60_000, stepSpentMicros: 2_240_000, stepCapMicros: 2_800_000 }, t)).toMatchObject({ wrapUp: true, trigger: 'spend' });
    expect(turnNoteOf({ attemptMsLeft: 20 * 60_000, stepSpentMicros: 2_239_999, stepCapMicros: 2_800_000 }, t)).toMatchObject({ wrapUp: false });
    expect(turnNoteOf({ attemptMsLeft: 1_000, stepSpentMicros: 2_700_000, stepCapMicros: 2_800_000 }, t)).toMatchObject({ wrapUp: true, trigger: 'time+spend' });
  });
  it('custom thresholds move the trigger', () => {
    const custom = { stepSpendLeftRatio: 0.5, attemptMsLeft: 600_000, maxWrapUpTurns: 2 };
    expect(turnNoteOf({ attemptMsLeft: 599_999 }, custom).wrapUp).toBe(true);
    expect(turnNoteOf({ attemptMsLeft: 20 * 60_000, stepSpentMicros: 1_400_000, stepCapMicros: 2_800_000 }, custom).wrapUp).toBe(true);
  });
  it('the wrap-up window is bounded: after maxWrapUpTurns the noter reports exhaustion', async () => {
    let left = 20 * 60_000;
    const noter = createTurnNoter({ thresholds: { ...t, maxWrapUpTurns: 2 }, status: async () => ({ attemptMsLeft: left }) });
    expect((await noter.next()).exhausted).toBe(false);
    left = 60_000;
    expect(await noter.next()).toMatchObject({ exhausted: false, note: { wrapUp: true } });
    expect((await noter.next()).exhausted).toBe(false);
    expect((await noter.next()).exhausted).toBe(true);
    expect(noter.wrapUpTurns()).toBe(3);
    expect(noter.trigger()).toBe('time');
  });
});

describe('run 9 fix 2: the note rides the LAST message only (prefix cache and role order intact)', () => {
  const body = (messages: unknown[]) => Buffer.from(JSON.stringify({ model: 'deepseek-flash', max_tokens: 16384, stream: true, messages }));
  it('appends to a trailing tool result, leaving every earlier message byte-identical', () => {
    const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'task' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] }, { role: 'tool', tool_call_id: 'c1', content: 'out' }];
    const out = JSON.parse(injectTurnNote(body(messages), 'NOTE')!.toString('utf8'));
    expect(out.messages.slice(0, 3)).toEqual(messages.slice(0, 3));
    expect(out.messages).toHaveLength(4);
    expect(out.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'out\n\nNOTE' });
    expect(out.model).toBe('deepseek-flash');
    expect(out.max_tokens).toBe(16384);
  });
  it('appends to a trailing user message (string or parts); adds a user message only after an assistant', () => {
    expect(JSON.parse(injectTurnNote(body([{ role: 'user', content: 'task' }]), 'N')!.toString()).messages).toEqual([{ role: 'user', content: 'task\n\nN' }]);
    expect(JSON.parse(injectTurnNote(body([{ role: 'user', content: [{ type: 'text', text: 'task' }] }]), 'N')!.toString()).messages[0].content)
      .toEqual([{ type: 'text', text: 'task' }, { type: 'text', text: 'N' }]);
    expect(JSON.parse(injectTurnNote(body([{ role: 'assistant', content: 'a' }]), 'N')!.toString()).messages).toEqual([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'N' }]);
  });
  it('leaves bodies it cannot safely change, and never exceeds the admission input bound', () => {
    expect(injectTurnNote(Buffer.from('not json'), 'N')).toBeNull();
    expect(injectTurnNote(Buffer.from('{"model":"m"}'), 'N')).toBeNull();
    expect(injectTurnNote(body([{ role: 'system', content: 'S' }]), 'N')).toBeNull();
    const b = body([{ role: 'user', content: 'task' }]);
    expect(injectTurnNote(b, 'N', b.byteLength + 2)).toBeNull();
    expect(injectTurnNote(b, 'N', b.byteLength + 100)).not.toBeNull();
  });
});

const recordingUpstream = async () => {
  const bodies: string[] = [];
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    });
  });
  servers.push(upstream);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, bodies };
};
const post = (url: string, payload: string) => new Promise<number>((resolve, reject) => {
  const req = request(`${url}/chat/completions`, { method: 'POST' }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode ?? 0)); });
  req.once('error', reject);
  req.end(payload);
});

describe('run 9 fix 2: the broker rewrites each request before admission and drains on exhaustion', () => {
  it('the upstream and the admission both see the body with the note; a drain refuses with 403 and stops admitting', async () => {
    const up = await recordingUpstream();
    const admitted: string[] = [];
    let drain = false;
    const broker = await startModelBroker({
      upstreamBaseURL: up.url,
      bearer: '',
      upstreamTimeoutMs: 5_000,
      rewriteRequest: async (b) => (drain ? { body: b, drain: true } : { body: injectTurnNote(b, '[CompanyOS status] x') ?? b }),
      admission: async (bytes) => {
        admitted.push(Buffer.from(bytes).toString('utf8'));
        return { signal: new AbortController().signal, maxOutputTokens: 10, release: () => undefined, settle: async () => undefined } as never;
      },
    });
    if (!broker.ok) throw broker.error;
    brokers.push(broker.value);
    const payload = JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'task' }] });
    expect(await post(broker.value.url, payload)).toBe(200);
    expect(JSON.parse(up.bodies[0]!).messages[0].content).toBe('task\n\n[CompanyOS status] x');
    expect(admitted[0]).toBe(up.bodies[0]);
    drain = true;
    expect(await post(broker.value.url, payload)).toBe(403);
    expect(up.bodies).toHaveLength(1);
    expect(admitted).toHaveLength(1);
    drain = false;
    // admission stays closed for the rest of the attempt (no relaunch can resume spending)
    expect(await post(broker.value.url, payload)).toBe(403);
    expect(up.bodies).toHaveLength(1);
  });

  it('the embedded provider wires it: per-turn noter, drain into the deadline drain, budget status from the request', () => {
    const src = readFileSync('apps/desktop/src/executor/dsh-executor-provider.ts', 'utf8');
    expect(src).toMatch(/rewriteRequest: async \(body: Buffer\) =>/u);
    expect(src).toMatch(/thresholds: embedded\.wrapUp \?\? wrapUpThresholdsOf\(process\.env\)/u);
    expect(src).toMatch(/request\.modelCallBudgetStatus\?\.\(\)/u);
    expect(src).toMatch(/drainForWrapUp = beginDeadlineDrain;/u);
    expect(src).toMatch(/injectTurnNote\(body, note\.text, request\.modelCallInputBoundBytes\)/u);
    const coordinator = readFileSync('apps/desktop/src/execution-safety-coordinator.ts', 'utf8');
    expect(coordinator).toMatch(/async stepBudget\(\)/u);
    const dispatch = readFileSync('apps/desktop/src/executor/provider-dispatch.ts', 'utf8');
    expect(dispatch).toMatch(/modelCallBudgetStatus: externalAdmission\.stepBudget/u);
  });
});

/* ------------------------------------------------------- fix 1: environment tools */

describe('run 9 fix 1: the kernel is told which external tools exist', () => {
  it('finds soffice on PATH, in a well-known dir, or reports it missing', () => {
    const onPath = detectExternalTools({ PATH: '/x;/lo' }, (p) => p === '/lo/soffice', undefined, ';');
    expect(onPath[0]).toMatchObject({ id: 'soffice', path: '/lo/soffice', onPath: true });
    expect(externalToolsLineOf(onPath)).toMatch(/^Environment \(detected by CompanyOS on this machine\): LibreOffice \(soffice\) is installed and on PATH \(\/lo\/soffice\)/u);
    const known = detectExternalTools({ PATH: '/x' }, (p) => p === '/usr/bin/soffice', undefined, ';');
    expect(known[0]).toMatchObject({ path: '/usr/bin/soffice', onPath: false });
    expect(externalToolsLineOf(known)).toMatch(/installed at \/usr\/bin\/soffice but not on PATH — call it by that absolute path/u);
    const missing = detectExternalTools({ PATH: '/x' }, () => false, undefined, ';');
    expect(missing[0]!.path).toBeNull();
    const line = externalToolsLineOf(missing)!;
    expect(line).toMatch(/LibreOffice \(soffice\) is NOT installed on this machine — do not search for it, install it or wait for it/u);
    expect(line).toMatch(/report a clear message/u);
  });

  it('the task text carries the environment line and the verification directive (objective stays first)', () => {
    const base = {
      attemptId: 'exa_1', attemptNumber: 1, taskId: 'tsk_1', runId: 'run_1', roleId: 'drole_1', taskKind: 'companyos:software-work',
      work: { objective: '实现合同模板解析核心库', acceptanceCriteria: [{ criterionId: 'docx-import-fields', requirement: '识别字段' }] },
    };
    const req = base as never;
    const text = dshTaskTextOf(req, { externalToolsLine: 'Environment (detected by CompanyOS on this machine): X.' });
    expect(text.split('\n')[0]).toBe('实现合同模板解析核心库');
    expect(text).toContain('Environment (detected by CompanyOS on this machine): X.');
    expect(text).toContain(VERIFICATION_DIRECTIVE);
    expect(VERIFICATION_DIRECTIVE).toMatch(/starting with the criterion id in brackets/u);
    expect(VERIFICATION_DIRECTIVE).toMatch(/when it says WRAP-UP/u);
    const noCriteria = dshTaskTextOf({ ...base, work: { objective: 'o' } } as never);
    expect(noCriteria).not.toContain(VERIFICATION_DIRECTIVE);
    expect(noCriteria).not.toContain('Environment (detected');
  });

  it('the live runner installs LibreOffice (timeout, retry, PATH, soffice --version) before the inline build and the driver', () => {
    const live = readFileSync('.github/workflows/hark-live-goal.yml', 'utf8');
    const custom = live.slice(live.indexOf('  live-goal-custom:'));
    const step = custom.slice(custom.indexOf('- name: Test environment - LibreOffice'), custom.indexOf('- uses: pnpm/action-setup@v4'));
    expect(step).toMatch(/not a CompanyOS dependency/u);
    expect(step).toMatch(/timeout-minutes: \d+/u);
    expect(step).toMatch(/choco install libreoffice-fresh -y --no-progress/u);
    expect(step).toMatch(/for \(\$i = 1; \(\$i -le 3\)/u);
    expect(step).toMatch(/C:\\Program Files\\LibreOffice\\program/u);
    expect(step).toMatch(/\$env:GITHUB_PATH/u);
    expect(step).toMatch(/soffice --version/u);
    expect(step).toMatch(/exit 1/u);
    const at = (s: string) => custom.indexOf(s);
    expect(at('- name: Test environment - LibreOffice')).toBeGreaterThan(0);
    expect(at('- name: Test environment - LibreOffice')).toBeLessThan(at('- uses: pnpm/action-setup@v4'));
    expect(at('- name: Test environment - LibreOffice')).toBeLessThan(at("- name: The user's goal through the installed GUI"));
  });
});

/* ------------------------------------------------- fix 3: credit verified work */

const ev = (o: unknown) => JSON.stringify(o);
const RUN9_NODE_TEST_OUTPUT = [
  '> contract-fill-core@0.1.0 test',
  '> node --test --test-isolation=none test/engine.test.js test/pdf.test.js',
  '',
  '✔ [docx-import-fields] 识别正文、页眉与表格中的可填字段 (96.4425ms)',
  '✔ [docx-import-fields] 结构化数据匹配字段且不串填甲乙方 (39.5109ms)',
  '✔ [fill-preserves-layout] 填充后保留段落、样式、表格与页面设置 (91.1467ms)',
  '✔ [pdf-export-available] LIBREOFFICE_PATH 可指向安装目录 (11.2097ms)',
  '﹣ [pdf-export-available] 导出 PDF 且中文内容与页面设置正确 (0.2321ms) # 未检测到 LibreOffice',
  'ℹ tests 5', 'ℹ suites 0', 'ℹ pass 4', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0', 'ℹ duration_ms 372.1205',
].join('\r\n');
const WITH_SOFFICE = RUN9_NODE_TEST_OUTPUT.replace('﹣ [pdf-export-available] 导出 PDF 且中文内容与页面设置正确 (0.2321ms) # 未检测到 LibreOffice', '✔ [pdf-export-available] 导出 PDF 且中文内容与页面设置正确 (812ms)')
  .replace('ℹ pass 4', 'ℹ pass 5').replace('ℹ skipped 1', 'ℹ skipped 0');
const criteria = [
  { criterionId: 'docx-import-fields', requirement: '识别字段' },
  { criterionId: 'fill-preserves-layout', requirement: '保留排版' },
  { criterionId: 'pdf-export-available', requirement: '导出 PDF' },
];
const stream = (testOutput: string, extra: string[] = []) => [
  ev({ type: 'session', sessionId: 's1' }),
  ev({ type: 'tool_call', callId: 'c1', tool: 'write', input: { file_path: 'src/fill.js', content: '…' } }),
  ev({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' }),
  ev({ type: 'tool_call', callId: 'c2', tool: 'pwsh', input: { command: 'npm test' } }),
  ev({ type: 'tool_result', callId: 'c2', status: 'completed', result: testOutput }),
  ...extra,
];
const track = (lines: string[]) => { const t = createVerifiedWorkTracker(); lines.forEach((l) => t.observe(l)); return t.evidence(); };
const credit = (lines: string[], outcome: { kind: string; stdoutText?: string; stderrText?: string } = { kind: 'timeout' }, extra: Partial<Parameters<typeof verifiedWorkCreditOf>[0]> = {}) =>
  verifiedWorkCreditOf({ outcome, evidence: track(lines), criteria, requiresFileDelivery: false, files: [{ path: 'src/fill.js', bytes: 10 }], filesTruncated: false, ...extra });

describe('run 9 fix 3: test-runner summaries and criterion mapping', () => {
  it('reads node:test, vitest, jest, mocha and pytest summaries', () => {
    expect(testRunCountsOf(WITH_SOFFICE)).toEqual({ passed: 5, failed: 0, skipped: 0 });
    expect(testRunCountsOf(RUN9_NODE_TEST_OUTPUT)).toEqual({ passed: 4, failed: 0, skipped: 1 });
    expect(testRunCountsOf(' Test Files  2 passed (2)\n      Tests  7 passed (7)\n')).toMatchObject({ passed: 7, failed: 0 });
    expect(testRunCountsOf('      Tests  1 failed | 6 passed (7)\n')).toMatchObject({ passed: 6, failed: 1 });
    expect(testRunCountsOf('Tests:       2 failed, 5 passed, 7 total')).toMatchObject({ passed: 5, failed: 2 });
    expect(testRunCountsOf('  4 passing (20ms)\n  1 failing\n')).toMatchObject({ passed: 4, failed: 1 });
    expect(testRunCountsOf('========== 3 passed, 1 skipped in 0.12s ==========')).toMatchObject({ passed: 3, failed: 0, skipped: 1 });
    expect(testRunCountsOf('npm ERR! missing script: test')).toBeNull();
  });
  it('maps bracketed criterion ids to pass / skip / fail lines', () => {
    const states = criterionTestStatesOf(RUN9_NODE_TEST_OUTPUT, criteria.map((c) => c.criterionId));
    expect(states.get('docx-import-fields')).toEqual(['pass', 'pass']);
    expect(states.get('pdf-export-available')).toEqual(['pass', 'skip']);
    expect(criterionTestStatesOf('✖ [a] broken (2ms)\n× [b] x\nnot ok 3 - [c] y\nok 4 - [d] z # SKIP', ['a', 'b', 'c', 'd']))
      .toEqual(new Map([['a', ['fail']], ['b', ['fail']], ['c', ['fail']], ['d', ['skip']]]));
  });
});

describe('run 9 fix 3: a timed-out attempt with verified work is credited, not blindly retried', () => {
  it('credits a timeout whose last test run passed and proves every criterion (files kept)', () => {
    const c = credit(stream(WITH_SOFFICE));
    expect(c).not.toBeNull();
    expect(c!.criteria).toEqual(['docx-import-fields', 'fill-preserves-layout', 'pdf-export-available']);
    expect(c!.run).toEqual({ command: 'npm test', passed: 5, failed: 0, skipped: 0 });
    expect(c!.finalText).toMatch(/^CompanyOS credited this step's verified work: the attempt ended because its time budget ran out/u);
    expect(c!.finalText).toContain('`npm test` — 5 passed, 0 failed');
    expect(c!.finalText).toContain('[pdf-export-available] 导出 PDF');
    expect(c!.finalText).toContain('Files kept in the workspace: src/fill.js');
  });
  it('credits an attempt stopped by the step spend cap / deadline refusal; never a cancel or transport failure', () => {
    expect(endedByTimeOrCap({ kind: 'provider-failed', stderrText: 'dsh: AUTH: 403 budget admission refused' })).toBe(true);
    expect(endedByTimeOrCap({ kind: 'provider-failed', stdoutText: ev({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message: '403 attempt deadline reached: no new model calls' } } }) })).toBe(true);
    expect(endedByTimeOrCap({ kind: 'provider-failed', stderrText: 'dsh: AUTH: 401 unauthorized' })).toBe(false);
    expect(endedByTimeOrCap({ kind: 'cancelled' })).toBe(false);
    expect(endedByTimeOrCap({ kind: 'transport-failed' })).toBe(false);
    expect(credit(stream(WITH_SOFFICE), { kind: 'provider-failed', stderrText: 'dsh: AUTH: 403 budget admission refused' })!.finalText).toMatch(/its spend budget was used up/u);
    expect(credit(stream(WITH_SOFFICE), { kind: 'cancelled' })).toBeNull();
  });
  it('run 9 as it happened is NOT credited: the PDF criterion was only skipped (soffice missing)', () => {
    expect(credit(stream(RUN9_NODE_TEST_OUTPUT))).toBeNull();
  });
  it('is not credited when the workspace changed after the passing run, the last run failed, or no test ran', () => {
    expect(credit(stream(WITH_SOFFICE, [ev({ type: 'tool_call', callId: 'c3', tool: 'edit', input: { file_path: 'src/fill.js' } })]))).toBeNull();
    expect(credit(stream(WITH_SOFFICE, [ev({ type: 'tool_call', callId: 'c3', tool: 'pwsh', input: { command: 'Set-Content src/x.js "y"' } })]))).toBeNull();
    // read-only inspection after the run keeps the credit; a fresh passing run re-establishes it
    expect(credit(stream(WITH_SOFFICE, [ev({ type: 'tool_call', callId: 'c3', tool: 'read', input: { file_path: 'README.md' } }), ev({ type: 'tool_result', callId: 'c3', status: 'completed', result: '…' })]))).not.toBeNull();
    expect(credit(stream(WITH_SOFFICE, [
      ev({ type: 'tool_call', callId: 'c3', tool: 'edit', input: { file_path: 'src/fill.js' } }),
      ev({ type: 'tool_call', callId: 'c4', tool: 'pwsh', input: { command: 'node --test test/engine.test.js test/pdf.test.js' } }),
      ev({ type: 'tool_result', callId: 'c4', status: 'completed', result: WITH_SOFFICE }),
    ]))).not.toBeNull();
    const failing = WITH_SOFFICE.replace('ℹ fail 0', 'ℹ fail 1').replace('✔ [fill-preserves-layout]', '✖ [fill-preserves-layout]');
    expect(credit(stream(WITH_SOFFICE, [ev({ type: 'tool_call', callId: 'c5', tool: 'pwsh', input: { command: 'npm test' } }), ev({ type: 'tool_result', callId: 'c5', status: 'completed', result: failing })]))).toBeNull();
    expect(credit([ev({ type: 'tool_call', callId: 'c1', tool: 'write', input: { file_path: 'a.js' } })])).toBeNull();
    expect(credit(stream(WITH_SOFFICE), { kind: 'timeout' }, { criteria: [] })).toBeNull();
  });
  it('is not credited when a criterion has no test, or the step needs a declared file delivery', () => {
    expect(credit(stream(WITH_SOFFICE), { kind: 'timeout' }, { criteria: [...criteria, { criterionId: 'mobile-ui', requirement: '移动端' }] })).toBeNull();
    expect(credit(stream(WITH_SOFFICE), { kind: 'timeout' }, { requiresFileDelivery: true })).toBeNull();
  });
  it('an npm install is never mistaken for a test run', () => {
    const e = track([ev({ type: 'tool_call', callId: 'c1', tool: 'pwsh', input: { command: 'npm install --save-dev vitest' } }), ev({ type: 'tool_result', callId: 'c1', status: 'completed', result: WITH_SOFFICE })]);
    expect(e.testRuns).toBe(0);
    expect(e.lastPassingRun).toBeNull();
  });
  it('the embedded provider credits before writing retry notes and records the credit as evidence', () => {
    const src = readFileSync('apps/desktop/src/executor/dsh-executor-provider.ts', 'utf8');
    expect(src).toMatch(/verifiedWork\.observe\(line\)/u);
    expect(src).toMatch(/if \(outcome\.kind !== 'succeeded' && credit === null\) \{/u);
    expect(src).toMatch(/'executor\.verified_work_credited'/u);
    expect(src).toMatch(/kind: 'succeeded',\n\s+exitCode: 0,/u);
  });
});

/* ------------------------------------------------------------- fix 4: planner */

describe('run 9 fix 4: environment-dependent capabilities get their own plan step', () => {
  it('the planner contract says so (guidance; the validator stays the authority)', () => {
    const src = readFileSync('packages/engine/src/planning/planner-runtime.ts', 'utf8');
    expect(src).toMatch(/Environment-dependent capabilities: work that depends on an external program or operating-system/u);
    expect(src).toMatch(/LibreOffice\/soffice/u);
    expect(src).toMatch(/is its OWN`,\n\s+`work item with its own acceptance criterion/u);
    expect(src).toMatch(/never mixed into the core`,\n\s+`library\/logic item/u);
  });
});


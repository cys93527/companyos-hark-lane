/**
 * LIVE-CONTRACT-FILL run 6 (hark-live-goal 42385697784, c7b2a4c): step 1 failed after three
 * kernel attempts each ending turn_end "error" (CNY 6.5 of the CNY 8 run), the UI said 3
 * dispatches had unknown usage while the ledger had every call KNOWN, and the evidence bundle
 * carried the agent's npm cache into a full artifact quota. Pinned here:
 *  1. the kernel's own error (message, code, stderr tail, last events) reaches the settled
 *     row, the goal workspace, the UI reason and the live summary;
 *  2. a retry resumes from compact prior-attempt notes and a project-only inventory, and one
 *     step may spend at most its share of the goal cap (blocked with a reason);
 *  3. usage coverage reads the settled ledger; a pre-network refusal is a proven zero;
 *  4. dependency stores and caches are never evidence, and the copy is bounded.
 * The ROOT CAUSE regression (compaction sizing) is pinned in h15d-context-window.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import type { BudgetReservation } from '@companyos/core';
import {
  attemptNotesOf,
  kernelErrorDetailLine,
  kernelEventsTailOf,
  kernelTurnErrorOf,
  parseAttemptNotes,
  renderAttemptNotes,
  textTailOf,
} from '../../apps/desktop/src/executor/kernel-failure-detail.js';
import {
  COMPACTION_HEADROOM_MAX_TOKENS,
  COMPACTION_SUMMARY_MAX_TOKENS,
  attemptNotesPathOf,
  resumedAttemptDirective,
  workspaceFileInventoryOf,
} from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import { COMPACTION_TOKENS_CAP } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';
import { createLatestAttemptFailureReader } from '../../apps/desktop/src/goal-attempt-failure.js';
import {
  DEFAULT_STEP_SPEND_CAP_RATIO,
  STEP_SPEND_CAP_REACHED,
  stepAtSpendCap,
  stepCapReached,
  stepSpendCapMicros,
  stepSpendCapRatioOf,
  stepSpendMicros,
} from '../../apps/desktop/src/step-spend-cap.js';
import { STANDING_ADMISSION_REFUSALS } from '../../apps/desktop/src/autonomy/goal-outcome-autonomy-driver.js';
import { projectGoalUsage, type UsageReader } from '../../apps/desktop/src/efficiency/goal-usage-projection.js';
import { attemptFailureLabel, blockerLabel } from '../../apps/renderer/src/failure-labels.js';
// @ts-expect-error untyped harness helper (.mjs)
import { collectWorkspaceEvidence, isEvidenceSkippedPath } from '../../scripts/hark/evidence-filter.mjs';
// @ts-expect-error untyped harness helper (.mjs)
import { summarize } from '../../scripts/hark/live-summary.mjs';

const line = (value: unknown): string => JSON.stringify(value);
const kernelStdout = [
  line({ type: 'session', sessionId: 'ses_1', cwd: 'C:/ws' }),
  line({ type: 'status', phase: 'turn_start', turn: 1 }),
  line({ type: 'tool_call', callId: 'c1', tool: 'shell', input: { command: 'npm install docx pdf-lib' } }),
  line({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'added 120 packages' }),
  line({ type: 'thinking', text: 'hidden reasoning' }),
  line({ type: 'text', text: '已完成 packages/core 的骨架，下一步写 docx 字段识别。' }),
  line({ type: 'tool_call', callId: 'c2', tool: 'write_file', input: { path: 'packages/core/src/fields.ts', content: 'x' } }),
  line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { message: 'This request exceeds the maximum context length CompanyOS admits for this run (96000 request bytes; got 101234).', code: 'CONTEXT_WINDOW_EXCEEDED' } } }),
].join('\n');

describe('run 6 fix 1: the kernel error detail is captured, not just the slug', () => {
  it('reads kind, code and message of the last failed turn; a later completed turn clears it', () => {
    expect(kernelTurnErrorOf(kernelStdout)).toEqual({
      kind: 'error',
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'This request exceeds the maximum context length CompanyOS admits for this run (96000 request bytes; got 101234).',
    });
    expect(kernelTurnErrorOf(`${kernelStdout}\n${line({ type: 'status', phase: 'turn_end', turn: 2, reason: { kind: 'completed' } })}`)).toBeNull();
    expect(kernelTurnErrorOf('not json\n{"type":"status"}')).toBeNull();
    const long = kernelTurnErrorOf(line({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message: 'x'.repeat(5000), code: 'UNKNOWN' } } }));
    expect(long?.message?.length).toBeLessThanOrEqual(600);
    expect(kernelErrorDetailLine(kernelTurnErrorOf(kernelStdout))).toMatch(/^CONTEXT_WINDOW_EXCEEDED: This request exceeds/u);
  });

  it('keeps a bounded tail of the last kernel events (no reasoning) and of stderr', () => {
    const tail = kernelEventsTailOf(kernelStdout, 4);
    expect(tail).toHaveLength(4);
    expect(tail[tail.length - 1]).toBe('status:turn_end:error');
    expect(tail.join(' ')).not.toMatch(/hidden reasoning/u);
    expect(tail.some((t) => t.startsWith('tool_call:write_file'))).toBe(true);
    expect(textTailOf('a'.repeat(5000)).length).toBeLessThanOrEqual(800);
  });

  it('the settled row, the goal workspace read, the UI reason and the live summary all carry it', async () => {
    const dispatch = readFileSync('apps/desktop/src/executor/provider-dispatch.ts', 'utf8');
    expect(dispatch).toMatch(/settledPayload\['kernelError'\]/u);
    expect(dispatch).toMatch(/settledPayload\['kernelEventsTail'\]/u);
    expect(dispatch).toMatch(/settledPayload\['stderrTail'\]/u);

    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE execution_attempts (id TEXT, run_id TEXT, task_id TEXT, state TEXT, failure_code TEXT, created_at TEXT, settled_at TEXT);
            CREATE TABLE events (aggregate_id TEXT, type TEXT, payload TEXT);
            CREATE TABLE agent_executions (execution_id TEXT, run_id TEXT, task_id TEXT, status TEXT, error_kind TEXT, error_message TEXT, finished_at TEXT);`);
    d.prepare('INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)').run('exa_1', 'run_exec', 'tsk_1', 'FAILED', 'PROVIDER_FAILED', 'a', 'b');
    d.prepare('INSERT INTO events VALUES (?, ?, ?)').run('exa_1', 'executor.dispatch_settled', JSON.stringify({
      outcome: 'provider-failed', reasonCode: 'EXECUTOR_KERNEL_TURN_ERROR', kernelError: kernelTurnErrorOf(kernelStdout),
    }));
    const failure = await createLatestAttemptFailureReader(d as never)(['run_exec']);
    expect(failure?.detailCode).toBe('EXECUTOR_KERNEL_TURN_ERROR');
    expect(failure?.detailMessage).toMatch(/^CONTEXT_WINDOW_EXCEEDED: This request exceeds the maximum context length/u);

    const label = attemptFailureLabel({ ...failure!, detailMessage: failure!.detailMessage ?? null });
    expect(label).toMatch(/^智能体内核异常结束（error）：CONTEXT_WINDOW_EXCEEDED: /u);
    expect(label!.length).toBeLessThanOrEqual('智能体内核异常结束（error）：'.length + 160);
    expect(attemptFailureLabel({ runId: 'r', taskId: 't', attemptId: 'a', failureCode: 'PROVIDER_FAILED', detailCode: null, settledAt: null })).toBe('执行器（智能体内核）运行失败');

    const dir = mkdtempSync(join(tmpdir(), 'run6-summary-'));
    try {
      writeFileSync(join(dir, 'live-goal.json'), JSON.stringify({
        result: 'INCOMPLETE',
        attemptFailures: [{ attemptId: 'exa_1', attemptNumber: 1, failureCode: 'PROVIDER_FAILED', reasonCode: 'EXECUTOR_KERNEL_TURN_ERROR', kernelError: kernelTurnErrorOf(kernelStdout), stderrTail: 'boom at line 3', kernelEventsTail: kernelEventsTailOf(kernelStdout) }],
      }));
      const lines: string[] = summarize(dir, { log: () => undefined });
      expect(lines.some((l) => /attempt failure exa_1 #1 PROVIDER_FAILED EXECUTOR_KERNEL_TURN_ERROR kernelError: error CONTEXT_WINDOW_EXCEEDED This request exceeds/u.test(l))).toBe(true);
      expect(lines.some((l) => l.includes('stderr tail: boom at line 3'))).toBe(true);
      expect(lines.some((l) => l.includes('last kernel events: ') && l.includes('status:turn_end:error'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const gui = readFileSync('scripts/hark/live-goal-gui.mjs', 'utf8');
    expect(gui).toMatch(/attemptFailures: \(\(\) => \{/u);
  });
});

describe('run 6 fix 2a: a retry resumes from compact notes, not a rediscovery', () => {
  it('builds bounded notes (actions, last note, why it ended) that round-trip and render', () => {
    const notes = attemptNotesOf({ taskId: 'tsk_1', attemptNumber: 1, outcome: 'provider-failed', endReason: 'EXECUTOR_KERNEL_TURN_ERROR', stdoutText: kernelStdout });
    expect(notes.commands).toEqual(['shell: npm install docx pdf-lib', 'write_file: packages/core/src/fields.ts']);
    expect(notes.lastAgentText).toBe('已完成 packages/core 的骨架，下一步写 docx 字段识别。');
    expect(notes.kernelError).toMatch(/^CONTEXT_WINDOW_EXCEEDED/u);
    const back = parseAttemptNotes(JSON.stringify(notes));
    expect(back).toEqual(notes);
    expect(parseAttemptNotes('{"schema":"other"}')).toBeNull();
    const rendered = renderAttemptNotes(notes);
    expect(rendered).toMatch(/^Summary of attempt 1 \(ended provider-failed, EXECUTOR_KERNEL_TURN_ERROR: CONTEXT_WINDOW_EXCEEDED/u);
    expect(rendered.length).toBeLessThanOrEqual(2400);
  });

  it('the resumed directive carries the notes and the installed-dependency hint; inventories skip caches', () => {
    const root = mkdtempSync(join(tmpdir(), 'run6-ws-'));
    try {
      mkdirSync(join(root, '.npm-cache', '_cacache', 'content-v2'), { recursive: true });
      for (let i = 0; i < 80; i++) writeFileSync(join(root, '.npm-cache', '_cacache', 'content-v2', `blob${String(i)}`), 'x');
      mkdirSync(join(root, 'node_modules', 'docx'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'docx', 'index.js'), 'x');
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'ARCHITECTURE.md'), '# arch');
      writeFileSync(join(root, 'package.json'), '{}');
      const inventory = workspaceFileInventoryOf(root);
      expect(inventory.files.map((f) => f.path)).toEqual(['docs/ARCHITECTURE.md', 'package.json']);
      expect(inventory.truncated).toBe(false);
      const notes = renderAttemptNotes(attemptNotesOf({ taskId: 'tsk_1', attemptNumber: 1, outcome: 'provider-failed', endReason: null, stdoutText: kernelStdout }));
      const directive = resumedAttemptDirective({ attemptNumber: 2, files: inventory.files, filesTruncated: false, priorNotes: notes, dependenciesInstalled: true });
      expect(directive).toMatch(/^RESUMED STEP \(attempt 2\)/u);
      expect(directive).toContain('docs/ARCHITECTURE.md');
      expect(directive).toContain('Summary of attempt 1');
      expect(directive).toMatch(/do not reinstall them/u);
      expect(directive).not.toContain('.npm-cache');
      expect(attemptNotesPathOf(root, 'tsk/../x')).toBe(join(root, '.companyos', 'attempt-notes', 'tsk____x.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const provider = readFileSync('apps/desktop/src/executor/dsh-executor-provider.ts', 'utf8');
    // the notes are written after a failed attempt and read on the next one (never a session replay)
    expect(provider).toMatch(/writeFileSync\(notesPath, JSON\.stringify\(attemptNotesOf\(/u);
    expect(provider).toMatch(/parseAttemptNotes\(readFileSync\(notesPath, 'utf8'\)\)/u);
    expect(COMPACTION_TOKENS_CAP).toBe(COMPACTION_HEADROOM_MAX_TOKENS);
    expect(COMPACTION_TOKENS_CAP).toBe(COMPACTION_SUMMARY_MAX_TOKENS);
  });
});

const reservation = (ownerId: string, status: BudgetReservation['status'], boundMicros: number, costMicros?: number): BudgetReservation => ({
  callId: `${ownerId}:network:${String(Math.random())}`,
  runId: 'run_goal',
  ownerId,
  bound: { modelKey: 'm', inputTokens: 192000, outputTokens: 16384, costMicros: boundMicros, evidenceRef: 'sha256:x', validUntilMs: 1 },
  status,
  usage: costMicros === undefined ? null : { tokens: 1000, costMicros },
});

describe('run 6 fix 2b: per-step spend cap (default 35% of the goal cap)', () => {
  it('ratio parsing, cap and spend arithmetic', () => {
    expect(DEFAULT_STEP_SPEND_CAP_RATIO).toBe(0.35);
    expect(stepSpendCapRatioOf(undefined)).toBe(0.35);
    expect(stepSpendCapRatioOf('0.5')).toBe(0.5);
    expect(stepSpendCapRatioOf('0')).toBe(0.35);
    expect(stepSpendCapRatioOf('1.5')).toBe(0.35);
    expect(stepSpendCapRatioOf('abc')).toBe(0.35);
    expect(stepSpendCapMicros(8_000_000, 0.35)).toBe(2_800_000);
    const reservations = [
      reservation('exa_1', 'KNOWN', 515_072, 60_000),
      reservation('exa_1', 'UNKNOWN', 515_072),
      reservation('exa_2', 'RESERVED', 515_072),
      reservation('exa_other', 'KNOWN', 515_072, 999_999),
    ];
    // KNOWN counts its real cost; open / UNKNOWN calls count their bound
    expect(stepSpendMicros(reservations, new Set(['exa_1', 'exa_2']))).toBe(60_000 + 515_072 + 515_072);
    expect(stepCapReached(2_300_000, 515_072, 2_800_000)).toBe(true);
    expect(stepCapReached(2_200_000, 515_072, 2_800_000)).toBe(false);
    expect(stepCapReached(10, 10, 0)).toBe(false);
  });

  it('the standing check names the unfinished step at its share; a finished step never blocks', () => {
    const reservations = Array.from({ length: 50 }, () => reservation('exa_1', 'KNOWN', 515_072, 50_000));
    const attempts = new Map([['exa_1', { taskId: 'tsk_1', taskState: 'RUNNING' }]]);
    expect(stepAtSpendCap({ reservations, attempts, capMicros: 2_800_000 })).toBe('tsk_1');
    expect(stepAtSpendCap({ reservations, attempts: new Map([['exa_1', { taskId: 'tsk_1', taskState: 'DONE' }]]), capMicros: 2_800_000 })).toBeNull();
    expect(stepAtSpendCap({ reservations: reservations.slice(0, 10), attempts, capMicros: 2_800_000 })).toBeNull();
    expect(stepAtSpendCap({ reservations, attempts, capMicros: 0 })).toBeNull();
  });

  it('is enforced at admission, read as a standing block by the driver, and labelled for the boss', () => {
    expect(STANDING_ADMISSION_REFUSALS).toContain(STEP_SPEND_CAP_REACHED);
    const coordinator = readFileSync('apps/desktop/src/execution-safety-coordinator.ts', 'utf8');
    expect(coordinator).toMatch(/stepCapReached\(spent, proof\.costMicros, stepCapMicros\)/u);
    expect(coordinator).toMatch(/reason: STEP_SPEND_CAP_REACHED/u);
    const services = readFileSync('apps/desktop/src/core-services.ts', 'utf8');
    expect(services).toMatch(/taskId: request\.taskId/u);
    expect(services).toMatch(/executionSafety\.stepAtSpendCap\(runId\)/u);
    const composition = readFileSync('apps/desktop/src/production-composition.ts', 'utf8');
    expect(composition).toMatch(/stepSpendCapRatio: stepSpendCapRatioOf\(env\['COS_STEP_SPEND_CAP_RATIO'\]\)/u);
    expect(blockerLabel(STEP_SPEND_CAP_REACHED)).toMatch(/^已阻塞 · 单个步骤的花费已达上限/u);
  });
});

describe('run 6 fix 3: usage coverage reads the settled ledger', () => {
  const reader = (ledger: { costMicros: number; knownCalls: number; openCalls: number; currency: string | null } | null): UsageReader => ({
    runsOf: async () => [{ id: 'run_goal', state: 'FAILED' }],
    agentExecutions: async () => [],
    providerDispatches: async () => [{ attemptId: 'exa_1', providerKey: 'dsh' }, { attemptId: 'exa_2', providerKey: 'dsh' }, { attemptId: 'exa_3', providerKey: 'dsh' }, { attemptId: 'exa_4', providerKey: 'dsh' }],
    brokeredUsage: async () => new Map([
      ['exa_1', { inputTokens: 1000, outputTokens: 100, complete: true, exchanges: 3 }],
      ['exa_2', { inputTokens: 1000, outputTokens: 100, complete: false, exchanges: 3 }],
      ['exa_3', { inputTokens: 1000, outputTokens: 100, complete: false, exchanges: 3 }],
      ['exa_4', { inputTokens: 1000, outputTokens: 100, complete: false, exchanges: 3 }],
    ]),
    providerInvocations: async () => [],
    modelPricing: async () => null,
    modelKeyOf: async () => null,
    settledCost: async () => ledger,
  });

  it('a ledger with every call settled KNOWN means no unknown dispatch and full coverage', async () => {
    const projection = await projectGoalUsage(reader({ costMicros: 6_502_398, knownCalls: 171, openCalls: 0, currency: 'CNY' }), 'run_goal');
    expect(projection.usage.unknownDispatchCount).toBe(0);
    expect(projection.usage.coverageRatio).toBe(1);
    expect(projection.usage.complete).toBe(true);
    expect(projection.cost).toMatchObject({ state: 'KNOWN', knownScopeCost: 6.502398, currency: 'CNY', coverageComplete: true });
  });

  it('an open or UNKNOWN ledger call keeps the honest unknown count', async () => {
    const projection = await projectGoalUsage(reader({ costMicros: 1, knownCalls: 10, openCalls: 1, currency: 'CNY' }), 'run_goal');
    expect(projection.usage.unknownDispatchCount).toBe(3);
    expect(projection.usage.complete).toBe(false);
    const none = await projectGoalUsage(reader(null), 'run_goal');
    expect(none.usage.unknownDispatchCount).toBe(3);
  });

  it('a body refused before any upstream HTTP is a proven zero, not an unknown exchange', async () => {
    const { createDurableUsageReader } = await import('../../apps/desktop/src/efficiency/durable-usage-reader.js');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE events (aggregate_id TEXT, type TEXT, payload TEXT);');
    const add = db.prepare('INSERT INTO events VALUES (?, ?, ?)');
    add.run('exa_1', 'executor.model_exchange_observed', JSON.stringify({ usageDisposition: 'observed', endedBy: 'upstream-end', usage: { inputTokens: 100, outputTokens: 10 } }));
    add.run('exa_1', 'executor.model_exchange_observed', JSON.stringify({ usageDisposition: 'not-reached', endedBy: 'admission-context-exceeded', usage: null }));
    add.run('exa_2', 'executor.model_exchange_observed', JSON.stringify({ usageDisposition: 'observed', endedBy: 'upstream-end', usage: { inputTokens: 100, outputTokens: 10 } }));
    // a call that reached the network and ended without usage stays UNKNOWN
    add.run('exa_2', 'executor.model_exchange_observed', JSON.stringify({ usageDisposition: 'not-reached', endedBy: 'timeout', usage: null }));
    const usage = await createDurableUsageReader({ db: db as never, runs: { get: async () => null } } as never, 'company_default').brokeredUsage!(['exa_1', 'exa_2']);
    expect(usage.get('exa_1')).toEqual({ inputTokens: 100, outputTokens: 10, complete: true, exchanges: 1 });
    expect(usage.get('exa_2')?.complete).toBe(false);
  });
});

describe('run 6 fix 4: dependency stores and caches are never evidence; the copy is bounded', () => {
  it('skips node_modules / npm caches / pnpm store and bounds per file and total', () => {
    expect(isEvidenceSkippedPath('.npm-cache\\_cacache\\content-v2\\sha512\\00')).toBe(true);
    expect(isEvidenceSkippedPath('apps/web/node_modules/x/index.js')).toBe(true);
    expect(isEvidenceSkippedPath('.pnpm-store/v3/files')).toBe(true);
    expect(isEvidenceSkippedPath('packages/core/src/index.ts')).toBe(false);
    const root = mkdtempSync(join(tmpdir(), 'run6-ev-'));
    const dest = mkdtempSync(join(tmpdir(), 'run6-ev-out-'));
    try {
      mkdirSync(join(root, '.npm-cache', '_cacache'), { recursive: true });
      writeFileSync(join(root, '.npm-cache', '_cacache', 'blob'), 'x'.repeat(1000));
      mkdirSync(join(root, 'node_modules', 'a'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'a', 'i.js'), 'x');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'a'.repeat(100));
      writeFileSync(join(root, 'src', 'b.ts'), 'b'.repeat(100));
      writeFileSync(join(root, 'big.bin'), 'z'.repeat(5000));
      const result = collectWorkspaceEvidence(root, dest, { maxFileBytes: 4096, maxTotalBytes: 150 });
      expect(result.files.map((f: { path: string }) => f.path.replace(/\\/gu, '/'))).toEqual(['big.bin', 'src/a.ts', 'src/b.ts']);
      expect(result.skippedDirs.map((d: { path: string; count: number }) => [d.path, d.count])).toEqual([['.npm-cache', 1], ['node_modules', 1]]);
      expect(result.copied).toBe(1);
      expect(result.omitted.map((o: { path: string }) => o.path.replace(/\\/gu, '/'))).toEqual(['big.bin', 'src/b.ts']);
      expect(readFileSync(join(dest, 'src', 'a.ts'), 'utf8')).toBe('a'.repeat(100));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
    const gui = readFileSync('scripts/hark/live-goal-gui.mjs', 'utf8');
    expect(gui).toMatch(/collectWorkspaceEvidence\(out\.workspace, join\(evidence, 'workspace'\)\)/u);
    expect(gui).not.toMatch(/cpSync\(out\.workspace/u);
  });
});

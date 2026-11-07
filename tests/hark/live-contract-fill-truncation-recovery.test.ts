/**
 * LIVE-CONTRACT-FILL run 4 (hark-live-goal 42346111946): one model reply cut at the
 * output ceiling mid file-write failed the whole goal. The attempt now recovers in place:
 * files already written stay, the kernel is relaunched with a continuation directive
 * (what was truncated, which files exist, write the rest one file/part per reply), and
 * only after bounded continuations does it fail with the typed reason.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dshTaskTextOf, KERNEL_OUTPUT_CEILING, OUTPUT_CEILING_CONTINUATION_MIN_REMAINING_MS, OUTPUT_CEILING_MAX_CONTINUATIONS,
  outputCeilingContinuationDirective, outputCeilingDirective, postProcessDshOutcome, runWithOutputCeilingRecovery, workspaceFileInventoryOf,
} from '../../apps/desktop/src/executor/dsh-executor-provider.js';

const truncated = {
  kind: 'provider-failed', exitCode: 1, stderrText: '',
  stdoutText: ['{"type":"session","sessionId":"session-1"}', '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"max-tokens"}}'].join('\n'),
} as const;
const succeeded = {
  kind: 'succeeded', exitCode: 0, startedAt: 'Sat 2026-11-07 2:29 PM CST (UTC+08:00)', finishedAt: 'Sat 2026-11-07 2:30 PM CST (UTC+08:00)',
  stdoutText: '{"type":"session","sessionId":"session-1"}\n{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
} as const;

const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'cos-trunc-'));
  mkdirSync(join(root, 'contractfill'));
  writeFileSync(join(root, 'contractfill', 'docx_reader.py'), 'x'.repeat(13197));
  writeFileSync(join(root, 'contractfill', 'errors.py'), 'y'.repeat(1271));
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'skip');
  return root;
};

describe('output-ceiling truncation recovery inside the attempt (live contract-fill run 4)', () => {
  it('a truncated reply is continued on the same workspace and the step can still succeed', async () => {
    const root = workspace();
    const calls: { timeoutMs: number; directive: string | undefined }[] = [];
    const outcomes = [truncated, succeeded];
    const result = await runWithOutputCeilingRecovery({
      workspaceRoot: root, outputCeilingTokens: 8192, timeoutMs: 600_000,
      start: async (timeoutMs, directive) => { calls.push({ timeoutMs, directive }); return outcomes.shift() as never; },
    });
    expect(result.outcome.kind).toBe('succeeded');
    expect(result.continuations).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.directive).toBeUndefined();
    const directive = calls[1]!.directive!;
    expect(directive).toMatch(/^CONTINUATION 1 of 3 of this same attempt/u);
    expect(directive).toMatch(/reached the per-response output limit \(~8192 tokens\) and was cut off; the tool call in that reply .* was NOT applied/u);
    expect(directive).toContain('contractfill/docx_reader.py (13197 B)');
    expect(directive).toContain('contractfill/errors.py (1271 B)');
    expect(directive).not.toContain('node_modules');
    expect(directive).toMatch(/ONE file or ONE part per reply, each part at most about 128 lines/u);
    expect(calls[1]!.timeoutMs).toBeLessThanOrEqual(600_000);
  });

  it('fails only after the bounded continuations, keeping the typed reason', async () => {
    let n = 0;
    const result = await runWithOutputCeilingRecovery({
      workspaceRoot: workspace(), outputCeilingTokens: 4096, timeoutMs: 600_000,
      start: async () => { n += 1; return truncated as never; },
    });
    expect(n).toBe(1 + OUTPUT_CEILING_MAX_CONTINUATIONS);
    expect(result.continuations).toBe(OUTPUT_CEILING_MAX_CONTINUATIONS);
    expect(result.outcome.kind).toBe('provider-failed');
    expect((postProcessDshOutcome(result.outcome) as { reasonCode?: string }).reasonCode).toBe(KERNEL_OUTPUT_CEILING);
  });

  it('never continues other failures, an aborted attempt, or past the attempt deadline', async () => {
    const other = { ...truncated, stdoutText: '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error"}}' };
    let n = 0;
    await runWithOutputCeilingRecovery({ workspaceRoot: workspace(), timeoutMs: 600_000, start: async () => { n += 1; return other as never; } });
    expect(n).toBe(1);
    const aborted = new AbortController(); aborted.abort();
    n = 0;
    await runWithOutputCeilingRecovery({ workspaceRoot: workspace(), timeoutMs: 600_000, signal: aborted.signal, start: async () => { n += 1; return truncated as never; } });
    expect(n).toBe(1);
    let clock = 0;
    n = 0;
    await runWithOutputCeilingRecovery({
      workspaceRoot: workspace(), timeoutMs: 100_000, now: () => clock,
      start: async () => { n += 1; clock += 100_000 - OUTPUT_CEILING_CONTINUATION_MIN_REMAINING_MS + 1; return truncated as never; },
    });
    expect(n).toBe(1);
  });

  it('the continuation directive is rendered last in the task text; inventory is bounded', () => {
    const req = { attemptId: 'exa_1', attemptNumber: 1, taskId: 'tsk_1', runId: 'run_1', roleId: 'drole_1', taskKind: 'companyos:software-work', work: { objective: 'goal', acceptanceCriteria: [] } } as never;
    const directive = outputCeilingContinuationDirective({ continuation: 2, maxContinuations: 3, outputCeilingTokens: 8192, files: [], filesTruncated: false });
    expect(directive).toContain('The workspace has no files yet.');
    const text = dshTaskTextOf(req, { outputCeilingTokens: 8192, continuationDirective: directive });
    expect(text.split('\n')[0]).toBe('goal');
    expect(text.split('\n').at(-1)).toBe(directive);
    expect(text).toContain(outputCeilingDirective(8192));
    expect(outputCeilingDirective(8192)).toMatch(/one file \(or one part of a file\) per reply/u);
    const root = mkdtempSync(join(tmpdir(), 'cos-inv-'));
    for (let i = 0; i < 70; i += 1) writeFileSync(join(root, `f${String(i).padStart(2, '0')}.py`), 'z');
    const inv = workspaceFileInventoryOf(root);
    expect(inv.files).toHaveLength(60);
    expect(inv.truncated).toBe(true);
  });
});

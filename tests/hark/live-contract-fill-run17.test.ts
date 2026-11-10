/**
 * Live contract-fill run 17 (hark-live-goal 42730130436) regression.
 *
 * The generated app's own suite passed 78/78, yet every `repo.test-check` ended `timedOut` and
 * three corrective rounds never fixed it:
 *   1. the validator's output capture kept the FIRST 32 KiB of output and then dropped the rest,
 *      so the "last output" of a test contract stopped by its deadline was its early passing
 *      tests, never the test still running;
 *   2. the corrective task reached the kernel with only the cited ids
 *      (`causeEvidenceRefs: ["val_…", "art_…"]`) — the kernel searched the workspace for the
 *      validation id and never learned that the test command ran past the deadline or which
 *      grounding claims were unsupported.
 * The capture is now a rolling window of the most recent output, and a corrective task's text
 * carries the failing validators' reports.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { CONTRACT_DEADLINE_MARKER, keepRecentOutput, runRepoTestContract } from '../../apps/desktop/src/repo-test-process.js';
import {
  CORRECTIVE_CAUSE_HEADER,
  CORRECTIVE_CAUSE_LIMITS,
  correctiveCauseLinesOf,
  correctiveValidationIdsOf,
  type CorrectiveCauseReader,
} from '../../apps/desktop/src/executor/corrective-cause-detail.js';
import { dshTaskTextOf } from '../../apps/desktop/src/executor/dsh-executor-provider.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) { super(); }
  kill(): boolean { return true; }
}

/** The run-17 corrective lineage, byte-shaped like the durable task row. */
const correctiveInputs = {
  corrective: {
    schemaVersion: 'companyos/corrective-task/1',
    reasonCode: 'VALIDATION_FAILED',
    parentTaskId: 'tsk_d15badb6e687cba199adca691d',
    round: 1,
    causeEvidenceRefs: ['val_01M71JHYRSZJ43YX03SA0TMP2R', 'art_01M71FSVRX8RGQPM0R0ZJABVV2', 'val_GROUNDING'],
  },
};

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const reader = (overrides: Partial<Record<string, unknown>> = {}): CorrectiveCauseReader => {
  const validations: Record<string, { validatorId: string; status: string; evidenceRefs: string[] }> = {
    val_01M71JHYRSZJ43YX03SA0TMP2R: {
      validatorId: 'repo.test-check',
      status: 'fail',
      evidenceRefs: ['command:validation:x:repo.test-check', 'artifact:art_01M71FSVRX8RGQPM0R0ZJABVV2', 'artifact:art_REPORT_TEST'],
    },
    val_GROUNDING: {
      validatorId: 'evidence.grounding-check',
      status: 'fail',
      evidenceRefs: ['artifact:art_01M71FSVRX8RGQPM0R0ZJABVV2', 'artifact:art_REPORT_GROUND'],
    },
  };
  const artifacts: Record<string, { kind: string; contentRef: string }> = {
    art_01M71FSVRX8RGQPM0R0ZJABVV2: { kind: 'companyos:executor-output', contentRef: 'sha256:out' },
    art_REPORT_TEST: { kind: 'companyos/repo-test-check-report', contentRef: 'sha256:test' },
    art_REPORT_GROUND: { kind: 'companyos/evidence-grounding-report', contentRef: 'sha256:ground' },
  };
  const contents: Record<string, Uint8Array> = {
    'sha256:out': new TextEncoder().encode('final text of the step'),
    'sha256:test': encode({
      verdict: 'fail',
      command: 'node test/all.test.js',
      exitCode: 1,
      timedOut: true,
      outputTail: `${CONTRACT_DEADLINE_MARKER} 测试脚本超过 510000 ms 仍未结束，进程树已终止。最后输出：\n✔ [pdf-env-available] 真实转换实证 (21339.687ms)\n候选探测：soffice.exe → ETIMEDOUT`,
      reasons: ['the workspace test contract exceeded the validator deadline (510000 ms after a 4000 ms snapshot copy) and its process tree was ended; see outputTail for the last output.'],
    }),
    'sha256:ground': encode({
      verdict: 'fail',
      unsupported: ['named path not found in workspace: test/pdf-smoke.test.js'],
      reasons: ['1 unsupported factual claim(s) detected.'],
    }),
  };
  return {
    validation: async (id) => (overrides['validation'] as CorrectiveCauseReader['validation'] | undefined)?.(id) ?? validations[id] ?? null,
    artifact: async (id) => artifacts[id] ?? null,
    content: async (ref) => contents[ref] ?? null,
  };
};

describe('live contract-fill run 17: the validator keeps the END of the test output', () => {
  it('keepRecentOutput keeps the most recent characters', () => {
    expect(keepRecentOutput('abc', 'def', 4)).toBe('cdef');
    expect(keepRecentOutput('', 'xy', 4)).toBe('xy');
  });

  it('a long contract stopped by its deadline reports the test still running, not its first tests', async () => {
    const root = new FakeChild(9);
    const fakeSpawn = (() => {
      setTimeout(() => {
        root.stdout.write(`FIRST-TEST-OUTPUT ${'x'.repeat(40_000)}\n`);
        root.stderr.write('warning on stderr\n');
        root.stdout.write('▶ [criteria-export-pdf-available] still converting with soffice …');
      }, 5);
      return root;
    }) as never;
    const result = await runRepoTestContract(
      { cwd: 'C:\\ws', timeoutMs: 60 },
      { spawn: fakeSpawn, platform: 'win32', settleGraceMs: 10, killTree: () => { setTimeout(() => root.emit('close', 1), 1); } },
    );
    expect(result.timedOut).toBe(true);
    expect(result.outputTail).toContain('still converting with soffice');
    expect(result.outputTail).toContain('warning on stderr');
    expect(result.outputTail).not.toContain('FIRST-TEST-OUTPUT');
  });
});

describe('live contract-fill run 17: a corrective task is told why it is redone', () => {
  it('resolves only the cited validation ids', () => {
    expect(correctiveValidationIdsOf(correctiveInputs)).toEqual(['val_01M71JHYRSZJ43YX03SA0TMP2R', 'val_GROUNDING']);
    expect(correctiveValidationIdsOf({})).toEqual([]);
    expect(correctiveValidationIdsOf(null)).toEqual([]);
  });

  it('renders the failing reports: timeout + last output, unsupported claims', async () => {
    const lines = await correctiveCauseLinesOf(correctiveInputs, reader());
    const text = lines.join('\n');
    expect(lines[0]).toBe(CORRECTIVE_CAUSE_HEADER);
    expect(text).toContain('- repo.test-check failed; running `node test/all.test.js` in a fresh copy of the workspace');
    expect(text).toMatch(/did not finish before the validator deadline/u);
    expect(text).toContain('soffice.exe → ETIMEDOUT');
    expect(text).toContain('- evidence.grounding-check failed');
    expect(text).toContain('named path not found in workspace: test/pdf-smoke.test.js');
    expect(text.length).toBeLessThanOrEqual(CORRECTIVE_CAUSE_LIMITS.maxTotalChars + 200);
  });

  it('a passing or missing validation adds nothing; an unreadable report still names the validator', async () => {
    expect(await correctiveCauseLinesOf({ corrective: { causeEvidenceRefs: ['val_missing'] } }, reader())).toEqual([]);
    const broken: CorrectiveCauseReader = {
      validation: async () => ({ validatorId: 'repo.test-check', status: 'fail', evidenceRefs: ['artifact:a'] }),
      artifact: async () => { throw new Error('store down'); },
      content: async () => null,
    };
    const lines = await correctiveCauseLinesOf({ corrective: { causeEvidenceRefs: ['val_1'] } }, broken);
    expect(lines).toEqual([CORRECTIVE_CAUSE_HEADER, '- repo.test-check failed (its report could not be read).']);
  });

  it('the kernel task text carries the causes before the engineering practice', async () => {
    const correctiveCauses = await correctiveCauseLinesOf(correctiveInputs, reader());
    const text = dshTaskTextOf({
      attemptId: 'exa_1', attemptNumber: 1, taskId: 'tsk_1', runId: 'run_1', roleId: 'drole_1', taskKind: 'companyos:software-work',
      work: { objective: '实现预览编辑与 Word/PDF 导出', taskInputs: correctiveInputs, correctiveCauses },
    } as never);
    expect(text.split('\n')[0]).toBe('实现预览编辑与 Word/PDF 导出');
    expect(text).toContain(CORRECTIVE_CAUSE_HEADER);
    expect(text.indexOf(CORRECTIVE_CAUSE_HEADER)).toBeLessThan(text.indexOf('Engineering practice'));
  });

  it('the composition resolves the causes and the dispatch carries them to the executor', () => {
    const services = readFileSync('apps/desktop/src/core-services.ts', 'utf8');
    expect(services).toMatch(/correctiveCauseLinesOf\(workEnvelope\.taskInputs/u);
    const dispatch = readFileSync('apps/desktop/src/executor/provider-dispatch.ts', 'utf8');
    expect(dispatch).toMatch(/correctiveCauses: envelope\.value\.correctiveCauses/u);
  });
});

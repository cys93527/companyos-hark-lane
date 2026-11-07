/**
 * LIVE-CONTRACT-FILL run 5: the kernel hand-wrote a zip inflater, an XML parser and a docx
 * loader (zero dependencies) and the plan of a Chinese goal was written in English.
 * The kernel task text and the planner contract now carry the engineering practice and the
 * language rule (guidance only).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { dshTaskTextOf, ENGINEERING_PRACTICE_DIRECTIVE } from '../../apps/desktop/src/executor/dsh-executor-provider.js';

describe('run 5: generation guidance', () => {
  const req = { attemptId: 'exa_1', attemptNumber: 1, taskId: 'tsk_1', runId: 'run_1', roleId: 'drole_1', taskKind: 'companyos:software-work', work: { objective: '做一个合同自动填写应用', acceptanceCriteria: [] } } as never;

  it('the kernel task text asks for mature libraries via the package manager, never hand-rolled format parsers', () => {
    const text = dshTaskTextOf(req);
    expect(text.split('\n')[0]).toBe('做一个合同自动填写应用');
    expect(text).toContain(ENGINEERING_PRACTICE_DIRECTIVE);
    expect(ENGINEERING_PRACTICE_DIRECTIVE).toMatch(/package manager/u);
    expect(ENGINEERING_PRACTICE_DIRECTIVE).toMatch(/official registry/u);
    expect(ENGINEERING_PRACTICE_DIRECTIVE).toMatch(/docxtemplater with pizzip/u);
    expect(ENGINEERING_PRACTICE_DIRECTIVE).toMatch(/soffice --headless --convert-to pdf/u);
    expect(ENGINEERING_PRACTICE_DIRECTIVE).toMatch(/Never hand-write parsers or writers for zip, XML, docx, PDF/u);
    expect(ENGINEERING_PRACTICE_DIRECTIVE).toMatch(/same natural language as the objective/u);
  });

  it('the planner contract asks for the goal language and library-first software plans', () => {
    const planner = readFileSync('packages/engine/src/planning/planner-runtime.ts', 'utf8');
    expect(planner).toMatch(/write every objective and requirement in the same natural language as the stated/u);
    expect(planner).toMatch(/a Chinese objective gets a Chinese plan/u);
    expect(planner).toMatch(/mature, well-known libraries installed through the/u);
  });
});

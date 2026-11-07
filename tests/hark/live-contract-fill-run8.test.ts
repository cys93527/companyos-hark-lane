/**
 * Live contract-fill run 8 (hark-live-goal 42419993676) regression: step 1 of a 6-step plan
 * ("parse the .docx template and detect fillable fields") ran 192 model calls and wrote the
 * WHOLE app (server, UI, paste entry, preview, PDF export) — the kernel saw the full goal and
 * nothing said the goal is split into steps that run separately — until the step's spend share
 * ran out (GOAL_STEP_SPEND_CAP_REACHED). The task text now carries the plan position, marks the
 * other steps as not this task's work, and tells the kernel to finish once this step's own
 * criteria are met.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dshTaskTextOf, planContextLinesOf, STEP_SCOPE_DIRECTIVE } from '../../apps/desktop/src/executor/dsh-executor-provider.js';

const request = (planContext?: unknown) => ({
  attemptId: 'exa_1', attemptNumber: 1, taskId: 'tsk_1', runId: 'run_1', roleId: 'drole_1', taskKind: 'companyos:software-work',
  work: {
    objective: '基于成熟的 Word 文档解析库实现合同模板解析与可填充字段自动识别',
    memoryView: ['Goal: 开发一个跨平台的合同自动填写软件'],
    acceptanceCriteria: [{ criterionId: 'c1', requirement: '识别占位符与下划线空白' }],
    ...(planContext === undefined ? {} : { planContext }),
  },
}) as never;

const plan = {
  position: 1, total: 3,
  steps: [
    { objective: '基于成熟的 Word 文档解析库实现合同模板解析与可填充字段自动识别', current: true },
    { objective: '实现手动输入与粘贴两种数据录入方式', current: false },
    { objective: '实现预览编辑与 Word/PDF 导出界面', current: false },
  ],
};

describe('run 8: a plan step is told it is one step and to stay in its scope', () => {
  it('renders the plan position, marks the other steps as not this task, and adds the scope directive', () => {
    const text = dshTaskTextOf(request(plan));
    const lines = text.split('\n');
    expect(lines[0]).toBe('基于成熟的 Word 文档解析库实现合同模板解析与可填充字段自动识别');
    expect(text).toContain('Plan position: this task is step 1 of 3 of the goal\'s plan.');
    expect(text).toContain('- step 1 (THIS task): 基于成熟的 Word 文档解析库实现合同模板解析与可填充字段自动识别');
    expect(text).toContain('- step 2 (another task — not yours): 实现手动输入与粘贴两种数据录入方式');
    expect(text).toContain('- step 3 (another task — not yours): 实现预览编辑与 Word/PDF 导出界面');
    expect(text).toContain(STEP_SCOPE_DIRECTIVE);
    // the plan position comes before the engineering practice and the final-answer line
    expect(text.indexOf('Plan position')).toBeLessThan(text.indexOf('Engineering practice'));
    expect(STEP_SCOPE_DIRECTIVE).toMatch(/do not implement them now/u);
    expect(STEP_SCOPE_DIRECTIVE).toMatch(/limited share of the goal's budget/u);
    expect(STEP_SCOPE_DIRECTIVE).toMatch(/final answer as soon as this step's acceptance criteria are met/u);
  });

  it('a single-step goal (or no plan) gets no plan lines', () => {
    expect(planContextLinesOf(undefined)).toEqual([]);
    expect(planContextLinesOf({ position: 1, total: 1, steps: [{ objective: 'x', current: true }] })).toEqual([]);
    expect(dshTaskTextOf(request())).not.toContain('Plan position');
    expect(dshTaskTextOf(request())).not.toContain(STEP_SCOPE_DIRECTIVE);
  });

  it('the plan context is projected from the pinned plan and carried to the executor', () => {
    const projector = readFileSync('packages/engine/src/projection/work-package-projector.ts', 'utf8');
    expect(projector).toMatch(/plan-item objectives in pinned order/u);
    const services = readFileSync('apps/desktop/src/core-services.ts', 'utf8');
    expect(services).toMatch(/planContext: \{/u);
    const dispatch = readFileSync('apps/desktop/src/executor/provider-dispatch.ts', 'utf8');
    expect(dispatch).toMatch(/planContext: envelope\.value\.planContext/u);
  });
});

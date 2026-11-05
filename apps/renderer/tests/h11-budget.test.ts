// H11 — budget/spend/UNKNOWN + previewed-plan read model (renderer). No DOM, no IO.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { budgetRows, formatMoney, loadGoalBudget, parseGoalBudgetRead } from '../src/budget.js';
import { RuntimePanelView } from '../src/runtime-panel.js';
import { ChatView } from '../src/chat.js';
import { projectPlanSteps } from '../src/plan-steps.js';

const bucket = (calls: number, tokens: number, costMicros: number) => ({ calls, tokens, costMicros });
const live = {
  budget: {
    state: 'ACTIVE', goalRunId: 'run_x', currency: 'CNY',
    cap: { ...bucket(6, 200000, 1_000_000), deadlineMs: 1 },
    settled: bucket(1, 1769, 5740), unknown: bucket(0, 0, 0), held: bucket(0, 0, 0),
    remaining: bucket(5, 198231, 994260), worstCaseCostMicros: 5740, notes: [],
  },
  plan: {
    artifactId: 'art_1',
    items: [{ planItemId: 'create-hello-txt', objective: 'Create hello.txt', taskKind: 'companyos:software-work' }],
    criteria: [{ criterionId: 'hello-file-exists', requirement: 'A file named hello.txt exists.' }],
  },
};

describe('H11 budget read model', () => {
  it('renders the H10b live run exactly (settled ¥0.00574, cap ¥1.00)', () => {
    const read = parseGoalBudgetRead(live);
    expect(read).not.toBeNull();
    const rows = budgetRows(read!.budget);
    expect(rows[0]).toBe('费用 · 预算生效中');
    expect(rows).toContain('上限 · ¥1.00 · 6 次调用 · 200000 tokens');
    expect(rows).toContain('已结算 · ¥0.00574 · 1 次 · 1769 tokens');
    expect(rows.some((r) => r.startsWith('未确认'))).toBe(false);
  });

  it('shows UNKNOWN as "up to bound", never as zero or settled', () => {
    const read = parseGoalBudgetRead({ ...live, budget: { ...live.budget, settled: bucket(0, 0, 0), unknown: bucket(1, 32000, 112000), worstCaseCostMicros: 112000 } });
    const rows = budgetRows(read!.budget);
    expect(rows).toContain('未确认 · 1 次 · 最多 ¥0.112（不会自动重试）');
    expect(rows).toContain('已结算 · ¥0.00 · 0 次 · 0 tokens');
  });

  it('rejects malformed projections instead of guessing', () => {
    expect(parseGoalBudgetRead({ budget: { ...live.budget, settled: { calls: -1, tokens: 0, costMicros: 0 } } })).toBeNull();
    expect(parseGoalBudgetRead({ budget: { ...live.budget, currency: 'BTC' } })).toBeNull();
    expect(parseGoalBudgetRead({ budget: { ...live.budget, state: 'WHATEVER' } })).toBeNull();
    expect(parseGoalBudgetRead(null)).toBeNull();
  });

  it('formats currencies and raw units honestly', () => {
    expect(formatMoney(1_000_000, null)).toBe('1.00 单位');
    expect(formatMoney(2_500_000, 'USD')).toBe('$2.50');
  });

  it('a failed run.budget read renders nothing', async () => {
    const bridge = { controlPlaneRequest: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'x' } }) };
    expect(await loadGoalBudget(bridge as never, 'run_x')).toBeNull();
    expect(await loadGoalBudget(bridge as never, null)).toBeNull();
  });

  it('the runtime panel shows spend and the previewed plan before any task exists', () => {
    const html = renderToStaticMarkup(h(RuntimePanelView, {
      open: true, expanded: true, tab: 'run',
      lifecycle: null, artifacts: [], timeline: [], taskDetail: null,
      budget: parseGoalBudgetRead(live),
      onToggleExpanded: () => undefined, onSelectTab: () => undefined, onSelectTask: () => undefined,
    }));
    expect(html).toContain('已结算 · ¥0.00574');
    // UI-PAPER-INK: the previewed plan moved from the runtime panel into the goal page's
    // timeline (one place, with canonical step states); before any execution stage exists
    // every step is 待开始 while the Goal is live and 未执行 once it ended.
    const read = parseGoalBudgetRead(live)!;
    const liveSteps = projectPlanSteps({ items: read.plan!.items, execution: null, phase: 'planning', outcome: null });
    const page = renderToStaticMarkup(h(ChatView, {
      objective: 'x', entries: [{ kind: 'goal-accepted', runId: 'run_x', objective: 'x' }], loading: false, failure: null,
      planSteps: liveSteps, criteria: read.plan!.criteria,
    }));
    expect(page).toContain('规划完成 · 1 步 · 1 条验收标准');
    expect(page).toContain('Create hello.txt');
    expect(page).toContain('待开始');
    expect(page).toContain('验收 · A file named hello.txt exists.');
    const ended = projectPlanSteps({ items: read.plan!.items, execution: null, phase: 'completed', outcome: 'COMPLETED' });
    expect(ended[0]?.label).toBe('未执行');
  });
});

/**
 * Requirement 10 — minimal deterministic branching, and its effect on execution.
 */
import { describe, expect, it } from 'vitest';

import type { BranchSet } from '@companyos/core';

import { makeFixture, must, STAGE_ID } from './support.js';

const BRANCHES: BranchSet = {
  defaultBranch: 'safe',
  rules: [
    { id: 'high-risk-needs-slow-path', when: [{ field: 'risk.level', op: 'eq', value: 'HIGH' }], to: 'fast' },
    { id: 'large-change', when: [{ field: 'change.lines', op: 'gt', value: 500 }], to: 'fast' },
  ],
};

describe('deterministic branch selection', () => {
  it('is a pure function of the context', () => {
    const fixture = makeFixture();
    const context = { risk: { level: 'HIGH' }, change: { lines: 12 } };

    const first = fixture.engine.planBranch(BRANCHES, context);
    const second = fixture.engine.planBranch(BRANCHES, context);
    expect(first).toEqual(second);
    expect(first).toEqual({ branch: 'fast', ruleId: 'high-risk-needs-slow-path' });
  });

  it('takes the first matching rule, and the declared default otherwise', () => {
    const fixture = makeFixture();
    expect(
      fixture.engine.planBranch(BRANCHES, { risk: { level: 'LOW' }, change: { lines: 900 } }).ruleId,
    ).toBe('large-change');
    expect(fixture.engine.planBranch(BRANCHES, { risk: { level: 'LOW' } })).toEqual({
      branch: 'safe',
      ruleId: null,
    });
    expect(fixture.engine.planBranch({ defaultBranch: 'only', rules: [] }, {}).branch).toBe('only');
  });

  it('uses the selected branch to pick the stage handler', async () => {
    // The `fast` branch has a handler that always fails; the default branch succeeds.
    const fastFixture = makeFixture({
      script: { 'fast:pack-a:build': ['failed', 'failed', 'failed', 'failed'] },
    });
    const fastRun = await fastFixture.seedRun();
    const fastTask = await fastFixture.seedTask();
    const fastResult = must(
      await fastFixture.engine.drive(fastRun.id, {
        plan: { branchSet: BRANCHES, context: { risk: { level: 'HIGH' } } },
        stage: { stageId: STAGE_ID, taskIds: [fastTask.id] },
      }),
    );
    expect(fastResult.run.state).toBe('FAILED');

    const safeFixture = makeFixture({ script: { 'fast:pack-a:build': ['failed'] } });
    const safeRun = await safeFixture.seedRun();
    const safeTask = await safeFixture.seedTask();
    const safeResult = must(
      await safeFixture.engine.drive(safeRun.id, {
        plan: { branchSet: BRANCHES, context: { risk: { level: 'LOW' } } },
        stage: { stageId: STAGE_ID, taskIds: [safeTask.id] },
      }),
    );
    expect(safeResult.run.state).toBe('COMPLETED');
  });

  it('accepts an explicit branch without rules', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 }));
    const planning = await fixture.engine.readRun(run.id);

    must(
      await fixture.engine.dispatch(
        fixture.command(planning!, 'PLAN.COMPLETE', { payload: { branch: 'fast' } }),
      ),
    );
    expect((await fixture.engine.readRun(run.id))?.state).toBe('ROUTING');
  });

  it('falls back to the default branch when the context matches nothing', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 }));
    const planning = await fixture.engine.readRun(run.id);

    must(
      await fixture.engine.dispatch(
        fixture.command(planning!, 'PLAN.COMPLETE', {
          payload: { branchSet: BRANCHES, branchContext: { risk: { level: 'LOW' } } },
        }),
      ),
    );
    expect((await fixture.engine.readRun(run.id))?.state).toBe('ROUTING');
  });
});

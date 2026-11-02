/**
 * AUDIT-E2 regression (engine area).
 * A run left non-terminal with a durable cancel intent (user cancelled, then the app quit before
 * RUN.CANCEL committed) used to make engine.recover() report 'unrecoverable' although it had
 * cancelled the run, so startup recovery failed closed (desktop exit 1) and a healthy run in the
 * same scan was never recovered. Also: one genuinely unrecoverable run must not stop the scan.
 */
import { describe, expect, it } from 'vitest';
import {
  ok,
  FixedClock,
  SequenceIdFactory,
  createWorkflowRun,
  type Approval,
  type Task,
  type WorkflowRun,
} from '@companyos/core';
import {
  createInMemoryEntityStore,
  createInMemoryEventStore,
  createScriptedRegistry,
  createWorkflowEngine,
  createStartupRecoveryOrchestrator,
} from '@companyos/engine';

const setup = () => {
  const clock = new FixedClock(Date.parse('2026-04-01T00:00:00.000Z'));
  const ids = new SequenceIdFactory();
  const runs = createInMemoryEntityStore<WorkflowRun>();
  const tasks = createInMemoryEntityStore<Task>();
  const intents = new Set<string>();
  const cancellation = {
    async request(id: string) { intents.add(id); },
    async requested(id: string) { return intents.has(id); },
  };
  const engine = createWorkflowEngine({
    ids, clock, runs, tasks,
    approvals: createInMemoryEntityStore<Approval>(),
    events: createInMemoryEventStore(),
    handlers: createScriptedRegistry({}),
    cancellation,
  });
  const mk = async (): Promise<WorkflowRun> => {
    const r = createWorkflowRun({ companyId: 'cmp_1' as never, workflowId: 'w' as never, templateId: 't' as never, versionId: 'v' as never, snapshotId: 's' as never, startedBy: 'user_owner', now: clock.nowIso(), ids });
    if (!r.ok) throw new Error(r.error.message);
    const executing = { ...r.value, state: 'EXECUTING' as const };
    await runs.put(executing);
    return executing;
  };
  const orchestrate = (eng: Parameters<typeof createStartupRecoveryOrchestrator>[0]['engine']) =>
    createStartupRecoveryOrchestrator({
      actorId: 'user_owner',
      runtime: { recoverInterrupted: async () => ok([]) },
      tools: { recoverInvocations: async () => ok({ interrupted: [], waitingApproval: [] } as never) },
      engine: eng,
      runs,
    }).run();
  return { runs, intents, engine, mk, orchestrate };
};

describe('AUDIT-E2 startup recovery honours durable cancel intent', () => {
  it('cancel-intent run is reported cancelled (not a failure) and the healthy run is recovered', async () => {
    const f = setup();
    const cancelled = await f.mk();
    const healthy = await f.mk();
    f.intents.add(cancelled.id); // durable intent committed, RUN.CANCEL never landed
    const report = await f.orchestrate(f.engine);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.runsCancelled).toBe(1);
      expect(report.value.runsRecovered).toBe(1);
    }
    expect((await f.runs.get(cancelled.id))?.state).toBe('FAILED');
    expect((await f.runs.get(healthy.id))?.state).toBe('EXECUTING');
  });

  it('frozen port recover() keeps its two outcomes: honoured cancel maps to unrecoverable', async () => {
    const f = setup();
    const run = await f.mk();
    f.intents.add(run.id);
    expect(await f.engine.recover(run.id)).toBe('unrecoverable');
    expect((await f.runs.get(run.id))?.state).toBe('FAILED');
  });

  it('one unrecoverable / throwing run does not stop the scan; every failure is reported', async () => {
    const f = setup();
    const bad = await f.mk();
    const boom = await f.mk();
    const healthy = await f.mk();
    const recovered: string[] = [];
    const report = await f.orchestrate({
      recover: f.engine.recover,
      async recoverOutcome(runId: string) {
        if (runId === bad.id) return 'unrecoverable';
        if (runId === boom.id) throw new Error('store gone');
        recovered.push(runId);
        return f.engine.recoverOutcome(runId);
      },
    });
    expect(recovered).toEqual([healthy.id]);
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.error.details['reason']).toBe('RUN_RECOVERY_FAILED');
      expect(report.error.details['runId']).toBe(bad.id);
      const failures = report.error.details['failures'] as readonly { runId: string; phase: string; cause?: string }[];
      expect(failures.map((x) => x.runId)).toEqual([bad.id, boom.id]);
      expect(failures[1]?.cause).toContain('store gone');
    }
  });
});

/**
 * UI-PAPER-INK interaction audit — control-plane contract fixes the renderer relies on.
 *
 *  UI-AUDIT-04  approval.respond is bound to the approval row the user SAW (approvalId):
 *               a stale/superseded/decided request is refused typed (CONFLICT APPROVAL_STALE)
 *               and nothing is resumed or denied.
 *  UI-AUDIT-05  an APPROVE on a Goal with a durable cancellation intent is refused typed
 *               (CANCELLED APPROVAL_GOAL_CANCELLED); deny stays possible.
 *  UI-AUDIT-22  decisions.pending pages through EVERY run (a pending approval of a live run
 *               beyond the first 100 runs used to be dropped).
 *  UI-PAPER-INK run.budget plan items carry their compiled stageId (compiledNodeId).
 */
import { describe, expect, it } from 'vitest';

import { compiledNodeId } from '@companyos/engine';
import { createControlPlaneService, GOAL_WORK_KIND } from '../../apps/desktop/src/control-plane.js';

const NOT = { ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never };

interface ApprovalRow {
  id: string; runId: string; taskId: string | null; riskLevel: string; status: string; reason: string;
  requestedBy: string; requestedAt: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
}

const row = (id: string, status: string): ApprovalRow => ({
  id, runId: 'run_a', taskId: 'tsk_1', riskLevel: 'MEDIUM', status, reason: 'install dev dependency',
  requestedBy: 'agent', requestedAt: '2026-11-04T00:00:00.000Z', decidedBy: null, decidedAt: null, decisionNote: null,
});

const service = (opts: {
  approvals?: ApprovalRow[];
  cancelled?: boolean;
  runs?: { id: string; companyId: string; state: string; workflowId?: string }[];
  plan?: { command: string; content: unknown };
} = {}) => {
  const resumed: string[] = [];
  const denied: string[] = [];
  const runs = opts.runs ?? [{ id: 'run_a', companyId: 'company_default', state: 'WAITING_APPROVAL' }];
  const listCalls: { limit?: number; offset?: number }[] = [];
  const svc = createControlPlaneService({
    companyId: 'company_default',
    actorId: 'user_owner',
    clock: { nowIso: () => '2026-11-04T00:00:00.000Z' },
    ids: { id: (prefix: string) => `${prefix}_x` },
    currentWorkspace: () => null,
    tasks: { listByRun: () => Promise.resolve([]) },
    runs: {
      get: (runId: string) => Promise.resolve((runs.find((r) => r.id === runId) ?? null) as never),
      list: (page?: { limit?: number; offset?: number }) => {
        listCalls.push(page ?? {});
        const offset = page?.offset ?? 0;
        const limit = page?.limit ?? 100;
        return Promise.resolve({ items: runs.slice(offset, offset + limit) as never, total: runs.length });
      },
    },
    templates: { list: () => Promise.resolve({ items: [], total: 0 }) },
    lifecycle: { createTemplate: () => Promise.resolve(NOT), saveDraftGraph: () => Promise.resolve(NOT), publish: () => Promise.resolve(NOT), createRun: () => Promise.resolve(NOT) },
    engine: {
      drive: () => Promise.resolve(NOT),
      dispatch: (command: { runId: string }) => {
        denied.push(command.runId);
        return Promise.resolve({ ok: true as const, value: { duplicate: false } as never });
      },
    },
    materializer: null,
    planner: null,
    compiler: null,
    supervisor: {
      run: () => Promise.resolve(NOT),
      resumeEscalatedRun: (input: { runId: string }) => {
        resumed.push(input.runId);
        return Promise.resolve({ ok: true as const, value: { resumed: true } as never });
      },
    } as never,
    observation: {
      getRunBlockers: () => Promise.resolve({ ok: true as const, value: [] as never }),
    } as never,
    runGoal: null,
    artifacts: {
      listByRun: () => Promise.resolve(opts.plan === undefined ? [] : [{ id: 'art_plan', kind: 'companyos:plan' }]),
      getByCreationCommand: () => Promise.resolve(opts.plan === undefined ? null : { artifact: { id: 'art_plan', contentRef: 'ref' } }),
      commandIdOf: () => Promise.resolve(opts.plan === undefined ? null : opts.plan.command),
      readContent: () => Promise.resolve(opts.plan === undefined ? null : new TextEncoder().encode(JSON.stringify(opts.plan.content))),
    },
    approvals: { listByRun: () => Promise.resolve(opts.approvals ?? []) },
    ...(opts.cancelled === undefined ? {} : { isGoalCancelled: () => Promise.resolve(opts.cancelled === true) }),
    ...(opts.plan === undefined ? {} : {
      goalBudget: {
        read: () => Promise.resolve(null),
        now: () => Date.parse('2026-11-04T00:00:00.000Z'),
        currency: 'CNY',
      },
    }),
    workProfile: { stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 3 },
  } as never);
  return { svc, resumed, denied, listCalls };
};

const respond = (svc: ReturnType<typeof service>['svc'], payload: Record<string, unknown>) =>
  svc.handle({ operation: 'approval.respond', payload: { companyId: 'company_default', runId: 'run_a', ...payload } }) as Promise<{
    ok: boolean; error?: { code: string; details?: Record<string, unknown> };
  }>;

describe('UI-AUDIT-04 approval decisions are bound to the approval the user saw', () => {
  it('approves when the named approval is the current pending row', async () => {
    const h = service({ approvals: [row('apr_1', 'pending')] });
    const result = await respond(h.svc, { decision: 'approve', approvalId: 'apr_1' });
    expect(result.ok).toBe(true);
    expect(h.resumed).toEqual(['run_a']);
  });

  it('refuses a superseded approval typed and resumes nothing', async () => {
    const h = service({ approvals: [row('apr_1', 'approved'), row('apr_2', 'pending')] });
    const result = await respond(h.svc, { decision: 'approve', approvalId: 'apr_1' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONFLICT');
    expect(result.error?.details?.['reason']).toBe('APPROVAL_STALE');
    expect(result.error?.details?.['currentApprovalId']).toBe('apr_2');
    expect(h.resumed).toEqual([]);
  });

  it('refuses a deny of an already decided approval and dispatches nothing', async () => {
    const h = service({ approvals: [row('apr_1', 'denied')] });
    const result = await respond(h.svc, { decision: 'deny', approvalId: 'apr_1' });
    expect(result.error?.details?.['reason']).toBe('APPROVAL_STALE');
    expect(h.denied).toEqual([]);
  });

  it('an invalid approvalId is a typed argument error', async () => {
    const h = service({ approvals: [row('apr_1', 'pending')] });
    const result = await respond(h.svc, { decision: 'approve', approvalId: 42 });
    expect(result.ok).toBe(false);
    expect(h.resumed).toEqual([]);
  });
});

describe('UI-AUDIT-05 a cancelled Goal is never resumed by an approval', () => {
  it('refuses approve with CANCELLED, still allows deny', async () => {
    const h = service({ approvals: [row('apr_1', 'pending')], cancelled: true });
    const approve = await respond(h.svc, { decision: 'approve', approvalId: 'apr_1' });
    expect(approve.ok).toBe(false);
    expect(approve.error?.code).toBe('CANCELLED');
    expect(approve.error?.details?.['reason']).toBe('APPROVAL_GOAL_CANCELLED');
    expect(h.resumed).toEqual([]);
    const deny = await respond(h.svc, { decision: 'deny', approvalId: 'apr_1' });
    expect(deny.ok).toBe(true);
    expect(h.denied).toEqual(['run_a']);
  });
});

describe('UI-AUDIT-22 decisions.pending sees every live run', () => {
  it('pages past the first page of runs', async () => {
    const runs = Array.from({ length: 450 }, (_, i) => ({ id: `run_${String(i).padStart(3, '0')}`, companyId: 'company_default', state: 'COMPLETED' }));
    runs.push({ id: 'run_late', companyId: 'company_default', state: 'WAITING_APPROVAL' });
    const h = service({ runs, approvals: [] });
    const result = (await h.svc.handle({ operation: 'decisions.pending', payload: { companyId: 'company_default' } })) as {
      ok: boolean; value?: { pending: { runId: string }[] };
    };
    expect(result.ok).toBe(true);
    expect(result.value?.pending.map((entry) => entry.runId)).toEqual(['run_late']);
    expect(h.listCalls.length).toBeGreaterThan(1);
  });
});

describe('UI-PAPER-INK run.budget plan items carry their compiled stage', () => {
  it('stageId = compiledNodeId(planId from the plan artifact command, planItemId)', async () => {
    const h = service({
      runs: [{ id: 'run_a', companyId: 'company_default', state: 'EXECUTING' }],
      plan: {
        command: 'plan:pln_123',
        content: { planItems: [{ planItemId: 'P1', objective: 'one' }, { planItemId: 'P2', objective: 'two' }], acceptanceCriteria: [{ criterionId: 'C1', requirement: 'r' }] },
      },
    });
    const result = (await h.svc.handle({ operation: 'run.budget', payload: { companyId: 'company_default', runId: 'run_a' } })) as {
      ok: boolean; value?: { plan: { items: { planItemId: string; stageId: string | null }[] } | null };
      error?: unknown;
    };
    expect(result.ok, JSON.stringify(result.error ?? null)).toBe(true);
    expect(result.value?.plan?.items).toEqual([
      expect.objectContaining({ planItemId: 'P1', stageId: compiledNodeId('pln_123', 'P1') }),
      expect.objectContaining({ planItemId: 'P2', stageId: compiledNodeId('pln_123', 'P2') }),
    ]);
  });
});

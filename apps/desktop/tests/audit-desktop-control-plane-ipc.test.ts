/**
 * AUDIT-D7 (+R7 main side): approving a decision resumes the waiting Goal's autonomy driver, and a throwing
 * control-plane / workflow handler answers with the typed envelope instead of rejecting the renderer's invoke.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createControlPlaneIpcHandler, handlerFailureEnvelope, neverReject } from '../src/control-plane-ipc.js';

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

const harness = (respond: (request: unknown) => Promise<unknown>) => {
  const started: string[] = [];
  let resumes = 0;
  let release: (() => void) | null = null;
  const handler = createControlPlaneIpcHandler({
    companyId: 'co',
    handle: respond,
    autonomy: () => ({
      start: (_c, runId) => { started.push(runId); },
      resumeNonTerminalGoalRuns: async () => { resumes += 1; await new Promise<void>((r) => { release = r; }); return ['g1']; },
    }),
  });
  return { handler, started, resumes: () => resumes, release: () => release?.() };
};

describe('AUDIT-D7 approval resumes autonomy; handlers never reject', () => {
  it('a successful approve resumes the non-terminal Goals (single-flight)', async () => {
    const h = harness(async () => ({ ok: true, value: { runId: 'exec-1', decision: 'approve', resumed: true } }));
    await h.handler({ operation: 'approval.respond', payload: { decision: 'approve' } });
    await h.handler({ operation: 'approval.respond', payload: { decision: 'approve' } });
    expect(h.resumes()).toBe(1);
    h.release();
    await flush();
    await h.handler({ operation: 'approval.respond', payload: { decision: 'approve' } });
    expect(h.resumes()).toBe(2);
  });

  it('deny, refused approvals and reads resume nothing; goal.create starts its driver', async () => {
    const deny = harness(async () => ({ ok: true, value: { runId: 'r', decision: 'deny' } }));
    await deny.handler({ operation: 'approval.respond' });
    const refused = harness(async () => ({ ok: false, error: { code: 'CONFLICT', message: 'x', details: {} } }));
    await refused.handler({ operation: 'approval.respond' });
    expect(deny.resumes() + refused.resumes()).toBe(0);
    const create = harness(async () => ({ ok: true, value: { runId: 'goal-9' } }));
    await create.handler({ operation: 'goal.create' });
    expect(create.started).toEqual(['goal-9']);
  });

  it('a throwing handler answers a typed envelope (DomainError keeps its code)', async () => {
    const plain = harness(async () => { throw new Error('boom'); });
    await expect(plain.handler({ operation: 'run.usage' })).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR', message: '内部错误：boom', details: { reason: 'CONTROL_PLANE_HANDLER_FAILED' } },
    });
    const domain = harness(async () => { throw Object.assign(new Error('gone'), { code: 'NOT_FOUND', details: { id: 'x' } }); });
    await expect(domain.handler({})).resolves.toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'gone', details: { id: 'x' } } });
    await expect(neverReject(async () => { throw 'str'; }, 'WORKFLOW_HANDLER_FAILED')).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(handlerFailureEnvelope({ code: 'lower', message: 'm' }, 'R').error.code).toBe('INTERNAL_ERROR');
  });

  it('main.ts routes both channels through the wrapper', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain('return controlPlaneIpc(core)(withSessionActor(request));');
    expect(main).toContain("return neverReject(async () => api.handle(withSessionActor(request)), 'WORKFLOW_HANDLER_FAILED', logger);");
    expect(main).not.toContain('await core.controlPlane.handle(withSessionActor(request))');
  });
});

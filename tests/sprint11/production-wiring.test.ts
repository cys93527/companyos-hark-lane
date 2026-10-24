/**
 * Sprint 11 production closeout (A–O): the REAL production shape.
 *
 * Real SQLite file, real durable chain set, real AuthorizationService (Role → Authority), real
 * HandoffStore, real EventStore, real createHandoffService with the same dependency shape as
 * `apps/desktop/src/main.ts`, and the real IPC entry point (`createWorkflowApi`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { defineEvent, previousHandoffTextOf, type HandoffPacket } from '@companyos/core';
import { createAuthorizationService, createHandoffService, type HandoffAuditPayload, type HandoffService } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { createWorkflowApi } from '../../apps/desktop/src/workflows.js';
import { EXPECTED_COMPOSITION_CHAINS } from '../shared/expected-chains.js';

const tempDirs: string[] = [];
const makeDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s11p-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const clock = { now: () => 1_800_000_000_000, nowIso: () => '2027-06-01T10:00:00.000Z' };

const openDb = (dataDir: string): DurableDatabase =>
  openDurableDatabase({ dataDir, appliedAt: clock.nowIso(), chains: [...EXPECTED_COMPOSITION_CHAINS] });

/** The production composition-root shape (main.ts), against real stores + real authz. */
interface Prod {
  readonly db: DurableDatabase;
  readonly api: ReturnType<typeof createWorkflowApi>;
  readonly service: HandoffService;
  readonly assignRole: (actorId: string, roleId: string) => Promise<void>;
  readonly roleIdOf: (key: string) => string;
  readonly packet: (overrides?: Record<string, unknown>) => Record<string, unknown>;
}

const buildProd = async (
  db: DurableDatabase,
  overrides: { readonly runtime?: unknown } = {},
): Promise<Prod> => {
  if (db.handoffStore === null) throw new Error('the handoff chain must be enabled');
  let seq = 0;
  const ids = { id: (prefix?: string) => `${prefix ?? 'id'}_${String((seq += 1))}` };
  const authz = createAuthorizationService({
    ids: ids as never,
    clock: clock as never,
    roles: db.roles,
    assignments: db.roleAssignments,
  });
  const developer = await authz.defineRole({
    companyId: 'company_default',
    key: 'developer',
    name: 'Developer',
    authorities: ['handoff.create', 'handoff.read'],
  });
  const reviewer = await authz.defineRole({
    companyId: 'company_default',
    key: 'reviewer',
    name: 'Reviewer',
    authorities: ['handoff.read', 'handoff.accept', 'handoff.reject'],
  });
  if (!developer.ok || !reviewer.ok) throw new Error('role provisioning failed');

  const audit =
    (type: string) =>
    async (payload: HandoffAuditPayload): Promise<void> => {
      await db.events.append([
        defineEvent(
          {
            type,
            aggregateId: payload.handoffId,
            aggregateType: 'Handoff',
            traceId: payload.traceId,
            actorId: payload.actorId,
            payload: { ...payload },
          },
          { id: (p?: string) => `${p ?? 'evt'}_${String((seq += 1))}`, ulid: () => `01HZZZZZZZZZZZZZZZZZZZ${String(seq)}` } as never,
          clock.nowIso(),
        ),
      ]);
    };

  // Sprint 13 (ADR-0017/0020): passthrough durable resolver — the harness seeds
  // artifact/val_ refs directly, so identity-only resolution keeps Sprint 11 tests intact.
  const durableReferenceResolver = async (refs: readonly string[]) => ({
    ok: true as const,
    value: refs.map((ref) => ({
      kind: ref.startsWith('val_') ? 'validation' : 'artifact',
      id: ref,
      ref: ref.startsWith('val_') ? ref : `artifact:${ref}`,
    })),
  });
  const service = createHandoffService({
    store: db.handoffStore,
    clock: clock as never,
    authorize: ({ actorId, authority }) => authz.decide({ actorId, authority }),
    actorRoleIds: async (actorId) => (await authz.assignmentsOf(actorId)).map((assignment) => assignment.roleId),
    durableReferenceResolver,
    audit: {
      created: audit('handoff.created'),
      ready: audit('handoff.ready'),
      accepted: audit('handoff.accepted'),
      rejected: audit('handoff.rejected'),
      superseded: audit('handoff.superseded'),
      cancelled: audit('handoff.cancelled'),
    },
  });
  const api = createWorkflowApi({
    handoff: service,
    ...(overrides.runtime === undefined ? {} : { runtime: overrides.runtime }),
    router: { recommend: async () => ({ ok: true as const, value: {} }) },
  } as never);
  const roles: Record<string, string> = { developer: developer.value.id, reviewer: reviewer.value.id };
  return {
    db,
    api,
    service,
    roleIdOf: (key) => roles[key] ?? '',
    assignRole: async (actorId, roleId) => {
      const assigned = await authz.assign({ actorId, roleId, assignedBy: 'user_owner' });
      if (!assigned.ok) throw new Error(`assign failed: ${assigned.error.code}`);
    },
    packet: (overrides = {}) => ({
      handoffId: 'hnd_prod',
      companyId: 'company_default',
      workflowId: 'wfl_1',
      workflowVersionId: 'wfv_1',
      workflowRunId: 'run_1',
      stageId: 'stg_1',
      taskId: 'tsk_1',
      fromAgentId: 'agt_developer',
      fromRoleId: roles['developer'],
      toRoleId: roles['reviewer'],
      objective: 'Ship the change',
      summary: 'Implemented and validated; ready for review.',
      recommendedNextAction: 'Review the change.',
      validationRefs: [{ kind: 'validation', refId: 'val_ci' }],
      traceId: 'trace_prod',
      actorId: 'user_developer',
      ...overrides,
    }),
  };
};

const eventTypes = async (db: DurableDatabase): Promise<readonly string[]> =>
  (await db.events.all()).map((entry) => entry.event.type);

const rawCount = (db: DurableDatabase, sql: string, ...params: readonly string[]): number => {
  const raw = new DatabaseSync(db.path);
  try {
    const row = raw.prepare(sql).get(...params) as { readonly n: number | bigint };
    return Number(row.n);
  } finally {
    raw.close();
  }
};

describe('A–E, L. production wiring, IPC reachability and durable audit', () => {
  it('A/B/C/D/E/L: create → ready → accept through the real IPC + stores, audited durably', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const prod = await buildProd(db);
      await prod.assignRole('user_developer', prod.roleIdOf('developer'));
      await prod.assignRole('user_reviewer', prod.roleIdOf('reviewer'));

      const created = await prod.api.handle({ operation: 'handoff.create', payload: prod.packet() });
      expect(created.ok, JSON.stringify(created.ok ? {} : created.error)).toBe(true);
      expect(rawCount(db, 'SELECT COUNT(*) AS n FROM handoffs WHERE handoff_id = ?', 'hnd_prod')).toBe(1);
      expect(rawCount(db, 'SELECT COUNT(*) AS n FROM handoff_refs WHERE handoff_id = ?', 'hnd_prod')).toBe(1);

      const ready = await prod.api.handle({
        operation: 'handoff.ready',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_developer' },
      });
      expect(ready.ok, JSON.stringify(ready.ok ? {} : ready.error)).toBe(true);
      expect((await db.handoffStore?.get('hnd_prod', 1))?.status).toBe('READY');

      const accepted = await prod.api.handle({
        operation: 'handoff.accept',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_reviewer' },
      });
      expect(accepted.ok, JSON.stringify(accepted.ok ? {} : accepted.error)).toBe(true);
      const stored = await db.handoffStore?.get('hnd_prod', 1);
      expect(stored?.status).toBe('ACCEPTED');
      expect(stored?.acceptedBy).toBe('user_reviewer');

      const types = await eventTypes(db);
      for (const expected of ['handoff.created', 'handoff.ready', 'handoff.accepted']) {
        expect(types, `${expected} must be durable`).toContain(expected);
      }
      const acceptedEvent = (await db.events.all()).find((entry) => entry.event.type === 'handoff.accepted');
      expect(acceptedEvent?.event.payload).toMatchObject({ handoffId: 'hnd_prod', actorId: 'user_reviewer', version: 1 });
    } finally {
      db.close();
    }
  });
});

describe('F–H, O. ACCEPTED-only previousHandoff derivation', () => {
  it('F/G/H/O: only ACCEPTED yields previousHandoff, and it survives a restart', async () => {
    const dataDir = makeDataDir();
    {
      const db = openDb(dataDir);
      try {
        const prod = await buildProd(db);
        await prod.assignRole('user_developer', prod.roleIdOf('developer'));
        await prod.assignRole('user_reviewer', prod.roleIdOf('reviewer'));
        await prod.api.handle({ operation: 'handoff.create', payload: prod.packet() });
        await prod.api.handle({ operation: 'handoff.ready', payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_developer' } });

        const readyPacket = await db.handoffStore?.get('hnd_prod', 1);
        expect(readyPacket?.status).toBe('READY');
        expect(previousHandoffTextOf(readyPacket as HandoffPacket)).toBeNull();

        await prod.api.handle({ operation: 'handoff.accept', payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_reviewer' } });
        const acceptedPacket = await db.handoffStore?.get('hnd_prod', 1);
        const text = previousHandoffTextOf(acceptedPacket as HandoffPacket);
        expect(text).toContain('# Previous handoff');
        expect(text).toContain('objective: Ship the change');

        await prod.api.handle({ operation: 'handoff.create', payload: prod.packet({ handoffId: 'hnd_rej' }) });
        await prod.api.handle({ operation: 'handoff.ready', payload: { handoffId: 'hnd_rej', version: 1, actorId: 'user_developer' } });
        const rejected = await prod.api.handle({
          operation: 'handoff.reject',
          payload: { handoffId: 'hnd_rej', version: 1, actorId: 'user_reviewer', reasonCodes: ['ACCEPTANCE_NOT_MET'] },
        });
        expect(rejected.ok).toBe(true);
        const rejectedPacket = await db.handoffStore?.get('hnd_rej', 1);
        expect(rejectedPacket?.status).toBe('REJECTED');
        expect(previousHandoffTextOf(rejectedPacket as HandoffPacket)).toBeNull();
      } finally {
        db.close();
      }
    }
    const reopened = openDb(dataDir);
    try {
      const packet = await reopened.handoffStore?.get('hnd_prod', 1);
      expect(packet?.status).toBe('ACCEPTED');
      const text = previousHandoffTextOf(packet as HandoffPacket);
      expect(text).toContain('# Previous handoff');
      expect((await reopened.runs.list()).items).toHaveLength(0);
      expect((await reopened.agentExecutions.list()).items).toHaveLength(0);
      expect((await reopened.handoffStore?.listVersions('hnd_prod'))?.length).toBe(1);
    } finally {
      reopened.close();
    }
  });
});

describe('I–K. IPC role-claim rejection and trusted role derivation', () => {
  it('I: every client role claim is rejected with INVALID_ARGUMENT', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const prod = await buildProd(db);
      for (const claim of [
        { actorRoleIds: ['role_reviewer'] },
        { roles: ['reviewer'] },
        { roleMemberships: ['reviewer'] },
        { effectiveRoles: ['reviewer'] },
        { permissions: ['handoff.accept'] },
        { authorities: ['handoff.accept'] },
      ]) {
        const response = await prod.api.handle({
          operation: 'handoff.create',
          payload: { ...prod.packet({ handoffId: `hnd_${Object.keys(claim)[0] ?? 'x'}` }), ...claim },
        });
        expect(response.ok, `${Object.keys(claim)[0]} must be rejected`).toBe(false);
        if (!response.ok) expect(response.error.code).toBe('INVALID_ARGUMENT');
      }
      expect(rawCount(db, 'SELECT COUNT(*) AS n FROM handoffs')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('J/K: a forged Reviewer claim cannot accept; real assignments can', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const prod = await buildProd(db);
      await prod.assignRole('user_developer', prod.roleIdOf('developer'));
      await prod.assignRole('user_forger', prod.roleIdOf('developer'));
      await prod.api.handle({ operation: 'handoff.create', payload: prod.packet() });
      await prod.api.handle({ operation: 'handoff.ready', payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_developer' } });

      const forged = await prod.api.handle({
        operation: 'handoff.accept',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_forger', roles: ['reviewer'] },
      });
      expect(forged.ok).toBe(false);
      if (!forged.ok) expect(forged.error.code).toBe('INVALID_ARGUMENT');
      const refused = await prod.api.handle({
        operation: 'handoff.accept',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_forger' },
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe('PERMISSION_DENIED');
      await prod.assignRole('user_reviewer', prod.roleIdOf('reviewer'));
      const accepted = await prod.api.handle({
        operation: 'handoff.accept',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_reviewer' },
      });
      expect(accepted.ok, JSON.stringify(accepted.ok ? {} : accepted.error)).toBe(true);
      expect((await db.handoffStore?.get('hnd_prod', 1))?.status).toBe('ACCEPTED');
    } finally {
      db.close();
    }
  });
});

describe('M/N and side-effect freedom', () => {
  it('M/N: a failing ref insert leaves no row, no refs and no created audit', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const prod = await buildProd(db);
      await prod.assignRole('user_developer', prod.roleIdOf('developer'));
      const store = db.handoffStore;
      const broken = {
        ...(prod.packet() as unknown as HandoffPacket),
        handoffVersion: 1,
        toAgentId: null,
        status: 'DRAFT',
        completedWork: [],
        remainingWork: [],
        constraints: [],
        acceptanceCriteria: [],
        artifactRefs: [{ kind: 'bogus', refId: 'x' }],
        decisionRefs: [],
        validationRefs: [],
        knownRisks: [],
        openQuestions: [],
        modelBinding: null,
        executionRef: null,
        supersedes: null,
        acceptedBy: null,
        acceptedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReasons: [],
        rejectionComment: null,
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
      } as unknown as HandoffPacket;
      await expect(store!.create(broken)).rejects.toThrow();
      expect(rawCount(db, 'SELECT COUNT(*) AS n FROM handoffs WHERE handoff_id = ?', 'hnd_prod')).toBe(0);
      expect(rawCount(db, 'SELECT COUNT(*) AS n FROM handoff_refs WHERE handoff_id = ?', 'hnd_prod')).toBe(0);

      const first = await prod.api.handle({ operation: 'handoff.create', payload: prod.packet() });
      expect(first.ok).toBe(true);
      const createdCount = (await eventTypes(db)).filter((type) => type === 'handoff.created').length;
      const duplicate = await prod.api.handle({ operation: 'handoff.create', payload: prod.packet() });
      expect(duplicate.ok).toBe(false);
      expect((await eventTypes(db)).filter((type) => type === 'handoff.created').length).toBe(createdCount);
    } finally {
      db.close();
    }
  });

  it('accept starts no agent, advances no workflow and records no router decision', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const prod = await buildProd(db);
      await prod.assignRole('user_developer', prod.roleIdOf('developer'));
      await prod.assignRole('user_reviewer', prod.roleIdOf('reviewer'));
      await prod.api.handle({ operation: 'handoff.create', payload: prod.packet() });
      await prod.api.handle({ operation: 'handoff.ready', payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_developer' } });
      const accepted = await prod.api.handle({
        operation: 'handoff.accept',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_reviewer' },
      });
      expect(accepted.ok).toBe(true);
      expect((await db.agentExecutions.list()).items).toHaveLength(0);
      expect((await db.runs.list()).items).toHaveLength(0);
      expect((await db.routerDecisions?.listRecent(50))?.length ?? 0).toBe(0);
      const types = await eventTypes(db);
      expect(types.some((type) => type.startsWith('router.'))).toBe(false);
      expect(types.some((type) => type.startsWith('agent.'))).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('review closeout: runtime carrier, reject role check, read authority', () => {
  it('the ACCEPTED-derived text really reaches the runtime input (and READY does not)', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const seen: { readonly previousHandoff?: string | null }[] = [];
      const runtime = {
        prepare: async (request: { readonly previousHandoff?: string | null }) => {
          seen.push(request);
          return { ok: true as const, value: { executionId: 'exe_1' } };
        },
      };
      const prod = await buildProd(db, { runtime });
      await prod.assignRole('user_developer', prod.roleIdOf('developer'));
      await prod.assignRole('user_reviewer', prod.roleIdOf('reviewer'));
      await prod.api.handle({ operation: 'handoff.create', payload: prod.packet() });
      await prod.api.handle({ operation: 'handoff.ready', payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_developer' } });
      const prepare = (): Promise<unknown> =>
        prod.api.handle({
          operation: 'agent.prepare',
          payload: { agentId: 'agt', roleId: 'rol', taskId: 'tsk', runId: 'run', actorId: 'user_reviewer', modelKey: 'model-a', handoffId: 'hnd_prod', version: 1 },
        });
      // READY: the runtime receives no previous handoff.
      await prepare();
      expect(seen[0]?.previousHandoff ?? null).toBeNull();
      await prod.api.handle({ operation: 'handoff.accept', payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_reviewer' } });
      // ACCEPTED: the server-derived text really reaches the runtime input.
      await prepare();
      expect(seen[1]?.previousHandoff).toContain('# Previous handoff');
      // And a client-supplied previous handoff is still refused.
      const forged = await prod.api.handle({
        operation: 'agent.prepare',
        payload: {
          agentId: 'agt',
          roleId: 'rol',
          taskId: 'tsk',
          runId: 'run',
          actorId: 'user_reviewer',
          modelKey: 'model-a',
          context: { previousHandoff: 'FORGED' },
        },
      });
      expect(forged.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it('reject requires the target role, and reading requires handoff.read', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const prod = await buildProd(db);
      await prod.assignRole('user_developer', prod.roleIdOf('developer'));
      await prod.assignRole('user_outsider', prod.roleIdOf('developer'));
      await prod.api.handle({ operation: 'handoff.create', payload: prod.packet() });
      await prod.api.handle({ operation: 'handoff.ready', payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_developer' } });
      const rejectedByOutsider = await prod.api.handle({
        operation: 'handoff.reject',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_outsider', reasonCodes: ['OTHER'] },
      });
      expect(rejectedByOutsider.ok).toBe(false);
      if (!rejectedByOutsider.ok) expect(rejectedByOutsider.error.code).toBe('PERMISSION_DENIED');
      expect((await db.handoffStore?.get('hnd_prod', 1))?.status).toBe('READY');
      const readDenied = await prod.api.handle({
        operation: 'handoff.get',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_nobody' },
      });
      expect(readDenied.ok).toBe(false);
      if (!readDenied.ok) expect(readDenied.error.code).toBe('PERMISSION_DENIED');
      await prod.assignRole('user_reviewer', prod.roleIdOf('reviewer'));
      const readOk = await prod.api.handle({
        operation: 'handoff.get',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_reviewer' },
      });
      expect(readOk.ok).toBe(true);
      // The target role may reject.
      const rejected = await prod.api.handle({
        operation: 'handoff.reject',
        payload: { handoffId: 'hnd_prod', version: 1, actorId: 'user_reviewer', reasonCodes: ['ACCEPTANCE_NOT_MET'] },
      });
      expect(rejected.ok).toBe(true);
      expect((await db.handoffStore?.get('hnd_prod', 1))?.status).toBe('REJECTED');
    } finally {
      db.close();
    }
  });
});

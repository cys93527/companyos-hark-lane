/**
 * AUDIT regression (engine area; corep finding handoff-service.ts:302-303): `supersede` wrote
 * previous -> SUPERSEDED and then created the next version. A refused successor insert left the
 * previous version SUPERSEDED with no successor. Against a REAL durable SQLite database: the
 * successor insert comes first, so its failure changes nothing, and failures are typed results.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type CreateHandoffInput, type HandoffPacket, type HandoffStorePort } from '@companyos/core';
import { createHandoffService, type HandoffAuditEmitter } from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

import { EXPECTED_COMPOSITION_CHAINS } from '../shared/expected-chains.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(Date.UTC(2027, 5, 1, 10)).toISOString();
const openDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-audit-handoff-'));
  dirs.push(dir);
  return openDurableDatabase({ dataDir: dir, appliedAt: NOW, chains: [...EXPECTED_COMPOSITION_CHAINS] });
};

const noAudit: HandoffAuditEmitter = {
  created: async () => undefined,
  ready: async () => undefined,
  accepted: async () => undefined,
  rejected: async () => undefined,
  superseded: async () => undefined,
  cancelled: async () => undefined,
};

const input: Omit<CreateHandoffInput, 'createdAt' | 'handoffId'> = {
  companyId: 'cmp',
  workflowId: 'wfl_1',
  workflowVersionId: 'wfv_1',
  workflowRunId: 'run_1',
  stageId: 'stg_1',
  taskId: 'tsk_1',
  fromAgentId: 'agt_dev',
  fromRoleId: 'role_dev',
  toRoleId: 'role_rev',
  objective: 'Ship the change',
  summary: 'v1 summary',
  recommendedNextAction: 'Review it.',
  traceId: 'trace_1',
};

type Db = ReturnType<typeof openDb>;

const serviceFor = (store: HandoffStorePort) =>
  createHandoffService({
    store,
    audit: noAudit,
    clock: { now: () => Date.parse(NOW), nowIso: () => NOW },
    authorize: async () => ({ ok: true as const, value: true as const }),
    actorRoleIds: async () => ['role_dev'],
  });

const readyV1 = async (db: Db): Promise<HandoffPacket> => {
  const service = serviceFor(db.handoffStore!);
  const draft = await service.createDraft({ ...input, handoffId: 'hnd_1', actorId: 'user_dev' });
  if (!draft.ok) throw new Error(draft.error.message);
  const ready = await service.ready({ handoffId: 'hnd_1', version: 1, actorId: 'user_dev' });
  if (!ready.ok) throw new Error(ready.error.message);
  return ready.value;
};

const supersedeWith = (store: HandoffStorePort) =>
  serviceFor(store).supersede({
    handoffId: 'hnd_1',
    previousVersion: 1,
    actorId: 'user_dev',
    next: { ...input, summary: 'v2 summary' },
  });

/** Delegate every port method to the real store, overriding the named ones. */
const wrap = (real: HandoffStorePort, over: Partial<HandoffStorePort>): HandoffStorePort => ({
  create: (p) => real.create(p),
  update: (p) => real.update(p),
  get: (id, v) => real.get(id, v),
  listVersions: (id) => real.listVersions(id),
  listForTargetRole: (role, limit) => real.listForTargetRole(role, limit),
  listForScope: (scope) => real.listForScope(scope),
  listRecent: (limit) => real.listRecent(limit),
  ...over,
});

describe('AUDIT handoff supersede never orphans a SUPERSEDED predecessor', () => {
  it('a refused successor insert (real duplicate v2) leaves v1 untouched and returns a typed error', async () => {
    const db = openDb();
    try {
      const v1 = await readyV1(db);
      const real = db.handoffStore!;
      // A REAL conflicting row: v2 already exists, so the durable INSERT is refused.
      await real.create({ ...v1, handoffVersion: 2, status: 'DRAFT', summary: 'squatter', supersedes: null });
      const outcome = await supersedeWith(real);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe('ALREADY_EXISTS');
      expect((await real.get('hnd_1', 1))?.status).toBe('READY');
      expect((await real.get('hnd_1', 2))?.summary).toBe('squatter');
    } finally {
      db.close();
    }
  });

  it('a raw storage failure on the successor insert is a typed PERSISTENCE_FAILED, v1 untouched', async () => {
    const db = openDb();
    try {
      await readyV1(db);
      const real = db.handoffStore!;
      const outcome = await supersedeWith(wrap(real, { create: async () => { throw new Error('disk I/O error'); } }));
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe('PERSISTENCE_FAILED');
        expect(outcome.error.details['phase']).toBe('create_successor');
      }
      expect((await real.get('hnd_1', 1))?.status).toBe('READY');
      expect(await real.get('hnd_1', 2)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('a failure marking the predecessor is a typed result, never a rejection', async () => {
    const db = openDb();
    try {
      await readyV1(db);
      const outcome = await supersedeWith(wrap(db.handoffStore!, { update: async () => { throw new Error('disk I/O error'); } }));
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.details['phase']).toBe('supersede_previous');
    } finally {
      db.close();
    }
  });

  it('the happy path still commits both rows', async () => {
    const db = openDb();
    try {
      await readyV1(db);
      const outcome = await supersedeWith(db.handoffStore!);
      expect(outcome.ok ? 'ok' : `${outcome.error.code}: ${outcome.error.message}`).toBe('ok');
      expect((await db.handoffStore!.get('hnd_1', 1))?.status).toBe('SUPERSEDED');
      expect((await db.handoffStore!.get('hnd_1', 2))?.summary).toBe('v2 summary');
    } finally {
      db.close();
    }
  });
});

/**
 * Sprint 6 carry-over: the minimal Role -> Authority model, and its persistence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AUTHORITIES, FixedClock, SequenceIdFactory, decideAuthority } from '@companyos/core';
import { createAuthorizationService, type AuthorizationService } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const EPOCH = Date.parse('2026-08-02T00:00:00.000Z');

interface Fixture {
  readonly dataDir: string;
  readonly clock: FixedClock;
  readonly ids: SequenceIdFactory;
  database(): DurableDatabase;
  auth(): AuthorizationService;
  restart(): void;
  cleanup(): void;
}

const make = (): Fixture => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-authz-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const open = (): DurableDatabase =>
    openDurableDatabase({ dataDir, appliedAt: clock.nowIso(), chains: ['core', 'engine', 'provider'] });
  let database = open();
  const build = (db: DurableDatabase): AuthorizationService =>
    createAuthorizationService({
      ids,
      clock,
      roles: db.roles,
      assignments: db.roleAssignments,
    });
  let auth = build(database);
  return {
    dataDir,
    clock,
    ids,
    database: () => database,
    auth: () => auth,
    restart(): void {
      database.close();
      database = open();
      auth = build(database);
    },
    cleanup(): void {
      try {
        database.close();
      } catch {
        // already closed
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};

const fixtures: Fixture[] = [];
const fixture = (): Fixture => {
  const created = make();
  fixtures.push(created);
  return created;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe('role -> authority authorization', () => {
  it('grants an authority only through an assigned role', async () => {
    const f = fixture();
    const role = await f.auth().defineRole({
      companyId: 'cmp_1',
      key: 'workflow.lead',
      name: 'Workflow Lead',
      authorities: ['workflow.publish', 'workflow.archive', 'provider.invoke'],
    });
    expect(role.ok).toBe(true);
    if (!role.ok) return;

    const before = await f.auth().decide({ actorId: 'user_lead', authority: 'workflow.publish' });
    expect(before.ok).toBe(false);
    if (!before.ok) {
      expect(before.error.code).toBe('PERMISSION_DENIED');
      expect(before.error.details['held']).toEqual([]);
    }

    const assigned = await f.auth().assign({
      actorId: 'user_lead',
      roleId: role.value.id,
      assignedBy: 'user_owner',
    });
    expect(assigned.ok).toBe(true);

    expect((await f.auth().decide({ actorId: 'user_lead', authority: 'workflow.publish' })).ok).toBe(true);
    expect((await f.auth().decide({ actorId: 'user_lead', authority: 'provider.invoke' })).ok).toBe(true);
    // Not granted:
    expect((await f.auth().decide({ actorId: 'user_lead', authority: 'secret.write' })).ok).toBe(false);
    expect(await f.auth().effective('user_lead')).toEqual(['provider.invoke', 'workflow.archive', 'workflow.publish']);
    expect(await f.auth().effective('user_nobody')).toEqual([]);
  });

  it('refuses an unknown authority instead of allowing it', async () => {
    const f = fixture();
    const role = await f.auth().defineRole({
      companyId: 'cmp_1',
      key: 'ops',
      name: 'Ops',
      authorities: ['provider.read'],
    });
    if (!role.ok) throw new Error('role');
    await f.auth().assign({ actorId: 'user_ops', roleId: role.value.id, assignedBy: 'user_owner' });
    const decision = await f.auth().decide({ actorId: 'user_ops', authority: 'provider.teleport' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('INVALID_ARGUMENT');
      expect(decision.error.details['known']).toEqual(AUTHORITIES);
    }
  });

  it('refuses to define a role carrying an unknown authority', async () => {
    const f = fixture();
    const role = await f.auth().defineRole({
      companyId: 'cmp_1',
      key: 'weird',
      name: 'Weird',
      authorities: ['workflow.publish', 'workflow.teleport'],
    });
    expect(role.ok).toBe(false);
    if (!role.ok) {
      expect(role.error.code).toBe('VALIDATION_FAILED');
      expect(role.error.details['unknown']).toEqual(['workflow.teleport']);
    }
  });

  it('refuses to assign a role that does not exist, and revoking removes the grant', async () => {
    const f = fixture();
    const missing = await f.auth().assign({ actorId: 'a', roleId: 'rol_missing', assignedBy: 'owner' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('NOT_FOUND');

    const role = await f.auth().defineRole({
      companyId: 'cmp_1',
      key: 'reviewer',
      name: 'Reviewer',
      authorities: ['workflow.review'],
    });
    if (!role.ok) throw new Error('role');
    const assigned = await f.auth().assign({ actorId: 'user_reviewer', roleId: role.value.id, assignedBy: 'owner' });
    if (!assigned.ok) throw new Error('assign');
    expect((await f.auth().decide({ actorId: 'user_reviewer', authority: 'workflow.review' })).ok).toBe(true);

    const revoked = await f.auth().revoke(assigned.value.id);
    expect(revoked.ok).toBe(true);
    expect((await f.auth().decide({ actorId: 'user_reviewer', authority: 'workflow.review' })).ok).toBe(false);
  });

  it('survives a restart (roles + assignments stay in SQLite)', async () => {
    const f = fixture();
    const role = await f.auth().defineRole({
      companyId: 'cmp_1',
      key: 'secret.keeper',
      name: 'Secret Keeper',
      authorities: ['secret.read', 'secret.write'],
    });
    if (!role.ok) throw new Error('role');
    await f.auth().assign({ actorId: 'user_keeper', roleId: role.value.id, assignedBy: 'owner' });

    f.restart();

    const roles = await f.auth().listRoles();
    expect(roles.map((entry) => entry.key)).toEqual(['secret.keeper']);
    expect(await f.auth().effective('user_keeper')).toEqual(['secret.read', 'secret.write']);
    const assignments = await f.auth().assignmentsOf('user_keeper');
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.roleId).toBe(role.value.id);
  });

  it('the pure Core decision is usable without any persistence', () => {
    const role = {
      id: 'rol_x' as never,
      companyId: 'cmp_1' as never,
      key: 'k',
      name: 'n',
      description: '',
      requiredCapabilities: [],
      authority: ['workflow.fork'],
      createdAt: 'now',
      updatedAt: 'now',
    };
    const assignment = {
      id: 'actor:rol_x',
      actorId: 'actor',
      roleId: 'rol_x',
      assignedAt: 'now',
      assignedBy: 'owner',
    };
    expect(
      decideAuthority({ actorId: 'actor', authority: 'workflow.fork', roles: [role], assignments: [assignment] }).ok,
    ).toBe(true);
    expect(
      decideAuthority({ actorId: 'other', authority: 'workflow.fork', roles: [role], assignments: [assignment] }).ok,
    ).toBe(false);
  });
});

/**
 * AUDIT-E4 regression (engine area): the bootstrap owner role was a one-shot.
 *  - Upgrade: it kept the AUTHORITIES catalogue of the FIRST run; an authority added later was
 *    never granted, so the session owner was denied every new gate with no repair path.
 *  - Crash: role write and assignment write are separate; a crash between them left a role held
 *    by nobody and every later boot skipped the bootstrap -> the session actor held nothing.
 * The bootstrap now reconciles its own role on every boot, without ever widening anyone else.
 */
import { describe, expect, it } from 'vitest';
import { AUTHORITIES, FixedClock, SequenceIdFactory, type Role, type RoleAssignment } from '@companyos/core';
import { createAuthorizationService, createInMemoryEntityStore, ensureBootstrapOwner } from '@companyos/engine';

const build = () => {
  const roles = createInMemoryEntityStore<Role>();
  const assignments = createInMemoryEntityStore<RoleAssignment>();
  const authz = createAuthorizationService({
    ids: new SequenceIdFactory(),
    clock: new FixedClock(Date.parse('2026-04-01T00:00:00.000Z')),
    roles,
    assignments,
  });
  return { roles, assignments, authz };
};

const NEW_AUTHORITY = 'decision.revoke';
const OLD_CATALOGUE = AUTHORITIES.filter((authority) => authority !== NEW_AUTHORITY);

const seedBootstrapRole = async (f: ReturnType<typeof build>, authorities: readonly string[]) => {
  const role = await f.authz.defineRole({
    companyId: 'company_default',
    key: 'owner',
    name: 'Owner (bootstrap)',
    description: 'Provisioned once on first run; carries every authority for the session actor.',
    authorities,
  });
  if (!role.ok) throw new Error(role.error.message);
  return role.value;
};

describe('AUDIT-E4 bootstrap owner is reconciled on every boot', () => {
  it('upgrade: an authority added to the catalogue after first run is granted to the bootstrap owner', async () => {
    const f = build();
    const role = await seedBootstrapRole(f, OLD_CATALOGUE);
    const held = await f.authz.assign({ actorId: 'user_owner', roleId: role.id, assignedBy: 'system:bootstrap' });
    expect(held.ok).toBe(true);
    expect((await f.authz.decide({ actorId: 'user_owner', authority: NEW_AUTHORITY })).ok).toBe(false);

    const boot = await ensureBootstrapOwner(f.authz, { actorId: 'user_owner' });
    expect(boot.ok).toBe(true);
    if (boot.ok) expect(boot.value).toMatchObject({ provisioned: false, reason: 'reconciled', authoritiesAdded: [NEW_AUTHORITY], assignmentRestored: false });
    for (const authority of AUTHORITIES) {
      expect((await f.authz.decide({ actorId: 'user_owner', authority })).ok, authority).toBe(true);
    }
    const again = await ensureBootstrapOwner(f.authz, { actorId: 'user_owner' });
    if (again.ok) expect(again.value).toMatchObject({ provisioned: false, reason: 'roles_already_defined' });
  });

  it('crash between role and assignment writes: the next boot restores the assignment', async () => {
    const f = build();
    await seedBootstrapRole(f, [...AUTHORITIES]); // role committed, assignment lost
    expect((await f.authz.decide({ actorId: 'user_owner', authority: 'run.start' })).ok).toBe(false);

    const boot = await ensureBootstrapOwner(f.authz, { actorId: 'user_owner' });
    expect(boot.ok).toBe(true);
    if (boot.ok) expect(boot.value).toMatchObject({ reason: 'reconciled', assignmentRestored: true });
    expect((await f.authz.decide({ actorId: 'user_owner', authority: 'run.start' })).ok).toBe(true);
  });

  it('a held bootstrap role is never handed to another actor', async () => {
    const f = build();
    const first = await ensureBootstrapOwner(f.authz, { actorId: 'user_owner' });
    expect(first.ok && first.value.provisioned).toBe(true);
    const intruder = await ensureBootstrapOwner(f.authz, { actorId: 'user_intruder' });
    if (intruder.ok) expect(intruder.value.reason).toBe('roles_already_defined');
    expect((await f.authz.decide({ actorId: 'user_intruder', authority: 'run.start' })).ok).toBe(false);
  });

  it('an operator-defined role set (no bootstrap role) is left untouched', async () => {
    const f = build();
    const custom = await f.authz.defineRole({ companyId: 'company_default', key: 'owner', name: 'Owner', authorities: ['agent.read'] });
    if (!custom.ok) throw new Error(custom.error.message);
    const boot = await ensureBootstrapOwner(f.authz, { actorId: 'user_owner' });
    if (boot.ok) expect(boot.value.reason).toBe('roles_already_defined');
    expect((await f.authz.readRole(custom.value.id))?.authority).toEqual(['agent.read']);
    const refused = await f.authz.reconcileBootstrapRole(custom.value.id, AUTHORITIES);
    expect(refused.ok).toBe(false);
  });
});

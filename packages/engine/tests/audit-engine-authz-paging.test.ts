/**
 * AUDIT-E6 regression (engine area): authorization read only the first 500 roles and
 * assignments (single `list({limit:500})`), so a role or assignment past that page silently
 * denied. Reads must page to exhaustion, including against a store that serves short pages.
 */
import { describe, expect, it } from 'vitest';
import { FixedClock, SequenceIdFactory, type EntityStore, type Role, type RoleAssignment } from '@companyos/core';
import { createAuthorizationService, createInMemoryEntityStore } from '@companyos/engine';

/** A store that never serves more than `cap` rows per page (as a real backend may clamp). */
const clamped = <T extends { readonly id: string }>(inner: EntityStore<T>, cap: number): EntityStore<T> => ({
  get: (id) => inner.get(id),
  put: (entity) => inner.put(entity),
  delete: (id) => inner.delete(id),
  list: (page) => inner.list({ ...page, limit: Math.min(page?.limit ?? cap, cap) }),
});

const build = async (cap?: number) => {
  const rolesInner = createInMemoryEntityStore<Role>();
  const assignmentsInner = createInMemoryEntityStore<RoleAssignment>();
  const authz = createAuthorizationService({
    ids: new SequenceIdFactory(),
    clock: new FixedClock(Date.parse('2026-04-01T00:00:00.000Z')),
    roles: cap === undefined ? rolesInner : clamped(rolesInner, cap),
    assignments: cap === undefined ? assignmentsInner : clamped(assignmentsInner, cap),
  });
  // 600 filler roles + 600 filler assignments for other actors push the target past row 500.
  for (let i = 0; i < 600; i += 1) {
    const role = await authz.defineRole({ companyId: 'cmp_1', key: `filler_${i}`, name: `filler ${i}`, authorities: ['agent.read'] });
    if (!role.ok) throw new Error(role.error.message);
    const assigned = await authz.assign({ actorId: `user_${i}`, roleId: role.value.id, assignedBy: 'test' });
    if (!assigned.ok) throw new Error(assigned.error.message);
  }
  const target = await authz.defineRole({ companyId: 'cmp_1', key: 'late', name: 'late', authorities: ['run.start'] });
  if (!target.ok) throw new Error(target.error.message);
  const assigned = await authz.assign({ actorId: 'user_late', roleId: target.value.id, assignedBy: 'test' });
  if (!assigned.ok) throw new Error(assigned.error.message);
  return authz;
};

describe('AUDIT-E6 authorization pages roles/assignments to exhaustion', () => {
  for (const cap of [undefined, 37] as const) {
    it(`a role/assignment past the first page still grants (page cap ${String(cap ?? 'none')})`, async () => {
      const authz = await build(cap);
      expect((await authz.listRoles()).length).toBe(601);
      expect((await authz.assignmentsOf('user_late')).length).toBe(1);
      expect(await authz.effective('user_late')).toEqual(['run.start']);
      const decided = await authz.decide({ actorId: 'user_late', authority: 'run.start' });
      expect(decided.ok).toBe(true);
    });
  }
});

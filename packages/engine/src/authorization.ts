/**
 * Authorization service (Sprint 6 carry-over): Role -> Authority, persisted.
 *
 * The decisions themselves are Core's (`decideAuthority`); this service only persists
 * roles/assignments and loads them for the decision, so every caller (workflow service,
 * provider registry, secret tooling) shares one gate.
 */
import {
  AUTHORITIES,
  DomainError,
  asId,
  decideAuthority,
  domainError,
  err,
  ok,
  validateRoleAuthorities,
  type Clock,
  type EntityStore,
  type IdFactory,
  type PackAvailabilityPolicy,
  type Result,
  type Role,
  type RoleAssignment,
} from '@companyos/core';

export interface AuthorizationDeps {
  readonly ids: IdFactory;
  readonly clock: Clock;
  readonly roles: EntityStore<Role>;
  readonly assignments: EntityStore<RoleAssignment>;
  /**
   * Industry-pack live-availability seam (T15-04 corrective; ADR-0025 Decision 4).
   *
   * A Role materialized by a pack keeps its row when the pack is disabled (history and
   * audit must stay readable), but it must NOT be handed to a new member afterwards.
   * When supplied, `assign` refuses a role whose owning pack installations are all
   * disabled; existing assignments are untouched (they are history, not new use).
   * Omitted => no pack awareness (legacy single-tenant composition).
   */
  readonly packAvailability?: PackAvailabilityPolicy;
}

export interface DefineRoleInput {
  readonly companyId: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly authorities: readonly string[];
  readonly requiredCapabilities?: readonly string[];
}

export interface AssignRoleInput {
  readonly actorId: string;
  readonly roleId: string;
  readonly assignedBy: string;
}

export interface AuthorizationService {
  defineRole(input: DefineRoleInput): Promise<Result<Role, DomainError>>;
  readRole(roleId: string): Promise<Role | null>;
  listRoles(): Promise<readonly Role[]>;
  assign(input: AssignRoleInput): Promise<Result<RoleAssignment, DomainError>>;
  revoke(assignmentId: string): Promise<Result<boolean, DomainError>>;
  assignmentsOf(actorId: string): Promise<readonly RoleAssignment[]>;
  /** AUDIT-E4: every assignment of one role (exhaustive). */
  holdersOf(roleId: string): Promise<readonly RoleAssignment[]>;
  decide(input: { readonly actorId: string; readonly authority: string; readonly scopeId?: string }): Promise<Result<true, DomainError>>;
  effective(actorId: string): Promise<readonly string[]>;
  /**
   * AUDIT-E4: bring the BOOTSTRAP owner role (and only it) up to the given authority
   * catalogue. Returns the stored role (unchanged when nothing was missing).
   */
  reconcileBootstrapRole(roleId: string, authorities: readonly string[]): Promise<Result<Role, DomainError>>;
}

export interface BootstrapOwnerOptions {
  readonly actorId: string;
  readonly companyId?: string;
}

export interface BootstrapOwnerOutcome {
  /** True only on the run that actually provisioned the owner role. */
  readonly provisioned: boolean;
  readonly roleId: string | null;
  /**
   * provisioned: first run. reconciled (AUDIT-E4): the existing bootstrap owner role was
   * repaired (authorities added by an upgrade and/or the crash-lost assignment restored).
   * roles_already_defined: nothing to do.
   */
  readonly reason: 'provisioned' | 'reconciled' | 'roles_already_defined';
  /** AUDIT-E4: authorities granted to the bootstrap owner role on this run (sorted). */
  readonly authoritiesAdded?: readonly string[];
  /** AUDIT-E4: true when the crash-lost bootstrap assignment was restored on this run. */
  readonly assignmentRestored?: boolean;
}

/** The bootstrap owner role's identity (key + name are written only by the bootstrap). */
const BOOTSTRAP_ROLE_KEY = 'owner';
const BOOTSTRAP_ROLE_NAME = 'Owner (bootstrap)';
const BOOTSTRAP_ASSIGNER = 'system:bootstrap';

/**
 * Sprint 7.1 MEDIUM-1: replace "empty role table = allow everything" with an explicit
 * bootstrap state.
 *
 * On the FIRST run (no roles at all) this provisions ONE owner role carrying every known
 * authority and assigns it to the given actor, so the permission model has an auditable
 * starting point.
 *
 * AUDIT-E4: on every later run it RECONCILES that bootstrap owner role (never any other
 * role, never any other actor):
 *   - authorities added to the catalogue by an in-place upgrade are granted to it, so the
 *     session owner is not locked out of every new gate;
 *   - a crash between the role write and the assignment write (no transaction spans them)
 *     left the role held by NOBODY; the assignment is restored to the bootstrap actor.
 *     When the role is already held, no new actor ever gains it (the window stays closed).
 * A role set defined without the bootstrap (no bootstrap owner role) is left untouched.
 * Idempotent: a repeated boot converges and changes nothing, so a crash at any point of
 * this sequence is repaired by the next boot.
 */
export async function ensureBootstrapOwner(
  authz: AuthorizationService,
  options: BootstrapOwnerOptions,
): Promise<Result<BootstrapOwnerOutcome, DomainError>> {
  const companyId = options.companyId ?? 'company_default';
  const roles = await authz.listRoles();
  if (roles.length > 0) {
    const owner = roles.find(
      (role) => role.key === BOOTSTRAP_ROLE_KEY && role.name === BOOTSTRAP_ROLE_NAME && String(role.companyId) === companyId,
    );
    if (owner === undefined) {
      return ok({ provisioned: false, roleId: null, reason: 'roles_already_defined' });
    }
    const before = new Set(owner.authority);
    const reconciled = await authz.reconcileBootstrapRole(owner.id, AUTHORITIES);
    if (!reconciled.ok) return reconciled;
    const authoritiesAdded = reconciled.value.authority.filter((authority) => !before.has(authority)).sort();
    const holders = await authz.holdersOf(owner.id);
    let assignmentRestored = false;
    if (holders.length === 0) {
      const assigned = await authz.assign({ actorId: options.actorId, roleId: owner.id, assignedBy: BOOTSTRAP_ASSIGNER });
      if (!assigned.ok) return assigned;
      assignmentRestored = true;
    }
    const changed = authoritiesAdded.length > 0 || assignmentRestored;
    return ok({
      provisioned: false,
      roleId: changed ? owner.id : null,
      reason: changed ? 'reconciled' : 'roles_already_defined',
      authoritiesAdded,
      assignmentRestored,
    });
  }
  const owner = await authz.defineRole({
    companyId,
    key: BOOTSTRAP_ROLE_KEY,
    name: BOOTSTRAP_ROLE_NAME,
    description: 'Provisioned once on first run; carries every authority for the session actor.',
    authorities: [...AUTHORITIES],
  });
  if (!owner.ok) return owner;
  const assigned = await authz.assign({
    actorId: options.actorId,
    roleId: owner.value.id,
    assignedBy: BOOTSTRAP_ASSIGNER,
  });
  if (!assigned.ok) return assigned;
  return ok({ provisioned: true, roleId: owner.value.id, reason: 'provisioned' });
}

const AUTHZ_PAGE_SIZE = 500;

/** Read every row of a paged store; stops on `total` or on an empty page (never loops). */
const readAllRows = async <T extends { readonly id: string }>(store: EntityStore<T>): Promise<T[]> => {
  const collected: T[] = [];
  for (let offset = 0; ; ) {
    const page = await store.list({ limit: AUTHZ_PAGE_SIZE, offset });
    for (const item of page.items) collected.push(item);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }
  return collected;
};

export function createAuthorizationService(deps: AuthorizationDeps): AuthorizationService {
  const nowIso = (): string => deps.clock.nowIso();

  // AUDIT-E6: every authorization read pages to exhaustion. A single 500-row page made
  // roles/assignments past it invisible (newly assigned roles silently denied).
  const loadRoles = async (): Promise<readonly Role[]> => readAllRows(deps.roles);
  const loadAssignments = async (): Promise<readonly RoleAssignment[]> => readAllRows(deps.assignments);

  return {
    async defineRole(input: DefineRoleInput): Promise<Result<Role, DomainError>> {
      const at = nowIso();
      const role: Role = {
        id: asId<'RoleId'>(deps.ids.id('rol')),
        companyId: asId<'CompanyId'>(input.companyId),
        key: input.key,
        name: input.name,
        description: input.description ?? '',
        requiredCapabilities: input.requiredCapabilities ?? [],
        authority: [...input.authorities],
        createdAt: at,
        updatedAt: at,
      };
      const valid = validateRoleAuthorities(role);
      if (!valid.ok) return valid;
      try {
        await deps.roles.put(role);
      } catch (error) {
        // A concurrent first-run bootstrap can lose the race on UNIQUE(company_id, key):
        // report it as a domain conflict rather than leaking a raw storage error.
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE/i.test(message)) {
          return err(
            domainError('CONFLICT', `Role key "${input.key}" already exists for this company.`, {
              key: input.key,
              companyId: input.companyId,
            }),
          );
        }
        return err(
          error instanceof DomainError
            ? error
            : domainError('PERSISTENCE_FAILED', message, { key: input.key }),
        );
      }
      return ok(role);
    },

    async readRole(roleId: string): Promise<Role | null> {
      return deps.roles.get(roleId);
    },

    async listRoles(): Promise<readonly Role[]> {
      return loadRoles();
    },

    async assign(input: AssignRoleInput): Promise<Result<RoleAssignment, DomainError>> {
      const role = await deps.roles.get(input.roleId);
      if (role === null) {
        return err(domainError('NOT_FOUND', `Role ${input.roleId} not found.`, { roleId: input.roleId }));
      }
      // Industry-pack availability: a role a disabled pack materialized is history, not a
      // live position - refuse the NEW assignment (the row and its audit stay readable).
      if (deps.packAvailability !== undefined) {
        const available = await deps.packAvailability.isMaterializedContentAvailable({
          companyId: role.companyId,
          contentKind: 'role',
          entityId: role.id,
        });
        if (!available.ok) return err(available.error);
        if (!available.value) {
          return err(
            domainError('POLICY_DENIED', `Role ${input.roleId} belongs to a disabled industry pack and cannot be assigned.`, {
              reason: 'PACK_MATERIALIZED_CONTENT_UNAVAILABLE',
              roleId: input.roleId,
            }),
          );
        }
      }
      const valid = validateRoleAuthorities(role);
      if (!valid.ok) return valid;
      const assignment: RoleAssignment = {
        id: `${input.actorId}:${input.roleId}`,
        actorId: input.actorId,
        roleId: input.roleId,
        assignedAt: nowIso(),
        assignedBy: input.assignedBy,
      };
      await deps.assignments.put(assignment);
      return ok(assignment);
    },

    async revoke(assignmentId: string): Promise<Result<boolean, DomainError>> {
      return ok(await deps.assignments.delete(assignmentId));
    },

    async assignmentsOf(actorId: string): Promise<readonly RoleAssignment[]> {
      return (await loadAssignments()).filter((entry) => entry.actorId === actorId);
    },

    async holdersOf(roleId: string): Promise<readonly RoleAssignment[]> {
      return (await loadAssignments()).filter((entry) => entry.roleId === roleId);
    },

    async reconcileBootstrapRole(roleId: string, authorities: readonly string[]): Promise<Result<Role, DomainError>> {
      const role = await deps.roles.get(roleId);
      if (role === null) {
        return err(domainError('NOT_FOUND', `Role ${roleId} not found.`, { roleId }));
      }
      if (role.key !== BOOTSTRAP_ROLE_KEY || role.name !== BOOTSTRAP_ROLE_NAME) {
        return err(
          domainError('POLICY_DENIED', `Role ${roleId} is not the bootstrap owner role.`, {
            reason: 'NOT_BOOTSTRAP_ROLE',
            roleId,
          }),
        );
      }
      const held = new Set(role.authority);
      const missing = authorities.filter((authority) => !held.has(authority));
      if (missing.length === 0) return ok(role);
      const next: Role = { ...role, authority: [...role.authority, ...missing], updatedAt: nowIso() };
      const valid = validateRoleAuthorities(next);
      if (!valid.ok) return valid;
      await deps.roles.put(next);
      return ok(next);
    },

    async decide(input: { readonly actorId: string; readonly authority: string; readonly scopeId?: string }) {
      return decideAuthority({
        actorId: input.actorId,
        authority: input.authority,
        roles: await loadRoles(),
        assignments: await loadAssignments(),
        ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
      });
    },

    async effective(actorId: string): Promise<readonly string[]> {
      const roles = await loadRoles();
      const assignments = await loadAssignments();
      const held = new Set(assignments.filter((entry) => entry.actorId === actorId).map((entry) => entry.roleId));
      const granted = new Set<string>();
      for (const role of roles.filter((entry) => held.has(entry.id))) {
        for (const authority of role.authority) granted.add(authority);
      }
      return [...granted].sort();
    },
  };
}

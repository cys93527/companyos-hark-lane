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
  decide(input: { readonly actorId: string; readonly authority: string; readonly scopeId?: string }): Promise<Result<true, DomainError>>;
  effective(actorId: string): Promise<readonly string[]>;
}

export interface BootstrapOwnerOptions {
  readonly actorId: string;
  readonly companyId?: string;
}

export interface BootstrapOwnerOutcome {
  /** True only on the run that actually provisioned the owner role. */
  readonly provisioned: boolean;
  readonly roleId: string | null;
  readonly reason: 'provisioned' | 'roles_already_defined';
}

/**
 * Sprint 7.1 MEDIUM-1: replace "empty role table = allow everything" with an explicit
 * bootstrap state.
 *
 * On the FIRST run (no roles at all) this provisions ONE owner role carrying every known
 * authority and assigns it to the given actor, so the permission model has an auditable
 * starting point. On every later run it does nothing: the caller's authorization path is
 * plain Role -> Authority, with no special window left open.
 */
export async function ensureBootstrapOwner(
  authz: AuthorizationService,
  options: BootstrapOwnerOptions,
): Promise<Result<BootstrapOwnerOutcome, DomainError>> {
  const roles = await authz.listRoles();
  if (roles.length > 0) {
    return ok({ provisioned: false, roleId: null, reason: 'roles_already_defined' });
  }
  const owner = await authz.defineRole({
    companyId: options.companyId ?? 'company_default',
    key: 'owner',
    name: 'Owner (bootstrap)',
    description: 'Provisioned once on first run; carries every authority for the session actor.',
    authorities: [...AUTHORITIES],
  });
  if (!owner.ok) return owner;
  const assigned = await authz.assign({
    actorId: options.actorId,
    roleId: owner.value.id,
    assignedBy: 'system:bootstrap',
  });
  if (!assigned.ok) return assigned;
  return ok({ provisioned: true, roleId: owner.value.id, reason: 'provisioned' });
}

export function createAuthorizationService(deps: AuthorizationDeps): AuthorizationService {
  const nowIso = (): string => deps.clock.nowIso();

  const loadRoles = async (): Promise<readonly Role[]> => (await deps.roles.list({ limit: 500 })).items;
  const loadAssignments = async (): Promise<readonly RoleAssignment[]> =>
    (await deps.assignments.list({ limit: 500 })).items;

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

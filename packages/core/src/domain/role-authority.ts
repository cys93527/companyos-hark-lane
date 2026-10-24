/**
 * Minimal Role -> Authority authorization (Sprint 6 carry-over).
 *
 * The model is deliberately small: a Role carries a list of authority strings
 * (`domain/role.ts`), an Assignment binds a role to an actor, and a decision answers one
 * question - "may this actor exercise this authority?" - with a Core error when not.
 *
 * Authorities are a CLOSED set so a typo cannot silently become a permission, and the
 * names are capability-shaped (`workflow.publish`, `provider.invoke`, ...), never
 * vendor- or industry-shaped.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { Role } from './role.js';

export const AUTHORITIES = [
  // workflow governance
  'workflow.draft.create',
  'workflow.draft.edit',
  'workflow.publish',
  'workflow.propose',
  'workflow.review',
  'workflow.fork',
  'workflow.deprecate',
  'workflow.archive',
  'workflow.lock',
  // execution
  'run.start',
  'run.cancel',
  // provider layer
  'provider.register',
  'provider.invoke',
  'provider.read',
  // model registry (Sprint 7)
  'model.register',
  'model.read',
  'model.write',
  // agent execution runtime (Sprint 8)
  'agent.execute',
  'agent.read',
  // tool registry (Sprint 9)
  'tool.register',
  'tool.read',
  'tool.invoke',
  'tool.enable',
  'tool.disable',
  // structured handoff (Sprint 11)
  'handoff.create',
  'handoff.read',
  'handoff.accept',
  'handoff.reject',
  // organizational memory + decisions (Sprint 12)
  'memory.create',
  'memory.read',
  'memory.supersede',
  'memory.retract',
  'decision.create',
  'decision.read',
  'decision.supersede',
  'decision.revoke',
  // durable artifacts + validation evidence (Sprint 13, ADR-0015/0016 §13.2)
  'artifact.create',
  'artifact.read',
  'validation.record',
  'validation.read',
  // industry pack management (Sprint 15, ADR-0027 D10 — the ONLY Sprint 15 pack
  // authority: install/enable/disable/upgrade. Vocabulary-only in T15-02; the real
  // execution point arrives with the PackService in T15-04. It grants nothing by
  // itself: no authority minting, no role assignment, no owner, no code execution.)
  'pack.manage',
  // secrets
  'secret.read',
  'secret.write',
] as const;

export type Authority = (typeof AUTHORITIES)[number];

export const isAuthority = (value: unknown): value is Authority =>
  typeof value === 'string' && (AUTHORITIES as readonly string[]).includes(value);

/** Known-but-grantable prefixes stay explicit: no wildcards, no globs. */
export const AUTHORITY_PATTERN = /^[a-z]+(\.[a-z_]+)+$/;

export interface RoleAssignment {
  /** `EntityStore` key - `<actorId>:<roleId>`. */
  readonly id: string;
  readonly actorId: string;
  readonly roleId: string;
  readonly assignedAt: string;
  readonly assignedBy: string;
}

export const assignmentId = (actorId: string, roleId: string): string => `${actorId}:${roleId}`;

export interface AuthorityDecisionInput {
  readonly actorId: string;
  readonly authority: string;
  readonly roles: readonly Role[];
  readonly assignments: readonly RoleAssignment[];
  /** Optional template/provider scope; recorded in the error for auditability. */
  readonly scopeId?: string;
}

/** Roles the actor actually holds (assignments resolved against the role list). */
export const rolesOfActor = (
  roles: readonly Role[],
  assignments: readonly RoleAssignment[],
  actorId: string,
): readonly Role[] => {
  const held = new Set(assignments.filter((entry) => entry.actorId === actorId).map((entry) => entry.roleId));
  return roles.filter((role) => held.has(role.id));
};

/** Every authority the actor holds, deduplicated and sorted for stable output. */
export const authoritiesOfActor = (
  roles: readonly Role[],
  assignments: readonly RoleAssignment[],
  actorId: string,
): readonly string[] => {
  const granted = new Set<string>();
  for (const role of rolesOfActor(roles, assignments, actorId)) {
    for (const authority of role.authority) granted.add(authority);
  }
  return [...granted].sort();
};

/**
 * The decision. Unknown authorities are refused as `INVALID_ARGUMENT` (fail closed, and a
 * typo is a bug rather than a bypass).
 */
export function decideAuthority(input: AuthorityDecisionInput): Result<true, DomainError> {
  if (!isAuthority(input.authority)) {
    return err(
      domainError('INVALID_ARGUMENT', `Unknown authority "${input.authority}".`, {
        authority: input.authority,
        known: AUTHORITIES,
      }),
    );
  }
  const granted = authoritiesOfActor(input.roles, input.assignments, input.actorId);
  if (granted.includes(input.authority)) return ok(true);
  return err(
    domainError('PERMISSION_DENIED', `Actor "${input.actorId}" lacks authority "${input.authority}".`, {
      actorId: input.actorId,
      authority: input.authority,
      held: granted,
      ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
    }),
  );
}

/** Effective permissions for a UI: what this actor may do, sorted. */
export const effectiveAuthorities = authoritiesOfActor;

/** Guard used when assigning a role: the role must exist and only carry known authorities. */
export function validateRoleAuthorities(role: Role): Result<true, DomainError> {
  const unknown = role.authority.filter((authority) => !isAuthority(authority));
  if (unknown.length > 0) {
    return err(
      domainError('VALIDATION_FAILED', `Role "${role.key}" carries unknown authorities.`, {
        roleId: role.id,
        unknown,
        known: AUTHORITIES,
      }),
    );
  }
  return ok(true);
}

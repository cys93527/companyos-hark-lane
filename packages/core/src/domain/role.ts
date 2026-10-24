/**
 * Role — a POSITION in the organisation (规划书 §二原则 3 "Agent 是岗位").
 *
 * Hard invariant (Sprint 1 Task 5 / STEP 7):
 *   **A Role must NEVER bind a concrete model.** A position describes what work it
 *   is responsible for; which model fills it today is decided later by the Router
 *   (P1/Sprint 7-10). `packages/core/tests/domain/role-agent.test.ts` locks this in.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import { makeId, type CompanyId, type RoleId } from '../kernel/identifiers.js';

export interface Role {
  readonly id: RoleId;
  readonly companyId: CompanyId;
  /** Stable machine key, e.g. `reviewer`. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Capability ids this position needs (e.g. `pack-x:y`) — never model names. */
  readonly requiredCapabilities: readonly string[];
  /** Authority tokens this position may exercise, e.g. `run.approve`. */
  readonly authority: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Fields that must never appear on a Role (model/provider binding belongs to the Router). */
export const ROLE_FORBIDDEN_BINDINGS = ['model', 'modelId', 'modelKey', 'provider', 'providerId'] as const;

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export interface CreateRoleInput {
  readonly companyId: CompanyId;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly requiredCapabilities?: readonly string[];
  readonly authority?: readonly string[];
  readonly now: string;
  readonly ids: IdFactory;
}

export function createRole(input: CreateRoleInput): Result<Role, DomainError> {
  if (!KEY_PATTERN.test(input.key)) {
    return err(
      domainError('INVALID_ARGUMENT', 'Role key must be lower-kebab-case (2–32 chars).', {
        key: input.key,
      }),
    );
  }
  if (input.name.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'Role name must not be empty.', { key: input.key }));
  }
  return ok({
    id: makeId<'RoleId'>('role', input.ids),
    companyId: input.companyId,
    key: input.key,
    name: input.name.trim(),
    description: input.description ?? '',
    requiredCapabilities: input.requiredCapabilities ?? [],
    authority: input.authority ?? [],
    createdAt: input.now,
    updatedAt: input.now,
  });
}

/** Structural guard used by tests and by Pack validation: a Role carries no model identity. */
export const roleIsModelAgnostic = (value: Readonly<Record<string, unknown>>): boolean =>
  ROLE_FORBIDDEN_BINDINGS.every((field) => !(field in value));

export const hasAuthority = (role: Role, token: string): boolean => role.authority.includes(token);

export function withCapabilities(
  role: Role,
  requiredCapabilities: readonly string[],
  now: string,
): Result<Role, DomainError> {
  const unique = [...new Set(requiredCapabilities)];
  if (unique.length !== requiredCapabilities.length) {
    return err(
      domainError('INVALID_ARGUMENT', 'Capability list contains duplicates.', {
        roleId: role.id,
      }),
    );
  }
  return ok({ ...role, requiredCapabilities: unique, updatedAt: now });
}

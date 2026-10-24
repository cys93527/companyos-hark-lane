/**
 * Company — the root organisation aggregate (规划书 §四 Core 概念 1; §六十九 用户是老板).
 *
 * A Company owns Industry Pack installations and Workflows. It is deliberately
 * thin: no roles, no workflow state, no model information live here.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import { makeId, type CompanyId } from '../kernel/identifiers.js';

export const COMPANY_STATUSES = ['active', 'archived'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export interface Company {
  readonly id: CompanyId;
  readonly name: string;
  readonly status: CompanyStatus;
  /** Installed Industry Packs (ids of `PackInstallation`). */
  readonly packInstallationIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
}

export interface CreateCompanyInput {
  readonly name: string;
  readonly createdBy: string;
  readonly now: string;
  readonly ids: IdFactory;
}

const MIN_NAME = 2;
const MAX_NAME = 120;

/** Name is the only free-text field, so it is the only thing to validate here. */
export function validateCompanyName(name: string): Result<string, DomainError> {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME) {
    return err(
      domainError('INVALID_ARGUMENT', `Company name must be at least ${MIN_NAME} characters.`, {
        name,
      }),
    );
  }
  if (trimmed.length > MAX_NAME) {
    return err(
      domainError('INVALID_ARGUMENT', `Company name must be at most ${MAX_NAME} characters.`, {
        length: trimmed.length,
      }),
    );
  }
  return ok(trimmed);
}

export function createCompany(input: CreateCompanyInput): Result<Company, DomainError> {
  const name = validateCompanyName(input.name);
  if (!name.ok) return name;
  return ok({
    id: makeId<'CompanyId'>('company', input.ids),
    name: name.value,
    status: 'active',
    packInstallationIds: [],
    createdAt: input.now,
    updatedAt: input.now,
    createdBy: input.createdBy,
  });
}

export const isCompanyActive = (company: Company): boolean => company.status === 'active';

export function renameCompany(
  company: Company,
  name: string,
  now: string,
): Result<Company, DomainError> {
  if (company.status === 'archived') {
    return err(
      domainError('ARCHIVED_READONLY', `Company ${company.id} is archived and cannot be renamed.`, {
        companyId: company.id,
      }),
    );
  }
  const validated = validateCompanyName(name);
  if (!validated.ok) return validated;
  return ok({ ...company, name: validated.value, updatedAt: now });
}

export function archiveCompany(company: Company, now: string): Result<Company, DomainError> {
  if (company.status === 'archived') {
    return err(
      domainError('IMMUTABLE_ENTITY', `Company ${company.id} is already archived.`, {
        companyId: company.id,
      }),
    );
  }
  return ok({ ...company, status: 'archived', updatedAt: now });
}

export function attachPackInstallation(
  company: Company,
  installationId: string,
  now: string,
): Result<Company, DomainError> {
  if (company.packInstallationIds.includes(installationId)) {
    return err(
      domainError('ALREADY_EXISTS', `Pack installation ${installationId} is already attached.`, {
        companyId: company.id,
        installationId,
      }),
    );
  }
  return ok({
    ...company,
    packInstallationIds: [...company.packInstallationIds, installationId],
    updatedAt: now,
  });
}

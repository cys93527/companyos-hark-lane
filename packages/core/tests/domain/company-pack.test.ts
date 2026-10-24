/**
 * Sprint 1 Task 2: Company and Pack installation.
 */
import { describe, expect, it } from 'vitest';

import {
  attachPackInstallation,
  archiveCompany,
  capabilityOwner,
  createCompany,
  createPackInstallation,
  isCompanyActive,
  isPackEnabled,
  missingCapabilities,
  providesCapability,
  renameCompany,
  setPackStatus,
  type CompanyId,
} from '@companyos/core';

import { expectErr, expectOk, makeIds, nowIso, packManifestFixture } from './support.js';

const newCompany = (name = 'Acme Studio') =>
  expectOk(createCompany({ name, createdBy: 'user_owner', now: nowIso(), ids: makeIds() }));

describe('Company', () => {
  it('creates an active company with no pack installations', () => {
    const company = newCompany();
    expect(company.status).toBe('active');
    expect(company.packInstallationIds).toEqual([]);
    expect(company.id.startsWith('cmp_')).toBe(true);
    expect(isCompanyActive(company)).toBe(true);
  });

  it('validates the name', () => {
    expect(expectErr(createCompany({ name: ' ', createdBy: 'u', now: nowIso(), ids: makeIds() })).code).toBe(
      'INVALID_ARGUMENT',
    );
    expect(expectErr(createCompany({ name: 'x', createdBy: 'u', now: nowIso(), ids: makeIds() })).code).toBe(
      'INVALID_ARGUMENT',
    );
    expect(
      expectErr(createCompany({ name: 'y'.repeat(121), createdBy: 'u', now: nowIso(), ids: makeIds() })).code,
    ).toBe('INVALID_ARGUMENT');
  });

  it('renames, then refuses everything once archived', () => {
    const company = newCompany();
    const renamed = expectOk(renameCompany(company, 'Acme Two', nowIso(1000)));
    expect(renamed.name).toBe('Acme Two');

    const archived = expectOk(archiveCompany(renamed, nowIso(2000)));
    expect(archived.status).toBe('archived');
    expect(expectErr(renameCompany(archived, 'Nope', nowIso(3000))).code).toBe('ARCHIVED_READONLY');
    expect(expectErr(archiveCompany(archived, nowIso(3000))).code).toBe('IMMUTABLE_ENTITY');
  });

  it('attaches a pack installation once', () => {
    const company = newCompany();
    const attached = expectOk(attachPackInstallation(company, 'pak_1', nowIso(500)));
    expect(attached.packInstallationIds).toEqual(['pak_1']);
    expect(expectErr(attachPackInstallation(attached, 'pak_1', nowIso(600))).code).toBe('ALREADY_EXISTS');
  });
});

describe('Pack installation', () => {
  const companyId = 'cmp_1' as CompanyId;

  it('validates the manifest before recording an installation', () => {
    const installed = expectOk(
      createPackInstallation({ companyId, manifest: packManifestFixture(), installedBy: 'u', now: nowIso(), ids: makeIds() }),
    );
    expect(installed.packId).toBe('pack-a');
    expect(installed.coreApi).toBe('1');
    expect(installed.packVersion).toBe('1.0.0');
    expect(installed.capabilities).toEqual(['pack-a:build', 'pack-a:deploy']);
    expect(installed.status).toBe('installed');
    expect(isPackEnabled(installed)).toBe(true);

    const invalid = createPackInstallation({
      companyId,
      manifest: { packId: 'Bad Id', packVersion: 'nope' },
      installedBy: 'u',
      now: nowIso(),
      ids: makeIds(),
    });
    expect(expectErr(invalid).code).toBe('VALIDATION_FAILED');
  });

  it('toggles status once', () => {
    const installed = expectOk(
      createPackInstallation({ companyId, manifest: packManifestFixture(), installedBy: 'u', now: nowIso(), ids: makeIds() }),
    );
    const disabled = expectOk(setPackStatus(installed, 'disabled', nowIso(1000)));
    expect(isPackEnabled(disabled)).toBe(false);
    expect(expectErr(setPackStatus(disabled, 'disabled', nowIso(2000))).code).toBe('CONFLICT');
  });

  it('resolves capabilities only through enabled packs', () => {
    const disabledPack = { ...expectOk(
      createPackInstallation({ companyId, manifest: packManifestFixture(), installedBy: 'u', now: nowIso(), ids: makeIds() }),
    ), status: 'disabled' as const };

    expect(providesCapability([disabledPack], 'pack-a:build')).toBe(false);

    const enabled = expectOk(setPackStatus(disabledPack, 'installed', nowIso(10)));
    expect(providesCapability([enabled], 'pack-a:build')).toBe(true);
    expect(capabilityOwner([enabled], 'pack-a:deploy')?.packId).toBe('pack-a');
    expect(missingCapabilities([enabled], ['pack-a:build', 'other:cap'])).toEqual(['other:cap']);
  });
});

/**
 * Sprint 16 / Task-16-03 — pre-Sprint17 installability truth.
 *
 * The DevCompany manifest is STATICALLY valid, but its tool/validator requirements point
 * at Sprint 17 runtime providers that do not exist yet. This suite proves the only
 * runtime-level claim Task-16-03 makes: installing the real product manifest into a
 * company whose tool registry lacks those providers FAILS CLOSED with zero durable writes.
 * A successful install through the real PackService (with a satisfying registry) is
 * Task-16-05 scope and is deliberately NOT attempted here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuthorizationService,
  createPackService,
  createWorkflowLifecycle,
  ensureBootstrapOwner,
  type ToolRequirementResolver,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { DEVCOMPANY_MANIFEST } from '@companyos/pack-dev-company';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t16install-'));
  created.push(dir);
  return dir;
};
let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_16I${String(++seq).padStart(12, '0')}`,
  ulid: () => `16I${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-26T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-26T00:00:00.000Z') + seq * 1_000, nowIso };

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('DevCompany install before the Sprint 17 runtime', () => {
  it('fails closed on the unmet tool requirement with zero durable writes', async () => {
    const db = openDurableDatabase({
      dataDir: tempDir(),
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'agent', 'tools', 'artifact', 'pack'],
    });
    database = db;
    const actor = 'user_owner';
    const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
    const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);

    const lifecycle = createWorkflowLifecycle({
      ids,
      clock,
      templates: db.templates,
      locks: db.locks,
      proposals: db.proposals,
      snapshots: db.snapshots,
      runs: db.runs,
      events: db.events,
      unitOfWork: db.unitOfWork,
    });
    // An EMPTY registry: no Sprint 17 provider is registered in production yet.
    const requirementResolver: ToolRequirementResolver = { resolve: async () => ({ ok: false as const }) };
    const service = createPackService({
      clock,
      ids,
      authorization: authz,
      lifecycle,
      packVersions: db.packVersions!,
      packInstallations: db.packInstallations!,
      packContentRefs: db.packContentRefs!,
      events: db.events,
      ledger: db.ledger,
      unitOfWork: db.unitOfWork,
      toolRequirementResolver: requirementResolver,
    });

    const denied = await service.install({
      commandId: 'cmd_devcompany_pre_s17',
      companyId: 'company_default',
      actorId: actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_devcompany_pre_s17',
    });

    // The first unmet requirement (repo.test-runner) fails the preflight closed.
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.details['reason']).toBe('PACK_TOOL_MISSING');
    expect(denied.error.details['toolId']).toBe('repo.test-runner');

    // Zero durable writes: no installation, no PackVersion, no content refs, no materialized
    // role, no workflow template, and no success event.
    expect(db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
    expect(db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(0);
    expect(db.db.prepare('SELECT * FROM pack_content_refs').all()).toHaveLength(0);
    expect(db.db.prepare('SELECT * FROM workflow_templates').all()).toHaveLength(0);
    const roles = db.db.prepare('SELECT key FROM roles').all() as { key: string }[];
    expect(roles.every((role) => role.key === 'owner')).toBe(true);
    const eventTypes = db.db.prepare('SELECT type FROM events').all().map((row) => (row as { type: string }).type);
    expect(eventTypes).not.toContain('pack.installed');
  });

  it('reports the same closed failure for the validator requirement', async () => {
    const db = openDurableDatabase({
      dataDir: tempDir(),
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'agent', 'tools', 'artifact', 'pack'],
    });
    database = db;
    const actor = 'user_owner';
    const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
    const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);

    const lifecycle = createWorkflowLifecycle({
      ids,
      clock,
      templates: db.templates,
      locks: db.locks,
      proposals: db.proposals,
      snapshots: db.snapshots,
      runs: db.runs,
      events: db.events,
      unitOfWork: db.unitOfWork,
    });
    // A registry that knows every required TOOL but none of them validates: the tool
    // requirements pass and the validator requirement fails closed instead.
    const requirementResolver: ToolRequirementResolver = {
      resolve: async () => ({ ok: true as const, capabilities: [] }),
    };
    const service = createPackService({
      clock,
      ids,
      authorization: authz,
      lifecycle,
      packVersions: db.packVersions!,
      packInstallations: db.packInstallations!,
      packContentRefs: db.packContentRefs!,
      events: db.events,
      ledger: db.ledger,
      unitOfWork: db.unitOfWork,
      toolRequirementResolver: requirementResolver,
    });

    const denied = await service.install({
      commandId: 'cmd_devcompany_validator_missing',
      companyId: 'company_default',
      actorId: actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_devcompany_validator_missing',
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.details['reason']).toBe('PACK_VALIDATOR_MISSING');
    expect(denied.error.details['validatorId']).toBe('repo.validation-evidence');
    expect(db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
    expect(db.db.prepare('SELECT * FROM pack_content_refs').all()).toHaveLength(0);
  });
});

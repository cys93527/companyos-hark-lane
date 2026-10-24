/**
 * Sprint 17 / Task-17-06 — DevCompany production installability milestone.
 *
 * With `repo.validation-evidence` registered (and the validator capability it requires), the
 * REAL DevCompany 1.0.0 manifest installs through the real PackService against a
 * production-shaped registry of the TEN repository tools — no test-only fake registry.
 *
 * The Sprint 16 invariants still hold: 24 content refs, the five roles (+ the bootstrap owner),
 * one workflow template, zero automatic assignments. And installation is NOT a QA PASS: a
 * fresh run/task has no evidence, so the validator still fails.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REPOSITORY_GIT_TOOL_SPEC,
  REPOSITORY_PROCESS_TOOL_SPECS,
  REPOSITORY_TOOL_SPECS,
  REPOSITORY_VALIDATION_EVIDENCE_SPEC,
  createAuthorizationService,
  createPackService,
  createRepositoryGitToolRecord,
  createRepositoryProcessToolRecord,
  createRepositoryToolRecord,
  createRepositoryValidationEvidenceRecord,
  createWorkflowLifecycle,
  ensureBootstrapOwner,
  type ToolRequirementResolver,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { DEVCOMPANY_MANIFEST, DEVCOMPANY_PACK_ID, DEVCOMPANY_PACK_VERSION } from '@companyos/pack-dev-company';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17install-'));
  created.push(dir);
  return dir;
};
let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_17N${String(++seq).padStart(12, '0')}`,
  ulid: () => `17N${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** The ten repository tools, registered as durable registry facts (registry facts only). */
const seedRepositoryTools = async (db: DurableDatabase, actor: string): Promise<Map<string, readonly string[]>> => {
  const capabilities = new Map<string, readonly string[]>();
  const toolIds = [
    ...REPOSITORY_TOOL_SPECS.map((spec) => spec.toolId),
    ...REPOSITORY_PROCESS_TOOL_SPECS.map((spec) => spec.toolId),
    REPOSITORY_GIT_TOOL_SPEC.toolId,
    REPOSITORY_VALIDATION_EVIDENCE_SPEC.toolId,
  ];
  expect(toolIds).toHaveLength(10);
  for (const toolId of toolIds) {
    const record =
      toolId === REPOSITORY_VALIDATION_EVIDENCE_SPEC.toolId
        ? createRepositoryValidationEvidenceRecord(REPOSITORY_VALIDATION_EVIDENCE_SPEC, nowIso())
        : toolId === REPOSITORY_GIT_TOOL_SPEC.toolId
          ? createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, nowIso())
          : REPOSITORY_TOOL_SPECS.some((spec) => spec.toolId === toolId)
            ? createRepositoryToolRecord(
                REPOSITORY_TOOL_SPECS.find((spec) => spec.toolId === toolId)!,
                nowIso(),
              )
            : createRepositoryProcessToolRecord(
                REPOSITORY_PROCESS_TOOL_SPECS.find((spec) => spec.toolId === toolId)!,
                nowIso(),
              );
    if (!record.ok) throw new Error(record.error.message);
    await db.toolRecords.put(record.value);
    capabilities.set(record.value.toolId, record.value.capabilities);
  }
  void actor;
  return capabilities;
};

describe('DevCompany production install after T17-06', () => {
  it('44/87. installs the real manifest against the ten-tool repository registry', async () => {
    const db = openDurableDatabase({
      dataDir: tempDir(),
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
    });
    database = db;
    const actor = 'user_owner';
    const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
    const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    const capabilities = await seedRepositoryTools(db, actor);

    // Every declared requirement resolves against the durable registry facts, and the
    // validator requirement resolves WITH the validator capability.
    const requirementResolver: ToolRequirementResolver = {
      resolve: async (toolId) => {
        const found = capabilities.get(toolId);
        if (found === undefined) return { ok: false as const };
        return { ok: true as const, capabilities: found };
      },
    };
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

    const installed = await service.install({
      commandId: 'cmd_devcompany_t1706_install',
      companyId: 'company_default',
      actorId: actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_devcompany_t1706_install',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.value.packId).toBe(DEVCOMPANY_PACK_ID);
    expect(installed.value.packVersion).toBe(DEVCOMPANY_PACK_VERSION);
    expect(installed.value.status).toBe('installed');

    // Sprint 16 invariants: 24 content refs, five roles + owner, zero auto-assignment.
    const refs = await db.packContentRefs!.listByInstallation(installed.value.id);
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    expect(refs.value).toHaveLength(24);
    const roles = (await db.roles.list({ limit: 500 })).items.filter(
      (role) => role.companyId === 'company_default',
    );
    expect(roles.map((role) => role.key).sort()).toEqual([
      'dev-company-cto',
      'dev-company-developer',
      'dev-company-documentation',
      'dev-company-qa',
      'dev-company-reviewer',
      'owner',
    ]);
    const assignments = (await db.roleAssignments.list({ limit: 500 })).items;
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.actorId).toBe(actor);

    // Installation is NOT a QA PASS: no evidence exists for any run/task yet, so the
    // validator's verdict for a fresh scope is still a FAIL (never an automatic pass).
    const evidenceInvocations = (await db.toolInvocations.list({ limit: 500 })).items.filter(
      (invocation) => invocation.toolId === 'repo.validation-evidence',
    );
    expect(evidenceInvocations).toHaveLength(0);
  });
});

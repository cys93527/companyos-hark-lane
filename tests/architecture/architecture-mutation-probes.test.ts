/**
 * Sprint 22 — architecture law probes.
 *
 * Every automated guard in scripts/check-architecture.mjs is proven in BOTH
 * directions (Boss §38): a forbidden fixture MUST fail with the law's ARCH id,
 * and a legitimate fixture MUST pass. These are the mutation probes (Boss §48):
 * if a guard is ever weakened or removed, the corresponding probe here fails.
 *
 * The real repository scan must stay at ZERO violations (Boss §47 baseline
 * rule) and the documented exemption must be reported — never silent.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkArchitecture } from '../../scripts/check-architecture.mjs';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** Build a throw-away repository fixture tree and scan it. */
const fixture = (files: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), 'companyos-arch-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return checkArchitecture(root);
};

const lawsOf = (result: ReturnType<typeof checkArchitecture>) =>
  result.violations.map((violation) => violation.law);

/* ================================================================ ARCH-003 · direction */

describe('ARCH-003 — dependency direction (source level)', () => {
  it('an engine source importing desktop is caught', () => {
    const result = fixture({
      'packages/engine/src/evil.ts': "import { composeCoreServices } from '@companyos/desktop';\nexport const x = composeCoreServices;\n",
    });
    expect(lawsOf(result)).toContain('ARCH-003');
  });

  it('a persistence source importing electron is caught', () => {
    const result = fixture({
      'packages/persistence/src/evil.ts': "import { app } from 'electron';\nexport const x = app;\n",
    });
    expect(lawsOf(result)).toContain('ARCH-003');
  });

  it('engine importing core ports is allowed', () => {
    const result = fixture({
      'packages/engine/src/fine.ts': "import { ok } from '@companyos/core';\nexport const x = ok;\n",
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-004 · pinning */

describe('ARCH-004 — pinned WorkflowVersion authority', () => {
  it('currentVersion inside an execution module is caught', () => {
    const result = fixture({
      'packages/engine/src/supervisor/evil.ts':
        'const version = template.currentVersionId;\nexport const x = version;\n',
    });
    expect(lawsOf(result)).toContain('ARCH-004');
  });

  it('latestVersion inside the projector is caught', () => {
    const result = fixture({
      'packages/engine/src/projection/evil.ts': 'export const x = template.latestVersion;\n',
    });
    expect(lawsOf(result)).toContain('ARCH-004');
  });

  it('resolving the run-pinned version is allowed', () => {
    const result = fixture({
      'packages/engine/src/supervisor/fine.ts':
        'const version = template.versions.find((entry) => entry.id === run.versionId);\nexport const x = version;\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-005/006 · no second truth */

describe('ARCH-005/006 — no second DAG, no second scheduler, no unlisted storage', () => {
  it('a task-edge table is caught', () => {
    const result = fixture({
      'packages/persistence/migrations/engine/0099_evil.sql':
        'CREATE TABLE IF NOT EXISTS task_edges (from_task TEXT, to_task TEXT);\n',
    });
    expect(lawsOf(result)).toContain('ARCH-005');
  });

  it('a scheduler table is caught', () => {
    const result = fixture({
      'packages/persistence/migrations/engine/0099_evil.sql':
        'CREATE TABLE IF NOT EXISTS scheduler (id TEXT);\n',
    });
    expect(lawsOf(result)).toContain('ARCH-005');
  });

  it('a work-package table is caught', () => {
    const result = fixture({
      'packages/persistence/migrations/engine/0099_evil.sql':
        'CREATE TABLE IF NOT EXISTS work_packages (id TEXT);\n',
    });
    expect(lawsOf(result)).toContain('ARCH-005');
  });

  it('an unlisted new table is caught (inventory amendment required)', () => {
    const result = fixture({
      'packages/persistence/migrations/engine/0099_evil.sql':
        'CREATE TABLE IF NOT EXISTS brand_new_thing (id TEXT);\n',
    });
    expect(lawsOf(result)).toContain('ARCH-006');
  });

  it('an inventory table is allowed', () => {
    const result = fixture({
      'packages/persistence/migrations/engine/0099_fine.sql':
        'CREATE TABLE IF NOT EXISTS execution_attempts (attempt_id TEXT PRIMARY KEY);\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-008 · WorkPackage derived */

describe('ARCH-008 — WorkPackage is derived-only', () => {
  it('a WorkPackage mutating export is caught', () => {
    const result = fixture({
      'packages/engine/src/projection/work-package-projector.ts':
        'export function saveWorkPackage(input: unknown): unknown {\n  return input;\n}\n',
    });
    expect(lawsOf(result)).toContain('ARCH-008');
  });

  it('the projector factory and its projection read are allowed', () => {
    const result = fixture({
      'packages/engine/src/projection/work-package-projector.ts':
        'export const createWorkPackageProjector = (deps: unknown) => ({\n  project: async (input: unknown) => input,\n});\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-009 · Handoff owner */

describe('ARCH-009 — single Handoff owner', () => {
  it('a handoff table outside the Sprint11 chain is caught', () => {
    const result = fixture({
      'packages/persistence/migrations/engine/0099_evil.sql':
        'CREATE TABLE IF NOT EXISTS runtime_handoffs (id TEXT);\n',
    });
    expect(lawsOf(result)).toContain('ARCH-009');
  });

  it('the Sprint11 handoff chain is allowed', () => {
    const result = fixture({
      'packages/persistence/migrations/handoff/0001_handoffs.sql':
        'CREATE TABLE IF NOT EXISTS handoffs (handoff_id TEXT, version INTEGER);\nCREATE TABLE IF NOT EXISTS handoff_refs (id TEXT);\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-010 · task ownership */

describe('ARCH-010 — Task belongs to Run', () => {
  it('a company_id column on tasks is caught', () => {
    const result = fixture({
      'packages/persistence/migrations/engine/0099_evil.sql':
        'CREATE TABLE IF NOT EXISTS tasks_t_evil (\n  id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  company_id TEXT NOT NULL\n);\n',
    });
    expect(lawsOf(result)).toContain('ARCH-010');
  });

  it('companyId on the Task domain type is caught', () => {
    const result = fixture({
      'packages/core/src/domain/task.ts':
        'export interface Task {\n  readonly id: string;\n  readonly companyId: string;\n}\n',
    });
    expect(lawsOf(result)).toContain('ARCH-010');
  });

  it('run-scoped ownership is allowed', () => {
    const result = fixture({
      'packages/core/src/domain/task.ts':
        'export interface Task {\n  readonly id: string;\n  readonly runId: string;\n}\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-012/013 · attempt split */

describe('ARCH-012/013 — ExecutionAttempt ≠ Task; AgentExecution ≠ Attempt', () => {
  const path = 'packages/core/src/lifecycle/execution-attempt.ts';

  it('the attempt domain importing findings/validation modules is caught', () => {
    const result = fixture({
      [path]: "import { recordFinding } from '../supervisor/review-findings-sink.js';\nexport const x = recordFinding;\n",
    });
    expect(lawsOf(result)).toContain('ARCH-012');
  });

  it('model provenance on the attempt seed is caught', () => {
    const result = fixture({
      [path]:
        'export interface ExecutionAttemptSeed {\n  readonly modelKey: string;\n  readonly providerId: string;\n}\n',
    });
    expect(lawsOf(result)).toContain('ARCH-013');
  });

  it('the frozen attempt seed is allowed', () => {
    const result = fixture({
      [path]:
        'export interface ExecutionAttemptSeed {\n  readonly companyId: string;\n  readonly runId: string;\n  readonly taskId: string;\n  readonly attemptNumber: number;\n  readonly roleId: string;\n  readonly taskKind: string;\n}\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-017 · D1 scoping */

describe('ARCH-017 — D1 subject/global scope split', () => {
  const path = 'packages/engine/src/supervisor/supervisor-runtime.ts';

  it('a projection populated before the subject-match gate is caught (foreign hijack)', () => {
    const result = fixture({
      [path]:
        'const reports = [];\n' +
        // the projection is populated BEFORE any subject match — the foreign-hijack shape
        'const review = { artifactId: anchor.artifactId };\n' +
        'for (const anchor of anchors) {\n' +
        '  reports.push(anchor);\n' +
        '}\n' +
        'const subjectMatched = anchorSubjectMatched(anchor);\n' +
        'export const x = { subjectMatched, review, reports };\n',
    });
    expect(lawsOf(result)).toContain('ARCH-017');
  });

  it('a missing subject-match gate is caught', () => {
    const result = fixture({
      [path]: 'export const x = () => ({ review: { artifactId: "a" } });\n',
    });
    expect(lawsOf(result)).toContain('ARCH-017');
  });

  it('the frozen ordering (gate first, projection inside the matched branch) is allowed', () => {
    const result = fixture({
      [path]:
        'const subjectMatched = anchorSubjectMatched(anchor);\n' +
        'if (subjectMatched) {\n' +
        '  const review = { artifactId: anchor.artifactId };\n' +
        '  const anchorReports = [anchor];\n' +
        '  export const x = { review, anchorReports };\n' +
        '}\n' +
        'const blocking = anchors.filter((a) => unresolved(a));\n' +
        'export const y = blocking;\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-019/020 · reassessment ownership */

describe('ARCH-019/020 — corrective/reassessment authority', () => {
  it('a second writer of the reassessment marker is caught', () => {
    const result = fixture({
      'packages/engine/src/supervisor/evil-helper.ts':
        "import { createTask } from '@companyos/core';\n" +
        "export const seed = () => createTask({ inputs: { 'companyos:reassessment': { correctiveTaskId: 'x' } } });\n",
    });
    expect(lawsOf(result)).toContain('ARCH-019');
  });

  it('the provisioner as the only marker writer is allowed', () => {
    const result = fixture({
      'packages/engine/src/supervisor/corrective-provisioner.ts':
        "const inputs = { 'companyos:reassessment': { correctiveTaskId } };\nexport const x = inputs;\n",
    });
    expect(result.violations).toEqual([]);
  });

  it('a descendant scan without a pinned-version read is caught', () => {
    const result = fixture({
      'packages/engine/src/supervisor/corrective-provisioner.ts':
        'const descendantStages = descendantsOf(stage);\nexport const x = descendantStages;\n',
    });
    expect(lawsOf(result)).toContain('ARCH-020');
  });

  it('the pinned-DAG descendant derivation is allowed', () => {
    const result = fixture({
      'packages/engine/src/supervisor/corrective-provisioner.ts':
        'const version = template.versions.find((entry) => entry.id === run.versionId);\n' +
        'const descendantStages = strictDescendantsOf(version.graph, stage);\n' +
        'export const x = descendantStages;\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-021/022 · claim & transaction */

describe('ARCH-021/022 — claim before executor; no write TX across executor', () => {
  const path = 'packages/engine/src/engine.ts';

  it('an executor invoked before the claim is caught', () => {
    const result = fixture({
      [path]:
        'const handler = deps.handlers.resolve(kind);\n' +
        'await handler.execute({ taskId });\n' +
        'const claimedTx = await inTransaction(async () => claimExecutionAttempt(request, taskId));\n' +
        'export const x = claimedTx;\n',
    });
    expect(lawsOf(result)).toContain('ARCH-021');
  });

  it('an executor call inside a write transaction is caught', () => {
    const result = fixture({
      [path]:
        'const claim = request;\n' +
        'const claimedTx = await inTransaction(async () => claimExecutionAttempt(request, taskId));\n' +
        'const settled = await inTransaction(async () => {\n' +
        '  const handler = deps.handlers.resolve(kind);\n' +
        '  await handler.execute({ taskId });\n' +
        '  return claim;\n' +
        '});\n' +
        'export const x = { claimedTx, settled };\n',
    });
    expect(lawsOf(result)).toContain('ARCH-022');
  });

  it('the frozen timeline (claim → executor outside → settlement) is allowed', () => {
    const result = fixture({
      [path]:
        'const claimedTx = await inTransaction(async () => claimExecutionAttempt(request, taskId));\n' +
        'const handler = deps.handlers.resolve(claim.task.kind);\n' +
        'const reported = await handler.execute({ taskId });\n' +
        'const settledTx = await inTransaction(async () => settleExecutionAttempt(claim, "succeeded", stageOutput));\n' +
        'export const x = { claimedTx, reported, settledTx };\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-027 · UI not truth */

describe('ARCH-027 — UI is not truth', () => {
  it('a renderer importing the persistence store is caught', () => {
    const result = fixture({
      'apps/renderer/src/evil.ts': "import { openDurableDatabase } from '@companyos/persistence';\nexport const x = openDurableDatabase;\n",
    });
    expect(lawsOf(result)).toContain('ARCH-027');
  });

  it('a renderer importing contracts only is allowed', () => {
    const result = fixture({
      'apps/renderer/src/fine.ts': "import type { IpcContract } from '@companyos/contracts';\nexport const x: IpcContract | null = null;\n",
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-028 · session is context */

describe('ARCH-028 — session is context, not workflow truth', () => {
  it('a session module dispatching run events is caught', () => {
    const result = fixture({
      'packages/engine/src/session/evil.ts': 'export const x = () => dispatchInternal(runId, "RUN.START");\n',
    });
    expect(lawsOf(result)).toContain('ARCH-028');
  });

  it('a session module returning its round outcome is allowed', () => {
    const result = fixture({
      'packages/engine/src/session/fine.ts': 'export const x = () => ({ ok: true as const, value: { executionId: "e" } });\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-031 · software is a pack */

describe('ARCH-031 — software is a Pack (generic paths)', () => {
  it('software vocabulary as an identifier in a generic module is caught', () => {
    const result = fixture({
      'packages/engine/src/supervisor/evil.ts':
        'export const developerTaskKinds = ["coding"];\nexport const y = developerTaskKinds;\n',
    });
    expect(lawsOf(result)).toContain('ARCH-031');
  });

  it('an undocumented import of the repository seam from a generic module is caught', () => {
    const result = fixture({
      'packages/engine/src/projection/evil.ts': "import { repositoryGitTools } from '../repository/repository-git.js';\nexport const x = repositoryGitTools;\n",
    });
    expect(lawsOf(result)).toContain('ARCH-031');
  });

  it('neutral generic vocabulary is allowed', () => {
    const result = fixture({
      'packages/engine/src/supervisor/fine.ts':
        'export const taskKinds = ["task.supplier-analysis"];\nexport const y = taskKinds;\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ ARCH-007 · recency authority */

describe('ARCH-007 — no latest-object authority', () => {
  it('an ORDER BY created_at DESC outside a tie-break is caught', () => {
    const result = fixture({
      'packages/engine/src/supervisor/evil.ts':
        'export const query = "SELECT * FROM runs ORDER BY created_at DESC";\n',
    });
    expect(lawsOf(result)).toContain('ARCH-007');
  });

  it('a documented tie-break function using recency is allowed', () => {
    const result = fixture({
      'packages/engine/src/projection/fine.ts':
        'const byDeterministicRecency = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number =>\n' +
        '  String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || String(a.id).localeCompare(String(b.id));\n' +
        'export const x = byDeterministicRecency;\n',
    });
    expect(result.violations).toEqual([]);
  });
});

/* ================================================================ the violation contract (§46) */

describe('violation output contract (Boss §46)', () => {
  it('every violation names law, what, where, why and the remediation', () => {
    const result = fixture({
      'packages/engine/src/evil.ts': "import { app } from 'electron';\nexport const x = app;\n",
    });
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    for (const violation of result.violations) {
      expect(violation.law).toMatch(/^ARCH-\d{3}$/);
      expect(violation.what.length).toBeGreaterThan(0);
      expect(violation.where.length).toBeGreaterThan(0);
      expect(violation.why.length).toBeGreaterThan(0);
      expect(violation.fix.length).toBeGreaterThan(0);
    }
  });

  it('comments and string literals never trip a guard (false-positive control)', () => {
    const result = fixture({
      'packages/engine/src/supervisor/commented.ts':
        '// this module must never import electron or name git/repository/developer\n' +
        'const note = "forbidden words live here: git, repository, developer, reviewer, qa";\n' +
        'export const x = note;\n',
      'packages/engine/src/engine.ts': 'export const y = 1;\n',
    });
    expect(result.violations).toEqual([]);
  });
});

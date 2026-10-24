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
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { checkArchitecture } from '../../scripts/check-architecture.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LAWS_DOC = readFileSync(
  fileURLToPath(new URL('../../docs/architecture/ARCHITECTURE_LAWS.md', import.meta.url)),
  'utf8',
);

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

/* ================================================================ the guard itself */

describe('architecture guard — baseline', () => {
  it('the frozen repository produces ZERO violations', {timeout: 120_000}, () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.violations).toEqual([]);
  });

  it('the documented exceptions are REPORTED on every run (never silent)', {timeout: 120_000}, () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.notes).toHaveLength(2);
    expect(result.notes.every((note) => note.includes('EXEMPTION'))).toBe(true);
    expect(result.notes.join(' | ')).toContain('bounded-agent-context.ts');
    expect(result.notes.join(' | ')).toContain('qa-evidence');
    expect(result.notes.join(' | ')).toContain('repository-runtime.ts');
    expect(result.notes.join(' | ')).toContain('ARCH-007');
    // …and the exception is written down in the law document.
    expect(LAWS_DOC).toContain('REQUIRED_QA_EVIDENCE_SLOTS');
  });

  it('every law id the guard can emit is documented in ARCHITECTURE_LAWS.md', () => {
    const emitted = [
      'ARCH-001', 'ARCH-002', 'ARCH-003', 'ARCH-004', 'ARCH-005', 'ARCH-006', 'ARCH-008', 'ARCH-009',
      'ARCH-010', 'ARCH-012', 'ARCH-013', 'ARCH-017', 'ARCH-019', 'ARCH-020',
      'ARCH-021', 'ARCH-022', 'ARCH-027', 'ARCH-028', 'ARCH-031',
      'ARCH-033', 'ARCH-034', 'ARCH-035', 'ARCH-036',
      'ARCH-037', 'ARCH-038', 'ARCH-039',
      'ARCH-040', 'ARCH-041', 'ARCH-042', 'ARCH-043', 'ARCH-044',
    ];
    for (const law of emitted) {
      expect(LAWS_DOC, `${law} missing from the law document`).toContain(`### ${law} `);
    }
    // The forbidden categories and the inventory live in the document too.
    expect(LAWS_DOC).toContain('## Table inventory');
    expect(LAWS_DOC).toContain('## Exceptions');
  });

  it('ARCH-024: external exactly-once stays documented as NOT GUARANTEED', () => {
    expect(LAWS_DOC).toContain('NOT GUARANTEED');
    expect(LAWS_DOC).toContain('REAL_PRODUCTION_PROVIDER_EXECUTOR');
  });
});

/* ================================================================ Sprint 25 safety laws */

describe('ARCH-033 — no wholesale parent-environment inheritance (both directions)', () => {
  it('a process.env spread into a child environment FAILS with ARCH-033', () => {
    const result = fixture({
      'packages/engine/src/executor/leaky-provider.ts':
        "export const spawn2 = (cmd, argv) => require('node:child_process').spawn(cmd, argv, {\n" +
        "  shell: false,\n" +
        '  env: { ...process.env, ...(additions ?? {}) },\n' +
        '});\n',
    });
    const found = result.violations.filter((violation) => violation.law === 'ARCH-033');
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]?.what).toContain('process.env');
  });

  it('an unfiltered `env: process.env` FAILS with ARCH-033', () => {
    const result = fixture({
      'apps/desktop/src/executor/leaky-adapter.ts':
        "export const run = (cmd, argv) => require('node:child_process').spawn(cmd, argv, { env: process.env });\n",
    });
    expect(result.violations.some((violation) => violation.law === 'ARCH-033')).toBe(true);
  });

  it('an allowlist policy and process.env as a FILTER SOURCE pass', () => {
    const result = fixture({
      'packages/engine/src/executor/provider.ts':
        'export const build = (policy) => ({\n' +
        '  hostEnv: process.env,\n' +
        '  allowlist: policy.allowlist,\n' +
        '  declaredAdditions: { SAFE_FLAG: "1" },\n' +
        '});\n',
      'packages/engine/src/engine.ts': 'export const y = 1;\n',
    });
    expect(result.violations.filter((violation) => violation.law === 'ARCH-033')).toEqual([]);
  });
});

describe('ARCH-034 — containment is a component boundary (both directions)', () => {
  it('a raw `startsWith(root)` containment FAILS with ARCH-034', () => {
    const result = fixture({
      'packages/engine/src/repository/bad-contain.ts':
        'export const inside = (absolute, root) => absolute.startsWith(root);\n',
    });
    const found = result.violations.filter((violation) => violation.law === 'ARCH-034');
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]?.what).toContain('startsWith(root)');
  });

  it('a separator-terminated root and non-path startsWith pass', () => {
    const result = fixture({
      'packages/engine/src/repository/good-contain.ts':
        'export const inside = (absolute, root) => absolute.startsWith(root + sep);\n' +
        'export const branch = (text) => text.startsWith("# branch.oid ");\n',
      'packages/engine/src/engine.ts': 'export const y = 1;\n',
    });
    expect(result.violations.filter((violation) => violation.law === 'ARCH-034')).toEqual([]);
  });
});

describe('ARCH-035 - the renderer is untrusted (both directions)', () => {
  it('a renderer file importing persistence FAILS with ARCH-035', () => {
    const result = fixture({
      'apps/renderer/src/evil.tsx':
        "import { openDurableDatabase } from '@companyos/persistence';" + "\\n" + "export const x = 1;",
    });
    expect(result.violations.some((violation) => violation.law === 'ARCH-035')).toBe(true);
  });

  it('bridge-only renderer sources pass', () => {
    const result = fixture({
      'apps/renderer/src/bridge.ts':
        'export const call = (bridge: { controlPlaneRequest(r: unknown): Promise<unknown> }) => bridge.controlPlaneRequest({ operation: 1 });',
      'packages/engine/src/engine.ts': 'export const y = 1;',
    });
    expect(result.violations.filter((violation) => violation.law === 'ARCH-035')).toEqual([]);
  });
});

describe('ARCH-036 - the Control Plane projection is read-only (both directions)', () => {
  it('a direct SQL write inside control-plane.ts FAILS with ARCH-036', () => {
    const result = fixture({
      'apps/desktop/src/control-plane.ts':
        'export const cheat = (db: { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }) => db.db.prepare(\'UPDATE runs SET state = ?\').run(\'COMPLETED\');',
    });
    expect(result.violations.some((violation) => violation.law === 'ARCH-036')).toBe(true);
  });

  it('a read-only control-plane module passes', () => {
    const result = fixture({
      'apps/desktop/src/control-plane.ts':
        'export const read = (db: { prepare(q: string): { get(): unknown } }) => db.prepare(\'SELECT state FROM runs\').get();',
    });
    expect(result.violations.filter((violation) => violation.law === 'ARCH-036')).toEqual([]);
  });
});

/* ================================================================ ARCH-037 (V1 Product Reachability) */

describe('ARCH-037 — an external provider is never CompanyOS authority', () => {
  it('a production source importing the TEST mock provider FAILS (silently fabricated reasoning)', () => {
    const result = fixture({
      'apps/desktop/src/evil-composition.ts':
        "import { createMockProvider } from '@companyos/engine/dist/providers/mock-provider.js';\nexport const x = createMockProvider({ providerId: 'p' });\n",
    });
    expect(result.violations.some((violation) => violation.law === 'ARCH-037')).toBe(true);
  });

  it('a vendor identifier in the frozen inner ring FAILS (product bound to a provider brand)', () => {
    const result = fixture({
      'packages/engine/src/executor/evil.ts':
        'const preferred = dsh;\nconst alternate = openai;\nexport const routes = { preferred, alternate };\n',
    });
    expect(result.violations.some((violation) => violation.law === 'ARCH-037')).toBe(true);
  });

  it('vendor names inside comments/strings of the inner ring do NOT trip (false-positive control)', () => {
    const result = fixture({
      'packages/engine/src/executor/clean.ts':
        '// the dsh adapter lives in the desktop layer; this module stays vendor-neutral\nconst note = "not openai either";\nexport const x = note;\n',
      'packages/core/src/index.ts': 'export const y = 1;\n',
    });
    expect(result.violations.filter((violation) => violation.law === 'ARCH-037')).toEqual([]);
  });

  it('the shipped repository is clean under ARCH-037 (both facets)', {timeout: 120_000}, () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.violations.filter((violation) => violation.law === 'ARCH-037')).toEqual([]);
  });
});

/* ================================================================ ARCH-038 (Execution Architecture Freeze) */

describe('ARCH-038 — reasoning and execution are distinct capability classes', () => {
  it('a REASONING runtime importing executor-provider machinery FAILS', () => {
    const result = fixture({
      'packages/engine/src/supervisor/evil.ts':
        "import { createExecutorProviderRegistry } from '../executor/executor-provider.js';\nexport const x = createExecutorProviderRegistry;\n",
    });
    expect(result.violations.some((violation) => violation.law === 'ARCH-038')).toBe(true);
  });

  it('the EXECUTION dispatch importing model-registry machinery FAILS', () => {
    const result = fixture({
      'apps/desktop/src/executor/evil.ts':
        "import { createModelRegistry } from '../../packages/engine/src/registry/model-registry.js';\nexport const x = createModelRegistry;\n",
    });
    expect(result.violations.some((violation) => violation.law === 'ARCH-038')).toBe(true);
  });

  it('the shipped repository is clean under ARCH-038 (both directions)', {timeout: 120_000}, () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.violations.filter((violation) => violation.law === 'ARCH-038')).toEqual([]);
  });
});

/* ================================================================ ARCH-039 (Native Execution Foundation) */

describe('ARCH-039 — natural-language task content is never an executable', () => {
  it('task prose used in the native provider CODE fails (free-text-to-shell forbidden)', () => {
    const result = fixture({
      'apps/desktop/src/executor/native-process-provider.ts':
        "const argv = [...profile.args, request.taskText];\nexport const x = argv;\n",
    });
    expect(result.violations.some((violation) => violation.law === 'ARCH-039')).toBe(true);
  });

  it('prose in COMMENTS/strings does not trip (false-positive control)', () => {
    const result = fixture({
      'apps/desktop/src/executor/native-process-provider.ts':
        '// request.taskText must NEVER reach argv\nconst argv = [...profile.args];\nexport const x = argv;\n',
    });
    expect(result.violations.filter((violation) => violation.law === 'ARCH-039')).toEqual([]);
  });

  it('the shipped repository is clean under ARCH-039', () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.violations.filter((violation) => violation.law === 'ARCH-039')).toEqual([]);
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

/* ================================================================ ARCH-040 (Smart Model Routing V1) */

describe('ARCH-040 — the Smart Router is a pure deterministic decision function', () => {
  it('a router importing provider/executor machinery FAILS with ARCH-040', () => {
    const result = fixture({
      'apps/desktop/src/executor/smart-model-router.ts':
        "import { dispatch } from './dsh-executor-provider.js';\nexport const x = dispatch;\n",
    });
    const found = result.violations.filter((v) => v.law === 'ARCH-040');
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]!.why).toContain('Router Uses LLM = NO');
  });

  it('a network call or a tournament/vote/fallback identifier FAILS with ARCH-040', () => {
    const result = fixture({
      'apps/desktop/src/executor/smart-model-router.ts':
        'export const choose = (candidates) => candidates.map((c) => c);\nexport const call = () => fetch("http://x");\nexport const t = 1;\n',
    });
    const laws = result.violations.filter((v) => v.law === 'ARCH-040').map((v) => v.what);
    expect(laws.some((w) => w.includes('network call'))).toBe(true);
    const tournament = fixture({
      'apps/desktop/src/executor/smart-model-router.ts':
        'export const tournament = (a, b) => a;\nexport const vote = (a) => a;\n',
    });
    expect(tournament.violations.filter((v) => v.law === 'ARCH-040').length).toBeGreaterThanOrEqual(2);
  });

  it('the shipped router references no provider call and no forbidden identifier', {timeout: 120_000}, () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.violations.filter((v) => v.law === 'ARCH-040')).toEqual([]);
  });
});

/* ================================================================ ARCH-041 (Role Collaboration V1) */

describe('ARCH-041 — collaboration has no second truth and no peer chat', () => {
  it('a role_messages / agent_chat / team_task_store / scheduler identifier FAILS with ARCH-041', () => {
    for (const name of ['role_messages', 'agent_chat', 'team_task_store', 'agent_team_scheduler', 'peer_workflow_state']) {
      const result = fixture({
        'apps/desktop/src/executor/role-collaboration.ts': `export const rows = ${name};\n`,
      });
      expect(result.violations.filter((v) => v.law === 'ARCH-041').length).toBe(1);
    }
  });

  it('a second-truth table in a NEW migration FAILS (ARCH-005/006 extension)', () => {
    const result = fixture({
      'packages/persistence/migrations/0099_second_truth.sql': 'CREATE TABLE role_messages (id TEXT PRIMARY KEY);\n',
    });
    const found = result.violations.filter((v) => v.why.includes('second collaboration truth') || v.why.includes('peer chat') || v.why.includes('scheduling truth'));
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  it('a scheduling mutator in the collaboration module FAILS with ARCH-041', () => {
    const result = fixture({
      'apps/desktop/src/executor/role-collaboration.ts':
        'export const scheduleTask = (task) => task;\nexport const assignTask = (task) => task;\n',
    });
    expect(result.violations.some((v) => v.law === 'ARCH-041' && v.what.includes('scheduling/assignment mutator'))).toBe(true);
  });

  it('the shipped collaboration module is clean under ARCH-041', {timeout: 120_000}, () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.violations.filter((v) => v.law === 'ARCH-041')).toEqual([]);
  });
});

/* ================================================================ ARCH-042 (attempt model ownership) */

describe('ARCH-042 — the RoleInstance never owns a selected model', () => {
  it('a modelLock / selectedModel field on RoleInstance FAILS with ARCH-042', () => {
    const result = fixture({
      'apps/desktop/src/executor/role-orchestration.ts':
        'export interface RoleInstance {\n  readonly roleInstanceId: string;\n  readonly modelLock: string | null;\n}\nexport const x = 1;\n',
    });
    const found = result.violations.filter((v) => v.law === 'ARCH-042');
    expect(found.length).toBe(1);
    expect(found[0]!.why).toContain('ExecutionAttempt owns');
  });

  it('routing writing model truth onto the role object FAILS with ARCH-042', () => {
    const result = fixture({
      'apps/desktop/src/executor/smart-model-router.ts':
        'export const route = (role) => {\n  role.selectedModel = { modelProfileId: "m" };\n  return role;\n};\n',
    });
    expect(result.violations.some((v) => v.law === 'ARCH-042' && v.what.includes('writes model truth'))).toBe(true);
  });

  it('the shipped role contract carries requirements only (no model field)', {timeout: 120_000}, () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.violations.filter((v) => v.law === 'ARCH-042')).toEqual([]);
  });
});

/* ================================================================ ARCH-043 (Stage 8B runtime ownership) */

describe('ARCH-043 — the kernel never routes; collaboration never mutates tasks', () => {
  it('a kernel/provider importing the Smart Router FAILS with ARCH-043', () => {
    const result = fixture({
      'apps/desktop/src/executor/dsh-executor-provider.ts':
        "import { routeModelForAttempt } from './smart-model-router.js';\nexport const x = routeModelForAttempt;\n",
    });
    const found = result.violations.filter((v) => v.law === 'ARCH-043');
    expect(found.length).toBe(1);
    expect(found[0]!.why).toContain('hidden routing');
  });

  it('a task-state mutator in the collaboration bridge FAILS with ARCH-043', () => {
    const result = fixture({
      'apps/desktop/src/executor/runtime-collaboration.ts':
        'export const settleTask = (task) => task;\nexport const build = () => 1;\n',
    });
    expect(result.violations.some((v) => v.law === 'ARCH-043' && v.what.includes('task-state mutator'))).toBe(true);
  });

  it('the shipped kernel consumes the request route and the bridge only builds handoffs', {timeout: 120_000}, () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.violations.filter((v) => v.law === 'ARCH-043')).toEqual([]);
  });
});

/* ================================================================ ARCH-044 (Stage 8C dynamic professional roles) */

describe('ARCH-044 — the normal goal pipeline never flattens work onto a generic seat', () => {
  it('a control plane pinning rol.worker FAILS with ARCH-044', () => {
    const result = fixture({
      'apps/desktop/src/control-plane.ts':
        "const planItemProfiles = {};\nplanItemProfiles[id] = { taskProfile: { roleId: 'rol.worker', taskKind: 'work', maxAttempts: 3 } };\nexport const x = planItemProfiles;\n",
    });
    const found = result.violations.filter((v) => v.law === 'ARCH-044');
    expect(found.length).toBe(1);
    expect(found[0]!.why).toContain('professional-seat resolver');
  });

  it('the shipped control plane carries no generic worker seat', {timeout: 120_000}, () => {
    const result = checkArchitecture(REPO_ROOT);
    expect(result.violations.filter((v) => v.law === 'ARCH-044')).toEqual([]);
  });
});

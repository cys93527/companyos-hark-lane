/**
 * Sprint 8 tests AA/AB and the architecture boundary:
 *   - no vendor name anywhere in the runtime or the new Core domain
 *   - no routing/scoring logic, no benchmark import, no persistence import in the runtime
 *   - Agent Execution states stay disjoint from the workflow L1/L2/L3 machines
 *   - the migration chain never stores a credential
 */
import { readFileSync } from 'node:fs';
import { expectedChainsRegex, sourceWithoutComments } from '../shared/expected-chains.js';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AGENT_EXECUTION_STATES } from '@companyos/core';
import { agentMigrationsDir, loadMigrations } from '@companyos/persistence';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const source = (path: string): string => readFileSync(repo(path), 'utf8');

/** Strip comments and string literals so prose about vendors cannot mask code. */
const codeOnly = (value: string): string =>
  value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const RUNTIME = 'packages/engine/src/runtime/agent-runtime.ts';
const CORE_DOMAIN = [
  'packages/core/src/domain/agent-execution.ts',
  'packages/core/src/domain/agent-context.ts',
  'packages/core/src/domain/prompt-assembly.ts',
];

describe('AB. no vendor name in the runtime or its Core domain', () => {
  it('names no provider vendor', () => {
    const vendors = ['openai', 'anthropic', 'claude', 'deepseek', 'gemini', 'kimi', 'ollama'];
    for (const file of [RUNTIME, ...CORE_DOMAIN]) {
      const code = codeOnly(source(file)).toLowerCase();
      for (const vendor of vendors) {
        expect(new RegExp(`\\b${vendor}\\b`).test(code), `${file} names ${vendor}`).toBe(false);
      }
    }
  });

  it('the mock provider is the only adapter the runtime ever sees', () => {
    const code = codeOnly(source(RUNTIME));
    // The runtime talks to the registry port, never to an adapter class or an HTTP client.
    expect(code).not.toMatch(/fetch\(/);
    expect(code).not.toMatch(/node:http/);
    expect(code).not.toMatch(/axios/);
    expect(code).toMatch(/providers\.invoke\(/);
  });
});

describe('AA. no routing, scoring or benchmark influence', () => {
  it('contains no chooser identifier', () => {
    const code = codeOnly(source(RUNTIME));
    for (const forbidden of [
      'scoreModel',
      'rankModels',
      'bestModel',
      'autoSelect',
      'pickBest',
      'preferredModels\\[0\\]',
      'fallbackTo',
    ]) {
      expect(code).not.toMatch(new RegExp(forbidden, 'i'));
    }
  });

  it('never imports benchmark metadata or the persistence layer', () => {
    // Comments may (and do) explain that benchmark data is not consulted; CODE must not touch it.
    const code = codeOnly(source(RUNTIME));
    expect(code).not.toMatch(/benchmark/i);
    // The engine must not depend on @companyos/persistence (Sprint 8 §十五).
    expect(source(RUNTIME)).not.toMatch(/@companyos\/persistence/);
    expect(source(RUNTIME)).not.toMatch(/node:sqlite/);
    expect(code).not.toMatch(/\bSELECT\b|\bINSERT\b/);
  });

  it('requires an explicit model binding and refuses without one', () => {
    const code = source(RUNTIME);
    expect(code).toMatch(/MODEL_SELECTION_REQUIRED/);
    expect(code).toMatch(
      /Model selection belongs to the application-layer router, not to this runtime/,
    );
    // The refusal text is declared BEFORE any provider call site: the runtime's own seam
    // (`selectModel`) refuses a missing binding, and `prepare` is the path that calls it.
    const refusalIndex = code.indexOf('Model selection belongs to the application-layer router');
    const invokeIndex = code.indexOf('providers.invoke(');
    expect(refusalIndex).toBeGreaterThan(-1);
    expect(invokeIndex).toBeGreaterThan(refusalIndex);
    // The refusal is reachable from the entry points, not dead code: `prepare` and the run
    // path both consult the same seam.
    expect(code).toMatch(/const binding = await selectModel\(input\);/);
    expect(code).toMatch(/const revalidated = await selectModel\(\{/);
  });
});

describe('Lifecycle isolation: Agent Execution is its own state machine', () => {
  it('exposes exactly the eight documented states', () => {
    expect([...AGENT_EXECUTION_STATES]).toEqual([
      'CREATED',
      'READY',
      'RUNNING',
      'WAITING_EXTERNAL',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'INTERRUPTED',
    ]);
  });

  it('the runtime does not import the workflow L1/L2/L3 machines', () => {
    const code = source(RUNTIME);
    expect(code).not.toMatch(/workflow-run/);
    expect(code).not.toMatch(/workflow-template/);
    expect(code).not.toMatch(/lifecycle-machine/);
    expect(code).not.toMatch(/template-lifecycle/);
  });

  it('the runtime state vocabulary is its own (terminal names may coincide by design)', () => {
    // Layer isolation is structural: a private enum, a private transition table, a private
    // table and a private persisted column. Terminal words like COMPLETED/FAILED are generic
    // English and are intentionally reused across layers - the boundary test therefore checks
    // the RECOVERY vocabulary (the part that must never leak into L1) and the fact that the
    // runtime never imports an L1/L2/L3 machine. Closeout-8 NIT-1 corrected the earlier claim.
    const workflowRun = source('packages/core/src/domain/workflow-run.ts');
    const runStateBlock = workflowRun.slice(
      workflowRun.indexOf('STATES'),
      workflowRun.indexOf('STATES') + 2_000,
    );
    expect(runStateBlock).not.toMatch(/INTERRUPTED/);
    expect(runStateBlock).not.toMatch(/WAITING_EXTERNAL/);
    expect(source(RUNTIME)).not.toMatch(/from '.*workflow-run/);
  });
});

describe('Persistence boundary: the agent chain stores no credential', () => {
  it('ships one checksum-protected chain of its own', () => {
    const migrations = loadMigrations(agentMigrationsDir());
    // POST-CODEX R1: the chain is checksum-protected and append-only — the
    // outcome-commit marker migration (0002) is part of the canonical agent chain.
    expect(migrations.map((entry) => entry.name)).toEqual([
      '0001_agent_runtime',
      '0002_execution_outcome_commit',
      '0003_decision_commit_protocol',
      '0004_supervisor_turn_admission',
      '0005_logical_turn_permanent_ownership',
    ]);
    const sql = readFileSync(migrations[0]!.path, 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_executions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_execution_artifacts');
    // The eight states are enforced by the database, not only by TypeScript.
    for (const state of AGENT_EXECUTION_STATES) expect(sql).toContain(`'${state}'`);
    // No routing column, and no column that could hold a credential.
    const ddl = sql.replace(/--.*$/gm, ' ').toLowerCase();
    for (const forbidden of [
      'score',
      'priority',
      'fallback',
      'secret',
      'api_key',
      'token',
      'credential',
      'password',
    ]) {
      expect(ddl).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it('the persisted execution shape has no secret field', () => {
    const code = codeOnly(source(CORE_DOMAIN[0]!)).toLowerCase();
    for (const forbidden of [
      'secret',
      'apikey',
      'api_key',
      'password',
      'credential',
      'authorization',
    ]) {
      expect(code).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });
});

describe('Composition root: the runtime is reachable through the single IPC channel', () => {
  it('wires agent.* operations and the agent chain', () => {
    const workflows = source('apps/desktop/src/workflows.ts');
    for (const operation of [
      'agent.prepare',
      'agent.execute',
      'agent.get',
      'agent.list',
      'agent.cancel',
      'agent.recover',
    ]) {
      expect(workflows).toContain(`'${operation}'`);
    }
    // T17-08: the trusted core composition (agent runtime included) lives in the extracted,
    // electron-free module so the production entry is importable and E2E-testable.
    const main = source('apps/desktop/src/main.ts');
    expect(main).toMatch(/composeCoreServicesImpl\(/);
    expect(source('apps/desktop/src/core-services.ts')).toMatch(/createAgentRuntime\(/);
    // Comments are stripped first so the guard bites the executable chain list (post-Sprint-12 reconciliation).
    expect(sourceWithoutComments(main)).toMatch(expectedChainsRegex());
    expect(main.match(/openDurableDatabase\(/g) ?? []).toHaveLength(1);
  });
});

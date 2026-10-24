/**
 * Sprint 9 tests Y/Z/AA/AB and the architecture boundary of the tool layer.
 */
import { readFileSync } from 'node:fs';
import { expectedChainsRegex, sourceWithoutComments } from '../shared/expected-chains.js';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MOCK_TOOL_SPECS } from '@companyos/engine';
import { loadMigrations, toolMigrationsDir } from '@companyos/persistence';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const source = (path: string): string => readFileSync(repo(path), 'utf8');
const codeOnly = (value: string): string =>
  value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const TOOL_FILES = [
  'packages/core/src/domain/tool.ts',
  'packages/core/src/domain/tool-invocation.ts',
  'packages/core/src/domain/schema-validation.ts',
  'packages/core/src/ports/tool.ts',
  'packages/engine/src/tools/registry.ts',
  'packages/engine/src/tools/mock-tools.ts',
];

describe('Z. the tool layer contains no router or planner', () => {
  it('has no chooser, planner or loop identifier', () => {
    for (const file of TOOL_FILES) {
      const code = codeOnly(source(file));
      for (const forbidden of [
        'planTools',
        'chooseTool',
        'selectTool',
        'bestTool',
        'rankTools',
        'scoreTool',
        'autoSelect',
        'nextTool',
        'toolLoop',
        'while \\(true\\)',
      ]) {
        expect(code, `${file} contains ${forbidden}`).not.toMatch(new RegExp(forbidden, 'i'));
      }
    }
  });

  it('executes exactly one named tool per request (no iteration in the registry)', () => {
    const code = codeOnly(source('packages/engine/src/tools/registry.ts'));
    // One adapter call site. The `for` loops in this file iterate over DECLARED AUTHORITIES and
    // ARTIFACT REFERENCES - never over candidate tools - and there is no loop construct that
    // could re-enter the adapter (that would be the forbidden "tool loop").
    expect((code.match(/adapter\.invoke\(/g) ?? []).length).toBe(1);
    expect(code).not.toMatch(/\bwhile \(/);
    expect(code).not.toMatch(/\bfor \(const \w+ of .*tool/i);
  });

  it('the runtime never chooses a tool either', () => {
    const code = codeOnly(source('packages/engine/src/runtime/agent-runtime.ts'));
    for (const forbidden of ['chooseTool', 'selectTool', 'planTools', 'nextTool']) {
      expect(code).not.toMatch(new RegExp(forbidden, 'i'));
    }
    // It delegates the whole gate to the registry, by id.
    expect(code).toMatch(/deps\.tools\.invoke\(/);
  });
});

describe('AA. no real tool implementation in Core or the engine', () => {
  it('imports no process, filesystem or network primitive', () => {
    for (const file of TOOL_FILES) {
      const code = source(file);
      for (const forbidden of [
        'node:child_process',
        'node:fs',
        'node:net',
        'node:http',
        'child_process',
        'execSync',
        'spawnSync',
        'fetch(',
      ]) {
        expect(code, `${file} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('names no real tool, service or vendor', () => {
    const realTools = [
      'kubectl',
      'dockerfile',
      'terraform',
      'git push',
      'git commit',
      'npm publish',
      'rm -rf',
      'drop table',
      'aws ',
      'gcloud',
      'shell_exec',
    ];
    const vendors = ['openai', 'anthropic', 'claude', 'deepseek', 'gemini', 'kimi', 'ollama'];
    for (const file of TOOL_FILES) {
      const code = codeOnly(source(file)).toLowerCase();
      for (const forbidden of [...realTools, ...vendors]) {
        expect(code, `${file} mentions ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('AB. every shipped mock tool is inert', () => {
  it('describes actions and performs nothing', () => {
    const destructive = ['delete', 'remove', 'destroy', 'drop', 'push', 'deploy', 'exec', 'shell', 'bash', 'format'];
    for (const spec of MOCK_TOOL_SPECS) {
      const haystack = `${spec.toolId} ${spec.name} ${spec.description}`.toLowerCase();
      for (const verb of destructive) {
        expect(haystack, `${spec.toolId} mentions ${verb}`).not.toContain(verb);
      }
      // Only the five inert behaviours exist.
      expect(['echo', 'read_only', 'failing', 'needs_approval', 'never_returns']).toContain(spec.behaviour);
    }
  });

  it('ships the four required mocks (plus critical and slow)', () => {
    const ids = MOCK_TOOL_SPECS.map((spec) => spec.toolId);
    expect(ids).toContain('mock.echo');
    expect(ids).toContain('mock.read_only');
    expect(ids).toContain('mock.failing');
    expect(ids).toContain('mock.high_risk');
    expect(ids).toContain('mock.critical');
  });
});

describe('Persistence and composition boundary of the tool chain', () => {
  it('is its own checksum-protected chain with no credential or routing column', () => {
    const migrations = loadMigrations(toolMigrationsDir());
    expect(migrations.map((entry) => entry.name)).toEqual([
      '0001_tool_registry',
      '0002_tool_invocation_recovery',
      '0003_tool_invocation_attempts',
      // Sprint 13B corrective (ADR-0018): durable replay output snapshot.
      '0004_invocation_replay_output',
      // Sprint 13B corrective (ADR-0019): durable execution version provenance.
      '0005_invocation_version_provenance',
    ]);
    const sql = readFileSync(migrations[0]!.path, 'utf8');
    const recoverySql = readFileSync(migrations[1]!.path, 'utf8');
    const attemptsSql = readFileSync(migrations[2]!.path, 'utf8');
    expect(recoverySql).toContain('INTERRUPTED');
    // Attempt chain + explicit stable order (Sprint 9.1.2 §一/§三).
    for (const column of ['parent_invocation_id', 'root_invocation_id', 'attempt_number']) {
      expect(attemptsSql).toContain(column);
    }
    expect(attemptsSql).toContain('created_at DESC, id DESC');
    for (const table of ['tool_records', 'tool_invocations', 'tool_invocation_artifacts']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    const ddl = sql.replace(/--.*$/gm, ' ').toLowerCase();
    for (const forbidden of ['score', 'priority', 'fallback', 'plan', 'secret_value', 'api_key', 'token', 'credential', 'password']) {
      expect(ddl).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    // Risk is enforced by the database as well, not only by TypeScript.
    for (const level of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) expect(sql).toContain(`'${level}'`);
  });

  it('the composition root wires the tools chain and the tool operations', () => {
    // T17-08: the trusted core composition (tool registry included) lives in the extracted,
    // electron-free module so the production entry is importable and E2E-testable.
    const main = source('apps/desktop/src/main.ts');
    expect(main).toMatch(/composeCoreServicesImpl\(/);
    expect(source('apps/desktop/src/core-services.ts')).toMatch(/createToolRegistry\(/);
    // Comments are stripped first so the guard bites the executable chain list (post-Sprint-12 reconciliation).
    expect(sourceWithoutComments(main)).toMatch(
      expectedChainsRegex(),
    );
    expect(main.match(/openDurableDatabase\(/g) ?? []).toHaveLength(1);
    const workflows = source('apps/desktop/src/workflows.ts');
    for (const operation of ['tools.list', 'tools.enable', 'tools.disable', 'tools.invoke', 'tools.approve', 'tools.invocations']) {
      expect(workflows).toContain(`'${operation}'`);
    }
    // The renderer must not reach the tool layer directly.
    const renderer = source('apps/renderer/src/registry.tsx');
    expect(renderer).not.toMatch(/@companyos\/engine/);
    expect(renderer).not.toMatch(/@companyos\/persistence/);
  });
});

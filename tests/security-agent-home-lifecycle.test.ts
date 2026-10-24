/** Regression for the attack suite's former shared-directory count assertion.
 * Real resolver/staging/home disposal; tiny isolated fixture, no child launch. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEmbeddedDshRuntime } from '../apps/desktop/src/executor/embedded-dsh-runtime.js';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'companyos-home-lifecycle-'));
  owned.push(root);
  mkdirSync(join(root, 'runtime'));
  mkdirSync(join(root, 'home', 'profiles', 'p'), { recursive: true });
  const files = { 'runtime/cli.js': 'console.log("fixture");\n', 'home/profiles/p/package.json': '{}', 'home/patch.yml': 'workspace: {{WORKSPACE_ROOT}}\n' };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content, 'utf8');
  const closure = Buffer.from(JSON.stringify({ version: 1, generation: sha(root), files: Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, { sha256: sha(content), class: 'CONFIG_CRITICAL' }]),
  ), counts: { totalCritical: 3, samplingUsed: false } }), 'utf8');
  writeFileSync(join(root, 'closure-manifest.json'), closure);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ kernelId: 'home-fixture', upstreamRepo: 'fixture', upstreamSha: 'a'.repeat(40), upstreamTag: 'v1',
    runtimeRoot: join(root, 'runtime'), cliEntry: 'cli.js', profileName: 'p', dshHomeTemplateDir: join(root, 'home'),
    profilePatchTemplate: join(root, 'home/patch.yml'), transport: 'stdio', protocolVersion: 1,
    checksums: { 'cli.js': sha(files['runtime/cli.js']) }, closureGeneration: sha(closure) }), 'utf8');
  const runtime = resolveEmbeddedDshRuntime({ managedRoot: root });
  if (!runtime.ok) throw new Error(runtime.error.message);
  const stage = runtime.value.prepareAttemptStage({ attemptId: 'fixture' });
  if (!stage.ok) throw new Error(stage.error.message);
  const newHome = (attemptId: string) => {
    const result = stage.value.newDshHome({ attemptId, workspaceRoot: root, route: {
      providerId: 'fixture', modelId: 'fixture', baseURL: 'http://127.0.0.1:9', apiKeyEnv: 'FIXTURE_ROUTE',
      apiKeyValue: 'fixture', contextWindow: 100, maxTokens: 10,
    } });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  return { root, newHome, count: () => readdirSync(join(root, '.dsh-homes')).length };
};

describe('attack fixture home ownership and lifecycle, isolated real filesystem', () => {
  it('reproduces 1 → 0 during normal disposal; directory count is not a monotonic invariant', () => {
    const { newHome, count } = fixture();
    const home = newHome('a');
    const before = count();
    home.dispose();
    const after = count();
    expect(before).toBe(1);
    expect(after).toBe(0);
    expect(after >= before).toBe(false); // The old attack assertion would fail.
  });

  it('simultaneous homes are distinct, live-owned and independently disposed', () => {
    const { root, newHome, count } = fixture();
    const a = newHome('a');
    const b = newHome('b');
    expect(a.dshHome).not.toBe(b.dshHome);
    const marker = join(b.dshHome, 'other-attempt-marker');
    writeFileSync(marker, 'preserve-other-attempt', 'utf8');
    expect(resolveEmbeddedDshRuntime({ managedRoot: root }).ok).toBe(true);
    expect(count()).toBe(2); // The live owner prevents startup reclamation.
    a.dispose();
    expect(existsSync(a.dshHome)).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('preserve-other-attempt');
    expect(count()).toBe(1);
    b.dispose();
    expect(count()).toBe(0);
  });

  it('startup reclamation can also turn the shared count from 1 to 0', () => {
    const { root, count } = fixture();
    mkdirSync(join(root, '.dsh-homes', 'attempt-legacy-without-owner'), { recursive: true });
    const before = count();
    expect(resolveEmbeddedDshRuntime({ managedRoot: root }).ok).toBe(true);
    expect(before).toBe(1);
    expect(count()).toBe(0);
  });
});

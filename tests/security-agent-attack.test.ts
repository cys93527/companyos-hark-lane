/**
 * STAGE 5 — EMBEDDED AGENT ATTACK SUITE (hostile/compromised-model assumption).
 *
 * The scenario model is ADVERSARIAL DETERMINISTIC: it issues hostile tool calls
 * (outside-workspace reads/writes, junction traversal, network egress, secret
 * probing, config forgery) and hostile NDJSON shapes via fixture runtimes.
 * Deterministic integrity/protocol cases stay in the OFFLINE QUALITY GATE.
 * Six opt-in Kernel/resource cases and every original assertion live in
 * tests/kernel/security-agent-attack.live.test.ts (explicit approval required).
 */
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, afterAll, describe, expect, it} from 'vitest';

import {writeFixtureExecutionClosure} from './kernel/support/fixture-closure.js';

// Each worker/invocation owns its entire lab. Another suite must never clean it.
const LAB_ROOT = mkdtempSync(join(tmpdir(), 'tmp-attack-lab-'));
const scraps: string[] = [];
afterEach(() => {
  while (scraps.length > 0) {
    try { rmSync(scraps.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ }
  }
});
afterAll(() => {
  try { rmSync(LAB_ROOT, {recursive: true, force: true}); } catch { /* disposable */ }
});

const scratch = (prefix: string): string => {
  // Create workspace in a dedicated attack-lab root OUTSIDE tmpdir, so ../
  // escapes to a non-whitelisted parent (tmpdir is a writable root by policy).
  if (!existsSync(LAB_ROOT)) mkdirSync(LAB_ROOT, {recursive: true});
  const dir = mkdtempSync(join(LAB_ROOT, `${prefix}-`));
  scraps.push(dir);
  return dir;
};

describe('STAGE 5 embedded agent attack suite (hostile model; disposable lab workspaces)', () => {

  /** Build a SMALL fixture managed root with the REAL closure derivation applied. */
  const buildTamperFixture = (root: string): void => {
    const runtimeDir = join(root, 'runtime', 'apps', 'cli');
    mkdirSync(join(runtimeDir, 'lib'), {recursive: true});
    // The CLI entry statically requires dep-tamper; dep-tamper requires deep-dep.
    writeFileSync(join(runtimeDir, 'lib', 'bin.js'), 'require("dep-tamper");' + '\n' + "console.log('{}');" + '\n', 'utf8');
    writeFileSync(join(runtimeDir, 'package.json'), '{"name":"@deepseek-ai/dsh-cli"}', 'utf8');
    const depDir = join(runtimeDir, 'node_modules', 'dep-tamper');
    mkdirSync(join(depDir, 'node_modules', 'deep-dep'), {recursive: true});
    writeFileSync(join(depDir, 'package.json'), '{"name":"dep-tamper","version":"1.0.0","main":"index.js"}', 'utf8');
    writeFileSync(join(depDir, 'index.js'), 'require("deep-dep");' + '\n', 'utf8');
    writeFileSync(join(depDir, 'helper.ps1'), 'Write-Output "helper"' + '\n', 'utf8');
    const deepDir = join(depDir, 'node_modules', 'deep-dep');
    writeFileSync(join(deepDir, 'package.json'), '{"name":"deep-dep","version":"1.0.0","main":"index.js"}', 'utf8');
    writeFileSync(join(deepDir, 'index.js'), 'module.exports = {};' + '\n', 'utf8');
    // The composition seed (bundle patch) mounts dep-tamper by name.
    const bundleDir = join(root, 'runtime', 'packages', 'bundle', 'sdk-minimal');
    mkdirSync(bundleDir, {recursive: true});
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), '- id: seed' + '\n' + '  name: dep-tamper' + '\n', 'utf8');
    const homeTemplate = join(root, 'home', 'profiles', 'p');
    mkdirSync(homeTemplate, {recursive: true});
    writeFileSync(join(homeTemplate, 'package.json'), '{}', 'utf8');
    writeFileSync(join(root, 'patch.yml'), '- id: nothing' + '\n' + '  disabled: true' + '\n', 'utf8');
    writeFixtureExecutionClosure(root, {
      kernelId: 'tamper-fixture', upstreamRepo: 'fixture', upstreamSha: 'c'.repeat(40), upstreamTag: 'f',
      runtimeRoot: join(root, 'runtime'), cliEntry: 'apps/cli/lib/bin.js', nodeRange: '*', packageManager: '',
      profileName: 'p', dshHomeTemplateDir: join(root, 'home'), profilePatchTemplate: join(root, 'patch.yml'),
      transport: 'one-shot-ndjson', protocolVersion: '1', license: 'fixture',
      checksums: {}, createdAt: new Date().toISOString(),
    });
  };

  const TAMPER_CASES: readonly {readonly label: string; readonly target: string}[] = [
    {label: 'CLI entry', target: 'runtime/apps/cli/lib/bin.js'},
    {label: 'normal dependency JS', target: 'runtime/apps/cli/node_modules/dep-tamper/index.js'},
    {label: 'deep node_modules JS', target: 'runtime/apps/cli/node_modules/dep-tamper/node_modules/deep-dep/index.js'},
    {label: 'profile YAML (patch template)', target: 'patch.yml'},
    {label: 'cordis patch (composition)', target: 'runtime/packages/bundle/sdk-minimal/cordis.patch.yml'},
    {label: 'package.json identity', target: 'runtime/apps/cli/package.json'},
    {label: 'key JSON config (home template)', target: 'home/profiles/p/package.json'},
    {label: 'native/helper file', target: 'runtime/apps/cli/node_modules/dep-tamper/helper.ps1'},
  ];

  it.each(TAMPER_CASES)('RUNTIME TAMPER ($label): startup fails LOUD at the staged-closure gate — never launches', async (testCase) => {
    const {resolveEmbeddedDshRuntime} = await import('../apps/desktop/src/executor/embedded-dsh-runtime.js');
    const root = scratch('tamper-' + testCase.target.split('/').join('-'));
    buildTamperFixture(root);
    // Tamper ONE closure file BEFORE any staging: a fresh process (empty stage
    // registry — the vitest worker here) staging from the tampered tree must
    // refuse to launch. This is the Boss §5 semantics: modified runtime file,
    // runtime startup FAIL-LOUD.
    writeFileSync(join(root, ...testCase.target.split('/')), 'PWNED', 'utf8');
    const tampered = resolveEmbeddedDshRuntime({managedRoot: root});
    expect(tampered.ok).toBe(true); // resolve binds manifests only; the STAGE is the gate
    if (!tampered.ok) return;
    const stage = tampered.value.prepareAttemptStage({attemptId: 'tampered'});
    expect(stage.ok).toBe(false);
    if (!stage.ok) {
      expect(String(stage.error.details['reason'])).toBe('EXECUTOR_EMBEDDED_RUNTIME_TAMPERED');
    }
  }, 60_000);

  it('INTEGRITY CACHE AUDIT: no path-keyed trust — closure drift fails loud; a tree tamper invalidates EVERY subsequent attempt', async () => {
    const {resolveEmbeddedDshRuntime} = await import('../apps/desktop/src/executor/embedded-dsh-runtime.js');
    // (a) closure-manifest.json edited out-of-band -> CLOSURE_DRIFT.
    const rootA = scratch('cache-a');
    buildTamperFixture(rootA);
    const closurePath = join(rootA, 'closure-manifest.json');
    const closureBytes = readFileSync(closurePath, 'utf8');
    writeFileSync(closurePath, closureBytes.replace('"samplingUsed":false', '"samplingUsed":false,"note":"edited"'), 'utf8');
    const drifted = resolveEmbeddedDshRuntime({managedRoot: rootA});
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(String(drifted.error.details['reason'])).toBe('EXECUTOR_EMBEDDED_RUNTIME_CLOSURE_DRIFT');
    // (b) STAGE tamper between attempts: the next attempt's 100% verify gate
    // fails loud — never verify-once/trust-forever on the shared stage.
    const rootB = scratch('cache-b');
    buildTamperFixture(rootB);
    const resolved = resolveEmbeddedDshRuntime({managedRoot: rootB});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const first = resolved.value.prepareAttemptStage({attemptId: 'a1'});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stagedCli = join(first.value.stageRoot, 'runtime', 'apps', 'cli', 'lib', 'bin.js');
    writeFileSync(stagedCli, 'PWNED-STAGE', 'utf8');
    const second = resolved.value.prepareAttemptStage({attemptId: 'a2'});
    expect(second.ok).toBe(false);
    if (!second.ok) expect(String(second.error.details['reason'])).toBe('EXECUTOR_EMBEDDED_RUNTIME_TAMPERED');
    first.value.dispose();
    // (c) SOURCE tamper after staging can never execute: the stage is the only
    // tree the child reads, and the tampered bytes are provably not in it.
    const rootC = scratch('cache-c');
    buildTamperFixture(rootC);
    const resolvedC = resolveEmbeddedDshRuntime({managedRoot: rootC});
    expect(resolvedC.ok).toBe(true);
    if (!resolvedC.ok) return;
    const stageC = resolvedC.value.prepareAttemptStage({attemptId: 'c1'});
    expect(stageC.ok).toBe(true);
    if (!stageC.ok) return;
    writeFileSync(join(rootC, 'runtime', 'apps', 'cli', 'lib', 'bin.js'), 'PWNED-SOURCE', 'utf8');
    // The reused stage still hashes 100% clean (it never re-reads the source).
    const reverify = resolvedC.value.prepareAttemptStage({attemptId: 'c2'});
    expect(reverify.ok).toBe(true);
    if (reverify.ok) {
      expect(reverify.value.verifyStaged().ok).toBe(true);
      expect(readFileSync(join(reverify.value.stageRoot, 'runtime', 'apps', 'cli', 'lib', 'bin.js'), 'utf8')).not.toBe('PWNED-SOURCE');
    }
    // (d) a re-materialized runtime (NEW generation content) never reuses the old
    // stage: the cache key is the closure generation, not the managedRoot path.
    // Identical content legitimately re-verifies to the same generation, so the
    // fixture content is CHANGED before re-deriving (a real re-materialization).
    const generationBefore = resolvedC.value.closure.generation;
    writeFileSync(join(rootC, 'runtime', 'apps', 'cli', 'lib', 'bin.js'), 'require("dep-tamper");' + String.fromCharCode(10) + 'console.log("v2");' + String.fromCharCode(10), 'utf8');
    writeFixtureExecutionClosure(rootC, {
      kernelId: 'tamper-fixture', upstreamRepo: 'fixture', upstreamSha: 'c'.repeat(40), upstreamTag: 'f',
      runtimeRoot: join(rootC, 'runtime'), cliEntry: 'apps/cli/lib/bin.js', nodeRange: '*', packageManager: '',
      profileName: 'p', dshHomeTemplateDir: join(rootC, 'home'), profilePatchTemplate: join(rootC, 'patch.yml'),
      transport: 'one-shot-ndjson', protocolVersion: '1', license: 'fixture',
      checksums: {}, createdAt: new Date().toISOString(),
    });
    const resolvedC2 = resolveEmbeddedDshRuntime({managedRoot: rootC});
    expect(resolvedC2.ok).toBe(true);
    if (resolvedC2.ok) {
      expect(resolvedC2.value.closure.generation).not.toBe(generationBefore);
      const stageC2 = resolvedC2.value.prepareAttemptStage({attemptId: 'c3'});
      expect(stageC2.ok).toBe(true);
      if (stageC2.ok) {
        expect(stageC2.value.stageRoot).not.toBe(stageC.value.stageRoot);
        expect(readFileSync(join(stageC2.value.stageRoot, 'runtime', 'apps', 'cli', 'lib', 'bin.js'), 'utf8')).toContain('v2');
      }
    }
    stageC.value.dispose();
  }, 60_000);

  it('VERIFY-TO-EXECUTE TOCTOU: a source tamper after staging never reaches the child; a staged tamper is caught by the pre-spawn gate', async () => {
    const {resolveEmbeddedDshRuntime} = await import('../apps/desktop/src/executor/embedded-dsh-runtime.js');
    // (a) source-tree tamper between resolve and spawn: the child runs the STAGED
    // verified copy — the modified bytes are never executed (stage is the boundary).
    const root = scratch('toctou-src');
    buildTamperFixture(root);
    const resolved = resolveEmbeddedDshRuntime({managedRoot: root});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const stage = resolved.value.prepareAttemptStage({attemptId: 'toctou'});
    expect(stage.ok).toBe(true);
    if (!stage.ok) return;
    writeFileSync(join(root, 'runtime', 'apps', 'cli', 'lib', 'bin.js'), 'console.log("source-tampered");', 'utf8');
    expect(stage.value.verifyStaged().ok).toBe(true); // staged bytes still match the closure
    expect(readFileSync(join(stage.value.stageRoot, 'runtime', 'apps', 'cli', 'lib', 'bin.js'), 'utf8')).not.toContain('source-tampered');
    stage.value.dispose();
    // (b) staged tamper AFTER staging (pre-spawn): the gate refuses to spawn.
    const root2 = scratch('toctou-stage');
    buildTamperFixture(root2);
    const resolved2 = resolveEmbeddedDshRuntime({managedRoot: root2});
    expect(resolved2.ok).toBe(true);
    if (!resolved2.ok) return;
    const stage2 = resolved2.value.prepareAttemptStage({attemptId: 'toctou2'});
    expect(stage2.ok).toBe(true);
    if (!stage2.ok) return;
    writeFileSync(join(stage2.value.stageRoot, 'runtime', 'apps', 'cli', 'lib', 'bin.js'), 'console.log("stage-tampered");', 'utf8');
    const gate = stage2.value.verifyStaged();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(String(gate.error.details['reason'])).toBe('EXECUTOR_EMBEDDED_RUNTIME_TAMPERED');
    stage2.value.dispose();
  }, 60_000);

  it('NDJSON ADVERSARIAL: duplicate final / event-after-final / final-before-session / session-change all fail closed', async () => {
    const {parseNdjsonEvents} = await import('@companyos/engine');
    const session = JSON.stringify({type: 'session', sessionId: 'session-a', cwd: 'x'});
    const final = JSON.stringify({type: 'final', text: 'done'});
    const okRun = parseNdjsonEvents(`${session}\n${final}\n`);
    expect(okRun.ok).toBe(true);
    expect(parseNdjsonEvents(`${session}\n${final}\n${final}\n`).ok).toBe(false);
    expect(parseNdjsonEvents(`${final}\n${session}\n`).ok).toBe(false);
    expect(parseNdjsonEvents(`${session}\n${final}\n${JSON.stringify({type: 'status', phase: 'turn_end'})}\n`).ok).toBe(false);
    expect(parseNdjsonEvents(`${session}\n${JSON.stringify({type: 'session', sessionId: 'session-b'})}\n${final}\n`).ok).toBe(false);
    expect(parseNdjsonEvents(`${session}\nnot json\n`).ok).toBe(false);
  }, 30_000);
});

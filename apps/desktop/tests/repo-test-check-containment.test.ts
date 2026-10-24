/**
 * F3 — SOFTWARE VALIDATOR AUTHORITY CONTAINMENT (release blocker closure).
 *
 * The specialized software validator (`repo.test-check`) must obey the SAME canonical
 * Goal authority / workspace boundary as the work it validates:
 *
 *   F3-01  a validator test script writing INSIDE the workspace cannot mutate the
 *          user's canonical workspace (execution happens in a bounded snapshot)
 *   F3-02  a validator test script writing to the PARENT directory cannot create a
 *          file beside the user's canonical workspace
 *   F3-03  WORKSPACE_OPERATION gains no arbitrary write authority over the real
 *          workspace merely because the operation is a validator
 *   F3-04/05/06  the normal npm test contract semantics (pass/fail) are preserved
 *   F3-07  a binding/current mismatch fails closed — the validator never executes
 *          against (or even reads) the wrong workspace
 *   F3-08  the Goal's accessPolicy rides the resolved context into the durable report
 *   F3-09  an implementation self-report cannot force PASS (no contract → FAIL)
 *   F3-10  no second validation authority — the verdict rides the frozen validator
 *          envelope the ValidationService materializes
 *   F3-11  an INTERNAL link (junction/symlink inside the workspace) is MATERIALIZED:
 *          a write through it lands in the snapshot, never on the canonical target
 *   F3-12  an EXTERNAL link is refused with a typed reason BEFORE any execution —
 *          the external target can never be modified through the validator
 *   F3-13  a link that escapes cannot be laundered by a relative path (the same
 *          junction reached via a nested relative path is still refused)
 *   F3-14  installed dependencies (node_modules) are INCLUDED in the snapshot — a
 *          project whose test contract requires its installed dependency passes
 *   F3-15  a scope-overrun link was previously copied verbatim by cpSync; the manual
 *          bounded copy never preserves an outbound link (containment regression
 *          fixture: the canonical target of the link stays byte-identical)
 *
 * All fixtures are deterministic real processes (the production process port:
 * constant `npm test`, allowlisted env, armed deadline). No live provider.
 * Offline guard expands ONLY the reviewed hook-free Node script in the snapshot.
 * Assertions cover script/containment/port results, not native npm/CMD transport.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REPO_TEST_CHECK_REPORT_KIND,
  REPO_TEST_CHECK_SPEC,
  createRepoTestCheckPort,
} from '@companyos/engine';

import { runRepoTestContract } from '../src/repo-test-process.js';
import { registerOfflinePackageSnapshot, saveOfflinePackageTraces } from '../../../tests/support/offline-fixtures.js';

const created: string[] = [];
afterEach(() => {
  saveOfflinePackageTraces();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};

/** A tiny project whose test contract runs the given node -e script. */
const projectWithScript = (script: string, extraFiles: Readonly<Record<string, string>> = {}): string => {
  const root = tempDir('companyos-f3-ws-');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: `node -e ${JSON.stringify(script)}` } }),
  );
  for (const [name, content] of Object.entries(extraFiles)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
};

const realPortFor = (
  root: string,
  accessPolicy = 'WORKSPACE_OPERATION',
  mismatch = false,
  limits?: { readonly maxFiles: number; readonly maxTotalBytes: number },
) =>
  createRepoTestCheckPort(REPO_TEST_CHECK_SPEC, {
    resolveRunContext: async () => ({ root, accessPolicy, mismatch }),
    runTestContract: async (input) => {
      // Execute the reviewed Node script fresh through the unchanged production
      // capture/deadline port. Test guard expands npm's fixed, hook-free fixture
      // command; no cmd/npm/native lifecycle acceptance is claimed here.
      registerOfflinePackageSnapshot(input.cwd);
      return runRepoTestContract({ cwd: input.cwd, timeoutMs: REPO_TEST_CHECK_SPEC.timeoutMs });
    },
    ...(limits === undefined ? {} : { limits }),
    clock: { nowIso: () => '2026-10-06T00:00:00.000Z' },
  });

const invoke = async (port: ReturnType<typeof realPortFor>) => {
  const result = await port.invoke({
    input: { targetRef: 'artifact:art_x', artifactId: 'art_x', runId: 'run_x' },
  } as never);
  return result as {
    ok: boolean;
    error?: { code: string; details: Record<string, unknown> };
    value?: { status: string; output: Readonly<Record<string, unknown>> };
  };
};

const snapshotCount = (dir: string): number => readdirSync(dir).length;

describe('F3 — validator authority containment (real process fixtures)', () => {
  it('F3-01 READ_ONLY: a validator script writing inside the workspace cannot mutate the canonical workspace', async () => {
    const root = projectWithScript(
      "require('fs').writeFileSync('mutated-by-test.txt','x')",
      { 'src/keep.txt': 'original' },
    );
    const before = readdirSync(root).sort();
    const result = await invoke(realPortFor(root, 'READ_ONLY'));
    expect(result.ok).toBe(true);
    expect(result.value?.output['verdict']).toBe('pass'); // the script "passed"
    expect(result.value?.output['accessPolicy']).toBe('READ_ONLY');
    // The CANONICAL workspace is untouched — the mutation landed only in the snapshot.
    expect(existsSync(join(root, 'mutated-by-test.txt'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(before);
  }, 120_000);

  it('F3-02 READ_ONLY: a validator script writing to the parent directory cannot create a file beside the canonical workspace', async () => {
    const parent = tempDir('companyos-f3-parent-');
    const root = join(parent, 'ws');
    mkdirSync(root);
    created.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('../escape.txt','x')\"" } }),
    );
    const parentBefore = snapshotCount(parent);
    const result = await invoke(realPortFor(root, 'READ_ONLY'));
    expect(result.ok).toBe(true);
    expect(result.value?.output['verdict']).toBe('pass');
    // The USER's workspace parent is untouched: the escape landed in the snapshot's
    // own scratch area (OS temp), never beside the canonical workspace.
    expect(existsSync(join(parent, 'escape.txt'))).toBe(false);
    expect(snapshotCount(parent)).toBe(parentBefore);
  }, 120_000);

  it('F3-03 WORKSPACE_OPERATION: the validator gains no arbitrary write authority over the real workspace', async () => {
    const parent = tempDir('companyos-f3-parent-');
    const root = join(parent, 'ws');
    mkdirSync(root);
    created.push(root);
    // The test script writes BOTH inside the cwd and to its parent.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          test: "node -e \"const fs=require('fs'); fs.writeFileSync('validator-write.txt','x'); fs.writeFileSync('../validator-escape.txt','x');\"",
        },
      }),
    );
    writeFileSync(join(root, 'src-real.txt'), 'real content');
    const parentBefore = snapshotCount(parent);
    const result = await invoke(realPortFor(root, 'WORKSPACE_OPERATION'));
    expect(result.ok).toBe(true);
    expect(result.value?.output['verdict']).toBe('pass');
    expect(result.value?.output['accessPolicy']).toBe('WORKSPACE_OPERATION');
    expect(existsSync(join(root, 'validator-write.txt'))).toBe(false);
    expect(existsSync(join(parent, 'validator-escape.txt'))).toBe(false);
    expect(existsSync(join(root, 'src-real.txt'))).toBe(true);
    expect(snapshotCount(parent)).toBe(parentBefore);
  }, 120_000);

  it('F3-04/06 — a normal valid npm test still works and produces canonical PASS', async () => {
    const root = tempDir('companyos-f3-ws-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }),
    );
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), 'export const multiply = (a: number, b: number): number => a * b;\n');
    writeFileSync(
      join(root, 'tests', 'math.test.ts'),
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { multiply } from '../src/math.ts';\ntest('multiply', () => { assert.equal(multiply(4, 3), 12); });\n",
    );
    const result = await invoke(realPortFor(root));
    expect(result.ok).toBe(true);
    expect(result.value?.output['verdict']).toBe('pass');
    const report = JSON.parse(
      (result.value?.output['report'] as { kind: string; content: string }).content,
    ) as { executedOn: string };
    expect(report.executedOn).toBe('snapshot');
  }, 120_000);

  it('F3-05 — a failing npm test produces the canonical FAIL verdict', async () => {
    const root = tempDir('companyos-f3-ws-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }),
    );
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), 'export const multiply = (a: number, b: number): number => a - b;\n');
    writeFileSync(
      join(root, 'tests', 'math.test.ts'),
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { multiply } from '../src/math.ts';\ntest('multiply', () => { assert.equal(multiply(4, 3), 12); });\n",
    );
    const result = await invoke(realPortFor(root));
    expect(result.ok).toBe(true);
    expect(result.value?.output['verdict']).toBe('fail');
    expect((result.value?.output['report'] as { kind: string }).kind).toBe(REPO_TEST_CHECK_REPORT_KIND);
  }, 120_000);

  it('F3-07 — a binding/current mismatch fails closed BEFORE any execution', async () => {
    let executed = 0;
    const root = tempDir('companyos-f3-ws-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const port = createRepoTestCheckPort(REPO_TEST_CHECK_SPEC, {
      resolveRunContext: async () => ({ root: 'C:/the/bound/root', accessPolicy: 'WORKSPACE_OPERATION', mismatch: true }),
      runTestContract: async () => {
        executed += 1;
        return { exitCode: 0, timedOut: false, outputTail: '' };
      },
      clock: { nowIso: () => '2026-10-06T00:00:00.000Z' },
    });
    const result = await invoke(port);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(String(result.error?.details['reason'])).toBe('GOAL_WORKSPACE_MISMATCH');
    expect(executed).toBe(0); // no process ever ran against the wrong workspace
  });

  it('F3-09 — a workspace without a test contract FAILS (an implementation self-report cannot force PASS)', async () => {
    const root = tempDir('companyos-f3-ws-');
    writeFileSync(join(root, 'notes.txt'), 'the implementation claims all tests pass');
    const result = await invoke(realPortFor(root));
    expect(result.ok).toBe(true);
    expect(result.value?.output['verdict']).toBe('fail');
    expect(result.value?.status).toBe('error');
  }, 120_000);

  it('F3 (fail closed) — a workspace beyond the snapshot bounds is refused with a typed environment-unavailable reason', async () => {
    const root = tempDir('companyos-f3-cap-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const bulk = join(root, 'bulk');
    mkdirSync(bulk);
    for (let i = 0; i < 150; i += 1) writeFileSync(join(bulk, `f${String(i)}.txt`), 'x');
    // The production bounds are real-project sized; the boundary is exercised through the
    // injected (test-seam) limits so the refusal path is proven without a giant tree.
    const result = await invoke(realPortFor(root, 'WORKSPACE_OPERATION', false, { maxFiles: 100, maxTotalBytes: 1024 * 1024 }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(String(result.error?.details['reason'])).toBe('VALIDATION_ENVIRONMENT_UNAVAILABLE');
    expect(String(result.error?.details['snapshotReason'])).toBe('SNAPSHOT_BOUND_EXCEEDED');
  }, 60_000);

  it('F3-14 — installed dependencies (node_modules) are included in the snapshot (no false FAIL)', async () => {
    const root = tempDir('companyos-f3-deps-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { test: "node -e \"const d=require('local-dep'); if(d.answer()!==42) process.exit(1)\"" },
      }),
    );
    mkdirSync(join(root, 'node_modules', 'local-dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'local-dep', 'package.json'), JSON.stringify({ name: 'local-dep', main: 'index.js' }));
    writeFileSync(join(root, 'node_modules', 'local-dep', 'index.js'), 'exports.answer = () => 42;\n');
    const result = await invoke(realPortFor(root));
    expect(result.ok).toBe(true);
    expect(result.value?.output['verdict']).toBe('pass');
  }, 120_000);

  it('F3-11 — an INTERNAL junction is materialized as real content: a write through it stays in the snapshot', async () => {
    const root = tempDir('companyos-f3-link-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'keep.txt'), 'original');
    // An absolute junction pointing INSIDE the workspace (as real workspaces have).
    symlinkSync(join(root, 'src'), join(root, 'vint'), 'junction');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { test: "node -e \"const fs=require('fs'); fs.writeFileSync('vint/written.txt','x'); fs.readFileSync('vint/keep.txt','utf8');\"" },
      }),
    );
    const result = await invoke(realPortFor(root, 'READ_ONLY'));
    expect(result.ok).toBe(true);
    expect(result.value?.output['verdict']).toBe('pass');
    // The canonical junction TARGET is untouched — the write landed in the snapshot copy
    // of the target content (the link was materialized, never preserved).
    expect(existsSync(join(root, 'src', 'written.txt'))).toBe(false);
    expect(readFileSync(join(root, 'src', 'keep.txt'), 'utf8')).toBe('original');
  }, 120_000);

  it('F3-12 — an EXTERNAL junction is refused with a typed reason BEFORE any execution (target untouched)', async () => {
    const parent = tempDir('companyos-f3-ext-');
    const victim = join(parent, 'victim');
    mkdirSync(victim);
    created.push(victim);
    writeFileSync(join(victim, 'precious.txt'), 'do not touch');
    const root = join(parent, 'ws');
    mkdirSync(root);
    created.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('vext/precious.txt','MUTATED')\"" } }),
    );
    symlinkSync(victim, join(root, 'vext'), 'junction');
    let executed = 0;
    const port = createRepoTestCheckPort(REPO_TEST_CHECK_SPEC, {
      resolveRunContext: async () => ({ root, accessPolicy: 'WORKSPACE_OPERATION', mismatch: false }),
      runTestContract: async () => {
        executed += 1;
        return { exitCode: 0, timedOut: false, outputTail: '' };
      },
      clock: { nowIso: () => '2026-10-06T00:00:00.000Z' },
    });
    const result = await invoke(port as never);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(String(result.error?.details['reason'])).toBe('VALIDATION_ENVIRONMENT_UNAVAILABLE');
    expect(String(result.error?.details['snapshotReason'])).toBe('WORKSPACE_SYMLINK_ESCAPES_ROOT');
    // Zero execution and a byte-identical external target: the escape is impossible.
    expect(executed).toBe(0);
    expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe('do not touch');
    expect(readdirSync(victim).sort()).toEqual(['precious.txt']);
  }, 120_000);

  it('F3-13 — a nested external junction cannot be laundered through a deep relative path', async () => {
    const parent = tempDir('companyos-f3-nest-');
    const victim = join(parent, 'victim');
    mkdirSync(victim);
    created.push(victim);
    const root = join(parent, 'ws');
    created.push(root);
    mkdirSync(join(root, 'src', 'deep', 'nested'), { recursive: true });
    symlinkSync(victim, join(root, 'src', 'deep', 'nested', 'link'), 'junction');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { test: "node -e \"require('fs').writeFileSync('src/deep/nested/link/escaped.txt','x')\"" },
      }),
    );
    const result = await invoke(realPortFor(root));
    expect(result.ok).toBe(false);
    expect(String(result.error?.details['reason'])).toBe('VALIDATION_ENVIRONMENT_UNAVAILABLE');
    expect(String(result.error?.details['snapshotReason'])).toBe('WORKSPACE_SYMLINK_ESCAPES_ROOT');
    expect(readdirSync(victim)).toEqual([]);
  }, 120_000);

  it('F3-15 — containment regression: the pre-fix cpSync hole (verbatim link copy) can no longer mutate the external target', async () => {
    const parent = tempDir('companyos-f3-regress-');
    const victim = join(parent, 'victim');
    mkdirSync(victim);
    created.push(victim);
    writeFileSync(join(victim, 'data.txt'), 'canonical');
    const root = join(parent, 'ws');
    created.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'code.js'), 'exports.ok = true;\n');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { test: "node -e \"const fs=require('fs'); fs.writeFileSync('vext/data.txt','MUTATED'); fs.writeFileSync('vext/new.txt','x')\"" },
      }),
    );
    symlinkSync(victim, join(root, 'vext'), 'junction');
    const victimBefore = readdirSync(victim).sort();
    const result = await invoke(realPortFor(root));
    // Refused, and the victim is byte-identical: no write ever reached it.
    expect(result.ok).toBe(false);
    expect(readFileSync(join(victim, 'data.txt'), 'utf8')).toBe('canonical');
    expect(readdirSync(victim).sort()).toEqual(victimBefore);
  }, 120_000);
});

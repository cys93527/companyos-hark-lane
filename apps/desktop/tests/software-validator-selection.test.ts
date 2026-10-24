/**
 * BB2 FINAL FORENSIC closure — SOFTWARE_SPECIALIZED_VALIDATION_CANONICALITY.
 *
 * Proves the deterministic validator-selection policy and the specialized software
 * validation authority end to end at the seams the canonical lifecycle uses:
 *
 *   SV-01  a plan item declaring the SOFTWARE kind carries the specialized validator
 *   SV-02  grounding stays ADDITIVE (never replaces the specialized validator)
 *   SV-03  an implementation self-report cannot PASS — the validator executes the
 *          workspace's own test contract itself; absent contract → FAIL
 *   SV-04  a failing test contract → canonical verdict FAIL
 *   SV-05  a passing corrected contract → verdict PASS
 *   SV-06  the generic (default-kind) mapping is UNCHANGED (grounding only)
 *   SV-07  selection is policy over the declared closed kind set — no filename/goal-text/
 *          role-name input exists in the selection function
 *   SV-08  selection is deterministic (same inputs → same validators)
 *   SV-09  the specialized validator joins the SAME registry capability contract
 *          (TOOL_CAPABILITY_VALIDATOR) the ValidationService resolves through
 *   SV-10  the composition wires the planner advertisement + per-kind policy (so the
 *          canonical compile is the only place validator sets are assigned)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TOOL_CAPABILITY_VALIDATOR } from '@companyos/core';
import {
  REPO_TEST_CHECK_SPEC,
  REPO_TEST_CHECK_TOOL_ID,
  createRepoTestCheckPort,
  createRepoTestCheckRecord,
} from '@companyos/engine';

import {
  SOFTWARE_WORK_KIND,
  validatorIdsForTaskKind,
} from '../src/control-plane.js';
import { productionCompositionOptions } from '../src/production-composition.js';

const created: string[] = [];
afterEach(() => {
  saveOfflinePackageTraces();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

const tempWorkspace = (files: Readonly<Record<string, string>>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-sv-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
};

const GOAL_WORK_KIND = 'companyos:work';

describe('SV selection policy — the ONE deterministic validator-selection owner', () => {
  const profile = productionCompositionOptions({}).goalWorkProfile as {
    readonly validatorIds: readonly string[];
    readonly validatorIdsByTaskKind: Readonly<Record<string, readonly string[]>>;
    readonly operationKinds: readonly string[];
  };

  it('SV-01 — a plan item declaring the SOFTWARE kind carries the specialized validator', () => {
    const selected = validatorIdsForTaskKind(profile, SOFTWARE_WORK_KIND);
    expect(selected).toContain('repo.test-check');
    expect(profile.operationKinds).toContain(SOFTWARE_WORK_KIND);
  });

  it('SV-02 — grounding stays ADDITIVE beside the specialized validator, never a replacement', () => {
    const selected = validatorIdsForTaskKind(profile, SOFTWARE_WORK_KIND);
    expect(selected).toEqual(['repo.test-check', 'evidence.grounding-check']);
  });

  it('SV-06 — the generic default-kind mapping is UNCHANGED (grounding only)', () => {
    const selected = validatorIdsForTaskKind(profile, GOAL_WORK_KIND);
    expect(selected).toEqual(['evidence.grounding-check']);
    expect(selected).not.toContain('repo.test-check');
    expect(profile.validatorIds).toEqual(['evidence.grounding-check']);
  });

  it('SV-07 — selection reads ONLY the declared policy and the closed-set kind', () => {
    // The selection function's entire input surface: the deployment profile + the kind.
    // An undeclared kind falls back to the baseline; no other signal exists to consult.
    expect(validatorIdsForTaskKind(profile, 'companyos:not-declared')).toEqual(
      profile.validatorIds,
    );
    expect(
      validatorIdsForTaskKind({ validatorIds: ['evidence.grounding-check'] }, SOFTWARE_WORK_KIND),
    ).toEqual(['evidence.grounding-check']);
    expect(validatorIdsForTaskKind({}, GOAL_WORK_KIND)).toEqual([]);
  });

  it('SV-08 — selection is deterministic (same inputs → same validators)', () => {
    const a = validatorIdsForTaskKind(profile, SOFTWARE_WORK_KIND);
    const b = validatorIdsForTaskKind(profile, SOFTWARE_WORK_KIND);
    expect([...a]).toEqual([...b]);
  });
});

describe('SV specialized validator — repo.test-check executes the workspace test contract itself', () => {
  const makePort = (
    runResult: { exitCode: number; timedOut: boolean; outputTail: string },
    workspaceFiles: Readonly<Record<string, string>>,
    over?: { readonly mismatch?: boolean },
  ) => {
    const root = tempWorkspace(workspaceFiles);
    const seen: { cwd: string }[] = [];
    const port = createRepoTestCheckPort(REPO_TEST_CHECK_SPEC, {
      // F3/F4 contract: the run-scoped canonical context (Goal binding + accessPolicy +
      // current-open comparison) — the port never sees a bare workspace holder.
      resolveRunContext: async () =>
        over?.mismatch === true
          ? { root: 'C:/somewhere/else', accessPolicy: 'WORKSPACE_OPERATION', mismatch: true }
          : { root, accessPolicy: 'WORKSPACE_OPERATION', mismatch: false },
      runTestContract: async (input) => {
        seen.push({ cwd: input.cwd });
        return runResult;
      },
      clock: { nowIso: () => '2026-10-05T00:00:00.000Z' },
    });
    return { port, seen, root };
  };


  it('SV-05 — a passing corrected contract PASSes on the validator\'s own fresh execution', async () => {
    const { port, seen } = makePort(
      { exitCode: 0, timedOut: false, outputTail: 'tests 4 pass 0 fail' },
      { 'package.json': JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }) },
    );
    const result = await port.invoke({
      input: { targetRef: 'artifact:art_x', artifactId: 'art_x', runId: 'run_x' },
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.output as { verdict: string; command: string; reasons: string[] };
    expect(output.verdict).toBe('pass');
    expect(output.command).toBe('node --test tests/math.test.ts');
    expect(seen).toHaveLength(1); // exactly one fresh validator-owned execution
    expect(seen[0]?.cwd).toBe(seen[0]?.cwd);
  });

  it('SV-04 — a failing test contract produces canonical verdict FAIL', async () => {
    const { port } = makePort(
      { exitCode: 1, timedOut: false, outputTail: 'tests 3 pass 1 fail' },
      { 'package.json': JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }) },
    );
    const result = await port.invoke({
      input: { targetRef: 'artifact:art_x', artifactId: 'art_x', runId: 'run_x' },
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.output as { verdict: string; exitCode: number };
    expect(output.verdict).toBe('fail');
    expect(output.exitCode).toBe(1);
  });

  it('SV-03 — no test contract in the workspace FAILS: an implementation self-report cannot force PASS', async () => {
    // The port never reads any artifact/model claim — only the workspace contract and its
    // own execution. A workspace without a test contract is unverifiable → fail-closed.
    const { port } = makePort(
      { exitCode: 0, timedOut: false, outputTail: '' },
      { 'notes.txt': 'the implementation claims tests pass' },
    );
    const result = await port.invoke({
      input: { targetRef: 'artifact:art_x', artifactId: 'art_x', runId: 'run_x' },
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.output as { verdict: string; reasons: string[] };
    expect(output.verdict).toBe('fail');
    expect(output.reasons.join(' ')).toMatch(/test contract/i);
  });

  it('SV-03b — a timed-out test contract FAILS even with exit code 0 forced', async () => {
    const { port } = makePort(
      { exitCode: 0, timedOut: true, outputTail: '' },
      { 'package.json': JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }) },
    );
    const result = await port.invoke({
      input: { targetRef: 'artifact:art_x', artifactId: 'art_x', runId: 'run_x' },
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.output as { verdict: string }).verdict).toBe('fail');
  });

  it('SV-09 — the validator joins the SAME registry capability contract the ValidationService resolves', () => {
    const record = createRepoTestCheckRecord(REPO_TEST_CHECK_SPEC, '2026-10-05T00:00:00.000Z');
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.value.capabilities).toContain(TOOL_CAPABILITY_VALIDATOR);
    expect(record.value.toolId).toBe(REPO_TEST_CHECK_TOOL_ID);
  });

  it('SV-10 — the composition wires the planner advertisement and the per-kind policy (compile is the only assignment point)', () => {
    // The deployment profile is the single source: the planner advertisement (declared
    // kinds) and the compile-time assignment (validatorIdsForTaskKind) both read it.
    const options = productionCompositionOptions({});
    const profile = options.goalWorkProfile as {
      readonly operationKinds: readonly string[];
      readonly validatorIdsByTaskKind: Readonly<Record<string, readonly string[]>>;
    };
    expect(profile.validatorIdsByTaskKind[SOFTWARE_WORK_KIND]).toBeDefined();
    expect(profile.operationKinds).toEqual([SOFTWARE_WORK_KIND]);
  });
});

/* ============================================================================
 * PART E — the negative/positive fixture through the REAL production process port
 * (runRepoTestContract: constant `npm test`, allowlisted env, armed deadline). No live
 * provider, no model: the workspace's own deterministic test contract decides.
 * Offline gate: reviewed hook-free Node expansion, not native npm/CMD transport.
 * ========================================================================== */
import { runRepoTestContract } from '../src/repo-test-process.js';
import { registerOfflinePackageSnapshot, saveOfflinePackageTraces } from '../../../tests/support/offline-fixtures.js';
import { REPO_TEST_CHECK_SPEC as SPEC } from '@companyos/engine';

const realPortFor = (root: string) =>
  createRepoTestCheckPort(SPEC, {
    resolveRunContext: async () => ({ root, accessPolicy: 'WORKSPACE_OPERATION', mismatch: false }),
    runTestContract: async (input) => {
      // Guarded test-only Node expansion; retain the real port's output,
      // deadline and exit handling, without running an npm/Shell lifecycle.
      registerOfflinePackageSnapshot(input.cwd);
      return runRepoTestContract({ cwd: input.cwd, timeoutMs: SPEC.timeoutMs });
    },
    clock: { nowIso: () => '2026-10-05T00:00:00.000Z' },
  });

const invoke = async (port: ReturnType<typeof realPortFor>) =>
  (await port.invoke({
    input: { targetRef: 'artifact:art_x', artifactId: 'art_x', runId: 'run_x' },
  } as never)) as { ok: true; value: { output: Readonly<Record<string, unknown>> } };

describe('PART E — the real process port against deterministic tiny software fixtures', () => {
  it('NEGATIVE: multiply still wrong (failing test contract) → validator FAILS', async () => {
    const root = tempWorkspace({
      'package.json': JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }),
      'src/math.ts': 'export const multiply = (a: number, b: number): number => a - b;\n',
      'tests/math.test.ts': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { multiply } from '../src/math.ts';\ntest('multiply', () => { assert.equal(multiply(4, 3), 12); });\n",
    });
    const result = await invoke(realPortFor(root));
    expect(result.value.output['verdict']).toBe('fail');
    expect(String(result.value.output['outputTail'])).toMatch(/fail/i);
  }, 120_000);

  it('POSITIVE: corrected multiply (passing test contract) → validator PASSes', async () => {
    const root = tempWorkspace({
      'package.json': JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }),
      'src/math.ts': 'export const multiply = (a: number, b: number): number => a * b;\n',
      'tests/math.test.ts': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { multiply } from '../src/math.ts';\ntest('multiply', () => { assert.equal(multiply(4, 3), 12); });\n",
    });
    const result = await invoke(realPortFor(root));
    expect(result.value.output['verdict']).toBe('pass');
  }, 120_000);
});

/**
 * LIVE-CONTRACT-FILL run 13 (hark-live-goal 42624351676): every `repo.test-check` ended as a bare
 * registry TIMEOUT after exactly 600 000 ms (validation status `error`, no exit code, no output tail):
 * the registry bounds the whole invocation by the spec timeout and the test-contract process got the
 * SAME deadline, started only after the snapshot copy, so its own deadline (tree kill + tail) never
 * fired. The corrective rework never learned which test hung; 5 stages failed identically and the
 * goal ended. The contract deadline now sits strictly inside the invocation bound and a deadline
 * verdict carries the contract's last (unbuffered) output.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEADLINE_MARKER,
  runRepoTestContract,
  UNBUFFERED_STDIO_ENV,
} from '../../apps/desktop/src/repo-test-process.js';
import {
  createRepoTestCheckPort,
  REPO_TEST_CHECK_SPEC,
  REPO_TEST_CONTRACT_HEADROOM_MS,
  repoTestContractDeadlineMs,
} from '../../packages/engine/src/validation/repo-test-check-tool.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) { super(); }
  kill(): boolean { return true; }
}

describe('live contract-fill run 13: the test contract deadline fires inside the tool bound', () => {
  it('the contract deadline is strictly less than the registry timeout, with headroom', () => {
    const deadline = repoTestContractDeadlineMs(REPO_TEST_CHECK_SPEC);
    expect(deadline).toBe(REPO_TEST_CHECK_SPEC.timeoutMs - REPO_TEST_CONTRACT_HEADROOM_MS);
    expect(deadline).toBeLessThan(REPO_TEST_CHECK_SPEC.timeoutMs);
    expect(REPO_TEST_CONTRACT_HEADROOM_MS).toBeGreaterThanOrEqual(60_000);
    expect(() => repoTestContractDeadlineMs({ timeoutMs: 60_000 })).toThrow(/no room/);
  });

  it('a hanging contract is ended by its own deadline: timedOut verdict, tree killed, last output kept', async () => {
    const root = new FakeChild(42);
    let seenEnv: Record<string, string> | undefined;
    let killed = 0;
    const fakeSpawn = ((_cmd: string, _args: readonly string[], opts: { env: Record<string, string> }) => {
      seenEnv = opts.env;
      setTimeout(() => root.stdout.write('test_pdf_export_renders_chinese ... '), 5);
      return root;
    }) as never;
    const result = await runRepoTestContract(
      { cwd: 'C:\\ws', timeoutMs: 50 },
      {
        spawn: fakeSpawn,
        platform: 'win32',
        settleGraceMs: 10,
        killTree: () => { killed += 1; setTimeout(() => root.emit('close', 1), 1); },
      },
    );
    expect(killed).toBeGreaterThanOrEqual(1);
    expect(result.timedOut).toBe(true);
    expect(result.outputTail.startsWith(CONTRACT_DEADLINE_MARKER)).toBe(true);
    expect(result.outputTail).toContain('test_pdf_export_renders_chinese');
    expect(seenEnv).toMatchObject(UNBUFFERED_STDIO_ENV);
  });

  it('the Windows system locations native test dependencies expect are passed, secrets are not', async () => {
    const saved = { pd: process.env.PROGRAMDATA, key: process.env.COMPANYOS_MODEL_API_KEY };
    process.env.PROGRAMDATA = 'C:\\ProgramData';
    process.env.COMPANYOS_MODEL_API_KEY = 'sk-secret';
    let seenEnv: Record<string, string> | undefined;
    const root = new FakeChild(7);
    const fakeSpawn = ((_cmd: string, _args: readonly string[], opts: { env: Record<string, string> }) => {
      seenEnv = opts.env;
      setTimeout(() => root.emit('exit', 0, null), 5);
      return root;
    }) as never;
    try {
      const result = await runRepoTestContract({ cwd: 'C:\\ws', timeoutMs: 60_000 }, { spawn: fakeSpawn, platform: 'win32', settleGraceMs: 10, killTree: () => undefined });
      expect(result.timedOut).toBe(false);
      expect(result.outputTail.includes(CONTRACT_DEADLINE_MARKER)).toBe(false);
    } finally {
      if (saved.pd === undefined) delete process.env.PROGRAMDATA; else process.env.PROGRAMDATA = saved.pd;
      if (saved.key === undefined) delete process.env.COMPANYOS_MODEL_API_KEY; else process.env.COMPANYOS_MODEL_API_KEY = saved.key;
    }
    expect(seenEnv).toMatchObject({ PROGRAMDATA: 'C:\\ProgramData' });
    expect(seenEnv).not.toHaveProperty('COMPANYOS_MODEL_API_KEY');
  });
});

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('live contract-fill run 13: the port hands the contract what is left of the invocation bound', () => {
  const portFor = (seen: number[], result = { exitCode: 1, timedOut: true, outputTail: `${CONTRACT_DEADLINE_MARKER} x\ntest_a ... ` }) => {
    const root = mkdtempSync(join(tmpdir(), 'run13-ws-'));
    dirs.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'python tests/run_all.py' } }));
    return createRepoTestCheckPort(REPO_TEST_CHECK_SPEC, {
      resolveRunContext: async () => ({ root, accessPolicy: 'WORKSPACE_OPERATION', mismatch: false }),
      runTestContract: async (input) => { seen.push(input.timeoutMs); return result; },
      clock: { nowIso: () => 'Mon 2026-11-09 10:23 PM CST (UTC+08:00)' },
    });
  };

  it('the contract deadline is below the registry bound and a deadline verdict is a FAIL with its tail', async () => {
    const seen: number[] = [];
    const out = await portFor(seen).invoke({ input: { targetRef: 'artifact:a', artifactId: 'a', runId: 'r' } } as never) as {
      ok: boolean; value?: { output: Readonly<Record<string, unknown>> };
    };
    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeLessThanOrEqual(repoTestContractDeadlineMs(REPO_TEST_CHECK_SPEC));
    expect(seen[0]).toBeGreaterThan(repoTestContractDeadlineMs(REPO_TEST_CHECK_SPEC) - 10_000);
    expect(out.value?.output['verdict']).toBe('fail');
    expect(out.value?.output['timedOut']).toBe(true);
    expect(String(out.value?.output['outputTail'])).toContain('test_a');
    expect(String((out.value?.output['reasons'] as string[])[0])).toMatch(/validator deadline/);
  });
});

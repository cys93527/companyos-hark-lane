import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRepoTestContractRunner, type RepoTestContractRun } from '../../apps/desktop/src/repo-test-process.js';
import type { IsolationDispatchDecision } from '../../apps/desktop/src/executor/isolation/isolation-status.js';

/*
 * AUDIT-D1: the repo.test-check validator ran agent-written `npm test` as the signed-in user, outside the H16
 * isolation boundary, so a test script could rewrite budget approvals / provider setup / isolation state.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

type RunInput = Parameters<NonNullable<Parameters<typeof createRepoTestContractRunner>[0]['run']>>[0];
const recorder = (body?: (input: RunInput) => void): { calls: RunInput[]; run: (input: RunInput) => Promise<RepoTestContractRun> } => {
  const calls: RunInput[] = [];
  return { calls, run: async (input) => { calls.push(input); body?.(input); return { exitCode: 0, timedOut: false, outputTail: 'ok' }; } };
};

const isolated = (workspaceDirs: string[]): IsolationDispatchDecision => ({
  kind: 'launch-isolated', account: 'CompanyOSAgentab12cd', sid: 'S-1-5-21-1-2-3-1001', brokerPort: 47811, workspaceDirs,
});

describe('AUDIT-D1 validator runs inside the isolation boundary', () => {
  it('ISOLATED: npm test runs through the isolated launcher on a copy under the agent state root', async () => {
    const userData = tmp('companyos-d1-ud-');
    const stateRoot = join(userData, 'agent-kernel-state');
    const snapshot = tmp('companyos-testcheck-');
    writeFileSync(join(snapshot, 'package.json'), '{"scripts":{"test":"node -e 0"}}');
    let seenCopy = '';
    const rec = recorder((input) => { seenCopy = input.cwd; expect(existsSync(join(input.cwd, 'package.json'))).toBe(true); });
    const runner = createRepoTestContractRunner({
      run: rec.run, platform: 'win32', isolatedStateRoot: stateRoot, trustedStateRoot: userData,
      isolation: { launcherPath: 'C:\\app\\resources\\isolation\\companyos-isolated-launch.exe', credentialPath: 'C:\\ud\\isolation\\agent.dpapi', decide: () => isolated(['D:\\ws']), fileExists: () => true },
    });
    const result = await runner({ cwd: snapshot, timeoutMs: 1000 });
    expect(result).toEqual({ exitCode: 0, timedOut: false, outputTail: 'ok' });
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call.command?.executable).toBe('C:\\app\\resources\\isolation\\companyos-isolated-launch.exe');
    expect(call.command?.argv.slice(0, 7)).toEqual(['--account', 'CompanyOSAgentab12cd', '--credential', 'C:\\ud\\isolation\\agent.dpapi', '--cwd', seenCopy, '--']);
    expect(call.command?.argv.slice(7, 8)[0]).toMatch(/System32[\\/]cmd\.exe$/);
    expect(call.command?.argv.slice(8)).toEqual(['/d', '/s', '/c', 'npm test']);
    expect(seenCopy.startsWith(join(stateRoot, 'validator'))).toBe(true);
    expect(existsSync(seenCopy)).toBe(false); // copy removed after the run
  });

  it('DEGRADED: nothing is spawned and the run fails closed', async () => {
    const rec = recorder();
    const runner = createRepoTestContractRunner({
      run: rec.run, isolatedStateRoot: tmp('companyos-d1-st-'),
      isolation: { launcherPath: 'x', credentialPath: 'y', decide: () => ({ kind: 'refuse', reasonCode: 'ISOLATION_DEGRADED', problems: ['wfp:filterV4:missing'] }) },
    });
    const result = await runner({ cwd: tmp('companyos-testcheck-'), timeoutMs: 1000 });
    expect(rec.calls).toHaveLength(0);
    expect(result.exitCode).toBe(-1);
    expect(result.outputTail).toContain('[ISOLATION_DEGRADED]');
    expect(result.outputTail).toContain('wfp:filterV4:missing');
  });

  it('NOT CONFIGURED: labelled 未隔离 with a per-run scratch profile', async () => {
    const rec = recorder((input) => { expect(existsSync(input.envOverrides!['HOME']!)).toBe(true); });
    const runner = createRepoTestContractRunner({ run: rec.run, platform: 'linux' });
    const result = await runner({ cwd: tmp('companyos-testcheck-'), timeoutMs: 1000 });
    expect(result.outputTail.startsWith('[validator: 未隔离]')).toBe(true);
    const env = rec.calls[0]!.envOverrides!;
    expect(env['HOME']).toContain('companyos-validator-home-');
    expect(env['TEMP']!.startsWith(env['HOME']!)).toBe(true);
    expect(existsSync(env['HOME']!)).toBe(false);
  });

  it('a test script that tampers with trusted state is reverted and the run fails', async () => {
    const userData = tmp('companyos-d1-ud-');
    mkdirSync(join(userData, 'budget', 'proofs'), { recursive: true });
    mkdirSync(join(userData, 'provider'), { recursive: true });
    writeFileSync(join(userData, 'budget', 'approvals.json'), '{"cap":1}');
    writeFileSync(join(userData, 'provider', 'model.json'), '{"m":1}');
    const rec = recorder(() => {
      writeFileSync(join(userData, 'budget', 'approvals.json'), '{"cap":999999}');
      writeFileSync(join(userData, 'budget', 'proofs', 'forged.json'), '{}');
      rmSync(join(userData, 'provider', 'model.json'));
    });
    const runner = createRepoTestContractRunner({ run: rec.run, platform: 'linux', trustedStateRoot: userData });
    const result = await runner({ cwd: tmp('companyos-testcheck-'), timeoutMs: 1000 });
    expect(result.exitCode).toBe(-1);
    expect(result.outputTail).toContain('[VALIDATOR_TRUSTED_STATE_TAMPERED]');
    expect(readFileSync(join(userData, 'budget', 'approvals.json'), 'utf8')).toBe('{"cap":1}');
    expect(readFileSync(join(userData, 'provider', 'model.json'), 'utf8')).toBe('{"m":1}');
    expect(existsSync(join(userData, 'budget', 'proofs', 'forged.json'))).toBe(false);
  });

  it('core-services wires the runner with the production isolation config, state root and trusted root', () => {
    const src = readFileSync(join(__dirname, '../../apps/desktop/src/core-services.ts'), 'utf8');
    expect(src).toContain('repoTestContractRunner({ cwd: input.cwd, timeoutMs: Math.min(input.timeoutMs, repoTestContractDeadlineMs(REPO_TEST_CHECK_SPEC)) })');
    expect(src).toContain('isolation: options.embeddedDshIsolation');
    expect(src).toContain('trustedStateRoot: options.validatorTrustedStateRoot');
    const main = readFileSync(join(__dirname, '../../apps/desktop/src/main.ts'), 'utf8');
    expect(main.match(/validatorTrustedStateRoot: app\.getPath\('userData'\)/g)?.length).toBe(1); // AUDIT-D8: one composition site
  });
});

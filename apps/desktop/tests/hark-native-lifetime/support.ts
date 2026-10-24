/** Shared offline fixtures for the Hark lane lifetime tests (no native code). */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyLaunch, type LaunchPolicy, type LaunchRequest, type VerifiedLaunch } from '../../src/executor/native-lifetime/launch-pins.js';

export const TEST_POLICY: LaunchPolicy = { platform: process.platform, requireExeSuffix: true, maxTimeoutMs: 600_000 };
export const SIMULATED_WINDOWS_HOST = { platform: 'win32', arch: 'x64' } as const;

export interface Workspace { root: string; exe: string; exeSha: string; script: string; scriptSha: string; temp: string }

export function makeWorkspace(): Workspace {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hark-lane-3b3e-')));
  const temp = join(root, 'tmp');
  mkdirSync(temp);
  const exe = join(root, 'fixture.exe');
  const exeBytes = Buffer.from('MZ-offline-fixture-not-executable');
  writeFileSync(exe, exeBytes);
  const script = join(root, 'input.cjs');
  const scriptBytes = Buffer.from('/* pinned input */');
  writeFileSync(script, scriptBytes);
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  return { root, exe, exeSha: sha(exeBytes), script, scriptSha: sha(scriptBytes), temp };
}

export function baseRequest(ws: Workspace, overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    identity: { runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    executable: { path: ws.exe, sha256: ws.exeSha },
    inputs: [{ path: ws.script, sha256: ws.scriptSha }],
    argv: [ws.script, '--mode', 'offline fixture'],
    workspaceRoot: ws.root,
    cwd: ws.root,
    environment: { SystemRoot: 'C:\\Windows', TEMP: ws.temp, TMP: ws.temp, COMPANYOS_TEST_MODE: 'OFFLINE' },
    timeoutMs: 1_000,
    ...overrides,
  };
}

export function verified(ws: Workspace, overrides: Partial<LaunchRequest> = {}): VerifiedLaunch {
  return verifyLaunch(baseRequest(ws, overrides), TEST_POLICY);
}

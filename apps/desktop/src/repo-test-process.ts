/**
 * BB2 FINAL FORENSIC closure — the composition-owned process port of the
 * `repo.test-check` validator. Carries the frozen repository process discipline
 * (repository-process-runner) for the validator's fresh `npm test` execution:
 *
 *   - CONSTANT command: the fixed `npm test` contract — never an assembled shell line
 *     of any dynamic value (the workspace contract is executed BY npm, not interpolated).
 *   - ALLOWLISTED child environment (ADR-0028 D12): never the parent environment, so a
 *     workspace script cannot observe credentials.
 *   - Bounded output capture and an ARMED deadline (the engine boundary bans engine-held
 *     timers; the composition arms this one).
 */
import { spawn } from 'node:child_process';

export interface RepoTestContractRun {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly outputTail: string;
}

/** Host environment allowlist (ADR-0028 D12) — everything else the parent holds is dropped. */
const ALLOWLISTED_ENV_KEYS: readonly string[] = [
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'HOMEDRIVE', 'HOMEPATH',
  'USERPROFILE', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE',
  'USERDOMAIN', 'USERNAME', 'NODE_ENV', 'NPM_CONFIG_UPDATE_NOTIFIER',
];

const MAX_CAPTURE_CHARS = 32_768;

/** The ONE production implementation of the validator's injected process port. */
export const runRepoTestContract = async (input: {
  readonly cwd: string;
  readonly timeoutMs: number;
}): Promise<RepoTestContractRun> => {
  const isWindows = process.platform === 'win32';
  const runner = isWindows ? 'cmd.exe' : '/bin/sh';
  const argv = isWindows ? ['/d', '/s', '/c', 'npm test'] : ['-c', 'npm test'];
  const childEnv: Record<string, string> = {};
  for (const key of ALLOWLISTED_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value !== '') childEnv[key] = value;
  }
  return await new Promise<RepoTestContractRun>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(runner, argv, {
      cwd: input.cwd,
      env: childEnv,
      windowsHide: true,
      shell: false,
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, input.timeoutMs);
    const capture = (chunk: Buffer | string): void => {
      if (stdout.length + stderr.length >= MAX_CAPTURE_CHARS) return;
      const text = String(chunk);
      if (stdout.length < MAX_CAPTURE_CHARS / 2) stdout += text;
      else stderr += text;
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ exitCode, timedOut, outputTail: `${stdout}\n${stderr}`.trim() });
    };
    child.on('error', () => settle(-1));
    child.on('close', (code) => settle(typeof code === 'number' ? code : -1));
  });
};

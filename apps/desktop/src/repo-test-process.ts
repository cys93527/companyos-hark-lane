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
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

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

/**
 * AUDIT-D2 — the deadline must bound the WHOLE `npm test` tree. Killing only the direct
 * child (cmd.exe / sh) left npm and the test runner alive holding the stdio pipes, so the
 * old 'close'-based settle waited for the grandchildren and the deadline bounded nothing.
 * POSIX: the root leads its own process group (detached) and the group is SIGKILLed.
 * Windows: `taskkill /PID <root> /T /F` ends the root and every descendant.
 * Settle happens on the root's 'exit' plus a short grace for trailing output; any
 * descendant still holding the pipes after that is killed and the pipes are destroyed.
 */
export interface RepoTestProcessDeps {
  readonly spawn?: typeof spawn;
  readonly platform?: NodeJS.Platform;
  readonly killTree?: (child: ChildProcess) => void;
  readonly settleGraceMs?: number;
}

const DEFAULT_SETTLE_GRACE_MS = 2_000;

export const killProcessTree = (
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: typeof spawn = spawn,
): void => {
  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 0) return;
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    try {
      const killer = spawnImpl(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
};

/** The ONE production implementation of the validator's injected process port. */
export const runRepoTestContract = async (input: {
  readonly cwd: string;
  readonly timeoutMs: number;
}, deps: RepoTestProcessDeps = {}): Promise<RepoTestContractRun> => {
  const platform = deps.platform ?? process.platform;
  const spawnImpl = deps.spawn ?? spawn;
  const killTree = deps.killTree ?? ((c: ChildProcess) => killProcessTree(c, platform, spawnImpl));
  const graceMs = deps.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
  const isWindows = platform === 'win32';
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
    let grace: ReturnType<typeof setTimeout> | null = null;
    const child = spawnImpl(runner, argv, {
      cwd: input.cwd,
      env: childEnv,
      windowsHide: true,
      shell: false,
      // POSIX: own process group so the deadline can kill npm + the test runner too.
      detached: !isWindows,
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      killTree(child);
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
      if (grace !== null) clearTimeout(grace);
      resolve({ exitCode, timedOut, outputTail: `${stdout}\n${stderr}`.trim() });
    };
    child.on('error', () => settle(-1));
    child.on('close', (code) => settle(typeof code === 'number' ? code : -1));
    // The root exited: wait a short grace for 'close' (trailing output); a descendant that
    // still holds the pipes is killed and the pipes are released so the run settles.
    child.on('exit', (code) => {
      if (settled || grace !== null) return;
      grace = setTimeout(() => {
        grace = null;
        killTree(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(typeof code === 'number' && !timedOut ? code : -1);
      }, graceMs);
    });
  });
};

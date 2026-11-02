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
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { planIsolatedLaunch, type IsolationLaunchConfig } from './executor/isolation/isolated-launch-seam.js';

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
  /** AUDIT-D1: the isolated launch (launcher + argv prefix + the constant `npm test`); default the plain shell. */
  readonly command?: { readonly executable: string; readonly argv: readonly string[] };
  /** AUDIT-D1: allowlisted keys redirected to a per-run scratch (HOME/USERPROFILE/APPDATA/TEMP...). */
  readonly envOverrides?: Readonly<Record<string, string>>;
}, deps: RepoTestProcessDeps = {}): Promise<RepoTestContractRun> => {
  const platform = deps.platform ?? process.platform;
  const spawnImpl = deps.spawn ?? spawn;
  const killTree = deps.killTree ?? ((c: ChildProcess) => killProcessTree(c, platform, spawnImpl));
  const graceMs = deps.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
  const isWindows = platform === 'win32';
  const runner = input.command?.executable ?? (isWindows ? 'cmd.exe' : '/bin/sh');
  const argv = input.command ? [...input.command.argv] : isWindows ? ['/d', '/s', '/c', 'npm test'] : ['-c', 'npm test'];
  const childEnv: Record<string, string> = {};
  for (const key of ALLOWLISTED_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value !== '') childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(input.envOverrides ?? {})) {
    if (ALLOWLISTED_ENV_KEYS.includes(key) || key === 'HOME') childEnv[key] = value;
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

// ---------------------------------------------------------------------------------------------
// AUDIT-D1 — the validator executes agent-written code (`npm test` of the agent's workspace).
// It used to run as the signed-in user outside the H16 isolation boundary, so a test script
// could rewrite the budget approvals, the provider setup or the isolation state. The runner now:
//   - isolation configured + ISOLATED  -> the snapshot is copied under the agent-writable kernel
//     state root (<userData>/agent-kernel-state/validator/<id>) and `npm test` runs through the
//     isolated launcher as the agent account (same seam as the kernel; kill-on-close job);
//   - isolation configured but DEGRADED -> nothing is spawned (fail closed, ISOLATION_DEGRADED);
//   - isolation never configured        -> runs as the user, labelled 未隔离, with HOME/APPDATA/
//     TEMP redirected to a per-run scratch, and the trusted state files are hashed before/after:
//     any change is restored and the run fails VALIDATOR_TRUSTED_STATE_TAMPERED.
// ---------------------------------------------------------------------------------------------

/** Files under userData the app trusts for authority (budget approvals/proofs, provider setup, isolation). */
export const VALIDATOR_TRUSTED_PATHS: readonly string[] = [
  join('budget', 'approvals.json'),
  join('budget', 'proofs'),
  join('provider', 'model.json'),
  join('provider', 'model-api-key.dpapi'),
  'isolation',
];

type TrustedSnapshot = Map<string, Buffer>;

const captureTrusted = (root: string): TrustedSnapshot => {
  const out: TrustedSnapshot = new Map();
  const walk = (abs: string, depth: number): void => {
    let st;
    try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) { out.set(abs, Buffer.from(`symlink:${readlinkSafe(abs)}`)); return; }
    if (st.isFile()) { out.set(abs, readFileSync(abs)); return; }
    if (st.isDirectory() && depth < 8) for (const name of readdirSync(abs)) walk(join(abs, name), depth + 1);
  };
  for (const rel of VALIDATOR_TRUSTED_PATHS) walk(join(root, rel), 0);
  return out;
};

const readlinkSafe = (abs: string): string => { try { return readlinkSync(abs); } catch { return ''; } };

const hashOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Restores every changed/removed trusted file and removes added ones; returns the changed paths. */
export const restoreTrustedState = (root: string, before: TrustedSnapshot): string[] => {
  const after = captureTrusted(root);
  const changed: string[] = [];
  for (const [abs, bytes] of before) {
    const now = after.get(abs);
    if (now !== undefined && hashOf(now) === hashOf(bytes)) continue;
    changed.push(relative(root, abs));
    try {
      if (now !== undefined) rmSync(abs, { force: true, recursive: true });
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    } catch { /* reported as changed; the run fails either way */ }
  }
  for (const abs of after.keys()) {
    if (before.has(abs)) continue;
    changed.push(relative(root, abs));
    try { rmSync(abs, { force: true, recursive: true }); } catch { /* reported */ }
  }
  return changed.sort();
};

export interface RepoTestContractRunnerOptions {
  /** Production isolation config (absent in tests/dev = never configured). */
  readonly isolation?: IsolationLaunchConfig;
  /** The agent-writable kernel state root granted at isolation setup (<userData>/agent-kernel-state). */
  readonly isolatedStateRoot?: string;
  /** <userData>: where the trusted state files live. */
  readonly trustedStateRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly run?: typeof runRepoTestContract;
}

const UNISOLATED_LABEL = '[validator: 未隔离]';

export const createRepoTestContractRunner = (options: RepoTestContractRunnerOptions) =>
  async (input: { readonly cwd: string; readonly timeoutMs: number }): Promise<RepoTestContractRun> => {
    const run = options.run ?? runRepoTestContract;
    const platform = options.platform ?? process.platform;
    const before = options.trustedStateRoot === undefined ? null : captureTrusted(options.trustedStateRoot);
    const guard = (result: RepoTestContractRun): RepoTestContractRun => {
      if (before === null || options.trustedStateRoot === undefined) return result;
      const changed = restoreTrustedState(options.trustedStateRoot, before);
      if (changed.length === 0) return result;
      return {
        exitCode: -1,
        timedOut: result.timedOut,
        outputTail: `[VALIDATOR_TRUSTED_STATE_TAMPERED] 测试脚本改动了受信任的应用状态（已恢复）：${changed.join(', ')}\n${result.outputTail}`.trim(),
      };
    };

    const decision = options.isolation === undefined ? null : await options.isolation.decide();
    if (decision !== null && decision.kind === 'refuse') {
      return { exitCode: -1, timedOut: false, outputTail: `[ISOLATION_DEGRADED] 隔离已配置但不完整，验证器不执行：${decision.problems.join(', ')}` };
    }

    if (decision !== null && decision.kind === 'launch-isolated' && options.isolation !== undefined) {
      if (options.isolatedStateRoot === undefined) {
        return { exitCode: -1, timedOut: false, outputTail: '[ISOLATION_DEGRADED] validator:stateRootMissing' };
      }
      const workRoot = join(options.isolatedStateRoot, 'validator');
      const copy = join(workRoot, randomUUID());
      try {
        mkdirSync(workRoot, { recursive: true });
        cpSync(input.cwd, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
        const plan = planIsolatedLaunch({
          decision,
          config: options.isolation,
          workspaceRoot: copy,
          extraGrantedRoots: [options.isolatedStateRoot],
          childExecutable: join(systemRoot, 'System32', 'cmd.exe'),
          childArgv: ['/d', '/s', '/c', 'npm test'],
        });
        if (plan.kind !== 'isolated') {
          const problems = plan.kind === 'refused' ? plan.problems : ['validator:unexpectedPlan'];
          return { exitCode: -1, timedOut: false, outputTail: `[ISOLATION_DEGRADED] ${problems.join(', ')}` };
        }
        return guard(await run({ cwd: copy, timeoutMs: input.timeoutMs, command: { executable: plan.executable, argv: plan.argvPrefix } }));
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }

    // Never configured: as the user, labelled, with a per-run scratch profile.
    const scratch = mkdtempSync(join(tmpdir(), 'companyos-validator-home-'));
    try {
      const envOverrides: Record<string, string> = platform === 'win32'
        ? { USERPROFILE: scratch, APPDATA: join(scratch, 'AppData', 'Roaming'), LOCALAPPDATA: join(scratch, 'AppData', 'Local'), TEMP: join(scratch, 'Temp'), TMP: join(scratch, 'Temp'), HOMEDRIVE: scratch.slice(0, 2), HOMEPATH: scratch.slice(2) }
        : { HOME: scratch, TEMP: join(scratch, 'Temp'), TMP: join(scratch, 'Temp') };
      for (const dir of new Set(Object.values(envOverrides))) mkdirSync(dir, { recursive: true });
      const result = guard(await run({ cwd: input.cwd, timeoutMs: input.timeoutMs, envOverrides }));
      return { ...result, outputTail: `${UNISOLATED_LABEL}\n${result.outputTail}`.trim() };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

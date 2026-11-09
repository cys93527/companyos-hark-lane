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
  // Live contract-fill run 13: non-secret Windows system locations/identity that native programs a
  // test contract legitimately launches (LibreOffice for a PDF export test) expect to exist.
  'ALLUSERSPROFILE', 'PROGRAMDATA', 'PUBLIC', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432', 'PROGRAMW6432', 'COMPUTERNAME', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
];

const MAX_CAPTURE_CHARS = 32_768;

/**
 * Live contract-fill run 12 (hark-live-goal 42577881852): the validator decodes the captured
 * output as UTF-8, but a Python test contract writing to a pipe uses the ANSI code page; on the
 * en-US runner (cp1252) the generated tests' Chinese prints raised UnicodeEncodeError, so a project
 * whose tests pass in a console failed `repo.test-check` on every stage and the corrective cap ended
 * the goal. CONSTANT values (never copied from the parent environment): the child's stdio is UTF-8,
 * the same encoding this port decodes with, independent of the machine locale.
 */
export const UTF8_STDIO_ENV: Readonly<Record<string, string>> = Object.freeze({
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
});

/**
 * Live contract-fill run 13: a Python test contract writing to a pipe is block-buffered, so when the
 * deadline ends a hanging run the captured tail is empty. CONSTANT: unbuffered stdio, so the verdict
 * carries the last lines the contract printed (which test hung).
 */
export const UNBUFFERED_STDIO_ENV: Readonly<Record<string, string>> = Object.freeze({
  PYTHONUNBUFFERED: '1',
});

/** Prefix of the output tail when the contract deadline ended the process tree. */
export const CONTRACT_DEADLINE_MARKER = '[VALIDATOR_DEADLINE]';

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
  for (const [key, value] of Object.entries(UTF8_STDIO_ENV)) childEnv[key] = value;
  for (const [key, value] of Object.entries(UNBUFFERED_STDIO_ENV)) childEnv[key] = value;
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
      const output = `${stdout}\n${stderr}`.trim();
      resolve({
        exitCode,
        timedOut,
        outputTail: timedOut
          ? `${CONTRACT_DEADLINE_MARKER} 测试脚本超过 ${String(input.timeoutMs)} ms 仍未结束，进程树已终止。最后输出：\n${output}`.trim()
          : output,
      });
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
  /** Directory removal seam (tests); production = recursive rmSync with Windows lock retries. */
  readonly removeDir?: (path: string) => void;
}

/** Prefix of the note appended to a verdict whose per-run scratch/copy could not be removed. */
export const SCRATCH_CLEANUP_MARKER = '[VALIDATOR_SCRATCH_CLEANUP]';

const defaultRemoveDir = (path: string): void => {
  // Windows: a file a just-ended test process (or an orphaned helper it started, e.g. a
  // LibreOffice soffice.bin) still holds open makes the removal fail EPERM/EBUSY; retry briefly.
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};

/**
 * Live contract-fill run 14 (hark-live-goal 42668857942): every repo.test-check call failed
 * `EPERM, Permission denied: ...\\companyos-validator-home-XXXX` — the test contract had already
 * run, but removing the per-run scratch profile threw from the `finally` (LibreOffice processes the
 * tests launched still held its profile files), so the throw REPLACED the verdict and the validation
 * became a tool error on every stage until the corrective cap ended the goal. Removing the scratch is
 * housekeeping: it is best-effort, never replaces the contract's verdict, and a failure is reported in
 * the verdict tail (the leftover directory is swept by a later run).
 */
export const removeBestEffort = (path: string, removeDir: (path: string) => void = defaultRemoveDir): string | null => {
  try {
    removeDir(path);
    return null;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : 'ERROR';
    return `${SCRATCH_CLEANUP_MARKER} 临时目录未能删除（${code}），已留待下次清理：${path}`;
  }
};

const SCRATCH_PREFIX = 'companyos-validator-home-';
const STALE_SCRATCH_MS = 60 * 60 * 1000;

/** Best-effort sweep of scratch profiles an earlier run could not remove (older than an hour). */
export const sweepStaleScratch = (
  root: string = tmpdir(),
  removeDir: (path: string) => void = defaultRemoveDir,
  nowMs: number = Date.now(),
): void => {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const abs = join(root, name);
    try {
      if (nowMs - lstatSync(abs).mtimeMs < STALE_SCRATCH_MS) continue;
      removeDir(abs);
    } catch { /* still locked: a later run retries */ }
  }
};

const withCleanupNote = (result: RepoTestContractRun, note: string | null): RepoTestContractRun =>
  note === null ? result : { ...result, outputTail: `${result.outputTail}\n${note}`.trim() };

const UNISOLATED_LABEL = '[validator: 未隔离]';

export const createRepoTestContractRunner = (options: RepoTestContractRunnerOptions) =>
  async (input: { readonly cwd: string; readonly timeoutMs: number }): Promise<RepoTestContractRun> => {
    const run = options.run ?? runRepoTestContract;
    const platform = options.platform ?? process.platform;
    const removeDir = options.removeDir ?? defaultRemoveDir;
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
      let result: RepoTestContractRun;
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
        result = guard(await run({ cwd: copy, timeoutMs: input.timeoutMs, command: { executable: plan.executable, argv: plan.argvPrefix } }));
      } catch (error) {
        removeBestEffort(copy, removeDir);
        throw error;
      }
      return withCleanupNote(result, removeBestEffort(copy, removeDir));
    }

    // Never configured: as the user, labelled, with a per-run scratch profile.
    if (options.removeDir === undefined) sweepStaleScratch();
    const scratch = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
    let labelled: RepoTestContractRun;
    try {
      // AUDIT-RUN7-1: only the DIRECTORY-valued keys are created. HOMEDRIVE ('C:') is a drive and
      // HOMEPATH a drive-relative path naming the scratch itself: a recursive mkdir of a drive root
      // throws EPERM on Windows, which made every unconfigured validator run a tool error.
      const directories: Record<string, string> = platform === 'win32'
        ? { USERPROFILE: scratch, APPDATA: join(scratch, 'AppData', 'Roaming'), LOCALAPPDATA: join(scratch, 'AppData', 'Local'), TEMP: join(scratch, 'Temp'), TMP: join(scratch, 'Temp') }
        : { HOME: scratch, TEMP: join(scratch, 'Temp'), TMP: join(scratch, 'Temp') };
      for (const dir of new Set(Object.values(directories))) mkdirSync(dir, { recursive: true });
      const envOverrides: Record<string, string> = platform === 'win32'
        ? { ...directories, HOMEDRIVE: scratch.slice(0, 2), HOMEPATH: scratch.slice(2) }
        : directories;
      const result = guard(await run({ cwd: input.cwd, timeoutMs: input.timeoutMs, envOverrides }));
      labelled = { ...result, outputTail: `${UNISOLATED_LABEL}\n${result.outputTail}`.trim() };
    } catch (error) {
      removeBestEffort(scratch, removeDir);
      throw error;
    }
    return withCleanupNote(labelled, removeBestEffort(scratch, removeDir));
  };

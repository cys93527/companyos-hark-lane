/**
 * H16b-3 — the single seam where the embedded DSH kernel launch becomes an ISOLATED launch.
 *
 * Production helper: resources/isolation/companyos-isolated-launch.exe (scripts/hark/isolation/isolated-launch.cs,
 * proved by hark-isolation lifecycle 40352982060, 43/43). The launcher is a transparent stdio/exit-code proxy, so
 * the app spawns it exactly like the kernel; only the executable and the argv prefix change:
 *
 *   <launcher> --account <name> --credential <file.dpapi> --cwd <workspace> -- <childExecutable> <childArgv...>
 *
 * Decisions (isolation-status.ts):
 *   - launch-isolated   → the command above; the broker MUST listen on the allow-listed brokerPort (WFP blocks
 *                         every other destination for the agent SID, loopback included);
 *   - launch-unisolated → the kernel command unchanged, labelled "未隔离" (isolation never configured);
 *   - refuse            → no spawn at all: ISOLATION_DEGRADED (configured isolation no longer matches) — never
 *                         a silent fallback to the unisolated launch.
 * A missing launcher or credential file on an ISOLATED decision is also DEGRADED (fail closed), and so is a
 * workspace outside every root the setup granted the agent account (H16b-3b: the user picked another workspace
 * after isolation setup; re-run "CompanyOS 隔离设置" to grant it).
 */
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { IsolationDispatchDecision } from './isolation-status.js';

// Absolute on the platform that runs it (Windows in production; POSIX-shaped paths only in tests).
const isAbsolute = (path: string): boolean => win32.isAbsolute(path) || posix.isAbsolute(path);

/** Case-insensitive on Windows-shaped paths (NTFS) and segment-exact: a root `ws` never covers a sibling `ws2`. */
export const isWithinRoot = (root: string, path: string): boolean => {
  const windows = win32.isAbsolute(root) && /^[A-Za-z]:|^\\\\/u.test(root);
  const p = windows ? win32 : posix;
  const norm = (v: string): string => {
    const n = p.resolve(v);
    return windows ? n.toLowerCase() : n;
  };
  const r = norm(root);
  const t = norm(path);
  if (t === r) return true;
  const rel = p.relative(r, t);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
};

export interface IsolationLaunchConfig {
  /** Absolute path of companyos-isolated-launch.exe (packaged under resources/isolation/). */
  readonly launcherPath: string;
  /** Absolute path of the DPAPI (CurrentUser) credential file written at setup time (userData/isolation/). */
  readonly credentialPath: string;
  /** Runs the helper's status check (setup.ps1 -Action status) and returns the typed decision. */
  readonly decide: () => Promise<IsolationDispatchDecision> | IsolationDispatchDecision;
  /** Test seam: file existence (default fs.existsSync). */
  readonly fileExists?: (path: string) => boolean;
}

export type IsolatedLaunchPlan =
  | {
    readonly kind: 'isolated';
    readonly executable: string;
    readonly argvPrefix: readonly string[];
    readonly brokerPort: number;
    readonly account: string;
  }
  | { readonly kind: 'unisolated'; readonly label: '未隔离' }
  | { readonly kind: 'refused'; readonly reasonCode: 'ISOLATION_DEGRADED'; readonly problems: readonly string[] };

export const planIsolatedLaunch = (input: {
  readonly decision: IsolationDispatchDecision;
  readonly config: Pick<IsolationLaunchConfig, 'launcherPath' | 'credentialPath' | 'fileExists'>;
  readonly workspaceRoot: string;
  readonly childExecutable: string;
  readonly childArgv: readonly string[];
}): IsolatedLaunchPlan => {
  const { decision, config } = input;
  if (decision.kind === 'refuse') {
    return { kind: 'refused', reasonCode: 'ISOLATION_DEGRADED', problems: decision.problems };
  }
  if (decision.kind === 'launch-unisolated') return { kind: 'unisolated', label: '未隔离' };
  const exists = config.fileExists ?? existsSync;
  const problems: string[] = [];
  if (!isAbsolute(config.launcherPath) || !exists(config.launcherPath)) problems.push('launcher:missing');
  if (!isAbsolute(config.credentialPath) || !exists(config.credentialPath)) problems.push('credential:missing');
  if (!isAbsolute(input.workspaceRoot)) problems.push('workspace:notAbsolute');
  else if (!decision.workspaceDirs.some((root) => isWithinRoot(root, input.workspaceRoot))) problems.push('workspace:notGranted');
  if (!isAbsolute(input.childExecutable)) problems.push('child:notAbsolute');
  if (problems.length > 0) return { kind: 'refused', reasonCode: 'ISOLATION_DEGRADED', problems };
  return {
    kind: 'isolated',
    executable: config.launcherPath,
    argvPrefix: [
      '--account', decision.account,
      '--credential', config.credentialPath,
      '--cwd', input.workspaceRoot,
      '--',
      input.childExecutable,
      ...input.childArgv,
    ],
    brokerPort: decision.brokerPort,
    account: decision.account,
  };
};

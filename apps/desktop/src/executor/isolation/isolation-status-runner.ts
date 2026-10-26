/**
 * H16b-3 — runs the packaged helper's start-time status check and turns it into the typed dispatch decision.
 *
 * Layout (installed build):
 *   <resources>/isolation/setup.ps1 + wfp-persistent.cs        the helper (status is unelevated; WFP objects carry
 *                                                              an explicit SD granting the installing user read)
 *   <resources>/isolation/companyos-isolated-launch.exe        the launcher (built at packaging time with in-box csc)
 *   <userData>/isolation/state.json                            written by the ELEVATED install action
 *   <userData>/isolation/agent-credential.dpapi                the DPAPI (CurrentUser) password blob
 *
 * No state file → isolation was never configured → NOT_CONFIGURED (the helper is not even started).
 * A state file → the helper MUST confirm every recorded fact; anything else is ISOLATION_DEGRADED (fail closed):
 * a missing helper, a non-Windows host, a timeout, an unreadable report.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { interpretIsolationStatus, isolationDispatchDecision, type IsolationDispatchDecision } from './isolation-status.js';
import type { IsolationLaunchConfig } from './isolated-launch-seam.js';

export const ISOLATION_STATUS_TIMEOUT_MS = 60_000;

export interface IsolationLayout {
  readonly resourcesDir: string;
  readonly userDataDir: string;
}

export const isolationPaths = (layout: IsolationLayout) => ({
  helper: join(layout.resourcesDir, 'setup.ps1'),
  launcher: join(layout.resourcesDir, 'companyos-isolated-launch.exe'),
  statePath: join(layout.userDataDir, 'isolation', 'state.json'),
  credentialPath: join(layout.userDataDir, 'isolation', 'agent-credential.dpapi'),
});

type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;

const defaultExec: Exec = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
    const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
    resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
  });
});

export const windowsPowerShell = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export const decideIsolation = async (input: {
  readonly layout: IsolationLayout;
  readonly platform?: NodeJS.Platform;
  readonly fileExists?: (path: string) => boolean;
  readonly exec?: Exec;
  readonly powershell?: string;
}): Promise<IsolationDispatchDecision> => {
  const paths = isolationPaths(input.layout);
  const exists = input.fileExists ?? existsSync;
  if (!exists(paths.statePath)) return isolationDispatchDecision({ state: 'NOT_CONFIGURED', problems: [] });
  if ((input.platform ?? process.platform) !== 'win32') {
    return isolationDispatchDecision({ state: 'ISOLATION_DEGRADED', problems: ['host:notWindows'] });
  }
  if (!exists(paths.helper)) return isolationDispatchDecision({ state: 'ISOLATION_DEGRADED', problems: ['helper:missing'] });
  const run = await (input.exec ?? defaultExec)(
    input.powershell ?? windowsPowerShell(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, '-Action', 'status', '-StatePath', paths.statePath],
    ISOLATION_STATUS_TIMEOUT_MS,
  );
  return isolationDispatchDecision(interpretIsolationStatus(run.code, run.stdout));
};

/** The production isolation config for the embedded kernel (one per composition). */
export const productionIsolationLaunchConfig = (layout: IsolationLayout): IsolationLaunchConfig => {
  const paths = isolationPaths(layout);
  return {
    launcherPath: paths.launcher,
    credentialPath: paths.credentialPath,
    decide: () => decideIsolation({ layout }),
  };
};

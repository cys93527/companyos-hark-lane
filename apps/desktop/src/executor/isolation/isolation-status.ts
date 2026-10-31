/**
 * H16b — start-time isolation status (design lane/H16_DESIGN.md; helper scripts/hark/isolation/setup.ps1).
 *
 * The helper's `-Action status` prints ONE JSON line and exits 0 (ISOLATED), 2 (not isolated) or 1
 * (failure). This module turns that raw output into the typed decision the dispatch path uses:
 *   - ISOLATED            → the kernel may launch as the agent account;
 *   - NOT_CONFIGURED      → the user never ran isolation setup: dispatch proceeds, labelled "未隔离";
 *   - ISOLATION_DEGRADED  → isolation WAS configured but something no longer matches (account, ACL,
 *                           WFP filters, unreadable output): goal dispatch is REFUSED — never a silent
 *                           fallback to the unisolated launch.
 * Fail-closed: anything that is not a well-formed, exit-code-consistent report is DEGRADED.
 */
export type IsolationState = 'ISOLATED' | 'NOT_CONFIGURED' | 'ISOLATION_DEGRADED';

export interface IsolationStatus {
  readonly state: IsolationState;
  readonly problems: readonly string[];
  readonly account?: string;
  readonly sid?: string;
  readonly brokerPort?: number;
  /** H16b-3b: the workspace roots the agent account was granted Modify on (the only roots it can work in). */
  readonly workspaceDirs?: readonly string[];
}

export type IsolationDispatchDecision =
  | {
    readonly kind: 'launch-isolated';
    readonly account: string;
    readonly sid: string;
    readonly brokerPort: number;
    readonly workspaceDirs: readonly string[];
  }
  | { readonly kind: 'launch-unisolated'; readonly label: '未隔离' }
  | { readonly kind: 'refuse'; readonly reasonCode: 'ISOLATION_DEGRADED'; readonly problems: readonly string[] };

const degraded = (...problems: string[]): IsolationStatus => ({ state: 'ISOLATION_DEGRADED', problems });

const SID = /^S-1-5-21(-\d+){3,4}$/u;

export const interpretIsolationStatus = (exitCode: number | null, stdout: string): IsolationStatus => {
  const line = stdout.split(/\r?\n/u).map((l) => l.replace(/^\uFEFF/u, '').trim()).filter((l) => l.startsWith('{')).pop();
  if (line === undefined) return degraded(`status:noReport(exit=${String(exitCode)})`);
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return degraded('status:unparseable'); }
  if (typeof raw !== 'object' || raw === null) return degraded('status:unparseable');
  const r = raw as Record<string, unknown>;
  const problems = Array.isArray(r['problems']) ? r['problems'].filter((p): p is string => typeof p === 'string') : null;
  if (problems === null) return degraded('status:problemsMissing');
  const state = r['state'];
  if (state === 'NOT_CONFIGURED') {
    return exitCode === 2 && problems.length === 0 ? { state, problems } : degraded('status:inconsistent', ...problems);
  }
  if (state === 'ISOLATION_DEGRADED') {
    return degraded(...(problems.length === 0 ? ['status:degradedWithoutProblems'] : problems));
  }
  if (state !== 'ISOLATED') return degraded(`status:unknownState:${String(state)}`);
  if (exitCode !== 0 || problems.length > 0) return degraded('status:inconsistent', ...problems);
  const account = r['account'];
  const sid = r['sid'];
  const brokerPort = r['brokerPort'];
  if (typeof account !== 'string' || account === '') return degraded('status:accountMissing');
  if (typeof sid !== 'string' || !SID.test(sid)) return degraded('status:sidInvalid');
  if (typeof brokerPort !== 'number' || !Number.isInteger(brokerPort) || brokerPort < 1024 || brokerPort > 65535) {
    return degraded('status:brokerPortInvalid');
  }
  // H16b-3b: a goal whose workspace was never granted would run as an account that cannot write there; the
  // granted roots travel with the decision so the launch plan can refuse such a workspace up front.
  const workspaceDirs = r['workspaceDirs'];
  if (!Array.isArray(workspaceDirs) || workspaceDirs.length === 0
    || !workspaceDirs.every((d): d is string => typeof d === 'string' && d.length > 0)) {
    return degraded('status:workspaceDirsMissing');
  }
  return { state, problems: [], account, sid, brokerPort, workspaceDirs };
};

export const isolationDispatchDecision = (status: IsolationStatus): IsolationDispatchDecision => {
  if (status.state === 'NOT_CONFIGURED') return { kind: 'launch-unisolated', label: '未隔离' };
  if (status.state === 'ISOLATED' && status.account !== undefined && status.sid !== undefined && status.brokerPort !== undefined
    && status.workspaceDirs !== undefined) {
    return {
      kind: 'launch-isolated',
      account: status.account,
      sid: status.sid,
      brokerPort: status.brokerPort,
      workspaceDirs: status.workspaceDirs,
    };
  }
  return {
    kind: 'refuse',
    reasonCode: 'ISOLATION_DEGRADED',
    problems: status.problems.length === 0 ? ['status:incomplete'] : status.problems,
  };
};

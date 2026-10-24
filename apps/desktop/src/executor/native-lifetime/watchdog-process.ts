/**
 * Hark lane — H4: native wiring for the independent owner watchdog.
 *
 * Owner side (`armNativeWatchdog`): BEFORE any job member exists, create the
 * watchdog process suspended and OUTSIDE the Job, duplicate into it (a) the Job
 * handle and (b) a handle to the owner process itself, write the handle values
 * to an args file in an owner-controlled directory, then resume it.
 *
 * Watchdog side (`runNativeWatchdog`): read the args file, build a WatchdogPort
 * from its OWN duplicated handles, run the pure decision loop
 * (owner-watchdog.ts) and write a result record.
 *
 * Because the watchdog holds a Job handle, kill-on-close no longer fires when
 * the owner dies; owner exit is therefore the first terminate trigger. When the
 * watchdog exits, its handle closes and kill-on-close is re-armed for anything
 * still alive. Not wired into production dispatch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { NativeHandle, NativeProcessHandles, WindowsJobPort } from './job-port.js';
import { WATCHDOG_JOB_ACCESS, WATCHDOG_OWNER_ACCESS, type NativeHandleTransfer } from './koffi-job-port.js';
import { readFileLease } from './lease-file.js';
import { runOwnerWatchdog, type WatchdogConfig, type WatchdogPort, type WatchdogResult } from './owner-watchdog.js';

export interface WatchdogArgs {
  readonly version: 1;
  readonly jobHandle: string;
  readonly ownerHandle: string;
  readonly ownerPid: number;
  readonly leasePath: string;
  readonly resultPath: string;
  readonly config: WatchdogConfig;
}

export interface ArmedWatchdog {
  readonly pid: number;
  readonly process: NativeHandle;
}

/** Owner side. Throws (and leaves no running watchdog) on any failure. */
export function armNativeWatchdog(input: {
  readonly port: WindowsJobPort;
  readonly transfer: NativeHandleTransfer;
  readonly job: NativeHandle;
  readonly executable: string;
  readonly commandLine: string;
  readonly cwd: string;
  readonly environmentBlock: Uint8Array;
  readonly argsPath: string;
  readonly leasePath: string;
  readonly resultPath: string;
  readonly config: WatchdogConfig;
}): ArmedWatchdog {
  const { port, transfer } = input;
  const wd: NativeProcessHandles = port.createSuspended(input.executable, input.commandLine, input.cwd, input.environmentBlock);
  let ok = false;
  try {
    if (port.isInJob(input.job, wd.process)) throw new Error('watchdog-inside-job');
    const jobInWatchdog = transfer.duplicateInto(wd.process, input.job, WATCHDOG_JOB_ACCESS);
    const ownerInWatchdog = transfer.duplicateInto(wd.process, transfer.currentProcessHandle(), WATCHDOG_OWNER_ACCESS);
    const args: WatchdogArgs = {
      version: 1,
      jobHandle: jobInWatchdog.toString(),
      ownerHandle: ownerInWatchdog.toString(),
      ownerPid: process.pid,
      leasePath: input.leasePath,
      resultPath: input.resultPath,
      config: input.config,
    };
    writeFileSync(input.argsPath, JSON.stringify(args), { flag: 'wx' });
    if (port.resume(wd.thread) !== 1) throw new Error('watchdog-unexpected-suspend-count');
    ok = true;
    return { pid: wd.pid, process: wd.process };
  } finally {
    try { port.close(wd.thread); } catch { /* best effort */ }
    if (!ok) {
      try { port.terminateProcess(wd.process, 0xe0003e04); } catch { /* reported by caller */ }
      try { port.close(wd.process); } catch { /* best effort */ }
    }
  }
}

function parseArgs(text: string): WatchdogArgs {
  const raw = JSON.parse(text) as Partial<WatchdogArgs>;
  const handle = (v: unknown): string => {
    if (typeof v !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(v)) throw new Error('watchdog-args-refused');
    return v;
  };
  if (raw.version !== 1 || !Number.isSafeInteger(raw.ownerPid) || typeof raw.leasePath !== 'string' || typeof raw.resultPath !== 'string' || !raw.config) {
    throw new Error('watchdog-args-refused');
  }
  return {
    version: 1,
    jobHandle: handle(raw.jobHandle),
    ownerHandle: handle(raw.ownerHandle),
    ownerPid: raw.ownerPid as number,
    leasePath: raw.leasePath,
    resultPath: raw.resultPath,
    config: raw.config,
  };
}

/** Watchdog side. Returns the result it also writes to args.resultPath. */
export async function runNativeWatchdog(input: {
  readonly port: WindowsJobPort;
  readonly argsPath: string;
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs?: number;
}): Promise<WatchdogResult & { readonly ownerPid: number }> {
  const args = parseArgs(readFileSync(input.argsPath, 'utf8'));
  const { port } = input;
  const job = BigInt(args.jobHandle);
  const owner = BigInt(args.ownerHandle);
  const wport: WatchdogPort = {
    ownerExited: () => port.hasExited(owner),
    readLease: () => readFileLease(args.leasePath),
    terminateJob: code => port.terminateJob(job, code),
    jobDrained: () => {
      const m = port.members(job);
      return port.accounting(job).activeProcesses === 0 && m.assigned === 0 && m.listed.length === 0;
    },
    closeJobHandle: () => port.close(job),
  };
  const result = await runOwnerWatchdog({ port: wport, config: args.config, clock: input.clock, sleep: input.sleep, pollMs: input.pollMs ?? 25 });
  try { port.close(owner); } catch { /* the job handle close is what matters */ }
  const out = { ...result, ownerPid: args.ownerPid };
  writeFileSync(args.resultPath, JSON.stringify(out), { flag: 'wx' });
  return out;
}

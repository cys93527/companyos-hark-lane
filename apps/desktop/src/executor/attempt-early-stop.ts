/**
 * LIVE-CONTRACT-FILL run 10 (hark-live-goal 42441418492) — AN ATTEMPT THAT CANNOT PROGRESS ENDS NOW.
 *
 * Step 1 finished (its core library, tests passing); step 2 made 126 model calls in its first
 * six minutes and then went completely silent: no model call, no kernel output, no tool result
 * for the next 15 minutes, while the UI still showed "执行中". The attempt would only have ended
 * at its 30-minute deadline. Two paths lead there:
 *   - the run-9 wrap-up drain stopped admitting model calls but left the kernel process running
 *     until the deadline (every further model request is refused, so it can only wait), and
 *   - a kernel stuck past its own tool timeouts (the persistent shell's 300 s limit) emits
 *     nothing at all.
 * Both now end the attempt EARLY, exactly like its deadline (bounded drain, proven stop,
 * outcome `timeout`): the workspace is kept, verified work is credited, and the retry resumes
 * with notes that say why it ended.
 *
 *   COS_KERNEL_SILENCE_MS  silence (no kernel output, no model exchange) that ends an attempt
 *                          (default 600 000 = 10 min; bounds 120 000 .. 3 600 000)
 */
export const KERNEL_SILENCE_ENV = 'COS_KERNEL_SILENCE_MS';
export const DEFAULT_KERNEL_SILENCE_MS = 600_000;
export const KERNEL_SILENCE_MIN_MS = 120_000;
export const KERNEL_SILENCE_MAX_MS = 3_600_000;

export type AttemptEarlyStopReason = 'KERNEL_SILENT' | 'WRAP_UP_DRAINED';

/** The silence limit from the environment; an absent or out-of-bounds value keeps the default. */
export const kernelSilenceMsOf = (env: Readonly<Record<string, string | undefined>>): number => {
  const raw = env[KERNEL_SILENCE_ENV]?.trim() ?? '';
  if (raw === '') return DEFAULT_KERNEL_SILENCE_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= KERNEL_SILENCE_MIN_MS && value <= KERNEL_SILENCE_MAX_MS ? value : DEFAULT_KERNEL_SILENCE_MS;
};

/** What the resumed attempt is told about an early stop (rendered into its notes). */
export const earlyStopHintOf = (reason: string | null): string | null => {
  if (reason === 'KERNEL_SILENT') {
    return 'It was stopped because it produced no output and made no model call for several minutes — most likely a command ' +
      'that never returned (a server, GUI, watcher or interactive prompt left running in the foreground). Never start a ' +
      'long-running process in the foreground: run servers/GUIs only in the background with a time limit, pass non-interactive flags, and keep every command bounded.';
  }
  if (reason === 'WRAP_UP_DRAINED') {
    return 'It was stopped after its wrap-up turns were used up. Finish faster: verify with the existing tests and give the final answer early.';
  }
  return null;
};

export interface AttemptEarlyStop {
  /** Kernel output or a model exchange happened now. */
  activity(): void;
  /** End the attempt early (first reason wins; later calls are ignored). */
  fire(reason: AttemptEarlyStopReason): void;
  /** Why the attempt was ended early, or null. */
  reason(): AttemptEarlyStopReason | null;
  /** Arm the silence watchdog (resets the silence clock). */
  start(): void;
  /** Disarm the silence watchdog. */
  stop(): void;
  /** The process provider's early-deadline seam: `fire` runs once when the attempt is ended early. */
  subscribe(onFire: () => void): () => void;
}

export const createAttemptEarlyStop = (input: {
  readonly silenceMs: number;
  readonly now: () => number;
  readonly armTimer: (ms: number, callback: () => void) => () => void;
}): AttemptEarlyStop => {
  let last = input.now();
  let reason: AttemptEarlyStopReason | null = null;
  let armed = false;
  let cancelCheck: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const disarm = (): void => {
    cancelCheck?.();
    cancelCheck = null;
  };
  const fire = (next: AttemptEarlyStopReason): void => {
    if (reason !== null) return;
    reason = next;
    armed = false;
    disarm();
    for (const listener of [...listeners]) listener();
  };
  const schedule = (): void => {
    disarm();
    if (!armed || reason !== null) return;
    const wait = Math.max(1_000, input.silenceMs - (input.now() - last));
    cancelCheck = input.armTimer(wait, () => {
      cancelCheck = null;
      if (!armed || reason !== null) return;
      if (input.now() - last >= input.silenceMs) fire('KERNEL_SILENT');
      else schedule();
    });
  };
  return {
    activity(): void { last = input.now(); },
    fire,
    reason: () => reason,
    start(): void {
      last = input.now();
      armed = true;
      schedule();
    },
    stop(): void {
      armed = false;
      disarm();
    },
    subscribe(onFire: () => void): () => void {
      if (reason !== null) {
        onFire();
        return () => undefined;
      }
      listeners.add(onFire);
      return () => { listeners.delete(onFire); };
    },
  };
};

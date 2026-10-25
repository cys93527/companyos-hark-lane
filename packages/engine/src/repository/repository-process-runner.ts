/**
 * RepositoryProcessRunner (Sprint 17 — Task-17-04; ADR-0028 D10–D12/D18/D19).
 *
 * THE ONE OS process primitive of the Repository Runtime. Every repository process tool
 * (`repo.terminal`, `repo.test-runner`, `repo.linter`, `repo.typechecker`, `repo.builder`)
 * runs through this runner: there is deliberately no second spawn, no second environment
 * policy, no second output buffering and no second cancellation path.
 *
 * Frozen execution model (no exceptions):
 *   - `spawn(executable, argv, { shell: false, cwd: <canonical workspace root>, env: <filtered> })`
 *   - the model never chooses the executable, the argv, the cwd or the environment: those
 *     come from the TRUSTED `RepositoryCommandProfile` carried by the WorkspaceContext.
 *   - a raw command string is never assembled (`[executable, ...argv].join(' ')` is exactly
 *     the shape that turns a fixed argv into an injectable shell line, so it never happens).
 *
 * Bounded output (Boss freeze, T17-04 §40/§42): a 16 KiB inline preview per stream and an
 * 8 MiB capture cap per stream; reaching the cap terminates the process tree immediately
 * and fails closed with OUTPUT_LIMIT_EXCEEDED instead of letting the child run on unread.
 *
 * Externalization: the FULL bytes of a stream longer than the preview are published through
 * the EXISTING Artifact/CAS content store (`sha256:<64hex>` managed refs) — never a second
 * blob store, and never a file inside the repository workspace.
 *
 * Cancellation: the registry tells a timed-out adapter to stop through `ToolPort.cancel`
 * with the invocation id, while `ToolRequest` only exposes `executionId`. The runner keeps
 * its active table keyed by `executionId` and resolves `invocationId → executionId` through
 * an injected read-only lookup, so no registry semantics are changed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import {
  domainError,
  err,
  ok,
  type ArtifactContentStore,
  type DomainError,
  type Result,
  type ToolCancelReason,
} from '@companyos/core';

import type { RepositoryCommandDescriptor } from './workspace.js';

/* ------------------------------------------------------- frozen limits ------ */

/** Boss freeze (T17-04 §40): inline preview per stream, counted in UTF-8 BYTES. */
export const MAX_PROCESS_INLINE_PREVIEW_BYTES = 16 * 1024;
/** Boss freeze (T17-04 §42): hard capture cap per stream, counted in UTF-8 bytes. */
export const MAX_PROCESS_CAPTURE_BYTES = 8 * 1024 * 1024;

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/* ------------------------------------------------- environment policy ------- */

/**
 * Host environment allowlist (ADR-0028 D12). Everything else the parent holds is dropped:
 * `env: process.env` is never used, so a repository process cannot inherit a credential
 * the shell happened to carry.
 */
const WINDOWS_ENV_ALLOWLIST: readonly string[] = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'];
const POSIX_ENV_ALLOWLIST: readonly string[] = ['PATH', 'TMPDIR', 'LANG'];
const POSIX_ENV_PREFIXES: readonly string[] = ['LC_'];

/**
 * Explicitly refused names plus the shapes that must never survive into a child environment
 * (T17-04 §17). Applied to `safeEnvAdditions` as a validation, so a trusted profile that
 * tried to publish a credential fails closed instead of silently leaking it.
 */
const SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'SSH_AUTH_SOCK',
]);
/** Shapes, not names: any API key, access key, private key or auth material is refused. */
const SECRET_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|KEY|AUTH)/i;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isSecretEnvName = (key: string): boolean => SECRET_ENV_NAMES.has(key) || SECRET_ENV_PATTERN.test(key);

/**
 * Build the child environment: allowlisted host keys only, plus the TRUSTED profile's
 * `safeEnvAdditions`. Never the whole parent environment, never a SecretVault value — this
 * runner holds no vault reference at all (T17-04 §18).
 */
export const buildFilteredProcessEnvironment = (input: {
  readonly platform: NodeJS.Platform;
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  readonly safeEnvAdditions: Readonly<Record<string, string>>;
}): Result<Readonly<Record<string, string>>, DomainError> => {
  const additions = input.safeEnvAdditions ?? {};
  for (const [key, value] of Object.entries(additions)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      return err(
        domainError('INVALID_ARGUMENT', 'The trusted command profile declares an invalid environment name.', {
          reason: 'REPOSITORY_ENV_NAME_INVALID',
          envKey: key,
        }),
      );
    }
    if (isSecretEnvName(key)) {
      return err(
        domainError('INVALID_ARGUMENT', 'The trusted command profile must not publish a secret-shaped variable.', {
          reason: 'REPOSITORY_ENV_SECRET_REFUSED',
          envKey: key,
        }),
      );
    }
    if (typeof value !== 'string' || value.includes('\u0000')) {
      return err(
        domainError('INVALID_ARGUMENT', 'The trusted command profile declares an invalid environment value.', {
          reason: 'REPOSITORY_ENV_VALUE_INVALID',
          envKey: key,
        }),
      );
    }
  }

  const filtered: Record<string, string> = {};
  const allowlist = input.platform === 'win32' ? WINDOWS_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST;
  for (const key of allowlist) {
    const value = input.hostEnv[key];
    if (typeof value === 'string') filtered[key] = value;
  }
  if (input.platform !== 'win32') {
    for (const key of Object.keys(input.hostEnv)) {
      const value = input.hostEnv[key];
      if (typeof value === 'string' && POSIX_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        filtered[key] = value;
      }
    }
  }
  // A trusted addition may refine an allowlisted variable; it can never resurrect a
  // secret-shaped one (refused above).
  for (const [key, value] of Object.entries(additions)) {
    filtered[key] = value;
  }
  return ok(filtered);
};

/* ------------------------------------------------------------- results ------ */

export interface ProcessStreamSummary {
  /** Bytes actually received on this stream (counting continues past the cap). */
  readonly byteCount: number;
  /** `sha256:<64hex>` over the bytes this summary describes. */
  readonly sha256: string;
  /** True when the captured bytes are not valid UTF-8 (no lossy text claim is made). */
  readonly binary: boolean;
  /** Bounded UTF-8 preview; '' when the stream is binary or empty. */
  readonly preview: string;
  /** True when the full stream exceeded the inline preview. */
  readonly truncated: boolean;
  /** Managed CAS ref of the FULL bytes, or '' when the stream fit inside the preview. */
  readonly artifactRef: string;
}

export type ProcessTermination =
  | 'EXITED'
  | 'SIGNALLED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'OUTPUT_LIMIT'
  | 'SPAWN_ERROR';

export interface ProcessRunOutcome {
  readonly commandKey: string;
  readonly workspaceId: string;
  /** Process exit code, or -1 when the process was killed by a signal / never ran. */
  readonly exitCode: number;
  /** Signal name ('' when the process exited normally). */
  readonly signal: string;
  readonly durationMs: number;
  readonly termination: ProcessTermination;
  readonly stdout: ProcessStreamSummary;
  readonly stderr: ProcessStreamSummary;
  /** The bounded captured bytes, present only when the caller asked for them. */
  readonly stdoutBytes?: Uint8Array;
  readonly stderrBytes?: Uint8Array;
}

export interface RepositoryProcessRunnerDeps {
  readonly clock: { nowIso(): string; now(): number };
  /** The engine may not hold a timer itself (boundary gate): the composition arms it. */
  readonly timer: (ms: number, onTimeout: () => void) => () => void;
  /** Existing Artifact/CAS content store (composition-owned). Without it a long stream
   *  keeps its preview and digest but publishes no full bytes. */
  readonly contentStore?: ArtifactContentStore;
  /**
   * Maps a durable invocation id to the execution id its adapter was called with. The
   * registry's timeout path hands `cancel` the invocation id while `ToolRequest` only
   * exposes `executionId`; this lookup is what lets a cancellation find its process.
   */
  readonly resolveExecutionId?: (invocationId: string) => Promise<string | null>;
}

export interface RepositoryProcessRunInput {
  readonly descriptor: RepositoryCommandDescriptor;
  /** Canonical workspace root — internal only, never part of any result. */
  readonly canonicalRoot: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly timeoutMs: number;
  /**
   * Opt-in for a caller that must PARSE the captured stream (e.g. Git porcelain output):
   * the outcome then also carries the bounded captured bytes of each stream. The SAME
   * capture machinery serves it — no second buffering, still capped at 8 MiB per stream —
   * and the bytes stay internal: they are never part of a tool's serialized output.
   */
  readonly includeStreamBytes?: boolean;
}

export interface RepositoryProcessRunner {
  run(input: RepositoryProcessRunInput): Promise<Result<ProcessRunOutcome, DomainError>>;
  /** `ToolPort.cancel` seam: abort the in-flight process for one invocation id. */
  cancel(invocationId: string, reason?: ToolCancelReason): Promise<Result<true, DomainError>>;
  /**
   * Abort and WAIT for the run to settle, returning its bounded outcome so a caller can
   * publish failure evidence for a run the registry itself terminated (its timeout path
   * discards the adapter's own error, so this is the only way the evidence survives).
   * `null` means nothing was in flight for that invocation.
   */
  cancelAndAwait(invocationId: string, reason?: ToolCancelReason): Promise<Result<ProcessRunOutcome | null, DomainError>>;
  /** In-flight count (process-local; diagnostics only). */
  activeCount(): number;
}

/* ------------------------------------------------------------- internals ---- */

const digestOf = (bytes: Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/**
 * Strict UTF-8 decode of the WHOLE given byte range: `binary` is true only when the bytes
 * really are not UTF-8 (a cut multi-byte character at the preview boundary is trimmed
 * instead of replaced, so a truncated preview never becomes a lossy text claim).
 */
const decodeText = (bytes: Uint8Array): { readonly text: string; readonly binary: boolean } => {
  if (bytes.byteLength === 0) return { text: '', binary: false };
  try {
    return { text: UTF8_DECODER.decode(bytes), binary: false };
  } catch {
    for (let back = 1; back <= 3 && back < bytes.byteLength; back += 1) {
      try {
        return { text: UTF8_DECODER.decode(bytes.subarray(0, bytes.byteLength - back)), binary: false };
      } catch {
        // a multi-byte character was cut by the boundary — keep trimming
      }
    }
    return { text: '', binary: true };
  }
};

/** One captured stream: bounded memory, exact byte count, honest digest. */
class StreamCapture {
  byteCount = 0;
  private readonly chunks: Uint8Array[] = [];
  private kept = 0;
  private capped = false;

  /** Returns true when this chunk pushed the stream past the capture cap. */
  push(chunk: Uint8Array): boolean {
    this.byteCount += chunk.byteLength;
    if (this.capped) return false;
    if (this.kept + chunk.byteLength > MAX_PROCESS_CAPTURE_BYTES) {
      const room = MAX_PROCESS_CAPTURE_BYTES - this.kept;
      if (room > 0) {
        this.chunks.push(chunk.subarray(0, room));
        this.kept += room;
      }
      this.capped = true;
      return true;
    }
    this.chunks.push(chunk);
    this.kept += chunk.byteLength;
    return false;
  }

  get overflowed(): boolean {
    return this.capped;
  }

  bytes(): Uint8Array {
    return concatBytes(this.chunks);
  }
}

interface RunningProcess {
  readonly child: ChildProcess;
  terminate(reason: ProcessTermination): void;
  /** Resolves once the run has been summarized and its outcome recorded. */
  readonly settled: Promise<void>;
  /** The bounded outcome, readable by whoever awaited `settled`. */
  outcome: ProcessRunOutcome | null;
  /** The timeout this run was started with, in ms. */
  readonly deadlineMs: number | undefined;
  /** Milliseconds already spent on this run. */
  readonly elapsedMs: () => number;
}

/**
 * H14 — every live descendant of `rootPid` on Linux, read from /proc (parent links), so a
 * tree stop also reaches a grandchild that left the child's process group (`setsid`, a
 * `detached: true` spawn). Before H14 the POSIX stop signalled only the child's group and
 * such a grandchild survived the cancel (found by the Ubuntu gate). Empty off Linux or
 * when /proc is unreadable: the process-group signal is then the whole stop.
 */
export const linuxDescendantPids = (
  rootPid: number,
  proc: { readonly list: () => readonly string[]; readonly stat: (pid: string) => string } = {
    list: () => readdirSync('/proc'),
    stat: (pid) => readFileSync(`/proc/${pid}/stat`, 'utf8'),
  },
): number[] => {
  const children = new Map<number, number[]>();
  let entries: readonly string[];
  try {
    entries = proc.list();
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/u.test(entry)) continue;
    let stat: string;
    try {
      stat = proc.stat(entry);
    } catch {
      continue; // exited between the listing and the read
    }
    // `pid (comm) state ppid …` — comm may contain spaces/parentheses: parse after the LAST ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(Number(entry));
    children.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (out.includes(pid)) continue;
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
};

export const createRepositoryProcessRunner = (deps: RepositoryProcessRunnerDeps): RepositoryProcessRunner => {
  const running = new Map<string, RunningProcess>();

  /** Kill the process and its children (Windows + POSIX), never through a shell. */
  const terminateTree = (child: ChildProcess): void => {
    if (child.exitCode !== null || child.signalCode !== null) return; // already reaped
    try {
      if (process.platform === 'win32') {
        if (child.pid === undefined) {
          child.kill('SIGKILL');
          return;
        }
        // `taskkill /T` is the OS process-tree primitive. The parent is NOT killed
        // synchronously first: killing it before taskkill has walked the tree would orphan
        // the grandchildren and leave them running. taskkill is awaited; only a failure
        // (missing binary, refusal) falls back to killing the direct child alone.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => {
          child.kill('SIGKILL');
        });
        killer.on('close', (code) => {
          if (code !== 0 && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        });
        return;
      }
      if (child.pid !== undefined) {
        const rootPid = child.pid;
        if (process.platform === 'linux') {
          // Freeze first (group + every descendant found, repeated until no new one appears),
          // so nothing can fork past the walk; then kill everything that was frozen.
          const frozen = new Set<number>();
          const signal = (pid: number, sig: NodeJS.Signals): void => {
            try {
              process.kill(pid, sig);
            } catch {
              // already gone
            }
          };
          signal(-rootPid, 'SIGSTOP');
          for (let round = 0; round < 8; round += 1) {
            const found = linuxDescendantPids(rootPid).filter((pid) => !frozen.has(pid));
            if (found.length === 0) break;
            for (const pid of found) {
              frozen.add(pid);
              signal(pid, 'SIGSTOP');
            }
          }
          for (const pid of frozen) signal(pid, 'SIGKILL');
        }
        try {
          // The child was spawned detached: it leads its own process group, so the whole
          // group dies from one signal.
          process.kill(-rootPid, 'SIGKILL');
          return;
        } catch {
          // group already gone — fall through to the direct child
        }
      }
      child.kill('SIGKILL');
    } catch {
      // best effort: a kill that cannot be delivered is reflected in the outcome, not hidden
    }
  };

  const summarize = async (
    capture: StreamCapture,
    externalize: boolean,
  ): Promise<Result<ProcessStreamSummary, DomainError>> => {
    const bytes = capture.bytes();
    const decoded = decodeText(bytes);
    const previewBytes = bytes.subarray(0, Math.min(bytes.byteLength, MAX_PROCESS_INLINE_PREVIEW_BYTES));
    const preview = decoded.binary ? '' : decodeText(previewBytes).text;
    // A stream longer than the inline preview is externalized; so is a binary stream, whose
    // bytes no text preview could represent (T17-04 §46: no lossy text claim).
    const needsExternalization = decoded.binary || capture.byteCount > previewBytes.byteLength;
    let artifactRef = '';
    if (externalize && needsExternalization && deps.contentStore !== undefined && bytes.byteLength > 0) {
      const stored = await deps.contentStore.put(bytes);
      artifactRef = stored.contentRef;
    }
    return ok({
      byteCount: capture.byteCount,
      sha256: digestOf(bytes),
      binary: decoded.binary,
      preview,
      truncated: needsExternalization,
      artifactRef,
    });
  };

  const run = async (input: RepositoryProcessRunInput): Promise<Result<ProcessRunOutcome, DomainError>> => {
    const startedAt = deps.clock.now();
    const env = buildFilteredProcessEnvironment({
      platform: process.platform,
      hostEnv: process.env,
      safeEnvAdditions: input.descriptor.safeEnvAdditions,
    });
    if (!env.ok) return err(env.error);

    const stdout = new StreamCapture();
    const stderr = new StreamCapture();
    const state: { termination: ProcessTermination; exitCode: number; signal: string } = {
      termination: 'EXITED',
      exitCode: -1,
      signal: '',
    };

    const child = spawn(input.descriptor.executable, [...input.descriptor.baseArgv], {
      shell: false,
      cwd: input.canonicalRoot,
      env: env.value,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    child.stdout?.on('data', (chunk: Uint8Array) => {
      // The capture cap is enforced WHILE reading: a stream that runs past 8 MiB
      // terminates the tree immediately, so the child never keeps producing unread output.
      if (stdout.push(chunk)) entry.terminate('OUTPUT_LIMIT');
    });
    child.stderr?.on('data', (chunk: Uint8Array) => {
      if (stderr.push(chunk)) entry.terminate('OUTPUT_LIMIT');
    });

    let markSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const entry: RunningProcess = {
      child,
      terminate(reason: ProcessTermination): void {
        state.termination = reason;
        terminateTree(child);
      },
      settled,
      outcome: null,
      deadlineMs: input.timeoutMs,
      elapsedMs: () => deps.clock.now() - startedAt,
    };
    running.set(input.executionId, entry);

    const finished = new Promise<void>((resolve) => {
      child.once('error', () => {
        if (state.termination === 'EXITED') state.termination = 'SPAWN_ERROR';
        resolve();
      });
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        state.exitCode = typeof code === 'number' ? code : -1;
        state.signal = signal === null ? '' : String(signal);
        if (state.termination === 'EXITED') {
          state.termination = signal === null ? 'EXITED' : 'SIGNALLED';
        }
        resolve();
      });
    });

    const cancelTimer = deps.timer(input.timeoutMs, () => {
      entry.terminate('TIMEOUT');
    });

    try {
      await finished;
    } finally {
      cancelTimer();
      running.delete(input.executionId);
    }

    const stdoutSummary = await summarize(stdout, true);
    if (!stdoutSummary.ok) return err(stdoutSummary.error);
    const stderrSummary = await summarize(stderr, true);
    if (!stderrSummary.ok) return err(stderrSummary.error);

    const durationMs = deps.clock.now() - startedAt;
    const outcome: ProcessRunOutcome = {
      commandKey: input.descriptor.commandKey,
      workspaceId: input.workspaceId,
      exitCode: state.exitCode,
      signal: state.signal,
      durationMs,
      termination: state.termination,
      stdout: stdoutSummary.value,
      stderr: stderrSummary.value,
      ...(input.includeStreamBytes === true
        ? { stdoutBytes: stdout.bytes(), stderrBytes: stderr.bytes() }
        : {}),
    };
    entry.outcome = outcome;
    markSettled();
    // Every settled run reports its bounded outcome; the TOOL layer classifies success and
    // failure and publishes the evidence. Keeping the verdict here would hide a
    // registry-initiated timeout's evidence (its error is discarded by the registry's race),
    // so the runner stays a reporting primitive (T17-04 corrective).
    return ok(outcome);
  };

  /** Resolve an invocation id to the execution id its adapter was called with. */
  const locate = async (invocationId: string): Promise<Result<string | null, DomainError>> => {
    const unresolved: DomainError = domainError(
      'INVALID_ARGUMENT',
      'Cancellation cannot map an invocation to a running process.',
      { reason: 'PROCESS_CANCEL_UNRESOLVED', invocationId },
    );
    if (deps.resolveExecutionId === undefined) return err(unresolved);
    const executionId = await deps.resolveExecutionId(invocationId);
    if (executionId === null) return err(unresolved);
    return ok(executionId);
  };

  return {
    run,
    async cancel(invocationId: string, reason?: ToolCancelReason): Promise<Result<true, DomainError>> {
      const located = await locate(invocationId);
      if (!located.ok) return err(located.error);
      const entry = located.value === null ? undefined : running.get(located.value);
      if (entry === undefined) {
        // Nothing in flight for that execution: an idempotent, honest "already finished".
        return ok(true);
      }
      entry.terminate(reason ?? cancellationReasonOf(entry));
      return ok(true);
    },
    async cancelAndAwait(invocationId: string, reason?: ToolCancelReason): Promise<Result<ProcessRunOutcome | null, DomainError>> {
      const located = await locate(invocationId);
      if (!located.ok) return err(located.error);
      const entry = located.value === null ? undefined : running.get(located.value);
      if (entry === undefined) {
        // Nothing in flight: the run finished (or never started) before the cancellation.
        return ok(null);
      }
      entry.terminate(reason ?? cancellationReasonOf(entry));
      // Wait for the run to be summarized: the outcome (with previews, digests and CAS
      // refs) is what a caller must publish as durable failure evidence.
      await entry.settled;
      return ok(entry.outcome);
    },
    activeCount(): number {
      return running.size;
    },
  };
};

/**
 * Fallback classification for a cancel that carries NO reason (a legacy caller): a TIMEOUT
 * when it lands on the run's own deadline, otherwise an explicit cancellation.
 *
 * H14: the registry now SAYS 'TIMEOUT'. Inferring it from elapsed time was wrong: the
 * registry's timer starts before the runner's `startedAt` (spawn happens after it), so a
 * registry timeout always landed slightly BEFORE the runner's own deadline and was
 * recorded as CANCELLED (and with an injected clock that does not advance, always).
 */
const cancellationReasonOf = (entry: RunningProcess): ProcessTermination => {
  const deadlineMs = entry.deadlineMs;
  const elapsedMs = entry.elapsedMs();
  return deadlineMs !== undefined && elapsedMs >= deadlineMs ? 'TIMEOUT' : 'CANCELLED';
};

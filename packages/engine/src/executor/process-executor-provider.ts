/**
 * Sprint24 — the GENERIC PROCESS EXECUTOR PROVIDER (§36): the smallest shared
 * process/runtime mechanics every process-backed adapter needs. Not a universal
 * shell templating language; provider-specific protocol belongs in the adapter
 * (the desktop composition), which supplies argv building and result parsing.
 *
 * Process management law (§35): shell:false always; bounded stdout/stderr
 * capture (a stream that runs past the cap terminates the tree); exit code,
 * start/exit instants and termination result captured; the whole tree is
 * killed via the repository's proven primitives (taskkill /T /F on Windows);
 * no secret ever enters argv or the environment we pass.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { domainError, type DomainError, err, ok, type Result } from '@companyos/core';

import {
  assertExecutionCwdAllowed,
  buildExecutorEnvironment,
  executorEnvAllowlistFor,
  resolveTrustedWorkspaceRoot,
  type ExecutorEnvironmentPolicy,
} from './execution-safety.js';
import type {
  ExecutorCapabilityName,
  ExecutorExecutionRequest,
  ExecutorProvider,
  ExecutorProviderDescriptor,
  ExecutorProviderOutcome,
} from './executor-provider.js';

const OUTPUT_CAP_BYTES = 1_024 * 1_024; // 1 MiB per stream — bounded diagnostics, never unbounded logs

/**
 * The child-process environment policy (Sprint25).
 *
 * The parent environment is NEVER inherited wholesale. Only allowlisted host
 * variables cross into the child, plus the trusted composition's declared
 * additions (validated as name/value pairs and refused when secret-shaped). This
 * is the same law the repository process runner already enforces (ADR-0028 D12) —
 * one environment policy for every child this system creates.
 */
export interface ExecutorEnvPolicyInput {
  readonly platform?: NodeJS.Platform;
  readonly allowlist?: readonly string[];
  /** Defaults to the host environment; it is FILTERED, never passed through. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly declaredAdditions?: Readonly<Record<string, string>>;
}

export interface ProcessExecutorConfig {
  /**
   * The engine may not hold a timer itself (boundary gate): the composition arms the
   * deadline, exactly like the repository process runner's timer seam.
   */
  readonly timer?: (ms: number, onTimeout: () => void) => () => void;
  readonly providerKey: string;
  readonly capabilities: readonly ExecutorCapabilityName[];
  readonly executable: string;
  readonly baseArgv: readonly string[];
  /** Default cwd ONLY when the request carries no workspace (fail-closed callers pass null). */
  readonly fallbackCwd: string | null;
  /**
   * The trusted workspace root every spawn cwd must be contained in (component
   * boundary, no reparse escape). When omitted, the effective cwd is self-anchored:
   * the composition asserts that exact directory, and existence/shape/reparse
   * checks still run.
   */
  readonly trustedRoot?: string | null;
  /** Explicit child-environment policy; omitting it still never inherits wholesale. */
  readonly envPolicy?: ExecutorEnvPolicyInput;
  /**
   * LIVE-SMOKE-FIX-08B (LEVEL B evidence): an INCREMENTAL stdout line tap. Every
   * COMPLETE newline-terminated line the child emitted is delivered here AS IT
   * ARRIVES (plus the unterminated remainder when the child closes) — before any
   * settle-time processing. Pure observation: the tap can never alter the outcome.
   */
  readonly tapStdoutLine?: (line: string) => void;
  /**
   * Adapter protocol: build argv from the request, and parse the captured
   * stdout into the structured payload + external identity. Lives in the
   * composition (vendor protocol), never here.
   */
  readonly buildArgs?: (request: ExecutorExecutionRequest) => readonly string[];
  readonly parseResult?: (
    stdoutText: string,
  ) => { readonly structured?: unknown; readonly providerSessionId?: string } | null;
}

/**
 * The platform's default allowlist for a provider child. Only names the process
 * itself needs to run (a search path, the OS root, temp locations) — never
 * credentials.
 */
const defaultAllowlistFor = (platform: NodeJS.Platform): readonly string[] =>
  executorEnvAllowlistFor(platform);

const killTree = (child: ChildProcess, timer: ProcessExecutorConfig['timer']): Promise<boolean> => {
  // Never issue a PID-based kill for an already-reaped child (PID reuse).
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore',
        });
        const cancel = timer?.(5000, () => {
          // Only the helper created here, never an arbitrary system process.
          try { killer.kill('SIGKILL'); } catch { /* unknown termination remains false */ }
          resolve(false);
        });
        killer.once('error', () => { cancel?.(); resolve(false); });
        killer.once('close', (code) => { cancel?.(); resolve(code === 0); });
      } catch {
        resolve(false);
      }
    });
  }
  try {
    // This provider creates a separate POSIX process group. Killing only the
    // direct child cannot establish tree termination.
    process.kill(-child.pid, 'SIGKILL');
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
};

class BoundedCapture {
  private chunks: Buffer[] = [];
  private size = 0;
  private overflowed = false;
  push(chunk: Uint8Array): boolean {
    this.size += chunk.byteLength;
    if (this.size > OUTPUT_CAP_BYTES) {
      this.overflowed = true;
      return true; // signal termination
    }
    this.chunks.push(Buffer.from(chunk));
    return false;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
  get truncated(): boolean {
    return this.overflowed;
  }
}

export const createProcessExecutorProvider = (config: ProcessExecutorConfig): ExecutorProvider => {
  const descriptor: ExecutorProviderDescriptor = {
    providerKey: config.providerKey,
    capabilities: config.capabilities,
  };
  const envPolicy: ExecutorEnvironmentPolicy = {
    platform: config.envPolicy?.platform ?? process.platform,
    hostEnvAllowlist:
      config.envPolicy?.allowlist ?? defaultAllowlistFor(config.envPolicy?.platform ?? process.platform),
    hostEnv: config.envPolicy?.hostEnv ?? process.env,
    declaredAdditions: config.envPolicy?.declaredAdditions ?? {},
  };

  return {
    descriptor,
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      const isAborted = (): boolean => request.signal?.aborted === true;
      if (isAborted()) return { kind: 'cancelled', terminationProven: true };
      if ((request.timeoutMs !== undefined || request.signal !== undefined) && config.timer === undefined) {
        return { kind: 'transport-failed', reasonCode: 'EXECUTOR_TIMER_REQUIRED', detail: 'A composition timer is required to enforce the deadline and bound cancellation cleanup.' };
      }
      const startedAt = new Date().toISOString();
      const requestedCwd = request.workspace?.cwd ?? config.fallbackCwd;
      if (requestedCwd === null || requestedCwd === undefined) {
        return {
          kind: 'transport-failed',
          reasonCode: 'EXECUTOR_WORKSPACE_UNTRUSTED',
          detail: 'No trusted workspace was configured for this provider; refusing to spawn in an arbitrary directory.',
        };
      }

      // --- workspace authority, immediately BEFORE the spawn (Sprint25) ---------
      // Defense in depth behind the dispatch preflight: even a caller that skipped
      // the ordered preflight cannot turn this provider into an unverified spawn.
      //
      // A REQUESTED cwd must be carried with the trusted root it was derived from
      // (the dispatch preflight proves both). A provider with no root of its own
      // cannot verify a requested directory, so it refuses one — an unverifiable
      // request cwd is an unverified workspace, and an unverified workspace is no
      // execution. When no cwd is requested at all, the composition-declared
      // fallback is itself the trusted root.
      const requestedRoot = request.workspace?.root ?? config.trustedRoot ?? null;
      if (request.workspace !== null && requestedRoot === null) {
        return {
          kind: 'transport-failed',
          reasonCode: 'EXECUTOR_WORKSPACE_UNTRUSTED',
          detail: 'A requested workspace cwd arrived without a trusted root to verify it against; refusing to spawn.',
        };
      }
      const trustedRootInput = requestedRoot ?? requestedCwd;
      const root = resolveTrustedWorkspaceRoot({ root: trustedRootInput, platform: envPolicy.platform });
      if (!root.ok) {
        return {
          kind: 'transport-failed',
          reasonCode: 'EXECUTOR_WORKSPACE_UNTRUSTED',
          detail: `The trusted workspace root could not be verified (${String(root.error.details['reason'] ?? root.error.code)}).`,
        };
      }
      const cwdCheck = assertExecutionCwdAllowed({
        cwd: requestedCwd,
        canonicalRoot: root.value.canonicalRoot,
        platform: envPolicy.platform,
      });
      if (!cwdCheck.ok) {
        return {
          kind: 'transport-failed',
          reasonCode: 'EXECUTOR_WORKSPACE_UNTRUSTED',
          detail: `The execution cwd is not a trusted workspace path (${String(cwdCheck.error.details['reason'] ?? cwdCheck.error.code)}).`,
        };
      }
      const cwd = cwdCheck.value.canonicalCwd;

      // --- child environment: allowlist + validated additions (never wholesale) --
      const childEnv = buildExecutorEnvironment(envPolicy);
      if (!childEnv.ok) {
        return {
          kind: 'transport-failed',
          reasonCode: 'EXECUTOR_ENVIRONMENT_REFUSED',
          detail: `The provider environment was refused (${String(childEnv.error.details['reason'] ?? childEnv.error.code)}).`,
        };
      }

      const argv = [...config.baseArgv, ...(config.buildArgs?.(request) ?? [request.taskText])];
      if (isAborted()) return { kind: 'cancelled', terminationProven: true };
      const stdout = new BoundedCapture();
      const stderr = new BoundedCapture();
      const state: { terminated: 'no' | 'timeout' | 'abort' | 'output-limit'; exitCode: number } = {
        terminated: 'no',
        exitCode: -1,
      };
      const child = spawn(config.executable, argv, {
        shell: false,
        cwd,
        env: childEnv.value,
        stdio: [request.signal === undefined && !argv.includes('-') ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      let markExited: () => void = () => undefined;
      const exited = new Promise<void>((resolve) => {
        markExited = resolve;
      });
      let rootExited = false;
      let retired = false;
      let treeStopped = false;
      let killSettled = false;
      let cancelCleanup: (() => void) | undefined;
      const checkStopped = (): void => {
        if (rootExited && killSettled) markExited();
      };
      const stop = (reason: 'timeout' | 'abort' | 'output-limit'): void => {
        if (rootExited || state.terminated !== 'no') return;
        state.terminated = reason;
        // A failed kill must not hold dispatch forever. The timeout outcome
        // remains unproven; a late root exit does not retroactively prove the tree.
        cancelCleanup = config.timer?.(5000, markExited);
        if (config.timer === undefined) markExited();
        void killTree(child, config.timer).then((proven) => {
          treeStopped = proven;
          killSettled = true;
          checkStopped();
        });
      };
      const tap = config.tapStdoutLine;
      let tapBuffer = '';
      const NL = String.fromCharCode(10);
      const tapChunk = (chunk: string): void => {
        if (tap === undefined) return;
        tapBuffer += chunk;
        let newlineAt = tapBuffer.indexOf(NL);
        while (newlineAt >= 0) {
          tap(tapBuffer.slice(0, newlineAt));
          tapBuffer = tapBuffer.slice(newlineAt + 1);
          newlineAt = tapBuffer.indexOf(NL);
        }
        // Bound the partial-line buffer so a pathological binary stream cannot grow it forever.
        if (tapBuffer.length > 65_536) {
          tap(tapBuffer);
          tapBuffer = '';
        }
      };
      child.stdout?.on('data', (chunk: Uint8Array) => {
        if (retired) return;
        tapChunk(Buffer.from(chunk).toString('utf8'));
        if (stdout.push(chunk)) {
          stop('output-limit');
        }
      });
      child.stderr?.on('data', (chunk: Uint8Array) => {
        if (retired) return;
        if (stderr.push(chunk)) {
          stop('output-limit');
        }
      });
      child.on('error', () => {
        state.exitCode = -1;
        markExited();
      });
      child.on('close', (code: number | null) => {
        if (!retired && tap !== undefined && tapBuffer.length > 0) {
          tap(tapBuffer);
          tapBuffer = '';
        }
        state.exitCode = code === null ? -1 : code;
        rootExited = true;
        if (state.terminated === 'no') markExited();
        else checkStopped();
      });

      const onAbort = (): void => {
        stop('abort');
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (isAborted()) onAbort();
      const cancelTimer =
        config.timer !== undefined && request.timeoutMs !== undefined
          ? config.timer(request.timeoutMs, () => {
              stop('timeout');
            })
          : undefined;

      await exited;
      retired = true;
      cancelTimer?.();
      cancelCleanup?.();
      request.signal?.removeEventListener('abort', onAbort);
      const finishedAt = new Date().toISOString();
      const stdoutText = stdout.text();
      const parsed = state.terminated === 'no' ? config.parseResult?.(stdoutText) ?? null : null;
      const providerSessionId = parsed?.providerSessionId;

      if (state.terminated === 'timeout') {
        // LIVE-SMOKE-FIX-08 P1-2: keep the captured-so-far stdout (bounded tail) so a
        // killed attempt's last visible actions stay attributable. The BoundedCapture
        // already enforces the size ceiling; the tail keeps the FINAL (most forensic)
        // bytes when truncation hit.
        const captured = stdout.text();
        const TAIL = 8192;
        const stdoutText =
          captured.length <= TAIL ? captured : `${captured.slice(captured.length - TAIL)}
(stdout tail truncated)`;
        return { kind: 'timeout', terminationProven: rootExited && treeStopped, providerSessionId, stdoutText };
      }
      if (state.terminated === 'abort') {
        return { kind: 'cancelled', terminationProven: rootExited && treeStopped, providerSessionId };
      }
      if (state.terminated === 'output-limit') {
        if (!rootExited || !treeStopped) {
          return { kind: 'uncertain', reason: 'EXECUTOR_OUTPUT_LIMIT_TERMINATION_UNPROVEN', providerSessionId };
        }
        return { kind: 'provider-failed', exitCode: state.exitCode, stdoutText, stderrText: stderr.text(), reasonCode: 'EXECUTOR_OUTPUT_LIMIT', providerSessionId };
      }
      if (state.exitCode === -1) {
        return {
          kind: 'transport-failed',
          reasonCode: 'EXECUTOR_PROCESS_LAUNCH_FAILED',
          detail: stderr.truncated ? '(stderr truncated)' : stderr.text().slice(0, 500),
          providerSessionId,
        };
      }
      if (state.exitCode !== 0) {
        return {
          kind: 'provider-failed',
          exitCode: state.exitCode,
          stdoutText: stdout.truncated ? `${stdoutText}\n(stdout truncated)` : stdoutText,
          stderrText: stderr.truncated ? `${stderr.text()}\n(stderr truncated)` : stderr.text(),
          providerSessionId,
        };
      }
      return {
        kind: 'succeeded',
        exitCode: state.exitCode,
        ...(providerSessionId === undefined ? {} : { providerSessionId }),
        stdoutText: stdout.truncated ? `${stdoutText}\n(stdout truncated)` : stdoutText,
        ...(parsed?.structured === undefined ? {} : { structured: parsed.structured }),
        startedAt,
        finishedAt,
      };
    },
  };
};

/** Structured-output validation helper shared by adapters (§32). */
export const parseNdjsonEvents = (
  stdoutText: string,
): Result<
  {
    readonly providerSessionId?: string;
    readonly finalText: string | null;
    readonly events: readonly Readonly<Record<string, unknown>>[];
  },
  DomainError
> => {
  const events: Readonly<Record<string, unknown>>[] = [];
  let providerSessionId: string | undefined;
  let finalText: string | null = null;
  for (const line of stdoutText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return err(domainError('VALIDATION_FAILED', 'The provider emitted a malformed NDJSON event.', { reason: 'EXECUTOR_NDJSON_MALFORMED' }));
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return err(domainError('VALIDATION_FAILED', 'The provider emitted a non-object NDJSON event.', { reason: 'EXECUTOR_NDJSON_MALFORMED' }));
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    /*
     * STAGE 5 adversarial state machine (fail-closed; never "take the last
     * success-looking event"): a second final, any event after the final, or a
     * final without a preceding session is a protocol violation — the run is
     * malformed, not reinterpreted. A session id that CHANGES mid-stream is
     * equally impossible (one child = one session).
     */
    if (finalText !== null) {
      return err(domainError('VALIDATION_FAILED', 'The provider emitted an event after the final event.', { reason: 'EXECUTOR_NDJSON_EVENT_AFTER_FINAL' }));
    }
    const type = record['type'];
    if (type === 'session') {
      if (typeof record['sessionId'] !== 'string') {
        return err(domainError('VALIDATION_FAILED', 'The provider session event carries no readable session id.', { reason: 'EXECUTOR_NDJSON_MALFORMED' }));
      }
      const sessionId = String(record['sessionId']);
      if (providerSessionId !== undefined && providerSessionId !== sessionId) {
        return err(domainError('VALIDATION_FAILED', 'The provider changed its session identity mid-stream.', { reason: 'EXECUTOR_NDJSON_SESSION_CHANGED' }));
      }
      providerSessionId = sessionId;
    }
    if (type === 'final') {
      if (providerSessionId === undefined) {
        return err(domainError('VALIDATION_FAILED', 'The provider emitted a final before any session event.', { reason: 'EXECUTOR_NDJSON_FINAL_WITHOUT_SESSION' }));
      }
      if (typeof record['text'] !== 'string') {
        return err(domainError('VALIDATION_FAILED', 'The provider final event carries no text.', { reason: 'EXECUTOR_NDJSON_MALFORMED' }));
      }
      finalText = String(record['text']);
    }
    events.push(record);
  }
  return ok({
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    finalText,
    events,
  });
};

/**
 * The CompanyOS NATIVE PROCESS execution capability (Boss V1 Native Execution
 * Foundation §5-§10) — ONE deterministic, CompanyOS-owned ExecutorProvider.
 *
 * What it is: it executes an ALREADY-AUTHORIZED, explicitly configured local
 * operation — a named profile whose executable and LITERAL argv come from trusted
 * deployment data (the composition boundary, exactly where the dsh adapter's typed
 * configuration lives). The canonical Task/ExecutionAttempt/Sprint25-preflight/
 * settlement architecture is reused untouched: this is ONE more adapter behind the
 * SAME ExecutorProvider port, registry, routing and safety pipeline.
 *
 * What it is NOT (frozen, EXECUTION_CAPABILITY_MODEL / NATIVE_EXECUTION_RUNTIME):
 * not general shell access, not an AI agent, not a Codex/DSH replacement. Native
 * PROCESS answers "execute this already-authorized deterministic operation"; an
 * AGENTIC executor answers "reason about an open-ended task and decide how to act".
 *
 * Hard invariants (ARCH-039):
 *   - Natural-language task content NEVER becomes argv: the argv is the profile's
 *     literal `args` plus, when the profile declares them, TYPED inputs from the
 *     canonical immutable Task.inputs — each consumed as ONE data argument, never
 *     parsed, split or executed.
 *   - The profile registry is trusted deployment data; a task kind without a
 *     profile fails LOUD (`NATIVE_OPERATION_UNKNOWN`) — never a guess, never a
 *     shell fallback.
 *   - Raw process output is NOT business truth: canonical settlement stays with the
 *     engine; a required structured result that is not a JSON object fails typed
 *     (`NATIVE_STRUCTURED_OUTPUT_MALFORMED`).
 *
 * Safety comes from the SAME `createProcessExecutorProvider` machinery the dsh
 * adapter uses: shell:false, explicit executable, typed argv, trusted cwd with
 * component-boundary containment, AbortSignal + kill-tree cancellation, bounded
 * stdout/stderr (8 MiB), the Sprint25 allowlist environment (no wholesale
 * process.env inheritance).
 */
import {
  createProcessExecutorProvider,
  type ExecutorCapabilityName,
  type ExecutorExecutionRequest,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
} from '@companyos/engine';

import { domainError, type DomainError } from '@companyos/core';

export const NATIVE_PROCESS_PROVIDER_KEY = 'native.process';

/** The honest capability set of the native process provider (fail-loud set). */
export const NATIVE_PROCESS_CAPABILITIES: readonly ExecutorCapabilityName[] = [
  'cancellation',
  'timeout',
  'working-directory',
  'structured-output',
];

/**
 * ONE authorized native operation (§8): executable + LITERAL argv + bounds. Trusted
 * deployment data — the same authority class as the dsh adapter's typed
 * configuration. `inputArgs` optionally names Task.inputs keys whose STRING values
 * are appended as single DATA arguments (value binding, never re-parsed).
 */
export interface NativeOperationProfile {
  /** Audit/display identity of the operation. */
  readonly operationId: string;
  /** Absolute path of the executable (trusted deployment value). */
  readonly executable: string;
  /** The LITERAL argv (no interpolation of natural-language task content). */
  readonly args: readonly string[];
  /** Task.inputs keys whose string values append as single data arguments. */
  readonly inputArgs?: readonly string[];
  /** Per-invocation ceiling; the process provider enforces it via kill-tree. */
  readonly timeoutMs?: number;
}

/** task kind → its authorized operation (deployment data). */
export type NativeOperationTable = Readonly<Record<string, NativeOperationProfile>>;

const nativeFailure = (reasonCode: string, message: string): ExecutorProviderOutcome => ({
  kind: 'provider-failed',
  exitCode: -1,
  stdoutText: '',
  stderrText: message,
  reasonCode,
});

/** The composition-armed deadline seam (the engine boundary bans engine-held timers). */
export type NativeTimer = (ms: number, onTimeout: () => void) => () => void;

export const createNativeProcessProvider = (
  operations: NativeOperationTable,
  timer: NativeTimer,
): ExecutorProvider => {
  if (timer === undefined) {
    // The provider ADVERTISES the timeout capability; a construction without the
    // composition-armed deadline seam would let a hung process run unbounded while
    // the negotiation promises a bound (V1 Native Production Readiness §2). Fail
    // LOUD at construction — never a silently unbounded advertised capability.
    throw new Error(
      'createNativeProcessProvider requires the composition-armed timer: the timeout capability is advertised, so an unbounded construction is refused.',
    );
  }
  const delegates = new Map<string, ExecutorProvider>();
  for (const [taskKind, profile] of Object.entries(operations)) {
    delegates.set(
      taskKind,
      createProcessExecutorProvider({
        providerKey: NATIVE_PROCESS_PROVIDER_KEY,
        capabilities: NATIVE_PROCESS_CAPABILITIES,
        executable: profile.executable,
        baseArgv: [...profile.args],
        fallbackCwd: null, // fail closed: the dispatch preflight supplies the trusted cwd
        ...(timer === undefined ? {} : { timer }),
        buildArgs: (request) => {
          // TYPED inputs only: each declared key's STRING value becomes ONE data
          // argument — no splitting, no shell parsing, never the task text.
          const typed: string[] = [];
          for (const key of profile.inputArgs ?? []) {
            const value = request.work.taskInputs?.[key];
            if (typeof value === 'string') typed.push(value);
          }
          return typed;
        },
        parseResult: (stdoutText) => {
          // §12 minimal, generic, versionable convention: a whole-output JSON
          // object is a structured payload; anything else is plain text.
          try {
            const parsed: unknown = JSON.parse(stdoutText);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              return { structured: { schema: 'companyos/native-result/1', value: parsed } };
            }
          } catch {
            /* plain text result — legal when structured was not required */
          }
          return null;
        },
      }),
    );
  }
  return {
    descriptor: {
      providerKey: NATIVE_PROCESS_PROVIDER_KEY,
      capabilities: NATIVE_PROCESS_CAPABILITIES,
    },
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      const delegate = delegates.get(request.taskKind);
      if (delegate === undefined) {
        // Fail LOUD: no authorized operation for this task kind — never a guess.
        return nativeFailure(
          'NATIVE_OPERATION_UNKNOWN',
          `No native operation is authorized for task kind "${request.taskKind}".`,
        );
      }
      const profile = operations[request.taskKind]!;
      const outcome = await delegate.start({
        ...request,
        timeoutMs: request.timeoutMs ?? profile.timeoutMs,
      });
      // §12 fail-loud: a REQUIRED structured result must be a JSON object.
      if (request.structured && outcome.kind === 'succeeded') {
        const structured = outcome.structured as { readonly value?: unknown } | undefined;
        if (structured === undefined || structured.value === undefined) {
          return {
            kind: 'provider-failed',
            exitCode: outcome.exitCode,
            stdoutText: outcome.stdoutText.slice(0, 2_000),
            stderrText: 'The native operation did not produce a JSON-object structured result.',
            reasonCode: 'NATIVE_STRUCTURED_OUTPUT_MALFORMED',
          };
        }
      }
      return outcome;
    },
  };
};

/** Re-exported for the law doc/tests: the typed failure helper's error shape. */
export const nativeOperationUnknownError = (taskKind: string): DomainError =>
  domainError('CAPABILITY_MISSING', `No native operation is authorized for task kind "${taskKind}".`, {
    reason: 'NATIVE_OPERATION_UNKNOWN',
    taskKind,
  });

/**
 * Hark lane — H6: Supervisor integration CONTRACT for the Job-backed native
 * executor. It maps the canonical ExecutorProvider port onto the H3-H5
 * JobLifetimeAdapter. This module is NOT registered in production composition
 * (an architecture guard test enforces that). Wiring it in needs separate
 * approval and an independent review.
 *
 * Contract (each clause has an offline test in job-executor-contract.node-test.ts):
 *  C1  Unknown task kind -> provider-failed NATIVE_OPERATION_UNKNOWN, zero native calls.
 *  C2  Capabilities are honest: cancellation, timeout, working-directory. NO
 *      structured-output, because the Job launch has no stdout capture (CREATE_NO_WINDOW,
 *      no inherited std handles). A structured request, or a required capability
 *      outside the set, -> NATIVE_CAPABILITY_MISSING before any native call.
 *  C3  Workspace root + cwd must be supplied by the dispatch preflight; otherwise
 *      NATIVE_WORKSPACE_REQUIRED.
 *  C4  argv = the operation's literal args + typed STRING task inputs, one data argument each.
 *      Task text never becomes argv. The executable and inputs are hash-pinned
 *      deployment data; verifyLaunch refusal -> NATIVE_LAUNCH_REFUSED:<reason>.
 *  C5  The timeout is min(request, operation). The operation bound can never be raised.
 *  C6  The adapter must enforce launch pinning (REQUIRED). Otherwise construction throws.
 *  C7  Outcome mapping:
 *        EXITED        -> succeeded (exitCode 0)
 *        FAILED        -> provider-failed NATIVE_JOB_FAILED / NATIVE_IDENTITY_COVERAGE_INCOMPLETE
 *        TIMEOUT       -> timeout { terminationProven: proven && drained }
 *        CANCELLED     -> cancelled { terminationProven: proven && drained }
 *        LAUNCH_FAILED -> provider-failed NATIVE_LAUNCH_FAILED:<op> (nothing resumed)
 *        STOP_UNPROVEN -> uncertain NATIVE_STOP_UNPROVEN, and the provider LATCHES BLOCKED
 *        adapter throw -> uncertain NATIVE_ADAPTER_THREW, LATCHES BLOCKED
 *  C8  While blocked (latched or adapter quarantined), every start ->
 *      provider-failed NATIVE_EXECUTION_BLOCKED with zero native calls. The latch never self-clears.
 *  C9  The provider never claims success without drain: succeeded requires
 *      drained && terminationProven && identityCoverageComplete.
 *  C11 (H7) structured-output is advertised ONLY when the adapter captures output.
 *      A structured result must be complete (EOF on both streams, nothing dropped)
 *      and a whole-output JSON object. Otherwise NATIVE_OUTPUT_INCOMPLETE or
 *      NATIVE_STRUCTURED_OUTPUT_MALFORMED. Truncated plain text carries a marker.
 *  C10 The request's AbortSignal is forwarded. The provider never makes model calls
 *      (no supportsCallAdmission).
 */
import type {
  ExecutorCapabilityName,
  ExecutorExecutionRequest,
  ExecutorProvider,
  ExecutorProviderOutcome,
} from '@companyos/engine';
import type { JobLifetimeAdapter, LifetimeResult } from './job-lifetime.js';
import { LaunchRefused, verifyLaunch, type LaunchPolicy, type LaunchRequest } from './launch-pins.js';

export const NATIVE_JOB_PROVIDER_KEY = 'native.job';
export const NATIVE_JOB_CAPABILITIES: readonly ExecutorCapabilityName[] = Object.freeze(['cancellation', 'timeout', 'working-directory'] as ExecutorCapabilityName[]);

export interface NativeJobOperation {
  readonly operationId: string;
  readonly executable: { readonly path: string; readonly sha256: string };
  readonly inputs: readonly { readonly path: string; readonly sha256: string }[];
  readonly args: readonly string[];
  readonly inputArgs?: readonly string[];
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface NativeJobProviderDeps {
  readonly operations: Readonly<Record<string, NativeJobOperation>>;
  readonly adapter: JobLifetimeAdapter;
  readonly policy: LaunchPolicy;
  readonly nowIso: () => string;
}

export interface NativeJobProvider extends ExecutorProvider {
  readonly blocked: boolean;
  readonly blockReason: string | null;
}

const failed = (reasonCode: string, detail: string, exitCode = -1): ExecutorProviderOutcome => ({
  kind: 'provider-failed', exitCode, stdoutText: '', stderrText: detail.slice(0, 2_000), reasonCode,
});

const summarise = (r: LifetimeResult): string =>
  r.errors.map(e => (e.nativeCode === null ? e.operation : `${e.operation}#${e.nativeCode}`)).join('; ');

export function createNativeJobExecutorProvider(deps: NativeJobProviderDeps): NativeJobProvider {
  if (deps.adapter.launchPinning !== 'REQUIRED') throw new Error('native-job-provider requires an adapter with launchPinning REQUIRED');
  let blockReason: string | null = null;
  const capabilities: readonly ExecutorCapabilityName[] = Object.freeze(
    deps.adapter.outputCapture ? [...NATIVE_JOB_CAPABILITIES, 'structured-output' as ExecutorCapabilityName] : [...NATIVE_JOB_CAPABILITIES],
  );
  const capabilitySet = new Set<string>(capabilities);

  async function start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
    if (blockReason !== null || deps.adapter.quarantined) {
      blockReason ??= 'adapter-quarantined';
      return failed('NATIVE_EXECUTION_BLOCKED', blockReason);
    }
    const op = deps.operations[request.taskKind];
    if (!op) return failed('NATIVE_OPERATION_UNKNOWN', `no native operation for task kind "${request.taskKind}"`);
    const missing = request.requiredCapabilities.filter(c => !capabilitySet.has(c));
    if (request.structured && !capabilitySet.has('structured-output')) missing.push('structured-output' as ExecutorCapabilityName);
    if (missing.length > 0) return failed('NATIVE_CAPABILITY_MISSING', missing.join(','));
    if (!request.workspace?.root) return failed('NATIVE_WORKSPACE_REQUIRED', 'dispatch preflight must supply workspace root and cwd');

    const typed: string[] = [];
    for (const key of op.inputArgs ?? []) {
      const value = request.work.taskInputs?.[key];
      if (typeof value === 'string') typed.push(value);
    }
    const launchRequest: LaunchRequest = {
      identity: { runId: request.runId, taskId: request.taskId, attemptId: request.attemptId },
      executable: op.executable,
      inputs: op.inputs,
      argv: [...op.args, ...typed],
      workspaceRoot: request.workspace.root,
      cwd: request.workspace.cwd,
      environment: op.environment,
      timeoutMs: Math.min(request.timeoutMs ?? op.timeoutMs, op.timeoutMs),
    };
    let launch;
    try {
      launch = verifyLaunch(launchRequest, deps.policy);
    } catch (e) {
      if (e instanceof LaunchRefused) return failed(`NATIVE_LAUNCH_REFUSED:${e.reason}`, e.message);
      throw e;
    }

    const startedAt = deps.nowIso();
    let r: LifetimeResult;
    try {
      r = await deps.adapter.run(launch, request.signal);
    } catch (e) {
      blockReason = `adapter-threw:${e instanceof Error ? e.message : String(e)}`;
      return { kind: 'uncertain', reason: 'NATIVE_ADAPTER_THREW' };
    }
    const proven = r.terminationProven && r.drained;
    const out = r.output;
    const decode = (b: Uint8Array | undefined, dropped: number): string => {
      const text = b ? new TextDecoder('utf-8', { fatal: false }).decode(b) : '';
      return dropped > 0 ? `${text}\n[companyos: ${dropped} bytes truncated]` : text;
    };
    const stdoutText = decode(out?.stdout, out?.droppedBytes.stdout ?? 0);
    const stderrText = decode(out?.stderr, out?.droppedBytes.stderr ?? 0);
    switch (r.outcome) {
      case 'EXITED':
        if (!proven || !r.identityCoverageComplete) {
          blockReason = 'exited-without-proof';
          return { kind: 'uncertain', reason: 'NATIVE_STOP_UNPROVEN' };
        }
        if (request.structured) {
          if (!out || !out.complete || out.droppedBytes.stdout > 0) return failed('NATIVE_OUTPUT_INCOMPLETE', 'structured result requires complete, untruncated stdout', 0);
          let value: unknown;
          try { value = JSON.parse(stdoutText); } catch { value = undefined; }
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return { kind: 'provider-failed', exitCode: 0, stdoutText: stdoutText.slice(0, 2_000), stderrText: 'native operation did not produce a JSON-object structured result', reasonCode: 'NATIVE_STRUCTURED_OUTPUT_MALFORMED' };
          }
          return { kind: 'succeeded', exitCode: 0, stdoutText, structured: { schema: 'companyos/native-result/1', value }, startedAt, finishedAt: deps.nowIso() };
        }
        return { kind: 'succeeded', exitCode: 0, stdoutText, startedAt, finishedAt: deps.nowIso() };
      case 'FAILED': {
        const rootExit = r.processes.find(p => p.role === 'ROOT')?.exitCode ?? -1;
        return {
          kind: 'provider-failed', exitCode: rootExit, stdoutText: stdoutText.slice(0, 8_000),
          stderrText: [stderrText.slice(0, 8_000), summarise(r)].filter(Boolean).join('\n'),
          reasonCode: r.identityCoverageComplete ? 'NATIVE_JOB_FAILED' : 'NATIVE_IDENTITY_COVERAGE_INCOMPLETE',
        };
      }
      case 'TIMEOUT':
        if (!proven) blockReason = 'timeout-stop-unproven';
        return out ? { kind: 'timeout', terminationProven: proven, stdoutText: stdoutText.slice(0, 8_000) } : { kind: 'timeout', terminationProven: proven };
      case 'CANCELLED':
        if (!proven) blockReason = 'cancel-stop-unproven';
        return { kind: 'cancelled', terminationProven: proven };
      case 'LAUNCH_FAILED':
        if (r.resumed || !proven) {
          blockReason = 'launch-failed-after-resume';
          return { kind: 'uncertain', reason: 'NATIVE_STOP_UNPROVEN' };
        }
        return failed(`NATIVE_LAUNCH_FAILED:${r.errors[0]?.operation ?? 'unknown'}`, summarise(r));
      case 'STOP_UNPROVEN':
      default:
        blockReason = `stop-unproven:${summarise(r)}`;
        return { kind: 'uncertain', reason: 'NATIVE_STOP_UNPROVEN' };
    }
  }

  return {
    descriptor: { providerKey: NATIVE_JOB_PROVIDER_KEY, capabilities },
    start,
    get blocked() { return blockReason !== null || deps.adapter.quarantined; },
    get blockReason() { return blockReason; },
  };
}

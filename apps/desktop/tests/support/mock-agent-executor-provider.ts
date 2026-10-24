/**
 * MOCK AGENT EXECUTOR PROVIDER — the Agentic Capability Validation Sprint test double.
 *
 * Purpose:
 * Prove that ANY future external agent (DSH, Codex, ZCode, other) can enter
 * CompanyOS by implementing ONLY the existing ExecutorProvider contract.
 *
 * This is NOT:
 * - a real agent runtime
 * - a new Agent Interface
 * - a second Task system
 * - a second Workflow system
 * - a new Truth
 *
 * It is TEST INFRASTRUCTURE that simulates agent behaviour inside the existing
 * ExecutorProvider boundary. It lives outside `packages/engine` deliberately: the
 * engine ships contracts, not a fake agent, and its boundary law forbids timers,
 * randomness and wall-clock reads inside the engine ring. Everything the mock
 * needs from that forbidden set is INJECTED by the caller.
 *
 * Architecture invariants this mock must preserve:
 *
 * 1. CompanyOS ALWAYS owns canonical truth:
 *    Goal / Plan / Workflow / Task / ExecutionAttempt / Validation / Artifact /
 *    Evidence / Settlement
 *
 * 2. The external agent NEVER:
 *    - creates its own Task system
 *    - creates its own Workflow system
 *    - creates its own Artifact truth
 *    - modifies CompanyOS canonical state directly
 *    - judges task success itself
 *
 * 3. Agent RECEIVES: Task, WorkPackage, Workspace, Authority, capability requirements.
 *
 * 4. Agent RETURNS: ExecutorProviderOutcome (status/output/diagnostics/evidence
 *    candidates/artifact candidates) — NEVER Task completion status, NEVER Workflow
 *    completion status, NEVER Artifact final state.
 *
 * 5. CompanyOS manages: Settlement, Validation, Artifact canonicalization,
 *    Evidence registration, Observation projection.
 *
 * DETERMINISM (why this file has no bare `Date.now` / `Math.random`):
 * the same canonical attempt identity must always produce the same simulated
 * behaviour, so a redispatch of one attempt is reproducible and a failing test is
 * diagnosable rather than flaky. Timing, identity and the clock are injected
 * seams, exactly as the production process provider treats them.
 */
import { canonicalJson, sha256Hex } from '@companyos/core';
import type {
  ExecutorExecutionRequest,
  ExecutorProvider,
  ExecutorProviderDescriptor,
  ExecutorProviderOutcome,
} from '@companyos/engine';

/**
 * The mock agent's internal state during execution — NOT CompanyOS truth.
 *
 * Real agents (DSH, Codex, ZCode) have their own internal reasoning loops, tool
 * systems and intermediate state. CompanyOS does NOT save or depend on these
 * internals; the only truth it preserves is the ExecutionAttempt, the returned
 * ExecutorProviderOutcome, and whatever Settlement canonicalizes from it.
 */
interface AgentInternalState {
  readonly phase: 'analyzing' | 'planning-tools' | 'executing-tools' | 'synthesizing' | 'reporting';
  readonly toolCalls: readonly AgentToolCall[];
  readonly observations: readonly string[];
}

interface AgentToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: string;
}

/** Why a simulated run stopped before finishing. */
type AgentStopReason = 'cancelled' | 'deadline';

/**
 * Arms one simulated delay. The caller owns real time: a test may pass a real
 * timer, a fake timer, or nothing at all. The default resolves synchronously, so
 * contract tests never depend on wall-clock duration.
 */
export type MockAgentTimer = (ms: number, onTimeout: () => void) => () => void;

export interface MockAgentExecutorConfig {
  readonly providerKey: string;
  /**
   * Simulated failure rate (0–1). Deterministic: the decision derives from the
   * attempt's canonical dispatch identity, so one attempt always behaves the same
   * way. 0 never fails, 1 always fails.
   */
  readonly simulateFailureRate?: number;
  /** Simulated slow work: the agent takes this long to finish. */
  readonly simulateTimeoutMs?: number;
  /** Injected timer seam. Omitted = every delay resolves immediately. */
  readonly timer?: MockAgentTimer;
  /** Injected instant seam. Omitted = a fixed test epoch, never the real clock. */
  readonly clock?: () => string;
}

/** The mock's fixed epoch: outcomes are compared across runs, so "now" is stable. */
const MOCK_EPOCH = '2026-01-01T00:00:00.000Z';

/** Resolves at once — the default so nothing in the default path waits on a clock. */
const IMMEDIATE_TIMER: MockAgentTimer = (_ms, onTimeout) => {
  onTimeout();
  return () => undefined;
};

/**
 * A deterministic unit value in [0, 1) for one attempt. The same dispatch
 * identity always yields the same value; different attempts yield different
 * values. This replaces `Math.random` so a simulated failure is reproducible.
 */
const deterministicUnit = (seed: string): number => {
  const digest = sha256Hex(canonicalJson({ seed }));
  // 8 hex digits → 32 bits → a uniform value in [0, 1).
  return parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000;
};

/**
 * The simulated agent's reasoning loop — EPHEMERAL and OPAQUE to CompanyOS.
 *
 * `wait` is the caller-supplied timer seam wrapped with stop handling: every
 * phase boundary goes through it, so cancellation and the caller's deadline take
 * effect between phases exactly as they would for a real agent process.
 */
const simulateAgentReasoning = async (
  request: ExecutorExecutionRequest,
  wait: (ms: number) => Promise<void>,
): Promise<AgentInternalState> => {
  const state: {
    phase: AgentInternalState['phase'];
    toolCalls: AgentToolCall[];
    observations: string[];
  } = {
    phase: 'analyzing',
    toolCalls: [],
    observations: [`Received objective: ${request.work.objective.slice(0, 100)}`],
  };

  // Phase 1: analyze the objective
  await wait(1);

  // Phase 2: plan tool usage
  state.phase = 'planning-tools';
  state.observations.push('Determining required tools for this task...');
  await wait(1);

  // Phase 3: execute tools (simulated — a real agent would call actual tools)
  state.phase = 'executing-tools';
  const objective = request.work.objective.toLowerCase();

  if (objective.includes('read') || objective.includes('file') || objective.includes('analyze')) {
    state.toolCalls.push({
      tool: 'read_file',
      args: { path: '/workspace/example.txt' },
      result: 'File contents: example data for analysis',
    });
    state.observations.push('Read workspace file');
  }

  if (
    objective.includes('write') ||
    objective.includes('create') ||
    objective.includes('generate') ||
    objective.includes('extract')
  ) {
    state.toolCalls.push({
      tool: 'write_file',
      args: { path: '/workspace/output.txt', content: 'Generated result' },
      result: 'File written successfully',
    });
    state.observations.push('Created output file');
  }

  if (objective.includes('search') || objective.includes('find')) {
    state.toolCalls.push({
      tool: 'search',
      args: { query: 'relevant information' },
      result: 'Found 3 relevant results',
    });
    state.observations.push('Performed search');
  }

  await wait(1);

  // Phase 4: synthesize results
  state.phase = 'synthesizing';
  state.observations.push('Synthesizing findings...');
  await wait(1);

  // Phase 5: generate the report
  state.phase = 'reporting';
  state.observations.push('Preparing final report...');

  return state;
};

/**
 * Project agent internal state onto ExecutorProviderOutcome.
 *
 * This is the BOUNDARY where agent work becomes CompanyOS-visible. The outcome is
 * honest (it reflects work actually done), bounded (it claims no authority over
 * CompanyOS truth) and contract-shaped. It is NOT settlement — CompanyOS
 * settlement owns that.
 */
const buildOutcome = (
  state: AgentInternalState,
  startedAt: string,
  finishedAt: string,
  sessionId: string,
): ExecutorProviderOutcome => {
  // The content the simulated run produced (the write_file tool call's payload), if any.
  const writtenContent =
    state.toolCalls.find((call) => call.tool === 'write_file' && typeof call.args['content'] === 'string')
      ?.args['content'] ?? null;
  const report = [
    `Agent execution completed.`,
    ``,
    `Objective analyzed and processed.`,
    ``,
    `Tool calls: ${state.toolCalls.length}`,
    ...state.toolCalls.map((call) => `  - ${call.tool}(${JSON.stringify(call.args)}) → ${call.result}`),
    ``,
    `Observations:`,
    ...state.observations.map((obs) => `  - ${obs}`),
    ``,
    `Final phase: ${state.phase}`,
  ].join('\n');

  // Structured payload — CANDIDATES for CompanyOS Artifact/Evidence, never canonical.
  const structured = {
    agentReport: {
      toolCalls: state.toolCalls.length,
      observations: state.observations.length,
      finalPhase: state.phase,
    },
    // CompanyOS decides whether/how to canonicalize these.
    artifactCandidates: state.toolCalls
      .filter((call) => call.tool === 'write_file')
      .map((call) => ({
        path: String(call.args['path']),
        description: 'Agent-generated file',
      })),
    // The FROZEN declaration convention (same as the generic executor): when the
    // simulated run produced output content, return it as `artifactContent` — the
    // dispatch materializes it through the ONE Sprint-13 artifact service and only
    // the canonical reference settles. A real agent returns its produced content the
    // same way; it never inserts an artifact row itself.
    ...(writtenContent === null ? {} : { artifactContent: writtenContent }),
  };

  return {
    kind: 'succeeded',
    exitCode: 0,
    stdoutText: report,
    structured,
    startedAt,
    finishedAt,
    // A real agent would report its own durable provider session here.
    providerSessionId: sessionId,
  };
};

/**
 * Create a mock agent executor provider.
 *
 * This provider implements ExecutorProvider ONLY. It simulates agent
 * reasoning/tool/result, returns ExecutorProviderOutcome, creates no new Truth,
 * modifies no CompanyOS state, and judges no Task success.
 *
 * Real agents (DSH, Codex, ZCode) follow the same pattern: implement
 * ExecutorProvider, receive Task/WorkPackage, do their internal work, return an
 * ExecutorProviderOutcome, and let CompanyOS settle canonically.
 */
export const createMockAgentExecutorProvider = (config: MockAgentExecutorConfig): ExecutorProvider => {
  const timer: MockAgentTimer = config.timer ?? IMMEDIATE_TIMER;
  const clock = config.clock ?? (() => MOCK_EPOCH);

  const descriptor: ExecutorProviderDescriptor = {
    providerKey: config.providerKey,
    capabilities: [
      'cancellation',
      'timeout',
      'structured-output',
      'working-directory',
      'external-session-identity',
      // Agentic providers typically do NOT support:
      // - provider-idempotency (reasoning is non-deterministic)
      // - same-invocation-recovery (internal state is opaque)
      // - status-query (internal progress is opaque)
      //
      // Declaring this honestly is the point: agentic capability differs from
      // deterministic capability, and a provider may never claim what it lacks.
    ],
  };

  const sessionIdFor = (request: ExecutorExecutionRequest): string =>
    `mock-agent-session-${sha256Hex(
      canonicalJson({
        providerKey: config.providerKey,
        dispatchKey: request.dispatchKey,
        attemptId: request.attemptId,
      }),
    ).slice(0, 16)}`;

  return {
    descriptor,
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      const startedAt = clock();
      const sessionId = sessionIdFor(request);

      // --- the run's stop conditions -------------------------------------------
      // Two DISTINCT external facts, exactly as the contract separates them:
      // the caller's deadline (`request.timeoutMs`) and the caller's cancellation
      // (`request.signal`). Whichever arrives first stops the simulated work.
      const run: { stoppedBy: AgentStopReason | null } = { stoppedBy: null };
      const waiters = new Set<(reason: AgentStopReason) => void>();

      const stop = (reason: AgentStopReason): void => {
        if (run.stoppedBy !== null) return;
        run.stoppedBy = reason;
        for (const notify of [...waiters]) notify(reason);
        waiters.clear();
      };

      /** Wait `ms`, settling early when the run is stopped. */
      const wait = (ms: number): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          if (run.stoppedBy !== null) {
            reject(new Error(run.stoppedBy));
            return;
          }
          let settled = false;
          let cancelTimer: () => void = () => undefined;
          const settle = (reason: AgentStopReason | null): void => {
            if (settled) return;
            settled = true;
            waiters.delete(notify);
            cancelTimer();
            if (reason === null) resolve();
            else reject(new Error(reason));
          };
          const notify = (reason: AgentStopReason): void => settle(reason);
          waiters.add(notify);
          cancelTimer = timer(ms, () => settle(null));
          // A stop may have landed between the check above and registration.
          if (run.stoppedBy !== null) settle(run.stoppedBy);
        });

      const onAbort = (): void => stop('cancelled');
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted === true) stop('cancelled');

      const cancelDeadline =
        request.timeoutMs === undefined ? undefined : timer(request.timeoutMs, () => stop('deadline'));

      const settleStop = (): ExecutorProviderOutcome => {
        if (run.stoppedBy === 'cancelled') {
          return { kind: 'cancelled', terminationProven: true, providerSessionId: sessionId };
        }
        // `terminationProven` is true because the simulated work runs in-process:
        // stopping it here genuinely proves it stopped. A real external agent must
        // prove termination from its own exit evidence instead.
        return { kind: 'timeout', terminationProven: true, providerSessionId: sessionId };
      };

      try {
        // Simulated failure — deterministic per attempt, never random.
        const failureRate = config.simulateFailureRate;
        if (failureRate !== undefined && failureRate > 0) {
          const fails =
            failureRate >= 1 ||
            deterministicUnit(`${config.providerKey}:${request.dispatchKey}`) < failureRate;
          if (fails) {
            return {
              kind: 'provider-failed',
              exitCode: 1,
              stdoutText: 'Agent encountered an internal error during reasoning.',
              stderrText: 'Simulated agent failure',
              providerSessionId: sessionId,
            };
          }
        }

        // Simulated slow work: a long objective takes this much longer.
        if (config.simulateTimeoutMs !== undefined) await wait(config.simulateTimeoutMs);

        const state = await simulateAgentReasoning(request, wait);
        return buildOutcome(state, startedAt, clock(), sessionId);
      } catch (error) {
        if (error instanceof Error && (error.message === 'cancelled' || error.message === 'deadline')) {
          return settleStop();
        }
        // A real agent might surface transport or auth failures here.
        return {
          kind: 'transport-failed',
          reasonCode: 'MOCK_AGENT_INTERNAL_ERROR',
          detail: error instanceof Error ? error.message : String(error),
          providerSessionId: sessionId,
        };
      } finally {
        cancelDeadline?.();
        request.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
};

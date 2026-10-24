/**
 * SHARED F5 FIXTURE — the real production composition over a fresh durable store,
 * with a scriptable model provider and a deterministic software executor. Used by the
 * F5 inflight-settlement suite and the F5-D terminal-arbitration suite.
 *
 * Callers register their own afterEach cleanup over the exported lifecycle arrays:
 *   afterEach(() => { while (openDatabases.length) openDatabases.pop()?.close();
 *                    while (createdDirs.length) rmSync(createdDirs.pop() as string, {recursive:true, force:true}); });
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FAULT_CHECKPOINTS, domainError, ok, type DomainError, type FaultCheckpointPort, type InvocationRequest, type InvocationResult, type ModelProviderPort, type RawModelInfo, type Result } from '@companyos/core';
import { resolveExecutorConfig, type ExecutorExecutionRequest, type ExecutorProvider, type ExecutorProviderOutcome } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import type { GoalSafetyConfiguration } from '../../../apps/desktop/src/execution-safety-coordinator.js';
import { composeCoreServices } from '../../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND, SOFTWARE_WORK_KIND } from '../../../apps/desktop/src/control-plane.js';
export const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
export const COMPANY = 'company_default';
export const MODEL_KEY = 'f5.planner';

export type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

export const createdDirs: string[] = [];
export const openDatabases: DurableDatabase[] = [];
export const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
};

export type SupervisorMode = 'legal' | 'hang' | 'late' | 'bogus' | 'raw:hang' | 'raw:failFast' | 'raw:failLate' | 'raw:ok';

export interface F5Fixture {
  readonly core: Core;
  readonly workspace: string;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly mode: { value: SupervisorMode; delayMs: number };
  /** Every SUPERVISOR-branch provider invocation (the external model call). */
  readonly supervisorInvocations: { at: number }[];
  /**
   * F5-C arming hook: fires INSIDE the supervisor provider call, i.e. immediately
   * BEFORE the turn validates and records its Decision — the only window in which a
   * `sinkDelay` armed here can only hit the sink's own transaction.
   */
  readonly hooks: { onSupervisorCall?: () => void };
  /**
   * F5-B throw injection (asymmetric once-flags, consumed by the FIRST call after being
   * armed — arm them from `hooks.onSupervisorCall` so they land in the sink/settlement):
   *   `throwOnRunsGetOnce`      — the next `runs.get` throws (the sink's first read);
   *   `throwOnExecutionWriteOnce` — the next AgentExecution conditional write throws.
   */
  readonly faults: {
    throwOnRunsGetOnce: boolean;
    throwOnExecutionWriteOnce: boolean;
    /** POST-CODEX R1: consume one THROW per AgentExecution conditional write while > 0. */
    executionWriteFaults: number;
    /** POST-CODEX 9dc9943: the NEXT Decision CREATE call throws while > 0 (C2 tests). */
    decisionCreateFaults: number;
    /** POST-CODEX 6ec4d81: the NEXT event append throws while > 0 (N6-A1 tests). */
    throwOnEventAppendOnce: boolean;
    /** POST-CODEX 6ec4d81 re-audit: the NEXT CLAIM insert (createIfAbsent) throws once. */
    throwOnClaimWriteOnce: boolean;
    /**
     * 4a6e362 (N4-A1): when the NEXT claim INSERT CONFLICTS, hold its still-open
     * transaction for this many ms — the exact Codex loser-rollback window.
     */
    holdClaimOnConflictMs: number;
    /** 4a6e362 (N4-M1): the structured code the NEXT runs.get fault carries. */
    runsGetFaultCode: string;
    /** 4a6e362 (N4-A1): the NEXT event append carrying this event type throws once. */
    throwOnEventTypeOnce: string | null;
  };
  /**
   * POST-CODEX R1 — the between-read-and-persist GATE: pause the NEXT conditional
   * ExecutionWrite of the named class BEFORE its SQL, so a test can interleave a
   * cancellation / recovery / restart in exactly that window, then release it.
   */
  readonly executionGate: {
    armed: 'start' | 'settle' | 'claim' | null;
    readonly paused: boolean;
    release(): void;
  };
  /** Every provider invocation (any mode), for provider-call-count assertions. */
  readonly rawInvocations: { n: number };
  /** F5-C commit-window probe (see composeF5). Zero delays = pure pass-through. */
  readonly sinkDelay: {
    /** Delay BEFORE `BEGIN` — the sink is slow to obtain its write window. */
    txMs: number;
    /** Delay AFTER the commit completes, before the caller resumes. */
    tailMs: number;
    /** Wrapped transaction calls entered. */
    txCount: number;
    /** Wrapped transactions whose commit/rollback has completed. */
    txCompleted: number;
    /** Wrapped transaction calls currently in flight (including their tails). */
    inFlight: number;
    /** Resolves once every wrapped transaction call (including tails) has finished. */
    idle(): Promise<void>;
  };
}

export const composeF5 = async (options?: {
  readonly executionSafety?: GoalSafetyConfiguration;
  readonly planItems?: readonly unknown[];
  readonly acceptanceCriteria?: readonly unknown[];
  readonly execute?: (request: ExecutorExecutionRequest, workspace: string) => Promise<ExecutorProviderOutcome>;
  readonly supervisorTimeoutMs?: number;
  readonly maxSupervisorTurns?: number;
}): Promise<F5Fixture> => {
  const dataDir = tempDir('f5-db-');
  const workspace = tempDir('f5-ws-');
  const casRoot = `${dataDir}-cas`;

  const mode: { value: SupervisorMode; delayMs: number } = { value: 'legal', delayMs: 0 };
  const supervisorInvocations: { at: number }[] = [];
  const rawInvocations = { n: 0 };
  const hooks: { onSupervisorCall?: () => void } = {};
  let structured: unknown;

  /** The legal policy: corrective on a standing FAIL, COMPLETE when proven (the F1 shape). */
  const supervisorPolicy = (text: string) => {
    if (text.includes('LATEST_VALIDATION_FAILED')) {
      return { action: 'REQUEST_CORRECTIVE' as const };
    }
    if (/val_[0-9A-Za-z]+/.test(text) && text.includes('"DONE"')) {
      return { action: 'COMPLETE' as const };
    }
    return { action: 'CONTINUE' as const };
  };

  const planItems = [
    {
      planItemId: 'fix-multiply',
      objective: 'Fix the multiply function in the workspace project so multiply(4, 3) returns 12, run the project test contract, and deliver the result.',
      dependencyPlanItemIds: [],
      acceptanceCriterionRefs: ['c1'],
      taskKind: SOFTWARE_WORK_KIND,
    },
  ];

  const stub: ModelProviderPort = {
    describe: () => ({ providerId: 'prov_f5', kind: 'fake', displayName: 'f5', version: '1' }),
    listModels: () =>
      Promise.resolve(
        ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 32768, capabilities: { streaming: false, structuredOutput: true } } as RawModelInfo]),
      ),
    health: () => Promise.resolve(ok(undefined as never)),
    invoke(request: InvocationRequest) {
      rawInvocations.n += 1;
      // F5-D arbitration modes: a RAW provider outcome independent of the request
      // schema, so terminal-race regressions can drive exact settlement directions.
      if (mode.value === 'raw:hang') {
        return new Promise<Result<InvocationResult, DomainError>>(() => undefined);
      }
      if (mode.value === 'raw:failFast') {
        return Promise.reject(domainError('AGENT_UNAVAILABLE', 'raw failure', { kind: 'PROVIDER_UNAVAILABLE' }));
      }
      if (mode.value === 'raw:failLate') {
        const delay = mode.delayMs;
        return new Promise<Result<InvocationResult, DomainError>>((_resolve, reject) => {
          setTimeout(() => {
            reject(domainError('AGENT_UNAVAILABLE', 'late failure', { kind: 'PROVIDER_UNAVAILABLE' }));
          }, delay);
        });
      }
      if (mode.value === 'raw:ok') {
        return Promise.resolve(ok({ modelId: request.modelId, providerId: 'prov_f5', outputText: 'raw ok', structured: null, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const }));
      }
      const properties = (request.responseFormat?.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      if (!('action' in properties) && !('verdict' in properties)) {
        return Promise.resolve(
          ok({
            modelId: request.modelId,
            providerId: 'prov_f5',
            outputText: 'x',
            structured: {
              schema: 'companyos/plan-proposal/1',
              planItems: options?.planItems ?? planItems,
              acceptanceCriteria: options?.acceptanceCriteria ?? [{ criterionId: 'c1', requirement: 'multiply(4, 3) returns 12 and the project test contract passes.' }],
            } as never,
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
            finishReason: 'stop' as const,
          }),
        );
      }
      if ('verdict' in properties) {
        return Promise.resolve(
          ok({
            modelId: request.modelId,
            providerId: 'prov_f5',
            outputText: 'x',
            structured:
              'targetRef' in properties
                ? ({ schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal' } as never)
                : ({ schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', findings: [], summary: 'ok' } as never),
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
            finishReason: 'stop' as const,
          }),
        );
      }
      // The SUPERVISOR branch — the external call F5 bounds.
      supervisorInvocations.push({ at: Date.now() });
      hooks.onSupervisorCall?.();
      const contextText = JSON.stringify(request.messages);
      if (mode.value === 'hang') {
        // Never settles, ignores the caller signal entirely.
        return new Promise<Result<InvocationResult, DomainError>>(() => undefined);
      }
      if (mode.value === 'late') {
        // Ignores the caller signal and resolves the POLICY proposal after an arbitrary
        // wall-clock delay (a slow-but-honest provider, not a malformed one).
        const delay = mode.delayMs;
        return new Promise<Result<InvocationResult, DomainError>>((resolve) => {
          setTimeout(() => {
            const proposal = supervisorPolicy(contextText);
            const structuredProposal =
              proposal.action === 'REQUEST_CORRECTIVE'
                ? {
                    schema: 'companyos/supervisor-proposal/1',
                    action: 'REQUEST_CORRECTIVE',
                    reasonCode: 'VALIDATION_FAILED',
                    summary: 'The software validation failed; corrective work is required.',
                    evidenceRefs: [],
                    subject: null,
                  }
                : proposal.action === 'COMPLETE'
                  ? {
                      schema: 'companyos/supervisor-proposal/1',
                      action: 'COMPLETE',
                      reasonCode: 'GOAL_SATISFIED',
                      summary: 'The corrected behavior is proven and validated.',
                      evidenceRefs: (contextText.match(/val_[0-9A-Za-z]+/) ?? []).slice(0, 1),
                      subject: null,
                    }
                  : {
                      schema: 'companyos/supervisor-proposal/1',
                      action: 'CONTINUE',
                      reasonCode: 'GOAL_SATISFIED',
                      summary: 'late but valid',
                      evidenceRefs: [],
                      subject: null,
                    };
            resolve(
              ok({
                modelId: request.modelId,
                providerId: 'prov_f5',
                outputText: 'x',
                structured: structuredProposal as never,
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
                finishReason: 'stop' as const,
              }),
            );
          }, delay);
        });
      }
      if (mode.value === 'bogus' && contextText.includes('LATEST_VALIDATION_FAILED')) {
        // THE INCIDENT: a corrective proposal the authority must refuse — it cites an
        // evidence artifact that does not exist in durable truth. validateProposal passes
        // (the turn appends the actionable validation id); the Decision sink refuses the
        // unresolvable citation.
        structured = {
          schema: 'companyos/supervisor-proposal/1',
          action: 'REQUEST_CORRECTIVE',
          reasonCode: 'VALIDATION_FAILED',
          summary: 'The software validation failed; corrective work is required.',
          evidenceRefs: ['art_01F5HALLUCINATEDREF000000000000'],
          subject: null,
        } as never;
      } else {
        const proposal = supervisorPolicy(contextText);
        structured =
          proposal.action === 'REQUEST_CORRECTIVE'
            ? ({
                schema: 'companyos/supervisor-proposal/1',
                action: 'REQUEST_CORRECTIVE',
                reasonCode: 'VALIDATION_FAILED',
                summary: 'The software validation failed; corrective work is required.',
                evidenceRefs: [],
                subject: null,
              } as never)
            : proposal.action === 'COMPLETE'
              ? ({
                  schema: 'companyos/supervisor-proposal/1',
                  action: 'COMPLETE',
                  reasonCode: 'GOAL_SATISFIED',
                  summary: 'The corrected behavior is proven and validated.',
                  evidenceRefs: (contextText.match(/val_[0-9A-Za-z]+/) ?? []).slice(0, 1),
                  subject: null,
                } as never)
              : ({
                  schema: 'companyos/supervisor-proposal/1',
                  action: 'CONTINUE',
                  reasonCode: 'GOAL_SATISFIED',
                  summary: 'next',
                  evidenceRefs: [],
                  subject: null,
                } as never);
      }
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: 'prov_f5',
          outputText: 'x',
          structured: structured as never,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
          finishReason: 'stop' as const,
        }),
      );
    },
    stream(): AsyncIterable<Result<never, DomainError>> {
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
    },
  };
  const provider: ExecutorProvider = {
    ...(options?.execute === undefined ? {} : { supportsCallAdmission: true }),
    descriptor: { providerKey: 'f5-executor', capabilities: ['timeout', 'structured-output', 'environment-inputs', 'provider-idempotency'] },
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      if (options?.execute !== undefined) return options.execute(request, workspace);
      const root = request.workspace?.root ?? '';
      const now = '2026-10-07T00:00:00.000Z';
      if (!existsSync(join(root, 'package.json'))) {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }),
        );
        mkdirSync(join(root, 'src'), { recursive: true });
        mkdirSync(join(root, 'tests'), { recursive: true });
        writeFileSync(join(root, 'src', 'math.ts'), 'export function multiply(a: number, b: number): number {\n  return a - b;\n}\n');
        writeFileSync(
          join(root, 'tests', 'math.test.ts'),
          "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { multiply } from '../src/math.ts';\ntest('multiply', () => { assert.equal(multiply(4, 3), 12); });\n",
        );
        return { kind: 'succeeded', exitCode: 0, stdoutText: 'v1', structured: { status: 'succeeded', artifactContent: 'implemented (defective).' }, startedAt: now, finishedAt: now };
      }
      if (request.work.taskInputs !== undefined && (request.work.taskInputs as Record<string, unknown>)['corrective'] !== undefined) {
        writeFileSync(join(root, 'src', 'math.ts'), 'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n');
        return { kind: 'succeeded', exitCode: 0, stdoutText: 'corrected', structured: { status: 'succeeded', artifactContent: 'corrected multiply.' }, startedAt: now, finishedAt: now };
      }
      return { kind: 'succeeded', exitCode: 0, stdoutText: 'ok', structured: { status: 'succeeded', artifactContent: 'verified.' }, startedAt: now, finishedAt: now };
    },
  };
  const executorConfig = resolveExecutorConfig({
    providerKey: 'f5-executor',
    schema: { profile: { name: 'profile', kind: 'string', required: false, defaultValue: 'f5' } },
    envNames: {},
  });
  if (!executorConfig.ok) throw new Error(executorConfig.error.message);

  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  /*
   * F5-C → 4a6e362 — THE COMMIT-WINDOW PROBE, re-pointed at the SINK'S OWN transaction.
   * `db.unitOfWork.transaction` is shared by every writer on the connection, so a generic
   * wrapper can no longer mean "the sink is slow" (the runtime's own durable units would
   * be inflated too). The sink now emits two INSIDE-TRANSACTION checkpoints and the probe
   * delays exactly those:
   *   txMs   — the sink's write window has begun (its transaction is open) but its writes
   *            have not executed when the turn's deadline fires;
   *   tailMs — every write of the sink's transaction landed; the commit has not.
   * Zero delays make the checkpoint a strict pass-through (existing suites unaffected).
   */
  const sinkDelay = {
    txMs: 0,
    tailMs: 0,
    txCount: 0,
    txCompleted: 0,
    inFlight: 0,
    async idle(): Promise<void> {
      while (this.inFlight > 0) {
        await new Promise<void>((resolve) => sinkDelayWaiters.push(resolve));
      }
    },
  };
  const sinkDelayWaiters: (() => void)[] = [];
  const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /*
   * F5-B — THROW INJECTION at two production store seams (see F5Fixture.faults): the
   * sink's first read (`runs.get`, outside any transaction) and the settlement chain's
   * conditional AgentExecution write. Both are plain once-flags consumed by the first
   * call after arming.
   */
  const faults = { throwOnRunsGetOnce: false, throwOnExecutionWriteOnce: false, executionWriteFaults: 0, decisionCreateFaults: 0, throwOnEventAppendOnce: false, throwOnClaimWriteOnce: false, holdClaimOnConflictMs: 0, throwOnEventTypeOnce: null as string | null, runsGetFaultCode: 'SQLITE_BUSY' };
  /*
   * POST-CODEX R1 — the deterministic between-read-and-persist gate: armed for the
   * next `start` (conditional creation/progress) or `settle` (terminal transition)
   * write; the write pauses BEFORE its SQL until `release()`.
   */
  const executionGate = {
    armed: null as 'start' | 'settle' | null,
    paused: false,
    waiters: [] as (() => void)[],
    release(): void {
      this.paused = false;
      for (const waiter of this.waiters.splice(0)) waiter();
    },
  };
  const gateOf = async (kind: 'start' | 'settle' | 'claim'): Promise<void> => {
    if (executionGate.armed !== kind) return;
    executionGate.armed = null;
    executionGate.paused = true;
    await new Promise<void>((resolve) => executionGate.waiters.push(resolve));
  };
  /**
   * 6ec4d81 re-audit — the gate rides the runtime's own WRITE-CLASS checkpoints, emitted
   * immediately BEFORE the serialized write: a paused contender holds NO transaction and
   * NO connection write order, so the interleaved turn (or the release path) proceeds
   * exactly as production would.
   */
  const gateCheckpoints: FaultCheckpointPort = {
    async checkpoint(name: string): Promise<void> {
      // 4a6e362 — the SINK's own commit: the two windows around its transaction carry the
      // F5-C sinkDelay shapes (and ONLY they may: every other transaction stays untouched).
      if (name === FAULT_CHECKPOINTS.decisionCommitBeforeTransaction) {
        sinkDelay.txCount += 1;
        sinkDelay.inFlight += 1;
        if (sinkDelay.txMs > 0) await sleepMs(sinkDelay.txMs);
        return;
      }
      if (name === FAULT_CHECKPOINTS.decisionCommitAfterTransaction) {
        try {
          if (sinkDelay.tailMs > 0) await sleepMs(sinkDelay.tailMs);
        } finally {
          sinkDelay.txCompleted += 1;
          sinkDelay.inFlight -= 1;
          if (sinkDelay.inFlight === 0) {
            for (const waiter of sinkDelayWaiters.splice(0)) waiter();
          }
        }
        return;
      }
      const kind =
        name === FAULT_CHECKPOINTS.agentExecutionClaimBeforeWrite
          ? ('claim' as const)
          : name === FAULT_CHECKPOINTS.agentExecutionStartBeforeWrite
            ? ('start' as const)
            : name === FAULT_CHECKPOINTS.agentExecutionSettleBeforeWrite
              ? ('settle' as const)
              : null;
      if (kind !== null) await gateOf(kind);
    },
  };
  const faultOf = (): void => {
    if (faults.throwOnExecutionWriteOnce) {
      faults.throwOnExecutionWriteOnce = false;
      throw new Error('injected execution write failure');
    }
    if (faults.executionWriteFaults > 0) {
      faults.executionWriteFaults -= 1;
      throw new Error('injected execution write failure');
    }
  };
  const runsGet = db.runs.get.bind(db.runs);
  (db.runs as unknown as { get: (id: unknown) => Promise<unknown> }).get = async (id: unknown) => {
    if (faults.throwOnRunsGetOnce) {
      faults.throwOnRunsGetOnce = false;
      throw Object.assign(new Error('injected runs.get failure'), { code: faults.runsGetFaultCode });
    }
    return runsGet(id as never);
  };
  const executionWrite = (
    db.agentExecutions as unknown as {
      putIfStatus: (entity: never, expected: never) => Promise<boolean>;
    }
  ).putIfStatus.bind(db.agentExecutions);
  (db.agentExecutions as unknown as { putIfStatus: (entity: never, expected: never) => Promise<boolean> }).putIfStatus =
    async (entity: never, expected: never) => {
      faultOf();
      return executionWrite(entity, expected);
    };
  const decisionCreate = (
    db.decisions as unknown as {
      create: (record: never) => Promise<void>;
    }
  ).create.bind(db.decisions);
  (db.decisions as unknown as { create: (record: never) => Promise<void> }).create = async (record: never) => {
    if (faults.decisionCreateFaults > 0) {
      faults.decisionCreateFaults -= 1;
      throw new Error('injected decision create failure');
    }
    return decisionCreate(record);
  };
  const eventsAppend = db.events.append.bind(db.events);
  (db.events as unknown as { append: (events: never) => Promise<unknown> }).append = async (events: never) => {
    if (faults.throwOnEventAppendOnce) {
      faults.throwOnEventAppendOnce = false;
      throw new Error('injected event append failure');
    }
    if (faults.throwOnEventTypeOnce !== null) {
      const appended = Array.isArray(events) ? (events as readonly unknown[]) : [events as unknown];
      const hit = appended.some(
        (event) => String((event as { type?: unknown }).type ?? '') === faults.throwOnEventTypeOnce,
      );
      if (hit) {
        faults.throwOnEventTypeOnce = null;
        throw new Error('injected event append failure');
      }
    }
    return eventsAppend(events);
  };
  const claimWrite = (
    db.agentExecutions as unknown as {
      createIfAbsent: (entity: never) => Promise<boolean>;
    }
  ).createIfAbsent.bind(db.agentExecutions);
  (db.agentExecutions as unknown as { createIfAbsent: (entity: never) => Promise<boolean> }).createIfAbsent =
    async (entity: never) => {
      if (faults.throwOnClaimWriteOnce) {
        faults.throwOnClaimWriteOnce = false;
        throw new Error('injected claim write failure');
      }
      const created = await claimWrite(entity);
      if (!created && faults.holdClaimOnConflictMs > 0) {
        // The Codex N4-A1 window: the LOSING claim keeps its open transaction while the
        // winner finishes its turn — a stray direct write would be swallowed by the
        // rollback that follows.
        const holdMs = faults.holdClaimOnConflictMs;
        faults.holdClaimOnConflictMs = 0;
        await sleepMs(holdMs);
      }
      return created;
    };
  const executionStartWrite = (
    db.agentExecutions as unknown as {
      startIfPreTerminal: (entity: never) => Promise<boolean>;
    }
  ).startIfPreTerminal.bind(db.agentExecutions);
  (db.agentExecutions as unknown as { startIfPreTerminal: (entity: never) => Promise<boolean> }).startIfPreTerminal =
    async (entity: never) => {
      return executionStartWrite(entity);
    };
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    ...(options?.executionSafety === undefined ? {} : { executionSafety: options.executionSafety }),
    artifactFoundation: foundation as never,
    faultCheckpoints: gateCheckpoints,
    stageHandlers: { executorKinds: ['companyos:planning', GOAL_WORK_KIND, SOFTWARE_WORK_KIND] },
    goalWorkProfile: {
      stageKind: 'work',
      taskKind: GOAL_WORK_KIND,
      maxAttempts: 3,
      operationKinds: [SOFTWARE_WORK_KIND],
      validatorIds: ['evidence.grounding-check'],
      validatorIdsByTaskKind: { [SOFTWARE_WORK_KIND]: ['repo.test-check', 'evidence.grounding-check'] },
    },
    providerKinds: [GOAL_WORK_KIND, SOFTWARE_WORK_KIND],
    providerRoutes: { [GOAL_WORK_KIND]: 'f5-executor', [SOFTWARE_WORK_KIND]: 'f5-executor' },
    repositoryRuntime: { repositoryCapableKinds: [GOAL_WORK_KIND, SOFTWARE_WORK_KIND] },
    ...(options?.execute === undefined ? {} : { embeddedDshModelRoute: { providerId: 'prov_f5', modelId: 'p1', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'OFFLINE_UNUSED', maxTokens: 16000 } }),
    executorProviderImplementations: [{ provider, config: executorConfig.value }],
    ...(options?.supervisorTimeoutMs === undefined
      ? {}
      : {
          supervisorBounds: {
            timeoutMs: options.supervisorTimeoutMs,
            ...(options.maxSupervisorTurns === undefined ? {} : { maxSupervisorTurns: options.maxSupervisorTurns }),
          },
        }),
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({ root: workspace, commandProfile: {} });
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  const registered = await core.providers.register(stub, { actorId: actor });
  if (!registered.ok) throw new Error(registered.error.message);
  const models = await core.models.registerFromProvider({ providerId: 'prov_f5', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  if (!models.ok) throw new Error(models.error.message);
  const policy = await core.policies.savePolicy({ id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor } as never);
  if (!policy.ok) throw new Error(policy.error.message);
  return { core, workspace, dataDir, casRoot, mode, supervisorInvocations, hooks, sinkDelay, faults, executionGate, rawInvocations };
};


/**
 * F5-06 / S9B-A — a FRESH composition over the SAME durable storage (the production
 * reboot path): a new database connection + the same composition options.
 */
export const recomposeF5Over = async (f: F5Fixture, executionSafety?: GoalSafetyConfiguration): Promise<Core> => {
  const reopened = openDurableDatabase({ dataDir: f.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(reopened);
  const foundation = await openArtifactFoundation({ casRoot: f.casRoot, database: reopened, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(reopened, nullLogger as never, {
    ...(executionSafety === undefined ? {} : { executionSafety }),
    artifactFoundation: foundation as never,
    stageHandlers: { executorKinds: ['companyos:planning', GOAL_WORK_KIND, SOFTWARE_WORK_KIND] },
    goalWorkProfile: {
      stageKind: 'work',
      taskKind: GOAL_WORK_KIND,
      maxAttempts: 3,
      operationKinds: [SOFTWARE_WORK_KIND],
      validatorIds: ['evidence.grounding-check'],
      validatorIdsByTaskKind: { [SOFTWARE_WORK_KIND]: ['repo.test-check', 'evidence.grounding-check'] },
    },
    providerKinds: [GOAL_WORK_KIND, SOFTWARE_WORK_KIND],
    providerRoutes: { [GOAL_WORK_KIND]: 'f5-executor', [SOFTWARE_WORK_KIND]: 'f5-executor' },
    repositoryRuntime: { repositoryCapableKinds: [GOAL_WORK_KIND, SOFTWARE_WORK_KIND] },
  } as never);
  if (core === null) throw new Error('recomposition failed');
  return core;
};

/**
 * Pinned agent execution (Sprint 18 / Task-18-07) — the ONLY production path by which an
 * autonomous work/review/QA execution invokes a model.
 *
 * `GENERIC_AGENT_PINNED_MODEL_CONSUMER` existed because `AgentRuntime.prepare/run` accept a
 * caller-supplied `modelKey`, so any caller could name any registered model. This wrapper
 * removes that possibility by construction on the autonomous path: the model is resolved from
 * the run's OWN pinned snapshot, through a trusted binding NAME, and the method exposes no
 * model identity parameter at all. There is nothing for a caller to override.
 *
 *   RunSnapshot.modelBindings[bindingKey] → ModelRegistry record → AgentRuntime
 *
 * A missing, unknown, disabled or unavailable binding fails closed with ZERO provider calls.
 * There is no alternate provider, no alternate model and no fallback binding (§21).
 */
import {
  UNPINNABLE_AVAILABILITY,
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from '@companyos/core';

import type { AgentRuntimeService } from '../runtime/agent-runtime.js';
import type { AgentRunOutcome } from '../runtime/agent-runtime.js';
import type {
  RunModelBindingReader,
  RunModelBindingResolver,
} from '../lifecycle/run-model-bindings.js';

export interface PinnedAgentExecutionDeps {
  readonly runs: {
    get(runId: string): Promise<{
      readonly id: string;
      readonly companyId: string;
      readonly snapshotId: string;
    } | null>;
  };
  readonly modelBindings: RunModelBindingReader;
  readonly modelRegistry: RunModelBindingResolver;
  readonly agentRuntime: AgentRuntimeService;
  /** Trusted configuration: the binding NAME an autonomous execution resolves. */
  readonly bindingKey: string;
  readonly clock: { nowIso: () => string };
}

/** Everything a pinned round needs — and NOTHING that names a model. */
export interface PinnedRoundInput {
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly roleId: string;
  readonly actorId: string;
  readonly context: Parameters<AgentRuntimeService['run']>[0]['context'];
  readonly prompt?: Parameters<AgentRuntimeService['run']>[0]['prompt'];
  readonly traceId?: string;
  readonly signal?: AbortSignal;
  /** The structured output this round is expected to produce (the carrier's payload). */
  readonly intent?: 'review' | 'qa';
}

export interface PinnedAgentExecution {
  /** The public surface: note the ABSENCE of any model identity parameter. */
  runRound(
    input: PinnedRoundInput,
  ): Promise<
    Result<{ readonly executionId: string; readonly outcome: AgentRunOutcome }, DomainError>
  >;
  /**
   * Task-19-03 closeout: the RESIDUE-FIRST round. The caller's trusted callback makes the
   * bounded session residue durable BETWEEN the provider result and the terminal settlement
   * (Shape B), so a durably terminal-successful execution can never lack its residue.
   */
  runRoundResidueFirst(
    input: PinnedRoundInput,
    persistResidue: (payload: {
      readonly executionId: string;
      readonly structured: unknown;
      readonly outputText: string;
      readonly usage: unknown;
    }) => Promise<Result<unknown, DomainError>>,
  ): Promise<
    Result<{ readonly executionId: string; readonly outcome: AgentRunOutcome }, DomainError>
  >;
  /** Read-only: which model this run's trusted binding resolves to (for diagnostics/tests). */
  resolveBinding(input: {
    readonly companyId: string;
    readonly runId: string;
  }): Promise<
    Result<
      { readonly modelKey: string; readonly providerId: string; readonly providerModelId: string },
      DomainError
    >
  >;
}

export function createPinnedAgentExecution(deps: PinnedAgentExecutionDeps): PinnedAgentExecution {
  const resolveBinding = async (input: {
    readonly companyId: string;
    readonly runId: string;
  }): Promise<
    Result<
      { readonly modelKey: string; readonly providerId: string; readonly providerModelId: string },
      DomainError
    >
  > => {
    const run = await deps.runs.get(input.runId);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.runId,
        }),
      );
    }
    const bound = await deps.modelBindings.resolve(
      { runId: run.id, companyId: input.companyId, bindingName: deps.bindingKey },
      deps.modelRegistry,
    );
    if (!bound.ok) return bound;
    if (
      bound.value.enabled !== true ||
      UNPINNABLE_AVAILABILITY.includes(bound.value.availability)
    ) {
      return err(
        domainError(
          'NOT_FOUND',
          `The pinned binding "${deps.bindingKey}" is not usable (${String(bound.value.availability)}).`,
          {
            reason: 'RUN_BINDING_UNUSABLE',
            bindingName: deps.bindingKey,
            modelKey: bound.value.modelKey,
            availability: bound.value.availability,
          },
        ),
      );
    }
    return ok({
      modelKey: bound.value.modelKey,
      providerId: bound.value.providerId,
      providerModelId: bound.value.providerModelId,
    });
  };

  return {
    resolveBinding,
    async runRound(input) {
      const bound = await resolveBinding({ companyId: input.companyId, runId: input.runId });
      if (!bound.ok) return bound;
      const prepared = await deps.agentRuntime.prepare({
        // The model comes from the run's pin. The caller of THIS method cannot supply one.
        modelKey: bound.value.modelKey,
        explicit: true,
        scopes: [],
        agentId: input.agentId,
        roleId: input.roleId as never,
        taskId: input.taskId as never,
        runId: input.runId as never,
        actorId: input.actorId,
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      });
      if (!prepared.ok) return prepared;
      const outcome = await deps.agentRuntime.runWithOutput({
        executionId: prepared.value.executionId,
        actorId: input.actorId,
        context: input.context,
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!outcome.ok) return outcome;
      /*
       * `runWithOutput` defers the settlement, so a caller of THIS wrapper never observes a
       * RUNNING execution: the round settles it here, through the AgentRuntime's ONE completion
       * path, with the usage the provider REPORTED (the same rule the supervisor turn follows).
       * The durable row then says COMPLETED, which is what the canonical carrier provably
       * requires before it routes a handler's output to a sink.
       */
      const settled = await deps.agentRuntime.completeExecution({
        executionId: prepared.value.executionId,
        actorId: input.actorId,
        usage: outcome.value.usage,
      });
      if (!settled.ok) return settled;
      return ok({ executionId: prepared.value.executionId, outcome: outcome.value });
    },

    /*
     * Task-19-03 closeout (DEVELOPER_SESSION_EXECUTION_RESIDUE_DURABILITY): the RESIDUE-FIRST
     * round. `runWithOutput` leaves the execution RUNNING; the CALLER's trusted callback makes
     * the bounded session residue durable; ONLY THEN does this wrapper settle the execution as
     * terminal-successful. The forbidden state (execution durably COMPLETED while the session
     * residue is missing and no durable copy of the provider output exists) is impossible by
     * construction: settlement happens strictly after the residue is durable. A crash in the
     * window leaves the residue durable AND the execution non-terminal (RUNNING), which the
     * existing crash-recovery semantics own — never a terminal success with lost work.
     */
    async runRoundResidueFirst(
    input: PinnedRoundInput,
    persistResidue: (payload: {
      readonly executionId: string;
      readonly structured: unknown;
      readonly outputText: string;
      readonly usage: unknown;
    }) => Promise<Result<unknown, DomainError>>,
  ): Promise<
    Result<
      { readonly executionId: string; readonly outcome: AgentRunOutcome },
      DomainError
    >
  > {
    const bound = await resolveBinding({ companyId: input.companyId, runId: input.runId });
    if (!bound.ok) return bound;
    const prepared = await deps.agentRuntime.prepare({
      // The model comes from the run's pin. The caller of THIS method cannot supply one.
      modelKey: bound.value.modelKey,
      explicit: true,
      scopes: [],
      agentId: input.agentId,
      roleId: input.roleId as never,
      taskId: input.taskId as never,
      runId: input.runId as never,
      actorId: input.actorId,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });
    if (!prepared.ok) return prepared;
    const outcome = await deps.agentRuntime.runWithOutput({
      executionId: prepared.value.executionId,
      actorId: input.actorId,
      context: input.context,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!outcome.ok) return outcome;
    const residue = await persistResidue({
      executionId: prepared.value.executionId,
      structured: outcome.value.structured,
      outputText: outcome.value.outputText,
      usage: outcome.value.usage,
    });
    if (!residue.ok) {
      // The residue never became durable: settle nothing. The execution stays RUNNING and
      // the existing AgentRuntime uncertainty semantics own it — no fabricated success.
      await deps.agentRuntime.cancel(prepared.value.executionId, input.actorId);
      return residue;
    }
    const settled = await deps.agentRuntime.completeExecution({
      executionId: prepared.value.executionId,
      actorId: input.actorId,
      usage: outcome.value.usage,
    });
    if (!settled.ok) return settled;
    return ok({ executionId: prepared.value.executionId, outcome: outcome.value });
    },
  };
}

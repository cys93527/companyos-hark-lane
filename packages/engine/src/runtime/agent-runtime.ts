/**
 * Agent Execution Runtime (Sprint 8).
 *
 * It does exactly this, in this order:
 *   Task + Role + EXPLICIT model binding -> AgentContext -> deterministic prompt ->
 *   ProviderRegistry.invoke -> InvocationResult -> AgentExecution -> result/artifacts.
 *
 * It does NOT choose a model. The `modelKey` must come from a MANUAL user choice, an upper
 * layer's explicit binding, or a future router result. With no `modelKey` the runtime refuses
 * with MODEL_SELECTION_REQUIRED - it never picks the first preferred model, never falls back,
 * never consults benchmark metadata and never looks at price or latency to decide.
 */
import {
  DomainError,
  FAULT_CHECKPOINTS,
  assemblePrompt,
  buildAgentContext,
  createExecution,
  defineEvent,
  describeTool,
  domainError,
  err,
  evaluateManualSelection,
  selectionRulesFromPolicy,
  executionErrorToDomainError,
  markCancelled,
  markCompleted,
  markFailed,
  markInterrupted,
  markReady,
  markRunning,
  needsRecovery,
  normalizeExecutionError,
  ok,
  POLICY_SCOPE_TYPES,
  redactSecrets,
  redactValue,
  toMessages,
  type AgentExecution,
  type AgentExecutionStatus,
  type BuildAgentContextInput,
  type Clock,
  type StructuredOutputContract,
  type EntityId,
  type EntityStore,
  type EventStorePort,
  type ExecutionError,
  type ExecutionErrorKind,
  type FaultCheckpointPort,
  type IdFactory,
  type InvocationResult,
  type Logger,
  type ModelBinding,
  type PolicyScopeRef,
  type Result,
  type TokenUsage,
  type ToolDescriptor,
  type ToolInvocationOutcome,
  type ToolRegistryPort,
} from '@companyos/core';

import type { ModelRegistryService } from '../registry/model-registry.js';
import {runWithModelCallRetry, type RetrySleeper} from './model-call-retry.js';
import type { SelectionPolicyService } from '../registry/selection-policy.js';
import type { ProviderRegistry } from '../providers/registry.js';

/** Artifact references produced by an execution (mirrors the persistence record). */
export interface ExecutionArtifactRecord extends EntityId {
  readonly id: string;
  readonly executionId: string;
  readonly artifactRef: string;
  readonly label: string;
  readonly createdAt: string;
}

export interface AgentRuntimeDeps {
  readonly isCancellationRequested?: (runId: string) => Promise<boolean>;
  /** ADR-A/B: every PHYSICAL retry obtains its own durable Goal reservation. */
  readonly callAdmission?: (input: {
    readonly runId: string; readonly executionId: string; readonly modelKey: string;
    readonly networkAttempt: number; readonly maxOutputTokens: number | null;
  }) => Promise<{ readonly signal: AbortSignal; readonly maxOutputTokens: number; settle(usage: InvocationResult['usage'] | null): Promise<void>; release(): void }>;
  readonly ids: IdFactory;
  readonly clock: Clock;
  /**
   * F5-D — the execution store, optionally with the canonical CONDITIONAL terminal
   * transition (`putIfStatus`): the durable row's own status is the settlement arbiter,
   * so exactly one writer wins RUNNING → terminal. Fixture-grade stores without the
   * method keep the fresh-read guard (the runtime never writes a stale capture).
   */
  /**
   * 6ec4d81 re-audit — the claim/audit transaction seam: the durable admission claim and
   * its REQUIRED creation audit commit or roll back TOGETHER (no READY owner may outlive
   * a failed prepare; a transient audit failure rolls the claim back). Its OPTIONAL
   * `serialize` fence orders every direct execution write against open transactions on
   * the shared connection (a foreign rollback can no longer swallow this runtime's
   * writes). Optional: fixture-grade runtimes without it keep sequential writes.
   */
  readonly unitOfWork?: {
    transaction<R>(work: () => Promise<R>): Promise<Result<R, DomainError>>;
    serialize?<R>(work: () => Promise<R>): Promise<R>;
  };
  /**
   * The deterministic fault-checkpoint seam (same port the supervisor runtime uses): the
   * N25-C1/N6-A1/R1 proofs pause a contender exactly BEFORE its execution write — outside
   * any transaction, so the pause can never hold the connection's write order.
   */
  readonly faultCheckpoints?: FaultCheckpointPort;
  readonly executions: EntityStore<AgentExecution> & {
    putIfStatus?(entity: AgentExecution, expectedStatus: AgentExecutionStatus): Promise<boolean>;
    /** F5-D-R1 — creation-only insert (absent → create; existing → untouched). */
    createIfAbsent?(entity: AgentExecution): Promise<boolean>;
    /**
     * F5-D-R1 — conditional progress write: lands only while the row's CURRENT durable
     * status is in the legal pre-terminal set (CREATED/READY/RUNNING). FALSE means the
     * durable lifecycle truth won (terminal rows can never be revived to RUNNING).
     */
    startIfPreTerminal?(entity: AgentExecution): Promise<boolean>;
    /** 25b98d1 — the ACTIVE logical-turn claim holder (durable single-flight arbiter). */
    activeOwnerOfLogicalTurn?(logicalTurnId: string): Promise<AgentExecution | null>;
  };
  readonly artifacts: EntityStore<ExecutionArtifactRecord>;
  /** The curated registry: the runtime reads bindings from it, never a choice. */
  readonly models: ModelRegistryService;
  readonly providers: ProviderRegistry;
  /** Selection RULES (Sprint 7.5). The runtime validates against them; it never picks. */
  readonly policies: SelectionPolicyService;
  /**
   * Sprint 13 (Task-13-09, ADR-0015 D4): optional durable reference resolver. When a
   * completion carries MANAGED artifact refs (`artifact:art_...`), every one must
   * resolve to a durable Artifact row in the SAME run before the refs are persisted —
   * resolve-all-before-write, zero content reads. Absent: legacy/opaque refs behave
   * exactly as before, and a MANAGED ref fails closed
   * (DURABLE_REFERENCE_RESOLVER_UNAVAILABLE) instead of persisting a dangling ref.
   */
  readonly durableReferenceResolver?: (refs: readonly string[]) => Promise<
    Result<
      readonly {
        readonly kind: string;
        readonly id: string;
        readonly ref: string;
        readonly runId: string;
      }[],
      DomainError
    >
  >;
  readonly events?: EventStorePort;
  /**
   * LIVE-SMOKE-FIX-03 — the sleep used between control-plane model-call retries.
   * Defaults to the real cancelable timer sleep; fixtures/deployments may inject a
   * deterministic instant sleeper so tests never wait real seconds (Boss §14/§22).
   */
  readonly modelRetrySleep?: RetrySleeper;
  readonly authorize?: (input: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }) => Promise<Result<true, DomainError>>;
  /** Values to redact from anything persisted or audited. */
  readonly secrets?: () => Promise<readonly string[]>;
  readonly logger?: Logger;
  /**
   * Sprint 9: the tool registry. When wired, prompt tool declarations become real descriptors
   * and `runToolCall` performs ONE bounded tool round - never a loop, never a plan.
   */
  readonly tools?: ToolRegistryPort;
}

/** How a model was named. The runtime records the source; it never invents one. */
export interface ModelRequest {
  readonly modelKey?: string | null;
  readonly scopes: readonly PolicyScopeRef[];
  /** True when the user typed the model themselves (highest precedence). */
  readonly explicit?: boolean;
  readonly taskOverride?: boolean;
  /** Optional company scope; the runtime also derives TASK/ROLE/COMPANY:* from the ids. */
  readonly companyId?: string;
}

export interface PrepareExecutionInput extends ModelRequest {
  readonly agentId: string;
  readonly roleId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly actorId: string;
  readonly traceId?: string;
  readonly attempt?: number;
  /**
   * Sprint 11: the SERVER-derived, ACCEPTED-only previous-handoff text. The IPC layer forbids a
   * client from setting `context.previousHandoff`, so the runtime accepts it here instead and
   * merges it into the assembled context (see `buildAgentContext`).
   */
  readonly previousHandoff?: string | null;
  /**
   * 6ec4d81 re-audit — the DURABLE whole-turn decision-authority deadline, fixed at
   * turn admission and persisted WITH the admission claim (never recomputed inside the
   * claim transaction). A bounded supervisor claim row never carries a NULL deadline.
   */
  readonly decisionAuthorityExpiresAt?: string;
  /**
   * 25b98d1 — the canonical logical supervisor turn this execution is ADMITTED for.
   * When present, creation is an ATOMIC durable claim: the GLOBAL unique index over
   * non-NULL identities gives the turn exactly ONE historical owner, forever.
   */
  readonly logicalTurnId?: string;
}

/** Everything the caller must state explicitly for the context to be assembled. */
export type ContextInput = Omit<BuildAgentContextInput, 'binding' | 'trace'>;

export interface PromptOptions {
  readonly maxOutputTokens?: number | null;
  readonly structuredKeys?: readonly string[];
  /**
   * The caller's OWN structured-output contract (V1 Product Reachability): when a
   * trusted runtime turn needs a NON-string-shaped payload (the Planner's plan
   * proposal), it declares the real JSON Schema here and the runtime forwards it to
   * the provider VERBATIM, overriding the generic string-keyed derivation from
   * `structuredKeys`. The runtime's existing rule stands: a declared contract plus
   * a missing structured payload is INVALID_OUTPUT — never a repair.
   */
  readonly responseFormat?: StructuredOutputContract | null;
  readonly tools?: readonly string[];
  /**
   * Sprint 9: tool ids to DECLARE to the model. The runtime resolves each into a real
   * descriptor (name/description/parameters) - it never chooses which tool to call.
   */
  readonly toolIds?: readonly string[];
  readonly rolePreamble?: string | null;
}

export interface RunExecutionInput {
  readonly executionId: string;
  readonly actorId: string;
  readonly context: ContextInput;
  readonly prompt?: PromptOptions;
  readonly resultRef?: string | null;
  readonly artifacts?: readonly { readonly ref: string; readonly label: string }[];
  /** Sprint 11: server-derived, ACCEPTED-only previous-handoff text (never client-supplied). */
  readonly previousHandoff?: string | null;
  /**
   * Task-18-06: when true, `runWithOutput` leaves the execution RUNNING and does NOT write
   * artifact refs or a completion; the caller settles it through `completeExecution` or
   * `failExecution`. `run` ignores this flag (its contract is "invoke -> persist outcome").
   */
  readonly deferCompletion?: boolean;
  /**
   * Task-18-06 corrective: cancellation of THIS attempt, forwarded to the provider so the
   * model call itself terminates. Optional: a caller that supplies none gets the behavior it
   * had before. Already-aborted ⇒ the provider is never invoked (zero provider calls).
   */
  readonly signal?: AbortSignal;
  /**
   * 9dc9943 — the DURABLE decision-authority expiry for THIS execution (absolute
   * ISO-8601 UTC): the instant after which a Decision may no longer commit for the
   * row. Written at start; generic callers that omit it leave the row unbounded.
   */
  readonly decisionAuthorityExpiresAt?: string;
}

export interface ExecuteInput extends PrepareExecutionInput {
  readonly context: ContextInput;
  readonly prompt?: PromptOptions;
  readonly resultRef?: string | null;
  readonly artifacts?: readonly { readonly ref: string; readonly label: string }[];
  /** Task-18-06 corrective: forwarded to the provider (see `RunExecutionInput.signal`). */
  readonly signal?: AbortSignal;
}

/**
 * The outcome of one model round, including the provider payload the caller asked for.
 *
 * `structured` is present ONLY when the prompt requested a structured contract; validating it
 * is the caller's job (the runtime never interprets model output).
 */
export interface AgentRunOutcome {
  readonly execution: AgentExecution;
  readonly outputText: string;
  readonly structured: unknown | null;
  /**
   * The usage the provider REPORTED, carried so a deferred settlement records it faithfully
   * instead of silently zeroing the input tokens.
   */
  readonly usage: TokenUsage;
}

export interface AgentRuntimeService {
  /** Validate the named model and persist a READY execution (audited). */
  prepare(input: PrepareExecutionInput): Promise<Result<AgentExecution, DomainError>>;
  /** Assemble -> invoke -> persist the outcome. Never re-picks the model. */
  run(input: RunExecutionInput): Promise<Result<AgentExecution, DomainError>>;
  /**
   * The SAME single invocation path as `run`, but returns the provider payload. With
   * `deferCompletion` the execution stays RUNNING and the caller decides when (and whether) to
   * complete it — used by a trusted runtime that must persist its own durable result BEFORE the
   * execution may be marked COMPLETED (Task-18-06 §45).
   */
  runWithOutput(input: RunExecutionInput): Promise<Result<AgentRunOutcome, DomainError>>;
  /**
   * Complete a RUNNING execution with its durable result. Validates MANAGED artifact refs
   * (same run, resolve-all-before-write) exactly like `run` does.
   *
   * `usage` is the provider-reported usage of the attempt being settled. It is OPTIONAL only
   * because a deferred settlement may be performed by a caller that never saw the provider
   * payload; when omitted the row's own record stands (zeros), which is honest rather than
   * invented.
   */
  completeExecution(input: {
    readonly executionId: string;
    readonly actorId: string;
    readonly resultRef?: string | null;
    readonly artifacts?: readonly { readonly ref: string; readonly label: string }[];
    readonly usage?: TokenUsage;
  }): Promise<Result<AgentExecution, DomainError>>;
  /**
   * Fail a RUNNING execution with a structured error (never re-invokes a provider).
   *
   * `usage` (optional, LIVE-SMOKE-FIX-06 §14) is the provider-reported usage of a call
   * whose CONTENT failed — recorded faithfully instead of zeroed; omit it when the
   * provider supplied none (never an invented number).
   */
  failExecution(input: {
    readonly executionId: string;
    readonly actorId: string;
    readonly error: ExecutionError;
    readonly usage?: TokenUsage;
  }): Promise<Result<AgentExecution, DomainError>>;
  /** prepare + run, for the end-to-end path. */
  execute(input: ExecuteInput): Promise<Result<AgentExecution, DomainError>>;
  cancel(executionId: string, actorId: string): Promise<Result<AgentExecution, DomainError>>;
  /** RUNNING/WAITING_EXTERNAL -> INTERRUPTED. Never re-invokes a provider. Paged scan. */
  recoverInterrupted(actorId: string): Promise<Result<readonly AgentExecution[], DomainError>>;
  /**
   * 25b98d1 — BOOT-SCOPE reclaim of STALE ADMISSION CLAIMS: at process start no turn
   * of THIS process owns anything, so a pre-existing ACTIVE (`CREATED`/`READY`)
   * logical-turn claim is a dead owner — settle it INTERRUPTED so the partial unique
   * index frees the logical turn (a later legitimate attempt may claim normally).
   * Live in-process contenders never see this: it runs only in the startup recovery.
   */
  reclaimStaleClaims(actorId: string): Promise<Result<readonly AgentExecution[], DomainError>>;
  /** Reads are permitted too: `agent.read` (Sprint 8 debt #1). */
  get(executionId: string, actorId: string): Promise<Result<AgentExecution | null, DomainError>>;
  list(
    filter:
      | {
          readonly taskId?: string;
          readonly runId?: string;
          readonly roleId?: string;
          readonly status?: AgentExecution['status'];
        }
      | undefined,
    actorId: string,
  ): Promise<Result<readonly AgentExecution[], DomainError>>;
  /**
   * Sprint 9: ONE bounded tool round inside one execution.
   * Model returns a tool call -> the caller parses it -> this method executes it through the
   * registry (authority -> risk/approval -> schemas -> adapter). No loop, no next-tool.
   */
  runToolCall(input: {
    readonly executionId: string;
    readonly actorId: string;
    readonly toolId: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly idempotencyKey?: string | null;
  }): Promise<Result<ToolInvocationOutcome, DomainError>>;
}

/** Refusal -> execution error kind. Exhaustive by construction. */
const REFUSAL_KIND: Readonly<Record<string, ExecutionErrorKind>> = {
  MODEL_NOT_REGISTERED: 'MODEL_UNAVAILABLE',
  MODEL_DISABLED: 'MODEL_DISABLED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  MODEL_BLOCKED_BY_POLICY: 'POLICY_REFUSED',
  PROVIDER_NOT_ALLOWED: 'PROVIDER_UNAVAILABLE',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  UNKNOWN_CAPABILITY: 'CAPABILITY_MISSING',
  COST_LIMIT_EXCEEDED: 'POLICY_REFUSED',
  LATENCY_LIMIT_EXCEEDED: 'POLICY_REFUSED',
};

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntimeService {
  const nowIso = (): string => deps.clock.nowIso();
  const nowMs = (): number => deps.clock.now();
  let warned = false;
  let knownSecrets: readonly string[] = [];

  const refreshSecrets = async (): Promise<void> => {
    if (deps.secrets === undefined) return;
    knownSecrets = await deps.secrets();
  };

  const scrub = (value: string): string => {
    const redacted = redactSecrets(value, knownSecrets);
    return redacted;
  };

  const permit = async (
    actorId: string,
    authority: string,
    scopeId?: string,
  ): Promise<Result<true, DomainError>> => {
    if (deps.authorize === undefined) {
      if (!warned) {
        warned = true;
        deps.logger?.warn(
          'no authorization policy wired: agent runtime permissions are not enforced',
        );
      }
      return ok(true);
    }
    try {
      return await deps.authorize({
        actorId,
        authority,
        ...(scopeId === undefined ? {} : { scopeId }),
      });
    } catch (error) {
      return err(
        error instanceof DomainError
          ? error
          : domainError(
              'PERMISSION_DENIED',
              error instanceof Error ? error.message : String(error),
              {},
            ),
      );
    }
  };

  /** Audit payloads carry ids only, and are redacted (no secrets, no credentials). */
  const audit = async (
    type: string,
    execution: AgentExecution,
    actorId: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> => {
    if (deps.events === undefined) return;
    await deps.events.append([
      defineEvent(
        {
          type,
          aggregateId: execution.executionId,
          aggregateType: 'AgentExecution',
          traceId: execution.traceId,
          actorId,
          payload: redactValue(
            {
              executionId: execution.executionId,
              agentId: execution.agentId,
              roleId: execution.roleId,
              taskId: execution.taskId,
              runId: execution.runId,
              modelKey: execution.modelKey,
              providerId: execution.providerId,
              status: execution.status,
              ...extra,
            },
            knownSecrets,
          ) as Record<string, unknown>,
        },
        deps.ids,
        nowIso(),
      ),
    ]);
  };
  /*
   * 6ec4d81 re-audit (N25-C1 ten-entrant race) — SINGLE-CONNECTION WRITE ORDER: every
   * agent_executions write is routed through the UnitOfWork write-order fence when one is
   * wired. On a shared connection, a DIRECT write executed while another context holds an
   * open transaction becomes part of THAT transaction and is silently undone by its
   * ROLLBACK: a delayed contender's claim rollback reverted the winner's READY→RUNNING
   * start, so the winner's sink commit found a READY row and refused (provider called, no
   * Decision, turn FAILED). `serialize` queues the write on the same FIFO as transactions
   * WITHOUT opening one, so the statement executes with no foreign transaction open —
   * and a UnitOfWork without `serialize` falls back to a real transaction (heavier, same
   * guarantee). Semantics at every call site are unchanged: a failed write still THROWS
   * the same error; only the connection-ordering envelope is added. Stores without a
   * UnitOfWork (fixture-grade) keep their historical direct writes.
   */
  const serializedWrite = async <T>(write: () => Promise<T>): Promise<T> => {
    const uow = deps.unitOfWork;
    if (uow === undefined) return write();
    if (uow.serialize !== undefined) return uow.serialize(write);
    const outcome = await uow.transaction(write);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };
  const persist = async (execution: AgentExecution): Promise<void> => {
    await serializedWrite(() => deps.executions.put(execution));
  };

  /**
   * F5-D-R1 — the conditional terminal-settlement arbiter contract, applied to the two
   * START sites (creation + the READY→RUNNING mark): durable truth decides, never an
   * earlier in-memory read. A store WITHOUT conditional support (fixture-grade) keeps
   * the historical unconditional write — production stores are always conditional.
   */
  const createConditionally = async (execution: AgentExecution): Promise<Result<true, DomainError>> => {
    const createIfAbsent = deps.executions.createIfAbsent;
    if (createIfAbsent === undefined) {
      await persist(execution);
      return ok(true);
    }
    const created = await serializedWrite(() => createIfAbsent(execution));
    if (created) return ok(true);
    const durable = await deps.executions.get(execution.executionId);
    if (durable !== null) {
      return err(
        domainError(
          'CONFLICT',
          `Execution "${execution.executionId}" already exists; creation is a no-op and the durable row is authoritative.`,
          {
            reason: 'EXECUTION_ALREADY_EXISTS',
            executionId: execution.executionId,
            status: durable.status,
          },
        ),
      );
    }
    /*
     * 25b98d1 — the ATOMIC ADMISSION CLAIM lost: another ACTIVE execution already owns
     * this logical turn (the partial unique index). Report the durable owner; the caller
     * replays the canonical Decision or returns a typed in-flight result — never a
     * second reasoning execution.
     */
    const owner =
      execution.logicalTurnId === undefined || execution.logicalTurnId === null
        ? null
        : await deps.executions.activeOwnerOfLogicalTurn?.(execution.logicalTurnId) ?? null;
    return err(
      domainError(
        'CONFLICT',
        owner === null
          ? `The logical turn "${String(execution.logicalTurnId)}" could not be claimed.`
          : `The logical turn "${String(execution.logicalTurnId)}" is already owned by execution "${owner.executionId}" (${owner.status}).`,
        {
          reason: owner === null ? 'EXECUTION_ALREADY_EXISTS' : 'LOGICAL_TURN_ALREADY_CLAIMED',
          logicalTurnId: execution.logicalTurnId ?? null,
          ownerExecutionId: owner?.executionId ?? null,
          ownerStatus: owner?.status ?? null,
          ownerCommitted: owner === null ? null : owner.outcomeCommittedAt ?? null,
        },
      ),
    );
  };
  const startConditionally = async (
    execution: AgentExecution,
    startAudit?: {
      readonly type: string;
      readonly actorId: string;
      readonly extra: (execution: AgentExecution) => Readonly<Record<string, unknown>>;
    },
  ): Promise<Result<true, DomainError>> => {
    const startIfPreTerminal = deps.executions.startIfPreTerminal;
    if (startIfPreTerminal === undefined) {
      await persist(execution);
      return ok(true);
    }
    // The pause point sits OUTSIDE the durable unit: an interleaved
    // cancel/recovery/settlement arbitrates through the storage CAS as designed.
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.agentExecutionStartBeforeWrite);
    return durableUnit(async () => {
      const started = await serializedWrite(() => startIfPreTerminal(execution));
      if (started) {
        // 4a6e362 (N4-A1) — the start write and its audit form ONE durable unit: a
        // foreign rollback can never delete a committed `agent.execution_started`.
        if (startAudit !== undefined) {
          await audit(startAudit.type, execution, startAudit.actorId, startAudit.extra(execution));
        }
        return ok(true as const);
      }
      // The durable row is no longer in a legal pre-terminal state (a concurrent
      // cancellation/recovery/settlement won): report the durable truth and never
      // proceed as if this writer owned the row.
      const durable = await deps.executions.get(execution.executionId);
      return err(
        durable === null
          ? domainError('NOT_FOUND', `Execution "${execution.executionId}" vanished before start.`, {
              executionId: execution.executionId,
            })
          : alreadyTerminalError(durable),
      );
    });
  };

  const loadOrFail = async (executionId: string): Promise<Result<AgentExecution, DomainError>> => {
    const execution = await deps.executions.get(executionId);
    if (execution === null) {
      return err(
        domainError('NOT_FOUND', `Execution "${executionId}" does not exist.`, { executionId }),
      );
    }
    return ok(execution);
  };

  const TERMINAL_EXECUTION_STATUSES: readonly AgentExecutionStatus[] = [
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'INTERRUPTED',
  ];

  /**
   * 4a6e362 re-audit (N4-A1) — ONE DURABLE UNIT for a winning terminal settlement.
   *
   * The canonical CAS and its MANDATORY terminal audit commit or roll back TOGETHER
   * (BEGIN; conditional terminal write; won → append the unique terminal event; COMMIT):
   *   - a foreign transaction's ROLLBACK can never remove an event that already
   *     COMMITTED in this unit (the Codex counterexample: a losing contender's claim
   *     transaction used to swallow a winner's directly-appended completion event);
   *   - an audit append failure rolls the terminal write back with it — no terminal
   *     state may exist without its mandatory event;
   *   - a lost race appends nothing;
   *   - a nested call joins the enclosing unit (AsyncLocalStorage) instead of opening a
   *     second transaction.
   * Stores without a UnitOfWork (fixture-grade) keep the historical sequential writes.
   */
  const durableUnit = async <T>(
    work: () => Promise<Result<T, DomainError>>,
  ): Promise<Result<T, DomainError>> => {
    const uow = deps.unitOfWork;
    if (uow === undefined) return work();
    // A transaction failure (a write/append throw rolled back, or a failed COMMIT) keeps
    // the historical THROW contract: the caller's settlement/catch chain retries and
    // classifies it exactly as it did when the write was a bare statement. An ARBITRATION
    // outcome (won:false, a typed refusal) is a normal Result and COMMITS nothing.
    const outcome = await uow.transaction(async () => work());
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };

  /**
   * F5-D — THE canonical terminal-settlement arbiter. Every lifecycle transition
   * (completion, failure, cancellation, restart interruption) goes through here:
   *
   *   1. read the CURRENT durable row (never a stale in-memory capture);
   *   2. a row already in a terminal state is authoritative — the late writer LOSES
   *      and writes nothing (no second terminal event);
   *   3. the transition is derived from the CURRENT row and lands through the store's
   *      conditional write (`putIfStatus`) while the row is still RUNNING — one SQL
   *      statement decides the race, so exactly one writer ever wins.
   *
   * `won: true` ⇒ this caller owns the terminal settlement; its MANDATORY terminal
   * audit (when given) was appended INSIDE the same durable unit. `won: false` ⇒
   * ALREADY_TERMINAL / LOST_RACE — the returned row is the durable truth and no event
   * was minted.
   */
  const settleTerminal = async (input: {
    readonly executionId: string;
    readonly apply: (current: AgentExecution) => Result<AgentExecution, DomainError>;
    /** The mandatory terminal audit: appended in the SAME unit as the winning CAS. */
    readonly audit?: {
      readonly type: string;
      readonly actorId: string;
      readonly extra: (execution: AgentExecution) => Readonly<Record<string, unknown>>;
    };
  }): Promise<Result<{ readonly won: boolean; readonly execution: AgentExecution }, DomainError>> => {
    const current = await deps.executions.get(input.executionId);
    if (current === null) {
      return err(
        domainError('NOT_FOUND', `Execution "${input.executionId}" does not exist.`, {
          executionId: input.executionId,
        }),
      );
    }
    if (TERMINAL_EXECUTION_STATUSES.includes(current.status)) {
      return ok({ won: false, execution: current });
    }
    const next = input.apply(current);
    if (!next.ok) return next;
    /*
     * F5-C-R1 — the durable POST-COMMIT ownership rule: a row whose outcome was
     * durably committed (the marker landed in the writer's own transaction) may
     * only converge to the committed COMPLETED state. A generic failure/cancel/
     * timeout settlement must NOT reinterpret the committed turn — it is refused
     * with a typed error and writes nothing; the in-flight turn (or recovery)
     * finishes the committed state later.
     */
    const committed = current.outcomeCommittedAt !== null && current.outcomeCommittedAt !== undefined;
    if (committed && next.value.status !== 'COMPLETED') {
      return err(
        domainError(
          'CONFLICT',
          `Execution "${current.executionId}" carries a durably committed outcome; a ${next.value.status} settlement may not reinterpret it.`,
          {
            reason: 'EXECUTION_OUTCOME_COMMITTED',
            executionId: current.executionId,
            outcomeCommittedAt: current.outcomeCommittedAt,
            requestedStatus: next.value.status,
          },
        ),
      );
    }
    const putIfStatus = deps.executions.putIfStatus;
    // The pause point sits OUTSIDE the durable unit: an interleaved cancel/recovery
    // arbitrates through the storage CAS without holding the connection's write order.
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.agentExecutionSettleBeforeWrite);
    return durableUnit<{ readonly won: boolean; readonly execution: AgentExecution }>(async () => {
      let nextValue = next.value;
      const fresh = await deps.executions.get(input.executionId);
      if (fresh !== null && ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(fresh.status)) {
        return ok({ won: false, execution: fresh });
      }
      const committedNow = fresh?.outcomeCommittedAt != null;
      if (!committedNow && await deps.isCancellationRequested?.(String(current.runId))) {
        const cancelled = markCancelled(fresh ?? current, nowIso());
        if (!cancelled.ok) return cancelled;
        nextValue = cancelled.value;
      }
      if (putIfStatus !== undefined) {
        const wrote = await serializedWrite(() => putIfStatus(nextValue, current.status));
        if (!wrote) {
          const durable = (await deps.executions.get(input.executionId)) ?? current;
          /*
           * 9dc9943 — the STORAGE CAS (not the pre-read) is the authority: when a
           * NON-SUCCESS terminal lost on a row that is still RUNNING, the lost race
           * was the committed-outcome predicate — report the typed refusal so the
           * caller converges the committed state instead of a generic conflict.
           */
          const committedNow =
            durable.outcomeCommittedAt !== null && durable.outcomeCommittedAt !== undefined;
          if (committedNow && durable.status === 'RUNNING' && nextValue.status !== 'COMPLETED') {
            return err(
              domainError(
                'CONFLICT',
                `Execution "${durable.executionId}" committed its outcome while this ${nextValue.status} settlement was in flight; the committed state converges to COMPLETED.`,
                {
                  reason: 'EXECUTION_OUTCOME_COMMITTED',
                  executionId: durable.executionId,
                  outcomeCommittedAt: durable.outcomeCommittedAt,
                  outcomeDecisionId: durable.outcomeDecisionId ?? null,
                  requestedStatus: nextValue.status,
                },
              ),
            );
          }
          return ok({ won: false, execution: durable });
        }
        if (input.audit !== undefined) {
          await audit(nextValue.status === 'CANCELLED' ? 'agent.execution_cancelled' : input.audit.type, nextValue, input.audit.actorId, nextValue.status === 'CANCELLED' ? {} : input.audit.extra(nextValue));
        }
        return ok({ won: true, execution: nextValue });
      }
      // A store without conditional support (fixture-grade): the fresh read above already
      // removes the stale-object overwrite; the write is best-effort.
      await serializedWrite(() => deps.executions.put(nextValue));
      if (input.audit !== undefined) {
        await audit(nextValue.status === 'CANCELLED' ? 'agent.execution_cancelled' : input.audit.type, nextValue, input.audit.actorId, nextValue.status === 'CANCELLED' ? {} : input.audit.extra(nextValue));
      }
      return ok({ won: true, execution: nextValue });
    });
  };

  /** The typed result a LOST settlement reports: the winner's durable truth, never a write. */
  const alreadyTerminalError = (durable: AgentExecution): DomainError =>
    durable.status === 'FAILED' && durable.errorKind !== null
      ? executionErrorToDomainError(
          normalizeExecutionError({
            kind: durable.errorKind,
            code: durable.errorCode ?? undefined,
            message: durable.errorMessage ?? '',
          }),
        )
      : domainError(
          'CONFLICT',
          `Execution "${durable.executionId}" is already ${durable.status}; the durable state is authoritative and is never overwritten.`,
          {
            reason: 'EXECUTION_ALREADY_TERMINAL',
            executionId: durable.executionId,
            status: durable.status,
          },
        );

  /**
   * The heart of the boundary: resolve the NAMED model against policy, or refuse.
   * There is no branch here that produces a model the caller did not name.
   */
  const selectModel = async (
    input: ModelRequest & { readonly taskId: string; readonly roleId: string },
  ): Promise<Result<ModelBinding, DomainError>> => {
    const named = (input.modelKey ?? '').trim();
    if (named.length === 0) {
      // The runtime never chooses: the router lives UPSTREAM in the application layer, which turns
      // a recommendation into an explicit modelKey before this runtime is ever called.
      return err(
        domainError(
          'MODEL_SELECTION_REQUIRED',
          'An agent execution requires an explicit modelKey. Model selection belongs to the application-layer router, not to this runtime.',
          {
            taskId: input.taskId,
            roleId: input.roleId,
            selectionOwner: 'application-layer-router',
          },
        ),
      );
    }

    // Malformed scopes are an error, never silently dropped (Closeout: MEDIUM-2).
    const malformedScopes = input.scopes.filter(
      (scope) =>
        !(POLICY_SCOPE_TYPES as readonly string[]).includes(scope.scopeType) ||
        scope.scopeId.trim().length === 0,
    );
    if (malformedScopes.length > 0) {
      return err(
        domainError('INVALID_ARGUMENT', 'A policy scope is malformed.', {
          malformed: malformedScopes.map((scope) => String(scope.scopeType)),
        }),
      );
    }

    /**
     * Scope derivation (Closeout: MEDIUM-2). The caller's `scopes` are a HINT, not the gate:
     * the runtime derives the chain from the ids it already has, so "empty scopes" cannot
     * bypass a blockedModels / allowedProviders / capability policy.
     */
    const derivedScopes: PolicyScopeRef[] = [
      { scopeType: 'TASK', scopeId: input.taskId },
      { scopeType: 'ROLE', scopeId: input.roleId },
      ...(input.companyId === undefined
        ? []
        : [{ scopeType: 'COMPANY' as const, scopeId: input.companyId }]),
      { scopeType: 'COMPANY', scopeId: '*' },
    ];
    const scopes: readonly PolicyScopeRef[] = [...derivedScopes, ...input.scopes];

    const policy = await deps.policies.resolveFor(scopes);
    const records = await deps.models.list({ includeDisabled: true });
    const verdict = evaluateManualSelection({
      modelKey: named,
      // 10A.0.3 §七: the runtime reads the same shared rule shape as every other consumer.
      policy: selectionRulesFromPolicy(policy),
      records,
      ...(input.explicit === undefined ? {} : { explicit: input.explicit }),
      ...(input.taskOverride === undefined ? {} : { taskOverride: input.taskOverride }),
    });

    if (!verdict.accepted) {
      const kind = REFUSAL_KIND[verdict.refusals[0] ?? ''] ?? 'POLICY_REFUSED';
      const code =
        kind === 'CAPABILITY_MISSING'
          ? 'CAPABILITY_MISSING'
          : verdict.refusals.includes('MODEL_NOT_REGISTERED')
            ? 'NOT_FOUND'
            : 'POLICY_DENIED';
      return err(
        domainError(code, `Model "${named}" cannot be used: ${verdict.reasons.join(' ')}`, {
          kind,
          refusals: verdict.refusals,
          reasons: verdict.reasons,
          modelKey: named,
        }),
      );
    }

    const record = records.find((entry) => entry.modelKey === named);
    if (record === undefined) {
      return err(
        domainError('NOT_FOUND', `Model "${named}" is not registered.`, {
          modelKey: named,
          kind: 'MODEL_UNAVAILABLE',
        }),
      );
    }

    const source: ModelBinding['source'] =
      input.explicit === true
        ? 'MANUAL'
        : input.taskOverride === true
          ? 'TASK_OVERRIDE'
          : // 'ROUTER' is unreachable in Sprint 8: the runtime has no router, so a named model
            // that arrived from an upper layer is an explicit binding (Closeout: MEDIUM-1).
            'EXPLICIT_BINDING';

    return ok({
      modelKey: record.modelKey,
      providerId: record.providerId,
      providerModelId: record.providerModelId,
      source,
    });
  };

  const finishFailure = async (
    execution: AgentExecution,
    error: ExecutionError,
    actorId: string,
    latencyMs: number | null,
    usage?: TokenUsage,
  ): Promise<Result<AgentExecution, DomainError>> => {
    // The persisted message must never carry a credential.
    const safe: ExecutionError = { ...error, message: scrub(error.message) };
    /*
     * F5-D — CANCELLATION IS ONE CANONICAL TRANSITION. A cancelled invocation (caller
     * abort / deadline) settles through the CANCELLED state whichever writer arrives
     * first — the runtime's own catch or the caller's `cancel()` — so the durable
     * outcome is DETERMINISTIC (status CANCELLED + CANCELLED kind) and the loser gets
     * the same CAS refusal as any other stale writer.
     */
    const cancelled = safe.kind === 'CANCELLED';
    // F5-D — the failure lands ONLY when this writer wins the terminal transition; a
    // stale cancellation/terminal state can never be overwritten and never gains a
    // second terminal event.
    const settled = await settleTerminal({
      executionId: execution.executionId,
      apply: (current) =>
        cancelled
          ? markCancelled(current, nowIso())
          : markFailed(current, safe, {
              latencyMs,
              now: nowIso(),
              ...(usage === undefined
                ? {}
                : {
                    outputUsage: {
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      // TokenUsage carries no total; derive it exactly like the deferred
                      // settlement path does (input + output), never an invented number.
                      totalTokens: usage.inputTokens + usage.outputTokens,
                    },
                  }),
            }),
      // 4a6e362 (N4-A1) — the MANDATORY terminal audit rides the winning CAS unit.
      audit: {
        type: cancelled ? 'agent.execution_cancelled' : 'agent.execution_failed',
        actorId,
        extra: () =>
          cancelled
            ? { reason: 'invocation-cancelled' }
            : { errorKind: safe.kind, errorCode: safe.code, retryable: safe.retryable },
      },
    });
    if (!settled.ok) return settled;
    if (!settled.value.won) {
      // ALREADY_TERMINAL / LOST_RACE: the durable state is authoritative — no write and
      // no second terminal event; the caller learns the WINNER's outcome.
      return err(alreadyTerminalError(settled.value.execution));
    }
    if (!cancelled) {
      deps.logger?.warn('agent execution failed', {
        executionId: settled.value.execution.executionId,
        errorKind: safe.kind,
      });
    }
    return err(executionErrorToDomainError(safe));
  };

  /**
   * The ONE completion path: validate MANAGED artifact refs (same run, resolve-all-before-
   * write), persist them, mark the execution COMPLETED with the usage the provider REPORTED,
   * audit. `run`, `runWithOutput` and `completeExecution` all end here, so there is exactly
   * one place that may say COMPLETED.
   */
  const settleCompletion = async (
    execution: AgentExecution,
    input: {
      readonly artifacts: readonly { readonly ref: string; readonly label: string }[];
      readonly resultRef: string | null;
      readonly outputTokens: number;
      /** The provider-reported input tokens; 0 when the settlement is deferred and unreported. */
      readonly inputTokens: number;
      readonly latencyMs: number;
      readonly actorId: string;
    },
  ): Promise<Result<AgentExecution, DomainError>> => {
    const artifactRefs = input.artifacts;
    // Sprint 13 (Task-13-09, ADR-0015 D4): MANAGED artifact refs (artifact:art_...) must
    // resolve to durable Artifact rows in THIS run before persistence — resolve-all-before-
    // write, zero content reads. Legacy opaque refs pass through untouched; a missing resolver
    // with managed refs present fails closed rather than persisting a dangling ref.
    if (artifactRefs.length > 0 && deps.durableReferenceResolver !== undefined) {
      const managed = artifactRefs
        .map((artifact) => artifact.ref)
        .filter((ref) => ref.startsWith('artifact:art_'));
      if (managed.length > 0) {
        const resolved = await deps.durableReferenceResolver(managed);
        if (!resolved.ok) {
          return finishFailure(
            execution,
            normalizeExecutionError({
              kind: 'INVALID_OUTPUT',
              message: resolved.error.message,
              details: resolved.error.details,
            }),
            input.actorId,
            input.latencyMs,
          );
        }
        for (const reference of resolved.value) {
          if (reference.runId !== execution.runId) {
            return finishFailure(
              execution,
              normalizeExecutionError({
                kind: 'INVALID_OUTPUT',
                message: 'Referenced artifact belongs to a different run.',
              }),
              input.actorId,
              input.latencyMs,
            );
          }
        }
      }
    }
    const inputUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const inputTokens = input.inputTokens;
    const outputUsage = {
      inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: inputTokens + input.outputTokens,
    };
    // F5-D — completion lands ONLY when this writer wins the terminal transition; a
    // late completion after a canonical failure/cancellation never overwrites it and
    // never emits a second terminal event (nor writes its artifact rows).
    const settled = await settleTerminal({
      executionId: execution.executionId,
      apply: (current) =>
        markCompleted(current, {
          resultRef: input.resultRef,
          artifactRefs: artifactRefs.map((artifact) => artifact.ref),
          inputUsage,
          outputUsage,
          latencyMs: input.latencyMs,
          now: nowIso(),
        }),
      // 4a6e362 (N4-A1) — the MANDATORY completion audit rides the winning CAS unit.
      audit: {
        type: 'agent.execution_completed',
        actorId: input.actorId,
        extra: (completed) => ({
          resultRef: completed.resultRef,
          artifactCount: artifactRefs.length,
          latencyMs: input.latencyMs,
          outputTokens: outputUsage.outputTokens,
        }),
      },
    });
    if (!settled.ok) return settled;
    // F5-D — a completion that LOST the terminal race reports the durable winner
    // explicitly (ALREADY_TERMINAL / LOST_RACE) instead of writing or pretending.
    if (!settled.value.won) return err(alreadyTerminalError(settled.value.execution));
    for (const artifact of artifactRefs) {
      await deps.artifacts.put({
        id: deps.ids.id('art'),
        executionId: execution.executionId,
        artifactRef: artifact.ref,
        label: artifact.label,
        createdAt: nowIso(),
      });
    }
    const completed = settled.value.execution;
    deps.logger?.info('agent execution completed', {
      executionId: completed.executionId,
      modelKey: completed.modelKey,
    });
    return ok(completed);
  };

  /**
   * ONE invocation path for both `run` and `runWithOutput`: assemble -> invoke -> settle (or
   * defer the settlement). No second place in this runtime calls a provider.
   */
  const runTurn = async (
    input: RunExecutionInput,
  ): Promise<Result<AgentExecution | AgentRunOutcome, DomainError>> => {
    await refreshSecrets();
    const permitted = await permit(input.actorId, 'agent.execute', input.executionId);
    if (!permitted.ok) return permitted;

    const loaded = await loadOrFail(input.executionId);
    if (!loaded.ok) return loaded;
    if (loaded.value.status === 'CANCELLED') {
      return err(
        domainError('CANCELLED', 'This execution was cancelled; it will not be run.', {
          executionId: input.executionId,
          kind: 'CANCELLED',
        }),
      );
    }
    if (loaded.value.status !== 'READY' && loaded.value.status !== 'CREATED') {
      return err(
        domainError(
          'CONFLICT',
          `Execution is ${loaded.value.status}; only READY executions can run.`,
          {
            executionId: input.executionId,
            status: loaded.value.status,
          },
        ),
      );
    }

    /**
     * Re-validate the binding at execution time (Sprint 8 debt #2): between `prepare` and
     * `run` the model may have been disabled, its provider may have gone away, or the
     * policy may have changed. The SAME model is used - a now-invalid binding fails this
     * attempt (never a silent switch to another model).
     */
    const revalidated = await selectModel({
      modelKey: loaded.value.modelKey,
      scopes: [],
      explicit: true,
      taskId: loaded.value.taskId,
      roleId: loaded.value.roleId,
    });
    if (!revalidated.ok) {
      return finishFailure(
        loaded.value,
        normalizeExecutionError({
          kind: String(revalidated.error.details['kind'] ?? ''),
          code: revalidated.error.code,
          message: revalidated.error.message,
          details: revalidated.error.details,
        }),
        input.actorId,
        null,
      );
    }

    const context = buildAgentContext({
      ...input.context,
      // Sprint 11: the accepted-handoff projection is the ONLY source of the context's
      // previousHandoff (the client-facing context is rejected if it carries one).
      ...(input.previousHandoff === undefined ? {} : { previousHandoff: input.previousHandoff }),
      binding: {
        modelKey: loaded.value.modelKey,
        providerId: loaded.value.providerId,
        providerModelId: loaded.value.providerModelId,
        source: 'BINDING',
      },
      trace: {
        traceId: loaded.value.traceId,
        executionId: loaded.value.executionId,
        attempt: loaded.value.attempt,
      },
    });
    if (!context.ok) {
      return finishFailure(
        loaded.value,
        normalizeExecutionError({
          kind: 'CAPABILITY_MISSING',
          message: context.error.message,
          code: context.error.code,
          details: context.error.details,
        }),
        input.actorId,
        null,
      );
    }

    /**
     * Sprint 9: tool declarations come from the registry as real descriptors. The runtime
     * still chooses nothing - it declares exactly the tools the caller named.
     */
    let declaredToolNames: readonly string[] = input.prompt?.tools ?? [];
    let declaredDescriptors: readonly ToolDescriptor[] = [];
    if (input.prompt?.toolIds !== undefined && input.prompt.toolIds.length > 0) {
      if (deps.tools === undefined) {
        return err(
          domainError('PERSISTENCE_FAILED', 'Tool declarations need the tool registry.', {
            hint: "open the durable database with chains: [..., 'tools']",
          }),
        );
      }
      // Sprint 9.1 §五: real descriptors (name/description/inputSchema + capabilities/risk).
      // No adapter reference, no authority list, no secret ever enters the prompt.
      const wanted = input.prompt.toolIds;
      const all: ToolDescriptor[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await deps.tools.list(
          { includeDisabled: false, limit: 200, cursor },
          input.actorId,
        );
        if (!page.ok) return page;
        for (const tool of page.value.items) all.push(describeTool(tool));
        cursor = page.value.nextCursor;
        if (cursor === null) break;
      }
      const selected = all.filter((descriptor) => wanted.includes(descriptor.toolId));
      declaredDescriptors = selected;
      declaredToolNames = selected.map((descriptor) => descriptor.name);
    }

    const plan = assemblePrompt({
      context: context.value,
      ...(input.prompt?.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.prompt.maxOutputTokens }),
      ...(input.prompt?.structuredKeys === undefined
        ? {}
        : { structuredKeys: input.prompt.structuredKeys }),
      // Sprint 9: real tool descriptors (still declared, never chosen) from the registry.
      ...(declaredToolNames.length === 0 ? {} : { tools: declaredToolNames }),
      ...(declaredDescriptors.length === 0 ? {} : { toolDescriptors: declaredDescriptors }),
      ...(input.prompt?.rolePreamble === undefined
        ? {}
        : { rolePreamble: input.prompt.rolePreamble }),
    });
    if (!plan.ok) {
      return finishFailure(
        loaded.value,
        normalizeExecutionError({
          kind:
            plan.error.code === 'MODEL_SELECTION_REQUIRED'
              ? 'MODEL_SELECTION_REQUIRED'
              : 'INTERNAL',
          message: plan.error.message,
          code: plan.error.code,
          details: plan.error.details,
        }),
        input.actorId,
        null,
      );
    }

    const running = markRunning(loaded.value, nowIso());
    if (!running.ok) return running;
    // F5-D-R1: the READY→RUNNING write is CONDITIONALLY durable — a row cancelled
    // (or otherwise settled) between the load above and this write can never be
    // revived to RUNNING; the durable truth is reported instead.
    const runningEntity =
      input.decisionAuthorityExpiresAt === undefined
        ? running.value
        : { ...running.value, decisionAuthorityExpiresAt: input.decisionAuthorityExpiresAt };
    const started = await startConditionally(runningEntity, {
      type: 'agent.execution_started',
      actorId: input.actorId,
      extra: () => ({
        promptHash: plan.value.promptHash,
        templateVersion: plan.value.templateVersion,
      }),
    });
    if (!started.ok) return started;

    const startedMs = nowMs();
    const messages = {
      ...toMessages(plan.value),
      ...(input.prompt?.responseFormat === undefined ? {} : { responseFormat: input.prompt.responseFormat }),
    };
    let invoked: Awaited<ReturnType<ProviderRegistry['invoke']>>;
    // Task-18-06 corrective: an already-aborted attempt must never reach the provider. This is
    // a hard gate, not a courtesy — a cancelled attempt is over before it starts.
    if (input.signal?.aborted === true) {
      return finishFailure(
        running.value,
        normalizeExecutionError({
          kind: 'CANCELLED',
          message: 'This execution was cancelled; the provider was never invoked.',
        }),
        input.actorId,
        null,
      );
    }
    /*
     * LIVE-SMOKE-FIX-03 — CompanyOS-owned bounded retry/backoff around the ONE logical
     * model call (planner AND supervisor share this seam). One logical call stays ONE
     * AgentExecution and ONE outer operation: transient network failures (Core's typed
     * RETRYABLE_KINDS — transport unavailable, 408, 429, 5xx) are retried inside this
     * operation under the bounded policy (4 total attempts, 2s/5s/15s backoff,
     * Retry-After honored only for retryable classes and capped at 30s, cancellation
     * stops the backoff promptly); non-retryable classes reach the provider exactly
     * once. The provider adapter still performs exactly ONE network invocation per
     * attempt — the policy never hides inside the adapter. Exhaustion re-raises the
     * LAST typed failure annotated with the attempt count, so the outer orchestration
     * semantics are unchanged.
     */
    let networkAttempt = 0;
    try {
      invoked = (
        await runWithModelCallRetry(
          async (): Promise<Awaited<ReturnType<ProviderRegistry['invoke']>>> => {
            const admission = await deps.callAdmission?.({ runId: String(running.value.runId), executionId: running.value.executionId, modelKey: running.value.modelKey, networkAttempt: ++networkAttempt, maxOutputTokens: plan.value.maxOutputTokens });
            let settlementAttempted = false;
            try {
            // ONE provider network attempt per policy attempt. A typed provider failure
            // is RAISED here (carrying Core's retryable/retryAfterMs classification in
            // its details) so the retry policy can decide whether another network
            // attempt is permitted; a success resolves to the Result unwrapped.
            const attempt = await deps.providers.invoke(
              { providerId: running.value.providerId, actorId: input.actorId },
              {
                modelId: running.value.providerModelId,
                messages: messages.messages.map((message) => ({
                  role: message.role,
                  content: message.content,
                })),
                ...((admission?.maxOutputTokens ?? plan.value.maxOutputTokens) === null
                  ? {}
                  : { maxOutputTokens: admission?.maxOutputTokens ?? plan.value.maxOutputTokens ?? undefined }),
                ...(messages.responseFormat === null ? {} : { responseFormat: messages.responseFormat }),
                ...(messages.tools.length === 0 ? {} : { tools: messages.tools }),
                traceId: running.value.traceId,
                // Forwarded so the provider terminates the model call itself. Absent for every
                // caller that does not supply one, so nothing else changes.
                ...((input.signal === undefined && admission === undefined) ? {} : { signal: admission === undefined ? input.signal : input.signal === undefined ? admission.signal : AbortSignal.any([input.signal, admission.signal]) }),
              },
            );
            settlementAttempted = true;
            await admission?.settle(attempt.ok ? attempt.value.usage : null);
            if (!attempt.ok) throw attempt.error;
            return attempt;
            } catch (error) {
              if (!settlementAttempted) await admission?.settle(null);
              throw error;
            } finally { admission?.release(); }
          },
          {
            owner: 'PLANNER',
            correlationId: running.value.executionId,
            clock: deps.clock,
            // The composition wires the real cancelable timer sleep; a bare-engine
            // construction (test/lab) without the dep retries without waiting.
            sleep: deps.modelRetrySleep ?? (async () => undefined),
            signal: input.signal,
            telemetry: (event) => {
              deps.logger?.warn('control-plane model call retry observation', {...event});
              void audit('agent.model_call_retry', running.value, input.actorId, {...event});
            },
          },
        )
      ).value;
    } catch (error) {
      const details = (error as {readonly details?: Readonly<Record<string, unknown>>} | null)?.details;
      if (error instanceof DomainError && String(details?.['reason'] ?? '').startsWith('GOAL_')) {
        const reason = String(details?.['reason']);
        return finishFailure(running.value, normalizeExecutionError({ kind: reason === 'GOAL_CANCEL_REQUESTED' ? 'CANCELLED' : reason === 'GOAL_DEADLINE_EXCEEDED' ? 'TIMEOUT' : 'POLICY_REFUSED', message: scrub(error.message), details: { ...details, retryable: false } }), input.actorId, nowMs() - startedMs);
      }
      const kind = String(details?.['kind'] ?? '');
      return finishFailure(
        running.value,
        kind === ''
          ? normalizeExecutionError({
              kind: 'INTERNAL',
              message: scrub(error instanceof Error ? error.message : String(error)),
            })
          : normalizeExecutionError({
              kind,
              code: (error as {readonly code?: string}).code,
              message: scrub(error instanceof Error ? error.message : String(error)),
              details,
            }),
        input.actorId,
        nowMs() - startedMs,
      );
    }

    const latencyMs = nowMs() - startedMs;

    if (!invoked.ok) {
      const providerKind = String(invoked.error.details['kind'] ?? '');
      return finishFailure(
        running.value,
        normalizeExecutionError({
          kind: providerKind,
          code: invoked.error.code,
          message: invoked.error.message,
          details: invoked.error.details,
        }),
        input.actorId,
        latencyMs,
      );
    }

    const result = invoked.value;
    if (await deps.isCancellationRequested?.(String(running.value.runId))) {
      return finishFailure(running.value, normalizeExecutionError({ kind: 'CANCELLED', message: 'Durable Goal cancellation won before result publication.' }), input.actorId, latencyMs);
    }
    await audit('agent.provider_invoked', running.value, input.actorId, {
      providerModelId: running.value.providerModelId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      finishReason: result.finishReason,
      latencyMs,
    });

    // Structured output was requested: a missing payload is an invalid output, not a retry.
    if (messages.responseFormat !== null && result.structured === null) {
      return finishFailure(
        running.value,
        normalizeExecutionError({
          kind: 'INVALID_OUTPUT',
          message: 'The provider returned no structured payload.',
        }),
        input.actorId,
        latencyMs,
      );
    }

    // Task-18-06: a trusted caller may need its own durable result committed BEFORE the
    // execution is allowed to complete; it then settles the execution explicitly.
    if (input.deferCompletion === true) {
      return ok({
        execution: running.value,
        outputText: result.outputText,
        structured: result.structured,
        usage: result.usage,
      });
    }
    return settleCompletion(running.value, {
      artifacts: input.artifacts ?? [],
      resultRef: input.resultRef ?? null,
      outputTokens: result.usage.outputTokens,
      inputTokens: result.usage.inputTokens,
      latencyMs,
      actorId: input.actorId,
    });
  };

  const runtime: AgentRuntimeService = {
    async prepare(input: PrepareExecutionInput): Promise<Result<AgentExecution, DomainError>> {
      if (await deps.isCancellationRequested?.(String(input.runId))) return err(domainError('CANCELLED', 'Durable Goal cancellation refuses a new execution.'));
      await refreshSecrets();
      const permitted = await permit(input.actorId, 'agent.execute', input.taskId);
      if (!permitted.ok) return permitted;

      const binding = await selectModel(input);
      if (!binding.ok) return binding;

      const built = createExecution({
        executionId: deps.ids.id('exec'),
        agentId: input.agentId,
        roleId: input.roleId,
        taskId: input.taskId,
        runId: input.runId,
        binding: binding.value,
        traceId: input.traceId ?? deps.ids.id('trace'),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        now: nowIso(),
      });
      if (!built.ok) return built;
      const readyMarked = markReady(built.value, nowIso());
      if (!readyMarked.ok) return readyMarked;
      const ready =
        input.logicalTurnId === undefined
          ? readyMarked
          : ok({
              ...readyMarked.value,
              logicalTurnId: input.logicalTurnId,
              ...(input.decisionAuthorityExpiresAt === undefined
                ? {}
                : { decisionAuthorityExpiresAt: input.decisionAuthorityExpiresAt }),
            });
      if (!ready.ok) return ready;

      /*
       * 6ec4d81 re-audit (N6-A1) — THE ATOMIC PRE-PROVIDER ADMISSION BOUNDARY: the owner
       * row (claim + logicalTurnId + immutable deadline) and its REQUIRED creation audit
       * commit or roll back TOGETHER. A transient audit failure can never leave a READY
       * owner that permanently blocks the logical turn; the caller maps the abort to a
       * typed Result.err OUTSIDE the transaction (the UnitOfWork caller convention).
       */
      const claimAndAudit = async (): Promise<Result<AgentExecution, DomainError>> => {
        const created = await createConditionally(ready.value);
        if (!created.ok) throw created.error; // abort: the claim collided (or failed)
        await audit('agent.execution_created', ready.value, input.actorId, {
          bindingSource: binding.value.source,
          attempt: ready.value.attempt,
        });
        return ok(ready.value);
      };
      // The contention pause point: a delayed contender stops HERE — before it takes the
      // claim transaction — so the winner's full turn proceeds unobstructed and the
      // released contender arbitrates against committed durable truth.
      await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.agentExecutionClaimBeforeWrite);
      if (deps.unitOfWork === undefined) {
        try {
          const claimed = await claimAndAudit();
          return claimed;
        } catch (error) {
          return err(
            error instanceof DomainError
              ? error
              : domainError('PERSISTENCE_FAILED', error instanceof Error ? error.message : String(error), {
                  reason: 'EXECUTION_CLAIM_PERSISTENCE_FAILED',
                }),
          );
        }
      }
      const claimed = await deps.unitOfWork.transaction(claimAndAudit);
      if (!claimed.ok) return claimed;
      return claimed.value;
    },

    async run(input: RunExecutionInput): Promise<Result<AgentExecution, DomainError>> {
      const settled = await runTurn(input);
      if (!settled.ok) return settled;
      const value = settled.value;
      return ok('outputText' in value ? value.execution : value);
    },

    async runWithOutput(input: RunExecutionInput): Promise<Result<AgentRunOutcome, DomainError>> {
      const outcome = await runTurn({ ...input, deferCompletion: true });
      if (!outcome.ok) return outcome;
      const value = outcome.value;
      return ok(
        'outputText' in value
          ? value
          : {
              execution: value,
              outputText: '',
              structured: null,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: null },
            },
      );
    },

    async completeExecution(input: {
      readonly executionId: string;
      readonly actorId: string;
      readonly resultRef?: string | null;
      readonly artifacts?: readonly { readonly ref: string; readonly label: string }[];
      readonly usage?: TokenUsage;
    }): Promise<Result<AgentExecution, DomainError>> {
      const permitted = await permit(input.actorId, 'agent.execute', input.executionId);
      if (!permitted.ok) return permitted;
      const loaded = await loadOrFail(input.executionId);
      if (!loaded.ok) return loaded;
      // F5-D: no pre-check — the canonical arbiter decides; a LOST completion reports
      // the typed ALREADY_TERMINAL outcome instead of a bespoke CONFLICT.
      return settleCompletion(loaded.value, {
        artifacts: input.artifacts ?? [],
        resultRef: input.resultRef ?? null,
        outputTokens: input.usage?.outputTokens ?? loaded.value.outputUsage.outputTokens,
        inputTokens: input.usage?.inputTokens ?? loaded.value.outputUsage.inputTokens,
        latencyMs: loaded.value.latencyMs ?? 0,
        actorId: input.actorId,
      });
    },

    async failExecution(input: {
      readonly executionId: string;
      readonly actorId: string;
      readonly error: ExecutionError;
      /**
       * OPTIONAL provider usage of the failed invocation (LIVE-SMOKE-FIX-06 §14): a call
       * whose CONTENT failed still consumed real tokens when the provider reports them —
       * accounting stays honest without inventing numbers for calls that supply none.
       */
      readonly usage?: TokenUsage;
    }): Promise<Result<AgentExecution, DomainError>> {
      const permitted = await permit(input.actorId, 'agent.execute', input.executionId);
      if (!permitted.ok) return permitted;
      const loaded = await loadOrFail(input.executionId);
      if (!loaded.ok) return loaded;
      // F5-D: no pre-check — the canonical arbiter reports ALREADY_TERMINAL / LOST_RACE.
      return finishFailure(loaded.value, input.error, input.actorId, loaded.value.latencyMs ?? 0, input.usage);
    },

    async execute(input: ExecuteInput): Promise<Result<AgentExecution, DomainError>> {
      const prepared = await runtime.prepare(input);
      if (!prepared.ok) return prepared;
      const runInput: RunExecutionInput = {
        executionId: prepared.value.executionId,
        actorId: input.actorId,
        context: input.context,
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.resultRef === undefined ? {} : { resultRef: input.resultRef }),
        ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
        ...(input.previousHandoff === undefined ? {} : { previousHandoff: input.previousHandoff }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      };
      return runtime.run(runInput);
    },

    async cancel(
      executionId: string,
      actorId: string,
    ): Promise<Result<AgentExecution, DomainError>> {
      const permitted = await permit(actorId, 'agent.execute', executionId);
      if (!permitted.ok) return permitted;
      // F5-D — cancellation is a terminal transition like every other: it lands only
      // when this writer wins the RUNNING → CANCELLED conditional write; a row already
      // terminal (a raced completion/failure/recovery) is authoritative and untouched.
      const settled = await settleTerminal({
        executionId,
        apply: (current) => markCancelled(current, nowIso()),
        // 4a6e362 (N4-A1) — the MANDATORY cancellation audit rides the winning CAS unit.
        audit: { type: 'agent.execution_cancelled', actorId, extra: () => ({}) },
      });
      if (!settled.ok) return settled;
      if (!settled.value.won) return ok(settled.value.execution);
      return ok(settled.value.execution);
    },

    async recoverInterrupted(
      actorId: string,
    ): Promise<Result<readonly AgentExecution[], DomainError>> {
      const permitted = await permit(actorId, 'agent.execute', 'recovery');
      if (!permitted.ok) return permitted;
      // Paged scan (Sprint 8 debt #3): a dataset larger than one page must still be repaired.
      const pageSize = 200;
      const recovered: AgentExecution[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = (await deps.executions.list({ limit: pageSize, offset })).items;
        if (page.length === 0) break;
        for (const execution of page) {
          if (!needsRecovery(execution)) continue;
          // Never COMPLETED, never re-invoked: the attempt is over, the record says so.
          // F5-D — recovery competes for the SAME conditional transition: a late live
          // writer that won first is preserved (no second settlement, no event).
          /*
           * F5-C-R1 — the committed-outcome convergence: a row whose outcome was durably
           * committed (the marker landed before the crash) recovers to the COMMITTED
           * terminal state (COMPLETED — the provider result and the Decision are both
           * durable truth); it must never be reinterpreted as INTERRUPTED. Every other
           * in-flight row keeps the frozen restart semantics (INTERRUPTED).
           */
          const committed =
            execution.outcomeCommittedAt !== null && execution.outcomeCommittedAt !== undefined;
          /*
           * 9dc9943 — the DURABLE authority expiry is honored by recovery exactly as by
           * live reconciliation: an UNCOMMITTED row past its decision-authority expiry
           * settles as the canonical TIMEOUT failure (the deadline won; settlement
           * storage may have been unavailable then) — the SAME terminal truth either
           * way. A genuinely in-flight, unexpired row keeps the frozen INTERRUPTED
           * restart semantics.
           */
          const expired =
            typeof execution.decisionAuthorityExpiresAt === 'string' &&
            execution.decisionAuthorityExpiresAt !== '' &&
            execution.decisionAuthorityExpiresAt <= nowIso();
          const settled = await settleTerminal({
            executionId: execution.executionId,
            apply: (current) =>
              committed
                ? markCompleted(current, {
                    now: nowIso(),
                    resultRef: current.resultRef,
                    artifactRefs: [],
                    inputUsage: current.inputUsage,
                    outputUsage: current.outputUsage,
                    latencyMs: current.latencyMs ?? 0,
                  })
                : expired
                  ? markFailed(
                      current,
                      normalizeExecutionError({
                        kind: 'TIMEOUT',
                        code: 'TIMEOUT',
                        message: `The supervisor execution exceeded its durable decision-authority expiry (${String(execution.decisionAuthorityExpiresAt)}).`,
                        details: { reason: 'DECISION_AUTHORITY_EXPIRED' },
                      }),
                      { latencyMs: current.latencyMs ?? 0, now: nowIso() },
                    )
                  : markInterrupted(current, nowIso()),
            // 4a6e362 (N4-A1) — the recovery audit rides the winning CAS unit.
            audit: {
              type: committed
                ? 'agent.execution_completed'
                : expired
                  ? 'agent.execution_failed'
                  : 'agent.execution_interrupted',
              actorId,
              extra: () =>
                committed
                  ? { reason: 'outcome-committed-recovery', previousStatus: execution.status }
                  : expired
                    ? { reason: 'DECISION_AUTHORITY_EXPIRED', previousStatus: execution.status }
                    : { previousStatus: execution.status },
            },
          });
          if (!settled.ok || !settled.value.won) continue;
          recovered.push(settled.value.execution);
        }
        if (page.length < pageSize) break;
      }
      return ok(recovered);
    },

    async reclaimStaleClaims(
      actorId: string,
    ): Promise<Result<readonly AgentExecution[], DomainError>> {
      const permitted = await permit(actorId, 'agent.execute', 'recovery');
      if (!permitted.ok) return permitted;
      const reclaimed: AgentExecution[] = [];
      const pageSize = 200;
      for (let offset = 0; ; offset += pageSize) {
        const page = (await deps.executions.list({ limit: pageSize, offset })).items;
        if (page.length === 0) break;
        for (const execution of page) {
          const claimed =
            typeof execution.logicalTurnId === 'string' && execution.logicalTurnId !== '';
          const preStart = execution.status === 'CREATED' || execution.status === 'READY';
          if (!claimed || !preStart) continue;
          /*
           * The pre-start transition table allows READY → FAILED/CANCELLED only (never
           * INTERRUPTED, and a CANCELLED row would stop the run per §28): a dead claim
           * settles as a typed FAILED with the INTERRUPTED kind — terminal, honest and
           * outside the illegal-proposal budget (which counts INVALID_OUTPUT only).
           */
          const settled = await settleTerminal({
            executionId: execution.executionId,
            apply: (current) =>
              markFailed(
                current,
                normalizeExecutionError({
                  kind: 'INTERRUPTED',
                  code: 'INTERRUPTED',
                  message: 'Stale admission claim reclaimed at startup (the owner process ended before the turn started).',
                  details: { reason: 'STALE_ADMISSION_CLAIM_RECLAIMED' },
                }),
                { latencyMs: 0, now: nowIso() },
              ),
            // 4a6e362 (N4-A1) — the reclaim audit rides the winning CAS unit.
            audit: {
              type: 'agent.execution_failed',
              actorId,
              extra: () => ({
                reason: 'STALE_ADMISSION_CLAIM_RECLAIMED',
                previousStatus: execution.status,
                logicalTurnId: execution.logicalTurnId ?? null,
              }),
            },
          });
          if (!settled.ok || !settled.value.won) continue;
          reclaimed.push(settled.value.execution);
        }
        if (page.length < pageSize) break;
      }
      return ok(reclaimed);
    },

    async get(
      executionId: string,
      actorId: string,
    ): Promise<Result<AgentExecution | null, DomainError>> {
      const permitted = await permit(actorId, 'agent.read', executionId);
      if (!permitted.ok) return permitted;
      return ok(await deps.executions.get(executionId));
    },

    async list(
      filter = {},
      actorId: string,
    ): Promise<Result<readonly AgentExecution[], DomainError>> {
      const permitted = await permit(actorId, 'agent.read', filter.taskId ?? 'list');
      if (!permitted.ok) return permitted;
      const pageSize = 200;
      const collected: AgentExecution[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = (await deps.executions.list({ limit: pageSize, offset, descending: true }))
          .items;
        if (page.length === 0) break;
        collected.push(...page);
        if (page.length < pageSize) break;
      }
      return ok(
        collected.filter(
          (execution) =>
            (filter.taskId === undefined || execution.taskId === filter.taskId) &&
            (filter.runId === undefined || execution.runId === filter.runId) &&
            (filter.roleId === undefined ? true : execution.roleId === filter.roleId) &&
            (filter.status === undefined || execution.status === filter.status),
        ),
      );
    },

    async runToolCall(input) {
      await refreshSecrets();
      const permitted = await permit(input.actorId, 'agent.execute', input.executionId);
      if (!permitted.ok) return permitted;
      if (deps.tools === undefined) {
        return err(
          domainError('PERSISTENCE_FAILED', 'The tool registry is not wired in this runtime.', {
            hint: "open the durable database with chains: [..., 'tools']",
          }),
        );
      }
      const loaded = await loadOrFail(input.executionId);
      if (!loaded.ok) return loaded;
      // A tool round belongs to an attempt, so the attempt must be live.
      if (loaded.value.status === 'CANCELLED' || loaded.value.status === 'FAILED') {
        return err(
          domainError('CONFLICT', `Execution is ${loaded.value.status}; no tool round will run.`, {
            executionId: input.executionId,
            status: loaded.value.status,
          }),
        );
      }
      // Exactly ONE call: the registry owns authority, risk, approval, schema and idempotency.
      return deps.tools.invoke({
        toolId: input.toolId,
        executionId: loaded.value.executionId,
        agentId: loaded.value.agentId,
        taskId: loaded.value.taskId,
        runId: loaded.value.runId,
        actorId: input.actorId,
        traceId: loaded.value.traceId,
        input: input.input,
        idempotencyKey: input.idempotencyKey ?? null,
      });
    },
  };

  return runtime;
}

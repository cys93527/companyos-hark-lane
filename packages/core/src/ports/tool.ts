/**
 * Tool port (Sprint 9 §三): the vendor- and implementation-neutral boundary an adapter sits
 * behind. Core defines it; nothing in Core or the engine knows a concrete tool.
 */
import type { DomainError } from '../kernel/errors.js';
import type { Result } from '../kernel/result.js';
import type { ToolDescriptor, ToolRecord } from '../domain/tool.js';
import type { ToolInvocation, ToolInvocationStatus } from '../domain/tool-invocation.js';

export interface ToolRequest {
  readonly toolId: string;
  readonly executionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly actorId: string;
  readonly traceId: string;
  /** Already validated against the tool's inputSchema before the adapter sees it. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  /** Set when the adapter must be replay-safe. */
  readonly idempotencyKey: string | null;
}

export interface ToolResult {
  readonly status: 'ok' | 'error';
  readonly output: unknown;
  readonly artifactRefs: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly latencyMs: number;
}

export interface ToolHealth {
  readonly status: 'healthy' | 'degraded' | 'unavailable';
  readonly checkedAt: string;
  readonly latencyMs: number;
  readonly detail: string | null;
}

/** Optional capability: adapters that can abort an in-flight call implement it. */
export interface ToolPort {
  describe(): ToolDescriptor & { readonly id?: string; readonly enabled?: boolean };
  invoke(request: ToolRequest): Promise<Result<ToolResult, DomainError>>;
  health?(): Promise<Result<ToolHealth, DomainError>>;
  cancel?(invocationId: string): Promise<Result<true, DomainError>>;
}

export interface ToolRegistration {
  readonly toolId: string;
  readonly enabled: boolean;
  readonly riskLevel: ToolRecord['riskLevel'];
  readonly registeredAt: string;
}

/**
 * The registry contract. Note the shape of the API: `get(toolId)` and `invoke(toolId, ...)`
 * both require the CALLER to name the tool. There is no `find(capability)`, no `best(...)`,
 * no `plan(...)` - that is what keeps this a registry instead of a planner.
 */
export interface ToolRegistryPort {
  register(record: ToolRecord, options?: { readonly actorId?: string }): Promise<Result<ToolRegistration, DomainError>>;
  unregister(toolId: string, options?: { readonly actorId?: string }): Promise<Result<boolean, DomainError>>;
  /** Reads are permitted too: `tool.read` (§四). */
  get(toolId: string, actorId: string): Promise<Result<ToolRecord | null, DomainError>>;
  /** Paged, with an explicit cursor: a caller can never lose a tool to a silent cap (§四). */
  list(
    options:
      | {
          readonly includeDisabled?: boolean;
          readonly limit?: number;
          readonly cursor?: string | null;
        }
      | undefined,
    actorId: string,
  ): Promise<Result<ToolPage, DomainError>>;
  setEnabled(toolId: string, enabled: boolean, actorId: string): Promise<Result<ToolRecord, DomainError>>;
  invoke(input: ToolInvokeInput): Promise<Result<ToolInvocationOutcome, DomainError>>;
  approve(input: { readonly invocationId: string; readonly actorId: string }): Promise<Result<ToolInvocationOutcome, DomainError>>;
  getInvocation(invocationId: string, actorId: string): Promise<Result<ToolInvocation | null, DomainError>>;
  /** Paged with an explicit, STABLE order (created_at DESC, id DESC) - never implicit rowid. */
  listInvocations(
    filter:
      | {
          readonly executionId?: string;
          readonly toolId?: string;
          readonly rootInvocationId?: string;
          readonly limit?: number;
          readonly cursor?: string | null;
        }
      | undefined,
    actorId: string,
  ): Promise<Result<ToolInvocationPage, DomainError>>;
  /** Exact lookup by key (indexed), never a paged scan (§二). */
  findInvocationByIdempotencyKey(key: string, actorId: string): Promise<Result<ToolInvocation | null, DomainError>>;
  /**
   * Restart recovery (§一): STARTED -> INTERRUPTED, WAITING_APPROVAL untouched.
   * It never completes an invocation and never replays a non-idempotent tool.
   */
  recoverInvocations(actorId: string): Promise<Result<ToolRecoveryReport, DomainError>>;
  /** Explicit, human-requested retry of an INTERRUPTED invocation (idempotent tools only). */
  retryInvocation(invocationId: string, actorId: string): Promise<Result<ToolInvocationOutcome, DomainError>>;
}

/** A page of tool contracts. `nextCursor` is explicit: nothing is silently truncated. */
export interface ToolPage {
  readonly items: readonly ToolRecord[];
  readonly nextCursor: string | null;
}

export interface ToolRecoveryReport {
  /** Invocations moved to INTERRUPTED by this recovery pass. */
  readonly interrupted: readonly string[];
  /** Invocations left waiting for a human: never auto-approved, never auto-executed. */
  readonly waitingApproval: readonly string[];
  /** Idempotent invocations a human MAY explicitly retry (never retried automatically). */
  readonly retryable: readonly string[];
}

export interface ToolInvokeInput {
  readonly toolId: string;
  readonly executionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly actorId: string;
  readonly traceId?: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string | null;
  /** Attempt-chain wiring: set only when this call IS a retry (Sprint 9.1.2 §一). */
  readonly attempt?: {
    readonly parentInvocationId: string;
    readonly rootInvocationId: string;
    readonly attemptNumber: number;
  };
}

/** A page of invocations. `nextCursor` is explicit: nothing is silently truncated. */
export interface ToolInvocationPage {
  readonly items: readonly ToolInvocation[];
  readonly nextCursor: string | null;
}

/** What a caller sees after `invoke` (COMPLETED) or `approve`. */
export interface ToolInvocationOutcome {
  readonly invocationId: string;
  readonly status: ToolInvocationStatus;
  readonly toolId: string;
  /**
   * Execution provenance (ADR-0019): the version recorded on the durable invocation —
   * the ACTUAL executed version on a fresh call, and the ORIGINAL version on a replay
   * (never re-read from the current registry). NULL on pre-0005 legacy rows.
   */
  readonly toolVersion: string | null;
  readonly riskLevel: ToolRecord['riskLevel'];
  readonly output: unknown;
  readonly artifactRefs: readonly string[];
  readonly latencyMs: number | null;
  /**
   * Durable execution timestamps (ADR-0018 §20): the invocation's own recorded
   * startedAt/finishedAt — on a replay these are the ORIGINAL execution times, never
   * the retry clock.
   */
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** True when the call was served from a previous identical invocation (§七). */
  readonly replayed: boolean;
  /** On a replay: which invocation answered, and in which state (never "pretend success"). */
  readonly originalInvocationId: string | null;
  readonly originalStatus: ToolInvocationStatus | null;
}

/** Index lookup for idempotency: a database query, never an in-memory scan (§二). */
export interface ToolInvocationIndexPort {
  findByIdempotencyKey(key: string): Promise<ToolInvocation | null>;
}

/** The persisted shape, re-exported here so adapters never import the domain directly. */
export type {
  ToolInvocation as ToolInvocationRecord,
  ToolInvocationStatus,
} from '../domain/tool-invocation.js';

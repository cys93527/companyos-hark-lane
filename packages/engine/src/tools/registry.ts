/**
 * Tool Registry (Sprint 9).
 *
 * The registry stores tool CONTRACTS and executes exactly one named tool per request. Every
 * gate the user froze lives here, in this order, before an adapter is ever called:
 *
 *   identify tool -> enabled? -> authorities (tool.invoke + declared) -> risk/approval ->
 *   idempotency replay? -> INPUT schema -> adapter (with timeout) -> OUTPUT schema -> record
 *
 * There is no `find(capability)`, no `plan(...)`, no loop and no fallback: if the caller does
 * not name a tool, nothing happens (Sprint 9 §一).
 */
import {
  DomainError,
  TOOL_ERROR_CODES,
  createToolInvocation,
  decideToolApproval,
  defineEvent,
  digestInput,
  domainError,
  err,
  markInvocationApproved,
  markInvocationCompleted,
  markInvocationFailed,
  markInvocationInterrupted,
  markInvocationStarted,
  markWaitingApproval,
  normalizeToolError,
  baseIdempotencyKey,
  retryIdempotencyKey,
  ok,
  redactSecrets,
  redactValue,
  riskPolicyOf,
  setToolEnabled,
  toolInvocationNeedsRecovery,
  canRetryInvocation,
  validateAgainstSchema,
  type Clock,
  type EntityId,
  type EntityStore,
  type EventStorePort,
  type IdFactory,
  type Logger,
  type Result,
  type ToolInvocation,
  type ToolInvokeInput,
  type ToolInvocationOutcome,
  type ToolPort,
  type ToolRecord,
  type ToolRegistration,
  type ToolRegistryPort,
  type ToolInvocationIndexPort,
  type ToolInvocationPage,
  type ToolPage,
  type ToolRecoveryReport,
} from '@companyos/core';

import { createFailureEvidenceLinker, validateEvidenceArtifactRefs } from './failure-evidence.js';

export interface ToolInvocationArtifactRecord extends EntityId {
  readonly id: string;
  readonly invocationId: string;
  readonly artifactRef: string;
  readonly label: string;
  readonly createdAt: string;
}

export interface ToolRegistryDeps {
  readonly ids: IdFactory;
  readonly clock: Clock;
  readonly records: EntityStore<ToolRecord>;
  readonly invocations: EntityStore<ToolInvocation>;
  readonly invocationArtifacts: EntityStore<ToolInvocationArtifactRecord>;
  /** Adapter resolution: the composition root binds adapters to `adapterRef`. */
  readonly adapters: ReadonlyMap<string, ToolPort>;
  readonly authorize?: (input: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }) => Promise<Result<true, DomainError>>;
  readonly events?: EventStorePort;
  readonly secrets?: () => Promise<readonly string[]>;
  readonly logger?: Logger;
  /**
   * Timer injection: the engine boundary gate forbids `setTimeout` in engine source, so the
   * composition root supplies "arm a timeout, return a cancel function". Without it, a tool's
   * timeoutMs is advisory and the adapter's own contract governs.
   */
  readonly timer?: (ms: number, onTimeout: () => void) => () => void;
  /**
   * Atomic claim for an approval (Closeout HIGH-1). `claim` must be a compare-and-set at the
   * storage layer: exactly one caller may win for a given invocation. Without it, concurrent
   * approvals could both execute - so a production composition root MUST provide it.
   */
  readonly claims?: { claim(invocationId: string, now: string): Promise<boolean> };
  /**
   * Sprint 13 (Task-13-09, ADR-0015 D4): optional durable reference resolver. When a
   * COMPLETED tool output carries MANAGED artifact refs (artifact:art_...), every one
   * must resolve to a durable Artifact row in the invocation's run BEFORE the terminal
   * completion persists (no dangling managed refs in a successful result). Absent:
   * legacy/opaque refs behave exactly as before, and managed refs fail closed
   * (DURABLE_REFERENCE_RESOLVER_UNAVAILABLE) rather than advertising a missing artifact.
   */
  readonly durableReferenceResolver?: (refs: readonly string[]) => Promise<
    Result<
      readonly { readonly kind: string; readonly id: string; readonly ref: string; readonly runId: string }[],
      DomainError
    >
  >;
  /**
   * Exact idempotency lookup (Closeout/MEDIUM 9.1 §二). Backed by the unique index, so a replay
   * is one indexed query - never an in-memory scan of the first N rows.
   */
  readonly invocationIndex?: ToolInvocationIndexPort;
}

export interface ToolRegistry extends ToolRegistryPort {
  /** The descriptors a caller may show a model. Still no selection. */
  descriptors(actorId: string, options?: { readonly toolIds?: readonly string[] }): Promise<Result<readonly ToolRecord[], DomainError>>;
}

/** Paging bounds (Sprint 9.1 §四): a default, a hard cap, and an explicit next cursor. */
export const TOOL_PAGE_DEFAULT = 50;
export const TOOL_PAGE_MAX = 200;
const TOOL_SCAN_PAGE = 200;

const encodeToolCursor = (after: string, offset: number): string =>
  `${Buffer.from(after, 'utf8').toString('base64url')}.${String(offset)}`;

const decodeToolCursor = (cursor: string | null): { after: string | null; offset: number } | null => {
  if (cursor === null || cursor.length === 0) return { after: null, offset: 0 };
  const separator = cursor.lastIndexOf('.');
  if (separator <= 0) return null;
  const encoded = cursor.slice(0, separator);
  const offsetText = cursor.slice(separator + 1);
  if (!/^\d+$/.test(offsetText)) return null;
  try {
    return { after: Buffer.from(encoded, 'base64url').toString('utf8'), offset: Number(offsetText) };
  } catch {
    return null;
  }
};

export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  const nowIso = (): string => deps.clock.nowIso();
  const nowMs = (): number => deps.clock.now();
  let warned = false;
  let knownSecrets: readonly string[] = [];

  const refreshSecrets = async (): Promise<void> => {
    if (deps.secrets === undefined) return;
    knownSecrets = await deps.secrets();
  };
  const scrub = (value: string): string => redactSecrets(value, knownSecrets);

  const permit = async (actorId: string, authority: string, scopeId?: string): Promise<Result<true, DomainError>> => {
    if (deps.authorize === undefined) {
      if (!warned) {
        warned = true;
        deps.logger?.warn('no authorization policy wired: tool permissions are not enforced');
      }
      return ok(true);
    }
    try {
      return await deps.authorize({ actorId, authority, ...(scopeId === undefined ? {} : { scopeId }) });
    } catch (error) {
      return err(
        error instanceof DomainError
          ? error
          : domainError('PERMISSION_DENIED', error instanceof Error ? error.message : String(error), {}),
      );
    }
  };

  const audit = async (
    type: string,
    payloadInput: Readonly<Record<string, unknown>>,
    actorId: string,
    traceId: string,
  ): Promise<void> => {
    if (deps.events === undefined) return;
    await deps.events.append([
      defineEvent(
        {
          type,
          aggregateId: String(payloadInput['toolId'] ?? 'tool-registry'),
          aggregateType: 'ToolInvocation',
          traceId,
          actorId,
          // payloads carry ids/digests only; redaction runs over everything (Sprint 9 §八)
          payload: redactValue(payloadInput, knownSecrets) as Record<string, unknown>,
        },
        deps.ids,
        nowIso(),
      ),
    ]);
  };

  /**
   * THE ONE validating, idempotent evidence linker (Sprint 17 Task-17-04 final verification).
   * Built from the registry's own dependencies and exported on the ToolRegistry surface, so
   * the composition root hands the SAME component to the repository process tools for their
   * cancel/timeout path — a reference is never trusted merely because an adapter reported it,
   * on either path.
   */
  const failureEvidenceLinker = createFailureEvidenceLinker({
    invocations: deps.invocations,
    invocationArtifacts: deps.invocationArtifacts,
    ids: deps.ids,
    clock: deps.clock,
    ...(deps.durableReferenceResolver === undefined ? {} : { resolver: deps.durableReferenceResolver }),
  });

  const fail = async (
    invocation: ToolInvocation,
    kind: Parameters<typeof normalizeToolError>[0]['kind'],
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    latencyMs: number | null = null,
  ): Promise<Result<ToolInvocationOutcome, DomainError>> => {
    const error = normalizeToolError({ kind, message: scrub(message), details });
    let evidenceRefs: readonly string[] = [];
    let rejectedRefs: readonly string[] = [];
    const moved = markInvocationFailed(invocation, error, { latencyMs, now: nowIso() });
    if (moved.ok) {
      // Failure evidence provenance (Sprint 17 Task-17-04 corrective + final verification,
      // ADR-0028 D19): an adapter may report the durable artifact refs its failing run
      // produced, and a FAILED invocation keeps its evidence reachable from durable data
      // alone. Those refs are VALIDATED first — the COMPLETED path's exact rule (grammar,
      // durable existence, same-run ownership) — so a forged or dangling reference can never
      // establish provenance; the terminal FAILED write happens BEFORE any link, so no link
      // can exist without its terminal state.
      const reportedRefs = details['artifactRefs'];
      if (Array.isArray(reportedRefs) && reportedRefs.length > 0) {
        const verdict = await validateEvidenceArtifactRefs({
          refs: reportedRefs,
          runId: invocation.runId,
          ...(deps.durableReferenceResolver === undefined ? {} : { resolver: deps.durableReferenceResolver }),
        });
        evidenceRefs = verdict.accepted;
        rejectedRefs = verdict.rejected;
      }
      await deps.invocations.put(moved.value);
      if (evidenceRefs.length > 0) {
        await failureEvidenceLinker.link({
          invocationId: invocation.id,
          runId: invocation.runId,
          refs: evidenceRefs,
        });
      }
      await audit('tool.invocation_failed', {
        toolId: invocation.toolId,
        invocationId: invocation.id,
        executionId: invocation.executionId,
        agentId: invocation.agentId,
        taskId: invocation.taskId,
        runId: invocation.runId,
        actorId: invocation.actorId,
        riskLevel: invocation.riskLevel,
        traceId: invocation.traceId,
        errorKind: error.kind,
        errorCode: error.code,
      }, invocation.actorId, invocation.traceId);
    }
    // The reported refs are REPLACED by the validated set: a caller never sees an unvalidated
    // reference advertised as this invocation's evidence, and a refusal is named explicitly.
    const refsWereReported = Array.isArray(details['artifactRefs']);
    return err(
      domainError(error.code as Parameters<typeof domainError>[0], error.message, {
        kind: error.kind,
        invocationId: invocation.id,
        retryable: error.retryable,
        ...details,
        ...(refsWereReported
          ? {
              artifactRefs: evidenceRefs,
              rejectedArtifactRefs: rejectedRefs,
              ...(rejectedRefs.length === 0 ? {} : { evidenceRefValidation: 'ARTIFACT_REFERENCE_INVALID' }),
            }
          : {}),
      }),
    );
  };

  /**
   * Persist an invocation, translating a storage-level UNIQUE violation into a DomainError
   * (Sprint 9.1 §二): a raw SqliteError must never escape the registry.
   */
  const persistInvocation = async (invocation: ToolInvocation): Promise<Result<true, DomainError>> => {
    try {
      await deps.invocations.put(invocation);
      return ok(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE/i.test(message)) {
        return err(
          domainError('CONFLICT', 'This invocation collides with an existing idempotency key.', {
            kind: 'IDEMPOTENT_REPLAY',
            invocationId: invocation.id,
            idempotencyKey: invocation.idempotencyKey,
          }),
        );
      }
      return err(
        error instanceof DomainError
          ? error
          : domainError('PERSISTENCE_FAILED', message, { invocationId: invocation.id }),
      );
    }
  };

  /** One adapter call, bounded by the tool's timeout (Sprint 9 §六/§九, test O). */
  const callAdapter = async (
    adapter: ToolPort,
    record: ToolRecord,
    invocation: ToolInvocation,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Result<{ output: unknown; artifactRefs: readonly string[]; latencyMs: number }, DomainError>> => {
    const startedMs = nowMs();
    let cancelTimer: (() => void) | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      if (deps.timer === undefined) return; // never settles: the adapter governs
      cancelTimer = deps.timer(record.timeoutMs, () => {
        resolve('timeout');
      });
    });
    try {
      const raced = await Promise.race([
        adapter.invoke({
          toolId: record.toolId,
          executionId: invocation.executionId,
          agentId: invocation.agentId,
          taskId: invocation.taskId,
          runId: invocation.runId,
          actorId: invocation.actorId,
          traceId: invocation.traceId,
          input,
          timeoutMs: record.timeoutMs,
          idempotencyKey: invocation.idempotencyKey,
        }),
        timedOut,
      ]);
      const latencyMs = nowMs() - startedMs;
      if (raced === 'timeout') {
        // A timeout is a verdict, not an abort: tell the adapter to stop if it can
        // (Closeout MEDIUM-3), and document that side-effecting tools must be idempotent.
        try {
          await adapter.cancel?.(invocation.id, 'TIMEOUT');
        } catch {
          // best effort only: the failure of a cancel must not mask the timeout
        }
        return err(
          domainError('TIMEOUT', `Tool "${record.toolId}" exceeded its ${String(record.timeoutMs)}ms timeout.`, {
            toolId: record.toolId,
            timeoutMs: record.timeoutMs,
          }),
        );
      }
      if (!raced.ok) return err(raced.error);
      return ok({
        output: raced.value.output,
        artifactRefs: raced.value.artifactRefs,
        latencyMs,
      });
    } catch (error) {
      return err(
        domainError('AGENT_UNAVAILABLE', scrub(error instanceof Error ? error.message : String(error)), {
          toolId: record.toolId,
        }),
      );
    } finally {
      cancelTimer?.();
    }
  };

  const registry: ToolRegistry = {
    async register(record: ToolRecord, options = {}): Promise<Result<ToolRegistration, DomainError>> {
      await refreshSecrets();
      const permitted = await permit(options.actorId ?? 'system', 'tool.register', record.toolId);
      if (!permitted.ok) return permitted;
      const existing = await deps.records.get(record.toolId);
      if (existing !== null) {
        return err(
          domainError('CONFLICT', `Tool "${record.toolId}" is already registered.`, { toolId: record.toolId }),
        );
      }
      await deps.records.put(record);
      await audit(
        'tool.registered',
        {
          toolId: record.toolId,
          version: record.version,
          riskLevel: record.riskLevel,
          enabled: record.enabled,
          actorId: options.actorId ?? 'system',
          executionId: null,
          agentId: null,
          taskId: null,
          runId: null,
          traceId: deps.ids.id('trace'),
        },
        options.actorId ?? 'system',
        deps.ids.id('trace'),
      );
      return ok({
        toolId: record.toolId,
        enabled: record.enabled,
        riskLevel: record.riskLevel,
        registeredAt: record.createdAt,
      });
    },

    async unregister(toolId: string, options = {}): Promise<Result<boolean, DomainError>> {
      const permitted = await permit(options.actorId ?? 'system', 'tool.register', toolId);
      if (!permitted.ok) return permitted;
      return ok(await deps.records.delete(toolId));
    },

    async get(toolId: string, actorId: string): Promise<Result<ToolRecord | null, DomainError>> {
      const permitted = await permit(actorId, 'tool.read', toolId);
      if (!permitted.ok) return permitted;
      return ok(await deps.records.get(toolId));
    },

    async list(
      options: { readonly includeDisabled?: boolean; readonly limit?: number; readonly cursor?: string | null } | undefined,
      actorId: string,
    ): Promise<Result<ToolPage, DomainError>> {
      const permitted = await permit(actorId, 'tool.read', 'tool-registry');
      if (!permitted.ok) return permitted;

      const pageSize = Math.min(Math.max(options?.limit ?? TOOL_PAGE_DEFAULT, 1), TOOL_PAGE_MAX);
      const decoded = decodeToolCursor(options?.cursor ?? null);
      if (decoded === null) {
        return err(
          domainError('INVALID_ARGUMENT', 'The tool-list cursor is malformed.', {
            cursor: options?.cursor ?? null,
          }),
        );
      }

      // Cursor paging over the registry's own ordering (toolId ASC). We never truncate
      // silently: `nextCursor` is returned whenever more rows exist (Sprint 9.1 §四).
      const items: ToolRecord[] = [];
      /** Absolute index of each pushed item, so the next cursor is exact (no skipped rows). */
      const absoluteOffsets: number[] = [];
      let scanOffset = decoded.offset;
      for (;;) {
        const page = (await deps.records.list({ limit: TOOL_SCAN_PAGE, offset: scanOffset })).items;
        if (page.length === 0) break;
        for (const [index, tool] of page.entries()) {
          if (decoded.after !== null && tool.toolId <= decoded.after) continue;
          if (options?.includeDisabled !== true && !tool.enabled) continue;
          items.push(tool);
          absoluteOffsets.push(scanOffset + index);
          if (items.length === pageSize + 1) break;
        }
        if (items.length === pageSize + 1) break;
        if (page.length < TOOL_SCAN_PAGE) break;
        scanOffset += TOOL_SCAN_PAGE;
      }

      const hasMore = items.length > pageSize;
      const visible = items.slice(0, pageSize);
      const last = visible[visible.length - 1];
      const lastVisibleOffset = absoluteOffsets[visible.length - 1];
      return ok({
        items: visible,
        nextCursor:
          hasMore && last !== undefined && lastVisibleOffset !== undefined
            ? encodeToolCursor(last.toolId, lastVisibleOffset + 1)
            : null,
      });
    },

    async descriptors(actorId, options = {}) {
      // Paged internally (Sprint 9.1 §四/LOW-3): declaring tools must never silently miss one.
      const collected: ToolRecord[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await registry.list({ includeDisabled: false, limit: TOOL_PAGE_MAX, cursor }, actorId);
        if (!page.ok) return page;
        collected.push(...page.value.items);
        cursor = page.value.nextCursor;
        if (cursor === null) break;
      }
      const wanted = options.toolIds;
      return ok(wanted === undefined ? collected : collected.filter((tool) => wanted.includes(tool.toolId)));
    },

    async setEnabled(toolId: string, enabled: boolean, actorId: string): Promise<Result<ToolRecord, DomainError>> {
      const permitted = await permit(actorId, enabled ? 'tool.enable' : 'tool.disable', toolId);
      if (!permitted.ok) return permitted;
      const record = await deps.records.get(toolId);
      if (record === null) {
        return err(domainError('NOT_FOUND', `Tool "${toolId}" is not registered.`, { toolId }));
      }
      const next = setToolEnabled(record, enabled, nowIso());
      await deps.records.put(next);
      await audit(
        enabled ? 'tool.enabled' : 'tool.disabled',
        {
          toolId,
          riskLevel: next.riskLevel,
          actorId,
          executionId: null,
          agentId: null,
          taskId: null,
          runId: null,
          traceId: deps.ids.id('trace'),
        },
        actorId,
        deps.ids.id('trace'),
      );
      return ok(next);
    },

    async invoke(input: ToolInvokeInput): Promise<Result<ToolInvocationOutcome, DomainError>> {
      await refreshSecrets();
      const traceId = input.traceId ?? deps.ids.id('trace');

      const record = await deps.records.get(input.toolId);
      if (record === null) {
        return err(domainError('NOT_FOUND', `Tool "${input.toolId}" is not registered.`, { toolId: input.toolId }));
      }
      if (!record.enabled) {
        // A disabled tool never reaches an adapter (test W).
        return err(
          domainError('POLICY_DENIED', `Tool "${input.toolId}" is disabled.`, {
            kind: 'TOOL_DISABLED',
            toolId: input.toolId,
          }),
        );
      }

      // Authorities: tool.invoke plus everything the tool declares. Role -> Authority only.
      for (const authority of record.requiredAuthorities) {
        const permitted = await permit(input.actorId, authority, input.toolId);
        if (!permitted.ok) {
          return err(
            domainError('PERMISSION_DENIED', `Actor "${input.actorId}" may not use tool "${input.toolId}".`, {
              kind: 'PERMISSION_DENIED',
              authority,
              toolId: input.toolId,
            }),
          );
        }
      }

      const built = createToolInvocation({
        id: deps.ids.id('tinv'),
        toolId: record.toolId,
        // ADR-0019: version provenance is captured AT CREATION from the executing
        // record — WAITING/FAILED/COMPLETED all know their target version afterwards.
        toolVersion: record.version,
        executionId: input.executionId,
        agentId: input.agentId,
        taskId: input.taskId,
        runId: input.runId,
        actorId: input.actorId,
        traceId,
        riskLevel: record.riskLevel,
        idempotencyMode: record.idempotencyMode,
        idempotencyKey: input.idempotencyKey ?? null,
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        // Redacted BEFORE it is recorded: an approval replays this, and no secret is stored.
        input: redactValue(input.input, knownSecrets) as Record<string, unknown>,
        now: nowIso(),
      });
      if (!built.ok) return built;
      let invocation = built.value;

      await audit(
        'tool.invocation_requested',
        {
          toolId: record.toolId,
          invocationId: invocation.id,
          executionId: input.executionId,
          agentId: input.agentId,
          taskId: input.taskId,
          runId: input.runId,
          actorId: input.actorId,
          riskLevel: record.riskLevel,
          traceId,
          idempotencyKey: invocation.idempotencyKey,
        },
        input.actorId,
        traceId,
      );

      // Idempotency (§七 + 9.1 §二/§三): one INDEXED lookup; a replay returns the recorded
      // outcome (including a FAILED one - never dressed up as success) and never re-runs the tool.
      if (invocation.idempotencyKey !== null) {
        if (deps.invocationIndex === undefined) {
          // A scan is not an option (Sprint 9.1 §二/§LOW-4): refuse rather than answer slowly
          // and incompletely. Production wires the indexed store.
          return err(
            domainError('PERSISTENCE_FAILED', 'The tool invocation index is not wired in this build.', {
              hint: "pass the migration chain 'tools' and its invocation index store",
              idempotencyKey: invocation.idempotencyKey,
            }),
          );
        }
        const prior = await deps.invocationIndex.findByIdempotencyKey(invocation.idempotencyKey);
        if (prior !== null) {
          return replayOutcome(prior, record.toolId, traceId, input.actorId);
        }
      }

      // Risk gate (§五): HIGH/CRITICAL wait for a human before anything executes.
      const riskPolicy = riskPolicyOf(record.riskLevel);
      if (riskPolicy.requiresApproval) {
        const waiting = markWaitingApproval(invocation, nowIso());
        if (!waiting.ok) return waiting;
        invocation = waiting.value;
        const persisted = await persistInvocation(invocation);
        if (!persisted.ok) return persisted;
        await audit(
          'tool.approval_requested',
          {
            toolId: record.toolId,
            invocationId: invocation.id,
            executionId: invocation.executionId,
            agentId: invocation.agentId,
            taskId: invocation.taskId,
            runId: invocation.runId,
            actorId: invocation.actorId,
            riskLevel: record.riskLevel,
            traceId,
          },
          input.actorId,
          traceId,
        );
        return err(
          domainError('APPROVAL_REQUIRED', `Tool "${record.toolId}" (risk ${record.riskLevel}) needs approval.`, {
            kind: 'APPROVAL_REQUIRED',
            toolId: record.toolId,
            invocationId: invocation.id,
            riskLevel: record.riskLevel,
          }),
        );
      }

      return executeInvocation(record, invocation, input.input);
    },

    async approve(input: { readonly invocationId: string; readonly actorId: string }): Promise<Result<ToolInvocationOutcome, DomainError>> {
      await refreshSecrets();
      const permitted = await permit(input.actorId, 'tool.invoke', input.invocationId);
      if (!permitted.ok) return permitted;
      const invocation = await deps.invocations.get(input.invocationId);
      if (invocation === null) {
        return err(domainError('NOT_FOUND', `Invocation "${input.invocationId}" does not exist.`, {}));
      }
      if (invocation.status !== 'WAITING_APPROVAL') {
        return err(
          domainError('CONFLICT', `Invocation is ${invocation.status}; nothing to approve.`, {
            invocationId: invocation.id,
            status: invocation.status,
          }),
        );
      }
      const record = await deps.records.get(invocation.toolId);
      if (record === null) {
        return err(domainError('NOT_FOUND', `Tool "${invocation.toolId}" is not registered.`, {}));
      }
      // ADR-0019 §16: the deferred execution would run the CURRENT registration. If the
      // registration version drifted since the invocation was created, executing v2 and
      // attributing it to v1 provenance is forbidden — fail closed; a new logical
      // execution (new command identity) is required for the new version.
      //
      // Final-review corrective: a LEGACY waiting invocation with UNKNOWN (null) version
      // provenance must not execute EITHER — approving it would run the current version
      // and attribute the run to UNKNOWN. UNKNOWN ≠ CURRENT: execution is forbidden
      // outright, and the null is never backfilled from the registry.
      if (invocation.toolVersion === null) {
        return err(
          domainError(
            'PERSISTENCE_FAILED',
            `Tool "${invocation.toolId}" invocation "${invocation.id}" has no durable tool version provenance; deferred execution is forbidden.`,
            {
              reason: 'TOOL_INVOCATION_VERSION_UNRECOVERABLE',
              toolId: invocation.toolId,
              invocationId: invocation.id,
            },
          ),
        );
      }
      if (record.version !== invocation.toolVersion) {
        return err(
          domainError('CONFLICT', `Tool "${invocation.toolId}" registration changed from v${invocation.toolVersion} to v${record.version} while the invocation was waiting.`, {
            reason: 'TOOL_INVOCATION_VERSION_CHANGED',
            toolId: invocation.toolId,
            invocationVersion: invocation.toolVersion,
            currentVersion: record.version,
          }),
        );
      }
      const decision = decideToolApproval({
        riskLevel: invocation.riskLevel,
        requesterActorId: invocation.actorId,
        approverActorId: input.actorId,
      });
      if (!decision.ok) return decision;

      const started = markInvocationApproved(invocation, input.actorId, nowIso());
      if (!started.ok) return started;
      await deps.invocations.put(started.value);

      // Atomic claim: exactly one approver executes, even under concurrency (Closeout HIGH-1).
      if (deps.claims !== undefined) {
        const won = await deps.claims.claim(invocation.id, nowIso());
        if (!won) {
          const current = await deps.invocations.get(invocation.id);
          return ok({
            invocationId: invocation.id,
            status: current?.status ?? 'STARTED',
            toolId: record.toolId,
            toolVersion: invocation.toolVersion,
            riskLevel: invocation.riskLevel,
            output: null,
            artifactRefs: current?.artifactRefs ?? [],
            startedAt: current?.startedAt ?? null,
            finishedAt: current?.finishedAt ?? null,
            latencyMs: current?.latencyMs ?? null,
            replayed: true,
            originalInvocationId: invocation.id,
            originalStatus: current?.status ?? null,
          });
        }
      }

      // The approved call runs the SAME recorded request (already redacted): the approver does
      // not re-supply the payload, and the adapter is called exactly once per approval.
      return executeInvocation(record, started.value, started.value.input);
    },

    async getInvocation(invocationId: string, actorId: string): Promise<Result<ToolInvocation | null, DomainError>> {
      const permitted = await permit(actorId, 'tool.read', invocationId);
      if (!permitted.ok) return permitted;
      return ok(await deps.invocations.get(invocationId));
    },

    async listInvocations(
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
    ): Promise<Result<ToolInvocationPage, DomainError>> {
      const permitted = await permit(actorId, 'tool.read', 'tool-invocations');
      if (!permitted.ok) return permitted;
      const pageSize = Math.min(Math.max(filter?.limit ?? TOOL_PAGE_DEFAULT, 1), TOOL_PAGE_MAX);
      const decoded = decodeToolCursor(filter?.cursor ?? null);
      if (decoded === null) {
        return err(domainError('INVALID_ARGUMENT', 'The invocation-list cursor is malformed.', {
          cursor: filter?.cursor ?? null,
        }));
      }

      // The store orders by (created_at DESC, id DESC) - explicit and stable (Sprint 9.1.2 §三).
      const items: ToolInvocation[] = [];
      const absoluteOffsets: number[] = [];
      let scanOffset = decoded.offset;
      for (;;) {
        const page = (await deps.invocations.list({ limit: TOOL_SCAN_PAGE, offset: scanOffset, descending: true })).items;
        if (page.length === 0) break;
        for (const [index, invocation] of page.entries()) {
          if (decoded.after !== null && invocation.id >= decoded.after) continue;
          if (filter?.executionId !== undefined && invocation.executionId !== filter.executionId) continue;
          if (filter?.toolId !== undefined && invocation.toolId !== filter.toolId) continue;
          if (filter?.rootInvocationId !== undefined && invocation.rootInvocationId !== filter.rootInvocationId) {
            continue;
          }
          items.push(invocation);
          absoluteOffsets.push(scanOffset + index);
          if (items.length === pageSize + 1) break;
        }
        if (items.length === pageSize + 1) break;
        if (page.length < TOOL_SCAN_PAGE) break;
        scanOffset += TOOL_SCAN_PAGE;
      }

      const hasMore = items.length > pageSize;
      const visible = items.slice(0, pageSize);
      const last = visible[visible.length - 1];
      const lastOffset = absoluteOffsets[visible.length - 1];
      return ok({
        items: visible,
        nextCursor:
          hasMore && last !== undefined && lastOffset !== undefined
            ? encodeToolCursor(last.id, lastOffset + 1)
            : null,
      });
    },

    async findInvocationByIdempotencyKey(key: string, actorId: string) {
      const permitted = await permit(actorId, 'tool.read', 'tool-idempotency');
      if (!permitted.ok) return permitted;
      if (deps.invocationIndex === undefined) {
        return err(
          domainError('PERSISTENCE_FAILED', 'The tool invocation index is not wired in this build.', {
            hint: "pass the migration chain 'tools' and its invocation index store",
          }),
        );
      }
      return ok(await deps.invocationIndex.findByIdempotencyKey(key));
    },

    /**
     * Restart recovery (§一). STARTED -> INTERRUPTED with an audit event; WAITING_APPROVAL is
     * left EXACTLY as it was (no auto-approval, no auto-execution). Nothing is ever retried
     * here: a non-idempotent tool must never be re-run after a crash.
     */
    async recoverInvocations(actorId: string): Promise<Result<ToolRecoveryReport, DomainError>> {
      const permitted = await permit(actorId, 'tool.invoke', 'recovery');
      if (!permitted.ok) return permitted;
      const interrupted: string[] = [];
      const waitingApproval: string[] = [];
      const retryable: string[] = [];
      const pageSize = 200;
      for (let offset = 0; ; offset += pageSize) {
        const page = (await deps.invocations.list({ limit: pageSize, offset })).items;
        if (page.length === 0) break;
        for (const invocation of page) {
          if (invocation.status === 'WAITING_APPROVAL') {
            waitingApproval.push(invocation.id);
            continue;
          }
          if (!toolInvocationNeedsRecovery(invocation)) continue;
          const moved = markInvocationInterrupted(invocation, nowIso());
          if (!moved.ok) continue;
          await deps.invocations.put(moved.value);
          await audit(
            'tool.invocation_interrupted',
            {
              toolId: invocation.toolId,
              invocationId: invocation.id,
              executionId: invocation.executionId,
              agentId: invocation.agentId,
              taskId: invocation.taskId,
              runId: invocation.runId,
              actorId,
              riskLevel: invocation.riskLevel,
              traceId: invocation.traceId,
              previousStatus: invocation.status,
              idempotencyMode: invocation.idempotencyMode,
            },
            actorId,
            invocation.traceId,
          );
          interrupted.push(invocation.id);
          if (invocation.idempotencyMode !== 'NONE') retryable.push(invocation.id);
        }
        if (page.length < pageSize) break;
      }
      return ok({ interrupted, waitingApproval, retryable });
    },

    /**
     * The ONLY way an INTERRUPTED invocation may run again: an explicit human request, and only
     * for an idempotent tool. Each retry is a NEW attempt of the same chain (Sprint 9.1.2 §一):
     * a fresh invocationId, a parent pointer, a stable root and a strictly increasing
     * attemptNumber with its own derived idempotency key - so retry N can never wrongly replay
     * retry N-1, and the chain can grow without bound.
     */
    async retryInvocation(invocationId: string, actorId: string): Promise<Result<ToolInvocationOutcome, DomainError>> {
      await refreshSecrets();
      const permitted = await permit(actorId, 'tool.invoke', invocationId);
      if (!permitted.ok) return permitted;
      const original = await deps.invocations.get(invocationId);
      if (original === null) {
        return err(domainError('NOT_FOUND', `Invocation "${invocationId}" does not exist.`, {}));
      }
      const allowed = canRetryInvocation(original);
      if (!allowed.ok) return allowed;
      if (deps.invocationIndex === undefined) {
        return err(
          domainError('PERSISTENCE_FAILED', 'The tool invocation index is not wired in this build.', {
            hint: "pass the migration chain 'tools' and its invocation index store",
          }),
        );
      }

      const root = (await deps.invocations.get(original.rootInvocationId)) ?? original;
      const base =
        baseIdempotencyKey(root.idempotencyKey) ??
        `${original.toolId}:${original.executionId}:${original.inputDigest}`;

      // Start from the chain's highest known attempt and take the first FREE attempt number,
      // so a second explicit retry of the SAME attempt still produces a new identity.
      let attemptNumber = Math.max(original.attemptNumber, root.attemptNumber) + 1;
      let derivedKey = retryIdempotencyKey(base, attemptNumber);
      let free = false;
      for (let guard = 0; guard < 50; guard += 1) {
        const taken = await deps.invocationIndex.findByIdempotencyKey(derivedKey);
        if (taken === null) {
          free = true;
          break;
        }
        attemptNumber += 1;
        derivedKey = retryIdempotencyKey(base, attemptNumber);
      }
      if (!free) {
        // Never silently reuse an occupied key (that would look like a replay, not a retry).
        return err(
          domainError('CONFLICT', 'No free attempt number is available for this retry chain.', {
            invocationId: original.id,
            rootInvocationId: original.rootInvocationId,
            lastAttemptNumber: attemptNumber,
          }),
        );
      }

      return registry.invoke({
        toolId: original.toolId,
        executionId: original.executionId,
        agentId: original.agentId,
        taskId: original.taskId,
        runId: original.runId,
        actorId,
        traceId: original.traceId,
        input: original.input,
        idempotencyKey: derivedKey,
        attempt: {
          parentInvocationId: original.id,
          rootInvocationId: original.rootInvocationId,
          attemptNumber,
        },
      });
    },
  };

  /** The actual execution path, shared by `invoke` (no approval needed) and `approve`. */
  async function executeInvocation(
    record: ToolRecord,
    invocation: ToolInvocation,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Result<ToolInvocationOutcome, DomainError>> {
    // The enabled gate is checked HERE so both paths (invoke and approve) share it
    // (Closeout MEDIUM-1: a tool disabled while an approval was pending must not run).
    if (!record.enabled) {
      return fail(invocation, 'TOOL_DISABLED', `Tool "${record.toolId}" is disabled.`, {
        toolId: record.toolId,
      });
    }
    const adapter = deps.adapters.get(record.adapterRef);
    if (adapter === undefined) {
      return fail(invocation, 'TOOL_NOT_FOUND', `No adapter is bound for "${record.adapterRef}".`, {
        adapterRef: record.adapterRef,
      });
    }

    // INPUT schema BEFORE the adapter sees anything (§六).
    const inputValid = validateAgainstSchema(input, record.inputSchema, {
      label: `input of tool "${record.toolId}"`,
    });
    if (!inputValid.ok) {
      return fail(invocation, 'INPUT_INVALID', inputValid.error.message, inputValid.error.details);
    }

    const started = markInvocationStarted(invocation, nowIso());
    if (!started.ok) return started;
    const persistedStarted = await persistInvocation(started.value);
    if (!persistedStarted.ok) return persistedStarted;
    await audit(
      'tool.invocation_started',
      {
        toolId: record.toolId,
        invocationId: started.value.id,
        executionId: started.value.executionId,
        agentId: started.value.agentId,
        taskId: started.value.taskId,
        runId: started.value.runId,
        actorId: started.value.actorId,
        riskLevel: record.riskLevel,
        traceId: started.value.traceId,
        inputDigest: started.value.inputDigest,
      },
      started.value.actorId,
      started.value.traceId,
    );

    const called = await callAdapter(adapter, record, started.value, input);
    if (!called.ok) {
      const kind = called.error.code === 'TIMEOUT' ? 'TIMEOUT' : 'TOOL_FAILED';
      return fail(started.value, kind, called.error.message, called.error.details);
    }

    // OUTPUT schema AFTER the adapter returns (§六).
    const outputValid = validateAgainstSchema(called.value.output, record.outputSchema, {
      label: `output of tool "${record.toolId}"`,
    });
    if (!outputValid.ok) {
      return fail(
        started.value,
        'OUTPUT_INVALID',
        outputValid.error.message,
        outputValid.error.details,
        called.value.latencyMs,
      );
    }

    // Sprint 13 (Task-13-09): managed artifact refs in the output must resolve to
    // durable rows in this run BEFORE terminal completion persists. Failure follows the
    // existing invalid-output path (invocation FAILED, no dangling refs advertised) —
    // the tool is NOT re-executed; a correct retry goes through the idempotency key.
    if (deps.durableReferenceResolver !== undefined) {
      const managedRefs = called.value.artifactRefs.filter((ref) => ref.startsWith('artifact:art_'));
      if (managedRefs.length > 0) {
        const resolved = await deps.durableReferenceResolver(managedRefs);
        if (!resolved.ok) {
          return fail(
            started.value,
            'OUTPUT_INVALID',
            resolved.error.message,
            { ...resolved.error.details, reason: resolved.error.details?.reason ?? 'DURABLE_REFERENCE_INVALID' },
            called.value.latencyMs,
          );
        }
        for (const reference of resolved.value) {
          if (reference.runId !== started.value.runId) {
            return fail(
              started.value,
              'OUTPUT_INVALID',
              'Referenced artifact belongs to a different run.',
              { reason: 'ARTIFACT_REFERENCE_WRONG_RUN', reference: reference.ref },
              called.value.latencyMs,
            );
          }
        }
      }
    }

    for (const artifactRef of called.value.artifactRefs) {
      await deps.invocationArtifacts.put({
        id: deps.ids.id('tart'),
        invocationId: started.value.id,
        artifactRef,
        label: artifactRef,
        createdAt: nowIso(),
      });
    }

    // ADR-0018: persist a verified-lossless replay snapshot IN THE SAME terminal
    // update as COMPLETED + outputDigest (single upsert — no separate commit window).
    // A snapshot that cannot round-trip through JSON without changing its digest is
    // never persisted (replay of such a row fails closed instead of lying).
    const outputDigest = digestInput(called.value.output);
    let replayOutput: unknown = null;
    try {
      const roundTripped = JSON.parse(JSON.stringify(called.value.output)) as unknown;
      if (digestInput(roundTripped) === outputDigest) replayOutput = roundTripped;
    } catch {
      replayOutput = null; // exotic output: no snapshot, replay will fail closed
    }
    const completed = markInvocationCompleted(started.value, {
      outputDigest,
      artifactRefs: called.value.artifactRefs,
      latencyMs: called.value.latencyMs,
      now: nowIso(),
      replayOutput,
    });
    if (!completed.ok) return completed;
    await deps.invocations.put(completed.value);
    await audit(
      'tool.invocation_completed',
      {
        toolId: record.toolId,
        invocationId: completed.value.id,
        executionId: completed.value.executionId,
        agentId: completed.value.agentId,
        taskId: completed.value.taskId,
        runId: completed.value.runId,
        actorId: completed.value.actorId,
        riskLevel: record.riskLevel,
        traceId: completed.value.traceId,
        latencyMs: completed.value.latencyMs,
        artifactCount: called.value.artifactRefs.length,
        outputDigest: completed.value.outputDigest,
      },
      completed.value.actorId,
      completed.value.traceId,
    );

    return ok({
      invocationId: completed.value.id,
      status: completed.value.status,
      toolId: record.toolId,
      toolVersion: completed.value.toolVersion,
      riskLevel: record.riskLevel,
      output: called.value.output,
      artifactRefs: called.value.artifactRefs,
      latencyMs: called.value.latencyMs,
      startedAt: completed.value.startedAt,
      finishedAt: completed.value.finishedAt,
      replayed: false,
      originalInvocationId: null,
      originalStatus: null,
    });
  }

  /**
   * A replay answers with the ORIGINAL invocation's recorded facts - including its status.
   * A FAILED original stays FAILED: a replay must never look like a success (Sprint 9.1 §三).
   */
  async function replayOutcome(
    prior: ToolInvocation,
    toolId: string,
    traceId: string,
    actorId: string,
  ): Promise<Result<ToolInvocationOutcome, DomainError>> {
    await audit(
      'tool.invocation_replayed',
      {
        toolId,
        invocationId: prior.id,
        executionId: prior.executionId,
        agentId: prior.agentId,
        taskId: prior.taskId,
        runId: prior.runId,
        actorId,
        riskLevel: prior.riskLevel,
        traceId,
        originalStatus: prior.status,
      },
      actorId,
      traceId,
    );
    // ADR-0018 — restore the ORIGINAL successful output from the durable snapshot.
    if (prior.status === 'COMPLETED') {
      if (prior.replayOutput === null || prior.replayOutput === undefined) {
        // FAILED rows never carry snapshots; a COMPLETED row without one is either a
        // pre-0004 legacy row or an output that could not round-trip losslessly.
        // NEVER pretend `output: null` is a valid successful replay (fail closed).
        return err(
          domainError(
            'PERSISTENCE_FAILED',
            `Tool "${prior.toolId}" invocation "${prior.id}" completed without a replayable output snapshot.`,
            { reason: 'TOOL_REPLAY_OUTPUT_UNAVAILABLE', toolId: prior.toolId, invocationId: prior.id },
          ),
        );
      }
      if (prior.outputDigest === null || digestInput(prior.replayOutput) !== prior.outputDigest) {
        // Integrity violation: the snapshot does not match its own recorded digest.
        // NEVER call the adapter again to "repair" it.
        return err(
          domainError(
            'PERSISTENCE_FAILED',
            `Tool "${prior.toolId}" invocation "${prior.id}" has a corrupt replay output snapshot.`,
            { reason: 'TOOL_REPLAY_OUTPUT_CORRUPT', toolId: prior.toolId, invocationId: prior.id },
          ),
        );
      }
    }
    return ok({
      invocationId: prior.id,
      status: prior.status,
      toolId: prior.toolId,
      toolVersion: prior.toolVersion,
      riskLevel: prior.riskLevel,
      output: prior.replayOutput ?? null,
      artifactRefs: prior.artifactRefs,
      latencyMs: prior.latencyMs,
      startedAt: prior.startedAt,
      finishedAt: prior.finishedAt,
      replayed: true,
      originalInvocationId: prior.id,
      originalStatus: prior.status,
    });
  }

  void TOOL_ERROR_CODES;
  return registry;
}

/**
 * A compare-and-set claim over one invocation, implemented at the storage layer.
 * Two concurrent approvals race here; the loser must not execute the tool.
 */
export interface ToolInvocationClaimStore {
  claim(invocationId: string, now: string): Promise<boolean>;
}

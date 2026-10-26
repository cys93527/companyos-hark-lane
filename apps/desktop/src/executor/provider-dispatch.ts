/**
 * Sprint24 — the trusted PROVIDER DISPATCH orchestration: the single place a
 * provider-backed task kind executes. Runs INSIDE the engine's StageHandler
 * window — i.e. strictly AFTER the canonical ExecutionAttempt claim committed
 * and OUTSIDE any SQLite write transaction (ARCH-021/022 own those invariants;
 * this module must never open one around the provider call).
 *
 * Ownership law: the provider binding is SUBORDINATE to ExecutionAttempt; the
 * provider outcome is delivered back as a StageHandlerOutput envelope and the
 * ENGINE settles canonically — a provider success alone never settles a Task.
 *
 * Sprint25 — the SAFETY PRECONDITION runs here as an ordered phase, never as a
 * second lifecycle: configuration valid → secret refs resolvable → workspace
 * trusted → cwd allowed → capabilities supported → authorization present, all
 * BEFORE any provider side effect and before the durable claim. A safety failure
 * is an ordinary failed outcome with a typed stage/reason; the frozen attempt
 * records the configuration fingerprint it was claimed under so a resumed
 * attempt can refuse to run under a drifted configuration.
 */
import {
  assertExecutionSafety,
  assertExecutorCapabilities,
  assertConfigUnchanged,
  providerDispatchIdOf,
  providerDispatchKeyOf,
  type ExecutionSafetyStageName,
  type ExecutorCapabilityName,
  type ExecutorProvider,
  type ExecutorExecutionRequest,
  type ExecutorProviderRegistry,
  type ProviderRoleContext,
  type SelectedModelRoute,
  type TypedExecutorConfig,
} from '@companyos/engine';
import {createHash} from 'node:crypto';
import {renderRetryDirective, type RetryContinuationEnvelope} from './attempt-supervision.js';
import type { DomainError, Result, SecretRef, StageHandlerOutput } from '@companyos/core';
import {createCoreDomainEvent, redactSecrets, type DomainEvent} from '@companyos/core';
import type { ProviderDispatch, ProviderDispatchStore } from '@companyos/persistence';

import type { CoreServices } from '../core-services.js';
import {DEFAULT_ROUTING_MODE, budgetVerdictOf, attemptUsageOf, type RuntimeRoutingOutcome, type RoutingMode} from './runtime-routing.js';

/** A safe, bounded token naming why admission was refused (typed reason or error code; never a message). */
const admissionCauseOf = (error: unknown): string | undefined => {
  const e = error as { details?: { reason?: unknown }; code?: unknown } | null;
  const raw = typeof e?.details?.reason === 'string' ? e.details.reason : typeof e?.code === 'string' ? e.code : undefined;
  return raw !== undefined && /^[A-Z0-9_]{1,64}$/u.test(raw) ? raw : undefined;
};

/**
 * The Agentic Work Envelope (Agentic Work Package Contract closeout): the bounded
 * canonical work semantics one executor receives — projected by the composition from
 * the canonical Work Package (pinned-version node config, run-owned goal, Task.inputs,
 * pinned-DAG predecessor references). This is a TRANSPORT shape only: the composition
 * owns the mapping, this module carries it to the provider request unchanged, and a
 * projection failure fails the dispatch closed (never a silent degrade to a synthetic
 * task-kind label).
 */
export interface ProviderWorkEnvelope {
  /** The canonical one-task objective: the byte-exact plan-item objective, else the run-owned goal. */
  readonly objective: string;
  /** Bounded deterministic render of canonical context lines (goal, criteria, input references). */
  readonly memoryView?: readonly string[];
  /** Read-only canonical artifact references this work may consume. */
  readonly artifactRefs?: readonly string[];
  /** The canonical immutable Task.inputs as typed data. */
  readonly taskInputs?: Readonly<Record<string, unknown>>;
  /** The pinned acceptance criteria (self-check references; validation authority stays upstream). */
  readonly acceptanceCriteria?: readonly { readonly criterionId: string; readonly requirement: string }[];
  /** The run-owned canonical goal's structured constraints (human-supplied, byte-exact). */
  readonly goalStructured?: Readonly<Record<string, unknown>>;
}

export interface ProviderDispatchDeps {
  readonly fileDeliveryGoalOf?: (runId: string) => Promise<string | null>;
  readonly verifyFileDeliveryOf?: (input: { readonly runId: string; readonly taskId: string; readonly attemptId: string; readonly finalText: string }) => Promise<Result<{ readonly artifactRefs: readonly string[]; readonly validationRefs: readonly string[] }, DomainError>>;
  readonly prepareExternalAdmission?: (request: ProviderDispatchRequest, route: SelectedModelRoute | undefined) => Promise<{
    readonly signal: AbortSignal;
    readonly admitBody: NonNullable<ExecutorExecutionRequest['modelCallAdmission']>;
    /** H15d-fix3: the body byte bound admitBody enforces (kernel working window source). */
    readonly inputUpperBoundBytes?: number;
    release(): void;
  }>;
  readonly registry: ExecutorProviderRegistry;
  readonly dispatches: ProviderDispatchStore;
  readonly clock: { nowIso(): string };
  /**
   * LIVE-SMOKE-FIX-02 — the CompanyOS-resolved production attempt time budget (ms),
   * owned by the composition (deployment override, else the 600s product default).
   * When present the provider request ALWAYS carries an explicit timeout; the
   * provider's internal fallback is never the normal production path.
   */
  readonly attemptTimeoutMs?: number;
  /** Resolve the trusted workspace root for a run/task, or null (fail closed). */
  readonly workspaceOf: (runId: string, taskId: string) => string | null;
  readonly requiredCapabilitiesOf: (taskKind: string) => readonly ExecutorCapabilityName[];
  /**
   * The canonical Work Envelope seam (Agentic Work Package Contract). When present it
   * is the PRIMARY work source: its objective is the task's real business semantics,
   * and a projection error fails the dispatch (fail closed). Absent = the legacy
   * minimal path below (bounded tests / narrow compositions).
   */
  readonly workContextOf?: (
    runId: string,
    taskId: string,
  ) => Promise<Result<ProviderWorkEnvelope, DomainError>>;
  /**
   * STAGE E3 — retry continuation derivation seam (DERIVED, non-canonical). Given the
   * task and the NEW attempt number, returns the bounded retry envelope from durable
   * truth (prior attempt rows + E1 activity events), or null for a first attempt.
   * The envelope is context for the executor; it never alters settlement, budget,
   * routing, or the canonical attempt identity.
   */
  readonly retryContextOf?: (
    input: {readonly runId: string; readonly taskId: string; readonly attemptNumber: number},
  ) => RetryContinuationEnvelope | null;
  /**
   * Legacy minimal seam (Sprint24): one bounded text line for the work. Superseded by
   * `workContextOf` in the production composition; kept for the narrow compositions
   * that only carry text.
   */
  readonly workPackageTextOf?: (runId: string, taskId: string) => Promise<string | null>;
  /**
   * Native Execution Foundation §5 (optional): the canonical immutable Task.inputs,
   * projected to the request as TYPED DATA for deterministic providers. Absent = the
   * task carries no typed inputs (agentic flows are unchanged).
   */
  readonly taskInputsOf?: (runId: string, taskId: string) => Promise<Readonly<Record<string, unknown>> | null>;
  /**
   * Final Readiness Gate (optional) — canonical ARTIFACT materialization for a
   * provider's declared output: the SAME frozen convention the generic executor
   * handler uses (`structured.artifactContent`, a non-empty string). The composition
   * owns the call into the ONE Sprint-13 artifact service; a result here lets the
   * settled envelope carry the canonical artifact reference downstream Work Packages
   * project. Absent = the envelope carries no artifact reference (narrow test
   * compositions). A provider can never INSERT an artifact row itself.
   */
  readonly materializeArtifactOf?: (input: {
    readonly runId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly content: string;
  }) => Promise<Result<{ readonly artifactId: string }, DomainError>>;
  /**
   * Sprint25 — the typed, validated configuration this provider would run under,
   * or null when none is registered. Absent means NO dispatch proceeds: there is
   * no provenance to record, and "unconfigured" is a fail-closed condition.
   */
  readonly configOf?: (providerKey: string) => TypedExecutorConfig | null;
  /**
   * Sprint25 — was this execution authorized, and through WHICH existing
   * mechanism? Never an ad-hoc boolean: the reference names the Decision/Approval
   * that carries the authority. Absent/empty means unauthorized (fail closed).
   */
  readonly authorizationOf?: (input: {
    readonly providerKey: string;
    readonly runId: string;
    readonly taskId: string;
  }) => Promise<ProviderDispatchAuthorization | null>;
  /** Secret references this provider needs. The V1 local provider needs NONE. */
  readonly secretRefsOf?: (providerKey: string) => readonly SecretRef[];
  /**
   * STAGE 8B §9 — the routing mode for this composition. DETERMINISTIC_V1
   * (default) keeps the Stage 6 deterministic selector as the attempt's single
   * selection authority; SMART_ROUTER_V1 routes every provider-backed attempt
   * through the Smart Router BEFORE the kernel is invoked. An attempt never has
   * two selection authorities.
   */
  readonly routingMode?: RoutingMode;
  /**
   * STAGE 8B §5-§7 — the composition-owned routing seam: resolve the canonical
   * role, derive complexity/risk from canonical data, run the Smart Router, and
   * project the RoutingDecision + route + evidence for THIS attempt. Only
   * consulted in SMART_ROUTER_V1 mode, and only BEFORE the provider is invoked.
   */
  readonly routeModelOf?: (input: {
    readonly attemptId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly roleId: string;
    readonly attemptNumber: number;
  }) => Promise<Result<RuntimeRoutingOutcome, DomainError>>;
  /**
   * STAGE 8B §11-§12 — the composition-owned ROLE CONTEXT seam: the bounded
   * RoleContextEnvelope projection built from canonical durable truth (goal,
   * plan item, task, role responsibility, accepted handoffs, decisions,
   * artifact/evidence refs, criteria, risks, the attempt's selected model).
   * Never a producer raw transcript; a projection failure fails the dispatch.
   */
  readonly roleContextOf?: (input: {
    readonly runId: string;
    readonly taskId: string;
    readonly roleId: string;
    readonly attemptModelLabel: string | null;
  }) => Promise<Result<ProviderRoleContext, DomainError>>;
  /**
   * STAGE 8B §3 — the composition-owned durable handoff write: the producer
   * role's canonical artifacts/evidence are recorded as a READY canonical
   * handoff packet (existing Sprint-11 owner) the consumer role reads from
   * durable state. A producer with NO durable artifact records nothing (the
   * contract demands at least one durable artifact — there is no professional
   * transfer without one). Absent in DETERMINISTIC_V1 compositions and narrow
   * tests.
   */
  readonly recordHandoffOf?: (input: {
    readonly runId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly producerRoleId: string;
    readonly objective: string;
    readonly artifactRefs: readonly string[];
    readonly validationRefs?: readonly string[];
  }) => Promise<Result<{ readonly handoffId: string; readonly recorded: boolean }, DomainError>>;
  /**
   * LIVE-SMOKE-FIX-08 P1-2 — durable dispatch AUDIT (evidence only, never a second
   * execution truth). When present, `executor.dispatch_requested` is appended
   * BEFORE the provider process is launched (so a timeout/kill/crash attempt stays
   * attributable without depending on a post-success transcript), and
   * `executor.dispatch_settled` correlates the outcome afterwards. The values pass
   * the provided redaction (active vault secrets) before they are persisted.
   */
  readonly dispatchAudit?: {
    /** Append REAL domain events to the existing durable event store. */
    append(events: readonly DomainEvent[]): Promise<unknown>;
    /** Active secret VALUES (vault) — any occurrence in command/output text is redacted. */
    secrets(): readonly string[];
    /** The deterministic id factory (event ids), the same port the engine uses. */
    ids: {id(prefix?: string): string; ulid(): string};
  };
}

/** Authorization provenance — the existing Decision/Approval machinery, never a bare flag. */
export interface ProviderDispatchAuthorization {
  readonly present: boolean;
  readonly source: 'composition-policy' | 'decision-approval';
  readonly reference?: string;
}

export interface ProviderDispatchRequest {
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly roleId: string;
  readonly taskKind: string;
  /** DELIBERATE continuation into a known provider session — new work, never replay. */
  readonly continuationSessionId?: string;
}

/** A typed safety refusal: which stage failed and its reason (never a secret, never a root path). */
export interface ProviderDispatchSafetyFailure {
  readonly stage: ExecutionSafetyStageName | null;
  readonly reason: string;
  readonly code: string;
}

export interface ProviderDispatchExecutionResult {
  /**
   * The canonical handler return for the ENGINE's settlement: a structured
   * `succeeded` result carrying the output envelope, or the bare `failed`
   * status. The ENGINE settles Task/Attempt — the provider never does.
   */
  readonly output: { readonly status: 'succeeded'; readonly output: StageHandlerOutput } | 'failed';
  readonly dispatchId: string;
  readonly providerKey: string;
  readonly providerSessionId: string | null;
  readonly state: ProviderDispatch['state'];
  /** Present only on failure: the safety stage (or dispatch condition) that refused. */
  readonly failure?: ProviderDispatchSafetyFailure;
}

/** The deterministic attempt identity is recomputed, never taken from a caller. */
export const attemptIdentityOf = (request: ProviderDispatchRequest): { attemptId: string; attemptNumber: number } => ({
  attemptId: request.attemptId,
  attemptNumber: request.attemptNumber,
});

export const createProviderDispatchExecution = (deps: ProviderDispatchDeps) => {
  const execute = async (
    request: ProviderDispatchRequest,
    providerKey: string,
  ): Promise<ProviderDispatchExecutionResult> => {
    const provider: ExecutorProvider | null = deps.registry.resolve(providerKey);
    if (provider === null) {
      return {
        output: 'failed',
        dispatchId: '',
        providerKey,
        providerSessionId: null,
        state: 'DISPATCHED',
        failure: { stage: null, reason: 'EXECUTOR_PROVIDER_UNKNOWN', code: 'NOT_FOUND' },
      };
    }
    const required = deps.requiredCapabilitiesOf(request.taskKind);
    const negotiation = assertExecutorCapabilities(required, provider.descriptor);
    if (!negotiation.supported) {
      // FAIL LOUD before any external invocation — never silent degradation. A
      // routing/capability mistake is a programming error, so it stays an
      // exception (Sprint24 §11); the preflight stages below are operational
      // conditions the engine settles as a failed attempt.
      throw new Error(
        `EXECUTOR_CAPABILITY_MISSING:${providerKey}:${[...negotiation.missing].join(',')}`,
      );
    }

    /*
     * Sprint25 — the ordered safety preflight. No side effects: it decides
     * configuration validity, secret refs, workspace trust, cwd legality,
     * capabilities and authorization BEFORE a durable row exists and before the
     * provider is invoked. The capability stage is re-asserted here (idempotent)
     * so a single ordered verdict describes the whole precondition set.
     */
    const now = deps.clock.nowIso();
    const workspaceRoot = deps.workspaceOf(request.runId, request.taskId);
    const authorization = (await deps.authorizationOf?.({
      providerKey,
      runId: request.runId,
      taskId: request.taskId,
    })) ?? null;
    const verdict = await assertExecutionSafety({
      providerKey,
      config: deps.configOf?.(providerKey) ?? null,
      secretRefs: deps.secretRefsOf?.(providerKey) ?? [],
      workspaceRoot,
      cwd: workspaceRoot,
      requiredCapabilities: required,
      advertisedCapabilities: [...provider.descriptor.capabilities],
      authorization: authorization !== null && authorization.present,
    });
    if (!verdict.safe) {
      return {
        output: 'failed',
        dispatchId: '',
        providerKey,
        providerSessionId: null,
        state: 'DISPATCHED',
        failure: {
          stage: verdict.failedStage,
          reason: String(verdict.error?.details['reason'] ?? verdict.error?.code ?? 'EXECUTION_SAFETY_REFUSED'),
          code: verdict.error?.code ?? 'VALIDATION_FAILED',
        },
      };
    }

    /*
     * The work source (Agentic Work Package Contract): the canonical Work Envelope is
     * PRIMARY when the seam is wired, and it is projected BEFORE any durable dispatch
     * row exists — the same read-only-precondition discipline as the safety preflight
     * above. A projection failure fails the dispatch closed: an executor must never
     * silently receive a synthetic task-kind label in place of real business semantics.
     * The taskKind fallback further below is LAST-RESORT DEFENSE for narrow unwired
     * compositions only; taskKind stays a routing identity, never a business objective.
     */
    const envelope =
      deps.workContextOf === undefined ? undefined : await deps.workContextOf(request.runId, request.taskId);
    if (envelope !== undefined && !envelope.ok) {
      return {
        output: 'failed',
        dispatchId: '',
        providerKey,
        providerSessionId: null,
        state: 'DISPATCHED',
        failure: {
          stage: null,
          reason: String(envelope.error.details['reason'] ?? envelope.error.code ?? 'WORK_CONTEXT_PROJECTION_FAILED'),
          code: envelope.error.code,
        },
      };
    }

    const dispatchKey = providerDispatchKeyOf({
      companyId: request.companyId,
      runId: request.runId,
      taskId: request.taskId,
      attemptNumber: request.attemptNumber,
      providerKey,
    });
    const dispatchId = providerDispatchIdOf({
      companyId: request.companyId,
      runId: request.runId,
      taskId: request.taskId,
      attemptNumber: request.attemptNumber,
      providerKey,
    });

    /*
     * STAGE 8B §5-§7 — the ROUTING phase. In SMART_ROUTER_V1 mode the Smart
     * Router selects the attempt's model BEFORE any provider side effect: the
     * decision is deterministic, attempt-scoped evidence, and the provider
     * consumes the route verbatim. A routing failure fails the dispatch closed
     * (the same read-only-precondition discipline as the safety preflight) —
     * never a silent fall back to the legacy selector, and never a kernel that
     * chooses its own model.
     */
    const routingMode = deps.routingMode ?? DEFAULT_ROUTING_MODE;
    let routed: RuntimeRoutingOutcome | null = null;
    if (routingMode === 'SMART_ROUTER_V1') {
      if (deps.routeModelOf === undefined) {
        return {
          output: 'failed',
          dispatchId: '',
          providerKey,
          providerSessionId: null,
          state: 'DISPATCHED',
          failure: { stage: null, reason: 'ROUTING_SEAM_UNAVAILABLE', code: 'VALIDATION_FAILED' },
        };
      }
      const routing = await deps.routeModelOf({
        attemptId: request.attemptId,
        runId: request.runId,
        taskId: request.taskId,
        roleId: request.roleId,
        attemptNumber: request.attemptNumber,
      });
      if (!routing.ok) {
        return {
          output: 'failed',
          dispatchId: '',
          providerKey,
          providerSessionId: null,
          state: 'DISPATCHED',
          failure: {
            stage: null,
            reason: String(routing.error.details['reason'] ?? routing.error.code ?? 'MODEL_ROUTING_FAILED'),
            code: routing.error.code,
          },
        };
      }
      routed = routing.value;
    }

    /*
     * STAGE 8B §11-§12 — the ROLE CONTEXT phase. The bounded envelope is
     * projected from canonical durable truth (including ACCEPTED durable
     * handoffs) and travels with the request; the provider renders it as data.
     * A projection failure fails the dispatch closed.
     */
    let roleContext: ProviderRoleContext | null = null;
    if (deps.roleContextOf !== undefined) {
      const projected = await deps.roleContextOf({
        runId: request.runId,
        taskId: request.taskId,
        roleId: request.roleId,
        attemptModelLabel: routed === null ? null : `${routed.decision.selectedModel.modelProfileId}@${String(routed.decision.selectedModel.configurationVersion)}`,
      });
      if (!projected.ok) {
        return {
          output: 'failed',
          dispatchId: '',
          providerKey,
          providerSessionId: null,
          state: 'DISPATCHED',
          failure: {
            stage: null,
            reason: String(projected.error.details['reason'] ?? projected.error.code ?? 'ROLE_CONTEXT_PROJECTION_FAILED'),
            code: projected.error.code,
          },
        };
      }
      roleContext = projected.value;
    }

    const claimed = await deps.dispatches.claim({
      id: dispatchId,
      companyId: request.companyId,
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      attemptNumber: request.attemptNumber,
      providerKey,
      dispatchKey,
      providerSessionId: null,
      providerInvocationId: null,
      configFingerprint: verdict.configFingerprint,
      // STAGE 8B: the routing decision evidence rides the SAME per-attempt
      // durable owner (null = the legacy DETERMINISTIC_V1 path).
      routingDecisionJson: routed === null ? null : routed.evidenceJson,
      state: 'DISPATCHED',
      resultSummary: null,
      createdAt: now,
      updatedAt: now,
    });
    if (!claimed.ok) throw new Error(claimed.error.message);

    // Recovery/continuation: a previously PUBLISHED external identity resumes
    // the SAME external run instead of minting a new one (§26).
    const existing = await deps.dispatches.get(dispatchId);
    /*
     * STAGE 8B §16 — an attempt NEVER switches models internally. A replayed
     * dispatch (the same attempt+provider) carries the SAME recorded routing
     * decision; a recomputation that disagrees with the durable evidence is an
     * attempt-internal re-route and is refused (the remedy is a NEW attempt
     * with its own RoutingDecision, never a mid-attempt substitution).
     */
    if (routed !== null && existing !== null && existing.routingDecisionJson !== null && existing.routingDecisionJson !== routed.evidenceJson) {
      await deps.dispatches.markUncertain(
        dispatchId,
        'ATTEMPT_ROUTE_CONFLICT: the durable routing decision differs from the recomputed one',
        deps.clock.nowIso(),
      );
      return {
        output: 'failed',
        dispatchId,
        providerKey,
        providerSessionId: existing.providerSessionId,
        state: 'UNCERTAIN',
        failure: { stage: null, reason: 'ATTEMPT_ROUTE_CONFLICT', code: 'CONFLICT' },
      };
    }
    /*
     * Safe-replay rule (§16/§17/§20): a binding in PUBLISHED or UNCERTAIN means a
     * previous invocation MAY have run without a proven settlement. Re-invoking — even
     * into the SAME session — could duplicate side effects, so this dispatch refuses.
     * Session continuation stays available for DELIBERATE new work (§21) through
     * continuationSessionId on a NEW request; it is never auto-replay labelled recovery.
     */
    if (existing !== null && (existing.state === 'PUBLISHED' || existing.state === 'UNCERTAIN')) {
      await deps.dispatches.markUncertain(dispatchId, 'previous invocation outcome unproven; no automatic replay', deps.clock.nowIso());
      return {
        output: 'failed',
        dispatchId,
        providerKey,
        providerSessionId: existing.providerSessionId,
        state: 'UNCERTAIN',
        failure: { stage: null, reason: 'PROVIDER_DISPATCH_REPLAY_REFUSED', code: 'CONFLICT' },
      };
    }
    /*
     * Config-drift safety (§21): a frozen attempt never silently picks up a
     * changed configuration. The remedy is an explicit new attempt, never a
     * substitution of the environment a durable attempt ran under.
     */
    if (existing !== null && verdict.configFingerprint !== null) {
      const drift = assertConfigUnchanged(existing.configFingerprint, verdict.configFingerprint);
      if (!drift.ok) {
        await deps.dispatches.markUncertain(
          dispatchId,
          `EXECUTOR_CONFIG_DRIFT: ${String(drift.error.details['reason'] ?? 'drift')}`,
          deps.clock.nowIso(),
        );
        return {
          output: 'failed',
          dispatchId,
          providerKey,
          providerSessionId: existing.providerSessionId,
          state: 'UNCERTAIN',
          failure: {
            stage: 'config-valid',
            reason: String(drift.error.details['reason'] ?? 'EXECUTOR_CONFIG_DRIFT'),
            code: drift.error.code,
          },
        };
      }
      if (existing.configFingerprint === null) {
        // A binding from before the fingerprint field existed: unknown provenance
        // is not proven drift, so the resume proceeds (Sprint24 parity) and the
        // current fingerprint is recorded so the NEXT resume can compare.
        const recorded = await deps.dispatches.recordConfigFingerprint(
          dispatchId,
          verdict.configFingerprint,
          deps.clock.nowIso(),
        );
        if (!recorded.ok) throw new Error(recorded.error.message);
      }
    }
    const continuationSessionId = request.continuationSessionId;

    const baseWorkText =
      envelope !== undefined
        ? envelope.value.objective
        : await (deps.workPackageTextOf?.(request.runId, request.taskId) ?? Promise.resolve(null));
    /*
     * STAGE E3-C — retry continuation envelope: a NEW attempt of a previously failed
     * task carries BOUNDED derived context (prior failure, activity summary, workspace
     * reuse directive). First attempts get no retry context. The directive is appended
     * to the work objective so the executor receives it as an instruction; the
     * envelope itself rides the request as typed data. Derived only — never truth.
     */
    const retryEnvelope = deps.retryContextOf === undefined
      ? null
      : deps.retryContextOf({runId: request.runId, taskId: request.taskId, attemptNumber: request.attemptNumber});
    const workText = retryEnvelope === null ? baseWorkText : `${baseWorkText ?? `Execute task kind ${request.taskKind}.`}

${renderRetryDirective(retryEnvelope)}`;
    const taskInputs =
      envelope !== undefined && envelope.value.taskInputs !== undefined
        ? envelope.value.taskInputs
        : deps.taskInputsOf === undefined
          ? null
          : await deps.taskInputsOf(request.runId, request.taskId);
    /*
     * The cwd is the value the preflight PROVED (canonical, contained, existing),
     * and the root it proved it against travels with it — never the raw string a
     * resolver handed back, and never a cwd without its root.
     */
    const trustedCwd = verdict.canonicalCwd;
    const trustedRoot = verdict.canonicalRoot;
    // STAGE 8B §17 — the role execution budget enters the kernel execution
    // policy as the request timeout (the time budget is the one limit the
    // kernel enforces itself); turn/tool budgets are enforced against the
    // outcome usage below.
    const selectedModelRoute: SelectedModelRoute | undefined = routed === null ? undefined : routed.route;
    /*
     * LIVE-SMOKE-FIX-02 — the CompanyOS-owned attempt budget: an explicit Role
     * timeBudgetMs wins; otherwise the composition's resolved production level
     * (deployment override, else the 600s CompanyOS default) is ALWAYS passed
     * explicitly. The provider's internal 120s fallback is defensive-only and the
     * shipped production composition never depends on it.
     */
    const timeoutMs = routed === null
      ? deps.attemptTimeoutMs
      : (routed.roleBudget.timeBudgetMs ?? deps.attemptTimeoutMs);
    /*
     * LIVE-SMOKE-FIX-08 P1-2 — DURABLE PRE-DISPATCH ATTRIBUTION. Appended BEFORE
     * the external launch: attempt/task/role identity, provider + dispatch identity,
     * the proven cwd, the resolved timeout, and a SAFE command representation (the
     * work text fingerprint + bounded head, redacted). A timeout/kill/crash after
     * this point can never lose WHO dispatched WHAT to WHICH executable.
     */
    const dispatchStartedAt = deps.clock.nowIso();
    const taskTextForLaunch = workText ?? `Execute task kind ${request.taskKind}.`;
    if (deps.dispatchAudit !== undefined) {
      const audit = deps.dispatchAudit;
      const secrets = audit.secrets();
      const requestedEvent = createCoreDomainEvent(
        'executor.dispatch_requested',
        {type: 'ExecutionAttempt', id: request.attemptId},
        {
          attemptId: request.attemptId,
          attemptNumber: request.attemptNumber,
          taskId: request.taskId,
          runId: request.runId,
          roleId: request.roleId,
          taskKind: request.taskKind,
          providerKey,
          dispatchId,
          dispatchKey,
          cwd: trustedCwd,
          timeoutMs: timeoutMs ?? null,
          continuationSessionId: continuationSessionId ?? null,
          taskTextSha256: createHash('sha256').update(taskTextForLaunch).digest('hex'),
          taskTextLength: taskTextForLaunch.length,
          taskTextHead: redactSecrets(taskTextForLaunch.slice(0, 300), secrets),
          configFingerprint: verdict.configFingerprint ?? null,
          requestedAt: dispatchStartedAt,
        },
        {traceId: `trace_${dispatchKey}`, actorId: 'system:provider-dispatch', now: dispatchStartedAt, ids: audit.ids},
      );
      await audit.append([requestedEvent]);
    }
    const failed = async (reason: string, _message: string, cause?: string): Promise<ProviderDispatchExecutionResult> => {
      // H15c: the typed cause (e.g. GOAL_ADMISSION_BOUND_UNPROVEN) is kept on the durable
      // dispatch row — a refusal must say WHY (it was swallowed in hark-live-goal 40263437730).
      await deps.dispatches.settle(dispatchId, `NOT_INVOKED:${reason}${cause === undefined ? '' : `(${cause})`}`, deps.clock.nowIso());
      return { output: 'failed', dispatchId, providerKey, providerSessionId: null, state: 'SETTLED', failure: { stage: null, reason, code: 'POLICY_DENIED' } };
    };
    if (deps.prepareExternalAdmission !== undefined && provider.supportsCallAdmission !== true) return failed('EXECUTOR_COST_ADMISSION_UNSUPPORTED', 'The selected executor has no verified per-call budget gate.');
    let externalAdmission;
    try { externalAdmission = await deps.prepareExternalAdmission?.(request, selectedModelRoute); }
    catch (error) { return failed('GOAL_ADMISSION_REFUSED', 'Durable external execution admission was refused.', admissionCauseOf(error)); }
    let outcome;
    try {
    const fileDeliveryGoalRunId = await deps.fileDeliveryGoalOf?.(request.runId);
    if (externalAdmission?.signal.aborted === true) return failed('GOAL_CANCEL_REQUESTED', 'Execution was cancelled before provider start.');
    outcome = await provider.start({
      ...(externalAdmission === undefined ? {} : { modelCallAdmission: externalAdmission.admitBody, signal: externalAdmission.signal, ...(externalAdmission.inputUpperBoundBytes === undefined ? {} : { modelCallInputBoundBytes: externalAdmission.inputUpperBoundBytes }) }),
      companyId: request.companyId,
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      attemptNumber: request.attemptNumber,
      roleId: request.roleId,
      taskKind: request.taskKind,
      work: {
        ...(fileDeliveryGoalRunId == null ? {} : { fileDeliveryGoalRunId }),
        objective: workText ?? `Execute task kind ${request.taskKind}.`,
        ...(envelope !== undefined && envelope.value.memoryView !== undefined
          ? { memoryView: envelope.value.memoryView }
          : {}),
        ...(envelope !== undefined && envelope.value.artifactRefs !== undefined
          ? { artifactRefs: envelope.value.artifactRefs }
          : {}),
        ...(taskInputs === null || taskInputs === undefined ? {} : { taskInputs }),
        ...(envelope !== undefined && envelope.value.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: envelope.value.acceptanceCriteria }
          : {}),
        ...(envelope !== undefined && envelope.value.goalStructured !== undefined
          ? { goalStructured: envelope.value.goalStructured }
          : {}),
        ...(retryEnvelope === null ? {} : { retry: retryEnvelope }),
        ...(roleContext === null ? {} : { roleContext }),
      },
      workspace: trustedCwd === null || trustedRoot === null ? null : { cwd: trustedCwd, root: trustedRoot },
      requiredCapabilities: required,
      dispatchKey,
      taskText: workText ?? `Execute task kind ${request.taskKind}.`,
      structured: required.includes('structured-output'),
      // STAGE 8B §5-§7: the CompanyOS-selected route travels with the attempt;
      // the provider consumes it verbatim and never re-selects.
      ...(selectedModelRoute === undefined ? {} : { selectedModelRoute }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(continuationSessionId === undefined ? {} : { continuationSessionId }),
    });
    } finally { externalAdmission?.release(); }
    if (externalAdmission?.signal.aborted) {
      await deps.dispatches.markUncertain(dispatchId, 'GOAL_STOP_REMOTE_RESULT_UNKNOWN', deps.clock.nowIso());
      return { output: 'failed', dispatchId, providerKey, providerSessionId: null, state: 'UNCERTAIN', failure: { stage: null, reason: 'GOAL_STOP_REMOTE_RESULT_UNKNOWN', code: 'CANCELLED' } };
    }

    const settleAt = deps.clock.nowIso();
    if (deps.dispatchAudit !== undefined) {
      const audit = deps.dispatchAudit;
      const secrets = audit.secrets();
      const settledPayload: Record<string, unknown> = {
        attemptId: request.attemptId,
        dispatchId,
        providerKey,
        outcome: outcome.kind,
        durationMs: Date.parse(settleAt) - Date.parse(dispatchStartedAt),
        providerSessionId: (outcome as {providerSessionId?: string}).providerSessionId ?? null,
        settledAt: settleAt,
      };
      if (outcome.kind === 'timeout') {
        settledPayload['terminationProven'] = outcome.terminationProven;
        const tail = outcome.stdoutText ?? '';
        settledPayload['stdoutTail'] = redactSecrets(tail.slice(-2000), secrets);
        settledPayload['stdoutTailLength'] = tail.length;
      }
      if (outcome.kind === 'provider-failed') {
        settledPayload['exitCode'] = outcome.exitCode;
        settledPayload['stderrHead'] = redactSecrets(outcome.stderrText.slice(0, 500), secrets);
      }
      if (outcome.kind === 'transport-failed') {
        settledPayload['reasonCode'] = outcome.reasonCode;
      }
      const settledEvent = createCoreDomainEvent(
        'executor.dispatch_settled',
        {type: 'ExecutionAttempt', id: request.attemptId},
        settledPayload,
        {traceId: `trace_${dispatchKey}`, actorId: 'system:provider-dispatch', now: settleAt, ids: audit.ids},
      );
      await audit.append([settledEvent]);
    }
    if (outcome.kind === 'succeeded') {
      /*
       * STAGE 8B §17 — ROLE EXECUTION BUDGET enforcement. The provider ran
       * under the role budget (timeout + usage); when the turn/tool/token
       * budget is exhausted the attempt ends STRUCTURED as
       * ROLE_EXECUTION_BUDGET_EXHAUSTED — never an infinite loop, and what was
       * already produced stays durable (the progress summary is materialized
       * as a canonical artifact below before the verdict is taken).
       */
      if (routed !== null) {
        const verdictBudget = budgetVerdictOf(routed.roleBudget, attemptUsageOf(outcome.structured));
        if (verdictBudget.exhausted) {
          const progress = `ROLE_EXECUTION_BUDGET_EXHAUSTED:${String(verdictBudget.reason)}`;
          if (deps.materializeArtifactOf !== undefined) {
            await deps.materializeArtifactOf({
              runId: request.runId,
              taskId: request.taskId,
              attemptId: request.attemptId,
              content: progress,
            });
          }
          await deps.dispatches.markUncertain(dispatchId, progress, settleAt);
          return {
            output: 'failed',
            dispatchId,
            providerKey,
            providerSessionId: outcome.providerSessionId ?? null,
            state: 'UNCERTAIN',
            failure: { stage: null, reason: 'ROLE_EXECUTION_BUDGET_EXHAUSTED', code: 'LIMIT_EXCEEDED' },
          };
        }
      }
      if (outcome.providerSessionId !== undefined) {
        await deps.dispatches.publish(dispatchId, outcome.providerSessionId, settleAt);
      }
      await deps.dispatches.settle(dispatchId, outcome.kind, settleAt);
      const structured = outcome.structured as Readonly<Record<string, unknown>> | undefined;
      const finalText =
        structured !== undefined && typeof structured['finalText'] === 'string'
          ? String(structured['finalText'])
          : outcome.stdoutText;
      /*
       * Final Readiness Gate — canonical artifact materialization for a DECLARED
       * provider output (`structured.artifactContent`, the frozen convention the
       * generic executor handler already uses). The composition's seam calls the ONE
       * Sprint-13 artifact service (Option-B idempotent command), and only the
       * canonical reference enters the settled envelope — never a provider-authored
       * row, never file content in the envelope. A materialization failure fails the
       * dispatch honestly (the engine settles the attempt FAILED).
       */
      let artifactRefs: string[] = [];
      let validationRefs: readonly string[] = [];
      const declaredRequirements = envelope?.value.goalStructured?.['fileDeliveries'];
      const requiresFiles = Array.isArray(declaredRequirements) && declaredRequirements.some((item: unknown) => typeof item === 'object' && item !== null && envelope?.value.acceptanceCriteria?.some((criterion) => criterion.criterionId === (item as Record<string, unknown>)['criterionId']));
      if (requiresFiles) {
        if (deps.verifyFileDeliveryOf === undefined) return { output: 'failed', dispatchId, providerKey, providerSessionId: outcome.providerSessionId ?? null, state: 'SETTLED', failure: { stage: null, reason: 'FILE_DELIVERY_VERIFIER_UNAVAILABLE', code: 'VALIDATION_FAILED' } };
        const delivery = await deps.verifyFileDeliveryOf({ runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, finalText });
        if (!delivery.ok) return { output: 'failed', dispatchId, providerKey, providerSessionId: outcome.providerSessionId ?? null, state: 'SETTLED', failure: { stage: null, reason: String(delivery.error.details['reason'] ?? delivery.error.code), code: delivery.error.code } };
        if (delivery.value.artifactRefs.length === 0 || delivery.value.validationRefs.length === 0) return { output: 'failed', dispatchId, providerKey, providerSessionId: null, state: 'SETTLED', failure: { stage: null, reason: 'FILE_DELIVERY_EVIDENCE_EMPTY', code: 'VALIDATION_FAILED' } };
        artifactRefs = [...delivery.value.artifactRefs]; validationRefs = delivery.value.validationRefs;
      }
      if (
        deps.materializeArtifactOf !== undefined &&
        structured !== undefined &&
        typeof structured['artifactContent'] === 'string' &&
        structured['artifactContent'].length > 0
      ) {
        const materialized = await deps.materializeArtifactOf({
          runId: request.runId,
          taskId: request.taskId,
          attemptId: request.attemptId,
          content: String(structured['artifactContent']),
        });
        if (!materialized.ok) {
          return {
            output: 'failed',
            dispatchId,
            providerKey,
            providerSessionId: outcome.providerSessionId ?? null,
            state: 'SETTLED',
            failure: {
              stage: null,
              reason: String(materialized.error.details['reason'] ?? materialized.error.code ?? 'ARTIFACT_MATERIALIZATION_FAILED'),
              code: materialized.error.code,
            },
          };
        }
        if (!requiresFiles) artifactRefs = [materialized.value.artifactId];
      }
      /*
       * STAGE 8B §3 — the producer's durable output becomes a DURABLE CANONICAL
       * HANDOFF for the consumer role (existing Sprint-11 owner: refs, criteria,
       * risks and questions — never a raw transcript). The consumer later reads
       * it through the Work Package projection, so a restarted process
       * reconstructs the identical context from durable truth. A handoff write
       * failure fails the dispatch honestly (the engine settles FAILED).
       */
      if (deps.recordHandoffOf !== undefined) {
        const handoff = await deps.recordHandoffOf({
          runId: request.runId,
          taskId: request.taskId,
          attemptId: request.attemptId,
          producerRoleId: request.roleId,
          objective: workText ?? `Execute task kind ${request.taskKind}.`,
          artifactRefs,
          validationRefs,
        });
        if (!handoff.ok) {
          await deps.dispatches.markUncertain(
            dispatchId,
            String(handoff.error.details['reason'] ?? handoff.error.code ?? 'HANDOFF_RECORD_FAILED'),
            settleAt,
          );
          return {
            output: 'failed',
            dispatchId,
            providerKey,
            providerSessionId: outcome.providerSessionId ?? null,
            state: 'UNCERTAIN',
            failure: {
              stage: null,
              reason: String(handoff.error.details['reason'] ?? handoff.error.code ?? 'HANDOFF_RECORD_FAILED'),
              code: handoff.error.code,
            },
          };
        }
      }
      return {
        output: {
          status: 'succeeded' as const,
          output: {
            schemaVersion: 'companyos/stage-output/1',
            kind: 'companyos:work-role-work',
            executionId: request.attemptId,
            artifactRefs,
            validationRefs,
            payload: { providerKey, finalText, providerSessionId: outcome.providerSessionId ?? null },
          },
        },
        dispatchId,
        providerKey,
        providerSessionId: outcome.providerSessionId ?? null,
        state: 'SETTLED',
      };
    }
    if (outcome.kind === 'provider-failed' || outcome.kind === 'transport-failed') {
      if (outcome.kind === 'provider-failed' && outcome.providerSessionId !== undefined) {
        await deps.dispatches.publish(dispatchId, outcome.providerSessionId, settleAt);
      }
      await deps.dispatches.markUncertain(dispatchId, outcome.kind, settleAt);
      return {
        output: 'failed',
        dispatchId,
        providerKey,
        providerSessionId: outcome.providerSessionId ?? null,
        state: 'UNCERTAIN',
        failure: { stage: null, reason: outcome.kind, code: 'CONFLICT' },
      };
    }
    // cancelled / timeout / uncertain: honest non-proof of external termination.
    await deps.dispatches.markUncertain(dispatchId, outcome.kind, settleAt);
    return {
      output: 'failed',
      dispatchId,
      providerKey,
      providerSessionId: outcome.providerSessionId ?? null,
      state: 'UNCERTAIN',
      failure: { stage: null, reason: outcome.kind, code: 'INTERRUPTED' },
    };
  };

  return { execute };
};

export type ProviderDispatchExecution = ReturnType<typeof createProviderDispatchExecution>;
export type { CoreServices };

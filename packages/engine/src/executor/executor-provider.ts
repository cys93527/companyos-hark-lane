/**
 * Sprint24 — the CompanyOS-native EXECUTOR PROVIDER CONTRACT (the registered
 * Sprint23 reference: capability seam Service Definition → Provider → Consumer, translated
 * as ExecutorProvider contract → implementation → engine consumer).
 *
 * This module is the CONTRACT only: vendor-neutral, industry-neutral, no process
 * code, no workflow authority. The engine consumer depends on this contract —
 * never on a concrete vendor implementation (those live in the
 * composition, outside the engine's vendor-name-free boundary).
 *
 * Ownership invariants (Sprint24 §20/§21/§22): Task remains the work-lifecycle
 * owner; ExecutionAttempt remains the attempt owner (the provider binding is
 * SUBORDINATE to it); AgentExecution stays model provenance; a provider NEVER
 * chooses Task/Run/Attempt/WorkflowVersion identities — it RECEIVES them.
 */
import { canonicalJson, sha256Hex, type InvocationResult } from '@companyos/core';

/* ---------------------------------------------------------------- capabilities */

/**
 * The closed capability vocabulary (the Sprint23 reference: providers advertise
 * capabilities before execution; an unsupported requested capability FAILS LOUD).
 * A provider advertises ONLY what it truly supports — never a silent degrade.
 */
export const EXECUTOR_CAPABILITY_NAMES = [
  'cancellation',
  'timeout',
  'structured-output',
  'working-directory',
  'environment-inputs',
  'provider-idempotency',
  'external-session-identity',
  'external-invocation-identity',
  'status-query',
  'session-continuation',
  'same-invocation-recovery',
  'stdin',
  'streaming-diagnostics',
] as const;

export type ExecutorCapabilityName = (typeof EXECUTOR_CAPABILITY_NAMES)[number];

/** What one implementation provider truly supports. */
export interface ExecutorProviderDescriptor {
  /** Stable implementation key of the registered adapter — never a workflow semantic. */
  readonly providerKey: string;
  readonly capabilities: readonly ExecutorCapabilityName[];
}

/* -------------------------------------------------------------------- request */

/**
 * The bounded work projection handed to a provider (trusted CompanyOS input).
 *
 * This IS the Agentic Work Envelope (Agentic Work Package Contract closeout): the
 * bounded, derived projection of ONE task's canonical work semantics — objective,
 * acceptance criteria, typed inputs, read-only references and rendered context.
 * Everything an executor may SEE; nothing it may OWN. Sourced from the Work Package
 * projection (pinned-version node config + run-owned goal + Task.inputs +
 * pinned-DAG predecessor results); the composition owns the mapping.
 */
export interface ExecutorWorkInput {
  /** Canonical planning Run identity for a file declaration; not a new Goal id. */
  readonly fileDeliveryGoalRunId?: string;
  readonly objective: string;
  /** Rendered bounded context (e.g. the Work Package projection), if any. */
  readonly memoryView?: readonly string[];
  readonly artifactRefs?: readonly string[];
  /**
   * The canonical immutable Task.inputs (Native Execution Foundation §5): TYPED,
   * trusted creation data a deterministic provider may consume as DATA arguments —
   * never executable authority, and never a substitute for the deployment-owned
   * operation profile. Additive optional: agentic providers ignore it.
   */
  readonly taskInputs?: Readonly<Record<string, unknown>>;
  /**
   * STAGE E3 — derived retry continuation envelope (non-canonical context): present
   * only when this attempt is a retry of the same canonical task. Bounded prior
   * failure/activity summary + workspace-reuse directive data; never authority.
   */
  readonly retry?: unknown;
  /**
   * The pinned acceptance criteria for this work (Agentic Work Package Contract):
   * byte-exact references the executor may self-check against. Additive optional,
   * the same discipline as `taskInputs`. Knowing the standard is not owning it —
   * validation authority stays with CompanyOS Validation/Settlement, never the
   * provider.
   */
  readonly acceptanceCriteria?: readonly {
    readonly criterionId: string;
    readonly requirement: string;
  }[];
  /**
   * The run-owned canonical goal's bounded structured constraints (Final Readiness
   * Gate): human-supplied at goal ingress — scope, parameters, resource lists,
   * output requirements. The canonical owner is the run-goal artifact; this is the
   * derived transport view, byte-exact. Additive optional, the same discipline as
   * `taskInputs`. A MODEL never authors this field (ARCH-039: model text is not
   * executable authority).
   */
  readonly goalStructured?: Readonly<Record<string, unknown>>;
  /**
   * STAGE 8B — the ROLE CONTEXT this attempt executes under, projected from the
   * canonical sources (goal, plan item, task, role responsibility, canonical
   * decisions, artifact/evidence refs, acceptance criteria, known risks, the
   * attempt's selected model). Additive optional, the same discipline as
   * `taskInputs`: the provider renders it as data and NEVER authors it. The
   * shape structurally excludes raw producer transcripts and hidden reasoning —
   * only bounded professional summaries travel.
   */
  readonly roleContext?: ProviderRoleContext;
}

/**
 * STAGE 8B — the bounded role context summary a provider receives (and renders
 * into the kernel invocation). Refs and summaries only: there is deliberately
 * no transcript, reasoning or message field.
 */
export interface ProviderRoleContext {
  readonly roleName: string;
  readonly professionalResponsibility: string;
  readonly hardConstraints: readonly string[];
  readonly relevantDecisionSummaries: readonly string[];
  readonly knownRisks: readonly string[];
  readonly remainingQuestions: readonly string[];
  /** The attempt's CompanyOS-selected model as a label — evidence, never a re-selection seam. */
  readonly attemptModelLabel: string | null;
  readonly envelopeSizeBytes: number;
}

/**
 * STAGE 8B — the COMPANYOS-SELECTED model route for ONE ExecutionAttempt.
 * CompanyOS (the application layer, through the Stage 8 Smart Router) is the
 * only selection authority: a provider CONSUMES this route and must never
 * re-score, re-fallback or re-route. `credentialRef` is the SecretVault
 * POINTER (never a raw key); the model broker resolves it upstream so the
 * value never enters kernel-visible config or env.
 */
export interface SelectedModelRoute {
  readonly modelProfileId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly baseURL: string;
  /** The SecretVault POINTER — the auditable, persistable identity of the credential. */
  readonly credentialRef: string;
  /**
   * SMART-ROUTER-PROD-01: the CompanyOS process's IN-MEMORY resolution of
   * `credentialRef`, attached by the composition so the loopback broker can inject
   * the real credential upstream. NEVER persisted, never logged, never part of the
   * RoutingDecision evidence — the request object carries it only for the provider
   * boundary of THIS attempt.
   */
  readonly credentialValue?: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly configurationVersion: number;
}

/**
 * A provider request is DERIVED from trusted CompanyOS inputs. Canonical
 * identities are INPUTS: the provider cannot choose, mint or reinterpret them.
 */
export interface ExecutorExecutionRequest {
  /** ADR-A: trusted transport admission, not a model/kernel-authored budget. */
  readonly modelCallAdmission?: (body: Uint8Array) => Promise<{
    readonly signal: AbortSignal;
    settle(usage: InvocationResult['usage'] | null): Promise<void>;
    release(): void;
  }>;
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly roleId: string;
  readonly taskKind: string;
  readonly work: ExecutorWorkInput;
  /**
   * Trusted working directory; null when the provider does not use one.
   *
   * `root` (Sprint25) is the trusted workspace root the `cwd` must be contained in,
   * as PROVEN by the dispatch safety preflight — a generic process provider cannot
   * know a run's workspace on its own, so the caller carries both the canonical root
   * and the canonical cwd it derived from it.
   */
  readonly workspace: { readonly cwd: string; readonly root?: string } | null;
  /** Must be a subset of the provider's capabilities (checked BEFORE dispatch). */
  readonly requiredCapabilities: readonly ExecutorCapabilityName[];
  /** Deterministic dispatch identity for THIS attempt+provider (see dispatchKeyOf). */
  readonly dispatchKey: string;
  /** The one-task text (never secrets). */
  readonly taskText: string;
  readonly structured: boolean;
  readonly timeoutMs?: number;
  /**
   * STAGE 8B — the CompanyOS-selected model route for THIS attempt (the Smart
   * Router's decision, attached before the kernel is invoked). When present the
   * provider MUST consume it verbatim: re-selecting, re-scoring or silently
   * substituting a different profile is an attempt-internal model switch and is
   * forbidden (Stage 7B/Stage 8B). Absent = the deployment runs the legacy
   * DETERMINISTIC_V1 selection path with its own configured selection.
   */
  readonly selectedModelRoute?: SelectedModelRoute;
  /**
   * DELIBERATE session continuation (§21): submitting NEW work into the same durable
   * provider session. An explicit caller decision for semantically-new work — NEVER an
   * automatic "recovery" of an uncertain previous invocation (§20).
   */
  readonly continuationSessionId?: string;
  readonly signal?: AbortSignal;
}

/* ---------------------------------------------------------------------- result */

/**
 * The typed provider outcome taxonomy (the Sprint23 reference: fail-loud; nothing
 * collapses into Error(string)). `uncertain` is a first-class truth: a crash
 * window or unprovable termination may leave the external outcome UNKNOWN, and
 * CompanyOS must represent that honestly — never fabricate success.
 */
export type ExecutorProviderOutcome =
  | {
      readonly kind: 'succeeded';
      readonly exitCode: number;
      /**
       * Provider-owned DURABLE SESSION identity (a conversation that may carry many turns)
       * — bound only from real provider evidence, never manufactured, and NEVER a claim
       * of one exact invocation (§7).
       */
      readonly providerSessionId?: string;
      readonly stdoutText: string;
      /** Parsed structured payload when negotiated (validated by the trusted contract). */
      readonly structured?: unknown;
      readonly startedAt: string;
      readonly finishedAt: string;
    }
  | {
      readonly kind: 'provider-failed';
      readonly exitCode: number;
      readonly stdoutText: string;
      readonly stderrText: string;
      readonly reasonCode?: string;
      readonly providerSessionId?: string;
    }
  | {
      readonly kind: 'transport-failed';
      readonly reasonCode: string;
      readonly detail: string;
      readonly providerSessionId?: string;
    }
  | {
      readonly kind: 'cancelled';
      /** True ONLY when the provider proved termination (exit evidence). */
      readonly terminationProven: boolean;
      readonly providerSessionId?: string;
    }
  | {
      readonly kind: 'timeout';
      /** Timeout requests cancellation; it does NOT prove external work stopped. */
      readonly terminationProven: boolean;
      readonly providerSessionId?: string;
      /**
       * LIVE-SMOKE-FIX-08 P1-2 — the output captured BEFORE the timeout kill
       * (bounded, truncation-marked). A killed attempt stays attributable: the
       * Smoke-07 forensics lost the final tool commands precisely because the
       * timeout outcome dropped the already-captured transcript. Diagnostic
       * evidence only — the ExecutionAttempt row remains the canonical truth.
       */
      readonly stdoutText?: string;
    }
  | {
      readonly kind: 'uncertain';
      readonly reason: string;
      readonly providerSessionId?: string;
    };

/* ------------------------------------------------------------------- provider */

export interface ExecutorProvider {
  /** Trusted adapter code attests ALL external model calls consume the provided gate. */
  readonly supportsCallAdmission?: true;
  readonly descriptor: ExecutorProviderDescriptor;
  /**
   * One external execution. `start` is invoked ONLY after the canonical
   * ExecutionAttempt claim is durable and OUTSIDE any SQLite write transaction;
   * the returned outcome feeds the EXISTING engine settlement — it never
   * settles a Task itself.
   */
  start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome>;
}

/* ---------------------------------------------------------------- capability law */

/**
 * The capability contract (§11): required ⊆ provider, checked BEFORE any
 * external invocation. A mismatch is a typed NON-RETRYABLE error — never
 * "provider doesn't support resume, so silently start a new one".
 */
export const assertExecutorCapabilities = (
  required: readonly ExecutorCapabilityName[],
  provider: ExecutorProviderDescriptor,
): { supported: true } | { supported: false; missing: readonly ExecutorCapabilityName[] } => {
  const provided = new Set<string>(provider.capabilities);
  const missing = required.filter((capability) => !provided.has(capability));
  return missing.length === 0 ? { supported: true } : { supported: false, missing };
};

/* ------------------------------------------------------- deterministic dispatch */

/**
 * The deterministic dispatch identity (§22): derived from the canonical
 * ExecutionAttempt identity + provider key. The SAME attempt re-dispatched to
 * the SAME provider always derives the SAME key; different attempts never
 * share one. Random idempotency keys are forbidden for retry/recovery of the
 * same attempt.
 */
export const providerDispatchKeyOf = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly providerKey: string;
}): string =>
  `dsp_${sha256Hex(
    canonicalJson({
      purpose: 'companyos/provider-dispatch/1',
      companyId: input.companyId,
      runId: input.runId,
      taskId: input.taskId,
      attemptNumber: input.attemptNumber,
      providerKey: input.providerKey,
    }),
  ).slice(0, 26)}`;

/** The durable dispatch row identity (same seed as the dispatch key). */
export const providerDispatchIdOf = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly providerKey: string;
}): string =>
  `pdi_${sha256Hex(
    canonicalJson({
      purpose: 'companyos/provider-dispatch-id/1',
      companyId: input.companyId,
      runId: input.runId,
      taskId: input.taskId,
      attemptNumber: input.attemptNumber,
      providerKey: input.providerKey,
    }),
  ).slice(0, 26)}`;

/* -------------------------------------------------------------------- registry */

/**
 * The provider registry (the Sprint23 reference: named providers behind one
 * registry) — IMPLEMENTATION AUTHORITY ONLY. It answers "which providers
 * exist / what capabilities do they support". It must never answer what Task
 * runs next, what a stage means, whether a Run is complete or what result is
 * canonical (§44) — this module imports no run/task/lifecycle machinery.
 */
export interface ExecutorProviderRegistry {
  describeAll(): readonly ExecutorProviderDescriptor[];
  resolve(providerKey: string): ExecutorProvider | null;
}

export const createExecutorProviderRegistry = (
  providers: readonly ExecutorProvider[],
): ExecutorProviderRegistry => {
  const byKey = new Map<string, ExecutorProvider>();
  for (const provider of providers) {
    const existing = byKey.get(provider.descriptor.providerKey);
    if (existing !== undefined && existing !== provider) {
      throw new Error(`duplicate executor provider key "${provider.descriptor.providerKey}"`);
    }
    byKey.set(provider.descriptor.providerKey, provider);
  }
  return {
    describeAll: () => [...byKey.values()].map((provider) => provider.descriptor),
    resolve: (providerKey: string) => byKey.get(providerKey) ?? null,
  };
};

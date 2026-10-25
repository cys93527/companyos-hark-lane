/**
 * The ONE production composition wiring seam (Boss V1 Product Reachability, BB-001).
 *
 * Bug-bash finding BUG-BB-001 (PROVEN P1): the shipped Desktop composition never
 * passed the provider routing options, so no Goal could reach ANY ExecutorProvider
 * through normal product configuration — the abstraction existed, the deployment
 * wiring did not.
 *
 * This module is that wiring, named and shared: the Desktop main process consumes
 * `productionCompositionOptions()` at BOTH core-composition sites, and the
 * production-reachability tests consume the SAME function — there is no
 * test-only routing, no bug-bash-only composition, and no second routing system.
 *
 * Provider-neutral by construction:
 *   - the ROUTED adapter id is a deployment value (`COMPANYOS_EXECUTOR_PROVIDER`,
 *     default `dsh-headless` — the one adapter the repository ships; a deployment
 *     with a different adapter set points the env at its own adapter id);
 *   - Core/Engine semantics contain no vendor name; the route table is the
 *     existing composition seam tests already exercise;
 *   - a missing or unknown adapter fails LOUD at dispatch (typed, fail-closed) —
 *     never a silent mock, never fake execution.
 */
import { fileURLToPath } from 'node:url';
import type { TrustedBudgetProofSource } from './trusted-budget-proof.js';
import type { DeploymentBudgetCap } from './deployment-budget-proof.js';

import type { ComposeCoreServicesOptions } from './core-services.js';
import { GOAL_WORK_KIND, SOFTWARE_WORK_KIND } from './control-plane.js';
import { ModelPool, type ModelProfile } from './executor/model-pool.js';
import { ROUTING_POLICIES } from './executor/smart-model-router.js';
import { resolveOpenAiCompatibleConfig } from './models/openai-compatible-provider.js';

/** The default executor adapter id the composition routes the generic work kind to. */
export const DEFAULT_EXECUTOR_PROVIDER_KEY = 'dsh-headless';

/**
 * DRA-04 — the embedded DSH kernel's managed root as a STABLE deployment resource
 * location: an absolute path anchored on THIS module's own location (source
 * `apps/desktop/src/` and built `apps/desktop/dist/` are both three levels below the
 * repository root), NEVER on the launch working directory. Launching the desktop from
 * `apps/desktop`, from a shortcut, from a service or from any other working
 * directory therefore resolves the SAME runtime; a future packaged build repoints
 * this one seam at its resources directory and keeps the identical manifest
 * contract (no packaging system is implemented or assumed here).
 */
export const productionEmbeddedDshRuntimeRoot = (): string =>
  fileURLToPath(new URL('../../../.companyos-embedded/dsh-runtime', import.meta.url));

/**
 * The executor kinds of the production deployment: the planning kind (its task is
 * settled by the PlannerRuntime turn) and the generic work kind every compiled plan
 * item executes as (Sprint26). Declared deployment data — identical to the frozen
 * E2E deployment shape.
 */
export const PRODUCTION_EXECUTOR_KINDS: readonly string[] = ['companyos:planning', GOAL_WORK_KIND];

/** The env var a deployment uses to point the work kind at its executor adapter. */
export const EXECUTOR_PROVIDER_ENV = 'COMPANYOS_EXECUTOR_PROVIDER';

/** Resolve the production executor route target (deployment value, never renderer input). */
export const productionExecutorRoute = (env: Readonly<Record<string, string | undefined>> = process.env): string => {
  const configured = env[EXECUTOR_PROVIDER_ENV];
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : DEFAULT_EXECUTOR_PROVIDER_KEY;
};

/*
 * SMART-ROUTER-PROD-01 — the production routing wiring.
 *
 * Routing mode is PRODUCT configuration (never a Role/Task/kernel/provider choice):
 * `COS_MODEL_ROUTING_MODE` selects DETERMINISTIC_V1 (the compatible default when
 * unset) or SMART_ROUTER_V1. Under SMART_ROUTER_V1 the composition builds the ONE
 * authoritative ModelPool from the typed adapter configuration (the operator-declared
 * live profile plus any explicitly provided extra profiles) and injects the Stage 8
 * `ModelRoutingPolicyV1` fixture selected by `COS_MODEL_ROUTING_POLICY` (default
 * BALANCED) into the EXISTING routing seam — the algorithm, the fixtures and the
 * per-attempt decision/snapshot ownership are untouched. Traits are never guessed:
 * SMART_ROUTER_V1 without complete operator-declared traits fails the composition
 * loudly (MODEL_ROUTING_PROFILE_INCOMPLETE) instead of filling BALANCED defaults or
 * silently falling back to the deterministic selector.
 *
 * The policies are the Stage 8 tested definitions imported verbatim (no copies, no
 * re-weighting): static, deterministic and versioned.
 */
export type ProductionModelRouting = NonNullable<ComposeCoreServicesOptions['modelRouting']>;

/*
 * LIVE-SMOKE-FIX-02 — the CompanyOS-owned production EXECUTION ATTEMPT time budget.
 *
 * The live smoke proved the work attempt's effective timeout fell through to the DSH
 * provider's hidden 120_000 ms fallback: role execution budgets carry no timeBudgetMs
 * (turn/tool/token budgets only), the dispatch propagated `undefined`, and the
 * provider invented product policy. The effective budget belongs to CompanyOS:
 *
 *   precedence (most specific CompanyOS policy wins):
 *     1. an explicit Role execution budget `timeBudgetMs`   (existing domain object)
 *     2. the optional deployment override
 *        COS_EXECUTION_ATTEMPT_TIMEOUT_MS                    (validated, typed)
 *     3. the CompanyOS production default                    600_000 ms (10 min)
 *   and NEVER the provider's internal fallback — the production dispatch always
 *   passes an explicit resolved timeout; the provider fallback remains defensive
 *   only for malformed direct/internal invocations.
 */
export const DEFAULT_EXECUTION_ATTEMPT_TIMEOUT_MS = 600_000;
export const EXECUTION_ATTEMPT_TIMEOUT_ENV = 'COS_EXECUTION_ATTEMPT_TIMEOUT_MS';
export const EXECUTION_ATTEMPT_TIMEOUT_MIN_MS = 30_000;
export const EXECUTION_ATTEMPT_TIMEOUT_MAX_MS = 3_600_000;

/** Resolve the deployment-level attempt timeout (typed fail-loud; never clamped). */
export const resolveExecutionAttemptTimeoutMs = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): number => {
  const raw = env[EXECUTION_ATTEMPT_TIMEOUT_ENV]?.trim() ?? '';
  if (raw === '') return DEFAULT_EXECUTION_ATTEMPT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < EXECUTION_ATTEMPT_TIMEOUT_MIN_MS || parsed > EXECUTION_ATTEMPT_TIMEOUT_MAX_MS) {
    throw new Error(
      `${EXECUTION_ATTEMPT_TIMEOUT_ENV} must be an integer between ${String(EXECUTION_ATTEMPT_TIMEOUT_MIN_MS)} and ${String(EXECUTION_ATTEMPT_TIMEOUT_MAX_MS)} ms (got "${raw}").`,
    );
  }
  return parsed;
};

/** The deterministic precedence: an explicit Role budget beats the deployment level. */
export const resolveAttemptTimeoutMs = (
  roleTimeBudgetMs: number | undefined,
  deploymentLevelMs: number,
): number => roleTimeBudgetMs ?? deploymentLevelMs;

export const productionModelRouting = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  extraModelProfiles: readonly Omit<ModelProfile, 'configurationVersion'>[] = [],
): ProductionModelRouting | undefined => {
  const config = resolveOpenAiCompatibleConfig(env);
  if (!config.ok) throw new Error(`the model adapter configuration is invalid: ${config.error.message}`);
  if (config.value === null) {
    // SMART_ROUTER_V1 declared with NO model endpoint at all: an empty pool can never
    // route — fail loud at composition rather than silently degrading to the
    // deterministic default (no hidden mode fallback, §19).
    if ((env.COS_MODEL_ROUTING_MODE ?? '').trim() === 'SMART_ROUTER_V1') {
      throw new Error(
        'COS_MODEL_ROUTING_MODE=SMART_ROUTER_V1 requires a configured model endpoint (COS_MODEL_BASE_URL / COS_MODEL_ID): the routing pool would be empty.',
      );
    }
    return undefined;
  }
  const mode = config.value.routingMode ?? 'DETERMINISTIC_V1';
  if (mode === 'DETERMINISTIC_V1') return undefined;
  // SMART_ROUTER_V1: the env-declared profile MUST carry complete traits (fail closed).
  if (config.value.routingTraits === undefined) {
    throw new Error(
      'COS_MODEL_ROUTING_MODE=SMART_ROUTER_V1 requires complete routing traits for the live profile '
        + '(set COS_MODEL_QUALITY_TIER, COS_MODEL_COST_TIER, COS_MODEL_LATENCY_TIER and COS_MODEL_RELIABILITY_CLASS): '
        + 'traits are never guessed (MODEL_ROUTING_PROFILE_INCOMPLETE).',
    );
  }
  for (const extra of extraModelProfiles) {
    if (extra.routingTraits === undefined) {
      throw new Error(
        `An explicitly provided model profile ("${extra.modelProfileId}") lacks routing traits: SMART_ROUTER_V1 never guesses traits (MODEL_ROUTING_PROFILE_INCOMPLETE).`,
      );
    }
    if ((extra.authentication ?? 'REQUIRED') === 'NONE' && extra.credentialRef !== '') {
      throw new Error(
        `An explicitly provided model profile ("${extra.modelProfileId}") declares authentication NONE yet carries a credentialRef: a declared credential is never silently ignored (MODEL_PROFILE_AUTH_CONTRACT_INVALID).`,
      );
    }
  }
  const authentication = config.value.authentication ?? 'REQUIRED';
  const pool = new ModelPool();
  const registered = pool.register({
    modelProfileId: `env:${config.value.modelId}`,
    providerId: config.value.providerId,
    modelId: config.value.modelId,
    displayName: `${config.value.modelId} (operator env profile)`,
    endpointURL: config.value.baseUrl,
    // ABSENT exactly when the endpoint declares no-auth (never a fake pointer).
    credentialRef: authentication === 'NONE' ? '' : `vault://${config.value.apiKeyEnv}/live`,
    authentication,
    enabled: true,
    // Truthful capability claims only — the adapter answers structured requests;
    // it does not implement tool-calling or streaming today.
    capabilities: new Set(['structured-output'] as const),
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: false,
    supportsStructuredOutput: true,
    supportsStreaming: false,
    routingTraits: config.value.routingTraits,
  });
  if (!registered.ok) throw new Error(`the production model pool rejected the env profile: ${registered.error.message}`);
  for (const extra of extraModelProfiles) {
    const added = pool.register(extra);
    if (!added.ok) throw new Error(`the production model pool rejected profile "${extra.modelProfileId}": ${added.error.message}`);
  }
  const policy = ROUTING_POLICIES[config.value.routingPolicy ?? 'BALANCED'];
  return {mode: 'SMART_ROUTER_V1', pool, policy};
};

/**
 * The embedded DSH kernel's deterministic route when the deployment declares a live
 * model endpoint (the DETERMINISTIC_V1 path; under SMART_ROUTER_V1 the per-attempt
 * CompanyOS-selected route supersedes it — the kernel consumes either verbatim).
 * The credential resolves LAZILY inside the CompanyOS process (vault env namespace);
 * no raw secret ever enters configuration, the child env or the kernel config.
 */
export const productionEmbeddedModelRoute = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ComposeCoreServicesOptions['embeddedDshModelRoute'] => {
  const config = resolveOpenAiCompatibleConfig(env);
  if (!config.ok) throw new Error(`the model adapter configuration is invalid: ${config.error.message}`);
  if (config.value === null) return undefined;
  const apiKeyEnv = config.value.apiKeyEnv;
  return {
    providerId: config.value.providerId,
    modelId: config.value.modelId,
    baseURL: config.value.baseUrl,
    apiKeyEnv,
    apiKeyResolver: () => env[apiKeyEnv] ?? '',
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
};

/**
 * The production composition options. Both Desktop composition sites (the quiescent
 * startup composition and the workflow-API composition) use this ONE function, so the
 * shipped product and its tests exercise the same wiring.
 *
 * Repository capability: the work kind is repository-capable (the frozen E2E deployment
 * shape); the trusted-host workspace OPENING remains a deployment action — until a
 * workspace is open, repository-backed work dispatches fail closed with typed states.
 *
 * `extraModelProfiles` is the operator/deployment extension seam for additional
 * explicitly-declared routable profiles (tests use it for the multi-profile fixture);
 * every provided profile must itself carry complete routing traits.
 */
export const productionCompositionOptions = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: {readonly extraModelProfiles?: readonly Omit<ModelProfile, 'configurationVersion'>[]; readonly trustedBudgetProofs?: TrustedBudgetProofSource; readonly budgetCap?: DeploymentBudgetCap} = {},
): Pick<
  ComposeCoreServicesOptions,
  | 'stageHandlers'
  | 'providerKinds'
  | 'providerRoutes'
  | 'repositoryRuntime'
  | 'modelRouting'
  | 'embeddedDshRuntimeRoot'
  | 'embeddedDshModelRoute'
  | 'goalWorkProfile'
  | 'executionSafety'
> => {
  if (options.trustedBudgetProofs !== undefined && options.trustedBudgetProofs.scope !== 'PRODUCTION_VERIFIED') throw new Error('TEST_ONLY budget proofs cannot enable production admission.');
  // H10: an operator budget cap only ever rides WITH a production trusted proof source;
  // without one the fail-closed default (maxCostMicros 0) stands.
  if (options.budgetCap !== undefined && options.trustedBudgetProofs === undefined) throw new Error('A budget cap requires a PRODUCTION_VERIFIED trusted proof source.');
  const cap = options.budgetCap ?? { maxCalls: 4, maxTokens: 32768, maxCostMicros: 0, durationMs: 180000 };
  const routing = productionModelRouting(env, options.extraModelProfiles ?? []);
  const embeddedRoute = productionEmbeddedModelRoute(env);
  const executorRoute = productionExecutorRoute(env);
  return {
    stageHandlers: { executorKinds: [...PRODUCTION_EXECUTOR_KINDS, SOFTWARE_WORK_KIND] },
    // ADR-A: every production entry enables durable admission. No verified tariff /
    // upstream token bound is currently configured: external execution FAILS CLOSED.
    // These limits are not a claim that an upstream accepts a monetary hard cap.
    executionSafety: { policyId: 'v1-bounded-execution-1', maxCalls: cap.maxCalls, maxTokens: cap.maxTokens, maxCostMicros: cap.maxCostMicros, durationMs: cap.durationMs,
      ...(options.trustedBudgetProofs === undefined ? {} : { trustedProofs: options.trustedBudgetProofs }) },
    providerKinds: [GOAL_WORK_KIND, SOFTWARE_WORK_KIND],
    /*
     * DRA-04 — the embedded runtime root rides EVERY production composition: the
     * absolute, launch-independent managed root above (never inferred downstream
     * from the launch working directory). The per-user WRITABLE attempt data (stages,
     * model codex homes) never lives under this immutable resource location — it is
     * the already-separate userData/attempt path, unchanged by this fix.
     */
    embeddedDshRuntimeRoot: productionEmbeddedDshRuntimeRoot(),
    // The SAME executor route serves both work kinds; the route table is keyed by the
    // task kind (core-services dispatch resolves providerRouteTable[task.kind]).
    providerRoutes: { [GOAL_WORK_KIND]: executorRoute, [SOFTWARE_WORK_KIND]: executorRoute },
    repositoryRuntime: { repositoryCapableKinds: [GOAL_WORK_KIND, SOFTWARE_WORK_KIND] },
    /*
     * STAGE 4 P1 (DYNAMIC_PLAN_VALIDATION_CLOSURE): every dynamically planned work item
     * is bound to the generic evidence-grounding validator. The binding flows into the
     * compiled node config (validatorIds) and drives the canonical independent
     * validation lifecycle (supervisor validationRunner → ValidationService → evidence
     * applicator → VALIDATION.PASS → COMPLETED). The validator itself is a
     * verifier-only deterministic tool; it is NOT desktop- or model-authored.
     */
    goalWorkProfile: {
      stageKind: 'work',
      taskKind: GOAL_WORK_KIND,
      maxAttempts: 3,
      /*
       * STAGE 4 FINAL — deterministic validator SELECTION (not a fixed validator): the
       * deployment declares the validation CAPABILITY the work requires; the composition
       * resolves it to the registered validator tool carrying that capability
       * (TOOL_CAPABILITY_VALIDATOR + declared sub-capability). evidence.grounding-check
       * is the generic evidence-grounding validator for workspace-anchored analysis work;
       * specialized validators (software tests via validatorTools, repo QA, packs) remain
       * selectable by declaring different capabilities — nothing is replaced.
       */
      validatorIds: ['evidence.grounding-check'],
      /*
       * BB2 FINAL FORENSIC closure (SOFTWARE_SPECIALIZED_VALIDATION_CANONICALITY): the
       * deployment declares a SOFTWARE operation kind whose items carry the SPECIALIZED
       * software validation authority — `repo.test-check` (executes the workspace's OWN
       * declared test contract fresh at validation time) — with the generic grounding
       * validator kept ADDITIVE. A plan item that does not declare this kind keeps the
       * generic mapping unchanged. The policy is THIS static deployment declaration over
       * the closed operation-kind set; nothing is derived from filenames, goal text or
       * role names, and the model never chooses validators.
       */
      operationKinds: [SOFTWARE_WORK_KIND],
      validatorIdsByTaskKind: {
        [SOFTWARE_WORK_KIND]: ['repo.test-check', 'evidence.grounding-check'],
      },
    },
    ...(routing === undefined ? {} : { modelRouting: routing }),
    ...(embeddedRoute === undefined ? {} : { embeddedDshModelRoute: embeddedRoute }),
  };
};

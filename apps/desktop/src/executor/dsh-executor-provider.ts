/**
 * Sprint24 — the DeepSeek Harness (dsh headless) EXECUTOR ADAPTER.
 *
 * Lives in the desktop composition (never the engine): the engine's frozen
 * boundary is vendor-name-free. Wraps the installed stable automation surface
 * `dsh --profile headless [--json] [--session-id <id>] "<task>"` behind the
 * CompanyOS ExecutorProvider contract — the adapter owns ONLY the provider
 * protocol (argv + NDJSON parsing); generic process mechanics live in the
 * engine's ProcessExecutorProvider.
 *
 * Truthful capability advertisement (fail loud, never silent degrade):
 * timeout, structured-output, working-directory, stdin, external-run-identity
 * (the persisted session id), recovery-resume (`--session-id` continuation),
 * streaming-diagnostics (NDJSON events), cancellation (kill-tree REQUEST —
 * proof of stop only via exit evidence). NOT advertised: status-query,
 * idempotency-key (dsh mints a new session per invocation — CompanyOS's
 * deterministic dispatch key is OUR binding identity, not a provider
 * exactly-once claim), environment-inputs.
 */
import {
  createProcessExecutorProvider,
  parseNdjsonEvents,
  resolveExecutorConfig,
  type ExecutorCapabilityName,
  type ExecutorConfigSchema,
  type ExecutorExecutionRequest,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
  type TypedExecutorConfig,
} from '@companyos/engine';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { attemptNotesOf, parseAttemptNotes, renderAttemptNotes } from './kernel-failure-detail.js';
import { workspaceInventoryLineOf, workspaceInventoryOf } from './workspace-inventory.js';
import { createTurnNoter, detectExternalTools, externalToolsLineOf, injectTurnNote, wrapUpThresholdsOf, type ExternalToolStatus, type WrapUpThresholds } from './attempt-wrap-up.js';
import { createVerifiedWorkTracker, verifiedWorkCreditOf } from './verified-work-credit.js';

import {createCoreDomainEvent, domainError, type DomainError, err, ok, redactSecrets, type Result} from '@companyos/core';
import {createHash} from 'node:crypto';
import { planIsolatedLaunch, type IsolationLaunchConfig } from './isolation/isolated-launch-seam.js';
import type { IsolationDispatchDecision } from './isolation/isolation-status.js';
import {existsSync} from 'node:fs';
import { createAttemptEarlyStop, kernelSilenceMsOf } from './attempt-early-stop.js';

import {
  startModelBroker,
  type ModelBrokerExchangeObservation,
  type DshSandboxMode,
  type EmbeddedDshModelRoute,
  type EmbeddedDshRuntime,
} from './embedded-dsh-runtime.js';
import {
  selectModelProfile,
  snapshotOf,
  type ModelPool,
  type ModelSelectionRequirements,
  type SelectedModelSnapshot,
} from './model-pool.js';


/**
 * H15d-fix3 — the embedded kernel's model working window, derived from the request-body
 * byte bound the CompanyOS admission enforces. The kernel's token meter prices a request at
 * roughly four bytes per token, so a window of bound/4 tokens puts the kernel's compaction
 * threshold (min(0.8 x window, window - completion reserve - headroom)) well below the byte
 * bound. If a request still outgrows the bound, the broker answers with a typed
 * context-length error and the kernel compacts and retries (never a dead attempt).
 * hark-live-goal 40320541076: window 128k vs bound 48 000 bytes, no compaction -> 3 attempts
 * refused mid-work.
 */
export const KERNEL_BYTES_PER_TOKEN = 4;
export const kernelContextWindowFor = (routeWindow: number, inputBoundBytes: number | undefined): number =>
  inputBoundBytes === undefined ? routeWindow : Math.min(routeWindow, Math.floor(inputBoundBytes / KERNEL_BYTES_PER_TOKEN));

/**
 * LIVE-CONTRACT-FILL run 6 (hark-live-goal 42385697784) ROOT CAUSE — compaction sizing.
 *
 * The kernel's compaction-basic resolves its automatic threshold as
 *   min(window x 0.8, window - reservedCompletion - headroom)
 * and, when that is <= 0, logs "step compaction failed" ONCE and never compacts on pressure
 * again. Run 6 rendered headroom = summary maxTokens = the route max_tokens (16384, raised
 * after run 5) against a 24 000-token window (96 000-byte bound / 4): 24 000 - 16 384 -
 * 16 384 < 0, so pressure compaction was silently OFF. The only remaining reduction was the
 * broker's context_length_exceeded answer at the byte bound, which the kernel retries ONCE
 * per request (maxOverflowRetries default 1); every attempt grew to the bound (~28k tokens
 * per call, the cost driver) and died on the next consecutive overflow as turn_end "error".
 *
 * The compactor now gets its OWN small headroom / summary budget, more overflow retries,
 * and the sizing is checked before spawn: a window that leaves no real pressure budget is a
 * typed configuration failure, never a silently disabled compactor.
 */
export const COMPACTION_HEADROOM_MAX_TOKENS = 4096;
export const COMPACTION_SUMMARY_MAX_TOKENS = 4096;
/** compaction-basic DEFAULT_RETAIN_RATIO (messageBudget x 0.16 retained verbatim). */
export const COMPACTION_RETAIN_RATIO = 0.16;
/** The automatic threshold must leave at least this much working context (tokens). */
export const COMPACTION_MIN_THRESHOLD_TOKENS = 12_000;
export interface KernelCompactionSizing {
  readonly ok: boolean;
  readonly headroomTokens: number;
  readonly summaryMaxTokens: number;
  readonly thresholdTokens: number;
  readonly retainTokens: number;
  readonly reason?: string;
}
export const kernelCompactionSizingFor = (contextWindow: number, routeMaxTokens: number): KernelCompactionSizing => {
  const headroomTokens = Math.max(1, Math.min(COMPACTION_HEADROOM_MAX_TOKENS, routeMaxTokens));
  const summaryMaxTokens = Math.max(1, Math.min(COMPACTION_SUMMARY_MAX_TOKENS, routeMaxTokens));
  const messageBudget = contextWindow - routeMaxTokens;
  const thresholdTokens = Math.floor(Math.min(contextWindow * 0.8, messageBudget - headroomTokens));
  const retainTokens = Math.floor(Math.max(0, messageBudget) * COMPACTION_RETAIN_RATIO);
  const base = { headroomTokens, summaryMaxTokens, thresholdTokens, retainTokens };
  if (thresholdTokens < COMPACTION_MIN_THRESHOLD_TOKENS || retainTokens >= thresholdTokens) {
    return {
      ...base,
      ok: false,
      reason: `kernel working window ${String(contextWindow)} tokens leaves a compaction threshold of ${String(thresholdTokens)} tokens ` +
        `(< ${String(COMPACTION_MIN_THRESHOLD_TOKENS)}) after the ${String(routeMaxTokens)}-token output reserve and ${String(headroomTokens)} headroom; ` +
        'raise the trusted input bound (inputUpperBound) or lower the route max_tokens',
    };
  }
  return { ...base, ok: true };
};

export const DSH_PROVIDER_KEY = 'dsh-headless';

export const DSH_CAPABILITIES: readonly ExecutorCapabilityName[] = [
  'cancellation',
  'timeout',
  'structured-output',
  'working-directory',
  'stdin',
  'external-session-identity',
  'session-continuation',
  'streaming-diagnostics',
];

/**
 * The TYPED configuration contract for this adapter (Sprint25; profileName added by
 * the V1 real-executor recovery — docs/provider-recovery/DSH_CURRENT_RUNTIME_RECON.md).
 *
 * Declared here, validated by the engine's generic loader: two absolute paths, a
 * bounded timeout, and the dsh PROFILE the frozen one-task contract is invoked
 * under. The installed runtime normalizes the NAMED `headless` profile to a
 * web-app composition that rejects task arguments, while the shipped-template
 * composition `[base, dsh-headless]` executes the frozen S24 contract verbatim —
 * so CompanyOS targets its own template-restored profile by default. Nothing
 * secret-shaped may appear — the loader refuses it, and the local runtime needs
 * no credential at all (verified by running it with a completely empty environment).
 */
export const DSH_CONFIG_SCHEMA: ExecutorConfigSchema = {
  nodeExecutable: { name: 'nodeExecutable', kind: 'absolute-path', required: true },
  runtimeDir: { name: 'runtimeDir', kind: 'absolute-path', required: true },
  profileName: {
    name: 'profileName',
    kind: 'string',
    required: false,
    defaultValue: 'companyos-headless',
  },
  timeoutMs: {
    name: 'timeoutMs',
    kind: 'integer',
    required: false,
    defaultValue: 120_000,
    min: 1_000,
    max: 3_600_000,
  },
};

/** The environment variable name for each configurable field (named precedence). */
export const DSH_CONFIG_ENV_NAMES: Readonly<Record<string, string>> = {
  nodeExecutable: 'DSH_NODE',
  runtimeDir: 'DSH_RUNTIME',
  profileName: 'DSH_PROFILE',
};

export interface DshProviderConfigInput {
  /** Trusted composition overrides (highest precedence). */
  readonly composition?: Readonly<Record<string, string | number | undefined>>;
  /** Environment to read named variables from; defaults to the host environment. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Path grammar of the configured paths (H14); defaults to the host platform. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Resolve the typed, source-annotated dsh configuration. Precedence: composition →
 * named environment variable → declared default. A missing required field is a
 * typed VALIDATION_FAILED load — never a silent `?? ''`.
 */
export const resolveDshProviderConfig = (input: DshProviderConfigInput = {}): Result<TypedExecutorConfig, DomainError> =>
  resolveExecutorConfig({
    providerKey: DSH_PROVIDER_KEY,
    schema: DSH_CONFIG_SCHEMA,
    envNames: DSH_CONFIG_ENV_NAMES,
    ...(input.composition === undefined ? {} : { composition: input.composition }),
    environment: input.environment ?? process.env,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });

/** Read one effective value out of a resolved dsh configuration. */
export const dshConfigString = (config: TypedExecutorConfig, field: string): string | null => {
  const found = config.fields.find((entry) => entry.name === field);
  if (found === undefined) return null;
  return typeof found.value === 'string' ? found.value : String(found.value);
};

export const dshConfigInteger = (config: TypedExecutorConfig, field: string): number | null => {
  const found = config.fields.find((entry) => entry.name === field);
  if (found === undefined) return null;
  const value = typeof found.value === 'string' ? Number(found.value) : found.value;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
};

export interface DshProviderConfig {
  /** Absolute path to the node executable bundled with the harness runtime. */
  readonly nodeExecutable: string;
  /** Absolute path to the harness `resources/runtime` directory (holds lib/bin.js). */
  readonly runtimeDir: string;
  /**
   * STAGE 4 — the CompanyOS-MANAGED EMBEDDED runtime (default mode). When present,
   * the adapter launches the official pinned kernel as a managed child with a
   * disposable per-attempt DSH_HOME and the CompanyOS-selected model route; the
   * external nodeExecutable/runtimeDir fields remain ONLY as the explicit operator
   * opt-in path (never a silent fallback — see embedded-dsh-runtime.ts).
   */
  readonly embedded?: {
    readonly runtime: EmbeddedDshRuntime;
    /**
     * STAGE 6: the CompanyOS Model Pool for deterministic per-attempt selection
     * (Boss §2/§11). When provided, `modelRoute` is derived from the selected
     * profile each attempt — the provider never falls back to a hardcoded route.
     */
    readonly modelPool?: ModelPool;
    readonly selectionRequirements?: ModelSelectionRequirements;
    /** Explicit override for backward compat — if both pool and route exist, pool wins. */
    readonly modelRoute?: EmbeddedDshModelRoute;
    /**
     * STAGE 8B §10 — when true the kernel REQUIRES the CompanyOS-selected
     * model route on the request (the Smart Router's decision, attached before
     * invocation). A request without it fails loud: the kernel never re-scores,
     * never re-fallbacks and never routes on its own.
     */
    readonly requireRequestedModel?: boolean;
    /** Node executable for the managed child (default: the running process's node). */
    readonly nodeExecutable?: string;
    /**
     * H16b-3: Windows file/network isolation (isolation/isolated-launch-seam.ts). When present, every
     * attempt asks the helper's status check first: ISOLATED launches the kernel AS the agent account
     * through companyos-isolated-launch.exe with the broker on the allow-listed port; NOT_CONFIGURED
     * launches unchanged ("未隔离"); ISOLATION_DEGRADED refuses the dispatch (never a silent fallback).
     */
    readonly isolation?: IsolationLaunchConfig;
    /**
     * LIVE-SMOKE-FIX-08B (LEVEL B attribution): optional audit sink. When present,
     * every `tool_call <tool> <args-json>` line the kernel streams on stdout is
     * appended as a durable `executor.tool_invocation_requested` event AT ARRIVAL
     * (before the tool completes) — so a timeout/kill/crash attempt keeps the exact
     * INNER command form (node bin\cli.js vs bin\cli.js vs cmd /c bin\cli.js).
     * Redacted against the sink's active secret values; evidence only.
     */
    readonly toolInvocationAudit?: {
      append(events: readonly unknown[]): Promise<unknown>;
      secrets(): readonly string[];
      ids: {id(prefix?: string): string; ulid(): string};
      onFailure(error: unknown): void;
    };
    /**
     * LIVE-CONTRACT-FILL run 9: wrap-up thresholds (default: from COS_WRAPUP_* in the process
     * environment, see attempt-wrap-up.ts).
     */
    readonly wrapUp?: WrapUpThresholds;
    /**
     * LIVE-CONTRACT-FILL run 10: silence (no kernel output, no model exchange) that ends an
     * attempt early (default: COS_KERNEL_SILENCE_MS, else 10 min; see attempt-early-stop.ts).
     */
    readonly kernelSilenceMs?: number;
    /** LIVE-CONTRACT-FILL run 9: external-tool detection (default: PATH + well-known dirs). */
    readonly detectExternalTools?: () => readonly ExternalToolStatus[];
    /** Clock for the attempt's time-left status (tests). */
    readonly now?: () => number;
  };
  /**
   * The dsh profile the frozen one-task contract is invoked under. The installed
   * runtime normalizes the NAMED `headless` profile to a web-app composition that
   * rejects task arguments, so the default is CompanyOS's own template-restored
   * profile (one-time operator setup: `dsh companyos-headless --from-default-profile
   * headless`). The version label never selects the protocol — a contract mismatch
   * fails loud with `EXECUTOR_DSH_PROFILE_CONTRACT_MISMATCH`.
   */
  readonly profileName: string;
  /**
   * Trusted spawn cwd when the request carries no workspace. Declared by the
   * composition (never a silent fallback: an unset value is null and the dispatch
   * fails closed).
   */
  readonly fallbackCwd: string | null;
  /** The typed configuration this adapter was built from (provenance + fingerprint). */
  readonly config: TypedExecutorConfig;
  /** Per-invocation ceiling; the process provider enforces it via kill-tree. */
  readonly timeoutMs?: number;
  /** The composition-armed timer (the engine boundary bans engine-held timers). */
  readonly timer?: (ms: number, onTimeout: () => void) => () => void;
}

/**
 * Build the adapter from a TYPED configuration. The declared `fallbackCwd` is
 * honored (Sprint24 silently ignored it in favor of the runtime dir — that is
 * exactly the kind of silent weakening this sprint removes).
 */
export const createDshProviderFromConfig = (config: TypedExecutorConfig): Result<DshProviderConfig, DomainError> => {
  const nodeExecutable = dshConfigString(config, 'nodeExecutable');
  const runtimeDir = dshConfigString(config, 'runtimeDir');
  const profileName = dshConfigString(config, 'profileName') ?? 'companyos-headless';
  if (nodeExecutable === null || nodeExecutable === '' || runtimeDir === null || runtimeDir === '') {
    return err(
      domainError('VALIDATION_FAILED', 'The dsh configuration is missing nodeExecutable or runtimeDir.', {
        reason: 'DSH_CONFIG_INCOMPLETE',
      }),
    );
  }
  return ok({ nodeExecutable, runtimeDir, profileName, fallbackCwd: null, config });
};

/**
 * STAGE 4 — resolve the Node executable that runs the embedded DSH kernel child.
 * The kernel's boot gate rejects Electron-flavoured runtimes, so when the parent is
 * Electron the platform Node (PATH) is used. Falls back to process.execPath — the
 * kernel's own boot gate then produces the typed, visible failure.
 */
const resolveEmbeddedChildNode = (): string => {
  if (process.versions.electron === undefined) return process.execPath;
  const pathValue = process.env['PATH'] ?? process.env['Path'] ?? '';
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of pathValue.split(';')) {
    if (dir.trim() === '') continue;
    const candidate = join(dir.trim(), executable);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // unreadable PATH entry — skip
    }
  }
  return process.execPath;
};

/**
 * The single-task prompt handed to the provider (never secrets) — the Canonical
 * Work Envelope → kernel CONTEXT projection (transport only; no second WorkPackage,
 * no DshTask truth). Projects every envelope field the kernel needs as data:
 * objective, role, acceptance criteria, structured goal constraints, typed task
 * inputs, input artifact references, and the bounded memory-view context.
 */
/**
 * STAGE 4 — the Goal's canonical access policy (chosen at goal.create, carried in the
 * run-goal `structured` payload) mapped onto the KERNEL's own fs-sandbox mode. This is
 * the below-renderer enforcement point for 只读: the KERNEL refuses writes; no UI state
 * is involved. Unknown/absent policy ⇒ the workspace-write default (the pre-Stage-4
 * behavior), never a broader mode.
 */
export const dshSandboxModeOf = (goalStructured: Readonly<Record<string, unknown>> | undefined): DshSandboxMode => {
  const policy = goalStructured === undefined || goalStructured === null ? undefined : goalStructured['accessPolicy'];
  return policy === 'READ_ONLY' ? 'read-only' : 'workspace-write';
};

/**
 * LIVE-CONTRACT-FILL (hark-live-goal 42075419348): the kernel ends a turn with
 * `turn_end` reason `max-tokens` when ONE model response reaches the route's output
 * ceiling (it drops the truncated tool call and exits 1 with an empty stderr). A real
 * project goal hit it on every attempt by writing a whole source file in one tool call;
 * CompanyOS knew the ceiling and never told the kernel. The prompt now states the
 * ceiling and how to stay under it (write large files in parts).
 */
/**
 * Lines per file part that stay well under the ceiling: tool-call arguments are JSON
 * escaped code (≈ 12-16 tokens per source line incl. escaping) plus the reply around it.
 */
// Capped at 256 lines (the 8192-token figure): a wider ceiling (16384 after run 5) is headroom
// against truncation, not an invitation to write bigger parts (longer replies, slower calls).
export const outputCeilingPartLines = (outputCeilingTokens: number): number => Math.min(256, Math.max(40, Math.floor(outputCeilingTokens / 32)));
export const outputCeilingDirective = (outputCeilingTokens: number): string => {
  const lines = outputCeilingPartLines(outputCeilingTokens);
  return `Output limit: each of your responses, including tool-call arguments, is capped at about ${String(outputCeilingTokens)} output tokens. ` +
    `A response that reaches the cap is cut off and its tool call is lost. Never write a large file in one tool call: create it in parts of at most about ${String(lines)} lines ` +
    '(write the first part, then append or edit the following parts in later calls), write one file (or one part of a file) per reply, and keep each reply short.';
};

/**
 * LIVE-CONTRACT-FILL run 5: the kernel spent a whole 10-minute attempt hand-writing a zip
 * inflater, an XML parser and a docx loader (zero dependencies) instead of using the mature
 * libraries any engineer would install. The task text now states the engineering practice:
 * build on well-known libraries from the official registry through the project's package
 * manager, never hand-roll file-format parsers; keep the project clean; write user-facing
 * text in the goal's language. (Guidance only — authority and validation are unchanged.)
 */
export const ENGINEERING_PRACTICE_DIRECTIVE =
  'Engineering practice for software work: build on mature, widely used open-source libraries installed with the project\'s package manager ' +
  '(npm/pnpm for Node.js, pip for Python, …) from the official registry, declared in the manifest with a lockfile — for example docxtemplater with pizzip ' +
  '(or the docx package) for Word .docx templates, and LibreOffice headless conversion (soffice --headless --convert-to pdf) or an equivalent maintained ' +
  'library for PDF export. Never hand-write parsers or writers for zip, XML, docx, PDF or similar formats. If a dependency cannot be installed, say so ' +
  'in your final answer instead of re-implementing it. Keep scratch and probe files out of the project, and make every declared script (e.g. npm test) ' +
  'run tests that exist. Write user-facing text (UI strings, docs, reports) in the same natural language as the objective.';

/**
 * LIVE-CONTRACT-FILL run 8 (hark-live-goal 42419993676): step 1 of a 6-step plan ("parse the
 * Word template and detect fields") ran 192 model calls and wrote the WHOLE app — web server,
 * UI, paste entry, preview, PDF export — because the kernel saw the full goal and no word that
 * the goal is split into steps that run separately; the step's spend share ran out mid-work.
 * The task text now names the plan position, lists the other steps as NOT this task's work, and
 * says to finish as soon as this step's own criteria are met. (Guidance only — authority,
 * admission and validation are unchanged.)
 */
export const STEP_SCOPE_DIRECTIVE =
  'Scope: do ONLY the work of this step (the objective in the first line and its acceptance criteria). The other steps of the plan are ' +
  'separate tasks run after (or before) this one by other executions — do not implement them now, not even partly (no UI, export, ' +
  'packaging or extra features that belong to another step). This step has a limited share of the goal\'s budget and is stopped when it ' +
  'runs out, so work economically: write the code this step needs with a small test for it, run the tests once they exist, and give your ' +
  'final answer as soon as this step\'s acceptance criteria are met — do not keep polishing or probing.';

export const planContextLinesOf = (planContext: ExecutorExecutionRequest['work']['planContext']): string[] => {
  if (planContext === undefined || planContext.total < 2 || planContext.steps.length === 0) return [];
  const lines = [`Plan position: this task is step ${String(planContext.position)} of ${String(planContext.total)} of the goal's plan.`];
  planContext.steps.forEach((step, index) => {
    lines.push(`- step ${String(index + 1)}${step.current ? ' (THIS task)' : ' (another task — not yours)'}: ${step.objective}`);
  });
  lines.push(STEP_SCOPE_DIRECTIVE);
  return lines;
};

/**
 * LIVE-CONTRACT-FILL run 9 (hark-live-goal 42429421366): the step's tests passed but the kernel never
 * answered, so the attempt timed out with its work unrecognised. CompanyOS now credits a timed-out
 * attempt whose last test run passed and whose tests prove every criterion (verified-work-credit.ts);
 * that needs tests named after the criterion they prove. It also appends a status note with the time
 * and budget left to every turn and forces a wrap-up near the end (attempt-wrap-up.ts).
 */
export const VERIFICATION_DIRECTIVE =
  'Verification: name every test after the acceptance criterion it proves, starting with the criterion id in brackets ' +
  '(for example "[criterion-id] what it checks"), so CompanyOS can map test results to criteria. A criterion this environment ' +
  'cannot satisfy is reported in your final answer, never chased. CompanyOS appends a status note to your inputs with the time ' +
  'and budget left in this attempt; when it says WRAP-UP, stop new work, run the tests once and give your final answer.';

export interface DshTaskTextOptions {
  /** The selected route's per-response output ceiling (tokens), when CompanyOS knows it. */
  readonly outputCeilingTokens?: number;
  /** LIVE-CONTRACT-FILL run 9: the detected external tools line (externalToolsLineOf). */
  readonly externalToolsLine?: string;
  /** LIVE-CONTRACT-FILL run 11: files already in the workspace (workspaceInventoryLineOf). */
  readonly workspaceInventoryLine?: string;
  /** In-attempt continuation directive after an output-ceiling truncation (rendered last). */
  readonly continuationDirective?: string;
}

/** The goal's declared file deliveries that belong to this step's criteria. */
export const relevantFileDeliveriesOf = (request: ExecutorExecutionRequest): unknown[] => {
  const criteria = request.work.acceptanceCriteria ?? [];
  const fileRequirements = request.work.goalStructured?.['fileDeliveries'];
  return Array.isArray(fileRequirements) ? fileRequirements.filter((item: unknown) => typeof item === 'object' && item !== null && criteria.some((criterion) => criterion.criterionId === (item as Record<string, unknown>)['criterionId'])) : [];
};

export const dshTaskTextOf = (request: ExecutorExecutionRequest, options: DshTaskTextOptions = {}): string => {
  // The objective stays the FIRST line: the frozen S24 one-task contract (and its
  // deterministic fixture protocol) keys on the leading task text.
  const lines: string[] = [
    request.work.objective,
    `Role: ${request.roleId}`,
  ];
  const criteria = request.work.acceptanceCriteria ?? [];
  if (criteria.length > 0) {
    lines.push('Acceptance criteria (the platform validates the verdict, not you):');
    for (const criterion of criteria) lines.push(`- [${criterion.criterionId}] ${criterion.requirement}`);
  }
  lines.push(...planContextLinesOf(request.work.planContext));
  const goalStructured = request.work.goalStructured;
  if (goalStructured !== undefined && Object.keys(goalStructured).length > 0) {
    lines.push(`Goal structured constraints: ${JSON.stringify(goalStructured)}`);
  }
  const taskInputs = request.work.taskInputs;
  if (taskInputs !== undefined && Object.keys(taskInputs).length > 0) {
    lines.push(`Task inputs: ${JSON.stringify(taskInputs)}`);
  }
  lines.push(...(request.work.memoryView ?? []).slice(0, 8));
  const artifactRefs = request.work.artifactRefs ?? [];
  if (artifactRefs.length > 0) {
    lines.push(`Referenced artifacts (read-only): ${artifactRefs.join(', ')}`);
  }
  /*
   * STAGE 8B §11-§12 — the ROLE CONTEXT projection: bounded professional
   * summaries from canonical durable truth (responsibility, decision refs,
   * risks, open questions, the attempt's CompanyOS-selected model). Refs and
   * summaries only — no raw producer transcript and no hidden reasoning is
   * ever rendered (they are not inputs).
   */
  const roleContext = request.work.roleContext;
  if (roleContext !== undefined) {
    lines.push(`Professional responsibility: ${roleContext.professionalResponsibility}`);
    if (roleContext.hardConstraints.length > 0) {
      lines.push('Hard constraints:');
      for (const constraint of roleContext.hardConstraints) lines.push(`- ${constraint}`);
    }
    if (roleContext.relevantDecisionSummaries.length > 0) {
      lines.push(`Relevant decisions: ${roleContext.relevantDecisionSummaries.join(', ')}`);
    }
    if (roleContext.knownRisks.length > 0) {
      lines.push('Known risks:');
      for (const risk of roleContext.knownRisks) lines.push(`- ${risk}`);
    }
    if (roleContext.remainingQuestions.length > 0) {
      lines.push('Open questions:');
      for (const question of roleContext.remainingQuestions) lines.push(`- ${question}`);
    }
    if (roleContext.attemptModelLabel !== null) {
      lines.push(`Selected model (CompanyOS routing evidence): ${roleContext.attemptModelLabel}`);
    }
  }
  lines.push(ENGINEERING_PRACTICE_DIRECTIVE);
  if (options.externalToolsLine !== undefined && options.externalToolsLine !== '') lines.push(options.externalToolsLine);
  if (options.workspaceInventoryLine !== undefined && options.workspaceInventoryLine !== '') lines.push(options.workspaceInventoryLine);
  if (criteria.length > 0) lines.push(VERIFICATION_DIRECTIVE);
  const relevantFiles = relevantFileDeliveriesOf(request);
  if (relevantFiles.length > 0) {
    lines.push(`Required file delivery: ${JSON.stringify(relevantFiles)}`);
    lines.push(`Final text must be JSON {"schema":"companyos/business-files/1","goalRunId":${JSON.stringify(request.work.fileDeliveryGoalRunId)},"runId":${JSON.stringify(request.runId)},"taskId":${JSON.stringify(request.taskId)},"files":[{"relativePath":"the required relative path","sizeBytes":123,"sha256":"actual lowercase sha256"}]}. Report only actual nonempty files in the authorized Workspace. Exit code zero is not file delivery proof.`);
  } else lines.push('Answer with the final result text only.');
  if (options.outputCeilingTokens !== undefined && Number.isSafeInteger(options.outputCeilingTokens) && options.outputCeilingTokens > 0) {
    lines.push(outputCeilingDirective(options.outputCeilingTokens));
  }
  if (options.continuationDirective !== undefined && options.continuationDirective !== '') lines.push(options.continuationDirective);
  return lines.join('\n');
};

/**
 * LIVE-CONTRACT-FILL — the kernel's own reason for ending a turn, read from its JSON
 * stream (`{"type":"status","phase":"turn_end","reason":{"kind":...}}`). A failed exit
 * whose last turn ended for a typed reason carries that reason as the outcome's
 * reasonCode (evidence for the audit row and the retry directive) instead of an
 * anonymous exit 1 with an empty stderr.
 */
export const KERNEL_OUTPUT_CEILING = 'EXECUTOR_KERNEL_OUTPUT_CEILING' as const;
export const kernelTurnEndReasonOf = (stdoutText: string): string | null => {
  let reason: string | null = null;
  for (const line of stdoutText.split(/\r?\n/u)) {
    if (!line.includes('"turn_end"')) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; phase?: unknown; reason?: { kind?: unknown } };
      if (event.type === 'status' && event.phase === 'turn_end' && typeof event.reason?.kind === 'string') reason = event.reason.kind;
    } catch {
      // a non-JSON line is not a turn event
    }
  }
  return reason;
};
export const kernelFailureReasonCodeOf = (stdoutText: string): string | undefined => {
  const kind = kernelTurnEndReasonOf(stdoutText);
  if (kind === null || kind === 'completed') return undefined;
  if (kind === 'max-tokens') return KERNEL_OUTPUT_CEILING;
  const slug = kind.toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 40);
  return slug === '' ? undefined : `EXECUTOR_KERNEL_TURN_${slug}`;
};
/**
 * LIVE-CONTRACT-FILL run 4 (hark-live-goal 42346111946): a single model reply cut at the
 * output ceiling while writing a file ended the kernel process, the attempt, and after
 * three identical attempts the whole goal. The step now RECOVERS inside the attempt: the
 * files already written stay in the workspace, and the kernel is relaunched (bounded)
 * with a continuation directive naming what was truncated, which files exist, and how
 * to write the rest in smaller chunks. Only after the bounded continuations does the
 * attempt fail, with the typed EXECUTOR_KERNEL_OUTPUT_CEILING reason.
 */
export const OUTPUT_CEILING_MAX_CONTINUATIONS = 3;
/** A continuation needs at least this much of the attempt deadline left to be worth launching. */
export const OUTPUT_CEILING_CONTINUATION_MIN_REMAINING_MS = 30_000;
/**
 * Directories never listed as "work" in an inventory: VCS, dependency stores and package-manager
 * caches, build output. Run 6 (42385697784): the agent's workspace-local `.npm-cache` (~900
 * content files) sorted first and filled the whole 60-entry resume inventory, so a retry saw
 * cache blobs instead of the project and started over.
 */
export const INVENTORY_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.dsh', '.companyos', 'dist', 'build', '.next',
  '.npm-cache', '.npm', 'npm-cache', '_cacache', '.pnpm-store', '.yarn', '.cache', '.turbo', '.gradle', 'coverage',
]);
export interface WorkspaceFileEntry { readonly path: string; readonly bytes: number }
/** Bounded, deterministic inventory of the workspace's files (relative '/' paths, sorted). */
export const workspaceFileInventoryOf = (root: string, limit = 60): { readonly files: readonly WorkspaceFileEntry[]; readonly truncated: boolean } => {
  const files: WorkspaceFileEntry[] = [];
  let truncated = false;
  let visited = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > 8) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const name of entries) {
      if (++visited > 5000) { truncated = true; return; }
      const abs = join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (!INVENTORY_SKIP_DIRS.has(name)) walk(abs, relPath, depth + 1);
      } else if (st.isFile()) {
        if (files.length >= limit) { truncated = true; return; }
        files.push({ path: relPath, bytes: st.size });
      }
      if (truncated) return;
    }
  };
  walk(root, '', 0);
  return { files, truncated };
};
export const outputCeilingContinuationDirective = (input: {
  readonly continuation: number;
  readonly maxContinuations: number;
  readonly outputCeilingTokens?: number;
  readonly files: readonly WorkspaceFileEntry[];
  readonly filesTruncated: boolean;
}): string => {
  const ceiling = input.outputCeilingTokens !== undefined && Number.isSafeInteger(input.outputCeilingTokens) && input.outputCeilingTokens > 0
    ? input.outputCeilingTokens : undefined;
  const partLines = ceiling === undefined ? 120 : Math.max(30, Math.floor(outputCeilingPartLines(ceiling) / 2));
  const inventory = input.files.length === 0
    ? 'The workspace has no files yet.'
    : `Files already in the workspace (kept; relative path and size): ${input.files.map((file) => `${file.path} (${String(file.bytes)} B)`).join(', ')}${input.filesTruncated ? ', … (more not listed)' : ''}.`;
  return [
    `CONTINUATION ${String(input.continuation)} of ${String(input.maxContinuations)} of this same attempt: your previous reply reached the per-response output limit` +
      `${ceiling === undefined ? '' : ` (~${String(ceiling)} tokens)`} and was cut off; the tool call in that reply (most likely a large file write) was NOT applied.`,
    inventory,
    'Do not redo finished work: inspect the files above (they may be incomplete), then continue the task. A file that should exist but is missing or ends abruptly was the one being written when the reply was cut.',
    `Write the remaining files ONE file or ONE part per reply, each part at most about ${String(partLines)} lines: create the file with its first part, then append or edit the following parts in later calls. Keep every reply short.`,
  ].join(' ');
};

/**
 * Runs one attempt's kernel launch and recovers output-ceiling truncations in place:
 * up to `maxContinuations` relaunches on the same workspace, each with the continuation
 * directive, all within the attempt's ONE deadline. Any other outcome returns at once.
 */
/** Before the deadline, stop admitting new model calls this long ahead (bounded share of the budget). */
export const attemptDrainLeadMs = (attemptTimeoutMs: number): number => Math.min(30_000, Math.floor(attemptTimeoutMs / 20));
/** At the deadline, how long the kill waits for an in-flight model call to settle (model timeout 90 s + margin). */
export const ATTEMPT_DEADLINE_INFLIGHT_GRACE_MS = 120_000;
/**
 * A kernel that ended (or was stopped) after the deadline drain began ran out of its time
 * budget: the attempt is a resumable TIMEOUT, not a provider failure. A success stays a
 * success; cancellation and transport failures keep their own meaning.
 */
export const deadlineDrainOutcome = (outcome: ExecutorProviderOutcome, draining: boolean): ExecutorProviderOutcome => {
  if (!draining || outcome.kind !== 'provider-failed') return outcome;
  const failed = outcome as { readonly stdoutText?: string; readonly providerSessionId?: string };
  return {
    kind: 'timeout',
    terminationProven: true,
    ...(failed.providerSessionId === undefined ? {} : { providerSessionId: failed.providerSessionId }),
    ...(failed.stdoutText === undefined ? {} : { stdoutText: failed.stdoutText }),
  };
};
/** Attempt N>1 of a step: tell the kernel what an earlier attempt already left in the workspace. */
export const resumedAttemptDirective = (input: {
  readonly attemptNumber: number;
  readonly files: readonly WorkspaceFileEntry[];
  readonly filesTruncated: boolean;
  /** Compact notes of the previous attempt (renderAttemptNotes), when it left them. */
  readonly priorNotes?: string;
  /** True when a dependency store (node_modules) already exists in the workspace. */
  readonly dependenciesInstalled?: boolean;
}): string =>
  `RESUMED STEP (attempt ${String(input.attemptNumber)}): an earlier attempt of this same step ended before it finished (for example its time budget ran out). ` +
  (input.files.length === 0
    ? 'It left no project files yet. '
    : `Its files are kept in the workspace: ${input.files.map((file) => `${file.path} (${String(file.bytes)} B)`).join(', ')}${input.filesTruncated ? ', … (more not listed)' : ''}. `) +
  (input.priorNotes === undefined || input.priorNotes === '' ? '' : `${input.priorNotes} `) +
  (input.dependenciesInstalled === true ? 'Dependencies are already installed (node_modules exists): do not reinstall them unless package.json must change. ' : '') +
  'Do not start over: inspect only what you need, keep what is correct, fix what is incomplete, and continue with the remaining work. Keep tool outputs short (no full logs or directory dumps).';

/** Where a step's attempt notes live inside its workspace (excluded from inventories). */
export const attemptNotesPathOf = (workspaceRoot: string, taskId: string): string =>
  join(workspaceRoot, '.companyos', 'attempt-notes', `${taskId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80)}.json`);

export const runWithOutputCeilingRecovery = async (input: {
  readonly start: (timeoutMs: number, continuationDirective: string | undefined) => Promise<ExecutorProviderOutcome>;
  /** Rendered on the FIRST launch (e.g. a resumed attempt's workspace inventory). */
  readonly initialDirective?: string;
  /** True once the attempt is draining for its deadline: no further relaunches. */
  readonly shouldStop?: () => boolean;
  readonly workspaceRoot: string;
  readonly outputCeilingTokens?: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxContinuations?: number;
  readonly now?: () => number;
}): Promise<{ readonly outcome: ExecutorProviderOutcome; readonly continuations: number }> => {
  const now = input.now ?? Date.now;
  const max = input.maxContinuations ?? OUTPUT_CEILING_MAX_CONTINUATIONS;
  const startedMs = now();
  let outcome = await input.start(input.timeoutMs, input.initialDirective);
  let continuations = 0;
  while (continuations < max) {
    const settled = postProcessDshOutcome(outcome);
    if (settled.kind !== 'provider-failed' || settled.reasonCode !== KERNEL_OUTPUT_CEILING) break;
    if (input.signal?.aborted === true) break;
    if (input.shouldStop?.() === true) break;
    const remainingMs = input.timeoutMs - (now() - startedMs);
    if (remainingMs < OUTPUT_CEILING_CONTINUATION_MIN_REMAINING_MS) break;
    continuations += 1;
    const inventory = workspaceFileInventoryOf(input.workspaceRoot);
    const directive = outputCeilingContinuationDirective({
      continuation: continuations,
      maxContinuations: max,
      ...(input.outputCeilingTokens === undefined ? {} : { outputCeilingTokens: input.outputCeilingTokens }),
      files: inventory.files,
      filesTruncated: inventory.truncated,
    });
    outcome = await input.start(remainingMs, directive);
  }
  return { outcome, continuations };
};

/**
 * The KNOWN contract-drift signatures (recon §2/§6): each is a parse-level PROOF
 * that the runtime never invoked the task — the CLI rejected the flag, rejected
 * the task argument, or the configured profile does not exist. Matching one of
 * these is never a coercion of malformed output: the captured evidence stays
 * verbatim and the outcome is reclassified to a typed mismatch so the operator
 * gets the actionable remediation instead of a blind timeout. Everything else —
 * including genuinely unknown external outcomes — keeps the frozen uncertainty
 * semantics (no automatic replay).
 */
const DSH_CONTRACT_MISMATCH_SIGNATURES: readonly RegExp[] = [
  /unknown option '--json'/u,
  /too many arguments/iu,
  /profile "[^"]+" does not exist/u,
];

const dshContractMismatchIn = (texts: readonly string[]): boolean =>
  DSH_CONTRACT_MISMATCH_SIGNATURES.some((signature) =>
    texts.some((text) => text.length > 0 && signature.test(text)),
  );

/** The captured evidence carried by a non-succeeded outcome (empty when absent). */
const outcomeTextOf = (outcome: { readonly kind: string }): readonly string[] => {
  if (outcome.kind === 'provider-failed') {
    const failed = outcome as { readonly stdoutText?: string; readonly stderrText?: string };
    return [failed.stdoutText ?? '', failed.stderrText ?? ''];
  }
  if (outcome.kind === 'transport-failed') {
    return [(outcome as { readonly detail?: string }).detail ?? ''];
  }
  return [];
};

/**
 * Shared outcome post-processing (the frozen S24 semantics, used by BOTH launch
 * paths): contract-drift reclassification, evidence-proven session identity, and
 * the fail-closed NDJSON parse.
 */
export const postProcessDshOutcome = (outcome: ExecutorProviderOutcome): ExecutorProviderOutcome => {
  if (outcome.kind !== 'succeeded' && dshContractMismatchIn(outcomeTextOf(outcome))) {
    // Parse-level proof of non-invocation: reclassify to the typed mismatch,
    // preserving the captured evidence verbatim (never rewriting output).
    return outcome.kind === 'provider-failed'
      ? { ...outcome, reasonCode: 'EXECUTOR_DSH_PROFILE_CONTRACT_MISMATCH' }
      : outcome.kind === 'transport-failed'
        ? { ...outcome, reasonCode: 'EXECUTOR_DSH_PROFILE_CONTRACT_MISMATCH' }
        : outcome;
  }
  if (outcome.kind !== 'succeeded') {
    // The external identity can still be proven from the emitted session event
    // even when the run failed — never manufactured, only read from evidence.
    const emitted = outcome.kind === 'provider-failed' ? outcome.stdoutText : '';
    const session = parseSessionId(emitted);
    const kernelReason = outcome.kind === 'provider-failed' && outcome.reasonCode === undefined ? kernelFailureReasonCodeOf(emitted) : undefined;
    const typed = kernelReason === undefined ? outcome : { ...outcome, reasonCode: kernelReason };
    return session === null ? typed : { ...typed, providerSessionId: session };
  }
  const parsed = parseNdjsonEvents(outcome.stdoutText);
  if (!parsed.ok) {
    // Malformed structured output must NOT settle as success (§32).
    return {
      kind: 'provider-failed',
      exitCode: outcome.exitCode,
      stdoutText: outcome.stdoutText,
      stderrText: '',
      reasonCode: parsed.error.details['reason'] === undefined ? undefined : String(parsed.error.details['reason']),
      providerSessionId: parseSessionId(outcome.stdoutText) ?? undefined,
    };
  }
  if (parsed.value.finalText === null || parsed.value.finalText.trim() === '') {
    // Exit zero and a diagnostics summary are not a business result. Do not
    // materialize an apparently successful carrier for missing/empty output.
    return {
      kind: 'provider-failed', exitCode: outcome.exitCode,
      stdoutText: outcome.stdoutText, stderrText: '',
      reasonCode: parsed.value.finalText === null ? 'EXECUTOR_DSH_FINAL_MISSING' : 'EXECUTOR_DSH_FINAL_EMPTY',
      providerSessionId: parsed.value.providerSessionId,
    };
  }
  return {
    ...outcome,
    ...(parsed.value.providerSessionId === undefined ? {} : { providerSessionId: parsed.value.providerSessionId }),
    structured: {
      finalText: parsed.value.finalText,
      events: parsed.value.events,
      // STAGE 4 §20 — the kernel diagnostics summary rides the FROZEN artifactContent
      // convention: the dispatch materializes it through the ONE Sprint-13 artifact
      // service, so tool calls / commands / observation statuses enter canonical
      // evidence through the existing legal seam (bounded; the provider never writes
      // an artifact row itself).
      artifactContent: renderKernelDiagnosticsSummary(parsed.value.events),
    },
  };
};

/** Bounded kernel-diagnostics summary (tool calls + observation statuses), never raw secrets. */
const renderKernelDiagnosticsSummary = (
  events: readonly Readonly<Record<string, unknown>>[],
): string => {
  const lines: string[] = ['companyos/kernel-diagnostics/1'];
  let budget = 16_384;
  for (const event of events.slice(0, 256)) {
    const type = event['type'];
    if (type === 'tool_call') {
      const line = `tool_call ${String(event['tool'] ?? '?')} ${JSON.stringify(event['input'] ?? {}).slice(0, 512)}`;
      if (budget - line.length < 0) break;
      lines.push(line);
      budget -= line.length;
    } else if (type === 'tool_result') {
      const line = `tool_result ${String(event['callId'] ?? '?')} ${String(event['status'] ?? '?')} ${String(event['result'] ?? '').slice(0, 512)}`;
      if (budget - line.length < 0) break;
      lines.push(line);
      budget -= line.length;
    }
  }
  return lines.join('\n');
};

/**
 * STAGE 4 — the EMBEDDED launch path: the official pinned kernel as a MANAGED
 * CHILD per invocation. One execution = one disposable DSH_HOME (rendered with
 * the CompanyOS-selected model route + this attempt's trusted workspace root) +
 * the scrubbed-allowlist child environment carrying ONLY DSH_HOME and a
 * NON-SECRET route constant. The model credential NEVER enters the child
 * (argv/env/config): a per-invocation loopback MODEL BROKER injects the real
 * Authorization upstream. Both the scratch home and the broker die in `finally`.
 */
/**
 * CREDENTIAL RESOLUTION CLOSURE (PROD-01B): the credential the loopback broker may
 * inject upstream. A DECLARED credentialRef demands a resolved in-memory value — a
 * credential-reference SCHEME (vault://, secret://, …) travelling as a value is an
 * internal invariant violation and fails closed (typed) instead of ever reaching an
 * Authorization header. An empty ref with an empty value is the legal no-auth
 * contract; an empty ref WITH a value (composition-injected literal for trusted
 * local routes) dispatches unchanged.
 */
const CREDENTIAL_REF_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const credentialForBroker = (credentialRef: string | undefined, credentialValue: string | undefined): string => {
  const ref = credentialRef ?? '';
  const value = credentialValue ?? '';
  if (ref === '') return value;
  if (value !== '' && !CREDENTIAL_REF_SCHEME.test(value)) return value;
  return '';
};

/**
 * WINDOWS HEADLESS SCRIPT ASSOCIATION GUARD (LIVE-SMOKE-FIX-08 P1-1). Unattended
 * execution must not depend on DESKTOP file associations for programming-language
 * scripts. The host PATHEXT on this deployment class carries the Windows Script
 * Host extensions (.JS .JSE .VBS .VBE .WSF .WSH — observed live:
 * `.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC`), so a bare-name script
 * invocation inside the DSH child shell can resolve through the association to
 * wscript.exe (empirically CONFIRMED: `cmd /c probe` with the default PATHEXT
 * launches WSH). The guard REFINES the child-only PATHEXT (declaredAdditions may
 * refine an allowlisted variable; the host environment is never touched) by
 * dropping exactly the WSH-hosted extensions while PRESERVING everything else the
 * deployment declared (executable/batch/console extensions and any custom entries).
 *
 * Empirically scoped residual (documented, not fixable at this boundary): an
 * EXPLICIT-extension path (`cmd /c path\to\probe.js`) is association-dispatched by
 * cmd.exe regardless of PATHEXT — closing that form requires registry/IFEO/global
 * WSH changes that are explicitly out of bounds. The compensating controls are the
 * durable pre-dispatch/settled audit events (P1-2) and the bounded attempt retry.
 * Explicit runtime invocation (`node probe.js`) is and remains the supported path.
 */
const WSH_SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.JS', '.JSE', '.VBS', '.VBE', '.WSF', '.WSH']);

/** The child-safe fallback when the host declares no usable PATHEXT at all. */
const HEADLESS_FALLBACK_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export const sanitizePathextForHeadlessChild = (hostPathext: string | undefined): string => {
  const entries = (hostPathext ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && !WSH_SCRIPT_EXTENSIONS.has(entry.toUpperCase()));
  return (entries.length > 0 ? entries : HEADLESS_FALLBACK_PATHEXT.split(';')).join(';');
};

/**
 * LIVE-SMOKE-FIX-08B — build the LEVEL B stdout line tap for one attempt. Every
 * kernel `tool_call <tool> <args-json>` line becomes a durable, redacted
 * `executor.tool_invocation_requested` event AT ARRIVAL (the kernel streams the
 * line BEFORE the tool runs, so a timeout/kill/crash keeps the exact inner
 * command form — node bin\cli.js vs bin\cli.js vs cmd /c bin\cli.js).
 * Non-tool_call lines are ignored; a rejected append never fails the attempt
 * (evidence is best-effort observation, never execution truth).
 */
export interface DshToolInvocationAudit {
  append(events: readonly unknown[]): Promise<unknown>;
  secrets(): readonly string[];
  ids: {id(prefix?: string): string; ulid(): string};
  /**
   * LIVE-SMOKE-FIX-08C — REQUIRED loud surface for evidence-append failures. The
   * kernel controls the inner tool process start (CompanyOS has no gate there), so
   * a failed LEVEL B append can never block execution — but it must never be
   * SILENT either: the composition logs it through this callback (typed reason),
   * and the timeout-path stdout tail (dispatch_settled payload) still carries the
   * verbatim tool_call lines as equivalent attribution.
   */
  onFailure(error: unknown): void;
}

export const dshToolCallTapOf = (
  audit: DshToolInvocationAudit,
  attribution: {
    readonly attemptId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly roleId: string;
    readonly cwd: string | null;
  },
): ((line: string) => void) => {
  let toolSequence = 0;
  return (line: string): void => {
    /*
     * TWO wire forms feed the tap (LIVE-SMOKE-FIX-08C — proven against the REAL
     * kernel):
     *  - the `--json` ndjson session line: {"type":"tool_call","callId":...,
     *    "tool":"pwsh","input":{...}} — the canonical machine form;
     *  - the presentation text line: tool_call <tool> <args-json> — the rendered
     *    form the Smoke-07 transcripts carried.
     * Both identify the SAME pre-execution fact; the ndjson form wins when a line
     * could parse as either. Non-tool lines return without appending.
     */
    let tool = '';
    let argsText = '';
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as {type?: unknown; tool?: unknown; input?: unknown};
        if (parsed.type !== 'tool_call' || typeof parsed.tool !== 'string') return;
        tool = parsed.tool;
        argsText = JSON.stringify(parsed.input ?? null);
      } catch {
        return; // a non-JSON line that merely starts with '{' is not a tool call
      }
    } else if (trimmed.startsWith('tool_call ')) {
      const spaceAt = trimmed.indexOf(' ', 'tool_call '.length);
      tool = spaceAt < 0 ? '' : trimmed.slice('tool_call '.length, spaceAt).trim();
      argsText = spaceAt < 0 ? '' : trimmed.slice(spaceAt + 1);
    } else {
      return;
    }
    if (tool === '') return;
    toolSequence += 1;
    const secrets = audit.secrets();
    const at = new Date().toISOString();
    void audit.append([
      createCoreDomainEvent(
        'executor.tool_invocation_requested',
        {type: 'ExecutionAttempt', id: attribution.attemptId},
        {
          attemptId: attribution.attemptId,
          taskId: attribution.taskId,
          runId: attribution.runId,
          roleId: attribution.roleId,
          sequence: toolSequence,
          tool,
          argsSha256: createHash('sha256').update(argsText).digest('hex'),
          argsLength: argsText.length,
          argsHead: redactSecrets(argsText.slice(0, 400), secrets),
          cwd: attribution.cwd,
          at,
        },
        {traceId: `trace_attempt_${attribution.attemptId}`, actorId: 'system:dsh-executor', now: at, ids: audit.ids},
      ),
    ]).catch((error: unknown) => audit.onFailure(error));
  };
};

/**
 * V1 EFFICIENCY E1-B — bounded OBSERVATIONAL in-attempt activity tap.
 *
 * The kernel streams its whole session to stdout; the tool_call tap above already
 * records every TOOL_CALL durably, so this tap records ONLY the remaining coarse
 * activity evidence, coalesced: at most ONE `executor.attempt_activity` event per
 * category per ~10-second window per attempt, carrying counts + a redacted
 * fingerprint head — never raw streamed text, prompts, or tool output.
 *
 *   KERNEL_STATUS        — ndjson lines the kernel itself emits with a non-tool_call
 *                          `type` (session/status/result summaries): kernel-observable
 *                          activity. Model-internal activity is NOT observable and no
 *                          such claim is made.
 *   STREAM_ACTIVITY      — any other non-empty stdout line (rendered text).
 *
 * ACTIVITY IS NOT PROGRESS: these events carry no progress semantics, feed no
 * policy, and change no timeout/retry/settlement behavior — they exist so a
 * later reader can distinguish "kernel emitted something recently" from "silent
 * for minutes" inside one opaque attempt. Purely additive observation; a failed
 * append is loud (onFailure) and never fails the attempt.
 */
export type DshAttemptActivityCategory = 'KERNEL_STATUS' | 'STREAM_ACTIVITY';

export const DSH_ATTEMPT_ACTIVITY_WINDOW_MS = 10_000;
const DSH_ATTEMPT_ACTIVITY_HEAD_LIMIT = 120;

export const dshAttemptActivityTapOf = (
  audit: DshToolInvocationAudit,
  attribution: {readonly attemptId: string; readonly taskId: string; readonly runId: string; readonly roleId: string},
  options: {readonly now?: () => number} = {},
): ((line: string) => void) => {
  const now = options.now ?? ((): number => Date.now());
  const windows = new Map<DshAttemptActivityCategory, {windowStart: number; lineCount: number; fingerprint: string; lastHead: string}>();
  return (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let category: DshAttemptActivityCategory;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as {type?: unknown; tool?: unknown};
        // tool_call lines are already recorded per-call by the tool tap — never duplicated here
        if (parsed.type === 'tool_call' || typeof parsed.tool === 'string') return;
        category = 'KERNEL_STATUS';
      } catch {
        category = 'STREAM_ACTIVITY'; // non-JSON '{'-line: rendered text
      }
    } else if (trimmed.startsWith('tool_call ')) {
      return; // presentation-form tool call — already recorded per-call
    } else {
      category = 'STREAM_ACTIVITY';
    }
    const at = now();
    let window = windows.get(category);
    if (window === undefined || at - window.windowStart >= DSH_ATTEMPT_ACTIVITY_WINDOW_MS) {
      if (window !== undefined) {
        emitActivityWindow(audit, attribution, category, window);
      }
      window = {windowStart: at, lineCount: 0, fingerprint: '', lastHead: ''};
      windows.set(category, window);
    }
    window.lineCount += 1;
    window.fingerprint = createHash('sha256').update(trimmed).digest('hex');
    window.lastHead = trimmed.slice(0, DSH_ATTEMPT_ACTIVITY_HEAD_LIMIT);
  };
};

/** Flush the accumulated window as one bounded observation event (best-effort). */
const emitActivityWindow = (
  audit: DshToolInvocationAudit,
  attribution: {readonly attemptId: string; readonly taskId: string; readonly runId: string; readonly roleId: string},
  category: DshAttemptActivityCategory,
  window: {windowStart: number; lineCount: number; fingerprint: string; lastHead: string},
): void => {
  if (window.lineCount === 0) return;
  const secrets = audit.secrets();
  const at = new Date().toISOString();
  void audit.append([
    createCoreDomainEvent(
      'executor.attempt_activity',
      {type: 'ExecutionAttempt', id: attribution.attemptId},
      {
        attemptId: attribution.attemptId,
        taskId: attribution.taskId,
        runId: attribution.runId,
        roleId: attribution.roleId,
        activityType: category,
        activityIsProgress: false,
        windowStartAt: new Date(window.windowStart).toISOString(),
        lineCount: window.lineCount,
        lastLineSha256: window.fingerprint,
        lastLineHead: redactSecrets(window.lastHead, secrets),
      },
      {traceId: `trace_attempt_${attribution.attemptId}`, actorId: 'system:dsh-executor', now: at, ids: audit.ids},
    ),
  ]).catch((error: unknown) => audit.onFailure(error));
};

const createEmbeddedDshProvider = (config: DshProviderConfig, timeoutMs: number): ExecutorProvider => {
  const embedded = config.embedded!;
  return {
    supportsCallAdmission: true,
    descriptor: { providerKey: DSH_PROVIDER_KEY, capabilities: DSH_CAPABILITIES },
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      const workspaceRoot = request.workspace?.root ?? request.workspace?.cwd ?? null;
      if (workspaceRoot === null) {
        // The embedded kernel is workspace-anchored by design: no trusted root, no run.
        return {
          kind: 'transport-failed',
          reasonCode: 'EXECUTOR_EMBEDDED_WORKSPACE_REQUIRED',
          detail: 'The embedded DSH kernel requires a trusted workspace root on the request; failing closed.',
        };
      }
      // STAGE 6: deterministic model selection — CompanyOS alone picks the profile
      // for this attempt (Boss §2/§11). Fail-closed on any unavailability.
      let modelRoute: EmbeddedDshModelRoute;
      let modelSnapshot: SelectedModelSnapshot | undefined;
      if (request.selectedModelRoute !== undefined) {
        // STAGE 8B §5-§7/§10: the CompanyOS-selected route (the Smart Router's
        // RoutingDecision, attached to THIS attempt before invocation) is
        // consumed VERBATIM. The kernel never re-scores, re-fallback or
        // re-routes — selection authority stays with CompanyOS.
        const selected = request.selectedModelRoute;
        modelSnapshot = {
          modelProfileId: selected.modelProfileId,
          providerId: selected.providerId,
          modelId: selected.modelId,
          configurationVersion: selected.configurationVersion,
        };
        modelRoute = {
          providerId: selected.providerId,
          modelId: selected.modelId,
          baseURL: selected.baseURL,
          apiKeyEnv: 'COMPANYOS_MODEL_ROUTE_ACCESS',
          /*
           * CREDENTIAL RESOLUTION CLOSURE (PROD-01B): a route that DECLARES a
           * credentialRef must carry the in-memory RESOLVED value — a pointer string
           * here would travel to the broker's Authorization header. A pointer-shaped
           * credential is an internal invariant violation: fail closed (typed), never
           * send-and-hope-for-401. A route with neither ref nor value is the legal
           * no-auth contract and dispatches with an empty credential.
           */
          apiKeyValue: credentialForBroker(selected.credentialRef, selected.credentialValue),
          contextWindow: selected.contextWindow,
          maxTokens: selected.maxTokens,
        };
      } else if (embedded.requireRequestedModel === true) {
        // SMART_ROUTER_V1 without a CompanyOS-selected route: fail loud. The
        // kernel choosing its own model here would be hidden routing.
        return {
          kind: 'transport-failed',
          reasonCode: 'COMPANYOS_SELECTED_MODEL_REQUIRED',
          detail:
            'This kernel is configured to require the CompanyOS-selected model route (Smart Router V1); the request carried none.',
        };
      } else if (embedded.modelPool !== undefined) {
        const selection = selectModelProfile(embedded.modelPool, embedded.selectionRequirements ?? {});
        if (!selection.ok) {
          const reasonCode = String(selection.error.details['reason'] ?? 'MODEL_SELECTION_FAILED');
          return {
            kind: 'transport-failed',
            reasonCode,
            detail: selection.error.message,
          };
        }
        const profile = selection.value.profile;
        modelSnapshot = snapshotOf(profile);
        modelRoute = {
          providerId: profile.providerId,
          modelId: profile.modelId,
          baseURL: profile.endpointURL,
          apiKeyEnv: 'COMPANYOS_MODEL_ROUTE_ACCESS',
          // PROD-01B: a declared ref requires a resolved value here — a pointer is
          // never forwarded (fail closed below when the route stays unresolved).
          apiKeyValue: credentialForBroker(profile.credentialRef, undefined),
          contextWindow: profile.contextWindowTokens,
          maxTokens: profile.maxOutputTokens,
        };
        if (profile.credentialRef !== '' && modelRoute.apiKeyValue === '') {
          return {
            kind: 'transport-failed',
            reasonCode: 'MODEL_CREDENTIAL_MISSING',
            detail: `The embedded model route for profile "${profile.modelProfileId}" declares credentialRef "${profile.credentialRef}" that resolved to no credential; the dispatch fails closed instead of sending the pointer upstream.`,
          };
        }
      } else if (embedded.modelRoute !== undefined) {
        // The trusted composition route already carries its resolved (or legitimately
        // empty) credential; the broker-side scheme guard below is the final net.
        modelRoute = {
          ...embedded.modelRoute,
          apiKeyValue: credentialForBroker(
            embedded.modelRoute.apiKeyValue === '' ? '' : embedded.modelRoute.apiKeyEnv,
            embedded.modelRoute.apiKeyValue,
          ),
        };
        if (embedded.modelRoute.apiKeyValue !== '' && CREDENTIAL_REF_SCHEME.test(embedded.modelRoute.apiKeyValue)) {
          return {
            kind: 'transport-failed',
            reasonCode: 'MODEL_CREDENTIAL_MISSING',
            detail: 'The embedded model route carries a credential-reference scheme where a resolved credential is required; the dispatch fails closed instead of sending a pointer upstream.',
          };
        }
      } else {
        return {
          kind: 'transport-failed',
          reasonCode: 'MODEL_POOL_EMPTY',
          detail: 'The embedded DSH provider requires a model pool or explicit model route (fail-closed).',
        };
      }
      // H16b-3: the isolation decision precedes the broker (it fixes the broker port).
      let isolationDecision: IsolationDispatchDecision | undefined;
      if (embedded.isolation !== undefined) {
        try {
          isolationDecision = await embedded.isolation.decide();
        } catch (error) {
          isolationDecision = {
            kind: 'refuse',
            reasonCode: 'ISOLATION_DEGRADED',
            problems: [`status:threw:${error instanceof Error ? error.message : String(error)}`],
          };
        }
        if (isolationDecision.kind === 'refuse') {
          return {
            kind: 'transport-failed',
            reasonCode: 'ISOLATION_DEGRADED',
            detail: `Windows isolation was configured but no longer matches (${isolationDecision.problems.join(', ')}); the goal is not dispatched unisolated. Re-run isolation setup or remove it in Settings.`,
          };
        }
      }
      // The loopback model broker: injects the real credential upstream, streams SSE
      // both ways, and dies with the invocation (in-process; never a child process,
      // never a port held past the attempt, never a secret in kernel-visible config
      // or env — the Sprint24 §35 secret law holds literally).
      const exchangeAudit = embedded.toolInvocationAudit;
      /*
       * LIVE-CONTRACT-FILL run 9 — WRAP-UP MECHANISM: every model request carries the attempt's
       * time left and the step's spend left; below a threshold it carries the forced WRAP-UP
       * instruction, and once the bounded wrap-up window is used up the attempt drains.
       */
      const clockNow = embedded.now ?? Date.now;
      const attemptClock = { startedMs: clockNow(), deadlineMs: request.timeoutMs ?? timeoutMs };
      let drainForWrapUp: () => void = () => undefined;
      /*
       * LIVE-CONTRACT-FILL run 10 — an attempt that can no longer progress (silent kernel, or a
       * drained wrap-up) ends now, exactly like its deadline, instead of idling until it.
       */
      const earlyStop = createAttemptEarlyStop({
        silenceMs: embedded.kernelSilenceMs ?? kernelSilenceMsOf(process.env),
        now: clockNow,
        armTimer: config.timer ?? ((ms: number, callback: () => void) => {
          const handle = setTimeout(callback, ms);
          return () => clearTimeout(handle);
        }),
      });
      const turnNoter = createTurnNoter({
        thresholds: embedded.wrapUp ?? wrapUpThresholdsOf(process.env),
        status: async () => {
          let step: { readonly stepSpentMicros: number; readonly stepCapMicros: number } | null = null;
          try { step = (await request.modelCallBudgetStatus?.()) ?? null; } catch { step = null; }
          return {
            attemptMsLeft: attemptClock.deadlineMs - (clockNow() - attemptClock.startedMs),
            ...(step === null ? {} : { stepSpentMicros: step.stepSpentMicros, stepCapMicros: step.stepCapMicros }),
          };
        },
      });
      const broker = await startModelBroker({
        rewriteRequest: async (body: Buffer) => {
          earlyStop.activity();
          const { note, exhausted } = await turnNoter.next();
          if (exhausted) {
            drainForWrapUp();
            earlyStop.fire('WRAP_UP_DRAINED');
            return { body, drain: true };
          }
          return { body: injectTurnNote(body, note.text, request.modelCallInputBoundBytes) ?? body };
        },
        upstreamBaseURL: modelRoute.baseURL,
        bearer: modelRoute.apiKeyValue,
        ...(exchangeAudit === undefined ? {} : {
          observe: (observation: ModelBrokerExchangeObservation) => {
            earlyStop.activity();
            const at = new Date().toISOString();
            void exchangeAudit.append([
              createCoreDomainEvent(
                'executor.model_exchange_observed',
                {type: 'ExecutionAttempt', id: String(request.attemptId)},
                {attemptId: String(request.attemptId), taskId: String(request.taskId), runId: String(request.runId), ...observation, at},
                {traceId: `trace_attempt_${String(request.attemptId)}`, actorId: 'system:dsh-executor', now: at, ids: exchangeAudit.ids},
              ),
            ]).catch((error: unknown) => exchangeAudit.onFailure(error));
          },
        }),
        ...(request.modelCallAdmission === undefined ? {} : { admission: request.modelCallAdmission }),
        ...(isolationDecision?.kind === 'launch-isolated' ? { listenPort: isolationDecision.brokerPort } : {}),
      });
      if (!broker.ok) {
        return {
          kind: 'transport-failed',
          reasonCode: String(broker.error.details['reason'] ?? 'EXECUTOR_EMBEDDED_BROKER_FAILED'),
          detail: broker.error.message,
        };
      }
      const compaction = kernelCompactionSizingFor(kernelContextWindowFor(modelRoute.contextWindow, request.modelCallInputBoundBytes), modelRoute.maxTokens);
      if (!compaction.ok) {
        broker.value.close();
        return { kind: 'transport-failed', reasonCode: 'EXECUTOR_KERNEL_CONTEXT_WINDOW_TOO_SMALL', detail: String(compaction.reason) };
      }
      // STAGE 5B: stage a fresh verified execution copy for THIS attempt — the
      // child executes ONLY from the staged tree (100% closure hash pass), and
      // source-tree tamper after staging can never reach it.
      const stage = embedded.runtime.prepareAttemptStage({ attemptId: request.attemptId });
      if (!stage.ok) {
        broker.value.close();
        return {
          kind: 'transport-failed',
          reasonCode: String(stage.error.details['reason'] ?? 'EXECUTOR_EMBEDDED_RUNTIME_STAGE_FAILED'),
          detail: stage.error.message,
        };
      }
      const home = stage.value.newDshHome({
        attemptId: request.attemptId,
        workspaceRoot,
        // STAGE 4: the Goal's canonical access policy enforced by the KERNEL sandbox.
        sandboxMode: dshSandboxModeOf(request.work.goalStructured),
        route: {
          ...modelRoute,
          // H15d-fix3: the kernel's working window never exceeds what the admission admits.
          contextWindow: kernelContextWindowFor(modelRoute.contextWindow, request.modelCallInputBoundBytes),
          upstreamBaseURL: modelRoute.baseURL,
          baseURL: broker.value.url,
          apiKeyEnv: 'COMPANYOS_MODEL_ROUTE_ACCESS',
          apiKeyValue: 'companyos-model-broker',
        },
      });
      if (!home.ok) {
        stage.value.dispose();
        broker.value.close();
        return {
          kind: 'transport-failed',
          reasonCode: String(home.error.details['reason'] ?? 'EXECUTOR_EMBEDDED_HOME_RENDER_FAILED'),
          detail: home.error.message,
        };
      }
      try {
        /*
         * STAGE 5 environment isolation: the child's HOME/USERPROFILE point at the
         * per-attempt scratch (never the real user home — ~/.ssh, ~/.gitconfig,
         * ~/.npmrc, ~/.dsh are unreachable by construction), and Git reads ONLY the
         * scratch's empty config (no user/global/system config, no credential
         * helpers, no hooks from outside the workspace). All names pass the S25
         * secret-shape filter (none is credential-shaped).
         */
        const scratchGitConfig = join(home.value.dshHome, 'git-config');
        writeFileSync(scratchGitConfig, '', 'utf8');
        // STAGE 5B pre-spawn gate: refuse to spawn if the staged tree drifted.
        const preSpawn = stage.value.verifyStaged();
        if (!preSpawn.ok) {
          return {
            kind: 'transport-failed',
            reasonCode: String(preSpawn.error.details['reason'] ?? 'EXECUTOR_EMBEDDED_RUNTIME_TAMPERED'),
            detail: preSpawn.error.message,
          };
        }
        /*
         * LIVE-SMOKE-FIX-08B — LEVEL B inner-tool attribution. The kernel streams its
         * session as ndjson-ish lines on stdout; `tool_call <tool> <args-json>` lines
         * appear BEFORE the invoked tool's output. The incremental line tap appends a
         * durable `executor.tool_invocation_requested` event PER tool_call AT ARRIVAL —
         * timeout/kill/crash attempts keep the exact inner command form. Purely
         * additive observation; parse failures are skipped (never fail the attempt).
         */
        const toolTap = embedded.toolInvocationAudit === undefined
          ? undefined
          : dshToolCallTapOf(embedded.toolInvocationAudit, {
            attemptId: String(request.attemptId),
            taskId: String(request.taskId),
            runId: String(request.runId),
            roleId: String(request.roleId),
            cwd: workspaceRoot ?? null,
          });
        /*
         * V1 EFFICIENCY E1-B — the same stdout lines also feed the bounded activity
         * tap (coalesced KERNEL_STATUS / STREAM_ACTIVITY windows). Observation only:
         * no timeout, retry, routing, or settlement behavior reads it.
         */
        const activityTap = embedded.toolInvocationAudit === undefined
          ? undefined
          : dshAttemptActivityTapOf(embedded.toolInvocationAudit, {
            attemptId: String(request.attemptId),
            taskId: String(request.taskId),
            runId: String(request.runId),
            roleId: String(request.roleId),
          });
        // LIVE-CONTRACT-FILL run 9: the verified-work tracker reads every tool call/result live.
        const verifiedWork = createVerifiedWorkTracker();
        const tapStdoutLine = (line: string): void => {
          earlyStop.activity();
          toolTap?.(line);
          activityTap?.(line);
          verifiedWork.observe(line);
        };
        // STAGE 4 E2E: with no dedicated node configured, the child runs on THIS
        // Electron binary. ELECTRON_RUN_AS_NODE=1 makes it a plain Node runtime for the
        // kernel CLI (Electron's Node satisfies the manifest nodeRange) — without it the
        // child boots as a GUI Electron app and exits with a Windows status code.
        // H15: the packaged kernel ships its pinned Node runtime (staged + verified);
        // the user's PATH node is consulted only for a dev materialization without one.
        const childExecutable = embedded.nodeExecutable ?? stage.value.nodeExecutablePath ?? resolveEmbeddedChildNode();
        const childIsElectron = childExecutable === process.execPath;
        // Official 0.2.0 launcher grammar: positional profile first, then options,
        // then the task (passThroughOptions requires the leading positional).
        const kernelArgv = [stage.value.cliEntryPath, embedded.runtime.manifest.profileName, '--json'];
        let launchExecutable = childExecutable;
        let launchArgv: readonly string[] = kernelArgv;
        if (embedded.isolation !== undefined && isolationDecision !== undefined) {
          const plan = planIsolatedLaunch({
            decision: isolationDecision,
            config: embedded.isolation,
            workspaceRoot,
            childExecutable,
            childArgv: kernelArgv,
          });
          if (plan.kind === 'refused') {
            return {
              kind: 'transport-failed',
              reasonCode: plan.reasonCode,
              detail: `Windows isolation is configured but its launch prerequisites are missing (${plan.problems.join(', ')}); the goal is not dispatched unisolated.`,
            };
          }
          if (plan.kind === 'isolated') {
            launchExecutable = plan.executable;
            launchArgv = plan.argvPrefix;
          }
        }
        let continuationDirective: string | undefined;
        // LIVE-CONTRACT-FILL run 9: tell the kernel which external tools exist on this machine.
        let externalToolsLine: string | null = null;
        try { externalToolsLine = externalToolsLineOf((embedded.detectExternalTools ?? (() => detectExternalTools(process.env)))()); } catch { externalToolsLine = null; }
        // LIVE-CONTRACT-FILL run 11: tell the kernel what work already exists in its workspace.
        let workspaceInventoryLine: string | null = null;
        try { workspaceInventoryLine = workspaceInventoryLineOf(workspaceInventoryOf(workspaceRoot)); } catch { workspaceInventoryLine = null; }
        /*
         * LIVE-CONTRACT-FILL run 5 — DEADLINE DRAIN. Shortly before the attempt deadline the
         * broker stops admitting new model calls; at the deadline the kill waits (bounded) for
         * the in-flight call to settle. A kernel cut short this way ended a RESUMABLE timeout
         * (workspace kept; the next attempt continues from it), never an unknown-usage lock.
         */
        const attemptDeadlineMs = request.timeoutMs ?? timeoutMs;
        let deadlineDraining = false;
        const beginDeadlineDrain = (): void => {
          deadlineDraining = true;
          broker.value.stopAdmitting();
        };
        drainForWrapUp = beginDeadlineDrain;
        const armTimer = config.timer ?? ((ms: number, callback: () => void) => {
          const handle = setTimeout(callback, ms);
          return () => clearTimeout(handle);
        });
        const cancelDrainLead = armTimer(Math.max(0, attemptDeadlineMs - attemptDrainLeadMs(attemptDeadlineMs)), beginDeadlineDrain);
        const provider = createProcessExecutorProvider({
          providerKey: DSH_PROVIDER_KEY,
          beforeTimeoutStop: async () => {
            beginDeadlineDrain();
            await broker.value.whenIdle(ATTEMPT_DEADLINE_INFLIGHT_GRACE_MS);
          },
          earlyTimeout: (fire: () => void) => earlyStop.subscribe(fire),
          capabilities: DSH_CAPABILITIES,
          executable: launchExecutable,
          baseArgv: [...launchArgv],
          fallbackCwd: null,
          trustedRoot: workspaceRoot,
          envPolicy: {
            declaredAdditions: {
              DSH_HOME: home.value.dshHome,
              ...(childIsElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
              COMPANYOS_MODEL_ROUTE_ACCESS: 'companyos-model-broker',
              HOME: home.value.dshHome,
              USERPROFILE: home.value.dshHome,
              APPDATA: join(home.value.dshHome, 'appdata'),
              GIT_CONFIG_GLOBAL: scratchGitConfig,
              GIT_CONFIG_SYSTEM: scratchGitConfig,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_TERMINAL_PROMPT: '0',
              // LIVE-SMOKE-FIX-08 P1-1 — child-only headless PATHEXT (WSH-hosted
              // script extensions removed; see sanitizePathextForHeadlessChild).
              PATHEXT: sanitizePathextForHeadlessChild(process.env.PATHEXT),
            },
          },
          timer: config.timer ?? ((ms, callback) => {
            const handle = setTimeout(callback, ms);
            return () => clearTimeout(handle);
          }),
          tapStdoutLine,
          buildArgs: (invocation) => {
            const argv: string[] = [];
            if (
              invocation.continuationSessionId !== undefined &&
              invocation.continuationSessionId !== ''
            ) {
              argv.push('--session-id', invocation.continuationSessionId);
            }
            argv.push(dshTaskTextOf(invocation, {
              outputCeilingTokens: modelRoute.maxTokens,
              ...(externalToolsLine === null ? {} : { externalToolsLine }),
              ...(workspaceInventoryLine === null ? {} : { workspaceInventoryLine }),
              ...(continuationDirective === undefined ? {} : { continuationDirective }),
            }));
            return argv;
          },
          parseResult: (stdoutText) => {
            if (
              !stdoutText.includes('"type":"session"') &&
              !stdoutText.includes('"type": "session"')
            ) {
              return null;
            }
            return { structured: { ndjson: stdoutText } };
          },
        });
        const resumed = request.attemptNumber > 1 ? workspaceFileInventoryOf(workspaceRoot) : undefined;
        /*
         * LIVE-CONTRACT-FILL run 6 — a retry RESUMES: it starts a fresh, small kernel context
         * (never a replay of the failed conversation) seeded with the workspace inventory and
         * the previous attempt's compact notes (its last actions, last note, why it ended).
         */
        const notesPath = attemptNotesPathOf(workspaceRoot, request.taskId);
        let priorNotes: string | undefined;
        if (resumed !== undefined) {
          try {
            const notes = parseAttemptNotes(readFileSync(notesPath, 'utf8'));
            if (notes !== null && notes.taskId === request.taskId && notes.attemptNumber < request.attemptNumber) priorNotes = renderAttemptNotes(notes);
          } catch {
            priorNotes = undefined;
          }
        }
        const dependenciesInstalled = resumed !== undefined && existsSync(join(workspaceRoot, 'node_modules'));
        attemptClock.startedMs = clockNow();
        earlyStop.start();
        const attemptStartedAt = new Date().toISOString();
        const { outcome: rawOutcome } = await runWithOutputCeilingRecovery({
          workspaceRoot,
          outputCeilingTokens: modelRoute.maxTokens,
          timeoutMs: attemptDeadlineMs,
          shouldStop: () => deadlineDraining || earlyStop.reason() !== null,
          ...(resumed === undefined || (resumed.files.length === 0 && priorNotes === undefined) ? {} : {
            initialDirective: resumedAttemptDirective({
              attemptNumber: request.attemptNumber, files: resumed.files, filesTruncated: resumed.truncated,
              ...(priorNotes === undefined ? {} : { priorNotes }), dependenciesInstalled,
            }),
          }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          start: async (attemptTimeoutMs, directive) => {
            continuationDirective = directive;
            try {
              return await provider.start({ ...request, timeoutMs: attemptTimeoutMs });
            } finally {
              continuationDirective = undefined;
            }
          },
        });
        cancelDrainLead();
        earlyStop.stop();
        const outcome = deadlineDrainOutcome(rawOutcome, deadlineDraining);
        /*
         * LIVE-CONTRACT-FILL run 9 — CREDIT VERIFIED WORK: an attempt that ran out of time or budget
         * after its last test run passed and proved every criterion finishes the step (files kept)
         * instead of a blind retry. Anything less stays a resumable timeout (notes below).
         */
        const credit = outcome.kind === 'succeeded' ? null : (() => {
          const inventory = workspaceFileInventoryOf(workspaceRoot);
          return verifiedWorkCreditOf({
            outcome: outcome as { readonly kind: string; readonly stdoutText?: string; readonly stderrText?: string },
            evidence: verifiedWork.evidence(),
            criteria: request.work.acceptanceCriteria ?? [],
            requiresFileDelivery: relevantFileDeliveriesOf(request).length > 0,
            files: inventory.files,
            filesTruncated: inventory.truncated,
          });
        })();
        if (outcome.kind !== 'succeeded' && credit === null) {
          const stdoutText = (outcome as { readonly stdoutText?: string }).stdoutText ?? '';
          try {
            mkdirSync(join(notesPath, '..'), { recursive: true });
            writeFileSync(notesPath, JSON.stringify(attemptNotesOf({
              taskId: request.taskId,
              attemptNumber: request.attemptNumber,
              outcome: outcome.kind,
              endReason: earlyStop.reason() ?? (outcome as { readonly reasonCode?: string }).reasonCode ?? kernelFailureReasonCodeOf(stdoutText) ?? null,
              stdoutText,
            })));
          } catch {
            // notes are an optimisation for the next attempt; their absence never fails this one
          }
        }
        // STAGE 5B post-spawn gate: a staged-tree tamper in flight means the child
        // may have executed unverified bytes — the attempt fails loud, never silent.
        const postSpawn = stage.value.verifyStaged();
        if (!postSpawn.ok) {
          return {
            kind: 'transport-failed',
            reasonCode: String(postSpawn.error.details['reason'] ?? 'EXECUTOR_EMBEDDED_RUNTIME_TAMPERED_POST_SPAWN'),
            detail: postSpawn.error.message,
          };
        }
        if (credit !== null) {
          const stdoutText = (outcome as { readonly stdoutText?: string }).stdoutText ?? '';
          const sessionId = (outcome as { readonly providerSessionId?: string }).providerSessionId ?? parseSessionId(stdoutText) ?? undefined;
          if (exchangeAudit !== undefined) {
            const at = new Date().toISOString();
            void exchangeAudit.append([
              createCoreDomainEvent(
                'executor.verified_work_credited',
                {type: 'ExecutionAttempt', id: String(request.attemptId)},
                {attemptId: String(request.attemptId), taskId: String(request.taskId), runId: String(request.runId), endedAs: outcome.kind, criteria: credit.criteria, testRun: credit.run, wrapUpTurns: turnNoter.wrapUpTurns(), wrapUpTrigger: turnNoter.trigger(), at},
                {traceId: `trace_attempt_${String(request.attemptId)}`, actorId: 'system:dsh-executor', now: at, ids: exchangeAudit.ids},
              ),
            ]).catch((error: unknown) => exchangeAudit.onFailure(error));
          }
          const credited: ExecutorProviderOutcome = {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText,
            ...(sessionId === undefined ? {} : { providerSessionId: sessionId }),
            structured: {
              finalText: credit.finalText,
              events: [],
              verifiedWorkCredit: { endedAs: outcome.kind, criteria: credit.criteria, testRun: credit.run },
              artifactContent: ['companyos/verified-work-credit/1', `ended ${outcome.kind}`, `test ${credit.run.command.slice(0, 200)} passed=${String(credit.run.passed)} failed=0 skipped=${String(credit.run.skipped)}`, `criteria ${credit.criteria.join(',')}`].join('\n'),
            },
            startedAt: attemptStartedAt,
            finishedAt: new Date().toISOString(),
          };
          return modelSnapshot === undefined ? credited : { ...credited, selectedModel: modelSnapshot } as typeof credited;
        }
        // STAGE 6: the Selected Model Snapshot is execution evidence (Boss §10) —
        // attached to the provider outcome metadata for audit, never a second truth.
        const processed = postProcessDshOutcome(outcome);
        if (modelSnapshot !== undefined && processed.kind === 'succeeded') {
          return {
            ...processed,
            selectedModel: modelSnapshot,
          } as typeof processed;
        }
        return processed;
      } finally {
        earlyStop.stop();
        // An exchange the kernel abandoned keeps reading upstream so its usage settles
        // KNOWN; give it a bounded moment before the broker (and its sockets) close.
        broker.value.stopAdmitting();
        await broker.value.whenIdle(ATTEMPT_DEADLINE_INFLIGHT_GRACE_MS);
        home.value.dispose();
        stage.value.dispose();
        broker.value.close();
      }
    },
  };
};

export const createDshProvider = (config: DshProviderConfig): ExecutorProvider => {
  const timeoutMs = config.timeoutMs ?? dshConfigInteger(config.config, 'timeoutMs') ?? 120_000;
  if (config.embedded !== undefined) {
    return createEmbeddedDshProvider(config, timeoutMs);
  }
  const provider = createProcessExecutorProvider({
    providerKey: DSH_PROVIDER_KEY,
    capabilities: DSH_CAPABILITIES,
    executable: config.nodeExecutable,
    // ABSOLUTE: the harness entry must resolve regardless of which trusted workspace
    // the dispatch runs in (a relative argv would only work with cwd = runtime dir).
    baseArgv: [join(config.runtimeDir, 'lib', 'bin.js'), '--profile', config.profileName, '--json'],
    // The DECLARED fallback is honored; when none is declared the dispatch fails
    // closed rather than guessing a directory.
    fallbackCwd: config.fallbackCwd,
    /*
     * When a fallback exists it is self-anchored: the composition asserts that
     * exact directory, and existence/shape/reparse checks still run per spawn.
     * A real workspace root (carried on the request) is contained in IT instead —
     * the dispatch preflight passes the canonical root as the request cwd.
     */
    ...(config.fallbackCwd === null ? {} : { trustedRoot: config.fallbackCwd }),
    timer: config.timer ?? ((ms, callback) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    }),
    buildArgs: (request) => {
      const argv: string[] = [];
      if (request.continuationSessionId !== undefined && request.continuationSessionId !== '') {
        argv.push('--session-id', request.continuationSessionId);
      }
      argv.push(dshTaskTextOf(request));
      return argv;
    },
    parseResult: (stdoutText) => {
      if (!stdoutText.includes('"type":"session"') && !stdoutText.includes('"type": "session"')) {
        return null;
      }
      return { structured: { ndjson: stdoutText } };
    },
  });
  return {
    descriptor: provider.descriptor,
    async start(request) {
      const withTimeout: ExecutorExecutionRequest = {
        ...request,
        timeoutMs: request.timeoutMs ?? timeoutMs,
      };
      const outcome = await provider.start(withTimeout);
      return postProcessDshOutcome(outcome);
    },
  };
};

/** Read the REAL external session identity from emitted evidence (never guess). */
export const parseSessionId = (stdoutText: string): string | null => {
  for (const line of stdoutText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.includes('"session"')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Readonly<Record<string, unknown>>;
      if (parsed['type'] === 'session' && typeof parsed['sessionId'] === 'string') {
        return String(parsed['sessionId']);
      }
    } catch {
      return null;
    }
  }
  return null;
};

/** The final answer text from a succeeded run's evidence (null when absent). */
export const parseFinalText = (stdoutText: string): string | null => {
  for (const line of stdoutText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.includes('"final"')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Readonly<Record<string, unknown>>;
      if (parsed['type'] === 'final' && typeof parsed['text'] === 'string') return String(parsed['text']);
    } catch {
      return null;
    }
  }
  return null;
};

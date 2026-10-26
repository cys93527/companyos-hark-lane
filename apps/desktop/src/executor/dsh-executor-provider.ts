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
import { writeFileSync } from 'node:fs';

import {createCoreDomainEvent, domainError, type DomainError, err, ok, redactSecrets, type Result} from '@companyos/core';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';

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

export const dshTaskTextOf = (request: ExecutorExecutionRequest): string => {
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
  const fileRequirements = request.work.goalStructured?.['fileDeliveries'];
  const relevantFiles = Array.isArray(fileRequirements) ? fileRequirements.filter((item: unknown) => typeof item === 'object' && item !== null && criteria.some((criterion) => criterion.criterionId === (item as Record<string, unknown>)['criterionId'])) : [];
  if (relevantFiles.length > 0) {
    lines.push(`Required file delivery: ${JSON.stringify(relevantFiles)}`);
    lines.push(`Final text must be JSON {"schema":"companyos/business-files/1","goalRunId":${JSON.stringify(request.work.fileDeliveryGoalRunId)},"runId":${JSON.stringify(request.runId)},"taskId":${JSON.stringify(request.taskId)},"files":[{"relativePath":"the required relative path","sizeBytes":123,"sha256":"actual lowercase sha256"}]}. Report only actual nonempty files in the authorized Workspace. Exit code zero is not file delivery proof.`);
  } else lines.push('Answer with the final result text only.');
  return lines.join('\n');
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
const postProcessDshOutcome = (outcome: ExecutorProviderOutcome): ExecutorProviderOutcome => {
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
    return session === null ? outcome : { ...outcome, providerSessionId: session };
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
      // The loopback model broker: injects the real credential upstream, streams SSE
      // both ways, and dies with the invocation (in-process; never a child process,
      // never a port held past the attempt, never a secret in kernel-visible config
      // or env — the Sprint24 §35 secret law holds literally).
      const exchangeAudit = embedded.toolInvocationAudit;
      const broker = await startModelBroker({
        upstreamBaseURL: modelRoute.baseURL,
        bearer: modelRoute.apiKeyValue,
        ...(exchangeAudit === undefined ? {} : {
          observe: (observation: ModelBrokerExchangeObservation) => {
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
      });
      if (!broker.ok) {
        return {
          kind: 'transport-failed',
          reasonCode: String(broker.error.details['reason'] ?? 'EXECUTOR_EMBEDDED_BROKER_FAILED'),
          detail: broker.error.message,
        };
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
        const tapStdoutLine = toolTap === undefined && activityTap === undefined
          ? undefined
          : (line: string): void => {
            toolTap?.(line);
            activityTap?.(line);
          };
        // STAGE 4 E2E: with no dedicated node configured, the child runs on THIS
        // Electron binary. ELECTRON_RUN_AS_NODE=1 makes it a plain Node runtime for the
        // kernel CLI (Electron's Node satisfies the manifest nodeRange) — without it the
        // child boots as a GUI Electron app and exits with a Windows status code.
        // H15: the packaged kernel ships its pinned Node runtime (staged + verified);
        // the user's PATH node is consulted only for a dev materialization without one.
        const childExecutable = embedded.nodeExecutable ?? stage.value.nodeExecutablePath ?? resolveEmbeddedChildNode();
        const childIsElectron = childExecutable === process.execPath;
        const provider = createProcessExecutorProvider({
          providerKey: DSH_PROVIDER_KEY,
          capabilities: DSH_CAPABILITIES,
          executable: childExecutable,
          // Official 0.2.0 launcher grammar: positional profile first, then options,
          // then the task (passThroughOptions requires the leading positional).
          baseArgv: [stage.value.cliEntryPath, embedded.runtime.manifest.profileName, '--json'],
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
          ...(tapStdoutLine === undefined ? {} : { tapStdoutLine }),
          buildArgs: (invocation) => {
            const argv: string[] = [];
            if (
              invocation.continuationSessionId !== undefined &&
              invocation.continuationSessionId !== ''
            ) {
              argv.push('--session-id', invocation.continuationSessionId);
            }
            argv.push(dshTaskTextOf(invocation));
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
        const outcome = await provider.start({
          ...request,
          timeoutMs: request.timeoutMs ?? timeoutMs,
        });
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

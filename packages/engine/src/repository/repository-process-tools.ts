/**
 * Repository process tool adapters (Sprint 17 — Task-17-04; ADR-0028 D10–D12/D21–D25).
 *
 * Five thin ToolPort adapters over THE ONE RepositoryProcessRunner:
 *   repo.terminal     — HIGH,  side_effect, no automatic retry, input: { commandKey }
 *   repo.test-runner  — MEDIUM, side_effect, no automatic retry, fixed slot "tests"
 *   repo.linter       — MEDIUM, side_effect, no automatic retry, fixed slot "lint"
 *   repo.typechecker  — MEDIUM, side_effect, no automatic retry, fixed slot "typecheck"
 *   repo.builder      — MEDIUM, side_effect, no automatic retry, fixed slot "build"
 *
 * What the model can express is deliberately tiny: a QA tool takes NO arguments at all, and
 * `repo.terminal` may only NAME a trusted commandKey. The executable, the argv, the cwd and
 * the environment come from the trusted `RepositoryCommandProfile` on the WorkspaceContext,
 * so no input can turn a fixed command into an arbitrary shell line.
 *
 * A non-zero exit is a FAILED invocation that still carries structured evidence (previews,
 * digests, byte counts, artifact refs) — it is never dressed up as a success and never
 * compressed into one error string.
 */
import {
  createToolRecord,
  domainError,
  err,
  ok,
  type ArtifactContentStore,
  type DomainError,
  type Result,
  type ToolCancelReason,
  type ToolDescriptor,
  type ToolPort,
  type ToolRecord,
  type ToolRequest,
  type ToolResult,
} from '@companyos/core';

import type { WorkspaceContext } from './workspace.js';
import type {
  ProcessRunOutcome,
  ProcessStreamSummary,
  ProcessTermination,
  RepositoryProcessRunner,
} from './repository-process-runner.js';
import { repositoryCommandDescriptorFingerprint } from './command-fingerprint.js';
import type { RepositoryRevisionAnchor, RepositoryRevisionAnchorProvider } from './repository-git.js';

/* ------------------------------------------------------------ frozen specs -- */

/** Boss freeze (T17-04 §28/§30/§32): exact risk, exact idempotency, exact timeouts. */
export const PROCESS_TOOL_SPECS = [
  {
    toolId: 'repo.terminal' as const,
    slot: null,
    name: 'Repository terminal',
    description:
      'Run one trusted command from the workspace command profile (named by commandKey; executable/argv/env are fixed by the profile).',
    riskLevel: 'HIGH' as const,
    timeoutMs: 300_000,
  },
  {
    toolId: 'repo.test-runner' as const,
    slot: 'tests',
    name: 'Repository test runner',
    description: 'Run the workspace "tests" command from the trusted command profile (no arguments).',
    riskLevel: 'MEDIUM' as const,
    timeoutMs: 600_000,
  },
  {
    toolId: 'repo.linter' as const,
    slot: 'lint',
    name: 'Repository linter',
    description: 'Run the workspace "lint" command from the trusted command profile (no arguments).',
    riskLevel: 'MEDIUM' as const,
    timeoutMs: 300_000,
  },
  {
    toolId: 'repo.typechecker' as const,
    slot: 'typecheck',
    name: 'Repository typechecker',
    description: 'Run the workspace "typecheck" command from the trusted command profile (no arguments).',
    riskLevel: 'MEDIUM' as const,
    timeoutMs: 300_000,
  },
  {
    toolId: 'repo.builder' as const,
    slot: 'build',
    name: 'Repository builder',
    description: 'Run the workspace "build" command from the trusted command profile (no arguments).',
    riskLevel: 'MEDIUM' as const,
    timeoutMs: 600_000,
  },
] as const;

export type ProcessToolId = (typeof PROCESS_TOOL_SPECS)[number]['toolId'];

const streamSummarySchema = (): Readonly<Record<string, unknown>> => ({
  type: 'object',
  properties: {
    byteCount: { type: 'number' },
    sha256: { type: 'string' },
    binary: { type: 'boolean' },
    preview: { type: 'string' },
    truncated: { type: 'boolean' },
    artifactRef: { type: 'string' },
  },
  required: ['byteCount', 'sha256', 'binary', 'preview', 'truncated', 'artifactRef'],
  additionalProperties: false,
});

/** The revision anchor as structured output (nullable fields as ''; no root, no git dir). */
const anchorSchema = (): Readonly<Record<string, unknown>> => ({
  type: 'object',
  properties: {
    workspaceId: { type: 'string' },
    headSha: { type: 'string' },
    branch: { type: 'string' },
    workingTreeFingerprint: { type: 'string' },
    dirtyFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['workspaceId', 'headSha', 'branch', 'workingTreeFingerprint', 'dirtyFiles'],
  additionalProperties: false,
});

const processOutputSchema = (): Readonly<Record<string, unknown>> => ({
  type: 'object',
  properties: {
    workspaceId: { type: 'string' },
    commandKey: { type: 'string' },
    exitCode: { type: 'integer', minimum: -1 },
    signal: { type: 'string' },
    durationMs: { type: 'number' },
    termination: {
      type: 'string',
      enum: ['EXITED', 'SIGNALLED', 'TIMEOUT', 'CANCELLED', 'OUTPUT_LIMIT', 'SPAWN_ERROR'],
    },
    stdout: streamSummarySchema(),
    stderr: streamSummarySchema(),
    preAnchor: anchorSchema(),
    postAnchor: anchorSchema(),
    commandDescriptorFingerprint: { type: 'string' },
  },
  required: ['workspaceId', 'commandKey', 'exitCode', 'signal', 'durationMs', 'termination', 'stdout', 'stderr'],
  additionalProperties: false,
});

/** A QA tool takes no arguments: the schema itself makes any input a pre-spawn refusal. */
const EMPTY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

const TERMINAL_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: { commandKey: { type: 'string', minLength: 1 } },
  required: ['commandKey'],
  additionalProperties: false,
};

export interface RepositoryProcessToolSpec {
  readonly toolId: ProcessToolId;
  /** Fixed commandKey for a QA tool; null for `repo.terminal` (model names the key). */
  readonly slot: string | null;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly riskLevel: 'MEDIUM' | 'HIGH';
  readonly capabilities: readonly string[];
  readonly idempotencyMode: 'NONE';
  readonly timeoutMs: number;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export const REPOSITORY_PROCESS_TOOL_SPECS: readonly RepositoryProcessToolSpec[] = PROCESS_TOOL_SPECS.map(
  (entry) => ({
    toolId: entry.toolId,
    slot: entry.slot,
    name: entry.name,
    description: entry.description,
    version: '1.0.0',
    riskLevel: entry.riskLevel,
    // A real command may write caches, build output or generated files: these are
    // side-effecting capabilities, never a plain "read" (T17-04 §26).
    capabilities: ['side_effect'],
    // No automatic retry, ever: a re-run could duplicate a build or a test side effect.
    idempotencyMode: 'NONE' as const,
    timeoutMs: entry.timeoutMs,
    inputSchema: entry.slot === null ? TERMINAL_INPUT_SCHEMA : EMPTY_INPUT_SCHEMA,
    outputSchema: processOutputSchema(),
  }),
);

/** Build the registry record for one spec (validated by Core, so a spec cannot be malformed). */
export const createRepositoryProcessToolRecord = (
  spec: RepositoryProcessToolSpec,
  now: string,
): Result<ToolRecord, DomainError> =>
  createToolRecord({
    toolId: spec.toolId,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    capabilities: spec.capabilities,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    riskLevel: spec.riskLevel,
    requiredAuthorities: ['tool.invoke'],
    timeoutMs: spec.timeoutMs,
    idempotencyMode: spec.idempotencyMode,
    // A real command runs an unbounded workspace toolchain: STRICT audit for every one of
    // them (HIGH approval gates the terminal; the QA tools stay MEDIUM).
    auditPolicy: 'STRICT',
    providerKind: 'repository',
    adapterRef: spec.toolId,
    now,
  });

/* ---------------------------------------------------------------- adapter --- */

export interface RepositoryProcessToolDeps {
  /** The process-local workspace holder (0/1 active context; T17-02). */
  readonly workspace: () => WorkspaceContext | null;
  readonly clock: { nowIso(): string; now(): number };
  /** THE ONE shared process runner (never a per-tool spawn implementation). */
  readonly runner: RepositoryProcessRunner;
  /**
   * Existing Artifact/CAS content store (composition-owned). A failing run publishes a
   * BOUNDED failure-evidence object here, so a FAILED invocation can be reconstructed from
   * durable data alone (Sprint 17 T17-04 corrective).
   */
  readonly contentStore?: ArtifactContentStore;
  /**
   * Durable link between ONE invocation and the artifact refs its run produced. The shared
   * validating linker (`createFailureEvidenceLinker`) validates every reported ref before it
   * is linked, so this path carries the SAME rule as the registry's FAILED terminal write;
   * used on the cancel/timeout path, where the registry's own verdict discards adapter
   * details. It reports which refs were linked and which were refused.
   */
  readonly linkInvocationArtifacts?: (input: {
    readonly invocationId: string;
    readonly refs: readonly string[];
  }) => Promise<{ readonly linked: readonly string[]; readonly rejected: readonly string[] }>;
  /**
   * The shared read-only revision-anchor provider (T17-05). A QA tool anchors its run so a
   * success can prove WHICH repository state it ran against; a tool with no supported anchor
   * fails closed rather than reporting an unverifiable success.
   */
  readonly anchorProvider?: RepositoryRevisionAnchorProvider;
}

/**
 * The bounded failure evidence of one process invocation (T17-04 corrective, ADR-0028 D19).
 * Serialized into the existing CAS: previews are already bounded at 16 KiB per stream, so
 * this object never grows with the command's output, and the full bytes are referenced by
 * artifactRef instead of being inlined.
 */
export interface ProcessFailureEvidence {
  readonly schema: 'companyos/repository-process-evidence/1';
  readonly toolId: string;
  readonly commandKey: string;
  readonly workspaceId: string;
  readonly exitCode: number;
  readonly signal: string;
  readonly termination: ProcessTermination;
  readonly durationMs: number;
  readonly stdout: ProcessStreamSummary;
  readonly stderr: ProcessStreamSummary;
}

const workspaceNotOpen = (): DomainError =>
  domainError('POLICY_DENIED', 'No workspace is open; the trusted application must open one first.', {
    reason: 'WORKSPACE_NOT_OPEN',
  });

const processFailure = (reason: string, message: string, detail: Readonly<Record<string, unknown>>): DomainError =>
  domainError('AGENT_UNAVAILABLE', message, { kind: 'TOOL_FAILED', reason, ...detail });

const UTF8_ENCODER = new TextEncoder();

/** True when the run is anything other than a clean exit-0 (a failure that needs evidence). */
const isFailedRun = (outcome: ProcessRunOutcome): boolean =>
  outcome.termination !== 'EXITED' || outcome.exitCode !== 0;

/**
 * Publish the BOUNDED failure evidence of one run through the existing Artifact/CAS store
 * and return every artifactRef that must stay linked to its invocation: the evidence object
 * itself plus the full stream bytes the runner already externalized.
 */
const publishFailureEvidence = async (
  toolId: string,
  outcome: ProcessRunOutcome,
  contentStore: ArtifactContentStore | undefined,
): Promise<{ readonly evidence: ProcessFailureEvidence; readonly refs: readonly string[] }> => {
  const evidence: ProcessFailureEvidence = {
    schema: 'companyos/repository-process-evidence/1',
    toolId,
    commandKey: outcome.commandKey,
    workspaceId: outcome.workspaceId,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    termination: outcome.termination,
    durationMs: outcome.durationMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  };
  const streamRefs = [outcome.stdout.artifactRef, outcome.stderr.artifactRef].filter((ref) => ref.length > 0);
  if (contentStore === undefined) {
    // No store wired: the evidence stays ephemeral (returned to the caller only). Production
    // composition always provides the existing CAS store.
    return { evidence, refs: streamRefs };
  }
  const stored = await contentStore.put(UTF8_ENCODER.encode(JSON.stringify(evidence)));
  return { evidence, refs: [stored.contentRef, ...streamRefs] };
};

/**
 * Failure classification (T17-04 §51–§52): a settled-but-failed run keeps the tool taxonomy's
 * vocabulary — a timeout stays TIMEOUT, a cancellation stays CANCELLED, everything else is a
 * tool failure with a stable reason. Never a generic error, never a success.
 */
const classifyFailure = (
  outcome: ProcessRunOutcome,
): {
  readonly code: 'TIMEOUT' | 'CANCELLED' | 'AGENT_UNAVAILABLE';
  readonly kind: string;
  readonly reason: string;
  readonly message: string;
} => {
  switch (outcome.termination) {
    case 'TIMEOUT':
      return {
        code: 'TIMEOUT',
        kind: 'TIMEOUT',
        reason: 'PROCESS_TIMEOUT',
        message: 'The command exceeded its execution timeout and was terminated.',
      };
    case 'CANCELLED':
      return {
        code: 'CANCELLED',
        kind: 'CANCELLED',
        reason: 'PROCESS_CANCELLED',
        message: 'The command was cancelled and terminated.',
      };
    case 'OUTPUT_LIMIT':
      return {
        code: 'AGENT_UNAVAILABLE',
        kind: 'TOOL_FAILED',
        reason: 'OUTPUT_LIMIT_EXCEEDED',
        message: 'The command produced more output than the runtime allows.',
      };
    case 'SPAWN_ERROR':
      return {
        code: 'AGENT_UNAVAILABLE',
        kind: 'TOOL_FAILED',
        reason: 'PROCESS_SPAWN_FAILED',
        message: 'The configured command could not be started.',
      };
    case 'SIGNALLED':
      return {
        code: 'AGENT_UNAVAILABLE',
        kind: 'TOOL_FAILED',
        reason: 'PROCESS_SIGNALLED',
        message: `The command was terminated by ${outcome.signal === '' ? 'a signal' : `signal ${outcome.signal}`}.`,
      };
    default:
      return {
        code: 'AGENT_UNAVAILABLE',
        kind: 'TOOL_FAILED',
        reason: 'PROCESS_EXIT_NONZERO',
        message: `The command exited with code ${String(outcome.exitCode)}.`,
      };
  }
};

/** The anchor as structured output: no canonical root, no git dir, nullable fields as ''. */
const anchorOutput = (anchor: RepositoryRevisionAnchor): Readonly<Record<string, unknown>> => ({
  workspaceId: anchor.workspaceId,
  headSha: anchor.headSha ?? '',
  branch: anchor.branch ?? '',
  workingTreeFingerprint: anchor.workingTreeFingerprint,
  dirtyFiles: [...anchor.dirtyFiles],
});

/** The controlled, bounded output handed back on success (never a host path). */
const controlledOutput = (
  workspaceId: string,
  outcome: ProcessRunOutcome,
  preAnchor: RepositoryRevisionAnchor | null,
  postAnchor: RepositoryRevisionAnchor | null,
  command: { readonly commandKey: string; readonly commandDescriptorFingerprint: string },
): Readonly<Record<string, unknown>> => ({
  workspaceId,
  commandKey: outcome.commandKey,
  exitCode: outcome.exitCode,
  signal: outcome.signal,
  durationMs: outcome.durationMs,
  termination: outcome.termination,
  stdout: outcome.stdout,
  stderr: outcome.stderr,
  ...(preAnchor === null ? {} : { preAnchor: anchorOutput(preAnchor) }),
  ...(postAnchor === null ? {} : { postAnchor: anchorOutput(postAnchor) }),
  // T17-06: WHICH trusted command ran, as a digest (never the executable path or env).
  commandDescriptorFingerprint: command.commandDescriptorFingerprint,
});

export const createRepositoryProcessToolPort = (
  spec: RepositoryProcessToolSpec,
  deps: RepositoryProcessToolDeps,
): ToolPort => {
  const descriptor: ToolDescriptor & { readonly id?: string; readonly enabled?: boolean } = {
    toolId: spec.toolId,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    riskLevel: spec.riskLevel,
    capabilities: [...spec.capabilities].sort(),
    parameters: spec.inputSchema,
  };

  return {
    describe(): ToolDescriptor & { readonly id?: string; readonly enabled?: boolean } {
      return descriptor;
    },
    async invoke(request: ToolRequest): Promise<Result<ToolResult, DomainError>> {
      const startedAt = deps.clock.nowIso();
      const startedMs = deps.clock.now();
      const fail = (error: DomainError): Result<ToolResult, DomainError> => ({ ok: false as const, error });

      // Fail closed: without an active workspace no process may run at all.
      const context = deps.workspace();
      if (context === null) return fail(workspaceNotOpen());
      // Bind the workspace identity for THIS execution and refuse to run on a stale one.
      const stillActive = deps.workspace();
      if (stillActive === null || stillActive.workspaceId !== context.workspaceId) {
        return fail(
          processFailure('REPOSITORY_WORKSPACE_MISMATCH', 'The active workspace changed while starting the command.', {
            workspaceId: context.workspaceId,
          }),
        );
      }

      // The commandKey is either fixed by the tool (QA slots) or the ONLY thing the model
      // may name (repo.terminal). It is resolved against the TRUSTED profile, and an
      // unknown key fails BEFORE anything is spawned.
      const rawKey = spec.slot === null ? request.input['commandKey'] : spec.slot;
      if (typeof rawKey !== 'string' || rawKey.length === 0) {
        return fail(
          processFailure('REPOSITORY_COMMAND_KEY_INVALID', 'The command key must be a non-empty string.', {
            workspaceId: context.workspaceId,
          }),
        );
      }
      const descriptorForCommand = context.commandProfile[rawKey];
      if (descriptorForCommand === undefined) {
        return fail(
          processFailure('REPOSITORY_COMMAND_NOT_ALLOWED', 'The command key is not in the trusted command profile.', {
            commandKey: rawKey,
            workspaceId: context.workspaceId,
          }),
        );
      }
      if (descriptorForCommand.cwd !== 'workspace-root') {
        // A profile that asks for a cwd outside the workspace is refused, not silently
        // redirected: the runtime never runs a repository command anywhere else.
        return fail(
          processFailure('REPOSITORY_COMMAND_CWD_REFUSED', 'The trusted command profile declares an unsupported cwd.', {
            commandKey: rawKey,
            workspaceId: context.workspaceId,
          }),
        );
      }

      // T17-05 §41/§42: a QA tool anchors its run BEFORE it executes, so a success can prove
      // which repository state it ran against. With no supported anchor there is no
      // freshness proof, so the tool fails closed instead of reporting an unverifiable success.
      let preAnchor: RepositoryRevisionAnchor | null = null;
      if (deps.anchorProvider !== undefined) {
        const before = await deps.anchorProvider.getCurrentAnchor();
        if (!before.supported) {
          return fail(
            domainError('POLICY_DENIED', 'This workspace is not a supported Git repository for QA evidence.', {
              reason: before.reason,
              workspaceId: context.workspaceId,
            }),
          );
        }
        preAnchor = before.anchor;
      }

      const ran = await deps.runner.run({
        descriptor: descriptorForCommand,
        canonicalRoot: context.canonicalRoot,
        workspaceId: context.workspaceId,
        executionId: request.executionId,
        timeoutMs: request.timeoutMs,
      });
      if (!ran.ok) return fail(ran.error);

      const outcome = ran.value;
      const finishedAt = deps.clock.nowIso();
      const latencyMs = deps.clock.now() - startedMs;

      // Exit semantics (T17-04 §51): exit 0 is the ONLY success. Every other outcome is a
      // FAILED invocation that still carries its structured evidence — published to the
      // existing CAS and reported as artifactRefs so the registry links them to the
      // invocation (T17-04 corrective: a FAILED row must stay reconstructable).
      if (isFailedRun(outcome)) {
        const published = await publishFailureEvidence(spec.toolId, outcome, deps.contentStore);
        const classified = classifyFailure(outcome);
        return fail(
          domainError(classified.code, classified.message, {
            kind: classified.kind,
            reason: classified.reason,
            commandKey: outcome.commandKey,
            workspaceId: context.workspaceId,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            termination: outcome.termination,
            durationMs: outcome.durationMs,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            failureEvidence: published.evidence,
            artifactRefs: published.refs,
          }),
        );
      }

      // postAnchor after the run: pre != post is a recorded FACT (the T17-06 validator decides
      // what a mutated source means; this task never rewrites the invocation's status).
      let postAnchor: RepositoryRevisionAnchor | null = preAnchor;
      if (deps.anchorProvider !== undefined && preAnchor !== null) {
        const after = await deps.anchorProvider.getCurrentAnchor();
        if (!after.supported) {
          return fail(
            domainError('POLICY_DENIED', 'The repository state could not be anchored after the command ran.', {
              reason: after.reason,
              workspaceId: context.workspaceId,
            }),
          );
        }
        postAnchor = after.anchor;
      }

      return ok({
        status: 'ok' as const,
        output: controlledOutput(context.workspaceId, outcome, preAnchor, postAnchor, {
          commandKey: descriptorForCommand.commandKey,
          commandDescriptorFingerprint: repositoryCommandDescriptorFingerprint(descriptorForCommand),
        }),
        artifactRefs: [],
        startedAt,
        finishedAt,
        latencyMs,
      });
    },
    // `ToolPort.cancel` seam: the registry hands the invocation id of a timed-out call.
    //
    // This is also the ONLY place a registry-initiated timeout can leave durable evidence:
    // the registry answers a timeout with its own verdict and discards the adapter's error,
    // so the bounded evidence is published and linked HERE, against the invocation id the
    // registry supplied (T17-04 corrective).
    async cancel(invocationId: string, reason?: ToolCancelReason): Promise<Result<true, DomainError>> {
      const settled = await deps.runner.cancelAndAwait(invocationId, reason);
      if (!settled.ok) return err(settled.error);
      const outcome = settled.value;
      if (outcome === null || !isFailedRun(outcome)) return ok(true);
      const published = await publishFailureEvidence(spec.toolId, outcome, deps.contentStore);
      if (deps.linkInvocationArtifacts !== undefined && published.refs.length > 0) {
        // The linker validates: a refused ref is never durably linked, whatever produced it.
        await deps.linkInvocationArtifacts({ invocationId, refs: published.refs });
      }
      return ok(true);
    },
  };
};

/** All five process adapters over the ONE shared runner. */
export const createRepositoryProcessTools = (
  deps: RepositoryProcessToolDeps,
): ReadonlyMap<string, ToolPort> => {
  const ports = new Map<string, ToolPort>();
  for (const spec of REPOSITORY_PROCESS_TOOL_SPECS) {
    ports.set(spec.toolId, createRepositoryProcessToolPort(spec, deps));
  }
  return ports;
};

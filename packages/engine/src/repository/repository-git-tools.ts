/**
 * `repo.git` — the ONE read-only Git tool (Sprint 17 — Task-17-05; ADR-0028 D13/D14).
 *
 * Input is exactly `{ op: "status" | "diff" | "baseline" }` and nothing else: the model can
 * name an operation, never an argv. Every invocation goes through THE ONE repository process
 * runner with the fixed safety prefix (no pager, no fsmonitor, no untracked cache, no
 * external diff driver, no textconv, no colour) and the trusted environment additions
 * (GIT_OPTIONAL_LOCKS=0, GIT_TERMINAL_PROMPT=0), so a query can never write the index or
 * launch a repository-configured external program.
 *
 * Mutation is not expressible: the operation enum has no add/commit/checkout/reset/clean/
 * merge/rebase/fetch/pull/push/tag/stash, and unknown input fields are refused by the schema.
 *
 * Output carries no canonical root, no git dir and no executable — only workspace-relative
 * paths, the anchor and the runner's bounded process summaries (with CAS externalization).
 */
import {
  createToolRecord,
  domainError,
  ok,
  type DomainError,
  type Result,
  type ToolDescriptor,
  type ToolPort,
  type ToolRecord,
  type ToolRequest,
  type ToolResult,
} from '@companyos/core';

import type { WorkspaceContext } from './workspace.js';
import {
  GIT_DIFF_SAFETY_ARGV,
  GIT_REASONS,
  GIT_SAFE_ENV_ADDITIONS,
  GIT_SAFETY_ARGV,
  type RepositoryRevisionAnchor,
  type RepositoryRevisionAnchorProvider,
} from './repository-git.js';
import type { ProcessRunOutcome, RepositoryProcessRunner } from './repository-process-runner.js';

export type GitOperation = 'status' | 'diff' | 'baseline';

export interface RepositoryGitToolDeps {
  /** The process-local workspace holder (0/1 active context; T17-02). */
  readonly workspace: () => WorkspaceContext | null;
  readonly clock: { nowIso(): string; now(): number };
  /** THE ONE shared process runner: Git has no second spawn point (T17-05 §2). */
  readonly runner: RepositoryProcessRunner;
  /** Trusted composition-supplied Git executable (the model can never name it). */
  readonly gitExecutable: string;
  /** Milliseconds per Git invocation. */
  readonly timeoutMs: number;
  /**
   * THE ONE revision-anchor provider (T17-05 final integration). `repo.git`, the QA process
   * tools and the future validator all resolve anchors through this component, so there is
   * exactly one algorithm: `repo.git` merely records pre/post around its own read.
   */
  readonly anchorProvider: RepositoryRevisionAnchorProvider;
}

/** The anchor schema: no canonical root, no git dir; nullable fields are expressed as ''. */
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

const OPERATIONS: readonly GitOperation[] = ['status', 'diff', 'baseline'];

/** The T17-04 stream-summary shape (the same rule the process tools publish). */
const streamSummarySchema = (): Readonly<Record<string, unknown>> => ({
  type: 'object',
  properties: {
    commandKey: { type: 'string' },
    exitCode: { type: 'integer', minimum: -1 },
    signal: { type: 'string' },
    durationMs: { type: 'number' },
    termination: { type: 'string' },
    stdout: {
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
    },
    stderr: {
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
    },
  },
  required: ['commandKey', 'exitCode', 'signal', 'durationMs', 'termination', 'stdout', 'stderr'],
  additionalProperties: false,
});

export interface RepositoryGitToolSpec {
  readonly toolId: 'repo.git';
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly riskLevel: 'LOW';
  readonly capabilities: readonly string[];
  readonly idempotencyMode: 'IDEMPOTENT_KEY';
  readonly timeoutMs: number;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export const REPOSITORY_GIT_TOOL_SPEC: RepositoryGitToolSpec = {
  toolId: 'repo.git',
  name: 'Repository git (read-only)',
  description:
    'Read-only Git queries inside the open workspace: status, diff (unstaged working tree) and baseline (anchor + state).',
  version: '1.0.0',
  riskLevel: 'LOW',
  capabilities: ['read'],
  idempotencyMode: 'IDEMPOTENT_KEY',
  timeoutMs: 300_000,
  inputSchema: {
    type: 'object',
    properties: { op: { type: 'string', enum: [...OPERATIONS] } },
    required: ['op'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      op: { type: 'string', enum: [...OPERATIONS] },
      branch: { type: 'string' },
      headSha: { type: 'string' },
      isDirty: { type: 'boolean' },
      dirtyFiles: { type: 'array', items: { type: 'string' } },
      anchor: anchorSchema(),
      preAnchor: anchorSchema(),
      postAnchor: anchorSchema(),
      processOutput: streamSummarySchema(),
    },
    required: ['workspaceId', 'op', 'branch', 'headSha', 'isDirty', 'dirtyFiles'],
    additionalProperties: false,
  },
};

/** Build the registry record for the Git tool (validated by Core, so it cannot be malformed). */
export const createRepositoryGitToolRecord = (
  spec: RepositoryGitToolSpec,
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
    auditPolicy: 'STRICT',
    providerKind: 'repository',
    adapterRef: spec.toolId,
    now,
  });

/** The anchor, with empty strings for the two nullable fields (the schema has no union). */
const anchorOutput = (anchor: RepositoryRevisionAnchor): Readonly<Record<string, unknown>> => ({
  workspaceId: anchor.workspaceId,
  headSha: anchor.headSha ?? '',
  branch: anchor.branch ?? '',
  workingTreeFingerprint: anchor.workingTreeFingerprint,
  dirtyFiles: [...anchor.dirtyFiles],
});

const streamSummaryOutput = (outcome: ProcessRunOutcome, stream: 'stdout' | 'stderr'): Readonly<Record<string, unknown>> => ({
  byteCount: outcome[stream].byteCount,
  sha256: outcome[stream].sha256,
  binary: outcome[stream].binary,
  preview: outcome[stream].preview,
  truncated: outcome[stream].truncated,
  artifactRef: outcome[stream].artifactRef,
});

export const createRepositoryGitToolPort = (
  spec: RepositoryGitToolSpec,
  deps: RepositoryGitToolDeps,
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
  let invocation = 0;

  /** Run ONE git invocation through the shared runner and return its bounded outcome. */
  const runGit = async (
    context: WorkspaceContext,
    argv: readonly string[],
  ): Promise<Result<ProcessRunOutcome, DomainError>> => {
    invocation += 1;
    const ran = await deps.runner.run({
      descriptor: {
        commandKey: 'git',
        executable: deps.gitExecutable,
        baseArgv: [...GIT_SAFETY_ARGV, ...argv],
        cwd: 'workspace-root',
        safeEnvAdditions: { ...GIT_SAFE_ENV_ADDITIONS },
      },
      canonicalRoot: context.canonicalRoot,
      workspaceId: context.workspaceId,
      executionId: `revctl-op:${String(invocation)}`,
      timeoutMs: deps.timeoutMs,
      includeStreamBytes: argv[0] === 'status' || argv[0] === 'ls-files' || argv[0] === 'rev-parse',
    });
    return ran;
  };

  return {
    describe(): ToolDescriptor & { readonly id?: string; readonly enabled?: boolean } {
      return descriptor;
    },
    async invoke(request: ToolRequest): Promise<Result<ToolResult, DomainError>> {
      const startedAt = deps.clock.nowIso();
      const startedMs = deps.clock.now();
      const fail = (error: DomainError): Result<ToolResult, DomainError> => ({ ok: false as const, error });

      const context = deps.workspace();
      if (context === null) {
        return fail(
          domainError('POLICY_DENIED', 'No workspace is open; the trusted application must open one first.', {
            reason: GIT_REASONS.NOT_OPEN,
          }),
        );
      }
      const op = request.input['op'];
      if (typeof op !== 'string' || !OPERATIONS.includes(op as GitOperation)) {
        return fail(
          domainError('INVALID_ARGUMENT', 'Only status, diff and baseline are supported.', {
            reason: 'GIT_OPERATION_UNSUPPORTED',
            workspaceId: context.workspaceId,
          }),
        );
      }

      // The anchor computation performs the boundary checks (exact root, no worktree, no
      // submodule, no nested repository, bounded state) and yields the revision identity.
      // The preAnchor: read through THE ONE shared provider before the read-only command runs.
      const anchorResult = await deps.anchorProvider.getCurrentAnchor();
      if (!anchorResult.supported) {
        return fail(
          domainError(
            anchorResult.reason === GIT_REASONS.COMMAND_FAILED ? 'AGENT_UNAVAILABLE' : 'POLICY_DENIED',
            anchorResult.reason === GIT_REASONS.COMMAND_FAILED
              ? 'The Git command failed.'
              : 'This workspace is not a supported Git repository for read-only queries.',
            {
              reason: anchorResult.reason,
              ...(anchorResult.detail === undefined ? {} : { detail: anchorResult.detail }),
              workspaceId: context.workspaceId,
            },
          ),
        );
      }
      const anchor = anchorResult.anchor;
      const anchorUnspported = (result: { readonly supported: false; readonly reason: string; readonly detail?: string }): Result<ToolResult, DomainError> =>
        fail(
          domainError(
            result.reason === GIT_REASONS.COMMAND_FAILED ? 'AGENT_UNAVAILABLE' : 'POLICY_DENIED',
            result.reason === GIT_REASONS.COMMAND_FAILED
              ? 'The Git command failed.'
              : 'The repository state could not be anchored after the read-only query.',
            {
              reason: result.reason,
              ...(result.detail === undefined ? {} : { detail: result.detail }),
              workspaceId: context.workspaceId,
            },
          ),
        );

      if (op === 'status') {
        const outcome = await runGit(context, ['status', '--porcelain=v2', '-z', '--branch']);
        if (!outcome.ok) return fail(outcome.error);
        // postAnchor read AFTER the query: a concurrent repository change between the two
        // reads is a recorded FACT (the invocation stays COMPLETED; the verdict is T17-06's).
        const after = await deps.anchorProvider.getCurrentAnchor();
        if (!after.supported) return anchorUnspported(after);
        return ok({
          status: 'ok' as const,
          output: {
            workspaceId: context.workspaceId,
            op: 'status',
            branch: anchor.branch ?? '',
            headSha: anchor.headSha ?? '',
            isDirty: anchor.dirtyFiles.length > 0,
            dirtyFiles: [...anchor.dirtyFiles],
            preAnchor: anchorOutput(anchor),
            postAnchor: anchorOutput(after.anchor),
          },
          artifactRefs: [],
          startedAt,
          finishedAt: deps.clock.nowIso(),
          latencyMs: deps.clock.now() - startedMs,
        });
      }

      if (op === 'diff') {
        // Real unstaged working-tree diff, with every external-execution vector disabled.
        const outcome = await runGit(context, ['diff', ...GIT_DIFF_SAFETY_ARGV, '-z']);
        if (!outcome.ok) return fail(outcome.error);
        const refs = [outcome.value.stdout.artifactRef, outcome.value.stderr.artifactRef].filter(
          (ref) => ref.length > 0,
        );
        const after = await deps.anchorProvider.getCurrentAnchor();
        if (!after.supported) return anchorUnspported(after);
        return ok({
          status: 'ok' as const,
          output: {
            workspaceId: context.workspaceId,
            op: 'diff',
            branch: anchor.branch ?? '',
            headSha: anchor.headSha ?? '',
            isDirty: anchor.dirtyFiles.length > 0,
            dirtyFiles: [...anchor.dirtyFiles],
            preAnchor: anchorOutput(anchor),
            postAnchor: anchorOutput(after.anchor),
            processOutput: {
              commandKey: 'git',
              exitCode: outcome.value.exitCode,
              signal: outcome.value.signal,
              durationMs: outcome.value.durationMs,
              termination: outcome.value.termination,
              stdout: streamSummaryOutput(outcome.value, 'stdout'),
              stderr: streamSummaryOutput(outcome.value, 'stderr'),
            },
          },
          artifactRefs: refs,
          startedAt,
          finishedAt: deps.clock.nowIso(),
          latencyMs: deps.clock.now() - startedMs,
        });
      }

      // baseline: the durable Task-start evidence (workspaceId + branch + head + state + anchor).
      const statusRun = await runGit(context, ['status', '--porcelain=v2', '-z', '--branch']);
      if (!statusRun.ok) return fail(statusRun.error);
      const outcome = statusRun.value;
      const refs = [outcome.stdout.artifactRef, outcome.stderr.artifactRef].filter((ref) => ref.length > 0);
      return ok({
        status: 'ok' as const,
        output: {
          workspaceId: context.workspaceId,
          op: 'baseline',
          branch: anchor.branch ?? '',
          headSha: anchor.headSha ?? '',
          isDirty: anchor.dirtyFiles.length > 0,
          dirtyFiles: [...anchor.dirtyFiles],
          anchor: anchorOutput(anchor),
          processOutput: {
            commandKey: 'git',
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            durationMs: outcome.durationMs,
            termination: outcome.termination,
            stdout: streamSummaryOutput(outcome, 'stdout'),
            stderr: streamSummaryOutput(outcome, 'stderr'),
          },
        },
        artifactRefs: refs,
        startedAt,
        finishedAt: deps.clock.nowIso(),
        latencyMs: deps.clock.now() - startedMs,
      });
    },
  };
};

/**
 * `repo.validation-evidence` — the durable QA evidence validator tool (Sprint 17 — Task-17-06).
 *
 * ONE verifier tool with the exact identity DevCompany 1.0.0 declares. It answers a single
 * question from durable data only: "do the six required QA evidence items — tests, lint,
 * typecheck, build, git status, git diff — all point at the same run, the same task, the same
 * workspace, the same repository revision, the same trusted commands, and is the repository
 * still in that state right now?"
 *
 *   VERIFIER ONLY — no QA command is ever executed, no process is ever spawned, no stream is
 *   ever read: the source audit in the test suite asserts zero process-spawning surface and
 *   zero filesystem/network use.
 *
 *   NON-SELECTING INPUT — the model cannot nominate an invocation, a tool version, an
 *   expected result or an anchor. The scope comes from the trusted invocation context
 *   (runId/taskId on the ToolRequest), and the evidence comes from the trusted source.
 *
 *   VERDICT VS ERROR — `verdict: 'fail'` is a business verdict recorded on a COMPLETED
 *   invocation; only an infrastructure failure makes the invocation itself FAILED.
 */
import {
  TOOL_CAPABILITY_VALIDATOR,
  createToolRecord,
  err,
  ok,
  type DomainError,
  type Result,
  type ToolDescriptor,
  type ToolPort,
  type ToolRecord,
  type ToolRequest,
  type ToolResult,
} from '@companyos/core';

import {
  REQUIRED_QA_EVIDENCE_SLOTS,
  repositoryQaEvidenceReport,
  verifyRepositoryQaEvidence,
  type QaEvidenceVerdict,
  type RepositoryEvidenceSource,
  type RepositoryEvidenceToolRecordReader,
} from './qa-evidence.js';
import type { RepositoryRevisionAnchorProvider } from './repository-git.js';
import type { WorkspaceContext } from './workspace.js';

export interface RepositoryValidationEvidenceDeps {
  /** The process-local workspace holder (0/1 active context; T17-02). */
  readonly workspace: () => WorkspaceContext | null;
  /** Trusted evidence source (composition-owned read over the durable invocations). */
  readonly evidenceSource: RepositoryEvidenceSource;
  /** Trusted current tool-record reader (version drift verification). */
  readonly toolRecords: RepositoryEvidenceToolRecordReader;
  /** THE ONE revision-anchor provider (freshness read LAST). */
  readonly anchorProvider: RepositoryRevisionAnchorProvider;
  readonly clock: { nowIso(): string; now(): number };
}

export interface RepositoryValidationEvidenceSpec {
  readonly toolId: 'repo.validation-evidence';
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

const REPORT_KIND = 'companyos/repository-qa-evidence';

/** The exact fields the ValidationService hands a validator (application-trusted). */
const VALIDATOR_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    targetRef: { type: 'string', minLength: 1 },
    artifactId: { type: 'string', minLength: 1 },
    runId: { type: 'string', minLength: 1 },
    kind: { type: 'string', minLength: 1 },
    contentRef: { type: 'string', minLength: 1 },
    contentHash: { type: 'string', minLength: 1 },
    sizeBytes: { type: 'number' },
  },
  required: ['targetRef', 'artifactId', 'runId'],
  additionalProperties: false,
};

/**
 * The anchor as structured output: always the full shape (nullable fields as ''), so a
 * verdict without any anchor is still schema-valid and honest.
 */
const anchorOutput = (anchor: QaEvidenceVerdict['anchor']): Readonly<Record<string, unknown>> => ({
  workspaceId: anchor?.workspaceId ?? '',
  headSha: anchor?.headSha ?? '',
  branch: anchor?.branch ?? '',
  workingTreeFingerprint: anchor?.workingTreeFingerprint ?? '',
  dirtyFiles: anchor === null ? [] : [...anchor.dirtyFiles],
});

const slotOutput = (slot: QaEvidenceVerdict['evidence'][keyof QaEvidenceVerdict['evidence']]): Readonly<Record<string, unknown>> =>
  slot === null
    ? {}
    : {
        invocationId: slot.invocationId,
        toolId: slot.toolId,
        toolVersion: slot.toolVersion ?? '',
        status: slot.status,
        commandKey: slot.commandKey ?? '',
        commandDescriptorFingerprint: slot.commandDescriptorFingerprint ?? '',
        gitOp: slot.gitOp ?? '',
        exitCode: slot.exitCode ?? -1,
        anchor: anchorOutput(slot.anchor),
      };

export const REPOSITORY_VALIDATION_EVIDENCE_SPEC: RepositoryValidationEvidenceSpec = {
  toolId: 'repo.validation-evidence',
  name: 'Repository QA evidence validator',
  description:
    'Verifier-only: decides from durable evidence whether tests/lint/typecheck/build/git status/git diff all ran on the same repository state and whether that state is still current. Never executes a QA command.',
  version: '1.0.0',
  riskLevel: 'LOW',
  capabilities: [TOOL_CAPABILITY_VALIDATOR],
  idempotencyMode: 'IDEMPOTENT_KEY',
  timeoutMs: 120_000,
  inputSchema: VALIDATOR_INPUT_SCHEMA,
  outputSchema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      workspaceId: { type: 'string' },
      anchor: {
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
      },
      evidence: {
        type: 'object',
        properties: Object.fromEntries(
          REQUIRED_QA_EVIDENCE_SLOTS.map((entry) => [
            entry.slot,
            {
              type: 'object',
              properties: {
                invocationId: { type: 'string' },
                toolId: { type: 'string' },
                toolVersion: { type: 'string' },
                status: { type: 'string' },
                commandKey: { type: 'string' },
                commandDescriptorFingerprint: { type: 'string' },
                gitOp: { type: 'string' },
                exitCode: { type: 'integer', minimum: -1 },
                anchor: {
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
                },
              },
              // A missing slot carries NO field: its absence is the evidence (fail closed
              // rather than inventing a placeholder identity).
              additionalProperties: false,
            },
          ]),
        ),
        required: REQUIRED_QA_EVIDENCE_SLOTS.map((entry) => entry.slot),
        additionalProperties: false,
      },
      missingSlots: { type: 'array', items: { type: 'string' } },
      reasons: { type: 'array', items: { type: 'string' } },
      // The frozen validator envelope (Task-13-06): the durable report the ValidationService
      // materializes through ArtifactService, plus the addressable evidence refs.
      evidenceRefs: { type: 'array', items: { type: 'string' } },
      report: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          label: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['kind', 'label', 'content'],
        additionalProperties: false,
      },
    },
    required: ['verdict', 'workspaceId', 'anchor', 'evidence', 'missingSlots', 'reasons'],
    additionalProperties: false,
  },
};

/** Build the registry record (validated by Core, so the spec cannot be malformed). */
export const createRepositoryValidationEvidenceRecord = (
  spec: RepositoryValidationEvidenceSpec,
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

export const createRepositoryValidationEvidencePort = (
  spec: RepositoryValidationEvidenceSpec,
  deps: RepositoryValidationEvidenceDeps,
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

      // The trusted scope comes from the invocation context, never from the payload. A
      // payload that tries to select evidence (invocation ids, anchors, expected results)
      // is refused by the input schema before any of this runs.
      const runId = request.runId;
      const taskId = request.taskId;
      const verified = await verifyRepositoryQaEvidence({ runId, taskId }, {
        workspace: deps.workspace,
        evidenceSource: deps.evidenceSource,
        toolRecords: deps.toolRecords,
        anchorProvider: deps.anchorProvider,
      });
      if (!verified.ok) {
        // Operational failure only: the invocation itself is FAILED, never a fake verdict.
        return err(verified.error);
      }
      const verdict = verified.value;

      return ok({
        status: 'ok' as const,
        // The frozen validator envelope (verdict/evidenceRefs/report) plus the bounded
        // detail the ValidationService stores on the durable invocation. No command output,
        // no stream bytes, no host paths.
        output: {
          verdict: verdict.verdict,
          workspaceId: verdict.workspaceId ?? '',
          anchor: anchorOutput(verdict.anchor),
          evidence: Object.fromEntries(
            REQUIRED_QA_EVIDENCE_SLOTS.map((entry) => [entry.slot, slotOutput(verdict.evidence[entry.slot])]),
          ),
          missingSlots: [...verdict.missingSlots],
          reasons: [...verdict.reasons],
          report: {
            kind: REPORT_KIND,
            label: `QA evidence for the workspace (${verdict.verdict})`,
            content: repositoryQaEvidenceReport(verdict),
          },
        },
        artifactRefs: [],
        startedAt,
        finishedAt: deps.clock.nowIso(),
        latencyMs: deps.clock.now() - startedMs,
      });
    },
  };
};

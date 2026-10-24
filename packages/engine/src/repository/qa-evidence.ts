/**
 * Durable QA evidence verifier (Sprint 17 — Task-17-06; ADR-0028 D29).
 *
 * THE rule this module encodes: a QA PASS may only be concluded from durable evidence that
 * all points at the SAME repository state and the SAME trusted commands, and the repository
 * must still be in that state at the moment the verdict is produced.
 *
 *   VERIFIER ONLY — it never executes a QA command, never spawns a process, never reads a
 *   stream, never touches the filesystem or the network. It reads durable ToolInvocations,
 *   durable ToolRecords and the current revision anchor (read LAST, immediately before the
 *   verdict, so a change during verification cannot be masked by a stale reading).
 *
 * The model can select nothing: the scope (runId/taskId) comes from the trusted invocation
 * context, the evidence comes from the trusted evidence source, and the anchor comes from the
 * shared anchor provider. There is no input field through which a caller could nominate an
 * invocation, a tool version, an expected result or an anchor.
 *
 * A verdict of FAIL is a business verdict (the evidence does not satisfy the requirements),
 * not an operational error: only an infrastructure failure raises an error, and then the
 * ToolInvocation itself fails.
 */
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
  type ToolInvocation,
} from '@companyos/core';

import { repositoryCommandDescriptorFingerprint } from './command-fingerprint.js';
import type { RepositoryRevisionAnchor, RepositoryRevisionAnchorProvider } from './repository-git.js';
import type { WorkspaceContext } from './workspace.js';

/* --------------------------------------------------------- the six slots --- */

/** The exact required evidence set (T17-06 §11/§19). `repo.git op=baseline` is NOT one. */
export const REQUIRED_QA_EVIDENCE_SLOTS = [
  { slot: 'tests', toolId: 'repo.test-runner', commandKey: 'tests', gitOp: null },
  { slot: 'lint', toolId: 'repo.linter', commandKey: 'lint', gitOp: null },
  { slot: 'typecheck', toolId: 'repo.typechecker', commandKey: 'typecheck', gitOp: null },
  { slot: 'build', toolId: 'repo.builder', commandKey: 'build', gitOp: null },
  { slot: 'gitStatus', toolId: 'repo.git', commandKey: null, gitOp: 'status' },
  { slot: 'gitDiff', toolId: 'repo.git', commandKey: null, gitOp: 'diff' },
] as const;

export type QaEvidenceSlot = (typeof REQUIRED_QA_EVIDENCE_SLOTS)[number]['slot'];

/** What a caller may see about one evidence slot (bounded, no command output). */
export interface QaEvidenceSlotResult {
  readonly invocationId: string;
  readonly toolId: string;
  readonly toolVersion: string | null;
  readonly status: string;
  /** Present for the four command slots. */
  readonly commandKey: string | null;
  readonly commandDescriptorFingerprint: string | null;
  /** Present for the two Git slots. */
  readonly gitOp: string | null;
  readonly exitCode: number | null;
  readonly anchor: RepositoryRevisionAnchor | null;
}

export interface QaEvidenceVerdict {
  readonly verdict: 'pass' | 'fail';
  readonly workspaceId: string | null;
  readonly anchor: RepositoryRevisionAnchor | null;
  readonly evidence: Readonly<Record<QaEvidenceSlot, QaEvidenceSlotResult | null>>;
  readonly missingSlots: readonly QaEvidenceSlot[];
  readonly reasons: readonly string[];
}

/* ------------------------------------------------------------------ ports --- */

/**
 * The trusted evidence source: the ONLY way this verifier learns about durable invocations.
 * Composition owns the implementation (a read-only query over the durable store); the
 * verifier re-verifies every returned row against the trusted scope, so a source that
 * returned another run's rows could never manufacture provenance.
 */
export interface RepositoryEvidenceSource {
  selectLatestTerminal(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly toolIds: readonly string[];
  }): Promise<Result<readonly ToolInvocation[], DomainError>>;
}

/** The trusted, current tool-record reader (version drift verification). */
export interface RepositoryEvidenceToolRecordReader {
  read(toolId: string): Promise<Result<{ readonly version: string; readonly enabled: boolean } | null, DomainError>>;
}

export interface RepositoryQaEvidenceDeps {
  /** The process-local workspace holder (0/1 active context; T17-02). */
  readonly workspace: () => WorkspaceContext | null;
  readonly evidenceSource: RepositoryEvidenceSource;
  readonly toolRecords: RepositoryEvidenceToolRecordReader;
  readonly anchorProvider: RepositoryRevisionAnchorProvider;
}

/* ------------------------------------------------------------- internals --- */

const TERMINAL_STATUSES: readonly string[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const anchorFromOutput = (output: unknown, field: 'preAnchor' | 'postAnchor'): RepositoryRevisionAnchor | null => {
  if (!isRecord(output)) return null;
  const anchor = output[field];
  if (!isRecord(anchor)) return null;
  const fingerprint = anchor['workingTreeFingerprint'];
  const workspaceId = anchor['workspaceId'];
  const headSha = anchor['headSha'];
  if (typeof fingerprint !== 'string' || typeof workspaceId !== 'string' || typeof headSha !== 'string') return null;
  return {
    workspaceId,
    headSha: headSha.length === 0 ? null : headSha,
    branch: typeof anchor['branch'] === 'string' && anchor['branch'].length > 0 ? (anchor['branch'] as string) : null,
    workingTreeFingerprint: fingerprint,
    dirtyFiles: Array.isArray(anchor['dirtyFiles']) ? (anchor['dirtyFiles'] as readonly string[]) : [],
  };
};

/** Core identity: the fields two anchors must agree on to represent the same state. */
const sameAnchor = (left: RepositoryRevisionAnchor, right: RepositoryRevisionAnchor): boolean =>
  left.workspaceId === right.workspaceId &&
  left.headSha === right.headSha &&
  left.workingTreeFingerprint === right.workingTreeFingerprint;

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/* ---------------------------------------------------------- verification --- */

/**
 * Verify the six evidence slots for one trusted (runId, taskId) scope.
 *
 * Order matters: all durable evidence is loaded and verified FIRST, and the current anchor is
 * read LAST — a repository change during verification therefore cannot be hidden by an early
 * reading (T17-06 §27).
 */
export const verifyRepositoryQaEvidence = async (
  input: { readonly runId: string; readonly taskId: string },
  deps: RepositoryQaEvidenceDeps,
): Promise<Result<QaEvidenceVerdict, DomainError>> => {
  const context = deps.workspace();
  if (context === null) {
    // Without an active workspace there is no current anchor to be fresh against: FAIL,
    // never a pass on old invocations (T17-06 §28).
    return ok({
      verdict: 'fail' as const,
      workspaceId: null,
      anchor: null,
      evidence: {
        tests: null,
        lint: null,
        typecheck: null,
        build: null,
        gitStatus: null,
        gitDiff: null,
      },
      missingSlots: REQUIRED_QA_EVIDENCE_SLOTS.map((entry) => entry.slot),
      reasons: ['WORKSPACE_NOT_OPEN'],
    });
  }

  const reasons: string[] = [];
  const missingSlots: QaEvidenceSlot[] = [];
  const evidence: Record<QaEvidenceSlot, QaEvidenceSlotResult | null> = {
    tests: null,
    lint: null,
    typecheck: null,
    build: null,
    gitStatus: null,
    gitDiff: null,
  };

  // 1. The latest terminal invocation per required tool inside the trusted scope.
  const selected = await deps.evidenceSource.selectLatestTerminal({
    runId: input.runId,
    taskId: input.taskId,
    toolIds: [...new Set(REQUIRED_QA_EVIDENCE_SLOTS.map((entry) => entry.toolId))],
  });
  if (!selected.ok) return err(selected.error);

  // Re-verify the scope on every row: a source can never hand us another run's evidence.
  const eligible = selected.value.filter(
    (invocation) =>
      invocation.runId === input.runId &&
      invocation.taskId === input.taskId &&
      TERMINAL_STATUSES.includes(invocation.status),
  );
  for (const invocation of selected.value) {
    if (invocation.runId !== input.runId || invocation.taskId !== input.taskId) {
      reasons.push('EVIDENCE_SCOPE_MISMATCH');
    }
  }

  // 2. Per-slot verification.
  let sharedAnchor: RepositoryRevisionAnchor | null = null;
  for (const entry of REQUIRED_QA_EVIDENCE_SLOTS) {
    const candidates = eligible
      .filter((invocation) => invocation.toolId === entry.toolId)
      .sort((left, right) => (left.createdAt === right.createdAt ? (left.id < right.id ? 1 : -1) : left.createdAt < right.createdAt ? 1 : -1));
    if (entry.gitOp !== null) {
      // A tool id may serve several ops: the durable output names the op, so a baseline can
      // never substitute for status/diff (T17-06 §38).
      const matching = candidates.filter((invocation) => {
        const output = invocation.replayOutput;
        return isRecord(output) && output['op'] === entry.gitOp;
      });
      if (matching.length === 0) {
        missingSlots.push(entry.slot);
        reasons.push(`MISSING_EVIDENCE:${entry.slot}`);
        continue;
      }
      candidates.length = 0;
      candidates.push(...matching);
    }
    if (candidates.length === 0) {
      missingSlots.push(entry.slot);
      reasons.push(`MISSING_EVIDENCE:${entry.slot}`);
      continue;
    }
    const latest = candidates[0];
    if (latest === undefined) {
      missingSlots.push(entry.slot);
      reasons.push(`MISSING_EVIDENCE:${entry.slot}`);
      continue;
    }

    // Latest terminal rule: anything other than COMPLETED is a FAIL, never skipped over.
    if (latest.status !== 'COMPLETED') {
      reasons.push(`EVIDENCE_NOT_SUCCESSFUL:${entry.slot}:${latest.status}`);
      evidence[entry.slot] = {
        invocationId: latest.id,
        toolId: latest.toolId,
        toolVersion: latest.toolVersion,
        status: latest.status,
        commandKey: null,
        commandDescriptorFingerprint: null,
        gitOp: entry.gitOp,
        exitCode: null,
        anchor: null,
      };
      continue;
    }

    const output = isRecord(latest.replayOutput) ? latest.replayOutput : {};
    const pre = anchorFromOutput(latest.replayOutput, 'preAnchor');
    const post = anchorFromOutput(latest.replayOutput, 'postAnchor');

    // Tool version drift: the executed version must equal the current registration.
    const currentRecord = await deps.toolRecords.read(entry.toolId);
    if (!currentRecord.ok) return err(currentRecord.error);
    if (currentRecord.value === null || !currentRecord.value.enabled) {
      reasons.push(`TOOL_NOT_REGISTERED:${entry.slot}`);
    } else if (latest.toolVersion !== currentRecord.value.version) {
      reasons.push(`TOOL_VERSION_DRIFT:${entry.slot}`);
    }

    // Anchors: present, stable, and the same as every other slot.
    if (pre === null || post === null) {
      reasons.push(`EVIDENCE_ANCHOR_MISSING:${entry.slot}`);
    } else if (!sameAnchor(pre, post)) {
      reasons.push(`SOURCE_MUTATED_DURING_EVIDENCE:${entry.slot}`);
    }
    if (post !== null) {
      if (post.workspaceId !== context.workspaceId) {
        reasons.push(`EVIDENCE_WORKSPACE_MISMATCH:${entry.slot}`);
      }
      if (sharedAnchor === null) sharedAnchor = post;
      else if (!sameAnchor(sharedAnchor, post)) reasons.push(`EVIDENCE_ANCHOR_MISMATCH:${entry.slot}`);
    }

    let commandKey: string | null = null;
    let descriptorFingerprint: string | null = null;
    let exitCode: number | null = null;
    if (entry.gitOp === null) {
      // The four command slots: exact commandKey, a current descriptor fingerprint, exit 0.
      commandKey = stringOrNull(output['commandKey']);
      descriptorFingerprint = stringOrNull(output['commandDescriptorFingerprint']);
      exitCode = typeof output['exitCode'] === 'number' ? (output['exitCode'] as number) : null;
      if (commandKey !== entry.commandKey) {
        reasons.push(`COMMAND_KEY_MISMATCH:${entry.slot}`);
      }
      if (exitCode !== 0) {
        reasons.push(`COMMAND_EXIT_NONZERO:${entry.slot}`);
      }
      const currentDescriptor = context.commandProfile[entry.commandKey];
      if (currentDescriptor === undefined) {
        reasons.push(`COMMAND_PROFILE_SLOT_MISSING:${entry.slot}`);
      } else if (descriptorFingerprint !== repositoryCommandDescriptorFingerprint(currentDescriptor)) {
        reasons.push(`STALE_COMMAND_PROFILE:${entry.slot}`);
      }
    } else {
      descriptorFingerprint = stringOrNull(output['commandDescriptorFingerprint']);
    }

    evidence[entry.slot] = {
      invocationId: latest.id,
      toolId: latest.toolId,
      toolVersion: latest.toolVersion,
      status: latest.status,
      commandKey,
      commandDescriptorFingerprint: descriptorFingerprint,
      gitOp: entry.gitOp,
      exitCode,
      anchor: post,
    };
  }

  // 3. Freshness LAST: the repository must still be in the evidenced state right now.
  const current = await deps.anchorProvider.getCurrentAnchor();
  if (!current.supported) {
    reasons.push(`ANCHOR_UNAVAILABLE:${current.reason}`);
  } else if (sharedAnchor === null) {
    reasons.push('ANCHOR_UNAVAILABLE:NO_VERIFIED_ANCHOR');
  } else if (current.anchor.workspaceId !== sharedAnchor.workspaceId) {
    reasons.push('ANCHOR_WORKSPACE_MISMATCH');
  } else if (!sameAnchor(current.anchor, sharedAnchor)) {
    reasons.push('STALE_EVIDENCE');
  }

  const verdict = reasons.length === 0 ? ('pass' as const) : ('fail' as const);
  return ok({
    verdict,
    workspaceId: context.workspaceId,
    anchor: current.supported ? current.anchor : sharedAnchor,
    evidence,
    missingSlots,
    reasons,
  });
};

/** Build the canonical, deterministic evidence report a durable artifact can carry. */
export const repositoryQaEvidenceReport = (verdict: QaEvidenceVerdict): string =>
  JSON.stringify(
    {
      purpose: 'companyos/repository-qa-evidence/1',
      verdict: verdict.verdict,
      workspaceId: verdict.workspaceId,
      anchor:
        verdict.anchor === null
          ? null
          : {
              workspaceId: verdict.anchor.workspaceId,
              headSha: verdict.anchor.headSha,
              branch: verdict.anchor.branch,
              workingTreeFingerprint: verdict.anchor.workingTreeFingerprint,
              dirtyFiles: [...verdict.anchor.dirtyFiles],
            },
      evidence: Object.fromEntries(
        REQUIRED_QA_EVIDENCE_SLOTS.map((entry) => {
          const slot = verdict.evidence[entry.slot];
          return [
            entry.slot,
            slot === null
              ? null
              : {
                  invocationId: slot.invocationId,
                  toolId: slot.toolId,
                  toolVersion: slot.toolVersion,
                  status: slot.status,
                  commandKey: slot.commandKey,
                  commandDescriptorFingerprint: slot.commandDescriptorFingerprint,
                  gitOp: slot.gitOp,
                  exitCode: slot.exitCode,
                },
          ];
        }),
      ),
      missingSlots: [...verdict.missingSlots],
      reasons: [...verdict.reasons],
    },
    null,
    0,
  );

/** A convenience error for an operational failure inside the verifier (never a FAIL). */
export const evidenceVerificationError = (message: string, reason: string): DomainError =>
  domainError('PERSISTENCE_FAILED', message, { reason });

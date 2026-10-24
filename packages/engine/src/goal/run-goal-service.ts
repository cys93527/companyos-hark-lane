/**
 * Run Goal service (Sprint 18 / Task-18-02) — the ONE writer and the ONE reader.
 *
 * WRITER (`attach`): called by `createRun` INSIDE the run-creation transaction, so a Run can
 * never exist without its goal once one was requested, and a failed goal write takes the whole
 * run down with it. The bytes go through the existing ArtifactService, which means the goal
 * inherits the frozen artifact guarantees: exactly one artifact per command identity, a trusted
 * content fingerprint, permanent rows across ledger trims, and a CONFLICT when the same identity
 * is reused with different content (that is how "a second goal can never overwrite the first"
 * is enforced — by the artifact primitive, not by a bespoke check).
 *
 * READER (`get`): exact canonical retrieval. No "latest artifact for this run" query, because
 * the canonical goal is addressed by identity (`run-goal:<runId>`), and every hop is ownership
 * checked: run exists, run belongs to the asking company, artifact belongs to the run, artifact
 * has the goal kind, and the bytes decode against the artifact's own provenance. Anything else
 * fails closed.
 */
import {
  RUN_GOAL_ARTIFACT_KIND,
  decodeRunGoal,
  domainError,
  encodeRunGoal,
  err,
  ok,
  runGoalCommandId,
  validateRunGoalInput,
  type ArtifactContentStore,
  type ArtifactStorePort,
  type DomainError,
  type EntityStore,
  type Result,
  type RunGoal,
  type RunGoalInput,
  type WorkflowRun,
} from '@companyos/core';

import type { ArtifactService } from '../artifact/artifact-service.js';

export interface RunGoalWriter {
  /**
   * Attach the canonical goal of a freshly created run. Deterministic: the same run and the
   * same objective replay the same artifact; the same run with a different objective is a
   * fingerprint CONFLICT from the artifact primitive.
   */
  attach(input: {
    readonly runId: WorkflowRun['id'];
    readonly companyId: string;
    readonly goal: RunGoalInput;
    readonly actorId: string;
    readonly traceId: string;
  }): Promise<Result<{ readonly artifactId: string; readonly contentHash: string; readonly sizeBytes: number }, DomainError>>;
}

export interface RunGoalReader {
  /** The exact canonical goal of one run, or a fail-closed error. */
  get(input: { readonly runId: string; readonly companyId: string }): Promise<Result<RunGoal, DomainError>>;
}

export interface RunGoalServiceDeps {
  readonly artifactService: ArtifactService;
  readonly artifactStore: ArtifactStorePort;
  readonly contentStore: ArtifactContentStore;
  readonly runs: EntityStore<WorkflowRun>;
}

export interface RunGoalService extends RunGoalWriter, RunGoalReader {}

export function createRunGoalService(deps: RunGoalServiceDeps): RunGoalService {
  return {
    async attach(input): Promise<Result<{ readonly artifactId: string; readonly contentHash: string; readonly sizeBytes: number }, DomainError>> {
      const checked = validateRunGoalInput(input.goal);
      if (!checked.ok) return checked;

      const run = await deps.runs.get(input.runId);
      if (run === null) {
        return err(domainError('NOT_FOUND', `Run "${String(input.runId)}" not found; a goal cannot be attached.`, {
          reason: 'RUN_GOAL_RUN_MISSING',
          runId: String(input.runId),
        }));
      }
      if (run.companyId !== input.companyId) {
        return err(
          domainError('POLICY_DENIED', 'A goal may only be attached to a run of the same company.', {
            reason: 'RUN_GOAL_COMPANY_MISMATCH',
            runId: String(input.runId),
          }),
        );
      }

      const goal: RunGoal = {
        schema: 'companyos/run-goal/1',
        runId: String(input.runId),
        objective: checked.value.objective,
        structured: checked.value.structured,
        source: checked.value.source,
        // Creation instant/author come back from the artifact row on read; the writer does
        // not invent a second clock reading.
        createdAt: run.createdAt,
        createdBy: input.actorId,
      };

      const created = await deps.artifactService.create({
        commandId: runGoalCommandId(String(input.runId)),
        runId: input.runId,
        taskId: null,
        kind: RUN_GOAL_ARTIFACT_KIND,
        content: encodeRunGoal(goal),
        producedBy: input.actorId,
        traceId: input.traceId,
      });
      if (!created.ok) return created;
      return ok({
        artifactId: created.value.id,
        contentHash: created.value.contentHash,
        sizeBytes: created.value.sizeBytes,
      });
    },

    async get(input): Promise<Result<RunGoal, DomainError>> {
      const run = await deps.runs.get(input.runId as never);
      if (run === null) {
        return err(domainError('NOT_FOUND', `Run "${input.runId}" does not exist.`, { reason: 'RUN_GOAL_RUN_MISSING', runId: input.runId }));
      }
      if (run.companyId !== input.companyId) {
        // Cross-company reads are indistinguishable from a missing run: no existence oracle.
        return err(
          domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
            reason: 'RUN_GOAL_RUN_MISSING',
            runId: input.runId,
          }),
        );
      }

      const artifact = await deps.artifactStore.getByCreationCommand(runGoalCommandId(input.runId));
      if (artifact === null) {
        return err(
          domainError('NOT_FOUND', `Run "${input.runId}" has no canonical goal; it was never supplied.`, {
            reason: 'RUN_GOAL_MISSING',
            runId: input.runId,
          }),
        );
      }
      if (artifact.artifact.kind !== RUN_GOAL_ARTIFACT_KIND) {
        return err(
          domainError('VALIDATION_FAILED', 'The run goal address holds a different artifact kind.', {
            reason: 'RUN_GOAL_ARTIFACT_KIND_MISMATCH',
            runId: input.runId,
            kind: artifact.artifact.kind,
          }),
        );
      }
      if (String(artifact.artifact.runId) !== input.runId) {
        return err(
          domainError('VALIDATION_FAILED', 'The run goal address holds an artifact of another run.', {
            reason: 'RUN_GOAL_ARTIFACT_WRONG_RUN',
            runId: input.runId,
            artifactRunId: String(artifact.artifact.runId),
          }),
        );
      }

      // CAS get re-verifies the digest on every read, so corrupt bytes fail closed here.
      const bytes = await deps.contentStore.get(artifact.artifact.contentRef);
      return decodeRunGoal(bytes, {
        runId: input.runId,
        createdBy: artifact.artifact.producedBy,
        createdAt: artifact.artifact.createdAt,
      });
    },
  };
}

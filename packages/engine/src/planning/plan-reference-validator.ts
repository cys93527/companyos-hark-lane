/**
 * Plan authoritative reference validator (Sprint 20 / Task-20-02 §30).
 *
 * READ-ONLY checks of facts that ALREADY exist when a plan is validated: the planning Run,
 * its canonical run-goal artifact, ownership and tenant scope. It never checks (and never
 * could) a future WorkflowVersion, Execution Run or Tasks — those do not exist yet. This is
 * deliberately separate from the structural validator in Core (`lifecycle/plan.ts`), which
 * never performs persistence lookups (§10: structural ≠ authoritative).
 */
import {
  RUN_GOAL_ARTIFACT_KIND,
  domainError,
  err,
  runGoalCommandId,
  type DomainError,
  type Result,
} from '@companyos/core';

export interface PlanReferenceValidatorDeps {
  /** The durable run reader (company scope is proven here, never trusted from the caller). */
  readonly runs: {
    get(runId: string): Promise<{ readonly id: string; readonly companyId: string } | null>;
  };
  /** The durable artifact store port (read-only lookups by creation command). */
  readonly artifacts: {
    getByCreationCommand(
      creationCommandId: string,
    ): Promise<{
      readonly artifact: { readonly id: string; readonly runId: string; readonly kind: string };
    } | null>;
  };
}

export interface PlanReferenceValidationInput {
  readonly companyId: string;
  readonly planningRunId: string;
  /** The plan payload's sourceGoal.goalArtifactId (validated structurally beforehand). */
  readonly goalArtifactId: string;
}

export type PlanReferenceValidator = (
  input: PlanReferenceValidationInput,
) => Promise<Result<{ readonly goalArtifactId: string }, DomainError>>;

export function createPlanReferenceValidator(
  deps: PlanReferenceValidatorDeps,
): PlanReferenceValidator {
  return async (input) => {
    // Tenant scope first, with the existing NOT_FOUND / no-leak convention: a foreign tenant
    // learns nothing about the run's existence.
    const run = await deps.runs.get(input.planningRunId);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.planningRunId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.planningRunId,
        }),
      );
    }
    // The planning Run's canonical goal is recoverable by its permanent creation command.
    const found = await deps.artifacts.getByCreationCommand(runGoalCommandId(input.planningRunId));
    if (found === null) {
      const error = domainError(
        'NOT_FOUND',
        `The planning run "${input.planningRunId}" has no canonical goal artifact.`,
        { reason: 'PLAN_SOURCE_GOAL_MISSING', planningRunId: input.planningRunId },
      );
      return { ok: false as const, error };
    }
    const artifact = found.artifact;
    if (artifact.kind !== RUN_GOAL_ARTIFACT_KIND) {
      const error = domainError(
        'VALIDATION_FAILED',
        `The goal artifact of run "${input.planningRunId}" has kind "${artifact.kind}".`,
        { reason: 'PLAN_SOURCE_GOAL_KIND', planningRunId: input.planningRunId, kind: artifact.kind },
      );
      return { ok: false as const, error };
    }
    if (artifact.runId !== input.planningRunId) {
      const error = domainError(
        'VALIDATION_FAILED',
        `The referenced goal artifact belongs to another run.`,
        {
          reason: 'PLAN_SOURCE_GOAL_RUN_MISMATCH',
          planningRunId: input.planningRunId,
          artifactRunId: artifact.runId,
        },
      );
      return { ok: false as const, error };
    }
    if (artifact.id !== input.goalArtifactId) {
      const error = domainError(
        'VALIDATION_FAILED',
        `The plan's sourceGoal does not name the planning run's canonical goal artifact.`,
        {
          reason: 'PLAN_SOURCE_GOAL_ID_MISMATCH',
          planningRunId: input.planningRunId,
          expectedArtifactId: artifact.id,
        },
      );
      return { ok: false as const, error };
    }
    return { ok: true as const, value: { goalArtifactId: artifact.id } };
  };
}

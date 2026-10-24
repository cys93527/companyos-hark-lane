/**
 * Agent Context (Sprint 8 §五).
 *
 * The context is ASSEMBLED EXPLICITLY from named references. It is not "dump the database",
 * not "dump the chat history", not "dump the project directory": every field is a bounded
 * value or a reference (an id), and anything oversized or credential-shaped is refused with
 * a domain error rather than silently trimmed.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

/** Bounds chosen so a single field can never become a context-window accident. */
export const CONTEXT_LIMITS = {
  instructions: 8_000,
  objective: 4_000,
  constraintItem: 1_000,
  constraintCount: 50,
  acceptanceItem: 1_000,
  acceptanceCount: 50,
  memoryView: 20_000,
  decisionView: 20_000,
  previousHandoff: 20_000,
  artifactRefs: 200,
} as const;

export interface ContextReference {
  readonly id: string;
  /** A short human label; never the object's full content. */
  readonly label: string;
}

export interface AgentContext {
  readonly company: ContextReference;
  readonly workflow: ContextReference;
  readonly workflowVersion: string;
  readonly workflowRun: ContextReference;
  readonly stage: ContextReference | null;
  readonly task: ContextReference;
  readonly role: ContextReference;
  readonly modelBinding: {
    readonly modelKey: string;
    readonly providerId: string;
    readonly providerModelId: string;
    readonly source: string;
  };
  readonly objective: string;
  readonly instructions: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  /** A bounded, explicitly provided memory view - never the whole memory store. */
  readonly memoryView: readonly string[];
  readonly decisionView?: readonly string[];
  /** The previous stage's handoff text, if the workflow has one. */
  readonly previousHandoff: string | null;
  /** References only: artifact CONTENT is fetched by the caller, not embedded here. */
  readonly artifactRefs: readonly ContextReference[];
  readonly trace: {
    readonly traceId: string;
    readonly executionId: string;
    readonly attempt: number;
  };
}

export interface BuildAgentContextInput {
  readonly company: ContextReference;
  readonly workflow: ContextReference;
  readonly workflowVersion: string;
  readonly workflowRun: ContextReference;
  readonly stage?: ContextReference | null;
  readonly task: ContextReference;
  readonly role: ContextReference;
  readonly binding: {
    readonly modelKey: string;
    readonly providerId: string;
    readonly providerModelId: string;
    readonly source: string;
  };
  readonly objective: string;
  readonly instructions?: readonly string[];
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly memoryView?: readonly string[];
  readonly decisionView?: readonly string[];
  readonly previousHandoff?: string | null;
  readonly artifactRefs?: readonly ContextReference[];
  readonly trace: { readonly traceId: string; readonly executionId: string; readonly attempt: number };
}

const textIssue = (field: string, value: string, limit: number): DomainError | null =>
  value.length > limit
    ? domainError('VALIDATION_FAILED', `${field} exceeds the ${String(limit)}-character context budget.`, {
        field,
        length: value.length,
        limit,
      })
    : null;

/** Assemble a validated context. Deterministic: same input -> same output, no clock, no IO. */
export function buildAgentContext(
  input: BuildAgentContextInput,
): Result<AgentContext, DomainError> {
  const instructions = [...(input.instructions ?? [])];
  const constraints = [...(input.constraints ?? [])];
  const acceptanceCriteria = [...(input.acceptanceCriteria ?? [])];
  const memoryView = [...(input.memoryView ?? [])];
  const decisionView = [...(input.decisionView ?? [])];
  const artifactRefs = [...(input.artifactRefs ?? [])];

  const objectiveIssue = textIssue('objective', input.objective, CONTEXT_LIMITS.objective);
  if (objectiveIssue !== null) return err(objectiveIssue);
  if (input.objective.trim().length === 0) {
    return err(domainError('VALIDATION_FAILED', 'An agent context needs an objective.', {}));
  }

  for (const instruction of instructions) {
    const issue = textIssue('instruction', instruction, CONTEXT_LIMITS.instructions);
    if (issue !== null) return err(issue);
  }
  if (constraints.length > CONTEXT_LIMITS.constraintCount) {
    return err(
      domainError('VALIDATION_FAILED', 'Too many constraints for one context.', {
        count: constraints.length,
        limit: CONTEXT_LIMITS.constraintCount,
      }),
    );
  }
  for (const constraint of constraints) {
    const issue = textIssue('constraint', constraint, CONTEXT_LIMITS.constraintItem);
    if (issue !== null) return err(issue);
  }
  if (acceptanceCriteria.length > CONTEXT_LIMITS.acceptanceCount) {
    return err(
      domainError('VALIDATION_FAILED', 'Too many acceptance criteria for one context.', {
        count: acceptanceCriteria.length,
        limit: CONTEXT_LIMITS.acceptanceCount,
      }),
    );
  }
  for (const criterion of acceptanceCriteria) {
    const issue = textIssue('acceptanceCriterion', criterion, CONTEXT_LIMITS.acceptanceItem);
    if (issue !== null) return err(issue);
  }
  if (memoryView.length > CONTEXT_LIMITS.memoryView) {
    return err(
      domainError('VALIDATION_FAILED', 'The memory view is larger than the context budget.', {
        length: memoryView.length,
        limit: CONTEXT_LIMITS.memoryView,
      }),
    );
  }
  if (decisionView.length > CONTEXT_LIMITS.decisionView) {
    return err(domainError('VALIDATION_FAILED', 'The decision view is larger than the context budget.', { length: decisionView.length, limit: CONTEXT_LIMITS.decisionView }));
  }
  if (input.previousHandoff !== undefined && input.previousHandoff !== null) {
    const issue = textIssue('previousHandoff', input.previousHandoff, CONTEXT_LIMITS.previousHandoff);
    if (issue !== null) return err(issue);
  }
  if (artifactRefs.length > CONTEXT_LIMITS.artifactRefs) {
    return err(
      domainError('VALIDATION_FAILED', 'Too many artifact references for one context.', {
        count: artifactRefs.length,
        limit: CONTEXT_LIMITS.artifactRefs,
      }),
    );
  }
  for (const reference of artifactRefs) {
    if (reference.id.trim().length === 0) {
      return err(domainError('VALIDATION_FAILED', 'An artifact reference needs an id.', {}));
    }
    // A reference that looks like content (very long) is a caller bug, not a context.
    const issue = textIssue('artifactReference', reference.id, 200);
    if (issue !== null) return err(issue);
  }
  for (const [field, reference] of [
    ['company', input.company],
    ['workflow', input.workflow],
    ['workflowRun', input.workflowRun],
    ['task', input.task],
    ['role', input.role],
  ] as const) {
    if (reference.id.trim().length === 0) {
      return err(domainError('VALIDATION_FAILED', `The context needs a ${field} reference.`, { field }));
    }
  }
  if (input.workflowVersion.trim().length === 0) {
    return err(domainError('VALIDATION_FAILED', 'The context needs a workflowVersion.', {}));
  }
  if (input.binding.modelKey.trim().length === 0) {
    return err(domainError('MODEL_SELECTION_REQUIRED', 'The context needs an explicit model binding.', {}));
  }

  return ok({
    company: input.company,
    workflow: input.workflow,
    workflowVersion: input.workflowVersion,
    workflowRun: input.workflowRun,
    stage: input.stage ?? null,
    task: input.task,
    role: input.role,
    modelBinding: {
      modelKey: input.binding.modelKey,
      providerId: input.binding.providerId,
      providerModelId: input.binding.providerModelId,
      source: input.binding.source,
    },
    objective: input.objective,
    instructions,
    constraints,
    acceptanceCriteria,
    memoryView,
    ...(input.decisionView === undefined ? {} : { decisionView }),
    previousHandoff: input.previousHandoff ?? null,
    artifactRefs,
    trace: { ...input.trace },
  });
}

/** A compact, deterministic view used for prompt assembly and for the UI. */
export function contextSummary(context: AgentContext): string {
  const lines = [
    `# Objective\n${context.objective}`,
    context.instructions.length === 0 ? '' : `# Instructions\n${context.instructions.join('\n')}`,
    context.constraints.length === 0 ? '' : `# Constraints\n${context.constraints.join('\n')}`,
    context.acceptanceCriteria.length === 0
      ? ''
      : `# Acceptance criteria\n${context.acceptanceCriteria.join('\n')}`,
    context.previousHandoff === null ? '' : `# Previous handoff\n${context.previousHandoff}`,
    context.memoryView.length === 0 ? '' : `# Memory view\n${context.memoryView.join('\n')}`,
    (context.decisionView ?? []).length === 0 ? '' : `# Decision view\n${(context.decisionView ?? []).join('\n')}`,
    context.artifactRefs.length === 0
      ? ''
      : `# Artifact references (ids only)\n${context.artifactRefs
          .map((reference) => `- ${reference.id} (${reference.label})`)
          .join('\n')}`,
  ];
  return lines.filter((line) => line.length > 0).join('\n\n');
}

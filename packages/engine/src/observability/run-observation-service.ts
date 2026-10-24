/**
 * Sprint 23 — MINIMAL OBSERVABILITY (read-only Run observation service).
 *
 * A typed, read-only projection layer over CompanyOS canonical truth. The
 * registered Sprint23 reference (see docs/references/REFERENCE_CAPABILITY_MAP.md
 * and docs/sprint23/S23_MINIMAL_OBSERVABILITY.md) is the SELECTIVE-ADAPTATION
 * source for durable-vs-projection, restart reconstruction, live-event ≠
 * durable state, event map, projection seam and runtime inspector.
 * Nothing here is canonical: every field derives from a durable canonical
 * owner, and a failed observation is a typed error that mutates nothing.
 *
 * HARD BOUNDARY (Boss §21): this service READS, PROJECTS, AGGREGATES, EXPLAINS
 * and PAGES. It never writes Run/Task state, settles attempts, creates
 * findings/decisions, passes validation, provisions corrective work or touches
 * Handoff. Zero new tables; zero new event stores; the timeline is DERIVED
 * from the existing `events` feed plus canonical rows.
 */
import {
  domainError,
  runGoalCommandId,
  type DomainError,
  type Result,
  type Task,
  type WorkflowRun,
  err,
  ok,
} from '@companyos/core';

import { stageSubjectTaskOf } from '../projection/work-package-projector.js';
import {
  reviewVerdictConsumedBy,
  supervisorDecisionEvidenceOf,
} from '../supervisor/supervisor-runtime.js';

/* ------------------------------------------------------------------ contracts */

/** A derived blocker — a PROJECTION, never durable blocker truth (Boss §30). */
export interface RunBlocker {
  readonly code:
    | 'RUN_PAUSED'
    | 'RUN_FAILED'
    | 'APPROVAL_REQUIRED'
    | 'UNRESOLVED_FINDING'
    | 'VALIDATION_FAILED'
    | 'VALIDATION_REQUIREMENTS_MISSING'
    | 'ROUND_LIMIT_EXHAUSTED'
    | 'EXECUTION_FAILURE'
    | 'CAUSAL_CORRECTIVE_WAIT'
    | 'UNRECONCILED_CARRIER';
  readonly scope: 'RUN' | 'TASK' | 'STAGE';
  readonly subjectId?: string;
  readonly sourceType: string;
  readonly sourceId?: string;
  readonly evidenceRefs: readonly string[];
  readonly explanation: string;
}

/** One canonical review report, projected for finding visibility (D1). */
export interface FindingObservation {
  readonly artifactId: string;
  readonly reviewTaskId: string;
  readonly subjectTaskId: string;
  readonly verdict: string;
  readonly createdAt: string;
  readonly blocking: boolean;
  /** True while no REQUEST_CORRECTIVE decision has cited this report (D1 consumption). */
  readonly unresolved: boolean;
}

/** Discrete, canonically-derived progress — never an invented percentage (Boss §25). */
export interface RunProgressObservation {
  readonly stagesTotal: number;
  readonly stagesTerminalSuccessful: number;
  readonly tasksTotal: number;
  readonly tasksDone: number;
  readonly tasksActive: number;
  readonly tasksBlocked: number;
}

export interface StageObservation {
  readonly stageId: string;
  readonly taskCounts: Readonly<Record<string, number>>;
  readonly terminalSuccessful: boolean;
  readonly canonicalSubject: {
    readonly taskId: string;
    readonly output: {
      readonly kind: string;
      readonly artifactRefs: readonly string[];
      readonly validationRefs: readonly string[];
    } | null;
  } | null;
}

export interface ExecutionAttemptObservation {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly state: string;
  readonly runtimeInstanceId: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

/**
 * Model/LLM provenance — AgentExecution ONLY (Boss §27/§28). Never merged into
 * attempt or task lifecycle; never a claim about external success.
 */
export interface AgentProvenanceObservation {
  readonly executionId: string;
  readonly status: string;
  readonly modelKey: string | null;
  readonly providerId: string | null;
  readonly providerModelId: string | null;
}

export interface TaskObservation {
  readonly taskId: string;
  readonly runId: string;
  readonly companyId: string;
  readonly stageId: string;
  readonly roleId: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correctiveLineage: Readonly<Record<string, unknown>> | null;
  readonly reassessmentMarker: Readonly<Record<string, unknown>> | null;
  readonly executionAttempts: readonly ExecutionAttemptObservation[];
  readonly stageOutput: {
    readonly kind: string;
    readonly artifactRefs: readonly string[];
    readonly validationRefs: readonly string[];
  } | null;
  readonly provenance: readonly AgentProvenanceObservation[];
  /**
   * Honest at-least-once visibility (Boss §29): present when the durable state
   * cannot prove the external outcome. `externalInvocationProven === false`
   * means no canonical evidence of the executor call exists — never a claim it
   * did not happen.
   */
  readonly uncertainty: {
    readonly externalInvocationProven: boolean;
    readonly canonicalSettlementAbsent: boolean;
    readonly replayPossible: boolean;
    readonly note: string;
  } | null;
  /**
   * Sprint24 provider facts (§42): which implementation handled the attempt, whether the
   * external identity is known, whether the result is canonically settled, and whether the
   * provider advertises recovery — read from the durable dispatch binding (subordinate to
   * ExecutionAttempt). Null when the task never dispatched to a provider.
   */
  readonly provider: {
    readonly providerKey: string;
    readonly dispatchKey: string;
    /** Provider-owned DURABLE SESSION identity (conversation — many turns possible). */
    readonly providerSessionId: string | null;
    /** ONE exact external invocation identity — null unless the provider exposes one. */
    readonly providerInvocationId: string | null;
    readonly state: string;
    /**
     * Sprint25 — the deterministic fingerprint of the provider configuration this
     * dispatch ran under (values AND their sources). Null for a binding from before
     * the field existed, which means its provenance is unknown, never "matched".
     * A fingerprint is a derivation over non-secret values, so it is safe to show.
     */
    readonly configFingerprint: string | null;
    /** Honest recovery truth: continuation is NOT same-invocation recovery. */
    readonly recovery: {
      readonly sessionContinuation: boolean;
      readonly sameInvocationRecovery: boolean;
      readonly statusQuery: boolean;
    };
  } | null;
  readonly blockers: readonly RunBlocker[];
}

export interface RunOverview {
  readonly runId: string;
  readonly companyId: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly state: string;
  readonly revision: number;
  readonly reworkCount: number;
  readonly maxRework: number;
  readonly failureReason: string | null;
  readonly resumePoint: string | null;
  readonly pinnedVersion: {
    readonly templateId: string;
    readonly versionId: string;
    readonly nodeCount: number;
    readonly edgeCount: number;
  };
  readonly goal: { readonly artifactRef: string } | null;
  readonly plan: { readonly artifactRef: string } | null;
  readonly stages: readonly StageObservation[];
  readonly taskCounts: Readonly<Record<string, number>>;
  readonly executing: readonly {
    readonly taskId: string;
    readonly stageId: string;
    readonly kind: string;
    readonly attempt: ExecutionAttemptObservation | null;
  }[];
  readonly attempts: { readonly active: number; readonly interrupted: number; readonly completed: number; readonly failed: number };
  readonly blockers: readonly RunBlocker[];
  readonly unresolvedFindings: readonly FindingObservation[];
  readonly validation: {
    readonly requiredValidatorIds: readonly string[];
    readonly completed: readonly { readonly validatorId: string; readonly status: string; readonly evidenceRefs: readonly string[] }[];
    readonly failed: boolean;
    readonly missing: readonly string[];
  };
  readonly correctiveActivity: {
    readonly rounds: number;
    readonly correctiveTaskIds: readonly string[];
    readonly reassessmentTaskIds: readonly string[];
    readonly latest: {
      readonly taskId: string;
      readonly round: number;
      readonly parentTaskId: string;
      readonly originDecisionId: string;
    } | null;
  };
  readonly artifacts: readonly { readonly id: string; readonly kind: string; readonly taskId: string | null; readonly createdAt: string }[];
  readonly handoffCount: number;
  readonly progress: RunProgressObservation;
  readonly diagnostics: readonly string[];
}

export interface TimelineEntry {
  /** Stable identity of the SOURCE record (never a rowid). */
  readonly key: string;
  readonly kind: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly occurredAt: string | null;
  readonly sequence: number | null;
  readonly summary: string;
  readonly source: { readonly owner: string; readonly ref: string };
}

export interface RunTimelinePage {
  readonly entries: readonly TimelineEntry[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** Present when some history is known to be unreconstructable (Boss §38). */
  readonly limitation: string | null;
}

/* ------------------------------------------------------------------ ports */

export interface RunObservationDeps {
  /**
   * The trusted process actor the canonical sinks authorize (the same session actor
   * the composition uses). Observation reads ARE actor-gated reads of canonical
   * history — this is construction data of a trusted main-process service, never a
   * per-caller permission.
   */
  readonly actorId: string;
  readonly runs: { get(runId: string): Promise<WorkflowRun | null> };
  readonly tasks: {
    get(taskId: string): Promise<Task | null>;
    listByRun(runId: string): Promise<readonly Task[]>;
  };
  readonly executionAttempts: { listByTask(taskId: string): Promise<readonly {
    readonly seed: { readonly id: string; readonly attemptNumber: number; readonly taskKind: string };
    readonly state: string;
    readonly runtimeInstanceId: string | null;
    readonly createdAt: string;
    readonly settledAt: string | null;
  }[]> };
  readonly templates: { get(templateId: string): Promise<{
    readonly id: string;
    readonly versions: readonly { readonly id: string; readonly graph: unknown }[];
  } | null> };
  readonly validations: { listByRun(runId: string): Promise<readonly {
    readonly validatorId: string;
    readonly status: string;
    readonly evidenceRefs: readonly string[];
    readonly taskId: string | null;
    readonly finishedAt: string | null;
    readonly startedAt: string;
    readonly id: string;
  }[]> };
  readonly artifacts: {
    listByRun(runId: string): Promise<readonly {
      readonly id: string;
      readonly kind: string;
      readonly taskId: string | null;
      readonly createdAt: string;
    }[]>;
    getByCreationCommand(commandId: string): Promise<{ readonly artifact: { readonly id: string } } | null>;
  };
  readonly events: { readByRun(runId: string): Promise<readonly {
    readonly globalPosition: number;
    readonly event: { readonly eventId: string; readonly type: string; readonly occurredAt: string; readonly aggregateType: string; readonly aggregateId: string; readonly payload: unknown };
  }[]> };
  readonly decisionHistory: {
    listRunDecisionHistory(input: {
      readonly runId: string;
      readonly companyId: string;
      readonly actorId: string;
    }): Promise<Result<readonly {
      readonly decisionId: string;
      readonly decidedAt: string;
      readonly version: number;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }[], DomainError>>;
  };
  /** Canonical review reports of the run, projected by the T18-04 sink. */
  readonly reviewReports: {
    listRunReports(input: {
      readonly companyId: string;
      readonly runId: string;
      readonly actorId: string;
    }): Promise<Result<readonly {
      readonly artifactId: string;
      readonly reviewTaskId: string;
      readonly subjectTaskId: string;
      readonly verdict: string;
      readonly createdAt: string;
      readonly blocking: boolean;
    }[], DomainError>>;
  };
  readonly providerDispatches?: { byAttempt?(attemptId: string): Promise<readonly {
    readonly providerKey: string;
    readonly dispatchKey: string;
    readonly providerSessionId: string | null;
    readonly providerInvocationId: string | null;
    readonly state: string;
    /** Sprint25 configuration provenance — null when the binding predates the field. */
    readonly configFingerprint: string | null;
  }[]> };
  readonly agentExecutions?: { listByTask?(taskId: string): Promise<readonly {
    readonly executionId: string;
    readonly status: string;
    readonly modelKey: string | null;
    readonly providerId: string | null;
    readonly providerModelId: string | null;
  }[]> };
  readonly handoffs?: { listForScope?(input: {
    readonly companyId: string;
    readonly workflowRunId: string;
  }): Promise<readonly { readonly handoffId: string }[]> };
  readonly clock: { nowIso(): string };
}

/* ------------------------------------------------------------------ helpers */

const TASK_TERMINAL = new Set(['DONE', 'FAILED', 'CANCELLED', 'SKIPPED']);

const stageOutputEnvelopeOf = (
  task: Task,
): { readonly kind: string; readonly artifactRefs: readonly string[]; readonly validationRefs: readonly string[] } | null => {
  const raw = task.outputs['stageOutput'];
  if (typeof raw !== 'object' || raw === null) return null;
  const envelope = raw as Record<string, unknown>;
  if (typeof envelope['kind'] !== 'string') return null;
  return {
    kind: String(envelope['kind']),
    artifactRefs: Array.isArray(envelope['artifactRefs']) ? envelope['artifactRefs'].map(String) : [],
    validationRefs: Array.isArray(envelope['validationRefs']) ? envelope['validationRefs'].map(String) : [],
  };
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

/**
 * Opaque, deterministic cursor over the merged timeline order. The cursor holds the
 * FULL sort tuple (timestamp, sequence, kind, key): the page filter must follow the
 * SAME total order the sort uses — filtering by key alone would re-include or skip
 * entries whose timestamps order differently than their keys.
 */
interface TimelineCursor {
  /** The run this cursor was produced for — a cursor must never page another run. */
  readonly r: string;
  readonly t: string;
  readonly q: number;
  readonly k: string;
  readonly i: string;
}

const cursorTupleOf = (runId: string, entry: TimelineEntry): TimelineCursor => ({
  r: runId,
  t: entry.occurredAt ?? '',
  q: entry.sequence ?? 0,
  k: entry.kind,
  i: entry.key,
});

const encodeCursor = (runId: string, entry: TimelineEntry): string =>
  Buffer.from(JSON.stringify(cursorTupleOf(runId, entry)), 'utf8').toString('base64url');

const decodeCursor = (cursor: string): TimelineCursor | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const record = asRecord(parsed);
    if (record === null) return null;
    const r = record['r'];
    const t = record['t'];
    const q = record['q'];
    const k = record['k'];
    const i = record['i'];
    if (
      typeof r !== 'string' || typeof t !== 'string' || typeof q !== 'number' ||
      typeof k !== 'string' || typeof i !== 'string'
    ) {
      return null;
    }
    return { r, t, q, k, i };
  } catch {
    return null;
  }
};

const isAfterCursor = (entry: TimelineEntry, cursor: TimelineCursor): boolean => {
  const tuple = cursorTupleOf(cursor.r, entry);
  return (
    tuple.t.localeCompare(cursor.t) > 0 ||
    (tuple.t === cursor.t && (tuple.q > cursor.q ||
      (tuple.q === cursor.q && (tuple.k.localeCompare(cursor.k) > 0 ||
        (tuple.k === cursor.k && tuple.i.localeCompare(cursor.i) > 0)))))
  );
};

/* ------------------------------------------------------------------ the service */

export const createRunObservationService = (deps: RunObservationDeps) => {
  const notFound = (what: string, id: string) =>
    err(domainError('NOT_FOUND', `${what} "${id}" does not exist for this company.`, { reason: 'OBSERVATION_NOT_FOUND', id }));

  /** Ownership-checked run load: cross-company reads are indistinguishable from absent. */
  const loadRun = async (companyId: string, runId: string): Promise<Result<WorkflowRun, DomainError>> => {
    const run = await deps.runs.get(runId);
    if (run === null || String(run.companyId) !== String(companyId)) return notFound('Run', runId);
    return ok(run);
  };

  const pinnedGraphOf = async (run: WorkflowRun): Promise<{
    readonly nodes: readonly { readonly id: string; readonly config?: Record<string, unknown> }[];
    readonly edges: readonly { readonly from: string; readonly to: string }[];
  } | null> => {
    const template = await deps.templates.get(String(run.templateId));
    const version = template?.versions.find((entry) => entry.id === run.versionId);
    if (version === undefined) return null;
    const graph = asRecord(version.graph);
    if (graph === null) return null;
    return {
      nodes: Array.isArray(graph['nodes']) ? graph['nodes'] as readonly { readonly id: string; readonly config?: Record<string, unknown> }[] : [],
      edges: Array.isArray(graph['edges']) ? graph['edges'] as readonly { readonly from: string; readonly to: string }[] : [],
    };
  };

  const findingsOf = async (companyId: string, run: WorkflowRun): Promise<Result<readonly FindingObservation[], DomainError>> => {
    const reports = await deps.reviewReports.listRunReports({ companyId, runId: String(run.id), actorId: deps.actorId });
    if (!reports.ok) return reports;
    const history = await deps.decisionHistory.listRunDecisionHistory({ runId: String(run.id), companyId, actorId: deps.actorId });
    if (!history.ok) return history;
    const evidence = history.value
      .map((record) => supervisorDecisionEvidenceOf(record as never))
      .filter((entry): entry is { readonly action: string; readonly evidenceRefs: readonly string[] } => entry !== null);
    return ok(reports.value.map((report) => ({
      ...report,
      unresolved: report.blocking && !reviewVerdictConsumedBy(evidence, report.artifactId),
    })));
  };

  const attemptsOfRun = async (tasks: readonly Task[]): Promise<readonly ExecutionAttemptObservation[]> => {
    const out: ExecutionAttemptObservation[] = [];
    for (const task of tasks) {
      if (task.attempts === 0) continue;
      for (const attempt of await deps.executionAttempts.listByTask(String(task.id))) {
        out.push({
          attemptId: String(attempt.seed.id),
          attemptNumber: Number(attempt.seed.attemptNumber),
          state: String(attempt.state),
          runtimeInstanceId: attempt.runtimeInstanceId,
          createdAt: attempt.createdAt,
          settledAt: attempt.settledAt,
        });
      }
    }
    return out;
  };

  /** The derived blocker projection (Boss §30/§48): every entry cites canonical evidence. */
  const blockersOf = async (input: {
    readonly run: WorkflowRun;
    readonly tasks: readonly Task[];
    readonly attempts: readonly ExecutionAttemptObservation[];
    readonly findings: readonly FindingObservation[];
    readonly validations: readonly { readonly validatorId: string; readonly status: string; readonly evidenceRefs: readonly string[] }[];
    readonly requiredValidatorIds: readonly string[];
    readonly artifacts: readonly { readonly id: string; readonly kind: string; readonly taskId: string | null }[];
    readonly validationTaskIds: ReadonlySet<string>;
  }): Promise<readonly RunBlocker[]> => {
    const blockers: RunBlocker[] = [];
    const run = input.run;
    if (run.state === 'PAUSED') {
      blockers.push({
        code: 'RUN_PAUSED', scope: 'RUN', sourceType: 'WorkflowRun', sourceId: String(run.id),
        evidenceRefs: [`run:${String(run.id)}`],
        explanation: `Run is PAUSED${run.resumePoint === null ? '' : ` (resume point ${run.resumePoint})`}; only the trusted RUN.RESUME continues it.`,
      });
      if (run.reworkCount > run.maxRework) {
        blockers.push({
          code: 'ROUND_LIMIT_EXHAUSTED', scope: 'RUN', sourceType: 'WorkflowRun', sourceId: String(run.id),
          evidenceRefs: [`run:${String(run.id)}`, `reworkCount:${String(run.reworkCount)}`],
          explanation: `Corrective rounds exhausted (reworkCount ${String(run.reworkCount)} > maxRework ${String(run.maxRework)}).`,
        });
      }
    }
    if (run.state === 'FAILED') {
      blockers.push({
        code: 'RUN_FAILED', scope: 'RUN', sourceType: 'WorkflowRun', sourceId: String(run.id),
        evidenceRefs: [`run:${String(run.id)}`],
        explanation: `Run is FAILED${run.failureReason === null ? '' : ` (${run.failureReason})`}.`,
      });
    }
    if (run.state === 'WAITING_APPROVAL') {
      blockers.push({
        code: 'APPROVAL_REQUIRED', scope: 'RUN', sourceType: 'WorkflowRun', sourceId: String(run.id),
        evidenceRefs: [`run:${String(run.id)}`],
        explanation: 'Run is waiting for a human approval decision.',
      });
    }
    for (const finding of input.findings) {
      if (!finding.unresolved) continue;
      blockers.push({
        code: 'UNRESOLVED_FINDING', scope: 'RUN', subjectId: finding.subjectTaskId,
        sourceType: 'ReviewReport', sourceId: finding.artifactId,
        evidenceRefs: [`artifact:${finding.artifactId}`],
        explanation: `Anchor ${finding.reviewTaskId} reports ${finding.verdict} on subject ${finding.subjectTaskId}; no corrective decision has consumed this report (D1: all unresolved anchors block).`,
      });
    }
    const failedValidations = input.validations.filter((row) => row.status !== 'pass');
    if (failedValidations.length > 0) {
      blockers.push({
        code: 'VALIDATION_FAILED', scope: 'RUN', sourceType: 'Validation', sourceId: failedValidations[0]!.validatorId,
        evidenceRefs: failedValidations.map((row) => `validation:${row.validatorId}`),
        explanation: `${String(failedValidations.length)} validation row(s) are not passing.`,
      });
    }
    const completedIds = new Set(input.validations.map((row) => row.validatorId));
    const missing = input.requiredValidatorIds.filter((id) => !completedIds.has(id));
    if (missing.length > 0) {
      blockers.push({
        code: 'VALIDATION_REQUIREMENTS_MISSING', scope: 'RUN', sourceType: 'WorkflowVersion',
        sourceId: String(run.versionId),
        evidenceRefs: missing.map((id) => `validator:${id}`),
        explanation: `Pinned version requires validator(s) with no completed Validation row: ${missing.join(', ')}.`,
      });
    }
    const correctiveById = new Map<string, Task>();
    for (const task of input.tasks) {
      const lineage = asRecord(task.inputs['corrective']);
      if (lineage !== null) correctiveById.set(String(task.id), task);
    }
    for (const task of input.tasks) {
      if (task.state === 'FAILED') {
        blockers.push({
          code: 'EXECUTION_FAILURE', scope: 'TASK', subjectId: String(task.id),
          sourceType: 'Task', sourceId: String(task.id),
          evidenceRefs: [`task:${String(task.id)}`],
          explanation: `Task ${String(task.id)} is FAILED (${String(task.attempts)}/${String(task.maxAttempts)} attempts).`,
        });
      }
      const marker = asRecord(task.inputs['companyos:reassessment']);
      const correctiveId = marker === null ? null : typeof marker['correctiveTaskId'] === 'string' ? marker['correctiveTaskId'] : null;
      if (correctiveId !== null) {
        const corrective = correctiveById.get(correctiveId) ?? (await deps.tasks.get(correctiveId));
        if (corrective !== null && corrective.state !== 'DONE') {
          blockers.push({
            code: 'CAUSAL_CORRECTIVE_WAIT', scope: 'TASK', subjectId: String(task.id),
            sourceType: 'Task', sourceId: correctiveId,
            evidenceRefs: [`task:${String(task.id)}`, `corrective:${correctiveId}`],
            explanation: `Reassessment ${String(task.id)} is causally ineligible until corrective ${correctiveId} is DONE.`,
          });
        }
      }
    }
    // Crash window C observation: a settled task whose candidate envelope never
    // reached its canonical sink (the S21D-A proven shape).
    const findingArtifactTaskIds = new Set(input.artifacts.filter((a) => a.kind === 'companyos:review-findings' && a.taskId !== null).map((a) => String(a.taskId)));
    for (const task of input.tasks) {
      if (task.state !== 'DONE') continue;
      const envelope = stageOutputEnvelopeOf(task);
      if (envelope === null || envelope.kind !== 'companyos:review-findings-candidate') continue;
      if (findingArtifactTaskIds.has(String(task.id))) continue;
      blockers.push({
        code: 'UNRECONCILED_CARRIER', scope: 'TASK', subjectId: String(task.id),
        sourceType: 'Task', sourceId: String(task.id),
        evidenceRefs: [`task:${String(task.id)}`],
        explanation: `Task ${String(task.id)} settled with a review-findings candidate whose canonical report is not yet durable — carrier reconciliation is pending.`,
      });
    }
    void input.validationTaskIds;
    return blockers;
  };

  const getRunOverview = async (input: {
    readonly companyId: string;
    readonly runId: string;
  }): Promise<Result<RunOverview, DomainError>> => {
    const run = await loadRun(input.companyId, input.runId);
    if (!run.ok) return run;
    const tasks = await deps.tasks.listByRun(String(run.value.id));
    const attempts = await attemptsOfRun(tasks);
    const findings = await findingsOf(input.companyId, run.value);
    if (!findings.ok) return findings;
    const validations = await deps.validations.listByRun(String(run.value.id));
    const artifacts = await deps.artifacts.listByRun(String(run.value.id));
    const graph = await pinnedGraphOf(run.value);
    if (graph === null) {
      return err(domainError('NOT_FOUND', `The version pinned by run "${String(run.value.id)}" is missing.`, {
        reason: 'PINNED_VERSION_MISSING', runId: String(run.value.id),
      }));
    }
    const requiredValidatorIds = [...new Set(graph.nodes.flatMap((node) => {
      const raw = node.config?.['validatorIds'];
      return Array.isArray(raw) ? raw.map(String) : [];
    }))];
    const validationTaskIds = new Set(validations.filter((v) => v.taskId !== null).map((v) => String(v.taskId)));
    const blockers = await blockersOf({
      run: run.value, tasks, attempts, findings: findings.value, validations, requiredValidatorIds, artifacts, validationTaskIds,
    });

    const stages: StageObservation[] = graph.nodes.map((node) => {
      const stageTasks = tasks.filter((task) => String(task.stageId) === String(node.id));
      const counts: Record<string, number> = {};
      for (const task of stageTasks) counts[String(task.state)] = (counts[String(task.state)] ?? 0) + 1;
      const terminalSuccessful = stageTasks.length > 0 && stageTasks.every((t) => TASK_TERMINAL.has(String(t.state))) && stageTasks.some((t) => t.state === 'DONE');
      const subject = stageSubjectTaskOf(stageTasks);
      return {
        stageId: String(node.id),
        taskCounts: counts,
        terminalSuccessful,
        canonicalSubject: subject === null ? null : {
          taskId: String(subject.id),
          output: stageOutputEnvelopeOf(subject),
        },
      };
    });

    const taskCounts: Record<string, number> = {};
    for (const task of tasks) taskCounts[String(task.state)] = (taskCounts[String(task.state)] ?? 0) + 1;

    const executing = [];
    for (const task of tasks) {
      if (task.state !== 'RUNNING') continue;
      const live = (await deps.executionAttempts.listByTask(String(task.id))).find((row) => row.state === 'ACTIVE');
      executing.push({
        taskId: String(task.id),
        stageId: String(task.stageId),
        kind: String(task.kind),
        attempt: live === undefined ? null : {
          attemptId: String(live.seed.id),
          attemptNumber: Number(live.seed.attemptNumber),
          state: String(live.state),
          runtimeInstanceId: live.runtimeInstanceId,
          createdAt: live.createdAt,
          settledAt: live.settledAt,
        },
      });
    }

    const goal = await deps.artifacts.getByCreationCommand(runGoalCommandId(String(run.value.id)));
    const planArtifact = artifacts.find((artifact) => artifact.kind === 'companyos:plan');

    const correctiveTasks = tasks.filter((task) => asRecord(task.inputs['corrective']) !== null);
    const reassessmentTasks = tasks.filter((task) => asRecord(task.inputs['companyos:reassessment']) !== null);
    const latestCorrective = [...correctiveTasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)))[0] ?? null;
    const latestLineage = latestCorrective === null ? null : asRecord(latestCorrective.inputs['corrective']);

    const handoffCount = deps.handoffs?.listForScope === undefined
      ? 0
      : (await deps.handoffs.listForScope({ companyId: input.companyId, workflowRunId: String(run.value.id) })).length;

    const diagnostics: string[] = [];
    const historyEvents = await deps.events.readByRun(String(run.value.id));
    if (run.value.history.length > 0 && historyEvents.length === 0) {
      diagnostics.push('HISTORY_NOT_RECONSTRUCTABLE: run state history exists on the run row; the event feed carries no rows for this run.');
    }

    return ok({
      runId: String(run.value.id),
      companyId: String(run.value.companyId),
      workflowId: String(run.value.workflowId),
      versionId: String(run.value.versionId),
      state: String(run.value.state),
      revision: Number(run.value.revision),
      reworkCount: Number(run.value.reworkCount),
      maxRework: Number(run.value.maxRework),
      failureReason: run.value.failureReason === null ? null : String(run.value.failureReason),
      resumePoint: run.value.resumePoint === null ? null : String(run.value.resumePoint),
      pinnedVersion: {
        templateId: String(run.value.templateId),
        versionId: String(run.value.versionId),
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      },
      goal: goal === null ? null : { artifactRef: `artifact:${goal.artifact.id}` },
      plan: planArtifact === undefined ? null : { artifactRef: `artifact:${planArtifact.id}` },
      stages,
      taskCounts,
      executing,
      attempts: {
        active: attempts.filter((a) => a.state === 'ACTIVE').length,
        interrupted: attempts.filter((a) => a.state === 'INTERRUPTED').length,
        completed: attempts.filter((a) => a.state === 'COMPLETED').length,
        failed: attempts.filter((a) => a.state === 'FAILED').length,
      },
      blockers,
      unresolvedFindings: findings.value.filter((finding) => finding.unresolved),
      validation: {
        requiredValidatorIds,
        completed: validations.map((row) => ({ validatorId: row.validatorId, status: row.status, evidenceRefs: row.evidenceRefs })),
        failed: validations.some((row) => row.status !== 'pass'),
        missing: requiredValidatorIds.filter((id) => !new Set(validations.map((row) => row.validatorId)).has(id)),
      },
      correctiveActivity: {
        rounds: correctiveTasks.length,
        correctiveTaskIds: correctiveTasks.map((task) => String(task.id)),
        reassessmentTaskIds: reassessmentTasks.map((task) => String(task.id)),
        latest: latestCorrective === null || latestLineage === null ? null : {
          taskId: String(latestCorrective.id),
          round: Number(latestLineage['round'] ?? 0),
          parentTaskId: String(latestLineage['parentTaskId'] ?? ''),
          originDecisionId: String(latestLineage['originDecisionId'] ?? ''),
        },
      },
      artifacts: artifacts.map((artifact) => ({ id: String(artifact.id), kind: String(artifact.kind), taskId: artifact.taskId === null ? null : String(artifact.taskId), createdAt: String(artifact.createdAt) })),
      handoffCount,
      progress: {
        stagesTotal: stages.length,
        stagesTerminalSuccessful: stages.filter((stage) => stage.terminalSuccessful).length,
        tasksTotal: tasks.length,
        tasksDone: taskCounts['DONE'] ?? 0,
        tasksActive: taskCounts['RUNNING'] ?? 0,
        tasksBlocked: taskCounts['BLOCKED'] ?? 0,
      },
      diagnostics,
    });
  };

  const getTaskObservation = async (input: {
    readonly companyId: string;
    readonly taskId: string;
  }): Promise<Result<TaskObservation, DomainError>> => {
    const task = await deps.tasks.get(input.taskId);
    if (task === null) return notFound('Task', input.taskId);
    const run = await loadRun(input.companyId, String(task.runId));
    if (!run.ok) return notFound('Task', input.taskId);
    const attempts = (await deps.executionAttempts.listByTask(String(task.id))).map((attempt) => ({
      attemptId: String(attempt.seed.id),
      attemptNumber: Number(attempt.seed.attemptNumber),
      state: String(attempt.state),
      runtimeInstanceId: attempt.runtimeInstanceId,
      createdAt: attempt.createdAt,
      settledAt: attempt.settledAt,
    }));
    const provenance = deps.agentExecutions?.listByTask === undefined
      ? []
      : (await deps.agentExecutions.listByTask(String(task.id))).map((execution) => ({
        executionId: String(execution.executionId),
        status: String(execution.status),
        modelKey: execution.modelKey,
        providerId: execution.providerId,
        providerModelId: execution.providerModelId,
      }));
    const blockers: RunBlocker[] = [];
    if (task.state === 'FAILED') {
      blockers.push({
        code: 'EXECUTION_FAILURE', scope: 'TASK', subjectId: String(task.id),
        sourceType: 'Task', sourceId: String(task.id), evidenceRefs: [`task:${String(task.id)}`],
        explanation: `Task is FAILED (${String(task.attempts)}/${String(task.maxAttempts)} attempts).`,
      });
    }
    const marker = asRecord(task.inputs['companyos:reassessment']);
    const correctiveId = marker !== null && typeof marker['correctiveTaskId'] === 'string' ? marker['correctiveTaskId'] : null;
    if (correctiveId !== null) {
      const corrective = await deps.tasks.get(correctiveId);
      if (corrective !== null && corrective.state !== 'DONE') {
        blockers.push({
          code: 'CAUSAL_CORRECTIVE_WAIT', scope: 'TASK', subjectId: String(task.id),
          sourceType: 'Task', sourceId: correctiveId,
          evidenceRefs: [`task:${String(task.id)}`, `corrective:${correctiveId}`],
          explanation: `Causally ineligible until corrective ${correctiveId} is DONE.`,
        });
      }
    }
    /*
     * Sprint26 V2 fix: the dispatch binding is keyed by the CANONICAL ExecutionAttempt
     * id (exa_), never the task id. The lookup walks the task's own attempts and takes
     * the LATEST attempt's binding (the newest canonical execution), so a retried task
     * never shows a stale dispatch.
     */
    let dispatch = null;
    if (deps.providerDispatches?.byAttempt !== undefined) {
      for (const attempt of [...attempts].reverse()) {
        const rows = await deps.providerDispatches.byAttempt(String(attempt.attemptId));
        if (rows.length > 0) {
          dispatch = rows[0]!;
          break;
        }
      }
    }
    const envelope = stageOutputEnvelopeOf(task);
    const terminal = TASK_TERMINAL.has(String(task.state));
    const settled = task.state === 'DONE' && envelope !== null;
    const uncertainty = terminal || task.attempts === 0
      ? null
      : {
          externalInvocationProven: attempts.some((attempt) => attempt.state === 'COMPLETED' || attempt.settledAt !== null),
          canonicalSettlementAbsent: !settled,
          replayPossible: true,
          note: 'Canonical settlement is absent; the external invocation may have been attempted and replay is possible (at-least-once, NOT exactly-once).',
        };
    return ok({
      taskId: String(task.id),
      runId: String(task.runId),
      companyId: input.companyId,
      stageId: String(task.stageId),
      roleId: String(task.roleId),
      kind: String(task.kind),
      state: String(task.state),
      attempts: Number(task.attempts),
      maxAttempts: Number(task.maxAttempts),
      createdAt: String(task.createdAt),
      updatedAt: String(task.updatedAt),
      correctiveLineage: asRecord(task.inputs['corrective']),
      reassessmentMarker: marker,
      executionAttempts: attempts,
      provider: dispatch === null ? null : {
        providerKey: dispatch.providerKey,
        dispatchKey: dispatch.dispatchKey,
        providerSessionId: dispatch.providerSessionId,

        providerInvocationId: dispatch.providerInvocationId,

        state: dispatch.state,
        configFingerprint: dispatch.configFingerprint ?? null,

        // Honest per-installed-runtime truth (the local headless runtime): same-SESSION continuation works;

        // it exposes NO invocation identity, NO query, NO same-invocation recovery.

        recovery: { sessionContinuation: true, sameInvocationRecovery: false, statusQuery: false },

      },
      stageOutput: envelope,
      provenance,
      uncertainty,
      blockers,
    });
  };

  const getRunBlockers = async (input: {
    readonly companyId: string;
    readonly runId: string;
  }): Promise<Result<readonly RunBlocker[], DomainError>> => {
    const overview = await getRunOverview(input);
    if (!overview.ok) return overview;
    return ok(overview.value.blockers);
  };

  const getRunTimeline = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<Result<RunTimelinePage, DomainError>> => {
    const run = await loadRun(input.companyId, input.runId);
    if (!run.ok) return run;
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const runId = String(run.value.id);

    const entries: TimelineEntry[] = [];
    run.value.history.forEach((state, index) => {
      entries.push({
        key: `run-history:${String(index)}:${state.event}:${state.at}:${String(run.value.id)}`,
        kind: 'run.transition', subjectType: 'WorkflowRun', subjectId: runId,
        occurredAt: state.at, sequence: null,
        summary: `${String(state.from)} → ${String(state.to)} (${String(state.event)})`,
        source: { owner: 'WorkflowRun.history', ref: runId },
      });
    });
    const tasks = await deps.tasks.listByRun(runId);
    for (const task of tasks) {
      entries.push({
        key: `task-created:${String(task.id)}`,
        kind: 'task.created', subjectType: 'Task', subjectId: String(task.id),
        occurredAt: String(task.createdAt), sequence: null,
        summary: `Task ${String(task.kind)} created in stage ${String(task.stageId)}`,
        source: { owner: 'Task', ref: String(task.id) },
      });
      const lineage = asRecord(task.inputs['corrective']);
      if (lineage !== null) {
        entries.push({
          key: `corrective-created:${String(task.id)}`,
          kind: 'corrective.created', subjectType: 'Task', subjectId: String(task.id),
          occurredAt: String(task.createdAt), sequence: null,
          summary: `Corrective round ${String(lineage['round'] ?? '?')} (parent ${String(lineage['parentTaskId'] ?? '?')})`,
          source: { owner: 'Task.inputs.corrective', ref: String(task.id) },
        });
      }
      if (asRecord(task.inputs['companyos:reassessment']) !== null) {
        entries.push({
          key: `reassessment-created:${String(task.id)}`,
          kind: 'reassessment.created', subjectType: 'Task', subjectId: String(task.id),
          occurredAt: String(task.createdAt), sequence: null,
          summary: 'Deterministic reassessment provisioned',
          source: { owner: 'Task.inputs.companyos:reassessment', ref: String(task.id) },
        });
      }
      for (const attempt of await deps.executionAttempts.listByTask(String(task.id))) {
        entries.push({
          key: `attempt-claimed:${String(attempt.seed.id)}`,
          kind: 'executionattempt.claimed', subjectType: 'ExecutionAttempt', subjectId: String(attempt.seed.id),
          occurredAt: attempt.createdAt, sequence: null,
          summary: `Attempt ${String(attempt.seed.attemptNumber)} claimed (${String(attempt.state)})`,
          source: { owner: 'ExecutionAttempt', ref: String(attempt.seed.id) },
        });
        if (attempt.settledAt !== null) {
          entries.push({
            key: `attempt-settled:${String(attempt.seed.id)}`,
            kind: 'executionattempt.settled', subjectType: 'ExecutionAttempt', subjectId: String(attempt.seed.id),
            occurredAt: attempt.settledAt, sequence: null,
            summary: `Attempt ${String(attempt.seed.attemptNumber)} settled ${String(attempt.state)}`,
            source: { owner: 'ExecutionAttempt', ref: String(attempt.seed.id) },
          });
        }
      }
    }
    const findings = await findingsOf(input.companyId, run.value);
    if (!findings.ok) return findings;
    for (const finding of findings.value) {
      entries.push({
        key: `finding:${finding.artifactId}`,
        kind: 'finding.reported', subjectType: 'ReviewReport', subjectId: finding.artifactId,
        occurredAt: finding.createdAt, sequence: null,
        summary: `${finding.verdict} on subject ${finding.subjectTaskId} (anchor ${finding.reviewTaskId})${finding.unresolved ? ' — UNRESOLVED' : ''}`,
        source: { owner: 'companyos:review-findings', ref: `artifact:${finding.artifactId}` },
      });
    }
    const decisions = await deps.decisionHistory.listRunDecisionHistory({ runId, companyId: input.companyId, actorId: deps.actorId });
    if (!decisions.ok) return decisions;
    for (const record of decisions.value) {
      const evidence = supervisorDecisionEvidenceOf(record as never);
      entries.push({
        key: `decision:${String(record.decisionId)}@${String(record.version)}`,
        kind: 'decision.recorded', subjectType: 'Decision', subjectId: String(record.decisionId),
        occurredAt: String(record.decidedAt), sequence: null,
        summary: evidence === null ? 'Supervisor decision recorded' : `${evidence.action} (${String(evidence.evidenceRefs.length)} evidence ref(s))`,
        source: { owner: 'DecisionRecord', ref: String(record.decisionId) },
      });
    }
    const validations = await deps.validations.listByRun(runId);
    for (const row of validations) {
      entries.push({
        key: `validation:${String(row.id)}`,
        kind: 'validation.recorded', subjectType: 'Validation', subjectId: String(row.id),
        occurredAt: row.finishedAt ?? row.startedAt, sequence: null,
        summary: `Validator ${row.validatorId} → ${row.status}`,
        source: { owner: 'Validation', ref: String(row.id) },
      });
    }
    const artifacts = await deps.artifacts.listByRun(runId);
    for (const artifact of artifacts) {
      entries.push({
        key: `artifact:${String(artifact.id)}`,
        kind: 'artifact.created', subjectType: 'Artifact', subjectId: String(artifact.id),
        occurredAt: String(artifact.createdAt), sequence: null,
        summary: `Artifact ${String(artifact.kind)}`,
        source: { owner: 'Artifact', ref: `artifact:${String(artifact.id)}` },
      });
    }
    for (const stored of await deps.events.readByRun(runId)) {
      entries.push({
        key: `event:${stored.event.eventId}`,
        kind: `event.${stored.event.type}`, subjectType: stored.event.aggregateType, subjectId: stored.event.aggregateId,
        occurredAt: stored.event.occurredAt, sequence: stored.globalPosition,
        summary: stored.event.type,
        source: { owner: 'events', ref: String(stored.event.eventId) },
      });
    }

    // Stable deterministic order: canonical timestamp first (display/order
    // metadata only — Boss §44), then event sequence, then kind, then key.
    // Global uniqueness by construction: same-millisecond records from different
    // sources get distinct ordinals, so paging never yields a duplicate key.
    const seenKeys = new Map<string, number>();
    const uniquified = entries.map((entry) => {
      const n = seenKeys.get(entry.key) ?? 0;
      seenKeys.set(entry.key, n + 1);
      return n > 0 ? { ...entry, key: `${entry.key}#${String(n)}` } : entry;
    });
    entries.length = 0;
    entries.push(...uniquified);
    entries.sort((a, b) =>
      (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '') ||
      (a.sequence ?? 0) - (b.sequence ?? 0) ||
      a.kind.localeCompare(b.kind) ||
      a.key.localeCompare(b.key));

    /*
     * A cursor is RUN-SCOPED: one produced for another run (or company scope) is a
     * typed error, never a silent cross-run page — cursors carry ordering context
     * that only means something for the run that produced them.
     */
    let after: TimelineCursor | null = null;
    if (input.cursor !== undefined) {
      const decoded = decodeCursor(input.cursor);
      after = decoded === null ? null : decoded.r === runId ? decoded : null;
      if (after === null || after.r !== runId) {
        return err(domainError('INVALID_ARGUMENT', 'The timeline cursor does not belong to this run.', {
          reason: 'OBSERVATION_CURSOR_SCOPE_MISMATCH',
          runId,
        }));
      }
    }
    const filtered = after === null ? entries : entries.filter((entry) => isAfterCursor(entry, after));
    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > page.length;
    const limitation = run.value.history.length > 0 && (await deps.events.readByRun(runId)).length === 0
      ? 'HISTORY_NOT_RECONSTRUCTABLE: the event feed is empty for this run; earlier run transitions are projected from run.history only.'
      : null;
    return ok({
      entries: page,
      nextCursor: hasMore && page.length > 0 ? encodeCursor(runId, page[page.length - 1]!) : null,
      hasMore,
      limitation,
    });
  };

  return { getRunOverview, getTaskObservation, getRunBlockers, getRunTimeline };
};

/* ------------------------------------------------- non-authoritative live signal */

/**
 * Boss §40: an OPTIONAL process-local "canonical state changed" signal. It
 * carries NO truth — a lost notification is recovered by re-reading the
 * projection; nothing in the workflow may ever depend on a subscriber
 * receiving it.
 */
export interface RunObservationNotifier {
  subscribe(runId: string, listener: () => void): () => void;
  /** Fire AFTER the canonical commit (callers must guarantee the ordering). */
  notify(runId: string): void;
}

export const createRunObservationNotifier = (): RunObservationNotifier => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    subscribe(runId, listener) {
      const set = listeners.get(runId) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(runId, set);
      return () => set.delete(listener);
    },
    notify(runId) {
      for (const listener of listeners.get(runId) ?? []) listener();
    },
  };
};

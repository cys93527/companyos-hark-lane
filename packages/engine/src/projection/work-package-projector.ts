/**
 * Work Package projection (Sprint 20 / Task-20-06).
 *
 * A Work Package is the bounded, deterministic, DERIVED execution projection of ONE
 * legitimate Task: everything an executor needs to understand its work — the canonical
 * goal, the exact compiled node objective, the frozen acceptance criteria and validator
 * references, the pinned execution profile, the canonical predecessor results required by
 * the pinned DAG, and any explicitly accepted durable handoff context — WITHOUT scanning
 * raw tables, whole run history, sibling tasks or conversations.
 *
 * ARCHITECTURE SPLIT (frozen): Work Package = derived execution projection (this module,
 * zero persistence of its own); HandoffPacket = durable explicit handoff record (the ONE
 * Sprint-11 HandoffService — reused, never duplicated). Autonomous task-to-task
 * progression projects; explicit human/organizational responsibility transfer persists a
 * HandoffPacket through the existing service.
 *
 * PURITY: zero model calls, zero provider calls, zero mutation of any store. Same durable
 * state ⇒ same semantic package (no clock, no randomness, no timestamp in semantic
 * content; the task's own durable state appears only as clearly-labeled observational
 * metadata). Industry-neutral by construction: every role/kind/validator meaning comes
 * from the pinned WorkflowVersion; this module never names an industry.
 */
import {
  canonicalJson,
  domainError,
  err,
  handoffContextViewIfAccepted,
  isTaskTerminal,
  ok,
  taskProfileOf,
  type DomainError,
  type HandoffContextView,
  type HandoffPacket,
  type Result,
  type Task,
  type WorkflowTemplate,
} from '@companyos/core';

import { stageOutputOf } from '../supervisor/stage-output-carrier.js';

/** The projection contract identity (observational provenance for consumers). */
export const WORK_PACKAGE_CONTRACT = 'companyos/work-package/1';

/** Boundedness: the package is finite by construction, never a database dump. */
export const WORK_PACKAGE_LIMITS = {
  /** Direct DAG predecessors projected per package (plan limits already bound fan-in). */
  maxDirectPredecessors: 16,
  /** Reference lists carried per predecessor result (mirrors the stage-output envelope bounds). */
  maxResultRefs: 16,
  /** Accepted handoff packets projected per package. */
  maxAcceptedHandoffs: 4,
  /** Canonical task inputs size bound (the materializer already enforces this at creation). */
  maxTaskInputsBytes: 16 * 1024,
} as const;

/** One canonical predecessor result, selected by the repository's deterministic rules. */
export interface WorkPackageDependency {
  /** The predecessor stage id in the pinned DAG. */
  readonly stageId: string;
  /** The canonical subject task of that stage (corrective child wins — deterministic). */
  readonly subjectTaskId: string;
  /** The subject's stage-output envelope kind, when the task carries one. */
  readonly resultKind: string | null;
  /** Canonical artifact references from the subject's envelope (references, never copies). */
  readonly artifactRefs: readonly string[];
  /** Canonical validation references from the subject's envelope. */
  readonly validationRefs: readonly string[];
}

/** The approved projection of one durable accepted HandoffPacket (existing owner). */
export interface WorkPackageHandoff {
  readonly handoffId: string;
  readonly version: number;
  readonly view: HandoffContextView;
}

/** The derived Work Package (§39 shape, repository naming; no status machine of its own). */
export interface WorkPackage {
  readonly contract: typeof WORK_PACKAGE_CONTRACT;
  readonly identity: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly stageId: string;
    readonly templateId: string;
    /** The EXACT pinned WorkflowVersion — never the template's current version. */
    readonly workflowVersionId: string;
  };
  readonly goal: {
    /** The Execution-Run-owned canonical goal (never the Planning Run's goal). */
    readonly objective: string;
    /**
     * The goal's bounded structured constraints (Final Readiness Gate): the
     * human-supplied machine-readable scope/parameters/resource list, byte-exact from
     * the run-goal artifact. Null when the goal carries none.
     */
    readonly structured: Readonly<Record<string, unknown>> | null;
    readonly sourceType: string | null;
    readonly sourceRef: string | null;
  };
  readonly work: {
    /** The exact compiled PlanItem objective frozen in the pinned node config (byte-exact). */
    readonly objective: string | null;
    /** The canonical immutable Task.inputs (corrective lineage included as-is). */
    readonly taskInputs: Readonly<Record<string, unknown>>;
  };
  readonly execution: {
    readonly roleId: string;
    readonly taskKind: string;
    readonly maxAttempts: number;
    /**
     * STAGE 8C — the DERIVED professional responsibility pinned beside the task
     * profile (the durable carrier for deterministic run-scoped RoleInstance
     * reconstruction; null when the pinned version predates Stage 8C).
     */
    readonly professionalResponsibility: {
      readonly responsibilityIntent: string;
      readonly requiredCapabilities?: readonly string[];
      readonly independenceRequired?: boolean;
      readonly riskLevel?: 'low' | 'medium' | 'high';
    } | null;
  };
  readonly acceptance: {
    readonly criteria: readonly { readonly criterionId: string; readonly requirement: string }[];
    /** Pinned validator semantic references — informational; authority stays with the registry. */
    readonly validatorRefs: readonly string[];
  };
  readonly dependencies: readonly WorkPackageDependency[];
  /**
   * Sprint21 final — CAUSAL RESULT PROJECTION: when this task IS a deterministic
   * reassessment, its bounded canonical causal reference to the corrected result it
   * re-evaluates (the referenced corrective task's authoritative stageOutput), projected
   * from the immutable reassessment inputs. Never a second DAG, never cross-run evidence.
   */
  readonly causal: {
    readonly correctiveTaskId: string;
    readonly resultKind: string | null;
    readonly artifactRefs: readonly string[];
    readonly validationRefs: readonly string[];
  } | null;
  readonly handoff: readonly WorkPackageHandoff[];
  readonly provenance: {
    readonly snapshotId: string;
    readonly stageSource: 'pinned-workflow-version';
    readonly dependencySource: 'pinned-workflow-version-dag';
    readonly handoffSource: 'accepted-handoff-packets' | 'handoff-chain-absent';
  };
  /** Observational metadata only — never semantic identity, never execution authorization. */
  readonly observational: {
    readonly taskState: string;
  };
}

/**
 * STAGE 8C — read the DERIVED professional responsibility pinned beside the task
 * profile (trusted control-plane derivation, frozen with the version). Null when
 * the pinned version predates Stage 8C — never guessed.
 */
const professionalResponsibilityOfNode = (
  node: { readonly config?: Record<string, unknown> },
): WorkPackage['execution']['professionalResponsibility'] => {
  const value = node.config?.['professionalResponsibility'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const intent = record['responsibilityIntent'];
  if (typeof intent !== 'string' || intent.trim() === '') return null;
  const rawCapabilities = record['requiredCapabilities'];
  const capabilities =
    Array.isArray(rawCapabilities) && rawCapabilities.every((entry) => typeof entry === 'string')
      ? (rawCapabilities as readonly string[])
      : undefined;
  const independence = record['independenceRequired'];
  const risk = record['riskLevel'];
  return {
    responsibilityIntent: intent,
    ...(capabilities === undefined ? {} : { requiredCapabilities: capabilities }),
    ...(typeof independence === 'boolean' ? { independenceRequired: independence } : {}),
    ...(risk === 'low' || risk === 'medium' || risk === 'high' ? { riskLevel: risk } : {}),
  };
};

export interface WorkPackageProjectorDeps {
  readonly runs: {
    get(runId: string): Promise<{
      readonly id: string;
      readonly companyId: string;
      readonly templateId: string;
      readonly versionId: string;
      readonly snapshotId: string;
    } | null>;
  };
  readonly tasks: {
    get(taskId: string): Promise<Task | null>;
    /** T20-03A run-scoped claim read — only this run's task rows are ever loaded. */
    listByRun(runId: string): Promise<readonly Task[]>;
  };
  readonly snapshots: {
    get(snapshotId: string): Promise<{
      readonly runId: string;
      readonly templateId: string;
      readonly workflowVersionId: string;
    } | null>;
  };
  readonly templates: { get(templateId: string): Promise<WorkflowTemplate | null> };
  /** The canonical Run-goal reader (the run-owned `companyos:run-goal` artifact). */
  readonly goal: {
    get(input: {
      readonly runId: string;
      readonly companyId: string;
    }): Promise<
      Result<
        {
          readonly objective: string;
          readonly structured: Readonly<Record<string, unknown>> | null;
          readonly sourceType: string | null;
          readonly sourceRef: string | null;
        },
        DomainError
      >
    >;
  };
  /**
   * The Sprint-11 store's scoped latest-version read. Absent (handoff chain not opened)
   * ⇒ the handoff projection is empty and labeled `handoff-chain-absent`.
   */
  readonly handoffs?: {
    listForScope(scope: {
      readonly companyId: string;
      readonly workflowRunId: string;
      readonly taskId: string;
    }): Promise<readonly HandoffPacket[]>;
  };
}

export interface ProjectWorkPackageInput {
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
}

const notFound = (message: string, details: Record<string, unknown>) =>
  err(domainError('NOT_FOUND', message, details));

/**
 * The canonical subject task of ONE stage (§21/§54): the repository's deterministic
 * selection — a corrective child (its lineage parent is in the stage's task set) always
 * wins over its ancestor; ties break by corrective round, then recency, then id. This is
 * the SAME tie-break rule the T19-04 work-subject selection and the evidence layer use,
 * scoped to one stage and kind-neutral (industry-neutral).
 */
export const stageSubjectTaskOf = (
  stageTasks: readonly Task[],
): Task | null => {
  if (stageTasks.length === 0) return null;
  const ids = new Set(stageTasks.map((task) => String(task.id)));
  const lineageRoundOf = (task: Task): number => {
    const raw = task.inputs['corrective'];
    if (typeof raw !== 'object' || raw === null) return 0;
    const round = (raw as Record<string, unknown>)['round'];
    return typeof round === 'number' ? round : 0;
  };
  const isChild = (task: Task): boolean => {
    const raw = task.inputs['corrective'];
    if (typeof raw !== 'object' || raw === null) return false;
    const parent = (raw as Record<string, unknown>)['parentTaskId'];
    return typeof parent === 'string' && ids.has(parent);
  };
  const byDeterministicRecency = (a: Task, b: Task): number =>
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) ||
    String(a.id).localeCompare(String(b.id));
  const children = stageTasks.filter(isChild);
  const pool = children.length > 0 ? children : stageTasks;
  return pool.slice().sort((a, b) => lineageRoundOf(b) - lineageRoundOf(a) || byDeterministicRecency(a, b))[0] ?? null;
};

export function createWorkPackageProjector(deps: WorkPackageProjectorDeps) {
  const project = async (
    input: ProjectWorkPackageInput,
  ): Promise<Result<WorkPackage, DomainError>> => {
    /* ---- 1. run/task ownership (§12): fail closed, no cross-run oracle ---- */
    const run = await deps.runs.get(input.runId);
    if (run === null || String(run.companyId) !== String(input.companyId)) {
      // A foreign company's run and a missing run are indistinguishable: no existence leak.
      return notFound(`Run "${input.runId}" does not exist for this company.`, {
        reason: 'WORK_PACKAGE_RUN_NOT_FOUND',
        runId: input.runId,
      });
    }
    const task = await deps.tasks.get(input.taskId);
    if (task === null || String(task.runId) !== String(input.runId)) {
      return err(
        domainError('VALIDATION_FAILED', `Task "${input.taskId}" is not owned by this run.`, {
          reason: 'WORK_PACKAGE_TASK_RUN_MISMATCH',
          runId: input.runId,
          taskId: input.taskId,
        }),
      );
    }

    /* ---- 2. pinned workflow source (§13): snapshot → exact version → exact node ---- */
    const snapshot = await deps.snapshots.get(String(run.snapshotId));
    if (snapshot === null || String(snapshot.runId) !== String(run.id)) {
      return err(
        domainError('PERSISTENCE_FAILED', 'The run pins no readable snapshot; the pinned version cannot be proven.', {
          reason: 'WORK_PACKAGE_SNAPSHOT_MISSING',
          runId: run.id,
        }),
      );
    }
    const template = await deps.templates.get(String(snapshot.templateId));
    const version =
      template === null
        ? undefined
        : template.versions.find((entry) => String(entry.id) === String(snapshot.workflowVersionId));
    if (version === undefined) {
      return err(
        domainError('PERSISTENCE_FAILED', 'The pinned WorkflowVersion is missing from the pinned template.', {
          reason: 'WORK_PACKAGE_VERSION_MISSING',
          runId: run.id,
          workflowVersionId: String(snapshot.workflowVersionId),
        }),
      );
    }
    const nodes = version.graph.nodes as readonly {
      readonly id: string;
      readonly kind?: string;
      readonly config?: Record<string, unknown>;
    }[];
    const node = nodes.find((entry) => String(entry.id) === String(task.stageId));
    if (node === undefined) {
      return err(
        domainError('VALIDATION_FAILED', `Stage "${String(task.stageId)}" is not part of the run's pinned version.`, {
          reason: 'WORK_PACKAGE_STAGE_NOT_PINNED',
          runId: run.id,
          stageId: String(task.stageId),
        }),
      );
    }
    const nodeConfig = node.config ?? {};

    /* ---- 3. pinned execution profile (§18) must match the task's own semantics (§12) ---- */
    const profile = taskProfileOf(node as never);
    if (profile === null) {
      return err(
        domainError('VALIDATION_FAILED', `Stage "${String(task.stageId)}" pins no complete execution profile.`, {
          reason: 'WORK_PACKAGE_STAGE_PROFILE_UNAVAILABLE',
          stageId: String(task.stageId),
        }),
      );
    }
    if (
      String(task.roleId) !== String(profile.roleId) ||
      String(task.kind) !== String(profile.taskKind) ||
      Number(task.maxAttempts) !== Number(profile.maxAttempts)
    ) {
      return err(
        domainError('VALIDATION_FAILED', 'The task no longer matches the pinned node execution profile.', {
          reason: 'WORK_PACKAGE_TASK_PROFILE_MISMATCH',
          taskId: String(task.id),
          stageId: String(task.stageId),
        }),
      );
    }

    /* ---- 4. the run-owned canonical goal (§14) ---- */
    const goal = await deps.goal.get({ runId: run.id, companyId: input.companyId });
    if (!goal.ok) return goal;

    /* ---- 5. dependencies from the pinned DAG ONLY (§20/§25), canonical results (§21-§24) ---- */
    const edges = (version.graph as { edges?: readonly { from: string; to: string }[] }).edges ?? [];
    const predecessorStageIds = [
      ...new Set(
        edges
          .filter((edge) => String(edge.to) === String(task.stageId))
          .map((edge) => String(edge.from)),
      ),
    ].sort();
    if (predecessorStageIds.length > WORK_PACKAGE_LIMITS.maxDirectPredecessors) {
      return err(
        domainError('LIMIT_EXCEEDED', 'The pinned DAG predecessor fan-in exceeds the Work Package bound.', {
          reason: 'WORK_PACKAGE_PREDECESSOR_FANIN_EXCEEDED',
          stageId: String(task.stageId),
          predecessors: predecessorStageIds.length,
        }),
      );
    }
    const runTasks = await deps.tasks.listByRun(run.id);
    const dependencies: WorkPackageDependency[] = [];
    for (const stageId of predecessorStageIds) {
      const stageTasks = runTasks.filter((row) => String(row.stageId) === stageId);
      if (stageTasks.length === 0) {
        return err(
          domainError('VALIDATION_FAILED', `Required predecessor stage "${stageId}" has no work yet.`, {
            reason: 'WORK_PACKAGE_DEPENDENCY_NOT_READY',
            stageId,
          }),
        );
      }
      const open = stageTasks.filter((row) => !isTaskTerminal(row.state));
      if (open.length > 0) {
        return err(
          domainError('VALIDATION_FAILED', `Required predecessor stage "${stageId}" still has open work.`, {
            reason: 'WORK_PACKAGE_DEPENDENCY_NOT_READY',
            stageId,
            openTasks: open.map((row) => String(row.id)),
          }),
        );
      }
      if (!stageTasks.some((row) => row.state === 'DONE')) {
        return err(
          domainError('VALIDATION_FAILED', `Required predecessor stage "${stageId}" has no successful result.`, {
            reason: 'WORK_PACKAGE_DEPENDENCY_NOT_READY',
            stageId,
          }),
        );
      }
      const subject = stageSubjectTaskOf(stageTasks);
      if (subject === null) {
        return err(
          domainError('VALIDATION_FAILED', `The canonical subject of predecessor stage "${stageId}" cannot be resolved.`, {
            reason: 'WORK_PACKAGE_DEPENDENCY_NOT_READY',
            stageId,
          }),
        );
      }
      const envelope = stageOutputOf(subject);
      if (!envelope.ok) return envelope;
      const output = envelope.value;
      dependencies.push({
        stageId,
        subjectTaskId: String(subject.id),
        resultKind: output === null ? null : String(output.kind),
        artifactRefs: (output?.artifactRefs ?? []).slice(0, WORK_PACKAGE_LIMITS.maxResultRefs).map(String),
        validationRefs: (output?.validationRefs ?? []).slice(0, WORK_PACKAGE_LIMITS.maxResultRefs).map(String),
      });
    }

    /* ---- 5.5 CAUSAL RESULT PROJECTION (Sprint21 final §25-§29) ---- */
    let causal: WorkPackage['causal'] = null;
    const reassessmentInput = task.inputs['companyos:reassessment'] as
      | { readonly correctiveTaskId?: unknown }
      | undefined;
    if (reassessmentInput !== undefined && typeof reassessmentInput === 'object') {
      if (typeof reassessmentInput.correctiveTaskId !== 'string') {
        return err(
          domainError('VALIDATION_FAILED', 'The reassessment inputs carry no readable corrective reference.', {
            reason: 'WORK_PACKAGE_CAUSAL_REFERENCE_INVALID',
            taskId: String(task.id),
          }),
        );
      }
      const correctiveTaskId = reassessmentInput.correctiveTaskId;
      const corrective = await deps.tasks.get(correctiveTaskId);
      if (corrective === null || String(corrective.runId) !== String(run.id)) {
        // Cross-run / missing references fail closed — no foreign projection.
        return err(
          domainError('VALIDATION_FAILED', 'The referenced corrective task does not belong to this run.', {
            reason: 'WORK_PACKAGE_CAUSAL_REFERENCE_INVALID',
            taskId: String(task.id),
            correctiveTaskId,
          }),
        );
      }
      if (corrective!.state !== 'DONE') {
        return err(
          domainError('VALIDATION_FAILED', 'The referenced corrective task is not canonically complete.', {
            reason: 'WORK_PACKAGE_CAUSAL_REFERENCE_NOT_DONE',
            taskId: String(task.id),
            correctiveTaskId,
          }),
        );
      }
      const correctiveEnvelope = stageOutputOf(corrective!);
      if (!correctiveEnvelope.ok) return correctiveEnvelope;
      causal = {
        correctiveTaskId,
        resultKind: correctiveEnvelope.value === null ? null : String(correctiveEnvelope.value.kind),
        artifactRefs: (correctiveEnvelope.value?.artifactRefs ?? []).slice(0, WORK_PACKAGE_LIMITS.maxResultRefs).map(String),
        validationRefs: (correctiveEnvelope.value?.validationRefs ?? []).slice(0, WORK_PACKAGE_LIMITS.maxResultRefs).map(String),
      };
    }

    /* ---- 6. explicitly accepted durable handoff context (§31-§33), existing owner ---- */
    const handoff: WorkPackageHandoff[] = [];
    let handoffSource: WorkPackage['provenance']['handoffSource'] = 'handoff-chain-absent';
    if (deps.handoffs !== undefined) {
      handoffSource = 'accepted-handoff-packets';
      const packets = await deps.handoffs.listForScope({
        companyId: input.companyId,
        workflowRunId: run.id,
        taskId: String(task.id),
      });
      for (const packet of packets.slice(0, WORK_PACKAGE_LIMITS.maxAcceptedHandoffs)) {
        // The domain's OWN ACCEPTED-only projection: pending/rejected/superseded never
        // become active context (supersession is per-packet latest-version semantics).
        const view = handoffContextViewIfAccepted(packet);
        if (view !== null) {
          handoff.push({ handoffId: String(packet.handoffId), version: Number(packet.handoffVersion), view });
        }
      }
    }

    /* ---- 7. task inputs (§19): canonical, immutable, bounded ---- */
    const taskInputs = task.inputs;
    if (new TextEncoder().encode(canonicalJson(taskInputs)).length > WORK_PACKAGE_LIMITS.maxTaskInputsBytes) {
      return err(
        domainError('LIMIT_EXCEEDED', 'The task inputs exceed the Work Package bound.', {
          reason: 'WORK_PACKAGE_TASK_INPUTS_UNBOUNDED',
          taskId: String(task.id),
        }),
      );
    }

    /* ---- 8. the frozen node semantics (§15-§17): byte-exact, never reinterpreted ---- */
    const planItem = nodeConfig['planItem'] as { readonly objective?: unknown } | undefined;
    const objective =
      planItem !== undefined && typeof planItem.objective === 'string' ? planItem.objective : null;
    const criteria = Array.isArray(nodeConfig['acceptanceCriteria'])
      ? (nodeConfig['acceptanceCriteria'] as readonly { criterionId: string; requirement: string }[])
      : [];
    const validatorRefs = Array.isArray(nodeConfig['validatorIds'])
      ? (nodeConfig['validatorIds'] as readonly unknown[]).map(String)
      : [];

    /* ---- 9. pure derived result; no store write, no clock, no provider ---- */
    return ok({
      contract: WORK_PACKAGE_CONTRACT,
      identity: {
        companyId: String(input.companyId),
        runId: String(run.id),
        taskId: String(task.id),
        stageId: String(task.stageId),
        templateId: String(snapshot.templateId),
        workflowVersionId: String(snapshot.workflowVersionId),
      },
      goal: {
        objective: goal.value.objective,
        structured: goal.value.structured,
        sourceType: goal.value.sourceType,
        sourceRef: goal.value.sourceRef,
      },
      work: { objective, taskInputs },
      execution: {
        roleId: String(profile.roleId),
        taskKind: String(profile.taskKind),
        maxAttempts: Number(profile.maxAttempts),
        professionalResponsibility: professionalResponsibilityOfNode(node),
      },
      acceptance: { criteria: [...criteria], validatorRefs: [...validatorRefs] },
      dependencies,
      causal,
      handoff,
      provenance: {
        snapshotId: String(run.snapshotId),
        stageSource: 'pinned-workflow-version',
        dependencySource: 'pinned-workflow-version-dag',
        handoffSource,
      },
      observational: { taskState: String(task.state) },
    });
  };

  return { project };
}


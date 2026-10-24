/**
 * Generic normal-task materializer (Sprint 20 / Task-20-03B + Boss architecture
 * corrective: pack-driven PINNED profiles).
 *
 * The trusted production path that was missing: an EXISTING Run plus its immutable pinned
 * WorkflowVersion → ONE canonical baseline normal Task per (run, materializable stage) →
 * the existing Task store → the existing Engine. Generic infrastructure only: this module
 * knows nothing about Planning, Plan artifacts, handoff, verticals or any provider.
 *
 * Frozen semantics (T20-03A):
 *  - ownership: task.runId = the canonical Run (never caller-supplied);
 *  - creation seed: runId + stageId + roleId + kind + maxAttempts + canonical inputs —
 *    replay compares the SEED, never createdAt/updatedAt/state/attempts/outputs;
 *  - creation goes through the guarded seam (`putGuarded`): same seed ⇒ REPLAY (the stored
 *    row wins untouched, whatever the wall clock), different seed ⇒ TASK_IDENTITY_CONFLICT.
 *
 * The normal-task identity is deterministic from the trusted scope alone —
 * `tsk_<sha256("companyos/normal-task/1:company:run:stage")[0:26]>` — so repeated
 * materialization for the same run/stage needs NO command ledger: identity itself is
 * permanent, and the guarded seam arbitrates replay vs conflict. The namespace is salted
 * apart from the corrective identity, which this module never creates.
 */
import {
  CORRECTIVE_TASK_INPUTS_KEY,
  canonicalJson,
  createTask,
  domainError,
  err,
  ok,
  sha256Hex,
  taskProfileOf,
  type DomainError,
  type Result,
  type Task,
} from '@companyos/core';

/** Bounded generic creation inputs (canonical JSON), the materializer's only payload bound. */
export const NORMAL_TASK_INPUTS_MAX_BYTES = 16_384;

export interface NormalTaskMaterializerDeps {
  readonly runs: {
    get(runId: string): Promise<{
      readonly id: string;
      readonly companyId: string;
      readonly templateId: string;
      readonly versionId: string;
      readonly snapshotId: string;
    } | null>;
  };
  readonly templates: {
    get(templateId: string): Promise<{
      readonly versions: readonly {
        readonly id: string;
        readonly graph: {
          readonly nodes: readonly {
            readonly id: string;
            readonly kind: string;
            readonly title: string;
            readonly config: Readonly<Record<string, unknown>>;
          }[];
        };
      }[];
    } | null>;
  };
  /** The frozen T18-02 seam: the run's pinned snapshot must verify before anything is created. */
  readonly runSnapshot: {
    verify(input: {
      readonly runId: string;
      readonly snapshotId: string;
    }): Promise<Result<unknown, DomainError>>;
  };
  /**
   * OPTIONAL trusted runtime availability probe (composition-owned): does a process-local
   * implementation exist for this PINNED semantic task kind? Availability ONLY — the probe
   * can never choose, order or substitute semantic kinds (no "first registered handler"
   * authority exists anywhere in this module).
   */
  readonly taskKindAvailable?: (taskKind: string) => boolean;
  readonly tasks: {
    get(taskId: string): Promise<Task | null>;
    putGuarded(entity: Task): Promise<
      Result<{ readonly taskId: string; readonly replayed: boolean }, DomainError>
    >;
  };
  readonly clock: { nowIso(): string };
}

export interface MaterializeNormalTaskInput {
  readonly companyId: string;
  readonly runId: string;
  readonly stageId: string;
  /** Bounded trusted immutable creation inputs (generic; corrective keys are refused). */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export interface MaterializedNormalTask {
  readonly taskId: string;
  readonly replayed: boolean;
  readonly task: Task;
}

/** The permanent normal-task identity: deterministic from the trusted scope alone. */
export const normalTaskIdOf = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly stageId: string;
}): string =>
  `tsk_${sha256Hex(
    `companyos/normal-task/1:${String(input.companyId)}:${String(input.runId)}:${String(
      input.stageId,
    )}`,
  ).slice(0, 26)}`;

export function createNormalTaskMaterializer(deps: NormalTaskMaterializerDeps) {
  const materialize = async (
    input: MaterializeNormalTaskInput,
  ): Promise<Result<MaterializedNormalTask, DomainError>> => {
    // 1. The canonical Run — tenant scope proven here, never caller-claimed (no leak).
    const run = await deps.runs.get(input.runId);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.runId,
        }),
      );
    }
    // 2. The run's immutable pin must verify (never a caller-supplied snapshot/version).
    const verified = await deps.runSnapshot.verify({
      runId: run.id,
      snapshotId: run.snapshotId,
    });
    if (!verified.ok) return verified;
    // 3. Resolve the PINNED version — never template.currentVersion: a later published V2
    //    cannot change what an existing run materializes.
    const template = await deps.templates.get(run.templateId);
    const version =
      template === null
        ? undefined
        : template.versions.find((entry) => entry.id === run.versionId);
    if (version === undefined) {
      return err(
        domainError('NOT_FOUND', `The version pinned by run "${run.id}" is missing.`, {
          reason: 'RUN_VERSION_MISSING',
          runId: run.id,
          versionId: run.versionId,
        }),
      );
    }
    // 4. Exact canonical stage id inside the pinned graph (no fuzzy mapping).
    const node = version.graph.nodes.find((entry) => entry.id === input.stageId);
    if (node === undefined) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Stage "${input.stageId}" is not part of run "${run.id}"'s pinned version.`,
          {
            reason: 'NORMAL_TASK_STAGE_NOT_PINNED',
            runId: run.id,
            stageId: input.stageId,
          },
        ),
      );
    }
    /*
     * 5. The PINNED materialization profile (the corrective's core change): roleId /
     *    taskKind / maxAttempts are frozen in the pinned node's config by whatever
     *    Pack/workflow published this version — a COMPLETE profile is what makes a stage
     *    materializable. No stage-kind enumeration, no software-role mapping, no
     *    live-composition resolver: Core is industry-agnostic. Absent/partial/malformed ⇒
     *    fail closed (publish-time validation already rejected malformed profiles; this
     *    read-side check is defense in depth against, e.g., a tampered row).
     */
    const profile = taskProfileOf(node);
    if (profile === null) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Stage "${input.stageId}" has no complete pinned task profile; it is not materializable.`,
          {
            reason: 'NORMAL_TASK_STAGE_PROFILE_UNAVAILABLE',
            runId: run.id,
            stageId: input.stageId,
          },
        ),
      );
    }
    // 6. Runtime availability for the PINNED semantic kind — confirm only, never choose.
    if (deps.taskKindAvailable !== undefined && !deps.taskKindAvailable(profile.taskKind)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `No runtime implementation is available for the pinned task kind "${profile.taskKind}"; refusing to materialize (no substitution).`,
          {
            reason: 'NORMAL_TASK_TASK_KIND_UNAVAILABLE',
            runId: run.id,
            stageId: input.stageId,
            taskKind: profile.taskKind,
          },
        ),
      );
    }
    // 7. Corrective lineage is owned solely by the corrective provisioner.
    const inputs = input.inputs ?? {};
    if (inputs[CORRECTIVE_TASK_INPUTS_KEY] !== undefined) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'Normal task inputs must not carry corrective lineage; the corrective provisioner owns it.',
          {
            reason: 'NORMAL_TASK_CORRECTIVE_INPUTS_FORBIDDEN',
            runId: run.id,
            stageId: input.stageId,
          },
        ),
      );
    }
    // 8. Bounded payload seam (canonical bytes).
    const canonicalInputs = canonicalJson(inputs);
    if (canonicalInputs.length > NORMAL_TASK_INPUTS_MAX_BYTES) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Normal task inputs exceed the ${String(NORMAL_TASK_INPUTS_MAX_BYTES)}-byte canonical bound.`,
          {
            reason: 'NORMAL_TASK_INPUTS_TOO_LARGE',
            runId: run.id,
            stageId: input.stageId,
            bytes: canonicalInputs.length,
          },
        ),
      );
    }
    // 9. Deterministic identity + the frozen guarded creation seam.
    const taskId = normalTaskIdOf({
      companyId: run.companyId,
      runId: run.id,
      stageId: input.stageId,
    });
    const made = await createTask({
      runId: run.id as never,
      stageId: node.id as never,
      roleId: profile.roleId as never,
      kind: profile.taskKind,
      maxAttempts: profile.maxAttempts,
      inputs,
      now: deps.clock.nowIso(),
      ids: {
        id: (prefix?: string) =>
          prefix === undefined || prefix === 'tsk' ? taskId : `${prefix}_${taskId}`,
        ulid: () => taskId,
      },
    });
    if (!made.ok) return made;
    const guarded = await deps.tasks.putGuarded({ ...made.value, id: taskId as Task['id'] });
    if (!guarded.ok) return guarded;
    const stored = await deps.tasks.get(taskId);
    if (stored === null) {
      return err(
        domainError('PERSISTENCE_FAILED', `Task "${taskId}" disappeared after creation.`, {
          reason: 'NORMAL_TASK_STORE_READBACK_MISSING',
          taskId,
        }),
      );
    }
    return ok({ taskId, replayed: guarded.value.replayed, task: stored });
  };

  return { materialize, materializeNormalTask: materialize };
}

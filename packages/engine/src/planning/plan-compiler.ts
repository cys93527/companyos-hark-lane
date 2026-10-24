/**
 * Deterministic plan compiler + execution-run derivation + task materialization
 * (Sprint 20 / Task-20-05).
 *
 * PURE COMPILER: a Plan artifact plus a trusted immutable compilation profile become a
 * canonical WorkflowVersion graph — ZERO model calls, ZERO repair, ZERO classification,
 * ZERO current-time or random semantic decisions. Industry-neutral by construction: every
 * role/kind/validator meaning comes from the trusted profile (a Pack/workflow concern);
 * Core has no software vocabulary (source-asserted by the test suite).
 *
 * APPLICATION SERVICE: the canonical graph goes through the REAL publish lifecycle (never
 * a raw store write), then ONE Execution Run pinned to exactly that version (its OWN
 * canonical goal, same semantics as the planning goal, provenance — never cross-run
 * evidence), then baseline tasks through the frozen generic NormalTaskMaterializer. Each
 * step has a durable deterministic identity, so every crash window replays to the same
 * result: same compilation command → same anchor → same template (deterministic id) →
 * same version → same Run (deterministic Run.id, PRIMARY-KEY arbitrated) → same tasks.
 */
import {
  FAULT_CHECKPOINTS,
  canonicalJson,
  domainError,
  err,
  ok,
  sha256Hex,
  taskProfileOf,
  validatePlanArtifactPayload,
  type DomainError,
  type Result,
  type WorkflowTemplate,
} from '@companyos/core';

/**
 * The trusted PER-ITEM execution profile (Boss hardening §6): one PlanItem's frozen
 * semantics. Stage kind, task profile and validators are Pack-owned trusted truth.
 */
export interface PlanItemCompilationProfile {
  /** The neutral stage kind the compiled node carries (workflow vocabulary, Pack-owned). */
  readonly stageKind: string;
  /** The T20-03B task profile frozen into the compiled node config. */
  readonly taskProfile: { readonly roleId: string; readonly taskKind: string; readonly maxAttempts: number };
  /** Required validators (trusted Pack authority — the Plan never chooses validators). */
  readonly validatorIds?: readonly string[];
  /**
   * STAGE 8C — the DERIVED professional responsibility frozen beside the task
   * profile (trusted control-plane derivation): the durable, versioned carrier the
   * runtime reads to reconstruct the run-scoped RoleInstance deterministically.
   * The pinned WorkflowVersion stays the single task truth.
   */
  readonly professionalResponsibility?: {
    readonly responsibilityIntent: string;
    readonly requiredCapabilities?: readonly string[];
    readonly independenceRequired?: boolean;
    readonly riskLevel?: 'low' | 'medium' | 'high';
  };
}

/**
 * The trusted immutable compilation SPEC (Boss hardening §6-§8): an EXPLICIT, COMPLETE
 * per-PlanItem assignment. The join key is the exact canonical `planItemId` — never
 * objective text, classification, order or timestamps. Missing and extra assignments are
 * rejected BEFORE compilation; no implicit default/fallback profile exists in Core.
 */
export interface PlanCompilationSpec {
  readonly planItemProfiles: Readonly<Record<string, PlanItemCompilationProfile>>;
}

/** The compiler contract identity recorded in the permanent compilation anchor. */
export const PLAN_COMPILER_CONTRACT = 'companyos/plan-compiler/1';

/** The permanent compilation anchor's artifact kind (planning-run-owned provenance). */
export const PLAN_COMPILATION_ANCHOR_KIND = 'companyos:plan-compilation';

export interface PlanCompilerDeps {
  readonly artifacts: {
    get(artifactId: string): Promise<{
      readonly id: string;
      readonly runId: string;
      readonly kind: string;
      readonly contentHash: string;
      readonly contentRef: string;
    } | null>;
    /** The artifact's permanent creation command (e.g. `plan:<planId>`). */
    commandIdOf(artifactId: string): Promise<string | null>;
    create(command: {
      readonly commandId: string;
      readonly runId: string;
      readonly taskId?: string | null;
      readonly kind: string;
      readonly content: Uint8Array;
      readonly producedBy: string;
      readonly authorizedBy?: string;
      readonly traceId: string;
    }): Promise<Result<{ readonly artifactId: string }, DomainError>>;
    /** Permanent lookup by creation command (the anchor replay/conflict seam). */
    findByCommand(commandId: string): Promise<{
      readonly artifactId: string;
      readonly fingerprint: string;
    } | null>;
  };
  readonly content: { get(contentRef: string): Promise<Uint8Array | null> };
  readonly templates: {
    get(templateId: string): Promise<WorkflowTemplate | null>;
  };
  readonly runs: {
    get(runId: string): Promise<{
      readonly id: string;
      readonly companyId: string;
      readonly workflowId: string;
      readonly templateId: string;
      readonly versionId: string;
    } | null>;
  };
  readonly goal: {
    get(input: {
      readonly runId: string;
      readonly companyId: string;
    }): Promise<
      Result<
        {
          readonly objective: string;
          /** The planning goal's bounded structured constraints, carried byte-same (§37). */
          readonly structured: Readonly<Record<string, unknown>> | null;
        },
        DomainError
      >
    >;
  };
  readonly lifecycle: {
    createTemplate(input: {
      readonly orgId: string;
      readonly name: string;
      readonly actorId: string;
      readonly templateId?: string;
    }): Promise<Result<WorkflowTemplate, DomainError>>;
    saveDraftGraph(input: {
      readonly templateId: string;
      readonly graph: unknown;
      readonly actorId: string;
    }): Promise<Result<WorkflowTemplate, DomainError>>;
    publish(input: {
      readonly templateId: string;
      readonly actorId: string;
    }): Promise<Result<WorkflowTemplate, DomainError>>;
    createRun(input: {
      readonly templateId: string;
      readonly companyId: string;
      readonly workflowId: string;
      readonly actorId: string;
      readonly runId?: string;
      readonly commandId?: string;
      readonly modelBindings?: Readonly<Record<string, string>>;
      readonly goal?: {
        readonly objective: string;
        readonly source?: { readonly type: 'human' | 'application'; readonly ref?: string };
      };
    }): Promise<
      Result<
        {
          readonly run: { readonly id: string; readonly templateId: string; readonly versionId: string };
          readonly snapshot: { readonly snapshotId: string };
        },
        DomainError
      >
    >;
  };
  /** The frozen T20-03B materializer (the ONLY task-creation path for compiled nodes). */
  readonly materialize: (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly stageId: string;
  }) => Promise<Result<{ readonly taskId: string; readonly replayed: boolean }, DomainError>>;
  readonly faultCheckpoints?: { checkpoint(name: string): Promise<void> };
  readonly bindExecutionGoal?: (runId: string, goalRunId: string) => Promise<void>;
}

export interface CompilePlanInput {
  readonly companyId: string;
  readonly planningRunId: string;
  /** EXACT plan artifact selection — never a latest/newest lookup. */
  readonly planArtifactId: string;
  /** The permanent compilation command — the whole pipeline's replay identity. */
  readonly compilationCommandId: string;
  readonly actorId: string;
  /** Trusted bindings the Execution Run pins for its own runtime (configuration, not model choice). */
  readonly executionBindings: Readonly<Record<string, string>>;
}

export interface CompiledPlanResult {
  readonly planId: string;
  readonly planFingerprint: string;
  readonly templateId: string;
  readonly versionId: string;
  readonly executionRunId: string;
  readonly taskIds: readonly string[];
  readonly replayed: boolean;
}

/** The deterministic compiled-template name (the pipeline's durable discoverability anchor). */
export const compiledTemplateName = (planId: string, compilationCommandId: string): string =>
  `plan-compile:${String(planId)}:${String(compilationCommandId)}`;

/** The deterministic compiled node id: stable from (planId, planItemId) alone. */
export const compiledNodeId = (planId: string, planItemId: string): string =>
  `stg_${sha256Hex(`companyos/plan-stage/1:${String(planId)}:${String(planItemId)}`).slice(0, 16)}`;

/**
 * The permanent compiled Workflow LINEAGE identity (T20-05 hardening B): a deterministic
 * `WorkflowTemplate.id` derived from the immutable compilation semantics. The template
 * row's PRIMARY KEY arbitrates concurrent creation; the template NAME is display-only and
 * is never an authority.
 */
export const compiledTemplateId = (companyId: string, planId: string, compilationCommandId: string): string =>
  `tpl_${sha256Hex(`companyos/compiled-workflow/1:${String(companyId)}:${String(planId)}:${String(compilationCommandId)}`).slice(0, 26)}`;

/**
 * The permanent Execution Run identity (T20-05 hardening A): a deterministic
 * `WorkflowRun.id` derived from the immutable semantic inputs. The run row's PRIMARY KEY
 * is the final arbiter; `Run.workflowId` keeps its canonical meaning (the Workflow
 * lineage the run executes) and is NEVER overloaded with run idempotency identity.
 */
export const executionRunIdOf = (
  companyId: string,
  planningRunId: string,
  planId: string,
  compilationCommandId: string,
): string =>
  `run_${sha256Hex(`companyos/execution-run/1:${String(companyId)}:${String(planningRunId)}:${String(planId)}:${String(compilationCommandId)}`).slice(0, 26)}`;

/**
 * The PURE compilation: Plan + profile → the canonical immutable WorkflowVersion graph.
 * Deterministic; every semantic of the plan survives (id, objective, dependencies,
 * criteria with exact text); criteria definitions are physically duplicated into each
 * referencing node (one canonical criterionId each — the version has no schema-level
 * criterion store) and the immutable compile provenance travels in node config.
 */
/**
 * EXACT COVERAGE (Boss §8): every PlanItem has exactly one trusted profile — missing,
 * extra and malformed assignments all fail closed BEFORE any compilation output exists.
 */
export const validateCompilationCoverage = (
  planItems: readonly { readonly planItemId: string }[],
  spec: PlanCompilationSpec,
): Result<Readonly<Record<string, PlanItemCompilationProfile>>, DomainError> => {
  const assignment: Record<string, PlanItemCompilationProfile> = {};
  const seen = new Set<string>();
  for (const item of planItems) {
    const profile = spec.planItemProfiles[item.planItemId];
    if (profile === undefined) {
      return err(
        domainError('VALIDATION_FAILED', `No trusted compilation profile is assigned to plan item "${String(item.planItemId)}".`, {
          reason: 'COMPILATION_PROFILE_MISSING',
          planItemId: item.planItemId,
        }),
      );
    }
    seen.add(item.planItemId);
    assignment[item.planItemId] = profile;
  }
  for (const key of Object.keys(spec.planItemProfiles)) {
    if (!seen.has(key)) {
      return err(
        domainError('VALIDATION_FAILED', `A compilation profile is assigned to unknown plan item "${String(key)}".`, {
          reason: 'COMPILATION_PROFILE_UNKNOWN_ITEM',
          planItemId: key,
        }),
      );
    }
  }
  for (const [planItemId, profile] of Object.entries(assignment)) {
    if (
      profile.stageKind.trim() === '' ||
      profile.taskProfile.roleId.trim() === '' ||
      profile.taskProfile.taskKind.trim() === '' ||
      !Number.isInteger(profile.taskProfile.maxAttempts) ||
      profile.taskProfile.maxAttempts < 1 ||
      profile.taskProfile.maxAttempts > 100
    ) {
      return err(
        domainError('VALIDATION_FAILED', `The compilation profile for plan item "${String(planItemId)}" is malformed.`, {
          reason: 'COMPILATION_PROFILE_MALFORMED',
          planItemId,
        }),
      );
    }
  }
  return ok(assignment);
};

export const compilePlanGraph = (
  plan: {
    readonly planItems: readonly {
      readonly planItemId: string;
      readonly objective: string;
      readonly dependencyPlanItemIds: readonly string[];
      readonly acceptanceCriterionRefs: readonly string[];
    }[];
    readonly acceptanceCriteria: readonly {
      readonly criterionId: string;
      readonly requirement: string;
    }[];
  },
  provenance: {
    readonly planId: string;
    readonly planFingerprint: string;
    readonly planningRunId: string;
  },
  spec: Readonly<Record<string, PlanItemCompilationProfile>>,
): { readonly nodes: readonly unknown[]; readonly edges: readonly { readonly from: string; readonly to: string }[] } => {
  const criteriaById = new Map(plan.acceptanceCriteria.map((entry) => [entry.criterionId, entry]));
  const idOf = (planItemId: string): string => compiledNodeId(provenance.planId, planItemId);
  const nodes = plan.planItems.map((item) => {
    const profile = spec[item.planItemId] as PlanItemCompilationProfile;
    return {
    id: idOf(item.planItemId),
    kind: profile.stageKind,
    title: item.planItemId,
    config: {
      taskProfile: profile.taskProfile,
      ...(profile.professionalResponsibility === undefined
        ? {}
        : { professionalResponsibility: profile.professionalResponsibility }),
      ...(profile.validatorIds === undefined || profile.validatorIds.length === 0
        ? {}
        : { validatorIds: [...profile.validatorIds] }),
      planItem: {
        planItemId: item.planItemId,
        objective: item.objective,
        acceptanceCriterionRefs: [...item.acceptanceCriterionRefs],
      },
      // Physical duplication of the REFERENCED definitions (canonical ids preserved);
      // text is copied byte-for-byte — never rewritten, summarized or reinterpreted.
      acceptanceCriteria: item.acceptanceCriterionRefs
        .map((ref) => criteriaById.get(ref))
        .filter((entry): entry is { criterionId: string; requirement: string } => entry !== undefined)
        .map((entry) => ({ criterionId: entry.criterionId, requirement: entry.requirement })),
      compiledFrom: {
        planId: provenance.planId,
        planFingerprint: provenance.planFingerprint,
        planningRunId: provenance.planningRunId,
      },
    },
    };
  });
  const edges = plan.planItems.flatMap((item) =>
    item.dependencyPlanItemIds.map((dependency) => ({
      from: idOf(dependency),
      to: idOf(item.planItemId),
    })),
  );
  return { nodes, edges };
};

export function createPlanCompiler(deps: PlanCompilerDeps) {
  const compile = async (
    input: CompilePlanInput,
    spec: PlanCompilationSpec,
  ): Promise<Result<CompiledPlanResult, DomainError>> => {
    /* ---- 1. EXACT plan selection + authority validation (§4/§5) ---- */
    const artifact = await deps.artifacts.get(input.planArtifactId);
    if (artifact === null || String(artifact.runId) !== String(input.planningRunId)) {
      return err(
        domainError('NOT_FOUND', `Plan artifact "${input.planArtifactId}" is not owned by this planning run.`, {
          reason: 'PLAN_ARTIFACT_NOT_OWNED',
          planArtifactId: input.planArtifactId,
        }),
      );
    }
    const run = await deps.runs.get(input.planningRunId);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Planning run "${input.planningRunId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.planningRunId,
        }),
      );
    }
    if (artifact.kind !== 'companyos:plan') {
      return err(
        domainError('VALIDATION_FAILED', `Artifact "${input.planArtifactId}" is not a plan.`, {
          reason: 'PLAN_ARTIFACT_KIND_MISMATCH',
          kind: artifact.kind,
        }),
      );
    }
    const bytes = await deps.content.get(artifact.contentRef);
    if (bytes === null) {
      return err(
        domainError('NOT_FOUND', `Plan artifact "${input.planArtifactId}" content is unreadable.`, {
          reason: 'PLAN_ARTIFACT_CONTENT_MISSING',
          planArtifactId: input.planArtifactId,
        }),
      );
    }
    const planPayload = validatePlanArtifactPayload(JSON.parse(new TextDecoder().decode(bytes)));
    if (!planPayload.ok) return planPayload;
    const contentHash = sha256Hex(new TextDecoder().decode(bytes));
    if (contentHash !== artifact.contentHash) {
      return err(
        domainError('VALIDATION_FAILED', `Plan artifact "${input.planArtifactId}" failed its content hash check.`, {
          reason: 'PLAN_ARTIFACT_FINGERPRINT_MISMATCH',
          planArtifactId: input.planArtifactId,
        }),
      );
    }
    // The plan identity comes from the artifact's OWN permanent command anchor
    // (`plan:<planId>` — written by the planner runtime): exact, durable, replay-stable.
    const commandId = await deps.artifacts.commandIdOf(input.planArtifactId);
    if (commandId === null || !commandId.startsWith('plan:')) {
      return err(
        domainError('VALIDATION_FAILED', 'The selected artifact is not a permanently identified plan.', {
          reason: 'PLAN_ARTIFACT_COMMAND_MISSING',
          planArtifactId: input.planArtifactId,
        }),
      );
    }
    const planId = commandId.slice('plan:'.length);

    /* ---- 2. goal derivation source (§36): the canonical planning goal, byte-same ---- */
    const planningGoal = await deps.goal.get({
      runId: input.planningRunId,
      companyId: input.companyId,
    });
    if (!planningGoal.ok) return planningGoal;

    /* ---- 2.5 EXACT per-item coverage (hardening §8) — before anything durable ---- */
    const coverage = validateCompilationCoverage(planPayload.value.planItems, spec);
    if (!coverage.ok) return coverage;

    /*
     * ---- 2.75 the PERMANENT compilation anchor (hardening §29-§30) ----
     * An IMMUTABLE, planning-run-owned artifact whose content is the canonical
     * compilation-input fingerprint (plan + per-item spec + compiler contract) and whose
     * permanent command identity is the compilation command. It is durable BEFORE the
     * WorkflowVersion exists, so a crash-A retry can never reinterpret the same command
     * with a different Plan or per-item profile: the anchor replays or CONFLICTS.
     */
    const anchorCommandId = `plan-compile:${String(input.companyId)}:${String(input.compilationCommandId)}`;
    const anchorContent = canonicalJson({
      schema: 'companyos/plan-compilation-input/1',
      contract: PLAN_COMPILER_CONTRACT,
      companyId: input.companyId,
      planningRunId: input.planningRunId,
      planId,
      planFingerprint: artifact.contentHash,
      planItemProfiles: coverage.value,
    });
    const anchorFingerprint = sha256Hex(anchorContent);
    const existingAnchor = await deps.artifacts.findByCommand(anchorCommandId);
    if (existingAnchor !== null) {
      if (existingAnchor.fingerprint !== anchorFingerprint) {
        return err(
          domainError(
            'CONFLICT',
            `Compilation command "${input.compilationCommandId}" was already anchored with different compilation inputs.`,
            {
              reason: 'COMPILATION_COMMAND_CONFLICT',
              compilationCommandId: input.compilationCommandId,
            },
          ),
        );
      }
    } else {
      const anchored = await deps.artifacts.create({
        commandId: anchorCommandId,
        runId: input.planningRunId,
        kind: PLAN_COMPILATION_ANCHOR_KIND,
        content: new TextEncoder().encode(anchorContent),
        producedBy: input.actorId,
        authorizedBy: input.actorId,
        traceId: `trace_${anchorFingerprint.slice(0, 8)}`,
      });
      if (!anchored.ok) return anchored;
    }

    /* ---- 3. the PURE compile ---- */
    const graph = compilePlanGraph(
      planPayload.value,
      { planId, planFingerprint: artifact.contentHash, planningRunId: input.planningRunId },
      coverage.value,
    );

    /*
     * ---- 4. the compiled Workflow LINEAGE: permanent deterministic identity (hardening B) ----
     * The lineage is addressed by a deterministic WorkflowTemplate.id (PRIMARY-KEY
     * arbitrated through the guarded creation seam), NEVER by its display name and never
     * by a find-by-name scan. The exact compiled version is resolved by IMMUTABLE CONTENT
     * match inside that lineage — template.currentVersion is never compilation truth, so
     * a later unrelated version can never hijack a replay.
     */
    const templateName = compiledTemplateName(planId, input.compilationCommandId); // display-only
    const compiledId = compiledTemplateId(input.companyId, planId, input.compilationCommandId);
    const expectedGraphJson = canonicalJson(graph);
    const releasedMatchOf = (candidate: WorkflowTemplate) =>
      candidate.versions.find(
        (entry) => !entry.semver.includes('-draft') && canonicalJson(entry.graph) === expectedGraphJson,
      ) ?? null;
    const resolvePublished = async (): Promise<{
      readonly template: WorkflowTemplate;
      readonly version: NonNullable<ReturnType<typeof releasedMatchOf>>;
    } | null> => {
      const current = await deps.templates.get(compiledId);
      if (current === null) return null;
      const version = releasedMatchOf(current);
      return version === null ? null : { template: current, version };
    };
    let template = await deps.templates.get(compiledId);
    if (template !== null && (String(template.orgId) !== String(input.companyId) || template.name !== templateName)) {
      return err(
        domainError(
          'CONFLICT',
          `The compiled workflow lineage "${compiledId}" exists with a different immutable creation seed.`,
          { reason: 'COMPILATION_TEMPLATE_SEED_CONFLICT', templateId: compiledId },
        ),
      );
    }
    let version = template === null ? null : releasedMatchOf(template);
    let replayed = template !== null && version !== null;
    if (version === null) {
      await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.compiledGraphBeforeWorkflowPublish);
      if (template === null) {
        // Guarded creation: the PRIMARY KEY arbitrates concurrent same-lineage creation —
        // the loser receives the canonical row and continues below it.
        const created = await deps.lifecycle.createTemplate({
          orgId: input.companyId,
          name: templateName,
          actorId: input.actorId,
          templateId: compiledId,
        });
        if (!created.ok) return created;
        template = created.value;
      }
      const saved = await deps.lifecycle.saveDraftGraph({
        templateId: template.id,
        graph,
        actorId: input.actorId,
      });
      if (!saved.ok) {
        // A concurrent twin may have published this exact lineage between our read and
        // this write: resolve by content, never by competing publication.
        const resolved = await resolvePublished();
        if (resolved === null) return saved;
        template = resolved.template;
        version = resolved.version;
        replayed = true;
      } else {
        const published = await deps.lifecycle.publish({
          templateId: template.id,
          actorId: input.actorId,
        });
        if (!published.ok) {
          const resolved = await resolvePublished();
          if (resolved === null) return published;
          template = resolved.template;
          version = resolved.version;
          replayed = true;
        } else {
          template = published.value;
          version = releasedMatchOf(template);
          if (version === null) {
            return err(
              domainError('PERSISTENCE_FAILED', 'The compiled version is not resolvable after publication.', {
                reason: 'COMPILATION_VERSION_UNRESOLVED',
                templateId: template.id,
              }),
            );
          }
        }
      }
    }
    if (template === null || version === null) {
      // Control flow guarantees this is unreachable (every unresolved branch returned
      // above), but the resolution result is stated explicitly, fail closed.
      return err(
        domainError('PERSISTENCE_FAILED', 'The compiled workflow lineage could not be resolved.', {
          reason: 'COMPILATION_LINEAGE_UNRESOLVED',
          templateId: compiledId,
        }),
      );
    }
    const versionId = String(version.id);
    let executionRunId = '';
    let runReplayed = false;

    /*
     * ---- 5. ONE Execution Run, PERMANENT deterministic identity (§31/§32 + hardening A) ----
     * The permanent identity is the deterministic Run.id itself; the run row's PRIMARY KEY
     * (through the guarded creation seam) is the FINAL arbiter — find-then-create alone is
     * never the safety. `workflowId` keeps its canonical meaning: the actual compiled
     * Workflow lineage identity. The bounded T18-02 ledger is short-window protection only.
     */
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.workflowPublishedBeforeExecutionRun);
    const permanentRunId = executionRunIdOf(
      input.companyId,
      input.planningRunId,
      planId,
      input.compilationCommandId,
    );
    const existingRun = await deps.runs.get(permanentRunId);
    if (existingRun !== null) {
      // Same permanent identity: replay ONLY on the same immutable creation seed.
      if (String(existingRun.versionId) !== versionId) {
        return err(
          domainError(
            'CONFLICT',
            'The execution run for this compilation command is pinned to a different workflow version.',
            { reason: 'EXECUTION_RUN_VERSION_CONFLICT', runId: existingRun.id },
          ),
        );
      }
      if (
        String(existingRun.templateId) !== String(template.id) ||
        String(existingRun.workflowId) !== String(compiledId)
      ) {
        return err(
          domainError(
            'CONFLICT',
            'The execution run for this compilation command is pinned to a different workflow lineage.',
            { reason: 'EXECUTION_RUN_WORKFLOW_CONFLICT', runId: existingRun.id },
          ),
        );
      }
      const existingGoal = await deps.goal.get({ runId: existingRun.id, companyId: input.companyId });
      if (!existingGoal.ok) return existingGoal;
      if (existingGoal.value.objective !== planningGoal.value.objective) {
        return err(
          domainError(
            'CONFLICT',
            'The execution run for this compilation command owns a semantically different goal.',
            { reason: 'EXECUTION_RUN_GOAL_CONFLICT', runId: existingRun.id },
          ),
        );
      }
      executionRunId = String(existingRun.id);
      runReplayed = true;
    } else {
      const executionRun = await deps.lifecycle.createRun({
        templateId: template.id,
        companyId: input.companyId,
        // Truthful: the run executes the compiled Workflow lineage (its deterministic
        // template identity) — never a run idempotency key overloaded into this field.
        workflowId: compiledId,
        actorId: input.actorId,
        runId: permanentRunId, // PRIMARY-KEY-arbitrated permanent identity
        commandId: input.compilationCommandId, // short-window duplicate protection only
        modelBindings: input.executionBindings,
        goal: {
          // Same canonical semantics as the planning goal (§37) — objective AND its
          // bounded structured constraints, byte-same; the artifact is OWNED by
          // the execution run (created in its transaction), with immutable provenance via
          // the source ref — provenance only, never cross-run evidence.
          objective: planningGoal.value.objective,
          ...(planningGoal.value.structured === null || planningGoal.value.structured === undefined
            ? {}
            : { structured: planningGoal.value.structured }),
          source: { type: 'application', ref: `plan:${String(planId)}` },
        },
      });
      if (!executionRun.ok) return executionRun;
      executionRunId = String(executionRun.value.run.id);
    }

    /* ---- 6. baseline tasks through the frozen materializer (§40/§41) ---- */
    await deps.bindExecutionGoal?.(executionRunId, input.planningRunId);
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.executionRunDurableBeforeTasks);
    const taskIds: string[] = [];
    let index = 0;
    for (const node of graph.nodes) {
      const stageId = (node as { readonly id: string }).id;
      // Only nodes the pinned profile made materializable (a complete taskProfile) get a
      // baseline task — the materializer itself enforces the rest.
      if (taskProfileOf(node as never) === null) continue;
      const task = await deps.materialize({
        companyId: input.companyId,
        runId: executionRunId,
        stageId,
      });
      if (!task.ok) return task;
      taskIds.push(task.value.taskId);
      index += 1;
      if (index === 1) {
        // Crash D: the halfway point of task materialization (one exists, rest missing).
        await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.taskMaterializationProgress);
      }
    }

    /* ---- 7. everything durable, before the caller return (crash E) ---- */
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.compilationCompleteBeforeReturn);
    return ok({
      planId,
      planFingerprint: artifact.contentHash,
      templateId: template.id,
      versionId,
      executionRunId,
      taskIds,
      replayed: replayed || runReplayed,
    });
  };

  return { compile };
}

/**
 * Plan artifact contract + deterministic validator (Sprint 20 / Task-20-02).
 *
 * A Plan is a DURABLE PLANNING SPECIFICATION stored as an immutable Artifact owned by the
 * Planning Run (T20-01 §21 Shape B). It is NOT execution truth: WorkflowVersion / Run /
 * Task / Decision / Review / Validation remain the only execution authorities, a Plan has
 * NO state machine (no DRAFT/APPROVED/RUNNING/…), approval belongs to external authority,
 * and execution belongs to the existing lifecycle. This module defines the "plan language"
 * and its deterministic validation ONLY — no persistence wiring, no provider, no compiler.
 *
 * The strict split (§5): a MODEL may only ever produce a `PlanningProposal` (pure content —
 * items + criteria). Every identity fact (planId, artifactId, planningRunId, companyId,
 * commandId, fingerprint, createdAt, approval, WorkflowVersionId, TaskId) is decided by the
 * trusted runtime/service; none of them appears in the proposal shape.
 */
import { canonicalJson, sha256Hex } from '../kernel/hash.js';
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

/** The immutable artifact kind of one validated planning result (repo convention). */
export const PLAN_ARTIFACT_KIND = 'companyos:plan';

/** The schema of the TRUSTED validated plan payload (what the artifact content carries). */
export const PLAN_SCHEMA = 'companyos/plan/1';

/** The schema a MODEL's structured output must carry — deliberately distinct from the plan. */
export const PLAN_PROPOSAL_SCHEMA = 'companyos/plan-proposal/1';

/** Explicit fail-closed bounds (the review-findings LIMITS convention). */
export const PLAN_LIMITS = {
  planItemMinCount: 1,
  planItemMaxCount: 64,
  criteriaMinCount: 1,
  criteriaMaxCount: 128,
  dependencyRefsPerItemMax: 16,
  criterionRefsPerItemMax: 16,
  planItemIdMaxLength: 64,
  criterionIdMaxLength: 64,
  objectiveMaxChars: 2_000,
  criterionTextMaxChars: 2_000,
} as const;

/**
 * Local, plan-scoped stable ids: lowercase letters/digits/hyphens, no leading hyphen. The
 * regex permits total length 1..`PLAN_LIMITS.planItemIdMaxLength` (64) EXACTLY — the declared
 * bound, the regex bound and the validator checks are one contract (T20-02 corrective §5/§6).
 *
 * The SOURCE string is exported (V1 live-contract closeout, BB-WATCH-001) so every
 * provider-facing generation constraint derives from THE SAME literal the canonical
 * validator tests against — a future identifier-rule change can never silently leave a
 * generation schema stale. The regex is BUILT from the source, never duplicated.
 */
export const PLAN_LOCAL_ID_SOURCE = '[a-z][a-z0-9-]{0,63}';
const LOCAL_ID_PATTERN = new RegExp(`^${PLAN_LOCAL_ID_SOURCE}$`);

export const isPlanItemId = (value: string): boolean => LOCAL_ID_PATTERN.test(value);
export const isCriterionId = (value: string): boolean => LOCAL_ID_PATTERN.test(value);

/* ------------------------------------------------- the untrusted model proposal */

/** One proposed plan item — pure content; the model owns NOTHING but these fields. */
/**
 * STAGE 8C — a plan item's DECLARED professional responsibility (an optional
 * model REQUEST, the same authority class as `taskKind`): what professional
 * work the item needs. The trusted control-plane derivation resolves it through
 * the deterministic Stage 7 RoleResolver (catalog match, else dynamic spec) —
 * a request is never authority, never a role pin, and never a user choice.
 */
export interface ProfessionalResponsibilityDeclaration {
  /** Bounded statement of the professional work this item needs. */
  readonly responsibilityIntent: string;
  /** Capability tokens the responsibility needs (catalog-match inputs). */
  readonly requiredCapabilities?: readonly string[];
  /** Whether the work must be done by an independent seat (review/validation). */
  readonly independenceRequired?: boolean;
  readonly riskLevel?: 'low' | 'medium' | 'high';
}

export interface PlanningProposalItem {
  readonly planItemId: string;
  /** A bounded description of WHAT this item must achieve (never HOW to execute it). */
  readonly objective: string;
  /** Plan-local dependency refs — COMPILER INPUT ONLY, never runtime dependency truth. */
  readonly dependencyPlanItemIds?: readonly string[];
  /** Plan-local criterion refs. */
  readonly acceptanceCriterionRefs?: readonly string[];
  /**
   * OPTIONAL requested operation kind (V1 Native Production Readiness): the model may
   * propose WHICH deployment-declared kind this item executes as. A REQUEST never
   * authority — the trusted control-plane derivation validates it against the
   * deployment's closed kind set (unknown values fail closed) before compilation.
   * The taskKind grammar is the pinned taskProfile grammar (kind tokens).
   */
  readonly taskKind?: string;
  /** STAGE 8C: the declared professional responsibility (optional model request). */
  readonly professionalResponsibility?: ProfessionalResponsibilityDeclaration;
}

/** One proposed acceptance criterion — SPECIFICATION of "what counts as done", never status. */
export interface PlanningProposalCriterion {
  readonly criterionId: string;
  readonly requirement: string;
}

/** The ONLY shape a model may produce. No identity, no authority, no provenance fields. */
export interface PlanningProposal {
  readonly schema: typeof PLAN_PROPOSAL_SCHEMA;
  readonly planItems: readonly PlanningProposalItem[];
  readonly acceptanceCriteria: readonly PlanningProposalCriterion[];
}

/* --------------------------------------------------- the trusted validated plan */

/** The validated plan content (normalized, deterministic; identical input ⇒ identical value). */
export interface ValidatedPlanContent {
  readonly planItems: readonly {
    readonly planItemId: string;
    readonly objective: string;
    readonly dependencyPlanItemIds: readonly string[];
    readonly acceptanceCriterionRefs: readonly string[];
    readonly professionalResponsibility?: ProfessionalResponsibilityDeclaration;
  }[];
  readonly acceptanceCriteria: readonly {
    readonly criterionId: string;
    readonly requirement: string;
  }[];
}

/** The trusted artifact payload: validated content + the canonical source-goal reference. */
export interface PlanArtifactPayload {
  readonly schema: typeof PLAN_SCHEMA;
  /** The planning Run's own canonical run-goal artifact (validated by reference, §10/§30). */
  readonly sourceGoal: { readonly goalArtifactId: string };
  readonly planItems: ValidatedPlanContent['planItems'];
  readonly acceptanceCriteria: ValidatedPlanContent['acceptanceCriteria'];
}

/* -------------------------------------------------------- deterministic identity */

/**
 * The LOGICAL plan identity (§6): deterministic from the canonical planning scope ONLY —
 * the decision-sink / corrective-provisioner convention. It never contains model output,
 * timestamps, randomness, provider/model/artifact ids or plan content, so the same scope +
 * the same permanent command ALWAYS yield the same planId, whatever the model produced.
 */
export const planIdOf = (input: {
  readonly companyId: string;
  readonly planningRunId: string;
  readonly planningCommandId: string;
}): string =>
  `pla_${sha256Hex(
    `companyos/plan/1:${String(input.companyId)}:${String(input.planningRunId)}:${String(
      input.planningCommandId,
    )}`,
  ).slice(0, 26)}`;

/**
 * The CONTENT fingerprint (§7): sha256 over the canonical serialization of the VALIDATED
 * payload. Logical identity and content are deliberately separate: the fingerprint covers
 * only stable planning semantics — never timestamps, provider usage, latency, model or
 * response ids, or any other unstable metadata (those fields do not exist in the payload).
 */
export const planFingerprintOf = (payload: PlanArtifactPayload): string =>
  sha256Hex(canonicalJson(payload));

/** The replay/conflict comparison primitive (§7): same command + same fingerprint = replay. */
export type PlanReplayComparison =
  | { readonly kind: 'REPLAY'; readonly fingerprint: string }
  | { readonly kind: 'CONFLICT'; readonly expected: string; readonly actual: string };

export const comparePlanFingerprint = (input: {
  readonly recordedFingerprint: string;
  readonly candidateFingerprint: string;
}): PlanReplayComparison =>
  input.recordedFingerprint === input.candidateFingerprint
    ? { kind: 'REPLAY', fingerprint: input.recordedFingerprint }
    : {
        kind: 'CONFLICT',
        expected: input.recordedFingerprint,
        actual: input.candidateFingerprint,
      };

/** STAGE 8C — parse one declared professional responsibility (fail-closed, bounded). */
const parseResponsibilityDeclaration = (
  value: unknown,
  index: number,
): Result<ProfessionalResponsibilityDeclaration | undefined, DomainError> => {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) {
    return err(
      planError('PLAN_ITEM_RESPONSIBILITY_INVALID', `planItems[${String(index)}].professionalResponsibility must be an object when present.`),
    );
  }
  const intent = boundedText(
    value['responsibilityIntent'],
    300,
    'PLAN_ITEM_RESPONSIBILITY_INVALID',
    `planItems[${String(index)}].professionalResponsibility.responsibilityIntent`,
  );
  if (!intent.ok) return intent;
  const rawCapabilities = value['requiredCapabilities'];
  let capabilities: readonly string[] | undefined;
  if (rawCapabilities !== undefined) {
    if (!Array.isArray(rawCapabilities) || rawCapabilities.length > 8 || !rawCapabilities.every((entry) => typeof entry === 'string' && entry.trim() !== '' && entry.length <= 40)) {
      return err(
        planError('PLAN_ITEM_RESPONSIBILITY_INVALID', `planItems[${String(index)}].professionalResponsibility.requiredCapabilities must be up to 8 non-empty tokens.`),
      );
    }
    capabilities = [...new Set((rawCapabilities as readonly string[]).map((entry) => entry.trim()))].sort();
  }
  const rawIndependence = value['independenceRequired'];
  if (rawIndependence !== undefined && typeof rawIndependence !== 'boolean') {
    return err(
      planError('PLAN_ITEM_RESPONSIBILITY_INVALID', `planItems[${String(index)}].professionalResponsibility.independenceRequired must be a boolean when present.`),
    );
  }
  const rawRisk = value['riskLevel'];
  if (rawRisk !== undefined && (typeof rawRisk !== 'string' || !['low', 'medium', 'high'].includes(rawRisk))) {
    return err(
      planError('PLAN_ITEM_RESPONSIBILITY_INVALID', `planItems[${String(index)}].professionalResponsibility.riskLevel must be low|medium|high when present.`),
    );
  }
  const unknown = rejectUnknownKeys(value, new Set(['responsibilityIntent', 'requiredCapabilities', 'independenceRequired', 'riskLevel']), `planItems[${String(index)}].professionalResponsibility`);
  if (unknown !== null) return err(unknown);
  return ok({
    responsibilityIntent: intent.value,
    ...(capabilities === undefined ? {} : { requiredCapabilities: capabilities }),
    ...(rawIndependence === undefined ? {} : { independenceRequired: rawIndependence as boolean }),
    ...(rawRisk === undefined ? {} : { riskLevel: rawRisk as 'low' | 'medium' | 'high' }),
  } as ProfessionalResponsibilityDeclaration);
};

/* -------------------------------------------------------- strict validation core */

const PLAN_ITEM_KEYS = new Set([
  'planItemId',
  'objective',
  'dependencyPlanItemIds',
  'acceptanceCriterionRefs',
  // STAGE 8C: the model MAY declare the item's professional responsibility; the
  // trusted control-plane derivation resolves it through the RoleResolver.
  'professionalResponsibility',
  // V1 Native Production Readiness: the model MAY propose which deployment-declared
  // native operation kind an item executes as. It is a REQUEST, never authority —
  // the trusted control-plane derivation validates it against the deployment's
  // CLOSED kind set and refuses unknown values fail-closed.
  'taskKind',
]);
const CRITERION_KEYS = new Set(['criterionId', 'requirement']);
const PROPOSAL_KEYS = new Set(['schema', 'planItems', 'acceptanceCriteria']);
const PAYLOAD_KEYS = new Set(['schema', 'sourceGoal', 'planItems', 'acceptanceCriteria']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const planError = (reason: string, message: string): DomainError =>
  domainError('VALIDATION_FAILED', message, { reason });

const rejectUnknownKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): DomainError | null => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return planError(
        'PLAN_UNKNOWN_FIELD',
        `${where} carries unknown field "${key}" (unknown semantic fields fail closed).`,
      );
    }
  }
  return null;
};

const boundedText = (value: unknown, maxChars: number, reason: string, where: string): Result<string, DomainError> => {
  if (typeof value !== 'string') return err(planError(reason, `${where} must be a string.`));
  if (value.includes('\0')) return err(planError(reason, `${where} contains a NUL byte.`));
  // Nonblank rule (T20-02 corrective §8): semantic text must be nonblank — "" / "  " /
  // "\n\t" / Unicode-whitespace-only are ALL rejected. The blank check is Unicode-aware
  // (String.prototype.trim removes every Unicode WhiteSpace/LineTerminator). This is a
  // REJECTION check only: accepted text is stored and fingerprinted AS WRITTEN — there is
  // deliberately NO trim normalization, so "  implement API  " and "implement API" are two
  // DIFFERENT valid plans with different fingerprints (§9: no new semantic normalization).
  if (value.trim().length === 0) return err(planError(reason, `${where} must not be blank.`));
  if (value.length > maxChars) {
    return err(
      planError(
        reason,
        `${where} exceeds the ${String(maxChars)}-character bound (${String(value.length)}).`,
      ),
    );
  }
  return ok(value);
};

const stringArray = (
  value: unknown,
  maxCount: number,
  reason: string,
  where: string,
): Result<readonly string[], DomainError> => {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) return err(planError(reason, `${where} must be an array.`));
  if (value.length > maxCount) {
    return err(
      planError(
        reason,
        `${where} exceeds the ${String(maxCount)}-entry bound (${String(value.length)}).`,
      ),
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return err(planError(reason, `${where} entries must be strings.`));
    }
    out.push(entry);
  }
  return ok(out);
};

/** Validate ONE proposal's content strictly (§21/§24): no repair, no guessing, fail closed. */
export const validatePlanningProposal = (input: unknown): Result<ValidatedPlanContent, DomainError> => {
  if (!isRecord(input)) return err(planError('PLAN_PROPOSAL_MALFORMED', 'The proposal must be an object.'));
  const unknown = rejectUnknownKeys(input, PROPOSAL_KEYS, 'The proposal');
  if (unknown !== null) return err(unknown);
  if (input['schema'] !== PLAN_PROPOSAL_SCHEMA) {
    return err(
      planError(
        'PLAN_SCHEMA_UNSUPPORTED',
        `Unsupported planning proposal schema "${String(input['schema'])}".`,
      ),
    );
  }
  return validateContent(input['planItems'], input['acceptanceCriteria']);
};

/** Validate the TRUSTED artifact payload (same content rules + the source-goal reference). */
export const validatePlanArtifactPayload = (input: unknown): Result<PlanArtifactPayload, DomainError> => {
  if (!isRecord(input)) return err(planError('PLAN_PAYLOAD_MALFORMED', 'The plan payload must be an object.'));
  const unknown = rejectUnknownKeys(input, PAYLOAD_KEYS, 'The plan payload');
  if (unknown !== null) return err(unknown);
  if (input['schema'] !== PLAN_SCHEMA) {
    return err(
      planError('PLAN_SCHEMA_UNSUPPORTED', `Unsupported plan payload schema "${String(input['schema'])}".`),
    );
  }
  const sourceGoal = input['sourceGoal'];
  if (!isRecord(sourceGoal)) {
    return err(planError('PLAN_SOURCE_GOAL_MISSING', 'The plan payload must carry sourceGoal.'));
  }
  const goalUnknown = rejectUnknownKeys(sourceGoal, new Set(['goalArtifactId']), 'sourceGoal');
  if (goalUnknown !== null) return err(goalUnknown);
  if (typeof sourceGoal['goalArtifactId'] !== 'string' || sourceGoal['goalArtifactId'].length === 0) {
    return err(
      planError('PLAN_SOURCE_GOAL_MISSING', 'sourceGoal.goalArtifactId must be a non-empty string.'),
    );
  }
  const content = validateContent(input['planItems'], input['acceptanceCriteria']);
  if (!content.ok) return content;
  return ok({
    schema: PLAN_SCHEMA,
    sourceGoal: { goalArtifactId: sourceGoal['goalArtifactId'] },
    planItems: content.value.planItems,
    acceptanceCriteria: content.value.acceptanceCriteria,
  });
};

/** The shared strict content validation — identical for proposals and trusted payloads. */
const validateContent = (
  rawItems: unknown,
  rawCriteria: unknown,
): Result<ValidatedPlanContent, DomainError> => {
  if (!Array.isArray(rawItems)) {
    return err(planError('PLAN_ITEMS_MALFORMED', 'planItems must be an array.'));
  }
  if (rawItems.length < PLAN_LIMITS.planItemMinCount) {
    return err(planError('PLAN_ITEMS_EMPTY', 'A plan needs at least one plan item.'));
  }
  if (rawItems.length > PLAN_LIMITS.planItemMaxCount) {
    return err(
      planError(
        'PLAN_ITEM_COUNT_EXCEEDED',
        `A plan carries at most ${String(PLAN_LIMITS.planItemMaxCount)} items (${String(rawItems.length)}).`,
      ),
    );
  }
  if (!Array.isArray(rawCriteria)) {
    return err(planError('PLAN_CRITERIA_MALFORMED', 'acceptanceCriteria must be an array.'));
  }
  if (rawCriteria.length < PLAN_LIMITS.criteriaMinCount) {
    return err(planError('PLAN_CRITERIA_EMPTY', 'A plan needs at least one acceptance criterion.'));
  }
  if (rawCriteria.length > PLAN_LIMITS.criteriaMaxCount) {
    return err(
      planError(
        'PLAN_CRITERIA_COUNT_EXCEEDED',
        `A plan carries at most ${String(PLAN_LIMITS.criteriaMaxCount)} criteria (${String(rawCriteria.length)}).`,
      ),
    );
  }
  const itemIds = new Set<string>();
  const items: {
    planItemId: string;
    objective: string;
    dependencyPlanItemIds: readonly string[];
    acceptanceCriterionRefs: readonly string[];
    professionalResponsibility?: ProfessionalResponsibilityDeclaration;
  }[] = [];
  for (const [index, rawItem] of rawItems.entries()) {
    if (!isRecord(rawItem)) {
      return err(planError('PLAN_ITEM_MALFORMED', `planItems[${String(index)}] must be an object.`));
    }
    const itemUnknown = rejectUnknownKeys(rawItem, PLAN_ITEM_KEYS, `planItems[${String(index)}]`);
    if (itemUnknown !== null) return err(itemUnknown);
    const planItemId = rawItem['planItemId'];
    if (typeof planItemId !== 'string' || !isPlanItemId(planItemId)) {
      return err(
        planError(
          'PLAN_ITEM_ID_INVALID',
          `planItems[${String(index)}].planItemId must match [a-z][a-z0-9-]{0,62}.`,
        ),
      );
    }
    if (itemIds.has(planItemId)) {
      return err(planError('PLAN_ITEM_ID_DUPLICATE', `Duplicate plan item id "${planItemId}".`));
    }
    itemIds.add(planItemId);
    const objective = boundedText(
      rawItem['objective'],
      PLAN_LIMITS.objectiveMaxChars,
      'PLAN_OBJECTIVE_INVALID',
      `planItems[${String(index)}].objective`,
    );
    if (!objective.ok) return objective;
    const dependencies = stringArray(
      rawItem['dependencyPlanItemIds'],
      PLAN_LIMITS.dependencyRefsPerItemMax,
      'PLAN_DEPENDENCIES_INVALID',
      `planItems[${String(index)}].dependencyPlanItemIds`,
    );
    if (!dependencies.ok) return dependencies;
    const criterionRefs = stringArray(
      rawItem['acceptanceCriterionRefs'],
      PLAN_LIMITS.criterionRefsPerItemMax,
      'PLAN_CRITERION_REFS_INVALID',
      `planItems[${String(index)}].acceptanceCriterionRefs`,
    );
    if (!criterionRefs.ok) return criterionRefs;
    /*
     * T20-02 corrective §1/§2: EVERY executable plan item MUST reference at least one
     * acceptance criterion — a planned work item without an explicit, stable, reviewable
     * definition of completion is invalid, and missing criteria are NEVER repaired with a
     * synthetic default ("task completed" & friends do not exist anywhere). Absent and
     * empty both fail closed with the same reason.
     */
    if (criterionRefs.value.length < 1) {
      return err(
        planError(
          'PLAN_ITEM_CRITERIA_REQUIRED',
          `planItems[${String(index)}] ("${planItemId}") must reference at least one acceptance criterion.`,
        ),
      );
    }
    const rawTaskKind = rawItem['taskKind'];
    if (rawTaskKind !== undefined && (typeof rawTaskKind !== 'string' || rawTaskKind.trim() === '')) {
      return err(planError('PLAN_ITEM_TASK_KIND_INVALID', `planItems[${String(index)}].taskKind must be a non-empty kind token when present.`));
    }
    const declaration = parseResponsibilityDeclaration(rawItem['professionalResponsibility'], index);
    if (!declaration.ok) return declaration;
    items.push({
      planItemId,
      objective: objective.value,
      dependencyPlanItemIds: dependencies.value,
      acceptanceCriterionRefs: criterionRefs.value,
      ...(rawTaskKind === undefined ? {} : { taskKind: (rawTaskKind as string).trim() }),
      ...(declaration.value === undefined ? {} : { professionalResponsibility: declaration.value }),
    });
  }
  const criterionIds = new Set<string>();
  const criteria: { criterionId: string; requirement: string }[] = [];
  for (const [index, rawCriterion] of rawCriteria.entries()) {
    if (!isRecord(rawCriterion)) {
      return err(
        planError('PLAN_CRITERION_MALFORMED', `acceptanceCriteria[${String(index)}] must be an object.`),
      );
    }
    const criterionUnknown = rejectUnknownKeys(
      rawCriterion,
      CRITERION_KEYS,
      `acceptanceCriteria[${String(index)}]`,
    );
    if (criterionUnknown !== null) return err(criterionUnknown);
    const criterionId = rawCriterion['criterionId'];
    if (typeof criterionId !== 'string' || !isCriterionId(criterionId)) {
      return err(
        planError(
          'PLAN_CRITERION_ID_INVALID',
          `acceptanceCriteria[${String(index)}].criterionId must match [a-z][a-z0-9-]{0,62}.`,
        ),
      );
    }
    if (criterionIds.has(criterionId)) {
      return err(planError('PLAN_CRITERION_ID_DUPLICATE', `Duplicate criterion id "${criterionId}".`));
    }
    criterionIds.add(criterionId);
    const requirement = boundedText(
      rawCriterion['requirement'],
      PLAN_LIMITS.criterionTextMaxChars,
      'PLAN_CRITERION_TEXT_INVALID',
      `acceptanceCriteria[${String(index)}].requirement`,
    );
    if (!requirement.ok) return requirement;
    criteria.push({ criterionId, requirement: requirement.value });
  }
  // Reference validation: every ref must exist; duplicates and self-refs are refused.
  for (const item of items) {
    const seenDeps = new Set<string>();
    for (const dependency of item.dependencyPlanItemIds) {
      if (!itemIds.has(dependency)) {
        return err(
          planError(
            'PLAN_DEPENDENCY_UNKNOWN',
            `Plan item "${item.planItemId}" depends on unknown item "${dependency}".`,
          ),
        );
      }
      if (dependency === item.planItemId) {
        return err(
          planError('PLAN_DEPENDENCY_SELF', `Plan item "${item.planItemId}" depends on itself.`),
        );
      }
      if (seenDeps.has(dependency)) {
        return err(
          planError(
            'PLAN_DEPENDENCY_DUPLICATE',
            `Plan item "${item.planItemId}" declares dependency "${dependency}" twice.`,
          ),
        );
      }
      seenDeps.add(dependency);
    }
    const seenRefs = new Set<string>();
    for (const ref of item.acceptanceCriterionRefs) {
      if (!criterionIds.has(ref)) {
        return err(
          planError(
            'PLAN_CRITERION_REF_UNKNOWN',
            `Plan item "${item.planItemId}" references unknown criterion "${ref}".`,
          ),
        );
      }
      if (seenRefs.has(ref)) {
        return err(
          planError(
            'PLAN_CRITERION_REF_DUPLICATE',
            `Plan item "${item.planItemId}" references criterion "${ref}" twice.`,
          ),
        );
      }
      seenRefs.add(ref);
    }
  }
  /*
   * The frozen V1 invariant is TWO-SIDED (T20-02 corrective §3): every plan item references
   * at least one criterion (enforced at item parse time above), and every criterion is
   * referenced by at least one item (here). Sharing is ALLOWED: a criterion is an immutable
   * reusable requirement REFERENCE — many items may cite the same criterion, no criterion
   * ownership state exists, and evaluation stays task-scoped downstream (a criterion never
   * carries status; Reviewer/QA judge each Task against the cited definitions).
   */
  const referenced = new Set<string>();
  for (const item of items) {
    for (const ref of item.acceptanceCriterionRefs) referenced.add(ref);
  }
  for (const criterion of criteria) {
    if (!referenced.has(criterion.criterionId)) {
      return err(
        planError(
          'PLAN_CRITERION_UNREFERENCED',
          `Criterion "${criterion.criterionId}" is referenced by no plan item (V1 rejects unreferenced criteria).`,
        ),
      );
    }
  }
  // The dependency graph must be acyclic (iterative coloring). Multiple roots ARE allowed —
  // the existing WorkflowVersion DAG contract allows multiple entry stages.
  const dependenciesOf = new Map<string, readonly string[]>(
    items.map((item) => [item.planItemId, item.dependencyPlanItemIds]),
  );
  const iteratorOf = (id: string): Iterator<string> =>
    (dependenciesOf.get(id) ?? [])[Symbol.iterator]();
  const state = new Map<string, 0 | 1 | 2>();
  for (const root of itemIds) {
    if (state.get(root) !== undefined) continue;
    const stack: { readonly id: string; readonly iter: Iterator<string> }[] = [
      { id: root, iter: iteratorOf(root) },
    ];
    state.set(root, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const next = top.iter.next();
      if (next.done) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const dependency = next.value;
      const dependencyState = state.get(dependency);
      if (dependencyState === 1) {
        return err(
          planError('PLAN_DEPENDENCY_CYCLE', `The plan dependency graph contains a cycle at "${dependency}".`),
        );
      }
      if (dependencyState === undefined) {
        state.set(dependency, 1);
        stack.push({ id: dependency, iter: iteratorOf(dependency) });
      }
    }
  }
  return ok({ planItems: items, acceptanceCriteria: criteria });
};

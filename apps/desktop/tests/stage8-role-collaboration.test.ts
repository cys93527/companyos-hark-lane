/**
 * STAGE 8 PART A — ROLE COLLABORATION V1 targeted tests (Boss Stage 8 §A).
 *
 * Covers: the Professional Handoff Contract (closed field set, durable refs),
 * the closed failure-reason set, handoff acceptance into a bounded context
 * envelope, reviewer independence, the DERIVED collaboration projection
 * (PM not scheduler, no second truth), cross-task/company isolation, budget
 * handoff, and the two E2E proofs (software chain + non-software chain).
 */
import {describe, expect, it} from 'vitest';

import {
  COLLABORATION_ERROR_REASONS,
  FORBIDDEN_COLLABORATION_TRUTH,
  FORBIDDEN_HANDOFF_FIELDS,
  acceptHandoff,
  assertReviewerIndependence,
  buildProfessionalHandoff,
  projectRoleCollaboration,
  type DurableObjectRef,
  type ProfessionalHandoff,
} from '../src/executor/role-collaboration.js';
import {
  RoleCatalog,
  buildRoleContextEnvelope,
  createRoleInstance,
  resolveRole,
  roleExecutionBudgetExhausted,
  type ProfessionalResponsibilityRequirement,
  type RoleDefinition,
  type RoleInstance,
} from '../src/executor/role-orchestration.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROLE = (id: string, overrides: Partial<RoleDefinition> = {}): Omit<RoleDefinition, 'version'> => ({
  roleDefinitionId: id,
  displayName: id.replace(/-/g, ' '),
  professionalResponsibility: `Responsibility of ${id}`,
  responsibilityDescription: `${id} professional work`,
  requiredCapabilities: ['read', 'write'],
  preferredCapabilities: [],
  toolNeeds: ['fs'],
  contextNeeds: ['goal', 'task'],
  validationResponsibilities: [],
  independenceClass: 'implementer',
  defaultExecutionBudget: {maxTurns: 10, maxToolCalls: 30},
  packOwner: 'software-pack',
  domain: 'software',
  ...overrides,
});

const REQ = (intent: string, caps: readonly string[], overrides: Partial<ProfessionalResponsibilityRequirement> = {}): ProfessionalResponsibilityRequirement => ({
  responsibilityIntent: intent,
  requiredCapabilities: caps,
  expectedOutputKind: 'artifact',
  validationExpectation: 'validated',
  independenceRequired: false,
  riskLevel: 'low',
  ...overrides,
});

const instanceOf = (id: string, overrides: Partial<RoleDefinition> = {}, capabilities: readonly string[] = ['read', 'write']): RoleInstance => {
  const catalog = new RoleCatalog();
  catalog.register(ROLE(id, overrides));
  const spec = resolveRole(catalog, REQ(`work of ${id}`, capabilities));
  if (!spec.ok) throw new Error(`resolve failed for ${id}`);
  return createRoleInstance({roleInstanceId: `ri_${id}`, runId: 'run_s8', companyId: 'co_s8', specification: spec.value});
};

const DURABLE: readonly DurableObjectRef[] = [
  {kind: 'artifact', id: 'art_design'},
  {kind: 'artifact', id: 'art_impl'},
  {kind: 'evidence', id: 'ev_test_run'},
  {kind: 'decision', id: 'dec_schema'},
];

const HANDOFF_INPUT = {
  handoffId: 'ho_1',
  producerRoleInstanceId: 'ri_architect',
  consumerRoleInstanceId: 'ri_engineer',
  sourceTaskId: 'task_design',
  targetTaskId: 'task_impl',
  artifactRefs: ['art_design'],
  evidenceRefs: ['ev_test_run'],
  decisionRefs: ['dec_schema'],
  acceptanceCriteria: ['endpoints match the schema'],
  knownRisks: ['schema may change'],
  remainingQuestions: ['auth provider?'],
  handoffReason: 'Design is stable; implementation may begin.',
  durableObjects: DURABLE,
  sourceTaskState: 'done' as const,
};

// ---------------------------------------------------------------------------
// Professional Handoff Contract (Boss Stage 8 §A)
// ---------------------------------------------------------------------------

describe('STAGE 8 Professional Handoff Contract (Boss §A)', () => {
  it('builds a handoff carrying durable refs and professional summaries', () => {
    const result = buildProfessionalHandoff(HANDOFF_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const h = result.value;
    expect(h.producerRoleInstanceId).toBe('ri_architect');
    expect(h.consumerRoleInstanceId).toBe('ri_engineer');
    expect(h.sourceTaskId).toBe('task_design');
    expect(h.targetTaskId).toBe('task_impl');
    expect(h.artifactRefs).toEqual(['art_design']);
    expect(h.evidenceRefs).toEqual(['ev_test_run']);
    expect(h.decisionRefs).toEqual(['dec_schema']);
    expect(h.acceptanceCriteria).toEqual(['endpoints match the schema']);
    expect(h.knownRisks).toEqual(['schema may change']);
    expect(h.remainingQuestions).toEqual(['auth provider?']);
    expect(h.handoffReason).not.toBe('');
  });

  it('field set is CLOSED: no chat/message/transcript property exists on a handoff', () => {
    const result = buildProfessionalHandoff(HANDOFF_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const forbidden of [...FORBIDDEN_HANDOFF_FIELDS, 'message', 'messages', 'conversation', 'chat']) {
      expect(Object.hasOwn(result.value as unknown as Record<string, unknown>, forbidden)).toBe(false);
    }
  });

  it('HANDOFF_INPUT_MISSING on every empty required field', () => {
    for (const field of ['handoffId', 'producerRoleInstanceId', 'consumerRoleInstanceId', 'sourceTaskId', 'targetTaskId', 'handoffReason'] as const) {
      const result = buildProfessionalHandoff({...HANDOFF_INPUT, [field]: ''});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.details.reason).toBe('HANDOFF_INPUT_MISSING');
    }
  });

  it('HANDOFF_INPUT_MISSING when producer === consumer or a task hands off to itself', () => {
    const same = buildProfessionalHandoff({...HANDOFF_INPUT, consumerRoleInstanceId: 'ri_architect'});
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error.details.reason).toBe('HANDOFF_INPUT_MISSING');
    const self = buildProfessionalHandoff({...HANDOFF_INPUT, targetTaskId: 'task_design'});
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.details.reason).toBe('HANDOFF_INPUT_MISSING');
  });

  it('HANDOFF_ARTIFACT_INVALID on empty artifact list and on unresolved refs', () => {
    const empty = buildProfessionalHandoff({...HANDOFF_INPUT, artifactRefs: []});
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.details.reason).toBe('HANDOFF_ARTIFACT_INVALID');

    const unknown = buildProfessionalHandoff({...HANDOFF_INPUT, artifactRefs: ['art_ghost']});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.details.reason).toBe('HANDOFF_ARTIFACT_INVALID');

    // An artifact id registered as EVIDENCE does not satisfy an artifactRef.
    const wrongKind = buildProfessionalHandoff({...HANDOFF_INPUT, artifactRefs: ['ev_test_run']});
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.error.details.reason).toBe('HANDOFF_ARTIFACT_INVALID');
  });

  it('COLLABORATION_DEPENDENCY_BLOCKED when the source task is not done', () => {
    for (const state of ['pending', 'running', 'failed', 'blocked'] as const) {
      const result = buildProfessionalHandoff({...HANDOFF_INPUT, sourceTaskState: state});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.details.reason).toBe('COLLABORATION_DEPENDENCY_BLOCKED');
    }
  });

  it('failure reasons form the frozen closed set of six', () => {
    expect([...COLLABORATION_ERROR_REASONS]).toEqual([
      'HANDOFF_INPUT_MISSING',
      'HANDOFF_ARTIFACT_INVALID',
      'HANDOFF_AUTHORITY_MISMATCH',
      'HANDOFF_CONTEXT_BUILD_FAILED',
      'REVIEW_INDEPENDENCE_VIOLATION',
      'COLLABORATION_DEPENDENCY_BLOCKED',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Handoff acceptance → bounded context envelope
// ---------------------------------------------------------------------------

describe('STAGE 8 Handoff Acceptance (Boss §A)', () => {
  const consumer = instanceOf('engineer', {requiredCapabilities: ['read', 'write']}, ['read', 'write']);
  const accepted = buildProfessionalHandoff(HANDOFF_INPUT);
  if (!accepted.ok) throw new Error('fixture handoff failed');

  it('accepts into a bounded envelope carrying refs, criteria and NO model truth', () => {
    const envelope = acceptHandoff({
      handoff: accepted.value,
      consumerRole: consumer,
      targetTaskObjective: 'Implement the API endpoints',
      requiredOutput: 'merged endpoints',
      durableArtifacts: [{artifactId: 'art_design', summary: 'API schema v1 with 4 endpoints'}],
      taskAuthority: new Set(['read', 'write']),
      systemPolicy: new Set(['read', 'write', 'review']),
    });
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.value.relevantArtifactRefs).toEqual(['art_design']);
    expect(envelope.value.acceptanceCriteria).toEqual(['endpoints match the schema']);
    // STAGE 7B ownership: collaboration carries no selected model.
    expect(envelope.value.attemptModel).toBeNull();
    // The envelope is data refs + summaries — it structurally carries no raw transcript.
    expect(Object.hasOwn(envelope.value as unknown as Record<string, unknown>, 'rawTranscript')).toBe(false);
    expect(consumer.contextPolicy.excludeRawTranscripts).toBe(true);
  });

  it('HANDOFF_CONTEXT_BUILD_FAILED on missing objective or unreadable artifact', () => {
    const noObjective = acceptHandoff({
      handoff: accepted.value,
      consumerRole: consumer,
      targetTaskObjective: '',
      requiredOutput: 'x',
      durableArtifacts: [{artifactId: 'art_design', summary: 's'}],
      taskAuthority: new Set(['read', 'write']),
      systemPolicy: new Set(['read', 'write']),
    });
    expect(noObjective.ok).toBe(false);
    if (!noObjective.ok) expect(noObjective.error.details.reason).toBe('HANDOFF_CONTEXT_BUILD_FAILED');

    const unreadable = acceptHandoff({
      handoff: accepted.value,
      consumerRole: consumer,
      targetTaskObjective: 'Implement',
      requiredOutput: 'x',
      durableArtifacts: [],
      taskAuthority: new Set(['read', 'write']),
      systemPolicy: new Set(['read', 'write']),
    });
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.error.details.reason).toBe('HANDOFF_CONTEXT_BUILD_FAILED');
  });

  it('HANDOFF_AUTHORITY_MISMATCH when the effective authority is empty', () => {
    const mismatch = acceptHandoff({
      handoff: accepted.value,
      consumerRole: consumer,
      targetTaskObjective: 'Implement',
      requiredOutput: 'x',
      durableArtifacts: [{artifactId: 'art_design', summary: 's'}],
      taskAuthority: new Set(['review']),
      systemPolicy: new Set(['read', 'write']),
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.details.reason).toBe('HANDOFF_AUTHORITY_MISMATCH');
  });

  it('budget travels with the ROLE, not the handoff (Stage 7 budget unchanged)', () => {
    expect(roleExecutionBudgetExhausted(consumer.executionBudget, {turns: 10})).toBe(true);
    expect(roleExecutionBudgetExhausted(consumer.executionBudget, {turns: 9})).toBe(false);
    expect(consumer.executionBudget.maxToolCalls).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Reviewer independence
// ---------------------------------------------------------------------------

describe('STAGE 8 Reviewer Independence (Boss §A)', () => {
  const reviewer = instanceOf('reviewer', {requiredCapabilities: ['read', 'review'], independenceClass: 'independent-reviewer'}, ['read', 'review']);
  const handoff = buildProfessionalHandoff(HANDOFF_INPUT);
  if (!handoff.ok) throw new Error('fixture handoff failed');

  it('independent reviewer acceptance requires its own attempt', () => {
    const okRun = acceptHandoff({
      handoff: {...handoff.value, consumerRoleInstanceId: reviewer.roleInstanceId},
      consumerRole: reviewer,
      targetTaskObjective: 'Review the implementation',
      requiredOutput: 'review verdict',
      durableArtifacts: [{artifactId: 'art_design', summary: 'schema'}],
      taskAuthority: new Set(['read', 'review']),
      systemPolicy: new Set(['read', 'review']),
      producerAttemptId: 'att_engineer_1',
      consumerAttemptId: 'att_reviewer_1',
    });
    expect(okRun.ok).toBe(true);

    const sharedAttempt = acceptHandoff({
      handoff: {...handoff.value, consumerRoleInstanceId: reviewer.roleInstanceId},
      consumerRole: reviewer,
      targetTaskObjective: 'Review the implementation',
      requiredOutput: 'review verdict',
      durableArtifacts: [{artifactId: 'art_design', summary: 'schema'}],
      taskAuthority: new Set(['read', 'review']),
      systemPolicy: new Set(['read', 'review']),
      producerAttemptId: 'att_shared',
      consumerAttemptId: 'att_shared',
    });
    expect(sharedAttempt.ok).toBe(false);
    if (!sharedAttempt.ok) expect(sharedAttempt.error.details.reason).toBe('REVIEW_INDEPENDENCE_VIOLATION');

    const missingAttempts = acceptHandoff({
      handoff: {...handoff.value, consumerRoleInstanceId: reviewer.roleInstanceId},
      consumerRole: reviewer,
      targetTaskObjective: 'Review the implementation',
      requiredOutput: 'review verdict',
      durableArtifacts: [{artifactId: 'art_design', summary: 'schema'}],
      taskAuthority: new Set(['read', 'review']),
      systemPolicy: new Set(['read', 'review']),
    });
    expect(missingAttempts.ok).toBe(false);
    if (!missingAttempts.ok) expect(missingAttempts.error.details.reason).toBe('REVIEW_INDEPENDENCE_VIOLATION');
  });

  it('assertReviewerIndependence enforces separate instance and separate attempt', () => {
    expect(
      assertReviewerIndependence({
        reviewer: {roleInstanceId: 'ri_reviewer', attemptId: 'att_r', envelope: null},
        producer: {roleInstanceId: 'ri_engineer', attemptId: 'att_e'},
      }).ok,
    ).toBe(true);

    const sameRole = assertReviewerIndependence({
      reviewer: {roleInstanceId: 'ri_engineer', attemptId: 'att_r', envelope: null},
      producer: {roleInstanceId: 'ri_engineer', attemptId: 'att_e'},
    });
    expect(sameRole.ok).toBe(false);
    if (!sameRole.ok) expect(sameRole.error.details.reason).toBe('REVIEW_INDEPENDENCE_VIOLATION');

    const sameAttempt = assertReviewerIndependence({
      reviewer: {roleInstanceId: 'ri_reviewer', attemptId: 'att_x', envelope: null},
      producer: {roleInstanceId: 'ri_engineer', attemptId: 'att_x'},
    });
    expect(sameAttempt.ok).toBe(false);
  });

  it('a smuggled raw-context key in the reviewer envelope is a violation', () => {
    const producerInstance = instanceOf('engineer', {requiredCapabilities: ['read', 'write']}, ['read', 'write']);
    const smuggled = {
      ...buildRoleContextEnvelope({
        goalSummary: 'G', planItem: null, taskObjective: 'T', role: producerInstance, requiredOutput: 'out',
      }),
      chainOfThought: 'secret reasoning',
    };
    const result = assertReviewerIndependence({
      reviewer: {roleInstanceId: 'ri_reviewer', attemptId: 'att_r', envelope: smuggled},
      producer: {roleInstanceId: 'ri_engineer', attemptId: 'att_e'},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details.reason).toBe('REVIEW_INDEPENDENCE_VIOLATION');
  });
});

// ---------------------------------------------------------------------------
// Derived collaboration projection (PM not scheduler, no second truth)
// ---------------------------------------------------------------------------

describe('STAGE 8 Derived Collaboration Projection (Boss §A)', () => {
  const architect = instanceOf('architect', {requiredCapabilities: ['design', 'structured-output']}, ['design', 'structured-output']);
  const engineer = instanceOf('engineer', {requiredCapabilities: ['read', 'write']}, ['read', 'write']);
  const reviewer = instanceOf('reviewer', {requiredCapabilities: ['read', 'review'], independenceClass: 'independent-reviewer'}, ['read', 'review']);
  const coordinator = instanceOf('coordinator', {requiredCapabilities: ['read'], independenceClass: 'coordinator'}, ['read']);

  const handoffs: ProfessionalHandoff[] = [];
  const h1 = buildProfessionalHandoff({...HANDOFF_INPUT, producerRoleInstanceId: architect.roleInstanceId});
  if (h1.ok) handoffs.push(h1.value);
  const h2 = buildProfessionalHandoff({
    ...HANDOFF_INPUT,
    handoffId: 'ho_2',
    producerRoleInstanceId: engineer.roleInstanceId,
    consumerRoleInstanceId: reviewer.roleInstanceId,
    sourceTaskId: 'task_impl',
    targetTaskId: 'task_review',
    artifactRefs: ['art_impl'],
  });
  if (h2.ok) handoffs.push(h2.value);

  const tasks = [
    {taskId: 'task_design', roleInstanceId: architect.roleInstanceId, state: 'done' as const},
    {taskId: 'task_impl', roleInstanceId: engineer.roleInstanceId, state: 'running' as const},
    {taskId: 'task_review', roleInstanceId: reviewer.roleInstanceId, state: 'pending' as const},
    {taskId: 'task_plan', roleInstanceId: coordinator.roleInstanceId, state: 'pending' as const},
  ];

  it('projection derives every status from canonical task state', () => {
    const view = projectRoleCollaboration({runId: 'run_s8', roles: [architect, engineer, reviewer, coordinator], tasks, handoffs});
    expect(view.viewVersion).toBe(1);
    const byId = new Map(view.roles.map((r) => [r.roleInstanceId, r]));
    expect(byId.get(architect.roleInstanceId)!.derivedStatus).toBe('completed');
    expect(byId.get(engineer.roleInstanceId)!.derivedStatus).toBe('working');
    expect(byId.get(reviewer.roleInstanceId)!.derivedStatus).toBe('waiting');
    // The stored association lists mirror Task assignments exactly.
    expect(byId.get(architect.roleInstanceId)!.associatedTaskIds).toEqual(['task_design']);
  });

  it('pending handoffs wait on the SOURCE, never on a scheduler', () => {
    const view = projectRoleCollaboration({
      runId: 'run_s8',
      roles: [architect, engineer, reviewer, coordinator],
      tasks: [
        {taskId: 'task_design', roleInstanceId: architect.roleInstanceId, state: 'running' as const},
        {taskId: 'task_impl', roleInstanceId: engineer.roleInstanceId, state: 'pending' as const},
        {taskId: 'task_review', roleInstanceId: reviewer.roleInstanceId, state: 'pending' as const},
        {taskId: 'task_plan', roleInstanceId: coordinator.roleInstanceId, state: 'pending' as const},
      ],
      handoffs,
    });
    expect(view.pendingHandoffs.map((p) => p.waitingOn)).toEqual(['source-not-done', 'source-not-done']);
    // No scheduling decision field exists anywhere on the projection.
    for (const pending of view.pendingHandoffs) {
      expect(Object.hasOwn(pending as unknown as Record<string, unknown>, 'scheduledAt')).toBe(false);
      expect(Object.hasOwn(pending as unknown as Record<string, unknown>, 'assignedBy')).toBe(false);
    }
  });

  it('PM/coordinator coordinates handoffs but owns no truth of its own', async () => {
    const module = await import('../src/executor/role-collaboration.js');
    const exported = Object.keys(module);
    // No store/mutator/scheduler API exists — collaboration is build + project only.
    for (const forbidden of ['saveHandoff', 'updateHandoff', 'deleteHandoff', 'scheduleTask', 'assignTask', 'sendMessage', 'roleMessages', ...FORBIDDEN_COLLABORATION_TRUTH]) {
      expect(exported).not.toContain(forbidden);
    }
    // The coordinator appears in the projection exactly like any other role.
    const view = projectRoleCollaboration({runId: 'run_s8', roles: [architect, engineer, reviewer, coordinator], tasks, handoffs});
    const coordinatorView = view.roles.find((r) => r.roleInstanceId === coordinator.roleInstanceId)!;
    expect(coordinatorView.derivedStatus).toBe('waiting');
    expect(coordinatorView.independenceClass).toBe('coordinator');
  });

  it('projection is read-only: mutating the input tasks does not change stored status', () => {
    const mutableTasks = tasks.map((t) => ({...t}));
    const before = projectRoleCollaboration({runId: 'run_s8', roles: [engineer], tasks: mutableTasks, handoffs: []});
    mutableTasks[1]!.state = 'done';
    const after = projectRoleCollaboration({runId: 'run_s8', roles: [engineer], tasks: mutableTasks, handoffs: []});
    expect(before.roles[0]!.derivedStatus).toBe('working');
    expect(after.roles[0]!.derivedStatus).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('STAGE 8 Collaboration Isolation (Boss §A)', () => {
  it('cross-company artifacts are not resolvable durable objects', () => {
    const foreign = buildProfessionalHandoff({
      ...HANDOFF_INPUT,
      artifactRefs: ['art_other_company'],
      durableObjects: [{kind: 'artifact', id: 'art_own_company'}],
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.details.reason).toBe('HANDOFF_ARTIFACT_INVALID');
  });

  it('cross-task isolation: a handoff names exactly one source and one target task', () => {
    const result = buildProfessionalHandoff(HANDOFF_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceTaskId).toBe('task_design');
      expect(result.value.targetTaskId).toBe('task_impl');
      expect(Object.keys(result.value).filter((k) => k.endsWith('TaskId')).length).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// E2E Proof A — software chain Architect → Engineer → Reviewer (Boss §A)
// ---------------------------------------------------------------------------

describe('STAGE 8 E2E A — Software Collaboration Chain', () => {
  it('design → implementation → review chain with per-step handoffs and independent reviewer', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('architect', {requiredCapabilities: ['design', 'structured-output'], independenceClass: 'analyst'}));
    catalog.register(ROLE('engineer', {requiredCapabilities: ['tool-calling', 'structured-output']}));
    catalog.register(ROLE('reviewer', {requiredCapabilities: ['read', 'review'], independenceClass: 'independent-reviewer'}));

    const architectSpec = resolveRole(catalog, REQ('Design the API schema', ['design', 'structured-output']));
    const engineerSpec = resolveRole(catalog, REQ('Implement the API endpoints', ['tool-calling', 'structured-output']));
    const reviewerSpec = resolveRole(catalog, REQ('Independently review the implementation', ['read', 'review'], {independenceRequired: true}));
    expect(architectSpec.ok && engineerSpec.ok && reviewerSpec.ok).toBe(true);
    if (!architectSpec.ok || !engineerSpec.ok || !reviewerSpec.ok) return;

    const architect = createRoleInstance({roleInstanceId: 'ri_arch', runId: 'run_e2e', companyId: 'co_e2e', specification: architectSpec.value});
    const engineer = createRoleInstance({roleInstanceId: 'ri_eng', runId: 'run_e2e', companyId: 'co_e2e', specification: engineerSpec.value});
    const reviewer = createRoleInstance({roleInstanceId: 'ri_rev', runId: 'run_e2e', companyId: 'co_e2e', specification: reviewerSpec.value});

    const durable: DurableObjectRef[] = [
      {kind: 'artifact', id: 'art_schema'},
      {kind: 'artifact', id: 'art_impl'},
      {kind: 'evidence', id: 'ev_ci'},
      {kind: 'decision', id: 'dec_stack'},
    ];

    // Step 1: architect finishes design → handoff to engineer.
    const h1 = buildProfessionalHandoff({
      handoffId: 'ho_e2e_1',
      producerRoleInstanceId: architect.roleInstanceId,
      consumerRoleInstanceId: engineer.roleInstanceId,
      sourceTaskId: 'task_design', targetTaskId: 'task_impl',
      artifactRefs: ['art_schema'], decisionRefs: ['dec_stack'],
      handoffReason: 'Schema frozen; implementation may begin.',
      durableObjects: durable, sourceTaskState: 'done',
    });
    expect(h1.ok).toBe(true);
    if (!h1.ok) return;

    // Step 2: engineer accepts and works; the attempt model is NOT carried by the handoff.
    const engineerEnvelope = acceptHandoff({
      handoff: h1.value,
      consumerRole: engineer,
      targetTaskObjective: 'Implement the API endpoints',
      requiredOutput: 'merged endpoints',
      durableArtifacts: [{artifactId: 'art_schema', summary: 'schema v1'}],
      decisions: [{summary: 'use existing auth stack'}],
      taskAuthority: new Set(['tool-calling', 'structured-output', 'read', 'write']),
      systemPolicy: new Set(['tool-calling', 'structured-output', 'read', 'write']),
    });
    expect(engineerEnvelope.ok).toBe(true);

    // Step 3: engineer finishes → handoff to the independent reviewer.
    const h2 = buildProfessionalHandoff({
      handoffId: 'ho_e2e_2',
      producerRoleInstanceId: engineer.roleInstanceId,
      consumerRoleInstanceId: reviewer.roleInstanceId,
      sourceTaskId: 'task_impl', targetTaskId: 'task_review',
      artifactRefs: ['art_impl'], evidenceRefs: ['ev_ci'],
      acceptanceCriteria: ['no security boundary regressions'],
      handoffReason: 'Implementation complete; independent review required.',
      durableObjects: durable, sourceTaskState: 'done',
    });
    expect(h2.ok).toBe(true);
    if (!h2.ok) return;

    const reviewerEnvelope = acceptHandoff({
      handoff: h2.value,
      consumerRole: reviewer,
      targetTaskObjective: 'Independently review the implementation',
      requiredOutput: 'review verdict',
      durableArtifacts: [{artifactId: 'art_impl', summary: 'endpoints + tests'}],
      taskAuthority: new Set(['read', 'review']),
      systemPolicy: new Set(['read', 'review']),
      producerAttemptId: 'att_eng_1',
      consumerAttemptId: 'att_rev_1',
    });
    expect(reviewerEnvelope.ok).toBe(true);
    if (!reviewerEnvelope.ok) return;
    // The reviewer sees refs and criteria — never the engineer's transcript.
    expect(reviewerEnvelope.value.relevantArtifactRefs).toEqual(['art_impl']);
    expect(JSON.stringify(reviewerEnvelope.value)).not.toContain('chainOfThought');
  });
});

// ---------------------------------------------------------------------------
// E2E Proof B — non-software chain (Boss §A)
// ---------------------------------------------------------------------------

describe('STAGE 8 E2E B — Non-Software Collaboration Chain', () => {
  it('researcher → analyst → legal reviewer chain with no software vocabulary', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('researcher', {requiredCapabilities: ['read', 'research'], packOwner: 'research-pack', domain: 'research'}));
    catalog.register(ROLE('analyst', {requiredCapabilities: ['read', 'structured-output'], packOwner: 'research-pack', domain: 'research', independenceClass: 'analyst'}));
    catalog.register(ROLE('contract-reviewer', {requiredCapabilities: ['read', 'review'], packOwner: 'legal-pack', domain: 'legal', independenceClass: 'independent-reviewer'}));

    const researcherSpec = resolveRole(catalog, REQ('Collect market pricing evidence', ['read', 'research']));
    const analystSpec = resolveRole(catalog, REQ('Analyze findings', ['read', 'structured-output']));
    const reviewerSpec = resolveRole(catalog, REQ('Review the report', ['read', 'review'], {independenceRequired: true}));
    if (!researcherSpec.ok || !analystSpec.ok || !reviewerSpec.ok) throw new Error('resolve failed');

    const researcher = createRoleInstance({roleInstanceId: 'ri_res', runId: 'run_ns', companyId: 'co_ns', specification: researcherSpec.value});
    const analyst = createRoleInstance({roleInstanceId: 'ri_ana', runId: 'run_ns', companyId: 'co_ns', specification: analystSpec.value});
    const reviewer = createRoleInstance({roleInstanceId: 'ri_rev', runId: 'run_ns', companyId: 'co_ns', specification: reviewerSpec.value});

    const durable: DurableObjectRef[] = [
      {kind: 'artifact', id: 'art_evidence'},
      {kind: 'artifact', id: 'art_report'},
      {kind: 'evidence', id: 'ev_sources'},
    ];

    const h1 = buildProfessionalHandoff({
      handoffId: 'ho_ns_1',
      producerRoleInstanceId: researcher.roleInstanceId,
      consumerRoleInstanceId: analyst.roleInstanceId,
      sourceTaskId: 'task_collect', targetTaskId: 'task_analyze',
      artifactRefs: ['art_evidence'], evidenceRefs: ['ev_sources'],
      handoffReason: 'Evidence set is complete; analysis may begin.',
      durableObjects: durable, sourceTaskState: 'done',
    });
    expect(h1.ok).toBe(true);
    if (!h1.ok) return;

    const analystEnvelope = acceptHandoff({
      handoff: h1.value,
      consumerRole: analyst,
      targetTaskObjective: 'Analyze findings and produce the comparison report',
      requiredOutput: 'comparison report',
      durableArtifacts: [{artifactId: 'art_evidence', summary: '12 sources summarized'}],
      taskAuthority: new Set(['read', 'structured-output']),
      systemPolicy: new Set(['read', 'structured-output']),
    });
    expect(analystEnvelope.ok).toBe(true);

    const h2 = buildProfessionalHandoff({
      handoffId: 'ho_ns_2',
      producerRoleInstanceId: analyst.roleInstanceId,
      consumerRoleInstanceId: reviewer.roleInstanceId,
      sourceTaskId: 'task_analyze', targetTaskId: 'task_review',
      artifactRefs: ['art_report'],
      handoffReason: 'Report drafted; independent review required.',
      durableObjects: durable, sourceTaskState: 'done',
    });
    expect(h2.ok).toBe(true);
    if (!h2.ok) return;

    const view = projectRoleCollaboration({
      runId: 'run_ns',
      roles: [researcher, analyst, reviewer],
      tasks: [
        {taskId: 'task_collect', roleInstanceId: researcher.roleInstanceId, state: 'done'},
        {taskId: 'task_analyze', roleInstanceId: analyst.roleInstanceId, state: 'running'},
        {taskId: 'task_review', roleInstanceId: reviewer.roleInstanceId, state: 'pending'},
      ],
      handoffs: [h1.value, h2.value],
    });
    expect(view.pendingHandoffs.length).toBe(1);
    // The analysis task is still running, so the review handoff waits on its SOURCE.
    expect(view.pendingHandoffs[0]!.waitingOn).toBe('source-not-done');
    const names = view.roles.map((r) => r.displayName).join(' ');
    expect(names).not.toContain('engineer');
    expect(names).not.toContain('build');
  });
});

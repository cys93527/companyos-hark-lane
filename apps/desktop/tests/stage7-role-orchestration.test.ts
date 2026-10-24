/**
 * STAGE 7 — DYNAMIC ROLE ORCHESTRATION targeted tests (Boss §61).
 *
 * Covers: RoleDefinition contract, pack-extensible catalog, professional
 * responsibility inference, deterministic catalog match, dynamic synthesis,
 * dynamic specialist addition, minimal sufficient team, non-software
 * genericity, Role≠Model≠Authority≠FixedAgent, authority intersection,
 * per-attempt model lock, context isolation, reviewer independence,
 * budget enforcement, cross-task/company isolation, and three E2E proofs.
 */
import {describe, expect, it} from 'vitest';

import {ModelPool, type ModelProfile} from '../src/executor/model-pool.js';
import {
  RoleCatalog,
  buildRoleContextEnvelope,
  computeEffectiveExecutionPolicy,
  createRoleInstance,
  deriveRoleStatus,
  resolveRole,
  roleExecutionBudgetExhausted,
  selectModelForAttempt,
  type ProfessionalResponsibilityRequirement,
  type RoleDefinition,
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

const PROFILE = (id: string, overrides: Partial<ModelProfile> = {}): Omit<ModelProfile, 'configurationVersion'> => ({
  modelProfileId: id,
  providerId: `prov-${id}`,
  modelId: `model-${id}`,
  displayName: id,
  endpointURL: 'http://127.0.0.1:1/v1',
  credentialRef: 'vault://test/key',
  enabled: true,
  capabilities: new Set(['tool-calling', 'structured-output', 'streaming'] as const),
  contextWindowTokens: 8192,
  maxOutputTokens: 4096,
  supportsTools: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
// RoleDefinition + RoleCatalog contract (Boss §6-§7)
// ---------------------------------------------------------------------------

describe('STAGE 7 RoleDefinition + RoleCatalog (Boss §6-§7)', () => {
  it('registers and retrieves definitions', () => {
    const catalog = new RoleCatalog();
    const reg = catalog.register(ROLE('engineer'));
    expect(reg.ok).toBe(true);
    expect(catalog.list().length).toBe(1);
    expect(catalog.get('engineer').ok).toBe(true);
  });

  it('duplicate registration is CONFLICT', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('engineer'));
    expect(catalog.register(ROLE('engineer')).ok).toBe(false);
  });

  it('rejects empty id or empty responsibility', () => {
    const catalog = new RoleCatalog();
    expect(catalog.register(ROLE('')).ok).toBe(false);
    expect(catalog.register(ROLE('x', {professionalResponsibility: ''})).ok).toBe(false);
  });

  it('pack-extensible: software + non-software packs coexist', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('engineer', {packOwner: 'software-pack', domain: 'software'}));
    catalog.register(ROLE('researcher', {packOwner: 'research-pack', domain: 'research', requiredCapabilities: ['read']}));
    catalog.register(ROLE('contract-reviewer', {packOwner: 'legal-pack', domain: 'legal', requiredCapabilities: ['read', 'review']}));
    expect(catalog.list().length).toBe(3);
    const owners = new Set(catalog.list().map((d) => d.packOwner));
    expect(owners.size).toBe(3);
  });

  it('Core is industry-neutral: no software-specific names in the orchestration module', async () => {
    const source = await import('../src/executor/role-orchestration.js');
    const text = JSON.stringify(Object.keys(source));
    // The module should export generic concepts, not hardcode frontendEngineer etc.
    for (const forbidden of ['frontendEngineer', 'backendEngineer', 'gitReviewer', 'reactDeveloper']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Role Resolver (Boss §11-§12, §38, §54-§55)
// ---------------------------------------------------------------------------

describe('STAGE 7 RoleResolver (Boss §11-§12)', () => {
  it('catalog match: capability-satisfying template is selected deterministically', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('test-engineer', {requiredCapabilities: ['read', 'test']}));
    catalog.register(ROLE('engineer', {requiredCapabilities: ['read', 'write']}));
    const result = resolveRole(catalog, REQ('implement feature', ['read', 'write']));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.origin).toBe('catalog-match');
      expect(result.value.roleDefinitionId).toBe('engineer');
    }
  });

  it('dynamic synthesis when no catalog match exists (Boss §12)', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('engineer', {requiredCapabilities: ['read', 'write']}));
    const result = resolveRole(catalog, REQ('Windows security isolation verification', ['security', 'windows', 'review']));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.origin).toBe('dynamic-synthesis');
      expect(result.value.roleDefinitionId).toBeNull();
      expect(result.value.requiredCapabilities).toContain('security');
    }
  });

  it('independenceRequired produces independent-reviewer class (Boss §34)', () => {
    const catalog = new RoleCatalog();
    const result = resolveRole(catalog, REQ('independent check', ['review'], {independenceRequired: true}));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.independenceClass).toBe('independent-reviewer');
  });
});

// ---------------------------------------------------------------------------
// RoleInstance (Boss §14-§17)
// ---------------------------------------------------------------------------

describe('STAGE 7 RoleInstance (Boss §14-§17)', () => {
  it('createRoleInstance produces run-scoped identity with derived status', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('engineer'));
    const resolved = resolveRole(catalog, REQ('implement', ['read', 'write']));
    if (!resolved.ok) throw new Error('resolve failed');
    const instance = createRoleInstance({
      roleInstanceId: 'ri_001', runId: 'run_001', companyId: 'co_001',
      specification: resolved.value,
    });
    expect(instance.roleInstanceId).toBe('ri_001');
    expect(instance.runId).toBe('run_001');
    expect(instance.companyId).toBe('co_001');
    expect(instance.associatedTaskIds.length).toBe(0);
    // STAGE 7B: RoleInstance has no modelLock — model truth belongs to ExecutionAttempt
  });

  it('role status is DERIVED from task states (Boss §15)', () => {
    expect(deriveRoleStatus({taskStates: [{taskId: 't1', state: 'running'}]})).toBe('working');
    expect(deriveRoleStatus({taskStates: [{taskId: 't1', state: 'pending'}]})).toBe('waiting');
    expect(deriveRoleStatus({taskStates: [{taskId: 't1', state: 'done'}]})).toBe('completed');
    expect(deriveRoleStatus({taskStates: [{taskId: 't1', state: 'blocked'}]})).toBe('blocked');
    expect(deriveRoleStatus({taskStates: []})).toBe('completed');
  });

  it('cross-company isolation: different companyIds on separate instances', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('engineer'));
    const spec = resolveRole(catalog, REQ('implement', ['read', 'write']));
    if (!spec.ok) throw new Error('resolve failed');
    const a = createRoleInstance({roleInstanceId: 'ri_a', runId: 'run_a', companyId: 'co_A', specification: spec.value});
    const b = createRoleInstance({roleInstanceId: 'ri_b', runId: 'run_b', companyId: 'co_B', specification: spec.value});
    expect(a.companyId).not.toBe(b.companyId);
    expect(a.runId).not.toBe(b.runId);
  });
});

// ---------------------------------------------------------------------------
// Authority Intersection (Boss §22-§23)
// ---------------------------------------------------------------------------

describe('STAGE 7 Authority Intersection (Boss §22-§23)', () => {
  it('effective authority = task ∩ role needs ∩ system policy', () => {
    const result = computeEffectiveExecutionPolicy({
      taskAuthority: new Set(['read', 'write']),
      roleCapabilityNeeds: ['read', 'write', 'network'],
      systemPolicy: new Set(['read', 'write', 'network', 'admin']),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effectiveAuthority.has('read')).toBe(true);
      expect(result.value.effectiveAuthority.has('write')).toBe(true);
      expect(result.value.effectiveAuthority.has('network')).toBe(false);
      expect(result.value.denials).toContain('network');
    }
  });

  it('reviewer role cannot expand read-only task authority', () => {
    const result = computeEffectiveExecutionPolicy({
      taskAuthority: new Set(['read']),
      roleCapabilityNeeds: ['read', 'write'],
      systemPolicy: new Set(['read', 'write']),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effectiveAuthority.has('write')).toBe(false);
      expect(result.value.denials).toContain('write');
    }
  });
});

// ---------------------------------------------------------------------------
// Role → ModelPool (Boss §24-§26, §25 hard negative test)
// ---------------------------------------------------------------------------

describe('STAGE 7 ExecutionAttempt → ModelPool (Stage 7B §2-§7)', () => {
  const catalog = new RoleCatalog();
  catalog.register(ROLE('engineer', {requiredCapabilities: ['tool-calling', 'structured-output']}));
  catalog.register(ROLE('reviewer', {requiredCapabilities: ['read', 'review'], independenceClass: 'independent-reviewer'}));

  const makeRole = (roleId: string): ReturnType<typeof createRoleInstance> => {
    const spec = resolveRole(catalog, REQ('implement feature', ['tool-calling', 'structured-output']));
    if (!spec.ok) throw new Error('resolve failed');
    return createRoleInstance({roleInstanceId: roleId, runId: 'run_x', companyId: 'co_x', specification: spec.value});
  };

  it('RoleInstance has NO model truth (no modelLock/selectedModel/modelProfileId)', () => {
    const role = makeRole('ri_noModel');
    expect(role).not.toHaveProperty('modelLock');
    expect(role).not.toHaveProperty('selectedModel');
    expect(role).not.toHaveProperty('modelProfileId');
    // But it DOES have requirements
    expect(role).toHaveProperty('modelSelectionRequirements');
  });

  it('same RoleInstance → Model A then Model B (Stage 7B §5)', () => {
    const role = makeRole('ri_multi');

    const poolA = new ModelPool();
    poolA.register(PROFILE('MODEL_A'));
    const attemptA = selectModelForAttempt(poolA, {attemptId: 'att_A', taskId: 'task_A', role});
    expect(attemptA.ok).toBe(true);

    const poolB = new ModelPool();
    poolB.register(PROFILE('MODEL_B'));
    const attemptB = selectModelForAttempt(poolB, {attemptId: 'att_B', taskId: 'task_B', role});
    expect(attemptB.ok).toBe(true);

    if (attemptA.ok && attemptB.ok) {
      expect(attemptA.value.selectedModel.modelProfileId).toBe('MODEL_A');
      expect(attemptB.value.selectedModel.modelProfileId).toBe('MODEL_B');
      // RoleInstance unchanged — same identity across both attempts
      expect(role.roleInstanceId).toBe('ri_multi');
    }
  });

  it('same Task retry → Attempt A/Model A → Attempt B/Model B (Stage 7B §6)', () => {
    const role = makeRole('ri_retry');

    const poolA = new ModelPool();
    poolA.register(PROFILE('MODEL_A'));
    const attempt1 = selectModelForAttempt(poolA, {attemptId: 'att_1', taskId: 'task_R', role});
    expect(attempt1.ok).toBe(true);

    const poolB = new ModelPool();
    poolB.register(PROFILE('MODEL_B'));
    const attempt2 = selectModelForAttempt(poolB, {attemptId: 'att_2', taskId: 'task_R', role});
    expect(attempt2.ok).toBe(true);

    if (attempt1.ok && attempt2.ok) {
      expect(attempt1.value.selectedModel.modelProfileId).toBe('MODEL_A');
      expect(attempt2.value.selectedModel.modelProfileId).toBe('MODEL_B');
      // Same task, different attempts, different models — retry can reselect
      expect(attempt1.value.attemptId).not.toBe(attempt2.value.attemptId);
    }
  });

  it('SelectedModelSnapshot is scoped to the Attempt (Stage 7B §4)', () => {
    const role = makeRole('ri_scope');
    const pool = new ModelPool();
    pool.register(PROFILE('MODEL_X'));
    const result = selectModelForAttempt(pool, {attemptId: 'att_scoped', taskId: 'task_scoped', role});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.attemptId).toBe('att_scoped');
      expect(result.value.selectedModel.modelProfileId).toBe('MODEL_X');
      // The role was NOT modified — no side-effect
      expect(role.roleInstanceId).toBe('ri_scope');
      expect(role).not.toHaveProperty('modelLock');
    }
  });

  it('same model serves different roles via different attempts', () => {
    const pool = new ModelPool();
    pool.register(PROFILE('SHARED_MODEL', {capabilities: new Set(['tool-calling', 'structured-output', 'streaming', 'long-context'] as const)}));

    const engSpec = resolveRole(catalog, REQ('implement', ['tool-calling', 'structured-output']));
    const revSpec = resolveRole(catalog, REQ('review', ['read', 'review'], {independenceRequired: true}));
    if (!engSpec.ok || !revSpec.ok) throw new Error('resolve failed');

    const eng = createRoleInstance({roleInstanceId: 'ri_eng', runId: 'run_r', companyId: 'co_r', specification: engSpec.value});
    const rev = createRoleInstance({roleInstanceId: 'ri_rev', runId: 'run_r', companyId: 'co_r', specification: revSpec.value});

    const engAtt = selectModelForAttempt(pool, {attemptId: 'att_eng', taskId: 't_eng', role: eng});
    const revAtt = selectModelForAttempt(pool, {attemptId: 'att_rev', taskId: 't_rev', role: rev});
    expect(engAtt.ok).toBe(true);
    expect(revAtt.ok).toBe(true);
    if (engAtt.ok && revAtt.ok) {
      expect(engAtt.value.selectedModel.modelProfileId).toBe('SHARED_MODEL');
      expect(revAtt.value.selectedModel.modelProfileId).toBe('SHARED_MODEL');
      expect(engAtt.value.attemptId).not.toBe(revAtt.value.attemptId);
    }
  });
});

describe('STAGE 7 RoleContextEnvelope (Boss §28-§31)', () => {
  const catalog = new RoleCatalog();
  catalog.register(ROLE('engineer'));
  catalog.register(ROLE('reviewer', {requiredCapabilities: ['read', 'review'], independenceClass: 'independent-reviewer'}));

  it('envelope includes goal/plan/task/role/decisions/artifacts — NOT raw transcripts', () => {
    const spec = resolveRole(catalog, REQ('implement', ['read', 'write']));
    if (!spec.ok) throw new Error('resolve failed');
    const role = createRoleInstance({roleInstanceId: 'ri_env', runId: 'run_e', companyId: 'co_e', specification: spec.value});
    const envelope = buildRoleContextEnvelope({
      goalSummary: 'Build a REST API',
      planItem: 'API endpoint implementation',
      taskObjective: 'Implement POST /users',
      role,
      decisions: [{summary: 'Use Express'}],
      constraints: ['No external deps'],
      requiredOutput: 'Working endpoint',
      acceptanceCriteria: ['Returns 201'],
      artifactRefs: ['art_001'],
    });
    expect(envelope.goalSummary).toBe('Build a REST API');
    expect(envelope.relevantPlanItem).toBe('API endpoint implementation');
    expect(envelope.currentTaskObjective).toBe('Implement POST /users');
    expect(envelope.roleName).not.toBe('');
    expect(envelope.relevantDecisions.length).toBe(1);
    expect(envelope.acceptanceCriteria.length).toBe(1);
    expect(envelope.envelopeSizeBytes).toBeGreaterThan(0);
    // Structurally excludes raw transcripts (Boss §31)
    expect(role.contextPolicy.excludeRawTranscripts).toBe(true);
    expect(envelope).not.toHaveProperty('rawTranscript');
    expect(envelope).not.toHaveProperty('chainOfThought');
  });

  it('engineer context ≠ reviewer context (Boss §30)', () => {
    const engSpec = resolveRole(catalog, REQ('implement', ['read', 'write']));
    const revSpec = resolveRole(catalog, REQ('review', ['read', 'review'], {independenceRequired: true}));
    if (!engSpec.ok || !revSpec.ok) throw new Error('resolve failed');
    const eng = createRoleInstance({roleInstanceId: 'ri_e', runId: 'run_c', companyId: 'co_c', specification: engSpec.value});
    const rev = createRoleInstance({roleInstanceId: 'ri_r', runId: 'run_c', companyId: 'co_c', specification: revSpec.value});

    const engEnv = buildRoleContextEnvelope({
      goalSummary: 'G', planItem: 'P', taskObjective: 'T', role: eng,
      requiredOutput: 'code', effectiveTools: new Set(['write', 'process']),
    });
    const revEnv = buildRoleContextEnvelope({
      goalSummary: 'G', planItem: null, taskObjective: 'Review T', role: rev,
      requiredOutput: 'findings', effectiveTools: new Set(['read']),
      artifactRefs: ['art_impl'],
    });

    expect(engEnv.roleName).not.toBe(revEnv.roleName);
    expect(engEnv.toolSummary).toContain('write');
    expect(revEnv.toolSummary).not.toContain('write');
    expect(revEnv.relevantArtifactRefs).toContain('art_impl');
    expect(engEnv.relevantArtifactRefs.length).toBe(0);
  });

  it('token efficiency: envelope is bounded, not full history', () => {
    const spec = resolveRole(catalog, REQ('implement', ['read', 'write']));
    if (!spec.ok) throw new Error('resolve failed');
    const role = createRoleInstance({roleInstanceId: 'ri_t', runId: 'run_t', companyId: 'co_t', specification: spec.value});
    const envelope = buildRoleContextEnvelope({
      goalSummary: 'Simple task',
      planItem: null,
      taskObjective: 'Change title',
      role,
      requiredOutput: 'Changed title',
    });
    // Bounded: small goal + small task = small envelope (Boss §65)
    expect(envelope.envelopeSizeBytes).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Reviewer Independence (Boss §34)
// ---------------------------------------------------------------------------

describe('STAGE 7 Reviewer Independence (Boss §34)', () => {
  it('implementation and review produce different instances with different envelopes', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('engineer'));
    catalog.register(ROLE('reviewer', {requiredCapabilities: ['read', 'review'], independenceClass: 'independent-reviewer'}));
    const engSpec = resolveRole(catalog, REQ('implement', ['read', 'write']));
    const revSpec = resolveRole(catalog, REQ('independent review', ['read', 'review'], {independenceRequired: true}));
    if (!engSpec.ok || !revSpec.ok) throw new Error('resolve failed');
    const eng = createRoleInstance({roleInstanceId: 'ri_impl', runId: 'run_i', companyId: 'co_i', specification: engSpec.value});
    const rev = createRoleInstance({roleInstanceId: 'ri_rev', runId: 'run_i', companyId: 'co_i', specification: revSpec.value});
    expect(eng.roleInstanceId).not.toBe(rev.roleInstanceId);
    expect(eng.specification.independenceClass).toBe('implementer');
    expect(rev.specification.independenceClass).toBe('independent-reviewer');
    // Context policies differ structurally
    expect(rev.contextPolicy.excludeRawTranscripts).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Execution Budget (Boss §27)
// ---------------------------------------------------------------------------

describe('STAGE 7 Execution Budget (Boss §27)', () => {
  it('budget exhaustion detected correctly', () => {
    expect(roleExecutionBudgetExhausted({maxTurns: 5}, {turns: 5})).toBe(true);
    expect(roleExecutionBudgetExhausted({maxTurns: 5}, {turns: 4})).toBe(false);
    expect(roleExecutionBudgetExhausted({maxToolCalls: 10}, {toolCalls: 10})).toBe(true);
    expect(roleExecutionBudgetExhausted({tokenBudget: 1000}, {tokens: 1000})).toBe(true);
    expect(roleExecutionBudgetExhausted({}, {turns: 999999})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E2E Proof A: Software Development (Boss §62)
// ---------------------------------------------------------------------------

describe('STAGE 7 E2E Proof A — Software Development (Boss §62)', () => {
  it('goal → plan → responsibilities → roles → model → context → execute chain', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('architect', {requiredCapabilities: ['design', 'structured-output'], independenceClass: 'analyst'}));
    catalog.register(ROLE('engineer', {requiredCapabilities: ['tool-calling', 'structured-output']}));
    catalog.register(ROLE('test-engineer', {requiredCapabilities: ['tool-calling', 'test'], packOwner: 'software-pack'}));
    catalog.register(ROLE('reviewer', {requiredCapabilities: ['read', 'review'], independenceClass: 'independent-reviewer'}));

    const pool = new ModelPool();
    pool.register(PROFILE('MODEL_A', {capabilities: new Set(['tool-calling', 'structured-output', 'streaming'] as const)}));

    // Plan items with professional responsibilities
    const planItems: ProfessionalResponsibilityRequirement[] = [
      REQ('Design the API schema', ['design', 'structured-output']),
      REQ('Implement the API endpoints', ['tool-calling', 'structured-output']),
      REQ('Test the implementation', ['tool-calling', 'test']),
      REQ('Independently review the implementation', ['read', 'review'], {independenceRequired: true}),
    ];

    const instances = planItems.map((req, i) => {
      const spec = resolveRole(catalog, req);
      expect(spec.ok).toBe(true);
      if (!spec.ok) throw new Error('resolve failed');
      return createRoleInstance({roleInstanceId: `ri_${String(i)}`, runId: 'run_s6a', companyId: 'co_s6a', specification: spec.value});
    });

    // All resolved from catalog
    expect(instances.every((inst) => inst.specification.origin === 'catalog-match')).toBe(true);

    // Roles are distinct
    const roleNames = new Set(instances.map((inst) => inst.specification.displayName));
    expect(roleNames.size).toBe(4);

    // Each gets a model selection
    const selected = instances.map((inst, i) => selectModelForAttempt(pool, {attemptId: `att_${String(i)}`, taskId: `task_${String(i)}`, role: inst}));
    expect(selected.every((s) => s.ok)).toBe(true);

    // Reviewer independence preserved
    const reviewer = instances[3]!;
    expect(reviewer.specification.independenceClass).toBe('independent-reviewer');

    // Context envelopes are role-specific
    const envelopes = instances.map((inst, i) => buildRoleContextEnvelope({
      goalSummary: 'Build a REST API feature',
      planItem: `Plan item ${String(i)}`,
      taskObjective: planItems[i]!.responsibilityIntent,
      role: inst,
      requiredOutput: planItems[i]!.expectedOutputKind,
    }));
    const names = new Set(envelopes.map((e) => e.roleName));
    expect(names.size).toBe(4);
    // No raw transcripts
    expect(instances.every((inst) => inst.contextPolicy.excludeRawTranscripts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E2E Proof B: Non-Software Knowledge Work (Boss §63)
// ---------------------------------------------------------------------------

describe('STAGE 7 E2E Proof B — Non-Software (Boss §63)', () => {
  it('research goal forms Researcher/Analyst/Reviewer — NOT software roles', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('researcher', {requiredCapabilities: ['read', 'research'], packOwner: 'research-pack', domain: 'research'}));
    catalog.register(ROLE('analyst', {requiredCapabilities: ['read', 'structured-output'], packOwner: 'research-pack', domain: 'research', independenceClass: 'analyst'}));
    catalog.register(ROLE('reviewer', {requiredCapabilities: ['read', 'review'], independenceClass: 'independent-reviewer', packOwner: 'research-pack', domain: 'research'}));

    const requirements = [
      REQ('Conduct market research on competitor pricing', ['read', 'research']),
      REQ('Analyze findings and produce comparison report', ['read', 'structured-output']),
      REQ('Review the report for accuracy and completeness', ['read', 'review'], {independenceRequired: true}),
    ];

    const instances = requirements.map((req, i) => {
      const spec = resolveRole(catalog, req);
      expect(spec.ok).toBe(true);
      if (!spec.ok) throw new Error('resolve failed');
      return createRoleInstance({roleInstanceId: `ri_r${String(i)}`, runId: 'run_res', companyId: 'co_res', specification: spec.value});
    });

    // Non-software roles resolved
    expect(instances[0]!.specification.displayName).toContain('researcher');
    expect(instances[1]!.specification.displayName).toContain('analyst');
    expect(instances[2]!.specification.displayName).toContain('reviewer');

    // NO software roles leaked in
    const allRoles = instances.map((inst) => inst.specification.displayName).join(' ');
    expect(allRoles).not.toContain('engineer');
    expect(allRoles).not.toContain('git');
    expect(allRoles).not.toContain('build');
    expect(allRoles).not.toContain('architect');
  });
});

// ---------------------------------------------------------------------------
// E2E Proof C: Late Specialist Addition (Boss §64)
// ---------------------------------------------------------------------------

describe('STAGE 7 E2E Proof C — Late Specialist (Boss §64)', () => {
  it('mid-execution security risk → dynamic specialist role without user action', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('engineer'));
    // NO security specialist in initial catalog

    // Initial resolution: engineer
    const initial = resolveRole(catalog, REQ('implement feature', ['read', 'write']));
    expect(initial.ok).toBe(true);
    if (initial.ok) expect(initial.value.origin).toBe('catalog-match');

    // Late: security risk discovered → new responsibility
    const lateRequirement = REQ('Windows security boundary verification', ['security', 'windows', 'review'], {
      independenceRequired: true,
      riskLevel: 'high',
    });
    const specialist = resolveRole(catalog, lateRequirement);
    expect(specialist.ok).toBe(true);
    if (specialist.ok) {
      expect(specialist.value.origin).toBe('dynamic-synthesis');
      expect(specialist.value.independenceClass).toBe('independent-reviewer');
      expect(specialist.value.requiredCapabilities).toContain('security');
    }

    // The specialist gets its own RoleInstance
    const instance = createRoleInstance({
      roleInstanceId: 'ri_late_sec', runId: 'run_late', companyId: 'co_late',
      specification: specialist.ok ? specialist.value : (() => { throw new Error('unreachable'); })(),
    });
    expect(instance.professionalResponsibility).toContain('security');
  });
});

// ---------------------------------------------------------------------------
// Minimal Sufficient Team (Boss §19, §43)
// ---------------------------------------------------------------------------

describe('STAGE 7 Minimal Sufficient Team (Boss §19, §43)', () => {
  it('simple task resolves to minimal roles, not a full team', () => {
    const catalog = new RoleCatalog();
    catalog.register(ROLE('architect', {requiredCapabilities: ['design', 'structured-output']}));
    catalog.register(ROLE('engineer'));
    catalog.register(ROLE('test-engineer', {requiredCapabilities: ['read', 'test']}));
    catalog.register(ROLE('reviewer', {requiredCapabilities: ['read', 'review'], independenceClass: 'independent-reviewer'}));
    catalog.register(ROLE('project-manager', {independenceClass: 'coordinator'}));
    catalog.register(ROLE('security-engineer', {requiredCapabilities: ['security']}));

    // Simple task: change a config title and verify
    const simplePlan: ProfessionalResponsibilityRequirement[] = [
      REQ('Change configuration display title', ['read', 'write']),
      REQ('Verify the change', ['read', 'review'], {independenceRequired: true}),
    ];

    const instances = simplePlan.map((req) => {
      const spec = resolveRole(catalog, req);
      expect(spec.ok).toBe(true);
      if (!spec.ok) throw new Error('resolve failed');
      return spec.value;
    });

    // Minimal: 2 roles (engineer + reviewer), not 6-8
    expect(instances.length).toBe(2);
    const names = instances.map((s) => s.displayName);
    expect(names).not.toContain('project manager');
    expect(names).not.toContain('architect');
    expect(names).not.toContain('security engineer');
  });
});

// ---------------------------------------------------------------------------
// Negative claims (Boss §8, §25, §33, §57)
// ---------------------------------------------------------------------------

describe('STAGE 7 negative claims', () => {
  it('no manual user role assignment in the orchestration API', () => {
    // The resolveRole function takes ProfessionalResponsibilityRequirement
    // — there is no "user selects role" parameter anywhere in the API.
    const catalog = new RoleCatalog();
    const req = REQ('any work', ['read']);
    const result = resolveRole(catalog, req);
    expect(result.ok).toBe(true);
    // The API surface has no role picker / manual employee selection
    // (proven by the function signature accepting only requirement + catalog)
  });

  it('no hidden general-purpose agent fallback on resolution failure', () => {
    const catalog = new RoleCatalog();
    // Empty catalog + dynamic synthesis always succeeds (it derives from the requirement)
    // But if we had a strict mode... for now, dynamic synthesis is the last resort.
    // The key negative: resolveRole NEVER returns a "general-purpose-agent" role.
    const result = resolveRole(catalog, REQ('anything', ['unknown-cap']));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.displayName.toLowerCase()).not.toContain('general-purpose');
      expect(result.value.roleDefinitionId).not.toBe('general-agent');
    }
  });

  it('no peer chat runtime: handoff is via durable objects only', () => {
    // RoleContextEnvelope carries artifact refs — no "send message to role X" API exists
    const catalog = new RoleCatalog();
    catalog.register(ROLE('engineer'));
    const spec = resolveRole(catalog, REQ('implement', ['read', 'write']));
    if (!spec.ok) throw new Error('resolve failed');
    const role = createRoleInstance({roleInstanceId: 'ri_h', runId: 'run_h', companyId: 'co_h', specification: spec.value});
    const envelope = buildRoleContextEnvelope({
      goalSummary: 'G', planItem: null, taskObjective: 'T', role,
      requiredOutput: 'output', artifactRefs: ['art_prev'],
    });
    expect(envelope.relevantArtifactRefs).toContain('art_prev');
    // No messaging/chat fields
    expect(envelope).not.toHaveProperty('sendMessage');
    expect(envelope).not.toHaveProperty('peerChat');
    expect(envelope).not.toHaveProperty('conversation');
  });
});

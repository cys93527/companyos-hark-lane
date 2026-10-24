/**
 * Sprint 16 / Task-16-03 — DevCompany PRODUCT CONTENT verification.
 *
 * Verifies the delivered product content against the frozen T16-01 contract (roles,
 * authorities, workflow shape, prompt coverage, tool/validator/artifact/risk vocabulary,
 * model policy) and the four-way consistency between the contract doc, the manifest, the
 * model policy and these tests. Framework integration (a successful install through the
 * real PackService) is Task-16-05 scope; the only runtime-level assertion here is that an
 * unmet requirement fails closed, which lives in `tests/sprint16/`.
 */
import { describe, expect, it } from 'vitest';

import { AUTHORITIES, isAuthority } from '@companyos/core';

import {
  DEVCOMPANY_MANIFEST,
  DEVCOMPANY_MODEL_POLICY,
  DEVCOMPANY_PACK_ID,
  DEVCOMPANY_ROLE_KEYS,
  DEVCOMPANY_TOOL_IDS,
  DEVCOMPANY_VALIDATOR_ID,
  DEVCOMPANY_WORKFLOW_KEY,
  type DevCompanyModelCapability,
} from '@companyos/pack-dev-company';

/** The T16-01 §3.2 frozen authority sets — the authority of record for this audit. */
const FROZEN_AUTHORITIES: Readonly<Record<string, readonly string[]>> = {
  'dev-company:cto': [
    'workflow.draft.create',
    'workflow.publish',
    'artifact.create',
    'artifact.read',
    'decision.create',
    'decision.read',
    'memory.read',
    'tool.read',
    'validation.read',
  ],
  'dev-company:developer': [
    'agent.execute',
    'tool.invoke',
    'tool.read',
    'artifact.create',
    'artifact.read',
    'memory.create',
    'memory.read',
    'handoff.create',
    'handoff.read',
    'validation.read',
  ],
  'dev-company:reviewer': [
    'agent.execute',
    'tool.invoke',
    'tool.read',
    'artifact.create',
    'artifact.read',
    'memory.read',
    'validation.read',
    'handoff.read',
    'handoff.accept',
    'handoff.reject',
    'handoff.create',
  ],
  'dev-company:qa': [
    'agent.execute',
    'tool.invoke',
    'tool.read',
    'artifact.create',
    'artifact.read',
    'memory.read',
    'validation.record',
    'validation.read',
    'handoff.read',
    'handoff.accept',
    'handoff.reject',
    'handoff.create',
  ],
  'dev-company:documentation': [
    'agent.execute',
    'tool.invoke',
    'tool.read',
    'artifact.create',
    'artifact.read',
    'memory.read',
    'decision.read',
    'handoff.create',
    'handoff.read',
  ],
};

const promptText = (role: string): string =>
  DEVCOMPANY_MANIFEST.declarations.prompts.find((prompt) => prompt.key === `dev-company:${role}-prompt`)?.template ?? '';

describe('role contract (T16-01 §3)', () => {
  it('freezes exactly the five canonical role keys in order', () => {
    expect(DEVCOMPANY_MANIFEST.declarations.roles.map((role) => role.key)).toEqual([
      DEVCOMPANY_ROLE_KEYS.cto,
      DEVCOMPANY_ROLE_KEYS.developer,
      DEVCOMPANY_ROLE_KEYS.reviewer,
      DEVCOMPANY_ROLE_KEYS.qa,
      DEVCOMPANY_ROLE_KEYS.documentation,
    ]);
    expect(DEVCOMPANY_MANIFEST.declarations.roles).toHaveLength(5);
  });

  it.each([
    ['CTO', DEVCOMPANY_ROLE_KEYS.cto],
    ['Developer', DEVCOMPANY_ROLE_KEYS.developer],
    ['Reviewer', DEVCOMPANY_ROLE_KEYS.reviewer],
    ['QA', DEVCOMPANY_ROLE_KEYS.qa],
    ['Documentation', DEVCOMPANY_ROLE_KEYS.documentation],
  ])('locks the %s authority set exactly to the frozen set', (_label, key) => {
    const role = DEVCOMPANY_MANIFEST.declarations.roles.find((entry) => entry.key === key);
    expect(role).toBeDefined();
    // EXACT set equality (not "contains"): any extra or missing authority fails.
    expect([...(role?.authorityRefs ?? [])].sort()).toEqual([...(FROZEN_AUTHORITIES[key] ?? [])].sort());
    for (const authority of role?.authorityRefs ?? []) {
      expect(isAuthority(authority), `${authority} must exist in the closed catalog`).toBe(true);
    }
  });

  it('grants no pack-management or secret authority to any product role', () => {
    for (const role of DEVCOMPANY_MANIFEST.declarations.roles) {
      expect(role.authorityRefs).not.toContain('pack.manage');
      for (const authority of role.authorityRefs) {
        expect(authority.startsWith('secret.')).toBe(false);
      }
    }
    expect(AUTHORITIES).not.toContain('*');
  });

  it('defines roles only — no user identity, assignment or bootstrap field anywhere', () => {
    // Structural scan: collect every object key in the manifest (approval `mode: 'owner'`
    // is a legal stage-config value, so only KEYS are checked, never values).
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          keys.add(key);
          walk(entry);
        }
      }
    };
    walk(DEVCOMPANY_MANIFEST);
    for (const forbidden of ['actorId', 'assignedTo', 'assign', 'assignments', 'bootstrap', 'userId', 'user', 'installationId', 'companyId', 'creationCommandId', 'creationCommandFingerprint', 'status', 'installedAt', 'installedBy']) {
      expect(keys.has(forbidden), `manifest must not carry the field "${forbidden}"`).toBe(false);
    }
    const serialized = JSON.stringify(DEVCOMPANY_MANIFEST);
    for (const forbidden of ['user_', 'assignedTo', 'bootstrap']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('workflow contract (T16-01 §4)', () => {
  const template = DEVCOMPANY_MANIFEST.declarations.workflowTemplates[0]!;

  it('is the single canonical delivery-cycle workflow', () => {
    expect(DEVCOMPANY_MANIFEST.declarations.workflowTemplates).toHaveLength(1);
    expect(template.key).toBe(DEVCOMPANY_WORKFLOW_KEY);
    expect(template.key).toBe('dev-company:delivery-cycle');
  });

  it('is the exact five-stage linear chain with no extra stages', () => {
    expect(template.graph.nodes.map((node) => node.id)).toEqual(['cto', 'developer', 'reviewer', 'qa', 'documentation']);
    expect(template.graph.edges).toEqual([
      { from: 'cto', to: 'developer' },
      { from: 'developer', to: 'reviewer' },
      { from: 'reviewer', to: 'qa' },
      { from: 'qa', to: 'documentation' },
    ]);
    for (const forbidden of ['retry', 'deploy', 'release', 'security', 'devops', 'manager', 'loop']) {
      expect(template.graph.nodes.map((node) => node.id)).not.toContain(forbidden);
      expect(template.graph.edges.some((edge) => edge.from === edge.to)).toBe(false);
    }
  });

  it('binds every stage to its corresponding role exactly', () => {
    const expected: Record<string, string> = {
      cto: DEVCOMPANY_ROLE_KEYS.cto,
      developer: DEVCOMPANY_ROLE_KEYS.developer,
      reviewer: DEVCOMPANY_ROLE_KEYS.reviewer,
      qa: DEVCOMPANY_ROLE_KEYS.qa,
      documentation: DEVCOMPANY_ROLE_KEYS.documentation,
    };
    for (const node of template.graph.nodes) {
      expect(node.config['roleId']).toBe(expected[node.id]);
    }
  });

  it('uses only the frozen stage-config vocabulary', () => {
    const allowed = new Set(['roleId', 'validatorIds', 'riskLevel', 'approval']);
    for (const node of template.graph.nodes) {
      for (const configKey of Object.keys(node.config)) {
        expect(allowed.has(configKey), `stage ${node.id} uses unapproved key ${configKey}`).toBe(true);
      }
    }
  });

  it('makes the reviewer and QA gates non-bypassable (HIGH risk + required approval)', () => {
    for (const stageId of ['reviewer', 'qa'] as const) {
      const node = template.graph.nodes.find((entry) => entry.id === stageId)!;
      const config: Readonly<Record<string, unknown>> = node.config;
      expect(config['riskLevel']).toBe('HIGH');
      expect(config['approval']).toEqual({ required: true, mode: 'owner' });
    }
    // CTO is a planning/acceptance stage, never a scheduler: it has no approval gate and
    // no loop edge back into the chain.
    const nodes: readonly { readonly id: string; readonly config: Readonly<Record<string, unknown>> }[] = template.graph.nodes;
    const cto = nodes.find((entry) => entry.id === 'cto')!;
    expect(Object.keys(cto.config)).toEqual(['roleId']);
    const ctoStage: string = 'cto';
    expect(template.graph.edges.filter((edge) => edge.to === ctoStage)).toHaveLength(0); // no loop back into CTO
  });
});

describe('prompt contract (T16-01 §5)', () => {
  it('freezes exactly the five role prompts', () => {
    expect(DEVCOMPANY_MANIFEST.declarations.prompts.map((prompt) => prompt.key)).toEqual([
      'dev-company:cto-prompt',
      'dev-company:developer-prompt',
      'dev-company:reviewer-prompt',
      'dev-company:qa-prompt',
      'dev-company:documentation-prompt',
    ]);
  });

  it('CTO prompt covers the source-defined responsibilities and the scheduling boundary', () => {
    const text = promptText('cto');
    for (const needle of [
      'understand the requirement',
      'analyze the existing project',
      'select or design',
      'Sprint',
      'Task',
      'Acceptance Criteria',
      'Capability Requirement',
      'risk',
      'final acceptance',
      'SOP improvements',
      'do NOT own continuous scheduling',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('Developer prompt covers the implementation responsibilities only', () => {
    const text = promptText('developer');
    for (const needle of ['coding', 'UI', 'API', 'CRUD', 'bug fixes', 'refactoring', 'test additions', 'file modifications']) {
      expect(text).toContain(needle);
    }
    for (const forbidden of ['deployment owner', 'pack manager', 'final architecture authority']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('Reviewer prompt covers the review boundaries and stays independence-only', () => {
    const text = promptText('reviewer');
    for (const needle of [
      'independently',
      'architecture consistency',
      'potential bugs',
      'boundary',
      'state consistency',
      'concurrency',
      'async',
      'security',
      'missing tests',
      'unrelated diff',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('QA prompt forbids LLM self-attestation over all six real commands', () => {
    const text = promptText('qa');
    expect(text).toContain('NEVER claim a command passed from model reasoning alone');
    for (const command of ['tests', 'lint', 'typecheck', 'build', 'git diff', 'git status']) {
      expect(text).toContain(command);
    }
    expect(text).toContain('durable tool or validation evidence');
  });

  it('Documentation prompt covers the six deliverables', () => {
    const text = promptText('documentation');
    for (const needle of ['README', 'API Docs', 'CHANGELOG', 'User Guide', 'Technical Documentation', 'Decision Summary']) {
      expect(text).toContain(needle);
    }
  });

  it('claims no prompt runtime: prompts are declarative product data only', () => {
    // The pack framework has no prompt consumer; the test suite must not assert one.
    const pkg = DEVCOMPANY_MANIFEST.declarations;
    expect(pkg.prompts.every((prompt) => typeof prompt.template === 'string')).toBe(true);
  });
});

describe('tool / validator / artifact / risk vocabulary', () => {
  it('declares the six Sprint-17 tool requirements', () => {
    expect(DEVCOMPANY_MANIFEST.declarations.tools.map((tool) => tool.key)).toEqual([
      'dev-company:tool-req-tests',
      'dev-company:tool-req-lint',
      'dev-company:tool-req-typecheck',
      'dev-company:tool-req-build',
      'dev-company:tool-req-git-diff',
      'dev-company:tool-req-git-status',
    ]);
  });

  it('keeps git diff and git status as distinct requirements even though they share a tool id', () => {
    const diff = DEVCOMPANY_MANIFEST.declarations.tools.find((tool) => tool.key === 'dev-company:tool-req-git-diff')!;
    const status = DEVCOMPANY_MANIFEST.declarations.tools.find((tool) => tool.key === 'dev-company:tool-req-git-status')!;
    expect(diff.key).not.toBe(status.key);
    expect(diff.toolId).toBe(DEVCOMPANY_TOOL_IDS.gitDiff);
    expect(status.toolId).toBe(DEVCOMPANY_TOOL_IDS.gitStatus);
    expect(diff.toolId).toBe(status.toolId); // same future provider, distinct requirements
    expect(diff.capability).toBeNull(); // no capability vocabulary invented for a Sprint 17 tool
  });

  it('declares exactly one QA evidence validator', () => {
    expect(DEVCOMPANY_MANIFEST.declarations.validators).toEqual([
      { key: 'dev-company:qa-evidence-validator', validatorId: DEVCOMPANY_VALIDATOR_ID },
    ]);
    expect(DEVCOMPANY_VALIDATOR_ID).toBe('repo.validation-evidence');
  });

  it('declares exactly the five artifact kinds with role-aligned labels', () => {
    const artifacts = DEVCOMPANY_MANIFEST.declarations.artifacts;
    expect(artifacts.map((artifact) => artifact.key)).toEqual([
      'dev-company:requirements-analysis',
      'dev-company:implementation-change',
      'dev-company:review-report',
      'dev-company:qa-report',
      'dev-company:documentation',
    ]);
    for (const artifact of artifacts) {
      expect(artifact.label.length).toBeGreaterThan(0);
      expect(artifact.description.length).toBeGreaterThan(0);
    }
  });

  it('declares exactly one declarative risk rule (enforcement lives in the stage config)', () => {
    const risk = DEVCOMPANY_MANIFEST.declarations.riskRules;
    expect(risk).toHaveLength(1);
    expect(risk[0]!.key).toBe('dev-company:gate-no-bypass');
    expect(risk[0]!.riskLevel).toBe('HIGH');
    expect(risk[0]!.description).toContain('may not be bypassed');
  });

  it('leaves capability rules and generic templates empty by ruling', () => {
    expect(DEVCOMPANY_MANIFEST.declarations.capabilityRules).toEqual([]);
    expect(DEVCOMPANY_MANIFEST.declarations.templates).toEqual([]);
  });

  it('locks the nine-category counts exactly', () => {
    const d = DEVCOMPANY_MANIFEST.declarations;
    expect({
      roles: d.roles.length,
      workflowTemplates: d.workflowTemplates.length,
      prompts: d.prompts.length,
      tools: d.tools.length,
      validators: d.validators.length,
      artifacts: d.artifacts.length,
      riskRules: d.riskRules.length,
      capabilityRules: d.capabilityRules.length,
      templates: d.templates.length,
    }).toEqual({
      roles: 5,
      workflowTemplates: 1,
      prompts: 5,
      tools: 6,
      validators: 1,
      artifacts: 5,
      riskRules: 1,
      capabilityRules: 0,
      templates: 0,
    });
    // Constitution-mandated six are non-empty.
    for (const kind of ['roles', 'workflowTemplates', 'tools', 'validators', 'artifacts', 'riskRules'] as const) {
      expect(d[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('model policy (out-of-manifest companion product policy)', () => {
  it('requires the real model capability tokens and the reviewer/developer separation', () => {
    expect(DEVCOMPANY_MODEL_POLICY.developer.requiredLogicalCapabilities).toEqual<DevCompanyModelCapability[]>(['toolCalling']);
    expect(DEVCOMPANY_MODEL_POLICY.reviewer.requiredLogicalCapabilities).toEqual<DevCompanyModelCapability[]>(['reasoning']);
    expect(DEVCOMPANY_MODEL_POLICY.reviewerMustDifferFromDeveloper).toBe(true);
  });

  it('is structurally absent from the PackManifest (no tenth category, no smuggled field)', () => {
    const serialized = JSON.stringify(DEVCOMPANY_MANIFEST);
    expect(DEVCOMPANY_MANIFEST).not.toHaveProperty('modelPolicy');
    expect(Object.keys(DEVCOMPANY_MANIFEST.declarations)).toHaveLength(9);
    expect(serialized).not.toContain('reviewerMustDifferFromDeveloper');
    expect(serialized).not.toContain('requiredLogicalCapabilities');
    expect(DEVCOMPANY_MANIFEST.packId).toBe(DEVCOMPANY_PACK_ID);
  });
});

describe('four-way contract consistency', () => {
  it('agrees with the frozen contract on identity, counts and empty-category rulings', () => {
    // The contract doc states these facts; the manifest must match them exactly.
    expect(DEVCOMPANY_MANIFEST.packId).toBe('dev-company');
    expect(DEVCOMPANY_MANIFEST.packVersion).toBe('1.0.0');
    expect(DEVCOMPANY_MANIFEST.name).toBe('DevCompany');
    expect(DEVCOMPANY_MANIFEST.capabilities).toEqual([]);
    expect(DEVCOMPANY_MANIFEST.dependsOn).toEqual([]);
    // No sixth role, no sixth prompt, no sixth artifact kind, no second workflow.
    expect(DEVCOMPANY_MANIFEST.declarations.roles).toHaveLength(5);
    expect(DEVCOMPANY_MANIFEST.declarations.prompts).toHaveLength(5);
    expect(DEVCOMPANY_MANIFEST.declarations.artifacts).toHaveLength(5);
    expect(DEVCOMPANY_MANIFEST.declarations.workflowTemplates).toHaveLength(1);
  });
});

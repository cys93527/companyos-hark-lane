/**
 * Sprint 16 / Task-16-02 — DevCompany Pack static contract validation.
 *
 * Package-local, STATIC only: the canonical parser, the Core semantic validator, product
 * identity, the nine-category shape, the companion model policy, fingerprint determinism,
 * inertness (no executable module behaviour) and the dependency direction. Content-level
 * acceptance (role authorities, workflow semantics, prompt coverage, QA evidence wording)
 * is Task-16-03 scope and is deliberately NOT duplicated here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AUTHORITIES,
  PACK_API_VERSION,
  PACK_MANIFEST_VERSION,
  isAuthority,
  packManifestFingerprint,
  validatePackManifest,
} from '@companyos/core';
import { canonicalPackManifestSchema } from '@companyos/contracts';

import {
  DEVCOMPANY_MANIFEST,
  DEVCOMPANY_MODEL_POLICY,
  DEVCOMPANY_MODEL_POLICY_STAGES,
  DEVCOMPANY_PACK_ID,
  DEVCOMPANY_PACK_NAME,
  DEVCOMPANY_ROLE_KEYS,
  DEVCOMPANY_TOOL_IDS,
  DEVCOMPANY_VALIDATOR_ID,
  DEVCOMPANY_WORKFLOW_KEY,
  type DevCompanyModelCapability,
} from '@companyos/pack-dev-company';

const repo = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));

describe('DevCompany canonical manifest validity', () => {
  it('parses through the canonical contracts parser with zero issues', () => {
    const parsed = canonicalPackManifestSchema.safeParse(DEVCOMPANY_MANIFEST);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(DEVCOMPANY_MANIFEST);
  });

  it('passes the Core semantic validator (conformance with the semantic authority)', () => {
    const validated = validatePackManifest(DEVCOMPANY_MANIFEST);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.packId).toBe(DEVCOMPANY_PACK_ID);
  });

  it('uses the canonical version constants — no duplicated magic values', () => {
    expect(DEVCOMPANY_MANIFEST.manifestVersion).toBe(PACK_MANIFEST_VERSION);
    expect(DEVCOMPANY_MANIFEST.coreApi).toBe(PACK_API_VERSION);
  });

  it('carries the frozen product identity', () => {
    expect(DEVCOMPANY_MANIFEST.packId).toBe('dev-company');
    expect(DEVCOMPANY_MANIFEST.packVersion).toBe('1.0.0');
    expect(DEVCOMPANY_PACK_NAME).toBe('DevCompany');
  });

  it('never carries a codename or any installation identity field', () => {
    const serialized = JSON.stringify(DEVCOMPANY_MANIFEST);
    expect(serialized).not.toContain('CodeFleet');
    for (const forbidden of ['companyId', 'installationId', 'creationCommandId', 'creationCommandFingerprint', 'status', 'installedAt', 'actorId']) {
      expect(DEVCOMPANY_MANIFEST).not.toHaveProperty(forbidden);
    }
  });
});

describe('DevCompany nine-category declaration shape', () => {
  it('declares exactly the nine canonical categories', () => {
    expect(Object.keys(DEVCOMPANY_MANIFEST.declarations).sort()).toEqual([
      'artifacts',
      'capabilityRules',
      'prompts',
      'riskRules',
      'roles',
      'templates',
      'tools',
      'validators',
      'workflowTemplates',
    ]);
  });

  it('has every constitution-mandated category non-empty, prompts non-empty, and the two ruled-empty categories empty', () => {
    const d = DEVCOMPANY_MANIFEST.declarations;
    for (const kind of ['roles', 'workflowTemplates', 'validators', 'tools', 'artifacts', 'riskRules'] as const) {
      expect(d[kind].length, `${kind} must be non-empty`).toBeGreaterThan(0);
    }
    expect(d.prompts).toHaveLength(5);
    expect(d.capabilityRules).toEqual([]);
    expect(d.templates).toEqual([]);
  });

  it('freezes the five roles with pack-qualified keys and catalog-closed authorities', () => {
    const keys = DEVCOMPANY_MANIFEST.declarations.roles.map((role) => role.key);
    expect(keys).toEqual([
      DEVCOMPANY_ROLE_KEYS.cto,
      DEVCOMPANY_ROLE_KEYS.developer,
      DEVCOMPANY_ROLE_KEYS.reviewer,
      DEVCOMPANY_ROLE_KEYS.qa,
      DEVCOMPANY_ROLE_KEYS.documentation,
    ]);
    for (const role of DEVCOMPANY_MANIFEST.declarations.roles) {
      expect(role.authorityRefs.length).toBeGreaterThan(0);
      for (const authority of role.authorityRefs) {
        expect(isAuthority(authority), `${authority} must be in the closed catalog`).toBe(true);
      }
      // No role may hold the pack-management authority or a wildcard equivalent.
      expect(role.authorityRefs).not.toContain('pack.manage');
    }
    expect(AUTHORITIES).not.toContain('*');
  });

  it('declares one minimal five-stage delivery workflow bound to the five roles', () => {
    const templates = DEVCOMPANY_MANIFEST.declarations.workflowTemplates;
    expect(templates).toHaveLength(1);
    const template = templates[0]!;
    expect(template.key).toBe(DEVCOMPANY_WORKFLOW_KEY);
    expect(template.graph.nodes.map((node) => node.id)).toEqual(['cto', 'developer', 'reviewer', 'qa', 'documentation']);
    expect(template.graph.edges).toEqual([
      { from: 'cto', to: 'developer' },
      { from: 'developer', to: 'reviewer' },
      { from: 'reviewer', to: 'qa' },
      { from: 'qa', to: 'documentation' },
    ]);
    // Stage config uses only the frozen STAGE_CONFIG_KEYS — no invented key.
    const allowed = new Set(['roleId', 'validatorIds', 'riskLevel', 'approval']);
    for (const node of template.graph.nodes) {
      for (const configKey of Object.keys(node.config)) {
        expect(allowed.has(configKey), `stage ${node.id} uses unknown config key ${configKey}`).toBe(true);
      }
      expect(node.config['roleId']).toMatch(/^dev-company:(cto|developer|reviewer|qa|documentation)$/);
    }
    // The reviewer and QA gates cannot be bypassed: HIGH risk with a required approval.
    for (const stageId of ['reviewer', 'qa'] as const) {
      const node = template.graph.nodes.find((entry) => entry.id === stageId)!;
      const config: Readonly<Record<string, unknown>> = node.config;
      expect(config['riskLevel']).toBe('HIGH');
      expect(config['approval']).toEqual({ required: true, mode: 'owner' });
    }
    // No Sprint 18 orchestration creep: linear chain, one node per stage.
    expect(template.graph.edges).toHaveLength(4);
  });

  it('declares the six Sprint-17 tool requirements and the QA evidence validator as declarative requirements', () => {
    const tools = DEVCOMPANY_MANIFEST.declarations.tools;
    expect(tools.map((tool) => tool.key)).toEqual([
      'dev-company:tool-req-tests',
      'dev-company:tool-req-lint',
      'dev-company:tool-req-typecheck',
      'dev-company:tool-req-build',
      'dev-company:tool-req-git-diff',
      'dev-company:tool-req-git-status',
    ]);
    expect(new Set(tools.map((tool) => tool.toolId))).toEqual(
      new Set([DEVCOMPANY_TOOL_IDS.tests, DEVCOMPANY_TOOL_IDS.lint, DEVCOMPANY_TOOL_IDS.typecheck, DEVCOMPANY_TOOL_IDS.build, DEVCOMPANY_TOOL_IDS.gitDiff]),
    );
    expect(DEVCOMPANY_MANIFEST.declarations.validators).toEqual([
      { key: 'dev-company:qa-evidence-validator', validatorId: DEVCOMPANY_VALIDATOR_ID },
    ]);
  });

  it('declares the five artifact kinds and one minimal risk rule', () => {
    expect(DEVCOMPANY_MANIFEST.declarations.artifacts.map((artifact) => artifact.key)).toEqual([
      'dev-company:requirements-analysis',
      'dev-company:implementation-change',
      'dev-company:review-report',
      'dev-company:qa-report',
      'dev-company:documentation',
    ]);
    const risk = DEVCOMPANY_MANIFEST.declarations.riskRules;
    expect(risk).toHaveLength(1);
    expect(risk[0]!.riskLevel).toBe('HIGH');
  });

  it('carries the QA no-self-attestation rule in the QA prompt', () => {
    const qaPrompt = DEVCOMPANY_MANIFEST.declarations.prompts.find((prompt) => prompt.key === 'dev-company:qa-prompt');
    expect(qaPrompt).toBeDefined();
    expect(qaPrompt!.template).toContain('NEVER claim a command passed from model reasoning alone');
  });
});

describe('DevCompany companion model policy (out-of-manifest product policy)', () => {
  it('requires existing model capability tokens and the reviewer/developer separation', () => {
    expect(DEVCOMPANY_MODEL_POLICY.developer.requiredLogicalCapabilities).toEqual<DevCompanyModelCapability[]>(['toolCalling']);
    expect(DEVCOMPANY_MODEL_POLICY.reviewer.requiredLogicalCapabilities).toEqual<DevCompanyModelCapability[]>(['reasoning']);
    expect(DEVCOMPANY_MODEL_POLICY.reviewerMustDifferFromDeveloper).toBe(true);
    expect(DEVCOMPANY_MODEL_POLICY_STAGES).toEqual(['developer', 'reviewer']);
  });

  it('is NOT part of the PackManifest (no tenth category, no schema field)', () => {
    const manifestKeys = Object.keys(DEVCOMPANY_MANIFEST);
    expect(manifestKeys).not.toContain('modelPolicy');
    expect(Object.keys(DEVCOMPANY_MANIFEST.declarations)).not.toContain('modelPolicy');
    expect(JSON.stringify(DEVCOMPANY_MANIFEST)).not.toContain('reviewerMustDifferFromDeveloper');
    expect(JSON.stringify(DEVCOMPANY_MANIFEST)).not.toContain('requiredLogicalCapabilities');
  });
});

describe('DevCompany package purity and boundaries', () => {
  it('produces a deterministic qualified fingerprint for the product manifest', () => {
    const first = packManifestFingerprint(DEVCOMPANY_MANIFEST);
    const second = packManifestFingerprint(DEVCOMPANY_MANIFEST);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('exports inert data only — no executable behaviour in the source', () => {
    // Code-only view: comments and string literals are stripped, so a doc comment ABOUT the
    // rule (or a prompt text that mentions a token) cannot trip the lock.
    const codeOnly = (source: string): string => {
      let out = '';
      let i = 0;
      while (i < source.length) {
        const pair = source.slice(i, i + 2);
        if (pair === '/*') {
          const close = source.indexOf('*/', i + 2);
          i = close === -1 ? source.length : close + 2;
          out += ' ';
          continue;
        }
        if (pair === '//') {
          const eol = source.indexOf(String.fromCharCode(10), i);
          i = eol === -1 ? source.length : eol;
          out += ' ';
          continue;
        }
        const ch = source[i];
        if (ch === "'" || ch === '"' || ch === '`') {
          i += 1;
          while (i < source.length && source[i] !== ch) {
            if (source[i] === String.fromCharCode(92)) i += 1;
            i += 1;
          }
          i += 1;
          out += '""';
          continue;
        }
        out += ch;
        i += 1;
      }
      return out;
    };
    for (const file of ['manifest.ts', 'model-policy.ts', 'index.ts']) {
      const source = codeOnly(readFileSync(repo(`src/${file}`), 'utf8'));
      for (const forbidden of ['readFileSync', 'writeFileSync', 'node:fs', 'node:child_process', 'node:vm', 'eval(', 'new Function(', 'fetch(', 'process.env', 'PackService', 'install(', 'import(', 'require(']) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false);
      }
    }
  });

  it('keeps the dependency direction one-way: only generic platform contracts', () => {
    const manifest = JSON.parse(readFileSync(repo('package.json'), 'utf8')) as {
      readonly name: string;
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(manifest.name).toBe('@companyos/pack-dev-company');
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@companyos/core']);
    // The inner ring must never reach back into this pack.
    for (const inner of ['../../packages/core', '../../packages/contracts', '../../packages/engine'] as const) {
      const innerManifest = JSON.parse(readFileSync(repo(`${inner}/package.json`), 'utf8')) as {
        readonly dependencies?: Readonly<Record<string, string>>;
      };
      expect(Object.keys(innerManifest.dependencies ?? {})).not.toContain('@companyos/pack-dev-company');
      const source = readFileSync(repo(`${inner}/src/index.ts`), 'utf8');
      expect(source).not.toContain('pack-dev-company');
    }
  });
});

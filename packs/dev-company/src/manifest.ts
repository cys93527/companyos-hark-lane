/**
 * DevCompany (codename CodeFleet) — the first-party industry Pack product manifest.
 *
 * INERT, READONLY, COMPILE-TIME DATA (ADR-0024: Pack = immutable versioned declarative
 * configuration bundle — DATA/CONFIG ONLY). This module exports data and nothing else:
 * no install callbacks, no filesystem/network access, no dynamic imports, no runtime
 * behaviour of any kind. Importing it changes no global state.
 *
 * The canonical field set comes from `@companyos/core` (semantic authority) and is
 * validated at build/test time by `@companyos/contracts` (transport projection) —
 * see `tests/manifest.test.ts`. Content provenance is labelled per the Sprint 16 product
 * contract: role responsibilities are SOURCE-DEFINED (V1_1_RECONCILIATION §十七–§二十二);
 * role authorities, prompt wording and the stage graph are BOSS-FROZEN DERIVATION.
 *
 * NOT in this manifest (Boss ruling, TASK-16-02):
 *   - the Developer/Reviewer model-separation rule — that is a DevCompany product
 *     BINDING policy, not a Pack declaration; it lives in `./model-policy.js` and is
 *     enforced by the existing Model Registry / Router / RunSnapshot.modelBindings.
 *   - the internal codename CodeFleet — package/docs metadata only, never a manifest field.
 *   - tool/validator identifiers are DECLARATIVE REQUIREMENTS over Sprint 17 runtime
 *     providers: the manifest is statically valid, while a production install into a
 *     company that lacks those tools fails closed (expected until Sprint 17).
 */
import {
  PACK_API_VERSION,
  PACK_MANIFEST_VERSION,
  type PackManifest,
} from '@companyos/core';

/** Pack identity (T16-01 §2 / TASK-16-02 §10). */
export const DEVCOMPANY_PACK_ID = 'dev-company';
export const DEVCOMPANY_PACK_VERSION = '1.0.0';
export const DEVCOMPANY_PACK_NAME = 'DevCompany';

/**
 * The five canonical role logical keys (T16-01 §3.1). The materialized company role key
 * is derived by the pack framework (`<packId>-<name>`, ADR-0026 namespace rule).
 */
export const DEVCOMPANY_ROLE_KEYS = {
  cto: 'dev-company:cto',
  developer: 'dev-company:developer',
  reviewer: 'dev-company:reviewer',
  qa: 'dev-company:qa',
  documentation: 'dev-company:documentation',
} as const;

/** The single canonical workflow logical key (T16-01 §4). */
export const DEVCOMPANY_WORKFLOW_KEY = 'dev-company:delivery-cycle';

/** Sprint 17 future tool identities these requirements point at (not yet registered). */
export const DEVCOMPANY_TOOL_IDS = {
  tests: 'repo.test-runner',
  lint: 'repo.linter',
  typecheck: 'repo.typechecker',
  build: 'repo.builder',
  gitDiff: 'repo.git',
  gitStatus: 'repo.git',
} as const;

/** Sprint 17 future validator tool identity (must carry `validation:validator`). */
export const DEVCOMPANY_VALIDATOR_ID = 'repo.validation-evidence';

/** `dev-company:<name>` — the pack-qualified declaration key this pack always uses. */
const key = (name: string): string => `${DEVCOMPANY_PACK_ID}:${name}` as const;

export const DEVCOMPANY_MANIFEST = {
  manifestVersion: PACK_MANIFEST_VERSION,
  packId: DEVCOMPANY_PACK_ID,
  packVersion: DEVCOMPANY_PACK_VERSION,
  name: DEVCOMPANY_PACK_NAME,
  coreApi: PACK_API_VERSION,
  /** Pack-provided capabilities: none frozen by T16-01 — never invented. */
  capabilities: [],
  /** No Pack dependencies (T16-01 §12/TASK-16-02 §34). */
  dependsOn: [],
  declarations: {
    /* 1. Roles — five canonical positions; authorities are the T16-01 frozen minimal set. */
    roles: [
      {
        key: DEVCOMPANY_ROLE_KEYS.cto,
        label: 'CTO',
        authorityRefs: [
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
      },
      {
        key: DEVCOMPANY_ROLE_KEYS.developer,
        label: 'Developer',
        authorityRefs: [
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
      },
      {
        key: DEVCOMPANY_ROLE_KEYS.reviewer,
        label: 'Reviewer',
        authorityRefs: [
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
      },
      {
        key: DEVCOMPANY_ROLE_KEYS.qa,
        label: 'QA',
        authorityRefs: [
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
      },
      {
        key: DEVCOMPANY_ROLE_KEYS.documentation,
        label: 'Documentation',
        authorityRefs: [
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
      },
    ],

    /* 2. Workflow Templates — the minimal five-stage delivery chain (T16-01 §4). */
    workflowTemplates: [
      {
        key: DEVCOMPANY_WORKFLOW_KEY,
        name: 'DevCompany Delivery Cycle',
        description:
          'CTO -> Developer -> Reviewer -> QA -> Documentation. Minimal Sprint 16 chain: no retry loops, no release or CI orchestration.',
        graph: {
          nodes: [
            {
              id: 'cto',
              kind: 'work',
              title: 'CTO — requirement, workflow and acceptance',
              config: { roleId: DEVCOMPANY_ROLE_KEYS.cto },
            },
            {
              id: 'developer',
              kind: 'work',
              title: 'Developer — implementation',
              config: { roleId: DEVCOMPANY_ROLE_KEYS.developer },
            },
            {
              id: 'reviewer',
              kind: 'review',
              title: 'Reviewer — independent review',
              config: {
                roleId: DEVCOMPANY_ROLE_KEYS.reviewer,
                // Gate may not be bypassed: HIGH risk requires a human approval (规划书 §三十七).
                riskLevel: 'HIGH',
                approval: { required: true, mode: 'owner' },
              },
            },
            {
              id: 'qa',
              kind: 'validation',
              title: 'QA — real command evidence',
              config: {
                roleId: DEVCOMPANY_ROLE_KEYS.qa,
                validatorIds: [DEVCOMPANY_VALIDATOR_ID],
                // Gate may not be bypassed: HIGH risk requires a human approval (规划书 §三十七).
                riskLevel: 'HIGH',
                approval: { required: true, mode: 'owner' },
              },
            },
            {
              id: 'documentation',
              kind: 'work',
              title: 'Documentation — deliverable docs',
              config: { roleId: DEVCOMPANY_ROLE_KEYS.documentation },
            },
          ],
          edges: [
            { from: 'cto', to: 'developer' },
            { from: 'developer', to: 'reviewer' },
            { from: 'reviewer', to: 'qa' },
            { from: 'qa', to: 'documentation' },
          ],
        },
      },
    ],

    /* 3. Prompts — declarative product content (no runtime engine; T16-01 §5). */
    prompts: [
      {
        key: key('cto-prompt'),
        template:
          'Mission: understand the requirement, analyze the existing project, select or design the workflow, and define the Sprint, Task, Acceptance Criteria and Capability Requirement. Determine risk, perform final acceptance and propose SOP improvements. Hard boundary: you do NOT own continuous scheduling and must not act as a permanent orchestrator. Expected outputs: requirement analysis artifact, task/acceptance definitions, risk determination, final acceptance decision. Handoff target: developer.',
        version: null,
      },
      {
        key: key('developer-prompt'),
        template:
          'Mission: implement the accepted task — coding, UI, API, CRUD, bug fixes, ordinary refactoring, test additions and file modifications. Hard boundary: only the responsibilities above; do not redesign the workflow and do not claim review or QA conclusions. Expected outputs: implementation-change artifact with the durable evidence you produced. Evidence requirement: every claim about your change must be backed by a durable artifact. Handoff target: reviewer.',
        version: null,
      },
      {
        key: key('reviewer-prompt'),
        template:
          'Mission: review the implementation independently — code review, architecture consistency, potential bugs, boundary correctness, state consistency, concurrency, async correctness, security, missing tests and unrelated diff detection. Hard boundary: review the diff you were given and flag anything outside it; never approve your own work. Record in your report that the default model differs from the Developer default model. Expected outputs: review-report artifact with findings. Handoff target: qa.',
        version: null,
      },
      {
        key: key('qa-prompt'),
        template:
          'Mission: run tests, lint, typecheck, build, git diff and git status. Hard boundary: NEVER claim a command passed from model reasoning alone — every tests / lint / typecheck / build / git diff / git status conclusion must come from durable tool or validation evidence. Expected outputs: qa-report artifact that references the durable evidence rows. Evidence requirement: PASS requires real validator/tool evidence. Handoff target: documentation.',
        version: null,
      },
      {
        key: key('documentation-prompt'),
        template:
          'Mission: produce README, API Docs, CHANGELOG, User Guide, Technical Documentation and Decision Summary for the delivered change. Hard boundary: document what was delivered; do not modify product code. Expected outputs: documentation artifact per deliverable. Handoff target: none (terminal stage).',
        version: null,
      },
    ],

    /* 4. Tools — REQUIREMENTS over the registry (never implementations; ADR-0026). */
    tools: [
      { key: key('tool-req-tests'), toolId: DEVCOMPANY_TOOL_IDS.tests, capability: null },
      { key: key('tool-req-lint'), toolId: DEVCOMPANY_TOOL_IDS.lint, capability: null },
      { key: key('tool-req-typecheck'), toolId: DEVCOMPANY_TOOL_IDS.typecheck, capability: null },
      { key: key('tool-req-build'), toolId: DEVCOMPANY_TOOL_IDS.build, capability: null },
      { key: key('tool-req-git-diff'), toolId: DEVCOMPANY_TOOL_IDS.gitDiff, capability: null },
      { key: key('tool-req-git-status'), toolId: DEVCOMPANY_TOOL_IDS.gitStatus, capability: null },
    ],

    /* 5. Validators — QA evidence semantics (T16-01 §8). */
    validators: [{ key: key('qa-evidence-validator'), validatorId: DEVCOMPANY_VALIDATOR_ID }],

    /* 6. Artifacts — kind vocabulary only; instances are created per Run by ArtifactService. */
    artifacts: [
      { key: key('requirements-analysis'), label: 'Requirements Analysis', description: 'CTO requirement analysis and acceptance definition.' },
      { key: key('implementation-change'), label: 'Implementation Change', description: 'Developer implementation deliverable.' },
      { key: key('review-report'), label: 'Review Report', description: 'Reviewer independent review findings.' },
      { key: key('qa-report'), label: 'QA Report', description: 'QA conclusions backed by durable command evidence.' },
      { key: key('documentation'), label: 'Documentation', description: 'Documentation role deliverable.' },
    ],

    /* 7. Risk Rules — declarative minimum (the enforced gate is the stage-level config). */
    riskRules: [
      {
        key: key('gate-no-bypass'),
        riskLevel: 'HIGH',
        description:
          'Reviewer and QA gates may not be bypassed for work the delivery-cycle workflow classifies as requiring those stages; the reviewer and qa stages carry riskLevel HIGH with a required approval.',
      },
    ],

    /* 8. Capability Rules — intentionally empty (T16-01 §11). */
    capabilityRules: [],

    /* 9. Generic Templates — intentionally empty (T16-01 §11). */
    templates: [],
  },
} as const satisfies PackManifest;

/**
 * STEP 1 + STEP 4 gate: the workspace-governance rules and the single-source-of-truth
 * table must live in the entry contract (`AGENTS.md`), not only in a separate memo,
 * and the frozen priority ladder must be identical across the authoritative docs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string): string => readFileSync(repo(path), 'utf8');

const agents = read('AGENTS.md');
const governance = read('docs/WORKSPACE_GOVERNANCE.md');

const FROZEN_LADDER = {
  P0: 'Core · Workflow Lifecycle · Versioning · State · Persistence · Handoff · Recovery · Provider Abstraction · Security · Approval',
  P1: 'Model Registry · Router · Agent Runtime · Tool Registry · Validation · Risk · Memory · Decision · Artifact · DevCompany Pack',
  P2: 'Developer · Reviewer · QA · Git · Rework · Provider Failover · Desktop Workflow UI',
  P3: 'Metrics · Worktree · Parallel Agents · Workflow Optimization',
  P4: '其他 Industry Packs · Cloud · Marketplace · Team',
} as const;

describe('workspace governance (STEP 1)', () => {
  it('states the single-writer rule in AGENTS.md', () => {
    expect(agents).toContain('同一 Workspace 同一时间最多只能有一个 Writer Agent');
    expect(agents).toContain('Reviewer 默认只读');
    expect(agents).toContain('QA 默认只读');
    expect(agents).toMatch(/Git Worktree/);
    expect(agents).toContain('git reset --hard');
    expect(agents).toContain('docs/WORKSPACE_GOVERNANCE.md');
  });

  it('ships the governance document with the rule table and the drift check', () => {
    expect(existsSync(repo('docs/WORKSPACE_GOVERNANCE.md'))).toBe(true);
    for (const rule of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
      expect(governance, `rule ${rule} must be documented`).toContain(rule);
    }
    expect(governance).toContain('Compare-Object');
    expect(governance).toContain('git worktree');
  });

  it('records the decision as an ADR', () => {
    const adr = read('docs/adr/0004-single-writer-workspace.md');
    expect(adr).toMatch(/^# ADR-0004/m);
    expect(adr).toContain('Reviewer 默认只读');
    expect(adr).toMatch(/76d7bd733c7531f2ccb20d4cf29e0eb69a8312e9|写入漂移采样/);
  });
});

describe('single source of truth (STEP 4)', () => {
  it('names the authoritative document for each subject', () => {
    for (const key of [
      'PRODUCT_PLAN.md',
      'docs/ARCHITECTURE.md',
      'docs/EXECUTION_ROADMAP.md',
      'PROJECT_HANDOFF.md',
      'docs/adr/',
    ]) {
      expect(agents, `AGENTS.md §0.1 must name ${key}`).toContain(key);
    }
    expect(agents).toContain('单一真相源');
    expect(agents).toMatch(/不得自行猜测/);
  });

  it('keeps the frozen priority ladder identical in AGENTS.md, the roadmap and the reconciliation freeze', () => {
    const roadmap = read('docs/EXECUTION_ROADMAP.md');
    const reconciliation = read('docs/V1_1_RECONCILIATION.md');
    for (const [tier, scope] of Object.entries(FROZEN_LADDER)) {
      expect(agents, `AGENTS.md ${tier}`).toContain(scope);
      expect(roadmap, `EXECUTION_ROADMAP.md ${tier}`).toContain(scope);
      expect(reconciliation, `V1_1_RECONCILIATION.md ${tier}`).toContain(scope);
    }
  });

  it('does not contain the superseded 24-concept claim anywhere in the frozen docs', () => {
    for (const doc of ['AGENTS.md', 'PRODUCT_PLAN.md', 'docs/EXECUTION_ROADMAP.md']) {
      expect(read(doc), `${doc} must not assert 24 concepts`).not.toMatch(/24\s*个概念/);
    }
  });
});

describe('state layering (STEP 3B)', () => {
  it('declares the three layers in the state machine document and ADR-0003', () => {
    const stateMachine = read('docs/STATE_MACHINE.md');
    const adr = read('docs/adr/0003-state-layering.md');
    for (const source of [stateMachine, adr]) {
      expect(source).toContain('L1');
      expect(source).toContain('L2');
      expect(source).toContain('L3');
      expect(source).toContain('RECOVERING');
    }
    expect(adr).toContain('17');
    expect(stateMachine).toContain('17 态');
  });

  it('lists all 17 execution states in the state machine document', () => {
    const stateMachine = read('docs/STATE_MACHINE.md');
    for (const state of [
      'IDLE',
      'INITIALIZING',
      'DESIGNING_WORKFLOW',
      'WORKFLOW_REVIEW',
      'WORKFLOW_PUBLISHED',
      'PLANNING',
      'ROUTING',
      'WAITING_APPROVAL',
      'EXECUTING',
      'REVIEWING',
      'VALIDATING',
      'REWORK',
      'FINALIZING',
      'COMPLETED',
      'FAILED',
      'PAUSED',
      'RECOVERING',
    ]) {
      expect(stateMachine, `STATE_MACHINE.md must define ${state}`).toContain(state);
    }
  });

  it('contains no surviving trace of the superseded run-state vocabulary (HIGH-1)', () => {
    const stateMachine = read('docs/STATE_MACHINE.md');
    // The L1 machine's legacy run-state words. Note `succeeded` remains legal as a
    // *node* state (§5 NodeExecutionState) and `timed_out` as a failure *reason*,
    // so only the run-level usages are forbidden.
    for (const legacy of [
      'waiting_handoff',
      "'queued'",
      'queued | running',
      'RunState.timed_out',
      '`runs.state` | `queued',
    ]) {
      expect(
        stateMachine,
        `STATE_MACHINE.md must not use the superseded run state "${legacy}"`,
      ).not.toContain(legacy);
    }
    // The L1 value list must be the 17 frozen states.
    expect(stateMachine).toContain('`IDLE \\| INITIALIZING \\| DESIGNING_WORKFLOW');
    expect(stateMachine).toContain('RECOVERING`（17 态');
  });

  it('documents the pause/resume and rework rules that the review demanded', () => {
    const stateMachine = read('docs/STATE_MACHINE.md');
    const adr = read('docs/adr/0003-state-layering.md');
    expect(stateMachine).toContain('SM-L1-09');
    expect(stateMachine).toContain('SM-L1-10');
    expect(stateMachine).toContain('SM-L1-11');
    expect(stateMachine).toContain('resumePoint');
    expect(adr).toContain('PAUSABLE_RUN_STATES');
    expect(adr).toMatch(/maxRework/);
  });
});

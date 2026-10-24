/**
 * Sprint 1 Task 6: Artifact / Validation / Approval — the evidence and human-gate
 * layer (规划书 §三十一 / §三十二 / §三十六; 原则 7 真实结果优先).
 *
 * Review findings folded in here: BLOCKER-2 (a "pass" must carry evidence, and an
 * empty gate is NOT a pass) and MEDIUM-4 (deciding an approval requires the
 * authority token, not just a different free-text id).
 */
import { describe, expect, it } from 'vitest';

import {
  APPROVAL_AUTHORITY,
  APPROVAL_STATUSES,
  RISK_LEVELS,
  artifactsOfKind,
  blockingFailures,
  blocksExecution,
  createArtifact,
  createValidation,
  decideApproval,
  expireApproval,
  isArtifactIntact,
  isBlockingFailure,
  isContentHash,
  isExplicitConfirmation,
  qualityGatePassed,
  requestApproval,
  requiresHumanApproval,
  type Approval,
  type ApprovalDecision,
  type StageId,
  type TaskId,
  type Validation,
  type WorkflowRunId,
} from '@companyos/core';

import { expectErr, expectOk, makeIds, nowIso } from './support.js';

const runId = 'run_1' as WorkflowRunId;
const HASH = 'a'.repeat(64);

describe('Artifact', () => {
  it('records a content-addressed deliverable', () => {
    const artifact = expectOk(
      createArtifact({
        runId,
        kind: 'pack-a:report',
        contentRef: 'workspace/reports/1.md',
        contentHash: HASH,
        sizeBytes: 120,
        producedBy: 'agent_1',
        now: nowIso(),
        ids: makeIds(),
      }),
    );
    expect(artifact.kind).toBe('pack-a:report');
    expect(artifact.taskId).toBeNull();
    expect(artifact.id.startsWith('art_')).toBe(true);
    expect(isArtifactIntact(artifact, HASH)).toBe(true);
    expect(isArtifactIntact(artifact, 'b'.repeat(64))).toBe(false);
  });

  it('rejects a bad hash, a negative size and an empty ref', () => {
    const base = {
      runId,
      kind: 'k',
      contentRef: 'r',
      contentHash: HASH,
      sizeBytes: 1,
      producedBy: 'a',
      now: nowIso(),
      ids: makeIds(),
    };
    expect(expectErr(createArtifact({ ...base, contentHash: 'nope' })).code).toBe('INVALID_ARGUMENT');
    expect(expectErr(createArtifact({ ...base, sizeBytes: -1 })).code).toBe('INVALID_ARGUMENT');
    expect(expectErr(createArtifact({ ...base, contentRef: ' ' })).code).toBe('INVALID_ARGUMENT');
    expect(expectErr(createArtifact({ ...base, kind: ' ' })).code).toBe('INVALID_ARGUMENT');
    expect(isContentHash(HASH)).toBe(true);
    expect(isContentHash('A'.repeat(64))).toBe(false); // uppercase is not sha256 hex
  });

  it('filters by kind', () => {
    const make = (kind: string) =>
      expectOk(
        createArtifact({
          runId,
          kind,
          contentRef: 'r',
          contentHash: HASH,
          sizeBytes: 1,
          producedBy: 'a',
          now: nowIso(),
          ids: makeIds(),
        }),
      );
    const list = [make('a:one'), make('b:two'), make('a:one')];
    expect(artifactsOfKind(list, 'a:one')).toHaveLength(2);
  });
});

describe('Validation', () => {
  const base = {
    runId,
    validatorId: 'pack-a:unit-test',
    validatorVersion: '1.0.0',
    startedAt: nowIso(),
    ids: makeIds(),
  };

  it('records real evidence (command + exit code)', () => {
    const pass = expectOk(
      createValidation({ ...base, status: 'pass', command: 'pnpm test', exitCode: 0, blocking: true }),
    );
    expect(pass.exitCode).toBe(0);
    expect(pass.blocking).toBe(true);
    expect(pass.id.startsWith('val_')).toBe(true);
    expect(isBlockingFailure(pass)).toBe(false);
  });

  it('refuses a pass with no evidence at all (BLOCKER-2)', () => {
    const bare = createValidation({ ...base, status: 'pass' });
    expect(expectErr(bare).code).toBe('VALIDATION_FAILED');

    const bareExplicitNull = createValidation({ ...base, status: 'pass', exitCode: null as never });
    expect(bareExplicitNull.ok).toBe(false);
  });

  it('accepts a pass with an addressable evidence reference for non-command validators', () => {
    const reviewed = expectOk(
      createValidation({
        ...base,
        status: 'pass',
        evidenceRefs: ['artifact:art_1'],
        blocking: true,
      }),
    );
    expect(reviewed.exitCode).toBeNull();
    expect(reviewed.evidenceRefs).toEqual(['artifact:art_1']);
  });

  it('refuses blank or unaddressable evidence references (review finding LOW)', () => {
    for (const evidenceRefs of [[''], ['   '], ['art_1'], ['artifact:'], ['artifact:   ']]) {
      const result = createValidation({ ...base, status: 'pass', evidenceRefs, blocking: true });
      expect(result.ok, `${JSON.stringify(evidenceRefs)} must be refused`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
    // Both accepted forms work (a command may contain spaces).
    expect(createValidation({ ...base, status: 'pass', evidenceRefs: ['command:pnpm test'] }).ok).toBe(true);
    expect(createValidation({ ...base, status: 'pass', evidenceRefs: ['artifact:art_1'] }).ok).toBe(true);
  });

  it('refuses evidence that contradicts the verdict', () => {
    expect(expectErr(createValidation({ ...base, status: 'pass', exitCode: 1 })).code).toBe('INVALID_ARGUMENT');
    expect(expectErr(createValidation({ ...base, status: 'fail', exitCode: 0 })).code).toBe('INVALID_ARGUMENT');
  });

  it('fails the quality gate on a blocking failure — and on no evidence at all', () => {
    const pass = expectOk(createValidation({ ...base, status: 'pass', exitCode: 0, blocking: true }));
    const fail = expectOk(createValidation({ ...base, status: 'fail', exitCode: 1, blocking: true }));
    const advisory = expectOk(createValidation({ ...base, status: 'fail', exitCode: 1, blocking: false }));

    expect(qualityGatePassed([pass])).toBe(true);
    expect(qualityGatePassed([pass, fail])).toBe(false);
    expect(qualityGatePassed([pass, advisory])).toBe(true);
    // "No evidence" is not "passed" (review finding BLOCKER-2).
    expect(qualityGatePassed([])).toBe(false);
    expect(qualityGatePassed([advisory])).toBe(false);
    expect(blockingFailures([pass, fail, advisory])).toHaveLength(1);
  });

  it('ties a validation to a stage/task when provided', () => {
    const validation = expectOk(
      createValidation({
        ...base,
        status: 'pass',
        exitCode: 0,
        stageId: 'stg_1' as StageId,
        taskId: 'tsk_1' as TaskId,
      }),
    );
    expect(validation.stageId).toBe('stg_1');
    expect(validation.taskId).toBe('tsk_1');
  });

  it('keeps the blocking/advisory distinction queryable', () => {
    const advisory = expectOk(createValidation({ ...base, status: 'error', blocking: false }));
    const blocking = expectOk(createValidation({ ...base, status: 'error', blocking: true }));
    const all: readonly Validation[] = [advisory, blocking];
    expect(isBlockingFailure(advisory)).toBe(false);
    expect(blockingFailures(all)).toEqual([blocking]);
  });
});

describe('Approval', () => {
  const request = (riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL') =>
    requestApproval({
      runId,
      riskLevel,
      reason: 'schema migration on production data',
      requestedBy: 'chief_1',
      now: nowIso(),
      ids: makeIds(),
    });

  const decide = (_approval: Approval, overrides: Partial<ApprovalDecision> = {}): ApprovalDecision => ({
    decidedBy: 'user_owner',
    decidedAt: nowIso(2),
    approved: true,
    authorities: [APPROVAL_AUTHORITY],
    ...overrides,
  });

  it('only exists for HIGH and CRITICAL risk', () => {
    expect([...RISK_LEVELS]).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    expect(requiresHumanApproval('LOW')).toBe(false);
    expect(requiresHumanApproval('MEDIUM')).toBe(false);
    expect(requiresHumanApproval('HIGH')).toBe(true);
    expect(requiresHumanApproval('CRITICAL')).toBe(true);

    expect(expectErr(request('LOW')).code).toBe('POLICY_DENIED');
    expect(expectErr(request('MEDIUM')).code).toBe('POLICY_DENIED');
    expect(expectOk(request('HIGH')).status).toBe('pending');
    expect(expectOk(request('CRITICAL')).status).toBe('pending');
  });

  it('requires the approval authority, not merely a different id (MEDIUM-4)', () => {
    const pending = expectOk(request('HIGH'));
    const noAuthority = decideApproval(pending, decide(pending, { authorities: [] }));
    expect(expectErr(noAuthority).code).toBe('POLICY_DENIED');

    const wrongAuthority = decideApproval(pending, decide(pending, { authorities: ['run.review'] }));
    expect(expectErr(wrongAuthority).code).toBe('POLICY_DENIED');

    const selfDecision = decideApproval(pending, decide(pending, { decidedBy: 'chief_1' }));
    expect(expectErr(selfDecision).code).toBe('POLICY_DENIED');
  });

  it('decides once, and only from a pending state', () => {
    const pending = expectOk(request('HIGH'));
    const approved = expectOk(decideApproval(pending, decide(pending)));
    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toBe('user_owner');
    expect(blocksExecution(approved)).toBe(false);

    expect(expectErr(decideApproval(approved, decide(approved, { approved: false }))).code).toBe('CONFLICT');
    expect(expectErr(expireApproval(approved, nowIso(4))).code).toBe('CONFLICT');
  });

  it('treats a rejected or expired request as a block, and CRITICAL as explicit confirmation', () => {
    const rejected = expectOk(
      decideApproval(expectOk(request('HIGH')), decide(expectOk(request('HIGH')), { approved: false })),
    );
    expect(rejected.status).toBe('rejected');
    expect(blocksExecution(rejected)).toBe(true);

    const pending = expectOk(request('HIGH'));
    const expired = expectOk(expireApproval(pending, nowIso(1)));
    expect(expired.status).toBe('expired');
    expect(blocksExecution(expired)).toBe(true);

    const criticalPending = expectOk(request('CRITICAL'));
    const critical = expectOk(decideApproval(criticalPending, decide(criticalPending)));
    expect(isExplicitConfirmation(critical)).toBe(false); // needs an attributable note

    const critical2 = expectOk(request('CRITICAL'));
    const explicit = expectOk(
      decideApproval(critical2, decide(critical2, { note: 'confirmed by the owner out-of-band' })),
    );
    expect(isExplicitConfirmation(explicit)).toBe(true);
    expect([...APPROVAL_STATUSES]).toEqual(['pending', 'approved', 'rejected', 'expired']);
  });

  it('requires a reason', () => {
    expect(
      expectErr(
        requestApproval({ runId, riskLevel: 'HIGH', reason: '   ', requestedBy: 'u', now: nowIso(), ids: makeIds() }),
      ).code,
    ).toBe('INVALID_ARGUMENT');
  });
});

/**
 * AUDIT-RUN7-2 (v0.1.1 acceptance run 7, hark-live-goal 41641255275): the run passed VALIDATING with two
 * BLOCKING repo.test-check rows in status=error. Root cause: the evidence applicator decided the gate from
 * the stage of the NEWEST validation row only (the CHANGES.md stage, whose sole required validator is
 * evidence.grounding-check -> pass) and never looked at the other stages' failing repo.test-check rows,
 * although the supervisor context (latestValidationPerValidator over the whole run) saw them. The run
 * reached FINALIZING over failed validation, the supervisor then asked for corrective work in FINALIZING
 * (no legal way back to EXECUTING), and the run was delivered with the reassessment task still PENDING.
 * The gate now uses the SAME run-wide latest-row-per-validator derivation as the supervisor context.
 */
import { describe, expect, it } from 'vitest';

import { createEvidenceLifecycleApplicator } from '../src/supervisor/evidence-lifecycle.js';

type Row = { id: string; validatorId: string; status: string; stageId: string | null; targetRef: string | null };

const harness = (rows: Row[], requiredByStage: Record<string, string[]>, consumed: string[] = []) => {
  const dispatched: { type: string; payload?: Readonly<Record<string, unknown>> }[] = [];
  let state = 'VALIDATING';
  const applicator = createEvidenceLifecycleApplicator({
    runs: { get: async (id) => ({ id, state, revision: 6 }) },
    engine: {
      dispatch: async (command) => {
        dispatched.push({ type: command.type, ...(command.payload === undefined ? {} : { payload: command.payload }) });
        state = command.type === 'VALIDATION.PASS' ? 'FINALIZING' : 'REWORK';
        return { ok: true };
      },
    },
    readers: {
      getLatestReviewReport: async () => ({ ok: true, value: null }),
      listValidations: async () => rows,
      requiredValidators: async ({ stageId }) => ({ ok: true, value: requiredByStage[stageId] ?? [] }),
      correctiveCauseIds: async () => consumed,
    },
    clock: { nowIso: () => '2026-11-03T13:13:00.000Z' },
    ids: { id: (p?: string) => `${p ?? 'id'}_1` },
  });
  return { applicator, dispatched };
};

// newest first, exactly the run-7 shape: stage C (CHANGES.md) grounding pass is the newest row.
const run7Rows: Row[] = [
  { id: 'val_C_ground', validatorId: 'evidence.grounding-check', status: 'pass', stageId: 'stg_C', targetRef: 'artifact:art_C' },
  { id: 'val_B_test', validatorId: 'repo.test-check', status: 'error', stageId: 'stg_B', targetRef: 'artifact:art_B' },
  { id: 'val_B_ground', validatorId: 'evidence.grounding-check', status: 'pass', stageId: 'stg_B', targetRef: 'artifact:art_B' },
  { id: 'val_A_test', validatorId: 'repo.test-check', status: 'error', stageId: 'stg_A', targetRef: 'artifact:art_A' },
  { id: 'val_A_ground', validatorId: 'evidence.grounding-check', status: 'pass', stageId: 'stg_A', targetRef: 'artifact:art_A' },
];
const required = {
  stg_A: ['repo.test-check', 'evidence.grounding-check'],
  stg_B: ['repo.test-check', 'evidence.grounding-check'],
  stg_C: ['evidence.grounding-check'],
};

describe('AUDIT-RUN7-2 the validation gate covers every stage of the run', () => {
  it('a blocking failure on an earlier stage fails the gate even when the newest stage passes', async () => {
    const h = harness(run7Rows, required);
    const applied = await h.applicator.applyEvidence({ companyId: 'c', runId: 'run_1', actorId: 'user_owner' });
    expect(applied.ok).toBe(true);
    expect(h.dispatched.map((d) => d.type)).toEqual(['VALIDATION.FAIL']);
  });

  it('a consumed failure (corrective already cites it) waits for re-validation instead of passing', async () => {
    const h = harness(run7Rows, required, ['val_B_test']);
    const applied = await h.applicator.applyEvidence({ companyId: 'c', runId: 'run_1', actorId: 'user_owner' });
    expect(applied.ok && applied.value).toBe(null);
    expect(h.dispatched).toEqual([]);
  });

  it('all stages passing still passes, anchored on the newest row', async () => {
    const rows = run7Rows.map((row) => ({ ...row, status: 'pass' }));
    const h = harness(rows, required);
    const applied = await h.applicator.applyEvidence({ companyId: 'c', runId: 'run_1', actorId: 'user_owner' });
    expect(applied.ok).toBe(true);
    expect(h.dispatched).toEqual([{ type: 'VALIDATION.PASS', payload: { artifactId: 'art_C', stageId: 'stg_C' } }]);
  });

  it('a newer re-validation of the same validator supersedes the older failure', async () => {
    const rows: Row[] = [
      { id: 'val_B_test2', validatorId: 'repo.test-check', status: 'pass', stageId: 'stg_B', targetRef: 'artifact:art_B2' },
      ...run7Rows,
    ];
    const h = harness(rows, required);
    await h.applicator.applyEvidence({ companyId: 'c', runId: 'run_1', actorId: 'user_owner' });
    expect(h.dispatched.map((d) => d.type)).toEqual(['VALIDATION.PASS']);
  });
});

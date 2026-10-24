import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FixedClock } from '@companyos/core';
import { EVIDENCE_GROUNDING_SPEC, createEvidenceGroundingPort } from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';
import { describe, expect, it } from 'vitest';

/* ------------------- deterministic corrective fixture (FINAL-P1) ------------------ */

const EPOCH = Date.parse('2026-10-05T00:00:00.000Z');

const makeGroundingHarness = (workspaceFiles: Readonly<Record<string, string>>, artifactText: string) => {
  const root = mkdtempSync(join(tmpdir(), 'companyos-grounding-'));
  for (const [name, content] of Object.entries(workspaceFiles)) {
    const full = join(root, ...name.split('/'));
    if (name.includes('/')) mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  const port = createEvidenceGroundingPort(EVIDENCE_GROUNDING_SPEC, {
    workspace: () => ({ canonicalRoot: root }),
    artifactContent: async () => new TextEncoder().encode(artifactText),
    clock: { nowIso: () => new Date(EPOCH).toISOString() },
  });
  const invoke = async () => {
    const result = await port.invoke({
      scope: null,
      idempotencyKey: null,
      input: {
        targetRef: 'artifact:art_1',
        artifactId: 'art_1',
        runId: 'run_1',
        kind: 'text/markdown',
        contentRef: `sha256:${'a'.repeat(64)}`,
        contentHash: 'a'.repeat(64),
        sizeBytes: artifactText.length,
      },
    } as never);
    return result;
  };
  return { invoke, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

describe('FINAL-P1-07..12/15..17/23 corrective lifecycle (deterministic)', () => {
  it('a planted defect: grounding FAIL row is the initial validation; corrected artifact re-validated independently to PASS', async () => {
    // 1. the validator FAILS a planted unsupported data row (the initial validation).
    const workspace = {
      'data.csv': 'sensor_id,reading,status\nS-101,42.5,OK\nS-103,51.0,DEGRADED\n',
    };
    const badReport = 'The dataset `data.csv` includes:\n\nS-103,51.0,DEGRADED\nS-999,12.3,OK\n';
    const h = makeGroundingHarness(workspace, badReport);
    try {
      const first = await h.invoke();
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const firstVerdict = (first.value.output as { verdict: string }).verdict;
      expect(firstVerdict).toBe('fail');

      // 2. the SAME validator id is the re-validation authority (independence preserved:
      //    it is a separate verifier tool, never the implementation attempt).
      const correctedReport = badReport.replace('S-999,12.3,OK\n', '');
      const h2 = makeGroundingHarness(workspace, correctedReport);
      try {
        const second = await h2.invoke();
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        const secondVerdict = (second.value.output as { verdict: string }).verdict;
        expect(secondVerdict).toBe('pass');
      } finally {
        h2.cleanup();
      }
    } finally {
      h.cleanup();
    }
  });

  it('FINAL-P1-07 the corrective provisioner resolves a VALIDATION_FAILED cause from the failing validation row', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'companyos-corrfix-'));
    const clock = new FixedClock(EPOCH);
    const db = openDurableDatabase({
      dataDir,
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine', 'lifecycle', 'artifact', 'registry', 'selection'],
    });
    try {
      await db.runs.put({
        id: 'run_c', companyId: 'company_default', workflowId: 'wf', templateId: 'tpl',
        versionId: 'ver_1', snapshotId: 'snp_1', state: 'EXECUTING', revision: 8,
        reworkCount: 1, maxRework: 3, failureReason: null, resumePoint: null,
        history: [], createdAt: clock.nowIso(), updatedAt: clock.nowIso(), startedBy: 'user_owner',
      } as never);
      await db.tasks.put({
        id: 'tsk_work', runId: 'run_c', stageId: 'stg_work', roleId: 'rol' as never, kind: 'companyos:work',
        state: 'DONE', attempts: 1, maxAttempts: 3, inputs: {}, outputs: { artifactIds: ['art_target'] },
        createdAt: clock.nowIso(), updatedAt: clock.nowIso(), startedBy: 'user_owner',
      } as never);
      const validationStore = db.validationStore as unknown as {
        record: (row: unknown, creation: { creationCommandId: string; creationCommandFingerprint: string }) => Promise<void>;
      };
      await validationStore.record(
        {
          id: 'val_c1', runId: 'run_c', stageId: 'stg_work', taskId: null,
          validatorId: 'evidence.grounding-check', validatorVersion: '1.0.0', status: 'fail',
          command: 'tool:evidence.grounding-check', exitCode: null, blocking: true,
          evidenceRefs: ['artifact:art_target'], startedAt: clock.nowIso(), finishedAt: clock.nowIso(),
          targetRef: 'artifact:art_target',
        },
        { creationCommandId: 'cmd_val_c1', creationCommandFingerprint: 'fp_val_c1' },
      );

      const { createCorrectiveProvisioner } = await import('@companyos/engine');
      const provisioner = createCorrectiveProvisioner({
        runs: db.runs as never,
        tasks: db.tasks as never,
        templates: {
          get: async (id: string) => ({
            id, orgId: 'company_default', name: 'tpl', state: 'PUBLISHED',
            currentVersionId: 'ver_1',
            versions: [{ id: 'ver_1', graph: { nodes: [{ id: 'stg_work', kind: 'work', config: {} }], edges: [] } }] as unknown as readonly { id: string; graph: { nodes: { id: string; kind: string; config: Record<string, unknown> }[]; edges: unknown[] } }[],
          }),
        } as never,
        decisions: {
          get: async () => ({
            decisionId: 'dec_c', version: 1, status: 'ACTIVE',
            metadata: {
              supervisor: {
                runId: 'run_c', action: 'REQUEST_CORRECTIVE', reasonCode: 'VALIDATION_FAILED',
                validationId: 'val_c1',
                evidenceRefs: [
                  { kind: 'validation', ref: 'val_c1' },
                  { kind: 'artifact', ref: 'artifact:art_target' },
                ],
              },
            },
          }),
          listVersions: async () => [
            {
              decisionId: 'dec_c', version: 1, companyId: 'company_default', status: 'ACTIVE',
              metadata: {
                supervisor: {
                  runId: 'run_c', action: 'REQUEST_CORRECTIVE', reasonCode: 'VALIDATION_FAILED',
                  evidenceRefs: [
                    { kind: 'validation', ref: 'val_c1' },
                    { kind: 'artifact', ref: 'artifact:art_target' },
                  ],
                },
              },
            },
          ],
        } as never,
        artifacts: db.artifactStore as never,
        content: { get: async () => new TextEncoder().encode('{}') },
        validations: {
          get: async (id: string) =>
            id === 'val_c1'
              ? { status: 'fail', runId: 'run_c', stageId: 'stg_work', targetRef: 'artifact:art_target' }
              : null,
        },
        runSnapshot: {
          verify: async () => ({ ok: true, value: true }),
        },
        // (the runSnapshotVerifier stub above already authorizes; the versions.find error
        // comes from the sprint13 verifier used inside provision — covered by the stub below)
        unitOfWork: db.unitOfWork,
        clock: { nowIso: () => clock.nowIso() },
        ids: { id: (prefix: string) => `${prefix}_x` },
      } as never);
      const provisioned = await provisioner.provision({
        companyId: 'company_default', runId: 'run_c', decisionId: 'dec_c', decisionVersion: 1,
        actorId: 'user_owner',
      });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) return;
      const task = await db.tasks.get(provisioned.value.taskId as never);
      expect(task).not.toBeNull();
      const lineage = (task!.inputs as { corrective?: { parentTaskId: string; round: number } }).corrective;
      expect(lineage?.parentTaskId).toBe('tsk_work');
      expect(lineage?.round).toBe(1);
    } finally {
      db.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('FINAL-P1-23 the corrective round limit is enforced at the provisioning boundary (maxCorrectiveRounds honored)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'companyos-corrlim-'));
    const clock = new FixedClock(EPOCH);
    const db = openDurableDatabase({
      dataDir, appliedAt: clock.nowIso(), chains: ['core', 'engine', 'lifecycle', 'artifact', 'registry', 'selection'],
    });
    try {
      await db.runs.put({
        id: 'run_l', companyId: 'company_default', workflowId: 'wf', templateId: 'tpl',
        versionId: 'ver_1', snapshotId: 'snp_1', state: 'REWORK', revision: 9,
        reworkCount: 3, maxRework: 3, failureReason: null, resumePoint: null,
        history: [], createdAt: clock.nowIso(), updatedAt: clock.nowIso(), startedBy: 'user_owner',
      } as never);
      await db.tasks.put({
        id: 'tsk_l0', runId: 'run_l', stageId: 'stg_work', roleId: 'rol' as never, kind: 'companyos:work',
        state: 'DONE', attempts: 1, maxAttempts: 3,
        inputs: {
          corrective: {
            schemaVersion: 'companyos/corrective-task/1', companyId: 'company_default', runId: 'run_l',
            originDecisionId: 'dec_0', originDecisionVersion: 1, reasonCode: 'VALIDATION_FAILED',
            parentTaskId: 'tsk_l0', rootTaskId: 'tsk_l0', round: 5, causeEvidenceRefs: [],
            fingerprint: 'fp',
          },
        },
        outputs: { artifactIds: ['art_t'] }, createdAt: clock.nowIso(), updatedAt: clock.nowIso(), startedBy: 'user_owner',
      } as never);
      const { createCorrectiveProvisioner } = await import('@companyos/engine');
      const provisioner = createCorrectiveProvisioner({
        runs: db.runs as never, tasks: db.tasks as never,
        templates: {
          get: async (id: string) => ({
            id, orgId: 'company_default', name: 'tpl', state: 'PUBLISHED',
            currentVersionId: 'ver_1',
            versions: [{ id: 'ver_1', graph: { nodes: [{ id: 'stg_work', kind: 'work', config: {} }], edges: [] } }],
          }),
        } as never,
        decisions: {
          get: async () => ({
            decisionId: 'dec_l', version: 1, status: 'ACTIVE',
            metadata: {
              supervisor: {
                runId: 'run_l', action: 'REQUEST_CORRECTIVE', reasonCode: 'VALIDATION_FAILED',
                validationId: 'val_l',
                evidenceRefs: [
                  { kind: 'validation', ref: 'val_l' },
                  { kind: 'artifact', ref: 'artifact:art_target' },
                ],
              },
            },
          }),
          listVersions: async () => [
            {
              decisionId: 'dec_l', version: 1, companyId: 'company_default', status: 'ACTIVE',
              metadata: {
                supervisor: {
                  runId: 'run_l', action: 'REQUEST_CORRECTIVE', reasonCode: 'VALIDATION_FAILED',
                  validationId: 'val_l',
                  evidenceRefs: [
                    { kind: 'validation', ref: 'val_l' },
                    { kind: 'artifact', ref: 'artifact:art_target' },
                  ],
                },
              },
            },
          ],
        } as never,
        artifacts: db.artifactStore as never,
        content: { get: async () => new TextEncoder().encode('{}') },
        validations: { get: async () => ({ status: 'fail', runId: 'run_l', stageId: 'stg_work', targetRef: 'artifact:art_t' }) },
        runSnapshot: { verify: async () => ({ ok: true, value: true }) },
        unitOfWork: db.unitOfWork,
        clock: { nowIso: () => clock.nowIso() },
        ids: { id: (prefix: string) => `${prefix}_x` },
        maxCorrectiveRounds: 0,
      } as never);
      const provisioned = await provisioner.provision({
        companyId: 'company_default', runId: 'run_l', decisionId: 'dec_l', decisionVersion: 1,
        actorId: 'user_owner',
      });
      expect(provisioned.ok).toBe(false);
      if (provisioned.ok) return;
      expect(String((provisioned.error.details as { reason?: string }).reason)).toBe(
        'CORRECTIVE_ROUND_LIMIT_EXCEEDED',
      );
    } finally {
      db.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/**
 * Sprint 13 / Task-13-07: evidence-backed VALIDATION_PASSED (ADR-0020 R1-B + R2-B).
 *
 * Real SQLite (12 chains), real ArtifactService targets, real ValidationService batches,
 * real evidence guard, and the real WorkflowEngine seam. Covers the full §36–§48 matrix
 * plus the twelve §38 lock-ins.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createWorkflowRun,
  ok,
  artifactTargetRef,
  type ArtifactContentStore,
  type DomainError,
  type ToolPort,
  type ToolRegistryPort,
} from '@companyos/core';
import {
  createArtifactService,
  createToolRegistry,
  createValidationEvidenceGuard,
  createValidationService,
  createValidatorResolver,
  createWorkflowEngine,
  type EvidenceGateInput,
  type GateStagePolicy,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';

const created: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
const clock = { now: (): number => Date.parse('2026-01-01T00:00:00.000Z'), nowIso: (): string => '2026-01-01T00:00:00.000Z' };
const ids = (() => {
  let n = 0;
  return { id: (prefix = 'id') => `${prefix}_01JT18${String(++n).padStart(4, '0')}`, ulid: () => `01JT18${String(++n).padStart(20, '0')}` };
})();
const ACTOR = 'user_owner';
const allow = async (): Promise<{ readonly ok: true; readonly value: true }> => ok(true);

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Deterministic scripted validator adapter (pass verdict; matrix rows are seeded directly). */
const verdictTool = (): ToolPort => ({
  describe: () => ({ toolId: 'x', name: 'x', description: 'x', version: '1.0.0', riskLevel: 'LOW', parameters: {}, capabilities: [], inputSchema: {}, outputSchema: {} }),
  invoke: async () => ({
    ok: true as const,
    value: { status: 'ok' as const, output: { verdict: 'pass', evidenceRefs: [] }, artifactRefs: [], startedAt: clock.nowIso(), finishedAt: clock.nowIso(), latencyMs: 1 },
  }),
});

interface Harness {
  /** The artifact most recently created via target() — the seeding anchor. */
  targetId?: string;
  readonly db: DurableDatabase;
  readonly guard: ReturnType<typeof createValidationEvidenceGuard>;
  readonly validationService: ReturnType<typeof createValidationService>;
  readonly artifactService: ReturnType<typeof createArtifactService>;
  readonly registry: ToolRegistryPort;
  readonly runId: string;
  readonly stageId: string;
  target(overrides?: { readonly runId?: string }): Promise<{ readonly id: string }>;
  policy: { required: readonly string[] };
  seedBatch(commandId: string, entries: readonly { validatorId: string; status: 'pass' | 'fail' | 'error' | 'skipped'; blocking: boolean }[], options?: { readonly finishedAt?: string; readonly stageId?: string | null }): Promise<readonly string[]>;
}

const make = async (): Promise<Harness> => {
  const db = openDurableDatabase({
    dataDir: tempDir('companyos-t19-'),
    appliedAt: clock.nowIso(),
    chains: ['core', 'engine', 'artifact', 'tools', 'lifecycle'],
  });
  database = db;
  const contentStore: ArtifactContentStore = createFilesystemArtifactContentStore({ casRoot: tempDir('companyos-t19-cas-') });

  // Two validator tools with switchable verdict/blocking via direct row control in seedBatch.
  const unitTool = verdictTool();
  const lintTool = verdictTool();
  const registry = createToolRegistry({
    ids, clock,
    records: db.toolRecords, invocations: db.toolInvocations, invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map([['val.unit', unitTool], ['val.lint', lintTool]]),
    authorize: allow, events: db.events, secrets: async () => [],
    timer: (ms: number, onTimeout: () => void) => { const t = setTimeout(onTimeout, ms); return () => clearTimeout(t); },
    ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
    ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
  } as never);
  for (const toolId of ['val.unit', 'val.lint']) {
    const record = (await import('@companyos/core')).createToolRecord({
      toolId, name: toolId, description: `validator ${toolId}`, version: '1.0.0',
      capabilities: [(await import('@companyos/core')).TOOL_CAPABILITY_VALIDATOR],
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      riskLevel: 'LOW', idempotencyMode: 'IDEMPOTENT_KEY', adapterRef: toolId, now: clock.nowIso(),
    });
    expect(record.ok).toBe(true);
    if (record.ok) expect((await registry.register(record.value, { actorId: ACTOR })).ok).toBe(true);
  }

  const artifactService = createArtifactService({
    artifactStore: db.artifactStore!, contentStore, runs: db.runs, events: db.events,
    ledger: db.ledger, clock, ids, unitOfWork: db.unitOfWork, authorize: allow,
  });
  const validationService = createValidationService({
    resolver: createValidatorResolver({ registry }), registry,
    validationStore: db.validationStore!, artifactService, artifactStore: db.artifactStore!,
    events: db.events, ledger: db.ledger, clock, ids, unitOfWork: db.unitOfWork, authorize: allow,
  });

  const seedRun = createWorkflowRun({
    companyId: 'cmp_1' as never, workflowId: 'wfl_1' as never, templateId: 'tpl_1' as never,
    versionId: 'ver_1' as never, snapshotId: 'snp_1' as never, startedBy: ACTOR, now: clock.nowIso(), ids,
  });
  expect(seedRun.ok).toBe(true);
  if (!seedRun.ok) throw new Error('seed');
  await db.runs.put(seedRun.value);

  const stageId = 'stg_gate_1';
  const policy = { required: ['val.unit', 'val.lint'] as readonly string[] };
  const stagePolicy: GateStagePolicy = {
    requiredValidators: async () => ok([...policy.required]),
  };
  const guard = createValidationEvidenceGuard({
    artifactStore: db.artifactStore!,
    validationStore: db.validationStore!,
    stagePolicy,
  });

  const h: Harness = {
    db, guard, validationService, artifactService, registry,
    runId: seedRun.value.id, stageId, policy,
    async target(overrides) {
      const made = await artifactService.create({
        commandId: `cmd_target_${ids.id('t')}`, runId: (overrides?.runId ?? seedRun.value.id) as never,
        kind: 'pack-x:doc', content: new TextEncoder().encode('target'), producedBy: 'agent:agt_1', traceId: 'trace_t',
      });
      expect(made.ok).toBe(true);
      if (!made.ok) throw new Error('target');
      return { id: made.value.id };
    },
    async seedBatch(commandId, entries, options) {
      // Direct durable rows (bypassing the tool runtime) for deterministic matrix setup:
      const { createValidation } = await import('@companyos/core');
      const validationIds: string[] = [];
      const fingerprint = `fp:${commandId}`;
      const finishedAt = options?.finishedAt ?? `2026-01-01T00:00:${String(10 + (seedCounter += 1)).padStart(2, '0')}.000Z`;
      for (const entry of entries) {
        const made = createValidation({
          runId: h.runId as never, stageId: (options?.stageId === undefined ? stageId : options.stageId) as never,
          validatorId: entry.validatorId, validatorVersion: '1.0.0', status: entry.status,
          blocking: entry.blocking, evidenceRefs: ['command:seed'], startedAt: finishedAt, finishedAt,
          targetRef: artifactTargetRef(h.targetId ?? ''), ids,
        });
        expect(made.ok).toBe(true);
        if (!made.ok) continue;
        await db.validationStore!.record(made.value, { creationCommandId: commandId, creationCommandFingerprint: fingerprint });
        validationIds.push(made.value.id);
      }
      void fingerprint;
      return validationIds;
    },
  };
  let seedCounter = 0;
  // target binding for seedBatch: set per-test via a mutable field
  const harness = h as Harness & { targetId?: string };
  const origTarget = h.target.bind(h);
  h.target = async (overrides) => {
    const t = await origTarget(overrides);
    (h as Harness & { targetId?: string }).targetId = t.id;
    return t;
  };
  return harness;
};

const gate = (h: Harness, artifactId: string, overrides: Partial<EvidenceGateInput> = {}) =>
  h.guard.evaluateGate({ runId: h.runId, stageId: h.stageId, artifactId, ...overrides });

const reasonOf = (error: DomainError): string | undefined =>
  (error as DomainError & { details?: { reason?: string } }).details?.reason;

describe('evidence guard — happy path & requirements (§36/§37/§38)', () => {
  it('required V1+V2 blocking PASS in the latest batch → gate passes', async () => {
    const h = await make();
    const t = await h.target();
    await h.seedBatch('cmd_b1', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'pass', blocking: true },
    ]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.value.creationCommandId).toBe('cmd_b1');
      expect(verdict.value.requiredRows.map((r) => r.validatorId).sort()).toEqual(['val.lint', 'val.unit']);
    }
  });

  it('missing required validator (V1 PASS, V2 absent) → reject', async () => {
    const h = await make();
    const t = await h.target();
    await h.seedBatch('cmd_b1', [{ validatorId: 'val.unit', status: 'pass', blocking: true }]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_INCOMPLETE');
  });

  it('blocking FAIL → reject', async () => {
    const h = await make();
    const t = await h.target();
    await h.seedBatch('cmd_b1', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'fail', blocking: true },
    ]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_FAILED');
  });

  it('blocking ERROR → reject (a crashed validator is never a warning)', async () => {
    const h = await make();
    const t = await h.target();
    await h.seedBatch('cmd_b1', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'error', blocking: true },
    ]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_FAILED');
  });

  it('blocking SKIPPED → reject (qualityGatePassed semantics reused)', async () => {
    const h = await make();
    const t = await h.target();
    await h.seedBatch('cmd_b1', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'skipped', blocking: true },
    ]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_FAILED');
  });

  it('non-blocking FAIL of a NON-required validator does not decide the gate (§31)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'fail', blocking: false },
    ]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(true);
  });

  it('a non-required BLOCKING FAIL also lacks stage authority (§32)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'fail', blocking: true },
    ]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(true);
  });

  it('required validator with row blocking=false → POLICY MISMATCH fail closed (§3/§42/Case B)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [{ validatorId: 'val.unit', status: 'pass', blocking: false }]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_POLICY_MISMATCH');
  });

  it('required validator FAIL with row blocking=false → still reject (§30 Case C: policy covers the row)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [{ validatorId: 'val.unit', status: 'fail', blocking: false }]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_POLICY_MISMATCH');
  });

  it('empty stage validatorIds → gate cannot pass on no evidence (§5 ruling)', async () => {
    const h = await make();
    h.policy.required = [];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [{ validatorId: 'val.unit', status: 'pass', blocking: true }]);
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_NO_REQUIREMENTS');
  });
});

describe('evidence guard — target/run/stage anchors (§39/§40/§22/§23)', () => {
  it('wrong artifact: A has PASS evidence, B has none → B rejected (no reuse)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    await h.target();
    await h.seedBatch('cmd_b1', [{ validatorId: 'val.unit', status: 'pass', blocking: true }]);
    const b = await h.target();
    const verdict = await gate(h, b.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_NO_EVIDENCE');
  });

  it('wrong run: artifact belongs to another run → fail closed before evidence', async () => {
    const h = await make();
    const otherRun = createWorkflowRun({
      companyId: 'cmp_1' as never, workflowId: 'wfl_2' as never, templateId: 'tpl_1' as never,
      versionId: 'ver_1' as never, snapshotId: 'snp_2' as never, startedBy: ACTOR, now: clock.nowIso(), ids,
    });
    expect(otherRun.ok).toBe(true);
    if (!otherRun.ok) return;
    await h.db.runs.put(otherRun.value);
    const foreign = await h.target({ runId: otherRun.value.id });
    const verdict = await gate(h, foreign.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_WRONG_RUN');
  });

  it('missing artifact → NOT_FOUND', async () => {
    const h = await make();
    const verdict = await gate(h, 'art_01JT18MISSING0000000000000000ZZ');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('NOT_FOUND');
  });

  it('legacy stageId=null rows are NOT eligible for a staged gate (§22)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [{ validatorId: 'val.unit', status: 'pass', blocking: true }], { stageId: null });
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_NO_ELIGIBLE_BATCH');
  });

  it('task anchor: when provided, rows must match exactly (null is not a wildcard)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [{ validatorId: 'val.unit', status: 'pass', blocking: true }]);
    const mismatch = await gate(h, t.id, { taskId: 'tsk_other' as never });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(reasonOf(mismatch.error)).toBe('VALIDATION_GATE_NO_ELIGIBLE_BATCH');
  });
});

describe('evidence guard — R2-B batch selection (§43/§44/§27/§28/§29)', () => {
  it('new FAIL overrides old PASS (no fallback to an older passing batch)', async () => {
    const h = await make();
    h.policy.required = ['val.unit', 'val.lint'];
    const t = await h.target();
    await h.seedBatch('cmd_old', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'pass', blocking: true },
    ], { finishedAt: '2026-01-01T00:00:01.000Z' });
    await h.seedBatch('cmd_new', [
      { validatorId: 'val.unit', status: 'fail', blocking: true },
      { validatorId: 'val.lint', status: 'pass', blocking: true },
    ], { finishedAt: '2026-01-01T00:00:02.000Z' });
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_FAILED');
  });

  it('new PASS overrides old FAIL (intentional re-validation recovery)', async () => {
    const h = await make();
    h.policy.required = ['val.unit', 'val.lint'];
    const t = await h.target();
    await h.seedBatch('cmd_old', [
      { validatorId: 'val.unit', status: 'fail', blocking: true },
      { validatorId: 'val.lint', status: 'pass', blocking: true },
    ], { finishedAt: '2026-01-01T00:00:01.000Z' });
    await h.seedBatch('cmd_new', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'pass', blocking: true },
    ], { finishedAt: '2026-01-01T00:00:02.000Z' });
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.creationCommandId).toBe('cmd_new');
  });

  it('latest INCOMPLETE batch does NOT fall back to an older complete PASS (§11)', async () => {
    const h = await make();
    h.policy.required = ['val.unit', 'val.lint'];
    const t = await h.target();
    await h.seedBatch('cmd_old', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'pass', blocking: true },
    ], { finishedAt: '2026-01-01T00:00:01.000Z' });
    await h.seedBatch('cmd_new', [{ validatorId: 'val.unit', status: 'pass', blocking: true }], { finishedAt: '2026-01-01T00:00:02.000Z' });
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_INCOMPLETE');
  });

  it('no cross-batch Frankenstein PASS (V1@B1 + V2@B2 never compose)', async () => {
    const h = await make();
    h.policy.required = ['val.unit', 'val.lint'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'fail', blocking: true },
    ], { finishedAt: '2026-01-01T00:00:01.000Z' });
    await h.seedBatch('cmd_b2', [
      { validatorId: 'val.unit', status: 'fail', blocking: true },
      { validatorId: 'val.lint', status: 'pass', blocking: true },
    ], { finishedAt: '2026-01-01T00:00:02.000Z' });
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_FAILED');
  });

  it('same finishedAt tie → max(validationId) deterministically decides the winner (§29)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    const sameTime = '2026-01-01T00:00:05.000Z';
    const first = await h.seedBatch('cmd_t1', [{ validatorId: 'val.unit', status: 'fail', blocking: true }], { finishedAt: sameTime });
    const second = await h.seedBatch('cmd_t2', [{ validatorId: 'val.unit', status: 'pass', blocking: true }], { finishedAt: sameTime });
    // Deterministic regardless of insertion order: the batch holding the LARGER max
    // validationId is the winner. Assert which one that is and that the verdict agrees.
    const winnerIsSecond = second[0]! > first[0]!;
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(winnerIsSecond);
    if (verdict.ok) expect(verdict.value.creationCommandId).toBe('cmd_t2');
    else if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_FAILED');
    // Re-run in the opposite insertion order is impossible here (rows are durable),
    // but the ordering inputs are content-derived, not query-order derived.
  });

  it('historical PASS alone is never sufficient (§44)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_old', [{ validatorId: 'val.unit', status: 'pass', blocking: true }], { finishedAt: '2026-01-01T00:00:01.000Z' });
    await h.seedBatch('cmd_new', [{ validatorId: 'val.unit', status: 'fail', blocking: true }], { finishedAt: '2026-01-01T00:00:02.000Z' });
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
  });
});

describe('engine VALIDATION.PASS seam (§26/§27/§28/§46/§47/§48)', () => {
  const makeEngine = (h: Harness, gateDep: unknown) =>
    createWorkflowEngine({
      ids, clock, runs: h.db.runs, events: h.db.events, approvals: h.db.approvals,
      tasks: h.db.tasks, handlers: { resolve: () => null },
      ledger: h.db.ledger, unitOfWork: h.db.unitOfWork,
      validationGate: gateDep as never,
    });

  const runIn = async (h: Harness, state: string): Promise<string> => {
    const run = await h.db.runs.get(h.runId);
    expect(run).not.toBeNull();
    if (run === null) throw new Error('run');
    await h.db.runs.put({ ...run, state: state as never });
    return run.id;
  };

  it('evidence-backed PASS transitions VALIDATING → VALIDATION_PASSED', async () => {
    const h = await make();
    h.policy.required = ['val.unit', 'val.lint'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [
      { validatorId: 'val.unit', status: 'pass', blocking: true },
      { validatorId: 'val.lint', status: 'pass', blocking: true },
    ]);
    await runIn(h, 'VALIDATING');
    const engine = makeEngine(h, h.guard);
    const result = await engine.dispatch({
      commandId: 'cmd_pass_1', runId: h.runId as never, type: 'VALIDATION.PASS',
      expectedRevision: 0, actorId: ACTOR, traceId: 'trace_1', issuedAt: clock.nowIso(),
      payload: { artifactId: t.id, stageId: h.stageId },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.to).toBe('FINALIZING'); // L1: VALIDATION_PASSED event targets FINALIZING
    const run = await h.db.runs.get(h.runId);
    expect(run?.state).toBe('FINALIZING');
  });

  it('caller-declared verdict fields are structurally worthless (§26/§45)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    // NO durable evidence at all; the payload forges every verdict-ish field:
    await runIn(h, 'VALIDATING');
    const engine = makeEngine(h, h.guard);
    const result = await engine.dispatch({
      commandId: 'cmd_forge_1', runId: h.runId as never, type: 'VALIDATION.PASS',
      expectedRevision: 0, actorId: ACTOR, traceId: 'trace_1', issuedAt: clock.nowIso(),
      payload: { artifactId: t.id, stageId: h.stageId, validationPassed: true, qualityGatePassed: true, status: 'pass', passed: true },
    });
    expect(result.ok).toBe(false);
    const run = await h.db.runs.get(h.runId);
    expect(run?.state).toBe('VALIDATING'); // untouched
  });

  it('missing payload anchors → INVALID_ARGUMENT', async () => {
    const h = await make();
    await runIn(h, 'VALIDATING');
    const engine = makeEngine(h, h.guard);
    const result = await engine.dispatch({
      commandId: 'cmd_noanchor', runId: h.runId as never, type: 'VALIDATION.PASS',
      expectedRevision: 0, actorId: ACTOR, traceId: 'trace_1', issuedAt: clock.nowIso(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('illegal state: evidence all green but run is not VALIDATING → machine rejects (§46)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [{ validatorId: 'val.unit', status: 'pass', blocking: true }]);
    await runIn(h, 'EXECUTING'); // VALIDATION.PASS is illegal from here
    const engine = makeEngine(h, h.guard);
    const result = await engine.dispatch({
      commandId: 'cmd_bad_state', runId: h.runId as never, type: 'VALIDATION.PASS',
      expectedRevision: 0, actorId: ACTOR, traceId: 'trace_1', issuedAt: clock.nowIso(),
      payload: { artifactId: t.id, stageId: h.stageId },
    });
    expect(result.ok).toBe(false);
  });

  it('gate-absent engine keeps Sprint 2/3 behaviour (seam is opt-in)', async () => {
    const h = await make();
    await runIn(h, 'VALIDATING');
    const engine = makeEngine(h, undefined);
    const result = await engine.dispatch({
      commandId: 'cmd_nogate', runId: h.runId as never, type: 'VALIDATION.PASS',
      expectedRevision: 0, actorId: ACTOR, traceId: 'trace_1', issuedAt: clock.nowIso(),
    });
    expect(result.ok).toBe(true); // historical behaviour preserved
  });

  it('successful transition replays idempotently (§47)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_b1', [{ validatorId: 'val.unit', status: 'pass', blocking: true }]);
    await runIn(h, 'VALIDATING');
    const engine = makeEngine(h, h.guard);
    const command = {
      commandId: 'cmd_replay_1', runId: h.runId as never, type: 'VALIDATION.PASS' as const,
      expectedRevision: 0, actorId: ACTOR, traceId: 'trace_1', issuedAt: clock.nowIso(),
      payload: { artifactId: t.id, stageId: h.stageId },
    };
    const first = await engine.dispatch({ ...command });
    expect(first.ok).toBe(true);
    const eventsBefore = Number((h.db.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number | bigint }).c);
    const retry = await engine.dispatch({ ...command });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value.duplicate).toBe(true);
    const eventsAfter = Number((h.db.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number | bigint }).c);
    expect(eventsAfter).toBe(eventsBefore); // no duplicate transition events
  });

  it('caller cannot select an old passing batch via payload (§24)', async () => {
    const h = await make();
    h.policy.required = ['val.unit'];
    const t = await h.target();
    await h.seedBatch('cmd_old_good', [{ validatorId: 'val.unit', status: 'pass', blocking: true }], { finishedAt: '2026-01-01T00:00:01.000Z' });
    await h.seedBatch('cmd_new_bad', [{ validatorId: 'val.unit', status: 'fail', blocking: true }], { finishedAt: '2026-01-01T00:00:02.000Z' });
    await runIn(h, 'VALIDATING');
    const engine = makeEngine(h, h.guard);
    const result = await engine.dispatch({
      commandId: 'cmd_pickold', runId: h.runId as never, type: 'VALIDATION.PASS',
      expectedRevision: 0, actorId: ACTOR, traceId: 'trace_1', issuedAt: clock.nowIso(),
      payload: { artifactId: t.id, stageId: h.stageId, validationCommandId: 'cmd_old_good', validationIds: [], useThisEvidence: true },
    });
    expect(result.ok).toBe(false);
    const run = await h.db.runs.get(h.runId);
    expect(run?.state).toBe('VALIDATING');
  });
});

describe('end-to-end through the REAL ValidationService (§36 full chain)', () => {
  it('real tool execution → durable batch → guard passes → engine transitions', async () => {
    const h = await make();
    h.policy.required = ['val.unit', 'val.lint'];
    const t = await h.target();
    const run1 = await h.validationService.run({
      commandId: 'cmd_real_1', actorId: ACTOR, runId: h.runId as never, stageId: h.stageId as never,
      targetRef: artifactTargetRef(t.id),
      validators: [
        { validatorId: 'val.unit', blocking: true },
        { validatorId: 'val.lint', blocking: true },
      ],
      traceId: 'trace_r',
    });
    expect(run1.ok).toBe(true);
    if (!run1.ok) return;
    expect(run1.value.every((v) => v.status === 'pass')).toBe(true);

    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.creationCommandId).toBe('cmd_real_1');
  });

  it('no evidence → guard rejects with NO_EVIDENCE', async () => {
    const h = await make();
    const t = await h.target();
    const verdict = await gate(h, t.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(reasonOf(verdict.error)).toBe('VALIDATION_GATE_NO_EVIDENCE');
  });
});

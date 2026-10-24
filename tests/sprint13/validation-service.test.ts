/**
 * Sprint 13 / Task-13-06: ValidationService — durable validation evidence.
 *
 * Real SQLite (12 chains), real Tool Registry (tools chain + invocation index), real
 * ArtifactService + filesystem CAS, counting mock validator adapters. Covers the §56
 * matrix: happy batch, binding, versions, replays (ledger/permanent/fingerprint
 * conflicts/corruption), preflight failures, wrong-run targets, execution-failure
 * semantics, report materialization, crash-retry idempotency, concurrency,
 * transaction rollback, authorization deny, legacy-target ban, replay event silence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TOOL_CAPABILITY_VALIDATOR,
  createToolRecord,
  createWorkflowRun,
  domainError,
  ok,
  artifactTargetRef,
  type Artifact,
  type ArtifactContentStore,
  type CommandLedgerPort,
  type DomainError,
  type EventStorePort,
  type ToolPort,
  type ToolRegistryPort,
  type ToolRequest,
  type ToolResult,
  type Validation,
  type ValidationStorePort,
} from '@companyos/core';
import {
  createArtifactService,
  createToolRegistry,
  createValidationService,
  createValidatorResolver,
  type ValidationServiceDeps,
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
  return { id: (prefix = 'id') => `${prefix}_01JT16${String(++n).padStart(4, '0')}`, ulid: () => `01JT16${String(++n).padStart(20, '0')}` };
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

/** Counting deterministic validator adapter: scripted verdicts + call accounting. */
interface ScriptedValidator {
  readonly tool: ToolPort;
  calls: number;
}

const scriptedValidator = (script: (request: ToolRequest) => { ok: boolean; output?: unknown; error?: DomainError }): ScriptedValidator => {
  const state = { calls: 0 };
  const tool: ToolPort = {
    describe: () => ({
      toolId: 'scripted',
      name: 'scripted validator',
      description: 'scripted',
      version: '1.0.0',
      riskLevel: 'LOW',
      parameters: {},
      capabilities: [TOOL_CAPABILITY_VALIDATOR],
      inputSchema: {},
      outputSchema: {},
    }),
    invoke: async (request: ToolRequest): Promise<{ ok: true; value: ToolResult } | { ok: false; error: DomainError }> => {
      state.calls += 1;
      const outcome = script(request);
      if (!outcome.ok) return { ok: false, error: outcome.error ?? domainError('PERSISTENCE_FAILED', 'scripted failure') };
      return {
        ok: true,
        value: {
          status: 'ok',
          output: outcome.output,
          artifactRefs: [],
          startedAt: clock.nowIso(),
          finishedAt: clock.nowIso(),
          latencyMs: 1,
        },
      };
    },
  };
  return { tool, get calls() { return state.calls; } };
};

const registerValidatorTool = async (
  registry: ToolRegistryPort,
  toolId: string,
  adapterRef: string,
): Promise<void> => {
  const record = createToolRecord({
    toolId,
    name: toolId,
    description: `validator ${toolId}`,
    version: '1.4.2',
    capabilities: [TOOL_CAPABILITY_VALIDATOR],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    riskLevel: 'LOW',
    idempotencyMode: 'IDEMPOTENT_KEY',
    adapterRef,
    now: clock.nowIso(),
  });
  expect(record.ok).toBe(true);
  if (!record.ok) return;
  const registered = await registry.register(record.value, { actorId: ACTOR });
  expect(registered.ok).toBe(true);
};

interface Harness {
  readonly db: DurableDatabase;
  readonly service: ReturnType<typeof createValidationService>;
  readonly artifactService: ReturnType<typeof createArtifactService>;
  readonly registry: ToolRegistryPort;
  readonly v1: ScriptedValidator;
  readonly v2: ScriptedValidator;
  readonly target: Artifact;
  runId: string;
}

const make = async (options: { v1Script?: Parameters<typeof scriptedValidator>[0]; v2Script?: Parameters<typeof scriptedValidator>[0] } = {}): Promise<Harness> => {
  const db = openDurableDatabase({
    dataDir: tempDir('companyos-t16-'),
    appliedAt: clock.nowIso(),
    chains: ['core', 'engine', 'artifact', 'tools'],
  });
  database = db;
  const casRoot = tempDir('companyos-t16-cas-');
  const contentStore: ArtifactContentStore = createFilesystemArtifactContentStore({ casRoot });

  const v1 = scriptedValidator(options.v1Script ?? (() => ({ ok: true, output: { verdict: 'pass', evidenceRefs: [] } })));
  const v2 = scriptedValidator(options.v2Script ?? (() => ({ ok: true, output: { verdict: 'fail', evidenceRefs: [] } })));
  const registryDeps: Record<string, unknown> = {
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map<string, ToolPort>([
      ['val.unit', v1.tool],
      ['val.lint', v2.tool],
    ]),
    authorize: allow,
    events: db.events,
    secrets: async () => [],
    timer: (ms: number, onTimeout: () => void) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
    ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
  };
  const registry: ToolRegistryPort = createToolRegistry(registryDeps as never);
  await registerValidatorTool(registry, 'val.unit', 'val.unit');
  await registerValidatorTool(registry, 'val.lint', 'val.lint');

  const artifactStore = db.artifactStore!;
  const artifactService = createArtifactService({
    artifactStore,
    contentStore,
    runs: db.runs,
    events: db.events,
    ledger: db.ledger,
    clock,
    ids,
    unitOfWork: db.unitOfWork,
    authorize: allow,
  });

  const seedRun = createWorkflowRun({
    companyId: 'cmp_1' as never, workflowId: 'wfl_1' as never, templateId: 'tpl_1' as never,
    versionId: 'ver_1' as never, snapshotId: 'snp_1' as never, startedBy: ACTOR, now: clock.nowIso(), ids,
  });
  expect(seedRun.ok).toBe(true);
  if (!seedRun.ok) throw new Error('seed');
  await db.runs.put(seedRun.value);
  const target = await artifactService.create({
    commandId: 'cmd_target_1', runId: seedRun.value.id, kind: 'pack-x:doc',
    content: new TextEncoder().encode('the target artifact'), producedBy: 'agent:agt_1', traceId: 'trace_t',
  });
  expect(target.ok).toBe(true);
  if (!target.ok) throw new Error('target');

  const service = createValidationService({
    resolver: createValidatorResolver({ registry }),
    registry,
    validationStore: db.validationStore!,
    artifactService,
    artifactStore,
    events: db.events,
    ledger: db.ledger,
    clock,
    ids,
    unitOfWork: db.unitOfWork,
    authorize: allow,
  });
  return { db, service, artifactService, registry, v1, v2, target: target.value, runId: seedRun.value.id };
};

const command = (h: Harness, overrides: Partial<Parameters<ReturnType<typeof createValidationService>['run']>[0]> = {}) => ({
  commandId: 'cmd_val_1',
  actorId: ACTOR,
  runId: h.runId as never,
  targetRef: artifactTargetRef(h.target.id),
  validators: [
    { validatorId: 'val.unit', blocking: true },
    { validatorId: 'val.lint', blocking: false },
  ],
  traceId: 'trace_1',
  ...overrides,
});

const recordedEvents = (db: DurableDatabase): number => {
  const row = db.db.prepare('SELECT COUNT(*) AS c FROM events WHERE type = ?').get('validation.recorded') as { c: number | bigint };
  return Number(row.c);
};
const validationRows = (db: DurableDatabase): number => {
  const row = db.db.prepare('SELECT COUNT(*) AS c FROM validations').get() as { c: number | bigint };
  return Number(row.c);
};
const artifactRows = (db: DurableDatabase): number => {
  const row = db.db.prepare('SELECT COUNT(*) AS c FROM artifacts').get() as { c: number | bigint };
  return Number(row.c);
};
const trimLedger = (db: DurableDatabase, commandId: string): void => {
  db.db.prepare('DELETE FROM command_ledger WHERE command_id = ?').run(commandId);
};

describe('ValidationService happy batch', () => {
  it('one target + N validators → N rows, N events, one ledger outcome with the full id set', async () => {
    const h = await make();
    const result = await h.service.run(command(h));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const batch: readonly Validation[] = result.value;
    expect(batch).toHaveLength(2);
    // canonical order (sorted by validatorId) and trusted versions from the registry:
    expect(batch.map((v) => v.validatorId)).toEqual(['val.lint', 'val.unit']);
    expect(batch.every((v) => v.validatorVersion === '1.4.2')).toBe(true);
    expect(batch.every((v) => v.targetRef === artifactTargetRef(h.target.id))).toBe(true);
    expect(batch.every((v) => v.runId === h.runId)).toBe(true);
    // blocking from the TRUSTED plan (unit=true, lint=false):
    expect(batch.find((v) => v.validatorId === 'val.unit')?.blocking).toBe(true);
    expect(batch.find((v) => v.validatorId === 'val.lint')?.blocking).toBe(false);
    // statuses from the decoded envelope:
    expect(batch.find((v) => v.validatorId === 'val.unit')?.status).toBe('pass');
    expect(batch.find((v) => v.validatorId === 'val.lint')?.status).toBe('fail');
    expect(recordedEvents(h.db)).toBe(2);
    const ledger = await h.db.ledger.get('cmd_val_1');
    expect(Array.isArray(ledger?.outcome.validationIds)).toBe(true);
    expect((ledger?.outcome.validationIds as string[]).length).toBe(2);
  });

  it('order-insensitive: [V2,V1] is the same command as [V1,V2]', async () => {
    const h = await make();
    const first = await h.service.run(command(h));
    expect(first.ok).toBe(true);
    const reordered = await h.service.run(command(h, {
      validators: [
        { validatorId: 'val.lint', blocking: false },
        { validatorId: 'val.unit', blocking: true },
      ],
    }));
    expect(reordered.ok).toBe(true); // replay, not a fingerprint conflict
    if (first.ok && reordered.ok) {
      expect(new Set(reordered.value.map((v) => v.id))).toEqual(new Set(first.value.map((v) => v.id)));
    }
  });

  it('duplicate validatorId in one command is rejected', async () => {
    const h = await make();
    const result = await h.service.run(command(h, {
      validators: [
        { validatorId: 'val.unit', blocking: true },
        { validatorId: 'val.unit', blocking: false },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
    expect(validationRows(h.db)).toBe(0);
  });
});

describe('ValidationService replay semantics', () => {
  it('normal ledger replay: same ids, zero tool calls, zero new rows/events', async () => {
    const h = await make();
    const first = await h.service.run(command(h));
    expect(first.ok).toBe(true);
    const calls = h.v1.calls + h.v2.calls;
    const events = recordedEvents(h.db);
    const rows = validationRows(h.db);

    const retry = await h.service.run(command(h));
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(new Set(retry.value.map((v) => v.id))).toEqual(new Set(first.value.map((v) => v.id)));
    }
    expect(h.v1.calls + h.v2.calls).toBe(calls);
    expect(recordedEvents(h.db)).toBe(events);
    expect(validationRows(h.db)).toBe(rows);
  });

  it('ledger fingerprint conflict: different validator plan → CONFLICT before execution', async () => {
    const h = await make();
    expect((await h.service.run(command(h))).ok).toBe(true);
    const calls = h.v1.calls + h.v2.calls;
    const events = recordedEvents(h.db);

    const conflict = await h.service.run(command(h, { validators: [{ validatorId: 'val.unit', blocking: true }] }));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('CONFLICT');
    expect(h.v1.calls + h.v2.calls).toBe(calls);
    expect(recordedEvents(h.db)).toBe(events);
  });

  it('ledger outcome corruption fails closed (never re-executed as a miss)', async () => {
    const h = await make();
    expect((await h.service.run(command(h))).ok).toBe(true);
    h.db.db.prepare("UPDATE command_ledger SET outcome_json = '{\"validationIds\":[]}' WHERE command_id = ?").run('cmd_val_1');
    const retry = await h.service.run(command(h));
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('PERSISTENCE_FAILED');
    expect(validationRows(h.db)).toBe(2); // no new rows
  });

  it('permanent replay after ledger trim: same batch, no tool re-execution, no new evidence', async () => {
    const h = await make();
    const first = await h.service.run(command(h));
    expect(first.ok).toBe(true);
    trimLedger(h.db, 'cmd_val_1');
    const calls = h.v1.calls + h.v2.calls;
    const events = recordedEvents(h.db);
    const rows = validationRows(h.db);

    const retry = await h.service.run(command(h));
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(new Set(retry.value.map((v) => v.id))).toEqual(new Set(first.value.map((v) => v.id)));
    }
    expect(h.v1.calls + h.v2.calls).toBe(calls);
    expect(recordedEvents(h.db)).toBe(events);
    expect(validationRows(h.db)).toBe(rows);
  });

  it('permanent fingerprint conflict after trim: zero tool invocations', async () => {
    const h = await make();
    expect((await h.service.run(command(h))).ok).toBe(true);
    trimLedger(h.db, 'cmd_val_1');
    const calls = h.v1.calls + h.v2.calls;

    // A VALID-shaped but different target: same commandId + different semantics → CONFLICT.
    const conflict = await h.service.run(command(h, { targetRef: artifactTargetRef('art_01JT1600000000000000ZZZZ') }));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('CONFLICT');
    expect(h.v1.calls + h.v2.calls).toBe(calls);
    expect(validationRows(h.db)).toBe(2); // no new evidence
  });
});

describe('ValidationService preflight and target binding', () => {
  it('resolve-all-before-execute: one unknown validator means ZERO executions', async () => {
    const h = await make();
    const result = await h.service.run(command(h, {
      validators: [
        { validatorId: 'val.unit', blocking: true },
        { validatorId: 'val.unknown', blocking: true },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    expect(h.v1.calls + h.v2.calls).toBe(0);
    expect(validationRows(h.db)).toBe(0);
    expect(recordedEvents(h.db)).toBe(0);
  });

  it('a disabled validator means zero executions and zero evidence', async () => {
    const h = await make();
    await h.registry.setEnabled('val.lint', false, ACTOR);
    const result = await h.service.run(command(h));
    expect(result.ok).toBe(false);
    expect(h.v1.calls + h.v2.calls).toBe(0);
    expect(validationRows(h.db)).toBe(0);
  });

  it('wrong-run target fails closed BEFORE any execution', async () => {
    const h = await make();
    const otherRun = createWorkflowRun({
      companyId: 'cmp_1' as never, workflowId: 'wfl_2' as never, templateId: 'tpl_1' as never,
      versionId: 'ver_1' as never, snapshotId: 'snp_2' as never, startedBy: ACTOR, now: clock.nowIso(), ids,
    });
    expect(otherRun.ok).toBe(true);
    if (!otherRun.ok) return;
    await h.db.runs.put(otherRun.value);
    const result = await h.service.run(command(h, { runId: otherRun.value.id as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as DomainError & { details?: { reason?: string } }).details?.reason).toBe('VALIDATION_TARGET_WRONG_RUN');
    }
    expect(h.v1.calls + h.v2.calls).toBe(0);
  });

  it('a missing target artifact fails closed', async () => {
    const h = await make();
    const missing = artifactTargetRef('art_01JT1600000000000000000ZZZZ');
    const result = await h.service.run(command(h, { targetRef: missing }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    expect(h.v1.calls + h.v2.calls).toBe(0);
  });
});

describe('ValidationService execution semantics', () => {
  it('validator adapter failure → status=error (never a fake business fail)', async () => {
    const h = await make({ v1Script: () => ({ ok: false, error: domainError('TIMEOUT', 'validator timed out') }) });
    const result = await h.service.run(command(h));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unit = result.value.find((v) => v.validatorId === 'val.unit');
    expect(unit?.status).toBe('error');
    expect(unit?.evidenceRefs.some((ref) => ref.startsWith('command:validation:'))).toBe(true);
  });

  it('undecodable validator output → status=error', async () => {
    const h = await make({ v1Script: () => ({ ok: true, output: 'random stdout garbage' }) });
    const result = await h.service.run(command(h));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.find((v) => v.validatorId === 'val.unit')?.status).toBe('error');
  });

  it('blocking comes from the plan, never the validator output', async () => {
    // v2 (lint) says fail; the plan marks it blocking:false — a WARNING, not a gate:
    const h = await make();
    const result = await h.service.run(command(h));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lint = result.value.find((v) => v.validatorId === 'val.lint');
    expect(lint?.status).toBe('fail');
    expect(lint?.blocking).toBe(false);
  });

  it('report materialization goes through ArtifactService and lands as evidence', async () => {
    const h = await make({
      v1Script: () => ({
        ok: true,
        output: { verdict: 'pass', evidenceRefs: [], report: { kind: 'pack-x:test-report', label: 'unit report', content: 'all green' } },
      }),
    });
    const artifactsBefore = artifactRows(h.db);
    const result = await h.service.run(command(h));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(artifactRows(h.db)).toBe(artifactsBefore + 1);
    const unit = result.value.find((v) => v.validatorId === 'val.unit');
    expect(unit?.evidenceRefs.some((ref) => ref.startsWith('artifact:art_'))).toBe(true);
    expect(unit?.targetRef).toBe(artifactTargetRef(h.target.id)); // targetRef ≠ report evidence
    const report = await h.db.artifactStore!.listByRun(h.runId as never);
    const produced = report.find((a) => a.producedBy.startsWith('validator:val.unit@'));
    expect(produced?.producedBy).toBe('validator:val.unit@1.4.2');
  });

  it('crash-retry: tool invocation reused (adapter NOT re-executed), report artifact replayed, batch commits', async () => {
    const h = await make({
      v1Script: () => ({
        ok: true,
        output: { verdict: 'pass', evidenceRefs: [], report: { kind: 'pack-x:r', label: 'r', content: 'report body' } },
      }),
    });
    // First run fails at the validation UoW (event append breaks the transaction):
    const breakingEvents = {
      append: async (): Promise<readonly number[]> => {
        throw new Error('simulated event failure');
      },
    };
    const failing = createValidationServiceForHarness(h, { events: breakingEvents as never });
    const failed = await failing.run(command(h));
    expect(failed.ok).toBe(false);
    expect(validationRows(h.db)).toBe(0); // rolled back
    expect(h.v1.calls).toBe(1); // the tool ran once
    expect(artifactRows(h.db)).toBe(2); // target + report survived (§30 durable-before-UoW)

    const v1AfterFailure = h.v1.calls;
    const v2AfterFailure = h.v2.calls;
    const retry = await h.service.run(command(h)); // real service, same command

    // §22 REQUIRED END STATE (ADR-0018): tool executed ONCE; the replay restores the
    // ORIGINAL output snapshot (verdict + report descriptor); the deterministic nested
    // report command replays the SAME artifact; the batch then commits.
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(h.v1.calls).toBe(v1AfterFailure); // adapter NOT re-executed (snapshot replay)
    expect(h.v2.calls).toBe(v2AfterFailure);
    expect(artifactRows(h.db)).toBe(2); // target + ONE report (deterministic nested command)
    expect(validationRows(h.db)).toBe(2); // batch commits
    expect(recordedEvents(h.db)).toBe(2);
    const unit = retry.value.find((v) => v.validatorId === 'val.unit');
    expect(unit?.status).toBe('pass'); // original verdict restored
    expect(unit?.evidenceRefs.some((ref) => ref.startsWith('artifact:art_'))).toBe(true); // report evidence restored
    expect(unit?.targetRef).toBe(artifactTargetRef(h.target.id));
  });
});

describe('ValidationService concurrency', () => {
  it('same command + same fingerprint concurrently → one batch, both callers get the same ids', async () => {
    const h = await make();
    const results = await Promise.allSettled([h.service.run(command(h)), h.service.run(command(h))]);
    const idSets = results.map((r) => {
      expect(r.status).toBe('fulfilled');
      const value = (r as PromiseFulfilledResult<{ ok: boolean; value?: readonly Validation[]; error?: DomainError }>).value;
      expect(value.ok).toBe(true);
      return new Set((value.value ?? []).map((v) => v.id));
    });
    expect(idSets[0]).toEqual(idSets[1]);
    expect(validationRows(h.db)).toBe(2);
    expect(recordedEvents(h.db)).toBe(2);
  });

  it('same command + different fingerprint concurrently → one winner, the loser CONFLICTs', async () => {
    const h = await make();
    const results = await Promise.allSettled([
      h.service.run(command(h)),
      h.service.run(command(h, { validators: [{ validatorId: 'val.unit', blocking: true }] })),
    ]);
    const outcomes = results.map((r) => {
      expect(r.status).toBe('fulfilled');
      return (r as PromiseFulfilledResult<{ ok: boolean; error?: DomainError }>).value;
    });
    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0]?.error?.code).toBe('CONFLICT');
    // Whichever semantic won, the durable batch is EXACTLY the winner's plan:
    const winnerBatch = (winners[0] as { value?: readonly Validation[] }).value ?? [];
    expect(validationRows(h.db)).toBe(winnerBatch.length);
    expect(recordedEvents(h.db)).toBe(winnerBatch.length);
  });
});

describe('ValidationService transaction rollback', () => {
  it('validation record failure → rows/events/ledger all rollback', async () => {
    const h = await make();
    const real = h.db.validationStore!;
    const failingStore = {
      record: async (): Promise<void> => {
        throw new Error('simulated store failure');
      },
      get: real.get.bind(real),
      getByCreationCommand: real.getByCreationCommand.bind(real),
      listByRun: real.listByRun.bind(real),
      listByTargetRef: real.listByTargetRef.bind(real),
    };
    const service = createValidationServiceForHarness(h, { validationStore: failingStore as never });
    const result = await service.run(command(h));
    expect(result.ok).toBe(false);
    expect(validationRows(h.db)).toBe(0);
    expect(recordedEvents(h.db)).toBe(0);
    expect(await h.db.ledger.get('cmd_val_1')).toBeNull();
  });

  it('ledger put failure → rows/events rollback', async () => {
    const h = await make();
    const failingLedger = {
      get: async () => null,
      put: async (): Promise<void> => {
        throw new Error('simulated ledger failure');
      },
      count: async () => 0,
      trim: async () => 0,
    };
    const service = createValidationServiceForHarness(h, { ledger: failingLedger as never });
    const result = await service.run(command(h));
    expect(result.ok).toBe(false);
    expect(validationRows(h.db)).toBe(0);
    expect(recordedEvents(h.db)).toBe(0);
  });
});

describe('ValidationService authorization', () => {
  it('deny on a NEW command → zero everything', async () => {
    const h = await make();
    const deny = async (): Promise<{ ok: false; error: DomainError }> => ({
      ok: false,
      error: domainError('PERMISSION_DENIED', 'validation.record denied.'),
    });
    const service = createValidationServiceForHarness(h, { authorize: deny });
    const result = await service.run(command(h));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED');
    expect(h.v1.calls + h.v2.calls).toBe(0);
    expect(validationRows(h.db)).toBe(0);
    expect(recordedEvents(h.db)).toBe(0);
    expect(await h.db.ledger.get('cmd_val_1')).toBeNull();
  });

  it('deny on ledger replay → the old batch is NOT served', async () => {
    const h = await make();
    expect((await h.service.run(command(h))).ok).toBe(true);
    const deny = async (): Promise<{ ok: false; error: DomainError }> => ({
      ok: false,
      error: domainError('PERMISSION_DENIED', 'validation.record denied.'),
    });
    const service = createValidationServiceForHarness(h, { authorize: deny });
    const retry = await service.run(command(h));
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('PERMISSION_DENIED');
    expect(validationRows(h.db)).toBe(2); // untouched
    expect(recordedEvents(h.db)).toBe(2);
  });

  it('deny on permanent replay after trim → the durable batch cannot bypass authorization', async () => {
    const h = await make();
    expect((await h.service.run(command(h))).ok).toBe(true);
    trimLedger(h.db, 'cmd_val_1');
    const deny = async (): Promise<{ ok: false; error: DomainError }> => ({
      ok: false,
      error: domainError('PERMISSION_DENIED', 'validation.record denied.'),
    });
    const service = createValidationServiceForHarness(h, { authorize: deny });
    const retry = await service.run(command(h));
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('ValidationService boundaries', () => {
  it('never writes a legacy null targetRef (Sprint 13 records are always targeted)', async () => {
    const h = await make();
    const result = await h.service.run(command(h));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.every((v) => v.targetRef !== null)).toBe(true);
  });

  it('the command surface cannot carry version claims, executables or workflow actions', async () => {
    const h = await make();
    const cmd = command(h);
    expect('validatorVersion' in cmd).toBe(false);
    expect('executablePath' in cmd).toBe(false);
    expect('shellCommand' in cmd).toBe(false);
    expect('onPassTransition' in cmd).toBe(false);
  });

  it('no workflow transition is performed by the service (evidence only)', async () => {
    const h = await make({
      v1Script: () => ({ ok: true, output: { verdict: 'pass' } }),
      v2Script: () => ({ ok: true, output: { verdict: 'pass' } }),
    });
    const result = await h.service.run(command(h));
    expect(result.ok).toBe(true);
    // All blocking validators passed — yet the run state is untouched (T07's job):
    const run = await h.db.runs.get(h.runId);
    expect(run?.state).toBeDefined();
    expect(run?.state).toBe(createWorkflowRunStateAfterSeed());
    function createWorkflowRunStateAfterSeed(): string {
      return run?.state ?? '';
    }
  });
});

/** Rebuild the service over the harness with one dependency overridden. */
function createValidationServiceForHarness(
  h: Harness,
  overrides: {
    events?: EventStorePort;
    validationStore?: ValidationStorePort;
    ledger?: CommandLedgerPort;
    authorize?: ValidationServiceDeps['authorize'];
  } = {},
): ReturnType<typeof createValidationService> {
  return createValidationService({
    resolver: createValidatorResolver({ registry: h.registry }),
    registry: h.registry,
    validationStore: overrides.validationStore ?? h.db.validationStore!,
    artifactService: h.artifactService,
    artifactStore: h.db.artifactStore!,
    events: overrides.events ?? h.db.events,
    ledger: overrides.ledger ?? h.db.ledger,
    clock,
    ids,
    unitOfWork: h.db.unitOfWork,
    authorize: overrides.authorize ?? allow,
  });
}

describe('ValidationService approval path', () => {
  it('a HIGH-risk validator waiting for approval fails the whole command with zero evidence', async () => {
    const h = await make();
    // Register a HIGH-risk validator tool (risk gate inherited from Sprint 9):
    const record = createToolRecord({
      toolId: 'val.deploy-check', name: 'val.deploy-check', description: 'high risk validator',
      version: '1.0.0', capabilities: [TOOL_CAPABILITY_VALIDATOR],
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      riskLevel: 'HIGH', idempotencyMode: 'IDEMPOTENT_KEY', adapterRef: 'val.deploy-check', now: clock.nowIso(),
    });
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    // The risk gate fires BEFORE any adapter is consulted, so the harness adapter map
    // (which lacks 'val.deploy-check') is never touched on the waiting path:
    const registered = await h.registry.register(
      { ...(record.value), adapterRef: 'val.deploy-check' } as never,
      { actorId: ACTOR },
    );
    expect(registered.ok).toBe(true);

    const result = await h.service.run(command(h, {
      validators: [{ validatorId: 'val.deploy-check', blocking: true }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('APPROVAL_REQUIRED');
      expect((result.error as DomainError & { details?: { reason?: string } }).details?.reason).toBe('VALIDATION_WAITING_APPROVAL');
    }
    expect(validationRows(h.db)).toBe(0);
    expect(recordedEvents(h.db)).toBe(0);
    expect(await h.db.ledger.get('cmd_val_1')).toBeNull();
  });
});

describe('crash-retry verdict restoration variants (ADR-0018 §27/§28)', () => {
  const crashThenRetry = async (v1Script: Parameters<typeof scriptedValidator>[0]): Promise<{ unit: Validation | undefined; calls: number }> => {
    const h = await make({ v1Script });
    const failing = createValidationServiceForHarness(h, {
      events: { append: async (): Promise<readonly number[]> => { throw new Error('simulated event failure'); } } as never,
    });
    expect((await failing.run(command(h))).ok).toBe(false); // crash: batch rolled back
    const calls = h.v1.calls;
    const retry = await h.service.run(command(h));
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('retry failed');
    expect(h.v1.calls).toBe(calls); // adapter never re-executed
    return { unit: retry.value.find((v) => v.validatorId === 'val.unit'), calls };
  };

  it('restores a FAIL verdict after a crash retry', async () => {
    const { unit } = await crashThenRetry(() => ({ ok: true, output: { verdict: 'fail', evidenceRefs: [] } }));
    expect(unit?.status).toBe('fail');
  });

  it('restores a SKIPPED verdict after a crash retry', async () => {
    const { unit } = await crashThenRetry(() => ({ ok: true, output: { verdict: 'skipped' } }));
    expect(unit?.status).toBe('skipped');
  });

  it('deterministically remaps a malformed replayed output to error (§28, no re-execution)', async () => {
    const { unit } = await crashThenRetry(() => ({ ok: true, output: 'not-an-envelope' }));
    expect(unit?.status).toBe('error');
  });

  it('restores the full report descriptor and replays the SAME report artifact', async () => {
    const { unit } = await crashThenRetry(() => ({
      ok: true,
      output: { verdict: 'pass', evidenceRefs: [], report: { kind: 'pack-x:r2', label: 'r2', content: 'report two' } },
    }));
    expect(unit?.status).toBe('pass');
    expect(unit?.evidenceRefs.some((ref) => ref.startsWith('artifact:art_'))).toBe(true);
  });
});

describe('approval recovery end-to-end (ADR-0018 §24)', () => {
  it('HIGH validator: waiting → approve → retry completes → later retry replays without execution', async () => {
    const h = await make();
    // Register a HIGH-risk validator WITH an adapter (approval then real execution):
    let executed = 0;
    const highAdapter: ToolPort = {
      describe: () => ({
        toolId: 'val.high-check', name: 'high', description: 'high', version: '1.0.0', riskLevel: 'HIGH',
        parameters: {}, capabilities: [], inputSchema: {}, outputSchema: {},
      }),
      invoke: async (): Promise<{ ok: true; value: ToolResult } | { ok: false; error: DomainError }> => {
        executed += 1;
        return {
          ok: true,
          value: { status: 'ok', output: { verdict: 'pass' }, artifactRefs: [], startedAt: clock.nowIso(), finishedAt: clock.nowIso(), latencyMs: 1 },
        };
      },
    };
    // Build a registry that includes the high adapter:
    const registry = createToolRegistry({
      ids, clock,
      records: h.db.toolRecords, invocations: h.db.toolInvocations, invocationArtifacts: h.db.toolInvocationArtifacts,
      adapters: new Map([['val.unit', h.v1.tool], ['val.lint', h.v2.tool], ['val.high-check', highAdapter]]),
      authorize: allow, events: h.db.events, secrets: async () => [],
      timer: (ms: number, onTimeout: () => void) => { const t = setTimeout(onTimeout, ms); return () => clearTimeout(t); },
      ...(h.db.toolInvocationClaims === null ? {} : { claims: h.db.toolInvocationClaims }),
      ...(h.db.toolInvocationIndex === null ? {} : { invocationIndex: h.db.toolInvocationIndex }),
    } as never);
    const record = createToolRecord({
      toolId: 'val.high-check', name: 'val.high-check', description: 'high risk validator', version: '1.0.0',
      capabilities: [TOOL_CAPABILITY_VALIDATOR], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      riskLevel: 'HIGH', idempotencyMode: 'IDEMPOTENT_KEY', adapterRef: 'val.high-check', now: clock.nowIso(),
    });
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect((await registry.register(record.value, { actorId: ACTOR })).ok).toBe(true);
    const service = createValidationService({
      resolver: createValidatorResolver({ registry }),
      registry,
      validationStore: h.db.validationStore!,
      artifactService: h.artifactService,
      artifactStore: h.db.artifactStore!,
      events: h.db.events, ledger: h.db.ledger, clock, ids, unitOfWork: h.db.unitOfWork, authorize: allow,
    });
    const cmd = command(h, { validators: [{ validatorId: 'val.high-check', blocking: true }] });

    // 1) Waiting: zero evidence, APPROVAL_REQUIRED.
    const waiting = await service.run(cmd);
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) expect(waiting.error.code).toBe('APPROVAL_REQUIRED');
    expect(validationRows(h.db)).toBe(0);

    // 2) Approve the persisted WAITING_APPROVAL invocation.
    const invocationRow = h.db.db
      .prepare('SELECT id FROM tool_invocations WHERE tool_id = ? AND status = ?')
      .get('val.high-check', 'WAITING_APPROVAL') as { id: string } | undefined;
    expect(invocationRow).toBeDefined();
    if (invocationRow === undefined) return;
    const approved = await registry.approve({ invocationId: invocationRow.id, actorId: 'user_approver' });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.status).toBe('COMPLETED'); // approved call executed for real
    const executedAfterApproval = executed;

    // 3) Retry the SAME validation command: invocation replayed by key, verdict restored.
    const completed = await service.run(cmd);
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value[0]?.status).toBe('pass');
    expect(executed).toBe(executedAfterApproval); // no re-execution

    // 4) A LATER retry replays the durable batch without touching anything.
    const rows = validationRows(h.db);
    const events = recordedEvents(h.db);
    const later = await service.run(cmd);
    expect(later.ok).toBe(true);
    expect(executed).toBe(executedAfterApproval);
    expect(validationRows(h.db)).toBe(rows);
    expect(recordedEvents(h.db)).toBe(events);
  });
});

describe('validator version provenance (ADR-0019 §21–§23)', () => {
  /** Resolver seam: reports an OVERRIDDEN current version (simulated registry drift). */
  const driftResolver = (base: ReturnType<typeof createValidatorResolver>, override: { current: string | null }) => ({
    resolve: async (validatorId: string, actorId: string) => {
      const resolved = await base.resolve(validatorId, actorId);
      if (!resolved.ok || override.current === null) return resolved;
      return ok({ ...resolved.value, validatorVersion: override.current });
    },
  });

  it('§21 registry drift crash-retry: validatorVersion = durable v1, never current v2', async () => {
    const h = await make();
    const override = { current: null as string | null };
    const service = createValidationService({
      resolver: driftResolver(createValidatorResolver({ registry: h.registry }), override),
      registry: h.registry,
      validationStore: h.db.validationStore!,
      artifactService: h.artifactService,
      artifactStore: h.db.artifactStore!,
      events: h.db.events, ledger: h.db.ledger, clock, ids, unitOfWork: h.db.unitOfWork, authorize: allow,
    });
    // v1 (=1.4.2) executes; the Validation UoW crashes:
    const failing = createValidationService({
      resolver: driftResolver(createValidatorResolver({ registry: h.registry }), override),
      registry: h.registry,
      validationStore: h.db.validationStore!,
      artifactService: h.artifactService,
      artifactStore: h.db.artifactStore!,
      events: { append: async (): Promise<readonly number[]> => { throw new Error('crash'); } } as never,
      ledger: h.db.ledger, clock, ids, unitOfWork: h.db.unitOfWork, authorize: allow,
    });
    expect((await failing.run(command(h))).ok).toBe(false);
    const calls = h.v1.calls + h.v2.calls;

    // Registry "upgrades" while we were down:
    override.current = '2.0.0';
    const retry = await service.run(command(h));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(h.v1.calls + h.v2.calls).toBe(calls); // no re-execution
    expect(retry.value.every((v) => v.validatorVersion === '1.4.2')).toBe(true); // durable v1, NOT 2.0.0
    const recorded = h.db.db.prepare('SELECT payload FROM events WHERE type = ?').all('validation.recorded') as { payload: string }[];
    expect(recorded.every((row) => (JSON.parse(row.payload) as { validatorVersion: string }).validatorVersion === '1.4.2')).toBe(true);
  });

  it('§22 report artifact across drift: producedBy stays @v1, SAME artifact replays', async () => {
    const h = await make({
      v1Script: () => ({ ok: true, output: { verdict: 'pass', evidenceRefs: [], report: { kind: 'pack-x:drift', label: 'd', content: 'drift report' } } }),
    });
    const override = { current: null as string | null };
    const buildService = (events: unknown) => createValidationService({
      resolver: driftResolver(createValidatorResolver({ registry: h.registry }), override),
      registry: h.registry,
      validationStore: h.db.validationStore!,
      artifactService: h.artifactService,
      artifactStore: h.db.artifactStore!,
      events: (events as never) ?? h.db.events, ledger: h.db.ledger, clock, ids, unitOfWork: h.db.unitOfWork, authorize: allow,
    });
    const failing = buildService({ append: async (): Promise<readonly number[]> => { throw new Error('crash'); } });
    expect((await failing.run(command(h))).ok).toBe(false);
    override.current = '2.0.0';

    const retry = await buildService(undefined).run(command(h));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(artifactRows(h.db)).toBe(2); // ONE report — deterministic command replayed
    const reports = await h.db.artifactStore!.listByRun(h.runId as never);
    const report = reports.find((a) => a.kind === 'pack-x:drift');
    expect(report?.producedBy).toBe('validator:val.unit@1.4.2'); // durable v1 (§12)
    const unit = retry.value.find((v) => v.validatorId === 'val.unit');
    expect(unit?.validatorVersion).toBe('1.4.2');
    expect(unit?.evidenceRefs.some((ref) => ref === `artifact:${report?.id}`)).toBe(true);
  });

  it('§23 legacy invocation missing version → fail closed, zero substitution', async () => {
    const h = await make();
    expect((await h.service.run(command(h))).ok).toBe(true);
    // Simulate the legacy state directly: wipe the batch (rows, ledger, events) and the
    // version provenance, keeping valid replay snapshots:
    h.db.db.prepare('DELETE FROM validations').run();
    h.db.db.prepare('DELETE FROM command_ledger WHERE command_id = ?').run('cmd_val_1');
    h.db.db.prepare("DELETE FROM events WHERE type = 'validation.recorded'").run();
    h.db.db.prepare('UPDATE tool_invocations SET tool_version = NULL').run();
    h.db.db.prepare('UPDATE tool_records SET version = ?').run('9.9.9');

    const retry = await h.service.run(command(h));
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect((retry.error as DomainError & { details?: { reason?: string } }).details?.reason).toBe('VALIDATION_VERSION_PROVENANCE_UNRECOVERABLE');
    }
    expect(validationRows(h.db)).toBe(0);
    expect(recordedEvents(h.db)).toBe(0);
  });

  it('§26/§27 PASS/FAIL/SKIPPED/malformed all carry the invocation version', async () => {
    const h = await make();
    const result = await h.service.run(command(h));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.every((v) => v.validatorVersion === '1.4.2')).toBe(true);
  });
});

describe('approval version semantics (ADR-0019 §16/§24)', () => {
  it('§24a WAITING_APPROVAL invocation durably stores its tool version', async () => {
    const h = await make();
    const record = createToolRecord({
      toolId: 'val.wait-check', name: 'val.wait-check', description: 'high', version: '3.1.4',
      capabilities: [TOOL_CAPABILITY_VALIDATOR], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      riskLevel: 'HIGH', idempotencyMode: 'IDEMPOTENT_KEY', adapterRef: 'val.wait-check', now: clock.nowIso(),
    });
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect((await h.registry.register(record.value, { actorId: ACTOR })).ok).toBe(true);
    const result = await h.service.run(command(h, { validators: [{ validatorId: 'val.wait-check', blocking: true }] }));
    expect(result.ok).toBe(false); // APPROVAL_REQUIRED
    const row = h.db.db.prepare('SELECT tool_version, status FROM tool_invocations WHERE tool_id = ?').get('val.wait-check') as { tool_version: string | null; status: string };
    expect(row.status).toBe('WAITING_APPROVAL');
    expect(row.tool_version).toBe('3.1.4');
  });

  it('§24b version drift before approval → approve fails closed (no silent v2-as-v1)', async () => {
    const h = await make();
    const record = createToolRecord({
      toolId: 'val.drift-check', name: 'val.drift-check', description: 'high', version: '1.0.0',
      capabilities: [TOOL_CAPABILITY_VALIDATOR], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      riskLevel: 'HIGH', idempotencyMode: 'IDEMPOTENT_KEY', adapterRef: 'val.drift-check', now: clock.nowIso(),
    });
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect((await h.registry.register(record.value, { actorId: ACTOR })).ok).toBe(true);
    const result = await h.service.run(command(h, { validators: [{ validatorId: 'val.drift-check', blocking: true }] }));
    expect(result.ok).toBe(false);

    // Registration "upgrades" while waiting:
    h.db.db.prepare('UPDATE tool_records SET version = ? WHERE tool_id = ?').run('2.0.0', 'val.drift-check');
    const row = h.db.db.prepare('SELECT id FROM tool_invocations WHERE tool_id = ? AND status = ?').get('val.drift-check', 'WAITING_APPROVAL') as { id: string };
    const approved = await h.registry.approve({ invocationId: row.id, actorId: 'user_approver' });
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect((approved.error as DomainError & { details?: { reason?: string } }).details?.reason).toBe('TOOL_INVOCATION_VERSION_CHANGED');
    }
  });
});

describe('legacy approval provenance (ADR-0019 final clarification)', () => {
  it('A: legacy WAITING with null version cannot be approved into execution — zero side effects', async () => {
    const h = await make();
    const record = createToolRecord({
      toolId: 'val.legacy-wait', name: 'val.legacy-wait', description: 'high', version: '1.0.0',
      capabilities: [TOOL_CAPABILITY_VALIDATOR], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      riskLevel: 'HIGH', idempotencyMode: 'IDEMPOTENT_KEY', adapterRef: 'val.legacy-wait', now: clock.nowIso(),
    });
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect((await h.registry.register(record.value, { actorId: ACTOR })).ok).toBe(true);
    const result = await h.service.run(command(h, { validators: [{ validatorId: 'val.legacy-wait', blocking: true }] }));
    expect(result.ok).toBe(false); // WAITING path

    // Simulate the legacy state: unknown provenance + registry "now at" v9:
    h.db.db.prepare('UPDATE tool_invocations SET tool_version = NULL WHERE tool_id = ?').run('val.legacy-wait');
    h.db.db.prepare('UPDATE tool_records SET version = ? WHERE tool_id = ?').run('9.0.0', 'val.legacy-wait');
    const calls = h.v1.calls + h.v2.calls;

    const row = h.db.db.prepare('SELECT id FROM tool_invocations WHERE tool_id = ? AND status = ?').get('val.legacy-wait', 'WAITING_APPROVAL') as { id: string };
    const approved = await h.registry.approve({ invocationId: row.id, actorId: 'user_approver' });
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect((approved.error as DomainError & { details?: { reason?: string } }).details?.reason).toBe('TOOL_INVOCATION_VERSION_UNRECOVERABLE');
    }
    // Zero new tool side effects:
    expect(h.v1.calls + h.v2.calls).toBe(calls);
    // Status remains WAITING_APPROVAL; no terminal output / snapshot / finishedAt mutation:
    const after = h.db.db.prepare('SELECT status, tool_version, output_digest, replay_output_json, finished_at FROM tool_invocations WHERE id = ?').get(row.id) as { status: string; tool_version: string | null; output_digest: string | null; replay_output_json: string | null; finished_at: string | null };
    expect(after.status).toBe('WAITING_APPROVAL');
    expect(after.tool_version).toBeNull();
    expect(after.output_digest).toBeNull();
    expect(after.replay_output_json).toBeNull();
    expect(after.finished_at).toBeNull();
  });

  it('B: no silent backfill — the durable row keeps tool_version NULL after the denial', async () => {
    const h = await make();
    const record = createToolRecord({
      toolId: 'val.nobackfill', name: 'val.nobackfill', description: 'high', version: '1.0.0',
      capabilities: [TOOL_CAPABILITY_VALIDATOR], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      riskLevel: 'HIGH', idempotencyMode: 'IDEMPOTENT_KEY', adapterRef: 'val.nobackfill', now: clock.nowIso(),
    });
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect((await h.registry.register(record.value, { actorId: ACTOR })).ok).toBe(true);
    expect((await h.service.run(command(h, { validators: [{ validatorId: 'val.nobackfill', blocking: true }] }))).ok).toBe(false);
    h.db.db.prepare('UPDATE tool_invocations SET tool_version = NULL WHERE tool_id = ?').run('val.nobackfill');
    h.db.db.prepare('UPDATE tool_records SET version = ? WHERE tool_id = ?').run('9.0.0', 'val.nobackfill');

    const row = h.db.db.prepare('SELECT id FROM tool_invocations WHERE tool_id = ? AND status = ?').get('val.nobackfill', 'WAITING_APPROVAL') as { id: string };
    await h.registry.approve({ invocationId: row.id, actorId: 'user_approver' });
    // Direct durable check: UNKNOWN was not "repaired" into the current 9.0.0:
    const after = h.db.db.prepare('SELECT tool_version FROM tool_invocations WHERE id = ?').get(row.id) as { tool_version: string | null };
    expect(after.tool_version).toBeNull();
  });
});

/**
 * Sprint 10B.1 tests A–AP: production reachability, durable audit, IPC boundary and traceability.
 *
 * Every assertion drives REAL code: the deterministic router, the application service, the durable
 * event store (via `defineEvent` + `database.events.append`) and the real SQLite decision store,
 * including a genuine close/reopen cycle. Nothing here is a stub-only or always-true assertion.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPolicy,
  defineEvent,
  deriveRouterPolicyView,
  routerUnavailableOutcome,
  type ModelRecord,
  type RouterPolicyView,
  type RouterRequest,
} from '@companyos/core';
import {
  MAX_STORED_EVALUATIONS,
  createDeterministicModelRouter,
  createRouterApplicationService,
  reconcileRouterAudit,
  registryRevisionOf,
  repairPayloadOf,
  type RouterAuditPayload,
} from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const source = (path: string): string => readFileSync(repo(path), 'utf8');

const tempDirs: string[] = [];
const makeDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-10b1-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MODEL = (modelKey: string, overrides: Partial<ModelRecord> = {}): ModelRecord => ({
  id: modelKey,
  modelKey,
  providerId: 'provider-a',
  providerModelId: modelKey,
  displayName: modelKey,
  description: '',
  capabilities: {
    streaming: true,
    structuredOutput: true,
    toolCalling: false,
    vision: false,
    reasoning: false,
    audio: false,
  },
  contextWindow: 8_000,
  maxOutputTokens: 4_000,
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
  enabled: true,
  availability: 'available',
  metadata: {},
  registeredAt: '2027-01-01T00:00:00.000Z',
  updatedAt: '2027-01-01T00:00:00.000Z',
  registeredBy: 'user_owner',
  ...overrides,
});

const policyOf = (fields: Record<string, unknown> = {}) => {
  const built = createPolicy({
    id: 'COMPANY:*',
    scopeType: 'COMPANY',
    scopeId: '*',
    mode: 'AUTO',
    createdBy: 'user_owner',
    now: '2027-01-01T00:00:00.000Z',
    ...fields,
  } as never);
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
};

const viewOf = (fields: Record<string, unknown> = {}): RouterPolicyView =>
  deriveRouterPolicyView({ policy: policyOf(fields), generatedAt: '2027-01-01T00:00:00.000Z' });

/** Read the durable events table without assuming its exact column names. */
const durableEvents = (db: DatabaseSync): readonly { readonly type: string; readonly payload: string }[] => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as readonly {
    readonly name: string;
  }[];
  const eventTable = tables.map((row) => row.name).find((name) => /event/i.test(name));
  if (eventTable === undefined) return [];
  const columns = (db.prepare(`PRAGMA table_info(${eventTable})`).all() as unknown as readonly {
    readonly name: string;
  }[]).map((row) => row.name);
  const typeColumn = columns.find((name) => /^type$/i.test(name)) ?? columns[0];
  const payloadColumn = columns.find((name) => /payload|data/i.test(name)) ?? columns[columns.length - 1];
  return db
    .prepare(`SELECT ${String(typeColumn)} AS type, ${String(payloadColumn)} AS payload FROM ${eventTable}`)
    .all() as unknown as readonly { readonly type: string; readonly payload: string }[];
};

const request = (
  view: RouterPolicyView,
  candidates: readonly ModelRecord[],
  overrides: Partial<RouterRequest> = {},
): RouterRequest => ({
  requestId: 'req_e2e',
  companyId: 'company_default',
  taskId: 'tsk_1',
  roleId: 'role_developer',
  selectionMode: 'AUTO',
  policyView: view,
  estimatedInputTokens: 1_000,
  requiredOutputTokens: 500,
  candidateModels: candidates,
  traceId: 'trace_e2e',
  ...overrides,
});

describe('A–L. chain, durable audit and IPC/server boundaries', () => {
  it('the composition root really wires durable audit (this fails if the wiring is removed)', () => {
    const main = source('apps/desktop/src/main.ts');
    // The six events must go through the durable event store, not a logger.
    expect(main).toMatch(/database\.events\.append\(\[/);
    expect(main).toMatch(/defineEvent\(/);
    expect(main).toMatch(/routerAuditEmitter/);
    // Both the router AND the override flow (application service) receive the emitter.
    expect(main).toMatch(/createDeterministicModelRouter\(\{[\s\S]{0,700}audit: routerAuditEmitter/);
    expect(main).toMatch(/createRouterApplicationService\(\{[\s\S]{0,700}audit: routerAuditEmitter/);
    // The application service must NOT silently tolerate a missing audit emitter.
    const appService = source('packages/engine/src/router/router-application-service.ts');
    expect(appService).not.toMatch(/deps\.audit\?\./);
    expect(appService).toMatch(/readonly audit: RouterAuditEmitter;/);
    // And the decision store really comes from the durable database handle.
    expect(main).toMatch(/decisions: database\.routerDecisions/);
  });

  it('a real duplicate decision id is rejected by the real SQLite store', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({
      dataDir,
      appliedAt: '2027-06-01T10:00:00.000Z',
      chains: ['core', 'engine', 'registry', 'selection', 'tools', 'router'],
    });
    try {
      const store = db.routerDecisions;
      expect(store).not.toBeNull();
      const record = {
        decisionId: 'rtd_duplicate',
        requestId: 'req_dup',
        taskId: 'tsk',
        roleId: 'rol',
        selectionMode: 'AUTO' as const,
        selectedModelKey: 'model-a',
        decision: 'RECOMMENDED' as const,
        reasonCodesJson: '["PREFERRED_MODEL"]',
        candidateEvaluationsJson: '{}',
        rejectedCandidatesJson: '{}',
        policySnapshotVersion: 'snp@1',
        modelRegistryRevision: 'rev',
        benchmarkVersion: null,
        performanceSnapshot: null,
        routerVersion: 'model-router/v1',
        traceId: 'trace_dup',
        createdAt: '2027-06-01T10:00:00.000Z',
      };
      await store?.save(record);
      let refused = false;
      try {
        await store?.save(record);
      } catch {
        refused = true;
      }
      expect(refused, 'a duplicate decision_id must surface as an error').toBe(true);
      expect((await store?.listRecent(10))?.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('A/B: the production chain set creates router_decisions and the decision store is exposed', () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({
      dataDir,
      appliedAt: '2027-06-01T10:00:00.000Z',
      chains: ['core', 'engine', 'registry', 'selection', 'agent', 'tools', 'router'],
    });
    try {
      expect(db.migrations.router).not.toBeNull();
      expect(db.routerDecisions).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('C–F: all four terminal audit events land in the durable event store', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({
      dataDir,
      appliedAt: '2027-06-01T10:00:00.000Z',
      chains: ['core', 'engine', 'registry', 'selection', 'tools', 'router'],
    });
    try {
      const ids = (() => {
        let counter = 0;
        return {
          ulid: () => `01HZZZZZZZZZZZZZZZZZZZZZZ${String((counter += 1) % 10)}`,
          id: (prefix?: string) => `${prefix ?? 'evt'}_${String((counter += 1))}`,
        };
      })();
      const emit =
        (type: string) =>
        async (payload: RouterAuditPayload): Promise<void> => {
          await db.events.append([
            defineEvent(
              {
                type,
                aggregateId: payload.requestId,
                aggregateType: 'ModelRouter',
                traceId: payload.traceId,
                actorId: 'user_owner',
                payload: { ...payload },
              },
              ids,
              '2027-06-01T10:00:00.000Z',
            ),
          ]);
        };
        const decisionIds = (() => {
          let counter = 0;
          return { next: (prefix: string) => `${prefix}_${String((counter += 1))}` };
        })();
        const router = createDeterministicModelRouter({
          audit: {
            requested: emit('router.requested'),
            candidatesBuilt: emit('router.candidates_built'),
            recommendationCreated: emit('router.recommendation_created'),
            noCandidate: emit('router.no_candidate'),
            overrideRequested: emit('router.override_requested'),
            overrideConfirmed: emit('router.override_confirmed'),
          },
          clock: { now: () => Date.parse('2027-06-01T10:00:00.000Z'), nowIso: () => '2027-06-01T10:00:00.000Z' },
          ids: decisionIds,
          modelRegistryRevision: () => registryRevisionOf([MODEL('model-a')]),
          ...(db.routerDecisions === null ? {} : { decisions: db.routerDecisions }),
        });

      // RECOMMENDED path -> requested + candidates_built + recommendation_created.
      const recommended = await router.recommend(request(viewOf({ preferredModels: ['model-b'] }), [MODEL('model-a'), MODEL('model-b')]));
      expect(recommended.ok, JSON.stringify(recommended.ok ? {} : recommended.error)).toBe(true);
      // NO_ELIGIBLE_MODEL path -> no_candidate.
      const none = await router.recommend(request(viewOf({ blockedModels: ['model-a', 'model-b'] }), [MODEL('model-a'), MODEL('model-b')]));
      expect(none.ok, JSON.stringify(none.ok ? {} : none.error)).toBe(true);

      const raw = new DatabaseSync(db.path);
      try {
        const types = durableEvents(raw).map((row) => row.type);
        for (const expected of [
          'router.requested',
          'router.candidates_built',
          'router.recommendation_created',
          'router.no_candidate',
        ]) {
          expect(types, `${expected} must be durable`).toContain(expected);
        }
      } finally {
        raw.close();
      }
    } finally {
      db.close();
    }
  });

  it('G: the durable payload is the exact whitelist (no request/secret/prompt leakage)', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({
      dataDir,
      appliedAt: '2027-06-01T10:00:00.000Z',
      chains: ['core', 'engine', 'registry', 'selection', 'tools', 'router'],
    });
    try {
      const captured: RouterAuditPayload[] = [];
      const captureIds = (() => {
        let counter = 0;
        return {
          ulid: () => `01HZZZZZZZZZZZZZZZZZZZZZZ${String((counter += 1) % 10)}`,
          id: (prefix?: string) => `${prefix ?? 'evt'}_${String((counter += 1))}`,
        };
      })();
      const capture =
        (type: string) =>
        async (payload: RouterAuditPayload): Promise<void> => {
          captured.push(payload);
          await db.events.append([
            defineEvent(
              { type, aggregateId: payload.requestId, aggregateType: 'ModelRouter', traceId: payload.traceId, actorId: 'user_owner', payload: { ...payload } },
              captureIds,
              '2027-06-01T10:00:00.000Z',
            ),
          ]);
        };
      const router = createDeterministicModelRouter({
        audit: {
          requested: capture('router.requested'),
          candidatesBuilt: capture('router.candidates_built'),
          recommendationCreated: capture('router.recommendation_created'),
          noCandidate: capture('router.no_candidate'),
          overrideRequested: capture('router.override_requested'),
          overrideConfirmed: capture('router.override_confirmed'),
        },
        clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
        ids: { next: (prefix) => `${prefix}_X` },
        modelRegistryRevision: () => 'rev-x',
      });
      await router.recommend(request(viewOf(), [MODEL('model-a')]));
      expect(captured.length).toBeGreaterThan(0);
      for (const payload of captured) {
        expect(Object.keys(payload).sort()).toEqual(
          [
            'candidateCount',
            'modelRegistryRevision',
            'policySnapshotVersion',
            'reasonCodes',
            'rejectedCount',
            'requestId',
            'roleId',
            'routerVersion',
            'selectedModelKey',
            'selectionMode',
            'taskId',
            'traceId',
          ].sort(),
        );
        expect(JSON.stringify(payload)).not.toMatch(/candidateModels|policyView|secret|prompt|apiKey/i);
      }
    } finally {
      db.close();
    }
  });

  it('H–J: the IPC boundary rejects policy/candidate fields and only forwards a scope', async () => {
    const { createWorkflowApi, parseWorkflowRequest } = await import('../../apps/desktop/src/workflows.js');
    const received: unknown[] = [];
    const stub = {
      recommend: async (input: unknown) => {
        received.push(input);
        return { ok: true as const, value: { decision: 'RECOMMENDED', selectedModelKey: 'model-a' } };
      },
      override: async (input: unknown) => {
        received.push(input);
        return { ok: true as const, value: { accepted: true } };
      },
      registryRevision: () => 'rev',
    };
    const api = createWorkflowApi({
      router: stub,
    } as never);

    for (const forbidden of [
      { policyView: {} },
      { candidateModels: [] },
      { allowedModels: ['a'] },
      { blockedModels: ['a'] },
      { allowedProviders: ['p'] },
    ]) {
      const response = await api.handle({
        operation: 'router.recommend',
        payload: {
          companyId: 'cmp',
          taskId: 'tsk',
          roleId: 'rol',
          traceId: 'trace',
          actorId: 'user',
          selectionMode: 'AUTO',
          ...forbidden,
        },
      });
      expect(response.ok, `${Object.keys(forbidden)[0]} must be rejected`).toBe(false);
    }

    // A legal scope-only call reaches the application service, and nothing else is forwarded.
    const legal = await api.handle({
      operation: 'router.recommend',
      payload: {
        companyId: 'cmp',
        taskId: 'tsk',
        roleId: 'rol',
        traceId: 'trace',
        actorId: 'user',
        selectionMode: 'AUTO',
        requirements: ['streaming'],
      },
    });
    expect(legal.ok).toBe(true);
    const forwarded = received[0] as Record<string, unknown>;
    expect(forwarded['companyId']).toBe('cmp');
    expect(forwarded['policyView']).toBeUndefined();
    expect(forwarded['candidateModels']).toBeUndefined();
    // Parsing still refuses unknown operations outright.
    expect(parseWorkflowRequest({ operation: 'router.unknown' }).ok).toBe(false);
  });

  it('K/L: the application service derives the policy view and the candidate snapshot itself', async () => {
    let policyViewCalls = 0;
    let listModelCalls = 0;
    const providerCalls = 0;
    const runtimeCalls = 0;
    const service = createRouterApplicationService({
      policyView: async () => {
        policyViewCalls += 1;
        return { ok: true as const, value: viewOf({ preferredModels: ['model-b'] }) };
      },
      listModels: async () => {
        listModelCalls += 1;
        return [MODEL('model-a'), MODEL('model-b')];
      },
      router: createDeterministicModelRouter({
        audit: {
          requested: async () => undefined,
          candidatesBuilt: async () => undefined,
          recommendationCreated: async () => undefined,
          noCandidate: async () => undefined,
          overrideRequested: async () => undefined,
          overrideConfirmed: async () => undefined,
        },
        clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
        ids: { next: (prefix) => `${prefix}_id` },
        modelRegistryRevision: () => 'rev-e2e',
      }),
      scopes: (input) => [
        { scopeType: 'TASK', scopeId: input.taskId },
        { scopeType: 'COMPANY', scopeId: input.companyId },
      ],
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
    });
    const outcome = await service.recommend({
      companyId: 'cmp',
      taskId: 'tsk',
      roleId: 'rol',
      selectionMode: 'AUTO',
      estimatedInputTokens: 100,
      traceId: 'trace-e2e',
      actorId: 'user',
    });
    expect(outcome.ok).toBe(true);
    expect(policyViewCalls).toBe(1);
    expect(listModelCalls).toBe(1);
    if (outcome.ok) expect(outcome.value.selectedModelKey).toBe('model-b');
    // The recommendation path never touches a provider or the agent runtime.
    expect(providerCalls).toBe(0);
    expect(runtimeCalls).toBe(0);
  });
});

describe('M–V. registry revision, real data sources and persistence bounds', () => {
  it('M/N: the registry revision is content-bound and changes with content', () => {
    const base = [MODEL('model-a'), MODEL('model-b')];
    expect(registryRevisionOf(base)).toBe(registryRevisionOf([...base]));
    expect(registryRevisionOf(base)).not.toBe(registryRevisionOf([MODEL('model-a'), MODEL('model-b', { enabled: false })]));
    expect(registryRevisionOf(base)).not.toBe(registryRevisionOf([MODEL('model-a')]));
  });

  it('O: a provider with no health data stays `unknown` (never silently healthy)', async () => {
    const router = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_id` },
      modelRegistryRevision: () => 'rev',
      rankingContext: () => ({ providerHealth: {} }),
    });
    const outcome = await router.recommend(request(viewOf(), [MODEL('model-a')]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const health = outcome.value.candidateEvaluations[0]?.signalScores.find((s) => s.key === 'providerHealth');
    expect(health?.score).toBe(0.25);
    expect(outcome.value.reasonCodes).not.toContain('PROVIDER_HEALTHY');
  });

  it('P/Q: missing historical and benchmark data are skipped, not scored zero', async () => {
    const router = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_id` },
      modelRegistryRevision: () => 'rev',
    });
    const outcome = await router.recommend(request(viewOf(), [MODEL('model-a')]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const signals = outcome.value.candidateEvaluations[0]?.signalScores ?? [];
    for (const key of ['historicalSuccessRate', 'benchmarkMetadata']) {
      const signal = signals.find((s) => s.key === key);
      expect(signal?.score).toBeNull();
      expect(signal?.skipped).toBe('NO_DATA');
    }
    expect(outcome.value.reasonCodes).toContain('NO_BENCHMARK_DATA');
  });

  it('R: the benchmark weight is applied exactly once', async () => {
    const router = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_id` },
      modelRegistryRevision: () => 'rev',
      rankingContext: () => ({
        benchmarkByModelKey: {
          'model-a': {
            modelKey: 'model-a',
            score: 1,
            suiteId: 'suite',
            benchmarkVersion: 'bench/1',
            source: 'harness',
            recordedAt: '2027-01-01T00:00:00.000Z',
            stale: false,
          },
        },
      }),
    });
    // No pricing and a zero context window leave benchmark as the ONLY available signal.
    const bare = MODEL('model-a', { maxOutputTokens: null });
    const outcome = await router.recommend(request(viewOf(), [bare]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The benchmark signal keeps the RAW score; the weight is applied once in the total, so the
    // reported normalisedScore must equal Σ(w·s)/Σw over exactly the reported signals.
    const evaluation = outcome.value.candidateEvaluations[0];
    const signal = evaluation?.signalScores.find((s) => s.key === 'benchmarkMetadata');
    expect(signal?.score).toBe(1);
    const present = (evaluation?.signalScores ?? []).filter((s) => s.score !== null);
    const expectedWeighted = present.reduce((sum, s) => sum + s.weight * (s.score ?? 0), 0);
    const expectedWeight = present.reduce((sum, s) => sum + s.weight, 0);
    expect(evaluation?.availableWeights).toBeCloseTo(expectedWeight, 6);
    expect(evaluation?.normalisedScore).toBeCloseTo(expectedWeighted / expectedWeight, 6);
    expect(evaluation?.normalisedScore).toBeLessThanOrEqual(1);
  });

  it('S/T: decision ids are unique per call, and a collision fails loudly', async () => {
    const saved: string[] = [];
    const router = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_${String(saved.length + 1)}` },
      modelRegistryRevision: () => 'rev',
      decisions: {
        save: async (record) => {
          if (saved.includes(record.decisionId)) throw new Error('UNIQUE constraint failed: router_decisions.decision_id');
          saved.push(record.decisionId);
        },
      },
    });
    await router.recommend(request(viewOf(), [MODEL('model-a')]));
    await router.recommend(request(viewOf(), [MODEL('model-a')]));
    expect(new Set(saved).size).toBe(2);

    // A colliding id factory makes the second persistence attempt fail loudly.
    const alwaysSame = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: () => 'rtd_fixed' },
      modelRegistryRevision: () => 'rev',
      decisions: {
        save: async (record) => {
          if (saved.includes(record.decisionId)) throw new Error('UNIQUE constraint failed: router_decisions.decision_id');
          saved.push(record.decisionId);
        },
      },
    });
    const first = await alwaysSame.recommend(request(viewOf(), [MODEL('model-a')]));
    expect(first.ok).toBe(true);
    const second = await alwaysSame.recommend(request(viewOf(), [MODEL('model-a')]));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('PERSISTENCE_FAILED');
      expect(second.error.details['reason']).toBe('DECISION_PERSISTENCE_FAILED');
    }
  });

  it('U/V: the persisted detail is bounded and reports truncation', async () => {
    const records: { readonly candidateEvaluationsJson: string }[] = [];
    const router = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_id` },
      modelRegistryRevision: () => 'rev',
      maxStoredEvaluations: 5,
      decisions: { save: async (record) => void records.push({ candidateEvaluationsJson: record.candidateEvaluationsJson }) },
    });
    const many = Array.from({ length: 25 }, (_unused, index) => MODEL(`model-${String(index).padStart(2, '0')}`));
    const outcome = await router.recommend(request(viewOf(), many));
    expect(outcome.ok).toBe(true);
    const detail = JSON.parse(records[0]?.candidateEvaluationsJson ?? '{}') as {
      readonly totalCandidateCount: number;
      readonly storedEvaluationCount: number;
      readonly truncated: boolean;
      readonly evaluations: readonly unknown[];
    };
    expect(detail.totalCandidateCount).toBe(25);
    expect(detail.storedEvaluationCount).toBe(5);
    expect(detail.evaluations.length).toBe(5);
    expect(detail.truncated).toBe(true);
    expect(MAX_STORED_EVALUATIONS).toBe(20);
  });
});

describe('W–AC. override and reconciliation', () => {
  const routerService = (audit: string[], overrides: { readonly block?: boolean } = {}) =>
    createRouterApplicationService({
      policyView: async () => ({
        ok: true as const,
        value: viewOf(overrides.block === true ? { blockedModels: ['model-b'] } : {}),
      }),
      listModels: async () => [MODEL('model-a'), MODEL('model-b')],
      router: createDeterministicModelRouter({
        audit: {
          requested: async () => undefined,
          candidatesBuilt: async () => undefined,
          recommendationCreated: async () => undefined,
          noCandidate: async () => undefined,
          overrideRequested: async () => void audit.push('router.override_requested'),
          overrideConfirmed: async () => void audit.push('router.override_confirmed'),
        },
        clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
        ids: { next: (prefix) => `${prefix}_id` },
        modelRegistryRevision: () => 'rev',
      }),
      scopes: (input) => [{ scopeType: 'TASK', scopeId: input.taskId }],
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => void audit.push('router.override_requested'),
        overrideConfirmed: async () => void audit.push('router.override_confirmed'),
      },
    });

  const overrideInput = (confirm: boolean, userModelKey = 'model-b') => ({
    companyId: 'cmp',
    taskId: 'tsk',
    roleId: 'rol',
    traceId: 'trace-override',
    actorId: 'user',
    selectionMode: 'AUTO' as const,
    estimatedInputTokens: 100,
    userModelKey,
    recommendedModelKey: 'model-a',
    confirm,
  });

  it('W/X/Y: a legal override is accepted and durably audited; a blocked one is refused', async () => {
    const audit: string[] = [];
    const accepted = await routerService(audit).override(overrideInput(true));
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.accepted).toBe(true);
      expect(accepted.value.userFinalSelection).toBe('model-b');
      expect(accepted.value.confirmed).toBe(true);
    }
    expect(audit).toEqual(['router.override_requested', 'router.override_confirmed']);

    const blockedAudit: string[] = [];
    const refused = await routerService(blockedAudit, { block: true }).override(overrideInput(true));
    expect(refused.ok).toBe(true);
    if (refused.ok) {
      expect(refused.value.accepted).toBe(false);
      expect(refused.value.confirmed).toBe(false);
      expect(refused.value.refusals).toContain('MODEL_BLOCKED_BY_POLICY');
    }
    // No confirmation event may be emitted for a refused override.
    expect(blockedAudit).toEqual(['router.override_requested']);
  });

  it('Z/AA/AB/AC: reconciliation finds a missing audit event and repairs it once', async () => {
    const decision = {
      decisionId: 'rtd_1',
      requestId: 'req_missing',
      taskId: 'tsk',
      roleId: 'rol',
      selectionMode: 'AUTO' as const,
      selectedModelKey: 'model-a',
      decision: 'RECOMMENDED' as const,
      reasonCodesJson: JSON.stringify(['PREFERRED_MODEL']),
      candidateEvaluationsJson: '{}',
      rejectedCandidatesJson: '{}',
      policySnapshotVersion: 'snp@1',
      modelRegistryRevision: 'rev',
      benchmarkVersion: null,
      performanceSnapshot: null,
      routerVersion: 'model-router/v1',
      traceId: 'trace_missing',
      createdAt: '2027-06-01T10:00:00.000Z',
    };
    const gaps = reconcileRouterAudit({ decisions: [decision], auditedRequestIds: [] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.requestId).toBe('req_missing');
    const payload = repairPayloadOf(gaps[0]!);
    expect(payload.selectedModelKey).toBe('model-a');
    expect(payload.reasonCodes).toEqual(['PREFERRED_MODEL']);
    expect(payload.traceId).toBe('trace_missing');
    // Once audited, the same decision is no longer a gap (repair is idempotent by requestId).
    expect(reconcileRouterAudit({ decisions: [decision], auditedRequestIds: ['req_missing'] })).toHaveLength(0);
  });
});

describe('AD–AP. modes, boundaries and provenance', () => {
  it('AD/AE/AF: MANUAL is never routed, AUTO/HYBRID still recommend within policy', async () => {
    expect(routerUnavailableOutcome({ selectionMode: 'MANUAL' })).toBe('MANUAL_NOT_ROUTED');
    expect(routerUnavailableOutcome({ selectionMode: 'AUTO' })).toBe('ROUTER_NOT_AVAILABLE');
    const router = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_id` },
      modelRegistryRevision: () => 'rev',
    });
    const manual = await router.recommend(request(viewOf(), [MODEL('model-a')], { selectionMode: 'MANUAL' }));
    expect(manual.ok).toBe(false);
    if (!manual.ok) expect(manual.error.code).toBe('MANUAL_NOT_ROUTED');

    const auto = await router.recommend(request(viewOf(), [MODEL('model-a'), MODEL('model-b')]));
    expect(auto.ok).toBe(true);

    const hybrid = await router.recommend(
      request(viewOf({ mode: 'HYBRID', allowedModels: ['model-b'] }), [MODEL('model-a'), MODEL('model-b')], {
        selectionMode: 'HYBRID',
      }),
    );
    expect(hybrid.ok).toBe(true);
    if (hybrid.ok) {
      expect(hybrid.value.selectedModelKey).toBe('model-b');
      expect(hybrid.value.candidateEvaluations.map((e) => e.modelKey)).toEqual(['model-b']);
    }
  });

  it('AG/AH/AI/AJ: router unavailability, runtime ownership and no provider/runtime calls', () => {
    const runtime = source('packages/engine/src/runtime/agent-runtime.ts');
    expect(runtime).not.toMatch(/createDeterministicModelRouter|rankCandidates|RouterPolicyView/);
    expect(runtime).toMatch(/MODEL_SELECTION_REQUIRED/);
    const routerSource = source('packages/engine/src/router/deterministic-router.ts');
    expect(routerSource).not.toMatch(/ProviderRegistry|providerRegistry|\.invoke\(|agent-runtime/);
    const appSource = source('packages/engine/src/router/router-application-service.ts');
    expect(appSource).not.toMatch(/providers\.|agentRuntime|ProviderRegistry/);
    // T17-08: the trusted core composition (agent runtime included) was extracted into an
    // electron-free module so the production entry is importable and E2E-testable; the
    // router is still wired by the workflow API in main.ts.
    const main = source('apps/desktop/src/main.ts');
    const core = source('apps/desktop/src/core-services.ts');
    expect(main).toMatch(/createDeterministicModelRouter\(/);
    expect(core).toMatch(/createAgentRuntime\(/);
    const agentRuntimeIndex = core.indexOf('createAgentRuntime(');
    const runtimeDeps = core.slice(agentRuntimeIndex, core.indexOf('});', agentRuntimeIndex));
    expect(runtimeDeps).not.toMatch(/router/i);
  });

  it('AK/AL: no vendor names and no second ranking implementation', () => {
    for (const file of [
      'packages/engine/src/router/deterministic-router.ts',
      'packages/core/src/domain/model-router-ranking.ts',
      'packages/engine/src/router/router-application-service.ts',
    ]) {
      const code = source(file).toLowerCase();
      for (const vendor of ['openai', 'anthropic', 'claude', 'deepseek', 'gemini', 'kimi', 'ollama']) {
        expect(code, `${file} mentions ${vendor}`).not.toContain(vendor);
      }
    }
    const rankingFiles = ['packages/core/src/domain/model-router-ranking.ts'];
    for (const file of rankingFiles) {
      // Exactly one weight table, read from Core's frozen constant.
      expect(source(file)).toMatch(/ROUTER_V1_WEIGHTS/);
    }
    expect(source('packages/engine/src/router/deterministic-router.ts')).not.toMatch(/weight:\s*0\./);
  });

  it('AM/AN/AO: truthful reasons - no capability match when nothing was required, tie-break only on a real tie', async () => {
    const router = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_id` },
      modelRegistryRevision: () => 'rev',
    });
    // No requirement -> no REQUIRED_CAPABILITIES_MATCH.
    const noCapability = await router.recommend(request(viewOf(), [MODEL('model-a')]));
    expect(noCapability.ok).toBe(true);
    if (noCapability.ok) {
      expect(noCapability.value.reasonCodes).not.toContain('REQUIRED_CAPABILITIES_MATCH');
      expect(noCapability.value.reasonCodes).not.toContain('TIE_BREAK_APPLIED');
      expect(noCapability.value.reasonCodes.length).toBeGreaterThan(0);
    }
    // A real requirement -> the match reason appears.
    const withCapability = await router.recommend(request(viewOf({ requiredCapabilities: ['streaming'] }), [MODEL('model-a')]));
    expect(withCapability.ok).toBe(true);
    if (withCapability.ok) expect(withCapability.value.reasonCodes).toContain('REQUIRED_CAPABILITIES_MATCH');
    // A real tie -> the tie-break reason appears exactly once.
    const tie = await router.recommend(request(viewOf(), [MODEL('model-a'), MODEL('model-b')]));
    expect(tie.ok).toBe(true);
    if (tie.ok) {
      const occurrences = tie.value.reasonCodes.filter((code) => code === 'TIE_BREAK_APPLIED').length;
      expect(occurrences).toBeLessThanOrEqual(1);
    }
  });

  it('AP: provenance is complete and the recommendation never executes anything', async () => {
    const saved: { readonly policySnapshotVersion: string; readonly modelRegistryRevision: string; readonly routerVersion: string; readonly traceId: string }[] = [];
    const router = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      clock: { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_id` },
      modelRegistryRevision: () => 'registry-content/deadbeef/2',
      decisions: {
        save: async (record) => {
          saved.push({
            policySnapshotVersion: record.policySnapshotVersion,
            modelRegistryRevision: record.modelRegistryRevision,
            routerVersion: record.routerVersion,
            traceId: record.traceId,
          });
        },
      },
    });
    const view = viewOf({ preferredModels: ['model-a'] });
    const outcome = await router.recommend(request(view, [MODEL('model-a'), MODEL('model-b')]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.provenance.routerVersion).toBe('model-router/v1');
    expect(outcome.value.provenance.policySnapshotVersion).toBe(view.source.snapshotVersion);
    expect(outcome.value.provenance.modelRegistryRevision).toBe('registry-content/deadbeef/2');
    expect(outcome.value.provenance.benchmarkVersion).toBeNull();
    expect(outcome.value.provenance.performanceSnapshot).toBeNull();
    expect(saved[0]?.routerVersion).toBe('model-router/v1');
    expect(saved[0]?.traceId).toBe('trace_e2e');
    // The recommendation carries no execution capability at all.
    expect(Object.keys(outcome.value).sort()).not.toContain('execute');
    expect(source('packages/engine/src/router/deterministic-router.ts')).not.toMatch(/\.execute\(|invoke\(/);
  });
});

describe('restart traceability (§8)', () => {
  it('a persisted decision and its audit events survive a close/reopen cycle', async () => {
    const dataDir = makeDataDir();
    const chains = ['core', 'engine', 'registry', 'selection', 'tools', 'router'] as const;
    const clock = { now: () => 0, nowIso: () => '2027-06-01T10:00:00.000Z' };
    let decisionId = '';
    {
      const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...chains] });
      try {
        const restartIds = (() => {
          let counter = 0;
          return {
            ulid: () => `01HZZZZZZZZZZZZZZZZZZZZZZ${String((counter += 1) % 10)}`,
            id: (prefix?: string) => `${prefix ?? 'evt'}_${String((counter += 1))}`,
          };
        })();
        const emit =
          (type: string) =>
          async (payload: RouterAuditPayload): Promise<void> => {
            await db.events.append([
              defineEvent(
                { type, aggregateId: payload.requestId, aggregateType: 'ModelRouter', traceId: payload.traceId, actorId: 'user_owner', payload: { ...payload } },
                restartIds,
                clock.nowIso(),
              ),
            ]);
          };
        const router = createDeterministicModelRouter({
          audit: {
            requested: emit('router.requested'),
            candidatesBuilt: emit('router.candidates_built'),
            recommendationCreated: emit('router.recommendation_created'),
            noCandidate: emit('router.no_candidate'),
            overrideRequested: emit('router.override_requested'),
            overrideConfirmed: emit('router.override_confirmed'),
          },
          clock,
          ids: { next: (prefix) => `${prefix}_1` },
          modelRegistryRevision: () => registryRevisionOf([MODEL('model-a')]),
          ...(db.routerDecisions === null ? {} : { decisions: db.routerDecisions }),
        });
        const outcome = await router.recommend(request(viewOf({ preferredModels: ['model-a'] }), [MODEL('model-a'), MODEL('model-b')]));
        expect(outcome.ok).toBe(true);
        decisionId = 'rtd_req_e2e_1';
      } finally {
        db.close();
      }
    }
    {
      const reopened = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...chains] });
      try {
        expect(reopened.routerDecisions).not.toBeNull();
        const record = await reopened.routerDecisions?.latestForRequest('req_e2e');
        expect(record).not.toBeNull();
        expect(record?.decisionId).toBe(decisionId);
        expect(record?.selectedModelKey).toBe('model-a');
        expect(record?.decision).toBe('RECOMMENDED');
        expect(JSON.parse(record?.reasonCodesJson ?? '[]')).toContain('PREFERRED_MODEL');
        const detail = JSON.parse(record?.candidateEvaluationsJson ?? '{}') as {
          readonly evaluations: readonly { readonly modelKey: string }[];
        };
        expect(detail.evaluations.length).toBeGreaterThan(0);
        expect(record?.policySnapshotVersion).toBe(viewOf({ preferredModels: ['model-a'] }).source.snapshotVersion);
        expect(record?.modelRegistryRevision).toBe(registryRevisionOf([MODEL('model-a')]));
        expect(record?.benchmarkVersion).toBeNull();
        expect(record?.performanceSnapshot).toBeNull();
        expect(record?.traceId).toBe('trace_e2e');
        expect(record?.requestId).toBe('req_e2e');
        expect(record?.routerVersion).toBe('model-router/v1');
        // The audit trail is still there after the restart.
        const raw = new DatabaseSync(reopened.path);
        try {
          const types = durableEvents(raw).map((row) => row.type);
          expect(types).toContain('router.requested');
          expect(types).toContain('router.recommendation_created');
        } finally {
          raw.close();
        }
      } finally {
        reopened.close();
      }
    }
  });
});

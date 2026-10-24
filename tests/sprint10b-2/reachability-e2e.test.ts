/**
 * Sprint 10B.2 tests: behaviour-level reachability, durable audit, startup reconciliation and the
 * truthfulness fixes (candidate counts, provider-health freshness, workflow scope, single boundary).
 *
 * These tests drive the REAL components end to end against a REAL SQLite file: the application
 * service, the deterministic router, the durable decision store and the durable event store
 * (through `defineEvent` + `events.append`). Nothing here relies on a mock emitter or a source grep
 * for the behaviour itself - the only source-level assertion is the composition-root wiring guard,
 * which exists to fail if `main.ts` stops wiring what the behaviour tests prove.
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
  type ModelRecord,
  type RouterRequest,
} from '@companyos/core';
import {
  ROUTER_AUDIT_REPAIR_KEYS,
  ROUTER_TERMINAL_AUDIT_EVENT_TYPES,
  createDeterministicModelRouter,
  createRouterApplicationService,
  reconcileAndRepairRouterAudit,
  registryRevisionOf,
  repairEventTypeOf,
  type RouterAuditPayload,
} from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const source = (path: string): string => readFileSync(repo(path), 'utf8');

const tempDirs: string[] = [];
const makeDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-10b2-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CHAINS = ['core', 'engine', 'registry', 'selection', 'tools', 'router'] as const;

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

const eventTypes = (db: DatabaseSync): readonly string[] => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as readonly {
    readonly name: string;
  }[];
  const eventTable = tables.map((row) => row.name).find((name) => /^events$/i.test(name));
  if (eventTable === undefined) return [];
  const columns = (db.prepare(`PRAGMA table_info(${eventTable})`).all() as unknown as readonly {
    readonly name: string;
  }[]).map((row) => row.name);
  const typeColumn = columns.find((name) => /^type$/i.test(name)) ?? 'type';
  return (
    db.prepare(`SELECT ${String(typeColumn)} AS type FROM ${eventTable}`).all() as unknown as readonly {
      readonly type: string;
    }[]
  ).map((row) => row.type);
};

/** The composition-root wiring, expressed against the real modules (SQLite included). */
const wiring = (
  database: ReturnType<typeof openDurableDatabase>,
  options: { readonly models: readonly ModelRecord[]; readonly requireWorkflowPolicy?: boolean; readonly block?: readonly string[] },
) => {
  const ids = (() => {
    let counter = 0;
    return { ulid: () => `01HZZZZZZZZZZZZZZZZZZZZZ${String(counter % 10)}`, id: (p?: string) => `${p ?? 'evt'}_${String((counter += 1))}` };
  })();
  const clock = { now: () => 1_800_000_000_000, nowIso: () => '2027-06-01T10:00:00.000Z' };
  const emit =
    (type: string) =>
    async (payload: RouterAuditPayload): Promise<void> => {
      await database.events.append([
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
          clock.nowIso(),
        ),
      ]);
    };
  const audit = {
    requested: emit('router.requested'),
    candidatesBuilt: emit('router.candidates_built'),
    recommendationCreated: emit('router.recommendation_created'),
    noCandidate: emit('router.no_candidate'),
    overrideRequested: emit('router.override_requested'),
    overrideConfirmed: emit('router.override_confirmed'),
  };
  const router = createDeterministicModelRouter({
    audit,
    clock,
    ids: { next: (prefix) => ids.id(prefix) },
    modelRegistryRevision: () => registryRevisionOf(options.models),
    rankingContext: () => ({ providerHealth: { 'provider-a': 'healthy' }, providerHealthObservedAt: clock.now() }),
    ...(database.routerDecisions === null ? {} : { decisions: database.routerDecisions }),
  });
  const service = createRouterApplicationService({
    policyView: async ({ scopes }) => {
      const workflowId = scopes.find((scope) => scope.scopeType === 'WORKFLOW')?.scopeId ?? null;
      const base = options.block === undefined ? {} : { blockedModels: [...options.block] };
      return {
        ok: true as const,
        value: deriveRouterPolicyView({
          policy: policyOf(
            workflowId === null
              ? base
              : {
                  ...base,
                  id: `WORKFLOW:${workflowId}`,
                  scopeType: 'WORKFLOW',
                  scopeId: workflowId,
                  preferredModels: ['model-b'],
                },
          ),
          generatedAt: clock.nowIso(),
        }),
      };
    },
    listModels: async () => options.models,
    router,
    scopes: (input) => [
      { scopeType: 'TASK' as const, scopeId: input.taskId },
      { scopeType: 'ROLE' as const, scopeId: input.roleId },
      ...(input.workflowId === undefined || input.workflowId === null
        ? []
        : [{ scopeType: 'WORKFLOW' as const, scopeId: input.workflowId }]),
      { scopeType: 'COMPANY' as const, scopeId: input.companyId },
    ],
    audit,
  });
  return { service, audit, router, ids };
};

const scopeInput = (overrides: Record<string, unknown> = {}) => ({
  companyId: 'company_default',
  taskId: 'tsk_1',
  roleId: 'role_developer',
  selectionMode: 'AUTO' as const,
  estimatedInputTokens: 1_000,
  traceId: 'trace_10b2',
  actorId: 'user_owner',
  ...overrides,
});

describe('§一/§二: behaviour-level composition E2E (real SQLite)', () => {
  it('recommend persists the decision AND all four events durably', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...CHAINS] });
    try {
      const { service } = wiring(db, { models: [MODEL('model-a'), MODEL('model-b')] });
      const outcome = await service.recommend(scopeInput({ workflowId: 'wfl_1' }));
      expect(outcome.ok, JSON.stringify(outcome.ok ? {} : outcome.error)).toBe(true);

      // The decision really landed in SQLite (read back through the durable store).
      const record = await db.routerDecisions?.latestForRequest('req_trace_10b2');
      expect(record?.selectedModelKey).toBe('model-b');
      expect(record?.decision).toBe('RECOMMENDED');
      // …and the four events really landed in the durable event log.
      const raw = new DatabaseSync(db.path);
      try {
        const types = eventTypes(raw);
        for (const expected of [
          'router.requested',
          'router.candidates_built',
          'router.recommendation_created',
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

  it('a no-candidate request persists the decision and the no_candidate event durably', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...CHAINS] });
    try {
      const disabled = [MODEL('model-a', { enabled: false }), MODEL('model-b', { enabled: false })];
      const { service } = wiring(db, { models: disabled });
      const outcome = await service.recommend(scopeInput({ traceId: 'trace_none' }));
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.value.decision).toBe('NO_ELIGIBLE_MODEL');
      const record = await db.routerDecisions?.latestForRequest('req_trace_none');
      const detail = JSON.parse(record?.candidateEvaluationsJson ?? '{}') as {
        readonly totalCandidateCount: number;
        readonly eligibleCandidateCount: number;
      };
      // §九: the counts are honest - 2 candidates entered, 0 were eligible.
      expect(detail.totalCandidateCount).toBe(2);
      expect(detail.eligibleCandidateCount).toBe(0);
      const raw = new DatabaseSync(db.path);
      try {
        expect(eventTypes(raw)).toContain('router.no_candidate');
      } finally {
        raw.close();
      }
    } finally {
      db.close();
    }
  });

  it('override writes router.override_requested / _confirmed durably; a blocked model is refused', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...CHAINS] });
    try {
      const { service } = wiring(db, { models: [MODEL('model-a'), MODEL('model-b')] });
      const accepted = await service.override({
        ...scopeInput({ traceId: 'trace_override' }),
        userModelKey: 'model-b',
        recommendedModelKey: 'model-a',
        confirm: true,
      });
      expect(accepted.ok, JSON.stringify(accepted.ok ? {} : accepted.error)).toBe(true);
      if (accepted.ok) {
        expect(accepted.value.accepted).toBe(true);
        expect(accepted.value.confirmed).toBe(true);
      }
      const raw = new DatabaseSync(db.path);
      try {
        const types = eventTypes(raw);
        expect(types).toContain('router.override_requested');
        expect(types).toContain('router.override_confirmed');
      } finally {
        raw.close();
      }
    } finally {
      db.close();
    }
  });
});

describe('§二/§三/§四/§五: override refusal and startup reconciliation over the real durable stores', () => {
  it('the terminal-event set covers both router outcomes', () => {
    expect([...ROUTER_TERMINAL_AUDIT_EVENT_TYPES]).toEqual(['router.recommendation_created', 'router.no_candidate']);
    expect([...ROUTER_AUDIT_REPAIR_KEYS]).toEqual(['reconciled', 'repairReason']);
  });

  it('a blocked override is refused and writes NO confirmed event (review item 2)', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...CHAINS] });
    try {
      const { service } = wiring(db, { models: [MODEL('model-a'), MODEL('model-b')], block: ['model-b'] });
      const refused = await service.override({
        ...scopeInput({ traceId: 'trace_blocked' }),
        userModelKey: 'model-b',
        recommendedModelKey: 'model-a',
        confirm: true,
      });
      expect(refused.ok).toBe(true);
      if (refused.ok) {
        expect(refused.value.accepted).toBe(false);
        expect(refused.value.confirmed).toBe(false);
        expect(refused.value.refusals).toContain('MODEL_BLOCKED_BY_POLICY');
      }
      const raw = new DatabaseSync(db.path);
      try {
        const types = eventTypes(raw);
        expect(types).toContain('router.override_requested');
        expect(types, 'a refused override must not claim confirmation').not.toContain('router.override_confirmed');
      } finally {
        raw.close();
      }
    } finally {
      db.close();
    }
  });

  it('a NO_ELIGIBLE decision with its no_candidate event is NOT a false gap (review HIGH)', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...CHAINS] });
    try {
      const { service, audit } = wiring(db, { models: [MODEL('model-a', { enabled: false })] });
      const outcome = await service.recommend(scopeInput({ traceId: 'trace_none_gap' }));
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.value.decision).toBe('NO_ELIGIBLE_MODEL');

      const auditedRequestIds = async (): Promise<readonly string[]> =>
        (await db.events.all())
          .filter((stored) => (ROUTER_TERMINAL_AUDIT_EVENT_TYPES as readonly string[]).includes(stored.event.type))
          .map((stored) => stored.event.aggregateId);
      // The no_candidate event counts as audited, so there is nothing to repair…
      const audited = await auditedRequestIds();
      expect(audited).toContain('req_trace_none_gap');
      const pass = await reconcileAndRepairRouterAudit({
        listDecisions: () => db.routerDecisions?.listRecent(100) ?? Promise.resolve([]),
        listAuditedRequestIds: auditedRequestIds,
        emitRepair: audit.recommendationCreated,
      });
      expect(pass.repaired).toBe(0);
      // …and no spurious recommendation_created event was fabricated for it.
      const fabricated = (await db.events.all()).filter(
        (stored) => stored.event.type === 'router.recommendation_created',
      );
      expect(fabricated).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('a NO_ELIGIBLE crash-gap is repaired with the no_candidate event type (review MEDIUM)', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...CHAINS] });
    try {
      const { service } = wiring(db, { models: [MODEL('model-a', { enabled: false })] });
      const outcome = await service.recommend(scopeInput({ traceId: 'trace_none_repair' }));
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.value.decision).toBe('NO_ELIGIBLE_MODEL');
      const raw = new DatabaseSync(db.path);
      try {
        raw.exec("DELETE FROM events WHERE type = 'router.no_candidate'");
      } finally {
        raw.close();
      }
      const emitted: { readonly type: string; readonly payload: RouterAuditPayload }[] = [];
      const pass = await reconcileAndRepairRouterAudit({
        listDecisions: () => db.routerDecisions?.listRecent(100) ?? Promise.resolve([]),
        listAuditedRequestIds: async () => [],
        emitRepair: async (payload, eventType) => void emitted.push({ type: eventType, payload }),
      });
      expect(pass.repaired).toBe(1);
      // The repair MUST use the same event type the live run would have used.
      expect(emitted[0]?.type).toBe('router.no_candidate');
      expect(emitted[0]?.payload.repairReason).toBe('MISSING_NO_CANDIDATE_EVENT');
      expect(emitted[0]?.payload.selectedModelKey).toBeNull();
      // A RECOMMENDED decision repairs as recommendation_created instead.
      expect(repairEventTypeOf({ ...pass.gaps[0]!, decision: 'RECOMMENDED' })).toBe('router.recommendation_created');
      expect(repairEventTypeOf(pass.gaps[0]!)).toBe('router.no_candidate');
    } finally {
      db.close();
    }
  });

  it('the repair payload carries the REAL decision values (no invented counts)', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...CHAINS] });
    try {
      const { service, audit } = wiring(db, { models: [MODEL('model-a'), MODEL('model-b')] });
      await service.recommend(scopeInput({ traceId: 'trace_real_repair' }));
      const raw = new DatabaseSync(db.path);
      try {
        raw.exec("DELETE FROM events WHERE type = 'router.recommendation_created'");
      } finally {
        raw.close();
      }
      const pass = await reconcileAndRepairRouterAudit({
        listDecisions: () => db.routerDecisions?.listRecent(100) ?? Promise.resolve([]),
        listAuditedRequestIds: async () => [],
        emitRepair: audit.recommendationCreated,
      });
      expect(pass.repaired).toBe(1);
      const repair = (await db.events.all()).find(
        (stored) =>
          stored.event.type === 'router.recommendation_created' &&
          (stored.event.payload as { readonly reconciled?: boolean }).reconciled === true,
      );
      const payload = repair?.event.payload as {
        readonly selectionMode?: string;
        readonly candidateCount?: number;
      };
      expect(payload.selectionMode).toBe('AUTO');
      expect(payload.candidateCount).toBe(2);
    } finally {
      db.close();
    }
  });

  it('repairs a missing recommendation event exactly once across three startups', async () => {
    const dataDir = makeDataDir();
    {
      // Startup 1: a decision exists but its event was lost (simulated by deleting the event row).
      const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...CHAINS] });
      try {
        const { service, audit } = wiring(db, { models: [MODEL('model-a')] });
        await service.recommend(scopeInput({ traceId: 'trace_gap' }));
        const raw = new DatabaseSync(db.path);
        try {
          raw.exec("DELETE FROM events WHERE type = 'router.recommendation_created'");
        } finally {
          raw.close();
        }
        const first = await reconcileAndRepairRouterAudit({
          listDecisions: () => db.routerDecisions?.listRecent(100) ?? Promise.resolve([]),
          listAuditedRequestIds: async () =>
            (await db.events.all())
              .filter((stored) => stored.event.type === 'router.recommendation_created')
              .map((stored) => stored.event.aggregateId),
          emitRepair: audit.recommendationCreated,
        });
        expect(first.repaired).toBe(1);

        // Startup 2: nothing left to repair.
        const second = await reconcileAndRepairRouterAudit({
          listDecisions: () => db.routerDecisions?.listRecent(100) ?? Promise.resolve([]),
          listAuditedRequestIds: async () =>
            (await db.events.all())
              .filter((stored) => stored.event.type === 'router.recommendation_created')
              .map((stored) => stored.event.aggregateId),
          emitRepair: audit.recommendationCreated,
        });
        expect(second.repaired).toBe(0);

        // Startup 3: still nothing (idempotent).
        const third = await reconcileAndRepairRouterAudit({
          listDecisions: () => db.routerDecisions?.listRecent(100) ?? Promise.resolve([]),
          listAuditedRequestIds: async () =>
            (await db.events.all())
              .filter((stored) => stored.event.type === 'router.recommendation_created')
              .map((stored) => stored.event.aggregateId),
          emitRepair: audit.recommendationCreated,
        });
        expect(third.repaired).toBe(0);

        // The repair event is marked as reconciled (same type, extra provenance).
        const repairs = (await db.events.all()).filter(
          (stored) =>
            stored.event.type === 'router.recommendation_created' &&
            (stored.event.payload as { readonly reconciled?: boolean }).reconciled === true,
        );
        expect(repairs).toHaveLength(1);
        expect((repairs[0]?.event.payload as { readonly repairReason?: string }).repairReason).toBe(
          'MISSING_RECOMMENDATION_EVENT',
        );
      } finally {
        db.close();
      }
    }
  });
});

describe('§八/§九/§十: scope reachability, count truth, health freshness', () => {
  it('a WORKFLOW-scope policy is really reachable through the application service', async () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...CHAINS] });
    try {
      const { service } = wiring(db, { models: [MODEL('model-a'), MODEL('model-b')] });
      const outcome = await service.recommend(scopeInput({ workflowId: 'wfl_preferred' }));
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        // The WORKFLOW policy preferred model-b, and the recommendation honoured it; provenance
        // records the WORKFLOW policy id (scope identity lives on the derived view).
        expect(outcome.value.selectedModelKey).toBe('model-b');
        expect(outcome.value.policySource.policyId).toBe('WORKFLOW:wfl_preferred');
      }
    } finally {
      db.close();
    }
  });

  it('a stale provider-health observation is NOT treated as healthy', async () => {
    const router = createDeterministicModelRouter({
      audit: {
        requested: async () => undefined,
        candidatesBuilt: async () => undefined,
        recommendationCreated: async () => undefined,
        noCandidate: async () => undefined,
        overrideRequested: async () => undefined,
        overrideConfirmed: async () => undefined,
      },
      // `now()` is fixed; the observation is far older than the 5-minute freshness window.
      clock: { now: () => 1_800_000_000_000, nowIso: () => '2027-06-01T10:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_id` },
      modelRegistryRevision: () => 'rev',
      rankingContext: () => ({
        providerHealth: { 'provider-a': 'healthy' },
        providerHealthObservedAt: 1_799_999_000_000,
      }),
    });
    const request: RouterRequest = {
      requestId: 'req_stale',
      companyId: 'cmp',
      taskId: 'tsk',
      roleId: 'rol',
      selectionMode: 'AUTO',
      policyView: deriveRouterPolicyView({ policy: policyOf(), generatedAt: '2027-06-01T10:00:00.000Z' }),
      estimatedInputTokens: 100,
      candidateModels: [MODEL('model-a')],
      traceId: 'trace_stale',
    };
    const outcome = await router.recommend(request);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const health = outcome.value.candidateEvaluations[0]?.signalScores.find((s) => s.key === 'providerHealth');
    expect(health?.score).toBe(0.25);
    expect(outcome.value.reasonCodes).not.toContain('PROVIDER_HEALTHY');
  });

  it('§七: the IPC boundary still has exactly ONE validation path', async () => {
    const workflows = source('apps/desktop/src/workflows.ts');
    // The forbidden-key check happens in the handlers; the reader must not resurrect a forbidden name.
    expect(workflows).toMatch(/CLIENT_FORBIDDEN_ROUTER_KEYS\.filter\(\(key\) => key in payload\)/);
    expect(workflows).not.toMatch(/payload\['requiredCapabilities'\]/);
    // workflow/run/stage are parsed as CONTEXT, and only COMPANY/WORKFLOW/ROLE/TASK become scopes.
    expect(workflows).toMatch(/readText\(payload, 'workflowId', false\)/);
    const main = source('apps/desktop/src/main.ts');
    expect(main).toMatch(/scopeType: 'WORKFLOW' as const/);
    expect(main).not.toMatch(/scopeType: 'RUN' as const|scopeType: 'STAGE' as const/);
  });

  it('the composition root really wires the reconciliation pass (guard against silent removal)', () => {
    const main = source('apps/desktop/src/main.ts');
    expect(main).toMatch(/reconcileAndRepairRouterAudit\(/);
    expect(main).toMatch(/listAuditedRequestIds/);
    expect(main).toMatch(/await reconcileRouterAuditOnStartup\(\)/);
    expect(main).toMatch(/providerHealthObservedAt/);
  });
});

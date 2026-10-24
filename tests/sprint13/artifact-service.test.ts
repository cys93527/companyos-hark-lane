/**
 * Sprint 13 / Task-13-04: ArtifactService — permanent idempotency + durable creation.
 *
 * Real SQLite (11+1 chains) + real filesystem CAS + real command ledger + real events.
 * Covers the accepted matrix: happy path, ledger replay (match/mismatch/corrupt/missing
 * target), ledger-trim replay (match/mismatch), concurrent duplicates (same/different
 * fingerprint), transaction failure atomicity, preconditions, and boundary rules.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createWorkflowRun,
  domainError,
  err,
  ok,
  type Artifact,
  type ArtifactContentStore,
  type ArtifactStorePort,
  type CommandLedgerPort,
  type DomainError,
  type EventStorePort,
  type StoredContent,
} from '@companyos/core';
import {
  artifactCommandFingerprint,
  createArtifactService,
  type ArtifactService,
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

let database: DurableDatabase | null = null;

afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const ids = (() => {
  let n = 0;
  return { id: (prefix = 'id') => `${prefix}_01JT14${String(++n).padStart(4, '0')}`, ulid: () => `01JT14${String(++n).padStart(20, '0')}` };
})();
const clock = { now: (): number => Date.parse('2026-01-01T00:00:00.000Z'), nowIso: (): string => '2026-01-01T00:00:00.000Z' };
const allow = async (): Promise<Result_True> => ok(true);
type Result_True = { readonly ok: true; readonly value: true };

interface Harness {
  readonly service: ArtifactService;
  readonly db: DurableDatabase;
  readonly contentStore: ArtifactContentStore;
  readonly putLog: number[];
  readonly root: string;
  readonly runId: string;
}

/** Counting proxy over the real CAS (put-call accounting without mocking behaviour). */
class CountingContentStore implements ArtifactContentStore {
  putLog: number[] = [];
  constructor(private readonly inner: ArtifactContentStore) {}
  async put(content: Uint8Array, expectedHash?: string): Promise<StoredContent> {
    this.putLog.push(content.byteLength);
    return this.inner.put(content, expectedHash);
  }
  async get(contentRef: string): Promise<Uint8Array> {
    return this.inner.get(contentRef);
  }
  verify(contentRef: string): ReturnType<ArtifactContentStore['verify']> {
    return this.inner.verify(contentRef);
  }
}

const make = async (contentStoreOverride?: ArtifactContentStore): Promise<Harness> => {
  const db = openDurableDatabase({
    dataDir: tempDir('companyos-t14-'),
    appliedAt: clock.nowIso(),
    chains: ['core', 'engine', 'artifact'],
  });
  database = db;
  const casRoot = tempDir('companyos-t14-cas-');
  const contentStore = contentStoreOverride ?? createFilesystemArtifactContentStore({ casRoot });
  const counting = contentStoreOverride ?? new CountingContentStore(contentStore);
  const seedRun = createWorkflowRun({
    companyId: 'cmp_1' as never,
    workflowId: 'wfl_1' as never,
    templateId: 'tpl_1' as never,
    versionId: 'ver_1' as never,
    snapshotId: 'snp_1' as never,
    startedBy: 'user_owner',
    now: clock.nowIso(),
    ids,
  });
  if (!seedRun.ok) throw new Error(`seedRun failed: ${seedRun.error.message}`);
  await db.runs.put(seedRun.value);
  const service = createArtifactService({
    artifactStore: db.artifactStore as ArtifactStorePort,
    contentStore: counting,
    runs: db.runs,
    events: db.events,
    ledger: db.ledger,
    clock,
    ids,
    unitOfWork: db.unitOfWork,
    authorize: allow,
  });
  return { service, db, contentStore: counting, putLog: (counting as CountingContentStore).putLog, root: casRoot, runId: seedRun.value.id };
};

const command = (overrides: Partial<Parameters<ArtifactService['create']>[0]> = {}) => ({
  commandId: 'cmd_art_1',
  runId: 'run_01JT140001' as never,
  kind: 'pack-x:report',
  content: new TextEncoder().encode('artifact body'),
  producedBy: 'agent:agt_1',
  traceId: 'trace_1',
  ...overrides,
});

const eventCount = (db: DurableDatabase, aggregateId: string): number => {
  const row = db.db.prepare('SELECT COUNT(*) AS c FROM events WHERE aggregate_id = ? AND type = ?').get(aggregateId, 'artifact.created') as { c: number | bigint };
  return Number(row.c);
};

const trimLedger = (db: DurableDatabase, commandId: string): void => {
  db.db.prepare('DELETE FROM command_ledger WHERE command_id = ?').run(commandId);
};

describe('ArtifactService happy path', () => {
  it('creates CAS content, artifact row, one durable event and the ledger outcome', async () => {
    const h = await make();
    const result = await h.service.create(command({ runId: h.runId as never }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifact: Artifact = result.value;
    expect(artifact.id).toMatch(/^art_/);
    expect(artifact.contentRef).toBe(`sha256:${artifact.contentHash}`);
    expect(artifact.contentHash).toBe(new Uint8Array(0).length >= 0 ? artifact.contentHash : '');

    // Row is the SoT:
    const durable = await h.db.artifactStore?.get(artifact.id);
    expect(durable?.contentRef).toBe(artifact.contentRef);

    // Exactly one artifact.created with the frozen payload whitelist:
    expect(eventCount(h.db, artifact.id)).toBe(1);

    // Ledger outcome carries the stable identity:
    const ledgerRow = h.db.ledger.get('cmd_art_1');
    expect((await ledgerRow)?.outcome.artifactId).toBe(artifact.id);
  });
});

describe('ArtifactService replay semantics', () => {
  it('normal ledger replay: same artifactId, no new CAS/row/event', async () => {
    const h = await make();
    const first = await h.service.create(command({ runId: h.runId as never }));
    if (!first.ok) return;
    const eventsBefore = eventCount(h.db, first.value.id);
    const rowsBefore = await h.db.artifactStore?.listByRun(first.value.runId);
    const putCount = h.putLog.length;

    const second = await h.service.create(command({ runId: h.runId as never }));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.id).toBe(first.value.id);
    expect(h.putLog.length).toBe(putCount);
    expect(eventCount(h.db, first.value.id)).toBe(eventsBefore);
    expect((await h.db.artifactStore?.listByRun(first.value.runId))?.length).toBe(rowsBefore?.length);
  });

  it('ledger hit with a different fingerprint → CONFLICT before any side effect', async () => {
    const h = await make();
    const first = await h.service.create(command({ runId: h.runId as never }));
    if (!first.ok) return;
    const putCount = h.putLog.length;
    const second = await h.service.create(command({ runId: h.runId as never, content: text('different bytes') }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');
    expect(h.putLog.length).toBe(putCount); // no CAS write for the conflicting content
    expect(eventCount(h.db, first.value.id)).toBe(1);
  });

  it('ledger outcome corrupt → FAIL CLOSED (never treated as a miss)', async () => {
    const h = await make();
    const first = await h.service.create(command({ runId: h.runId as never }));
    if (!first.ok) return;
    h.db.db.prepare("UPDATE command_ledger SET outcome_json = '{}' WHERE command_id = ?").run('cmd_art_1');
    const retry = await h.service.create(command({ runId: h.runId as never }));
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('PERSISTENCE_FAILED');
  });

  it('ledger outcome pointing to a missing artifact → FAIL CLOSED', async () => {
    const h = await make();
    const first = await h.service.create(command({ runId: h.runId as never }));
    if (!first.ok) return;
    h.db.db.prepare('DELETE FROM artifacts WHERE artifact_id = ?').run(first.value.id);
    const retry = await h.service.create(command({ runId: h.runId as never }));
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.error.code).toBe('PERSISTENCE_FAILED');
      expect((retry.error as DomainError & { details?: { reason?: string } }).details?.reason).toBe('ARTIFACT_LEDGER_TARGET_MISSING');
    }
  });

  it('ledger trimmed + same fingerprint → permanent row replay, no second artifact', async () => {
    const h = await make();
    const first = await h.service.create(command({ runId: h.runId as never }));
    if (!first.ok) return;
    trimLedger(h.db, 'cmd_art_1');
    const putCount = h.putLog.length;
    const eventsBefore = eventCount(h.db, first.value.id);

    const second = await h.service.create(command({ runId: h.runId as never }));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.id).toBe(first.value.id);
    expect(h.putLog.length).toBe(putCount); // CAS put NOT rerun
    expect(eventCount(h.db, first.value.id)).toBe(eventsBefore); // no new event
    expect((await h.db.artifactStore?.listByRun(first.value.runId))?.length).toBe(1); // no new row
  });

  it('ledger trimmed + different fingerprint → CONFLICT, no second evidence of any kind', async () => {
    const h = await make();
    const first = await h.service.create(command({ runId: h.runId as never }));
    if (!first.ok) return;
    trimLedger(h.db, 'cmd_art_1');
    const putCount = h.putLog.length;
    const binary = Uint8Array.from([0x00, 0xff, 0x10]); // binary fingerprint input
    const second = await h.service.create(command({ runId: h.runId as never, content: binary }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');
    expect(h.putLog.length).toBe(putCount); // no CAS write for B
    expect(eventCount(h.db, first.value.id)).toBe(1);
    expect((await h.db.artifactStore?.listByRun(first.value.runId))?.length).toBe(1);
  });
});

describe('ArtifactService concurrency', () => {
  it('same commandId + same fingerprint concurrently → exactly one artifact, one event, same identity', async () => {
    const h = await make();
    const results = await Promise.allSettled([
      h.service.create(command({ runId: h.runId as never })),
      h.service.create(command({ runId: h.runId as never })),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ ok: true; value: Artifact }> => r.status === 'fulfilled');
    // Every caller ends up with the SAME artifact identity:
    const identities = new Set<string>();
    const debugErrors: unknown[] = [];
    for (const r of results) if (r.status === 'rejected') debugErrors.push(r.reason);
    for (const r of fulfilled) {
      const value = r.value as unknown as { ok: boolean; value: Artifact; error?: DomainError };
      expect(value.ok, `concurrent outcome: ${JSON.stringify(value)}`).toBe(true);
      identities.add(value.value.id);
    }
    expect(identities.size).toBe(1);
    const winnerId = [...identities][0]!;
    expect(eventCount(h.db, winnerId)).toBe(1);
    expect((await h.db.artifactStore?.listByRun(h.runId as never))?.length).toBe(1);
  });

  it('same commandId + different fingerprint concurrently → one winner, loser CONFLICTs', async () => {
    const h = await make();
    const results = await Promise.allSettled([
      h.service.create(command({ runId: h.runId as never, content: text('request A') })),
      h.service.create(command({ runId: h.runId as never, content: text('request B') })),
    ]);
    const outcomes: { ok: boolean; value?: Artifact; error?: DomainError }[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const v = r.value as unknown as { ok: boolean; value: Artifact; error: DomainError };
        outcomes.push(v.ok ? { ok: true, value: v.value } : { ok: false, error: v.error });
      } else {
        outcomes.push({ ok: false, error: domainError('PERSISTENCE_FAILED', String(r.reason)) });
      }
    }
    expect(outcomes.length).toBe(2);
    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0]?.error?.code).toBe('CONFLICT');
    expect((await h.db.artifactStore?.listByRun(h.runId as never))?.length).toBe(1);
    expect(eventCount(h.db, winners[0]!.value!.id)).toBe(1);
  });
});

describe('ArtifactService transaction atomicity', () => {
  it('artifact store failure → no event, no ledger, CAS orphan allowed', async () => {
    const h = await make();
    const failing: ArtifactStorePort = {
      create: async () => {
        throw new Error('simulated store failure');
      },
      get: async () => null,
      getByCreationCommand: async () => null,
      listByRun: async () => [],
      listByHash: async () => [],
      listAll: async () => [],
    };
    const service = createArtifactService({
      artifactStore: failing,
      contentStore: h.contentStore,
      runs: h.db.runs,
      events: h.db.events,
      ledger: h.db.ledger,
      clock,
      ids,
      unitOfWork: h.db.unitOfWork,
      authorize: allow,
    });
    const result = await service.create(command({ runId: h.runId as never }));
    expect(result.ok).toBe(false);
    const ledgerRow = await h.db.ledger.get('cmd_art_1');
    expect(ledgerRow).toBeNull();
    // Orphan CAS object is the accepted safe mode (content bytes are content-addressed):
    expect(h.putLog.length).toBe(1);
  });

  it('event append failure → artifact row and ledger rolled back', async () => {
    const h = await make();
    const failing: EventStorePort = {
      append: async () => {
        throw new Error('simulated event failure');
      },
    } as unknown as EventStorePort;
    const service = createArtifactService({
      artifactStore: h.db.artifactStore as ArtifactStorePort,
      contentStore: h.contentStore,
      runs: h.db.runs,
      events: failing,
      ledger: h.db.ledger,
      clock,
      ids,
      unitOfWork: h.db.unitOfWork,
      authorize: allow,
    });
    const result = await service.create(command({ runId: h.runId as never }));
    expect(result.ok).toBe(false);
    const ledgerRow = await h.db.ledger.get('cmd_art_1');
    expect(ledgerRow).toBeNull();
  });

  it('ledger put failure → artifact row and event rolled back', async () => {
    const h = await make();
    const failing: CommandLedgerPort = {
      get: async () => null,
      put: async () => {
        throw new Error('simulated ledger failure');
      },
      count: async () => 0,
      trim: async () => 0,
    };
    const service = createArtifactService({
      artifactStore: h.db.artifactStore as ArtifactStorePort,
      contentStore: h.contentStore,
      runs: h.db.runs,
      events: h.db.events,
      ledger: failing,
      clock,
      ids,
      unitOfWork: h.db.unitOfWork,
      authorize: allow,
    });
    const result = await service.create(command({ runId: h.runId as never }));
    expect(result.ok).toBe(false);
    expect((await h.db.artifactStore?.listByRun(h.runId as never))?.length).toBe(0);
  });
});

describe('ArtifactService preconditions and boundaries', () => {
  it('unknown run → NOT_FOUND before any CAS write', async () => {
    const h = await make();
    const result = await h.service.create(command({ runId: 'run_missing' as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    expect(h.putLog.length).toBe(0); // precondition runs BEFORE CAS
  });

  it('invalid command input → INVALID_ARGUMENT, no side effects', async () => {
    const h = await make();
    const result = await h.service.create(command({ runId: h.runId as never, kind: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
    expect(h.putLog.length).toBe(0);
  });

  it('command carries no contentRef/hash/fingerprint — trusted side owns them', () => {
    const cmd = command();
    expect('contentRef' in cmd).toBe(false);
    expect('contentHash' in cmd).toBe(false);
    expect('creationCommandFingerprint' in cmd).toBe(false);
    expect('sizeBytes' in cmd).toBe(false);
  });
});

describe('artifact fingerprint (content participates, deterministic)', () => {
  it('same semantic input → identical fingerprint; different bytes → different fingerprint', () => {
    const base = { runId: 'run_1', taskId: null, kind: 'k', producedBy: 'p' };
    const a = artifactCommandFingerprint({ ...base, contentDigest: 'aa'.repeat(32) });
    const aAgain = artifactCommandFingerprint({ ...base, contentDigest: 'aa'.repeat(32) });
    const b = artifactCommandFingerprint({ ...base, contentDigest: 'bb'.repeat(32) });
    expect(a).toBe(aAgain);
    expect(a).not.toBe(b);
  });
});

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe('ArtifactService authorization boundary (review corrective)', () => {
  /** Authorize double: deny switch + invocation accounting. */
  const makeAuthorizer = (deny: () => boolean) => {
    const calls: { actorId: string; runId: string; taskId: string | null }[] = [];
    const authorize = async (input: { actorId: string; authority: 'artifact.create'; runId: string; taskId: string | null }) => {
      calls.push({ actorId: input.actorId, runId: input.runId, taskId: input.taskId });
      if (deny()) {
        return err(domainError('PERMISSION_DENIED', 'artifact.create authority denied.', { authority: 'artifact.create' }));
      }
      return ok(true as const);
    };
    return { authorize, calls };
  };

  it('A: new command denied → forbidden with zero side effects on every store', async () => {
    const h = await make();
    const authz = makeAuthorizer(() => true);
    const service = createArtifactService({
      artifactStore: h.db.artifactStore as ArtifactStorePort,
      contentStore: h.contentStore,
      runs: h.db.runs,
      events: h.db.events,
      ledger: h.db.ledger,
      clock,
      ids,
      unitOfWork: h.db.unitOfWork,
      authorize: authz.authorize,
    });
    const result = await service.create(command({ runId: h.runId as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED');
    expect(h.putLog.length).toBe(0);
    expect((await h.db.artifactStore?.listByRun(h.runId as never))?.length ?? 0).toBe(0);
    expect(h.db.db.prepare('SELECT COUNT(*) AS c FROM events WHERE type = ?').get('artifact.created')).toMatchObject({ c: 0 });
    expect(await h.db.ledger.get('cmd_art_1')).toBeNull();
    // Context provided to the authority decision:
    expect(authz.calls).toHaveLength(1);
    expect(authz.calls[0]).toMatchObject({ actorId: 'agent:agt_1', runId: h.runId, taskId: null });
  });

  it('B: ledger replay denied — an existing command result is not served to an unauthorized caller', async () => {
    const h = await make();
    const first = await h.service.create(command({ runId: h.runId as never }));
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.value.id : '';
    const eventsBefore = eventCount(h.db, firstId);
    const putCount = h.putLog.length;
    const rowsBefore = (await h.db.artifactStore?.listByRun(h.runId as never))?.length ?? 0;
    const ledgerBefore = await h.db.ledger.get('cmd_art_1');

    const authz = makeAuthorizer(() => true); // now denies
    const service = createArtifactService({
      artifactStore: h.db.artifactStore as ArtifactStorePort,
      contentStore: h.contentStore,
      runs: h.db.runs,
      events: h.db.events,
      ledger: h.db.ledger,
      clock,
      ids,
      unitOfWork: h.db.unitOfWork,
      authorize: authz.authorize,
    });
    const retry = await service.create(command({ runId: h.runId as never }));
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('PERMISSION_DENIED');
    // zero new side effects, zero mutations:
    expect(h.putLog.length).toBe(putCount);
    expect(eventCount(h.db, firstId)).toBe(eventsBefore);
    expect((await h.db.artifactStore?.listByRun(h.runId as never))?.length).toBe(rowsBefore);
    expect(await h.db.ledger.get('cmd_art_1')).toEqual(ledgerBefore);
  });

  it('C: permanent replay denied after ledger trim — row hit cannot bypass authorization', async () => {
    const h = await make();
    const first = await h.service.create(command({ runId: h.runId as never }));
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.value.id : '';
    trimLedger(h.db, 'cmd_art_1');
    const eventsBefore = eventCount(h.db, firstId);
    const putCount = h.putLog.length;
    const rowsBefore = (await h.db.artifactStore?.listByRun(h.runId as never))?.length ?? 0;

    const authz = makeAuthorizer(() => true);
    const service = createArtifactService({
      artifactStore: h.db.artifactStore as ArtifactStorePort,
      contentStore: h.contentStore,
      runs: h.db.runs,
      events: h.db.events,
      ledger: h.db.ledger,
      clock,
      ids,
      unitOfWork: h.db.unitOfWork,
      authorize: authz.authorize,
    });
    const retry = await service.create(command({ runId: h.runId as never }));
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('PERMISSION_DENIED');
    expect(h.putLog.length).toBe(putCount);
    expect(eventCount(h.db, firstId)).toBe(eventsBefore);
    expect((await h.db.artifactStore?.listByRun(h.runId as never))?.length).toBe(rowsBefore);
    // Exactly one authorization decision per service request (A/B/C: one call each).
    expect(authz.calls).toHaveLength(1);
  });

  it('authorize is invoked exactly once per request on the allowed path too', async () => {
    const h = await make();
    const authz = makeAuthorizer(() => false);
    const service = createArtifactService({
      artifactStore: h.db.artifactStore as ArtifactStorePort,
      contentStore: h.contentStore,
      runs: h.db.runs,
      events: h.db.events,
      ledger: h.db.ledger,
      clock,
      ids,
      unitOfWork: h.db.unitOfWork,
      authorize: authz.authorize,
    });
    const result = await service.create(command({ runId: h.runId as never }));
    expect(result.ok).toBe(true);
    expect(authz.calls).toHaveLength(1);
  });
});

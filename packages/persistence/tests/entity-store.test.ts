/**
 * Sprint 0 acceptance (T0.7): the EntityStore port round-trips entities by id and
 * pages deterministically.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEntityStore, openCompanyDatabase, type Database, type JsonEntity } from '../src/index.js';

interface SampleEntity extends JsonEntity {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly tags: readonly string[];
}

const created: string[] = [];
const cleanups: Array<() => void> = [];

const openFixture = (): { db: Database; store: ReturnType<typeof createEntityStore<SampleEntity>> } => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-entities-'));
  created.push(dir);
  let tick = 0;
  const opened = openCompanyDatabase({ dataDir: dir, appliedAt: '2026-01-01T00:00:00.000Z' });
  cleanups.push(() => opened.db.close());
  const store = createEntityStore<SampleEntity>({
    db: opened.db,
    kind: 'sample',
    clock: { nowIso: () => `2026-01-01T00:00:0${tick++}.000Z` },
  });
  return { db: opened.db, store };
};

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const entity = (id: string, version: number, title = `entity ${id}`): SampleEntity => ({
  id,
  title,
  version,
  tags: ['a', 'b'],
});

describe('entity store', () => {
  it('round-trips an entity by id', async () => {
    const { store } = openFixture();
    await store.put(entity('ent_1', 1));

    await expect(store.get('ent_1')).resolves.toEqual(entity('ent_1', 1));
    await expect(store.get('missing')).resolves.toBeNull();
    await expect(store.has('ent_1')).resolves.toBe(true);
    await expect(store.count()).resolves.toBe(1);
  });

  it('upserts without losing the original createdAt', async () => {
    const { db, store } = openFixture();
    await store.put(entity('ent_1', 1));
    const firstRow = db.prepare('SELECT created_at FROM entities WHERE id = ?').get('ent_1') as {
      created_at: string;
    };

    await store.put(entity('ent_1', 2));
    const secondRow = db.prepare('SELECT created_at, updated_at FROM entities WHERE id = ?').get('ent_1') as {
      created_at: string;
      updated_at: string;
    };

    expect((await store.get('ent_1'))?.version).toBe(2);
    expect(secondRow.created_at).toBe(firstRow.created_at);
    expect(secondRow.updated_at).not.toBe(firstRow.created_at);
    await expect(store.count()).resolves.toBe(1);
  });

  it('pages and orders deterministically', async () => {
    const { store } = openFixture();
    for (const id of ['ent_1', 'ent_2', 'ent_3', 'ent_4', 'ent_5']) await store.put(entity(id, 1));

    const firstPage = await store.list({ limit: 2, orderBy: 'id' });
    expect(firstPage.items.map((item) => item.id)).toEqual(['ent_1', 'ent_2']);
    expect(firstPage).toMatchObject({ total: 5, offset: 0, limit: 2 });

    const secondPage = await store.list({ limit: 2, offset: 2, orderBy: 'id' });
    expect(secondPage.items.map((item) => item.id)).toEqual(['ent_3', 'ent_4']);

    const descending = await store.list({ limit: 1, orderBy: 'id', descending: true });
    expect(descending.items[0]?.id).toBe('ent_5');

    const capped = await store.list({ limit: 10_000 });
    expect(capped.limit).toBe(500);
  });

  it('deletes and reports whether anything was removed', async () => {
    const { store } = openFixture();
    await store.put(entity('ent_1', 1));
    await expect(store.delete('ent_1')).resolves.toBe(true);
    await expect(store.delete('ent_1')).resolves.toBe(false);
    await expect(store.get('ent_1')).resolves.toBeNull();
  });

  it('isolates kinds inside one database', async () => {
    const { db, store } = openFixture();
    const other = createEntityStore<SampleEntity>({
      db,
      kind: 'sample_other',
      clock: { nowIso: () => '2026-01-01T00:00:00.000Z' },
    });
    await store.put(entity('ent_1', 1));
    await other.put(entity('ent_1', 9));

    expect((await store.get('ent_1'))?.version).toBe(1);
    expect((await other.get('ent_1'))?.version).toBe(9);
    await expect(store.count()).resolves.toBe(1);
  });

  it('refuses an unknown orderBy instead of building SQL from input', async () => {
    const { store } = openFixture();
    await expect(store.list({ orderBy: 'id; DROP TABLE entities' })).rejects.toThrow(TypeError);
  });
});

/**
 * Sprint 15 / Task-13-03-round: durable Industry Pack persistence (opt-in `pack` chain).
 *
 * Covers the three durable truths (PackVersion / PackInstallation / PackContentRef):
 * the migration + schema constraints, immutable INSERT-once semantics (replay vs
 * CONFLICT), fail-closed read integrity (corrupt manifest / fingerprint), permanent
 * creation-command identity, the one-enabled-version partial-unique invariant,
 * company isolation, PackContentRef provenance (nullable materialization, no remap),
 * shared-transaction commit/rollback, and the "no delete / no service / no pinning
 * surface" structural locks.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPackContentRef,
  createPackVersion,
  packManifestFingerprint,
  type PackInstallation,
  type PackVersion,
} from '@companyos/core';
import {
  createSqlitePackContentRefStore,
  createSqlitePackInstallationStore,
  createSqlitePackVersionStore,
  openDurableDatabase,
  type DurableDatabase,
  type MigrationChainName,
} from '../src/index.js';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-pack-'));
  created.push(dir);
  return dir;
};
let nowMs = 0;
const nowIso = (): string => {
  nowMs += 1_000;
  return new Date(Date.parse('2026-09-26T00:00:00.000Z') + nowMs).toISOString();
};
let installationSeq = 0;
const nextInstallationId = (): string =>
  `pki_01JT15${String(++installationSeq).padStart(4, '0')}`;

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const closeQuietly = (target: DurableDatabase | null): void => {
  if (target === null) return;
  try {
    target.close();
  } catch {
    // already closed by the test itself
  }
};

const db = (chains: readonly MigrationChainName[]): DurableDatabase => {
  closeQuietly(database);
  database = openDurableDatabase({ dataDir: tempDir(), appliedAt: nowIso(), chains });
  return database;
};

const makeVersion = (overrides: { readonly packVersion?: string; readonly name?: string } = {}): PackVersion => {
  const result = createPackVersion({
    manifestVersion: 1,
    packId: 'pack-fixture',
    packVersion: overrides.packVersion ?? '1.0.0',
    name: overrides.name ?? 'fixture pack',
    coreApi: '1',
    capabilities: [{ id: 'pack-fixture:patch.apply', description: 'apply a patch' }],
    dependsOn: [],
    declarations: {
      roles: [], workflowTemplates: [], prompts: [], tools: [], validators: [],
      artifacts: [], riskRules: [], capabilityRules: [], templates: [],
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const makeInstallation = (overrides: { readonly companyId?: string; readonly packVersion?: string; readonly status?: 'installed' | 'disabled' } = {}): PackInstallation => ({
  id: nextInstallationId() as PackInstallation['id'],
  companyId: (overrides.companyId ?? 'cmp_a') as PackInstallation['companyId'],
  packId: 'pack-fixture',
  packVersion: overrides.packVersion ?? '1.0.0',
  name: 'fixture pack',
  coreApi: '1',
  capabilities: ['pack-fixture:patch.apply'],
  status: overrides.status ?? 'installed',
  installedBy: 'user_owner',
  installedAt: nowIso(),
  updatedAt: nowIso(),
});

describe('pack migration (fresh DB + registration)', () => {
  it('applies on a fresh database and creates the three tables with their indexes', () => {
    const database = db(['core', 'engine', 'pack']);
    const tables = (database.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index')`).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain('pack_versions');
    expect(tables).toContain('pack_installations');
    expect(tables).toContain('pack_content_refs');
    expect(tables).toContain('idx_pack_installations_one_enabled');
    expect(tables).toContain('idx_pack_installations_identity');
  });

  it('is registered in the production migration runner (not test-only schema)', () => {
    // The facade mounts the stores when the chain is requested — the same mechanism the
    // desktop composition uses, so production startup sees the pack schema.
    const database = db(['core', 'engine', 'pack']);
    expect(database.packVersions).not.toBeNull();
    expect(database.packInstallations).not.toBeNull();
    expect(database.packContentRefs).not.toBeNull();
    const off = db(['core', 'engine']);
    expect(off.packVersions).toBeNull();
  });

  it('reopen (upgrade) keeps rows and applies nothing twice', async () => {
    const dataDir = tempDir();
    const first = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: ['core', 'engine', 'pack'] });
    const version = makeVersion();
    const stored = await createSqlitePackVersionStore(first.db, { nowIso }).put(version);
    expect(stored.ok).toBe(true);
    first.close();
    const reopened = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: ['core', 'engine', 'pack'] });
    database?.close();
    database = reopened;
    expect(reopened.migrations.pack?.applied).toEqual([]); // exactly-once re-application
    const back = await createSqlitePackVersionStore(reopened.db, { nowIso }).get('pack-fixture', '1.0.0');
    expect(back.ok).toBe(true);
    if (back.ok && back.value) expect(back.value.manifestFingerprint).toBe(version.manifestFingerprint);
  });
});

describe('PackVersionStore', () => {
  it('round-trips the canonical manifest and the qualified fingerprint', async () => {
    const database = db(['core', 'engine', 'pack']);
    const store = createSqlitePackVersionStore(database.db, { nowIso });
    const version = makeVersion();
    const put = await store.put(version);
    expect(put.ok).toBe(true);
    const got = await store.get('pack-fixture', '1.0.0');
    expect(got.ok).toBe(true);
    if (got.ok && got.value) {
      expect(got.value.manifest).toEqual(version.manifest);
      expect(got.value.manifestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(got.value.manifestFingerprint).toBe(packManifestFingerprint(version.manifest));
    }
    const missing = await store.get('pack-fixture', '9.9.9');
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value).toBeNull();
  });

  it('same identity + same fingerprint → idempotent replay (no duplicate row)', async () => {
    const database = db(['core', 'engine', 'pack']);
    const store = createSqlitePackVersionStore(database.db, { nowIso });
    const version = makeVersion();
    await store.put(version);
    const again = await store.put(makeVersion());
    expect(again.ok).toBe(true);
    const rows = database.db.prepare('SELECT * FROM pack_versions').all();
    expect(rows).toHaveLength(1);
  });

  it('same identity + different fingerprint → CONFLICT, stored row unchanged', async () => {
    const database = db(['core', 'engine', 'pack']);
    const store = createSqlitePackVersionStore(database.db, { nowIso });
    await store.put(makeVersion());
    const divergent = await store.put(makeVersion({ name: 'renamed pack' }));
    expect(divergent.ok).toBe(false);
    if (!divergent.ok) expect(divergent.error.code).toBe('CONFLICT');
    const got = await store.get('pack-fixture', '1.0.0');
    if (got.ok && got.value) {
      expect(got.value.manifest.name).toBe('fixture pack'); // original never overwritten
      expect(got.value.manifestFingerprint).toBe(makeVersion().manifestFingerprint);
    }
  });

  it('corrupt manifest snapshot → read fails closed', async () => {
    const database = db(['core', 'engine', 'pack']);
    const store = createSqlitePackVersionStore(database.db, { nowIso });
    await store.put(makeVersion());
    database.db.prepare('UPDATE pack_versions SET canonical_manifest_json = ? WHERE pack_id = ?').run('{not-json', 'pack-fixture');
    const got = await store.get('pack-fixture', '1.0.0');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('PERSISTENCE_FAILED');
  });

  it('corrupt fingerprint (mismatch / wrong format) → read fails closed', async () => {
    const database = db(['core', 'engine', 'pack']);
    const store = createSqlitePackVersionStore(database.db, { nowIso });
    const version = makeVersion();
    await store.put(version);
    // The schema CHECK refuses a bare hex even on a direct write (no dual format).
    expect(() =>
      database.db.prepare('UPDATE pack_versions SET manifest_fingerprint = ? WHERE pack_id = ?').run('deadbeef', 'pack-fixture'),
    ).toThrow(/CHECK/);
    database.db.prepare('UPDATE pack_versions SET manifest_fingerprint = ? WHERE pack_id = ?').run(`sha256:${'b'.repeat(64)}`, 'pack-fixture');
    const mismatch = await store.get('pack-fixture', '1.0.0');
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.details['reason']).toBe('PACK_VERSION_FINGERPRINT_MISMATCH');
    expect(version.manifestFingerprint).toMatch(/^sha256:/);
  });
});

describe('PackInstallationStore', () => {
  it('round-trips all fields and rejects a missing PackVersion (fail closed, no FK shortcuts)', async () => {
    const database = db(['core', 'engine', 'pack']);
    const versionStore = createSqlitePackVersionStore(database.db, { nowIso });
    const installationStore = createSqlitePackInstallationStore(database.db);
    const absent = await installationStore.create({ installation: makeInstallation(), creationCommandId: 'cmd_1', creationCommandFingerprint: 'f1' });
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.error.code).toBe('NOT_FOUND');
    await versionStore.put(makeVersion());
    const installation = makeInstallation();
    const created = await installationStore.create({ installation, creationCommandId: 'cmd_1', creationCommandFingerprint: 'f1' });
    expect(created.ok).toBe(true);
    const got = await installationStore.get(installation.id);
    expect(got.ok).toBe(true);
    if (got.ok && got.value) {
      expect(got.value.companyId).toBe('cmp_a');
      expect(got.value.packId).toBe('pack-fixture');
      expect(got.value.packVersion).toBe('1.0.0');
      expect(got.value.status).toBe('installed');
    }
  });

  it('creation command identity: same command + same fingerprint replays; different fingerprint conflicts', async () => {
    const database = db(['core', 'engine', 'pack']);
    await createSqlitePackVersionStore(database.db, { nowIso }).put(makeVersion());
    const store = createSqlitePackInstallationStore(database.db);
    const installation = makeInstallation();
    await store.create({ installation, creationCommandId: 'cmd same', creationCommandFingerprint: 'fp1' });
    const replay = await store.create({ installation, creationCommandId: 'cmd other', creationCommandFingerprint: 'fp1' });
    expect(replay.ok).toBe(false); // unique (command) fires first: different command, same tuple
    const conflict = await store.create({ installation, creationCommandId: 'cmd same', creationCommandFingerprint: 'fp2' });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('CONFLICT');
    const byCommand = await store.findByCreationCommand('cmd same');
    expect(byCommand.ok).toBe(true);
    if (byCommand.ok && byCommand.value) expect(byCommand.value.status).toBe('installed');
  });

  it('duplicate (company, pack, version) with a different command → CONFLICT, one row', async () => {
    const database = db(['core', 'engine', 'pack']);
    await createSqlitePackVersionStore(database.db, { nowIso }).put(makeVersion());
    const store = createSqlitePackInstallationStore(database.db);
    const first = makeInstallation();
    await store.create({ installation: first, creationCommandId: 'cmd_a', creationCommandFingerprint: 'fa' });
    const second = await store.create({ installation: { ...first, status: 'disabled' }, creationCommandId: 'cmd_b', creationCommandFingerprint: 'fb' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.details['reason']).toBe('PACK_INSTALLATION_IDENTITY_CONFLICT');
    expect(database.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(1);
  });

  it('one-enabled-version invariant blocks a second installed version (race-safe DB index)', async () => {
    const database = db(['core', 'engine', 'pack']);
    const versionStore = createSqlitePackVersionStore(database.db, { nowIso });
    await versionStore.put(makeVersion({ packVersion: '1.0.0' }));
    await versionStore.put(makeVersion({ packVersion: '2.0.0' }));
    const store = createSqlitePackInstallationStore(database.db);
    const v1 = makeInstallation({ packVersion: '1.0.0' });
    await store.create({ installation: v1, creationCommandId: 'c1', creationCommandFingerprint: 'f1' });
    const v2 = await store.create({ installation: makeInstallation({ packVersion: '2.0.0' }), creationCommandId: 'c2', creationCommandFingerprint: 'f2' });
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.error.details['reason']).toBe('PACK_ONE_ENABLED_VERSION');
    // Valid upgrade sequence inside one transaction: v1 disabled → v2 installed.
    const unit = database.unitOfWork;
    const upgraded = await unit.transaction(async () => {
      const off = await store.setStatus(v1.id, 'disabled', nowIso());
      if (!off.ok) return off;
      return store.create({ installation: makeInstallation({ packVersion: '2.0.0' }), creationCommandId: 'c2', creationCommandFingerprint: 'f2' });
    });
    expect(upgraded.ok).toBe(true);
  });

  it('company isolation: same pack version installs for two companies; disabling A leaves B alone', async () => {
    const database = db(['core', 'engine', 'pack']);
    await createSqlitePackVersionStore(database.db, { nowIso }).put(makeVersion());
    const store = createSqlitePackInstallationStore(database.db);
    const a = makeInstallation({ companyId: 'cmp_a' });
    const b = makeInstallation({ companyId: 'cmp_b' });
    expect((await store.create({ installation: a, creationCommandId: 'ca', creationCommandFingerprint: 'fa' })).ok).toBe(true);
    expect((await store.create({ installation: b, creationCommandId: 'cb', creationCommandFingerprint: 'fb' })).ok).toBe(true);
    const disabled = await store.setStatus(a.id, 'disabled', nowIso());
    expect(disabled.ok).toBe(true);
    const bEnabled = await store.findEnabled('cmp_b', 'pack-fixture');
    expect(bEnabled.ok).toBe(true);
    if (bEnabled.ok && bEnabled.value) expect(bEnabled.value.status).toBe('installed');
    const aEnabled = await store.findEnabled('cmp_a', 'pack-fixture');
    if (aEnabled.ok) expect(aEnabled.value).toBeNull();
    const aList = await store.listByCompany('cmp_a');
    if (aList.ok) expect(aList.value).toHaveLength(1);
  });

  it('status mutations use the closed set only', async () => {
    const database = db(['core', 'engine', 'pack']);
    await createSqlitePackVersionStore(database.db, { nowIso }).put(makeVersion());
    const store = createSqlitePackInstallationStore(database.db);
    const installation = makeInstallation();
    await store.create({ installation, creationCommandId: 'cx', creationCommandFingerprint: 'fx' });
    const bogus = await store.setStatus(installation.id, 'activating' as never, nowIso());
    expect(bogus.ok).toBe(false);
    const twice = await store.setStatus(installation.id, 'disabled', nowIso());
    expect(twice.ok).toBe(true);
    const again = await store.setStatus(installation.id, 'disabled', nowIso());
    expect(again.ok).toBe(false);
    // Re-enable flips back (still closing the one-enabled invariant).
    const back = await store.setStatus(installation.id, 'installed', nowIso());
    expect(back.ok).toBe(true);
  });
});

describe('PackContentRefStore', () => {
  it('round-trips nullable provenance and reconstructs the (packId, packVersion) anchor', async () => {
    const database = db(['core', 'engine', 'pack']);
    await createSqlitePackVersionStore(database.db, { nowIso }).put(makeVersion());
    const installation = makeInstallation();
    await createSqlitePackInstallationStore(database.db).create({
      installation,
      creationCommandId: 'cc',
      creationCommandFingerprint: 'fc',
    });
    const refs = createSqlitePackContentRefStore(database.db, { nowIso });
    const templateRef = createPackContentRef({
      packId: 'pack-fixture',
      packVersion: '1.0.0',
      contentKind: 'template',
      logicalKey: 'pack-fixture:document-template',
    });
    expect(templateRef.ok).toBe(true);
    if (!templateRef.ok) return;
    expect((await refs.insert(installation.id, templateRef.value)).ok).toBe(true);
    const workflowRef = createPackContentRef({
      packId: 'pack-fixture',
      packVersion: '1.0.0',
      contentKind: 'workflowTemplate',
      logicalKey: 'pack-fixture:feature',
      materializedEntityRef: 'tpl_01Jsomewhere',
    });
    if (!workflowRef.ok) throw new Error(workflowRef.error.message);
    expect((await refs.insert(installation.id, workflowRef.value)).ok).toBe(true);

    const list = await refs.listByInstallation(installation.id);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(2);
      const nullable = list.value.find((ref) => ref.contentKind === 'template');
      expect(nullable?.materializedEntityRef).toBeNull(); // NULL, never a fake ref
      expect(nullable?.packId).toBe('pack-fixture'); // ownership anchor reconstructible
      const anchored = list.value.find((ref) => ref.contentKind === 'workflowTemplate');
      expect(anchored?.materializedEntityRef).toBe('tpl_01Jsomewhere');
    }
    const found = await refs.findByKey(installation.id, 'template', 'pack-fixture:document-template');
    expect(found.ok).toBe(true);
    if (found.ok && found.value) expect(found.value.logicalKey).toBe('pack-fixture:document-template');
  });

  it('duplicate (installation, kind, logicalKey) → CONFLICT; provenance is immutable', async () => {
    const database = db(['core', 'engine', 'pack']);
    await createSqlitePackVersionStore(database.db, { nowIso }).put(makeVersion());
    await createSqlitePackInstallationStore(database.db).create({
      installation: makeInstallation(),
      creationCommandId: 'cd',
      creationCommandFingerprint: 'fd',
    });
    const refs = createSqlitePackContentRefStore(database.db, { nowIso });
    const ref = createPackContentRef({
      packId: 'pack-fixture',
      packVersion: '1.0.0',
      contentKind: 'prompt',
      logicalKey: 'pack-fixture:summary',
    });
    if (!ref.ok) throw new Error(ref.error.message);
    const installation = makeInstallation();
    await refs.insert(installation.id, ref.value);
    const duplicate = await refs.insert(installation.id, ref.value);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.details['reason']).toBe('PACK_CONTENT_REF_DUPLICATE');
  });

  it('company isolation: the same pack version in two companies keeps separate provenance', async () => {
    const database = db(['core', 'engine', 'pack']);
    await createSqlitePackVersionStore(database.db, { nowIso }).put(makeVersion());
    const installs = createSqlitePackInstallationStore(database.db);
    const a = makeInstallation({ companyId: 'cmp_a' });
    const b = makeInstallation({ companyId: 'cmp_b' });
    await installs.create({ installation: a, creationCommandId: 'ca', creationCommandFingerprint: 'fa' });
    await installs.create({ installation: b, creationCommandId: 'cb', creationCommandFingerprint: 'fb' });
    const refs = createSqlitePackContentRefStore(database.db, { nowIso });
    const refA = createPackContentRef({ packId: 'pack-fixture', packVersion: '1.0.0', contentKind: 'workflowTemplate', logicalKey: 'pack-fixture:flow', materializedEntityRef: 'tpl_A' });
    const refB = createPackContentRef({ packId: 'pack-fixture', packVersion: '1.0.0', contentKind: 'workflowTemplate', logicalKey: 'pack-fixture:flow', materializedEntityRef: 'tpl_B' });
    if (!refA.ok || !refB.ok) throw new Error('ref build');
    expect((await refs.insert(a.id, refA.value)).ok).toBe(true);
    expect((await refs.insert(b.id, refB.value)).ok).toBe(true);
    const listA = await refs.listByInstallation(a.id);
    if (listA.ok) expect(listA.value[0]?.materializedEntityRef).toBe('tpl_A');
  });
});

describe('shared UnitOfWork across the three stores', () => {
  it('commits all three tables atomically inside one transaction', async () => {
    const database = db(['core', 'engine', 'pack']);
    const versionStore = createSqlitePackVersionStore(database.db, { nowIso });
    const installStore = createSqlitePackInstallationStore(database.db);
    const refStore = createSqlitePackContentRefStore(database.db, { nowIso });
    const version = makeVersion();
    const installation = makeInstallation();
    const ref = createPackContentRef({ packId: 'pack-fixture', packVersion: '1.0.0', contentKind: 'template', logicalKey: 'pack-fixture:document-template' });
    if (!ref.ok) throw new Error(ref.error.message);
    const committed = await database.unitOfWork.transaction(async () => {
      const v = await versionStore.put(version);
      if (!v.ok) return v;
      const i = await installStore.create({ installation, creationCommandId: 'cwsame', creationCommandFingerprint: 'fwsame' });
      if (!i.ok) return i;
      return refStore.insert(installation.id, ref.value);
    });
    expect(committed.ok).toBe(true);
    expect(database.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(1);
    expect(database.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(1);
    expect(database.db.prepare('SELECT * FROM pack_content_refs').all()).toHaveLength(1);
  });

  it('rolls the whole pack write set back when one participant throws', async () => {
    const database = db(['core', 'engine', 'pack']);
    const versionStore = createSqlitePackVersionStore(database.db, { nowIso });
    const installStore = createSqlitePackInstallationStore(database.db);
    const version = makeVersion();
    const installation = makeInstallation();
    const rolled = await database.unitOfWork.transaction(async () => {
      const v = await versionStore.put(version);
      if (!v.ok) return v;
      const i = await installStore.create({ installation, creationCommandId: 'crb', creationCommandFingerprint: 'frb' });
      if (!i.ok) return i;
      throw new Error('participant exploded after two writes');
    });
    expect(rolled.ok).toBe(false);
    expect(database.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(0);
    expect(database.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
  });
});

describe('structural locks (no delete / no service / no pinning)', () => {
  it('the migration contains no DELETE/DROP surface and the stores expose none', () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../migrations/pack/0001_pack_persistence.sql', import.meta.url)),
      'utf8',
    );
    // STATEMENT-level lock (prose may say "no delete/GC"): no SQL DELETE/DROP statement
    // in the executable body (comments stripped) of the migration or the store adapters.
    const statements = (text: string): readonly string[] => {
      const body = text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\s*\/\/.*$/gm, ' ');
      return body
        .split(';')
        .map((chunk) => chunk.trim().toUpperCase())
        .filter((chunk) => chunk.length > 0);
    };
    expect(statements(migration).some((chunk) => chunk.startsWith('DELETE') || chunk.startsWith('DROP'))).toBe(false);
    const stores = readFileSync(
      fileURLToPath(new URL('../src/durable/sqlite-pack-stores.ts', import.meta.url)),
      'utf8',
    );
    // The store source never contains a DELETE/DROP statement, and never performs an
    // authorization decision (stores persist facts; authorization is T15-04's job).
    expect(
      statements(stores).some((chunk) => chunk.startsWith('DELETE') || chunk.startsWith('DROP')),
    ).toBe(false);
    expect(stores.includes('decideAuthority') || stores.includes('isAuthority')).toBe(false);
  });
});

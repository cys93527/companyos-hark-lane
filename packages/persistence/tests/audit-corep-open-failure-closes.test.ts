/**
 * AUDIT-P6 — when a migration chain throws during open, the opener closes the connection it
 * opened before the error propagates (an unreachable handle would keep companyos.sqlite +
 * -wal/-shm locked on Windows for the life of the app).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MigrationFromNewerVersionError,
  openCompanyDatabase,
  openDatabase,
  openDurableDatabase,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-p6-'));
  dirs.push(dir);
  return dir;
};
const insertFutureRow = (dataDir: string, name: string): void => {
  const raw = openDatabase({ path: join(dataDir, 'companyos.sqlite') });
  raw.prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run(name, 'f'.repeat(64), 'newer-build');
  raw.close();
};

/** Track every physical connection opened (first exec = the opener's pragmas) and closed. */
const trackConnections = (): { opened: Set<DatabaseSync>; closed: Set<DatabaseSync> } => {
  const opened = new Set<DatabaseSync>();
  const closed = new Set<DatabaseSync>();
  const realExec = DatabaseSync.prototype.exec;
  const realClose = DatabaseSync.prototype.close;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    opened.add(this);
    return realExec.call(this, sql);
  });
  vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    closed.add(this);
    return realClose.call(this);
  });
  return { opened, closed };
};

describe('AUDIT-P6 a failed open never leaks its connection', () => {
  it('openDurableDatabase closes the connection when a migration chain refuses (newer schema)', () => {
    const dir = tempDir();
    openDurableDatabase({ dataDir: dir, appliedAt: 't1' }).close();
    insertFutureRow(dir, '0010_future_engine_change');

    const { opened, closed } = trackConnections();
    expect(() => openDurableDatabase({ dataDir: dir, appliedAt: 't2' })).toThrow(MigrationFromNewerVersionError);
    expect(opened.size).toBe(1);
    for (const handle of opened) expect(closed.has(handle)).toBe(true);
  });

  it('openCompanyDatabase closes the connection when a migration chain refuses (newer schema)', () => {
    const dir = tempDir();
    openCompanyDatabase({ dataDir: dir, appliedAt: 't1' }).db.close();
    insertFutureRow(dir, '0002_future_core_change');

    const { opened, closed } = trackConnections();
    expect(() => openCompanyDatabase({ dataDir: dir, appliedAt: 't2' })).toThrow(MigrationFromNewerVersionError);
    expect(opened.size).toBe(1);
    for (const handle of opened) expect(closed.has(handle)).toBe(true);
  });
});

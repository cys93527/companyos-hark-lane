#!/usr/bin/env node
// Hark lane H13 — logical snapshot of the INSTALLED app's user database (read-only).
// Runs on the installed app's own runtime: CompanyOS.exe with ELECTRON_RUN_AS_NODE=1.
//   h13-data-probe.mjs <dbFile> <outJson>
// Writes { migrations:[names], tables:{name:rowCount}, roleAssignments:[...], probeTable }.
// Never writes the database: opened read-only, no migration, no composition.
import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [dbFile, outJson] = process.argv.slice(2);
if (!dbFile || !outJson) { console.error('usage: <dbFile> <outJson>'); process.exit(64); }
const out = { dbFile, exists: existsSync(dbFile), at: new Date().toISOString() };
try {
  if (!out.exists) throw new Error('database file does not exist');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  out.migrations = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  out.tables = Object.fromEntries(tables.map((t) => [t, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/gu, '""')}"`).get().n)]));
  // The owner bootstrap row (actor, role, assigned_at) is a durable fact created on first
  // launch; identical rows after upgrade / downgrade / uninstall = the user's data survived.
  out.roleAssignments = tables.includes('role_assignments') ? db.prepare('SELECT actor_id, role_id, assigned_at FROM role_assignments ORDER BY actor_id, role_id').all().map((r) => `${r.actor_id}|${r.role_id}|${r.assigned_at}`) : null;
  out.probeTable = tables.includes('h13_upgrade_probe');
  db.close();
  out.ok = true;
} catch (error) {
  out.ok = false;
  out.error = String(error?.message ?? error);
}
writeFileSync(outJson, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);

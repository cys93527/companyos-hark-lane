// DB-BACKUP: restore helper for the local SQLite backups (docs/hark-lane/DB_BACKUP.md).
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) restore-database.mjs list    --user-data <dir>
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) restore-database.mjs request --user-data <dir> --backup <file name>
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) restore-database.mjs cancel  --user-data <dir>
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) restore-database.mjs status  --user-data <dir>
// `request` validates the backup now (integrity_check + schema known to this build) and STAGES
// the restore; CompanyOS applies it at its next start, before it opens the database (safety copy
// of the current database first). It never touches the live database itself, so it is safe to run
// while the app is open. Shipped at <install>/resources/setup/ like configure-provider.mjs; the app
// modules live at <install>/resources/app/apps/desktop/dist/. Answers one JSON line.
// No hashbang on purpose: it is always started through node/Electron, and a hashbang in a CRLF
// (Windows) checkout makes the Vitest module runner fail to load the file (hark-windows 41963722718).
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COMMANDS = ['list', 'request', 'cancel', 'status'];

export const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if (!['--user-data', '--backup', '--dist'].includes(k) || v === undefined) throw new Error(`unknown or incomplete argument ${k}`);
    opts[k.slice(2)] = v;
  }
  if (!COMMANDS.includes(command)) throw new Error(`command must be one of ${COMMANDS.join(', ')}`);
  if (!opts['user-data']) throw new Error('--user-data is required');
  if (command === 'request' && !opts.backup) throw new Error('request needs --backup <file name>');
  return { command, ...opts };
};

export const main = async (argv = process.argv.slice(2), log = (line) => console.log(line)) => {
  const here = dirname(fileURLToPath(import.meta.url));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log(JSON.stringify({ ok: false, code: 'RESTORE_ARGS_INVALID', message: e.message }));
    return 2;
  }
  const dist = args.dist ?? join(here, '..', 'app', 'apps', 'desktop', 'dist');
  try {
    const mod = await import(pathToFileURL(join(dist, 'db-backup.js')).href);
    const backupDir = mod.databaseBackupDir(args['user-data']);
    if (args.command === 'list') {
      const backups = mod.listDatabaseBackups(args['user-data']).map((b) => ({ file: b.fileName, tag: b.tag, createdAt: b.createdAt, bytes: b.bytes }));
      log(JSON.stringify({ ok: true, dir: backupDir, backups, pending: mod.readDatabaseRestoreRequest(backupDir) }));
      return 0;
    }
    if (args.command === 'status') {
      log(JSON.stringify({ ok: true, dir: backupDir, pending: mod.readDatabaseRestoreRequest(backupDir) }));
      return 0;
    }
    if (args.command === 'cancel') {
      log(JSON.stringify({ ok: true, cancelled: mod.cancelDatabaseRestoreRequest(backupDir) }));
      return 0;
    }
    const request = mod.requestDatabaseRestore({ backupDir, backupFileName: args.backup, knownMigrationNames: mod.shippedDatabaseMigrationNames() });
    log(JSON.stringify({ ok: true, staged: request, next: 'restart CompanyOS to apply the restore' }));
    return 0;
  } catch (e) {
    log(JSON.stringify({ ok: false, code: e.details?.kind ?? e.code ?? 'RESTORE_FAILED', message: e.message }));
    return 3;
  }
};

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}

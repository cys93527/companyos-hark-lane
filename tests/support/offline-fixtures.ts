import { createRequire } from 'node:module';
import { writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const api = require('../../scripts/test-offline-guard.cjs') as {
  installOfflineGuard(): { registerFixture(file: string, launch?: {argv: string[]; cwd: string}): unknown; registerInline(code: string): void; registerGitWorkspace(root: string): unknown; registerReadOnlyGitRepository(): unknown; registerSpawnFailure(file: string): void; registerPackageSnapshot(root: string): unknown; packageTraces: unknown[] };
};
/** Use only for reviewed, deterministic test bytes, never an actual CLI/adapter. */
export const registerOfflineFixture = (file: string, launch?: {argv: string[]; cwd: string}): void => { api.installOfflineGuard().registerFixture(file, launch); };
/** Only the two reviewed read-only queries against the fixed F candidate. */
export const registerOfflineReadOnlyGitRepository = (): void => { api.installOfflineGuard().registerReadOnlyGitRepository(); };
export const registerOfflineInline = (code: string): void => { api.installOfflineGuard().registerInline(code); };
/** Disposable Git setup only. Remote commands, hooks and shell dispatch remain denied. */
export const registerOfflineGitWorkspace = (root: string): void => { api.installOfflineGuard().registerGitWorkspace(root); };
/** Inject ENOENT without ever allowing an unknown executable to reach Windows. */
export const registerOfflineSpawnFailure = (file: string): void => { api.installOfflineGuard().registerSpawnFailure(file); };
/** Reviewed finite validator fixtures (two chains and M3); unknown scripts fail closed. */
export const registerOfflinePackageSnapshot = (root: string): void => { api.installOfflineGuard().registerPackageSnapshot(root); };
/** Known fixture argv only; no process env/output or credential values are recorded. */
export const saveOfflinePackageTraces = (): void => {
  const traces = api.installOfflineGuard().packageTraces.splice(0);
  if (traces.length) writeFileSync(join(tmpdir(), `two-chain-trace-${randomUUID()}.json`), JSON.stringify({capturedAt:new Date().toISOString(),scope:'Guard-expanded Node roots only; native grandchildren not comprehensively traced',traces},null,2)+'\n', {encoding:'utf8',flag:'wx'});
};
/** Reviewed CommonJS helper in a disposable script directory beneath ESM repo. */
export const registerOfflineCommonJsFixture = (file: string): void => {
  const rel = relative(realpathSync(tmpdir()), realpathSync(file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('OFFLINE_COMMONJS_FIXTURE_OUTSIDE_OWNED_TEMP');
  registerOfflineFixture(file);
  const manifest = join(dirname(file), 'package.json');
  if (!existsSync(manifest)) writeFileSync(manifest, '{"type":"commonjs"}', 'utf8');
};

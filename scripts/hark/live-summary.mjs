#!/usr/bin/env node
// Hark lane (2026-11-07): GitHub Free artifact storage (500 MB) can refuse the evidence upload.
// This prints a compact, recoverable summary of a live-goal run to the job log and to
// $GITHUB_STEP_SUMMARY: outcome, spend, goal status, generated workspace files, key log tails,
// and the whole live-goal.json (gzip + base64, one `HLG:` line per chunk between markers) so
// the spend ledger can be settled from the job log alone (lane fetch-live.sh decodes it).
// The model key is never printed: every emitted line is redacted against it.
// Live contract-fill run 4: the last KEY_SHOT_LIMIT key screenshots (small JPEGs the driver writes
// to screenshots/key/, each <= KEY_SHOT_MAX_BYTES) follow the same way, one `HLS:` blob per shot.
// usage: node scripts/hark/live-summary.mjs <evidenceDir>
//        node scripts/hark/live-summary.mjs --decode-shots <job.log> <outDir>   (lane fetch-live.sh)
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

export const MARK_BEGIN = 'HARK-LIVE-GOAL-JSON-GZB64 BEGIN';
export const MARK_END = 'HARK-LIVE-GOAL-JSON-GZB64 END';
export const CHUNK_PREFIX = 'HLG:';
export const SHOT_BEGIN = 'HARK-LIVE-SHOT-GZB64 BEGIN';
export const SHOT_END = 'HARK-LIVE-SHOT-GZB64 END';
export const SHOT_PREFIX = 'HLS:';
export const KEY_SHOT_LIMIT = 3;
export const KEY_SHOT_MAX_BYTES = 150_000;
const SHOT_NAME = /^[A-Za-z0-9._\u4e00-\u9fff-]{1,120}\.jpg$/u;

/** The key screenshots to emit: the newest KEY_SHOT_LIMIT JPEGs within the size bound (name order = time order). */
export function keyShotsOf(dir) {
  const keyDir = join(dir, 'screenshots', 'key');
  if (!existsSync(keyDir)) return { chosen: [], skipped: [] };
  const all = readdirSync(keyDir).filter((n) => SHOT_NAME.test(n)).sort();
  const skipped = [];
  const fit = [];
  for (const name of all) {
    const size = statSync(join(keyDir, name)).size;
    if (size > 0 && size <= KEY_SHOT_MAX_BYTES) fit.push(name); else skipped.push(`${name} (${size} B)`);
  }
  return { chosen: fit.slice(-KEY_SHOT_LIMIT).map((name) => join(keyDir, name)), skipped };
}

/** Rebuilds the key screenshots from a job log (timestamp prefixes tolerated): name -> JPEG bytes. */
export function decodeShotsFromLog(logText) {
  const shots = new Map();
  let name = null;
  let b64 = '';
  for (const line of String(logText).split(/\r?\n/u)) {
    const begin = line.indexOf(`${SHOT_BEGIN} `);
    if (begin >= 0) { name = line.slice(begin + SHOT_BEGIN.length + 1).trim(); b64 = ''; continue; }
    if (name === null) continue;
    if (line.includes(SHOT_END)) {
      if (SHOT_NAME.test(name)) { try { shots.set(name, gunzipSync(Buffer.from(b64, 'base64'))); } catch { /* torn blob: skipped */ } }
      name = null; b64 = ''; continue;
    }
    const at = line.indexOf(SHOT_PREFIX);
    if (at >= 0) b64 += (/^[A-Za-z0-9+/=]*/u.exec(line.slice(at + SHOT_PREFIX.length)) ?? [''])[0];
  }
  return shots;
}

function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function tail(p, n) { const t = readText(p); return t === null ? null : t.split(/\r?\n/u).slice(-n).join('\n'); }
function walk(root, base = root, acc = []) {
  if (!existsSync(root)) return acc;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules' && name !== '.git') walk(p, base, acc); } else acc.push(`${relative(base, p).replace(/\\/gu, '/')} (${st.size} B)`);
    if (acc.length > 400) break;
  }
  return acc;
}

/** The --decode-shots CLI body: writes every decoded shot into outDir, returns the names. */
export function writeDecodedShots(logText, outDir) {
  mkdirSync(outDir, { recursive: true });
  const shots = decodeShotsFromLog(logText);
  for (const [name, bytes] of shots) writeFileSync(join(outDir, name), bytes);
  return [...shots.keys()];
}

/** Prints (via `log`) and returns the summary lines; appends Markdown to `stepSummary` when given. */
export function summarize(dir, { key = '', stepSummary = '', log = console.log } = {}) {
  const redact = (t) => (key.length >= 8 ? String(t).split(key).join('[REDACTED]') : String(t));
  const out = [];
  const say = (t = '') => { const line = redact(t); out.push(line); log(line); };
  const jsonPath = join(dir, 'live-goal.json');
  const raw = readText(jsonPath);
  let g = null;
  try { g = raw === null ? null : JSON.parse(raw); } catch { g = null; }

  say('=== HARK LIVE-GOAL SUMMARY ===');
  if (g === null) say(`live-goal.json: ${raw === null ? 'MISSING' : 'UNPARSEABLE'} in ${dir}`);
  else {
    say(`result: ${g.result ?? '?'}  monitorEnd: ${g.monitorEnd ?? '?'}  goalRun: ${g.goalRun?.id ?? g.goalRunId ?? '?'} ${g.goalRun?.state ?? ''}`);
    say(`spend: ${JSON.stringify(g.spend ?? null)}  spendCny: ${g.spendCny ?? '?'}  reservations: ${(g.budget?.reservations ?? []).length}`);
    say(`elapsedMs: ${g.elapsedMs ?? '?'}  started: ${g.startedAt ?? '?'}  finished: ${g.finishedAt ?? '?'}`);
    say(`checks: ${JSON.stringify(g.checks ?? null)}`);
    say(`tasks: ${JSON.stringify((g.tasks ?? []).map((t) => `${t.kind}:${t.state}`))}`);
    say(`ui failures: ${JSON.stringify(g.ui?.failures ?? [])}`);
    say(`workspaceFiles (${(g.workspaceFiles ?? []).length}): ${JSON.stringify((g.workspaceFiles ?? []).slice(0, 200))}`);
    say(`projectChecks: ${JSON.stringify(g.projectChecks ?? [])}`);
  }
  const wsCopy = walk(join(dir, 'workspace'));
  say(`evidence workspace copy (${wsCopy.length}): ${JSON.stringify(wsCopy.slice(0, 200))}`);
  for (const [label, p, n] of [['harness-stdout', join(dir, 'harness-stdout.txt'), 40], ['harness-stderr', join(dir, 'harness-stderr.txt'), 20], ['driver.ndjson', join(dir, 'driver.ndjson'), 20], ['desktop.log', join(dir, 'app-logs', 'desktop.log'), 60]]) {
    const t = tail(p, n);
    say(`--- tail ${label} ---`);
    say(t === null ? '(missing)' : t);
  }

  if (raw !== null && key.length >= 8 && raw.includes(key)) say('live-goal.json contains the model key: blob NOT emitted');
  else if (raw !== null) {
    const b64 = gzipSync(Buffer.from(raw, 'utf8')).toString('base64');
    say(MARK_BEGIN);
    for (let i = 0; i < b64.length; i += 4000) say(`${CHUNK_PREFIX}${b64.slice(i, i + 4000)}`);
    say(MARK_END);
  }

  const { chosen, skipped } = keyShotsOf(dir);
  say(`key screenshots in log: ${JSON.stringify(chosen.map((p) => p.split(/[\\/]/u).pop()))}${skipped.length === 0 ? '' : `  skipped (over ${KEY_SHOT_MAX_BYTES} B or empty): ${JSON.stringify(skipped)}`}`);
  for (const p of chosen) {
    const name = p.split(/[\\/]/u).pop();
    const b64 = gzipSync(readFileSync(p)).toString('base64');
    say(`${SHOT_BEGIN} ${name}`);
    for (let i = 0; i < b64.length; i += 4000) say(`${SHOT_PREFIX}${b64.slice(i, i + 4000)}`);
    say(`${SHOT_END} ${name}`);
  }

  if (stepSummary) {
    const md = out.filter((l) => !l.startsWith(CHUNK_PREFIX) && !l.startsWith(SHOT_PREFIX));
    appendFileSync(stepSummary, `## hark-live-goal summary\n\n\`\`\`\n${md.join('\n').slice(0, 60000)}\n\`\`\`\n`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--decode-shots') {
  const outDir = process.argv[4] ?? 'screenshots-from-log';
  const names = writeDecodedShots(readFileSync(process.argv[3] ?? 'job.log', 'utf8'), outDir);
  console.log(`decoded ${names.length} key screenshot(s) into ${outDir}: ${JSON.stringify(names)}`);
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  summarize(process.argv[2] ?? 'hark-evidence', { key: process.env.COMPANYOS_MODEL_API_KEY ?? '', stepSummary: process.env.GITHUB_STEP_SUMMARY ?? '' });
}

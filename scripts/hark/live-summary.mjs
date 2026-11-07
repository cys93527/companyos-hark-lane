#!/usr/bin/env node
// Hark lane (2026-11-07): GitHub Free artifact storage (500 MB) can refuse the evidence upload.
// This prints a compact, recoverable summary of a live-goal run to the job log and to
// $GITHUB_STEP_SUMMARY: outcome, spend, goal status, generated workspace files, key log tails,
// and the whole live-goal.json (gzip + base64, one `HLG:` line per chunk between markers) so
// the spend ledger can be settled from the job log alone (lane fetch-live.sh decodes it).
// The model key is never printed: every emitted line is redacted against it.
// usage: node scripts/hark/live-summary.mjs <evidenceDir>
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const MARK_BEGIN = 'HARK-LIVE-GOAL-JSON-GZB64 BEGIN';
export const MARK_END = 'HARK-LIVE-GOAL-JSON-GZB64 END';
export const CHUNK_PREFIX = 'HLG:';

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

  if (stepSummary) {
    const md = out.filter((l) => !l.startsWith(CHUNK_PREFIX));
    appendFileSync(stepSummary, `## hark-live-goal summary\n\n\`\`\`\n${md.join('\n').slice(0, 60000)}\n\`\`\`\n`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  summarize(process.argv[2] ?? 'hark-evidence', { key: process.env.COMPANYOS_MODEL_API_KEY ?? '', stepSummary: process.env.GITHUB_STEP_SUMMARY ?? '' });
}

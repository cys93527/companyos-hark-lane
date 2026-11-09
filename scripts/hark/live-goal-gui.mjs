#!/usr/bin/env node
// Hark lane LIVE-CUSTOM (user request 2026-11-06): run ONE real user requirement through the
// INSTALLED CompanyOS exactly the way a user does - the real GUI, the main process's own
// autonomy driver, its own logs and database - and capture everything needed to monitor it.
// This script never touches CompanyOS internals: it launches CompanyOS.exe with a Chrome
// DevTools Protocol port, types the goal into the composer, chooses the model / access policy
// in the UI, clicks 批准 on approval cards, and observes progress through the UI, its own
// bridge reads and a READ-ONLY connection to the app's database.
// Runs on the app's bundled runtime:
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) live-goal-gui.mjs <appDir> <evidenceDir> <workspaceDir>
// Goal text: env GOAL_TEXT. Watchdog: env LIVE_WATCHDOG_MS. The API key stays in env and is
// never printed; evidence is scanned for it by the workflow.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, cpSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { driverEndLabel, driverEndOf } from './live-driver-end.mjs';
import { collectWorkspaceEvidence, isEvidenceSkippedPath } from './evidence-filter.mjs';

/* global fetch, WebSocket -- Node >= 22 globals on the bundled Electron runtime */

const [appDir, evidence, workspaceArg] = process.argv.slice(2);
const GOAL = (process.env.GOAL_TEXT ?? '').trim();
const WATCHDOG_MS = Number(process.env.LIVE_WATCHDOG_MS ?? 9_000_000);
const IDLE_STOP_MS = Number(process.env.LIVE_IDLE_STOP_MS ?? 15 * 60_000);
const POLL_MS = 30_000;
const SHOT_EVERY_MS = 60_000;
const DESKTOP_SHOT_EVERY_MS = 300_000;
const PORT = 9333;
const COMPANY = 'company_default';
const userData = join(process.env.APPDATA ?? '', 'CompanyOS');
const dbFile = join(userData, 'data', 'companyos.sqlite');
const shots = join(evidence, 'screenshots');
mkdirSync(shots, { recursive: true });
const out = { mode: 'custom-gui', goal: GOAL, startedAt: new Date().toISOString(), runtime: { node: process.versions.node, electron: process.versions.electron ?? null }, ui: { steps: [], approvals: [], failures: [] } };
const progressFile = join(evidence, 'progress.ndjson');
const log = (msg, extra = {}) => { const row = { t: new Date().toISOString(), msg, ...extra }; console.log(JSON.stringify(row)); appendFileSync(join(evidence, 'driver.ndjson'), `${JSON.stringify(row)}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-');

/* ----------------------------------------------------------------- CDP ---- */
let ws = null; let nextId = 1; const pending = new Map();
const cdp = (method, params = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  if (ws === null || ws.readyState !== 1) { reject(new Error('CDP not connected')); return; }
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, timeoutMs);
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const connect = async () => {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((p) => p.type === 'page' && !String(p.url).startsWith('devtools://'));
      if (page !== undefined) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
        ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); const p = pending.get(m.id); if (p) { pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } };
        ws.onclose = () => { ws = null; };
        return page.url;
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('CDP endpoint never came up');
};
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
// Live contract-fill run 4: screenshots were lost with the refused artifact. KEY shots also get a
// small JPEG (CDP-downscaled, <= KEY_SHOT_MAX_BYTES) in screenshots/key/, which live-summary.mjs
// emits into the job log (HLS: chunks) so fetch-live.sh can rebuild them without any artifact.
const KEY_SHOT_MAX_BYTES = 150_000;
const KEY_SHOT_STEPS = [{ quality: 60, scale: 0.6 }, { quality: 45, scale: 0.45 }, { quality: 35, scale: 0.35 }];
const keyShots = join(shots, 'key');
mkdirSync(keyShots, { recursive: true });
const keyShot = async (file) => {
  try {
    const m = await cdp('Page.getLayoutMetrics', {}, 15_000);
    const vp = m.cssVisualViewport ?? m.layoutViewport ?? {};
    const width = Math.max(1, Math.round(vp.clientWidth ?? 1280));
    const height = Math.max(1, Math.round(vp.clientHeight ?? 800));
    for (const step of KEY_SHOT_STEPS) {
      const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: step.quality, clip: { x: 0, y: 0, width, height, scale: step.scale } }, 30_000);
      const bytes = Buffer.from(r.data, 'base64');
      if (bytes.length <= KEY_SHOT_MAX_BYTES) { writeFileSync(join(keyShots, file.replace(/\.png$/u, '.jpg')), bytes); return; }
    }
    log('key screenshot over size at every step', { file });
  } catch (e) { log('key screenshot failed', { file, error: String(e?.message ?? e) }); }
};
const shot = async (label, { key = false } = {}) => {
  try {
    const r = await cdp('Page.captureScreenshot', { format: 'png' }, 30_000);
    const file = `${stamp()}-${label}.png`;
    writeFileSync(join(shots, file), Buffer.from(r.data, 'base64'));
    if (key) await keyShot(file);
    return file;
  } catch (e) { log('screenshot failed', { label, error: String(e?.message ?? e) }); return null; }
};
const desktopShot = (label) => {
  const file = join(shots, `${stamp()}-desktop-${label}.png`);
  const ps = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file.replace(/'/gu, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) log('desktop screenshot failed', { label, stderr: String(r.stderr ?? '').slice(0, 300) });
};
// UI text of the page parts that matter for monitoring (never secrets: the renderer has none).
const UI_STATE = `(() => {
  const t = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => (e.innerText || '').trim()).filter(Boolean).join(' | ').slice(0, 1500);
  const goal = document.querySelector('[data-testid=recent-goals] .sidebar__goal');
  return {
    composer: !!document.querySelector('[data-testid=goal-objective]'),
    composerBlocked: t('[data-testid=composer-blocked]'),
    model: t('[data-testid=model-selector]'),
    approvals: document.querySelectorAll('.approval-card__approve').length,
    approvalText: t('[data-testid=approval-card]'),
    failures: t('[data-testid=action-failure]'),
    banner: t('.services-failure, [role=alert]'),
    firstGoal: goal ? (goal.innerText || '').trim().slice(0, 300) : null,
    firstGoalLive: !!document.querySelector('[data-testid=recent-goals] .sidebar__goal .sidebar__goal-state--live'),
    runtime: t('[data-testid=runtime-lifecycle], [data-testid=runtime-budget], [data-testid=runtime-blockers]'),
    plan: t('[data-testid=plan-steps]'),
  };
})()`;
const clickText = (scopeSel, pattern) => evaluate(`(() => {
  const re = new RegExp(${JSON.stringify(pattern)}, 'u');
  const scope = document.querySelector(${JSON.stringify(scopeSel)}) || document;
  const b = Array.from(scope.querySelectorAll('button')).find((x) => re.test((x.innerText || '').trim()) && !x.disabled);
  if (!b) return false; b.click(); return (b.innerText || '').trim().slice(0, 120);
})()`);
const summary = () => evaluate(`window.companyos.controlPlaneRequest({ operation: 'home.summary', payload: { companyId: '${COMPANY}' } })`);

/* ---------------------------------------------------- read-only DB view ---- */
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* no sqlite */ }
const dbRead = (fn) => {
  if (DatabaseSync === null || !existsSync(dbFile)) return null;
  let db = null;
  try { db = new DatabaseSync(dbFile, { readOnly: true }); return fn((sql) => db.prepare(sql).all()); }
  catch (e) { return { error: String(e?.message ?? e).slice(0, 300) }; }
  finally { try { db?.close(); } catch { /* ignore */ } }
};
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const spendOf = (budget) => {
  const res = Array.isArray(budget?.reservations) ? budget.reservations : [];
  return { calls: res.length, known: res.filter((r) => r.status === 'KNOWN').length, unknown: res.filter((r) => r.status !== 'KNOWN').length,
    micros: res.reduce((m, r) => m + (r.status === 'KNOWN' ? (r.usage?.costMicros ?? 0) : (r.bound?.costMicros ?? 0)), 0) };
};
/** The newest 512 KB of the app's stdout log (the driver's JSON log lines). */
const appLogTail = () => {
  try {
    const file = join(evidence, 'app-stdout.txt');
    const size = statSync(file).size;
    const fd = openSync(file, 'r');
    try {
      const length = Math.min(size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return ''; }
};
const progressSnapshot = (runId) => dbRead((q) => {
  const run = runId === null ? null : q(`SELECT state, execution_budget_json AS b FROM runs WHERE id = '${runId}'`)[0] ?? null;
  const tasks = q('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state');
  const ev = q('SELECT COUNT(*) AS n, MAX(rowid) AS last FROM events')[0];
  const lastTypes = q('SELECT type FROM events ORDER BY rowid DESC LIMIT 5').map((r) => r.type);
  return { goalState: run?.state ?? null, spend: spendOf(parse(run?.b ?? 'null')), tasks: Object.fromEntries(tasks.map((r) => [r.state, r.n])), events: ev?.n ?? 0, lastEventTypes: lastTypes };
});

/* ---------------------------------------------------------------- main ---- */
let app = null;
const killApp = () => {
  if (app === null || app.exitCode !== null) return;
  spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { encoding: 'utf8' });
};
let code = 0;
try {
  if (GOAL === '') throw new Error('GOAL_TEXT is empty');
  // The user's empty project folder, remembered as the selected workspace (what the app
  // persists after the folder chooser; the chooser is a native dialog CDP cannot drive).
  mkdirSync(workspaceArg, { recursive: true });
  const workspace = realpathSync.native(workspaceArg);
  out.workspace = workspace;
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, 'workspace-selection.json'), JSON.stringify({ root: workspace, selectedAt: new Date().toISOString() }, null, 2));

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const appOut = openSync(join(evidence, 'app-stdout.txt'), 'a');
  app = spawn(join(appDir, 'CompanyOS.exe'), [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', appOut, appOut], windowsHide: false });
  app.on('exit', (c) => log('app exited', { code: c }));
  const url = await connect();
  log('cdp connected', { url });
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // Wait for the shell (or a startup failure page).
  let ui = null;
  for (let i = 0; i < 90; i += 1) {
    ui = await evaluate(UI_STATE).catch(() => null);
    if (ui?.composer) break;
    if (i === 10) { const c = await clickText('[data-testid=shell-nav]', '^对话与任务$').catch(() => false); if (c) log('navigated to chat for the composer'); }
    await sleep(2000);
  }
  out.ui.initial = ui;
  await shot('00-startup');
  desktopShot('startup');
  if (!ui?.composer) throw Object.assign(new Error('composer never appeared'), { result: 'UI_NO_COMPOSER' });
  // A blocked composer before a model is chosen is the expected first-run state, not a failure.
  out.ui.startupComposerBlocked = ui.composerBlocked || null;

  // Model: choose the configured provider model in the composer's model popover when none is selected.
  if (!/deepseek/iu.test(`${ui.model} ${ui.composerBlocked ? '' : 'selected'}`) || ui.composerBlocked) {
    const opened = await evaluate(`(() => { const b = document.querySelector('.composer__model-slot') || document.querySelector('.composer__model-button'); if (!b) return false; b.click(); return true; })()`);
    await sleep(1500);
    await shot('01-model-popover');
    const chosen = await clickText('[data-testid=model-selector-popover]', 'deepseek|DeepSeek').catch(() => false)
      || await clickText('[data-testid=model-selector-popover]', '.').catch(() => false);
    out.ui.steps.push({ step: 'choose-model', opened, chosen });
    await sleep(4000);
  }
  ui = await evaluate(UI_STATE);
  out.ui.modelAfterChoice = await evaluate(`(document.querySelector('.composer__model-slot') || {}).innerText || ''`).catch(() => '');
  if (ui.composerBlocked) out.ui.failures.push({ at: 'after-model-choice', composerBlocked: ui.composerBlocked });
  // Access policy: the default '询问权限' (normal autonomy, high-risk stops at an approval).
  const chip = await clickText('[data-testid=composer]', '(访问权限|询问权限|只读|工作区操作) ▾');
  await sleep(800);
  const policy = await clickText('[data-testid=authority-options]', '^询问权限').catch(() => false);
  out.ui.steps.push({ step: 'access-policy', chip, policy });
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => undefined);
  await sleep(500);
  // Type the goal exactly as the user wrote it and press 发送.
  await evaluate(`document.querySelector('[data-testid=goal-objective]').focus()`);
  await cdp('Input.insertText', { text: GOAL });
  await sleep(1000);
  await shot('02-goal-typed');
  // The send button reads '发送' + its shortcut badge ('Ctrl ↵').
  const sent = await clickText('[data-testid=composer]', '^(发送|提交中)');
  out.ui.steps.push({ step: 'send', sent });
  if (!sent) throw Object.assign(new Error('send button not clickable'), { result: 'UI_SEND_DISABLED' });

  // The run id from the app's own canonical home summary.
  let runId = null;
  for (let i = 0; i < 60 && runId === null; i += 1) {
    await sleep(2000);
    const s = await summary().catch(() => null);
    const g = s?.ok ? s.value.goals.find((x) => x.objective === GOAL) ?? s.value.goals[0] : undefined;
    if (g !== undefined) runId = g.runId;
    if (i === 5) { const u = await evaluate(UI_STATE); if (u.failures) out.ui.failures.push({ at: 'submit', failures: u.failures }); }
  }
  out.goalRunId = runId;
  log('goal created', { runId });
  await shot('03-goal-created', { key: true });
  if (runId === null) throw Object.assign(new Error('goal did not appear in the home summary'), { result: 'GOAL_NOT_CREATED' });

  // Monitor: UI + read-only DB snapshot every 30 s; screenshot every 60 s; approve approval cards.
  const t0 = Date.now(); let lastShot = 0; let lastDesktop = Date.now(); let lastChange = Date.now(); let lastKey = '';
  let terminal = null;
  while (true) {
    await sleep(POLL_MS);
    if (app.exitCode !== null) { terminal = 'APP_EXITED'; break; }
    const u = await evaluate(UI_STATE).catch((e) => ({ error: String(e?.message ?? e) }));
    const s = await summary().catch(() => null);
    const g = s?.ok ? s.value.goals.find((x) => x.runId === runId) ?? null : null;
    const p = progressSnapshot(runId);
    const row = { t: new Date().toISOString(), elapsedS: Math.round((Date.now() - t0) / 1000), state: g?.state ?? null, terminalOutcome: g?.terminalOutcome ?? null, ui: u, db: p };
    appendFileSync(progressFile, `${JSON.stringify(row)}\n`);
    console.log(`[progress] ${row.elapsedS}s state=${row.state} outcome=${row.terminalOutcome} calls=${p?.spend?.calls} micros=${p?.spend?.micros} events=${p?.events} tasks=${JSON.stringify(p?.tasks)} approvals=${u?.approvals}`);
    if (u?.failures && !out.ui.failures.some((f) => f.failures === u.failures)) out.ui.failures.push({ at: row.t, failures: u.failures });
    if (u?.banner && !out.ui.failures.some((f) => f.banner === u.banner)) out.ui.failures.push({ at: row.t, banner: u.banner });
    if (u?.approvals > 0) {
      const before = await shot('approval-card', { key: true });
      const clicked = await clickText('[data-testid=approval-card]', '^批准$');
      out.ui.approvals.push({ at: row.t, text: u.approvalText, clicked, screenshot: before });
      log('approval answered', { clicked });
      await sleep(3000);
      await shot('approval-after');
    }
    if (Date.now() - lastShot >= SHOT_EVERY_MS) { await shot(`run-${String(row.elapsedS).padStart(5, '0')}s`); lastShot = Date.now(); }
    if (Date.now() - lastDesktop >= DESKTOP_SHOT_EVERY_MS) { desktopShot(`run-${row.elapsedS}s`); lastDesktop = Date.now(); }
    const key = JSON.stringify([row.state, p?.events, p?.spend?.calls, u?.approvals]);
    if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
    const ended = row.terminalOutcome ?? (row.state === 'COMPLETED' || row.state === 'FAILED' ? row.state : null);
    if (ended !== null) { terminal = `TERMINAL_${ended}`; break; }
    // run 5: the driver's own terminal (blocked / failed / completed) ends the monitor at once.
    const driverEnd = driverEndOf(appLogTail(), runId);
    if (driverEnd !== null) { out.driverEnd = driverEnd; terminal = driverEndLabel(driverEnd); await shot('driver-end', { key: true }); break; }
    if (Date.now() - lastChange >= IDLE_STOP_MS) { terminal = 'IDLE_NO_PROGRESS'; break; }
    if (Date.now() - t0 >= WATCHDOG_MS) { terminal = 'WATCHDOG'; break; }
  }
  out.monitorEnd = terminal;
  out.elapsedMs = Date.now() - t0;
  log('monitor end', { terminal });

  // Final UI tour: the goal conversation, runtime panel, artifacts, then each surface.
  await shot('90-final', { key: true });
  desktopShot('final');
  await clickText('[data-testid=recent-goals]', '.').catch(() => false);
  await sleep(4000);
  await evaluate(`(() => { const c = document.querySelector('[data-testid=conversation]'); if (c) c.scrollTop = c.scrollHeight; })()`).catch(() => undefined);
  await shot('91-goal-bottom', { key: true });
  await evaluate(`(() => { const c = document.querySelector('[data-testid=conversation]'); if (c) c.scrollTop = 0; })()`).catch(() => undefined);
  await shot('92-goal-top', { key: true });
  out.ui.final = await evaluate(UI_STATE).catch(() => null);
  out.ui.finalText = await evaluate(`(document.querySelector('[data-testid=app-shell]') || document.body).innerText.slice(0, 20000)`).catch(() => null);
  for (const [i, label] of ['首页', '知识库', '工具', '智能体'].entries()) {
    if (await clickText('[data-testid=shell-nav]', `^${label}$`).catch(() => false)) { await sleep(2500); await shot(`9${3 + i}-${label}`); }
  }
} catch (e) {
  out.result = e?.result ?? 'DRIVER_ERROR';
  out.error = String(e?.stack ?? e).slice(0, 2000);
  log('driver error', { error: out.error });
  await shot('99-error', { key: true }).catch(() => undefined);
  desktopShot('error');
  code = 11;
}

/* ------------------------------------------------------------- collect ---- */
killApp();
await sleep(4000);
const collected = dbRead((q) => {
  const id = out.goalRunId ?? null;
  const rows = (sql) => { try { return q(sql); } catch (e) { return { error: String(e?.message ?? e) }; } };
  const run = id === null ? null : rows(`SELECT * FROM runs WHERE id = '${id}'`)[0] ?? null;
  const budget = parse(run?.execution_budget_json ?? 'null');
  writeFileSync(join(evidence, 'events.ndjson'), (rows('SELECT rowid AS seq, * FROM events ORDER BY rowid') || []).map((r) => JSON.stringify(r)).join('\n'));
  return {
    goalRun: run === null ? null : { id: run.id, state: run.state },
    budget,
    spend: spendOf(budget),
    runs: rows('SELECT id, state, created_at FROM runs ORDER BY rowid'),
    tasks: rows('SELECT id, kind, state, inputs_json FROM tasks ORDER BY rowid'),
    agentExecutions: rows('SELECT agent_id, status, model_key, provider_id, provider_model_id FROM agent_executions ORDER BY rowid'),
    artifacts: rows('SELECT * FROM artifacts ORDER BY rowid'),
    validations: rows('SELECT * FROM validations ORDER BY rowid'),
    handoffs: rows('SELECT * FROM handoffs ORDER BY rowid'),
    approvals: rows("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%approval%'"),
    eventTypeCounts: rows('SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC'),
    // Run 6: each failed attempt with the kernel's OWN error (message, code), stderr tail and
    // last events from its executor.dispatch_settled row - the slug alone hid the root cause.
    attemptFailures: (() => {
      const failed = rows("SELECT id, task_id, attempt_number, failure_code, settled_at FROM execution_attempts WHERE state = 'FAILED' ORDER BY rowid");
      if (!Array.isArray(failed)) return failed;
      return failed.map((a) => {
        const settled = rows(`SELECT payload FROM events WHERE aggregate_id = '${String(a.id).replace(/'/gu, "''")}' AND type = 'executor.dispatch_settled' ORDER BY rowid DESC LIMIT 1`);
        const p = Array.isArray(settled) && settled[0] !== undefined ? parse(settled[0].payload) : null;
        return { attemptId: a.id, taskId: a.task_id, attemptNumber: a.attempt_number, failureCode: a.failure_code, settledAt: a.settled_at,
          outcome: p?.outcome ?? null, reasonCode: p?.reasonCode ?? null, kernelError: p?.kernelError ?? null,
          stderrTail: p?.stderrTail ?? null, kernelEventsTail: p?.kernelEventsTail ?? null, durationMs: p?.durationMs ?? null };
      });
    })(),
    // Run 10: the attempt went silent for 15 min and the evidence artifact was refused (storage
    // quota), so nothing showed what it was doing. The last events (type, time, payload head)
    // travel in this JSON, which also reaches the job log.
    recentEvents: (() => {
      const last = rows('SELECT type, occurred_at, payload FROM events ORDER BY rowid DESC LIMIT 30');
      if (!Array.isArray(last)) return last;
      return last.reverse().map((e) => ({ type: e.type, at: e.occurred_at, payload: String(e.payload ?? '').slice(0, 400) }));
    })(),
    tables: rows("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
  };
});
Object.assign(out, collected ?? {});
out.spendCny = Number(((out.spend?.micros ?? 0) / 1e6).toFixed(6));
const safe = (name, fn) => { try { fn(); } catch (e) { (out.collectErrors ??= []).push(`${name}: ${String(e?.message ?? e).slice(0, 300)}`); } };
for (const s of ['', '-wal', '-shm']) safe(`db${s}`, () => { if (existsSync(dbFile + s)) copyFileSync(dbFile + s, join(evidence, `companyos.sqlite${s}`)); });
safe('logs', () => { if (existsSync(join(userData, 'logs'))) cpSync(join(userData, 'logs'), join(evidence, 'app-logs'), { recursive: true }); });
safe('budget', () => { if (existsSync(join(userData, 'budget'))) cpSync(join(userData, 'budget'), join(evidence, 'userdata-budget'), { recursive: true }); });
safe('kernel-logs', () => {
  const root = join(userData, 'agent-kernel-state');
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (!isEvidenceSkippedPath(e.name)) walk(p); } else if (/\.(log|jsonl|ndjson|json|txt)$/u.test(e.name) && statSync(p).size < 5_000_000) { const t = join(evidence, 'kernel-state', relative(root, p)); mkdirSync(join(t, '..'), { recursive: true }); copyFileSync(p, t); } } };
  if (existsSync(root)) walk(root);
});
safe('workspace', () => {
  if (out.workspace === undefined) return;
  // Run 6: no dependency stores / package-manager caches / VCS data, bounded per file and in total.
  const ws = collectWorkspaceEvidence(out.workspace, join(evidence, 'workspace'));
  out.workspaceFiles = ws.files;
  out.workspaceSkippedDirs = ws.skippedDirs;
  out.workspaceEvidenceCopy = { copied: ws.copied, copiedBytes: ws.copiedBytes, omitted: ws.omitted.slice(0, 50), omittedCount: ws.omitted.length };
});
// Independent of every model claim: does the generated project install / build / test?
safe('project-checks', () => {
  if (out.workspace === undefined) return;
  const roots = [out.workspace, ...readdirSync(out.workspace, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules').map((e) => join(out.workspace, e.name))]
    .filter((d) => existsSync(join(d, 'package.json')));
  // Run 11: the en-US runner's console code page (cp1252) made the generated Python tests' Chinese
  // output raise UnicodeEncodeError in this independent check; a Chinese Windows (cp936) and the
  // kernel's own runs did not. UTF-8 stdio keeps the check about the project, not the runner locale.
  const childEnv = { ...process.env, CI: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }; delete childEnv.ELECTRON_RUN_AS_NODE; delete childEnv.COMPANYOS_MODEL_API_KEY;
  const npm = (cwd, args, timeout) => { const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `npm ${args}`], { cwd, encoding: 'utf8', timeout, env: childEnv }); return { status: r.status, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000) }; };
  out.projectChecks = roots.map((root) => {
    const pkg = parse(readFileSync(join(root, 'package.json'), 'utf8')) ?? {};
    const scripts = pkg.scripts ?? {};
    const r = { root: relative(out.workspace, root) || '.', scripts: Object.keys(scripts), dependencies: Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }), hadNodeModules: existsSync(join(root, 'node_modules')) };
    if (!r.hadNodeModules && r.dependencies.length > 0) r.install = npm(root, 'install --no-audit --no-fund', 600_000);
    if (scripts.test) r.test = npm(root, 'test', 300_000);
    if (scripts.build) r.build = npm(root, 'run build', 600_000);
    return r;
  });
});
out.checks = {
  goalCreated: typeof out.goalRunId === 'string',
  goalCompleted: /COMPLET|SUCCE/u.test(String(out.monitorEnd ?? '')) || String(out.goalRun?.state ?? '').toUpperCase() === 'COMPLETED',
  workspaceHasFiles: (out.workspaceFiles ?? []).length > 0,
  artifacts: Array.isArray(out.artifacts) && out.artifacts.length > 0,
  validationPass: Array.isArray(out.validations) && out.validations.some((v) => v.status === 'pass'),
  noUiFailures: out.ui.failures.length === 0,
};
out.result ??= Object.values(out.checks).every(Boolean) ? 'GOAL_COMPLETED_CLEAN' : 'INCOMPLETE';
out.finishedAt = new Date().toISOString();
writeFileSync(join(evidence, 'live-goal.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ result: out.result, monitorEnd: out.monitorEnd, spend: out.spend, checks: out.checks }, null, 2));
process.exit(code !== 0 ? code : out.result === 'GOAL_COMPLETED_CLEAN' ? 0 : 20);

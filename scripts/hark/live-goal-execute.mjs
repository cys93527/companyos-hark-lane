#!/usr/bin/env node
// Hark lane H15c: ONE small live Goal EXECUTED end to end through the INSTALLED app's
// production composition: real DeepSeek planning + work items executed by the PACKAGED
// agent kernel (resources/agent-kernel/<version>, user-approved 2026-10-26) inside the
// trusted budget (operator approval, cap CNY 1). Records the real file outputs and the
// durable Artifact / CAS / Validation / Handoff rows. Two dependent steps so the first
// producer has a successor seat (a handoff only exists between two seats).
// Runs on the app's bundled runtime: CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) this.mjs
//   <resources/app dir> <evidenceDir> <budgetDir>
// The API key is resolved in-process from env and never printed or written.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [appDir, evidence, budgetDir] = process.argv.slice(2);
mkdirSync(evidence, { recursive: true });
const imp = (rel) => import(pathToFileURL(join(appDir, rel)).href);
const COMPANY = 'company_default';
const MODEL_KEY = 'h15c.live';
const WATCHDOG_MS = Number(process.env.H15C_WATCHDOG_MS ?? 600_000);
// H15d: 'acceptance' = the user-approved realistic acceptance goal (separate CNY 5 budget):
// a small Node project (scripts/hark/acceptance-fixture) with two real defects, a long
// business-rules document and a new feature to implement + test + document.
const SCENARIO = process.env.H15_SCENARIO === 'acceptance' ? 'acceptance' : 'smoke';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'acceptance-fixture');
const out = { scenario: SCENARIO, startedAt: new Date().toISOString(), runtime: { node: process.versions.node, electron: process.versions.electron ?? null } };
let db = null;
let dataDir = null;
let finishing = false;
const finish = (code) => {
  if (finishing) return;
  finishing = true;
  out.finishedAt = new Date().toISOString();
  out.finishErrors = [];
  const step = (name, fn) => { try { fn(); } catch (e) { out.finishErrors.push(`${name}: ${String(e?.message ?? e).slice(0, 400)}`); } };
  step('write-json-early', () => writeFileSync(join(evidence, 'live-goal.json'), JSON.stringify(out, null, 2)));
  step('db-close', () => db?.close());
  if (dataDir !== null) for (const s of ['', '-wal', '-shm']) {
    const f = join(dataDir, `companyos.sqlite${s}`);
    step(`copy${s}`, () => { if (existsSync(f)) copyFileSync(f, join(evidence, `companyos.sqlite${s}`)); });
  }
  step('copy-cas', () => { if (dataDir !== null && existsSync(`${dataDir}-cas`)) cpSync(`${dataDir}-cas`, join(evidence, 'cas'), { recursive: true }); });
  step('write-json', () => writeFileSync(join(evidence, 'live-goal.json'), JSON.stringify(out, null, 2)));
  console.log(JSON.stringify(out, null, 2));
  process.exit(code);
};
process.on('uncaughtException', (e) => { out.result = 'HARNESS_CRASH'; out.error = String(e?.stack ?? e).slice(0, 2000); finish(10); });

process.on('unhandledRejection', (e) => { out.unhandled = String(e?.stack ?? e).slice(0, 2000); finishing = false; finish(13); });
try {
  const { nullLogger } = await imp('node_modules/@companyos/observability/dist/index.js');
  const { openDurableDatabase } = await imp('node_modules/@companyos/persistence/dist/index.js');
  const { openArtifactFoundation } = await imp('apps/desktop/dist/artifact-stack.js');
  const { composeCoreServices } = await imp('apps/desktop/dist/core-services.js');
  const { resolveOpenAiCompatibleConfig } = await imp('apps/desktop/dist/models/openai-compatible-provider.js');
  const { productionCompositionOptions } = await imp('apps/desktop/dist/production-composition.js');
  const { createDeploymentBudgetProofSource } = await imp('apps/desktop/dist/deployment-budget-proof.js');

  const cfg = resolveOpenAiCompatibleConfig(process.env);
  if (!cfg.ok || cfg.value === null) { out.result = 'CONFIG_INVALID'; finish(2); }
  out.model = { providerId: cfg.value.providerId, modelId: cfg.value.modelId, baseUrl: cfg.value.baseUrl };
  if ((process.env[cfg.value.apiKeyEnv] ?? '').trim() === '') { out.result = 'BLOCKED_NO_SECRET'; finish(3); }

  const deployment = createDeploymentBudgetProofSource(budgetDir);
  if (deployment === undefined) { out.result = 'NO_BUDGET_APPROVAL'; finish(4); }
  out.budgetCap = deployment.cap;

  dataDir = mkdtempSync(join(tmpdir(), 'h15c-db-'));
  db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] });
  const foundation = await openArtifactFoundation({ casRoot: `${dataDir}-cas`, database: db, logger: nullLogger });
  if (!foundation.ok) { out.result = 'CAS_FAILED'; finish(5); }
  const core = await composeCoreServices(db, nullLogger, {
    artifactFoundation: foundation,
    ...productionCompositionOptions(process.env, { trustedBudgetProofs: deployment.source, budgetCap: deployment.cap }),
    // Same per-user writable roots main.ts gives the installed app (userData stand-ins).
    usageReconciliationDir: join(`${dataDir}-user`, 'budget'),
    embeddedDshStateRoot: join(`${dataDir}-user`, 'agent-kernel-state'),
  });
  if (core === null) { out.result = 'COMPOSITION_FAILED'; finish(6); }

  if (process.env.COS_PLAN_PREVIEW_WITHOUT_EXECUTOR === '1') { out.result = 'PREVIEW_MODE_SET'; finish(12); }
  // realpath: the kernel/workspace policy refuses 8.3 short-name aliases (RUNNER~1).
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'h15c-ws-')));
  out.workspace = ws;
  if (SCENARIO === 'acceptance') cpSync(FIXTURE, ws, { recursive: true });
  else writeFileSync(join(ws, 'README.md'), '# hello-companyos\n\nA tiny workspace for the H15c live execution smoke.\n');
  const opened = await core.repositoryRuntime.openWorkspace({ root: ws, commandProfile: {} });
  if (!opened.ok) { out.result = 'WORKSPACE_OPEN_FAILED'; out.error = opened.error.message; finish(7); }

  const reg = await core.models.registerFromProvider({ providerId: cfg.value.providerId, providerModelId: cfg.value.modelId, modelKey: MODEL_KEY, actorId: 'user_owner' });
  if (!reg.ok) { out.result = 'MODEL_REGISTER_FAILED'; out.error = reg.error.message; finish(8); }
  const pol = await core.policies.savePolicy({ id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: 'user_owner' });
  if (!pol.ok) { out.result = 'MODEL_POLICY_FAILED'; out.error = pol.error.message; finish(8); }

  const created = await core.controlPlane.handle({ operation: 'goal.create', payload: {
    companyId: COMPANY,
    objective: SCENARIO === 'acceptance'
      ? '工作区根目录是一个小型 Node.js 库存模块（shop-inventory，无第三方依赖），业务规则全部写在 docs/DOMAIN.md。请按顺序完成：1）阅读 docs/DOMAIN.md 和现有代码，修复 src/inventory.js 中导致 npm test 失败的缺陷（以规则 R2、R3 为准）；2）按规则 R4/R5 在 src/inventory.js 新增并导出 reorderPlan(items)，并新建 test/reorder.test.js，至少 3 个测试（覆盖文档中的示例、等于补货点不补、已下架不补）；3）运行 npm test 确认全部通过；4）新建 docs/CHANGES.md，用中文说明修复了哪些缺陷、reorderPlan 的规则和最终测试结果。不要引入任何第三方依赖，不要修改 docs/DOMAIN.md。'
      : '这是一个极小任务，计划恰好两个步骤，第二步依赖第一步：第 1 步在工作区根目录新建 hello.txt，内容为一行 "Hello CompanyOS"；第 2 步读取 hello.txt，在工作区根目录新建 summary.md，写一句话说明 hello.txt 的内容。',
    commandId: `h15c-${String(Date.now())}`,
  } });
  if (!created.ok) { out.result = 'GOAL_CREATE_FAILED'; out.error = JSON.stringify(created.error).slice(0, 1000); finish(9); }
  const runId = String(created.value.runId);
  out.goalRunId = runId;

  const t0 = Date.now();
  const outcome = await Promise.race([
    core.autonomyDriver.run({ companyId: COMPANY, runId }),
    new Promise((r) => setTimeout(() => r('WATCHDOG'), WATCHDOG_MS).unref?.()),
  ]);
  out.elapsedMs = Date.now() - t0;
  out.driver = outcome === 'WATCHDOG' ? 'WATCHDOG' : (outcome.ok
    ? { terminal: outcome.value.terminal, terminalReason: outcome.value.terminalReason, progress: outcome.value.progress,
        steps: outcome.value.stepsExecuted, attempts: outcome.value.attempts, externalBlocks: outcome.value.externalBlockCount,
        doctor: outcome.value.doctor.map((d) => ({ id: d.checkId, status: d.status, code: d.failureCode })) }
    : { error: { code: outcome.error.code, message: outcome.error.message } });

  const q = (sql) => db.db.prepare(sql).all();
  out.goalRun = q(`SELECT state FROM runs WHERE id = '${runId}'`)[0] ?? null;
  out.budget = (() => { const r = q(`SELECT execution_budget_json AS b FROM runs WHERE id = '${runId}'`)[0]; try { return JSON.parse(r?.b ?? 'null'); } catch { return r?.b ?? null; } })();
  out.tasks = q('SELECT kind, state FROM tasks ORDER BY rowid');
  out.agentExecutions = q('SELECT agent_id, status, model_key, provider_id, provider_model_id FROM agent_executions ORDER BY rowid');
  out.providerInvoked = q("SELECT COUNT(*) AS n FROM events WHERE type = 'provider.invoked'")[0]?.n ?? 0;
  out.eventTypes = [...new Set(q('SELECT type FROM events ORDER BY rowid').map((r) => r.type))];
  out.planItems = q("SELECT inputs_json FROM tasks WHERE kind != 'companyos:planning' ORDER BY rowid").map((r) => String(r.inputs_json).slice(0, 400));
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  for (const r of q("SELECT payload FROM events WHERE type = 'provider.invoked'")) {
    try { const p = JSON.parse(r.payload); usage.calls += 1; usage.inputTokens += p.usage?.inputTokens ?? p.inputTokens ?? 0; usage.outputTokens += p.usage?.outputTokens ?? p.outputTokens ?? 0; } catch { /* ignore */ }
  }
  out.usageFromEvents = usage;
  // H15d-fix2: provider.invoked events cover only CompanyOS-side agent calls, not the
  // kernel's brokered calls; the durable Goal budget envelope is the authoritative count.
  const reservations = Array.isArray(out.budget?.reservations) ? out.budget.reservations : [];
  out.spend = {
    calls: reservations.length,
    known: reservations.filter((r) => r.status === 'KNOWN').length,
    unknown: reservations.filter((r) => r.status !== 'KNOWN').length,
    micros: reservations.reduce((m, r) => m + (r.status === 'KNOWN' ? (r.usage?.costMicros ?? 0) : (r.bound?.costMicros ?? 0)), 0),
  };
  const rows = (sql) => { try { return q(sql).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 400) : v]))); } catch (e) { return { error: String(e?.message ?? e) }; } };
  out.artifacts = rows('SELECT * FROM artifacts ORDER BY rowid');
  out.validations = rows('SELECT validation_id, task_id, validator_id, status, blocking, evidence_refs_json FROM validations ORDER BY rowid');
  out.handoffs = rows('SELECT handoff_id, version, task_id, from_role_id, to_role_id, status, summary FROM handoffs ORDER BY rowid');
  out.handoffRefs = rows('SELECT * FROM handoff_refs ORDER BY rowid');
  const casFiles = [];
  const walkCas = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walkCas(p); else casFiles.push({ path: p.slice(`${dataDir}-cas`.length + 1), bytes: statSync(p).size }); } };
  try { walkCas(`${dataDir}-cas`); } catch { /* none */ }
  out.casFiles = casFiles;
  const read = (name) => { const p = join(ws, name); return existsSync(p) ? readFileSync(p, 'utf8').slice(0, 2000) : null; };
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  if (SCENARIO === 'acceptance') {
    out.workspaceFiles = Object.fromEntries(['src/inventory.js', 'test/reorder.test.js', 'docs/CHANGES.md', 'package.json'].map((f) => [f, read(f)]));
    // Independent of every model claim: the harness runs the project's own test contract and
    // exercises reorderPlan against the DOMAIN.md example itself.
    const npmTest = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['-c', 'npm test'], { cwd: ws, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, COMPANYOS_MODEL_API_KEY: undefined } });
    out.npmTest = { status: npmTest.status, tail: `${npmTest.stdout ?? ''}${npmTest.stderr ?? ''}`.slice(-3000) };
    const probe = spawnSync(process.execPath, ['-e', `const m=require(${JSON.stringify(join(ws, 'src', 'inventory.js'))});const items=[{sku:'C-300',qty:2,reorderPoint:10,targetStock:40,minOrder:10,packSize:6},{sku:'A-100',qty:4,reorderPoint:5,targetStock:12,minOrder:10,packSize:5},{sku:'B-200',qty:20,reorderPoint:20,targetStock:100,minOrder:50,packSize:12},{sku:'D-400',qty:0,reorderPoint:3,targetStock:9,minOrder:1,packSize:1,discontinued:true}];const before=JSON.stringify(items);const plan=m.reorderPlan(items);const inv=new m.Inventory([{sku:'X',qty:3,price:2.5},{sku:'Y',qty:2,price:1.25}]);let threw=false;try{inv.removeItem('X',4)}catch(e){threw=e instanceof RangeError}process.stdout.write(JSON.stringify({plan,pure:before===JSON.stringify(items),empty:m.reorderPlan([]),total:inv.totalValue(),threw,left:inv.get('X').qty}))`], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COMPANYOS_MODEL_API_KEY: undefined } });
    try { out.probe = JSON.parse(probe.stdout); } catch { out.probe = { error: `${probe.stdout ?? ''}${probe.stderr ?? ''}`.slice(-1500) }; }
    const p = out.probe;
    out.featureChecks = {
      npmTestPasses: npmTest.status === 0,
      reorderPlanExample: JSON.stringify(p?.plan) === JSON.stringify([{ sku: 'A-100', orderQty: 10 }, { sku: 'C-300', orderQty: 42 }]),
      reorderPlanPure: p?.pure === true && Array.isArray(p?.empty) && p.empty.length === 0,
      removeItemRule: p?.threw === true && p?.left === 3,
      totalValueRule: p?.total === 10,
      reorderTests: (out.workspaceFiles['test/reorder.test.js'] ?? '').length > 0,
      changesDoc: (out.workspaceFiles['docs/CHANGES.md'] ?? '').trim().length > 0,
      noNewDependencies: !/"(?:dev)?[dD]ependencies"/u.test(out.workspaceFiles['package.json'] ?? ''),
    };
  } else {
    out.workspaceFiles = { 'hello.txt': read('hello.txt'), 'summary.md': read('summary.md') };
  }
  out.checks = {
    driverCompleted: out.driver?.terminal === true && /COMPLET|SUCCE|DONE/u.test(String(out.driver?.terminalReason ?? '')) || String(out.goalRun?.state ?? '').toUpperCase() === 'COMPLETED',
    ...(SCENARIO === 'acceptance' ? out.featureChecks : {
      helloFile: (out.workspaceFiles['hello.txt'] ?? '').includes('Hello CompanyOS'),
      summaryFile: (out.workspaceFiles['summary.md'] ?? '').trim().length > 0,
    }),
    artifacts: n(out.artifacts) > 0,
    cas: casFiles.length > 0,
    validationPass: Array.isArray(out.validations) && out.validations.some((v) => v.status === 'pass'),
    handoff: n(out.handoffs) > 0,
    withinCap: out.spend.calls <= deployment.cap.maxCalls && out.spend.micros <= deployment.cap.maxCostMicros,
  };
  out.result = Object.values(out.checks).every(Boolean) ? 'EXECUTED_ARTIFACT_CAS_VALIDATION_HANDOFF' : 'INCOMPLETE';
  out.spendCny = Number((out.spend.micros / 1e6).toFixed(6));
  finish(out.result === 'EXECUTED_ARTIFACT_CAS_VALIDATION_HANDOFF' ? 0 : 20);
} catch (e) {
  out.result = 'HARNESS_ERROR';
  out.error = String(e?.stack ?? e).slice(0, 2000);
  finish(11);
}

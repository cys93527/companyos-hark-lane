#!/usr/bin/env node
// Hark lane H10: ONE tiny live Goal through the INSTALLED app's production composition,
// gated by the operator-attested trusted budget (userData-style budget dir), planning only.
// Runs on the app's bundled runtime: CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) this.mjs
//   <resources/app dir> <evidenceDir> <budgetDir>
// Work items route to dsh-headless; the DSH runtime is NOT packaged/approved, so work
// dispatch must fail closed (typed) — that is an expected, recorded outcome, not a pass.
// The API key is resolved in-process from env and never printed or written.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appDir, evidence, budgetDir] = process.argv.slice(2);
mkdirSync(evidence, { recursive: true });
const imp = (rel) => import(pathToFileURL(join(appDir, rel)).href);
const COMPANY = 'company_default';
const MODEL_KEY = 'h10.live';
const WATCHDOG_MS = Number(process.env.H10_WATCHDOG_MS ?? 240_000);
const out = { startedAt: new Date().toISOString(), runtime: { node: process.versions.node, electron: process.versions.electron ?? null } };
let db = null;
let dataDir = null;
const finish = (code) => {
  out.finishedAt = new Date().toISOString();
  try { db?.close(); } catch { /* ignore */ }
  if (dataDir !== null) for (const s of ['', '-wal', '-shm']) {
    const f = join(dataDir, `companyos.sqlite${s}`);
    if (existsSync(f)) copyFileSync(f, join(evidence, `companyos.sqlite${s}`));
  }
  writeFileSync(join(evidence, 'live-goal.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(code);
};
process.on('uncaughtException', (e) => { out.result = 'HARNESS_CRASH'; out.error = String(e?.stack ?? e).slice(0, 2000); finish(10); });

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

  dataDir = mkdtempSync(join(tmpdir(), 'h10-db-'));
  db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] });
  const foundation = await openArtifactFoundation({ casRoot: `${dataDir}-cas`, database: db, logger: nullLogger });
  if (!foundation.ok) { out.result = 'CAS_FAILED'; finish(5); }
  const core = await composeCoreServices(db, nullLogger, {
    artifactFoundation: foundation,
    ...productionCompositionOptions(process.env, { trustedBudgetProofs: deployment.source, budgetCap: deployment.cap }),
  });
  if (core === null) { out.result = 'COMPOSITION_FAILED'; finish(6); }

  const ws = mkdtempSync(join(tmpdir(), 'h10-ws-'));
  writeFileSync(join(ws, 'README.md'), '# hello-companyos\n\nA tiny workspace for the H10 live planning smoke.\n');
  const opened = await core.repositoryRuntime.openWorkspace({ root: ws, commandProfile: {} });
  if (!opened.ok) { out.result = 'WORKSPACE_OPEN_FAILED'; out.error = opened.error.message; finish(7); }

  const reg = await core.models.registerFromProvider({ providerId: cfg.value.providerId, providerModelId: cfg.value.modelId, modelKey: MODEL_KEY, actorId: 'user_owner' });
  if (!reg.ok) { out.result = 'MODEL_REGISTER_FAILED'; out.error = reg.error.message; finish(8); }
  const pol = await core.policies.savePolicy({ id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: 'user_owner' });
  if (!pol.ok) { out.result = 'MODEL_POLICY_FAILED'; out.error = pol.error.message; finish(8); }

  const created = await core.controlPlane.handle({ operation: 'goal.create', payload: {
    companyId: COMPANY,
    objective: '在工作区新建 hello.txt，内容为一行 "Hello CompanyOS"。这是一个极小任务，计划只需一个步骤。',
    commandId: `h10-${String(Date.now())}`,
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
    try { const p = JSON.parse(r.payload); usage.calls += 1; usage.inputTokens += p.usage?.inputTokens ?? 0; usage.outputTokens += p.usage?.outputTokens ?? 0; } catch { /* ignore */ }
  }
  out.usageFromEvents = usage;
  const planned = out.tasks.some((t) => t.kind !== 'companyos:planning');
  out.result = planned ? 'PLANNED' : 'NOT_PLANNED';
  finish(0);
} catch (e) {
  out.result = 'HARNESS_ERROR';
  out.error = String(e?.stack ?? e).slice(0, 2000);
  finish(11);
}

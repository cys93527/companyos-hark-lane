#!/usr/bin/env node
// Hark lane H12: CROSS-PROCESS restart proof on the INSTALLED app's production composition.
// No real Provider, no network, ¥0: the model provider is an in-process COUNTING FAKE.
// Run on the app's bundled runtime, once per phase, each a separate OS process:
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) restart-unknown.mjs <phase> <resources/app> <evidenceDir> <budgetDir> <dataDir>
// (p1 never exits by itself: after its checks it writes p1-ready.json and blocks until the
//  workflow kills the OS process with Stop-Process -Force — H12c hard kill.)
// phase p1: compose, create a Goal (budget initialized), start the planning turn; the fake
//           provider never answers, so ONE admitted reservation is RESERVED. Exit WITHOUT
//           settling and WITHOUT closing the database (a hard stop mid-call).
// phase p2: reopen the same dataDir. Composition recovery must turn the RESERVED call into
//           UNKNOWN (charged at its bound). goal.advance + autonomy driver must make 0 provider
//           calls and be refused GOAL_USAGE_UNKNOWN; run.budget shows unknown.calls=1. Then the
//           Goal is cancelled.
// phase p3: reopen again. The cancelled terminal must survive recovery + advance unchanged;
//           still 0 provider calls; UNKNOWN still counted.
// Every phase writes <evidence>/<phase>.json and exits 0 only when all its checks pass.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [phase, appDir, evidence, budgetDir, dataDir] = process.argv.slice(2);
if (!['p1', 'p2', 'p3', 'p4'].includes(phase ?? '') || !appDir || !evidence || !budgetDir || !dataDir) { console.error('usage: <p1|p2|p3|p4> <appDir> <evidence> <budgetDir> <dataDir>'); process.exit(64); }
mkdirSync(evidence, { recursive: true });
mkdirSync(dataDir, { recursive: true });
const imp = (rel) => import(pathToFileURL(join(appDir, rel)).href);
const COMPANY = 'company_default';
const PROVIDER_ID = 'h12.counting-fake';
const MODEL_ID = 'fake-1';
const MODEL_KEY = 'h12.fake';
const STATE = join(evidence, 'h12-state.json');
const CALL_LOG = join(evidence, 'provider-calls.log');
const out = { phase, pid: process.pid, startedAt: new Date().toISOString(), runtime: { node: process.versions.node, electron: process.versions.electron ?? null }, checks: [] };
let db = null;
let calls = 0;
const check = (id, pass, detail) => { out.checks.push({ id, pass: Boolean(pass), detail }); };
const write = () => writeFileSync(join(evidence, `${phase}.json`), JSON.stringify(out, null, 2));
const finish = (code, { close = true } = {}) => {
  out.finishedAt = new Date().toISOString();
  out.providerCallsThisProcess = calls;
  out.failed = out.checks.filter((c) => !c.pass).map((c) => c.id);
  out.result = code === 0 && out.failed.length === 0 ? 'PASS' : (out.result ?? 'FAIL');
  try { write(); } catch { /* stdout still has it */ }
  if (close) {
    try { db?.close(); } catch (e) { out.closeError = String(e?.message ?? e); }
    if (phase === 'p4') for (const s of ['', '-wal', '-shm']) { const f = join(dataDir, `companyos.sqlite${s}`); try { if (existsSync(f)) copyFileSync(f, join(evidence, `companyos.sqlite${s}`)); } catch { /* best effort */ } }
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : (code === 0 ? 1 : code));
};
const awaitHardKill = () => {
  out.finishedAt = new Date().toISOString();
  out.providerCallsThisProcess = calls;
  out.failed = out.checks.filter((c) => !c.pass).map((c) => c.id);
  out.result = out.failed.length === 0 ? 'PASS' : 'FAIL';
  out.stop = 'awaiting external hard kill (Stop-Process -Force)';
  write();
  console.log(JSON.stringify(out, null, 2));
  if (out.result !== 'PASS') process.exit(1); // nothing to kill: fail the phase directly
  writeFileSync(join(evidence, 'p1-ready.json'), JSON.stringify({ pid: process.pid, result: out.result, at: out.finishedAt }));
  setInterval(() => {}, 1 << 30); // keep the event loop alive until the OS kills us
  return new Promise(() => {});
};
process.on('uncaughtException', (e) => { out.result = 'HARNESS_CRASH'; out.error = String(e?.stack ?? e).slice(0, 2000); finish(10); });
process.on('unhandledRejection', (e) => { out.result = 'HARNESS_CRASH'; out.error = String(e?.stack ?? e).slice(0, 2000); finish(13); });

const reasonOf = (error) => error?.details?.reason ?? error?.code ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { nullLogger } = await imp('node_modules/@companyos/observability/dist/index.js');
  const { ok } = await imp('node_modules/@companyos/core/dist/index.js');
  const { openDurableDatabase } = await imp('node_modules/@companyos/persistence/dist/index.js');
  const { openArtifactFoundation } = await imp('apps/desktop/dist/artifact-stack.js');
  const { composeCoreServices } = await imp('apps/desktop/dist/core-services.js');
  const { productionCompositionOptions } = await imp('apps/desktop/dist/production-composition.js');
  const { createDeploymentBudgetProofSource } = await imp('apps/desktop/dist/deployment-budget-proof.js');

  // The counting fake. Every invoke is counted in-process AND appended to a durable log
  // (so a later phase can prove no call happened anywhere after p1). It never answers:
  // p1's call stays in flight until the process is stopped.
  const fakeProvider = {
    describe: () => ({ providerId: PROVIDER_ID, kind: 'fake', displayName: 'H12 counting fake (no network)', version: '1' }),
    listModels: () => Promise.resolve(ok([{ modelId: MODEL_ID, displayName: MODEL_ID, contextWindow: 32768, capabilities: { streaming: false, structuredOutput: true } }])),
    health: () => Promise.resolve(ok(undefined)),
    invoke(request) {
      calls += 1;
      appendFileSync(CALL_LOG, `${JSON.stringify({ phase, pid: process.pid, at: new Date().toISOString(), modelId: request.modelId, maxOutputTokens: request.maxOutputTokens ?? null })}\n`);
      return new Promise(() => { /* never settles: the admitted call is left in flight */ });
    },
    stream() { return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }; },
  };

  const deployment = createDeploymentBudgetProofSource(budgetDir);
  if (deployment === undefined) { out.result = 'NO_BUDGET_APPROVAL'; finish(4); }
  out.budgetCap = deployment.cap;

  db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] });
  const q = (sql, ...a) => db.db.prepare(sql).all(...a);
  // Core run-state: CANCEL -> FAILED (reason cancelled; no separate CANCELLED run state).
  // H12b: the cancel terminal is TYPED — failure_reason 'cancelled' (storage-enforced, migration 0009).
  const runTerm = (runId) => { const r = q('SELECT state, failure_reason AS fr, history_json AS h FROM runs WHERE id = ?', runId)[0]; const h = JSON.parse(r?.h ?? '[]'); return { runState: r?.state ?? null, failureReason: r?.fr ?? null, lastEvent: h.at(-1)?.event ?? null, history: r?.h ?? null }; };
  // H12b: the boss-facing typed outcome, read through the (fenced) control plane.
  const outcomeOf = async (runId) => { const w = await core.controlPlane.handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId } }); return w.ok ? w.value.overview?.terminalOutcome ?? null : `ERROR:${w.error.code}`; };
  const budgetRow = (runId) => { const r = q('SELECT execution_budget_json AS b FROM runs WHERE id = ?', runId)[0]; return r?.b == null ? null : JSON.parse(r.b); };

  // Snapshot BEFORE composition (composition runs recovery) — proves what recovery changed.
  const prior = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
  if (phase !== 'p1') {
    if (prior === null) { out.result = 'NO_PRIOR_STATE'; finish(5); }
    out.beforeRecovery = { budget: budgetRow(prior.runId), runState: q('SELECT state FROM runs WHERE id = ?', prior.runId)[0]?.state ?? null,
      goalB: prior.goalB ? runTerm(prior.goalB.runId) : null };
  }

  const foundation = await openArtifactFoundation({ casRoot: `${dataDir}-cas`, database: db, logger: nullLogger });
  if (!foundation.ok) { out.result = 'CAS_FAILED'; finish(6); }
  const core = await composeCoreServices(db, nullLogger, {
    artifactFoundation: foundation,
    ...productionCompositionOptions(process.env, { trustedBudgetProofs: deployment.source, budgetCap: deployment.cap }),
    // H12c: the same operator directory the product passes (userData/budget). p1-p3 have no
    // reconciliations.json (ABSENT, no effect); before p4 the operator tool writes one.
    usageReconciliationDir: budgetDir,
  });
  if (core === null) { out.result = 'COMPOSITION_FAILED'; finish(7); }

  const ws = join(dataDir, 'workspace');
  mkdirSync(ws, { recursive: true });
  if (!existsSync(join(ws, 'README.md'))) writeFileSync(join(ws, 'README.md'), '# h12\n\nRestart proof workspace.\n');
  const opened = await core.repositoryRuntime.openWorkspace({ root: ws, commandProfile: {} });
  if (!opened.ok) { out.result = 'WORKSPACE_OPEN_FAILED'; out.error = opened.error.message; finish(8); }
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0].actorId;
  const reg = await core.providers.register(fakeProvider, { actorId: actor });
  out.providerRegister = reg.ok ? 'ok' : reg.error.code;
  if (phase === 'p1') {
    const m = await core.models.registerFromProvider({ providerId: PROVIDER_ID, providerModelId: MODEL_ID, modelKey: MODEL_KEY, actorId: actor });
    if (!m.ok) { out.result = 'MODEL_REGISTER_FAILED'; out.error = m.error.message; finish(8); }
    const pol = await core.policies.savePolicy({ id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor });
    if (!pol.ok) { out.result = 'MODEL_POLICY_FAILED'; out.error = pol.error.message; finish(8); }
  }
  const budgetView = async (runId) => {
    const r = await core.controlPlane.handle({ operation: 'run.budget', payload: { companyId: COMPANY, runId } });
    return r.ok ? r.value.budget : { error: r.error };
  };

  if (phase === 'p1') {
    const created = await core.controlPlane.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '整理一份三项的办公室物资清单。', commandId: `h12-${String(Date.now())}` } });
    if (!created.ok) { out.result = 'GOAL_CREATE_FAILED'; out.error = JSON.stringify(created.error).slice(0, 1000); finish(9); }
    const runId = String(created.value.runId);
    out.goalRunId = runId;
    const initial = budgetRow(runId);
    check('P1-budget-initialized', initial !== null && initial.reservations.length === 0 && initial.cancellation === null, initial?.policy ?? null);
    // Goal B: cancelled BEFORE any work, so its Run reaches the CANCELLED terminal in p1.
    const createdB = await core.controlPlane.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: 'H12 取消对照目标：创建后立即取消。', commandId: `h12-b-${String(Date.now())}` } });
    if (!createdB.ok) { out.result = 'GOAL_B_CREATE_FAILED'; out.error = JSON.stringify(createdB.error).slice(0, 1000); finish(9); }
    const runB = String(createdB.value.runId);
    const cancelB = await core.controlPlane.handle({ operation: 'goal.cancel', payload: { companyId: COMPANY, runId: runB } });
    await sleep(1500); // engine.cancel terminal settlement is fire-and-forget in the composition
    const goalB = { runId: runB, ...runTerm(runB), cancellation: budgetRow(runB)?.cancellation ?? null };
    out.goalB = { ...goalB, cancel: cancelB.ok ? cancelB.value : { error: cancelB.error } };
    check('P1-goalB-cancelled-terminal', cancelB.ok && goalB.runState === 'FAILED' && goalB.lastEvent === 'CANCEL' && goalB.cancellation !== null, out.goalB);
    out.goalB.terminalOutcome = await outcomeOf(runB);
    check('P1-goalB-typed-CANCELLED', goalB.failureReason === 'cancelled' && out.goalB.terminalOutcome === 'CANCELLED', { failureReason: goalB.failureReason, terminalOutcome: out.goalB.terminalOutcome });
    // Start the driver and do NOT await it: the planning turn's call never returns.
    let driverSettled = null;
    core.autonomyDriver.run({ companyId: COMPANY, runId }).then((r) => { driverSettled = r.ok ? { terminal: r.value.terminal, terminalReason: r.value.terminalReason } : { error: reasonOf(r.error) }; }, (e) => { driverSettled = { threw: String(e?.message ?? e) }; });
    const deadline = Date.now() + 60_000;
    let state = null;
    while (Date.now() < deadline) {
      state = budgetRow(runId);
      if (calls >= 1 && state?.reservations?.some((r) => r.status === 'RESERVED')) break;
      if (driverSettled !== null) break;
      await sleep(100);
    }
    out.driverSettledBeforeExit = driverSettled;
    out.budgetAtExit = state;
    out.budgetViewAtExit = await budgetView(runId);
    check('P1-one-provider-call-in-flight', calls === 1, { calls });
    check('P1-one-reservation-RESERVED', state?.reservations?.length === 1 && state.reservations[0].status === 'RESERVED' && state.reservations[0].usage === null, state?.reservations ?? null);
    check('P1-driver-still-blocked-in-call', driverSettled === null, driverSettled);
    check('P1-run.budget-held-1', out.budgetViewAtExit?.held?.calls === 1 && out.budgetViewAtExit?.unknown?.calls === 0, out.budgetViewAtExit);
    writeFileSync(STATE, JSON.stringify({ runId, reservation: state?.reservations?.[0] ?? null, goalB }, null, 2));
    // H12c hard kill: p1 does NOT exit by itself. It records its checks, publishes a
    // ready marker and then blocks with the call still in flight; the workflow terminates
    // the OS process from outside (Stop-Process -Force = TerminateProcess). No settle, no
    // db.close(), no exit handlers, no graceful shutdown of any kind.
    await awaitHardKill(); // never resolves
  }

  if (phase === 'p4') {
    // H12c: the operator attested the UNKNOWN call with evidence (make-usage-reconciliation.mjs
    // ran between p3 and p4). Composition start applied it: UNKNOWN -> KNOWN with the attested
    // usage, nothing replayed, the cancelled terminal untouched.
    const runId = prior.runId;
    out.goalRunId = runId;
    const entry = JSON.parse(readFileSync(join(evidence, 'reconciliation-entry.json'), 'utf8'));
    out.entry = entry;
    const lines = existsSync(CALL_LOG) ? readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const before = out.beforeRecovery.budget?.reservations?.[0];
    const nowBudget = budgetRow(runId);
    const r = nowBudget?.reservations?.[0];
    out.afterReconciliation = nowBudget;
    check('P4-before-start-UNKNOWN', before?.status === 'UNKNOWN' && before?.usage === null, before);
    check('P4-reservation-KNOWN-from-attestation', nowBudget?.reservations?.length === 1 && r?.callId === entry.callId && r?.status === 'KNOWN'
      && r?.usage?.tokens === entry.tokens && r?.usage?.costMicros === entry.costMicros
      && r?.reconciliation?.reconciliationId === entry.reconciliationId && r?.reconciliation?.evidenceRef === entry.evidence && r?.reconciliation?.attestedBy === entry.attestedBy, r);
    check('P4-bound-unchanged', JSON.stringify(r?.bound) === JSON.stringify(prior.reservation?.bound), r?.bound);
    const view = await budgetView(runId);
    out.budgetView = view;
    check('P4-run.budget-unknown-0-reconciled-1', view?.unknown?.calls === 0 && view?.reconciled?.calls === 1 && view?.reconciled?.costMicros === entry.costMicros
      && view?.settled?.calls === 1 && view?.settled?.costMicros === entry.costMicros && view?.state === 'CANCELLED', view);
    const adv = await core.controlPlane.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId } });
    out.advance = adv.ok ? { ok: true } : { ok: false, code: adv.error.code, reason: reasonOf(adv.error) };
    await sleep(500);
    check('P4-advance-still-refused-CANCELLED', !adv.ok && JSON.stringify(out.advance).includes('CANCELLED'), out.advance);
    check('P4-cancellation-and-terminal-intact', JSON.stringify(budgetRow(runId)?.cancellation) === JSON.stringify(prior.cancellation) && runTerm(runId).history === prior.runHistoryAfterCancel, { cancellation: budgetRow(runId)?.cancellation, runState: runTerm(runId).runState });
    check('P4-provider-calls-0', calls === 0 && lines.length === 1 && lines.every((l) => l.phase === 'p1'), { thisProcess: calls, log: lines });
    finish(0);
  }

  const runId = prior.runId;
  out.goalRunId = runId;
  const logLines = () => (existsSync(CALL_LOG) ? readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const after = budgetRow(runId);
  out.afterRecovery = after;
  const r0 = after?.reservations?.[0];
  check(`${phase.toUpperCase()}-reservation-still-single`, after?.reservations?.length === 1 && r0?.callId === prior.reservation?.callId, after?.reservations?.map((r) => r.callId));
  check(`${phase.toUpperCase()}-reservation-UNKNOWN-at-bound`, r0?.status === 'UNKNOWN' && r0?.usage === null && JSON.stringify(r0?.bound) === JSON.stringify(prior.reservation?.bound), r0);

  const runStateBefore = q('SELECT state FROM runs WHERE id = ?', runId)[0]?.state ?? null;
  // The resume path the product uses: goal.advance, then the autonomy driver.
  const adv = await core.controlPlane.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId } });
  out.advance = adv.ok ? { ok: true, value: JSON.stringify(adv.value).slice(0, 800) } : { ok: false, code: adv.error.code, reason: reasonOf(adv.error), details: JSON.stringify(adv.error.details ?? null).slice(0, 800) };
  const drv = await Promise.race([core.autonomyDriver.run({ companyId: COMPANY, runId }), sleep(90_000).then(() => 'WATCHDOG')]);
  out.driver = drv === 'WATCHDOG' ? 'WATCHDOG' : drv.ok
    ? { terminal: drv.value.terminal, terminalReason: drv.value.terminalReason, steps: drv.value.stepsExecuted, attempts: drv.value.attempts }
    : { error: { code: drv.error.code, reason: reasonOf(drv.error) } };
  await sleep(500);
  const afterResume = budgetRow(runId);
  out.afterResume = afterResume;
  const view = await budgetView(runId);
  out.budgetView = view;
  // p3: Goal A is cancelled, so the control plane refuses it first with the typed CANCELLED code.
  const expectReason = phase === 'p2' ? 'GOAL_USAGE_UNKNOWN' : 'CANCELLED';
  const refusals = JSON.stringify([out.advance, out.driver]);
  check(`${phase.toUpperCase()}-provider-calls-0`, calls === 0 && logLines().every((l) => l.phase === 'p1') && logLines().length === 1, { thisProcess: calls, log: logLines() });
  check(`${phase.toUpperCase()}-no-new-reservation`, afterResume?.reservations?.length === 1 && afterResume.reservations[0].status === 'UNKNOWN', afterResume?.reservations);
  check(`${phase.toUpperCase()}-admission-refused-${expectReason}`, refusals.includes(expectReason), { advance: out.advance, driver: out.driver });
  check(`${phase.toUpperCase()}-run.budget-unknown.calls=1`, view?.unknown?.calls === 1 && view?.unknown?.costMicros === r0?.bound?.costMicros && view?.held?.calls === 0, view);

  // Goal B (CANCELLED in p1) must stay CANCELLED through recovery + the resume path.
  {
    const b = prior.goalB;
    const before = out.beforeRecovery.goalB;
    const advB = await core.controlPlane.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: b.runId } });
    const drvB = await Promise.race([core.autonomyDriver.run({ companyId: COMPANY, runId: b.runId }), sleep(60_000).then(() => 'WATCHDOG')]);
    await sleep(500);
    const nowB = { ...runTerm(b.runId), cancellation: budgetRow(b.runId)?.cancellation ?? null };
    out.goalB = { p1: b, beforeResume: before, now: nowB,
      advance: advB.ok ? { ok: true } : { ok: false, code: advB.error.code, reason: reasonOf(advB.error) },
      driver: drvB === 'WATCHDOG' ? 'WATCHDOG' : drvB.ok ? { terminal: drvB.value.terminal, terminalReason: drvB.value.terminalReason } : { error: reasonOf(drvB.error) } };
    check(`${phase.toUpperCase()}-goalB-cancelled-terminal-not-overwritten`, b.runState === 'FAILED' && b.lastEvent === 'CANCEL' && before?.history === b.history && nowB.history === b.history && nowB.runState === 'FAILED' && JSON.stringify(nowB.cancellation) === JSON.stringify(b.cancellation), out.goalB);
    check(`${phase.toUpperCase()}-goalB-advance-refused`, !advB.ok, out.goalB.advance);
    out.goalB.terminalOutcome = await outcomeOf(b.runId);
    check(`${phase.toUpperCase()}-goalB-typed-CANCELLED-after-restart`, nowB.failureReason === 'cancelled' && out.goalB.terminalOutcome === 'CANCELLED', { failureReason: nowB.failureReason, terminalOutcome: out.goalB.terminalOutcome });
    check(`${phase.toUpperCase()}-goalB-provider-calls-0`, calls === 0, { calls });
  }

  if (phase === 'p2') {
    const cancel = await core.controlPlane.handle({ operation: 'goal.cancel', payload: { companyId: COMPANY, runId } });
    out.cancel = cancel.ok ? cancel.value : { error: cancel.error };
    await sleep(1500); // engine.cancel terminal settlement is fire-and-forget in the composition
    const c = budgetRow(runId);
    out.afterCancel = { budget: c, runState: q('SELECT state FROM runs WHERE id = ?', runId)[0]?.state ?? null, view: await budgetView(runId) };
    check('P2-cancel-accepted', cancel.ok && c?.cancellation !== null, out.cancel);
    check('P2-cancel-keeps-UNKNOWN-charge', c?.reservations?.length === 1 && c.reservations[0].status === 'UNKNOWN', c?.reservations);
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    writeFileSync(STATE, JSON.stringify({ ...s, cancellation: c?.cancellation ?? null, runStateAfterCancel: out.afterCancel.runState, runHistoryAfterCancel: runTerm(runId).history }, null, 2));
  } else {
    const runStateAfter = q('SELECT state FROM runs WHERE id = ?', runId)[0]?.state ?? null;
    out.runState = { beforeRecovery: out.beforeRecovery.runState, beforeResume: runStateBefore, after: runStateAfter, afterCancelInP2: prior.runStateAfterCancel };
    check('P3-cancellation-intact', JSON.stringify(afterResume?.cancellation) === JSON.stringify(prior.cancellation) && prior.cancellation !== null, { now: afterResume?.cancellation, p2: prior.cancellation });
    check('P3-run-terminal-not-overwritten', runStateAfter === prior.runStateAfterCancel && out.beforeRecovery.runState === prior.runStateAfterCancel && runTerm(runId).history === prior.runHistoryAfterCancel, out.runState);
    check('P3-run.budget-state-CANCELLED', view?.state === 'CANCELLED', view?.state);
  }
  finish(0);
} catch (e) {
  out.result = 'HARNESS_ERROR';
  out.error = String(e?.stack ?? e).slice(0, 2000);
  finish(11);
}

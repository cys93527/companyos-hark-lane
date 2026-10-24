/**
 * COMPANYOS — LIVE CANONICAL HEADLESS E2E (the named gate; run EXPLICITLY):
 *
 *   COS_EXECUTION_ATTEMPT_TIMEOUT_MS=1800000 npx vitest run e2e/live-e2e.test.ts
 *
 * This is the ONE bounded real-provider run of the closure: the SAME production
 * composition the Desktop uses (productionCompositionOptions + the embedded DSH
 * runtime) with the machine's live model endpoint, driving ONE real Goal through the
 * canonical Stage-9 autonomy driver to its durable terminal, then proving the
 * canonical truth from durable rows + an INDEPENDENT oracle in the workspace.
 *
 * Excluded from the default suite (vitest.config.ts `exclude`): it spends real
 * wall-clock and real provider spend — it runs as its own named gate, once.
 *
 * Model provenance (reported honestly, never guessed): the requested Planner/
 * Supervisor model LABEL is the configured COS_MODEL_ID and the Provider-reported
 * resolved model is UNKNOWN unless the provider authoritatively records one.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { nullLogger } from '@companyos/observability';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { openArtifactFoundation } from '../apps/desktop/src/artifact-stack.js';
import { composeCoreServices } from '../apps/desktop/src/core-services.js';
import { resolveOpenAiCompatibleConfig } from '../apps/desktop/src/models/openai-compatible-provider.js';
import { productionCompositionOptions } from '../apps/desktop/src/production-composition.js';

const CHAINS = [
  'core',
  'engine',
  'lifecycle',
  'provider',
  'registry',
  'selection',
  'agent',
  'tools',
  'artifact',
  'pack',
  'memory',
  'session',
  'handoff',
] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'live.e2e';
/** Hard wall-clock bound for the ONE run (the provider can be slow; never unbounded). */
const RUN_BUDGET_MS = 55 * 60_000;

/**
 * 07cc53b re-audit (N07-R1) — RUNTIME SOURCE-TREE FINGERPRINT. A deterministic sha256 over
 * every git-tracked path and its WORKING-TREE content: recorded in the evidence so a later
 * verification can recompute it from the COMMITTED tree and prove the runtime tree and the
 * commit tree are identical (not merely that they share a parent).
 */
const sourceTreeFingerprint = (): string => {
  const hash = createHash('sha256');
  // Tracked AND untracked-but-not-ignored files: the run's candidate source tree is
  // exactly what a subsequent commit of this workspace would contain (an untracked new
  // source file belongs to the runtime tree too, so it must not drop out of the hash).
  const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: process.cwd(), stdio: 'pipe' })
    .toString('utf8')
    .split(String.fromCharCode(10))
    .filter((line) => line.length > 0)
    .sort();
  for (const relative of listing) {
    hash.update(relative);
    hash.update(String.fromCharCode(0));
    const absolute = join(process.cwd(), relative);
    hash.update(existsSync(absolute) ? readFileSync(absolute) : Buffer.from('<missing>'));
    hash.update(String.fromCharCode(0));
  }
  return hash.digest('hex');
};
const createdDirs: string[] = [];
/** The retained evidence dirs (never deleted by this test): one per successful run. */
const retainedEvidenceDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
};
const openDatabases: DurableDatabase[] = [];
afterAll(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  // POST-CODEX R1: the RETENTION rule — a successful run's evidence directories are
  // copied before cleanup and the copies are NEVER deleted here. Only the copies are
  // whitelisted; every other temp dir is removed as before.
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop() as string;
    if (retainedEvidenceDirs.includes(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The real small repository fixture: a multiply defect against a node --test contract. */
const makeWorkspace = (): string => {
  const root = tempDir('live-e2e-ws-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'math.ts'),
    'export function multiply(a: number, b: number): number {\n  return a - b;\n}\n',
  );
  writeFileSync(
    join(root, 'tests', 'math.test.ts'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { multiply } from '../src/math.ts';\ntest('multiply', () => { assert.equal(multiply(4, 3), 12); });\n",
  );
  return root;
};

describe('LIVE E2E — canonical headless Goal → COMPLETED (one bounded real run)', () => {
  it('drives one live Goal to a canonical COMPLETED with durable validators, Handoff READY and zero stale RUNNING', async () => {
    const config = resolveOpenAiCompatibleConfig();
    expect(config.ok, 'the live model endpoint must be configured').toBe(true);
    if (!config.ok) throw new Error(config.error.message);
    if (config.value === null) throw new Error('COS_MODEL_BASE_URL / COS_MODEL_ID are not configured');
    const live = config.value;

    const workspace = makeWorkspace();
    const dataDir = tempDir('live-e2e-db-');
    const casRoot = `${dataDir}-cas`;

    const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(db);
    const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
    if (!foundation.ok) throw new Error('artifact foundation failed');
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      ...productionCompositionOptions(),
    });
    if (core === null) throw new Error('production composition failed');
    const opened = await core.repositoryRuntime.openWorkspace({ root: workspace, commandProfile: {} });
    if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);

    // The production model selection: the env adapter is self-registered; bind its
    // model under the company MANUAL policy (the exact services behind the UI ops).
    const registered = await core.models.registerFromProvider({
      providerId: live.providerId,
      providerModelId: live.modelId,
      modelKey: MODEL_KEY,
      actorId: 'user_owner',
    });
    if (!registered.ok) throw new Error(`model registration failed: ${registered.error.message}`);
    const policy = await core.policies.savePolicy({
      id: `COMPANY:${COMPANY}`,
      scopeType: 'COMPANY',
      scopeId: COMPANY,
      mode: 'MANUAL',
      manualModelKey: MODEL_KEY,
      actorId: 'user_owner',
    } as never);
    if (!policy.ok) throw new Error(`model policy failed: ${policy.error.message}`);

    const created = await core.controlPlane!.handle({
      operation: 'goal.create',
      payload: {
        companyId: COMPANY,
        objective:
          '修复工作区项目的 multiply 实现：multiply(4, 3) 必须返回 12，且项目自带的 node --test 测试契约必须通过。',
        commandId: `live-e2e-${String(Date.now())}`,
      },
    });
    if (!created.ok) throw new Error(`goal.create failed: ${JSON.stringify(created.error)}`);
    const goalRunId = String((created.value as { readonly runId: string }).runId);

    const started = Date.now();
    const driver = core.autonomyDriver;
    if (driver === null) throw new Error('the autonomy driver is not composed');
    const outcome = await Promise.race([
      driver.run({ companyId: COMPANY, runId: goalRunId }),
      new Promise<'WATCHDOG'>((resolve) => setTimeout(() => resolve('WATCHDOG'), RUN_BUDGET_MS).unref?.()),
    ]);
    const elapsedMs = Date.now() - started;

    const rows = <T>(sql: string): readonly T[] => db.db.prepare(sql).all() as readonly T[];
    const one = <T>(sql: string): T | undefined => db.db.prepare(sql).get() as T | undefined;
    const goalRunRow = one<{ state: string; revision: number }>(`SELECT state, revision FROM runs WHERE id = '${goalRunId}'`);
    const executionRunRow = one<{ id: string; state: string }>(
      `SELECT id, state FROM runs WHERE id != '${goalRunId}' AND company_id = '${COMPANY}' ORDER BY created_at DESC LIMIT 1`,
    );
    const events = rows<{ type: string }>(`SELECT type FROM events ORDER BY rowid`);
    const eventTypes = events.map((row) => row.type);
    const validations = rows<{ status: string; validator_id: string }>(`SELECT status, validator_id FROM validations`);
    const handoffs = rows<{ status: string }>(`SELECT status FROM handoffs`);
    const staleExecutions = one<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_executions WHERE status = 'RUNNING'`);
    const staleAttempts = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM execution_attempts WHERE state NOT IN ('COMPLETED','FAILED','INTERRUPTED')`,
    );
    const supervisorRows = rows<{ started_at: string | null; finished_at: string | null; updated_at: string }>(
      `SELECT started_at, finished_at, updated_at FROM agent_executions WHERE agent_id = 'supervisor-runtime'`,
    );
    const decisionDuplicates = one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM (SELECT subject_key FROM decisions GROUP BY subject_key HAVING COUNT(*) > 1)',
    );
    /*
     * 4a6e362 (N4-A1) — TERMINAL AUDIT COMPLETENESS: every terminal execution carries its
     * mandatory terminal audit EXACTLY once (the atomic CAS+audit unit's end-to-end claim).
     */
    const terminalExecutionRows = rows<{ execution_id: string; status: string }>(
      `SELECT execution_id, status FROM agent_executions WHERE status IN ('COMPLETED','FAILED','CANCELLED','INTERRUPTED')`,
    );
    const terminalAuditCounts = new Map(
      rows<{ aggregate_id: string; n: number }>(
        `SELECT aggregate_id, COUNT(*) AS n FROM events
          WHERE type IN ('agent.execution_completed','agent.execution_failed','agent.execution_cancelled','agent.execution_interrupted')
          GROUP BY aggregate_id`,
      ).map((row) => [row.aggregate_id, Number(row.n)] as const),
    );
    const missingTerminalAudit = terminalExecutionRows.filter(
      (row) => (terminalAuditCounts.get(row.execution_id) ?? 0) === 0,
    ).length;
    const duplicateTerminalAudit = terminalExecutionRows.filter(
      (row) => (terminalAuditCounts.get(row.execution_id) ?? 0) > 1,
    ).length;
    const decisionCountValue = one<{ n: number }>('SELECT COUNT(*) AS n FROM decisions');
    /*
     * 314caae (N314-T1) — TASK CREATION IDENTITY: two different task rows sharing one
     * creation identity (run + stage + kind + canonical inputs) would be a duplicate task
     * truth; a replay must converge to ONE canonical row, never mint a second.
     */
    const duplicateTaskCreationIdentity = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT run_id, stage_id, kind, inputs_json FROM tasks
          GROUP BY run_id, stage_id, kind, inputs_json HAVING COUNT(*) > 1
       )`,
    );
    const taskCount = one<{ n: number }>('SELECT COUNT(*) AS n FROM tasks');
    const gitHead = (() => {
      try {
        return String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), stdio: 'pipe' })).trim();
      } catch {
        return 'UNKNOWN';
      }
    })();
    const providerModels = rows<{ payload: string }>(
      `SELECT payload FROM events WHERE type = 'provider.invoked' ORDER BY rowid`,
    ).slice(0, 3);

    // The INDEPENDENT oracle: the workspace's own contract, executed fresh.
    let oracle = 'not-run';
    try {
      execFileSync(process.execPath, ['--test', 'tests/math.test.ts'], { cwd: workspace, stdio: 'pipe' });
      oracle = 'PASS';
    } catch {
      oracle = 'FAIL';
    }
    const sourceAfter = readFileSync(join(workspace, 'src', 'math.ts'), 'utf8');

    const maxConcurrentSupervisors = ((): number => {
      const timeline: { at: number; delta: number }[] = [];
      for (const row of supervisorRows) {
        if (row.started_at === null) continue;
        timeline.push({ at: Date.parse(row.started_at), delta: 1 });
        timeline.push({ at: Date.parse(row.finished_at ?? row.updated_at), delta: -1 });
      }
      timeline.sort((left, right) => left.at - right.at || right.delta - left.delta);
      let current = 0;
      let max = 0;
      for (const event of timeline) {
        current += event.delta;
        max = Math.max(max, current);
      }
      return max;
    })();

    const report = {
      goalRunId,
      executionRunId: executionRunRow?.id ?? null,
      elapsedMs,
      driverOutcome: outcome === 'WATCHDOG' ? 'WATCHDOG' : outcome.ok ? 'ok' : String(outcome.error.code),
      goalRunState: goalRunRow?.state ?? 'MISSING',
      executionRunState: executionRunRow?.state ?? 'MISSING',
      completionChain: eventTypes.filter((type) => type.startsWith('run.')),
      validations,
      handoffs,
      staleExecutions: Number(staleExecutions?.n ?? -1),
      staleAttempts: Number(staleAttempts?.n ?? -1),
      maxConcurrentSupervisors,
      decisionCount: Number(decisionCountValue?.n ?? -1),
      decisionDuplicates: Number(decisionDuplicates?.n ?? -1),
      missingTerminalAudit,
      duplicateTerminalAudit,
      duplicateTaskCreationIdentity: Number(duplicateTaskCreationIdentity?.n ?? -1),
      taskCount: Number(taskCount?.n ?? -1),
      gitHead,
      sourceTreeFingerprint: sourceTreeFingerprint(),
      sourceTreeFingerprintMethod:
        'sha256 over sorted (git ls-files --cached --others --exclude-standard) paths + WORKING-TREE bytes; recompute identically after the commit to bind the trees',
      testConfig: {
        vitestConfig: 'vitest.e2e.config.ts',
        runBudgetMs: RUN_BUDGET_MS,
        executionAttemptTimeoutMs: process.env['COS_EXECUTION_ATTEMPT_TIMEOUT_MS'] ?? null,
        requestedModelLabel: live.modelId,
      },
      oracle,
      modelProvenance: {
        requestedModelLabel: live.modelId,
        providerReportedResolvedModel: 'UNKNOWN',
        note: 'COS_MODEL_ID is the requested label; the compatible endpoint does not authoritatively report a resolved model identity.',
      },
      providerInvokedSample: providerModels.map((row) => String(row.payload).slice(0, 200)),
      sourceAfter,
    };
    console.log('LIVE_E2E_REPORT ' + JSON.stringify(report, null, 1));

    expect(outcome).not.toBe('WATCHDOG');
    if (outcome === 'WATCHDOG') throw new Error('the live run exceeded its wall-clock budget');
    expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.error)).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(goalRunRow?.state).toBe('COMPLETED');
    expect(executionRunRow?.state).toBe('COMPLETED');
    expect(eventTypes).toContain('run.completed');
    expect(validations.some((row) => row.status === 'pass')).toBe(true);
    expect(handoffs.some((row) => row.status === 'READY')).toBe(true);
    expect(Number(staleExecutions?.n)).toBe(0);
    expect(Number(staleAttempts?.n)).toBe(0);
    expect(maxConcurrentSupervisors).toBeLessThanOrEqual(1);
    expect(Number(decisionDuplicates?.n)).toBe(0);
    // 4a6e362 (N4-A1): the mandatory terminal audit is present EXACTLY once per terminal row.
    expect(missingTerminalAudit).toBe(0);
    expect(duplicateTerminalAudit).toBe(0);
    // 314caae (N314-T1): every task replay converged to ONE canonical row per creation identity.
    expect(Number(duplicateTaskCreationIdentity?.n)).toBe(0);
    expect(outcome.value.userDecisionCount).toBe(0);
    expect(oracle).toBe('PASS');
    expect(sourceAfter).toContain('a * b');
    /*
     * POST-CODEX R1 — RETAINED AUDIT EVIDENCE: copy the final SQLite database (+ WAL
     * sidecars) into the gitignored managed root so the next READ-ONLY audit can
     * inspect AgentExecution rows, ExecutionAttempt rows, Decision rows, Validation
     * rows, Handoff and the event timeline directly. The copy path is printed;
     * credentials never live in the database (SecretRef pointers only).
     */
    const evidenceDir = join(process.cwd(), '.companyos-embedded', 'e2e-evidence', goalRunId);
    mkdirSync(evidenceDir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${join(dataDir, 'companyos.sqlite')}${suffix}`;
      if (existsSync(source)) copyFileSync(source, join(evidenceDir, `companyos.sqlite${suffix}`));
    }
    writeFileSync(
      join(evidenceDir, 'evidence.json'),
      JSON.stringify({ goalRunId, executionRunId: executionRunRow?.id ?? null, report }, null, 1),
    );
    retainedEvidenceDirs.push(dataDir, casRoot);
    console.log('LIVE_E2E_EVIDENCE ' + evidenceDir);
  }, RUN_BUDGET_MS + 5 * 60_000);
});

import {registerOfflineInline} from '../support/offline-fixtures.js';
registerOfflineInline('process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))');
/**
 * Sprint25 — the SAFETY PREFLIGHT PIPELINE and failure injection (Boss §30-§31/§44-§48).
 *
 * The law under test: the ordered phase — config valid → secret refs resolvable →
 * workspace trusted → cwd allowed → capabilities supported → authorization present —
 * runs BEFORE any provider side effect, is a phase inside the canonical attempt (never
 * a second lifecycle), and a failure is an ordinary failed outcome the ENGINE settles.
 * Every failure is asserted at the level the operator can observe: a typed stage, a
 * typed reason, no provider_dispatches row, no provider invocation. (The CANONICAL
 * ExecutionAttempt claim is Transaction A in the engine and always precedes this
 * orchestration — proven by s25-claim-ordering.test.ts.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import {
  EXECUTION_SAFETY_STAGE_ORDER,
  assertExecutionSafety,
  buildExecutorEnvironment,
  createProcessExecutorProvider,
  executorEnvAllowlistFor,
  providerDispatchIdOf,
  providerDispatchKeyOf,
  type ExecutorExecutionRequest,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
  type TypedExecutorConfig,
} from '@companyos/engine';

import { createProviderDispatchExecution } from '../../apps/desktop/src/executor/provider-dispatch.js';
import { scriptedAuthorization, scriptedExecutorConfig } from '../support/provider-safety-fixture.js';

const dirs: string[] = [];
const dbs: DurableDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 's25p-'));
  dirs.push(dir);
  return dir;
};

const configOf = (providerKey = 'scripted'): TypedExecutorConfig => scriptedExecutorConfig(providerKey);

const SAFE_BASE = {
  providerKey: 'scripted',
  config: configOf(),
  workspaceRoot: 'C:\\work\\project',
  cwd: 'C:\\work\\project',
  requiredCapabilities: ['timeout', 'structured-output'],
  advertisedCapabilities: ['timeout', 'structured-output'],
  authorization: true,
};

const diskSeams = (root: string) => ({
  realpath: (p: string) => p,
  stat: (p: string) => {
    if (p !== root) throw new Error(`ENOENT: ${p}`);
    return { isDirectory: () => true };
  },
  lstat: (p: string) => {
    if (p !== root) throw new Error(`ENOENT: ${p}`);
    return { isSymbolicLink: () => false };
  },
  platform: 'win32' as NodeJS.Platform,
});

describe('S25 preflight — the ordered pipeline (§30)', () => {
  it('1. a fully safe execution passes every stage IN CONTRACT ORDER', async () => {
    const verdict = await assertExecutionSafety(SAFE_BASE, diskSeams(SAFE_BASE.workspaceRoot!));
    expect(verdict.safe).toBe(true);
    expect(verdict.stages.map((stage) => stage.stage)).toEqual([...EXECUTION_SAFETY_STAGE_ORDER]);
  });

  it('2. the frozen stage order is exactly the contract order', () => {
    expect([...EXECUTION_SAFETY_STAGE_ORDER]).toEqual([
      'config-valid',
      'secret-refs-resolvable',
      'workspace-trusted',
      'cwd-allowed',
      'capabilities-supported',
      'authorization-present',
    ]);
  });

  it('3. an absent configuration fails at config-valid and evaluates NOTHING after it', async () => {
    const verdict = await assertExecutionSafety({ ...SAFE_BASE, config: null }, diskSeams(SAFE_BASE.workspaceRoot!));
    expect(verdict.safe).toBe(false);
    expect(verdict.failedStage).toBe('config-valid');
    expect(verdict.stages.map((stage) => stage.stage)).toEqual(['config-valid']);
    expect(String(verdict.error?.details['reason'])).toBe('EXECUTOR_CONFIG_MISSING');
    expect(verdict.configFingerprint).toBeNull();
  });

  it('4. an unresolvable secret reference fails at secret-refs-resolvable with the typed code', async () => {
    const resolver = {
      async resolve(): Promise<string | null> {
        return null;
      },
      async available(): Promise<readonly string[]> {
        return [];
      },
    };
    const verdict = await assertExecutionSafety(
      {
        ...SAFE_BASE,
        secretRefs: [{ id: 'sref_1', providerId: 'scripted', purpose: 'provider-api-key', source: 'env', envName: 'PROVIDER_API_KEY' }],
      },
      { ...diskSeams(SAFE_BASE.workspaceRoot!), secretResolver: resolver },
    );
    expect(verdict.safe).toBe(false);
    expect(verdict.failedStage).toBe('secret-refs-resolvable');
    expect(verdict.error?.code).toBe('SECRET_NOT_FOUND');
    // Names and outcomes only — a value never reaches the verdict.
    expect(verdict.secretReports).toEqual([{ purpose: 'provider-api-key', source: 'env', outcome: 'not-found' }]);
  });

  it('5. no trusted workspace root fails at workspace-trusted', async () => {
    const verdict = await assertExecutionSafety({ ...SAFE_BASE, workspaceRoot: null }, diskSeams(SAFE_BASE.workspaceRoot!));
    expect(verdict.safe).toBe(false);
    expect(verdict.failedStage).toBe('workspace-trusted');
    expect(String(verdict.error?.details['reason'])).toBe('EXECUTION_WORKSPACE_UNTRUSTED');
  });

  it('6. a cwd outside the trusted root fails at cwd-allowed', async () => {
    const verdict = await assertExecutionSafety(
      { ...SAFE_BASE, cwd: 'C:\\work\\project-evil' },
      diskSeams(SAFE_BASE.workspaceRoot!),
    );
    expect(verdict.safe).toBe(false);
    expect(verdict.failedStage).toBe('cwd-allowed');
    expect(String(verdict.error?.details['reason'])).toBe('REPOSITORY_PATH_OUTSIDE_ROOT');
  });

  it('7. an unsupported capability fails at capabilities-supported (fail loud, never silent degrade)', async () => {
    const verdict = await assertExecutionSafety(
      { ...SAFE_BASE, requiredCapabilities: ['timeout', 'status-query'] },
      diskSeams(SAFE_BASE.workspaceRoot!),
    );
    expect(verdict.safe).toBe(false);
    expect(verdict.failedStage).toBe('capabilities-supported');
    expect(verdict.error?.code).toBe('CAPABILITY_MISSING');
  });

  it('8. a missing authorization fails at authorization-present (never an implicit allow)', async () => {
    const verdict = await assertExecutionSafety({ ...SAFE_BASE, authorization: false }, diskSeams(SAFE_BASE.workspaceRoot!));
    expect(verdict.safe).toBe(false);
    expect(verdict.failedStage).toBe('authorization-present');
    expect(verdict.error?.code).toBe('APPROVAL_REQUIRED');
  });
});

describe('S25 preflight — the child environment policy (§16)', () => {
  it('9. the parent environment is NEVER inherited wholesale: a canary does not cross', () => {
    const built = buildExecutorEnvironment({
      platform: 'win32',
      hostEnvAllowlist: executorEnvAllowlistFor('win32'),
      hostEnv: { PATH: 'C:\\tools', PATH2: 'x', S25_CANARY_SECRET: 'supersecret', DSH_RUNTIME: 'E:\\x' },
      declaredAdditions: {},
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.value)).toEqual(['PATH']);
  });

  it('10. a secret-shaped declared addition is refused (the profile cannot publish a credential)', () => {
    const built = buildExecutorEnvironment({
      platform: 'win32',
      hostEnvAllowlist: executorEnvAllowlistFor('win32'),
      hostEnv: {},
      declaredAdditions: { PROVIDER_API_KEY: 'sk-mock-0123456789abcdef' },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(String(built.error.details['reason'])).toBe('EXECUTOR_ENV_SECRET_REFUSED');
  });

  it('11. a declared addition may refine an allowlisted variable but never resurrect a dropped one', () => {
    const built = buildExecutorEnvironment({
      platform: 'win32',
      hostEnvAllowlist: executorEnvAllowlistFor('win32'),
      hostEnv: { TEMP: 'C:\\host-temp', DSH_RUNTIME: 'E:\\x' },
      declaredAdditions: { TEMP: 'C:\\declared-temp' },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value['TEMP']).toBe('C:\\declared-temp');
    expect('DSH_RUNTIME' in built.value).toBe(false);
  });

  it('12. an invalid environment name or value is refused', () => {
    const name = buildExecutorEnvironment({
      platform: 'win32',
      hostEnvAllowlist: executorEnvAllowlistFor('win32'),
      hostEnv: {},
      declaredAdditions: { 'bad name': 'x' },
    });
    expect(name.ok).toBe(false);
    if (name.ok) return;
    expect(String(name.error.details['reason'])).toBe('EXECUTOR_ENV_NAME_INVALID');

    const value = buildExecutorEnvironment({
      platform: 'win32',
      hostEnvAllowlist: executorEnvAllowlistFor('win32'),
      hostEnv: {},
      declaredAdditions: { SAFE_FLAG: 'a\u0000b' },
    });
    expect(value.ok).toBe(false);
    if (value.ok) return;
    expect(String(value.error.details['reason'])).toBe('EXECUTOR_ENV_VALUE_INVALID');
  });
});

describe('S25 preflight — REAL process spawn, real environment (§16/§33)', () => {
  const requestOf = (over: Partial<ExecutorExecutionRequest> = {}): ExecutorExecutionRequest => ({
    companyId: 'company_default',
    runId: 'run_s25p',
    taskId: 'tsk_s25p',
    attemptId: 'exa_s25p_1',
    attemptNumber: 1,
    roleId: 'rol.provider',
    taskKind: 'task.provider-echo',
    work: { objective: 'print the environment' },
    workspace: null,
    requiredCapabilities: ['timeout'],
    dispatchKey: providerDispatchKeyOf({
      companyId: 'company_default',
      runId: 'run_s25p',
      taskId: 'tsk_s25p',
      attemptNumber: 1,
      providerKey: 'node-probe',
    }),
    taskText: 'print the environment',
    structured: false,
    ...over,
  });

  it('13. a REAL child sees ONLY the allowlisted environment (a hostile parent cannot leak)', async () => {
    const provider = createProcessExecutorProvider({
      providerKey: 'node-probe',
      capabilities: ['timeout'],
      executable: process.execPath,
      buildArgs: () => [],
      baseArgv: ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'],
      fallbackCwd: tempDir(),
      envPolicy: {
        hostEnv: {
          PATH: 'C:\\tools',
          S25_CANARY_SECRET: 'supersecret-value-1234',
          DSH_RUNTIME: 'E:\\harness\\runtime',
          GITHUB_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaa',
        },
      },
    });
    const outcome = await provider.start(requestOf());
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    const keys = JSON.parse(outcome.stdoutText) as readonly string[];
    // The credentials the hostile parent carried never cross the boundary.
    expect(keys).not.toContain('S25_CANARY_SECRET');
    expect(keys).not.toContain('GITHUB_TOKEN');
    expect(keys).not.toContain('DSH_RUNTIME');
    expect(outcome.stdoutText).not.toContain('supersecret');
    // The allowlisted search path does cross.
    expect(keys).toContain('PATH');
    /*
     * Probed Windows fact (recorded, not assumed): the host OS adds a fixed set of
     * system/session variables to every new process block — libuv cannot suppress
     * them. So the invariant is "everything the child sees came from OUR allowlist
     * or from that fixed OS set", never "the child sees exactly our list".
     */
    const windowsSystemVariables: readonly string[] = [
      'HOMEDRIVE',
      'HOMEPATH',
      'LOGONSERVER',
      'SYSTEMDRIVE',
      'SYSTEMROOT',
      'TEMP',
      'USERDOMAIN',
      'USERNAME',
      'USERPROFILE',
      'WINDIR',
    ];
    const permitted = new Set<string>([...executorEnvAllowlistFor('win32'), ...windowsSystemVariables]);
    expect(keys.filter((key) => !permitted.has(key))).toEqual([]);
  });

  it('14. an untrusted cwd fails BEFORE the process is created (no spawn, no side effect)', async () => {
    let spawnReached = false;
    const provider = createProcessExecutorProvider({
      providerKey: 'node-probe',
      capabilities: ['timeout', 'working-directory'],
      executable: process.execPath,
      baseArgv: ['--version'],
      fallbackCwd: null,
      buildArgs: () => {
        spawnReached = true;
        return ['--version'];
      },
    });
    const outcome = await provider.start(requestOf({ workspace: null }));
    expect(outcome.kind).toBe('transport-failed');
    if (outcome.kind !== 'transport-failed') return;
    expect(outcome.reasonCode).toBe('EXECUTOR_WORKSPACE_UNTRUSTED');
    expect(spawnReached).toBe(false);
  });

  it('15. a cwd outside the trusted root is refused before the process is created', async () => {
    const root = tempDir();
    const outside = tempDir();
    let spawnReached = false;
    const provider = createProcessExecutorProvider({
      providerKey: 'node-probe',
      capabilities: ['timeout', 'working-directory'],
      executable: process.execPath,
      baseArgv: ['--version'],
      fallbackCwd: root,
      trustedRoot: root,
      buildArgs: () => {
        spawnReached = true;
        return ['--version'];
      },
    });
    const outcome = await provider.start(requestOf({ workspace: { cwd: outside } }));
    expect(outcome.kind).toBe('transport-failed');
    if (outcome.kind !== 'transport-failed') return;
    expect(outcome.reasonCode).toBe('EXECUTOR_WORKSPACE_UNTRUSTED');
    expect(spawnReached).toBe(false);
  });
});

/* -------------------------------------------------------- dispatch level --- */

const scriptProvider = (behavior: () => ExecutorProviderOutcome): ExecutorProvider => ({
  descriptor: { providerKey: 'scripted', capabilities: ['timeout', 'structured-output'] },
  async start(): Promise<ExecutorProviderOutcome> {
    return behavior();
  },
});

const requestInput = { companyId: 'company_default', runId: 'run_s25d', taskId: 'tsk_s25d' };

describe('S25 preflight — failure injection through the production dispatch (§31/§45-§48)', () => {
  it('16. a safety refusal returns a typed failure, creates NO provider_dispatches row and never calls the provider', async () => {
    const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: ['core', 'engine'] as never });
    dbs.push(db);
    let calls = 0;
    const dispatch = createProviderDispatchExecution({
      registry: (await import('@companyos/engine')).createExecutorProviderRegistry([
        scriptProvider(() => {
          calls += 1;
          return { kind: 'succeeded', exitCode: 0, stdoutText: 'x', startedAt: '', finishedAt: '' };
        }),
      ]),
      dispatches: db.providerDispatches,
      clock: { nowIso: () => new Date().toISOString() },
      workspaceOf: () => null, // no trusted workspace
      requiredCapabilitiesOf: () => ['timeout'],
      workPackageTextOf: async () => null,
      configOf: () => configOf(),
      authorizationOf: async () => scriptedAuthorization('scripted'),
    });
    const result = await dispatch.execute(
      { ...requestInput, attemptId: 'exa_s25d_1', attemptNumber: 1, roleId: 'rol.provider', taskKind: 'task.provider-work' },
      'scripted',
    );
    expect(result.output).toBe('failed');
    expect(result.failure?.stage).toBe('workspace-trusted');
    expect(result.failure?.reason).toBe('EXECUTION_WORKSPACE_UNTRUSTED');
    expect(result.dispatchId).toBe('');
    expect(calls).toBe(0);
    expect(db.db.prepare('SELECT COUNT(*) AS c FROM provider_dispatches').get()).toEqual({ c: 0 });
  });

  it('17. a CONFIG DRIFT on a frozen attempt is refused and recorded as uncertainty', async () => {
    const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: ['core', 'engine'] as never });
    dbs.push(db);
    const dispatchId = providerDispatchIdOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' });
    const now = new Date().toISOString();
    await db.providerDispatches.claim({
      id: dispatchId,
      ...requestInput,
      attemptId: 'exa_s25d_1',
      attemptNumber: 1,
      providerKey: 'scripted',
      dispatchKey: providerDispatchKeyOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' }),
      providerSessionId: null,
      providerInvocationId: null,
      configFingerprint: 'scfg_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      state: 'DISPATCHED',
      routingDecisionJson: null,
      resultSummary: null,
      createdAt: now,
      updatedAt: now,
    });
    let calls = 0;
    const dispatch = createProviderDispatchExecution({
      registry: (await import('@companyos/engine')).createExecutorProviderRegistry([
        scriptProvider(() => {
          calls += 1;
          return { kind: 'succeeded', exitCode: 0, stdoutText: 'x', startedAt: '', finishedAt: '' };
        }),
      ]),
      dispatches: db.providerDispatches,
      clock: { nowIso: () => new Date().toISOString() },
      workspaceOf: () => tempDir(),
      requiredCapabilitiesOf: () => ['timeout'],
      workPackageTextOf: async () => null,
      configOf: () => scriptedExecutorConfig('scripted', 'a-different-configuration'),
      authorizationOf: async () => scriptedAuthorization('scripted'),
    });
    const result = await dispatch.execute(
      { ...requestInput, attemptId: 'exa_s25d_1', attemptNumber: 1, roleId: 'rol.provider', taskKind: 'task.provider-work' },
      'scripted',
    );
    expect(result.output).toBe('failed');
    expect(result.failure?.reason).toBe('EXECUTOR_CONFIG_DRIFT');
    expect(result.state).toBe('UNCERTAIN');
    expect(calls).toBe(0);
    const row = await db.providerDispatches.get(dispatchId);
    expect(row?.state).toBe('UNCERTAIN');
  });

  it('18. a pre-Sprint25 binding (no fingerprint) resumes on parity and records its provenance', async () => {
    const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: ['core', 'engine'] as never });
    dbs.push(db);
    const dispatchId = providerDispatchIdOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' });
    const now = new Date().toISOString();
    await db.providerDispatches.claim({
      id: dispatchId,
      ...requestInput,
      attemptId: 'exa_s25d_1',
      attemptNumber: 1,
      providerKey: 'scripted',
      dispatchKey: providerDispatchKeyOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' }),
      providerSessionId: null,
      providerInvocationId: null,
      configFingerprint: null,
      state: 'DISPATCHED',
      routingDecisionJson: null,
      resultSummary: null,
      createdAt: now,
      updatedAt: now,
    });
    let calls = 0;
    const dispatch = createProviderDispatchExecution({
      registry: (await import('@companyos/engine')).createExecutorProviderRegistry([
        scriptProvider(() => {
          calls += 1;
          return { kind: 'succeeded', exitCode: 0, stdoutText: 'done', startedAt: '', finishedAt: '' };
        }),
      ]),
      dispatches: db.providerDispatches,
      clock: { nowIso: () => new Date().toISOString() },
      workspaceOf: () => tempDir(),
      requiredCapabilitiesOf: () => ['timeout'],
      workPackageTextOf: async () => null,
      configOf: () => scriptedExecutorConfig('scripted'),
      authorizationOf: async () => scriptedAuthorization('scripted'),
    });
    const result = await dispatch.execute(
      { ...requestInput, attemptId: 'exa_s25d_1', attemptNumber: 1, roleId: 'rol.provider', taskKind: 'task.provider-work' },
      'scripted',
    );
    if (result.output === 'failed') throw new Error('the dispatch failed unexpectedly');
    expect(result.output.status).toBe('succeeded');
    expect(calls).toBe(1);
    const row = await db.providerDispatches.get(dispatchId);
    expect(row?.configFingerprint).not.toBeNull();
    expect(row?.state).toBe('SETTLED');
  });

  it('19. a fully safe dispatch settles through the canonical row and hands the engine an envelope', async () => {
    const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: ['core', 'engine'] as never });
    dbs.push(db);
    const dispatch = createProviderDispatchExecution({
      registry: (await import('@companyos/engine')).createExecutorProviderRegistry([
        scriptProvider(() => ({ kind: 'succeeded', exitCode: 0, stdoutText: 'ok', startedAt: '', finishedAt: '' })),
      ]),
      dispatches: db.providerDispatches,
      clock: { nowIso: () => new Date().toISOString() },
      workspaceOf: () => tempDir(),
      requiredCapabilitiesOf: () => ['timeout'],
      workPackageTextOf: async () => null,
      configOf: () => configOf(),
      authorizationOf: async () => scriptedAuthorization('scripted'),
    });
    const result = await dispatch.execute(
      { ...requestInput, attemptId: 'exa_s25d_1', attemptNumber: 1, roleId: 'rol.provider', taskKind: 'task.provider-work' },
      'scripted',
    );
    if (result.output === 'failed') return;
    expect(result.output.status).toBe('succeeded');
    expect(result.output.output.executionId).toBe('exa_s25d_1');
    expect(result.state).toBe('SETTLED');
    const row = await db.providerDispatches.get(result.dispatchId);
    expect(row?.configFingerprint).toBe(configOf().fingerprint);
    expect(row?.state).toBe('SETTLED');
  });

  it('20. a missing authorization provenance fails closed before any claim or provider call', async () => {
    const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: ['core', 'engine'] as never });
    dbs.push(db);
    let calls = 0;
    const dispatch = createProviderDispatchExecution({
      registry: (await import('@companyos/engine')).createExecutorProviderRegistry([
        scriptProvider(() => {
          calls += 1;
          return { kind: 'succeeded', exitCode: 0, stdoutText: 'x', startedAt: '', finishedAt: '' };
        }),
      ]),
      dispatches: db.providerDispatches,
      clock: { nowIso: () => new Date().toISOString() },
      workspaceOf: () => tempDir(),
      requiredCapabilitiesOf: () => ['timeout'],
      workPackageTextOf: async () => null,
      configOf: () => configOf(),
      // no authorizationOf at all — the dispatch is not authorized
    });
    const result = await dispatch.execute(
      { ...requestInput, attemptId: 'exa_s25d_1', attemptNumber: 1, roleId: 'rol.provider', taskKind: 'task.provider-work' },
      'scripted',
    );
    expect(result.output).toBe('failed');
    expect(result.failure?.stage).toBe('authorization-present');
    expect(calls).toBe(0);
    expect(db.db.prepare('SELECT COUNT(*) AS c FROM provider_dispatches').get()).toEqual({ c: 0 });
  });
});

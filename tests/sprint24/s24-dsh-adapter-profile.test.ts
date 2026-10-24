/**
 * Sprint24 recovery (Boss V1 Real Executor Compatibility Recovery §15/§16) —
 * DETERMINISTIC adapter-contract tests for the PROFILE-based DSH invocation.
 *
 * Root cause (docs/provider-recovery/DSH_CURRENT_RUNTIME_RECON.md): the installed
 * runtime normalizes the NAMED `headless` profile to a web-app composition that
 * rejects task arguments; the frozen S24 contract lives on the shipped-template
 * composition, reachable under a non-normalized profile name. These tests prove
 * the adapter targets the configured profile, fails LOUD on the known contract
 * drift signatures (parse-level proof of non-invocation — never a coercion), and
 * never keys behavior on the version label.
 *
 * All tests run a REAL node process executing a FIXTURE runtime script (no
 * installed-DSH dependency): the fixture echoes the argv it received as the S24
 * NDJSON contract, or replays a drift signature, per the task text.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOfflineFixture } from '../support/offline-fixtures.js';

import { afterEach, describe, expect, it } from 'vitest';

import { providerDispatchKeyOf, type ExecutorExecutionRequest, type TypedExecutorConfig } from '@companyos/engine';

import {
  createDshProvider,
  createDshProviderFromConfig,
  DSH_PROVIDER_KEY,
  resolveDshProviderConfig,
} from '../../apps/desktop/src/executor/dsh-executor-provider.js';

const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

/*
 * The fixture runtime: a real node script standing in for lib/bin.js. The task
 * text (the adapter's LAST argv element) selects the behavior, so every path is
 * driven through the adapter's OWN argv construction.
 */
const FIXTURE_BIN = `
const argv = process.argv.slice(2);
const task = argv[argv.length - 1] ?? '';
const profile = argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : null;
if (task.startsWith('FIXTURE:reject-json')) { console.error("error: unknown option '--json'"); process.exit(1); }
if (task.startsWith('FIXTURE:too-many-args')) { console.error('error: too many arguments. Expected 0 arguments but got 1: ' + task); process.exit(1); }
if (task.startsWith('FIXTURE:no-profile')) { console.error('Error: dsh: profile "companyos-headless" does not exist; create it with \\'dsh plugin --profile companyos-headless add <package>\\''); process.exit(1); }
if (task.startsWith('FIXTURE:garbage')) { console.log('this is not ndjson at all'); process.exit(0); }
const session = argv.includes('--session-id') ? argv[argv.indexOf('--session-id') + 1] : 'session-fresh-fixture';
console.log(JSON.stringify({ type: 'session', sessionId: session, cwd: process.cwd() }));
console.log(JSON.stringify({ type: 'status', phase: 'fixture-probe', profile: profile }));
console.log(JSON.stringify({ type: 'final', text: 'PONG' }));
`;

interface Fixture {
  readonly runtimeDir: string;
  readonly config: TypedExecutorConfig;
  readonly provider: ReturnType<typeof createDshProvider>;
}

const makeFixture = (composition: { readonly profileName?: string } = {}): Fixture => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'dsh-fixture-'));
  createdDirs.push(runtimeDir);
  mkdirSync(join(runtimeDir, 'lib'), { recursive: true });
  writeFileSync(join(runtimeDir, 'lib', 'bin.js'), FIXTURE_BIN, 'utf8');
  registerOfflineFixture(join(runtimeDir, 'lib', 'bin.js'));
  const typedConfig = resolveDshProviderConfig({
    composition: {
      nodeExecutable: process.execPath,
      runtimeDir,
      ...(composition.profileName === undefined ? {} : { profileName: composition.profileName }),
      timeoutMs: 10_000,
    },
  });
  if (!typedConfig.ok) throw new Error(typedConfig.error.message);
  const built = createDshProviderFromConfig(typedConfig.value);
  if (!built.ok) throw new Error(built.error.message);
  return {
    runtimeDir,
    config: typedConfig.value,
    provider: createDshProvider({ ...built.value, fallbackCwd: runtimeDir }),
  };
};

const requestOf = (taskText: string, over: Partial<ExecutorExecutionRequest> = {}): ExecutorExecutionRequest => ({
  companyId: 'company_default',
  runId: 'run_s24p',
  taskId: 'tsk_s24p',
  attemptId: 'exa_s24p_1',
  attemptNumber: 1,
  roleId: 'rol.provider',
  taskKind: 'task.provider-echo',
  work: { objective: taskText },
  workspace: null,
  requiredCapabilities: ['timeout', 'structured-output'],
  dispatchKey: providerDispatchKeyOf({
    companyId: 'company_default',
    runId: 'run_s24p',
    taskId: 'tsk_s24p',
    attemptNumber: 1,
    providerKey: DSH_PROVIDER_KEY,
  }),
  taskText,
  structured: true,
  timeoutMs: 10_000,
  ...over,
});

describe('S24 recovery — the profile-based DSH invocation contract (deterministic)', () => {
  it('§16.5 the configuration carries NO version field — the version label can never select the protocol', () => {
    const f = makeFixture();
    const names = f.config.fields.map((field) => field.name);
    expect(names).not.toContain('version');
    expect(names).not.toContain('runtimeVersion');
    expect(names).toContain('nodeExecutable');
    expect(names).toContain('runtimeDir');
  });

  it('§16.2 profileName defaults to the CompanyOS-owned template-restored profile', () => {
    const typedConfig = resolveDshProviderConfig({
      composition: { nodeExecutable: process.execPath, runtimeDir: 'E:\\fixture' },
    });
    expect(typedConfig.ok).toBe(true);
    if (!typedConfig.ok) return;
    const field = typedConfig.value.fields.find((entry) => entry.name === 'profileName');
    expect(field?.value).toBe('companyos-headless');
    expect(field?.source).toBe('default');
  });

  it('§16.2 the ACTUAL invocation syntax: the adapter passes the configured profile, --json, and the task to the runtime', async () => {
    const f = makeFixture();
    const outcome = await f.provider.start(requestOf('Answer with exactly the word PONG.'));
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.providerSessionId).toBe('session-fresh-fixture');
    const events = (outcome.structured as { readonly events: readonly { readonly type?: string; readonly phase?: string; readonly profile?: string }[] }).events;
    const probe = events.find((event) => event.type === 'status' && event.phase === 'fixture-probe');
    expect(probe?.profile).toBe('companyos-headless'); // the argv the runtime actually received
    expect(outcome.structured).toMatchObject({ finalText: 'PONG' });
    expect('providerInvocationId' in outcome).toBe(false); // §16.10 never invented
  });

  it('§16.2 an EXPLICIT profile override reaches the runtime (composition precedence)', async () => {
    const f = makeFixture({ profileName: 'audit-custom-profile' });
    const outcome = await f.provider.start(requestOf('Answer with exactly the word PONG.'));
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    const events = (outcome.structured as { readonly events: readonly { readonly type?: string; readonly phase?: string; readonly profile?: string }[] }).events;
    expect(events.find((event) => event.type === 'status' && event.phase === 'fixture-probe')?.profile).toBe('audit-custom-profile');
  });

  it('§16.3/§16.4 the drift signature "unknown option --json" is classified as a typed CONTRACT MISMATCH (not coerced, not uncertain)', async () => {
    const f = makeFixture();
    const outcome = await f.provider.start(requestOf('FIXTURE:reject-json'));
    expect(outcome.kind).toBe('provider-failed');
    if (outcome.kind !== 'provider-failed') return;
    expect(outcome.reasonCode).toBe('EXECUTOR_DSH_PROFILE_CONTRACT_MISMATCH');
    expect(outcome.stderrText).toContain("unknown option '--json'"); // evidence preserved verbatim
  });

  it('§16.3/§16.4 the drift signature "too many arguments" (the web-app hijack) is classified as a typed CONTRACT MISMATCH', async () => {
    const f = makeFixture();
    const outcome = await f.provider.start(requestOf('FIXTURE:too-many-args'));
    expect(outcome.kind).toBe('provider-failed');
    if (outcome.kind !== 'provider-failed') return;
    expect(outcome.reasonCode).toBe('EXECUTOR_DSH_PROFILE_CONTRACT_MISMATCH');
    expect(outcome.stderrText).toContain('too many arguments');
  });

  it('§16.3/§16.4 a MISSING configured profile is classified as a typed CONTRACT MISMATCH (fail loud, actionable)', async () => {
    const f = makeFixture();
    const outcome = await f.provider.start(requestOf('FIXTURE:no-profile'));
    expect(outcome.kind).toBe('provider-failed');
    if (outcome.kind !== 'provider-failed') return;
    expect(outcome.reasonCode).toBe('EXECUTOR_DSH_PROFILE_CONTRACT_MISMATCH');
    expect(outcome.stderrText).toContain('does not exist');
  });

  it('§16.6 malformed provider output (exit 0, garbage) is NOT coerced into success and NOT mislabeled as a contract mismatch', async () => {
    const f = makeFixture();
    const outcome = await f.provider.start(requestOf('FIXTURE:garbage'));
    expect(outcome.kind).toBe('provider-failed'); // the frozen malformed-structured-output rule
    if (outcome.kind !== 'provider-failed') return;
    expect(outcome.reasonCode).not.toBe('EXECUTOR_DSH_PROFILE_CONTRACT_MISMATCH');
  });

  it('§16.9 session identity stays truthful: a continuation session id is adopted, never minted', async () => {
    const f = makeFixture();
    const outcome = await f.provider.start(
      requestOf('Answer with exactly the word PONG.', { continuationSessionId: 'session-continued-fixture' }),
    );
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.providerSessionId).toBe('session-continued-fixture'); // echoed from the REAL argv evidence
    expect('providerInvocationId' in outcome).toBe(false);
  });
});

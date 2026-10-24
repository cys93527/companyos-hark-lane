import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorExecutionRequest } from '@companyos/engine';
import { createDshProvider, createDshProviderFromConfig, resolveDshProviderConfig, dshTaskTextOf } from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import { registerOfflineFixture } from '../support/offline-fixtures.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const runFixture = async (output: string) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-output-fixture-')); dirs.push(root);
  mkdirSync(join(root, 'lib'));
  // This is a deterministic fixture script, NOT the DSH kernel.
  writeFileSync(join(root, 'lib', 'bin.js'), `process.stdout.write(${JSON.stringify(output)});`, 'utf8');
  const resolved = resolveDshProviderConfig({ composition: { nodeExecutable: process.execPath, runtimeDir: root, profileName: 'fixture', timeoutMs: 1000 } });
  if (!resolved.ok) throw resolved.error;
  const built = createDshProviderFromConfig(resolved.value);
  if (!built.ok) throw built.error;
  const provider = createDshProvider({ ...built.value, fallbackCwd: root });
  const request: ExecutorExecutionRequest = { companyId: 'company', runId: 'run', taskId: 'task', attemptId: 'attempt', attemptNumber: 1, roleId: 'role', taskKind: 'fixture', work: { objective: 'deterministic fixture only' }, workspace: null, requiredCapabilities: ['structured-output'], dispatchKey: 'dispatch', taskText: '', structured: true, timeoutMs: 1000 };
  registerOfflineFixture(join(root, 'lib', 'bin.js'), {argv: ['--profile', 'fixture', '--json', dshTaskTextOf(request)], cwd: root});
  return provider.start(request);
};
const session = '{"type":"session","sessionId":"fixture-session"}\n';
describe('execution safety: DSH adapter output carrier (fixture, not real DSH)', () => {
  it.each(['', session, `${session}{"type":"status","phase":"busy"}\n`])('rejects exit-zero output without a final result %j', async (output) => {
    expect(await runFixture(output)).toMatchObject({ kind: 'provider-failed', exitCode: 0, reasonCode: 'EXECUTOR_DSH_FINAL_MISSING' });
  });
  it.each(['', '   ', '\n\t'])('rejects an empty final result %j', async (text) => {
    expect(await runFixture(`${session}${JSON.stringify({ type: 'final', text })}\n`)).toMatchObject({ kind: 'provider-failed', reasonCode: 'EXECUTOR_DSH_FINAL_EMPTY' });
  });
  it('retains the existing diagnostics artifact and actual final text', async () => {
    const output = `${session}{"type":"tool_call","tool":"fixture","input":{}}\n{"type":"final","text":"actual fixture result"}\n`;
    const result = await runFixture(output);
    expect(result.kind).toBe('succeeded');
    if (result.kind === 'succeeded') {
      expect(result.providerSessionId).toBe('fixture-session');
      expect(result.stdoutText).toBe(output);
      expect(result.structured).toMatchObject({ finalText: 'actual fixture result', artifactContent: 'companyos/kernel-diagnostics/1\ntool_call fixture {}' });
    }
  });
  it('rejects events after final rather than publishing a late successful result', async () => {
    const result = await runFixture(`${session}{"type":"final","text":"result"}\n{"type":"status","phase":"late"}\n`);
    expect(result.kind).toBe('provider-failed');
  });
});

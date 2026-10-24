import { createHash } from 'node:crypto';
import { statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import type * as ChildProcesses from 'node:child_process';

export const redactEvidence = (text: string, secrets: readonly string[] = []): string => {
  let result = text;
  for (const value of secrets) if (value) result = result.replaceAll(value, '[REDACTED]');
  return result.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]').replace(/((?:api[_-]?key|password|token)\s*[=:]\s*)[^\s,;}]+/gi, '$1[REDACTED]').slice(0, 32_768);
};
export const outcomeEvidence = (value: unknown, secrets: readonly string[] = []) => {
  const data = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const kind = typeof data['kind'] === 'string' ? data['kind'] : 'MALFORMED_OUTCOME';
  const nativeExitCode = typeof data['exitCode'] === 'number' && Number.isInteger(data['exitCode']) ? data['exitCode'] : null;
  const text = (key: string) => typeof data[key] === 'string' ? redactEvidence(data[key], secrets) : null;
  return {
    observedAt: new Date().toISOString(), kind, nativeExitCode,
    nativeExitEvidence: nativeExitCode === null ? 'NOT CAPTURED' : 'PROVIDER_REPORTED_NATIVE_FIELD',
    reasonCode: text('reasonCode') ?? text('reason'), detail: text('detail'),
    terminationProven: data['terminationProven'] === true ? true : data['terminationProven'] === false ? false : null,
    stdout: text('stdoutText'), stderr: text('stderrText'),
    // A zero exit rejected for protocol/policy reasons stays non-success.
    succeeded: kind === 'succeeded',
  };
};
export const saveOutcomeEvidence = (file: string, outcome: unknown, processes: readonly unknown[], secrets: readonly string[] = []): void => {
  const data = { outcome: outcomeEvidence(outcome, secrets), processes, scope: 'Node spawn observed in this test only. Native grandchildren and remote cancellation are not proven.' };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
};
export const observeFixtureSpawns = (secrets: readonly string[] = []) => {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as typeof ChildProcesses;
  const original = cp.spawn;
  const records: Record<string, unknown>[] = [];
  cp.spawn = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = original(file, args, options) as ChildProcess;
    let identity: Record<string, unknown> | null = null;
    try { const stat = statSync(file, { bigint: true }); identity = { dev: String(stat.dev), fileId: String(stat.ino) }; } catch { /* NOT CAPTURED */ }
    const row: Record<string, unknown> = { PID: child.pid ?? null, parentPID: process.pid, requestedAt: new Date().toISOString(), executable: file, identity, argvSHA256: createHash('sha256').update(JSON.stringify(args)).digest('hex'), cwd: options?.['cwd'] ?? null, exitCode: null, signal: null, exitObserved: false };
    records.push(row);
    child.once('exit', (code, signal) => { row['exitCode'] = code; row['signal'] = signal; row['exitObserved'] = true; row['exitedAt'] = new Date().toISOString(); });
    child.once('error', (error) => { row['spawnError'] = redactEvidence(error.message, secrets); });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (value: Buffer) => { stdout = (stdout + value.toString('utf8')).slice(-32_768); row['stdoutTail'] = redactEvidence(stdout, secrets); });
    child.stderr?.on('data', (value: Buffer) => { stderr = (stderr + value.toString('utf8')).slice(-32_768); row['stderrTail'] = redactEvidence(stderr, secrets); });
    return child;
  }) as typeof cp.spawn;
  syncBuiltinESMExports();
  return { records, stop: () => { cp.spawn = original; syncBuiltinESMExports(); } };
};

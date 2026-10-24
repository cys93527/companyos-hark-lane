import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactEvidence } from './kernel-outcome-evidence.js';

/** Loopback-only live fixture. Readiness is acknowledged, never guessed from a port. */
export const startScenarioServer = async (scenario: readonly unknown[], directory: string) => {
  const file = join(directory, 'scenario.json');
  writeFileSync(file, JSON.stringify(scenario), { encoding: 'utf8', flag: 'wx' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../kernel/support/scenario-model-server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', SCENARIO_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  try {
    const port = await waitForScenarioReady(child);
    return { port, PID: child.pid, stop: () => stopScenarioServer(child) };
  } catch (error) {
    try { await stopScenarioServer(child); } catch { throw new AggregateError([error], 'SCENARIO_START_FAILED_AND_STOP_NOT_PROVEN'); }
    throw error;
  }
};

/** Exported separately for deterministic EventEmitter tests; no process is created here. */
export const waitForScenarioReady = (child: ChildProcess, timeoutMs = 5_000): Promise<number> => new Promise((resolve, reject) => {
  let stdout = ''; let stderr = '';
  const cleanup = () => { clearTimeout(timer); child.stdout?.off('data', data); child.stderr?.off('data', errors); child.off('error', failed); child.off('exit', exited); };
  const fail = (message: string) => { cleanup(); reject(new Error(`${message}: ${redactEvidence(stderr)}`)); };
  const data = (value: Buffer) => {
    stdout = (stdout + value.toString('utf8')).slice(-32_768);
    const match = /scenario-model-server on (\d+) with/.exec(stdout);
    if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) { cleanup(); resolve(Number(match[1])); }
  };
  const errors = (value: Buffer) => { stderr = (stderr + value.toString('utf8')).slice(-32_768); };
  const failed = () => fail('SCENARIO_SPAWN_FAILURE');
  const exited = (code: number | null, signal: string | null) => fail(`SCENARIO_EXIT_BEFORE_READY code=${String(code)} signal=${String(signal)}`);
  const timer = setTimeout(() => fail('SCENARIO_READY_TIMEOUT'), timeoutMs);
  child.stdout?.on('data', data); child.stderr?.on('data', errors); child.once('error', failed); child.once('exit', exited);
});

export const stopScenarioServer = (child: ChildProcess, timeoutMs = 5_000): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('exit', exited); child.off('error', failed); };
    const exited = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('SCENARIO_STOP_NOT_PROVEN')); };
    const timer = setTimeout(failed, timeoutMs);
    child.once('exit', exited); child.once('error', failed);
    // Only this exact ChildProcess handle is stopped; no guessed PID or process name.
    if (!child.kill()) failed();
  });
};

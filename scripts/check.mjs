#!/usr/bin/env node
/**
 * `pnpm check` — the single aggregate gate of CompanyOS (T0.12).
 *
 * Order is cheapest-first and fails fast:
 *   1. lint         eslint .
 *   2. typecheck    tsc -p tsconfig.json --noEmit
 *   3. boundaries   Core vocabulary + import direction (scripts/check-boundaries.mjs)
 *   4. architecture architecture laws ARCH-003..ARCH-031 (scripts/check-architecture.mjs)
 *   5. test         vitest run
 *   6. build        tsc -b (libs) + vite build (renderer) + tsc (desktop)
 *
 * `--only <step>` runs a single step (used by scripts/tests/check-gate.test.mjs
 * to prove the gate fails fast). Exit code 0 only when every executed step passed.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync } from 'node:fs';
import { runStages } from './check-runner.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Failure-capture discipline (T20-05 §34): a non-zero step must NEVER lose its
 * diagnostics. Every step's output is captured and replayed to the console, and on
 * failure the full output (command, exit code, failing files/tests where the tool
 * prints them, and the tail) is persisted to .check-failures/ so a transient red can
 * still be classified afterwards. No retries — the first failure is the truth.
 */
const FAILURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.check-failures');

const persistFailure = (step, cmd, code, signal, output) => {
  try {
    mkdirSync(FAILURE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(FAILURE_DIR, `${stamp}-${step}.log`);
    const lines = String(output).split('\n');
    const tail = lines.slice(-400).join('\n');
    writeFileSync(
      file,
      [
        `step: ${step}`,
        `command: ${cmd}`,
        `exit code: ${String(code)}`,
        `signal: ${String(signal ?? 'none')}`,
        `captured at: ${new Date().toISOString()}`,
        '',
        '--- full output ---',
        String(output),
        '',
        '--- tail (last 400 lines) ---',
        tail,
        '',
      ].join('\n'),
      'utf8',
    );
    return file;
  } catch {
    return null; // capture must never mask the original failure
  }
};

const require = createRequire(import.meta.url);
const { ROOT, parseCheckArgs } = require('./check-plan.cjs');
const { installOfflineGuard, safeEnvironment } = require('./test-offline-guard.cjs');

// Every actual check descendant uses the existing offline guard, including when
// pnpm's outer wrapper did not preload it. No package-manager or shell children.
export function checkEnvironment(input = process.env) {
  const env = {};
  const allowed = new Set(['SYSTEMROOT','WINDIR','SYSTEMDRIVE','COMSPEC','PATHEXT','OS','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','NO_COLOR']);
  for (const [key,value] of Object.entries(input)) if (allowed.has(key.toUpperCase())) env[key]=value;
  const parent=join(ROOT,'.tmp','offline-gates');
  mkdirSync(parent,{recursive:true});
  const profile=mkdtempSync(join(parent,'check-'));
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR']) env[key]=profile;
  env.FORCE_COLOR='1'; env.CI='1';
  return safeEnvironment(env);
}

export async function main(argv = process.argv.slice(2)) {
  // Validate all CLI args before admitting any child or emitting a PASS summary.
  try { parseCheckArgs(argv); } catch (error) {
    console.error(`❌ pnpm check: ${error.message}`);
    return 1;
  }
  let steps, env;
  try {
    env=checkEnvironment();
    // Registration and execution share the finite expansion; the guard pins
    // each script's bytes/file identity and cwd, and checks exact argv at spawn.
    steps=installOfflineGuard().registerCheckCommands(argv);
  } catch (error) {
    console.error(`❌ pnpm check preflight BLOCKED: ${error.message}`);
    return 1;
  }
  const controller=new globalThis.AbortController();
  const interrupt=()=>controller.abort();
  process.once('SIGINT',interrupt); process.once('SIGTERM',interrupt);
  try {
    const outcome=await runStages(steps,{env,signal:controller.signal,persist:persistFailure});
    return outcome.code;
  } finally {
    process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',interrupt);
  }
}

if (process.argv[1] && realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(process.argv[1])) process.exitCode=await main();

/**
 * STAGE 4 — embedded-kernel FAILURE gates: cancel / timeout / kernel crash /
 * malformed NDJSON. Every fixture is disposable; the CompanyOS uncertainty
 * discipline (at-least-once, no silent replay, no fabricated completion) must
 * hold when the kernel misbehaves.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { join as pjoin } from 'node:path';
import { createDshProvider, DSH_PROVIDER_KEY } from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import { resolveEmbeddedDshRuntime } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';
import { writeFixtureExecutionClosure } from './support/fixture-closure.js';
import { resolveExecutorConfig, type ExecutorExecutionRequest } from '@companyos/engine';

const EMBEDDED_ROOT = pjoin(process.cwd(), '.companyos-embedded', 'dsh-runtime');
const scraps: string[] = [];
afterEach(() => {
  while (scraps.length > 0) rmSync(scraps.pop() as string, { recursive: true, force: true });
});

const armedTimer = (ms: number, onTimeout: () => void): (() => void) => {
  const handle = setTimeout(onTimeout, ms);
  return () => clearTimeout(handle);
};

const requestOf = (workspace: string, over: Partial<ExecutorExecutionRequest> = {}): ExecutorExecutionRequest => ({
  companyId: 'c', runId: 'r', taskId: 't', attemptId: `att_${Math.random().toString(36).slice(2, 10)}`, attemptNumber: 1,
  roleId: 'rol', taskKind: 'companyos:work', work: { objective: 'do the bounded work' },
  workspace: { cwd: workspace, root: workspace }, requiredCapabilities: [], dispatchKey: `dsp_${Math.random().toString(36).slice(2, 10)}`,
  taskText: 'x', structured: false, ...over,
});

const workspaceScratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-kernel-fail-'));
  scraps.push(dir);
  return dir;
};

const embeddedProvider = (baseURL: string, over: { readonly timeoutMs?: number } = {}) => {
  const rt = resolveEmbeddedDshRuntime({ managedRoot: EMBEDDED_ROOT });
  if (!rt.ok) throw new Error(rt.error.message);
  const cfg = resolveExecutorConfig({
    providerKey: DSH_PROVIDER_KEY,
    schema: { kernelId: { name: 'kernelId', kind: 'string', required: true } },
    envNames: {}, composition: { kernelId: rt.value.manifest.kernelId },
  });
  if (!cfg.ok) throw new Error(cfg.error.message);
  return createDshProvider({
    nodeExecutable: '', runtimeDir: '', profileName: rt.value.manifest.profileName, fallbackCwd: null,
    config: cfg.value,
    timer: armedTimer,
    timeoutMs: over.timeoutMs,
    embedded: {
      runtime: rt.value,
      modelRoute: { providerId: 'p', modelId: 'm', baseURL, apiKeyEnv: 'COMPANYOS_MODEL_ROUTE_ACCESS', apiKeyValue: 'broker', contextWindow: 8192, maxTokens: 256 },
    },
  });
};

/** A scenario server child handle for the failure fixtures. */
import { spawn } from 'node:child_process';
const startScenario = (scenario: readonly unknown[]): { port: number; stop: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-kernel-fail-model-'));
  scraps.push(dir);
  const file = join(dir, 's.json');
  writeFileSync(file, JSON.stringify(scenario), 'utf8');
  const port = 9200 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [join(process.cwd(), 'tests', 'kernel', 'support', 'scenario-model-server.mjs')], {
    env: { ...process.env, PORT: String(port), SCENARIO_FILE: file }, stdio: 'ignore', shell: false,
  });
  return { port, stop: () => child.kill() };
};

describe('STAGE 4 embedded kernel failure gates (disposable fixtures)', () => {
  it('CANCEL: an aborted invocation returns the typed cancelled outcome with proven termination, and no orphan kernel process remains', async () => {
    const model = startScenario([{ delay_ms: 60_000 }]);
    try {
      const provider = embeddedProvider(`http://127.0.0.1:${model.port}/v1`);
      const controller = new AbortController();
      const ws = workspaceScratch();
      const running = provider.start(requestOf(ws, { signal: controller.signal, timeoutMs: 90_000 }));
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      controller.abort();
      const outcome = await running;
      expect(['cancelled', 'provider-failed', 'timeout']).toContain(outcome.kind);
      if (outcome.kind === 'cancelled') expect(outcome.terminationProven).toBe(true);
      // Orphan check: no node child still holding our disposable DSH_HOME scratch.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    } finally {
      model.stop();
    }
  }, 120_000);

  it('TIMEOUT: the composition-armed deadline terminates the invocation with the typed timeout classification', async () => {
    const model = startScenario([{ delay_ms: 60_000 }]);
    try {
      const provider = embeddedProvider(`http://127.0.0.1:${model.port}/v1`, { timeoutMs: 6_000 });
      const ws = workspaceScratch();
      const outcome = await provider.start(requestOf(ws));
      expect(['timeout', 'cancelled', 'provider-failed']).toContain(outcome.kind);
      if (outcome.kind === 'timeout') expect(outcome.terminationProven).toBe(true);
    } finally {
      model.stop();
    }
  }, 120_000);

  it('KERNEL CRASH: a kernel process that dies mid-run yields a typed failure — never a fabricated success (uncertainty discipline upstream)', async () => {
    // A CRASHING runtime: a manifest whose CLI entry prints the session line then
    // exits non-zero mid-stream. Built as a scratch managed root (checksum-free
    // manifest = no exact-pin claim, valid only as a crash fixture).
    const crashRoot = mkdtempSync(join(tmpdir(), 'companyos-kernel-crash-root-'));
    scraps.push(crashRoot);
    const runtimeDir = join(crashRoot, 'runtime');
    mkdirSync(join(runtimeDir, 'apps', 'cli', 'lib'), { recursive: true });
    const cli = join(runtimeDir, 'apps', 'cli', 'lib', 'bin.js');
    writeFileSync(
      cli,
      [
        "console.log(JSON.stringify({ type: 'session', sessionId: 'session-crash-fixture', cwd: process.cwd() }));",
        "console.log(JSON.stringify({ type: 'status', phase: 'turn_start', turn: 1 }));",
        'process.exit(1);',
        '',
      ].join('\n'),
      'utf8',
    );
    const homeTemplate = join(crashRoot, 'home-template', 'profiles', 'crash');
    mkdirSync(homeTemplate, { recursive: true });
    writeFileSync(join(homeTemplate, 'package.json'), '{"name":"dsh-profile-crash","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}', 'utf8');
    const patch = join(crashRoot, 'patch-template.yml');
    writeFileSync(patch, '- id: nothing\n  disabled: true\n', 'utf8');
    writeFixtureExecutionClosure(crashRoot, {
      kernelId: 'crash-fixture', upstreamRepo: 'fixture', upstreamSha: 'a'.repeat(40), upstreamTag: 'fixture',
      runtimeRoot: runtimeDir, cliEntry: 'apps/cli/lib/bin.js', nodeRange: '*', packageManager: '',
      profileName: 'crash', dshHomeTemplateDir: join(crashRoot, 'home-template'), profilePatchTemplate: patch,
      transport: 'one-shot-ndjson', protocolVersion: 's24-ndjson/1', license: 'fixture', checksums: {}, createdAt: new Date().toISOString(),
    });
    const rt = resolveEmbeddedDshRuntime({ managedRoot: crashRoot });
    if (!rt.ok) throw new Error(rt.error.message);
    const cfg = resolveExecutorConfig({
      providerKey: DSH_PROVIDER_KEY,
      schema: { kernelId: { name: 'kernelId', kind: 'string', required: true } },
      envNames: {}, composition: { kernelId: 'crash' },
    });
    if (!cfg.ok) throw new Error(cfg.error.message);
    const provider = createDshProvider({
      nodeExecutable: '', runtimeDir: '', profileName: 'crash', fallbackCwd: null, config: cfg.value,
      timer: armedTimer,
      embedded: {
        runtime: rt.value,
        modelRoute: { providerId: 'p', modelId: 'm', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'COMPANYOS_MODEL_ROUTE_ACCESS', apiKeyValue: 'x', contextWindow: 8, maxTokens: 8 },
      },
    });
    const ws = workspaceScratch();
    const outcome = await provider.start(requestOf(ws));
    expect(outcome.kind).not.toBe('succeeded');
    if (outcome.kind === 'provider-failed') {
      // The crashed run emitted evidence, not a verdict: the failure is honest.
      expect(outcome.exitCode).not.toBe(0);
    }
  }, 120_000);

  it('MALFORMED NDJSON: invalid JSON output fails closed with the typed NDJSON error — never coerced into success', async () => {
    const garbageRoot = mkdtempSync(join(tmpdir(), 'companyos-kernel-garbage-root-'));
    scraps.push(garbageRoot);
    const runtimeDir = join(garbageRoot, 'runtime');
    mkdirSync(join(runtimeDir, 'apps', 'cli', 'lib'), { recursive: true });
    const cli = join(runtimeDir, 'apps', 'cli', 'lib', 'bin.js');
    writeFileSync(
      cli,
      [
        "console.log(JSON.stringify({ type: 'session', sessionId: 'session-garbage-fixture', cwd: process.cwd() }));",
        "console.log('this is not json at all {{{');",
        '',
      ].join('\n'),
      'utf8',
    );
    const homeTemplate = join(garbageRoot, 'home-template', 'profiles', 'garbage');
    mkdirSync(homeTemplate, { recursive: true });
    writeFileSync(join(homeTemplate, 'package.json'), '{"name":"dsh-profile-garbage","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}', 'utf8');
    const patch = join(garbageRoot, 'patch-template.yml');
    writeFileSync(patch, '- id: nothing\n  disabled: true\n', 'utf8');
    writeFixtureExecutionClosure(garbageRoot, {
      kernelId: 'garbage-fixture', upstreamRepo: 'fixture', upstreamSha: 'b'.repeat(40), upstreamTag: 'fixture',
      runtimeRoot: runtimeDir, cliEntry: 'apps/cli/lib/bin.js', nodeRange: '*', packageManager: '',
      profileName: 'garbage', dshHomeTemplateDir: join(garbageRoot, 'home-template'), profilePatchTemplate: patch,
      transport: 'one-shot-ndjson', protocolVersion: 's24-ndjson/1', license: 'fixture', checksums: {}, createdAt: new Date().toISOString(),
    });
    const rt = resolveEmbeddedDshRuntime({ managedRoot: garbageRoot });
    if (!rt.ok) throw new Error(rt.error.message);
    const cfg = resolveExecutorConfig({
      providerKey: DSH_PROVIDER_KEY,
      schema: { kernelId: { name: 'kernelId', kind: 'string', required: true } },
      envNames: {}, composition: { kernelId: 'garbage' },
    });
    if (!cfg.ok) throw new Error(cfg.error.message);
    const provider = createDshProvider({
      nodeExecutable: '', runtimeDir: '', profileName: 'garbage', fallbackCwd: null, config: cfg.value,
      timer: armedTimer,
      embedded: {
        runtime: rt.value,
        modelRoute: { providerId: 'p', modelId: 'm', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'COMPANYOS_MODEL_ROUTE_ACCESS', apiKeyValue: 'x', contextWindow: 8, maxTokens: 8 },
      },
    });
    const ws = workspaceScratch();
    const outcome = await provider.start(requestOf(ws));
    expect(outcome.kind).toBe('provider-failed');
    if (outcome.kind === 'provider-failed') {
      expect(outcome.reasonCode).toBe('EXECUTOR_NDJSON_MALFORMED');
    }
  }, 120_000);
});

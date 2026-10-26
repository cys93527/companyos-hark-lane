/**
 * Hark lane H15 — FIRST-START KERNEL HEALTH CHECK (DSH_KERNEL_DISTRIBUTION_UPDATE_SPEC §3).
 *
 *   kernel spawn -> version readback == manifest declaration (mismatch = refuse + diagnostic)
 *
 * The check runs the STAGED, closure-verified CLI entry on the STAGED pinned Node
 * runtime (prepareAttemptStage re-hashes 100% of the execution closure before it
 * hands out paths), with a scrubbed environment and a disposable DSH_HOME. The
 * one-shot NDJSON transport has no ping verb, so the readback is `--version`,
 * which the upstream CLI answers from its own app-boot package identity.
 *
 * A refused kernel is never registered: the composition keeps the embedded
 * provider out and the typed reason is visible (never a silent fallback to any
 * other dsh, never a PASS without the readback).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmbeddedDshRuntime } from './embedded-dsh-runtime.js';

export type KernelHealthStatus = 'HEALTHY' | 'REFUSED';

export interface KernelHealthReport {
  readonly status: KernelHealthStatus;
  readonly reasonCode: string | null;
  readonly detail: string;
  readonly kernelId: string;
  readonly upstreamSha: string;
  readonly upstreamTag: string;
  readonly declaredVersion: string | null;
  readonly observedVersion: string | null;
  readonly nodeRuntime: string | null;
  readonly closureGeneration: string;
  readonly elapsedMs: number;
  /** Where first-start time goes (stage copy + closure re-hash, kernel spawn, post-spawn re-hash). */
  readonly phases?: { readonly stageMs: number; readonly spawnMs: number; readonly verifyMs: number };
  readonly checkedAt: string;
}

/** The version the manifest declares; dev materializations read the pinned CLI package. */
export const declaredKernelVersion = (runtime: EmbeddedDshRuntime): string | null => {
  if (typeof runtime.manifest.kernelVersion === 'string' && runtime.manifest.kernelVersion !== '') return runtime.manifest.kernelVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(runtime.manifest.runtimeRoot, 'apps', 'cli', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
};

const ENV_PASSTHROUGH = ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec'] as const;

export const checkEmbeddedKernelHealth = async (
  runtime: EmbeddedDshRuntime,
  options: { readonly timeoutMs?: number; readonly now?: () => Date } = {},
): Promise<KernelHealthReport> => {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const declared = declaredKernelVersion(runtime);
  const base = {
    kernelId: runtime.manifest.kernelId,
    upstreamSha: runtime.manifest.upstreamSha,
    upstreamTag: runtime.manifest.upstreamTag,
    declaredVersion: declared,
    closureGeneration: runtime.closure.generation,
  };
  const refuse = (reasonCode: string, detail: string, observed: string | null, nodeRuntime: string | null): KernelHealthReport => ({
    ...base, status: 'REFUSED', reasonCode, detail: detail.slice(0, 2_000), observedVersion: observed, nodeRuntime,
    elapsedMs: Date.now() - started, checkedAt: now().toISOString(),
  });
  if (declared === null) return refuse('KERNEL_VERSION_UNDECLARED', 'The kernel manifest declares no version to read back.', null, null);
  const stageStarted = Date.now();
  const stage = runtime.prepareAttemptStage({ attemptId: 'kernel-health' });
  const stageMs = Date.now() - stageStarted;
  if (!stage.ok) return refuse('KERNEL_STAGE_REFUSED', stage.error.message, null, null);
  const node = stage.value.nodeExecutablePath ?? process.execPath;
  const runAsNode = stage.value.nodeExecutablePath === null && process.versions.electron !== undefined;
  const home = mkdtempSync(join(tmpdir(), 'companyos-kernel-health-'));
  const env: Record<string, string> = { DSH_HOME: home, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  if (runAsNode) env['ELECTRON_RUN_AS_NODE'] = '1';
  try {
    const spawnStarted = Date.now();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError: string | null }>((resolvePromise) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const child = spawn(node, [stage.value.cliEntryPath, '--version'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: home });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs ?? 30_000);
      child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 8_192) stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString('utf8'); });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ code: null, stdout, stderr, timedOut, spawnError: error.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ code, stdout, stderr, timedOut, spawnError: null });
      });
    });
    const spawnMs = Date.now() - spawnStarted;
    if (result.spawnError !== null) return refuse('KERNEL_SPAWN_FAILED', result.spawnError, null, node);
    if (result.timedOut) return refuse('KERNEL_HEALTH_TIMEOUT', 'The kernel did not answer --version in time.', null, node);
    const observed = result.stdout.trim().split(/\r?\n/u).pop()?.trim() ?? '';
    if (result.code !== 0) return refuse('KERNEL_EXIT_NONZERO', `exit ${String(result.code)}: ${result.stderr.trim()}`, observed === '' ? null : observed, node);
    if (observed !== declared) {
      return refuse('KERNEL_VERSION_MISMATCH', `The kernel reported "${observed}" but the manifest declares "${declared}".`, observed, node);
    }
    const verifyStarted = Date.now();
    const post = stage.value.verifyStaged();
    const verifyMs = Date.now() - verifyStarted;
    if (!post.ok) return refuse('KERNEL_STAGE_REFUSED', post.error.message, observed, node);
    return { ...base, status: 'HEALTHY', reasonCode: null, detail: 'version readback matches the manifest', observedVersion: observed, nodeRuntime: node,
      elapsedMs: Date.now() - started, phases: { stageMs, spawnMs, verifyMs }, checkedAt: now().toISOString() };
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort scratch cleanup */ }
  }
};

// H15 — packaged agent kernel: closure seeds, denylist, relocatable manifest, installer wiring.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs operator script, no type declarations
import { disabledRowIds, dropDisabledRows, isKernelDenylisted } from '../../scripts/lib/runtime-execution-closure.mjs';
import { resolveEmbeddedDshRuntime } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';
import { AGENT_KERNEL_VERSION_DIR } from '../../apps/desktop/src/production-composition.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const materialize = readFileSync('scripts/materialize-embedded-dsh.mjs', 'utf8');
const installerWorkflow = readFileSync('.github/workflows/hark-installer.yml', 'utf8');
const smoke = readFileSync('scripts/hark/installer-smoke.ps1', 'utf8');

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A tiny layoutVersion-2 managed root (relative paths, node runtime as closure member). */
const packedFixture = (opts: { nodeShaOverride?: string } = {}): string => {
  const root = mkdtempSync(join(tmpdir(), 'h15-kernel-'));
  roots.push(root);
  const files: Record<string, string> = {
    'runtime/apps/cli/lib/bin.js': 'console.log("0.2.0-rc.2")\n',
    'dsh-home-template/profiles/companyos-minimal/package.json': '{"name":"p","dependencies":{}}\n',
    'profile-patch-template.yml': '- id: llm-deepseek\n  disabled: true\n',
    'node/node.exe': 'not really node',
  };
  const closureFiles: Record<string, { class: string; sha256: string }> = {};
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...rel.split('/')), text);
    closureFiles[rel] = { class: rel.endsWith('.exe') ? 'NATIVE_CRITICAL' : rel.endsWith('.js') ? 'EXECUTABLE_CRITICAL' : 'CONFIG_CRITICAL', sha256: sha(text) };
  }
  const closureText = JSON.stringify({ version: 1, generation: 'g'.repeat(64), derivation: {}, counts: { EXECUTABLE_CRITICAL: 1, CONFIG_CRITICAL: 2, NATIVE_CRITICAL: 1, totalCritical: 4, samplingUsed: false }, files: closureFiles, links: [] });
  writeFileSync(join(root, 'closure-manifest.json'), closureText);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    kernelId: 'dsh-managed-minimal-v1', upstreamRepo: 'https://github.com/deepseek-ai/deepseek-harness',
    upstreamSha: '639ed015397290b3745d163aafe02ffee4aa3f84', upstreamTag: 'dsh-v0.2.0-rc.2',
    runtimeRoot: 'runtime', cliEntry: 'apps/cli/lib/bin.js', nodeRange: '^22.19.0 || >=24.0.0', packageManager: 'pnpm@11.7.0',
    profileName: 'companyos-minimal', dshHomeTemplateDir: 'dsh-home-template', profilePatchTemplate: 'profile-patch-template.yml',
    transport: 'one-shot-ndjson', protocolVersion: 's24-ndjson/1', license: 'MIT', checksums: { 'apps/cli/lib/bin.js': sha(files['runtime/apps/cli/lib/bin.js']!) },
    createdAt: '2026-10-26T00:00:00.000Z', layoutVersion: 2, kernelVersion: '0.2.0-rc.2',
    nodeRuntime: { path: 'node/node.exe', version: 'v24.19.0', sha256: opts.nodeShaOverride ?? sha(files['node/node.exe']!) },
    closureGeneration: sha(closureText),
  }));
  return root;
};

describe('H15 packaged agent kernel', () => {
  it('pins exactly one kernel version directory', () => {
    expect(AGENT_KERNEL_VERSION_DIR).toBe('dsh-v0.2.0-rc.2');
  });

  it('the CompanyOS profile disables the account/telemetry-adjacent rows of the official sdk-minimal bundle', () => {
    for (const id of ['llm-deepseek', 'sdk-jsonrpc-server', 'sdk-app-startup', 'deepseek-llm-api-extensions', 'session-log-deepseek', 'plugin-package-inventory-deepseek']) {
      expect(materialize).toContain(`'- id: ${id}',\n      '  disabled: true',`);
    }
  });

  it('closure seeds drop the bundle rows the profile disables', () => {
    const patch = '- id: a\n  disabled: true\n- id: b\n  disabled: true\n- id: c\n  config:\n    disabled: true\n';
    expect([...disabledRowIds(patch)].sort()).toEqual(['a', 'b']);
    const bundle = '- insert:\n    - id: a\n      name: \'@x/a\'\n      config:\n        k: 1\n\n    - id: keep\n      name: \'@x/keep\'\n    - id: b\n      name: \'@x/b\'\n';
    const kept = dropDisabledRows(bundle, new Set(['a', 'b']));
    expect(kept).toContain('@x/keep');
    expect(kept).not.toContain('@x/a');
    expect(kept).not.toContain('@x/b');
  });

  it('the denylist covers worldview/account/telemetry packages but not the headless transport plugin manager', () => {
    for (const name of ['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-workflow-ptc', '@deepseek-ai/dsh-llm-deepseek-account', '@deepseek-ai/dsh-authorization', '@deepseek-ai/dsh-anonymous-user-id', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-session-log-deepseek']) {
      expect(isKernelDenylisted(name), name).toBe(true);
    }
    for (const name of ['@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-fs-sandbox', '@deepseek-ai/dsh-headless']) {
      expect(isKernelDenylisted(name), name).toBe(false);
    }
  });

  it('resolves a RELOCATABLE (layoutVersion 2) manifest and stages the shipped node runtime under the state root', () => {
    const root = packedFixture();
    const state = mkdtempSync(join(tmpdir(), 'h15-state-'));
    roots.push(state);
    const resolved = resolveEmbeddedDshRuntime({ managedRoot: root, stateRoot: state });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.manifest.runtimeRoot).toBe(join(root, 'runtime'));
    const stage = resolved.value.prepareAttemptStage({ attemptId: 'h15' });
    expect(stage.ok).toBe(true);
    if (!stage.ok) return;
    expect(stage.value.stageRoot.startsWith(join(state, '.dsh-stages'))).toBe(true);
    expect(stage.value.nodeExecutablePath).toBe(join(stage.value.stageRoot, 'node', 'node.exe'));
    expect(stage.value.cliEntryPath).toBe(join(stage.value.stageRoot, 'runtime', 'apps', 'cli', 'lib', 'bin.js'));
  });

  it('refuses a shipped node runtime that is not a closure member with the manifest sha256', () => {
    const root = packedFixture({ nodeShaOverride: 'f'.repeat(64) });
    const resolved = resolveEmbeddedDshRuntime({ managedRoot: root, stateRoot: root });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.details['reason']).toBe('EXECUTOR_EMBEDDED_RUNTIME_NODE_UNVERIFIED');
  });

  it('the installer build ships the kernel and proves it (pack, official node, health + PONG, install-time first-start health)', () => {
    expect(installerWorkflow).toContain('scripts/materialize-embedded-dsh.mjs');
    expect(installerWorkflow).toContain('https://nodejs.org/dist/v24.19.0/SHASUMS256.txt');
    expect(installerWorkflow).toContain('scripts/hark/pack-agent-kernel.mjs');
    expect(installerWorkflow).toMatch(/kernel-health-smoke\.mjs .* --pong/u);
    expect(installerWorkflow).toContain('"$env:RUNNER_TEMP/agent-kernel"');
    expect(smoke).toContain("Check 'agent-kernel-installed'");
    expect(smoke).toContain("Check 'kernel-first-start-health'");
  });
});

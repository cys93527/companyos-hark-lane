/**
 * STAGE 4 — source-level architecture guards for the embedded kernel (only the
 * REAL new risks; no duplication of the existing ARCH laws).
 *
 * 1. The production resolver/adapters NEVER read ~/.dsh, never resolve a PATH
 *    `dsh`, and never consult a desktop installation implicitly.
 * 2. The rendered profile template structurally EXCLUDES the DSH worldview
 *    packages (goal/workflow/plan/agent-team/api/web/desktop/settings/telemetry/
 *    account-OAuth) — exclusion by absence, not by convention.
 * 3. The typed embedded provider config carries NO raw credential (the route
 *    value resolves through the broker; the composition declares only identity
 *    fields).
 * 4. No kernel package name leaks into the Core/Engine rings (the engine stays
 *    vendor-name-free; the kernel lives in the desktop composition only).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const walk = (current: string): readonly string[] =>
  readdirSync(current).flatMap((entry) => {
    const full = join(current, entry);
    return statSync(full).isDirectory() ? walk(full) : extname(full) === '.ts' ? [full] : [];
  });

const readSource = (file: string): string => readFileSync(file, 'utf8');

describe('STAGE 4 embedded kernel architecture guards (source-level)', () => {
  it('production NEVER reads ~/.dsh or resolves a PATH dsh implicitly', () => {
    const production = [
      ...walk(repoRoot('apps/desktop/src')),
    ];
    const offenders = production.filter((file) => {
      const source = readSource(file);
      // The embedded seam + adapters must not touch the user's dsh home or PATH.
      const forbidden = [
        /\.dsh['"]/u,               // ~/.dsh paths
        /homedir\(\)/u,             // home resolution in the kernel seam
        /which\(['"]dsh/u,          // PATH dsh discovery
      ];
      return forbidden.some((pattern) => pattern.test(source));
    });
    expect(offenders.map((file) => file.replace(repoRoot(''), ''))).toEqual([]);
    // The env-based EXTERNAL config loads ONLY behind the explicit opt-in sentinel —
    // never as a default call. (The sanctioned shape: `else if (externalDshRuntimeOptedIn())`
    // guards the single `resolveDshProviderConfig()` call site.)
    const composition = readSource(repoRoot('apps/desktop/src/core-services.ts'));
    const callSites = composition.split('resolveDshProviderConfig()').length - 1;
    expect(callSites).toBe(1);
    const guardIndex = composition.indexOf('} else if (externalDshRuntimeOptedIn()) {');
    const callIndex = composition.indexOf('resolveDshProviderConfig()');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(guardIndex);
  });

  it('the profile patch template structurally EXCLUDES every DSH worldview package', () => {
    const templatePath = repoRoot('.companyos-embedded/dsh-runtime/profile-patch-template.yml');
    if (!existsSync(templatePath)) return; // runtime not materialized on this machine
    const template = readSource(templatePath)
      .split(String.fromCharCode(10))
      .filter((line) => !line.trim().startsWith('#'))
      .join(String.fromCharCode(10));
    const forbidden = [
      'dsh-goal', 'dsh-workflow', 'dsh-plan', 'agent-team', 'dsh-api-',
      'dsh-web', 'dsh-client', 'dsh-host', 'dsh-desktop', 'dsh-settings',
      'dsh-telemetry', 'llm-deepseek-account', 'dsh-authorization', 'plugin-manager',
      'dsh-commands', 'marketplace',
    ];
    for (const name of forbidden) {
      expect(template.includes(name)).toBe(false);
    }
    // The minimal rows ARE present (fs tools, BYO llm seam, one-shot runner).
    expect(template.includes('dsh-fs-sandbox')).toBe(true);
    expect(template.includes('dsh-llm-pi-ai')).toBe(true);
    expect(template.includes('dsh-headless')).toBe(true);
  });

  it('the typed embedded config declares NO credential field (identity only; the broker holds the value)', () => {
    const composition = readSource(repoRoot('apps/desktop/src/core-services.ts'));
    const block = composition.slice(
      composition.indexOf('const embeddedTypedConfig = resolveExecutorConfig'),
      composition.indexOf('if (embeddedTypedConfig.ok)'),
    );
    // Precise patterns: the ENV NAME field (routeApiKeyEnv) is identity, not a
    // credential; what must never appear is the VALUE wiring or resolver call.
    const forbiddenPatterns = [
      /route\.apiKeyValue/u,
      /apiKeyResolver\(\)/u,
      /['"]sk-[a-zA-Z0-9]/u,
    ];
    for (const pattern of forbiddenPatterns) {
      expect(pattern.test(block)).toBe(false);
    }
  });

  it('no kernel/vendor package name leaks into the Core or Engine rings', () => {
    const rings = [...walk(repoRoot('packages/core/src')), ...walk(repoRoot('packages/engine/src'))];
    const offenders = rings.filter((file) => /deepseek-ai|dsh-/u.test(readSource(file)));
    expect(offenders.map((file) => file.replace(repoRoot(''), ''))).toEqual([]);
  });

  it('the materialization script pins the exact upstream identity (no latest/branch identities)', () => {
    const script = readSource(repoRoot('scripts/materialize-embedded-dsh.mjs'));
    expect(script.includes("'639ed015397290b3745d163aafe02ffee4aa3f84'")).toBe(true);
    expect(script.includes("'dsh-v0.2.0-rc.2'")).toBe(true);
    expect(/['"](latest|master|main)['"]/u.test(script)).toBe(false);
  });
});

/**
 * Hark lane H15 — Windows MAX_PATH root fix (hark-installer 40257828899: Inno Setup aborted
 * the per-user install because pnpm virtual-store names pushed kernel paths past 260).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs build script, no type declarations
import { KERNEL_RELATIVE_PATH_BUDGET, pnpmStoreRemap } from '../../scripts/hark/pack-agent-kernel.mjs';

const LONG = '@earendil-works+pi-ai@0.87.1_patch_hash=b9bcce474fb2ac44633dff0fa722816a5bff5451b4575d5_ecef9fb4cf2934d432845a5253d64a9c';

describe('H15 kernel path budget', () => {
  it('renames every pnpm virtual-store dir to a short deterministic id, consistently for files and junctions', () => {
    const paths = [
      `runtime/node_modules/.pnpm/${LONG}/node_modules/@earendil-works/pi-ai/dist/index.js`,
      `runtime/node_modules/.pnpm/${LONG}/node_modules/zod`,
      'runtime/node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js',
      'runtime/node_modules/.pnpm/node_modules/zod',
      'runtime/apps/cli/lib/bin.js',
    ];
    const a = pnpmStoreRemap(paths);
    const b = pnpmStoreRemap([...paths].reverse());
    expect(paths.map(a.shorten)).toEqual(paths.map(b.shorten));
    expect(a.shorten(paths[0])).toBe('runtime/node_modules/.pnpm/0/node_modules/@earendil-works/pi-ai/dist/index.js');
    expect(a.shorten(paths[1])).toBe('runtime/node_modules/.pnpm/0/node_modules/zod');
    expect(a.shorten(paths[2])).toBe('runtime/node_modules/.pnpm/1/node_modules/zod/index.js');
    // pnpm's hoisted `.pnpm/node_modules` is not a store entry and keeps its name.
    expect(a.shorten(paths[3])).toBe(paths[3]);
    expect(a.shorten(paths[4])).toBe(paths[4]);
    expect(a.table).toEqual({ 0: LONG, 1: 'zod@4.4.3' });
    expect(KERNEL_RELATIVE_PATH_BUDGET).toBeLessThanOrEqual(150);
  });

  it('the installer refuses an install dir that would exceed MAX_PATH, sized from the measured stage', () => {
    const iss = readFileSync('installer/companyos.iss', 'utf8');
    expect(iss).toMatch(/#error MaxRelPath is required/u);
    expect(iss).toMatch(/Limit := 259 - \{#MaxRelPath\} - 1;/u);
    expect(iss).toMatch(/chs\.InstallDirTooLong=/u);
    const wf = readFileSync('.github/workflows/hark-installer.yml', 'utf8');
    expect(wf.match(/measure-stage-paths\.mjs/gu)?.length).toBe(2);
    expect(wf.match(/\/DMaxRelPath=/gu)?.length).toBe(2);
  });

  it('native.job smoke reads the provider contract shape (structured.value) for the artifact digest', () => {
    const smoke = readFileSync('scripts/hark/native-job-smoke.mjs', 'utf8');
    expect(smoke).toMatch(/outcome\.structured\?\.value/u);
    expect(smoke).toMatch(/companyos\/native-result\/1/u);
  });
});

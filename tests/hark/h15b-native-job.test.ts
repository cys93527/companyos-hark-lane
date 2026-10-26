// H15b — native.job production wiring: packaged deployment data, routing, pack script.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NATIVE_INVENTORY_KIND,
  NATIVE_JOB_ROUTE,
  productionCompositionOptions,
  productionNativeJob,
} from '../../apps/desktop/src/production-composition.js';
import { NATIVE_JOB_PROVIDER_KEY } from '../../apps/desktop/src/executor/native-lifetime/native-job-composition.js';

const sha = (t: string | Buffer): string => createHash('sha256').update(t).digest('hex');
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const resources = (operations: unknown): string => {
  const root = mkdtempSync(join(tmpdir(), 'h15b-res-'));
  roots.push(root);
  mkdirSync(join(root, 'native'), { recursive: true });
  writeFileSync(join(root, 'native', 'operations.json'), JSON.stringify(operations));
  return root;
};
const packed = {
  schema: 'companyos.native-job-operations.v1',
  operations: {
    [NATIVE_INVENTORY_KIND]: {
      operationId: 'workspace-inventory',
      executable: { resource: 'agent-kernel/dsh-v0.2.0-rc.2/node/node.exe', sha256: 'a'.repeat(64) },
      inputs: [{ resource: 'native/operations/workspace-inventory.cjs', sha256: 'b'.repeat(64) }],
      args: ['{input:0}'],
      timeoutMs: 120000,
      environment: { TEMP: '{workspace}/.companyos/tmp', TMP: '{workspace}/.companyos/tmp' },
    },
  },
};

describe('H15b native.job production wiring', () => {
  it('the route target is exactly the provider key', () => {
    expect(NATIVE_JOB_ROUTE).toBe(NATIVE_JOB_PROVIDER_KEY);
  });
  it('no deployment data (dev tree) -> no native job option, no route', () => {
    const root = mkdtempSync(join(tmpdir(), 'h15b-empty-')); roots.push(root);
    expect(productionNativeJob(root)).toBeUndefined();
    const o = productionCompositionOptions({}, { nativeJobResourcesRoot: root });
    expect(o.nativeJob).toBeUndefined();
    expect(o.providerRoutes?.[NATIVE_INVENTORY_KIND]).toBeUndefined();
  });
  it('packaged data resolves against resources, keeps pins, substitutes {input:N}, adds SystemRoot', () => {
    const root = resources(packed);
    const job = productionNativeJob(root, { SystemRoot: 'C:\\Windows' })!;
    expect(job.bindingDir).toBe(join(root, 'native', 'koffi-3.3.3'));
    const op = job.operations[NATIVE_INVENTORY_KIND]!;
    expect(op.executable).toEqual({ path: join(root, 'agent-kernel', 'dsh-v0.2.0-rc.2', 'node', 'node.exe'), sha256: 'a'.repeat(64) });
    expect(op.args).toEqual([join(root, 'native', 'operations', 'workspace-inventory.cjs')]);
    expect(op.environment).toEqual({ SystemRoot: 'C:\\Windows', TEMP: '{workspace}/.companyos/tmp', TMP: '{workspace}/.companyos/tmp' });
  });
  it('routes each packaged kind to native.job and dispatches it through the provider seam', () => {
    const o = productionCompositionOptions({}, { nativeJobResourcesRoot: resources(packed) });
    expect(o.providerRoutes?.[NATIVE_INVENTORY_KIND]).toBe(NATIVE_JOB_ROUTE);
    expect(o.providerKinds).toContain(NATIVE_INVENTORY_KIND);
    expect(o.nativeJob?.operations[NATIVE_INVENTORY_KIND]).toBeDefined();
  });
  it('malformed or escaping deployment data throws (never silently ignored)', () => {
    expect(() => productionNativeJob(resources({ schema: 'x', operations: {} }))).toThrow(/malformed/u);
    const escape = structuredClone(packed) as typeof packed;
    escape.operations[NATIVE_INVENTORY_KIND].inputs = [{ resource: '../evil.js', sha256: 'b'.repeat(64) }];
    expect(() => productionNativeJob(resources(escape))).toThrow(/refused/u);
    const dangling = structuredClone(packed) as typeof packed;
    dangling.operations[NATIVE_INVENTORY_KIND].args = ['{input:3}'];
    expect(() => productionNativeJob(resources(dangling))).toThrow(/names no input/u);
  });
  it('the inventory operation script is deterministic CompanyOS code without network or child processes', () => {
    const script = readFileSync('scripts/hark/native-operations/workspace-inventory.cjs', 'utf8');
    expect(script).not.toMatch(/require\('node:(child_process|net|http|https|dns|tls)'\)/u);
    expect(script).toMatch(/companyos-inventory\.json/u);
    expect(sha(script)).toMatch(/^[0-9a-f]{64}$/u);
  });
  it('the installer build packs and ships native.job (koffi from the integrity-checked fetch) and smokes it', () => {
    const wf = readFileSync('.github/workflows/hark-installer.yml', 'utf8');
    expect(wf).toMatch(/pack-native-job\.mjs/u);
    expect(wf).toMatch(/KOFFI_SHA512/u);
    expect(wf).toMatch(/native-job-smoke\.mjs/u);
    const stage = readFileSync('scripts/hark/stage-desktop.mjs', 'utf8');
    expect(stage).toMatch(/resources', 'native'/u);
  });
});

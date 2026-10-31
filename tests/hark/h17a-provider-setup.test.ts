import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyProviderSetupOverlay,
  parseProviderSetupModel,
  readProviderSetup,
  PROVIDER_SETUP_DIR,
  PROVIDER_SETUP_KEY_FILE,
  PROVIDER_SETUP_MODEL_FILE,
} from '../../apps/desktop/src/provider-setup.js';
import { capCnyToMicros, parseProviderSetupProfile, PROVIDER_SETUP_CREDENTIAL_REF, readProviderSetupProfile, removeProviderSetup, writeProviderSetup as writeWithProfile, type ProviderSetupWriteInput } from '../../apps/desktop/src/provider-setup-write.js';
import { createDeploymentBudgetProofSource, readDeploymentBudgetApproval } from '../../apps/desktop/src/deployment-budget-proof.js';
import { createKoffiDpapiUnprotect, loadProviderSetupUnprotect } from '../../apps/desktop/src/provider-setup-dpapi.js';
import { resolveOpenAiCompatibleConfig } from '../../apps/desktop/src/models/openai-compatible-provider.js';
// @ts-expect-error -- plain ESM script without types
import { parseArgs } from '../../scripts/hark/setup/configure-provider.mjs';

/*
 * H17a: ordinary-user provider setup for the installed app. Trusted helper writes a DPAPI key file +
 * non-secret model.json + the user's budget approval; the main process overlays its environment
 * (deployment env wins whole), fail closed on anything partial or unreadable, never reporting values.
 */
const KEY = 'fake-key-for-h17a-0123456789';
// The shipped deployment profile (resources/setup/provider-profile.json) — vendor data lives there, not in source.
const PROFILE_PATH = join(__dirname, '../../scripts/hark/setup/provider-profile.json');
const PROFILE = readProviderSetupProfile(PROFILE_PATH);
const writeProviderSetup = (input: Omit<ProviderSetupWriteInput, 'profile'>): ReturnType<typeof writeWithProfile> => writeWithProfile({ ...input, profile: PROFILE });
// Test stand-in for DPAPI: a reversible XOR "protection" (the real one is CryptUnprotectData).
const protect = (s: string): Buffer => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a));
const unprotect = (blob: Uint8Array): Uint8Array => Buffer.from(Buffer.from(blob).map((b) => b ^ 0x5a));

const fresh = (): string => mkdtempSync(join(tmpdir(), 'h17a-'));
const writeKey = (userData: string, blob: Buffer): void => {
  mkdirSync(join(userData, PROVIDER_SETUP_DIR), { recursive: true });
  writeFileSync(join(userData, PROVIDER_SETUP_DIR, PROVIDER_SETUP_KEY_FILE), blob);
};
const configured = (capCny = 5, now = Date.now()): string => {
  const ud = fresh();
  writeKey(ud, protect(KEY));
  writeProviderSetup({ userDataDir: ud, capCny, approvedBy: 'alice', now });
  return ud;
};

describe('H17a provider setup — read', () => {
  it('nothing on disk is NOT_CONFIGURED and changes nothing', () => {
    const env: Record<string, string | undefined> = {};
    const setup = readProviderSetup(fresh(), unprotect);
    expect(setup).toEqual({ state: 'NOT_CONFIGURED' });
    expect(applyProviderSetupOverlay(env, setup)).toEqual({ source: 'none', setupState: 'NOT_CONFIGURED', reasonCode: null, applied: [] });
    expect(env).toEqual({});
  });

  it('a complete setup is CONFIGURED and overlays the model env the adapter resolves', () => {
    const ud = configured();
    const setup = readProviderSetup(ud, unprotect);
    expect(setup.state).toBe('CONFIGURED');
    const env: Record<string, string | undefined> = { PATH: '/bin' };
    const result = applyProviderSetupOverlay(env, setup);
    expect(result.source).toBe('provider-setup');
    expect(env['COS_MODEL_BASE_URL']).toBe('https://api.deepseek.com');
    expect(env['COS_MODEL_ID']).toBe('deepseek-flash');
    expect(env['COS_MODEL_PROVIDER_ID']).toBe('model.deepseek');
    expect(env['COS_MODEL_MAX_OUTPUT_TOKENS']).toBe('4096');
    expect(env['COMPANYOS_MODEL_API_KEY']).toBe(KEY);
    const resolved = resolveOpenAiCompatibleConfig(env);
    expect(resolved.ok).toBe(true);
    // the report carries names and states, never a value
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain('api.deepseek.com');
  });

  it('a deployment environment that declares ANY model field wins whole (no mixing)', () => {
    const ud = configured();
    const env: Record<string, string | undefined> = { COS_MODEL_BASE_URL: 'https://operator.example' };
    const result = applyProviderSetupOverlay(env, readProviderSetup(ud, unprotect));
    expect(result).toMatchObject({ source: 'environment', applied: [] });
    expect(env['COMPANYOS_MODEL_API_KEY']).toBeUndefined();
    expect(env['COS_MODEL_ID']).toBeUndefined();
  });

  it('partial or broken setups are INVALID with a typed reason and apply nothing', () => {
    const keyOnly = fresh();
    writeKey(keyOnly, protect(KEY));
    expect(readProviderSetup(keyOnly, unprotect)).toMatchObject({ state: 'INVALID', reasonCode: 'PROVIDER_SETUP_MODEL_INVALID' });

    const noKey = configured();
    const keyPath = join(noKey, PROVIDER_SETUP_DIR, PROVIDER_SETUP_KEY_FILE);
    writeFileSync(keyPath, Buffer.alloc(0));
    expect(readProviderSetup(noKey, unprotect)).toMatchObject({ state: 'INVALID', reasonCode: 'PROVIDER_SETUP_KEY_UNREADABLE' });

    const otherUser = configured();
    const failing = (): Uint8Array => { throw new Error('CryptUnprotectData 0x8009000B'); };
    const r = readProviderSetup(otherUser, failing);
    expect(r).toMatchObject({ state: 'INVALID', reasonCode: 'PROVIDER_SETUP_KEY_UNREADABLE' });
    expect(JSON.stringify(r)).not.toContain(KEY);

    expect(readProviderSetup(configured(), null)).toMatchObject({ state: 'INVALID', reasonCode: 'PROVIDER_SETUP_UNPROTECT_UNAVAILABLE' });

    const badKey = configured();
    writeKey(badKey, protect('has space key 123'));
    expect(readProviderSetup(badKey, unprotect)).toMatchObject({ state: 'INVALID', reasonCode: 'PROVIDER_SETUP_KEY_UNREADABLE' });

    const corrupt = configured();
    writeFileSync(join(corrupt, PROVIDER_SETUP_DIR, PROVIDER_SETUP_MODEL_FILE), '{not json');
    const env: Record<string, string | undefined> = {};
    const res = applyProviderSetupOverlay(env, readProviderSetup(corrupt, unprotect));
    expect(res).toMatchObject({ source: 'none', setupState: 'INVALID', reasonCode: 'PROVIDER_SETUP_MODEL_INVALID' });
    expect(env).toEqual({});

    const missingKey = fresh();
    writeProviderSetup({ userDataDir: missingKey, capCny: 1, approvedBy: 'alice' });
    expect(readProviderSetup(missingKey, unprotect)).toMatchObject({ state: 'INVALID', reasonCode: 'PROVIDER_SETUP_KEY_MISSING' });
  });

  it('model.json accepts only https endpoints without credentials and bounded numbers', () => {
    const base = JSON.parse(readFileSync(join(configured(), PROVIDER_SETUP_DIR, PROVIDER_SETUP_MODEL_FILE), 'utf8')) as Record<string, unknown>;
    expect(parseProviderSetupModel(base)).not.toBeNull();
    expect(parseProviderSetupModel({ ...base, baseUrl: 'http://api.deepseek.com' })).toBeNull();
    expect(parseProviderSetupModel({ ...base, baseUrl: 'https://u:p@api.deepseek.com' })).toBeNull();
    expect(parseProviderSetupModel({ ...base, maxOutputTokens: 100_000 })).toBeNull();
    expect(parseProviderSetupModel({ ...base, providerId: 'deepseek' })).toBeNull();
    expect(parseProviderSetupModel({ ...base, schema: 'other' })).toBeNull();
  });
});

describe('H17a provider setup — write', () => {
  it('writes an approval + proof the deployment budget source trusts, with the user cap', async () => {
    const now = Date.now();
    const ud = configured(2.5, now);
    const approval = readDeploymentBudgetApproval(join(ud, 'budget'));
    expect(approval).not.toBeNull();
    expect(approval!.cap.maxCostMicros).toBe(2_500_000);
    expect(approval!.approvedBy).toBe('alice');
    const deployment = createDeploymentBudgetProofSource(join(ud, 'budget'), () => now);
    expect(deployment).toBeDefined();
    const identity = await deployment!.source.identify({
      providerId: 'model.deepseek', modelId: 'deepseek-flash', endpoint: 'https://api.deepseek.com/', credentialRef: PROVIDER_SETUP_CREDENTIAL_REF,
    } as Parameters<NonNullable<typeof deployment>["source"]["identify"]>[0]);
    expect(identity).not.toBeNull();
    const ref = await deployment!.source.select(identity!);
    expect(ref).toBe(approval!.proofs[0]);
    // the key never lands in any non-secret file
    for (const f of [join(ud, PROVIDER_SETUP_DIR, PROVIDER_SETUP_MODEL_FILE), join(ud, 'budget', 'approvals.json')]) expect(readFileSync(f, 'utf8')).not.toContain(KEY);
  });

  it('the price proof expires (re-attested by re-running setup)', async () => {
    const now = Date.now();
    const ud = configured(5, now);
    const later = createDeploymentBudgetProofSource(join(ud, 'budget'), () => now + PROFILE.proofValidForMs + 1);
    const identity = await later!.source.identify({ providerId: 'model.deepseek', modelId: 'deepseek-flash' } as Parameters<NonNullable<typeof later>['source']['identify']>[0]);
    expect(identity).toBeNull();
  });

  it('refuses caps outside 0.1..100 CNY and bad approvers', () => {
    expect(capCnyToMicros(0.1)).toBe(100_000);
    expect(capCnyToMicros(100)).toBe(100_000_000);
    for (const bad of [0, 0.05, 101, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => capCnyToMicros(bad)).toThrow(/between/u);
    expect(() => writeProviderSetup({ userDataDir: fresh(), capCny: 5, approvedBy: 'bad"name' })).toThrow(/local account/u);
  });

  it('remove deletes the user files and only an approval the helper wrote', () => {
    const ud = configured();
    expect(removeProviderSetup(ud, PROFILE).removed).toEqual(['provider/model.json', 'provider/model-api-key.dpapi', 'budget/approvals.json']);
    expect(readProviderSetup(ud, unprotect)).toEqual({ state: 'NOT_CONFIGURED' });

    const op = fresh();
    mkdirSync(join(op, 'budget'), { recursive: true });
    const operator = JSON.parse(readFileSync(join(configured(), 'budget', 'approvals.json'), 'utf8')) as { billingScope: { account: string } };
    operator.billingScope.account = 'deepseek:repo-secret:COMPANYOS_MODEL_API_KEY';
    writeFileSync(join(op, 'budget', 'approvals.json'), JSON.stringify(operator));
    expect(removeProviderSetup(op, PROFILE).removed).toEqual([]);
    expect(existsSync(join(op, 'budget', 'approvals.json'))).toBe(true);
  });
});

describe('H17a provider profile is deployment data', () => {
  it('the shipped profile parses; any shape defect is refused whole', () => {
    const raw = JSON.parse(readFileSync(PROFILE_PATH, 'utf8')) as Record<string, unknown>;
    expect(parseProviderSetupProfile(raw)).not.toBeNull();
    expect(parseProviderSetupProfile({ ...raw, extra: 1 })).toBeNull();
    expect(parseProviderSetupProfile({ ...raw, baseUrl: 'http://api.deepseek.com' })).toBeNull();
    expect(parseProviderSetupProfile({ ...raw, maxCalls: 0 })).toBeNull();
    expect(parseProviderSetupProfile({ ...raw, pricing: { ...(raw['pricing'] as object), currency: 'USD' } })).toBeNull();
    expect(parseProviderSetupProfile({ ...raw, schema: 'other' })).toBeNull();
    const { billingAccount: _drop, ...missing } = raw;
    expect(parseProviderSetupProfile(missing)).toBeNull();
    expect(() => writeWithProfile({ userDataDir: fresh(), capCny: 1, approvedBy: 'alice', profile: { ...PROFILE, modelId: '' } })).toThrow(/profile/u);
    expect(() => readProviderSetupProfile(join(fresh(), 'none.json'))).toThrow(/profile/u);
  });
});

describe('H17a DPAPI port over koffi (call shape)', () => {
  it('marshals DATA_BLOB, copies plaintext out, zeroes it and frees DPAPI memory', () => {
    const calls: string[] = [];
    const memory = new Map<bigint, Buffer>();
    let next = 0x1000n;
    const alloc = (n: number): bigint => { const p = next; next += 0x1000n; memory.set(p, Buffer.alloc(n)); return p; };
    const funcs: Record<string, (...a: unknown[]) => unknown> = {
      GetLastError: () => 0,
      GetProcessHeap: () => 7n,
      HeapAlloc: (_h, _f, n) => alloc(Number(n)),
      HeapFree: (_h, _f, p) => { calls.push(`HeapFree:${String(p)}`); return 1; },
      LocalFree: (p) => { calls.push(`LocalFree:${String(p)}`); return 0n; },
      CryptUnprotectData: (dataIn, _d, _e, _r, _p, flags, dataOut) => {
        calls.push(`Unprotect:flags=${String(flags)}`);
        const inBlob = dataIn as Buffer;
        const src = memory.get(inBlob.readBigUInt64LE(8))!.subarray(0, inBlob.readUInt32LE(0));
        const plain = unprotect(src);
        const p = alloc(plain.length);
        Buffer.from(plain).copy(memory.get(p)!);
        (dataOut as Buffer).writeUInt32LE(plain.length, 0);
        (dataOut as Buffer).writeBigUInt64LE(p, 8);
        return 1;
      },
    };
    const koffi = {
      version: '3.3.3',
      sizeof: () => 8,
      load: (path: string) => ({
        func: (decl: string) => {
          const name = /__stdcall (\w+)\(/u.exec(decl)![1]!;
          if (name === 'RtlMoveMemory') {
            return decl.includes('uintptr_t dst')
              ? (dst: unknown, src: unknown, n: unknown) => { (src as Buffer).copy(memory.get(dst as bigint)!, 0, 0, Number(n)); }
              : (dst: unknown, src: unknown, n: unknown) => { memory.get(src as bigint)!.copy(dst as Buffer, 0, 0, Number(n)); };
          }
          calls.push(`declare:${path.endsWith('crypt32.dll') ? 'crypt32' : 'kernel32'}:${name}`);
          return funcs[name]!;
        },
      }),
    };
    const fn = createKoffiDpapiUnprotect(koffi, '3.3.3', { platform: 'win32', arch: 'x64' }, 'C:\\Windows');
    const out = fn(protect(KEY));
    expect(Buffer.from(out).toString('utf8')).toBe(KEY);
    expect(calls).toContain('Unprotect:flags=1');
    const outPtr = [...memory.keys()][1]!;
    expect(memory.get(outPtr)!.every((b) => b === 0)).toBe(true); // plaintext zeroed before LocalFree
    expect(calls.filter((c) => c.startsWith('LocalFree') || c.startsWith('HeapFree'))).toHaveLength(2);
  });

  it('refuses non-Windows hosts and unverified bindings (null unprotect, no require)', async () => {
    expect(() => createKoffiDpapiUnprotect({ version: '3.3.3', sizeof: () => 8, load: () => { throw new Error('no'); } }, '3.3.3', { platform: 'linux', arch: 'x64' })).toThrow(/unsupported-host/u);
    expect((await loadProviderSetupUnprotect('/nowhere', { platform: 'linux', arch: 'arm64' })).unprotect).toBeNull();
    let required = false;
    const r = await loadProviderSetupUnprotect(fresh(), { platform: 'win32', arch: 'x64' }, () => { required = true; throw new Error('x'); });
    expect(r.unprotect).toBeNull();
    expect(r.detail).toMatch(/manifest missing/u);
    expect(required).toBe(false);
  });
});

describe('H17a trusted helper scripts', () => {
  const ps1 = readFileSync(join(__dirname, '../../scripts/hark/setup/configure-deepseek.ps1'), 'utf8');
  it('PowerShell helper: secure prompt, DPAPI CurrentUser, key never passed to the node half, UTF-8 BOM', () => {
    expect(ps1.charCodeAt(0)).toBe(0xfeff);
    expect(ps1).toContain('Read-Host -AsSecureString');
    expect(ps1).toContain('[Security.Cryptography.DataProtectionScope]::CurrentUser');
    expect(ps1).toContain('ZeroFreeBSTR');
    expect(ps1).not.toMatch(/[\u201c\u201d\u2018\u2019]/u); // PowerShell treats smart quotes as string delimiters
    const nodeCalls = ps1.split('\n').filter((l) => l.includes("Invoke-SetupNode @("));
    expect(nodeCalls.length).toBe(2);
    for (const l of nodeCalls) expect(l).not.toMatch(/plain|bytes|blob|secure/iu);
    expect(ps1).not.toMatch(/\$env:COMPANYOS_MODEL_API_KEY\s*=/u);
  });
  it('node half argument contract', () => {
    expect(parseArgs(['write', '--user-data', 'C:\\u', '--cap-cny', '5', '--approved-by', 'alice'])).toEqual({ command: 'write', 'user-data': 'C:\\u', 'cap-cny': '5', 'approved-by': 'alice' });
    expect(() => parseArgs(['write', '--user-data', 'C:\\u'])).toThrow(/cap-cny/u);
    expect(() => parseArgs(['write', '--api-key', 'x'])).toThrow(/unknown/u);
    expect(() => parseArgs(['steal'])).toThrow(/command/u);
  });
});

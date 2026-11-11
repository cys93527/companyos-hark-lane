/**
 * UI-AUDIT-3 — 设置 → 模型服务 (in-app API key, provider and budget). No real network, no real
 * DPAPI, no model calls: protect/unprotect are an XOR fake, fetch is a fake, confirm is a fake
 * standing in for main's native dialog.
 *
 * Pins:
 *   - the key goes one way: it is never in a result, a status, a log line, model.json, the
 *     approval or the proof — only "****" + its last 4 reach the renderer;
 *   - the budget approval / removal / restart happen ONLY when the main-owned confirm says yes;
 *   - nothing but main.ts reaches the service, and no control-plane / workflow / runtime / tool
 *     path can name it (the agent cannot approve its own budget);
 *   - only the app window's top frame passes the IPC sender check;
 *   - the connection test is GET /models (never a model call) and maps statuses to plain codes;
 *   - CryptProtectData is called with CurrentUser scope (flags = UI_FORBIDDEN only) and the
 *     plaintext copy is zeroed before HeapFree.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createProviderSettingsIpcHandler,
  createProviderSettingsService,
  keyHintOf,
  providerSettingsConfirmText,
  providerSettingsFingerprint,
  type ProviderSettingsConfirm,
  type ProviderSettingsDeps,
} from '../../apps/desktop/src/provider-settings.js';
import { readProviderSetupProfile } from '../../apps/desktop/src/provider-setup-write.js';
import { readProviderSetup } from '../../apps/desktop/src/provider-setup.js';
import { readDeploymentBudgetApproval } from '../../apps/desktop/src/deployment-budget-proof.js';
import { createKoffiDpapiProtect } from '../../apps/desktop/src/provider-setup-dpapi.js';
import { CHANNELS } from '../../apps/desktop/src/channels.js';

const PROFILE = readProviderSetupProfile(join(__dirname, '../../scripts/hark/setup/provider-profile.json'));
const KEY = 'fake-key-for-ui-audit-3-0123456789abcdWXYZ';
const KEY2 = 'fake-key-for-ui-audit-3-second-key-7777';
const xor = (b: Uint8Array): Uint8Array => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a));
const fresh = (): string => mkdtempSync(join(tmpdir(), 'ua3-'));

interface Harness {
  readonly dir: string;
  readonly confirms: ProviderSettingsConfirm[];
  readonly logs: string[];
  readonly fetches: { url: string; headers: Readonly<Record<string, string>> }[];
  readonly relaunches: number[];
  readonly service: ReturnType<typeof createProviderSettingsService>;
}

const harness = (over: Partial<ProviderSettingsDeps> & { answer?: boolean; fetchStatus?: number; fetchBody?: unknown; fetchThrows?: boolean } = {}): Harness => {
  const dir = over.userDataDir ?? fresh();
  const confirms: ProviderSettingsConfirm[] = [];
  const logs: string[] = [];
  const fetches: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const relaunches: number[] = [];
  const service = createProviderSettingsService({
    userDataDir: dir,
    readShippedProfile: () => PROFILE,
    protect: xor,
    unprotect: xor,
    environmentDeclared: false,
    appliedFingerprint: providerSettingsFingerprint(dir),
    confirm: async (request) => {
      confirms.push(request);
      return over.answer ?? true;
    },
    fetch: async (url, init) => {
      fetches.push({ url, headers: init.headers });
      if (over.fetchThrows === true) throw new Error('network');
      return { status: over.fetchStatus ?? 200, json: async () => over.fetchBody ?? { data: [{ id: PROFILE.modelId }] } };
    },
    approvedBy: 'tester',
    relaunch: () => relaunches.push(1),
    log: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
    ...over,
  });
  return { dir, confirms, logs, fetches, relaunches, service };
};

/** Every byte under dir (all files), as latin1 text, for "the key is nowhere" checks. */
const allFileText = (dir: string): string => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p).toString('latin1'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.join('\n');
};

describe('UI-AUDIT-3 provider settings: save (key one way, budget only by the user)', () => {
  it('preset save: writes the DPAPI key file + model + approval, the key appears nowhere else, status shows ****last4', async () => {
    const h = harness();
    const r = await h.service.handle('save', { mode: 'preset', apiKey: KEY, capCny: 3 });
    expect(r.ok).toBe(true);
    expect(h.confirms).toEqual([expect.objectContaining({ kind: 'approve-budget', capCny: 3, modelId: PROFILE.modelId, keyChanged: true })]);
    const setup = readProviderSetup(h.dir, xor);
    expect(setup.state).toBe('CONFIGURED');
    expect(setup.state === 'CONFIGURED' ? setup.apiKey : '').toBe(KEY);
    expect(readDeploymentBudgetApproval(join(h.dir, 'budget'))?.cap.maxCostMicros).toBe(3_000_000);
    // the key: not in the result, the status, the logs, or any file in plain form
    const everywhere = [JSON.stringify(r), JSON.stringify(h.service.status()), h.logs.join('\n'), allFileText(h.dir)].join('\n');
    expect(everywhere).not.toContain(KEY);
    expect(everywhere).not.toContain(KEY.slice(0, 20));
    expect(r.status?.keyHint).toBe('****WXYZ');
    expect(r.status?.capCny).toBe(3);
    expect(r.status?.service).toEqual(expect.objectContaining({ kind: 'preset', modelId: PROFILE.modelId }));
    expect(r.restartRequired).toBe(true);
    expect(h.logs.every((line) => /^provider settings \{"operation":"\w+","code":"\w+"\}$/u.test(line))).toBe(true);
  });

  it('the user cancelling the main-owned confirm writes NOTHING (no key, no approval)', async () => {
    const h = harness({ answer: false });
    const r = await h.service.handle('save', { mode: 'preset', apiKey: KEY, capCny: 50 });
    expect(r).toEqual(expect.objectContaining({ ok: false, code: 'CANCELLED' }));
    expect(h.confirms).toHaveLength(1);
    expect(existsSync(join(h.dir, 'provider'))).toBe(false);
    expect(readDeploymentBudgetApproval(join(h.dir, 'budget'))).toBeNull();
  });

  it('raising the budget of an existing setup also needs the confirm; cancel keeps the old cap', async () => {
    const h = harness();
    await h.service.handle('save', { mode: 'preset', apiKey: KEY, capCny: 2 });
    const declining = harness({ userDataDir: h.dir, answer: false });
    expect((await declining.service.handle('save', { mode: 'preset', capCny: 90 })).code).toBe('CANCELLED');
    expect(readDeploymentBudgetApproval(join(h.dir, 'budget'))?.cap.maxCostMicros).toBe(2_000_000);
    const approving = harness({ userDataDir: h.dir });
    const r = await approving.service.handle('save', { mode: 'preset', capCny: 9 });
    expect(r.ok).toBe(true);
    expect(approving.confirms[0]).toEqual(expect.objectContaining({ kind: 'approve-budget', capCny: 9, keyChanged: false }));
    expect(readDeploymentBudgetApproval(join(h.dir, 'budget'))?.cap.maxCostMicros).toBe(9_000_000);
    // the stored key was kept (empty field = keep)
    const setup = readProviderSetup(h.dir, xor);
    expect(setup.state === 'CONFIGURED' ? setup.apiKey : '').toBe(KEY);
  });

  it('custom OpenAI-compatible service: user price into the proof; replacing the key replaces it', async () => {
    const h = harness();
    const r = await h.service.handle('save', { mode: 'custom', baseUrl: 'https://llm.example.test/v1/', modelId: 'chat-x', inputCnyPerM: 1.5, outputCnyPerM: 6, apiKey: KEY, capCny: 4 });
    expect(r.ok).toBe(true);
    expect(r.status?.service).toEqual(expect.objectContaining({ kind: 'custom', baseUrl: 'https://llm.example.test/v1', modelId: 'chat-x', inputCnyPerM: 1.5, outputCnyPerM: 6 }));
    const again = await h.service.handle('save', { mode: 'custom', baseUrl: 'https://llm.example.test/v1', modelId: 'chat-x', inputCnyPerM: 1.5, outputCnyPerM: 6, apiKey: KEY2, capCny: 4 });
    expect(again.status?.keyHint).toBe('****7777');
    const setup = readProviderSetup(h.dir, xor);
    expect(setup.state === 'CONFIGURED' ? setup.apiKey : '').toBe(KEY2);
  });

  it('refuses invalid input BEFORE asking the user (no dialog for a request that cannot be saved)', async () => {
    const h = harness();
    const cases: [unknown, string][] = [
      [{ mode: 'preset', capCny: 3 }, 'KEY_REQUIRED'],
      [{ mode: 'preset', apiKey: 'has space key', capCny: 3 }, 'KEY_INVALID'],
      [{ mode: 'preset', apiKey: KEY, capCny: 1000 }, 'CAP_INVALID'],
      [{ mode: 'custom', baseUrl: 'http://plain.example', modelId: 'm', inputCnyPerM: 1, outputCnyPerM: 1, apiKey: KEY, capCny: 3 }, 'SERVICE_INVALID'],
      [{ mode: 'custom', baseUrl: 'https://u:p@x.example', modelId: 'm', inputCnyPerM: 1, outputCnyPerM: 1, apiKey: KEY, capCny: 3 }, 'SERVICE_INVALID'],
      [{ mode: 'custom', baseUrl: 'https://x.example', modelId: 'm', inputCnyPerM: 0, outputCnyPerM: 1, apiKey: KEY, capCny: 3 }, 'PRICE_INVALID'],
      [{ mode: 'preset', apiKey: KEY, capCny: 3, extra: 1 }, 'INVALID_REQUEST'],
      ['not an object', 'INVALID_REQUEST'],
    ];
    for (const [payload, code] of cases) {
      const r = await h.service.handle('save', payload);
      expect(r.code, JSON.stringify(payload)).toBe(code);
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
    expect(h.confirms).toHaveLength(0);
    expect(existsSync(join(h.dir, 'provider'))).toBe(false);
  });

  it('a deployment environment that declares the model owns it: settings refuse to save', async () => {
    const h = harness({ environmentDeclared: true });
    expect((await h.service.handle('save', { mode: 'preset', apiKey: KEY, capCny: 3 })).code).toBe('ENVIRONMENT_MANAGED');
    expect(h.service.status().source).toBe('environment');
    expect(h.confirms).toHaveLength(0);
  });

  it('a host without DPAPI cannot take a key in-app (and says so); nothing is written', async () => {
    const h = harness({ protect: null, unprotect: null });
    expect((await h.service.handle('save', { mode: 'preset', apiKey: KEY, capCny: 3 })).code).toBe('KEY_ENTRY_UNSUPPORTED');
    expect(h.service.status().keyEntrySupported).toBe(false);
    expect(existsSync(join(h.dir, 'provider'))).toBe(false);
  });

  it('a failed write leaves the previous setup exactly as it was (key file restored)', async () => {
    const h = harness();
    await h.service.handle('save', { mode: 'preset', apiKey: KEY, capCny: 2 });
    const before = readFileSync(join(h.dir, 'provider', 'model-api-key.dpapi'));
    const approvalBefore = readFileSync(join(h.dir, 'budget', 'approvals.json'));
    // a reader that cannot read back what was written = verify failure after the write
    const broken = harness({ userDataDir: h.dir, unprotect: () => { throw new Error('nope'); } });
    const r = await broken.service.handle('save', { mode: 'preset', apiKey: KEY2, capCny: 7 });
    expect(r.code).toBe('WRITE_FAILED');
    expect(readFileSync(join(h.dir, 'budget', 'approvals.json')).equals(approvalBefore)).toBe(true);
    expect(readFileSync(join(h.dir, 'provider', 'model-api-key.dpapi')).equals(before)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(KEY2);
  });
});

describe('UI-AUDIT-3 provider settings: test connection (GET /models, never a model call)', () => {
  it('uses the typed key over https GET {base}/models and reports whether the model is listed', async () => {
    const h = harness();
    const r = await h.service.handle('test', { mode: 'custom', baseUrl: 'https://llm.example.test/v1', modelId: 'chat-x', apiKey: KEY });
    expect(h.fetches).toEqual([{ url: 'https://llm.example.test/v1/models', headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } }]);
    expect(r).toEqual(expect.objectContaining({ ok: true, code: 'OK', modelListed: false }));
    expect(JSON.stringify(r) + h.logs.join('')).not.toContain(KEY);
  });
  it('falls back to the stored key; maps 401/404/5xx/network to plain codes', async () => {
    const h = harness();
    await h.service.handle('save', { mode: 'preset', apiKey: KEY, capCny: 2 });
    for (const [status, code] of [[401, 'KEY_REJECTED'], [403, 'KEY_REJECTED'], [404, 'ENDPOINT_NOT_FOUND'], [502, 'HTTP_ERROR']] as const) {
      const t = harness({ userDataDir: h.dir, fetchStatus: status });
      const r = await t.service.handle('test', { mode: 'preset' });
      expect(r.code).toBe(code);
      expect(t.fetches[0]?.headers['Authorization']).toBe(`Bearer ${KEY}`);
      expect(t.fetches[0]?.url).toBe(`${PROFILE.baseUrl}/models`);
    }
    expect((await harness({ userDataDir: h.dir, fetchThrows: true }).service.handle('test', { mode: 'preset' })).code).toBe('UNREACHABLE');
    expect((await harness({ userDataDir: h.dir }).service.handle('test', { mode: 'preset' })).modelListed).toBe(true);
  });
  it('no key anywhere = KEY_REQUIRED without any request', async () => {
    const h = harness();
    expect((await h.service.handle('test', { mode: 'preset' })).code).toBe('KEY_REQUIRED');
    expect(h.fetches).toHaveLength(0);
  });
  it('a hung service times out (abort) as TIMEOUT', async () => {
    const h = harness({
      testTimeoutMs: 5,
      fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    expect((await h.service.handle('test', { mode: 'preset', apiKey: KEY })).code).toBe('TIMEOUT');
  });
});

describe('UI-AUDIT-3 provider settings: remove / restart need the user; IPC sender + shape', () => {
  it('remove asks first; cancel keeps everything, yes removes key + model + own approval', async () => {
    const h = harness();
    await h.service.handle('save', { mode: 'preset', apiKey: KEY, capCny: 2 });
    expect((await harness({ userDataDir: h.dir, answer: false }).service.handle('remove', undefined)).code).toBe('CANCELLED');
    expect(existsSync(join(h.dir, 'provider', 'model-api-key.dpapi'))).toBe(true);
    const yes = harness({ userDataDir: h.dir });
    const r = await yes.service.handle('remove', undefined);
    expect(r.ok).toBe(true);
    expect(yes.confirms).toEqual([{ kind: 'remove' }]);
    expect(existsSync(join(h.dir, 'provider', 'model-api-key.dpapi'))).toBe(false);
    expect(readDeploymentBudgetApproval(join(h.dir, 'budget'))).toBeNull();
  });
  it('restart relaunches only after the confirm', async () => {
    const no = harness({ answer: false });
    expect((await no.service.handle('restart', undefined)).code).toBe('CANCELLED');
    expect(no.relaunches).toHaveLength(0);
    const yes = harness();
    expect((await yes.service.handle('restart', undefined)).ok).toBe(true);
    expect(yes.relaunches).toHaveLength(1);
  });
  it('the IPC handler refuses any sender but the app window top frame, and any unknown shape', async () => {
    const h = harness();
    const ipc = createProviderSettingsIpcHandler(h.service, (event) => event === 'app-window');
    expect((await ipc('other-frame', { operation: 'save', payload: { mode: 'preset', apiKey: KEY, capCny: 3 } })).code).toBe('UNTRUSTED_SENDER');
    expect(h.confirms).toHaveLength(0);
    expect((await ipc('app-window', { operation: 'approveBudget', payload: {} })).code).toBe('INVALID_REQUEST');
    expect((await ipc('app-window', { operation: 'status', payload: {}, extra: 1 })).code).toBe('INVALID_REQUEST');
    const request = { operation: 'save', payload: { mode: 'preset', apiKey: KEY, capCny: 3 } as Record<string, unknown> };
    expect((await ipc('app-window', request)).ok).toBe(true);
    expect('apiKey' in request.payload).toBe(false); // dropped from the request object after use
  });
  it('the confirm dialog text is built from validated values only and states the cap and price', () => {
    const t = providerSettingsConfirmText({ kind: 'approve-budget', capCny: 5, host: 'llm.example.test', modelId: 'chat-x', inputCnyPerM: 2, outputCnyPerM: 8, keyChanged: true });
    expect(t.message).toBe('批准每个目标最多花费 5 元？');
    expect(t.detail).toContain('llm.example.test · chat-x');
    expect(t.detail).toContain('输入 2 元，输出 8 元');
    expect(t.confirmLabel).toBe('批准并保存');
    expect(keyHintOf(KEY)).toBe('****WXYZ');
    expect(keyHintOf('short')).toBeNull();
  });
});

describe('UI-AUDIT-3: the agent / runtime / tools have no route to the budget approval', () => {
  const src = join(__dirname, '../../apps/desktop/src');
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|js)$/u.test(name)) files.push(p);
    }
  };
  walk(src);
  it('only main.ts imports the provider-settings service (no executor, autonomy, control plane, workflow or kernel module)', () => {
    const importers = files.filter((p) => /from '\.{1,2}\/(?:[\w-]+\/)*provider-settings\.js'/u.test(readFileSync(p, 'utf8'))).map((p) => relative(src, p));
    expect(importers).toEqual(['main.ts']);
  });
  it('the service is registered on its own IPC channel only; the control-plane and workflow handlers do not name it', () => {
    const main = readFileSync(join(src, 'main.ts'), 'utf8');
    expect((main.match(/ipcMain\.handle\(CHANNELS\.providerSettings/gu) ?? []).length).toBe(1);
    for (const name of ['control-plane.ts', 'control-plane-ipc.ts', 'workflows.ts', 'core-services.ts']) {
      const text = readFileSync(join(src, name), 'utf8');
      expect(text, name).not.toMatch(/provider-settings|providerSettings|writeProviderSetup|approvals\.json/u);
    }
    expect(CHANNELS.providerSettings).toBe('companyos:provider-settings');
  });
  it('the main-process confirm is a native dialog on the app window (not a renderer callback)', () => {
    const main = readFileSync(join(src, 'main.ts'), 'utf8');
    const block = main.slice(main.indexOf('confirm: async (request) =>'), main.indexOf('fetch: async (url, init)'));
    expect(block).toContain('dialog.showMessageBox');
    expect(block).toContain('answer.response === 1');
    expect(block).not.toMatch(/webContents\.send|ipcMain|executeJavaScript/u);
  });
});

describe('UI-AUDIT-3 DPAPI protect over koffi (call shape)', () => {
  it('CryptProtectData with CurrentUser scope (flags = UI_FORBIDDEN only), plaintext copy zeroed, both buffers freed', () => {
    const calls: string[] = [];
    const memory = new Map<bigint, Buffer>();
    let next = 0x1000n;
    const alloc = (n: number): bigint => { const p = next; next += 0x1000n; memory.set(p, Buffer.alloc(n)); return p; };
    let inPtr = 0n;
    const funcs: Record<string, (...a: unknown[]) => unknown> = {
      GetLastError: () => 0,
      GetProcessHeap: () => 7n,
      HeapAlloc: (_h, _f, n) => { inPtr = alloc(Number(n)); return inPtr; },
      HeapFree: (_h, _f, p) => { calls.push(`HeapFree:${String(p)}`); return 1; },
      LocalFree: (p) => { calls.push(`LocalFree:${String(p)}`); return 0n; },
      CryptProtectData: (dataIn, _d, _e, _r, _p, flags, dataOut) => {
        calls.push(`Protect:flags=${String(flags)}`);
        const inBlob = dataIn as Buffer;
        const plain = memory.get(inBlob.readBigUInt64LE(8))!.subarray(0, inBlob.readUInt32LE(0));
        const blob = xor(plain);
        const p = alloc(blob.length);
        Buffer.from(blob).copy(memory.get(p)!);
        (dataOut as Buffer).writeUInt32LE(blob.length, 0);
        (dataOut as Buffer).writeBigUInt64LE(p, 8);
        return 1;
      },
    };
    const koffi = {
      version: '3.3.3',
      sizeof: () => 8,
      load: () => ({
        func: (decl: string) => {
          const name = /__stdcall (\w+)\(/u.exec(decl)![1]!;
          if (name === 'RtlMoveMemory') {
            return decl.includes('uintptr_t dst')
              ? (dst: unknown, src: unknown, n: unknown) => { (src as Buffer).copy(memory.get(dst as bigint)!, 0, 0, Number(n)); }
              : (dst: unknown, src: unknown, n: unknown) => { memory.get(src as bigint)!.copy(dst as Buffer, 0, 0, Number(n)); };
          }
          return funcs[name]!;
        },
      }),
    };
    const protect = createKoffiDpapiProtect(koffi, '3.3.3', { platform: 'win32', arch: 'x64' }, 'C:\\Windows');
    const blob = protect(Buffer.from(KEY, 'utf8'));
    expect(Buffer.from(xor(blob)).toString('utf8')).toBe(KEY);
    expect(calls).toContain('Protect:flags=1');
    expect(memory.get(inPtr)!.every((b) => b === 0)).toBe(true); // plaintext copy zeroed before HeapFree
    expect(calls.filter((c) => c.startsWith('LocalFree') || c.startsWith('HeapFree'))).toHaveLength(2);
    expect(() => createKoffiDpapiProtect(koffi, '3.3.3', { platform: 'linux', arch: 'x64' })).toThrow(/unsupported-host/u);
  });
});

describe('UI-AUDIT-3: the Start-menu helper keeps working beside the in-app flow', () => {
  it('a helper-written setup reads back in the settings status (same files, same parsers)', async () => {
    const dir = fresh();
    const { writeProviderSetup } = await import('../../apps/desktop/src/provider-setup-write.js');
    writeFileSync(join(dir, 'placeholder'), '');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'provider'), { recursive: true });
    writeFileSync(join(dir, 'provider', 'model-api-key.dpapi'), xor(Buffer.from(KEY)));
    writeProviderSetup({ userDataDir: dir, profile: PROFILE, capCny: 1, approvedBy: 'helper-user' });
    const h = harness({ userDataDir: dir });
    const status = h.service.status();
    expect(status.state).toBe('CONFIGURED');
    expect(status.keyHint).toBe('****WXYZ');
    expect(status.capCny).toBe(1);
    expect(status.service?.kind).toBe('preset');
    expect(status.restartRequired).toBe(false);
  });
});

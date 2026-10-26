/**
 * Hark lane H17a — DPAPI (CurrentUser) decrypt of the provider-setup key file, in the
 * MAIN process, over the SHIPPED, manifest-verified koffi 3.3.3 binding (resources/native,
 * H15b). No new dependency: the binding is the one native.job already ships and verifies.
 *
 * Declared surface: crypt32!CryptUnprotectData (CRYPTPROTECT_UI_FORBIDDEN, no entropy,
 * no prompt) and the kernel32 memory primitives needed to marshal DATA_BLOB. Plain
 * key bytes are zeroed in the DPAPI-owned buffer before LocalFree. x64 ABI only:
 * DATA_BLOB = { DWORD cbData; [4 pad]; BYTE *pbData } = 16 bytes.
 */
import { join } from 'node:path';

import type { ProviderSetupUnprotect } from './provider-setup.js';

/**
 * Structural view of the koffi module (the native-lifetime seam is reached ONLY by the dynamic
 * import in loadProviderSetupUnprotect, the same rule core-services follows for native.job).
 */
export interface DpapiKoffi {
  readonly version: string;
  sizeof(type: string): number;
  load(path: string): { func(declaration: string): (...args: unknown[]) => unknown };
}

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
const HEAP_ZERO_MEMORY = 0x8;
const DATA_BLOB_SIZE = 16;
const MAX_BLOB_BYTES = 1 << 16;

export class ProviderSetupDpapiError extends Error {
  constructor(readonly step: string, readonly win32Error: number | null) {
    super(`provider-setup dpapi ${step}${win32Error === null ? '' : ` (win32 ${win32Error})`}`);
  }
}

/** Build the unprotect function over an already verified koffi module. win32/x64 only. */
export const createKoffiDpapiUnprotect = (
  koffi: DpapiKoffi,
  pinnedVersion: string,
  host: { readonly platform: string; readonly arch: string } = process,
  systemRoot: string | undefined = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'],
): (blob: Uint8Array) => Uint8Array => {
  if (host.platform !== 'win32' || host.arch !== 'x64') throw new ProviderSetupDpapiError('unsupported-host', null);
  if (koffi.version !== pinnedVersion) throw new ProviderSetupDpapiError(`koffi-version-${koffi.version}`, null);
  if (koffi.sizeof('uintptr_t') !== 8) throw new ProviderSetupDpapiError('pointer-size', null);
  if (!systemRoot || !/^[A-Za-z]:\\[^\\/:*?"<>|]+$/u.test(systemRoot)) throw new ProviderSetupDpapiError('system-root-refused', null);
  const kernel32 = koffi.load(`${systemRoot}\\System32\\kernel32.dll`);
  const crypt32 = koffi.load(`${systemRoot}\\System32\\crypt32.dll`);
  const getLastError = kernel32.func('uint32 __stdcall GetLastError()');
  const getProcessHeap = kernel32.func('uintptr_t __stdcall GetProcessHeap()');
  const heapAlloc = kernel32.func('uintptr_t __stdcall HeapAlloc(uintptr_t heap, uint32 flags, uintptr_t bytes)');
  const heapFree = kernel32.func('int __stdcall HeapFree(uintptr_t heap, uint32 flags, uintptr_t mem)');
  const copyIn = kernel32.func('void __stdcall RtlMoveMemory(uintptr_t dst, void *src, uintptr_t bytes)');
  const copyOut = kernel32.func('void __stdcall RtlMoveMemory(void *dst, uintptr_t src, uintptr_t bytes)');
  const localFree = kernel32.func('uintptr_t __stdcall LocalFree(uintptr_t mem)');
  const unprotectData = crypt32.func('int __stdcall CryptUnprotectData(void *dataIn, void *description, void *entropy, void *reserved, void *prompt, uint32 flags, void *dataOut)');
  const asBig = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(Number(v)));

  return (blob: Uint8Array): Uint8Array => {
    if (blob.byteLength === 0 || blob.byteLength > MAX_BLOB_BYTES) throw new ProviderSetupDpapiError('blob-size', null);
    const heap = asBig(getProcessHeap());
    const inMem = asBig(heapAlloc(heap, HEAP_ZERO_MEMORY, BigInt(blob.byteLength)));
    if (inMem === 0n) throw new ProviderSetupDpapiError('HeapAlloc', null);
    try {
      copyIn(inMem, Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength), BigInt(blob.byteLength));
      const dataIn = Buffer.alloc(DATA_BLOB_SIZE);
      dataIn.writeUInt32LE(blob.byteLength, 0);
      dataIn.writeBigUInt64LE(inMem, 8);
      const dataOut = Buffer.alloc(DATA_BLOB_SIZE);
      const ok = Number(unprotectData(dataIn, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, dataOut));
      if (ok === 0) throw new ProviderSetupDpapiError('CryptUnprotectData', Number(getLastError()));
      const size = dataOut.readUInt32LE(0);
      const outMem = dataOut.readBigUInt64LE(8);
      try {
        if (outMem === 0n || size > MAX_BLOB_BYTES) throw new ProviderSetupDpapiError('CryptUnprotectData-output', null);
        const plain = Buffer.alloc(size);
        if (size > 0) {
          copyOut(plain, outMem, BigInt(size));
          copyIn(outMem, Buffer.alloc(size), BigInt(size)); // zero the DPAPI-owned plaintext before freeing it
        }
        return plain;
      } finally {
        if (outMem !== 0n) localFree(outMem);
      }
    } finally {
      heapFree(heap, 0, inMem);
    }
  };
};

/**
 * The production unprotect for the installed app: `<resources>/native/koffi-3.3.3`, verified
 * against its manifest before anything is required. Any refusal = null (the caller reports
 * PROVIDER_SETUP_UNPROTECT_UNAVAILABLE; nothing falls back to a weaker store).
 */
export const loadProviderSetupUnprotect = async (
  resourcesRoot: string,
  host: { readonly platform: string; readonly arch: string } = process,
  load?: (bindingDir: string) => DpapiKoffi,
): Promise<{ readonly unprotect: ProviderSetupUnprotect; readonly detail: string | null }> => {
  if (host.platform !== 'win32' || host.arch !== 'x64') return { unprotect: null, detail: `unsupported host ${host.platform}/${host.arch}` };
  const seam = await import('./executor/native-lifetime/native-job-composition.js');
  const loaded = seam.loadVerifiedKoffiBinding(join(resourcesRoot, 'native', seam.NATIVE_JOB_BINDING_DIR), load);
  if (!loaded.ok) return { unprotect: null, detail: loaded.detail };
  try {
    return { unprotect: createKoffiDpapiUnprotect(loaded.koffi, seam.KOFFI_PINNED_VERSION, host), detail: null };
  } catch (e) {
    return { unprotect: null, detail: e instanceof Error ? e.message : String(e) };
  }
};

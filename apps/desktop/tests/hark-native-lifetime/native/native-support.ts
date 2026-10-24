/**
 * Hark lane H4 — shared helpers for NATIVE Windows tests and their fixture
 * processes (owner / watchdog). Windows x64 CI only; koffi comes from
 * HARK_KOFFI_DIR (integrity-pinned install outside the repo).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KoffiLike } from '../../../src/executor/native-lifetime/koffi-job-port.js';
import { compareEnvironmentNames, quoteWindowsArgument } from '../../../src/executor/native-lifetime/launch-pins.js';

export function loadKoffi(): KoffiLike {
  const dir = process.env['HARK_KOFFI_DIR'];
  if (process.platform !== 'win32' || process.arch !== 'x64' || !dir) throw new Error('HARK_NATIVE_HOST_REFUSED: requires win32/x64 and HARK_KOFFI_DIR');
  return createRequire(join(dir, 'package.json'))('koffi') as KoffiLike;
}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Deterministic child fixture (CommonJS): no network, no credentials. */
export const CHILD_FIXTURE = `/* Hark native child fixture */
const fs = require('node:fs');
const path = require('node:path');
const [mode, tag] = process.argv.slice(2);
const write = (name, value) => fs.writeFileSync(path.join(process.cwd(), name), JSON.stringify(value));
if (mode === 'normal') { write(tag + '-root.json', { pid: process.pid }); }
else if (mode === 'error') { process.exitCode = 17; }
else if (mode === 'hold') { write(tag + '-root.json', { pid: process.pid }); setInterval(() => {}, 1000); }
else if (mode === 'tree') {
  write(tag + '-root.json', { pid: process.pid });
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'leaf', tag], { stdio: 'ignore', windowsHide: true, shell: false });
  child.on('error', e => write(tag + '-spawn-error.json', { code: e.code }));
  setInterval(() => {}, 1000);
} else if (mode === 'print') { process.stdout.write(JSON.stringify({ ok: true, pid: process.pid })); process.stderr.write('diag-line'); }
else if (mode === 'flood') { const chunk = 'x'.repeat(64 * 1024); for (let i = 0; i < 48; i += 1) process.stdout.write(chunk); }
else if (mode === 'inheritleaf') {
  process.stdout.write('root-out;');
  require('node:child_process').spawn(process.execPath, [__filename, 'leafprint', tag], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, shell: false });
} else if (mode === 'leafprint') { setTimeout(() => { process.stdout.write('leaf-out;'); }, 300); }
else if (mode === 'leaf') { write(tag + '-leaf.json', { pid: process.pid }); setInterval(() => {}, 1000); }
else { process.exitCode = 99; }
`;

export interface NativeWorkspace { root: string; temp: string; control: string; exe: string; exeSha: string; script: string; scriptSha: string }

/** Child workspace plus a SEPARATE owner control directory (lease / args / results). */
export function makeNativeWorkspace(prefix: string): NativeWorkspace {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `${prefix}-ws-`)));
  const control = realpathSync.native(mkdtempSync(join(tmpdir(), `${prefix}-ctl-`)));
  const temp = join(root, 'tmp');
  mkdirSync(temp);
  const exe = join(root, 'node.exe');
  copyFileSync(process.execPath, exe);
  const script = join(root, 'fixture.cjs');
  writeFileSync(script, CHILD_FIXTURE);
  return { root, temp, control, exe, exeSha: sha256(readFileSync(exe)), script, scriptSha: sha256(readFileSync(script)) };
}

/** Unicode environment block for helper processes (owner / watchdog) the TEST creates. */
export function environmentBlock(env: Record<string, string>): Uint8Array {
  const names = Object.keys(env).sort(compareEnvironmentNames);
  const text = names.map(n => `${n}=${env[n] ?? ''}`).join('\0');
  return Buffer.from(`${text}\0\0`, 'utf16le');
}

export function helperEnvironment(temp: string): Record<string, string> {
  return {
    SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
    TEMP: temp,
    TMP: temp,
    HARK_KOFFI_DIR: process.env['HARK_KOFFI_DIR'] ?? '',
    COMPANYOS_TEST_MODE: 'OFFLINE',
    NODE_NO_WARNINGS: '1',
  };
}

const registerNative = pathToFileURL(resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'scripts', 'hark', 'register-native.mjs')).href;

/** node.exe --import <register-native> <ts entry> ...args, quoted for CreateProcessW. */
export function nodeCommandLine(exe: string, entry: string, args: readonly string[]): string {
  return [exe, '--import', registerNative, entry, ...args].map(quoteWindowsArgument).join(' ');
}

export async function waitForJson<T>(file: string, ms: number): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { /* partially written */ }
    }
  }
  throw new Error(`fixture-file-missing:${file}`);
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitDead(pids: readonly number[], ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (pids.every(p => !alive(p))) return true;
  return pids.every(p => !alive(p));
}

export const evidence = (name: string, value: unknown): void => {
  console.log(`HARK_NATIVE_EVIDENCE ${name} ${JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
};

/**
 * Hark lane — H5: handle-pinned launch (closes the hash-then-CreateProcess TOCTOU).
 *
 * verifyLaunch() hashes the executable and inputs BY PATH. Between that hash
 * and CreateProcessW (and, for inputs, until the child has read them) the path
 * could be re-pointed or the file rewritten. pinLaunch() closes that window:
 *
 *  1. Every ancestor directory of every pinned file is opened with a share mode
 *     that DENIES DELETE (no rename/move/delete of the directory chain) and with
 *     FILE_LIST_DIRECTORY access so the share mode is actually enforced.
 *  2. The executable and each input are opened with share READ only (deny
 *     write, deny delete — so also no rename-over), without following reparse
 *     points. A reparse point anywhere is refused.
 *  3. The final path of each handle must equal the requested path (no junction
 *     / symlink / short-name redirection).
 *  4. The SHA-256 is recomputed THROUGH THE PINNED HANDLE and must equal the
 *     pin verified earlier. Only these bytes can be executed / read.
 *  5. After CreateProcessW the adapter checks the root's image path equals the
 *     pinned executable's final path before resume.
 *  6. Pins are held for the whole run and released after the Job is drained.
 *
 * Not covered: a same-user process can still read the files; an administrator
 * or kernel-mode actor can bypass share modes; ACLs are not changed.
 */
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type { NativeHandle } from './job-port.js';
import type { VerifiedLaunch } from './launch-pins.js';

export const FILE_ATTRIBUTE_DIRECTORY = 0x10;
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

export interface PinnedObjectInfo {
  /** Normalised DOS path the handle really refers to (no \\?\ prefix). */
  readonly finalPath: string;
  readonly attributes: number;
  readonly volumeSerial: number;
  readonly fileIndex: string;
  readonly links: number;
  readonly size: number;
}

export interface FilePinPort {
  /** Share READ only (deny write + delete), no reparse traversal. */
  openFilePinned(path: string): NativeHandle;
  /** Share READ|WRITE (deny delete), FILE_LIST_DIRECTORY so sharing is enforced, no reparse traversal. */
  openDirectoryPinned(path: string): NativeHandle;
  info(handle: NativeHandle): PinnedObjectInfo;
  /** Sequential read from the handle's current position; 0 = EOF. */
  read(handle: NativeHandle, into: Uint8Array): number;
  close(handle: NativeHandle): void;
}

export class LaunchPinRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`launch pin refused: ${reason}`);
    this.name = 'LaunchPinRefused';
    this.reason = reason;
  }
}

export interface PinnedFile {
  readonly role: 'EXECUTABLE' | 'INPUT';
  readonly path: string;
  readonly sha256: string;
  readonly volumeSerial: number;
  readonly fileIndex: string;
}

export interface LaunchPins {
  readonly executableFinalPath: string;
  readonly files: readonly PinnedFile[];
  readonly directoryCount: number;
  /** Idempotent. Returns close errors (never throws). */
  release(): readonly string[];
}

const isWin = (p: string): boolean => /^[A-Za-z]:\\/u.test(p);

export function normaliseFinalPath(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) throw new LaunchPinRefused('unc-path');
  return p.startsWith('\\\\?\\') ? p.slice(4) : p;
}

export function samePinnedPath(a: string, b: string): boolean {
  if (isWin(a) || isWin(b)) return win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
  return posix.normalize(a) === posix.normalize(b);
}

/** Root-first list of directories containing `file` (drive root included). */
export function ancestorsOf(file: string): string[] {
  const p = isWin(file) ? win32 : posix;
  const out: string[] = [];
  for (let dir = p.dirname(file); ; dir = p.dirname(dir)) {
    out.unshift(dir);
    if (p.dirname(dir) === dir) break;
  }
  return out;
}

const MAX_PINNED_BYTES = 512 * 1024 * 1024;

export function pinLaunch(launch: VerifiedLaunch, port: FilePinPort): LaunchPins {
  const handles: NativeHandle[] = [];
  const dirs = new Map<string, NativeHandle>();
  let released = false;
  const release = (): readonly string[] => {
    if (released) return [];
    released = true;
    const errors: string[] = [];
    for (const h of handles.reverse()) {
      try { port.close(h); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    }
    return errors;
  };
  try {
    const targets: { role: PinnedFile['role']; path: string; sha256: string }[] = [
      { role: 'EXECUTABLE', path: launch.executablePath, sha256: launch.executableSha256 },
      ...launch.inputs.map(i => ({ role: 'INPUT' as const, path: i.path, sha256: i.sha256 })),
    ];
    // 1. Directory chain first: once pinned, no ancestor can be renamed or replaced.
    for (const t of targets) {
      for (const dir of ancestorsOf(t.path)) {
        const key = dir.toLowerCase();
        if (dirs.has(key)) continue;
        const h = port.openDirectoryPinned(dir);
        handles.push(h);
        dirs.set(key, h);
        const info = port.info(h);
        if ((info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw new LaunchPinRefused(`reparse-point:${dir}`);
        if ((info.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) throw new LaunchPinRefused(`not-a-directory:${dir}`);
        if (!samePinnedPath(normaliseFinalPath(info.finalPath), dir)) throw new LaunchPinRefused(`path-redirected:${dir}`);
      }
    }
    // 2-4. Files: deny write/delete, no redirection, hash through the handle.
    const files: PinnedFile[] = [];
    let executableFinalPath = '';
    for (const t of targets) {
      const h = port.openFilePinned(t.path);
      handles.push(h);
      const info = port.info(h);
      if ((info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw new LaunchPinRefused(`reparse-point:${t.path}`);
      if ((info.attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0) throw new LaunchPinRefused(`not-a-file:${t.path}`);
      const finalPath = normaliseFinalPath(info.finalPath);
      if (!samePinnedPath(finalPath, t.path)) throw new LaunchPinRefused(`path-redirected:${t.path}`);
      if (info.size > MAX_PINNED_BYTES) throw new LaunchPinRefused(`too-large:${t.path}`);
      const hash = createHash('sha256');
      const chunk = new Uint8Array(1024 * 1024);
      let total = 0;
      for (;;) {
        const n = port.read(h, chunk);
        if (n === 0) break;
        total += n;
        if (total > MAX_PINNED_BYTES) throw new LaunchPinRefused(`too-large:${t.path}`);
        hash.update(chunk.subarray(0, n));
      }
      if (total !== info.size) throw new LaunchPinRefused(`size-changed:${t.path}`);
      if (hash.digest('hex') !== t.sha256) throw new LaunchPinRefused(`hash-mismatch:${t.path}`);
      if (t.role === 'EXECUTABLE') executableFinalPath = finalPath;
      files.push(Object.freeze({ role: t.role, path: t.path, sha256: t.sha256, volumeSerial: info.volumeSerial, fileIndex: info.fileIndex }));
    }
    return Object.freeze({ executableFinalPath, files: Object.freeze(files), directoryCount: dirs.size, release });
  } catch (e) {
    release();
    throw e;
  }
}

/**
 * Hark lane H5 — SIMULATED FilePinPort over Node fs for offline tests.
 * Exercises pinLaunch()/adapter LOGIC only: POSIX has no share-mode deny, so
 * write/delete denial is NOT proven here (native evidence: pins-native.win-test.ts).
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, type FilePinPort } from '../../src/executor/native-lifetime/file-pins.js';
import { NativeJobError, type NativeHandle } from '../../src/executor/native-lifetime/job-port.js';

export interface SimulatedPins extends FilePinPort {
  readonly calls: string[];
  openCount(): number;
  /** Paths whose final path is reported as something else (junction simulation). */
  readonly redirect: Map<string, string>;
}

export function createNodeFsPinPort(): SimulatedPins {
  const open = new Map<NativeHandle, { fd: number; path: string }>();
  let next = 0x9000n;
  const calls: string[] = [];
  const redirect = new Map<string, string>();
  const openAny = (path: string, op: string): NativeHandle => {
    calls.push(`${op}:${path}`);
    let fd: number;
    try { fd = openSync(path, 'r'); } catch { throw new NativeJobError(op, 2); }
    const h = next; next += 1n;
    open.set(h, { fd, path });
    return h;
  };
  const rec = (h: NativeHandle): { fd: number; path: string } => {
    const r = open.get(h);
    if (!r) throw new NativeJobError('invalid-handle', 6);
    return r;
  };
  return {
    calls,
    redirect,
    openCount: () => open.size,
    openFilePinned: path => openAny(path, 'openFilePinned'),
    openDirectoryPinned: path => openAny(path, 'openDirectoryPinned'),
    info(h) {
      const { fd, path } = rec(h);
      const l = lstatSync(path);
      const st = fstatSync(fd);
      const attributes = (st.isDirectory() ? FILE_ATTRIBUTE_DIRECTORY : 0) | (l.isSymbolicLink() ? FILE_ATTRIBUTE_REPARSE_POINT : 0);
      return {
        finalPath: redirect.get(path) ?? realpathSync.native(path),
        attributes,
        volumeSerial: Number(st.dev),
        fileIndex: String(st.ino),
        links: st.nlink,
        size: st.size,
      };
    },
    read(h, into) {
      return readSync(rec(h).fd, into, 0, into.length, null);
    },
    close(h) {
      const r = rec(h);
      closeSync(r.fd);
      open.delete(h);
    },
  };
}

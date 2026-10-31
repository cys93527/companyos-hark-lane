/**
 * Sinks — where a structured log line ends up.
 *
 * Sprint 0 ships two real sinks and one test sink:
 *   - console      : JSON line to stdout/stderr (dev + CI)
 *   - rotating file: size-capped, N retained files (desktop runtime, §四十四)
 *   - memory       : collects lines so tests can assert on them
 *
 * A sink receives an already serialized line: it never inspects or re-formats
 * fields, which keeps redaction in exactly one place (`redact.ts`).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export interface LogSink {
  readonly name: string;
  /**
   * `level` is the record's level as decided by the logger (AUDIT-P4): a sink that
   * routes by severity must use it, never a substring of the serialized line.
   */
  write(line: string, level?: string): void;
}

export interface WritableLike {
  write(chunk: string): boolean;
}

export interface ConsoleSinkOptions {
  readonly out?: WritableLike;
  readonly err?: WritableLike;
  /** Levels routed to stderr instead of stdout. */
  readonly errorLevels?: readonly string[];
}

export const createConsoleSink = (options: ConsoleSinkOptions = {}): LogSink => {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const errorLevels = options.errorLevels ?? ['warn', 'error'];
  return {
    name: 'console',
    write(line: string, level?: string): void {
      const effective = level ?? topLevelLevelOf(line);
      const target = effective !== null && errorLevels.includes(effective) ? err : out;
      target.write(line.endsWith('\n') ? line : `${line}\n`);
    },
  };
};

/**
 * The record's own top-level `level` (for a line written without an explicit level).
 * Parsed, never substring-matched: a nested `{ "level": "warn" }` field must not
 * reroute an info line (AUDIT-P4).
 */
const topLevelLevelOf = (line: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const level = (parsed as Record<string, unknown>)['level'];
      return typeof level === 'string' ? level : null;
    }
  } catch {
    // not a JSON record: no level
  }
  return null;
};

export interface MemorySink extends LogSink {
  readonly lines: string[];
  clear(): void;
}

export const createMemorySink = (name = 'memory'): MemorySink => {
  const lines: string[] = [];
  return {
    name,
    lines,
    write(line: string): void {
      lines.push(line.endsWith('\n') ? line.slice(0, -1) : line);
    },
    clear(): void {
      lines.length = 0;
    },
  };
};

export interface RotatingFileSinkOptions {
  readonly dir: string;
  readonly fileName?: string;
  /** Rotate once the active file would exceed this many bytes. */
  readonly maxBytes?: number;
  /** Total files kept, including the active one (1 = only the active file). */
  readonly maxFiles?: number;
  /** Monotonic-enough millisecond clock for the rotation retry back-off (tests inject it). */
  readonly nowMs?: () => number;
}

export const DEFAULT_MAX_BYTES = 512 * 1024;
export const DEFAULT_MAX_FILES = 5;

/** First / maximum delay before a failed rotation is retried. */
export const ROTATION_RETRY_INITIAL_MS = 1_000;
export const ROTATION_RETRY_MAX_MS = 5 * 60_000;

/**
 * Rotating file sink: `<dir>/<fileName>` is the active file; rotated files are
 * `<fileName>.1`, `.2`, … The newest rotation always has the smallest suffix, and
 * files beyond `maxFiles` are deleted, so the directory stays size-capped.
 *
 * `maxFiles` counts the active file (AUDIT-P8): `maxFiles: 1` keeps ONLY the active
 * file (rotation truncates it); `maxFiles: n` keeps the active file plus `.1 … .(n-1)`,
 * and any leftover index `>= n` (e.g. from a larger earlier setting) is pruned.
 *
 * Rotation is best-effort and never fails a write (AUDIT-P1): on Windows a rotated or
 * active file held open without FILE_SHARE_DELETE (antivirus, a log viewer) makes
 * `unlink`/`rename` throw EPERM/EBUSY. The sink then keeps APPENDING to the active
 * file and retries rotation after an exponential back-off, instead of retrying (and
 * throwing) on every line. Only a failed APPEND of the line itself is reported to the
 * caller (the logger isolates and reports sink failures; it never reaches business code).
 */
export function createRotatingFileSink(options: RotatingFileSinkOptions): LogSink {
  const dir = options.dir;
  const fileName = options.fileName ?? 'companyos.log';
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
  const nowMs = options.nowMs ?? Date.now;
  const activePath = join(dir, fileName);

  mkdirSync(dir, { recursive: true });

  const rotatedPath = (index: number): string => `${activePath}.${index}`;
  const rotatedIndexPattern = new RegExp(`^${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`);

  /** Every rotated index present on disk. */
  const presentIndexes = (): number[] => {
    const indexes: number[] = [];
    for (const entry of readdirSync(dir)) {
      const match = rotatedIndexPattern.exec(entry);
      if (match !== null) indexes.push(Number(match[1]));
    }
    return indexes;
  };

  /** Throws on the first failed step; the caller keeps appending and retries later. */
  const rotate = (): void => {
    if (maxFiles === 1) {
      for (const index of presentIndexes()) unlinkSync(rotatedPath(index));
      truncateSync(activePath, 0);
      return;
    }
    // Free the slot the oldest retained rotation moves into, and prune every index
    // beyond the retention window.
    for (const index of presentIndexes()) {
      if (index >= maxFiles - 1) unlinkSync(rotatedPath(index));
    }
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      const from = rotatedPath(index);
      if (existsSync(from)) renameSync(from, rotatedPath(index + 1));
    }
    if (existsSync(activePath)) renameSync(activePath, rotatedPath(1));
  };

  let retryDelayMs = 0;
  let nextRotationAt = 0;

  const tryRotate = (): void => {
    if (retryDelayMs > 0 && nowMs() < nextRotationAt) return; // backing off
    try {
      rotate();
      retryDelayMs = 0;
      nextRotationAt = 0;
    } catch {
      retryDelayMs =
        retryDelayMs === 0 ? ROTATION_RETRY_INITIAL_MS : Math.min(retryDelayMs * 2, ROTATION_RETRY_MAX_MS);
      nextRotationAt = nowMs() + retryDelayMs;
    }
  };

  const sizeOfActive = (): number => {
    try {
      return fileSize(activePath);
    } catch {
      return 0;
    }
  };

  return {
    name: 'file',
    write(line: string): void {
      const payload = line.endsWith('\n') ? line : `${line}\n`;
      const size = sizeOfActive();
      if (size > 0 && size + Buffer.byteLength(payload, 'utf8') > maxBytes) tryRotate();
      try {
        appendFileSync(activePath, payload, 'utf8');
      } catch (error) {
        // The directory may have been removed under us: recreate it once, then retry.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(dir, { recursive: true });
        appendFileSync(activePath, payload, 'utf8');
      }
    },
  };
}

const fileSize = (path: string): number => (existsSync(path) ? statSync(path).size : 0);

/** Total bytes currently held by a rotating sink's directory (used by tests). */
export const totalSizeOfRotations = (dir: string, fileName = 'companyos.log'): number => {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((entry) => entry === fileName || entry.startsWith(`${fileName}.`))
    .reduce((sum, entry) => sum + fileSize(join(dir, entry)), 0);
};

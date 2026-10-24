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
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface LogSink {
  readonly name: string;
  write(line: string): void;
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
    write(line: string): void {
      const target = errorLevels.some((level) => line.includes(`"level":"${level}"`)) ? err : out;
      target.write(line.endsWith('\n') ? line : `${line}\n`);
    },
  };
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
  /** Total files kept, including the active one. */
  readonly maxFiles?: number;
}

export const DEFAULT_MAX_BYTES = 512 * 1024;
export const DEFAULT_MAX_FILES = 5;

/**
 * Rotating file sink: `<dir>/<fileName>` is the active file; rotated files are
 * `<fileName>.1`, `.2`, … The newest rotation always has the smallest suffix, and
 * files beyond `maxFiles` are deleted, so the directory stays size-capped.
 */
export function createRotatingFileSink(options: RotatingFileSinkOptions): LogSink {
  const dir = options.dir;
  const fileName = options.fileName ?? 'companyos.log';
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const activePath = join(dir, fileName);

  mkdirSync(dir, { recursive: true });

  const sizeOf = fileSize;

  const rotatedPath = (index: number): string => `${activePath}.${index}`;

  const rotate = (): void => {
    const oldest = rotatedPath(maxFiles - 1);
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      const from = rotatedPath(index);
      if (existsSync(from)) renameSync(from, rotatedPath(index + 1));
    }
    if (existsSync(activePath)) renameSync(activePath, rotatedPath(1));
  };

  return {
    name: 'file',
    write(line: string): void {
      const payload = line.endsWith('\n') ? line : `${line}\n`;
      if (sizeOf(activePath) + Buffer.byteLength(payload, 'utf8') > maxBytes && sizeOf(activePath) > 0) {
        rotate();
      }
      appendFileSync(activePath, payload, 'utf8');
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

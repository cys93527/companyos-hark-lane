/**
 * Sprint 0 acceptance (T0.8): the file sink rotates and stays size-capped.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLogger,
  createRotatingFileSink,
  parseLogLine,
  toJsonLine,
  totalSizeOfRotations,
} from '../src/index.js';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-observability-'));
  created.push(dir);
  return dir;
};

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('rotating file sink', () => {
  it('writes append-only JSON lines', () => {
    const dir = tempDir();
    const sink = createRotatingFileSink({ dir, maxBytes: 10_000 });
    sink.write(toJsonLine({ ts: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'first' }));
    sink.write(toJsonLine({ ts: '2026-01-01T00:00:01.000Z', level: 'info', msg: 'second' }));

    const lines = readFileSync(join(dir, 'companyos.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(parseLogLine(lines[1]!).msg).toBe('second');
  });

  it('rotates once the active file would exceed maxBytes and caps retained files', () => {
    const dir = tempDir();
    const sink = createRotatingFileSink({ dir, maxBytes: 200, maxFiles: 3 });
    const line = toJsonLine({ ts: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'x'.repeat(120) });

    for (let index = 0; index < 25; index += 1) sink.write(line);

    const entries = readdirSync(dir).sort();
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(entries).toContain('companyos.log');
    expect(entries).toContain('companyos.log.1');
    // Every retained file is a valid log file, and the total stays bounded.
    for (const entry of entries) {
      const content = readFileSync(join(dir, entry), 'utf8');
      expect(content.length).toBeGreaterThan(0);
      expect(parseLogLine(content.trim().split('\n')[0]!).msg.length).toBe(120);
    }
    expect(totalSizeOfRotations(dir)).toBeLessThanOrEqual(200 * 3);
  });

  it('creates the log directory and appends to an existing file', () => {
    const dir = join(tempDir(), 'nested', 'logs');
    const sink = createRotatingFileSink({ dir, fileName: 'desktop.log' });
    writeFileSync(join(dir, 'desktop.log'), '', { flag: 'a' });
    sink.write('{"msg":"hello"}');
    expect(readFileSync(join(dir, 'desktop.log'), 'utf8')).toContain('hello');
  });

  it('integrates with a logger and the default rotation budget', () => {
    const dir = tempDir();
    const logger = createLogger({
      sinks: [createRotatingFileSink({ dir })],
      clock: { nowIso: () => '2026-01-01T00:00:00.000Z' },
    });
    logger.info('boot', { traceId: 'trace_1' });
    const content = readFileSync(join(dir, 'companyos.log'), 'utf8');
    expect(parseLogLine(content.trim()).msg).toBe('boot');
  });
});

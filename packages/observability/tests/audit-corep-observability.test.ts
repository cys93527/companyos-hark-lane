/**
 * AUDIT corep — observability regressions (P1 sink isolation + rotation failure,
 * P2 value-level scrubbing, P3 anchored token keys, P4 reserved keys + level routing,
 * P8 maxFiles semantics). Each case failed on 4b71b20.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MASK,
  createConsoleSink,
  createLogger,
  createMemorySink,
  createRotatingFileSink,
  isSensitiveKey,
  parseLogLine,
  redactFields,
  scrubString,
  type LogSink,
  type LoggerInternalError,
} from '../src/index.js';

const clock = { nowIso: () => '2026-01-01T00:00:00.000Z' };
const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'corep-audit-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Linux stand-in for a Windows EPERM/EBUSY on unlink: a non-empty directory in the slot. */
const blockSlot = (path: string): void => {
  mkdirSync(path);
  writeFileSync(join(path, 'held'), 'x');
};

describe('AUDIT-P1 a log call never throws into its caller', () => {
  it('isolates a throwing sink: the caller is unaffected and later sinks still get the line', () => {
    const reports: LoggerInternalError[] = [];
    const broken: LogSink = {
      name: 'broken',
      write: () => {
        throw new Error('EPERM: operation not permitted, token=abc123secret');
      },
    };
    const mem = createMemorySink();
    const logger = createLogger({ sinks: [broken, mem], clock, onInternalError: (r) => reports.push(r) });

    expect(() => logger.info('database ready')).not.toThrow();
    expect(() => logger.child({ runId: 'r1' }).error('second')).not.toThrow();
    expect(mem.lines).toHaveLength(2);
    // Reported once (rate-limited across children), scrubbed, never the line itself.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe('sink:broken');
    expect(reports[0]?.message).not.toContain('abc123secret');
  });

  it('a record that cannot be built (throwing getter / clock) still never throws', () => {
    const mem = createMemorySink();
    const reports: LoggerInternalError[] = [];
    const logger = createLogger({ sinks: [mem], clock, onInternalError: (r) => reports.push(r) });
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get: () => {
        throw new Error('getter exploded');
      },
    });
    expect(() => logger.warn('still logged', { hostile })).not.toThrow();
    expect(parseLogLine(mem.lines[0]!).msg).toBe('still logged');
    expect(reports[0]?.source).toBe('record');
    // bigint no longer breaks serialization at all.
    logger.info('big', { n: 10n });
    expect(parseLogLine(mem.lines[1]!)['n']).toBe('10');
  });

  it('a failing reporter is swallowed too', () => {
    const logger = createLogger({
      sinks: [{ name: 'x', write: () => { throw new Error('no'); } }],
      onInternalError: () => {
        throw new Error('reporter also broken');
      },
    });
    expect(() => logger.error('x')).not.toThrow();
  });

  it('rotating sink: a failed rotation keeps appending to the active file and backs off', () => {
    const dir = tempDir();
    let now = 0;
    const sink = createRotatingFileSink({ dir, fileName: 'desktop.log', maxBytes: 200, maxFiles: 2, nowMs: () => now });
    blockSlot(join(dir, 'desktop.log.1')); // rotation target cannot be removed
    const mem = createMemorySink();
    const reports: LoggerInternalError[] = [];
    const logger = createLogger({ sinks: [sink, mem], clock, onInternalError: (r) => reports.push(r) });

    logger.info('a'.repeat(150));
    expect(() => logger.info('b'.repeat(150))).not.toThrow();
    expect(() => logger.info('c'.repeat(150))).not.toThrow();
    expect(mem.lines).toHaveLength(3);
    expect(reports).toHaveLength(0); // rotation failure is handled inside the sink
    const active = readFileSync(join(dir, 'desktop.log'), 'utf8').trim().split('\n');
    expect(active).toHaveLength(3); // nothing lost: all three lines appended

    // Once the slot is released and the back-off has elapsed, rotation resumes.
    rmSync(join(dir, 'desktop.log.1'), { recursive: true, force: true });
    now += 10 * 60_000;
    logger.info('d'.repeat(150));
    expect(readdirSync(dir).sort()).toEqual(['desktop.log', 'desktop.log.1']);
    expect(readFileSync(join(dir, 'desktop.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('AUDIT-P2 value-level secret scrubbing', () => {
  it('scrubs the message, string leaves, Error.message, header tuples, JSON strings and auth keys', () => {
    const mem = createMemorySink();
    const logger = createLogger({ sinks: [mem], clock });
    logger.error('call failed Authorization: Bearer sk-live-AAAAAAAA', {
      error: new Error('401 for key sk-live-BBBBBBBB'),
      detail: 'Authorization: Bearer opaqueCCCCCCCC',
      headers: [['Authorization', 'Bearer opaqueDDDDDDDD'], ['accept', 'json']],
      body: '{"apiKey":"plainEEEEEEEE","model":"m1"}',
      auth: 'Basic dXNlcjpGRkZGRkZGRg==',
      url: 'https://host.example/v1?access_token=GGGGGGGG&page=2',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.HHHHHHHHHHHH',
      nested: { list: ['password=IIIIIIII'] },
    });
    const line = mem.lines[0]!;
    for (const marker of ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC', 'DDDDDDDD', 'EEEEEEEE', 'dXNlcjpGRkZGRkZGRg', 'GGGGGGGG', 'HHHHHHHHHHHH', 'IIIIIIII']) {
      expect(line).not.toContain(marker);
    }
    const record = parseLogLine(line);
    // Non-secret content survives.
    expect(record.msg).toBe(`call failed Authorization: ${MASK}`);
    expect(record['error']).toEqual({ name: 'Error', message: `401 for key ${MASK}` });
    expect(record['headers']).toEqual([['Authorization', MASK], ['accept', 'json']]);
    expect(record['body']).toBe(`{"apiKey":"${MASK}","model":"m1"}`);
    expect(record['url']).toBe(`https://host.example/v1?access_token=${MASK}&page=2`);
  });

  it('leaves ordinary text and usage numbers in free text alone', () => {
    expect(scrubString('stage 2 finished in 3s, inputTokens: 120, maxTokens=4096')).toBe(
      'stage 2 finished in 3s, inputTokens: 120, maxTokens=4096',
    );
    expect(scrubString('run_01HX… resumed by owner')).toBe('run_01HX… resumed by owner');
  });

  it('redact:false still disables scrubbing for tests that assert raw values', () => {
    const mem = createMemorySink();
    createLogger({ sinks: [mem], clock, redact: false }).info('Bearer rawvalue123', { s: 'sk-rawvalue1234' });
    expect(mem.lines[0]).toContain('rawvalue123');
    expect(mem.lines[0]).toContain('sk-rawvalue1234');
  });
});

describe('AUDIT-P3 anchored token-key matching', () => {
  it('keeps usage counters', () => {
    const usage = { inputTokens: 120, outputTokens: 30, maxTokens: 4096, tokenCount: 7, token_usage: 3, tokens: 150 };
    expect(redactFields({ usage })).toEqual({ usage });
    for (const key of ['inputTokens', 'outputTokens', 'maxTokens', 'tokenCount', 'tokens_in', 'totalTokens', 'tokenizer']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('still masks credential-shaped names', () => {
    for (const key of [
      'token',
      'accessToken',
      'access_token',
      'refresh_token',
      'refreshToken',
      'idToken',
      'providerToken',
      'X-Auth-Token',
      'sessionToken',
      'auth',
      'proxyAuth',
      'bearer',
      'apiKey',
      'X-Api-Key',
      'client_secret',
      'password',
      'Authorization',
      'cookie',
      'accessKey',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    expect(isSensitiveKey('runId')).toBe(false);
    expect(isSensitiveKey('authorities')).toBe(false);
  });
});

describe('AUDIT-P4 reserved record keys and level routing', () => {
  it('caller fields cannot overwrite ts/level/msg/logger; they are kept under field.<name>', () => {
    const mem = createMemorySink();
    createLogger({ name: 'svc', sinks: [mem], clock })
      .child({ logger: 'spoof' })
      .error('provider call failed', { msg: 'all good', level: 'debug', ts: 'x' });
    const record = parseLogLine(mem.lines[0]!);
    expect(record.level).toBe('error');
    expect(record.msg).toBe('provider call failed');
    expect(record.ts).toBe('2026-01-01T00:00:00.000Z');
    expect(record['logger']).toBe('svc');
    expect(record['field.msg']).toBe('all good');
    expect(record['field.level']).toBe('debug');
    expect(record['field.ts']).toBe('x');
    expect(record['field.logger']).toBe('spoof');
    // The frozen line shape still starts with ts, level, msg.
    expect(Object.keys(record).slice(0, 3)).toEqual(['ts', 'level', 'msg']);
  });

  it('console sink routes by the record level, not by a substring in a nested field', () => {
    const out: string[] = [];
    const errs: string[] = [];
    const sink = createConsoleSink({
      out: { write: (c) => out.push(c) > 0 },
      err: { write: (c) => errs.push(c) > 0 },
    });
    const logger = createLogger({ sinks: [sink], clock });
    logger.info('status', { check: { level: 'warn' }, note: '"level":"error"' });
    logger.warn('real warning');
    expect(out).toHaveLength(1);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('real warning');
    // A direct write without a level parses the top-level level only.
    sink.write('{"level":"info","nested":{"level":"error"}}');
    sink.write('{"level":"error"}');
    expect(out).toHaveLength(2);
    expect(errs).toHaveLength(2);
  });
});

describe('AUDIT-P8 maxFiles counts the active file', () => {
  it('maxFiles=1 keeps only the active file', () => {
    const dir = tempDir();
    const sink = createRotatingFileSink({ dir, fileName: 'a.log', maxBytes: 10, maxFiles: 1 });
    for (let i = 0; i < 5; i += 1) sink.write('0123456789');
    expect(readdirSync(dir).sort()).toEqual(['a.log']);
    expect(readFileSync(join(dir, 'a.log'), 'utf8')).toBe('0123456789\n');
  });

  it('maxFiles=n keeps exactly n files and prunes leftovers beyond the window', () => {
    const dir = tempDir();
    // Leftovers from an earlier, larger retention setting.
    for (const index of [3, 4, 7]) writeFileSync(join(dir, `a.log.${index}`), 'old\n');
    writeFileSync(join(dir, 'a.log.10x'), 'not ours\n');
    const sink = createRotatingFileSink({ dir, fileName: 'a.log', maxBytes: 10, maxFiles: 3 });
    for (let i = 0; i < 8; i += 1) sink.write(`line-${i}xxxx`);
    expect(readdirSync(dir).sort()).toEqual(['a.log', 'a.log.1', 'a.log.10x', 'a.log.2']);
    expect(readFileSync(join(dir, 'a.log'), 'utf8')).toBe('line-7xxxx\n');
    expect(readFileSync(join(dir, 'a.log.1'), 'utf8')).toBe('line-6xxxx\n');
    expect(readFileSync(join(dir, 'a.log.2'), 'utf8')).toBe('line-5xxxx\n');
  });
});

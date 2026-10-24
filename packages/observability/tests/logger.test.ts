/**
 * Sprint 0 acceptance (T0.8): secrets never reach a sink, correlation ids reach
 * every child logger, and the interface stays structurally compatible with the
 * Core `Logger` port without importing it at runtime.
 */
import { describe, expect, it } from 'vitest';

import type { Logger as CoreLogger } from '@companyos/core';

import {
  MASK,
  createLogger,
  createMemorySink,
  isSensitiveKey,
  levelRank,
  nullLogger,
  parseLogLine,
  redactFields,
  type Logger,
} from '../src/index.js';

const fixedClock = { nowIso: () => '2026-01-01T00:00:00.000Z' };

describe('structured logging', () => {
  it('is structurally compatible with the Core Logger port', () => {
    const logger: Logger = createLogger({ sinks: [createMemorySink()], clock: fixedClock });
    const asPort: CoreLogger = logger;
    asPort.child({ runId: 'run_1' }).info('compatible');
    expect(levelRank('debug')).toBeLessThan(levelRank('error'));
  });

  it('writes one JSON object per line with correlation ids', () => {
    const sink = createMemorySink();
    const logger = createLogger({
      name: 'test',
      sinks: [sink],
      clock: fixedClock,
      fields: { traceId: 'trace_1' },
    });

    logger.info('database ready', { runId: 'run_1', cost: 0.25 });

    expect(sink.lines).toHaveLength(1);
    const record = parseLogLine(sink.lines[0]!);
    expect(record).toMatchObject({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'database ready',
      logger: 'test',
      traceId: 'trace_1',
      runId: 'run_1',
      cost: 0.25,
    });
  });

  it('propagates correlation ids to a child logger and merges bound fields', () => {
    const sink = createMemorySink();
    const parent = createLogger({ sinks: [sink], clock: fixedClock, fields: { traceId: 'trace_1' } });
    const child = parent.child({ runId: 'run_7' }).child({ stageId: 'stage_2' });

    child.warn('retry scheduled', { attempt: 2 });

    const record = parseLogLine(sink.lines[0]!);
    expect(record).toMatchObject({
      traceId: 'trace_1',
      runId: 'run_7',
      stageId: 'stage_2',
      attempt: 2,
      level: 'warn',
    });
  });

  it('filters below the configured level', () => {
    const sink = createMemorySink();
    const logger = createLogger({ level: 'warn', sinks: [sink], clock: fixedClock });
    logger.debug('ignored');
    logger.info('ignored');
    logger.error('kept');
    expect(sink.lines).toHaveLength(1);
    expect(parseLogLine(sink.lines[0]!).level).toBe('error');
  });

  it('masks secrets in the message fields', () => {
    const sink = createMemorySink();
    const logger = createLogger({ sinks: [sink], clock: fixedClock });
    logger.info('provider call', {
      apiKey: 'sk-live-123',
      authorization: 'Bearer abc',
      nested: { providerToken: 'tok_1', endpoint: 'https://api.example.com' },
    });

    const record = parseLogLine(sink.lines[0]!);
    expect(record['apiKey']).toBe(MASK);
    expect(record['authorization']).toBe(MASK);
    expect(record['nested']).toEqual({ providerToken: MASK, endpoint: 'https://api.example.com' });
    expect(sink.lines[0]).not.toContain('sk-live-123');
  });

  it('keeps redaction on by default and offers a documented opt-out', () => {
    expect(redactFields({ password: 'p' })).toEqual({ password: MASK });
    expect(isSensitiveKey('X-Api-Key')).toBe(true);
    expect(isSensitiveKey('runId')).toBe(false);

    const sink = createMemorySink();
    const raw = createLogger({ sinks: [sink], clock: fixedClock, redact: false });
    raw.info('debug only', { password: 'visible' });
    expect(parseLogLine(sink.lines[0]!)['password']).toBe('visible');
  });

  it('survives cyclic field graphs and errors', () => {
    const sink = createMemorySink();
    const logger = createLogger({ sinks: [sink], clock: fixedClock });
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;

    logger.error('boom', { cyclic, error: new Error('failed'), deep: { a: { b: { c: { d: 1 } } } } });

    const record = parseLogLine(sink.lines[0]!);
    expect(record['error']).toEqual({ name: 'Error', message: 'failed' });
    expect((record['cyclic'] as Record<string, unknown>)['self']).toBeDefined();
    expect(nullLogger.child({})).toBe(nullLogger);
  });
});

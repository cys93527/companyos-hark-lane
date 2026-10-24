/**
 * Structured JSON-lines logger.
 *
 * Line shape (frozen in Sprint 0):
 *   {"ts":"<ISO-8601>","level":"info","msg":"...","traceId":"...","runId":"..."}
 *
 * `child()` merges extra bound fields, which is how correlation ids propagate
 * from the run context down into every adapter (§四十四 Audit).
 */
import { MASK, redactFields } from './redact.js';
import type { LogSink } from './sinks.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevelName;
  readonly msg: string;
  readonly [key: string]: unknown;
}

export interface LoggerClock {
  nowIso(): string;
}

export interface CreateLoggerOptions {
  readonly name?: string;
  readonly level?: LogLevelName;
  readonly sinks?: readonly LogSink[];
  readonly fields?: LogFields;
  readonly clock?: LoggerClock;
  /** Disable only for tests that assert raw values; production must keep it on. */
  readonly redact?: boolean;
}

export const levelRank = (level: LogLevelName): number => LOG_LEVELS.indexOf(level);

/** A log record as the single line that goes to a sink. */
export const toJsonLine = (record: LogRecord): string => JSON.stringify(record);

export function parseLogLine(line: string): LogRecord {
  return JSON.parse(line) as LogRecord;
}

class JsonLogger implements Logger {
  readonly #name: string;
  readonly #threshold: number;
  readonly #sinks: readonly LogSink[];
  readonly #fields: LogFields;
  readonly #clock: LoggerClock;
  readonly #redact: boolean;

  public constructor(options: {
    name: string;
    threshold: number;
    sinks: readonly LogSink[];
    fields: LogFields;
    clock: LoggerClock;
    redact: boolean;
  }) {
    this.#name = options.name;
    this.#threshold = options.threshold;
    this.#sinks = options.sinks;
    this.#fields = options.fields;
    this.#clock = options.clock;
    this.#redact = options.redact;
  }

  #write(level: LogLevelName, message: string, fields: LogFields = {}): void {
    if (levelRank(level) < this.#threshold) return;
    const merged: Record<string, unknown> = { ...this.#fields, ...fields };
    const safe = this.#redact ? redactFields(merged) : merged;
    const record: LogRecord = {
      ts: this.#clock.nowIso(),
      level,
      msg: message,
      logger: this.#name,
      ...safe,
    };
    const line = toJsonLine(record);
    for (const sink of this.#sinks) sink.write(line);
  }

  public debug(message: string, fields?: LogFields): void {
    this.#write('debug', message, fields);
  }

  public info(message: string, fields?: LogFields): void {
    this.#write('info', message, fields);
  }

  public warn(message: string, fields?: LogFields): void {
    this.#write('warn', message, fields);
  }

  public error(message: string, fields?: LogFields): void {
    this.#write('error', message, fields);
  }

  public child(fields: LogFields): Logger {
    return new JsonLogger({
      name: this.#name,
      threshold: this.#threshold,
      sinks: this.#sinks,
      fields: { ...this.#fields, ...fields },
      clock: this.#clock,
      redact: this.#redact,
    });
  }
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return new JsonLogger({
    name: options.name ?? 'companyos',
    threshold: levelRank(options.level ?? 'info'),
    sinks: options.sinks ?? [],
    fields: options.fields ?? {},
    clock: options.clock ?? { nowIso: () => new Date().toISOString() },
    redact: options.redact ?? true,
  });
}

/** Convenience: a logger that writes nothing (adapters that must stay silent). */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

export { MASK };

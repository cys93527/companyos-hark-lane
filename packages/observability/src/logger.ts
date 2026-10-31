/**
 * Structured JSON-lines logger.
 *
 * Line shape (frozen in Sprint 0):
 *   {"ts":"<ISO-8601>","level":"info","msg":"...","traceId":"...","runId":"..."}
 *
 * `child()` merges extra bound fields, which is how correlation ids propagate
 * from the run context down into every adapter (§四十四 Audit).
 */
import { MASK, redactFields, scrubString } from './redact.js';
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
  /**
   * Where the logger reports its OWN failures (a sink that threw, a record that could
   * not be serialized). Rate-limited per source. Default: one line on stderr. It must
   * never throw; if it does, the failure is swallowed (logging never fails a caller).
   */
  readonly onInternalError?: (report: LoggerInternalError) => void;
}

/** A logger-internal failure report (never contains the log line itself). */
export interface LoggerInternalError {
  /** `sink:<name>` or `record`. */
  readonly source: string;
  readonly message: string;
  /** Failures of this source since the previous report (rate limiting). */
  readonly failures: number;
}

/** Reserved record keys a caller field can never overwrite (AUDIT-P4). */
export const RESERVED_RECORD_KEYS = ['ts', 'level', 'msg', 'logger'] as const;
const RESERVED = new Set<string>(RESERVED_RECORD_KEYS);

/** Minimum gap between two internal-error reports of the same source. */
export const INTERNAL_ERROR_REPORT_INTERVAL_MS = 60_000;

const defaultInternalErrorReporter = (report: LoggerInternalError): void => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'logger internal failure', source: report.source, failures: report.failures, error: report.message })}\n`,
  );
};

/** Shared by a logger and all its children so rate limiting is per sink, not per child. */
class InternalErrorReporter {
  readonly #report: (report: LoggerInternalError) => void;
  readonly #state = new Map<string, { lastReportAt: number; pending: number }>();

  public constructor(report: (report: LoggerInternalError) => void) {
    this.#report = report;
  }

  public fail(source: string, error: unknown): void {
    try {
      const now = Date.now();
      const state = this.#state.get(source) ?? { lastReportAt: Number.NEGATIVE_INFINITY, pending: 0 };
      state.pending += 1;
      this.#state.set(source, state);
      if (now - state.lastReportAt < INTERNAL_ERROR_REPORT_INTERVAL_MS) return;
      const failures = state.pending;
      state.pending = 0;
      state.lastReportAt = now;
      const message = scrubString(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      this.#report({ source, message, failures });
    } catch {
      // Reporting a logging failure must never itself fail the caller.
    }
  }
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
  readonly #internal: InternalErrorReporter;

  public constructor(options: {
    name: string;
    threshold: number;
    sinks: readonly LogSink[];
    fields: LogFields;
    clock: LoggerClock;
    redact: boolean;
    internal: InternalErrorReporter;
  }) {
    this.#name = options.name;
    this.#threshold = options.threshold;
    this.#sinks = options.sinks;
    this.#fields = options.fields;
    this.#clock = options.clock;
    this.#redact = options.redact;
    this.#internal = options.internal;
  }

  /**
   * AUDIT-P1 — a log call NEVER throws into its caller. Logging sits inside business
   * `try` blocks and `.catch` handlers (DB bootstrap, recovery scheduling, migration
   * reporting); a failing sink must not turn a healthy operation into a failure. Each
   * sink is isolated, so one broken sink never starves the others, and the failure is
   * reported (rate-limited) through `onInternalError`.
   */
  #write(level: LogLevelName, message: string, fields: LogFields = {}): void {
    if (levelRank(level) < this.#threshold) return;
    let line: string;
    try {
      line = toJsonLine(this.#record(level, message, fields));
    } catch (error) {
      this.#internal.fail('record', error);
      try {
        line = toJsonLine({
          ts: this.#safeNow(),
          level,
          msg: this.#redact ? scrubString(String(message)) : String(message),
          logger: this.#name,
          logError: 'record could not be serialized; fields dropped',
        });
      } catch {
        return;
      }
    }
    for (const sink of this.#sinks) {
      try {
        sink.write(line, level);
      } catch (error) {
        this.#internal.fail(`sink:${sinkName(sink)}`, error);
      }
    }
  }

  /**
   * The record. Reserved keys (`ts`, `level`, `msg`, `logger`) always come from the
   * logger (AUDIT-P4): a caller field with a reserved name is kept under
   * `field.<name>` instead of silently rewriting the line's severity or message.
   */
  #record(level: LogLevelName, message: string, fields: LogFields): LogRecord {
    const merged: Record<string, unknown> = { ...this.#fields, ...fields };
    const safe = this.#redact ? redactFields(merged) : merged;
    const record: Record<string, unknown> = {
      ts: this.#clock.nowIso(),
      level,
      msg: this.#redact ? scrubString(message) : message,
      logger: this.#name,
    };
    for (const [key, value] of Object.entries(safe)) {
      const target = RESERVED.has(key) ? `field.${key}` : key;
      Object.defineProperty(record, target, { value, enumerable: true, writable: true, configurable: true });
    }
    return record as unknown as LogRecord;
  }

  #safeNow(): string {
    try {
      return this.#clock.nowIso();
    } catch {
      return new Date().toISOString();
    }
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
      internal: this.#internal,
    });
  }
}

const sinkName = (sink: LogSink): string => {
  try {
    return typeof sink.name === 'string' && sink.name.length > 0 ? sink.name : 'unnamed';
  } catch {
    return 'unnamed';
  }
};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return new JsonLogger({
    name: options.name ?? 'companyos',
    threshold: levelRank(options.level ?? 'info'),
    sinks: options.sinks ?? [],
    fields: options.fields ?? {},
    clock: options.clock ?? { nowIso: () => new Date().toISOString() },
    redact: options.redact ?? true,
    internal: new InternalErrorReporter(options.onInternalError ?? defaultInternalErrorReporter),
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

/**
 * Port: structured logging.
 *
 * Core depends on this interface only; the concrete JSON-lines implementation
 * lives in `@companyos/observability`. Log fields MUST already be redacted by the
 * caller for anything sensitive (see docs/SECURITY_MODEL.md).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger with extra bound fields (correlation ids etc.). */
  child(fields: LogFields): Logger;
}

/** Test double that records everything instead of writing it. */
export class MemoryLogger implements Logger {
  public readonly records: Array<{ level: LogLevel; message: string; fields: LogFields }> = [];

  public constructor(private readonly bound: LogFields = {}) {}

  #write(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.records.push({ level, message, fields: { ...this.bound, ...fields } });
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
    return new MemoryLogger({ ...this.bound, ...fields });
  }
}

/** No-op logger, for adapters that must not emit anything. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

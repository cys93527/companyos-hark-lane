/**
 * @companyos/observability — structured JSON-lines logging (planning-document
 * §四十四 Audit): redaction, correlation ids, console + rotating file sinks.
 *
 * The `Logger` interface here is structurally identical to the `Logger` port in
 * `@companyos/core` (which this package deliberately does NOT import at runtime —
 * see LAW 2 in scripts/check-boundaries.mjs). Compatibility is asserted by
 * `packages/observability/tests/logger.test.ts`.
 */
export { MASK, SENSITIVE_KEY_PATTERN, isSensitiveKey, redactFields, redactValue, scrubString } from './redact.js';
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  ROTATION_RETRY_INITIAL_MS,
  ROTATION_RETRY_MAX_MS,
  createConsoleSink,
  createMemorySink,
  createRotatingFileSink,
  totalSizeOfRotations,
} from './sinks.js';
export type { ConsoleSinkOptions, LogSink, MemorySink, RotatingFileSinkOptions, WritableLike } from './sinks.js';
export {
  INTERNAL_ERROR_REPORT_INTERVAL_MS,
  LOG_LEVELS,
  RESERVED_RECORD_KEYS,
  createLogger,
  levelRank,
  nullLogger,
  parseLogLine,
  toJsonLine,
} from './logger.js';
export type {
  CreateLoggerOptions,
  LogFields,
  LogLevelName,
  LogRecord,
  Logger,
  LoggerClock,
  LoggerInternalError,
} from './logger.js';

/**
 * @companyos/observability — structured JSON-lines logging (planning-document
 * §四十四 Audit): redaction, correlation ids, console + rotating file sinks.
 *
 * The `Logger` interface here is structurally identical to the `Logger` port in
 * `@companyos/core` (which this package deliberately does NOT import at runtime —
 * see LAW 2 in scripts/check-boundaries.mjs). Compatibility is asserted by
 * `packages/observability/tests/logger.test.ts`.
 */
export { MASK, SENSITIVE_KEY_PATTERN, isSensitiveKey, redactFields, redactValue } from './redact.js';
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  createConsoleSink,
  createMemorySink,
  createRotatingFileSink,
  totalSizeOfRotations,
} from './sinks.js';
export type { ConsoleSinkOptions, LogSink, MemorySink, RotatingFileSinkOptions, WritableLike } from './sinks.js';
export { LOG_LEVELS, createLogger, levelRank, nullLogger, parseLogLine, toJsonLine } from './logger.js';
export type { CreateLoggerOptions, LogFields, LogLevelName, LogRecord, Logger, LoggerClock } from './logger.js';

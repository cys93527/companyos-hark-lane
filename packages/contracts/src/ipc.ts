/**
 * Every message that crosses the renderer ↔ main trust boundary is declared
 * here exactly once and validated with zod at runtime (docs/SECURITY_MODEL.md).
 *
 * Rules:
 *   - channel names are literal constants; dynamic channel names are forbidden;
 *   - handlers are registered from this registry only (allow-list design);
 *   - payloads are parsed before use, never trusted.
 */
import { z } from 'zod';

export const IPC_CHANNELS = {
  appInfo: 'app:info',
  dbHealth: 'db:health',
  dbMigrate: 'db:migrate',
  logWrite: 'log:write',
  rendererReady: 'renderer:ready',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const IPC_CHANNEL_LIST = [
  IPC_CHANNELS.appInfo,
  IPC_CHANNELS.dbHealth,
  IPC_CHANNELS.dbMigrate,
  IPC_CHANNELS.logWrite,
  IPC_CHANNELS.rendererReady,
] as const;

export const IpcChannelSchema = z.enum(IPC_CHANNEL_LIST);

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);

/** Request payloads ------------------------------------------------------- */

export const EmptyRequestSchema = z.undefined().or(z.null()).or(z.object({}).strict());

export const LogWriteRequestSchema = z
  .object({
    level: LogLevelSchema,
    message: z.string().min(1).max(2_000),
    /** Free-form context; the main process re-redacts it before persisting. */
    fields: z.record(z.unknown()).optional(),
  })
  .strict();

export const RendererReadyRequestSchema = z
  .object({
    rendererVersion: z.string().min(1).max(64),
    startedAt: z.string().datetime(),
  })
  .strict();

/** Response payloads ------------------------------------------------------ */

export const AppInfoSchema = z
  .object({
    name: z.string().min(1),
    appVersion: z.string().min(1),
    electron: z.string().min(1),
    node: z.string().min(1),
    chrome: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    startedAt: z.string().datetime(),
    /** Sprint 0 ships no router: this stays 'none' until Sprint 7 (P2). */
    modelRouter: z.literal('none'),
  })
  .strict();

export const DbHealthSchema = z
  .object({
    ok: z.boolean(),
    databasePath: z.string().min(1),
    schemaVersion: z.number().int().nonnegative(),
    appliedMigrations: z.number().int().nonnegative(),
    journalMode: z.string().min(1),
    pageCount: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    checkedAt: z.string().datetime(),
  })
  .strict();

export const MigrationReportSchema = z
  .object({
    applied: z.array(
      z.object({ version: z.number().int(), name: z.string(), checksum: z.string() }).strict(),
    ),
    skipped: z.array(
      z.object({ version: z.number().int(), name: z.string(), checksum: z.string() }).strict(),
    ),
    currentVersion: z.number().int().nonnegative(),
  })
  .strict();

export const AckSchema = z.object({ ok: z.boolean(), error: z.string().optional() }).strict();

export type AppInfo = z.infer<typeof AppInfoSchema>;
export type DbHealth = z.infer<typeof DbHealthSchema>;
export type MigrationReportDto = z.infer<typeof MigrationReportSchema>;
export type LogWriteRequest = z.infer<typeof LogWriteRequestSchema>;
export type RendererReadyRequest = z.infer<typeof RendererReadyRequestSchema>;
export type Ack = z.infer<typeof AckSchema>;

/** Result envelope used by every handler — never leak raw exceptions to the UI. */
export type IpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export const IpcResultSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.union([
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: z.string() }).strict(),
  ]);

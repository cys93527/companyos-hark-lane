/**
 * Renderer-side view of the preload bridge.
 *
 * The renderer is untrusted: it cannot import Node built-ins or Electron, so this
 * module only *describes* what `window.companyos` may look like and degrades
 * gracefully when it is absent (e.g. unit tests, or a browser preview).
 */
export const BRIDGE_KEY = 'companyos';

export interface PlatformInfo {
  readonly platform: string;
  readonly arch: string;
  readonly electron: string;
  readonly node: string;
  readonly chrome: string;
}

export interface DatabaseStatus {
  readonly path: string | null;
  readonly journalMode: string | null;
  readonly schemaVersion: number;
  /** H12c: typed bootstrap failure from the main process (see database-failure.tsx). */
  readonly failure?: unknown;
  /** STARTUP-VISIBLE: typed core-services failure / degraded model provider (see services-failure.tsx). */
  readonly services?: unknown;
}

export interface WorkflowBridgeRequest {
  readonly operation: string;
  readonly requestId?: string;
  readonly payload?: unknown;
}

export interface CompanyOsBridge {
  appVersion(): Promise<string>;
  platformInfo(): Promise<PlatformInfo>;
  databaseStatus(): Promise<DatabaseStatus>;
  /**
   * Sprint 5: the Designer's single entry point. Optional so the shell keeps working in
   * a browser preview / unit test where the preload bridge is only partially faked.
   */
  workflowRequest?(request: WorkflowBridgeRequest): Promise<unknown>;
  /**
   * Sprint26: the Goal-to-Outcome runtime surface (goal entry, bounded pipeline
   * advance, approval responses, read projections). ONE method, ONE channel — the
   * trusted main-process control-plane service validates everything.
   */
  controlPlaneRequest?(request: WorkflowBridgeRequest): Promise<unknown>;
  /** STAGE 1: native directory chooser; resolves to the chosen path or null (cancelled). */
  workspaceSelect?(): Promise<string | null>;
  /** STAGE 1: open/validate the chosen directory as the run workspace (trusted main seam). */
  workspaceOpen?(root: string): Promise<{ readonly ok: boolean; readonly root: string; readonly error?: string }>;
  /** STAGE 1: the currently opened workspace path, or null. */
  workspaceCurrent?(): Promise<string | null>;
  /** Canonical single-workspace change: trusted close→open, fail-closed (typed refusal). */
  workspaceSwitch?(root: string): Promise<{ readonly ok: boolean; readonly root: string; readonly error?: string }>;
  /**
   * STAGE 3: bounded artifact actions. The renderer names a canonical artifact id and
   * nothing else — no path is ever accepted from the renderer.
   */
  artifactAction?(request: {
    readonly operation: 'preview' | 'open' | 'reveal';
    readonly artifactId: string;
  }): Promise<unknown>;
  /**
   * UI-AUDIT-3: 设置 → 模型服务 (one typed channel to the MAIN-process service). The API key
   * goes one way; nothing this returns carries it.
   */
  providerSettings?(request: { readonly operation: string; readonly payload?: unknown }): Promise<unknown>;
  channels(): readonly string[];
}

export const FALLBACK_APP_VERSION = '0.0.0-dev';

type AnyRecord = Record<string, unknown>;

const asRecord = (value: unknown): AnyRecord | null =>
  typeof value === 'object' && value !== null ? (value as AnyRecord) : null;

const hasFunction = (record: AnyRecord, key: string): boolean =>
  typeof record[key] === 'function';

export function isCompanyOsBridge(value: unknown): value is CompanyOsBridge {
  const record = asRecord(value);
  if (record === null) return false;
  return (
    hasFunction(record, 'appVersion') &&
    hasFunction(record, 'platformInfo') &&
    hasFunction(record, 'databaseStatus') &&
    hasFunction(record, 'channels')
  );
}

/** Read the bridge off an arbitrary scope (defaults to `globalThis`). */
export function getBridge(scope: unknown = globalThis): CompanyOsBridge | null {
  const record = asRecord(scope);
  if (record === null) return null;
  const candidate = record[BRIDGE_KEY];
  return isCompanyOsBridge(candidate) ? candidate : null;
}

export const bridgeAvailability = (scope: unknown = globalThis): 'available' | 'missing' =>
  getBridge(scope) === null ? 'missing' : 'available';

/** The version shown in the shell header; never throws. */
export async function resolveAppVersion(
  bridge: CompanyOsBridge | null,
  fallback: string = FALLBACK_APP_VERSION,
): Promise<string> {
  if (bridge === null) return fallback;
  try {
    const version = await bridge.appVersion();
    return typeof version === 'string' && version.length > 0 ? version : fallback;
  } catch {
    return fallback;
  }
}

export async function resolveDatabaseStatus(
  bridge: CompanyOsBridge | null,
): Promise<DatabaseStatus | null> {
  if (bridge === null) return null;
  try {
    return await bridge.databaseStatus();
  } catch {
    return null;
  }
}

/* ------------------------------------------------- AUDIT R7: IPC rejections --- */

/** Typed code for a bridge call whose promise rejected (main threw / IPC broke). */
export const IPC_FAILED = 'IPC_FAILED';

export interface IpcFailureEnvelope {
  readonly ok: false;
  readonly error: { readonly code: typeof IPC_FAILED; readonly message: string };
}

const describeError = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'UNKNOWN';
};

export const ipcFailureEnvelope = (error: unknown): IpcFailureEnvelope => ({
  ok: false,
  error: {
    code: IPC_FAILED,
    message: `与主进程通信失败（${describeError(error)}），操作结果未确认。`,
  },
});

export const isIpcFailure = (value: unknown): value is IpcFailureEnvelope => {
  const record = asRecord(value);
  if (record === null || record['ok'] !== false) return false;
  const error = asRecord(record['error']);
  return error !== null && error['code'] === IPC_FAILED;
};

/**
 * Run one bridge call and turn ANY rejection (or synchronous throw) into the typed
 * `{ ok:false, error:{ code:'IPC_FAILED' } }` envelope. Every renderer bridge call goes
 * through this so a main-process throw can never surface as an unhandled rejection or
 * leave a busy flag / spinner stuck.
 */
export async function safeRequest<T>(call: () => Promise<T>): Promise<T | IpcFailureEnvelope> {
  try {
    return await call();
  } catch (error) {
    return ipcFailureEnvelope(error);
  }
}

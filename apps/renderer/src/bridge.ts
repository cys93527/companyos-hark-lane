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

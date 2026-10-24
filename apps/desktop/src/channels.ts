/**
 * The IPC allow-list — the single source of truth shared by the main process and
 * the security tests (planning-document §四十七 / §三十九: a role only gets the
 * capabilities it needs, and the UI only gets the channels it needs).
 *
 * `apps/desktop/preload/preload.cjs` repeats this list because a sandboxed
 * preload cannot import an ES module; `tests/channels.test.ts` fails the build if
 * the two ever drift apart.
 */
export const CHANNELS = {
  appVersion: 'companyos:app-version',
  platformInfo: 'companyos:platform-info',
  databaseStatus: 'companyos:database-status',
  /** Workflow Designer requests (Sprint 5): ONE channel, schema-validated server side. */
  workflow: 'companyos:workflow',
  /**
   * Product Control Plane requests (Sprint 26): ONE channel for the Goal-to-Outcome
   * runtime — operation + payload, schema-validated by the trusted main-process
   * control-plane service. The renderer gets no other control surface.
   */
  controlPlane: 'companyos:control-plane',
  /**
   * DESKTOP STAGE 1 — workspace selection (operational context, not truth):
   * native directory chooser, trusted open on the ONE repository runtime, and the
   * persisted-selection read used for restart rehydration. Three narrow channels;
   * the renderer never touches the filesystem itself.
   */
  workspaceSelect: 'companyos:workspace-select',
  workspaceOpen: 'companyos:workspace-open',
  workspaceCurrent: 'companyos:workspace-current',
  /**
   * BUG BASH workspace-switch closure — the canonical SINGLE-WORKSPACE change command.
   * The engine is intentionally single-active-workspace (a second open is refused), so the
   * ONLY supported change operation is this trusted main-process lifecycle:
   * close (lease-guarded, fail-closed) → open the new root → read back canonical identity.
   * A refused switch always leaves the previous workspace canonical; the renderer only ever
   * updates its display from the canonical result — never from its own intent.
   */
  workspaceSwitch: 'companyos:workspace-switch',
  /**
   * STAGE 3 — the bounded artifact surface (Preview / Open / Reveal in Explorer).
   * ONE typed channel: `{ operation: 'preview' | 'open' | 'reveal', artifactId }`. The
   * renderer may name a CANONICAL ARTIFACT ID and nothing else — no path, no
   * `openAnyPath(string)` primitive — and every action is resolved and contained inside
   * the trusted main process against the artifact CAS.
   */
  artifacts: 'companyos:artifacts',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

export const ALLOWED_CHANNELS: readonly ChannelName[] = Object.freeze([
  CHANNELS.appVersion,
  CHANNELS.platformInfo,
  CHANNELS.databaseStatus,
  CHANNELS.workflow,
  CHANNELS.controlPlane,
  CHANNELS.workspaceSelect,
  CHANNELS.workspaceOpen,
  CHANNELS.workspaceCurrent,
  CHANNELS.workspaceSwitch,
  CHANNELS.artifacts,
]);

export const isAllowedChannel = (channel: string): channel is ChannelName =>
  (ALLOWED_CHANNELS as readonly string[]).includes(channel);

/** Key the preload bridge is exposed under: `window.companyos`. */
export const BRIDGE_KEY = 'companyos';

export interface PlatformInfo {
  readonly platform: string;
  readonly arch: string;
  readonly electron: string;
  readonly node: string;
  readonly chrome: string;
}

export interface DatabaseStatus {
  /** Absolute path of the SQLite file, or `:memory:`. */
  readonly path: string | null;
  readonly journalMode: string | null;
  readonly schemaVersion: number;
}

/** Shape of `window.companyos` as seen by the renderer. */
export interface CompanyOsBridge {
  appVersion(): Promise<string>;
  platformInfo(): Promise<PlatformInfo>;
  databaseStatus(): Promise<DatabaseStatus>;
  /**
   * One entry point for every Designer call (Sprint 5): the renderer sends an
   * operation + payload, the main process validates and routes it. No other channel
   * may be added for workflow features.
   */
  workflowRequest(request: {
    readonly operation: string;
    readonly requestId?: string;
    readonly payload?: unknown;
  }): Promise<unknown>;
  /**
   * Sprint 26: the Goal-to-Outcome runtime surface — goal entry, bounded pipeline
   * advance, approval responses and read projections. ONE method, ONE channel; the
   * main-process service validates everything and owns no truth.
   */
  controlPlaneRequest(request: {
    readonly operation: string;
    readonly payload?: unknown;
  }): Promise<unknown>;
  /** STAGE 1: open the native directory chooser; resolves to the chosen path or null. */
  workspaceSelect(): Promise<string | null>;
  /** STAGE 1: open (validate + bind) the given directory as the run workspace. */
  workspaceOpen(root: string): Promise<{ readonly ok: boolean; readonly root: string; readonly error?: string }>;
  /** STAGE 1: the currently opened workspace path, or null. */
  workspaceCurrent(): Promise<string | null>;
  /**
   * BUG BASH closure: the canonical single-workspace CHANGE command. Fails closed — on any
   * refusal the previous workspace stays canonical and the typed error is returned.
   */
  workspaceSwitch(root: string): Promise<{ readonly ok: boolean; readonly root: string; readonly error?: string }>;
  /**
   * STAGE 3: the bounded artifact surface. `artifactAction({ operation, artifactId })` —
   * the renderer may name a canonical artifact id only; no path is ever accepted.
   */
  artifactAction(request: {
    readonly operation: 'preview' | 'open' | 'reveal';
    readonly artifactId: string;
  }): Promise<unknown>;
  channels(): readonly string[];
}

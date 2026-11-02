/**
 * AUDIT-D8 — the ONE quiescent startup sequence, shared by the boot and the lazy (post-boot) retry.
 *
 * Root cause: the boot ran open DB -> CAS reconcile -> compose -> recovery -> autonomy -> rehydrate,
 * while the lazy IPC path re-implemented a fragment of it: it opened a NEW database handle on every
 * call (never assigned, never closed), composed with the boot's still-null artifact foundation (so it
 * could never succeed), never cleared the database failure, and on a later success skipped startup
 * recovery and never created the autonomy launcher.
 *
 * Here every step runs in order, each one at most once per success:
 *   - the database handle is kept once opened (a retry never opens a second one); a refusal the
 *     policy marks non-retryable is never re-opened;
 *   - the artifact foundation is reconciled once per database handle;
 *   - composition is retried while it fails (non-fatal: the shell stays up and reports it);
 *   - core services are committed only AFTER recovery passed, then autonomy and rehydration run;
 *   - a fatal finding (CAS integrity, recovery safety) closes the handle and is sticky for the process.
 * Concurrent callers share one in-flight attempt.
 */
export type RecoveryStepResult = { readonly kind: 'ok' } | { readonly kind: 'fatal'; readonly code: string; readonly message: string };
export type FoundationStepResult<F> =
  | { readonly ok: true; readonly value: F }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface RuntimeStarterSteps<Db, F, Core> {
  /** Opens the durable database, or records its own failure and answers null. */
  readonly openDatabase: () => Db | null;
  /** Whether a database refusal may be retried in this process. */
  readonly databaseRetryable: () => boolean;
  readonly openFoundation: (db: Db) => Promise<FoundationStepResult<F>>;
  /** Composes the core services; null = composition failed (records its own reason). */
  readonly compose: (db: Db, foundation: F) => Promise<Core | null>;
  readonly recover: (db: Db, core: Core) => Promise<RecoveryStepResult>;
  /** Called exactly once, after recovery passed: the composition becomes the product instance. */
  readonly commit: (db: Db, foundation: F, core: Core) => void;
  readonly startAutonomy: (db: Db, core: Core) => Promise<void>;
  readonly rehydrate: (core: Core) => Promise<void>;
  readonly closeDatabase: (db: Db) => void;
}

export type RuntimeStartOutcome<Db, Core> =
  | { readonly kind: 'ready'; readonly db: Db; readonly core: Core }
  | { readonly kind: 'unavailable'; readonly stage: 'database' | 'composition'; readonly db: Db | null }
  | { readonly kind: 'fatal'; readonly stage: 'artifact-integrity' | 'recovery'; readonly code: string; readonly message: string };

export interface RuntimeStarter<Db, Core> {
  start(): Promise<RuntimeStartOutcome<Db, Core>>;
}

export function createRuntimeStarter<Db, F, Core>(steps: RuntimeStarterSteps<Db, F, Core>): RuntimeStarter<Db, Core> {
  let db: Db | null = null;
  let databaseAttempted = false;
  let foundation: F | null = null;
  let ready: { readonly kind: 'ready'; readonly db: Db; readonly core: Core } | null = null;
  let fatal: Extract<RuntimeStartOutcome<Db, Core>, { kind: 'fatal' }> | null = null;
  let inFlight: Promise<RuntimeStartOutcome<Db, Core>> | null = null;

  const failClosed = (
    stage: 'artifact-integrity' | 'recovery',
    code: string,
    message: string,
  ): RuntimeStartOutcome<Db, Core> => {
    if (db !== null) steps.closeDatabase(db);
    db = null;
    foundation = null;
    fatal = { kind: 'fatal', stage, code, message };
    return fatal;
  };

  const attempt = async (): Promise<RuntimeStartOutcome<Db, Core>> => {
    if (ready !== null) return ready;
    if (fatal !== null) return fatal;
    if (db === null) {
      if (databaseAttempted && !steps.databaseRetryable()) return { kind: 'unavailable', stage: 'database', db: null };
      databaseAttempted = true;
      db = steps.openDatabase();
      if (db === null) return { kind: 'unavailable', stage: 'database', db: null };
    }
    const openDb = db;
    if (foundation === null) {
      const opened = await steps.openFoundation(openDb);
      if (!opened.ok) return failClosed('artifact-integrity', opened.code, opened.message);
      foundation = opened.value;
    }
    const core = await steps.compose(openDb, foundation);
    if (core === null) return { kind: 'unavailable', stage: 'composition', db: openDb };
    const recovered = await steps.recover(openDb, core);
    if (recovered.kind === 'fatal') return failClosed('recovery', recovered.code, recovered.message);
    steps.commit(openDb, foundation, core);
    await steps.startAutonomy(openDb, core);
    await steps.rehydrate(core);
    ready = { kind: 'ready', db: openDb, core };
    return ready;
  };

  return {
    start() {
      if (inFlight !== null) return inFlight;
      inFlight = attempt().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

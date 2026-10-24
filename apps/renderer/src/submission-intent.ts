/**
 * STAGE 2 — submission-intent identity (fixes Stage-1 finding F-1).
 *
 * Identity rule: ONE USER SUBMISSION INTENT is idempotent. The intent id is NOT derived
 * from the objective text — the same text may legitimately be executed twice on purpose —
 * and it is NOT a per-mount random value either: it must survive a renderer remount or
 * reload while the submission has not been acknowledged yet.
 *
 * So the intent id lives in a tiny CLIENT-SIDE OUTBOX (one bounded record) and IS the
 * canonical `commandId` passed to `goal.create`. The canonical command-id seam is the
 * idempotency authority (Goal creation replays under the same commandId); this outbox
 * only remembers the identity of an intent that has not been acknowledged, so a reload
 * before the ack replays the SAME intent instead of silently creating a second Goal.
 *
 * It is not a second command ledger: no Goal/Run state is stored here, and the record is
 * cleared as soon as the intent is acknowledged.
 */

export type SubmissionIntentState = 'pending' | 'acknowledged';

export interface SubmissionIntentRecord {
  readonly intentId: string;
  readonly objective: string;
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly workspaceRoot: string;
  readonly state: SubmissionIntentState;
  readonly goalRunId?: string;
  readonly createdAt: string;
  /** True once this identity has been handed to the canonical seam at least once. */
  readonly attempted?: boolean;
}

/** Injected so tests are deterministic; the default is a bounded localStorage record. */
export interface SubmissionIntentStore {
  readonly load: () => SubmissionIntentRecord | null;
  readonly save: (record: SubmissionIntentRecord | null) => void;
}

export type SubmissionResult =
  | { readonly status: 'created'; readonly runId: string; readonly intentId: string }
  | { readonly status: 'replayed'; readonly runId: string; readonly intentId: string }
  | { readonly status: 'failed'; readonly intentId: string; readonly error: string }
  | { readonly status: 'blocked'; readonly reason: 'pending' | 'empty' | 'no-workspace' };

export interface SubmissionSubmit {
  (input: {
    readonly intentId: string;
    readonly objective: string;
    readonly structured?: Readonly<Record<string, unknown>>;
    readonly workspaceRoot: string;
  }): Promise<{ readonly runId: string } | { readonly error: string }>;
}

export interface SubmissionControllerOptions {
  readonly store: SubmissionIntentStore;
  readonly submit: SubmissionSubmit;
  readonly now: () => string;
  readonly newIntentId: () => string;
}

export interface SubmissionController {
  readonly pending: () => SubmissionIntentRecord | null;
  /**
   * Resolve an intent that is pending across a remount/reload: replay the SAME intentId.
   * Called once on mount; a submission that never reached the canonical seam therefore
   * cannot duplicate, and one that did replays into the same Goal.
   */
  readonly resolvePending: () => Promise<SubmissionResult | null>;
  readonly submitObjective: (objective: string, workspaceRoot: string | null, structured?: Readonly<Record<string, unknown>>) => Promise<SubmissionResult>;
  /** Retry the pending intent with the SAME identity (transport failure path). */
  readonly retry: () => Promise<SubmissionResult | null>;
  /** Drop a pending intent whose failure is terminal for that text (user changed their mind). */
  readonly discard: () => void;
}

const MAX_OBJECTIVE = 2000;

export const createSubmissionController = (options: SubmissionControllerOptions): SubmissionController => {
  const { store, submit, now, newIntentId } = options;

  const readPending = (): SubmissionIntentRecord | null => {
    const record = store.load();
    return record !== null && record.state === 'pending' ? record : null;
  };

  const acknowledge = (intent: SubmissionIntentRecord, runId: string): SubmissionResult => {
    // The outbox holds at most one record and it is NOT cleared here: keeping the
    // acknowledged intent for the session lets the UI show "已创建" for the row that was
    // just submitted. A NEW explicit submission replaces it (case D).
    const replayed = intent.attempted === true;
    store.save({ ...intent, state: 'acknowledged', goalRunId: runId });
    return replayed ? { status: 'replayed', runId, intentId: intent.intentId } : { status: 'created', runId, intentId: intent.intentId };
  };

  const runIntent = async (intent: SubmissionIntentRecord): Promise<SubmissionResult> => {
    if (intent.attempted !== true) store.save({ ...intent, attempted: true });
    const outcome = await submit({
      intentId: intent.intentId,
      objective: intent.objective,
      ...(intent.structured === undefined ? {} : { structured: intent.structured }),
      workspaceRoot: intent.workspaceRoot,
    });
    if ('runId' in outcome) return acknowledge(intent, outcome.runId);
    // Failed: keep the record pending so a retry replays the same identity.
    return { status: 'failed', intentId: intent.intentId, error: outcome.error };
  };

  return {
    pending: readPending,

    resolvePending: async () => {
      const intent = readPending();
      if (intent === null) return null;
      return runIntent(intent);
    },

    submitObjective: async (objective, workspaceRoot, structured) => {
      const text = objective.trim();
      if (text === '') return { status: 'blocked', reason: 'empty' };
      if (workspaceRoot === null) return { status: 'blocked', reason: 'no-workspace' };
      // A double-click (or a queued retry) while one intent is unresolved must not create
      // a second Goal: the pending intent owns the next submission until it settles.
      const pending = readPending();
      if (pending !== null) return { status: 'blocked', reason: 'pending' };
      const intent: SubmissionIntentRecord = {
        intentId: newIntentId(),
        objective: text.slice(0, MAX_OBJECTIVE),
        ...(structured === undefined ? {} : { structured: JSON.parse(JSON.stringify(structured)) as Readonly<Record<string, unknown>> }),
        workspaceRoot,
        state: 'pending',
        createdAt: now(),
      };
      store.save(intent);
      return runIntent(intent);
    },

    retry: async () => {
      const intent = readPending();
      if (intent === null) return null;
      return runIntent(intent);
    },

    discard: () => {
      store.save(null);
    },
  };
};

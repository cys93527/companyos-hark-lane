/**
 * STAGE 2 — the browser-side backing store for ONE unacknowledged submission intent.
 *
 * Bounded by construction: at most one record, and it is replaced (never appended) on the
 * next submission. It holds NO Goal/Run truth — only the identity of a submission the
 * canonical command has not acknowledged yet, which is what makes a reload before the ack
 * safe (see submission-intent.ts).
 */
import type { SubmissionIntentRecord, SubmissionIntentStore } from './submission-intent.js';

export const SUBMISSION_INTENT_STORAGE_KEY = 'companyos.submission-intent.v1';

const hasStorage = (storage: unknown): storage is Storage =>
  typeof storage === 'object' && storage !== null && typeof (storage as Storage).getItem === 'function';

const parseRecord = (raw: string | null): SubmissionIntentRecord | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record['intentId'] !== 'string' || typeof record['objective'] !== 'string') return null;
    return {
      intentId: record['intentId'],
      objective: record['objective'],
      ...(record['structured'] === undefined ? {} : { structured: record['structured'] as Readonly<Record<string, unknown>> }),
      workspaceRoot: typeof record['workspaceRoot'] === 'string' ? record['workspaceRoot'] : '',
      state: record['state'] === 'acknowledged' ? 'acknowledged' : 'pending',
      createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
    };
  } catch {
    return null;
  }
};

/**
 * A store backed by localStorage when it exists (the real app) and a no-op in-memory
 * store otherwise (SSR/tests): a missing store must never break the shell, only lose the
 * reload-protection — and in that case the intent can no longer be replayed, which is
 * exactly the behaviour the canonical command-id ledger would enforce anyway.
 */
export const createSubmissionIntentStore = (storage: unknown = typeof localStorage === 'undefined' ? null : localStorage): SubmissionIntentStore => {
  const usable = hasStorage(storage) ? storage : null;
  return {
    load: () => (usable === null ? null : parseRecord(usable.getItem(SUBMISSION_INTENT_STORAGE_KEY))),
    save: (record) => {
      if (usable === null) return;
      if (record === null) usable.removeItem(SUBMISSION_INTENT_STORAGE_KEY);
      else usable.setItem(SUBMISSION_INTENT_STORAGE_KEY, JSON.stringify(record));
    },
  };
};

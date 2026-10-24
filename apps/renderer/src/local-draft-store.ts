/** Non-authoritative editor data. Never an outbox, Goal, Run or execution permit. */
export interface LocalDraft {
  readonly state: 'LOCAL_DRAFT';
  readonly companyId: string;
  readonly workspaceRoot: string;
  readonly objective: string;
}

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
const PREFIX = 'companyos.local-draft.v1:';
const keyOf = (companyId: string, workspaceRoot: string): string => {
  if (!companyId || !workspaceRoot || companyId.length > 128 || workspaceRoot.length > 2048) throw new Error('LOCAL_DRAFT_SCOPE_INVALID');
  return PREFIX + JSON.stringify([companyId, workspaceRoot]);
};
const checkObjective = (objective: unknown): string => {
  if (typeof objective !== 'string' || objective.length > 2000) throw new Error('LOCAL_DRAFT_CONTENT_INVALID');
  // Do not persist recognizable credential assignments/literals supplied in editor text.
  if (/(?:api[-_ ]?key|secret|token|password|credential)\s*[:=]\s*\S|\bbearer\s+\S|\bsk-[a-z0-9]{16,}|-----BEGIN .*PRIVATE KEY-----/iu.test(objective)) throw new Error('LOCAL_DRAFT_CREDENTIAL_REFUSED');
  return objective;
};

export const createLocalDraftStore = (storage: DraftStorage | null) => ({
  save(companyId: string, workspaceRoot: string, objective: string): void {
    const key = keyOf(companyId, workspaceRoot);
    const record: LocalDraft = { state: 'LOCAL_DRAFT', companyId, workspaceRoot, objective: checkObjective(objective) };
    if (storage === null) throw new Error('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    storage.setItem(key, JSON.stringify(record)); // Quota/security errors propagate; never submit.
  },
  load(companyId: string, workspaceRoot: string): LocalDraft | null {
    const key = keyOf(companyId, workspaceRoot);
    if (storage === null) throw new Error('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    const raw = storage.getItem(key);
    if (raw === null) return null;
    if (raw.length > 8192) throw new Error('LOCAL_DRAFT_RECORD_INVALID');
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('LOCAL_DRAFT_RECORD_INVALID');
    const r = value as Record<string, unknown>;
    if (Object.keys(r).sort().join(',') !== 'companyId,objective,state,workspaceRoot' || r['state'] !== 'LOCAL_DRAFT' || r['companyId'] !== companyId || r['workspaceRoot'] !== workspaceRoot) throw new Error('LOCAL_DRAFT_RECORD_INVALID');
    return { state: 'LOCAL_DRAFT', companyId, workspaceRoot, objective: checkObjective(r['objective']) };
  },
});

/** Electron default-session DOM storage is scoped by its isolated userData profile. */
export const browserDraftStorage = (): DraftStorage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
};

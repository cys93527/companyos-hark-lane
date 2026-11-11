/**
 * UI-AUDIT-3 (user 2026-11-11: "截图的都是啥…没用都放设置") — the draft is saved SILENTLY.
 *
 * Replaces the 保存草稿 / 恢复草稿 buttons and their status line: the unsent text of each
 * workspace is written to local storage shortly after every change (an emptied field removes it)
 * and put back into the empty field when that workspace opens. A manual restore offer is not
 * needed: restore only ever fills an EMPTY field (the field is cleared on every workspace change),
 * so it can never overwrite typing. The one thing the user is told is when text was NOT saved
 * because it looks like a credential (LOCAL_DRAFT_CREDENTIAL_REFUSED) — that is actionable.
 * Still non-authoritative editor data: never an outbox, Goal, Run or execution permit.
 */
import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { browserDraftStorage, createLocalDraftStore, type DraftStorage } from './local-draft-store.js';

export interface DraftAutosaveProps {
  readonly companyId: string;
  readonly workspaceRoot: string | null;
  readonly objective: string;
  readonly onRestore: (objective: string) => void;
  /** Debounce before a change is written (ms). */
  readonly delayMs?: number;
  /** Injected for tests; defaults to the profile's local storage. */
  readonly storage?: DraftStorage | null;
}

export const DRAFT_CREDENTIAL_NOTE = '内容里像是有密钥，这段文字不会保存为草稿。';

export function DraftAutosave(props: DraftAutosaveProps): JSX.Element | null {
  const store = useMemo(() => createLocalDraftStore(props.storage === undefined ? browserDraftStorage() : props.storage), [props.storage]);
  const [note, setNote] = useState<string | null>(null);
  const { companyId, workspaceRoot, onRestore, objective } = props;
  // The scope the field currently belongs to; a save never lands in another workspace's slot.
  const restoredFor = useRef<string | null>(null);
  // The objective prop of the render that restored still belongs to the PREVIOUS scope: skip it.
  const skipNext = useRef(false);
  useLayoutEffect(() => {
    // Clear old editor contents before paint; never carry one Workspace's draft into another.
    restoredFor.current = null;
    skipNext.current = true;
    onRestore('');
    setNote(null);
    if (workspaceRoot === null) return;
    try {
      onRestore(store.load(companyId, workspaceRoot)?.objective ?? '');
    } catch {
      // An unreadable record is left alone (not restored, not overwritten until the user types).
    }
    restoredFor.current = workspaceRoot;
  }, [store, companyId, workspaceRoot, onRestore]);
  useEffect(() => {
    if (workspaceRoot === null || restoredFor.current !== workspaceRoot) return;
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (objective.trim() === '') store.remove(companyId, workspaceRoot);
        else store.save(companyId, workspaceRoot, objective);
        setNote(null);
      } catch (error) {
        setNote(error instanceof Error && error.message === 'LOCAL_DRAFT_CREDENTIAL_REFUSED' ? DRAFT_CREDENTIAL_NOTE : null);
      }
    }, props.delayMs ?? 400);
    return () => clearTimeout(timer);
  }, [store, companyId, workspaceRoot, objective, props.delayMs]);
  return note === null ? null : h('p', { className: 'composer__draft-note muted', role: 'status', 'data-testid': 'local-draft-note' }, note);
}

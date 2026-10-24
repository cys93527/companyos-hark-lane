/**
 * Durable Session store port (Sprint 19 / Task-19-02).
 *
 * The port the Session kernel consumes. It is deliberately TINY: sessions are created
 * idempotently, entries are appended with a per-session sequence and a permanent command
 * identity, and reads are ordered folds. There is no update and no delete — entries are
 * append-only by construction (T19-02 §15) and there is no session status machine to
 * mutate (§5).
 *
 * Every read/write is tenant-scoped by `companyId`; a foreign tenant's session is
 * indistinguishable from a missing one (§9).
 */
import type { DomainError } from '../kernel/errors.js';
import type { Result } from '../kernel/result.js';
import type { SessionEntry, SessionRecord } from '../lifecycle/session.js';

/** The durable row an append produced (the permanent replay record). */
export interface SessionEntryRow extends SessionEntry {
  /** The semantic fingerprint of the append command; replay compares it (§17). */
  readonly fingerprint: string;
}

export interface SessionStorePort {
  /** Insert a session row; the UNIQUE(company,run,task,role) index arbitrates idempotency. */
  insert(session: SessionRecord): Promise<void>;

  /** Read one session by id, scoped to the company; null when absent or foreign. */
  get(input: {
    readonly sessionId: string;
    readonly companyId: string;
  }): Promise<SessionRecord | null>;

  /**
   * Append one entry. The KERNEL allocates the sequence and the fingerprint; the store
   * enforces PRIMARY KEY(session_id, sequence) and UNIQUE(session_id, command_id), so a
   * concurrent duplicate append fails at the database level and the kernel converts it into
   * the replay answer (§36/§17).
   */
  append(
    entry: SessionEntryRow,
  ): Promise<
    Result<{ readonly sequence: number } | { readonly replay: SessionEntryRow }, DomainError>
  >;

  /** Read one entry by its permanent command identity (the replay lookup). */
  entryByCommand(input: {
    readonly sessionId: string;
    readonly commandId: string;
  }): Promise<SessionEntryRow | null>;

  /** Every entry of one session ordered by sequence ascending. */
  listEntries(sessionId: string): Promise<readonly SessionEntryRow[]>;

  /** The highest allocated sequence of a session (0 when the session has no entries). */
  lastSequence(sessionId: string): Promise<number>;
}

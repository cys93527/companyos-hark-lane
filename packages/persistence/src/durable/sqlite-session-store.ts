/**
 * Durable Session store (Sprint 19 / Task-19-02) — the SQLite realization of the kernel's
 * port. Append-only: no UPDATE, no DELETE exists in this module. Concurrency (§36): every
 * write runs on the database's single serialized connection; the kernel allocates sequences
 * inside a UnitOfWork transaction, and the PRIMARY KEY(session_id, sequence) plus
 * UNIQUE(session_id, command_id) indexes make a duplicate append fail at the database level
 * rather than silently double-append.
 */
import type {
  DomainError,
  Result,
  SessionCanonicalRef,
  SessionEntryKind,
  SessionEntryRow,
  SessionRecord,
} from '@companyos/core';
import { domainError, err, ok } from '@companyos/core';

import type { SessionStorePort } from '@companyos/core';

import type { Database } from '../db.js';

interface SessionRow {
  readonly session_id: string;
  readonly company_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly role_key: string;
  readonly parent_session_id: string | null;
  readonly created_at: string;
}

interface EntryRow {
  readonly session_id: string;
  readonly sequence: number | bigint;
  readonly command_id: string;
  readonly entry_kind: string;
  readonly text: string;
  readonly refs_json: string;
  readonly execution_id: string | null;
  readonly input_token_estimate: number | bigint;
  readonly output_token_count: number | bigint | null;
  readonly fingerprint: string;
  readonly created_at: string;
}

const recordOf = (row: SessionRow): SessionRecord => ({
  sessionId: row.session_id,
  companyId: row.company_id,
  runId: row.run_id,
  taskId: row.task_id,
  roleKey: row.role_key,
  parentSessionId: row.parent_session_id,
  createdAt: row.created_at,
});

const entryOf = (row: EntryRow): SessionEntryRow => ({
  sessionId: row.session_id,
  sequence: Number(row.sequence),
  commandId: row.command_id,
  entryKind: row.entry_kind as SessionEntryKind,
  text: row.text,
  refs: JSON.parse(String(row.refs_json)) as readonly SessionCanonicalRef[],
  executionId: row.execution_id,
  tokenAccounting: {
    inputTokenEstimate: Number(row.input_token_estimate),
    outputTokenCount: row.output_token_count === null ? null : Number(row.output_token_count),
  },
  createdAt: row.created_at,
  fingerprint: row.fingerprint,
});

export function createSqliteSessionStore(db: Database): SessionStorePort {
  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, company_id, run_id, task_id, role_key, parent_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectSession = db.prepare(
    'SELECT * FROM sessions WHERE session_id = ? AND company_id = ?',
  );
  const insertEntry = db.prepare(
    `INSERT INTO session_entries
       (session_id, sequence, command_id, entry_kind, text, refs_json, execution_id,
        input_token_estimate, output_token_count, fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectByCommand = db.prepare(
    'SELECT * FROM session_entries WHERE session_id = ? AND command_id = ?',
  );
  const selectEntries = db.prepare(
    'SELECT * FROM session_entries WHERE session_id = ? ORDER BY sequence ASC',
  );
  const selectLast = db.prepare(
    'SELECT COALESCE(MAX(sequence), 0) AS last FROM session_entries WHERE session_id = ?',
  );

  return {
    async insert(session: SessionRecord): Promise<void> {
      insertSession.run(
        session.sessionId,
        session.companyId,
        session.runId,
        session.taskId,
        session.roleKey,
        session.parentSessionId,
        session.createdAt,
      );
    },

    async get(input: {
      readonly sessionId: string;
      readonly companyId: string;
    }): Promise<SessionRecord | null> {
      const row = selectSession.get(input.sessionId, input.companyId) as SessionRow | undefined;
      return row === undefined ? null : recordOf(row);
    },

    async append(entry: SessionEntryRow): Promise<
      Result<{ readonly sequence: number } | { readonly replay: SessionEntryRow }, DomainError>
    > {
      try {
        insertEntry.run(
          entry.sessionId,
          entry.sequence,
          entry.commandId,
          entry.entryKind,
          entry.text,
          JSON.stringify(entry.refs),
          entry.executionId,
          entry.tokenAccounting.inputTokenEstimate,
          entry.tokenAccounting.outputTokenCount,
          entry.fingerprint,
          entry.createdAt,
        );
        return ok({ sequence: entry.sequence });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE constraint failed: session_entries\.session_id, session_entries\.command_id/.test(message)) {
          const existing = selectByCommand.get(entry.sessionId, entry.commandId) as
            | EntryRow
            | undefined;
          if (existing !== undefined) return ok({ replay: entryOf(existing) });
        }
        return err(
          domainError('PERSISTENCE_FAILED', `The session entry append was refused: ${message}`, {
            reason: 'SESSION_ENTRY_APPEND_REFUSED',
            sessionId: entry.sessionId,
            sequence: entry.sequence,
          }),
        );
      }
    },

    async entryByCommand(input: {
      readonly sessionId: string;
      readonly commandId: string;
    }): Promise<SessionEntryRow | null> {
      const row = selectByCommand.get(input.sessionId, input.commandId) as
        | EntryRow
        | undefined;
      return row === undefined ? null : entryOf(row);
    },

    async listEntries(sessionId: string): Promise<readonly SessionEntryRow[]> {
      const rows = selectEntries.all(sessionId) as EntryRow[];
      return rows.map(entryOf);
    },

    async lastSequence(sessionId: string): Promise<number> {
      const row = selectLast.get(sessionId) as { last: number | bigint };
      return Number(row.last);
    },
  };
}


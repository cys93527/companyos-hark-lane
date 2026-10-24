/**
 * Durable Session kernel (Sprint 19 / Task-19-02) — the generic, role-free kernel ONLY.
 *
 * What this module is: an idempotent session factory (deterministic tenant-scoped identity),
 * an append-only entry log with permanent replay identity, a deterministic active-window
 * compaction checkpoint writer, and a pure active-context reader.
 *
 * What this module is NOT (Boss frozen ruling §1/§19-§22): it is not a workflow, task,
 * decision, execution, memory, scheduler, retry machine, evidence or authority surface. It
 * cannot complete tasks, create decisions, dispatch lifecycle events, grant anything, or
 * touch RunSnapshot/WorkflowVersion. It is trusted process-internal infrastructure: no Tool,
 * no IPC, no UI, and NO role integration (Supervisor stays state-reconstructed; Developer /
 * Reviewer / QA integration belongs to T19-03+).
 */
import {
  domainError,
  err,
  ok,
  sessionIdOf,
  SESSION_COMPACTION_CHECKPOINT_SCHEMA,
  SESSION_CONTEXT_SEED_SCHEMA,
  SESSION_ENTRY_KINDS,
  SESSION_ENTRY_LIMITS,
  SESSION_FIRST_SEQUENCE,
  utf8ByteLength,
  isValidSessionRef,
  type DomainError,
  type Result,
  type SessionCanonicalRef,
  type SessionEntryKind,
  type SessionEntryRow,
  type SessionRecord,
  type SessionStorePort,
} from '@companyos/core';

/** Redaction seam (§23): applied to every textual entry BEFORE the durable write. */
export interface SessionRedactionBoundary {
  /** Return the text safe to persist; the default boundary is the identity function. */
  redact(text: string): string;
  /** Known secret values for tests; never persisted, only compared/redacted away. */
  knownSecrets?(): readonly string[];
}

/** Ownership readers (§10): sessions are refused for runs/tasks that do not exist. */
export interface SessionOwnershipReaders {
  readonly runs: {
    get(
      runId: string,
    ): Promise<{ readonly id: string; readonly companyId: string } | null>;
  };
  readonly tasks: { get(taskId: string): Promise<{ readonly id: string; readonly stageId: string } | null> };
  /**
   * The task→run binding proof. Task rows carry no runId, so the proof is the pinned-graph
   * membership rule the decision sink already uses; the caller supplies it as a seam.
   */
  taskBelongsToRun(input: {
    readonly runId: string;
    readonly taskId: string;
  }): Promise<boolean>;
  /**
   * Corrective ruling C: the durable AgentExecution reader used to validate an entry's
   * executionId BEFORE the append commits. Absent ⇒ the kernel cannot prove the reference
   * and every execution-bearing append fails closed (no foreign execution association).
   */
  readonly executions?: {
    get(executionId: string): Promise<{
      readonly executionId: string;
      readonly runId: string;
      readonly taskId: string;
      readonly roleId: string;
    } | null>;
  };
}

export interface SessionKernelDeps {
  readonly store: SessionStorePort;
  readonly ownership: SessionOwnershipReaders;
  readonly redaction?: SessionRedactionBoundary;
  readonly clock: { nowIso(): string };
}

/** What the active-context reader projects (§31): refs + recent residue + checkpoint. */
export interface ActiveSessionContext {
  readonly session: SessionRecord;
  /** Canonical references from entries still eligible, in sequence order. */
  readonly refs: readonly SessionCanonicalRef[];
  /** Eligible conversational entries, in sequence order (never truncated silently). */
  readonly entries: readonly SessionEntryRow[];
  /** The latest compaction checkpoint, when one exists. */
  readonly checkpoint: SessionEntryRow | null;
}

/** One append command. `text` is conversational residue; `refs` point at canonical state. */
export interface AppendSessionEntryInput {
  readonly companyId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly entryKind: SessionEntryKind;
  readonly text?: string;
  readonly refs?: readonly SessionCanonicalRef[];
  readonly executionId?: string | null;
  readonly inputTokenEstimate: number;
  readonly outputTokenCount?: number | null;
}

const SESSION_COMMAND_NAMESPACE = 'companyos/session-entry/1';

/** Semantic entry fingerprint: everything that changes the entry's meaning participates. */
const entryFingerprintOf = (input: {
  readonly sessionId: string;
  readonly entryKind: SessionEntryKind;
  readonly text: string;
  readonly refs: readonly SessionCanonicalRef[];
  readonly executionId: string | null;
  readonly inputTokenEstimate: number;
  readonly outputTokenCount: number | null;
}): string => {
  // Deterministic, dependency-free digest over the canonical string form (sorted refs).
  const canonical = [
    input.sessionId,
    input.entryKind,
    input.text,
    JSON.stringify([...input.refs].sort((l, r) => `${l.kind}:${l.id}` < `${r.kind}:${r.id}` ? -1 : 1)),
    input.executionId ?? '',
    String(input.inputTokenEstimate),
    input.outputTokenCount === null ? '' : String(input.outputTokenCount),
  ].join('\u0000');
  // FNV-1a 64-bit over UTF-16 code units: stable, fast, no node:crypto in engine hot path.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `fnv1a:${hash.toString(16)}`;
};

export function createSessionKernel(deps: SessionKernelDeps) {
  const redact = (text: string): string => deps.redaction?.redact(text) ?? text;

  /* ------------------------------------------------------------------ create -- */

  /**
   * Idempotent session creation (§7): the identity is DERIVED from the immutable scope, so
   * the same scope always resolves to the same session. An existing row whose stored scope
   * disagrees with the request fails closed — it is never rewritten.
   */
  const ensureSession = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    /** §11: a stable trusted role key from frozen configuration; never a display label. */
    readonly roleKey: string;
    readonly parentSessionId?: string | null;
  }): Promise<Result<SessionRecord, DomainError>> => {
    if (input.roleKey.trim() === '') {
      return err(
        domainError('VALIDATION_FAILED', 'A session needs a non-empty trusted role key.', {
          reason: 'SESSION_ROLE_KEY_EMPTY',
        }),
      );
    }
    // §10: no orphan sessions — the run must exist and belong to the company.
    const run = await deps.ownership.runs.get(input.runId);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'SESSION_RUN_MISSING',
          runId: input.runId,
        }),
      );
    }
    const task = await deps.ownership.tasks.get(input.taskId);
    if (task === null) {
      return err(
        domainError('NOT_FOUND', `Task "${input.taskId}" does not exist.`, {
          reason: 'SESSION_TASK_MISSING',
          taskId: input.taskId,
        }),
      );
    }
    if (!(await deps.ownership.taskBelongsToRun({ runId: input.runId, taskId: input.taskId }))) {
      return err(
        domainError('VALIDATION_FAILED', 'The task does not belong to this run.', {
          reason: 'SESSION_TASK_RUN_MISMATCH',
          runId: input.runId,
          taskId: input.taskId,
        }),
      );
    }
    // §8: parent validation — same company, same run, exists, not self, no cycle. NOT same
    // task: corrective child sessions will legitimately cross task boundaries.
    const sessionId = sessionIdOf({
      companyId: input.companyId,
      runId: input.runId,
      taskId: input.taskId,
      roleKey: input.roleKey,
    });
    if (input.parentSessionId != null) {
      // §8 self-parent: the request's derived identity equals its own parent.
      if (input.parentSessionId === sessionId) {
        return err(
          domainError('VALIDATION_FAILED', 'A session cannot be its own parent.', {
            reason: 'SESSION_PARENT_SELF',
            sessionId,
          }),
        );
      }
      const parentCheck = await validateParent({
        companyId: input.companyId,
        runId: input.runId,
        parentSessionId: input.parentSessionId,
      });
      if (parentCheck !== null) return err(parentCheck);
    }
    const existing = await deps.store.get({ sessionId, companyId: input.companyId });
    if (existing !== null) {
      // Same scope ⇒ the same session (idempotent). Any disagreement is fail-closed (§7):
      // identity derivation makes a scope mismatch impossible for well-formed input, but a
      // tampered row is still refused rather than rewritten.
      if (
        existing.runId !== input.runId ||
        existing.taskId !== input.taskId ||
        existing.roleKey !== input.roleKey
      ) {
        return err(
          domainError('CONFLICT', 'The existing session scope conflicts with the request.', {
            reason: 'SESSION_SCOPE_CONFLICT',
            sessionId,
          }),
        );
      }
      /*
       * Corrective ruling B: parentSessionId is IMMUTABLE lineage metadata after creation. A
       * replay that names a DIFFERENT parent (null→P, P1→P2) is refused — there is no
       * authorized one-time attach operation, so nothing is silently rewritten.
       */
      if ((input.parentSessionId ?? null) !== existing.parentSessionId) {
        return err(
          domainError(
            'CONFLICT',
            'The session parent is immutable lineage metadata and cannot be changed after creation.',
            {
              reason: 'SESSION_PARENT_CONFLICT',
              sessionId,
              storedParentSessionId: existing.parentSessionId,
              requestedParentSessionId: input.parentSessionId ?? null,
            },
          ),
        );
      }
      return ok(existing);
    }
    const record: SessionRecord = {
      sessionId,
      companyId: input.companyId,
      runId: input.runId,
      taskId: input.taskId,
      roleKey: input.roleKey,
      parentSessionId: input.parentSessionId ?? null,
      createdAt: deps.clock.nowIso(),
    };
    try {
      await deps.store.insert(record);
    } catch (error) {
      // A concurrent creator won the UNIQUE(company,run,task,role) race: read the winner.
      const raced = await deps.store.get({ sessionId, companyId: input.companyId });
      if (raced !== null) return ok(raced);
      return err(
        domainError('PERSISTENCE_FAILED', `Session insert was refused: ${String(error)}`, {
          reason: 'SESSION_INSERT_REFUSED',
          sessionId,
        }),
      );
    }
    return ok(record);
  };

  const validateParent = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly parentSessionId: string;
  }): Promise<DomainError | null> => {
    if (input.parentSessionId === sessionIdOfScopedParent(input)) {
      // Self-parent detection is structural: the parent id equals a session of this scope.
      void 0;
    }
    let cursor: string | null = input.parentSessionId;
    const seen = new Set<string>();
    while (cursor !== null) {
      if (seen.has(cursor)) {
        return domainError('VALIDATION_FAILED', 'The session parent chain contains a cycle.', {
          reason: 'SESSION_PARENT_CYCLE',
        });
      }
      seen.add(cursor);
      const parent = await deps.store.get({ sessionId: cursor, companyId: input.companyId });
      if (parent === null) {
        return domainError('NOT_FOUND', `The parent session does not exist in this company.`, {
          reason: 'SESSION_PARENT_MISSING',
          parentSessionId: cursor,
        });
      }
      if (parent.runId !== input.runId) {
        return domainError('VALIDATION_FAILED', 'The parent session belongs to another run.', {
          reason: 'SESSION_PARENT_RUN_MISMATCH',
          parentSessionId: cursor,
        });
      }
      cursor = parent.parentSessionId;
    }
    return null;
  };

  const sessionIdOfScopedParent = (input: {
    readonly companyId: string;
    readonly runId: string;
  }): string => input.runId;

  /* ------------------------------------------------------------------ append -- */

  /**
   * Append one entry (§14-§17): bounded, redacted, append-only, with the per-session
   * sequence allocated inside this module and the permanent command identity arbitrating
   * replay. Same commandId + same fingerprint equals the SAME entry; a different fingerprint
   * fails closed.
   */
  const appendEntry = async (
    input: AppendSessionEntryInput,
  ): Promise<Result<SessionEntryRow, DomainError>> => {
    const session = await deps.store.get({
      sessionId: input.sessionId,
      companyId: input.companyId,
    });
    if (session === null) {
      return err(
        domainError('NOT_FOUND', `Session "${input.sessionId}" does not exist for this company.`, {
          reason: 'SESSION_MISSING',
          sessionId: input.sessionId,
        }),
      );
    }
    if (!(SESSION_ENTRY_KINDS as readonly string[]).includes(input.entryKind)) {
      return err(
        domainError('VALIDATION_FAILED', `Unknown session entry kind "${String(input.entryKind)}".`, {
          reason: 'SESSION_ENTRY_KIND_INVALID',
        }),
      );
    }
    const text = redact(input.text ?? '');
    if (utf8ByteLength(text) > SESSION_ENTRY_LIMITS.maxEntryTextBytes) {
      return err(
        domainError('VALIDATION_FAILED', 'The session entry text exceeds its byte bound.', {
          reason: 'SESSION_ENTRY_OVERSIZED',
          limitBytes: SESSION_ENTRY_LIMITS.maxEntryTextBytes,
        }),
      );
    }
    const refs = [...(input.refs ?? [])];
    if (refs.length > SESSION_ENTRY_LIMITS.maxRefsPerEntry) {
      return err(
        domainError('VALIDATION_FAILED', 'The session entry carries too many canonical refs.', {
          reason: 'SESSION_ENTRY_REFS_OVERSIZED',
          limit: SESSION_ENTRY_LIMITS.maxRefsPerEntry,
        }),
      );
    }
    for (const ref of refs) {
      if (!isValidSessionRef(ref)) {
        return err(
          domainError('VALIDATION_FAILED', 'The session entry carries an invalid canonical ref.', {
            reason: 'SESSION_ENTRY_REF_INVALID',
          }),
        );
      }
    }
    /*
     * Corrective ruling C: an entry must not falsely claim association with a foreign
     * AgentExecution. Existence, same run, same task are enforced from the durable row;
     * company scope is implied because the session itself was read company-scoped and the
     * execution is proven to belong to THIS run. Role compatibility (session roleKey vs
     * execution roleId) has no canonical mapping and is deliberately NOT guessed.
     */
    if (input.executionId != null) {
      if (deps.ownership.executions === undefined) {
        return err(
          domainError(
            'PERSISTENCE_FAILED',
            'An execution-bearing session entry needs the execution reader; the reference cannot be proven.',
            { reason: 'SESSION_EXECUTION_READER_UNAVAILABLE', executionId: input.executionId },
          ),
        );
      }
      const execution = await deps.ownership.executions.get(input.executionId);
      if (execution === null) {
        return err(
          domainError('NOT_FOUND', `Execution "${input.executionId}" does not exist.`, {
            reason: 'SESSION_EXECUTION_MISSING',
            executionId: input.executionId,
          }),
        );
      }
      if (execution.runId !== session.runId) {
        return err(
          domainError('VALIDATION_FAILED', 'The execution belongs to another run.', {
            reason: 'SESSION_EXECUTION_RUN_MISMATCH',
            executionId: input.executionId,
          }),
        );
      }
      if (execution.taskId !== session.taskId) {
        return err(
          domainError('VALIDATION_FAILED', 'The execution belongs to another task.', {
            reason: 'SESSION_EXECUTION_TASK_MISMATCH',
            executionId: input.executionId,
          }),
        );
      }
    }
    const outputTokenCount = input.outputTokenCount ?? null;
    const fingerprint = entryFingerprintOf({
      sessionId: input.sessionId,
      entryKind: input.entryKind,
      text,
      refs,
      executionId: input.executionId ?? null,
      inputTokenEstimate: input.inputTokenEstimate,
      outputTokenCount,
    });
    const permanentCommandId = `${SESSION_COMMAND_NAMESPACE}:${input.sessionId}:${input.commandId}`;
    const existing = await deps.store.entryByCommand({
      sessionId: input.sessionId,
      commandId: permanentCommandId,
    });
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) {
        return err(
          domainError('CONFLICT', 'The session entry command was reused with a different payload.', {
            reason: 'SESSION_ENTRY_FINGERPRINT_MISMATCH',
            commandId: permanentCommandId,
          }),
        );
      }
      return ok(existing);
    }
    /*
     * Concurrency (§36): a rival append may commit between the last-sequence read and the
     * insert. The store's PRIMARY KEY(session_id, sequence) makes that collision fail at the
     * database level; the loop re-allocates and retries (bounded), so concurrent appends
     * converge to distinct sequences with no lost entry while the permanent command identity
     * stays the arbiter of replay.
     */
    for (let attempt = 0; ; attempt += 1) {
      const last = await deps.store.lastSequence(input.sessionId);
      const sequence = Math.max(SESSION_FIRST_SEQUENCE, last + 1);
      const row: SessionEntryRow = {
        sessionId: input.sessionId,
        sequence,
        commandId: permanentCommandId,
        entryKind: input.entryKind,
        text,
        refs,
        executionId: input.executionId ?? null,
        tokenAccounting: {
          inputTokenEstimate: input.inputTokenEstimate,
          outputTokenCount,
        },
        createdAt: deps.clock.nowIso(),
        fingerprint,
      };
      const appended = await deps.store.append(row);
      if (!appended.ok) {
        const collided = /UNIQUE constraint failed: session_entries\.session_id, session_entries\.sequence/.test(
          appended.error.message,
        );
        if (collided && attempt < 32) continue;
        return appended;
      }
      if ('replay' in appended.value) {
        const replay = appended.value.replay;
        if (replay.fingerprint !== fingerprint) {
          return err(
            domainError(
              'CONFLICT',
              'The session entry command was reused with a different payload.',
              {
                reason: 'SESSION_ENTRY_FINGERPRINT_MISMATCH',
                commandId: permanentCommandId,
              },
            ),
          );
        }
        return ok(replay);
      }
      return ok(row);
    }
  };

  /* -------------------------------------------------------------- compaction -- */

  /**
   * Deterministic active-window compaction (§29/§30): writes a checkpoint entry carrying
   * ONLY bounded metadata (coveredThroughSequence, category counts, refs digest, token
   * accounting). Old entries are NEVER deleted or rewritten; the checkpoint only changes
   * what a FUTURE active projection is eligible to include.
   */
  const compact = async (input: {
    readonly companyId: string;
    readonly sessionId: string;
    readonly commandId: string;
  }): Promise<Result<SessionEntryRow, DomainError>> => {
    const session = await deps.store.get({
      sessionId: input.sessionId,
      companyId: input.companyId,
    });
    if (session === null) {
      return err(
        domainError('NOT_FOUND', `Session "${input.sessionId}" does not exist for this company.`, {
          reason: 'SESSION_MISSING',
        }),
      );
    }
    /*
     * §17 applies to compaction too: the SAME compaction command replays the SAME checkpoint
     * even when nothing new is eligible — the eligibility check is skipped for a replay.
     */
    const permanentCommandId = `${SESSION_COMMAND_NAMESPACE}:${input.sessionId}:${input.commandId}`;
    const replayed = await deps.store.entryByCommand({
      sessionId: input.sessionId,
      commandId: permanentCommandId,
    });
    if (replayed !== null) return ok(replayed);
    const entries = await deps.store.listEntries(input.sessionId);
    const latestCheckpoint = latestCheckpointOf(entries);
    const coveredThrough =
      latestCheckpoint === null ? 0 : checkpointCoveredThrough(latestCheckpoint);
    const eligible = entries.filter(
      (entry) => entry.sequence > coveredThrough && entry.entryKind !== 'compaction_checkpoint',
    );
    if (eligible.length === 0) {
      return err(
        domainError('CONFLICT', 'There is nothing to compact: no eligible entries.', {
          reason: 'SESSION_COMPACTION_EMPTY',
        }),
      );
    }
    const counts: Record<string, number> = {};
    let inputEstimate = 0;
    let outputCount = 0;
    for (const entry of eligible) {
      counts[entry.entryKind] = (counts[entry.entryKind] ?? 0) + 1;
      inputEstimate += entry.tokenAccounting.inputTokenEstimate;
      outputCount += entry.tokenAccounting.outputTokenCount ?? 0;
    }
    const through = eligible[eligible.length - 1]!.sequence;
    // §29: bounded metadata ONLY — schema, covered range, category counts, a refs digest and
    // token accounting. No semantic facts, no business-truth fields.
    const checkpointText = JSON.stringify({
      schema: SESSION_COMPACTION_CHECKPOINT_SCHEMA,
      coveredThroughSequence: through,
      entryCounts: counts,
      refsDigest: entryFingerprintOf({
        sessionId: input.sessionId,
        entryKind: 'canonical_ref',
        text: '',
        refs: eligible.flatMap((entry) => [...entry.refs]),
        executionId: null,
        inputTokenEstimate: 0,
        outputTokenCount: null,
      }),
      inputTokenEstimate: inputEstimate,
      outputTokenCount: outputCount,
    });
    return appendEntry({
      companyId: input.companyId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      entryKind: 'compaction_checkpoint',
      text: checkpointText,
      refs: [],
      executionId: null,
      inputTokenEstimate: 0,
      outputTokenCount: null,
    });
  };

  const latestCheckpointOf = (
    entries: readonly SessionEntryRow[],
  ): SessionEntryRow | null => {
    let latest: SessionEntryRow | null = null;
    for (const entry of entries) {
      if (entry.entryKind !== 'compaction_checkpoint') continue;
      if (latest === null || entry.sequence > latest.sequence) latest = entry;
    }
    return latest;
  };

  const checkpointCoveredThrough = (checkpoint: SessionEntryRow): number => {
    try {
      const parsed = JSON.parse(checkpoint.text) as { coveredThroughSequence?: unknown };
      return typeof parsed.coveredThroughSequence === 'number' ? parsed.coveredThroughSequence : 0;
    } catch {
      return 0;
    }
  };

  /* ------------------------------------------------------------------ reading -- */

  /**
   * The ACTIVE context projection (§31): canonical refs + eligible recent conversational
   * entries + the latest checkpoint metadata. Pure/fail-closed: it fetches NO business facts
   * itself and builds no role-specific prompt.
   */
  const readActiveContext = async (input: {
    readonly companyId: string;
    readonly sessionId: string;
    /** How many entries AFTER the checkpoint stay eligible. Default: all of them. */
    readonly recentWindow?: number;
  }): Promise<Result<ActiveSessionContext, DomainError>> => {
    const session = await deps.store.get({
      sessionId: input.sessionId,
      companyId: input.companyId,
    });
    if (session === null) {
      return err(
        domainError('NOT_FOUND', `Session "${input.sessionId}" does not exist for this company.`, {
          reason: 'SESSION_MISSING',
        }),
      );
    }
    const entries = await deps.store.listEntries(input.sessionId);
    const checkpoint = latestCheckpointOf(entries);
    const coveredThrough = checkpoint === null ? 0 : checkpointCoveredThrough(checkpoint);
    const after = entries.filter((entry) => entry.sequence > coveredThrough);
    const eligible =
      input.recentWindow === undefined
        ? after
        : after.slice(Math.max(0, after.length - input.recentWindow));
    const refs: SessionCanonicalRef[] = [];
    for (const entry of eligible) {
      for (const ref of entry.refs) refs.push(ref);
    }
    return ok({ session, refs, entries: eligible, checkpoint });
  };

  return { ensureSession, appendEntry, compact, readActiveContext };
}

export { SESSION_CONTEXT_SEED_SCHEMA };

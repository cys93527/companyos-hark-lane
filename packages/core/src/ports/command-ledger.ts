/**
 * Port: durable command ledger (Sprint 3 — durable idempotency).
 *
 * The engine records every applied command here so that:
 *   - replaying the same `commandId` is exactly-once **even across a process restart**
 *     (requirement 11), and
 *   - reusing a key with different content is detectable (requirement 13 of Sprint 2).
 *
 * Core stays generic on purpose: `outcome` is an opaque, owner-defined snapshot (the
 * engine stores its `DispatchOutcome` there), so this contract never leaks engine DTOs
 * into Core.
 */
export interface CommandLedgerRecord {
  readonly commandId: string;
  /** Fingerprint of the command content (see `commandFingerprint` in Core). */
  readonly fingerprint: string;
  /** Run the command applied to — kept for auditing and per-run diagnostics. */
  readonly runId: string;
  /** Opaque outcome snapshot, serializable to JSON. */
  readonly outcome: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

export interface CommandLedgerPort {
  get(commandId: string): Promise<CommandLedgerRecord | null>;
  put(record: CommandLedgerRecord): Promise<void>;
  count(): Promise<number>;
  /**
   * Keep at most `limit` records (oldest first out) and report how many were removed.
   * A bounded ledger keeps the idempotency window explicit instead of promising to
   * remember every command forever.
   */
  trim(limit: number): Promise<number>;
}

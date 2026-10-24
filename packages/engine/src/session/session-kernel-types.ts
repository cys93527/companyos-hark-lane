/**
 * The structural type of the T19-02 Session kernel surface the Developer runtime consumes
 * (avoids a concrete import cycle; the kernel itself is `createSessionKernel`).
 */
import type {
  DomainError,
  Result,
  SessionEntryRow,
  SessionRecord,
} from '@companyos/core';

export interface SessionKernel {
  ensureSession(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly roleKey: string;
    readonly parentSessionId?: string | null;
  }): Promise<Result<SessionRecord, DomainError>>;
  appendEntry(input: {
    readonly companyId: string;
    readonly sessionId: string;
    readonly commandId: string;
    readonly entryKind: string;
    readonly text?: string;
    readonly refs?: readonly { readonly kind: string; readonly id: string; readonly note?: string }[];
    readonly executionId?: string | null;
    readonly inputTokenEstimate: number;
    readonly outputTokenCount?: number | null;
  }): Promise<Result<SessionEntryRow, DomainError>>;
  readActiveContext(input: {
    readonly companyId: string;
    readonly sessionId: string;
    readonly recentWindow?: number;
  }): Promise<
    Result<
      {
        readonly session: SessionRecord;
        readonly refs: readonly { readonly kind: string; readonly id: string }[];
        readonly entries: readonly SessionEntryRow[];
        readonly checkpoint: SessionEntryRow | null;
      },
      DomainError
    >
  >;
}

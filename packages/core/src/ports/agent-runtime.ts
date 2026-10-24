/**
 * Port: agent execution — CONTRACT ONLY (see the note in model-gateway.ts).
 * Sprint 0 ships types; the node executor, checkpoint/resume and tool invocation
 * land in Sprint 8 (P2).
 */
import type { RunSnapshotRef } from '../lifecycle/snapshot.js';

export type ExecutionOutcome = 'succeeded' | 'failed' | 'cancelled' | 'waiting_handoff';

export interface ExecutionTask {
  readonly runId: string;
  readonly nodeId: string;
  readonly roleId: string;
  readonly snapshot: RunSnapshotRef;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly deadlineMs: number | null;
}

export interface ExecutionResult {
  readonly outcome: ExecutionOutcome;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly string[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface AgentRuntimePort {
  execute(task: ExecutionTask): Promise<ExecutionResult>;
  cancel(runId: string): Promise<void>;
}

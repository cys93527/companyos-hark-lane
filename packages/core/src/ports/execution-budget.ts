/** ADR-A/B: subordinate admission facts; Run/Task terminal state remains canonical. */
export interface GoalBudgetPolicy {
  readonly policyId: string;
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxCostMicros: number;
  readonly deadlineMs: number;
}

export interface CostAdmissionBound {
  readonly modelKey: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  /** Trusted deployment evidence, never an estimate supplied by the adapter/model. */
  readonly evidenceRef: string;
  readonly validUntilMs: number;
}

export interface BudgetReservation {
  readonly callId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly bound: CostAdmissionBound;
  readonly status: 'RESERVED' | 'KNOWN' | 'UNKNOWN';
  readonly usage: { readonly tokens: number; readonly costMicros: number } | null;
}

export interface GoalExecutionBudget {
  readonly goalRunId: string;
  readonly policy: GoalBudgetPolicy;
  readonly cancellation: { readonly requestedAtMs: number; readonly requestId: string } | null;
  readonly reservations: readonly BudgetReservation[];
}

/** ONE canonical connection/transaction, not a second database or execution scheduler. */
export interface ExecutionBudgetStore {
  bind(runId: string, goalRunId: string): Promise<void>;
  goalOf(runId: string): Promise<string | null>;
  update<T>(goalRunId: string, change: (current: GoalExecutionBudget | null) => {
    readonly next: GoalExecutionBudget;
    readonly value: T;
  }): Promise<T>;
  read(goalRunId: string): Promise<GoalExecutionBudget | null>;
}

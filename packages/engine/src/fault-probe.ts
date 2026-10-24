/**
 * The deterministic fault-injection PROBE (Sprint 18 / Task-18-08) — the test-harness side of
 * the `FaultCheckpointPort` seam.
 *
 * It records every checkpoint it observes and THROWS the crash sentinel (`FaultCrashError`,
 * deliberately NOT a DomainError) at the armed checkpoints. Because the sentinel is not a
 * domain error, no service can catch it and misreport a crash as Task FAILED / Decision
 * FAILED / Validation FAIL: it propagates out of the composition, exactly like a real crash.
 *
 * This is TEST INFRASTRUCTURE ONLY. It is not a Tool, holds no authority, reads no
 * environment, and a model, a user or a payload can never reach it — only a trusted test
 * harness constructs one and hands it to the composition's `faultCheckpoints` option.
 */
import { FaultCrashError, type FaultCheckpointName, type FaultCheckpointPort } from '@companyos/core';

export interface FaultProbeScript {
  /** Checkpoint names that crash the process-equivalent on their Nth hit (default: the 1st). */
  readonly crashAt?: readonly {
    readonly name: FaultCheckpointName;
    readonly afterHits?: number;
  }[];
}

export interface FaultProbe {
  readonly port: FaultCheckpointPort;
  /** Every checkpoint observed so far, in order (the durable-ordering proof). */
  observed(): readonly FaultCheckpointName[];
  /** How many times each name fired. */
  hits(name: FaultCheckpointName): number;
}

export function createFaultProbe(script: FaultProbeScript = {}): FaultProbe {
  const counts = new Map<string, number>();
  const order: string[] = [];
  const armed = new Map<string, number>(
    (script.crashAt ?? []).map((entry) => [entry.name, entry.afterHits ?? 1]),
  );
  return {
    port: {
      async checkpoint(name: FaultCheckpointName): Promise<void> {
        const seen = (counts.get(name) ?? 0) + 1;
        counts.set(name, seen);
        order.push(name);
        const trigger = armed.get(name);
        if (trigger !== undefined && seen >= trigger) {
          armed.delete(name);
          throw new FaultCrashError(name);
        }
      },
    },
    observed: () => [...order],
    hits: (name: FaultCheckpointName) => counts.get(name) ?? 0,
  };
}

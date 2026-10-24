/**
 * Run model binding reader (Sprint 18 / Task-18-02) — the application half of
 * `MODEL_BINDING_RUN_PINNING_GAP`.
 *
 * The pin itself (types, validation, registry seam) lives in Core
 * (`@companyos/core` → `lifecycle/run-model-bindings`), because the lifecycle service may
 * only speak Core contracts (Sprint 4 boundary). This module adds the two things that need
 * stores: reading the frozen map of one run back, and resolving ONE pinned binding to a
 * concrete model record — fail closed when the run never pinned that name, and fail closed
 * again when the pinned model has since vanished. There is no default, no latest model and
 * no fallback anywhere in this file.
 */
import {
  domainError,
  err,
  ok,
  type DomainError,
  type EntityStore,
  type Result,
  type RunSnapshot,
  type RunModelBindingRecord,
  type RunModelBindingResolver,
  type WorkflowRun,
} from '@companyos/core';

export type { RunModelBindingRecord, RunModelBindingResolver };

export interface RunModelBindingReader {
  /** The frozen map of one run. Fail closed on missing run / cross-company access. */
  get(input: { readonly runId: string; readonly companyId: string }): Promise<Result<Readonly<Record<string, string>>, DomainError>>;
  /**
   * Resolve ONE pinned binding of a run to a concrete model record. A name the run never
   * pinned is a fail-closed `RUN_BINDING_MISSING` — never a default, never the latest model.
   */
  resolve(
    input: { readonly runId: string; readonly companyId: string; readonly bindingName: string },
    resolver: RunModelBindingResolver,
  ): Promise<Result<RunModelBindingRecord, DomainError>>;
}

export interface RunModelBindingReaderDeps {
  readonly runs: EntityStore<WorkflowRun>;
  readonly snapshots: EntityStore<RunSnapshot>;
}

export function createRunModelBindingReader(deps: RunModelBindingReaderDeps): RunModelBindingReader {
  const pinned = async (input: { readonly runId: string; readonly companyId: string }): Promise<Result<RunSnapshot, DomainError>> => {
    const run = await deps.runs.get(input.runId as never);
    if (run === null || run.companyId !== input.companyId) {
      // A cross-company read is indistinguishable from a missing run: no existence oracle.
      return err(domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, { reason: 'RUN_MISSING', runId: input.runId }));
    }
    const snapshot = await deps.snapshots.get(run.snapshotId as never);
    if (snapshot === null) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" pins no retrievable snapshot; its bindings cannot be read.`, {
          reason: 'RUN_SNAPSHOT_MISSING',
          runId: input.runId,
        }),
      );
    }
    return ok(snapshot);
  };

  return {
    async get(input): Promise<Result<Readonly<Record<string, string>>, DomainError>> {
      const snapshot = await pinned(input);
      if (!snapshot.ok) return snapshot;
      return ok(snapshot.value.modelBindings);
    },

    async resolve(input, resolver): Promise<Result<RunModelBindingRecord, DomainError>> {
      const snapshot = await pinned(input);
      if (!snapshot.ok) return snapshot;
      const modelKey = snapshot.value.modelBindings[input.bindingName];
      if (modelKey === undefined) {
        return err(
          domainError('NOT_FOUND', `Run "${input.runId}" pins no model binding named "${input.bindingName}".`, {
            reason: 'RUN_BINDING_MISSING',
            runId: input.runId,
            bindingName: input.bindingName,
          }),
        );
      }
      const record = await resolver.get(modelKey);
      if (record === null || record.modelKey !== modelKey) {
        return err(
          domainError('NOT_FOUND', `Pinned model binding "${input.bindingName}" no longer resolves to a registered model.`, {
            reason: 'RUN_BINDING_UNKNOWN',
            runId: input.runId,
            bindingName: input.bindingName,
            modelKey,
          }),
        );
      }
      return ok(record);
    },
  };
}

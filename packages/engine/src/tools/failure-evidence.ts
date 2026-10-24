/**
 * Failure-evidence reference integrity (Sprint 17 — Task-17-04 final verification).
 *
 * ONE rule, ONE place. The refs a FAILING adapter reports must be treated exactly like the
 * refs a COMPLETED tool advertises: never trusted merely because they arrived in
 * `DomainError.details`. Every subsystem that links evidence to an invocation — the tool
 * registry's FAILED terminal write, and the process tools' cancel/timeout path (which the
 * registry's own timeout race cannot carry) — goes through this component, so the semantics
 * are identical for every adapter.
 *
 * The rule (mirrors the COMPLETED path in `tools/registry.ts`):
 *   - managed refs (`artifact:art_...`) must RESOLVE to a durable Artifact row through the
 *     shared durable-reference resolver AND belong to the invocation's own run;
 *   - CAS content refs (`sha256:<64 hex>`) are format-checked only, exactly as the COMPLETED
 *     path treats them (opaque content identity, not an artifact-row reference);
 *   - anything malformed, missing, cross-run or otherwise unresolvable is REFUSED and never
 *     linked; without a resolver the managed grammar fails closed.
 *
 * Linkage is idempotent over the relation's `UNIQUE (invocation_id, artifact_ref)`, and the
 * caller writes the terminal invocation state BEFORE linking, so no link can exist without
 * its terminal state.
 */
import {
  domainError,
  type Clock,
  type DomainError,
  type EntityStore,
  type IdFactory,
  type Result,
  type ToolInvocation,
} from '@companyos/core';

import type { ToolInvocationArtifactRecord } from './registry.js';

/** Canonical CAS content-ref grammar (`sha256:<64 lowercase hex>`) — ADR-0015 D3. */
const SHA256_REF_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The shared durable-reference resolver (Task-13-09): identity + run anchor, no content reads. */
export type EvidenceReferenceResolver = (
  refs: readonly string[],
) => Promise<
  Result<
    readonly { readonly kind: string; readonly id: string; readonly ref: string; readonly runId: string }[],
    DomainError
  >
>;

export interface EvidenceRefVerdict {
  /** Refs that passed validation and may be linked. */
  readonly accepted: readonly string[];
  /** Refs that were refused (never linked, never silently forgotten). */
  readonly rejected: readonly string[];
}

/**
 * Validate evidence refs for one invocation. Pure policy: no writes, so both linking paths
 * (and any test) can reason about the verdict alone.
 */
export const validateEvidenceArtifactRefs = async (input: {
  readonly refs: readonly unknown[];
  /** The invocation's run anchor: a reference to another run is refused. */
  readonly runId: string;
  readonly resolver?: EvidenceReferenceResolver;
}): Promise<EvidenceRefVerdict> => {
  const accepted: string[] = [];
  const rejected: string[] = [];
  const managed: string[] = [];
  for (const candidate of input.refs) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      rejected.push(String(candidate));
      continue;
    }
    if (candidate.startsWith('artifact:')) managed.push(candidate);
    else if (SHA256_REF_PATTERN.test(candidate)) accepted.push(candidate);
    else rejected.push(candidate);
  }
  if (managed.length === 0) return { accepted, rejected };
  if (input.resolver === undefined) {
    // No resolver wired: the managed grammar fails closed, exactly as it does for COMPLETED.
    return { accepted, rejected: [...rejected, ...managed] };
  }
  const resolved = await input.resolver(managed);
  if (!resolved.ok) return { accepted, rejected: [...rejected, ...managed] };
  for (const reference of resolved.value) {
    if (reference.runId !== input.runId) rejected.push(reference.ref);
    else accepted.push(reference.ref);
  }
  return { accepted, rejected };
};

export interface FailureEvidenceLinkInput {
  readonly invocationId: string;
  /**
   * The invocation's run anchor (validated against every managed ref). Optional: when the
   * caller has only the invocation id — the process tools' cancel/timeout path — it is read
   * from the durable invocation row, and a row that cannot be read fails closed.
   */
  readonly runId?: string;
  readonly refs: readonly unknown[];
}

export interface FailureEvidenceLinkResult {
  /** Refs that were validated and are now linked to the invocation. */
  readonly linked: readonly string[];
  /** Refs that were refused (not linked). */
  readonly rejected: readonly string[];
}

export interface FailureEvidenceLinker {
  link(input: FailureEvidenceLinkInput): Promise<FailureEvidenceLinkResult>;
}

/**
 * Build the ONE validating, idempotent evidence linker. The registry uses an instance built
 * from its own dependencies for the FAILED terminal write; the composition root passes the
 * same component to the repository process tools for the cancel/timeout path.
 */
export const createFailureEvidenceLinker = (deps: {
  readonly invocations: EntityStore<ToolInvocation>;
  readonly invocationArtifacts: EntityStore<ToolInvocationArtifactRecord>;
  readonly ids: IdFactory;
  readonly clock: Clock;
  readonly resolver?: EvidenceReferenceResolver;
}): FailureEvidenceLinker => ({
  async link(input) {
    let runId = input.runId;
    if (runId === undefined) {
      const invocation = await deps.invocations.get(input.invocationId);
      if (invocation === null) {
        // No durable invocation to anchor to: refuse everything rather than link unanchored.
        return { linked: [], rejected: input.refs.map((ref) => String(ref)) };
      }
      runId = invocation.runId;
    }
    const verdict = await validateEvidenceArtifactRefs({
      refs: input.refs,
      runId,
      resolver: deps.resolver,
    });
    if (verdict.accepted.length === 0) return { linked: [], rejected: verdict.rejected };
    // Idempotent: the relation's UNIQUE (invocation_id, artifact_ref) makes a blind second
    // insert fail, so the refs already linked to this invocation are read first.
    const current = await deps.invocations.get(input.invocationId);
    const already = new Set(current?.artifactRefs ?? []);
    const linked: string[] = [];
    for (const ref of verdict.accepted) {
      if (already.has(ref)) continue;
      await deps.invocationArtifacts.put({
        id: deps.ids.id('tart'),
        invocationId: input.invocationId,
        artifactRef: ref,
        label: ref,
        createdAt: deps.clock.nowIso(),
      });
      already.add(ref);
      linked.push(ref);
    }
    return { linked, rejected: verdict.rejected };
  },
});

/** Structured refusal carried by a failure that reported unusable evidence refs. */
export const rejectedEvidenceDetails = (result: FailureEvidenceLinkResult): Readonly<Record<string, unknown>> =>
  result.rejected.length === 0
    ? {}
    : {
        rejectedArtifactRefs: result.rejected,
        reason: 'ARTIFACT_REFERENCE_INVALID',
      };

/** Convenience for adapters that must surface a refusal as a domain error. */
export const evidenceRefusalError = (message: string, result: FailureEvidenceLinkResult): DomainError =>
  domainError('INVALID_ARGUMENT', message, {
    reason: 'ARTIFACT_REFERENCE_INVALID',
    rejectedArtifactRefs: result.rejected,
  });

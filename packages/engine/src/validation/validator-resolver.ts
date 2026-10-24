/**
 * Controlled validator resolution (Sprint 13B — Task-13-05; ADR-0016 D5, S13
 * VALIDATION_CONTRACT §8).
 *
 * The resolver is a THIN, read-only view over the existing Sprint 9 Tool Registry:
 *   - identity:      validatorId ≡ toolId (1:1 — one registration, one validator id)
 *   - version:       validatorVersion ≡ ToolRecord.version (the canonical, immutable
 *                    registry source — IVI-3 closed; a caller can never claim one)
 *   - opt-in:        a tool is resolvable ONLY if it declared
 *                    TOOL_CAPABILITY_VALIDATOR at registration; an ordinary tool is
 *                    refused with the same NOT_FOUND as an unknown id (no existence
 *                    oracle for non-validators)
 *   - fail closed:   unregistered / disabled / non-validator → no descriptor
 *   - inheritance:   riskLevel, requiredAuthorities and adapterRef are carried through
 *                    untouched — resolution grants nothing and bypasses nothing
 *   - no execution:  resolving never invokes the tool (T06 performs the controlled
 *                    invocation through the registry's own invoke path)
 */
import {
  TOOL_CAPABILITY_VALIDATOR,
  domainError,
  err,
  ok,
  type Authority,
  type DomainError,
  type Result,
  type ToolRegistryPort,
  type ToolRiskLevel,
} from '@companyos/core';

/** Minimal readonly capability description handed to the Validation layer (T06). */
export interface ValidatorDescriptor {
  /** ≡ toolId of the underlying registered tool. */
  readonly validatorId: string;
  /** Canonical registry version — audit evidence, never caller-supplied. */
  readonly validatorVersion: string;
  /** The underlying tool identity (invocation goes through the registry, not this). */
  readonly toolId: string;
  /** Inherited, unchanged: the validator capability never rewrites tool risk. */
  readonly riskLevel: ToolRiskLevel;
  /** Inherited, unchanged: enforced by the registry on every future invocation. */
  readonly requiredAuthorities: readonly Authority[];
  /** Opaque adapter binding reference (resolved by the composition root). */
  readonly adapterRef: string;
}

export interface ValidatorResolverDeps {
  readonly registry: ToolRegistryPort;
}

export interface ValidatorResolver {
  /**
   * Resolve a registered validator-capable tool. No execution, no persistence —
   * descriptor only.
   */
  resolve(validatorId: string, actorId: string): Promise<Result<ValidatorDescriptor, DomainError>>;
}

export function createValidatorResolver(deps: ValidatorResolverDeps): ValidatorResolver {
  return {
    async resolve(validatorId: string, actorId: string): Promise<Result<ValidatorDescriptor, DomainError>> {
      const found = await deps.registry.get(validatorId, actorId);
      if (!found.ok) return found; // authority/refusal from the registry itself, untouched

      const record = found.value;
      // Unknown id AND ordinary tool resolve to the same fail-closed outcome: the
      // resolver never reveals whether an unregistered ordinary tool exists.
      if (record === null || !record.capabilities.includes(TOOL_CAPABILITY_VALIDATOR)) {
        return err(
          domainError('NOT_FOUND', `No validator is registered under "${validatorId}".`, {
            reason: 'VALIDATOR_NOT_FOUND',
            validatorId,
          }),
        );
      }
      // A disabled tool must never produce a descriptor the Validation layer would
      // later fail to execute (fail closed now, not at invocation time).
      if (!record.enabled) {
        return err(
          domainError('VALIDATION_FAILED', `Validator "${validatorId}" is disabled.`, {
            reason: 'VALIDATOR_UNAVAILABLE',
            validatorId,
          }),
        );
      }
      return ok({
        validatorId: record.toolId,
        validatorVersion: record.version,
        toolId: record.toolId,
        riskLevel: record.riskLevel,
        requiredAuthorities: [...record.requiredAuthorities],
        adapterRef: record.adapterRef,
      });
    },
  };
}

/**
 * DevCompany companion PRODUCT POLICY — model-binding separation (TASK-16-02 §5–§12).
 *
 * This is NOT a PackManifest declaration, NOT a tenth Pack category, and NOT a Core
 * semantic contract: the canonical Pack schema has no model-capability requirement field,
 * and the Boss ruled that model binding policy lives OUTSIDE PackManifest authority.
 * It is first-party DevCompany companion product configuration — inert readonly data that
 * a future model-binding validation step (T16-05) reads together with the existing Model
 * Registry / Router. Nothing here is consumed by the generic Pack framework.
 *
 * Capability names reuse the existing `ModelCapabilityProfile` logical vocabulary
 * (`toolCalling` / `reasoning`) — no synonyms, no vendor names.
 */
import type { ModelCapabilityProfile } from '@companyos/core';

/** The boolean capability flags of the real model capability profile. */
type BooleanCapabilityKeys<T> = {
  [K in keyof T]-?: T[K] extends boolean ? K : never;
}[keyof T];

/**
 * A logical model capability token, exactly as `ModelCapabilityProfile` spells it
 * (`toolCalling` / `reasoning` / …). Derived, never hand-listed, so a profile rename
 * breaks this package at compile time instead of silently drifting.
 */
export type DevCompanyModelCapability = BooleanCapabilityKeys<ModelCapabilityProfile>;

export interface DevCompanyModelPolicyStage {
  /** Logical model capabilities a binding for this stage must satisfy. */
  readonly requiredLogicalCapabilities: readonly DevCompanyModelCapability[];
}

export interface DevCompanyModelPolicy {
  /**
   * Product rule (AC16.2 / 规划书 §二十): the Reviewer default binding must resolve to a
   * DIFFERENT model than the Developer default binding. Enforced at the existing
   * model-binding layer (Model Registry / Router / RunSnapshot.modelBindings) — never by
   * the Pack manifest and never by prompt text.
   */
  readonly developer: DevCompanyModelPolicyStage;
  readonly reviewer: DevCompanyModelPolicyStage;
  readonly reviewerMustDifferFromDeveloper: true;
}

export const DEVCOMPANY_MODEL_POLICY: DevCompanyModelPolicy = {
  developer: { requiredLogicalCapabilities: ['toolCalling'] },
  reviewer: { requiredLogicalCapabilities: ['reasoning'] },
  reviewerMustDifferFromDeveloper: true,
} as const;

/** Stage ids of the delivery cycle this policy speaks about (mirrors the manifest graph). */
export const DEVCOMPANY_MODEL_POLICY_STAGES = ['developer', 'reviewer'] as const;

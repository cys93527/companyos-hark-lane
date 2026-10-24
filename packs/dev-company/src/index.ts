/**
 * `@companyos/pack-dev-company` — the first-party DevCompany industry Pack
 * (internal codename CodeFleet).
 *
 * Product DATA only (ADR-0024 DATA/CONFIG ONLY): the canonical manifest and the companion
 * model-binding policy. No installer, no service, no runtime consumer — importing this
 * package performs no work beyond defining inert data.
 */
export {
  DEVCOMPANY_MANIFEST,
  DEVCOMPANY_PACK_ID,
  DEVCOMPANY_PACK_NAME,
  DEVCOMPANY_PACK_VERSION,
  DEVCOMPANY_ROLE_KEYS,
  DEVCOMPANY_TOOL_IDS,
  DEVCOMPANY_VALIDATOR_ID,
  DEVCOMPANY_WORKFLOW_KEY,
} from './manifest.js';
export {
  DEVCOMPANY_MODEL_POLICY,
  DEVCOMPANY_MODEL_POLICY_STAGES,
  type DevCompanyModelCapability,
  type DevCompanyModelPolicy,
  type DevCompanyModelPolicyStage,
} from './model-policy.js';

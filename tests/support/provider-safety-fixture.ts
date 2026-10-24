/**
 * Sprint25 test fixture: the safety preconditions a provider dispatch must satisfy.
 *
 * A dispatch no longer runs "because the provider exists": it needs a typed,
 * source-annotated configuration and an authorization provenance. These helpers
 * build both for test providers through the SAME production loader the desktop
 * composition uses, so a migrating fixture cannot quietly invent a weaker shape.
 */
import {
  executorConfigFingerprint,
  type TypedExecutorConfig,
} from '@companyos/engine';

/**
 * A typed configuration for a scripted provider. The schema declares one field so
 * the configuration is non-empty (an empty one fails the config-valid stage), and
 * the fingerprint is derived by the real derivation, never hardcoded.
 */
export const scriptedExecutorConfig = (
  providerKey: string,
  value = 'headless',
): TypedExecutorConfig => ({
  providerKey,
  fields: [{ name: 'profile', value, source: 'default' }],
  fingerprint: executorConfigFingerprint([{ name: 'profile', value, source: 'default' }]),
});

/** The standard authorization provenance for an ordinary workspace-anchored test dispatch. */
export const scriptedAuthorization = (providerKey: string) => ({
  present: true as const,
  source: 'composition-policy' as const,
  reference: `provider-registration:${providerKey}`,
});

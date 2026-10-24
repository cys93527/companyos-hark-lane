/**
 * PackManifest transport projection — the JSON-shape mirror of the CANONICAL Core
 * semantic model (ADR-0024: `packages/core` is the semantic authority; this package
 * is the transport / schema-validation projection; CORE_BOUNDARIES §4 documents the
 * same contract).
 *
 * The ninth category (Generic Templates) field schema was named by repository
 * sources but not defined there; the TASK-15-02 architecture ruling froze the minimal
 * data-only contract `{ key, kind, content }`.
 *
 * Legacy field aliases (Sprint 0 shape: `id` / `version` / `schemaVersion` /
 * `apiVersion` / `coreApiRange` / `displayName` / `provides.*`) are NORMALIZED here
 * — Core exposes canonical names only. Ambiguity between two names is a rejection,
 * never a silent pick. This is an early-internal-fixture-compatible shim marked
 * deprecated; conformance tests lock that the normalized transport shape and the
 * Core semantic model agree one-to-one.
 */
import { z } from 'zod';

const PACK_ID = /^[a-z][a-z0-9-]{1,31}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OPAQUE_TOKEN = /^[a-z][a-z0-9-]{0,63}$/;
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/** JSON-safe inert template data — mirrors the Core `JsonValue` type structurally. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]),
);

const packQualifiedKey = /^[a-z][a-z0-9-]{1,31}:[a-z][a-z0-9-]{0,63}$/;

const capability = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,31}:[a-z][a-z0-9.-]{0,63}$/, 'capability id must be "<packId>:<name>"'),
    description: z.string(),
    approval: z.enum(['none', 'required']).optional(),
  })
  .strict();

const packDependency = z
  .object({
    packId: z.string().regex(PACK_ID),
    packVersion: z.string().regex(SEMVER, 'dependency version must be an EXACT semver (no ranges)'),
  })
  .strict();

const roleDeclaration = z
  .object({ key: z.string().regex(packQualifiedKey), label: z.string().min(1), authorityRefs: z.array(z.string().min(1)).nonempty() })
  .strict();

const workflowTemplateDeclaration = z
  .object({
    key: z.string().regex(packQualifiedKey),
    name: z.string().min(1),
    description: z.string(),
    graph: z.object({
      nodes: z.array(z.object({
        id: z.string().min(1),
        kind: z.string().min(1),
        title: z.string().min(1),
        config: z.record(z.unknown()),
      })).min(1),
      edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), condition: z.string().optional() })),
    }).strict(),
  })
  .strict();

const promptDeclaration = z
  .object({ key: z.string().regex(packQualifiedKey), template: z.string().min(1), version: z.string().nullable() })
  .strict();

const toolRequirementDeclaration = z
  .object({ key: z.string().regex(packQualifiedKey), toolId: z.string().min(1), capability: z.string().nullable() })
  .strict();

const validatorDeclaration = z
  .object({ key: z.string().regex(packQualifiedKey), validatorId: z.string().min(1) })
  .strict();

const artifactTypeDeclaration = z
  .object({ key: z.string().regex(packQualifiedKey), label: z.string().min(1), description: z.string() })
  .strict();

const riskRuleDeclaration = z
  .object({ key: z.string().regex(packQualifiedKey), riskLevel: z.enum(RISK_LEVELS), description: z.string() })
  .strict();

const capabilityRuleDeclaration = z
  .object({
    key: z.string().regex(packQualifiedKey),
    requires: z.array(z.string()),
    exposes: z.array(z.string()),
  })
  .strict();

/** Generic Template (ninth category): `kind` is an opaque token — Core never switches on it. */
const genericTemplateDeclaration = z
  .object({ key: z.string().regex(packQualifiedKey), kind: z.string().regex(OPAQUE_TOKEN), content: jsonValue })
  .strict();

/**
 * The CANONICAL transport schema — a one-to-one projection of the Core semantic model
 * (strict: unknown fields are rejected, never stripped, per the repo zod convention).
 */
export const canonicalPackManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    packId: z.string().regex(PACK_ID),
    packVersion: z.string().regex(SEMVER),
    name: z.string().min(1),
    coreApi: z.string().regex(/^1$/, 'coreApi must be "1" (the Core API version this build speaks)'),
    capabilities: z.array(capability),
    dependsOn: z.array(packDependency),
    declarations: z
      .object({
        roles: z.array(roleDeclaration),
        workflowTemplates: z.array(workflowTemplateDeclaration),
        prompts: z.array(promptDeclaration),
        tools: z.array(toolRequirementDeclaration),
        validators: z.array(validatorDeclaration),
        artifacts: z.array(artifactTypeDeclaration),
        riskRules: z.array(riskRuleDeclaration),
        capabilityRules: z.array(capabilityRuleDeclaration),
        templates: z.array(genericTemplateDeclaration),
      })
      .strict(),
  })
  .strict();

export type CanonicalPackManifest = z.infer<typeof canonicalPackManifestSchema>;

/** The nine canonical categories, all empty — the minimal declaration payload. */
export const emptyPackDeclarations = (): Record<string, never[]> => ({
  roles: [],
  workflowTemplates: [],
  prompts: [],
  tools: [],
  validators: [],
  artifacts: [],
  riskRules: [],
  capabilityRules: [],
  templates: [],
});

/**
 * Transport wire name of the canonical schema (Sprint 0 consumers imported
 * `packManifestSchema`; the canonical projection carries that name forward).
 */
export const packManifestSchema = canonicalPackManifestSchema;
export type PackManifest = CanonicalPackManifest;

/** True when the pack declares nothing Core could resolve — useful for linting packs. */
export const isEmptyPack = (manifest: CanonicalPackManifest): boolean =>
  manifest.capabilities.length === 0 &&
  Object.values(manifest.declarations).every((list) => list.length === 0);

/* -------------------------------------------------- legacy normalization --- */

interface AliasPair {
  readonly legacy: readonly string[];
  readonly canonical: 'manifestVersion' | 'packId' | 'packVersion' | 'name' | 'coreApi';
}

const ALIASES: readonly AliasPair[] = [
  { legacy: ['id'], canonical: 'packId' },
  { legacy: ['version'], canonical: 'packVersion' },
  { legacy: ['schemaVersion'], canonical: 'manifestVersion' },
  { legacy: ['apiVersion', 'coreApiRange'], canonical: 'coreApi' },
  { legacy: ['displayName'], canonical: 'name' },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stable = (value: unknown): string => JSON.stringify(value) ?? 'undefined';

/**
 * Normalize a LEGACY transport manifest to the canonical shape (deprecated shim for
 * the dormant Sprint 0 schema). Deprecated aliases: `id`→packId, `version`→
 * packVersion, `schemaVersion`→manifestVersion, `apiVersion`/`coreApiRange`→coreApi,
 * `displayName`→name. A canonical name and a legacy name carrying DIFFERENT values
 * is a rejection (no silent pick). The legacy `provides.*` structure (bare name
 * lists, no declaration payloads) is NOT carried over: canonical declarations
 * require full records (T15-02 §53).
 */
export function normalizeLegacyPackManifestInput(input: unknown): LegacyNormalizeResult<Record<string, unknown>> {
  if (!isRecord(input)) return { ok: false, error: 'manifest must be an object' };
  const raw: Record<string, unknown> = { ...input };
  for (const alias of ALIASES) {
    const legacyKeys = alias.legacy.filter((key) => raw[key] !== undefined);
    if (legacyKeys.length === 0) continue;
    const canonicalValue = raw[alias.canonical];
    if (canonicalValue !== undefined) {
      // A legacy name alongside the canonical name: only a same-valued copy survives;
      // any different value is a rejection, never a silent pick.
      if (legacyKeys.some((key) => stable(raw[key]) !== stable(canonicalValue))) {
        return {
          ok: false,
          error: `conflicting values for canonical "${alias.canonical}": ${[...legacyKeys, alias.canonical].join(' and ')}`,
        };
      }
      for (const key of legacyKeys) delete raw[key];
      continue;
    }
    const distinct = new Set(legacyKeys.map((key) => stable(raw[key])));
    if (distinct.size > 1) {
      return { ok: false, error: `conflicting legacy values for canonical "${alias.canonical}": ${legacyKeys.join(' and ')}` };
    }
    const value = raw[legacyKeys[0]!];
    for (const key of legacyKeys) delete raw[key];
    raw[alias.canonical] = value;
  }
  if (raw['provides'] !== undefined) {
    return { ok: false, error: 'legacy "provides" (bare name lists) is not a canonical declaration payload; use declarations.* with full records' };
  }
  return { ok: true, value: raw };
}

export type LegacyNormalizeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Capability Registry — the seam between Core and every Industry Pack.
 *
 * Core defines the CANONICAL PackManifest semantic model and validates it; Core never
 * imports a pack and never knows a pack's vocabulary (ADR-0002/0024). A pack registers
 * capabilities that are namespaced by `packId`, so two verticals can never collide.
 *
 * Sprint 15 (Task-15-02, ADR-0024): this file is the semantic authority for the pack
 * manifest. `packages/contracts` is a transport/validation PROJECTION of exactly this
 * model (legacy field aliases are normalized there, never here); CORE_BOUNDARIES §4
 * documents the same contract. Core exposes CANONICAL names only:
 *   manifestVersion / packId / packVersion / name / coreApi / capabilities /
 *   dependsOn / declarations — nine declaration categories, no tenth kind
 *   (ADR-0024 D2). Everything is DATA/CONFIG ONLY: no field of this model is or can
 *   be executable, and nothing in the Pack paths evaluates pack-supplied code.
 *
 * Generic Templates (the ninth category): repository sources named the category but
 * did not define its field schema. The TASK-15-02 architecture ruling freezes the
 * minimal data-only contract `{ key, kind, content }` — it is NOT derived from the
 * original planning document.
 */
import type { JsonValue } from '../kernel/hash.js';
import { AUTHORITIES, isAuthority } from '../domain/role-authority.js';
import { RISK_LEVELS, type RiskLevel } from '../domain/approval.js';
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '../lifecycle/version.js';
import { PackManifestError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

/* ------------------------------------------------------------- core API --- */

export const PACK_API_VERSION = '1';

/** Current manifest schema version (the manifest shape itself, not the pack release). */
export const PACK_MANIFEST_VERSION = 1;

/** Pure compatibility check: the manifest's `coreApi` vs the Core API this build speaks. */
export const coreApiIsCompatible = (coreApi: string): boolean => coreApi === PACK_API_VERSION;

/* --------------------------------------------------------- JSON safety --- */

/**
 * JSON-safe inert data (Task-15-02 Boss ruling §6): the ONLY shape a Generic Template
 * `content` may take. Functions, undefined, bigint, symbols, class instances, Dates,
 * Buffers and non-finite numbers are all outside JSON — they are rejected at
 * validation, never silently stringified away. (Type re-exported from the kernel —
 * one JSON value type in Core.)
 */
export type { JsonValue } from '../kernel/hash.js';

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type === 'undefined' || type === 'function' || type === 'bigint' || type === 'symbol') return false;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (type === 'object') {
    // Plain JSON objects only: no class instances, no Dates, no Buffers.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

/* --------------------------------------------------------- identifiers --- */

export const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** Local (pack-qualified) name segment: kebab-case token — the repo identifier convention. */
const LOCAL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** Opaque type token (e.g. a Generic Template `kind`) — same identifier convention. */
export const OPAQUE_TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export const capabilityId = (packId: string, name: string): string => `${packId}:${name}`;

export const isNamespacedCapability = (packId: string, id: string): boolean =>
  id.startsWith(`${packId}:`) && id.length > packId.length + 1;

/** The ONE canonical namespace helper for every pack-owned logical name (ADR-0026 D9). */
export const packQualifiedKey = (packId: string, localName: string): string => `${packId}:${localName}`;

/** Split a pack-qualified key; `null` when the shape is not `<packId>:<localName>`. */
export const parsePackQualifiedKey = (key: string): { readonly packId: string; readonly localName: string } | null => {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const packId = key.slice(0, separator);
  const localName = key.slice(separator + 1);
  if (!PACK_ID_PATTERN.test(packId) || !LOCAL_NAME_PATTERN.test(localName)) return null;
  return { packId, localName };
};

/* ------------------------------------------------------ the nine kinds --- */

export const PACK_CONTENT_KINDS = [
  'role',
  'workflowTemplate',
  'prompt',
  'tool',
  'validator',
  'artifactType',
  'riskRule',
  'capabilityRule',
  'template',
] as const;
export type PackContentKind = (typeof PACK_CONTENT_KINDS)[number];

/** 1. Roles — declarative archetype data; every authority ref must be in the CLOSED catalog. */
export interface RoleDeclaration {
  readonly key: string;
  readonly label: string;
  readonly authorityRefs: readonly string[];
}

/** 2. Workflow Templates — industry-neutral seed data; materializes via the lifecycle service (T15-04). */
export interface WorkflowTemplateDeclaration {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly graph: WorkflowGraph;
}

/** 3. Prompts — declarative template data; no prompt runtime engine is introduced. */
export interface PromptDeclaration {
  readonly key: string;
  readonly template: string;
  readonly version: string | null;
}

/** 4. Tools — REQUIREMENTS over the existing registry, never implementations. */
export interface ToolRequirementDeclaration {
  readonly key: string;
  readonly toolId: string;
  readonly capability: string | null;
}

/** 5. Validators — map to a registry tool carrying the `validation:validator` capability (resolution in T15-04). */
export interface ValidatorDeclaration {
  readonly key: string;
  readonly validatorId: string;
}

/** 6. Artifacts — kind vocabulary/expectations only; ADR-0015 stays authoritative. */
export interface ArtifactTypeDeclaration {
  readonly key: string;
  readonly label: string;
  readonly description: string;
}

/** 7. Risk Rules — declarative policy data; the existing RiskLevel/RISK_POLICY stay authoritative. */
export interface RiskRuleDeclaration {
  readonly key: string;
  readonly riskLevel: RiskLevel;
  readonly description: string;
}

/** 8. Capability Rules — required/exposed capability RELATIONSHIPS; capability != authority. */
export interface CapabilityRuleDeclaration {
  readonly key: string;
  readonly requires: readonly string[];
  readonly exposes: readonly string[];
}

/**
 * 9. Generic Templates — reusable, lazy, declarative JSON data templates
 * (TASK-15-02 Boss ruling): `kind` is an opaque token Core never interprets, and
 * `content` is inert JSON-safe data. NOT a WorkflowTemplate, NOT a Prompt, NOT an
 * executable template engine.
 */
export interface GenericTemplateDeclaration {
  readonly key: string;
  readonly kind: string;
  readonly content: JsonValue;
}

export interface PackDeclarations {
  readonly roles: readonly RoleDeclaration[];
  readonly workflowTemplates: readonly WorkflowTemplateDeclaration[];
  readonly prompts: readonly PromptDeclaration[];
  readonly tools: readonly ToolRequirementDeclaration[];
  readonly validators: readonly ValidatorDeclaration[];
  readonly artifacts: readonly ArtifactTypeDeclaration[];
  readonly riskRules: readonly RiskRuleDeclaration[];
  readonly capabilityRules: readonly CapabilityRuleDeclaration[];
  readonly templates: readonly GenericTemplateDeclaration[];
}

/* -------------------------------------------------- canonical manifest --- */

export interface PackCapability {
  /** Must be namespaced: `<packId>:<name>`. */
  readonly id: string;
  readonly description: string;
  /** Human-in-the-loop requirement for this capability, if any. */
  readonly approval?: 'none' | 'required';
}

/** REQUIRED, EXACT-version pack dependency (ADR-0026 — no ranges, no optionals). */
export interface PackDependency {
  readonly packId: string;
  readonly packVersion: string;
}

export interface PackManifest {
  readonly manifestVersion: typeof PACK_MANIFEST_VERSION;
  readonly packId: string;
  readonly packVersion: string;
  readonly name: string;
  readonly coreApi: string;
  readonly capabilities: readonly PackCapability[];
  readonly dependsOn: readonly PackDependency[];
  readonly declarations: PackDeclarations;
}

/* ---------------------------------------------------------- validation --- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ALLOWED_TOP_LEVEL = new Set([
  'manifestVersion', 'packId', 'packVersion', 'name', 'coreApi', 'capabilities', 'dependsOn', 'declarations',
]);

/** Fields that must NEVER appear anywhere in pack data — safety-first rejection. */
const FORBIDDEN_FIELDS = new Set([
  'userId', 'memberId', 'assignTo', 'owner', 'bootstrapOwner',
  'execute', 'command', 'executable', 'modulePath', 'script', 'binary', 'python', 'entrypoint',
  'callback', 'handler', 'engine', 'runtime', 'language', 'renderer',
]);

const rejectForbiddenFields = (source: Record<string, unknown>, where: string, problems: string[]): void => {
  for (const field of Object.keys(source)) {
    if (FORBIDDEN_FIELDS.has(field)) {
      problems.push(`${where}: field "${field}" is not allowed in pack data`);
    }
  }
};

const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];
  return typeof value === 'string' ? value : null;
};

/** Read a strict object: reject unknown fields and security-relevant fields, never strip. */
const readStrictObject = (
  value: unknown,
  where: string,
  allowed: readonly string[],
  problems: string[],
): Record<string, unknown> | null => {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  rejectForbiddenFields(value, where, problems);
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) problems.push(`${where}: unknown field "${field}"`);
  }
  return value;
};

const readNamespacedKey = (value: unknown, packId: string, where: string, problems: string[]): string | null => {
  const key = typeof value === 'string' ? value : null;
  if (key === null) {
    problems.push(`${where}.key is required`);
    return null;
  }
  const parsed = parsePackQualifiedKey(key);
  if (parsed === null) {
    problems.push(`${where}.key must be pack-qualified as "<packId>:<localName>"`);
    return null;
  }
  if (parsed.packId !== packId) {
    problems.push(`${where}.key "${key}" must be namespaced under packId "${packId}"`);
    return null;
  }
  return key;
};

const readDependency = (value: unknown, index: number, problems: string[]): PackDependency | null => {
  const raw = readStrictObject(value, `dependsOn[${index}]`, ['packId', 'packVersion'], problems);
  if (raw === null) return null;
  const packId = readString(raw, 'packId');
  const packVersion = readString(raw, 'packVersion');
  if (packId === null || !PACK_ID_PATTERN.test(packId)) {
    problems.push(`dependsOn[${index}].packId must match ^[a-z][a-z0-9-]{1,31}$`);
    return null;
  }
  if (packVersion === null || !SEMVER_PATTERN.test(packVersion)) {
    problems.push(`dependsOn[${index}].packVersion must be an EXACT semver (ranges such as ^1.2 are not supported)`);
    return null;
  }
  return { packId, packVersion };
};

const readGraph = (value: unknown, where: string, problems: string[]): WorkflowGraph | null => {
  const raw = readStrictObject(value, `${where}.graph`, ['nodes', 'edges'], problems);
  if (raw === null) return null;
  if (!Array.isArray(raw['nodes']) || raw['nodes'].length === 0) {
    problems.push(`${where}.graph.nodes must be a non-empty array`);
    return null;
  }
  const nodeIds = new Set<string>();
  const nodes: WorkflowNode[] = [];
  for (const [index, nodeValue] of (raw['nodes'] as readonly unknown[]).entries()) {
    const node = readStrictObject(nodeValue, `${where}.graph.nodes[${index}]`, ['id', 'kind', 'title', 'config'], problems);
    if (node === null) continue;
    const id = readString(node, 'id');
    const kind = readString(node, 'kind');
    const title = readString(node, 'title');
    if (id === null || id.trim().length === 0 || kind === null || kind.trim().length === 0 || title === null || title.trim().length === 0) {
      problems.push(`${where}.graph.nodes[${index}] needs non-empty id, kind and title`);
      continue;
    }
    if (nodeIds.has(id)) {
      problems.push(`${where}.graph.nodes[${index}].id "${id}" is duplicated`);
      continue;
    }
    const config = node['config'];
    if (config !== undefined && !isRecord(config)) {
      problems.push(`${where}.graph.nodes[${index}].config must be an object`);
      continue;
    }
    nodeIds.add(id);
    nodes.push({ id, kind, title, config: config === undefined ? {} : (config as Readonly<Record<string, unknown>>) });
  }
  const edges: WorkflowEdge[] = [];
  const rawEdges = raw['edges'] ?? [];
  if (!Array.isArray(rawEdges)) {
    problems.push(`${where}.graph.edges must be an array`);
    return null;
  }
  for (const [index, edgeValue] of rawEdges.entries()) {
    const edge = readStrictObject(edgeValue, `${where}.graph.edges[${index}]`, ['from', 'to', 'condition'], problems);
    if (edge === null) continue;
    const from = readString(edge, 'from');
    const to = readString(edge, 'to');
    if (from === null || to === null || !nodeIds.has(from) || !nodeIds.has(to)) {
      problems.push(`${where}.graph.edges[${index}] must reference existing node ids`);
      continue;
    }
    const condition = readString(edge, 'condition');
    edges.push({ from, to, ...(condition === null ? {} : { condition }) });
  }
  return { nodes, edges };
};

/**
 * Validate an UNTRUSTED canonical manifest (packs are data, but data is validated at
 * the boundary — ADR-0024 D5). Strict: canonical field names only (legacy aliases are
 * normalized in the transport projection, never here), unknown and security-relevant
 * fields are rejected, never stripped.
 */
export function validatePackManifest(value: unknown): Result<PackManifest, PackManifestError> {
  if (!isRecord(value)) {
    return err(new PackManifestError('Pack manifest must be an object.'));
  }
  const problems: string[] = [];
  rejectForbiddenFields(value, 'manifest', problems);
  for (const field of Object.keys(value)) {
    if (!ALLOWED_TOP_LEVEL.has(field)) problems.push(`manifest: unknown field "${field}"`);
  }

  if (value['manifestVersion'] !== PACK_MANIFEST_VERSION) {
    problems.push(`manifestVersion must be ${String(PACK_MANIFEST_VERSION)}`);
  }
  const packId = readString(value, 'packId');
  if (packId === null || !PACK_ID_PATTERN.test(packId)) {
    problems.push('packId must match ^[a-z][a-z0-9-]{1,31}$');
  }
  const packVersion = readString(value, 'packVersion');
  if (packVersion === null || !SEMVER_PATTERN.test(packVersion)) {
    problems.push('packVersion must be a semver string');
  }
  const name = readString(value, 'name');
  if (name === null || name.trim().length === 0) {
    problems.push('name is required');
  }
  const coreApi = readString(value, 'coreApi');
  if (coreApi === null || !coreApiIsCompatible(coreApi)) {
    problems.push(`coreApi must be "${PACK_API_VERSION}" (the Core API this build speaks)`);
  }

  const capabilities: PackCapability[] = [];
  const seenCapabilityIds = new Set<string>();
  const rawCapabilities = value['capabilities'];
  if (!Array.isArray(rawCapabilities)) {
    problems.push('capabilities must be an array');
  } else {
    for (const [index, raw] of rawCapabilities.entries()) {
      const cap = readStrictObject(raw, `capabilities[${index}]`, ['id', 'description', 'approval'], problems);
      if (cap === null) continue;
      const id = readString(cap, 'id');
      if (id === null) {
        problems.push(`capabilities[${index}].id is required`);
        continue;
      }
      if (packId !== null && !isNamespacedCapability(packId, id)) {
        problems.push(`capabilities[${index}].id must be namespaced as "${packId}:..."`);
        continue;
      }
      if (seenCapabilityIds.has(id)) {
        problems.push(`capabilities[${index}].id "${id}" is duplicated`);
        continue;
      }
      seenCapabilityIds.add(id);
      const approval = readString(cap, 'approval');
      if (approval !== null && approval !== 'none' && approval !== 'required') {
        problems.push(`capabilities[${index}].approval must be "none" or "required"`);
        continue;
      }
      capabilities.push({
        id,
        description: readString(cap, 'description') ?? '',
        ...(approval === 'required' || approval === 'none' ? { approval } : {}),
      });
    }
  }

  const dependsOn: PackDependency[] = [];
  const seenDependencyIds = new Set<string>();
  const rawDependsOn = value['dependsOn'];
  if (!Array.isArray(rawDependsOn)) {
    problems.push('dependsOn must be an array');
  } else {
    for (const [index, raw] of rawDependsOn.entries()) {
      const dependency = readDependency(raw, index, problems);
      if (dependency === null) continue;
      if (dependency.packId === packId) {
        problems.push(`dependsOn[${index}]: a pack cannot depend on itself`);
        continue;
      }
      if (seenDependencyIds.has(dependency.packId)) {
        problems.push(`dependsOn[${index}].packId "${dependency.packId}" is duplicated`);
        continue;
      }
      seenDependencyIds.add(dependency.packId);
      dependsOn.push(dependency);
    }
  }

  const declarations = validateDeclarations(value['declarations'], packId ?? '', problems);

  if (problems.length > 0) {
    return err(new PackManifestError(`Invalid pack manifest: ${problems.join('; ')}`, { problems }));
  }
  return ok({
    manifestVersion: PACK_MANIFEST_VERSION,
    packId: packId as string,
    packVersion: packVersion as string,
    name: name as string,
    coreApi: coreApi as string,
    capabilities,
    dependsOn,
    declarations,
  });
}

const DECLARATION_KINDS = [
  'roles', 'workflowTemplates', 'prompts', 'tools', 'validators',
  'artifacts', 'riskRules', 'capabilityRules', 'templates',
] as const;

function validateDeclarations(
  value: unknown,
  packId: string,
  problems: string[],
): PackDeclarations {
  const empty: PackDeclarations = {
    roles: [], workflowTemplates: [], prompts: [], tools: [], validators: [],
    artifacts: [], riskRules: [], capabilityRules: [], templates: [],
  };
  if (value === undefined) {
    problems.push('declarations must be an object with the nine canonical categories');
    return empty;
  }
  if (!isRecord(value)) {
    problems.push('declarations must be an object');
    return empty;
  }
  rejectForbiddenFields(value, 'declarations', problems);
  for (const field of Object.keys(value)) {
    if (!(DECLARATION_KINDS as readonly string[]).includes(field)) {
      problems.push(`declarations: unknown category "${field}" (the nine canonical categories only)`);
    }
  }

  const roles: RoleDeclaration[] = [];
  const workflowTemplates: WorkflowTemplateDeclaration[] = [];
  const prompts: PromptDeclaration[] = [];
  const tools: ToolRequirementDeclaration[] = [];
  const validators: ValidatorDeclaration[] = [];
  const artifacts: ArtifactTypeDeclaration[] = [];
  const riskRules: RiskRuleDeclaration[] = [];
  const capabilityRules: CapabilityRuleDeclaration[] = [];
  const templates: GenericTemplateDeclaration[] = [];
  const seenKeys = new Map<string, Set<string>>();

  const checkDuplicate = (kind: string, key: string): void => {
    const keys = seenKeys.get(kind) ?? new Set<string>();
    if (keys.has(key)) problems.push(`declarations.${kind}: duplicate key "${key}"`);
    keys.add(key);
    seenKeys.set(kind, keys);
  };
  const readList = (kind: string): readonly unknown[] => {
    const raw = value[kind];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      problems.push(`declarations.${kind} must be an array`);
      return [];
    }
    return raw;
  };

  for (const [index, raw] of readList('roles').entries()) {
    const where = `declarations.roles[${index}]`;
    const record = readStrictObject(raw, where, ['key', 'label', 'authorityRefs'], problems);
    if (record === null) continue;
    const key = readNamespacedKey(record['key'], packId, where, problems);
    const label = readString(record, 'label');
    if (key === null || label === null || label.trim().length === 0) continue;
    checkDuplicate('roles', key);
    const authorityRefs: string[] = [];
    const rawRefs = record['authorityRefs'];
    if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
      problems.push(`${where}.authorityRefs must be a non-empty array`);
    } else {
      for (const ref of rawRefs) {
        if (typeof ref !== 'string' || !isAuthority(ref)) {
          // Fail closed: a pack can only REFERENCE the closed authority catalog (ADR-0026 D7).
          problems.push(`${where}.authorityRefs entry "${String(ref)}" is not a known authority (closed catalog, ${String(AUTHORITIES.length)} entries)`);
        } else {
          authorityRefs.push(ref);
        }
      }
    }
    roles.push({ key, label, authorityRefs });
  }

  for (const [index, raw] of readList('workflowTemplates').entries()) {
    const where = `declarations.workflowTemplates[${index}]`;
    const record = readStrictObject(raw, where, ['key', 'name', 'description', 'graph'], problems);
    if (record === null) continue;
    const key = readNamespacedKey(record['key'], packId, where, problems);
    const wfName = readString(record, 'name');
    if (record['description'] === undefined) problems.push(`${where}.description is required`);
    if (record['graph'] !== undefined && isRecord(record['graph']) && record['graph']['edges'] === undefined) {
      problems.push(`${where}.graph.edges must be present (use [] when there are none)`);
    }
    const graph = readGraph(record['graph'], where, problems);
    if (key === null || wfName === null || wfName.trim().length === 0 || graph === null) continue;
    checkDuplicate('workflowTemplates', key);
    workflowTemplates.push({ key, name: wfName, description: readString(record, 'description') ?? '', graph });
  }

  for (const [index, raw] of readList('prompts').entries()) {
    const where = `declarations.prompts[${index}]`;
    const record = readStrictObject(raw, where, ['key', 'template', 'version'], problems);
    if (record === null) continue;
    if (record['version'] === undefined) problems.push(`${where}.version must be present (null when versionless)`);
    const key = readNamespacedKey(record['key'], packId, where, problems);
    const template = readString(record, 'template');
    if (key === null || template === null || template.trim().length === 0) continue;
    checkDuplicate('prompts', key);
    const version = readString(record, 'version');
    prompts.push({ key, template, version: version === null ? null : version });
  }

  for (const [index, raw] of readList('tools').entries()) {
    const where = `declarations.tools[${index}]`;
    const record = readStrictObject(raw, where, ['key', 'toolId', 'capability'], problems);
    if (record === null) continue;
    if (record['capability'] === undefined) problems.push(`${where}.capability must be present (null when unspecified)`);
    const key = readNamespacedKey(record['key'], packId, where, problems);
    const toolId = readString(record, 'toolId');
    if (key === null || toolId === null || toolId.trim().length === 0) continue;
    checkDuplicate('tools', key);
    const capability = readString(record, 'capability');
    tools.push({ key, toolId, capability: capability === null ? null : capability });
  }

  for (const [index, raw] of readList('validators').entries()) {
    const where = `declarations.validators[${index}]`;
    const record = readStrictObject(raw, where, ['key', 'validatorId'], problems);
    if (record === null) continue;
    const key = readNamespacedKey(record['key'], packId, where, problems);
    const validatorId = readString(record, 'validatorId');
    if (key === null || validatorId === null || validatorId.trim().length === 0) continue;
    checkDuplicate('validators', key);
    validators.push({ key, validatorId });
  }

  for (const [index, raw] of readList('artifacts').entries()) {
    const where = `declarations.artifacts[${index}]`;
    const record = readStrictObject(raw, where, ['key', 'label', 'description'], problems);
    if (record === null) continue;
    if (record['description'] === undefined) problems.push(`${where}.description is required`);
    const key = readNamespacedKey(record['key'], packId, where, problems);
    const label = readString(record, 'label');
    if (key === null || label === null || label.trim().length === 0) continue;
    checkDuplicate('artifacts', key);
    artifacts.push({ key, label, description: readString(record, 'description') ?? '' });
  }

  for (const [index, raw] of readList('riskRules').entries()) {
    const where = `declarations.riskRules[${index}]`;
    const record = readStrictObject(raw, where, ['key', 'riskLevel', 'description'], problems);
    if (record === null) continue;
    if (record['description'] === undefined) problems.push(`${where}.description is required`);
    const key = readNamespacedKey(record['key'], packId, where, problems);
    const riskLevel = readString(record, 'riskLevel');
    if (key === null) continue;
    if (riskLevel === null || !(RISK_LEVELS as readonly string[]).includes(riskLevel)) {
      problems.push(`${where}.riskLevel must be one of LOW / MEDIUM / HIGH / CRITICAL`);
      continue;
    }
    checkDuplicate('riskRules', key);
    riskRules.push({ key, riskLevel: riskLevel as RiskLevel, description: readString(record, 'description') ?? '' });
  }

  for (const [index, raw] of readList('capabilityRules').entries()) {
    const where = `declarations.capabilityRules[${index}]`;
    const record = readStrictObject(raw, where, ['key', 'requires', 'exposes'], problems);
    if (record === null) continue;
    const key = readNamespacedKey(record['key'], packId, where, problems);
    if (key === null) continue;
    if (record['requires'] === undefined || record['exposes'] === undefined) {
      problems.push(`${where}.requires / exposes must be present (use [] when none)`);
      continue;
    }
    const requires = record['requires'];
    const exposes = record['exposes'];
    if (!Array.isArray(requires) || !Array.isArray(exposes)) {
      problems.push(`${where}.requires / exposes must be arrays`);
      continue;
    }
    const validIds = (list: readonly unknown[], field: string): string[] | null => {
      const out: string[] = [];
      for (const entry of list) {
        if (typeof entry !== 'string' || !entry.includes(':')) {
          problems.push(`${where}.${field} entries must be namespaced capability ids ("<packId>:<name>")`);
          return null;
        }
        out.push(entry);
      }
      return out;
    };
    const requiresIds = validIds(requires, 'requires');
    const exposesIds = validIds(exposes, 'exposes');
    if (requiresIds === null || exposesIds === null) continue;
    checkDuplicate('capabilityRules', key);
    capabilityRules.push({ key, requires: requiresIds, exposes: exposesIds });
  }

  for (const [index, raw] of readList('templates').entries()) {
    const where = `declarations.templates[${index}]`;
    const record = readStrictObject(raw, where, ['key', 'kind', 'content'], problems);
    if (record === null) continue;
    const key = readNamespacedKey(record['key'], packId, where, problems);
    const kind = readString(record, 'kind');
    const kindOk = kind !== null && OPAQUE_TOKEN_PATTERN.test(kind);
    if (!kindOk) {
      problems.push(`${where}.kind must be a non-empty kebab-case type token`);
    }
    const content = record['content'];
    if (!isJsonValue(content)) {
      // Reject — never JSON.stringify silent loss (NaN / Infinity / undefined / function / bigint …).
      problems.push(`${where}.content must be JSON-safe inert data (no functions, undefined, bigint, symbols, class instances or non-finite numbers)`);
    }
    if (key === null || !kindOk || !isJsonValue(content)) continue;
    checkDuplicate('templates', key);
    templates.push({ key, kind: kind as string, content });
  }

  return {
    roles, workflowTemplates, prompts, tools, validators,
    artifacts, riskRules, capabilityRules, templates,
  };
}

/** In-memory registry over the canonical model (durable stores land in T15-03). */
export class PackRegistry {
  readonly #packs = new Map<string, PackManifest>();

  public register(manifest: PackManifest): Result<PackManifest, PackManifestError> {
    const existing = this.#packs.get(manifest.packId);
    if (existing !== undefined && existing.packVersion === manifest.packVersion) {
      return err(
        new PackManifestError(`Pack ${manifest.packId}@${manifest.packVersion} is already registered.`, {
          packId: manifest.packId,
        }),
      );
    }
    this.#packs.set(manifest.packId, manifest);
    return ok(manifest);
  }

  public list(): readonly PackManifest[] {
    return [...this.#packs.values()];
  }

  public capabilities(): readonly PackCapability[] {
    return this.list().flatMap((pack) => pack.capabilities);
  }

  /** Resolve a capability id to its owning pack. Returns null when unknown. */
  public ownerOf(capability: string): PackManifest | null {
    return this.list().find((pack) => pack.capabilities.some((cap) => cap.id === capability)) ?? null;
  }
}

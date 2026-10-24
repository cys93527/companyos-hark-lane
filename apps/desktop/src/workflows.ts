/**
 * The desktop application layer for Workflow Designer (Sprint 5).
 *
 * Renderer -> IPC request -> parseWorkflowRequest (schema validation) ->
 * WorkflowLifecycle service (all rules) -> Core domain -> Persistence.
 *
 * Owns no business rule: it validates transport shape, calls the lifecycle service and
 * formats the answer. It never touches SQLite. ASCII-only on purpose.
 */
import {
  DomainError,
  FALLBACK_MODES,
  POLICY_SCOPE_TYPES,
  SELECTION_MODES,
  applyChangeOps,
  assertEditable,
  currentVersion,
  domainError,
  err,
  ok,
  previousHandoffTextOf,
  validateWorkflowGraph,
  type ChangeProposal,
  type HandoffRef,
  type PolicyScopeRef,
  type Result,
  type StageOp,
  type WorkflowGraph,
  type WorkflowTemplate,
  type WorkflowVersion,
} from '@companyos/core';
import type { AgentRuntimeService, ModelRegistryService, RouterApplicationService, RouterOverrideInput, RouterRecommendationInput, SelectionPolicyService, HandoffService, ToolRegistry, WorkflowLifecycle, MemoryService, DecisionService } from '@companyos/engine';

export const WORKFLOW_OPERATIONS = [
  'library.list',
  'template.get',
  'draft.create',
  'draft.open',
  'draft.applyOps',
  'draft.save',
  'draft.validate',
  'review.submit',
  'review.decide',
  'revision.open',
  'publish',
  'publish.revision',
  'proposal.list',
  'version.get',
  'compare',
  'fork',
  'deprecate',
  'archive',
  'run.create',
  'run.snapshot',
  // Sprint 7: Model Registry (curated catalogue, no routing)
  'models.list',
  'models.catalogue',
  'models.register',
  'models.enable',
  'models.disable',
  'models.alias',
  'models.resolve',
  'models.refreshHealth',
  // Sprint 7.5: Model Selection Policy (rules only - no router)
  'models.policy',
  'models.policy.explain',
  // Stage 2: the effective company selection (read-only) so the client can show it.
  'models.selection',
  // Stage 3: the derived readiness projection (provider / model / executor / workspace).
  'runtime.readiness',
  // Sprint 8: agent execution runtime (executes; never selects a model)
  'agent.prepare',
  'agent.execute',
  'agent.get',
  'agent.list',
  'agent.cancel',
  'agent.recover',
  // Sprint 9: tool registry (contracts + ONE bounded invocation per request)
  'tools.list',
  'tools.enable',
  'tools.disable',
  'tools.invoke',
  'tools.approve',
  'tools.invocations',
  'tools.recover',
  'tools.retry',
  // Sprint 10B.1: the router RECOMMENDS (it never executes) - the scope is the only client input.
  'router.recommend',
  'router.override.request',
  'router.override.confirm',
  // Sprint 11: structured handoff (server-derived roles; no client role claims)
  'handoff.create',
  'handoff.ready',
  'handoff.accept',
  'handoff.reject',
  'handoff.cancel',
  'handoff.get',
  'handoff.listForTargetRole',
  // Sprint 12: organizational memory and explicit decisions
  'memory.create', 'memory.get', 'memory.retrieve', 'memory.history', 'memory.supersede', 'memory.markStale', 'memory.retract',
  'decision.create', 'decision.get', 'decision.active', 'decision.history', 'decision.supersede', 'decision.revoke',
  // Sprint 13 (Task-13-11 IPC boundary corrective): the durable artifact/validation
  // services stay TRUSTED MAIN-PROCESS capabilities. No renderer-facing operations
  // exist for them — none were frozen in an IPC contract, and gate semantics
  // (blocking / validation plan) must never come from a caller.
] as const;

export type WorkflowOperation = (typeof WORKFLOW_OPERATIONS)[number];

export interface WorkflowRequest {
  readonly operation: WorkflowOperation;
  readonly requestId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface WorkflowErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type WorkflowResponse =
  | { readonly ok: true; readonly operation: WorkflowOperation; readonly value: unknown }
  | { readonly ok: false; readonly operation: WorkflowOperation | null; readonly error: WorkflowErrorPayload };

const MAX_TEXT = 512;
/** Transport caps (Sprint 5 review LOW-2): a compromised renderer cannot post huge JSON. */
const MAX_GRAPH_NODES = 200;
const MAX_GRAPH_EDGES = 500;
const MAX_LIST_ITEMS = 64;
const MAX_OPS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (message: string, details: Record<string, unknown> = {}): DomainError =>
  domainError('INVALID_ARGUMENT', message, details);

const readText = (
  payload: Record<string, unknown>,
  key: string,
  required = true,
): Result<string | undefined, DomainError> => {
  const value = payload[key];
  if (value === undefined) {
    return required ? err(invalid(`Field "${key}" is required.`, { field: key })) : ok(undefined);
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT) {
    return err(
      invalid(`Field "${key}" must be a non-empty string of at most ${MAX_TEXT} characters.`, { field: key }),
    );
  }
  return ok(value);
};

const readStringArray = (
  payload: Record<string, unknown>,
  key: string,
): Result<readonly string[] | undefined, DomainError> => {
  const value = payload[key];
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    return err(invalid(`Field "${key}" must be an array of non-empty strings.`, { field: key }));
  }
  if (value.length > MAX_LIST_ITEMS) {
    return err(invalid(`Field "${key}" may hold at most ${MAX_LIST_ITEMS} entries.`, { field: key }));
  }
  return ok(value as readonly string[]);
};

const readGraph = (payload: Record<string, unknown>, key: string): Result<WorkflowGraph | undefined, DomainError> => {
  const value = payload[key];
  if (value === undefined) return ok(undefined);
  if (!isRecord(value) || !Array.isArray(value['nodes']) || !Array.isArray(value['edges'])) {
    return err(invalid(`Field "${key}" must be a graph with nodes[] and edges[].`, { field: key }));
  }
  if (value['nodes'].length > MAX_GRAPH_NODES || value['edges'].length > MAX_GRAPH_EDGES) {
    return err(
      invalid(
        `Field "${key}" exceeds the transport limits (${MAX_GRAPH_NODES} stages / ${MAX_GRAPH_EDGES} edges).`,
        { field: key },
      ),
    );
  }
  for (const node of value['nodes'] as readonly unknown[]) {
    if (!isRecord(node) || typeof node['id'] !== 'string' || typeof node['kind'] !== 'string') {
      return err(invalid('Every node needs string "id" and "kind".', { field: key }));
    }
    if (node['config'] !== undefined && !isRecord(node['config'])) {
      return err(invalid('Node "config" must be an object.', { field: key }));
    }
  }
  for (const edge of value['edges'] as readonly unknown[]) {
    if (!isRecord(edge) || typeof edge['from'] !== 'string' || typeof edge['to'] !== 'string') {
      return err(invalid('Every edge needs string "from" and "to".', { field: key }));
    }
  }
  return ok({
    nodes: (value['nodes'] as readonly Record<string, unknown>[]).map((node) => ({
      id: node['id'] as string,
      kind: node['kind'] as string,
      title: typeof node['title'] === 'string' ? node['title'] : (node['id'] as string),
      config: isRecord(node['config']) ? (node['config'] as Readonly<Record<string, unknown>>) : {},
    })),
    edges: (value['edges'] as readonly Record<string, unknown>[]).map((edge) => ({
      from: edge['from'] as string,
      to: edge['to'] as string,
      ...(typeof edge['condition'] === 'string' ? { condition: edge['condition'] as string } : {}),
    })),
  });
};

function readOps(payload: Record<string, unknown>, key = 'ops'): Result<readonly StageOp[], DomainError> {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) {
    return err(invalid(`Field "${key}" must be a non-empty array of change operations.`, { field: key }));
  }
  if (value.length > MAX_OPS) {
    return err(invalid(`Field "${key}" may hold at most ${MAX_OPS} operations.`, { field: key }));
  }
  for (const entry of value as readonly unknown[]) {
    if (!isRecord(entry) || typeof entry['op'] !== 'string') {
      return err(invalid('Every change operation needs a string "op".', { field: key }));
    }
  }
  return ok(value as readonly StageOp[]);
}

/** Strict entry point: EVERY IPC request passes through here (requirement Q). */
export function parseWorkflowRequest(raw: unknown): Result<WorkflowRequest, DomainError> {
  if (!isRecord(raw)) return err(invalid('An IPC request must be an object.'));
  const operation = raw['operation'];
  if (typeof operation !== 'string' || !(WORKFLOW_OPERATIONS as readonly string[]).includes(operation)) {
    return err(invalid(`Unknown workflow operation "${String(operation)}".`, { allowed: WORKFLOW_OPERATIONS }));
  }
  const requestId = raw['requestId'];
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.trim().length === 0)) {
    return err(invalid('"requestId" must be a non-empty string when provided.'));
  }
  const payload = raw['payload'] ?? {};
  if (!isRecord(payload)) return err(invalid('"payload" must be an object.'));
  return ok({
    operation: operation as WorkflowOperation,
    requestId: typeof requestId === 'string' ? requestId : 'req_unknown',
    payload,
  });
}

export interface VersionSummary {
  readonly versionId: string;
  readonly semver: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly draft: boolean;
  readonly stageCount: number;
}

export interface TemplateSummary {
  readonly templateId: string;
  readonly name: string;
  readonly orgId: string;
  readonly state: WorkflowTemplate['state'];
  readonly currentVersion: string | null;
  readonly versionCount: number;
  readonly usageCount: number;
  readonly updatedAt: string;
  readonly editable: boolean;
}

/** The graph the Designer shows: the open draft, else the current version, else empty. */
export const graphOf = (template: WorkflowTemplate): WorkflowGraph =>
  template.versions.find((version) => version.id === template.draftVersionId)?.graph ??
  currentVersion(template)?.graph ?? { nodes: [], edges: [] };

export const summariseVersion = (version: WorkflowVersion): VersionSummary => ({
  versionId: version.id,
  semver: version.semver,
  contentHash: version.contentHash,
  createdAt: version.createdAt,
  createdBy: version.createdBy,
  draft: version.semver.includes('-draft'),
  stageCount: version.graph.nodes.length,
});

export const summariseTemplate = (template: WorkflowTemplate, usageCount = 0): TemplateSummary => ({
  templateId: template.id,
  name: template.name,
  orgId: template.orgId,
  state: template.state,
  currentVersion: currentVersion(template)?.semver ?? null,
  versionCount: template.versions.length,
  usageCount,
  updatedAt: template.updatedAt,
  editable: template.state === 'draft',
});

export interface GraphDiff {
  readonly addedStageIds: readonly string[];
  readonly removedStageIds: readonly string[];
  readonly changedStageIds: readonly string[];
  readonly addedEdges: readonly string[];
  readonly removedEdges: readonly string[];
}

/** Pure structural diff used by "Compare Versions" (requirement K). */
export function diffGraphs(from: WorkflowGraph, to: WorkflowGraph): GraphDiff {
  const key = (node: { id: string; kind: string; title: string; config: Readonly<Record<string, unknown>> }): string =>
    JSON.stringify({ id: node.id, kind: node.kind, title: node.title, config: node.config });
  const fromNodes = new Map(from.nodes.map((node) => [node.id, node]));
  const toNodes = new Map(to.nodes.map((node) => [node.id, node]));
  const edgeKey = (edge: { from: string; to: string }): string => `${edge.from}->${edge.to}`;
  const fromEdges = new Set(from.edges.map(edgeKey));
  const toEdges = new Set(to.edges.map(edgeKey));
  return {
    addedStageIds: to.nodes.filter((node) => !fromNodes.has(node.id)).map((node) => node.id),
    removedStageIds: from.nodes.filter((node) => !toNodes.has(node.id)).map((node) => node.id),
    changedStageIds: to.nodes
      .filter((node) => fromNodes.has(node.id) && key(node) !== key(fromNodes.get(node.id)!))
      .map((node) => node.id),
    addedEdges: [...toEdges].filter((entry) => !fromEdges.has(entry)),
    removedEdges: [...fromEdges].filter((entry) => !toEdges.has(entry)),
  };
}

/** The durable provider-catalogue row shape (mirrors persistence's ProviderModelRecord). */
export interface ProviderCatalogueRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  /** Opaque to the renderer: capability/pricing objects are passed through verbatim. */
  readonly capabilities: unknown;
  readonly pricing: unknown;
}

/** STAGE 3 — the derived readiness projection (main-process facts, never renderer-owned). */
export type ReadinessProvider = () => Promise<unknown> | unknown;

export interface WorkflowApiDeps {
  readonly lifecycle: WorkflowLifecycle;
  /** Sprint 7: the curated model registry (no routing logic lives behind this). */
  readonly models?: ModelRegistryService;
  /**
   * STAGE 2 — the durable provider catalogue (the raw `provider_models` snapshot an
   * already-configured provider adapter declared). Read-only and offline: it never calls a
   * provider, so the model selector can offer what the provider ACTUALLY exposes without
   * the renderer knowing anything about providers or credentials.
   */
  readonly providerCatalogue?: () => Promise<readonly ProviderCatalogueRow[]>;
  /** STAGE 3: the derived readiness projection for Settings / Diagnostics. */
  readonly readiness?: ReadinessProvider;
  /** Sprint 7.5: selection RULES. It stores and explains; it never chooses. */
  readonly policies?: SelectionPolicyService;
  /** Sprint 8: executes one agent attempt with an EXPLICIT model binding. */
  readonly runtime?: AgentRuntimeService;
  /** Sprint 9: tool contracts + one bounded invocation per request. */
  readonly tools?: ToolRegistry;
  /** Sprint 10B.1: application-layer router (recommendation only; never execution). */
  readonly router?: RouterApplicationService;
  /** Sprint 11: structured handoff service (durable audit + server-derived roles). */
  readonly handoff?: HandoffService;
  readonly memory?: MemoryService;
  readonly decision?: DecisionService;
  readonly listTemplates: () => Promise<readonly WorkflowTemplate[]>;
  /** Real change proposals (Sprint 5 review MEDIUM-3: `proposal.list` used to lie). */
  readonly listProposals?: () => Promise<readonly ChangeProposal[]>;
  readonly roleIds?: readonly string[];
  readonly validatorIds?: readonly string[];
  /**
   * Production default for "every stage must bind a role" (Sprint 5 review MEDIUM-1):
   * a rule that only fires when a caller asks for it is not a rule in production.
   */
  readonly defaultRequireRole?: boolean;
  readonly usageCounts?: () => Promise<Readonly<Record<string, number>>>;
}

export interface WorkflowApi {
  handle(raw: unknown): Promise<WorkflowResponse>;
}

const toError = (error: DomainError): WorkflowErrorPayload => ({
  code: error.code,
  message: error.message,
  details: error.details,
});

/** The registry is part of the composition root; a missing one is a wiring error. */
const registryMissing = (): DomainError =>
  domainError('PERSISTENCE_FAILED', 'The model registry is not wired in this build.', {
    hint: "open the durable database with chains: ['core','engine','lifecycle','provider','registry','selection']",
  });

/** Selection policies are optional wiring too (no router exists yet). */
const policyMissing = (): DomainError =>
  domainError('PERSISTENCE_FAILED', 'The model selection policy service is not wired in this build.', {
    hint: "open the durable database with chains: [..., 'selection']",
  });

/** The agent runtime is part of the composition root as well. */
const runtimeMissing = (): DomainError =>
  domainError('PERSISTENCE_FAILED', 'The agent execution runtime is not wired in this build.', {
    hint: "open the durable database with chains: [..., 'agent']",
  });

/** …and so is the tool registry. */
const toolsMissing = (): DomainError =>
  domainError('PERSISTENCE_FAILED', 'The tool registry is not wired in this build.', {
    hint: "open the durable database with chains: [..., 'tools']",
  });
const memoryMissing = (): DomainError => domainError('PERSISTENCE_FAILED', 'The organizational memory service is not wired in this build.');
const decisionMissing = (): DomainError => domainError('PERSISTENCE_FAILED', 'The decision service is not wired in this build.');

/** A tool invocation payload: an object of primitives is all the registry accepts. */
const readToolInput = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (value === undefined || value === null) return {};
  return isRecord(value) ? value : null;
};

/** `{ id, label }` reference, as the UI/Runtime layers exchange them. */
const readReference = (value: unknown): { id: string; label: string } | null => {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const label = value['label'];
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id, label: typeof label === 'string' && label.length > 0 ? label : id };
};

const readStringArrayField = (value: unknown): readonly string[] | null => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    values.push(entry);
  }
  return values;
};

/** The explicit AgentContext the caller must supply (Sprint 8 §五). */
const readAgentContext = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  for (const field of ['company', 'workflow', 'task', 'role']) {
    if (readReference(value[field]) === null) return null;
  }
  if (readReference(value['workflowRun']) === null) return null;
  const workflowVersion = value['workflowVersion'];
  const objective = value['objective'];
  if (typeof workflowVersion !== 'string' || workflowVersion.length === 0) return null;
  if (typeof objective !== 'string' || objective.length === 0) return null;
  const instructions = readStringArrayField(value['instructions']);
  const constraints = readStringArrayField(value['constraints']);
  const acceptanceCriteria = readStringArrayField(value['acceptanceCriteria']);
  const memoryView = readStringArrayField(value['memoryView']);
  const decisionView = readStringArrayField(value['decisionView']);
  if (instructions === null || constraints === null || acceptanceCriteria === null || memoryView === null || decisionView === null) {
    return null;
  }
  const artifactRefs = value['artifactRefs'];
  const references: { id: string; label: string }[] = [];
  if (artifactRefs !== undefined && artifactRefs !== null) {
    if (!Array.isArray(artifactRefs)) return null;
    for (const entry of artifactRefs) {
      const reference = readReference(entry);
      if (reference === null) return null;
      references.push(reference);
    }
  }
  const stage = value['stage'] === undefined || value['stage'] === null ? null : readReference(value['stage']);
  // Sprint 11: client role claims are NEVER trusted - roles come from the authz service.
  if (
    'previousHandoff' in value ||
    'previousHandoffText' in value
  ) {
    return null;
  }
  return {
    company: readReference(value['company']),
    workflow: readReference(value['workflow']),
    workflowVersion,
    workflowRun: readReference(value['workflowRun']),
    stage,
    task: readReference(value['task']),
    role: readReference(value['role']),
    objective,
    instructions,
    constraints,
    acceptanceCriteria,
    memoryView,
    decisionView,
    artifactRefs: references,
  };
};

const readPromptOptions = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) return {};
  const structuredKeys = readStringArrayField(value['structuredKeys']);
  const tools = readStringArrayField(value['tools']);
  const maxOutputTokens = value['maxOutputTokens'];
  const rolePreamble = value['rolePreamble'];
  return {
    ...(structuredKeys === null ? {} : { structuredKeys }),
    ...(tools === null ? {} : { tools }),
    ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
    ...(typeof rolePreamble === 'string' ? { rolePreamble } : {}),
  };
};

const readArtifactInputs = (value: unknown): readonly { ref: string; label: string }[] | null => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const artifacts: { ref: string; label: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const ref = entry['ref'];
    const label = entry['label'];
    if (typeof ref !== 'string' || ref.length === 0) return null;
    artifacts.push({ ref, label: typeof label === 'string' ? label : ref });
  }
  return artifacts;
};

/** Common bits of every agent.* payload. `null` means "malformed scope list". */
const readModelRequest = (
  payload: Record<string, unknown>,
):
  | {
      readonly modelKey: string | null;
      readonly scopes: readonly PolicyScopeRef[];
      readonly companyId?: string;
      readonly explicit: boolean;
      readonly taskOverride: boolean;
    }
  | null => {
  const modelKey = readText(payload, 'modelKey', false);
  const scopes = readScopes(payload);
  if (scopes === null) return null;
  const companyId = readText(payload, 'companyId', false);
  return {
    modelKey: modelKey.ok ? (modelKey.value ?? null) : null,
    scopes,
    ...(companyId.ok && companyId.value !== undefined ? { companyId: companyId.value } : {}),
    explicit: payload['explicit'] === true,
    taskOverride: payload['taskOverride'] === true,
  };
};

/** `scopes: [{ scopeType, scopeId }]` — a malformed entry is an ARGUMENT error, never dropped. */
const readScopes = (payload: Record<string, unknown>): readonly PolicyScopeRef[] | null => {
  const raw = payload['scopes'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const scopes: PolicyScopeRef[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const scopeType = entry['scopeType'];
    const scopeId = entry['scopeId'];
    if (
      typeof scopeType !== 'string' ||
      !(POLICY_SCOPE_TYPES as readonly string[]).includes(scopeType) ||
      typeof scopeId !== 'string' ||
      scopeId.trim().length === 0
    ) {
      return null;
    }
    scopes.push({ scopeType: scopeType as PolicyScopeRef['scopeType'], scopeId });
  }
  return scopes;
};

const malformedScope = (): DomainError =>
  domainError('INVALID_ARGUMENT', 'A policy scope is malformed.', {});

/* ------------------------------------------------- structured handoff (Sprint 11) --- */

/** Client-supplied role claims are rejected outright - the server derives roles itself. */
const CLIENT_FORBIDDEN_HANDOFF_ROLE_KEYS = [
  'actorRoleIds',
  'roles',
  'roleMemberships',
  'effectiveRoles',
  'permissions',
  'authorities',
] as const;

const handoffMissing = (): DomainError =>
  domainError('ROUTER_NOT_AVAILABLE', 'The handoff service is not wired in this composition root.', {});

/** `{ handoffId, version? }`: the ONLY thing a client may say about a previous handoff. */
const readHandoffRef = (
  payload: Record<string, unknown>,
): { readonly handoffId: string; readonly version: number | null } | null | undefined => {
  const handoffId = payload['handoffId'];
  if (handoffId === undefined || handoffId === null) return undefined;
  if (typeof handoffId !== 'string' || handoffId.trim().length === 0) return null;
  const version = payload['version'];
  if (version === undefined || version === null) return { handoffId, version: null };
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  return { handoffId, version };
};

/** Server-side derivation: durable store -> ACCEPTED check -> bounded deterministic text. */
const derivePreviousHandoff = async (
  handoff: HandoffService | undefined,
  ref: { readonly handoffId: string; readonly version: number | null } | null | undefined,
  actorId: string,
): Promise<string | null> => {
  if (ref === undefined || ref === null || handoff === undefined) return null;
  const loaded = await handoff.get(ref.handoffId, ref.version, actorId);
  // `previousHandoffTextOf` returns null for every state except ACCEPTED.
  return loaded.ok ? previousHandoffTextOf(loaded.value) : null;
};

const readHandoffCreate = (payload: Record<string, unknown>): Record<string, unknown> | null => {
  const required = ['handoffId', 'companyId', 'workflowId', 'workflowVersionId', 'workflowRunId', 'stageId', 'taskId', 'fromAgentId', 'fromRoleId', 'toRoleId', 'objective', 'summary', 'recommendedNextAction', 'traceId', 'actorId'];
  for (const field of required) {
    const value = payload[field];
    if (typeof value !== 'string' || value.trim().length === 0) return null;
  }
  const refs = (field: string): readonly HandoffRef[] => {
    const raw = payload[field];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return [];
    const parsed: HandoffRef[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) return parsed;
      const refId = entry['refId'];
      if (typeof refId !== 'string') return parsed;
      parsed.push({ kind: field.replace('Refs', '') as HandoffRef['kind'], refId });
    }
    return parsed;
  };
  const strings = (field: string): readonly string[] => {
    const raw = payload[field];
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  };
  return {
    handoffId: payload['handoffId'],
    companyId: payload['companyId'],
    workflowId: payload['workflowId'],
    workflowVersionId: payload['workflowVersionId'],
    workflowRunId: payload['workflowRunId'],
    stageId: payload['stageId'],
    taskId: payload['taskId'],
    fromAgentId: payload['fromAgentId'],
    fromRoleId: payload['fromRoleId'],
    toRoleId: payload['toRoleId'],
    objective: payload['objective'],
    summary: payload['summary'],
    recommendedNextAction: payload['recommendedNextAction'],
    traceId: payload['traceId'],
    actorId: payload['actorId'],
    completedWork: strings('completedWork'),
    remainingWork: strings('remainingWork'),
    constraints: strings('constraints'),
    acceptanceCriteria: strings('acceptanceCriteria'),
    knownRisks: strings('knownRisks'),
    openQuestions: strings('openQuestions'),
    artifactRefs: refs('artifactRefs'),
    decisionRefs: refs('decisionRefs'),
    validationRefs: refs('validationRefs'),
  };
};

/** 10B.1 §5: fields a renderer may NEVER send (policy/candidates belong to the server). */
const CLIENT_FORBIDDEN_ROUTER_KEYS = [
  'policyView',
  'candidateModels',
  'allowedModels',
  'blockedModels',
  'allowedProviders',
  'requiredCapabilities',
  'preferredModels',
  'request',
  'routerRequest',
] as const;

const routerMissing = (): DomainError =>
  domainError('ROUTER_NOT_AVAILABLE', 'The router is not wired in this composition root.', {});

/** Read the router SCOPE (the only client-supplied router input). */
const readRouterScope = (payload: Record<string, unknown>): RouterRecommendationInput | null => {
  const companyId = readText(payload, 'companyId');
  if (!companyId.ok || companyId.value === undefined) return null;
  const taskId = readText(payload, 'taskId');
  if (!taskId.ok || taskId.value === undefined) return null;
  const roleId = readText(payload, 'roleId');
  if (!roleId.ok || roleId.value === undefined) return null;
  const traceId = readText(payload, 'traceId');
  if (!traceId.ok || traceId.value === undefined) return null;
  const actorId = readText(payload, 'actorId');
  if (!actorId.ok || actorId.value === undefined) return null;
  const mode = payload['selectionMode'];
  const selectionMode = mode === 'HYBRID' ? 'HYBRID' : mode === 'AUTO' ? 'AUTO' : null;
  if (selectionMode === null) return null;
  const requiredOutputTokens = readOptionalNumber(payload, 'requiredOutputTokens');
  const inputTokens = readOptionalNumber(payload, 'estimatedInputTokens');
  // 10B.2 §八: these are CONTEXT ids, not policy scopes. Only COMPANY/WORKFLOW/ROLE/TASK become
  // policy scopes (the application service builds those); run/stage travel as context.
  const workflowId = readText(payload, 'workflowId', false);
  const runId = readText(payload, 'runId', false);
  const stageId = readText(payload, 'stageId', false);
  return {
    companyId: companyId.value,
    taskId: taskId.value,
    roleId: roleId.value,
    traceId: traceId.value,
    actorId: actorId.value,
    selectionMode,
    requiredCapabilities: readCapabilities(payload),
    estimatedInputTokens: inputTokens ?? 1_000,
    ...(requiredOutputTokens === null ? {} : { requiredOutputTokens }),
    ...(workflowId.ok && workflowId.value !== undefined ? { workflowId: workflowId.value } : {}),
    ...(runId.ok && runId.value !== undefined ? { runId: runId.value } : {}),
    ...(stageId.ok && stageId.value !== undefined ? { stageId: stageId.value } : {}),
  };
};

const readCapabilities = (payload: Record<string, unknown>): readonly string[] => {
  // 10B.2 §七: ONE validation path. `requirements` is the only accepted field name - reading a
  // second forbidden name here used to shadow the boundary check in the handlers.
  const raw = payload['requirements'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
};

/** `router.override.*`: a scope plus the model the user chose (never a policy or candidate list). */
const readOverrideInput = (
  payload: Record<string, unknown>,
  operation: WorkflowOperation,
): (RouterOverrideInput & { readonly confirm: boolean }) | null => {
  const scope = readRouterScope(payload);
  if (scope === null) return null;
  const userModelKey = readText(payload, 'userModelKey');
  if (!userModelKey.ok || userModelKey.value === undefined) return null;
  const recommendedModelKey = readText(payload, 'recommendedModelKey', false);
  const traceId = readText(payload, 'traceId');
  if (!traceId.ok || traceId.value === undefined) return null;
  return {
    ...scope,
    userModelKey: userModelKey.value,
    recommendedModelKey: recommendedModelKey.ok ? (recommendedModelKey.value ?? null) : null,
    confirm: operation === 'router.override.confirm',
  };
};

const readOptionalNumber = (
  payload: Record<string, unknown>,
  key: string,
): number | null => {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export function createWorkflowApi(deps: WorkflowApiDeps): WorkflowApi {
  const options = (
    payload: Readonly<Record<string, unknown>>,
  ): {
    roleIds?: readonly string[];
    validatorIds?: readonly string[];
    requireRole?: boolean;
    lifecycleState?: WorkflowTemplate['state'];
  } => {
    const roles = readStringArray(payload, 'roleIds');
    const validators = readStringArray(payload, 'validatorIds');
    return {
      ...(roles.ok && roles.value !== undefined
        ? { roleIds: roles.value }
        : deps.roleIds === undefined
          ? {}
          : { roleIds: deps.roleIds }),
      ...(validators.ok && validators.value !== undefined
        ? { validatorIds: validators.value }
        : deps.validatorIds === undefined
          ? {}
          : { validatorIds: deps.validatorIds }),
      ...(payload['requireRole'] === true || (payload['requireRole'] !== false && deps.defaultRequireRole === true)
        ? { requireRole: true }
        : {}),
    };
  };

  const templateOf = async (templateId: string): Promise<Result<WorkflowTemplate, DomainError>> => {    const template = await deps.lifecycle.readTemplate(templateId);
    return template === null
      ? err(domainError('NOT_FOUND', `Template ${templateId} not found.`, { templateId }))
      : ok(template);
  };

  /** The single write path for graph edits: Core ops -> Core validation -> Lifecycle save. */
  const applyOperations = async (
    template: WorkflowTemplate,
    ops: readonly StageOp[],
    actorId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<Result<WorkflowTemplate, DomainError>> => {
    const editable = assertEditable(template.state);
    if (!editable.ok) return editable;

    const applied = applyChangeOps(graphOf(template), ops);
    if (!applied.ok) return applied;

    const report = validateWorkflowGraph(applied.value, {
      ...options(payload),
      lifecycleState: template.state,
    });
    if (!report.valid) {
      return err(
        domainError('VALIDATION_FAILED', 'The change set produces an invalid workflow.', {
          issues: report.issues,
          issueCodes: report.issues.map((entry) => entry.code),
        }),
      );
    }
    return deps.lifecycle.saveDraftGraph({ templateId: template.id, graph: applied.value, actorId });
  };

  return {
    async handle(raw: unknown): Promise<WorkflowResponse> {
      const parsed = parseWorkflowRequest(raw);
      if (!parsed.ok) return { ok: false, operation: null, error: toError(parsed.error) };
      const { operation, payload } = parsed.value;

      const settle = async <T>(work: () => Promise<Result<T, DomainError>>): Promise<WorkflowResponse> => {
        const result = await work();
        return result.ok
          ? { ok: true, operation, value: result.value }
          : { ok: false, operation, error: toError(result.error) };
      };

      const fail = (error: DomainError): WorkflowResponse => ({ ok: false, operation, error: toError(error) });

      try {
        switch (operation) {
          case 'library.list': {
            const templates = await deps.listTemplates();
            const usage = deps.usageCounts === undefined ? {} : await deps.usageCounts();
            return {
              ok: true,
              operation,
              value: templates.map((template) => summariseTemplate(template, usage[template.id] ?? 0)),
            };
          }

          case 'template.get':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              return templateOf(id.value as string);
            });

          case 'draft.create':
            return settle(async () => {
              const orgId = readText(payload, 'orgId');
              if (!orgId.ok) return orgId;
              const name = readText(payload, 'name');
              if (!name.ok) return name;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.lifecycle.createTemplate({
                orgId: orgId.value as string,
                name: name.value as string,
                actorId: actorId.value as string,
              });
            });

          case 'draft.open':
          case 'draft.validate': {
            const id = readText(payload, 'templateId');
            if (!id.ok) return fail(id.error);
            const found = await templateOf(id.value as string);
            if (!found.ok) return fail(found.error);
            const graph = graphOf(found.value);
            const report = validateWorkflowGraph(graph, {
              ...options(payload),
              lifecycleState: found.value.state,
            });
            return {
              ok: true,
              operation,
              value: {
                template: summariseTemplate(found.value),
                versions: found.value.versions.map(summariseVersion),
                graph,
                editable: found.value.state === 'draft',
                validation: report,
              },
            };
          }

          case 'draft.applyOps':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const ops = readOps(payload);
              if (!ops.ok) return ops;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const found = await templateOf(id.value as string);
              if (!found.ok) return found;
              return applyOperations(found.value, ops.value, actorId.value as string, payload);
            });

          case 'draft.save':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const graph = readGraph(payload, 'graph');
              if (!graph.ok) return graph;
              if (graph.value === undefined) return err(invalid('Field "graph" is required.', {}));
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const found = await templateOf(id.value as string);
              if (!found.ok) return found;
              const editable = assertEditable(found.value.state);
              if (!editable.ok) return editable;
              const report = validateWorkflowGraph(graph.value, {
                ...options(payload),
                lifecycleState: found.value.state,
              });
              if (!report.valid) {
                return err(
                  domainError('VALIDATION_FAILED', 'The workflow graph is invalid.', {
                    issues: report.issues,
                    issueCodes: report.issues.map((entry) => entry.code),
                  }),
                );
              }
              return deps.lifecycle.saveDraftGraph({
                templateId: found.value.id,
                graph: graph.value,
                actorId: actorId.value as string,
              });
            });

          case 'review.submit':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const rationale = readText(payload, 'rationale');
              if (!rationale.ok) return rationale;
              const summary = readText(payload, 'summary', false);
              if (!summary.ok) return summary;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const changeSummary = readOps(payload, 'changeSummary');
              const ops = changeSummary.ok ? changeSummary.value : [];
              if (ops.length === 0) {
                return err(
                  invalid('Field "changeSummary" must describe at least one change.', { field: 'changeSummary' }),
                );
              }
              return deps.lifecycle.openProposal({
                templateId: id.value as string,
                rationale: rationale.value as string,
                summary: summary.value ?? 'designer change request',
                ops: ops.map((entry) => ({
                  op: 'update_node' as const,
                  path: `${entry.op}#${'stageId' in entry ? String(entry.stageId) : 'workflow'}`,
                })),
                actorId: actorId.value as string,
              });
            });

          case 'review.decide':
            return settle(async () => {
              const proposalId = readText(payload, 'proposalId');
              if (!proposalId.ok) return proposalId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const decision = payload['decision'];
              if (decision !== 'accept' && decision !== 'reject') {
                return err(invalid('Field "decision" must be "accept" or "reject".', { field: 'decision' }));
              }
              const note = readText(payload, 'note', false);
              if (!note.ok) return note;
              return deps.lifecycle.decideProposal({
                proposalId: proposalId.value as string,
                decision,
                actorId: actorId.value as string,
                ...(note.value === undefined ? {} : { note: note.value }),
              });
            });

          case 'revision.open':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const proposalId = readText(payload, 'proposalId');
              if (!proposalId.ok) return proposalId;
              const graph = readGraph(payload, 'graph');
              if (!graph.ok) return graph;
              if (graph.value === undefined) return err(invalid('Field "graph" is required.', {}));
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.lifecycle.openRevision({
                templateId: id.value as string,
                proposalId: proposalId.value as string,
                graph: graph.value,
                actorId: actorId.value as string,
              });
            });

          case 'publish.revision':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.lifecycle.publishRevision({
                templateId: id.value as string,
                actorId: actorId.value as string,
              });
            });

          case 'proposal.list': {
            const proposals = deps.listProposals === undefined ? [] : await deps.listProposals();
            return {
              ok: true,
              operation,
              value: proposals.map((proposal) => ({
                proposalId: proposal.id,
                status: proposal.status,
                templateId: proposal.targetTemplateId,
                baseVersionId: proposal.baseVersionId,
                authorId: proposal.authorId,
                rationale: proposal.rationale,
                createdAt: proposal.createdAt,
                decidedBy: proposal.decidedBy,
              })),
            };
          }

          case 'publish': {
            const id = readText(payload, 'templateId');
            if (!id.ok) return fail(id.error);
            const found = await templateOf(id.value as string);
            if (!found.ok) return fail(found.error);
            // Validation is the publish gate; the lifecycle service then applies its rules.
            const report = validateWorkflowGraph(graphOf(found.value), {
              ...options(payload),
              requireRole: payload['requireRole'] === true,
            });
            if (!report.valid) {
              return fail(
                domainError('VALIDATION_FAILED', 'Publish refused: the workflow is invalid.', {
                  issues: report.issues,
                  issueCodes: report.issues.map((entry) => entry.code),
                }),
              );
            }
            const actorId = readText(payload, 'actorId');
            if (!actorId.ok) return fail(actorId.error);
            const published = await deps.lifecycle.publish({
              templateId: found.value.id,
              actorId: actorId.value as string,
            });
            return published.ok ? { ok: true, operation, value: published.value } : fail(published.error);
          }

          case 'version.get':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const found = await templateOf(id.value as string);
              if (!found.ok) return found;
              const versionId = readText(payload, 'versionId', false);
              if (!versionId.ok) return versionId;
              const version =
                versionId.value === undefined
                  ? currentVersion(found.value)
                  : (found.value.versions.find((entry) => entry.id === versionId.value) ?? null);
              return version === null
                ? err(domainError('NOT_FOUND', 'No such version.', { templateId: found.value.id }))
                : ok({ version: summariseVersion(version), graph: version.graph });
            });

          case 'compare':
            return settle(async () => {
              const fromId = readText(payload, 'fromVersionId');
              if (!fromId.ok) return fromId;
              const toId = readText(payload, 'toVersionId');
              if (!toId.ok) return toId;
              const templates = await deps.listTemplates();
              const versions = templates.flatMap((template) => template.versions);
              const from = versions.find((version) => version.id === fromId.value);
              const to = versions.find((version) => version.id === toId.value);
              if (from === undefined || to === undefined) {
                return err(domainError('NOT_FOUND', 'Both versions must exist to be compared.', {}));
              }
              return ok({
                from: summariseVersion(from),
                to: summariseVersion(to),
                diff: diffGraphs(from.graph, to.graph),
              });
            });

          case 'fork':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const name = readText(payload, 'name');
              if (!name.ok) return name;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.lifecycle.fork({
                templateId: id.value as string,
                name: name.value as string,
                actorId: actorId.value as string,
              });
            });

          case 'deprecate':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const reason = readText(payload, 'reason');
              if (!reason.ok) return reason;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.lifecycle.deprecate({
                templateId: id.value as string,
                reason: reason.value as string,
                actorId: actorId.value as string,
              });
            });

          case 'archive':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.lifecycle.archive({ templateId: id.value as string, actorId: actorId.value as string });
            });

          case 'run.create':
            return settle(async () => {
              const id = readText(payload, 'templateId');
              if (!id.ok) return id;
              const companyId = readText(payload, 'companyId');
              if (!companyId.ok) return companyId;
              const workflowId = readText(payload, 'workflowId');
              if (!workflowId.ok) return workflowId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.lifecycle.createRun({
                templateId: id.value as string,
                companyId: companyId.value as string,
                workflowId: workflowId.value as string,
                actorId: actorId.value as string,
              });
            });

          case 'run.snapshot':
            return settle(async () => {
              const snapshotId = readText(payload, 'snapshotId');
              if (!snapshotId.ok) return snapshotId;
              const snapshot = await deps.lifecycle.readSnapshot(snapshotId.value as string);
              return snapshot === null ? err(domainError('NOT_FOUND', 'No such run snapshot.', {})) : ok(snapshot);
            });

          case 'models.catalogue': {
            // STAGE 2 — what an already-configured provider actually offers, read from the
            // durable catalogue. No provider call, no credentials, no registration.
            if (deps.providerCatalogue === undefined) return fail(registryMissing());
            const rows = await deps.providerCatalogue();
            return {
              ok: true,
              operation,
              value: rows.map((row) => ({
                providerId: row.providerId,
                providerModelId: row.modelId,
                displayName: row.displayName,
                contextWindow: row.contextWindow,
                maxOutputTokens: row.maxOutputTokens,
                capabilities: row.capabilities,
                pricing: row.pricing,
              })),
            };
          }

          case 'models.list': {
            if (deps.models === undefined) return fail(registryMissing());
            const includeDisabled = payload['includeDisabled'] === true;
            return {
              ok: true,
              operation,
              value: (await deps.models.list({ includeDisabled })).map((record) => ({
                modelKey: record.modelKey,
                displayName: record.displayName,
                providerId: record.providerId,
                providerModelId: record.providerModelId,
                description: record.description,
                capabilities: record.capabilities,
                contextWindow: record.contextWindow,
                maxOutputTokens: record.maxOutputTokens,
                pricing: record.pricing,
                enabled: record.enabled,
                availability: record.availability,
                updatedAt: record.updatedAt,
              })),
            };
          }

          case 'models.register':
            return settle(async () => {
              if (deps.models === undefined) return err(registryMissing());
              const providerId = readText(payload, 'providerId');
              if (!providerId.ok) return providerId;
              const providerModelId = readText(payload, 'providerModelId');
              if (!providerModelId.ok) return providerModelId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const modelKey = readText(payload, 'modelKey', false);
              if (!modelKey.ok) return modelKey;
              const description = readText(payload, 'description', false);
              if (!description.ok) return description;
              return deps.models.registerFromProvider({
                providerId: providerId.value as string,
                providerModelId: providerModelId.value as string,
                actorId: actorId.value as string,
                ...(modelKey.value === undefined ? {} : { modelKey: modelKey.value }),
                ...(description.value === undefined ? {} : { description: description.value }),
              });
            });

          case 'models.enable':
          case 'models.disable':
            return settle(async () => {
              if (deps.models === undefined) return err(registryMissing());
              const modelKey = readText(payload, 'modelKey');
              if (!modelKey.ok) return modelKey;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.models.setEnabled(
                modelKey.value as string,
                operation === 'models.enable',
                actorId.value as string,
              );
            });

          case 'models.alias':
            return settle(async () => {
              if (deps.models === undefined) return err(registryMissing());
              const alias = readText(payload, 'alias');
              if (!alias.ok) return alias;
              const modelKey = readText(payload, 'modelKey');
              if (!modelKey.ok) return modelKey;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const scope = readText(payload, 'scope', false);
              if (!scope.ok) return scope;
              return deps.models.bindAlias({
                alias: alias.value as string,
                modelKey: modelKey.value as string,
                actorId: actorId.value as string,
                ...(scope.value === undefined ? {} : { scope: scope.value }),
              });
            });

          case 'models.resolve':
            return settle(async () => {
              if (deps.models === undefined) return err(registryMissing());
              const alias = readText(payload, 'alias');
              if (!alias.ok) return alias;
              const scope = readText(payload, 'scope', false);
              if (!scope.ok) return scope;
              return deps.models.resolve(alias.value as string, scope.value);
            });

          case 'models.refreshHealth':
            return settle(async () => {
              if (deps.models === undefined) return err(registryMissing());
              const providerId = readText(payload, 'providerId');
              if (!providerId.ok) return providerId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.models.refreshHealth(providerId.value as string, actorId.value as string);
            });

          case 'models.policy':
            return settle(async () => {
              if (deps.policies === undefined) return err(policyMissing());
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const scopeType = readText(payload, 'scopeType');
              if (!scopeType.ok) return scopeType;
              if (!(POLICY_SCOPE_TYPES as readonly string[]).includes(scopeType.value as string)) {
                return err(invalid(`Unknown policy scope "${String(scopeType.value)}".`, { allowed: POLICY_SCOPE_TYPES }));
              }
              const scopeId = readText(payload, 'scopeId');
              if (!scopeId.ok) return scopeId;
              const mode = readText(payload, 'mode');
              if (!mode.ok) return mode;
              if (!(SELECTION_MODES as readonly string[]).includes(mode.value as string)) {
                return err(invalid(`Unknown selection mode "${String(mode.value)}".`, { allowed: SELECTION_MODES }));
              }
              const fallback = readText(payload, 'allowFallback', false);
              if (!fallback.ok) return fallback;
              if (
                fallback.value !== undefined &&
                !(FALLBACK_MODES as readonly string[]).includes(fallback.value)
              ) {
                return err(invalid(`Unknown fallback mode "${fallback.value}".`, { allowed: FALLBACK_MODES }));
              }
              const manualModelKey = readText(payload, 'manualModelKey', false);
              if (!manualModelKey.ok) return manualModelKey;
              const lists = {
                allowedModels: readStringArray(payload, 'allowedModels'),
                preferredModels: readStringArray(payload, 'preferredModels'),
                blockedModels: readStringArray(payload, 'blockedModels'),
                allowedProviders: readStringArray(payload, 'allowedProviders'),
                requiredCapabilities: readStringArray(payload, 'requiredCapabilities'),
              };
              for (const [key, value] of Object.entries(lists)) {
                if (!value.ok) return value;
                void key;
              }
              return deps.policies.savePolicy({
                actorId: actorId.value as string,
                scopeType: scopeType.value as PolicyScopeRef['scopeType'],
                scopeId: scopeId.value as string,
                mode: mode.value as 'MANUAL' | 'AUTO' | 'HYBRID',
                manualModelKey: manualModelKey.value ?? null,
                allowedModels: lists.allowedModels.ok ? (lists.allowedModels.value ?? []) : [],
                preferredModels: lists.preferredModels.ok ? (lists.preferredModels.value ?? []) : [],
                blockedModels: lists.blockedModels.ok ? (lists.blockedModels.value ?? []) : [],
                allowedProviders: lists.allowedProviders.ok ? (lists.allowedProviders.value ?? []) : [],
                requiredCapabilities: lists.requiredCapabilities.ok ? (lists.requiredCapabilities.value ?? []) : [],
                maxCost: readOptionalNumber(payload, 'maxCost'),
                maxLatency: readOptionalNumber(payload, 'maxLatency'),
                ...(fallback.value === undefined ? {} : { allowFallback: fallback.value as 'NEVER' | 'ASK' | 'AUTO_WITHIN_POLICY' }),
                requireApprovalForOverride: payload['requireApprovalForOverride'] === true,
              });
            });

          case 'runtime.readiness': {
            // STAGE 3 — a DERIVED readiness projection (provider / model / executor / workspace).
            if (deps.readiness === undefined) return fail(registryMissing());
            return { ok: true, operation, value: await deps.readiness() };
          }

          case 'models.selection': {
            // STAGE 2 — the EFFECTIVE model selection for a scope, read-only. The client
            // must be able to show which model the company currently runs on (and that none
            // is selected) without being able to choose one itself.
            if (deps.policies === undefined) return fail(policyMissing());
            const scopeTypeInput = readText(payload, 'scopeType', false);
            if (!scopeTypeInput.ok) return fail(scopeTypeInput.error);
            const scopeIdInput = readText(payload, 'scopeId', false);
            if (!scopeIdInput.ok) return fail(scopeIdInput.error);
            const scopeType = scopeTypeInput.value ?? 'COMPANY';
            if (!(POLICY_SCOPE_TYPES as readonly string[]).includes(scopeType)) {
              return fail(invalid(`Unknown policy scope "${scopeType}".`, { allowed: POLICY_SCOPE_TYPES }));
            }
            const scopeId = scopeIdInput.value ?? 'company_default';
            const policy = await deps.policies.getPolicy(scopeType as PolicyScopeRef['scopeType'], scopeId);
            if (policy === null) {
              return { ok: true, operation, value: { scopeType, scopeId, selected: false, resolvedModelKey: null } };
            }
            return {
              ok: true,
              operation,
              value: {
                scopeType,
                scopeId,
                selected: true,
                mode: policy.mode,
                manualModelKey: policy.manualModelKey,
                preferredModels: policy.preferredModels,
                resolvedModelKey:
                  policy.manualModelKey !== null && policy.manualModelKey !== ''
                    ? policy.manualModelKey
                    : (policy.preferredModels[0] ?? null),
              },
            };
          }

          case 'models.policy.explain':
            return settle(async () => {
              if (deps.policies === undefined) return err(policyMissing());
              const modelKey = readText(payload, 'modelKey');
              if (!modelKey.ok) return modelKey;
              const scopes = readScopes(payload);
              if (scopes === null) return err(malformedScope());
              return deps.policies.explainManual({
                modelKey: modelKey.value as string,
                scopes,
                explicit: payload['explicit'] === true,
                ...(payload['taskOverride'] === true ? { taskOverride: true } : {}),
              });
            });

          case 'agent.prepare':
          case 'agent.execute':
            return settle(async () => {
              if (deps.runtime === undefined) return err(runtimeMissing());
              const agentId = readText(payload, 'agentId');
              if (!agentId.ok) return agentId;
              const roleId = readText(payload, 'roleId');
              if (!roleId.ok) return roleId;
              const taskId = readText(payload, 'taskId');
              if (!taskId.ok) return taskId;
              const runId = readText(payload, 'runId');
              if (!runId.ok) return runId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;

              const modelRequest = readModelRequest(payload);
              if (modelRequest === null) return err(malformedScope());
              // Sprint 11: the previous handoff is DERIVED from the durable store (client text is
              // rejected by `readAgentContext`). Only an ACCEPTED handoff yields a value.
              const handoffRef = readHandoffRef(payload);
              if (handoffRef === null) return err(invalid('handoffId/version are malformed.'));
              // A client may never hand the runtime a previous-handoff text (any operation).
              const clientContext = payload['context'];
              if (
                isRecord(clientContext) &&
                ('previousHandoff' in clientContext || 'previousHandoffText' in clientContext)
              ) {
                return err(invalid('previousHandoff is derived server-side from an ACCEPTED handoff.'));
              }
              const previousHandoff = await derivePreviousHandoff(deps.handoff, handoffRef, actorId.value as string);
              const request = {
                agentId: agentId.value as string,
                roleId: roleId.value as string,
                taskId: taskId.value as string,
                runId: runId.value as string,
                actorId: actorId.value as string,
                previousHandoff,
                ...modelRequest,
              };

              if (operation === 'agent.prepare') return deps.runtime.prepare(request);

              const context = readAgentContext(payload['context']);
              if (context === null) {
                return err(invalid('agent.execute needs an explicit context with references and an objective.'));
              }
              const artifacts = readArtifactInputs(payload['artifacts']);
              if (artifacts === null) {
                return err(invalid('agent.execute received malformed artifact references.'));
              }
              const resultRef = readText(payload, 'resultRef', false);
              if (!resultRef.ok) return resultRef;
              return deps.runtime.execute({
                ...request,
                context: context as never,
                prompt: readPromptOptions(payload['prompt']) as never,
                ...(resultRef.value === undefined ? {} : { resultRef: resultRef.value }),
                artifacts,
              });
            });

          case 'agent.get':
            return settle(async () => {
              if (deps.runtime === undefined) return err(runtimeMissing());
              const executionId = readText(payload, 'executionId');
              if (!executionId.ok) return executionId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const found = await deps.runtime.get(executionId.value as string, actorId.value as string);
              if (!found.ok) return found;
              if (found.value === null) {
                return err(domainError('NOT_FOUND', `Execution "${String(executionId.value)}" does not exist.`, {}));
              }
              return ok(found.value);
            });

          case 'agent.list':
            return settle(async () => {
              if (deps.runtime === undefined) return err(runtimeMissing());
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const taskId = readText(payload, 'taskId', false);
              if (!taskId.ok) return taskId;
              const runId = readText(payload, 'runId', false);
              if (!runId.ok) return runId;
              const roleId = readText(payload, 'roleId', false);
              if (!roleId.ok) return roleId;
              return deps.runtime.list(
                {
                  ...(taskId.value === undefined ? {} : { taskId: taskId.value }),
                  ...(runId.value === undefined ? {} : { runId: runId.value }),
                  ...(roleId.value === undefined ? {} : { roleId: roleId.value }),
                },
                actorId.value as string,
              );
            });

          case 'agent.cancel':
            return settle(async () => {
              if (deps.runtime === undefined) return err(runtimeMissing());
              const executionId = readText(payload, 'executionId');
              if (!executionId.ok) return executionId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.runtime.cancel(executionId.value as string, actorId.value as string);
            });

          case 'agent.recover':
            return settle(async () => {
              if (deps.runtime === undefined) return err(runtimeMissing());
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.runtime.recoverInterrupted(actorId.value as string);
            });

          case 'tools.list':
            return settle(async () => {
              if (deps.tools === undefined) return err(toolsMissing());
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const limit = readOptionalNumber(payload, 'limit');
              const cursorValue = payload['cursor'];
              if (cursorValue !== undefined && cursorValue !== null && typeof cursorValue !== 'string') {
                return err(invalid('tools.list received a malformed cursor.'));
              }
              return deps.tools.list(
                {
                  includeDisabled: payload['includeDisabled'] === true,
                  ...(limit === null ? {} : { limit }),
                  ...(typeof cursorValue === 'string' ? { cursor: cursorValue } : {}),
                },
                actorId.value as string,
              );
            });

          case 'tools.recover':
            return settle(async () => {
              if (deps.tools === undefined) return err(toolsMissing());
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.tools.recoverInvocations(actorId.value as string);
            });

          case 'tools.retry':
            return settle(async () => {
              if (deps.tools === undefined) return err(toolsMissing());
              const invocationId = readText(payload, 'invocationId');
              if (!invocationId.ok) return invocationId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.tools.retryInvocation(invocationId.value as string, actorId.value as string);
            });

          case 'tools.enable':
          case 'tools.disable':
            return settle(async () => {
              if (deps.tools === undefined) return err(toolsMissing());
              const toolId = readText(payload, 'toolId');
              if (!toolId.ok) return toolId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.tools.setEnabled(
                toolId.value as string,
                operation === 'tools.enable',
                actorId.value as string,
              );
            });

          case 'router.recommend':
            return settle(async () => {
              if (deps.router === undefined) return err(routerMissing());
              // 10B.1 §5: the client may ONLY name a scope. Everything else (policy view,
              // candidates, ranking context) is assembled by the application layer.
              const forbidden = CLIENT_FORBIDDEN_ROUTER_KEYS.filter((key) => key in payload);
              if (forbidden.length > 0) {
                return err(
                  invalid('The router request must not carry policy or candidate fields.', { forbidden }),
                );
              }
              const input = readRouterScope(payload);
              if (input === null) return err(invalid('A router request needs a valid scope.'));
              return (await deps.router.recommend(input)) as Result<unknown, DomainError>;
            });

          case 'router.override.request':
          case 'router.override.confirm':
            return settle(async () => {
              if (deps.router === undefined) return err(routerMissing());
              const forbidden = CLIENT_FORBIDDEN_ROUTER_KEYS.filter((key) => key in payload);
              if (forbidden.length > 0) {
                return err(invalid('An override request must not carry policy fields.', { forbidden }));
              }
              const input = readOverrideInput(payload, operation);
              if (input === null) return err(invalid('An override needs a scope and a userModelKey.'));
              return (await deps.router.override(input)) as Result<unknown, DomainError>;
            });

          case 'handoff.create':
          case 'handoff.ready':
          case 'handoff.accept':
          case 'handoff.reject':
          case 'handoff.cancel':
          case 'handoff.get':
          case 'handoff.listForTargetRole':
            return settle(async () => {
              // Role claims are rejected BEFORE anything else: a forged claim must never depend on
              // whether the handoff service happens to be wired.
              const roleClaims = CLIENT_FORBIDDEN_HANDOFF_ROLE_KEYS.filter((key) => key in payload);
              if (roleClaims.length > 0) {
                return err(invalid('Handoff roles are derived server-side; client role claims are rejected.', {
                  forbidden: roleClaims,
                }));
              }
              if (deps.handoff === undefined) return err(handoffMissing());
              if (operation === 'handoff.create') {
                const input = readHandoffCreate(payload);
                if (input === null) return err(invalid('handoff.create needs the full packet.'));
                return (await deps.handoff.createDraft(input as never)) as Result<unknown, DomainError>;
              }
              const handoffId = readText(payload, 'handoffId');
              if (!handoffId.ok || handoffId.value === undefined) return err(invalid('handoffId is required.'));
              const versionText = readOptionalNumber(payload, 'version');
              if (operation === 'handoff.listForTargetRole') {
                const toRoleId = readText(payload, 'toRoleId');
                if (!toRoleId.ok || toRoleId.value === undefined) return err(invalid('toRoleId is required.'));
                const listActorId = readText(payload, 'actorId');
                if (!listActorId.ok || listActorId.value === undefined) return err(invalid('actorId is required.'));
                return (await deps.handoff.listForTargetRole(toRoleId.value, versionText ?? 20, listActorId.value)) as Result<unknown, DomainError>;
              }
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok || actorId.value === undefined) return err(invalid('actorId is required.'));
              if (operation === 'handoff.get') {
                return (await deps.handoff.get(handoffId.value, versionText, actorId.value)) as Result<unknown, DomainError>;
              }
              if (versionText === null) return err(invalid('version is required for this operation.'));
              if (operation === 'handoff.ready') {
                return (await deps.handoff.ready({ handoffId: handoffId.value, version: versionText, actorId: actorId.value })) as Result<unknown, DomainError>;
              }
              if (operation === 'handoff.cancel') {
                return (await deps.handoff.cancel({ handoffId: handoffId.value, version: versionText, actorId: actorId.value })) as Result<unknown, DomainError>;
              }
              if (operation === 'handoff.accept') {
                return (await deps.handoff.accept({ handoffId: handoffId.value, version: versionText, actorId: actorId.value })) as Result<unknown, DomainError>;
              }
              const reasons = payload['reasonCodes'];
              const comment = readText(payload, 'comment', false);
              return (await deps.handoff.reject({
                handoffId: handoffId.value,
                version: versionText,
                actorId: actorId.value,
                reasonCodes: Array.isArray(reasons) ? (reasons as never) : ([] as never),
                comment: comment.ok ? (comment.value ?? null) : null,
              })) as Result<unknown, DomainError>;
            });

          case 'tools.invoke':
            return settle(async () => {
              if (deps.tools === undefined) return err(toolsMissing());
              const toolId = readText(payload, 'toolId');
              if (!toolId.ok) return toolId;
              const executionId = readText(payload, 'executionId');
              if (!executionId.ok) return executionId;
              const agentId = readText(payload, 'agentId');
              if (!agentId.ok) return agentId;
              const taskId = readText(payload, 'taskId');
              if (!taskId.ok) return taskId;
              const runId = readText(payload, 'runId');
              if (!runId.ok) return runId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const input = readToolInput(payload['input']);
              if (input === null) return err(invalid('tools.invoke needs an object payload.'));
              const idempotencyKey = readText(payload, 'idempotencyKey', false);
              if (!idempotencyKey.ok) return idempotencyKey;
              return deps.tools.invoke({
                toolId: toolId.value as string,
                executionId: executionId.value as string,
                agentId: agentId.value as string,
                taskId: taskId.value as string,
                runId: runId.value as string,
                actorId: actorId.value as string,
                input,
                ...(idempotencyKey.value === undefined ? {} : { idempotencyKey: idempotencyKey.value }),
              });
            });

          case 'tools.approve':
            return settle(async () => {
              if (deps.tools === undefined) return err(toolsMissing());
              const invocationId = readText(payload, 'invocationId');
              if (!invocationId.ok) return invocationId;
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              return deps.tools.approve({
                invocationId: invocationId.value as string,
                actorId: actorId.value as string,
              });
            });

          case 'tools.invocations':
            return settle(async () => {
              if (deps.tools === undefined) return err(toolsMissing());
              const actorId = readText(payload, 'actorId');
              if (!actorId.ok) return actorId;
              const executionId = readText(payload, 'executionId', false);
              if (!executionId.ok) return executionId;
              const toolId = readText(payload, 'toolId', false);
              if (!toolId.ok) return toolId;
              const rootInvocationId = readText(payload, 'rootInvocationId', false);
              if (!rootInvocationId.ok) return rootInvocationId;
              const limit = readOptionalNumber(payload, 'limit');
              const cursorValue = payload['cursor'];
              if (cursorValue !== undefined && cursorValue !== null && typeof cursorValue !== 'string') {
                return err(invalid('tools.invocations received a malformed cursor.'));
              }
              return deps.tools.listInvocations(
                {
                  ...(executionId.value === undefined ? {} : { executionId: executionId.value }),
                  ...(toolId.value === undefined ? {} : { toolId: toolId.value }),
                  ...(rootInvocationId.value === undefined ? {} : { rootInvocationId: rootInvocationId.value }),
                  ...(limit === null ? {} : { limit }),
                  ...(typeof cursorValue === 'string' ? { cursor: cursorValue } : {}),
                },
                actorId.value as string,
              );
            });

          case 'memory.create':
          case 'memory.get':
          case 'memory.retrieve':
          case 'memory.history':
          case 'memory.supersede':
          case 'memory.markStale':
          case 'memory.retract':
            return settle<unknown>(async () => {
              if (deps.memory === undefined) return err(memoryMissing());
              const actor = readText(payload, 'actorId'); if (!actor.ok) return actor;
              if (operation === 'memory.create') {
                const scope = payload['scope'];
                if (!isRecord(scope) || typeof scope.type !== 'string' || typeof scope.id !== 'string') return err(invalid('memory.create needs scope.'));
                const required = ['companyId','kind','importance','title','content','traceId','createdBy'];
                if (required.some(k => typeof payload[k] !== 'string')) return err(invalid('memory.create is missing required fields.'));
                return deps.memory.create({ ...payload, scope, actorId: actor.value } as never);
              }
              if (operation === 'memory.retrieve') {
                const scopes = payload['scopes']; if (!Array.isArray(scopes)) return err(invalid('memory.retrieve needs scopes.'));
                const companyId = readText(payload, 'companyId'); if (!companyId.ok) return companyId;
                return deps.memory.retrieve({ ...payload, actorId: actor.value, companyId: companyId.value, scopes } as never);
              }
              const id = readText(payload, 'memoryId'); if (!id.ok) return id;
              const version = readOptionalNumber(payload, 'version');
              if (operation === 'memory.get') return deps.memory.get(id.value!, version, actor.value!);
              if (operation === 'memory.history') return deps.memory.history(id.value!, actor.value!);
              if (version === null) return err(invalid('version is required.'));
              if (operation === 'memory.markStale') return deps.memory.markStale({ memoryId:id.value!, version, actorId:actor.value!, reason:String(payload['reason'] ?? '') });
              if (operation === 'memory.retract') return deps.memory.retract({ memoryId:id.value!, version, actorId:actor.value!, reason:typeof payload['reason']==='string'?payload['reason']:undefined });
              const next = payload['next']; if (!isRecord(next)) return err(invalid('next is required.'));
              return deps.memory.supersede({ memoryId:id.value!, version, actorId:actor.value!, next: next as never });
            });

          case 'decision.create':
          case 'decision.get':
          case 'decision.active':
          case 'decision.history':
          case 'decision.supersede':
          case 'decision.revoke':
            return settle<unknown>(async () => {
              if (deps.decision === undefined) return err(decisionMissing());
              const actor = readText(payload, 'actorId'); if (!actor.ok) return actor;
              if (operation === 'decision.create') return deps.decision.create({ ...payload, actorId: actor.value } as never);
              if (operation === 'decision.active') { const company = readText(payload,'companyId'); if(!company.ok)return company; return deps.decision.active(company.value!,actor.value!,readOptionalNumber(payload,'limit')??100); }
              const id = readText(payload, 'decisionId'); if (!id.ok) return id;
              const version = readOptionalNumber(payload, 'version');
              if (operation === 'decision.get') return deps.decision.get(id.value!, version, actor.value!);
              if (operation === 'decision.history') return deps.decision.history(id.value!, actor.value!);
              if (version === null) return err(invalid('version is required.'));
              if (operation === 'decision.revoke') return deps.decision.revoke({decisionId:id.value!,version,actorId:actor.value!});
              const next = payload['next']; if(!isRecord(next)) return err(invalid('next is required.'));
              return deps.decision.supersede({decisionId:id.value!,version,actorId:actor.value!,next:next as never});
            });
          default:
            return fail(invalid(`Operation "${String(operation)}" is not implemented.`));
        }
      } catch (error) {
        return fail(
          error instanceof DomainError
            ? error
            : domainError('PERSISTENCE_FAILED', error instanceof Error ? error.message : String(error), {}),
        );
      }
    },
  };
}

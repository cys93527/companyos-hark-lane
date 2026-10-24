/**
 * Tool Registry domain (Sprint 9 §二/§五).
 *
 * A ToolRecord is an industry-neutral description of an invocable capability: what it does,
 * what it accepts, what it returns, how risky it is, which authorities it needs, how it
 * behaves on replay, and which adapter implements it.
 *
 * NOT here, and never: choosing a tool for a task, planning multi-tool sequences, or looping
 * an agent over tools. A registry lists and describes; the caller (a bounded runtime path)
 * must name the tool it wants.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import { AUTHORITIES, isAuthority, type Authority } from './role-authority.js';

export const TOOL_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];
export const isToolRiskLevel = (value: unknown): value is ToolRiskLevel =>
  typeof value === 'string' && (TOOL_RISK_LEVELS as readonly string[]).includes(value);

export const IDEMPOTENCY_MODES = ['NONE', 'COMMAND_ID', 'IDEMPOTENT_KEY'] as const;
export type IdempotencyMode = (typeof IDEMPOTENCY_MODES)[number];

export const TOOL_AUDIT_POLICIES = ['STANDARD', 'STRICT'] as const;
export type ToolAuditPolicy = (typeof TOOL_AUDIT_POLICIES)[number];

/**
 * The frozen risk semantics (§五). Risk lives in the DOMAIN, not in a UI hint:
 * every gate below is enforced by the registry before an adapter is ever called.
 */
export interface RiskPolicy {
  readonly requiresApproval: boolean;
  readonly requiresValidator: boolean;
  readonly auditPolicy: ToolAuditPolicy;
  /** CRITICAL forbids the requester approving their own call. */
  readonly selfApprovalAllowed: boolean;
}

export const RISK_POLICY: Readonly<Record<ToolRiskLevel, RiskPolicy>> = {
  LOW: { requiresApproval: false, requiresValidator: false, auditPolicy: 'STANDARD', selfApprovalAllowed: true },
  MEDIUM: { requiresApproval: false, requiresValidator: true, auditPolicy: 'STRICT', selfApprovalAllowed: true },
  HIGH: { requiresApproval: true, requiresValidator: false, auditPolicy: 'STRICT', selfApprovalAllowed: true },
  CRITICAL: { requiresApproval: true, requiresValidator: false, auditPolicy: 'STRICT', selfApprovalAllowed: false },
};

export const riskPolicyOf = (riskLevel: ToolRiskLevel): RiskPolicy => RISK_POLICY[riskLevel];

/** Approval decision for a TOOL call. Pure: the caller supplies both actors. */
export function decideToolApproval(input: {
  readonly riskLevel: ToolRiskLevel;
  readonly requesterActorId: string;
  readonly approverActorId: string;
}): Result<true, DomainError> {
  const policy = RISK_POLICY[input.riskLevel];
  if (!policy.requiresApproval) {
    return ok(true);
  }
  if (input.approverActorId.trim().length === 0) {
    return err(
      domainError('APPROVAL_REQUIRED', `Tool risk ${input.riskLevel} requires explicit human approval.`, {
        riskLevel: input.riskLevel,
      }),
    );
  }
  if (!policy.selfApprovalAllowed && input.approverActorId === input.requesterActorId) {
    return err(
      domainError('APPROVAL_DENIED', 'A CRITICAL tool may not be approved by the actor who requested it.', {
        riskLevel: input.riskLevel,
        actorId: input.approverActorId,
      }),
    );
  }
  return ok(true);
}

export interface ToolRecord {
  /** `EntityStore` key - identical to `toolId`. */
  readonly id: string;
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  /** Tool contract version (semver-ish string; the registry never rewrites it). */
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  readonly riskLevel: ToolRiskLevel;
  readonly requiredAuthorities: readonly Authority[];
  readonly timeoutMs: number;
  readonly idempotencyMode: IdempotencyMode;
  readonly auditPolicy: ToolAuditPolicy;
  /** What kind of adapter implements it (`mock` today) - never a vendor name. */
  readonly providerKind: string;
  /** Opaque reference to the adapter binding (resolved by the composition root). */
  readonly adapterRef: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const normalizeToolId = (raw: string): string => raw.trim().toLowerCase();

export interface CreateToolInput {
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly capabilities?: readonly string[];
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly riskLevel: string;
  readonly requiredAuthorities?: readonly string[];
  readonly timeoutMs?: number;
  readonly idempotencyMode?: string;
  readonly auditPolicy?: string;
  readonly providerKind?: string;
  readonly adapterRef?: string;
  readonly now: string;
}

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export function createToolRecord(input: CreateToolInput): Result<ToolRecord, DomainError> {
  const toolId = normalizeToolId(input.toolId);
  if (!TOOL_ID_PATTERN.test(toolId)) {
    return err(
      domainError('VALIDATION_FAILED', `"${input.toolId}" is not a valid tool id.`, {
        toolId: input.toolId,
        pattern: TOOL_ID_PATTERN.source,
      }),
    );
  }
  if (input.name.trim().length === 0) {
    return err(domainError('VALIDATION_FAILED', 'A tool needs a name.', { toolId }));
  }
  if (input.version.trim().length === 0) {
    return err(domainError('VALIDATION_FAILED', 'A tool needs a version.', { toolId }));
  }
  if (!isToolRiskLevel(input.riskLevel)) {
    return err(
      domainError('VALIDATION_FAILED', `Unknown risk level "${input.riskLevel}".`, {
        allowed: TOOL_RISK_LEVELS,
      }),
    );
  }
  const idempotencyMode = input.idempotencyMode ?? 'NONE';
  if (!(IDEMPOTENCY_MODES as readonly string[]).includes(idempotencyMode)) {
    return err(
      domainError('VALIDATION_FAILED', `Unknown idempotency mode "${idempotencyMode}".`, {
        allowed: IDEMPOTENCY_MODES,
      }),
    );
  }
  const auditPolicy = input.auditPolicy ?? RISK_POLICY[input.riskLevel].auditPolicy;
  if (!(TOOL_AUDIT_POLICIES as readonly string[]).includes(auditPolicy)) {
    return err(
      domainError('VALIDATION_FAILED', `Unknown audit policy "${auditPolicy}".`, { allowed: TOOL_AUDIT_POLICIES }),
    );
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return err(domainError('VALIDATION_FAILED', 'timeoutMs must be a positive integer.', { timeoutMs }));
  }

  const requiredAuthorities: Authority[] = [];
  for (const authority of input.requiredAuthorities ?? []) {
    if (!isAuthority(authority)) {
      return err(
        domainError('VALIDATION_FAILED', `Unknown authority "${authority}" on tool "${toolId}".`, {
          authority,
          known: AUTHORITIES.length,
        }),
      );
    }
    if (!requiredAuthorities.includes(authority)) requiredAuthorities.push(authority);
  }
  // Invoking a tool is ALWAYS required, whatever the tool declares (§四).
  if (!requiredAuthorities.includes('tool.invoke')) requiredAuthorities.push('tool.invoke');

  return ok({
    id: toolId,
    toolId,
    name: input.name,
    description: input.description,
    version: input.version,
    capabilities: [...new Set((input.capabilities ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort(),
    inputSchema: { ...input.inputSchema },
    outputSchema: { ...input.outputSchema },
    enabled: true,
    riskLevel: input.riskLevel,
    requiredAuthorities,
    timeoutMs,
    idempotencyMode: idempotencyMode as IdempotencyMode,
    auditPolicy: auditPolicy as ToolAuditPolicy,
    providerKind: input.providerKind ?? 'mock',
    adapterRef: input.adapterRef ?? toolId,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export const setToolEnabled = (record: ToolRecord, enabled: boolean, now: string): ToolRecord => ({
  ...record,
  enabled,
  updatedAt: now,
});

/** Side-effecting tools must declare how a replay is handled (§七). */
export const toolHasSideEffects = (record: Pick<ToolRecord, 'capabilities'>): boolean =>
  record.capabilities.includes('side_effect') || record.capabilities.includes('write');

/**
 * Reserved capability marker (Sprint 13A/ADR-0016, Task-13-05): a tool is resolvable as
 * a VALIDATOR only when it explicitly declares this capability at registration. An
 * ordinary tool is never a validator by default — the Validation subsystem resolves
 * exclusively through this opt-in (fail closed for everything else). Declaring it does
 * NOT change the tool's risk level, authorities, or execution model; it only makes the
 * tool discoverable by the controlled validator resolver.
 */
export const TOOL_CAPABILITY_VALIDATOR = 'validation:validator';

/** The tool descriptors a model may be shown - a description, never a selection. */
export interface ToolDescriptor {
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly riskLevel: ToolRiskLevel;
  readonly capabilities: readonly string[];
  /** The tool's inputSchema (named `parameters` for provider/protocol familiarity). */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export const describeTool = (record: ToolRecord): ToolDescriptor => ({
  toolId: record.toolId,
  name: record.name,
  description: record.description,
  version: record.version,
  riskLevel: record.riskLevel,
  capabilities: [...record.capabilities].sort(),
  parameters: record.inputSchema,
});

/**
 * Agent — the *worker* currently occupying a Role (规划书 §二原则 2 / 原则 3).
 *
 * Hard invariant (Sprint 1 Task 5 / STEP 7):
 *   **An Agent must NEVER bind a concrete Provider.** An agent carries at most a
 *   *logical* capability-slot reference (e.g. `logical.reasoning.default`), which
 *   the Router resolves to a provider+model at execution time (P1/Sprint 7-10).
 *   The rule is enforced with an ALLOW-LIST of slots, so no vendor name needs to
 *   be known by Core at all.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import { makeId, type AgentId, type CompanyId, type RoleId } from '../kernel/identifiers.js';

export const AGENT_STATUSES = ['idle', 'busy', 'disabled'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * Closed vocabulary of logical binding SLOTS.
 *
 * Deliberately an allow-list, not a vendor block-list (review finding HIGH-3): a
 * block-list both leaks vendor names into Core and is always incomplete
 * (`logical.mistral.default` would sail through). Anything that is not a declared
 * slot is refused, so no provider or model name can become part of an Agent.
 */
export const LOGICAL_BINDING_SLOTS = [
  'reasoning',
  'fast',
  'writing',
  'review',
  'research',
  'analysis',
  'design',
  'vision',
  'speech',
  'embedding',
] as const;
export type LogicalBindingSlot = (typeof LOGICAL_BINDING_SLOTS)[number];

/**
 * Closed vocabulary of binding VARIANTS (quality tiers).
 *
 * The variant segment must be closed too (review re-inspection): an open pattern
 * like `logical.<slot>.<anything>` would let a product name through in the tier
 * segment, i.e. the red line would be bypassable by the back door. Only tiers are
 * allowed — never a product name.
 */
export const LOGICAL_BINDING_VARIANTS = ['default', 'cheap', 'balanced', 'strong'] as const;
export type LogicalBindingVariant = (typeof LOGICAL_BINDING_VARIANTS)[number];

export interface Agent {
  readonly id: AgentId;
  readonly companyId: CompanyId;
  readonly roleId: RoleId;
  readonly displayName: string;
  readonly status: AgentStatus;
  /** LOGICAL binding only (`logical.<slot>[.<variant>]`); `null` = unassigned. */
  readonly modelBindingRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const LOGICAL_REF_PATTERN = /^logical\.([a-z][a-z0-9-]*)(?:\.([a-z][a-z0-9-]*))?$/;

/** Rejects anything that is not a declared logical slot+tier — provider/model names included. */
export function validateModelBindingRef(ref: string): Result<string, DomainError> {
  const match = LOGICAL_REF_PATTERN.exec(ref);
  if (match === null) {
    return err(
      domainError(
        'POLICY_DENIED',
        'An Agent binding must be a logical reference: "logical.<slot>" or "logical.<slot>.<tier>".',
        { ref, allowedSlots: [...LOGICAL_BINDING_SLOTS], allowedVariants: [...LOGICAL_BINDING_VARIANTS] },
      ),
    );
  }
  const slot = match[1] ?? '';
  if (!(LOGICAL_BINDING_SLOTS as readonly string[]).includes(slot)) {
    return err(
      domainError('POLICY_DENIED', `"${slot}" is not a declared logical binding slot.`, {
        ref,
        slot,
        allowedSlots: [...LOGICAL_BINDING_SLOTS],
      }),
    );
  }
  const variant = match[2];
  if (variant !== undefined && !(LOGICAL_BINDING_VARIANTS as readonly string[]).includes(variant)) {
    return err(
      domainError('POLICY_DENIED', `"${variant}" is not a declared binding tier.`, {
        ref,
        variant,
        allowedVariants: [...LOGICAL_BINDING_VARIANTS],
      }),
    );
  }
  return ok(ref);
}

/** The capability slot a binding targets — never an implementation name. */
export const logicalSlotOf = (ref: string): LogicalBindingSlot | null => {
  const match = LOGICAL_REF_PATTERN.exec(ref);
  const slot = match?.[1];
  return slot !== undefined && (LOGICAL_BINDING_SLOTS as readonly string[]).includes(slot)
    ? (slot as LogicalBindingSlot)
    : null;
};

export interface CreateAgentInput {
  readonly companyId: CompanyId;
  readonly roleId: RoleId;
  readonly displayName: string;
  readonly now: string;
  readonly ids: IdFactory;
  readonly modelBindingRef?: string;
}

export function createAgent(input: CreateAgentInput): Result<Agent, DomainError> {
  if (input.displayName.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'Agent display name must not be empty.', {}));
  }
  let modelBindingRef: string | null = null;
  if (input.modelBindingRef !== undefined) {
    const validated = validateModelBindingRef(input.modelBindingRef);
    if (!validated.ok) return validated;
    modelBindingRef = validated.value;
  }
  return ok({
    id: makeId<'AgentId'>('agent', input.ids),
    companyId: input.companyId,
    roleId: input.roleId,
    displayName: input.displayName.trim(),
    status: 'idle',
    modelBindingRef,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function assignModelBinding(
  agent: Agent,
  ref: string,
  now: string,
): Result<Agent, DomainError> {
  const validated = validateModelBindingRef(ref);
  if (!validated.ok) return validated;
  return ok({ ...agent, modelBindingRef: validated.value, updatedAt: now });
}

export function clearModelBinding(agent: Agent, now: string): Result<Agent, DomainError> {
  if (agent.modelBindingRef === null) {
    return err(
      domainError('CONFLICT', `Agent ${agent.id} has no model binding.`, { agentId: agent.id }),
    );
  }
  return ok({ ...agent, modelBindingRef: null, updatedAt: now });
}

export function setAgentStatus(
  agent: Agent,
  status: AgentStatus,
  now: string,
): Result<Agent, DomainError> {
  if (agent.status === status) {
    return err(
      domainError('CONFLICT', `Agent ${agent.id} is already "${status}".`, { agentId: agent.id }),
    );
  }
  return ok({ ...agent, status, updatedAt: now });
}

export const isAgentAvailable = (agent: Agent): boolean => agent.status !== 'disabled';

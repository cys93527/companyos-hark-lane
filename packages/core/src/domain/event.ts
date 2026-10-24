/**
 * Core domain event catalog (规划书 §四 Core 概念 16 "Event").
 *
 * Single-source rule (AGENTS.md §0.1): the *workflow/template* events are already
 * declared by the lifecycle machine (`lifecycle/machine.ts` → `TRANSITIONS[].emits`),
 * so they are NOT repeated here. This module owns the **run / execution / task /
 * validation / approval / artifact** vocabulary that Sprint 1 introduces.
 */
import type { DomainEvent } from '../kernel/events.js';
import { defineEvent } from '../kernel/events.js';
import type { IdFactory } from '../ports/id-factory.js';

export const CORE_DOMAIN_EVENT_TYPES = [
  // run lifecycle (L1 machine, §三十三)
  'run.started',
  'run.snapshot_pinned',
  'run.sop_design_started',
  'run.draft_submitted',
  'run.draft_rejected',
  'run.created',
  'run.plan_ready',
  'run.route_resolved',
  'run.route_failed',
  'run.approval_required',
  'run.approval_granted',
  'run.approval_denied',
  'run.execution_done',
  'run.execution_failed',
  'run.review_passed',
  'run.review_rejected',
  'run.rework_ready',
  'run.rework_exhausted',
  'run.validation_passed',
  'run.validation_failed',
  'run.delivered',
  'run.delivery_failed',
  'run.paused',
  'run.resumed',
  'run.crash_detected',
  'run.recovered',
  'run.recovery_failed',
  'run.cancelled',
  'run.timed_out',
  'run.completed',
  // task / stage (L3)
  'stage.created',
  'stage.state_changed',
  'task.created',
  'task.state_changed',
  'task.blocked',
  // governance & artifacts
  'validation.recorded',
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'approval.expired',
  'artifact.created',
  // org / pack
  'company.created',
  'pack.installed',
  'pack.disabled',
  // provider + model registry audit (Sprint 6/7)
  'provider.registered',
  'provider.invoked',
  'provider.health_checked',
  'provider.failed',
  'model.registered',
  'model.enabled',
  'model.disabled',
  'model.alias_bound',
  'model.selection_policy_saved',
  'benchmark.result_recorded',
  // agent execution audit (Sprint 8)
  'agent.execution_created',
  'agent.execution_started',
  'agent.execution_completed',
  'agent.execution_failed',
  'agent.execution_cancelled',
  'agent.execution_interrupted',
  'agent.provider_invoked',
  // tool registry audit (Sprint 9)
  'tool.registered',
  'tool.enabled',
  'tool.disabled',
  'tool.invocation_requested',
  'tool.invocation_started',
  'tool.invocation_completed',
  'tool.invocation_failed',
  'tool.approval_requested',
  'tool.invocation_replayed',
  'tool.invocation_interrupted',
  // structured handoff audit (Sprint 11)
  'handoff.created',
  'handoff.ready',
  'handoff.accepted',
  'handoff.rejected',
  'handoff.superseded',
  'handoff.cancelled',
  // executor dispatch audit (LIVE-SMOKE-FIX-08: pre-launch attribution + settlement
  // correlation for external provider invocations — killed/timed-out attempts stay
  // attributable without depending on post-success transcripts)
  'executor.dispatch_requested',
  'executor.dispatch_settled',
  'executor.tool_invocation_requested',
  // V1 EFFICIENCY E1-B: bounded observational in-attempt activity (coalesced
  // kernel stdout windows; ACTIVITY_IS_NOT_PROGRESS; read by nothing in execution)
  'executor.attempt_activity',
  // model router audit (Sprint 10A: contract only - no emitter until 10B)
  'router.requested',
  'router.candidates_built',
  'router.recommendation_created',
  'router.no_candidate',
  'router.override_requested',
  'router.override_confirmed',
  'role.created',
  'agent.created',
  'agent.binding_assigned',
] as const;

export type CoreDomainEventType = (typeof CORE_DOMAIN_EVENT_TYPES)[number];

export const isCoreDomainEventType = (value: unknown): value is CoreDomainEventType =>
  typeof value === 'string' && (CORE_DOMAIN_EVENT_TYPES as readonly string[]).includes(value);

export interface CoreEventContext {
  readonly traceId: string;
  readonly actorId: string;
  readonly now: string;
  readonly ids: IdFactory;
}

export interface CoreEventAggregate {
  readonly type: string;
  readonly id: string;
}

/**
 * Build a `DomainEvent` for a Core domain type.
 *
 * `occurredAt` always comes from the injected context (never `Date.now()`), so a
 * replayed run produces byte-identical events (ADR-0003 / `Clock` port rule).
 */
export function createCoreDomainEvent(
  type: CoreDomainEventType,
  aggregate: CoreEventAggregate,
  payload: Readonly<Record<string, unknown>>,
  context: CoreEventContext,
): DomainEvent<CoreDomainEventType, Readonly<Record<string, unknown>>> {
  return defineEvent(
    {
      type,
      aggregateId: aggregate.id,
      aggregateType: aggregate.type,
      traceId: context.traceId,
      actorId: context.actorId,
      payload,
    },
    context.ids,
    context.now,
  );
}

/** Deterministic ordering key for an event log (id is a monotonic ULID). */
export const eventOrderKey = (event: DomainEvent): string => event.eventId;

/**
 * Who emits each declared event.
 *
 * Every catalog entry must have exactly ONE declared emitter: a name nobody can emit
 * is a lie in the audit vocabulary, and two emitters would make the trail
 * non-deterministic (review finding after Sprint 2). Entries whose emitter does not
 * exist yet carry the sprint that will own them, so the gap is explicit rather than
 * silent.
 */
export const CORE_EVENT_EMITTERS: Readonly<Record<CoreDomainEventType, string>> = {
  // L1 machine transitions (engine)
  'run.started': 'engine:l1-machine',
  'run.snapshot_pinned': 'engine:l1-machine',
  'run.sop_design_started': 'engine:l1-machine',
  'run.draft_submitted': 'engine:l1-machine',
  'run.draft_rejected': 'engine:l1-machine',
  'run.created': 'engine:l1-machine',
  'run.plan_ready': 'engine:l1-machine',
  'run.route_resolved': 'engine:l1-machine',
  'run.route_failed': 'engine:l1-machine',
  'run.approval_required': 'engine:l1-machine',
  'run.approval_granted': 'engine:l1-machine',
  'run.approval_denied': 'engine:l1-machine',
  'run.execution_done': 'engine:l1-machine',
  'run.execution_failed': 'engine:l1-machine',
  'run.review_passed': 'engine:l1-machine',
  'run.review_rejected': 'engine:l1-machine',
  'run.rework_ready': 'engine:l1-machine',
  'run.rework_exhausted': 'engine:l1-machine',
  'run.validation_passed': 'engine:l1-machine',
  'run.validation_failed': 'engine:l1-machine',
  'run.delivered': 'engine:l1-machine',
  'run.delivery_failed': 'engine:l1-machine',
  'run.paused': 'engine:l1-machine',
  'run.resumed': 'engine:l1-machine',
  'run.crash_detected': 'engine:l1-machine',
  'run.recovered': 'engine:l1-machine',
  'run.recovery_failed': 'engine:l1-machine',
  'run.cancelled': 'engine:l1-machine',
  'run.timed_out': 'engine:l1-machine',
  'run.completed': 'engine:l1-machine',
  // Task-level transitions observed by the engine while executing a stage
  'task.state_changed': 'engine:task-execution',
  'task.blocked': 'engine:task-execution',
  // Approval aggregate (the engine records the decision it applied)
  'approval.requested': 'engine:approval-side-effect',
  'approval.granted': 'engine:approval-side-effect',
  'approval.denied': 'engine:approval-side-effect',
  'approval.expired': 'sweeper:S24',
  // Not emitted yet — declared with their future owner instead of silently dangling
  'stage.created': 'planner:S18',
  'stage.state_changed': 'planner:S18',
  'task.created': 'planner:S18',
  'validation.recorded': 'validators:S13',
  'artifact.created': 'artifact-service:S13',
  'company.created': 'org-context:S1',
  'role.created': 'org-context:S1',
  'agent.created': 'org-context:S1',
  'agent.binding_assigned': 'org-context:S1',
  'pack.installed': 'pack-registry:S15',
  'pack.disabled': 'pack-registry:S15',
  // emitted today by the provider layer / model registry (engine)
  'provider.registered': 'engine:provider-registry',
  'provider.invoked': 'engine:provider-registry',
  'provider.health_checked': 'engine:provider-registry',
  'provider.failed': 'engine:provider-registry',
  'model.registered': 'engine:model-registry',
  'model.enabled': 'engine:model-registry',
  'model.disabled': 'engine:model-registry',
  'model.alias_bound': 'engine:model-registry',
  'model.selection_policy_saved': 'engine:selection-policy',
  'benchmark.result_recorded': 'engine:benchmark-harness',
  'agent.execution_created': 'engine:agent-runtime',
  'agent.execution_started': 'engine:agent-runtime',
  'agent.execution_completed': 'engine:agent-runtime',
  'agent.execution_failed': 'engine:agent-runtime',
  'agent.execution_cancelled': 'engine:agent-runtime',
  'agent.execution_interrupted': 'engine:agent-runtime',
  'agent.provider_invoked': 'engine:agent-runtime',
  'tool.registered': 'engine:tool-registry',
  'tool.enabled': 'engine:tool-registry',
  'tool.disabled': 'engine:tool-registry',
  'tool.invocation_requested': 'engine:tool-registry',
  'tool.invocation_started': 'engine:tool-registry',
  'tool.invocation_completed': 'engine:tool-registry',
  'tool.invocation_failed': 'engine:tool-registry',
  'tool.approval_requested': 'engine:tool-registry',
  'tool.invocation_replayed': 'engine:tool-registry',
  'tool.invocation_interrupted': 'engine:tool-registry',
  // Sprint 11: emitted durably by the handoff service, which IS wired at the composition root.
  // (`handoff.superseded` has no IPC operation yet; the service path emits it.)
  'handoff.created': 'engine:handoff-service',
  'handoff.ready': 'engine:handoff-service',
  'handoff.accepted': 'engine:handoff-service',
  'handoff.rejected': 'engine:handoff-service',
  'handoff.superseded': 'engine:handoff-service',
  'handoff.cancelled': 'engine:handoff-service',
  // Declared, not yet emitted: the router service lands in Sprint 10B (ADR-0014).
  'executor.dispatch_requested': 'desktop:provider-dispatch',
  'executor.dispatch_settled': 'desktop:provider-dispatch',
  'executor.tool_invocation_requested': 'desktop:embedded-executor',
  'executor.attempt_activity': 'desktop:embedded-executor',
  'router.requested': 'model-router:S10',
  'router.candidates_built': 'model-router:S10',
  'router.recommendation_created': 'model-router:S10',
  'router.no_candidate': 'model-router:S10',
  'router.override_requested': 'model-router:S10',
  'router.override_confirmed': 'model-router:S10',
};

export const emitterOf = (type: CoreDomainEventType): string => CORE_EVENT_EMITTERS[type];

/**
 * THE workflow lifecycle state machine (ADR-0006/0007/0009).
 *
 * Single source of truth for the 10 lifecycle capabilities required by the
 * execution directive: Draft → Publish → Version → Fork → Deprecate → Archive,
 * plus Run Snapshot, Template Lock, Change Proposal and Performance Metrics
 * (the last four are modelled in sibling modules because they do not mutate the
 * template's own state).
 *
 * `docs/STATE_MACHINE.md` mirrors this table — change both together.
 */
import { err, ok, type Result } from '../kernel/result.js';
import { LifecycleError } from '../kernel/errors.js';

export const LIFECYCLE_STATES = ['draft', 'published', 'deprecated', 'archived'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LIFECYCLE_EVENTS = [
  'publish',
  'open_revision',
  'publish_revision',
  'fork',
  'deprecate',
  'archive',
  'lock',
  'unlock',
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/** `new_template` marks an event that materialises a *different* aggregate. */
export type TransitionTarget = LifecycleState | 'new_template';

export interface TransitionRule {
  readonly event: LifecycleEvent;
  readonly from: readonly LifecycleState[];
  readonly to: TransitionTarget;
  /** Human-readable precondition, mirrored by the imperative guards in template.ts. */
  readonly guard: string;
  readonly effect: string;
  readonly emits: readonly string[];
}

export const TRANSITIONS: readonly TransitionRule[] = [
  {
    event: 'publish',
    from: ['draft'],
    to: 'published',
    guard: 'template has no current version yet; graph must contain at least one node',
    effect: 'mint immutable WorkflowVersion 1.0.0, set currentVersionId, state=published',
    emits: ['workflow.version.created', 'workflow.template.published'],
  },
  {
    event: 'open_revision',
    from: ['published'],
    to: 'published',
    guard:
      'an ACCEPTED ChangeProposal exists whose baseVersionId === currentVersionId; no draft already open',
    effect: 'add draft version <next-minor>-draft, set draftVersionId; published version untouched',
    emits: ['workflow.version.draft_created', 'workflow.template.revision_opened'],
  },
  {
    event: 'publish_revision',
    from: ['published'],
    to: 'published',
    guard: 'draftVersionId is set and the referenced draft version exists',
    effect: 'release the draft (strip -draft), promote it to currentVersionId, clear draftVersionId',
    emits: ['workflow.version.released', 'workflow.template.published'],
  },
  {
    event: 'fork',
    from: ['published', 'deprecated'],
    to: 'new_template',
    guard: 'a source version exists; no ACTIVE lock with scope=global',
    effect: 'create a NEW template in state=draft with forkedFrom lineage pointing at the source',
    emits: ['workflow.template.forked'],
  },
  {
    event: 'deprecate',
    from: ['published'],
    to: 'deprecated',
    guard: 'reason is non-empty; refusing NEW runs is acceptable to the caller',
    effect:
      'state=deprecated; a pending draft version is discarded (draftVersionId:=null, recorded in the event); existing run snapshots keep executing',
    emits: ['workflow.template.deprecated'],
  },
  {
    event: 'archive',
    from: ['deprecated'],
    to: 'archived',
    guard: 'no ACTIVE run-scoped lock referencing this template',
    effect: 'state=archived — terminal, read-only forever, retained for audit',
    emits: ['workflow.template.archived'],
  },
  {
    event: 'lock',
    from: ['draft', 'published', 'deprecated'],
    to: 'published',
    guard: 'scope ∈ {run, global} and reason is non-empty',
    effect: 'create a TemplateLock; does NOT change state (lock is a separate aggregate)',
    emits: ['workflow.template.locked'],
  },
  {
    event: 'unlock',
    from: ['draft', 'published', 'deprecated'],
    to: 'published',
    guard: 'the lock is still active',
    effect: 'release the TemplateLock; does NOT change state',
    emits: ['workflow.template.unlocked'],
  },
];

export const findTransition = (
  event: LifecycleEvent,
  from: LifecycleState,
): TransitionRule | null => TRANSITIONS.find((rule) => rule.event === event && rule.from.includes(from)) ?? null;

export const canTransition = (event: LifecycleEvent, from: LifecycleState): boolean =>
  findTransition(event, from) !== null;

export const allowedEvents = (state: LifecycleState): readonly LifecycleEvent[] =>
  TRANSITIONS.filter((rule) => rule.from.includes(state)).map((rule) => rule.event);

/** `archived` is absorbing: no outgoing edges, ever. */
export const isTerminal = (state: LifecycleState): boolean =>
  !TRANSITIONS.some((rule) => rule.from.includes(state));

export const isState = (value: unknown): value is LifecycleState =>
  typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);

/**
 * Resolve the target state, or fail with `ILLEGAL_TRANSITION`.
 * Lock/unlock are overlay events and return the state unchanged.
 */
export function nextState(event: LifecycleEvent, from: LifecycleState): Result<LifecycleState, LifecycleError> {
  const rule = findTransition(event, from);
  if (rule === null) {
    return err(
      new LifecycleError('ILLEGAL_TRANSITION', `Event "${event}" is not legal in state "${from}".`, {
        from,
        event,
        allowed: allowedEvents(from),
      }),
    );
  }
  if (rule.to === 'new_template' || rule.event === 'lock' || rule.event === 'unlock') {
    return ok(from);
  }
  return ok(rule.to);
}

/** Guard helper for callers that need to fail fast with a custom message. */
export function requireState(
  template: { readonly state: LifecycleState; readonly id: string },
  allowed: readonly LifecycleState[],
  event: LifecycleEvent,
): Result<true, LifecycleError> {
  if (allowed.includes(template.state)) return ok(true);
  const code =
    template.state === 'archived'
      ? 'ARCHIVED_READONLY'
      : template.state === 'deprecated'
        ? 'DEPRECATED_TEMPLATE'
        : 'ILLEGAL_TRANSITION';
  return err(
    new LifecycleError(
      code,
      `Template ${template.id} is "${template.state}"; "${event}" requires one of [${allowed.join(', ')}].`,
      { templateId: template.id, state: template.state, event, allowed },
    ),
  );
}

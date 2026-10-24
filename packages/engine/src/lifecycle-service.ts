/**
 * Workflow Lifecycle service (Sprint 4).
 *
 * Outer-ring orchestration for the L2 lifecycle domain that Core already owns: load the
 * aggregate from the ports, call the pure Core functions, persist the result and write
 * the lifecycle events — all inside ONE `UnitOfWork` transaction, so a half-published
 * template cannot exist.
 *
 * It contains no domain rules of its own (every guard — Draft → Review → Publish,
 * immutability, accepted proposals, lock policy, retired templates — comes from Core)
 * and knows nothing about industries or models.
 */
import {
  DomainError,
  acceptChangeProposal,
  archiveTemplate,
  asId,
  assertForkable,
  assertMutable as assertMutableInCore,
  canonicalJson,
  createRunSnapshot,
  createTemplateLock,
  createWorkflowRun,
  createWorkflowTemplate,
  createWorkflowVersion,
  currentVersion,
  defineEvent,
  deprecateTemplate,
  domainError,
  draftVersion,
  err,
  forkTemplate,
  isRunnable,
  ok,
  openChangeProposal,
  openRevision as openRevisionInCore,
  publishInitialVersion,
  publishRevision as publishRevisionInCore,
  recomputeContentHash,
  rejectChangeProposal,
  releaseTemplateLock,
  requireState,
  sha256Hex,
  validateRunModelBindings,
  type RunGoalInput,
  type RunModelBindingResolver,
  type ChangeOp,
  type ChangeProposal,
  type Clock,
  type CommandLedgerPort,
  type DomainEvent,
  type EntityStore,
  type EventStorePort,
  type IdFactory,
  type Logger,
  type PackAvailabilityPolicy,
  type PackRunProvenancePolicy,
  type Result,
  type RunSnapshot,
  type StoredEvent,
  type TemplateLock,
  type UnitOfWork,
  type WorkflowGraph,
  type WorkflowRun,
  type WorkflowTemplate,
  FAULT_CHECKPOINTS,
  type FaultCheckpointPort,
} from '@companyos/core';

/* ------------------------------------------------------------------ inputs --- */

/**
 * Structural creation-guard seams (T20-05 permanent identity): the durable stores
 * satisfy these without the engine importing persistence. A PLAIN insert arbitrated by
 * the PRIMARY KEY; the immutable creation seed decides replay vs conflict.
 */
export interface RunCreationGuard {
  putGuarded(entity: WorkflowRun): Promise<
    Result<{ readonly runId: string; readonly replayed: boolean }, DomainError>
  >;
}

export interface TemplateCreationGuard {
  putGuarded(entity: WorkflowTemplate): Promise<
    Result<{ readonly templateId: string; readonly replayed: boolean }, DomainError>
  >;
}

export interface WorkflowLifecycleDeps {
  readonly ids: IdFactory;
  readonly clock: Clock;
  readonly templates: EntityStore<WorkflowTemplate> & Partial<TemplateCreationGuard>;
  readonly locks: EntityStore<TemplateLock>;
  readonly proposals: EntityStore<ChangeProposal>;
  readonly snapshots: EntityStore<RunSnapshot>;
  readonly runs: EntityStore<WorkflowRun> & Partial<RunCreationGuard>;
  readonly events: EventStorePort;
  /** When omitted, writes are not transactional (logged, never silent). */
  readonly unitOfWork?: UnitOfWork;
  readonly logger?: Logger;
  /**
   * Task-18-08 deterministic fault-injection seam: absent in production (zero overhead),
   * armed by a test harness to prove the run-creation transaction's atomicity.
   */
  readonly faultCheckpoints?: FaultCheckpointPort;
  /**
   * Governance policy seam (Sprint 4 review MEDIUM-4).
   *
   * When supplied, EVERY mutating operation asks for one authority first
   * (`workflow.publish`, `workflow.draft.edit`, `workflow.fork`, …), so a composition
   * root can enforce the Bible's T02–T07 preconditions. Omitted ⇒ allow-all, which is
   * recorded as a known limitation in ADR-0007 until the Role store lands.
   */
  readonly authorize?: (request: {
    readonly actorId: string;
    readonly authority: string;
    readonly templateId: string | null;
    readonly traceId?: string;
  }) => Promise<Result<true, DomainError>> | Result<true, DomainError>;
  /**
   * Industry-pack live-availability seam (T15-04 corrective; ADR-0025 Decision 4).
   *
   * A WorkflowTemplate a pack materialized keeps its draft/versions after the pack is
   * disabled (existing Runs and history must stay resolvable), but no NEW work may use
   * it. When supplied, every new-use entry (draft edit, publish, revision publish, fork,
   * run start) refuses a template whose owning pack installations are all disabled.
   * Reads (`readTemplate`, `readSnapshot`, `eventsOf`) are never gated.
   * Omitted => no pack awareness (legacy composition without packs).
   */
  readonly packAvailability?: PackAvailabilityPolicy;
  /**
   * Industry-pack RUN provenance (T15-05, ADR-0027). When supplied, `createRun` derives
   * `RunSnapshot.packVersions` from durable provenance (live pack owners of the selected
   * materialized template + their exact dependency closure) BEFORE any write, and fails
   * closed on an incomplete resolution. Omitted => no pack awareness (legacy composition),
   * in which case the snapshot keeps its empty map.
   */
  readonly packProvenance?: PackRunProvenancePolicy;
  /**
   * Durable command ledger (Sprint 18, Task-18-02 §7). Used ONLY for run-creation replay:
   * a repeated `CreateRunInput.commandId` returns the original run and its goal instead of
   * minting a second one, and a reused identity with different content conflicts. Omitted => a
   * caller-supplied `commandId` is refused (idempotency cannot be guaranteed), never
   * silently ignored.
   */
  readonly ledger?: CommandLedgerPort;
  /**
   * The run-goal writer (Sprint 18, Task-18-02). Called INSIDE the run-creation transaction,
   * so a run never exists without a goal it promised. Omitted => a caller-supplied goal is
   * refused (a goal must not silently vanish), and runs are still created without one.
   */
  readonly runGoal?: {
    attach(input: {
      readonly runId: string;
      readonly companyId: string;
      readonly goal: RunGoalInput;
      readonly actorId: string;
      readonly traceId: string;
    }): Promise<Result<{ readonly artifactId: string }, DomainError>>;
  };
  /**
   * Model Registry read seam (Sprint 18, Task-18-02 §21-§28): `RunSnapshot.modelBindings`
   * entries are resolved against the real registry BEFORE any write, so a run cannot pin an
   * unknown or disabled model. Structurally minimal — the concrete `ModelRegistryService`
   * satisfies it. Omitted => caller-supplied bindings are refused (never trusted unverified).
   */
  readonly modelRegistry?: RunModelBindingResolver;
}

/** Authorities the lifecycle service asks for (the Bible's per-transition preconditions). */
export const LIFECYCLE_AUTHORITIES = {
  createDraft: 'workflow.draft.create',
  editDraft: 'workflow.draft.edit',
  publish: 'workflow.publish',
  propose: 'workflow.propose',
  review: 'workflow.review',
  fork: 'workflow.fork',
  deprecate: 'workflow.deprecate',
  archive: 'workflow.archive',
  lock: 'workflow.lock',
  startRun: 'run.start',
} as const;

interface ActorInput {
  readonly actorId: string;
  readonly traceId?: string;
}

export interface CreateTemplateInput extends ActorInput {
  readonly orgId: string;
  readonly name: string;
  /**
   * Optional TRUSTED deterministic template identity (T20-05 permanent identity): the
   * permanent lineage identity of a compiled workflow. The PRIMARY KEY arbitrates
   * concurrent creation; the immutable seed (orgId/name) decides replay vs conflict.
   * Requires the guarded store seam; omitted ⇒ the id is minted as usual.
   */
  readonly templateId?: string;
}

export interface SaveDraftInput extends ActorInput {
  readonly templateId: string;
  readonly graph: WorkflowGraph;
}

export interface PublishInput extends ActorInput {
  readonly templateId: string;
  /** Defaults to the persisted draft graph. */
  readonly graph?: WorkflowGraph;
}

export interface OpenProposalInput extends ActorInput {
  readonly templateId: string;
  readonly rationale: string;
  readonly summary: string;
  readonly ops: readonly ChangeOp[];
}

export interface DecideProposalInput extends ActorInput {
  readonly proposalId: string;
  readonly decision: 'accept' | 'reject';
  readonly note?: string;
}

export interface OpenRevisionInput extends ActorInput {
  readonly templateId: string;
  readonly proposalId: string;
  readonly graph: WorkflowGraph;
}

export interface ForkInput extends ActorInput {
  readonly templateId: string;
  readonly name: string;
}

export interface DeprecateInput extends ActorInput {
  readonly templateId: string;
  readonly reason: string;
}

export interface LockInput extends ActorInput {
  readonly templateId: string;
  readonly scope: TemplateLock['scope'];
  readonly reason: string;
}

export interface UnlockInput extends ActorInput {
  readonly lockId: string;
}

export interface ArchiveInput extends ActorInput {
  readonly templateId: string;
}

/**
 * `RunSnapshot.packVersions` is TRUSTED DERIVED DATA (T15-05, ADR-0027): no caller field
 * exists for it. The application layer derives it from durable pack provenance through the
 * injected `packProvenance` resolver; a caller can never supply or override it.
 */
export interface CreateRunInput extends ActorInput {
  readonly templateId: string;
  readonly companyId: string;
  readonly workflowId: string;
  readonly modelBindings?: Readonly<Record<string, string>>;
  readonly memoryViewRef?: string;
  /**
   * Optional TRUSTED deterministic run identity (T20-05 permanent identity): the permanent
   * idempotency identity of an execution run derived from immutable semantic inputs. The
   * run row's PRIMARY KEY is the final arbiter for concurrent creation; the immutable
   * creation seed (companyId/workflowId/templateId/versionId) decides replay vs conflict,
   * and mutable lifecycle state is never reset. Requires the guarded store seam; omitted ⇒
   * the id is minted as usual.
   */
  readonly runId?: string;
  /**
   * Caller-supplied retry identity for run creation (Sprint 18, Task-18-02 §7). When present,
   * the SAME `commandId` replays the original run and its canonical goal, and the same
   * `commandId` with different content is a fingerprint CONFLICT — the frozen command-ledger
   * rules, not a bespoke mechanism. Requires the `ledger` dependency; identity alone never
   * participates in the authority decision.
   */
  readonly commandId?: string;
  /**
   * The canonical goal of this run (WHAT it wants to achieve). Optional so that legacy
   * compositions that have no goal to state still create runs; when supplied it is written
   * atomically with the run, is immutable afterwards, and is retrievable by
   * `RunGoalService.get`. Requires the `runGoal` writer dependency — a caller-supplied goal
   * with no writer fails closed rather than silently disappearing.
   */
  readonly goal?: RunGoalInput;
}

export interface CreatedRun {
  readonly run: WorkflowRun;
  readonly snapshot: RunSnapshot;
}

export interface WorkflowLifecycle {
  createTemplate(input: CreateTemplateInput): Promise<Result<WorkflowTemplate, DomainError>>;
  readTemplate(id: string): Promise<WorkflowTemplate | null>;
  saveDraftGraph(input: SaveDraftInput): Promise<Result<WorkflowTemplate, DomainError>>;
  publish(input: PublishInput): Promise<Result<WorkflowTemplate, DomainError>>;
  openProposal(input: OpenProposalInput): Promise<Result<ChangeProposal, DomainError>>;
  decideProposal(input: DecideProposalInput): Promise<Result<ChangeProposal, DomainError>>;
  openRevision(input: OpenRevisionInput): Promise<Result<WorkflowTemplate, DomainError>>;
  publishRevision(input: PublishInput): Promise<Result<WorkflowTemplate, DomainError>>;
  fork(input: ForkInput): Promise<Result<WorkflowTemplate, DomainError>>;
  deprecate(input: DeprecateInput): Promise<Result<WorkflowTemplate, DomainError>>;
  archive(input: ArchiveInput): Promise<Result<WorkflowTemplate, DomainError>>;
  lock(input: LockInput): Promise<Result<TemplateLock, DomainError>>;
  unlock(input: UnlockInput): Promise<Result<TemplateLock, DomainError>>;
  createRun(input: CreateRunInput): Promise<Result<CreatedRun, DomainError>>;
  readSnapshot(snapshotId: string): Promise<RunSnapshot | null>;
  eventsOf(aggregateType: string, aggregateId: string): Promise<readonly StoredEvent[]>;
}

/**
 * Events this service owns that the state machine does not declare.
 *
 * `TRANSITIONS[].emits` stays the single source for *state transitions*; opening and
 * deciding a proposal changes no template state, so those facts are declared here and
 * documented in `docs/WORKFLOW_LIFECYCLE.md` §2.
 */
export const GOVERNANCE_EVENT_TYPES = [
  'workflow.version.draft_updated',
  'workflow.change_proposal.opened',
  'workflow.change_proposal.accepted',
  'workflow.change_proposal.rejected',
] as const;

export function createWorkflowLifecycle(deps: WorkflowLifecycleDeps): WorkflowLifecycle {
  const nowIso = (): string => deps.clock.nowIso();
  const newTrace = (): string => deps.ids.id('trace');
  let warned = false;

  async function inTransaction<T>(work: () => Promise<T>): Promise<Result<T, DomainError>> {
    if (deps.unitOfWork !== undefined) return deps.unitOfWork.transaction(work);
    if (!warned) {
      warned = true;
      deps.logger?.warn('no UnitOfWork injected: lifecycle writes are not transactional');
    }
    try {
      return ok(await work());
    } catch (error) {
      if (error instanceof DomainError) return err(error);
      return err(
        domainError('PERSISTENCE_FAILED', error instanceof Error ? error.message : String(error), {}),
      );
    }
  }

  /** Build one lifecycle event through Core's `defineEvent` (single event shape). */
  const event = (
    type: string,
    aggregateId: string,
    actorId: string,
    traceId: string | undefined,
    payload: Readonly<Record<string, unknown>>,
    aggregateType = 'WorkflowTemplate',
  ): DomainEvent =>
    defineEvent(
      { type, aggregateId, aggregateType, traceId: traceId ?? newTrace(), actorId, payload },
      deps.ids,
      nowIso(),
    );

  /**
   * T15-04 corrective: a template a disabled pack materialized is history, not a live
   * capability. Read paths stay open; this guard is for NEW use only.
   */
  const denyDisabledPackTemplate = async (template: WorkflowTemplate): Promise<DomainError | null> => {
    if (deps.packAvailability === undefined) return null;
    const available = await deps.packAvailability.isMaterializedContentAvailable({
      companyId: template.orgId,
      contentKind: 'workflowTemplate',
      entityId: template.id,
    });
    if (!available.ok) return available.error;
    if (available.value) return null;
    return domainError(
      'POLICY_DENIED',
      `Template ${template.id} belongs to a disabled industry pack and cannot be used for new work.`,
      { reason: 'PACK_MATERIALIZED_CONTENT_UNAVAILABLE', templateId: template.id },
    );
  };

  const loadTemplate = async (templateId: string): Promise<WorkflowTemplate> => {
    const template = await deps.templates.get(templateId);
    if (template === null) {
      throw domainError('NOT_FOUND', `Template ${templateId} not found.`, { templateId });
    }
    return template;
  };

  /** Persist an aggregate mutation and append its events (inside the caller's tx). */
  const commit = async (template: WorkflowTemplate, events: readonly DomainEvent[]): Promise<void> => {
    await deps.templates.put(template);
    if (events.length > 0) await deps.events.append(events);
  };

  /** Active lock of a template, read through the port. */
  const activeLock = async (templateId: string): Promise<TemplateLock | null> => {
    const page = await deps.locks.list({ limit: 500 });
    return page.items.find((lock) => lock.templateId === templateId && lock.releasedAt === null) ?? null;
  };

  /** Core's lock policy: any active lock refuses a mutating operation. */
  const assertMutable = async (templateId: string, operation: string): Promise<void> => {
    const lock = await activeLock(templateId);
    const guard = assertMutableInCore(lock === null ? [] : [lock], templateId, operation);
    if (!guard.ok) throw guard.error;
  };

  /** Core's fork policy: only a `global` lock refuses a fork. */
  const assertForkableNow = async (templateId: string): Promise<void> => {
    const lock = await activeLock(templateId);
    const guard = assertForkable(lock === null ? [] : [lock], templateId);
    if (!guard.ok) throw guard.error;
  };

  /** Ask the injected policy (when any) for one authority; returns the denial, or null. */
  const authorityDenial = async (
    actorId: string,
    authority: string,
    templateId: string | null,
    traceId?: string,
  ): Promise<DomainError | null> => {
    if (deps.authorize === undefined) return null;
    try {
      const decision = await deps.authorize({
        actorId,
        authority,
        templateId,
        ...(traceId === undefined ? {} : { traceId }),
      });
      return decision.ok ? null : decision.error;
    } catch (error) {
      return error instanceof DomainError
        ? error
        : domainError('POLICY_DENIED', error instanceof Error ? error.message : String(error), {});
    }
  };

  const draftGraphOf = (template: WorkflowTemplate): WorkflowGraph | null => {
    const draft = draftVersion(template);
    return draft === null ? null : draft.graph;
  };

  const ctxOf = (input: ActorInput) => ({
    actorId: input.actorId,
    now: nowIso(),
    ids: deps.ids,
    traceId: input.traceId ?? newTrace(),
  });

  /**
   * Exclusive publish window (requirement 14). `fn` runs while this actor holds the
   * template's only active lock, so a competing publish cannot slip in; the partial
   * unique index is the referee even across processes.
   */
  async function withPublishLock<T>(
    template: WorkflowTemplate,
    input: ActorInput,
    fn: () => Promise<T>,
  ): Promise<T> {
    const version = currentVersion(template);
    if (version === null) {
      throw domainError('ILLEGAL_TRANSITION', `Template ${template.id} has no current version to publish from.`, {
        templateId: template.id,
      });
    }
    const created = createTemplateLock({
      templateId: template.id,
      versionId: version.id,
      scope: 'global',
      reason: 'publish_window',
      lockedBy: input.actorId,
      lockedAt: nowIso(),
      ids: deps.ids,
    });
    if (!created.ok) throw created.error;

    await deps.locks.put(created.value); // throws CONFLICT/lock_held if another lock is active
    const release = async (): Promise<void> => {
      const released = releaseTemplateLock(created.value, {
        releasedBy: input.actorId,
        releasedAt: nowIso(),
      });
      if (released.ok) await deps.locks.put(released.value);
    };
    try {
      const value = await fn();
      await release();
      return value;
    } catch (error) {
      await release(); // never wedge the template because a publish failed
      throw error;
    }
  }

  /**
   * The frozen command-ledger fingerprint of a run-creation command (T18-02 §7).
   *
   * Covers every semantic input of the command — template, company, workflow, the ALREADY
   * VALIDATED model bindings, a caller-pinned memory view and the canonical goal — so the
   * same identity replayed with different content is a `CONFLICT` instead of a silent second
   * run.
   */
  const runCreationFingerprint = (
    input: CreateRunInput,
    modelBindings: Readonly<Record<string, string>>,
  ): string =>
    sha256Hex(
      canonicalJson({
        purpose: 'run.create',
        templateId: input.templateId,
        companyId: input.companyId,
        workflowId: input.workflowId,
        modelBindings,
        memoryViewRef: input.memoryViewRef ?? null,
        goal: input.goal === undefined ? null : canonicalJson(input.goal),
      }),
    );

  /**
   * Replay an already-applied run-creation command (T18-02 §7).
   *
   * Returns the durable outcome on a matching replay, `null` when the command is new, and an
   * error when identity is unusable, the ledger is not wired or the recorded outcome no longer
   * resolves. Never regenerates anything.
   */
  const replayRunCreation = async (
    input: CreateRunInput,
    modelBindings: Readonly<Record<string, string>>,
  ): Promise<Result<CreatedRun, DomainError> | null> => {
    if (input.commandId === undefined) return null;
    const commandId = input.commandId.trim();
    if (commandId === '') {
      return err(domainError('INVALID_ARGUMENT', 'A run creation commandId must be a non-empty identity.'));
    }
    if (deps.ledger === undefined) {
      return err(
        domainError('PERSISTENCE_FAILED', 'Run creation replay requires the durable command ledger, which is not wired; refusing to guess.', {
          reason: 'RUN_CREATE_LEDGER_UNAVAILABLE',
        }),
      );
    }
    const recorded = await deps.ledger.get(commandId);
    if (recorded === null) return null;
    if (recorded.fingerprint !== runCreationFingerprint(input, modelBindings)) {
      return err(
        domainError('CONFLICT', 'Run creation command reused with different content.', {
          reason: 'RUN_CREATE_FINGERPRINT_MISMATCH',
          commandId,
        }),
      );
    }
    const outcome = recorded.outcome;
    const replayedRunId = typeof outcome['runId'] === 'string' ? (outcome['runId'] as string) : null;
    if (replayedRunId === null) {
      return err(
        domainError('PERSISTENCE_FAILED', 'Run creation ledger outcome is unreadable.', {
          reason: 'RUN_CREATE_LEDGER_OUTCOME_CORRUPT',
          commandId,
        }),
      );
    }
    const run = await deps.runs.get(replayedRunId as never);
    if (run === null) {
      return err(
        domainError('PERSISTENCE_FAILED', 'Run creation ledger outcome points to a run that no longer exists.', {
          reason: 'RUN_CREATE_LEDGER_TARGET_MISSING',
          commandId,
          runId: replayedRunId,
        }),
      );
    }
    const snapshot = await deps.snapshots.get(run.snapshotId as never);
    if (snapshot === null) {
      return err(
        domainError('PERSISTENCE_FAILED', 'The replayed run pins a snapshot that no longer exists.', {
          reason: 'RUN_CREATE_LEDGER_SNAPSHOT_MISSING',
          commandId,
          runId: replayedRunId,
        }),
      );
    }
    return ok({ run, snapshot });
  };

  return {
    /* ------------------------------------------------------------ templates */
    async createTemplate(input: CreateTemplateInput): Promise<Result<WorkflowTemplate, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.createDraft, null, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        // T20-05 permanent identity: a TRUSTED deterministic template id is created through
        // the guarded seam — the PRIMARY KEY arbitrates concurrent creation, the immutable
        // seed (orgId/name) decides replay vs conflict, and the canonical row wins untouched.
        if (input.templateId !== undefined) {
          const guard = deps.templates.putGuarded;
          if (guard === undefined) {
            throw domainError('PERSISTENCE_FAILED', 'A deterministic template id was supplied but the guarded creation seam is not wired; refusing to mint an un-arbitrated lineage.', {
              reason: 'TEMPLATE_IDENTITY_GUARD_UNAVAILABLE',
              templateId: input.templateId,
            });
          }
          const seed = createWorkflowTemplate({
            orgId: input.orgId,
            name: input.name,
            actorId: input.actorId,
            now: nowIso(),
            ids: deps.ids,
            traceId: input.traceId ?? newTrace(),
            id: input.templateId,
          });
          const written = await guard(seed.template);
          if (!written.ok) throw written.error;
          if (written.value.replayed) {
            // Another caller already created this canonical lineage: return ITS row; a
            // duplicate "created" event would be a lie about what happened.
            const canonical = await deps.templates.get(input.templateId);
            if (canonical === null) {
              throw domainError('PERSISTENCE_FAILED', 'The canonical template row vanished during guarded replay.', {
                reason: 'TEMPLATE_IDENTITY_REPLAY_TARGET_MISSING',
                templateId: input.templateId,
              });
            }
            return canonical;
          }
          await deps.events.append(seed.events);
          return seed.template;
        }
        const mutation = createWorkflowTemplate({
          orgId: input.orgId,
          name: input.name,
          actorId: input.actorId,
          now: nowIso(),
          ids: deps.ids,
          traceId: input.traceId ?? newTrace(),
        });
        await commit(mutation.template, mutation.events);
        return mutation.template;
      });
    },

    async readTemplate(id: string): Promise<WorkflowTemplate | null> {
      return deps.templates.get(id);
    },

    /** Requirement A: a draft's working version is editable. Requirement B: nothing else is. */
    async saveDraftGraph(input: SaveDraftInput): Promise<Result<WorkflowTemplate, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.editDraft, input.templateId, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        const unavailable = await denyDisabledPackTemplate(template);
        if (unavailable !== null) throw unavailable;
        await assertMutable(template.id, 'save_draft');
        const guard = requireState(template, ['draft'], 'open_revision');
        if (!guard.ok) throw guard.error;

        const existingDraft = draftVersion(template);
        const at = nowIso();
        let versions: readonly WorkflowTemplate['versions'][number][];
        let draftId: string;
        if (existingDraft === null) {
          const minted = createWorkflowVersion({
            templateId: template.id,
            semver: '1.0.0-draft',
            graph: input.graph,
            createdBy: input.actorId,
            createdAt: at,
            ids: deps.ids,
          });
          versions = [...template.versions, minted];
          draftId = minted.id;
        } else {
          versions = template.versions.map((version) =>
            version.id === existingDraft.id
              ? {
                  ...version,
                  graph: input.graph,
                  contentHash: recomputeContentHash({ ...version, graph: input.graph }),
                }
              : version,
          );
          draftId = existingDraft.id;
        }

        const next: WorkflowTemplate = {
          ...template,
          versions,
          draftVersionId: draftId,
          updatedAt: at,
        };
        await commit(next, [
          event(
            existingDraft === null ? 'workflow.version.draft_created' : 'workflow.version.draft_updated',
            draftId,
            input.actorId,
            input.traceId,
            { templateId: next.id, draftVersionId: draftId, semver: '1.0.0-draft' },
            'WorkflowVersion',
          ),
        ]);
        return next;
      });
    },

    /** `draft --publish--> published`: mints the first immutable version. */
    async publish(input: PublishInput): Promise<Result<WorkflowTemplate, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.publish, input.templateId, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        const unavailable = await denyDisabledPackTemplate(template);
        if (unavailable !== null) throw unavailable;
        const graph = input.graph ?? draftGraphOf(template);
        if (graph === null) {
          throw domainError('VALIDATION_FAILED', 'Nothing to publish: no draft graph and no graph supplied.', {
            templateId: template.id,
          });
        }
        const mutation = publishInitialVersion(template, { graph, ctx: ctxOf(input) });
        if (!mutation.ok) throw mutation.error;
        // The open draft is superseded by the release: drop the row instead of keeping a
        // draft that nothing points at (only drafts may ever disappear).
        const supersededDraftId = template.draftVersionId;
        const next: WorkflowTemplate = {
          ...mutation.value.template,
          versions: mutation.value.template.versions.filter((version) => version.id !== supersededDraftId),
        };
        await commit(next, mutation.value.events);
        return next;
      });
    },

    /* ------------------------------------------------------------ proposals */
    async openProposal(input: OpenProposalInput): Promise<Result<ChangeProposal, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.propose, input.templateId, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        const guard = requireState(template, ['published'], 'open_revision');
        if (!guard.ok) throw guard.error;
        if (template.currentVersionId === null) {
          throw domainError('ILLEGAL_TRANSITION', 'A proposal must target a published version.', {
            templateId: template.id,
          });
        }
        const proposal = openChangeProposal({
          targetTemplateId: template.id,
          baseVersionId: template.currentVersionId,
          subject: { summary: input.summary, ops: input.ops },
          rationale: input.rationale,
          authorId: input.actorId,
          calledAt: nowIso(),
          ids: deps.ids,
        });
        if (!proposal.ok) throw proposal.error;
        await deps.proposals.put(proposal.value);
        await deps.events.append([
          event('workflow.change_proposal.opened', template.id, input.actorId, input.traceId, {
            proposalId: proposal.value.id,
            baseVersionId: proposal.value.baseVersionId,
            ops: proposal.value.ops.length,
          }),
        ]);
        return proposal.value;
      });
    },

    /** Requirement K: a rejected proposal can never open a revision. */
    async decideProposal(input: DecideProposalInput): Promise<Result<ChangeProposal, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.review, null, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const proposal = await deps.proposals.get(input.proposalId);
        if (proposal === null) {
          throw domainError('NOT_FOUND', `Proposal ${input.proposalId} not found.`, {
            proposalId: input.proposalId,
          });
        }
        const decision = {
          decidedBy: input.actorId,
          decidedAt: nowIso(),
          ...(input.note === undefined ? {} : { note: input.note }),
        };
        const decided =
          input.decision === 'accept'
            ? acceptChangeProposal(proposal, decision)
            : rejectChangeProposal(proposal, decision);
        if (!decided.ok) throw decided.error;
        await deps.proposals.put(decided.value);
        await deps.events.append([
          event(
            decided.value.status === 'accepted'
              ? 'workflow.change_proposal.accepted'
              : 'workflow.change_proposal.rejected',
            decided.value.targetTemplateId,
            input.actorId,
            input.traceId,
            { proposalId: decided.value.id, status: decided.value.status, baseVersionId: decided.value.baseVersionId },
          ),
        ]);
        return decided.value;
      });
    },

    /* ------------------------------------------------------------- revisions */
    async openRevision(input: OpenRevisionInput): Promise<Result<WorkflowTemplate, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.editDraft, input.templateId, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        await assertMutable(template.id, 'open_revision');
        const proposal = await deps.proposals.get(input.proposalId);
        if (proposal === null) {
          throw domainError('NOT_FOUND', `Proposal ${input.proposalId} not found.`, {
            proposalId: input.proposalId,
          });
        }
        const mutation = openRevisionInCore(template, {
          proposal,
          graph: input.graph,
          ctx: ctxOf(input),
        });
        if (!mutation.ok) throw mutation.error;
        await commit(mutation.value.template, mutation.value.events);
        return mutation.value.template;
      });
    },

    async publishRevision(input: PublishInput): Promise<Result<WorkflowTemplate, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.publish, input.templateId, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        const unavailable = await denyDisabledPackTemplate(template);
        if (unavailable !== null) throw unavailable;
        await assertMutable(template.id, 'publish_revision');
        return withPublishLock(template, input, async () => {
          const mutation = publishRevisionInCore(template, ctxOf(input));
          if (!mutation.ok) throw mutation.error;
          await commit(mutation.value.template, mutation.value.events);
          return mutation.value.template;
        });
      });
    },

    /* ----------------------------------------------------------------- fork */
    async fork(input: ForkInput): Promise<Result<WorkflowTemplate, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.fork, input.templateId, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        const unavailable = await denyDisabledPackTemplate(template);
        if (unavailable !== null) throw unavailable;
        await assertForkableNow(template.id);
        const outcome = forkTemplate(template, { name: input.name, ctx: ctxOf(input) });
        if (!outcome.ok) throw outcome.error;
        // The source template is untouched: only the clone + the audit event are written.
        await deps.templates.put(outcome.value.template);
        await deps.events.append(outcome.value.events);
        return outcome.value.template;
      });
    },

    /* ------------------------------------------------------- retire / archive */
    async deprecate(input: DeprecateInput): Promise<Result<WorkflowTemplate, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.deprecate, input.templateId, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        const mutation = deprecateTemplate(template, { reason: input.reason, ctx: ctxOf(input) });
        if (!mutation.ok) throw mutation.error;
        await commit(mutation.value.template, mutation.value.events);
        return mutation.value.template;
      });
    },

    /** Requirement 13: archived is terminal and read-only, and never deleted. */
    async archive(input: ArchiveInput): Promise<Result<WorkflowTemplate, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.archive, input.templateId, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        // The machine's archive guard is exactly "no ACTIVE run-scoped lock": a global
        // publish window does not block archiving by itself.
        const lock = await activeLock(template.id);
        if (lock !== null && lock.scope === 'run') {
          throw domainError('LOCKED_TEMPLATE', `Template ${template.id} is locked by a run; archive is refused.`, {
            templateId: template.id,
            lockId: lock.id,
            scope: lock.scope,
          });
        }
        const mutation = archiveTemplate(template, ctxOf(input));
        if (!mutation.ok) throw mutation.error;
        await commit(mutation.value.template, mutation.value.events);
        return mutation.value.template;
      });
    },

    /* ----------------------------------------------------------------- locks */
    async lock(input: LockInput): Promise<Result<TemplateLock, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.lock, input.templateId, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        const versionId = template.currentVersionId ?? template.draftVersionId;
        if (versionId === null) {
          throw domainError('VALIDATION_FAILED', 'A lock must pin a version, but the template has none.', {
            templateId: template.id,
          });
        }
        const created = createTemplateLock({
          templateId: template.id,
          versionId,
          scope: input.scope,
          reason: input.reason,
          lockedBy: input.actorId,
          lockedAt: nowIso(),
          ids: deps.ids,
        });
        if (!created.ok) throw created.error;
        await deps.locks.put(created.value);
        await deps.events.append([
          event('workflow.template.locked', template.id, input.actorId, input.traceId, {
            lockId: created.value.id,
            versionId,
            scope: input.scope,
          }),
        ]);
        return created.value;
      });
    },

    async unlock(input: UnlockInput): Promise<Result<TemplateLock, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.lock, null, input.traceId);
      if (denied !== null) return err(denied);
      return inTransaction(async () => {
        const lock = await deps.locks.get(input.lockId);
        if (lock === null) {
          throw domainError('NOT_FOUND', `Lock ${input.lockId} not found.`, { lockId: input.lockId });
        }
        const released = releaseTemplateLock(lock, { releasedBy: input.actorId, releasedAt: nowIso() });
        if (!released.ok) throw released.error;
        await deps.locks.put(released.value);
        await deps.events.append([
          event('workflow.template.unlocked', lock.templateId, input.actorId, input.traceId, {
            lockId: lock.id,
          }),
        ]);
        return released.value;
      });
    },

    /* -------------------------------------------------------------- run bind */
    /** Requirements 10–13: pin a published version; refuse draft/retired templates. */
    async createRun(input: CreateRunInput): Promise<Result<CreatedRun, DomainError>> {
      const denied = await authorityDenial(input.actorId, LIFECYCLE_AUTHORITIES.startRun, input.templateId, input.traceId);
      if (denied !== null) return err(denied);

      // T18-02 §21–§28: run-pinned model bindings are TRUSTED APPLICATION CONFIGURATION, so
      // they are proven against the real registry before any write — an unknown or disabled
      // model must leave no run, no snapshot and nothing to roll back. A caller cannot
      // downgrade the check by omitting the registry: bindings are then refused outright.
      let modelBindings: Readonly<Record<string, string>> = {};
      // An empty map declares no binding, so there is nothing to prove and no registry seam to
      // require. A NON-empty map is trusted application configuration and must be verified.
      if (input.modelBindings !== undefined && Object.keys(input.modelBindings).length > 0) {
        if (deps.modelRegistry === undefined) {
          return err(
            domainError('PERSISTENCE_FAILED', 'Run model bindings were supplied but no model registry is wired; refusing to pin unverified bindings.', {
              reason: 'RUN_BINDING_REGISTRY_UNAVAILABLE',
            }),
          );
        }
        const validated = await validateRunModelBindings(input.modelBindings, deps.modelRegistry);
        if (!validated.ok) return err(validated.error);
        modelBindings = validated.value;
      }

      // T18-02 §7: a repeated run-creation command replays the ORIGINAL run and its goal.
      // Identity alone never grants anything: the authority decision above already ran, and
      // the fingerprint comparison below decides replay vs conflict.
      const replay = await replayRunCreation(input, modelBindings);
      if (replay !== null) return replay;

      // T20-05 permanent identity: a TRUSTED deterministic run id needs the guarded creation
      // seam (plain insert + PRIMARY-KEY arbitration). Fail closed BEFORE any write.
      if (input.runId !== undefined && deps.runs.putGuarded === undefined) {
        return err(
          domainError('PERSISTENCE_FAILED', 'A deterministic run id was supplied but the guarded creation seam is not wired; refusing to mint an un-arbitrated run.', {
            reason: 'RUN_IDENTITY_GUARD_UNAVAILABLE',
            runId: input.runId,
          }),
        );
      }

      /**
       * The normalized creation identity and its fingerprint. The actor is deliberately NOT
       * part of the fingerprint (idempotency is about WHAT was asked for, not WHO retried it);
       * the memory view is included only when the caller pinned one, because the default is
       * derived from the run id that does not exist yet.
       */
      const creation: { readonly commandId: string; readonly fingerprint: string } | null =
        input.commandId === undefined
          ? null
          : {
              commandId: input.commandId.trim(),
              fingerprint: runCreationFingerprint(input, modelBindings),
            };

      // T15-05: pack provenance is derived BEFORE the write phase, so a dependency failure
      // leaves no run, no snapshot and nothing to roll back. The caller never supplies it.
      let packVersions: Readonly<Record<string, string>> = {};
      if (deps.packProvenance !== undefined) {
        const resolved = await deps.packProvenance.resolveForWorkflow({
          companyId: input.companyId,
          templateId: input.templateId,
        });
        if (!resolved.ok) return err(resolved.error);
        packVersions = resolved.value;
      }
      const created = await inTransaction(async () => {
        const template = await loadTemplate(input.templateId);
        // New work must not start from a disabled pack's capability (T15-04 corrective).
        const unavailable = await denyDisabledPackTemplate(template);
        if (unavailable !== null) throw unavailable;
        // Explicit, self-explaining refusal (Sprint 4 review NIT-1: `requireState` with
        // an unrelated event name produced a misleading "lock" message).
        if (template.state !== 'published') {
          const code =
            template.state === 'archived'
              ? 'ARCHIVED_READONLY'
              : template.state === 'deprecated'
                ? 'DEPRECATED_TEMPLATE'
                : 'ILLEGAL_TRANSITION';
          throw domainError(code, `Template ${template.id} is "${template.state}"; starting a run requires "published".`, {
            templateId: template.id,
            state: template.state,
          });
        }
        if (!isRunnable(template)) {
          throw domainError('ILLEGAL_TRANSITION', 'Only a published template with a current version can start a run.', {
            templateId: template.id,
            state: template.state,
          });
        }
        const version = currentVersion(template);
        if (version === null) {
          throw domainError('ILLEGAL_TRANSITION', 'Template has no current version.', {
            templateId: template.id,
          });
        }

        // T20-05 permanent identity: the SAME deterministic run id replays the canonical
        // row when its immutable creation seed matches (companyId/workflowId/templateId/
        // versionId); any seed drift fails closed. Mutable lifecycle state is never reset —
        // the stored row wins untouched. This check is the friendly path; the guarded
        // insert below is the PRIMARY-KEY-arbitrated final arbiter for true races.
        if (input.runId !== undefined) {
          const canonical = await deps.runs.get(input.runId as never);
          if (canonical !== null) {
            const seedMatch =
              String(canonical.companyId) === String(input.companyId) &&
              String(canonical.workflowId) === String(input.workflowId) &&
              String(canonical.templateId) === String(template.id) &&
              String(canonical.versionId) === String(version.id);
            if (!seedMatch) {
              throw domainError('CONFLICT', `Run "${input.runId}" already exists with a different immutable creation seed.`, {
                reason: 'RUN_IDENTITY_SEED_CONFLICT',
                runId: input.runId,
              });
            }
            const replayedSnapshot = await deps.snapshots.get(canonical.snapshotId as never);
            if (replayedSnapshot === null) {
              throw domainError('PERSISTENCE_FAILED', 'The replayed run pins a snapshot that no longer exists.', {
                reason: 'RUN_IDENTITY_SNAPSHOT_MISSING',
                runId: input.runId,
              });
            }
            return { run: canonical, snapshot: replayedSnapshot };
          }
        }

        // Transient pin lock: it makes the snapshot legitimate (Core requires an ACTIVE
        // lock on the pinned version) and is released again, so a pin is not a mutex.
        const lockCreated = createTemplateLock({
          templateId: template.id,
          versionId: version.id,
          scope: 'run',
          reason: `run_start:${version.semver}`,
          lockedBy: input.actorId,
          lockedAt: nowIso(),
          ids: deps.ids,
        });
        if (!lockCreated.ok) throw lockCreated.error;
        await deps.locks.put(lockCreated.value);

        const run = createWorkflowRun({
          ...(input.runId === undefined ? {} : { id: asId<'WorkflowRunId'>(input.runId) }),
          companyId: asId<'CompanyId'>(input.companyId),
          workflowId: asId<'WorkflowId'>(input.workflowId),
          templateId: asId<'WorkflowTemplateId'>(template.id),
          versionId: asId<'WorkflowVersionId'>(version.id),
          snapshotId: asId<'RunSnapshotId'>(deps.ids.id('snp')),
          startedBy: input.actorId,
          now: nowIso(),
          ids: deps.ids,
        });
        if (!run.ok) throw run.error;

        const snapshot = createRunSnapshot({
          runId: run.value.id,
          orgId: template.orgId,
          version,
          lock: lockCreated.value,
          packVersions,
          modelBindings,
          memoryViewRef: input.memoryViewRef ?? `memory:${run.value.id}`,
          createdBy: input.actorId,
          createdAt: nowIso(),
          ids: deps.ids,
        });
        if (!snapshot.ok) throw snapshot.error;

        const boundRun: WorkflowRun = {
          ...run.value,
          snapshotId: asId<'RunSnapshotId'>(snapshot.value.snapshotId),
        };
        await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.runGoalBeforeCommit);
        if (input.runId === undefined) {
          await deps.runs.put(boundRun);
        } else {
          // PRIMARY-KEY-arbitrated final write: a concurrent twin that committed the same
          // deterministic id first turns this into a replay of ITS canonical row (same
          // seed); a seed drift fails closed. Neither caller can end up with two rows.
          const written = await deps.runs.putGuarded!(boundRun);
          if (!written.ok) throw written.error;
          if (written.value.replayed) {
            const canonical = await deps.runs.get(input.runId as never);
            if (canonical === null) {
              throw domainError('PERSISTENCE_FAILED', 'The canonical run row vanished during guarded replay.', {
                reason: 'RUN_IDENTITY_REPLAY_TARGET_MISSING',
                runId: input.runId,
              });
            }
            const replayedSnapshot = await deps.snapshots.get(canonical.snapshotId as never);
            if (replayedSnapshot === null) {
              throw domainError('PERSISTENCE_FAILED', 'The replayed run pins a snapshot that no longer exists.', {
                reason: 'RUN_IDENTITY_SNAPSHOT_MISSING',
                runId: input.runId,
              });
            }
            // Our transient pin lock must not survive as a leftover ACTIVE row.
            const unlocked = releaseTemplateLock(lockCreated.value, {
              releasedBy: input.actorId,
              releasedAt: nowIso(),
            });
            if (unlocked.ok) await deps.locks.put(unlocked.value);
            return { run: canonical, snapshot: replayedSnapshot };
          }
        }
        await deps.snapshots.put(snapshot.value);

        // T18-02 §5–§10: the canonical goal is written INSIDE the run-creation transaction,
        // so a run never exists without a goal it promised, and a failed goal write takes the
        // whole run down with it. The writer derives the artifact identity from the run id,
        // which makes a second goal for this run a fingerprint CONFLICT (artifact primitive),
        // not a bespoke rule.
        if (input.goal !== undefined) {
          if (deps.runGoal === undefined) {
            throw domainError('PERSISTENCE_FAILED', 'A run goal was supplied but no run-goal writer is wired; refusing to create a run whose goal would be lost.', {
              reason: 'RUN_GOAL_WRITER_UNAVAILABLE',
            });
          }
          const attached = await deps.runGoal.attach({
            runId: boundRun.id,
            companyId: input.companyId,
            goal: input.goal,
            actorId: input.actorId,
            traceId: input.traceId ?? deps.ids.id('trace'),
          });
          if (!attached.ok) throw attached.error;
          // Task-18-08: a crash INSIDE the transaction after the goal attach must roll the
          // goal back WITH the run — neither may survive alone.
          await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.runGoalDuringTransaction);
        }

        // T18-02 §7: record the creation identity INSIDE the same transaction, so a replay
        // can only ever return a run that actually committed.
        if (creation !== null && deps.ledger !== undefined) {
          await deps.ledger.put({
            commandId: creation.commandId,
            fingerprint: creation.fingerprint,
            runId: boundRun.id,
            outcome: { runId: boundRun.id, snapshotId: boundRun.snapshotId },
            recordedAt: nowIso(),
          });
        }

        const released = releaseTemplateLock(lockCreated.value, {
          releasedBy: input.actorId,
          releasedAt: nowIso(),
        });
        if (released.ok) await deps.locks.put(released.value);

        return { run: boundRun, snapshot: snapshot.value };
      });
      // Task-18-08: the commit is durable NOW — a crash after this point must leave BOTH the
      // run and its goal intact, and a replay must return the same run.
      await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.runGoalAfterCommit);
      return created;
    },

    async readSnapshot(snapshotId: string): Promise<RunSnapshot | null> {
      return deps.snapshots.get(snapshotId);
    },

    async eventsOf(aggregateType: string, aggregateId: string): Promise<readonly StoredEvent[]> {
      return deps.events.readByAggregate(aggregateType, aggregateId);
    },
  };
}

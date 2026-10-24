/**
 * WorkflowTemplate — the lifecycle aggregate (Draft/Publish/Version/Fork/
 * Deprecate/Archive). Every command returns a new immutable snapshot plus the
 * domain events to publish, so the aggregate stays pure and unit-testable.
 */
import type { DomainEvent } from '../kernel/events.js';
import type { IdFactory } from '../ports/id-factory.js';
import type { ChangeProposal } from './change-proposal.js';
import type { WorkflowGraph, WorkflowVersion } from './version.js';

import { LifecycleError } from '../kernel/errors.js';
import { defineEvent } from '../kernel/events.js';
import { err, ok, type Result } from '../kernel/result.js';
import { requireAcceptedProposal } from './change-proposal.js';
import { allowedEvents, requireState, type LifecycleEvent, type LifecycleState } from './machine.js';
import {
  createWorkflowVersion,
  draftSemverFor,
  INITIAL_SEMVER,
  isRunnableGraph,
  recomputeContentHash,
  releaseSemver,
} from './version.js';

export interface ForkOrigin {
  readonly templateId: string;
  readonly versionId: string;
  readonly semver: string;
  readonly forkedAt: string;
  readonly forkedBy: string;
}

export interface WorkflowTemplate {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly state: LifecycleState;
  readonly currentVersionId: string | null;
  readonly draftVersionId: string | null;
  readonly versions: readonly WorkflowVersion[];
  readonly forkedFrom: ForkOrigin | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
}

export interface CommandContext {
  readonly actorId: string;
  readonly now: string;
  readonly ids: IdFactory;
  readonly traceId: string;
}

export interface TemplateMutation {
  readonly template: WorkflowTemplate;
  readonly events: readonly DomainEvent[];
  readonly version: WorkflowVersion | null;
}

/* ------------------------------------------------------------------ queries */

export const findVersion = (
  template: WorkflowTemplate,
  versionId: string | null,
): WorkflowVersion | null =>
  versionId === null ? null : (template.versions.find((v) => v.id === versionId) ?? null);

export const currentVersion = (template: WorkflowTemplate): WorkflowVersion | null =>
  findVersion(template, template.currentVersionId);

export const draftVersion = (template: WorkflowTemplate): WorkflowVersion | null =>
  findVersion(template, template.draftVersionId);

/** Versions that production runs may pin to (drafts are excluded). */
export const releasedVersions = (template: WorkflowTemplate): readonly WorkflowVersion[] =>
  template.versions.filter((v) => !v.semver.includes('-draft'));

/** Run start is refused for draft/deprecated/archived templates. */
export const isRunnable = (template: WorkflowTemplate): boolean =>
  template.state === 'published' && template.currentVersionId !== null;

const illegal = (
  template: WorkflowTemplate,
  event: LifecycleEvent,
  message: string,
  details: Record<string, unknown> = {},
): Result<never, LifecycleError> =>
  err(
    new LifecycleError('ILLEGAL_TRANSITION', message, {
      templateId: template.id,
      state: template.state,
      event,
      allowed: allowedEvents(template.state),
      ...details,
    }),
  );

/* --------------------------------------------------------------- lifecycle */

export interface CreateTemplateInput {
  readonly orgId: string;
  readonly name: string;
  readonly actorId: string;
  readonly now: string;
  readonly ids: IdFactory;
  readonly traceId: string;
  /**
   * Optional TRUSTED deterministic template identity (permanent lineage identity for
   * trusted pipelines, e.g. plan compilation). When omitted the id is minted as usual.
   * The PRIMARY KEY of the template row is the final arbiter for same-id races.
   */
  readonly id?: string;
}

export function createWorkflowTemplate(input: CreateTemplateInput): TemplateMutation {
  const template: WorkflowTemplate = {
    id: input.id ?? input.ids.id('tpl'),
    orgId: input.orgId,
    name: input.name,
    state: 'draft',
    currentVersionId: null,
    draftVersionId: null,
    versions: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    createdBy: input.actorId,
  };
  return {
    template,
    version: null,
    events: [
      defineEvent(
        {
          type: 'workflow.template.created',
          aggregateId: template.id,
          aggregateType: 'WorkflowTemplate',
          traceId: input.traceId,
          actorId: input.actorId,
          payload: { orgId: input.orgId, name: input.name },
        },
        input.ids,
        input.now,
      ),
    ],
  };
}

export interface PublishInput {
  readonly graph: WorkflowGraph;
  readonly ctx: CommandContext;
}

/** `draft --publish--> published` — mints the first immutable version. */
export function publishInitialVersion(
  template: WorkflowTemplate,
  input: PublishInput,
): Result<TemplateMutation, LifecycleError> {
  const guard = requireState(template, ['draft'], 'publish');
  if (!guard.ok) return guard;
  if (template.currentVersionId !== null) {
    return illegal(template, 'publish', 'Template already owns a version; use publish_revision instead.');
  }
  if (!isRunnableGraph(input.graph)) {
    return err(
      new LifecycleError('VALIDATION_FAILED', 'Cannot publish an empty or structurally invalid graph.', {
        templateId: template.id,
      }),
    );
  }
  const version = createWorkflowVersion({
    templateId: template.id,
    semver: INITIAL_SEMVER,
    graph: input.graph,
    createdBy: input.ctx.actorId,
    createdAt: input.ctx.now,
    ids: input.ctx.ids,
  });
  const next: WorkflowTemplate = {
    ...template,
    state: 'published',
    currentVersionId: version.id,
    draftVersionId: null,
    versions: [...template.versions, version],
    updatedAt: input.ctx.now,
  };
  return ok({
    template: next,
    version,
    events: [
      defineEvent(
        {
          type: 'workflow.version.created',
          // Version facts are addressed by the VERSION id, so
          // `readByAggregate('WorkflowVersion', versionId)` finds them; the template id
          // travels in the payload (Sprint 4 review MEDIUM-2).
          aggregateId: version.id,
          aggregateType: 'WorkflowVersion',
          traceId: input.ctx.traceId,
          actorId: input.ctx.actorId,
          payload: { templateId: template.id, versionId: version.id, semver: version.semver, contentHash: version.contentHash },
        },
        input.ctx.ids,
        input.ctx.now,
      ),
      defineEvent(
        {
          type: 'workflow.template.published',
          aggregateId: template.id,
          aggregateType: 'WorkflowTemplate',
          traceId: input.ctx.traceId,
          actorId: input.ctx.actorId,
          payload: { versionId: version.id, semver: version.semver },
        },
        input.ctx.ids,
        input.ctx.now,
      ),
    ],
  });
}

export interface OpenRevisionInput {
  readonly proposal: ChangeProposal;
  readonly graph: WorkflowGraph;
  readonly ctx: CommandContext;
}

/** `published --open_revision--> published (+draft version)` — gated by an accepted proposal. */
export function openRevision(
  template: WorkflowTemplate,
  input: OpenRevisionInput,
): Result<TemplateMutation, LifecycleError> {
  const guard = requireState(template, ['published'], 'open_revision');
  if (!guard.ok) return guard;
  if (template.draftVersionId !== null) {
    return err(
      new LifecycleError('CONFLICT', 'A revision is already open; publish or discard it first.', {
        templateId: template.id,
        draftVersionId: template.draftVersionId,
      }),
    );
  }
  const accepted = requireAcceptedProposal(input.proposal, template.id, template.currentVersionId);
  if (!accepted.ok) return accepted;
  const base = currentVersion(template);
  if (base === null) {
    return illegal(template, 'open_revision', 'Template has no current version to revise.');
  }
  if (!isRunnableGraph(input.graph)) {
    return err(
      new LifecycleError('VALIDATION_FAILED', 'Cannot open a revision on an empty or invalid graph.', {
        templateId: template.id,
      }),
    );
  }
  const version = createWorkflowVersion({
    templateId: template.id,
    semver: draftSemverFor(base.semver),
    graph: input.graph,
    createdBy: input.ctx.actorId,
    createdAt: input.ctx.now,
    ids: input.ctx.ids,
    changeProposalId: input.proposal.id,
  });
  return ok({
    template: { ...template, draftVersionId: version.id, versions: [...template.versions, version], updatedAt: input.ctx.now },
    version,
    events: [
      defineEvent(
        {
          type: 'workflow.version.draft_created',
          aggregateId: version.id,
          aggregateType: 'WorkflowVersion',
          traceId: input.ctx.traceId,
          actorId: input.ctx.actorId,
          payload: {
            templateId: template.id,
            versionId: version.id,
            semver: version.semver,
            proposalId: input.proposal.id,
          },
        },
        input.ctx.ids,
        input.ctx.now,
      ),
      defineEvent(
        {
          type: 'workflow.template.revision_opened',
          aggregateId: template.id,
          aggregateType: 'WorkflowTemplate',
          traceId: input.ctx.traceId,
          actorId: input.ctx.actorId,
          payload: { baseVersionId: base.id, draftVersionId: version.id },
        },
        input.ctx.ids,
        input.ctx.now,
      ),
    ],
  });
}

/** `published (+draft) --publish_revision--> published (new current version)`. */
export function publishRevision(
  template: WorkflowTemplate,
  ctx: CommandContext,
): Result<TemplateMutation, LifecycleError> {
  const guard = requireState(template, ['published'], 'publish_revision');
  if (!guard.ok) return guard;
  const draft = draftVersion(template);
  if (draft === null) {
    return illegal(template, 'publish_revision', 'No draft version is open.');
  }
  // Sprint 4 correction: the content hash covers `{templateId, semver, graph}`, so
  // releasing a draft (`1.1.0-draft` → `1.1.0`) MUST re-hash it — otherwise the released
  // version fails `isVersionIntact` and the persisted fingerprint is wrong.
  const releasedDraft: WorkflowVersion = { ...draft, semver: releaseSemver(draft.semver) };
  const released: WorkflowVersion = {
    ...releasedDraft,
    contentHash: recomputeContentHash(releasedDraft),
  };
  const versions = template.versions.map((v) => (v.id === draft.id ? released : v));
  const next: WorkflowTemplate = {
    ...template,
    versions,
    currentVersionId: released.id,
    draftVersionId: null,
    updatedAt: ctx.now,
  };
  return ok({
    template: next,
    version: released,
    events: [
      defineEvent(
        {
          type: 'workflow.version.released',
          aggregateId: released.id,
          aggregateType: 'WorkflowVersion',
          traceId: ctx.traceId,
          actorId: ctx.actorId,
          payload: {
            templateId: template.id,
            versionId: released.id,
            semver: released.semver,
            contentHash: released.contentHash,
          },
        },
        ctx.ids,
        ctx.now,
      ),
      defineEvent(
        {
          type: 'workflow.template.published',
          aggregateId: template.id,
          aggregateType: 'WorkflowTemplate',
          traceId: ctx.traceId,
          actorId: ctx.actorId,
          payload: { versionId: released.id, semver: released.semver, revision: true },
        },
        ctx.ids,
        ctx.now,
      ),
    ],
  });
}

export interface ForkInput {
  readonly name: string;
  readonly ctx: CommandContext;
}

export interface ForkOutcome {
  readonly template: WorkflowTemplate;
  readonly origin: ForkOrigin;
  readonly events: readonly DomainEvent[];
}

/**
 * `fork` — clones the current version into a NEW template in `draft`.
 * The source template is NOT mutated (only an audit event is emitted).
 */
export function forkTemplate(
  template: WorkflowTemplate,
  input: ForkInput,
): Result<ForkOutcome, LifecycleError> {
  const guard = requireState(template, ['published', 'deprecated'], 'fork');
  if (!guard.ok) return guard;
  const source = currentVersion(template);
  if (source === null) return illegal(template, 'fork', 'Nothing to fork: no current version.');

  const forkedAt = input.ctx.now;
  const origin: ForkOrigin = {
    templateId: template.id,
    versionId: source.id,
    semver: source.semver,
    forkedAt,
    forkedBy: input.ctx.actorId,
  };
  const clone: WorkflowTemplate = {
    ...createWorkflowTemplate({
      orgId: template.orgId,
      name: input.name,
      actorId: input.ctx.actorId,
      now: forkedAt,
      ids: input.ctx.ids,
      traceId: input.ctx.traceId,
    }).template,
    forkedFrom: origin,
  };
  return ok({
    template: clone,
    origin,
    events: [
      defineEvent(
        {
          type: 'workflow.template.forked',
          aggregateId: clone.id,
          aggregateType: 'WorkflowTemplate',
          traceId: input.ctx.traceId,
          actorId: input.ctx.actorId,
          payload: {
            sourceTemplateId: origin.templateId,
            sourceVersionId: origin.versionId,
            sourceSemver: origin.semver,
          },
        },
        input.ctx.ids,
        forkedAt,
      ),
    ],
  });
}

/** `published --deprecate--> deprecated` (refuses new runs; snapshots continue). */
export function deprecateTemplate(
  template: WorkflowTemplate,
  input: { readonly reason: string; readonly ctx: CommandContext },
): Result<TemplateMutation, LifecycleError> {
  const guard = requireState(template, ['published'], 'deprecate');
  if (!guard.ok) return guard;
  if (input.reason.trim().length === 0) {
    return err(
      new LifecycleError('VALIDATION_FAILED', 'Deprecation requires a non-empty reason.', {
        templateId: template.id,
      }),
    );
  }
  const discardedDraftVersionId = template.draftVersionId;
  return ok({
    template: { ...template, state: 'deprecated', draftVersionId: null, updatedAt: input.ctx.now },
    version: null,
    events: [
      defineEvent(
        {
          type: 'workflow.template.deprecated',
          aggregateId: template.id,
          aggregateType: 'WorkflowTemplate',
          traceId: input.ctx.traceId,
          actorId: input.ctx.actorId,
          payload: { reason: input.reason, discardedDraftVersionId },
        },
        input.ctx.ids,
        input.ctx.now,
      ),
    ],
  });
}

/** `deprecated --archive--> archived` — terminal. */
export function archiveTemplate(
  template: WorkflowTemplate,
  ctx: CommandContext,
): Result<TemplateMutation, LifecycleError> {
  const guard = requireState(template, ['deprecated'], 'archive');
  if (!guard.ok) return guard;
  return ok({
    template: { ...template, state: 'archived', draftVersionId: null, updatedAt: ctx.now },
    version: null,
    events: [
      defineEvent(
        {
          type: 'workflow.template.archived',
          aggregateId: template.id,
          aggregateType: 'WorkflowTemplate',
          traceId: ctx.traceId,
          actorId: ctx.actorId,
          payload: { archivedVersionId: template.currentVersionId },
        },
        ctx.ids,
        ctx.now,
      ),
    ],
  });
}

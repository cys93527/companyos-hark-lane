/**
 * Versioned domain-event payload contracts.
 *
 * The event *type* strings here are the wire format for `DomainEvent.type`
 * emitted by Core. Consumers must tolerate unknown minor versions, so payload
 * schemas are additive-only within a major version.
 */
import { z } from 'zod';

export const EVENT_TYPES = [
  'workflow.template.created',
  'workflow.version.created',
  'workflow.template.published',
  'workflow.version.draft_created',
  'workflow.template.revision_opened',
  'workflow.version.released',
  'workflow.template.forked',
  'workflow.template.deprecated',
  'workflow.template.archived',
  'workflow.template.locked',
  'workflow.template.unlocked',
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const DomainEventEnvelopeSchema = z
  .object({
    eventId: z.string().min(1),
    type: EventTypeSchema,
    version: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    aggregateId: z.string().min(1),
    aggregateType: z.string().min(1),
    traceId: z.string().min(1),
    actorId: z.string().min(1),
    payload: z.record(z.unknown()),
  })
  .strict();

export type DomainEventEnvelope = z.infer<typeof DomainEventEnvelopeSchema>;

export const EVENT_PAYLOAD_SCHEMAS = {
  'workflow.template.created': z.object({ orgId: z.string(), name: z.string() }).strict(),
  'workflow.version.created': z
    .object({ versionId: z.string(), semver: z.string(), contentHash: z.string().length(64) })
    .strict(),
  'workflow.template.published': z
    .object({ versionId: z.string(), semver: z.string(), revision: z.boolean().optional() })
    .strict(),
  'workflow.version.draft_created': z
    .object({ versionId: z.string(), semver: z.string(), proposalId: z.string() })
    .strict(),
  'workflow.template.revision_opened': z
    .object({ baseVersionId: z.string(), draftVersionId: z.string() })
    .strict(),
  'workflow.version.released': z
    .object({ versionId: z.string(), semver: z.string(), contentHash: z.string().length(64) })
    .strict(),
  'workflow.template.forked': z
    .object({
      sourceTemplateId: z.string(),
      sourceVersionId: z.string(),
      sourceSemver: z.string(),
    })
    .strict(),
  'workflow.template.deprecated': z
    .object({ reason: z.string(), discardedDraftVersionId: z.string().nullable() })
    .strict(),
  'workflow.template.archived': z.object({ archivedVersionId: z.string().nullable() }).strict(),
  'workflow.template.locked': z.object({ lockId: z.string(), scope: z.enum(['run', 'global']) }).strict(),
  'workflow.template.unlocked': z.object({ lockId: z.string() }).strict(),
} as const satisfies Record<EventType, z.ZodTypeAny>;

export const validateEventPayload = (
  type: EventType,
  payload: unknown,
): { readonly ok: true } | { readonly ok: false; readonly error: string } => {
  const parsed = EVENT_PAYLOAD_SCHEMAS[type].safeParse(payload);
  return parsed.success ? { ok: true } : { ok: false, error: parsed.error.message };
};

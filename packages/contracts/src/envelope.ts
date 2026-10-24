/**
 * EventEnvelope — the persisted, replayable shape of every domain event
 * (planning-document §四十三 Event System, §四十四 Audit).
 *
 * `version` is the envelope/payload schema version: consumers must tolerate
 * unknown minor versions and must never be broken by an additive field.
 */
import { z } from 'zod';

import { correlationIdsSchema } from './correlation.js';

export const SCHEMA_VERSION = 1;

export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  /** e.g. `workflow.template.published`, `run.recovered`. */
  type: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  aggregateId: z.string().min(1),
  aggregateType: z.string().min(1),
  actorId: z.string().min(1),
  ...correlationIdsSchema.shape,
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Envelope of the Sprint 0 desktop shell — proves the log/event pipeline works. */
export const systemStartedPayloadSchema = z.object({
  appVersion: z.string().min(1),
  mode: z.enum(['development', 'production', 'test']),
  databasePath: z.string().min(1),
});

export type SystemStartedPayload = z.infer<typeof systemStartedPayloadSchema>;

/**
 * ArtifactService (Sprint 13B — Task-13-04; ADR-0015 decisions 15/D4/D13).
 *
 * Orchestrates the ONE durable artifact-creation path:
 *
 *   CreateArtifact command
 *     → validate + trusted command fingerprint (content digest participates — the
 *       caller can never supply the fingerprint or a content hash claim)
 *     → idempotency level 1: command ledger (fingerprint mismatch → CONFLICT before
 *       ANY side effect; match → recover artifactId → ArtifactStore is the SoT)
 *     → idempotency level 2: permanent row lookup (ledger trimmed → recover by
 *       creation_command_id, fingerprint-verified)
 *     → new command preconditions (run existence via the authoritative Run Store port)
 *     → CAS first (ArtifactContentStore.put — trusted contentRef/hash/sizeBytes)
 *     → domain creation via the frozen createArtifact factory (IdFactory/Clock)
 *     → ONE existing UnitOfWork: artifact row + artifact.created event + ledger outcome
 *       (all-or-nothing; a CAS orphan after a SQLite failure is the accepted safe mode)
 *     → concurrent duplicate: the UNIQUE(creation_command_id) index is the final
 *       defence — the losing request recovers the winner via getByCreationCommand and
 *       returns the SAME artifactId (same fingerprint) or CONFLICT (different).
 *
 * Policy lives HERE (replay vs CONFLICT); stores return durable facts only.
 */
import { createHash } from 'node:crypto';

import {
  canonicalJson,
  createArtifact,
  defineEvent,
  domainError,
  err,
  ok,
  sha256Hex,
  type Artifact,
  type ArtifactContentStore,
  type ArtifactStorePort,
  type Clock,
  type CommandLedgerPort,
  type DomainError,
  type EntityStore,
  type EventStorePort,
  type IdFactory,
  type Result,
  type UnitOfWork,
  type TaskId,
  type WorkflowRun,
} from '@companyos/core';

export interface CreateArtifactCommand {
  /** Business command identity (retry key). Caller-supplied; never regenerated. */
  readonly commandId: string;
  readonly runId: WorkflowRun['id'];
  /** Optional task anchor (null = produced by the stage as a whole). */
  readonly taskId?: TaskId | null;

  /** Pack-defined opaque kind (Core never interprets it). */
  readonly kind: string;
  /** The exact bytes to materialize; the digest is computed by the trusted side. */
  readonly content: Uint8Array;
  readonly producedBy: string;
  /**
   * The AUTHORIZATION PRINCIPAL of this creation, when it is not the producer: the trusted
   * actor the authorization seam should decide for. Provenance (`producedBy`) says WHO/WHAT
   * produced the artifact; this says who is allowed to perform the operation — a system
   * component producing on behalf of an authorized actor supplies both, and neither field is
   * ever derived from the other. Absent ⇒ the producer is the principal (the only form earlier
   * callers had, so their behavior cannot change).
   */
  readonly authorizedBy?: string;
  readonly traceId: string;
}

export interface ArtifactServiceDeps {
  readonly artifactStore: ArtifactStorePort;
  readonly contentStore: ArtifactContentStore;
  /** Authoritative run existence lookup (no direct SQLite). */
  readonly runs: EntityStore<WorkflowRun>;
  readonly events: EventStorePort;
  readonly ledger: CommandLedgerPort;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly unitOfWork: UnitOfWork;
  /**
   * `artifact.create` authority execution point (Sprint 13A contract §13.2).
   * INVARIANT (review corrective): authorization gates EVERY path of this capability —
   * new create, ledger replay AND permanent-row replay. It runs before the fingerprint
   * lookups and before any side effect; a DENY returns the authority error with zero
   * writes (no CAS, no row, no event, no ledger). It must NOT participate in the
   * command fingerprint (authorization = may-this-call-run; fingerprint = what-the-
   * command-is). Context (run/task) is provided so real auth policies can decide.
   */
  readonly authorize: (input: {
    readonly actorId: string;
    readonly authority: 'artifact.create';
    readonly runId: string;
    readonly taskId: string | null;
  }) => Promise<Result<true, DomainError>>;
}

export interface ArtifactService {
  /** Exactly one artifact per commandId — permanent, across retries and ledger trims. */
  create(command: CreateArtifactCommand): Promise<Result<Artifact, DomainError>>;
}

/** Trusted command fingerprint: every semantic input participates, including the exact content digest. */
export const artifactCommandFingerprint = (command: {
  readonly runId: string;
  readonly taskId: string | null;
  readonly kind: string;
  readonly producedBy: string;
  readonly contentDigest: string;
}): string =>
  sha256Hex(
    canonicalJson({
      purpose: 'artifact.create',
      runId: command.runId,
      taskId: command.taskId,
      kind: command.kind,
      producedBy: command.producedBy,
      contentDigest: command.contentDigest,
    }),
  );

const isLedgerCorrupt = (outcome: Readonly<Record<string, unknown>>): boolean =>
  typeof outcome.artifactId !== 'string' || !outcome.artifactId.startsWith('art_');

export function createArtifactService(deps: ArtifactServiceDeps): ArtifactService {
  /** Recover the durable artifact from the row-level permanent identity. */
  const permanentReplay = async (
    commandId: string,
    fingerprint: string,
  ): Promise<Result<Artifact, DomainError>> => {
    const lookup = await deps.artifactStore.getByCreationCommand(commandId);
    if (lookup === null) return err(domainError('NOT_FOUND', 'Permanent artifact lookup missed.', { commandId }));
    if (lookup.creationCommandFingerprint !== fingerprint) {
      return err(
        domainError('CONFLICT', 'Artifact creation command reused with different content.', {
          reason: 'ARTIFACT_COMMAND_FINGERPRINT_MISMATCH',
          commandId,
        }),
      );
    }
    return ok(lookup.artifact);
  };

  return {
    async create(command: CreateArtifactCommand): Promise<Result<Artifact, DomainError>> {
      // Command-shape validation (trusted side owns everything the caller must not supply).
      if (
        command.commandId.trim() === '' ||
        command.runId.trim() === '' ||
        command.kind.trim() === '' ||
        command.producedBy.trim() === '' ||
        command.traceId.trim() === ''
      ) {
        return err(domainError('INVALID_ARGUMENT', 'Artifact command identity, kind, producer and trace are required.'));
      }
      const principal = command.authorizedBy ?? command.producedBy;
      if (principal.trim() === '') {
        return err(
          domainError('INVALID_ARGUMENT', 'Artifact creation needs an authorization principal.'),
        );
      }
      const permit = await deps.authorize({
        actorId: principal,
        authority: 'artifact.create',
        runId: command.runId,
        taskId: command.taskId ?? null,
      });
      if (!permit.ok) return permit;

      // Trusted fingerprint BEFORE any side effect (review §7): same commandId with
      // different bytes must CONFLICT before writing a pointless CAS orphan.
      const contentDigest = createHash('sha256').update(command.content).digest('hex');
      const fingerprint = artifactCommandFingerprint({
        runId: command.runId,
        taskId: command.taskId ?? null,
        kind: command.kind,
        producedBy: command.producedBy,
        contentDigest,
      });

      // Idempotency level 1 — command ledger.
      const ledgerHit = await deps.ledger.get(command.commandId);
      if (ledgerHit !== null) {
        if (ledgerHit.fingerprint !== fingerprint) {
          return err(
            domainError('CONFLICT', 'Artifact creation command reused with different content.', {
              reason: 'ARTIFACT_COMMAND_FINGERPRINT_MISMATCH',
              commandId: command.commandId,
            }),
          );
        }
        // The ledger outcome is NOT the artifact SoT — recover the row from SQLite.
        if (isLedgerCorrupt(ledgerHit.outcome)) {
          return err(
            domainError('PERSISTENCE_FAILED', 'Artifact command ledger outcome is corrupt.', {
              reason: 'ARTIFACT_LEDGER_OUTCOME_CORRUPT',
              commandId: command.commandId,
            }),
          );
        }
        const artifactId = ledgerHit.outcome.artifactId as string;
        const durable = await deps.artifactStore.get(artifactId as Artifact['id']);
        if (durable === null) {
          return err(
            domainError('PERSISTENCE_FAILED', 'Ledger outcome points to a missing artifact.', {
              reason: 'ARTIFACT_LEDGER_TARGET_MISSING',
              commandId: command.commandId,
              artifactId,
            }),
          );
        }
        return ok(durable); // replay: no CAS put, no row, no event
      }

      // Idempotency level 2 — permanent row identity (ledger trimmed).
      const permanent = await permanentReplay(command.commandId, fingerprint);
      if (permanent.ok) return permanent;
      if (permanent.error.code !== 'NOT_FOUND') return permanent; // CONFLICT from row level

      // New-command preconditions (AFTER idempotency: a successful replay never re-fails
      // just because current state moved on — review §13).
      const run = await deps.runs.get(command.runId);
      if (run === null) {
        return err(domainError('NOT_FOUND', `Run "${command.runId}" not found.`, { details: { runId: command.runId } }));
      }

      // CAS first (review §14/§16): trusted contentRef/hash/sizeBytes come from the store.
      const stored = await deps.contentStore.put(command.content);
      const made = createArtifact({
        runId: command.runId as never,
        taskId: command.taskId ?? undefined,
        kind: command.kind,
        contentRef: stored.contentRef,
        contentHash: stored.contentHash,
        sizeBytes: stored.sizeBytes,
        producedBy: command.producedBy,
        now: deps.clock.nowIso(),
        ids: deps.ids,
      });
      if (!made.ok) return made; // CAS object may remain as an orphan — accepted safe mode.

      // ONE existing UnitOfWork: row + event + ledger outcome, all-or-nothing.
      const written = await deps.unitOfWork.transaction(async () => {
        await deps.artifactStore.create(made.value, {
          creationCommandId: command.commandId,
          creationCommandFingerprint: fingerprint,
        });
        await deps.events.append([
          defineEvent(
            {
              type: 'artifact.created',
              aggregateId: made.value.id,
              aggregateType: 'Artifact',
              traceId: command.traceId,
              actorId: command.producedBy,
              payload: {
                artifactId: made.value.id,
                runId: made.value.runId,
                taskId: made.value.taskId,
                kind: made.value.kind,
                contentHash: made.value.contentHash,
                sizeBytes: made.value.sizeBytes,
                producedBy: made.value.producedBy,
                traceId: command.traceId,
              },
            },
            deps.ids,
            deps.clock.nowIso(),
          ),
        ]);
        await deps.ledger.put({
          commandId: command.commandId,
          fingerprint,
          runId: command.runId,
          outcome: { artifactId: made.value.id, contentRef: stored.contentRef, contentHash: stored.contentHash },
          recordedAt: deps.clock.nowIso(),
        });
        return made.value;
      });
      if (written.ok) return written;

      // Concurrent duplicate: the UNIQUE(creation_command_id) index is the final defence.
      // A same-fingerprint loser must recover the winner's identity, not surface a raw
      // conflict; a different-fingerprint loser must CONFLICT (never replay the winner).
      const conflictReason = (written.error as DomainError & { details?: { reason?: string } }).details?.reason;
      if (
        written.error.code === 'CONFLICT' &&
        conflictReason === 'ARTIFACT_CREATION_COMMAND_EXISTS'
      ) {
        const recovered = await permanentReplay(command.commandId, fingerprint);
        if (recovered.ok) return recovered;
        return written;
      }
      // Store/event/ledger failure inside the transaction → all rolled back; the CAS
      // object may remain as an orphan (accepted safe mode, reconciled by Task-13-10).
      return written;
    },
  };
}

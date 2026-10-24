/**
 * Handoff service (Sprint 11) — orchestration only.
 *
 * It applies the Core state machine, persists versions, checks authorities and emits REDACTED audit
 * events. It never mutates the workflow, never starts an agent, never accepts on behalf of the
 * target role and never summarises with an LLM.
 */
import {
  acceptHandoffPacket,
  applyHandoffTransition,
  cancelHandoffPacket,
  createHandoffPacket,
  domainError,
  err,
  markHandoffReady,
  ok,
  rejectHandoffPacket,
  supersedeHandoff,
  type Clock,
  type CreateHandoffInput,
  type DomainError,
  DomainError as DomainErrorClass,
  type HandoffPacket,
  type HandoffRejectionReason,
  type HandoffStorePort,
  type Result,
} from '@companyos/core';

export type HandoffAuthority = 'handoff.create' | 'handoff.read' | 'handoff.accept' | 'handoff.reject';

/** The audit payload whitelist (Sprint 11 §十七): ids + counts only - never the summary body. */
export interface HandoffAuditPayload {
  readonly handoffId: string;
  readonly version: number;
  /** WHO acted (review MEDIUM): without this the audit cannot answer "who transferred/accepted". */
  readonly actorId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly fromRoleId: string;
  readonly toRoleId: string;
  readonly status: HandoffPacket['status'];
  readonly artifactCount: number;
  readonly decisionCount: number;
  readonly validationCount: number;
  readonly traceId: string;
}

export interface HandoffAuditEmitter {
  created(payload: HandoffAuditPayload): Promise<void>;
  ready(payload: HandoffAuditPayload): Promise<void>;
  accepted(payload: HandoffAuditPayload): Promise<void>;
  rejected(payload: HandoffAuditPayload): Promise<void>;
  superseded(payload: HandoffAuditPayload): Promise<void>;
  cancelled(payload: HandoffAuditPayload): Promise<void>;
}

export interface HandoffServiceDeps {
  readonly store: HandoffStorePort;
  readonly audit: HandoffAuditEmitter;
  readonly clock: Clock;
  readonly authorize: (input: {
    readonly actorId: string;
    readonly authority: HandoffAuthority;
    readonly handoffId: string;
  }) => Promise<Result<true, DomainError>>;
  /**
   * TRUSTED role derivation (review MEDIUM): the actor's roles come from the authorization service,
   * NEVER from the caller. A client-supplied role list must be impossible to reach this layer.
   */
  readonly actorRoleIds: (actorId: string) => Promise<readonly string[]>;
  /**
   * Sprint 13 (Task-13-09, ADR-0017): optional durable reference resolver for
   * kind='artifact' / kind='validation' refs. Present ⇒ every such ref must resolve to
   * a durable row before the handoff persists (resolve-all-before-write). Absent ⇒
   * legacy format-only behavior preserved (Sprint 11 contract), but a MANAGED envelope
   * (artifact:art_<id> / canonical ValidationId) then fails closed rather than
   * persisting a dangling reference.
   */
  readonly durableReferenceResolver?: (refs: readonly string[]) => Promise<
    Result<
      readonly { readonly kind: string; readonly id: string; readonly ref: string }[],
      DomainError
    >
  >;
}

export interface HandoffService {
  /** `createdAt` is supplied by the service clock, never by the caller. */
  createDraft(
    input: Omit<CreateHandoffInput, 'createdAt'> & { readonly actorId: string },
  ): Promise<Result<HandoffPacket, DomainError>>;
  ready(input: {
    readonly handoffId: string;
    readonly version: number;
    readonly actorId: string;
    readonly requiresEvidence?: boolean;
  }): Promise<Result<HandoffPacket, DomainError>>;
  accept(input: {
    readonly handoffId: string;
    readonly version: number;
    readonly actorId: string;
  }): Promise<Result<HandoffPacket, DomainError>>;
  reject(input: {
    readonly handoffId: string;
    readonly version: number;
    readonly actorId: string;
    readonly reasonCodes: readonly HandoffRejectionReason[];
    readonly comment?: string | null;
  }): Promise<Result<HandoffPacket, DomainError>>;
  cancel(input: { readonly handoffId: string; readonly version: number; readonly actorId: string }): Promise<Result<HandoffPacket, DomainError>>;
  supersede(input: {
    readonly handoffId: string;
    readonly previousVersion: number;
    readonly actorId: string;
    readonly next: Omit<CreateHandoffInput, 'handoffId' | 'createdAt'>;
  }): Promise<Result<{ readonly previous: HandoffPacket; readonly next: HandoffPacket }, DomainError>>;
  get(handoffId: string, version: number | null, actorId: string): Promise<Result<HandoffPacket, DomainError>>;
  versions(handoffId: string, actorId: string): Promise<Result<readonly HandoffPacket[], DomainError>>;
  listForTargetRole(toRoleId: string, limit: number, actorId: string): Promise<Result<readonly HandoffPacket[], DomainError>>;
}

const payloadOf = (packet: HandoffPacket, actorId: string): HandoffAuditPayload => ({
  handoffId: packet.handoffId,
  version: packet.handoffVersion,
  actorId,
  taskId: packet.taskId,
  runId: packet.workflowRunId,
  fromRoleId: packet.fromRoleId,
  toRoleId: packet.toRoleId,
  status: packet.status,
  artifactCount: packet.artifactRefs.length,
  decisionCount: packet.decisionRefs.length,
  validationCount: packet.validationRefs.length,
  traceId: packet.traceId,
});

export function createHandoffService(deps: HandoffServiceDeps): HandoffService {
  const permit = async (
    actorId: string,
    authority: HandoffAuthority,
    handoffId: string,
  ): Promise<Result<true, DomainError>> => deps.authorize({ actorId, authority, handoffId });

  const load = async (handoffId: string, version: number): Promise<Result<HandoffPacket, DomainError>> => {
    const packet = await deps.store.get(handoffId, version);
    if (packet === null) {
      return err(domainError('NOT_FOUND', `No handoff "${handoffId}" at version ${String(version)}.`, { handoffId, version }));
    }
    return ok(packet);
  };

  return {
    async createDraft(input): Promise<Result<HandoffPacket, DomainError>> {
      const permitted = await permit(input.actorId, 'handoff.create', input.handoffId);
      if (!permitted.ok) return permitted;
      const created = createHandoffPacket({ ...input, createdAt: deps.clock.nowIso() });
      if (!created.ok) return created;
      // Sprint 13 (Task-13-09, ADR-0017): durable identity verification for
      // kind='artifact' / kind='validation' refs — resolve-all-before-write. A managed
      // envelope must resolve to a durable row; a missing resolver with managed refs
      // present fails closed (no dangling handoff references, no partial versions).
      const managedRefs = [
        ...created.value.artifactRefs.map((r) => r.refId).filter((id) => id.startsWith('art_')),
        ...created.value.validationRefs.map((r) => r.refId).filter((id) => id.startsWith('val_')),
      ].map((id) => (id.startsWith('val_') ? id : `artifact:${id}`));
      if (managedRefs.length > 0) {
        if (deps.durableReferenceResolver === undefined) {
          return err(
            domainError('PERSISTENCE_FAILED', 'Managed handoff refs present but no durable reference resolver is wired.', {
              reason: 'DURABLE_REFERENCE_RESOLVER_UNAVAILABLE',
              handoffId: created.value.handoffId,
            }),
          );
        }
        const resolved = await deps.durableReferenceResolver(managedRefs);
        if (!resolved.ok) {
          return err(domainError(resolved.error.code as never, resolved.error.message, {
            reason: 'HANDOFF_DURABLE_REFERENCE_INVALID',
            handoffId: created.value.handoffId,
            cause: resolved.error.details,
          }));
        }
      }
      try {
        await deps.store.create(created.value);
      } catch (error) {
        // A persistence conflict must surface as a DOMAIN error, never as a thrown storage error:
        // a duplicate version is a CONFLICT, and nothing was committed (the store is transactional).
        const code =
          error instanceof DomainErrorClass && typeof (error as { readonly code?: unknown }).code === 'string'
            ? String((error as { readonly code?: unknown }).code)
            : 'PERSISTENCE_FAILED';
        return err(
          domainError(code as never, error instanceof Error ? error.message : String(error), {
            handoffId: created.value.handoffId,
            version: created.value.handoffVersion,
            reason: 'HANDOFF_CREATE_REJECTED',
          }),
        );
      }
      await deps.audit.created(payloadOf(created.value, input.actorId));
      return created;
    },

    async ready(input): Promise<Result<HandoffPacket, DomainError>> {
      const permitted = await permit(input.actorId, 'handoff.create', input.handoffId);
      if (!permitted.ok) return permitted;
      const current = await load(input.handoffId, input.version);
      if (!current.ok) return current;
      const ready = markHandoffReady(current.value, {
        now: deps.clock.nowIso(),
        ...(input.requiresEvidence === undefined ? {} : { requiresEvidence: input.requiresEvidence }),
      });
      if (!ready.ok) return ready;
      await deps.store.update(ready.value);
      await deps.audit.ready(payloadOf(ready.value, input.actorId));
      return ready;
    },

    async accept(input): Promise<Result<HandoffPacket, DomainError>> {
      const permitted = await permit(input.actorId, 'handoff.accept', input.handoffId);
      if (!permitted.ok) return permitted;
      // Authority alone is not enough: the actor must actually hold the TARGET role.
      const actorRoleIds = await deps.actorRoleIds(input.actorId);
      if (actorRoleIds.length === 0) {
        return err(
          domainError('PERMISSION_DENIED', 'The actor holds no roles, so no handoff can be accepted.', {
            reason: 'WRONG_TARGET_ROLE',
            actorId: input.actorId,
          }),
        );
      }
      const current = await load(input.handoffId, input.version);
      if (!current.ok) return current;
      const accepted = acceptHandoffPacket(current.value, {
        actorId: input.actorId,
        // Derived server-side from the authorization service - never from the caller.
        actorRoleIds: await deps.actorRoleIds(input.actorId),
        now: deps.clock.nowIso(),
      });
      if (!accepted.ok) return accepted;
      await deps.store.update(accepted.value);
      await deps.audit.accepted(payloadOf(accepted.value, input.actorId));
      return accepted;
    },

    async reject(input): Promise<Result<HandoffPacket, DomainError>> {
      const permitted = await permit(input.actorId, 'handoff.reject', input.handoffId);
      if (!permitted.ok) return permitted;
      const current = await load(input.handoffId, input.version);
      if (!current.ok) return current;
      // Review MEDIUM: rejecting is not "anyone who can reject" - the actor must hold the target
      // role, exactly like acceptance.
      const rejectorRoles = await deps.actorRoleIds(input.actorId);
      if (!rejectorRoles.includes(current.value.toRoleId)) {
        return err(
          domainError('PERMISSION_DENIED', 'Only the target role may reject this handoff.', {
            reason: 'WRONG_TARGET_ROLE',
            toRoleId: current.value.toRoleId,
            actorId: input.actorId,
          }),
        );
      }
      const rejected = rejectHandoffPacket(current.value, {
        actorId: input.actorId,
        reasonCodes: input.reasonCodes,
        comment: input.comment ?? null,
        now: deps.clock.nowIso(),
      });
      if (!rejected.ok) return rejected;
      await deps.store.update(rejected.value);
      await deps.audit.rejected(payloadOf(rejected.value, input.actorId));
      return rejected;
    },

    async cancel(input): Promise<Result<HandoffPacket, DomainError>> {
      const permitted = await permit(input.actorId, 'handoff.create', input.handoffId);
      if (!permitted.ok) return permitted;
      const current = await load(input.handoffId, input.version);
      if (!current.ok) return current;
      const cancelled = cancelHandoffPacket(current.value, { now: deps.clock.nowIso() });
      if (!cancelled.ok) return cancelled;
      await deps.store.update(cancelled.value);
      await deps.audit.cancelled(payloadOf(cancelled.value, input.actorId));
      return cancelled;
    },

    async supersede(input) {
      const permitted = await permit(input.actorId, 'handoff.create', input.handoffId);
      if (!permitted.ok) return permitted;
      const current = await load(input.handoffId, input.previousVersion);
      if (!current.ok) return current;
      const created = createHandoffPacket({
        ...input.next,
        handoffId: input.handoffId,
        createdAt: deps.clock.nowIso(),
      });
      if (!created.ok) return created;
      const nextVersion = { ...created.value, handoffVersion: current.value.handoffVersion + 1 };
      const superseded = supersedeHandoff(current.value, nextVersion);
      if (!superseded.ok) return superseded;
      await deps.store.update(superseded.value.previous);
      await deps.store.create(superseded.value.next);
      await deps.audit.superseded(payloadOf(superseded.value.previous, input.actorId));
      await deps.audit.created(payloadOf(superseded.value.next, input.actorId));
      return ok({ previous: superseded.value.previous, next: superseded.value.next });
    },

    async get(handoffId, version, actorId): Promise<Result<HandoffPacket, DomainError>> {
      // `handoff.read` is a real authority: reading is authorized like any other operation.
      const permitted = await permit(actorId, 'handoff.read', handoffId);
      if (!permitted.ok) return permitted;
      const packet = await deps.store.get(handoffId, version);
      if (packet === null) {
        return err(domainError('NOT_FOUND', `No handoff "${handoffId}".`, { handoffId }));
      }
      return ok(packet);
    },

    async versions(handoffId, actorId): Promise<Result<readonly HandoffPacket[], DomainError>> {
      const permitted = await permit(actorId, 'handoff.read', handoffId);
      if (!permitted.ok) return permitted;
      const versions = await deps.store.listVersions(handoffId);
      if (versions.length === 0) {
        return err(domainError('NOT_FOUND', `No handoff "${handoffId}".`, { handoffId }));
      }
      return ok(versions);
    },

    async listForTargetRole(toRoleId, limit, actorId): Promise<Result<readonly HandoffPacket[], DomainError>> {
      const permitted = await permit(actorId, 'handoff.read', `role:${toRoleId}`);
      if (!permitted.ok) return permitted;
      return ok(await deps.store.listForTargetRole(toRoleId, limit));
    },
  };
}

/** Re-exported so callers can assert the legal transition set without importing Core twice. */
export { applyHandoffTransition };

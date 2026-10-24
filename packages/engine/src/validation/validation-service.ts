/**
 * ValidationService (Sprint 13B — Task-13-06; ADR-0016/0017).
 *
 * Orchestrates the ONE durable validation path:
 *
 *   RunValidation command (ONE target, N validators — frozen cardinality)
 *     → shape validation (duplicates rejected; targeted is MANDATORY — Sprint 13 never
 *       writes legacy null targetRefs)
 *     → authorization `validation.record` (DENY gates new/replay/permanent-replay,
 *       before ANY durable result or side effect)
 *     → trusted command fingerprint (canonical validator plan; validatorVersion is
 *       execution evidence and deliberately NOT part of it)
 *     → replay level 1: ledger (outcome must carry the COMPLETE validationId set;
 *       cross-checked against the durable batch — corrupt/missing/drifted = FAIL CLOSED)
 *     → replay level 2: permanent row batch (ledger-trim safe; fingerprint+target verified)
 *     → preflight: resolve ALL validators before executing ANY (half-batches impossible)
 *     → target verification: artifact exists, id matches, runId matches (wrong-run closed)
 *     → execution through the EXISTING Tool Registry invoke path (authority/risk/idempotency
 *       inherited; deterministic idempotency key binds commandId+fingerprint+validatorId
 *       so a crash-retry NEVER re-executes the underlying adapter)
 *     → optional report materialized via ArtifactService (deterministic nested command —
 *       crash-retry replays the SAME artifact; validators never touch stores)
 *     → ONE UnitOfWork: N Validation rows + N validation.recorded events + 1 ledger outcome
 *
 * Validators produce evidence only: no workflow transitions, no memory/decision writes.
 */
import {
  VALIDATION_EVIDENCE_PATTERN,
  canonicalJson,
  createValidation,
  defineEvent,
  domainError,
  err,
  isValidationTargetRef,
  ok,
  sha256Hex,
  type Artifact,
  type ArtifactStorePort,
  type Clock,
  type CommandLedgerPort,
  type DomainError,
  type EventStorePort,
  type IdFactory,
  type Result,
  type StageId,
  type TaskId,
  type ToolRegistryPort,
  type UnitOfWork,
  type Validation,
  type ValidationStorePort,
  type ValidationTargetRef,
  type WorkflowRunId,
} from '@companyos/core';

import { decodeValidatorOutput } from './validator-output.js';
import type { ValidatorResolver } from './validator-resolver.js';
import type { ArtifactService } from '../artifact/artifact-service.js';

export interface ValidatorPlanEntry {
  readonly validatorId: string;
  /** Trusted orchestration input (R3): the validator output can NEVER change this. */
  readonly blocking: boolean;
}

export interface RunValidationCommand {
  /** Business command identity (retry key). Caller-supplied; never regenerated. */
  readonly commandId: string;
  readonly actorId: string;
  readonly runId: WorkflowRunId;
  readonly stageId?: StageId | null;
  readonly taskId?: TaskId | null;
  /** ONE target per command (frozen cardinality — ADR-0017). Mandatory, never null. */
  readonly targetRef: ValidationTargetRef;
  readonly validators: readonly ValidatorPlanEntry[];
  readonly traceId: string;
}

export interface ValidationServiceDeps {
  readonly resolver: ValidatorResolver;
  /** Report materialization ONLY (validator → descriptor → this service → artifact). */
  readonly artifactService: ArtifactService;
  readonly registry: ToolRegistryPort;
  readonly validationStore: ValidationStorePort;
  readonly artifactStore: ArtifactStorePort;
  readonly events: EventStorePort;
  readonly ledger: CommandLedgerPort;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly unitOfWork: UnitOfWork;
  readonly authorize: (input: {
    readonly actorId: string;
    readonly authority: 'validation.record';
    readonly runId: string;
    readonly targetRef: string;
  }) => Promise<Result<true, DomainError>>;
}

export interface ValidationService {
  run(command: RunValidationCommand): Promise<Result<readonly Validation[], DomainError>>;
}

/** Canonical plan: order carries NO business semantics — sort by validatorId for stable fingerprints. */
const canonicalPlan = (validators: readonly ValidatorPlanEntry[]): readonly ValidatorPlanEntry[] =>
  [...validators].sort((a, b) => (a.validatorId < b.validatorId ? -1 : a.validatorId > b.validatorId ? 1 : 0));

/** Trusted fingerprint: semantic command identity. Excludes validatorVersion (execution evidence). */
export const validationCommandFingerprint = (input: {
  readonly runId: string;
  readonly stageId: string | null;
  readonly taskId: string | null;
  readonly targetRef: string;
  readonly validators: readonly ValidatorPlanEntry[];
}): string =>
  sha256Hex(
    canonicalJson({
      purpose: 'validation.run',
      runId: input.runId,
      stageId: input.stageId,
      taskId: input.taskId,
      targetRef: input.targetRef,
      validators: canonicalPlan(input.validators).map((v) => ({ id: v.validatorId, blocking: v.blocking })),
    }),
  );

/** Deterministic per-validator tool invocation key (§17): binds commandId + fingerprint + validatorId. */
export const validatorInvocationKey = (commandId: string, fingerprint: string, validatorId: string): string =>
  `validation:${commandId}:${fingerprint}:${validatorId}`;

/** Deterministic nested report-artifact command (§27): crash-retry replays the SAME artifact. */
export const reportArtifactCommandId = (commandId: string, fingerprint: string, validatorId: string): string =>
  `validation-report:${commandId}:${fingerprint}:${validatorId}`;

const isValidationId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('val_');

export function createValidationService(deps: ValidationServiceDeps): ValidationService {
  const artifactIdOf = (targetRef: string): string => targetRef.slice('artifact:'.length);

  /** Verify the ledger outcome against the DURABLE batch (the ledger is never the SoT). */
  const recoverViaLedger = async (
    command: RunValidationCommand,
    fingerprint: string,
  ): Promise<Result<readonly Validation[], DomainError> | null> => {
    const hit = await deps.ledger.get(command.commandId);
    if (hit === null) return null; // level-1 miss

    if (hit.fingerprint !== fingerprint) {
      return err(domainError('CONFLICT', 'Validation command reused with different semantics.', {
        reason: 'VALIDATION_COMMAND_FINGERPRINT_MISMATCH',
        commandId: command.commandId,
      }));
    }
    const ids = hit.outcome.validationIds;
    if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length || !ids.every(isValidationId)) {
      return err(domainError('PERSISTENCE_FAILED', 'Validation ledger outcome is corrupt.', {
        reason: 'VALIDATION_LEDGER_OUTCOME_CORRUPT',
        commandId: command.commandId,
      }));
    }
    // Cross-check the claimed id set against the durable batch for this command.
    const batch = await deps.validationStore.getByCreationCommand(command.commandId);
    if (batch === null) {
      return err(domainError('PERSISTENCE_FAILED', 'Validation ledger outcome has no durable batch.', {
        reason: 'VALIDATION_LEDGER_TARGET_MISSING',
        commandId: command.commandId,
      }));
    }
    const durableIds = batch.validations.map((v) => v.id).sort();
    const claimedIds = [...(ids as readonly string[])].sort();
    const sameSet =
      durableIds.length === claimedIds.length && durableIds.every((id, i) => id === claimedIds[i]);
    const belongs =
      batch.creationCommandFingerprint === fingerprint &&
      batch.targetRef === command.targetRef &&
      batch.validations.every((v) => v.runId === command.runId && v.targetRef === command.targetRef);
    if (!sameSet || !belongs) {
      return err(domainError('PERSISTENCE_FAILED', 'Validation ledger outcome does not match the durable batch.', {
        reason: 'VALIDATION_LEDGER_TARGET_MISSING',
        commandId: command.commandId,
      }));
    }
    return ok(batch.validations);
  };

  /** Level-2 replay: permanent row batch after a ledger trim. */
  const recoverViaPermanentRow = async (
    command: RunValidationCommand,
    fingerprint: string,
  ): Promise<Result<readonly Validation[], DomainError> | null> => {
    const batch = await deps.validationStore.getByCreationCommand(command.commandId);
    if (batch === null) return null; // level-2 miss
    if (batch.creationCommandFingerprint !== fingerprint) {
      return err(domainError('CONFLICT', 'Validation command reused with different semantics.', {
        reason: 'VALIDATION_COMMAND_FINGERPRINT_MISMATCH',
        commandId: command.commandId,
      }));
    }
    if (batch.targetRef !== command.targetRef || batch.validations.some((v) => v.runId !== command.runId)) {
      return err(domainError('PERSISTENCE_FAILED', 'Durable validation batch does not belong to this command.', {
        reason: 'VALIDATION_BATCH_TARGET_MISSING',
        commandId: command.commandId,
      }));
    }
    return ok(batch.validations);
  };

  return {
    async run(command: RunValidationCommand): Promise<Result<readonly Validation[], DomainError>> {
      // ---- shape validation (trusted side owns everything the caller must not supply) ----
      if (
        command.commandId.trim() === '' ||
        command.actorId.trim() === '' ||
        command.runId.trim() === '' ||
        command.traceId.trim() === ''
      ) {
        return err(domainError('INVALID_ARGUMENT', 'Validation command identity, actor and trace are required.'));
      }
      if (!isValidationTargetRef(command.targetRef)) {
        return err(domainError('INVALID_ARGUMENT', 'targetRef must be a canonical artifact target ref.', {
          reason: 'VALIDATION_TARGET_REQUIRED',
        }));
      }
      if (command.validators.length === 0) {
        return err(domainError('INVALID_ARGUMENT', 'A validation command needs at least one validator.'));
      }
      const seen = new Set<string>();
      for (const entry of command.validators) {
        if (entry.validatorId.trim() === '') {
          return err(domainError('INVALID_ARGUMENT', 'Validator ids must be non-empty.'));
        }
        if (seen.has(entry.validatorId)) {
          return err(domainError('INVALID_ARGUMENT', `Validator "${entry.validatorId}" appears twice in one command.`, {
            reason: 'VALIDATION_DUPLICATE_VALIDATOR',
            validatorId: entry.validatorId,
          }));
        }
        seen.add(entry.validatorId);
      }

      // ---- authorization gates EVERY path (new / ledger replay / permanent replay) ----
      const permit = await deps.authorize({
        actorId: command.actorId,
        authority: 'validation.record',
        runId: command.runId,
        targetRef: command.targetRef,
      });
      if (!permit.ok) return permit;

      // ---- trusted fingerprint (before any side effect) ----
      const plan = canonicalPlan(command.validators);
      const fingerprint = validationCommandFingerprint({
        runId: command.runId,
        stageId: command.stageId ?? null,
        taskId: command.taskId ?? null,
        targetRef: command.targetRef,
        validators: plan,
      });

      // ---- replay level 1 / level 2 (no tool runs, no writes on a hit) ----
      const viaLedger = await recoverViaLedger(command, fingerprint);
      if (viaLedger !== null) return viaLedger;
      const viaPermanent = await recoverViaPermanentRow(command, fingerprint);
      if (viaPermanent !== null) return viaPermanent;

      // ---- preflight: resolve ALL validators before executing ANY (§15) ----
      const descriptors = [];
      for (const entry of plan) {
        const resolved = await deps.resolver.resolve(entry.validatorId, command.actorId);
        if (!resolved.ok) return resolved; // unknown / disabled / not validator-capable: zero executions
        descriptors.push({ entry, descriptor: resolved.value });
      }

      // ---- target verification (§13): fail closed BEFORE any execution ----
      const targetArtifactId = artifactIdOf(command.targetRef);
      const artifact: Artifact | null = await deps.artifactStore.get(targetArtifactId as Artifact['id']);
      if (artifact === null) {
        return err(domainError('NOT_FOUND', `Validation target "${command.targetRef}" does not exist.`, {
          reason: 'VALIDATION_TARGET_MISSING',
          targetRef: command.targetRef,
        }));
      }
      if (artifact.runId !== command.runId) {
        return err(domainError('VALIDATION_FAILED', 'Validation target belongs to a different run.', {
          reason: 'VALIDATION_TARGET_WRONG_RUN',
          targetRef: command.targetRef,
          targetRunId: artifact.runId,
          commandRunId: command.runId,
        }));
      }

      // ---- execution through the EXISTING Tool Registry path (§16) ----
      const startedAt = deps.clock.nowIso();
      const executed: {
        entry: ValidatorPlanEntry;
        status: 'pass' | 'fail' | 'error' | 'skipped';
        evidenceRefs: string[];
        latencyMs: number | null;
        /** Durable invocation execution times (§20): original times survive a replay. */
        startedAt: string | null;
        finishedAt: string | null;
        /** Execution provenance (ADR-0019): the ACTUAL executed tool version. */
        toolVersion: string | null;
      }[] = [];

      for (const { entry, descriptor } of descriptors) {
        const key = validatorInvocationKey(command.commandId, fingerprint, entry.validatorId);
        const invoked = await deps.registry.invoke({
          toolId: descriptor.toolId,
          executionId: `validation:${command.commandId}`,
          agentId: command.actorId,
          taskId: command.taskId ?? command.commandId,
          runId: command.runId,
          actorId: command.actorId,
          traceId: command.traceId,
          input: {
            targetRef: command.targetRef,
            artifactId: artifact.id,
            runId: artifact.runId,
            kind: artifact.kind,
            contentRef: artifact.contentRef,
            contentHash: artifact.contentHash,
            sizeBytes: artifact.sizeBytes,
          },
          idempotencyKey: key,
        });

        if (!invoked.ok) {
          // Sprint 9 semantics: a HIGH/CRITICAL tool awaiting human approval returns
          // err(APPROVAL_REQUIRED) after persisting a WAITING_APPROVAL invocation. That is
          // NOT a validator malfunction — the whole command fails closed with zero
          // evidence; after approval, a retry replays the SAME invocation by key.
          if (invoked.error.code === 'APPROVAL_REQUIRED') {
            return err(domainError('APPROVAL_REQUIRED', `Validator "${entry.validatorId}" is waiting for tool approval.`, {
              reason: 'VALIDATION_WAITING_APPROVAL',
              validatorId: entry.validatorId,
              cause: invoked.error.message,
            }));
          }
          const replayReason = (invoked.error as DomainError & { details?: { reason?: string } }).details?.reason;
          if (replayReason === 'TOOL_REPLAY_OUTPUT_UNAVAILABLE' || replayReason === 'TOOL_REPLAY_OUTPUT_CORRUPT') {
            // LEGACY / INTEGRITY path only (ADR-0018): a pre-0004 completed invocation
            // without a replay snapshot, or a corrupt one. Post-migration crash retries
            // restore the original output and flow normally; this branch must never
            // turn into an 'error' evidence row (that would degrade good evidence).
            return err(domainError('PERSISTENCE_FAILED', 'A replayed validator invocation cannot restore its verdict.', {
              reason: 'VALIDATION_VERDICT_UNRECOVERABLE',
              validatorId: entry.validatorId,
              cause: replayReason,
            }));
          }
          // Validator itself could not complete (adapter failure / timeout / tool-layer denial).
          // NEVER dressed up as a business 'fail' (ADR-0016 §2.2 ERROR semantics).
          executed.push({ entry, status: 'error', evidenceRefs: [`command:${key}`], latencyMs: null, startedAt: null, finishedAt: null, toolVersion: null });
          continue;
        }
        // ADR-0019: the durable invocation version is the ONLY execution provenance.
        const executedVersion = invoked.value.toolVersion;
        if (executedVersion === null) {
          // Pre-0005 legacy invocation (version UNKNOWN): NEVER substitute the current
          // registry version — fail closed (§14, the rule that matters most here).
          return err(domainError('PERSISTENCE_FAILED', 'A replayed validator invocation has no durable version provenance.', {
            reason: 'VALIDATION_VERSION_PROVENANCE_UNRECOVERABLE',
            validatorId: entry.validatorId,
            invocationId: invoked.value.invocationId,
          }));
        }
        if (!invoked.value.replayed && descriptor.validatorVersion !== executedVersion) {
          // Fresh execution with resolve/execute drift — an internal consistency error;
          // never mint evidence from it (§10). (A REPLAY may legitimately differ: the
          // durable v1 invocation wins over a resolver that now reports v2 — §11.)
          return err(domainError('PERSISTENCE_FAILED', 'Validator resolution and execution versions drifted.', {
            reason: 'VALIDATION_VERSION_PROVENANCE_DRIFT',
            validatorId: entry.validatorId,
            resolvedVersion: descriptor.validatorVersion,
            executedVersion,
          }));
        }
        if (invoked.value.status === 'WAITING_APPROVAL') {
          // The registry is holding the invocation for human approval: the whole command
          // fails closed with zero validation writes. After approval, a retry replays the
          // SAME invocation through the deterministic idempotency key.
          return err(domainError('APPROVAL_REQUIRED', `Validator "${entry.validatorId}" is waiting for tool approval.`, {
            reason: 'VALIDATION_WAITING_APPROVAL',
            validatorId: entry.validatorId,
            invocationId: invoked.value.invocationId,
          }));
        }
        if (invoked.value.status !== 'COMPLETED') {
          executed.push({ entry, status: 'error', evidenceRefs: [`command:${key}`], latencyMs: invoked.value.latencyMs, startedAt: invoked.value.startedAt, finishedAt: invoked.value.finishedAt, toolVersion: executedVersion });
          continue;
        }

        const decoded = decodeValidatorOutput(invoked.value.output);
        if (!decoded.ok) {
          // Malformed output (first run OR replay — ADR-0018 §28): the replay restores
          // the ORIGINAL bytes, so a retry deterministically maps to the same 'error'
          // evidence instead of re-executing the tool.
          executed.push({ entry, status: 'error', evidenceRefs: [`command:${key}`], latencyMs: invoked.value.latencyMs, startedAt: invoked.value.startedAt, finishedAt: invoked.value.finishedAt, toolVersion: executedVersion });
          continue;
        }

        const evidence = [`command:${key}`, ...decoded.value.evidenceRefs];

        // Optional report materialization THROUGH ArtifactService (§25/§26/§27).
        if (decoded.value.report !== null) {
          const materialized = await deps.artifactService.create({
            commandId: reportArtifactCommandId(command.commandId, fingerprint, entry.validatorId),
            runId: command.runId,
            taskId: command.taskId ?? null,
            kind: decoded.value.report.kind,
            content: new TextEncoder().encode(decoded.value.report.content),
            // ADR-0019 §12: producedBy MUST use the durable executed version — under
            // registry drift the retry still says validator:<id>@<v1>, keeping the nested
            // report command fingerprint stable so the SAME artifact replays.
            producedBy: `validator:${descriptor.validatorId}@${executedVersion}`,
            // AUTHORIZATION PRINCIPAL, deliberately distinct from the provenance producer: the
            // actor this command already authorized for `validation.record` is who may perform
            // the materialization. The validator identity NEVER becomes an authorization
            // principal — it only names what produced the report.
            authorizedBy: command.actorId,
            traceId: command.traceId,
          });
          if (!materialized.ok) {
            // Fail closed: the optional report could not be materialized — no partial
            // batch, no swallowed error, no fabricated evidence. Retry reuses the tool
            // invocation (idempotency key) and the SAME report artifact (deterministic
            // nested command), then the batch commits.
            return materialized;
          }
          evidence.push(`artifact:${materialized.value.id}`);
        }

        executed.push({ entry, status: decoded.value.verdict, evidenceRefs: evidence, latencyMs: invoked.value.latencyMs, startedAt: invoked.value.startedAt, finishedAt: invoked.value.finishedAt, toolVersion: executedVersion });
      }
      const finishedAt = deps.clock.nowIso();

      // ---- build the batch with the frozen domain factory (trusted fields only) ----
      const creation = { creationCommandId: command.commandId, creationCommandFingerprint: fingerprint };
      const rows: { row: Validation; blocking: boolean }[] = [];
      for (const result of executed) {
        const descriptor = descriptors.find((d) => d.entry.validatorId === result.entry.validatorId)!.descriptor;
        const made = createValidation({
          runId: command.runId,
          stageId: command.stageId ?? undefined,
          taskId: command.taskId ?? undefined,
          validatorId: descriptor.validatorId,
          // ADR-0019: execution provenance — the durable invocation version, NOT the
          // resolver's current view (crash-replay after a registry upgrade records v1).
          validatorVersion: result.toolVersion ?? descriptor.validatorVersion,
          status: result.status,
          command: `tool:${descriptor.toolId}`,
          exitCode: undefined, // tool validators carry addressable evidence refs, not fake exit codes
          blocking: result.entry.blocking, // trusted plan (R3): validator output never touches this
          evidenceRefs: result.evidenceRefs.filter((ref) => VALIDATION_EVIDENCE_PATTERN.test(ref)),
          startedAt: result.startedAt ?? startedAt,
          finishedAt: result.finishedAt ?? finishedAt,
          targetRef: command.targetRef,
          ids: deps.ids,
        });
        if (!made.ok) return made;
        rows.push({ row: made.value, blocking: result.entry.blocking });
      }

      // ---- ONE UnitOfWork: N rows + N events + 1 ledger outcome (all-or-nothing) ----
      const written = await deps.unitOfWork.transaction(async () => {
        for (const { row } of rows) {
          await deps.validationStore.record(row, creation);
        }
        for (const { row } of rows) {
          await deps.events.append([
            defineEvent(
              {
                type: 'validation.recorded',
                aggregateId: row.id,
                aggregateType: 'Validation',
                traceId: command.traceId,
                actorId: command.actorId,
                payload: {
                  validationId: row.id,
                  runId: row.runId,
                  stageId: row.stageId,
                  validatorId: row.validatorId,
                  validatorVersion: row.validatorVersion,
                  status: row.status,
                  blocking: row.blocking,
                  exitCode: row.exitCode,
                  evidenceRefCount: row.evidenceRefs.length,
                  traceId: command.traceId,
                },
              },
              deps.ids,
              deps.clock.nowIso(),
            ),
          ]);
        }
        await deps.ledger.put({
          commandId: command.commandId,
          fingerprint,
          runId: command.runId,
          outcome: { validationIds: rows.map((r) => r.row.id).sort() },
          recordedAt: deps.clock.nowIso(),
        });
        return rows.map((r) => r.row);
      });
      if (written.ok) return written;

      // ---- concurrent duplicate: UNIQUE(commandId, validatorId) is the final defence ----
      const reason = (written.error as DomainError & { details?: { reason?: string } }).details?.reason;
      if (written.error.code === 'CONFLICT' && reason === 'VALIDATION_CREATION_COMMAND_EXISTS') {
        const recovered = await recoverViaPermanentRow(command, fingerprint);
        if (recovered !== null && recovered.ok) return recovered;
      }
      return written;
    },
  };
}

export { decodeValidatorOutput };

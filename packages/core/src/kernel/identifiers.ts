/**
 * Domain identifier types (Sprint 1 Task 1 — ID freeze).
 *
 * Every aggregate has its own branded id, derived from the canonical prefix map
 * (`ports/id-factory.ts` → `ID_PREFIX`). There is exactly ONE prefix table in
 * Core (single source of truth), and this module only gives those prefixes a
 * nominal type so ids cannot be mixed up.
 */
import type { Brand } from './brand.js';
import { brand } from './brand.js';
import { ID_PREFIX } from '../ports/id-factory.js';
import type { IdFactory } from '../ports/id-factory.js';

/* ---------------------------------------------------------------- id types */

export type CompanyId = Brand<string, 'CompanyId'>;
export type PackInstallationId = Brand<string, 'PackInstallationId'>;
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type WorkflowTemplateId = Brand<string, 'WorkflowTemplateId'>;
export type WorkflowVersionId = Brand<string, 'WorkflowVersionId'>;
export type WorkflowRunId = Brand<string, 'WorkflowRunId'>;
export type RunSnapshotId = Brand<string, 'RunSnapshotId'>;
export type StageId = Brand<string, 'StageId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type RoleId = Brand<string, 'RoleId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type ValidationId = Brand<string, 'ValidationId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type EventId = Brand<string, 'EventId'>;
export type DecisionId = Brand<string, 'DecisionId'>;
export type HandoffId = Brand<string, 'HandoffId'>;
export type MemoryId = Brand<string, 'MemoryId'>;

/** Every id kind Core mints, mapped to its canonical prefix. */
export const DOMAIN_ID_PREFIX = {
  company: ID_PREFIX.company,
  packInstallation: ID_PREFIX.pack,
  workflow: ID_PREFIX.workflow,
  workflowTemplate: ID_PREFIX.template,
  workflowVersion: ID_PREFIX.version,
  workflowRun: ID_PREFIX.run,
  runSnapshot: ID_PREFIX.snapshot,
  stage: ID_PREFIX.stage,
  task: ID_PREFIX.task,
  role: ID_PREFIX.role,
  agent: ID_PREFIX.agent,
  artifact: ID_PREFIX.artifact,
  validation: ID_PREFIX.validation,
  approval: ID_PREFIX.approval,
  event: ID_PREFIX.event,
  decision: ID_PREFIX.decision,
  handoff: ID_PREFIX.handoff,
  memory: ID_PREFIX.memory,
} as const;

export type DomainIdKind = keyof typeof DOMAIN_ID_PREFIX;

/** `makeId('task', ids)` → `tsk_01J…`, branded as a `TaskId`-shaped string. */
export const makeId = <B extends string>(kind: DomainIdKind, ids: IdFactory): Brand<string, B> =>
  brand<string, B>(ids.id(DOMAIN_ID_PREFIX[kind]));

/**
 * Explicit conversion seam: treat an existing plain string as a branded id.
 *
 * Needed because the L2 aggregates written in Sprint 0 (`lifecycle/template.ts`,
 * `lifecycle/version.ts`) carry plain `string` ids. Rather than weaken the L1
 * domain signatures, the boundary names the conversion — so every place that
 * "trusts" an unbranded string is greppable.
 */
export const asId = <B extends string>(value: string): Brand<string, B> => brand<string, B>(value);

/** True when the value carries the canonical prefix for `kind` (no format guessing). */
export const hasIdPrefix = (kind: DomainIdKind, value: string): boolean =>
  value.startsWith(`${DOMAIN_ID_PREFIX[kind]}_`) && value.length > DOMAIN_ID_PREFIX[kind].length + 1;

/**
 * Workflow — the logical SOP container of a Company (规划书 §四 Core 概念 3).
 *
 * `Workflow` is the *container*: it belongs to a company and gathers template
 * versions. The lifecycle of a specific template version lives in
 * `lifecycle/template.ts` (L2 state) — this aggregate deliberately does NOT carry
 * a lifecycle state, so the two layers can never be confused (ADR-0003).
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import {
  makeId,
  type CompanyId,
  type WorkflowId,
  type WorkflowTemplateId,
} from '../kernel/identifiers.js';

export const WORKFLOW_STATUSES = ['active', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export interface Workflow {
  readonly id: WorkflowId;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly description: string;
  /** Templates belonging to this workflow (their versions live in L2). */
  readonly templateIds: readonly WorkflowTemplateId[];
  readonly status: WorkflowStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
}

export interface CreateWorkflowInput {
  readonly companyId: CompanyId;
  readonly name: string;
  readonly description?: string;
  readonly createdBy: string;
  readonly now: string;
  readonly ids: IdFactory;
}

export function createWorkflow(input: CreateWorkflowInput): Result<Workflow, DomainError> {
  const name = input.name.trim();
  if (name.length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'Workflow name must not be empty.', {}));
  }
  return ok({
    id: makeId<'WorkflowId'>('workflow', input.ids),
    companyId: input.companyId,
    name,
    description: input.description ?? '',
    templateIds: [],
    status: 'active',
    createdAt: input.now,
    updatedAt: input.now,
    createdBy: input.createdBy,
  });
}

export function attachTemplate(
  workflow: Workflow,
  templateId: WorkflowTemplateId,
  now: string,
): Result<Workflow, DomainError> {
  if (workflow.status === 'archived') {
    return err(
      domainError('ARCHIVED_READONLY', `Workflow ${workflow.id} is archived.`, {
        workflowId: workflow.id,
      }),
    );
  }
  if (workflow.templateIds.includes(templateId)) {
    return err(
      domainError('ALREADY_EXISTS', `Template ${templateId} is already attached.`, {
        workflowId: workflow.id,
        templateId,
      }),
    );
  }
  return ok({ ...workflow, templateIds: [...workflow.templateIds, templateId], updatedAt: now });
}

export function detachTemplate(
  workflow: Workflow,
  templateId: WorkflowTemplateId,
  now: string,
): Result<Workflow, DomainError> {
  if (!workflow.templateIds.includes(templateId)) {
    return err(
      domainError('NOT_FOUND', `Template ${templateId} is not attached to this workflow.`, {
        workflowId: workflow.id,
        templateId,
      }),
    );
  }
  return ok({
    ...workflow,
    templateIds: workflow.templateIds.filter((id) => id !== templateId),
    updatedAt: now,
  });
}

export function archiveWorkflow(workflow: Workflow, now: string): Result<Workflow, DomainError> {
  if (workflow.status === 'archived') {
    return err(
      domainError('IMMUTABLE_ENTITY', `Workflow ${workflow.id} is already archived.`, {
        workflowId: workflow.id,
      }),
    );
  }
  return ok({ ...workflow, status: 'archived', updatedAt: now });
}

export const isWorkflowActive = (workflow: Workflow): boolean => workflow.status === 'active';

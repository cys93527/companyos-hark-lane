/**
 * Sprint 1 Task 3: the Workflow container, linked to the existing L2 template
 * aggregate (one truth source for templates: `lifecycle/template.ts`).
 */
import { describe, expect, it } from 'vitest';

import {
  archiveWorkflow,
  asId,
  attachTemplate,
  createWorkflow,
  createWorkflowTemplate,
  detachTemplate,
  isWorkflowActive,
  publishInitialVersion,
  type CompanyId,
  type WorkflowTemplateId,
} from '@companyos/core';

import { expectErr, expectOk, makeIds, nowIso } from './support.js';

const companyId = 'cmp_1' as CompanyId;

/** L2 (lifecycle) ids are plain strings; L1 requires branded ids — convert once, visibly. */
const templateIdOf = (template: { readonly id: string }): WorkflowTemplateId =>
  asId<'WorkflowTemplateId'>(template.id);

const newWorkflow = (name = 'Feature delivery') =>
  expectOk(createWorkflow({ companyId, name, createdBy: 'user_owner', now: nowIso(), ids: makeIds() }));

/** Build a real L2 template so the container is linked to an actual aggregate. */
const newTemplate = () => {
  const created = createWorkflowTemplate({
    orgId: 'org_1',
    name: 'Feature SOP',
    actorId: 'user_owner',
    now: nowIso(),
    ids: makeIds(),
    traceId: 'trace_1',
  });
  return expectOk(
    publishInitialVersion(created.template, {
      graph: { nodes: [{ id: 'n1', kind: 'core.noop', title: 'N1', config: {} }], edges: [] },
      ctx: { actorId: 'user_owner', now: nowIso(1000), ids: makeIds(), traceId: 'trace_1' },
    }),
  ).template;
};

describe('Workflow container', () => {
  it('creates an active workflow owned by a company', () => {
    const workflow = newWorkflow();
    expect(workflow.status).toBe('active');
    expect(workflow.companyId).toBe(companyId);
    expect(workflow.templateIds).toEqual([]);
    expect(isWorkflowActive(workflow)).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(expectErr(createWorkflow({ companyId, name: '   ', createdBy: 'u', now: nowIso(), ids: makeIds() })).code).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('attaches and detaches a real published template version', () => {
    const template = newTemplate();
    const templateId = templateIdOf(template);
    const workflow = newWorkflow();

    const attached = expectOk(attachTemplate(workflow, templateId, nowIso(2000)));
    expect(attached.templateIds).toEqual([templateId]);
    expect(template.state).toBe('published');
    expect(template.currentVersionId).not.toBeNull();

    expect(expectErr(attachTemplate(attached, templateId, nowIso(3000))).code).toBe('ALREADY_EXISTS');
    const detached = expectOk(detachTemplate(attached, templateId, nowIso(4000)));
    expect(detached.templateIds).toEqual([]);
    expect(expectErr(detachTemplate(detached, templateId, nowIso(5000))).code).toBe('NOT_FOUND');
  });

  it('keeps a stable branded id type for templates', () => {
    const templateId: WorkflowTemplateId = templateIdOf(newTemplate());
    expect(typeof templateId).toBe('string');
  });

  it('refuses writes on an archived workflow', () => {
    const archived = expectOk(archiveWorkflow(newWorkflow(), nowIso(1000)));
    expect(archived.status).toBe('archived');
    expect(expectErr(archiveWorkflow(archived, nowIso(2000))).code).toBe('IMMUTABLE_ENTITY');
    expect(expectErr(attachTemplate(archived, 'tpl_x' as WorkflowTemplateId, nowIso(3000))).code).toBe(
      'ARCHIVED_READONLY',
    );
  });
});

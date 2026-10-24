/**
 * STAGE 2 — the bounded read-only surfaces behind the left navigation (知识库 / 工具 /
 * 智能体). Each one reads a REAL canonical operation over the typed workflow bridge and
 * projects only fields it can read safely; anything it cannot read is omitted rather than
 * invented. A typed error is surfaced, never swallowed into an empty panel.
 */
import { createElement as h, type JSX } from 'react';

import type { WorkflowBridge } from './designer.js';
import type { ControlPlaneBridge } from './workspace.js';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/* ------------------------------------------------------------------ tools --- */

export interface ToolRow {
  readonly id: string;
  readonly name: string | null;
  readonly enabled: boolean;
}

export const toToolRows = (value: unknown): readonly ToolRow[] => {
  if (!Array.isArray(value)) throw new Error('TOOLS_RESPONSE_INVALID');
  return value.map((entry: unknown) => {
    const row = asRecord(entry);
    const id = row === null ? null : text(row['toolId']) ?? text(row['id']);
    if (row === null || id === null || text(row['name']) === null || typeof row['enabled'] !== 'boolean' ||
        (text(row['id']) !== null && text(row['toolId']) !== null && row['id'] !== row['toolId'])) {
      throw new Error('TOOLS_RESPONSE_INVALID');
    }
    return {
      id,
      name: text(row['name']),
      enabled: row['enabled'],
    };
  });
};

export const loadTools = async (bridge: WorkflowBridge): Promise<readonly ToolRow[]> => {
  const rows: ToolRow[] = [];
  const cursors = new Set<string>();
  const identities = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = asRecord(await bridge.workflowRequest({
      operation: 'tools.list',
      payload: { includeDisabled: true, ...(cursor === null ? {} : { cursor }) },
    }));
    if (response?.['ok'] === false) throw new Error('TOOLS_UNAVAILABLE');
    const page = response?.['ok'] === true ? asRecord(response['value']) : null;
    if (page === null || !Array.isArray(page['items']) ||
        !(page['nextCursor'] === null || text(page['nextCursor']) !== null)) {
      throw new Error('TOOLS_RESPONSE_INVALID');
    }
    for (const row of toToolRows(page['items'])) {
      if (identities.has(row.id)) throw new Error('TOOLS_RESPONSE_INVALID');
      identities.add(row.id);
      rows.push(row);
    }
    cursor = page['nextCursor'] as string | null;
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error('TOOLS_RESPONSE_INVALID');
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return rows;
};

export function ToolsSurfaceView(props: {
  readonly rows: readonly ToolRow[] | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}): JSX.Element {
  return h(
    'section',
    { className: 'card surface', 'aria-label': 'tools-surface' },
    h('h2', null, '工具'),
    props.failure === null
      ? null
      : h('p', { className: 'typed-error__message', role: 'alert' }, `${props.failure.code} ${props.failure.message}`),
    props.failure !== null ? null : props.rows === null
      ? h('p', { className: 'muted' }, '加载中…')
      : props.rows.length === 0
        ? h('p', { className: 'muted' }, '尚无注册工具。')
        : h(
            'ul',
            { className: 'surface__list', 'aria-label': 'tool-rows' },
            props.rows.map((row) =>
              h(
                'li',
                { key: row.id },
                h('span', null, row.name ?? row.id),
                h('span', { className: 'surface__state' }, row.enabled ? 'enabled' : 'disabled'),
              ),
            ),
          ),
  );
}

/* ------------------------------------------------------------- knowledge --- */

export interface KnowledgeRow {
  readonly id: string;
  readonly title: string | null;
  readonly kind: string | null;
}

export const toKnowledgeRows = (value: unknown): readonly KnowledgeRow[] => {
  if (!Array.isArray(value)) throw new Error('KNOWLEDGE_RESPONSE_INVALID');
  return value.map((entry: unknown) => {
    const row = asRecord(entry);
    const id = row === null ? null : text(row['id']) ?? text(row['memoryId']);
    if (row === null || id === null || typeof row['title'] !== 'string' || text(row['kind']) === null) {
      throw new Error('KNOWLEDGE_RESPONSE_INVALID');
    }
    return {
      id,
      title: text(row['title']),
      kind: text(row['kind']),
    };
  });
};

/** Resolve the existing Company scope through Main's proveCompany-checked read. */
export const resolveSurfaceCompany = async (bridge: ControlPlaneBridge, companyScope: string): Promise<string> => {
  const response = asRecord(await bridge.controlPlaneRequest({
    operation: 'home.summary', payload: { companyId: companyScope },
  }));
  const value = response?.['ok'] === true ? asRecord(response['value']) : null;
  const companyId = value === null ? null : text(value['companyId']);
  if (companyId === null || companyId !== companyScope) throw new Error('KNOWLEDGE_CONTEXT_UNAVAILABLE');
  return companyId;
};

export const loadKnowledge = async (bridge: WorkflowBridge, companyId: string): Promise<readonly KnowledgeRow[]> => {
  if (typeof companyId !== 'string' || companyId.trim().length === 0) throw new Error('KNOWLEDGE_CONTEXT_UNAVAILABLE');
  const response = asRecord(await bridge.workflowRequest({
    operation: 'memory.retrieve',
    payload: { companyId, scopes: [{ type: 'COMPANY', id: companyId }], now: new Date().toISOString() },
  }));
  if (response?.['ok'] === false) throw new Error('KNOWLEDGE_UNAVAILABLE');
  const result = response?.['ok'] === true ? asRecord(response['value']) : null;
  if (result === null || !Array.isArray(result['items']) ||
      !Array.isArray(result['conflicts']) || result['conflicts'].some((entry: unknown) => typeof entry !== 'string') ||
      result['includedCount'] !== result['items'].length ||
      typeof result['totalMatched'] !== 'number' || !Number.isInteger(result['totalMatched']) ||
      result['totalMatched'] < result['items'].length || typeof result['truncated'] !== 'boolean') {
    throw new Error('KNOWLEDGE_RESPONSE_INVALID');
  }
  // A character/count budget can exclude every matching item; that is not an empty store.
  if (result['items'].length === 0 && result['totalMatched'] > 0) throw new Error('KNOWLEDGE_RESULTS_NOT_DISPLAYABLE');
  return toKnowledgeRows(result['items']);
};

export function KnowledgeSurfaceView(props: {
  readonly rows: readonly KnowledgeRow[] | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}): JSX.Element {
  return h(
    'section',
    { className: 'card surface', 'aria-label': 'knowledge-surface' },
    h('h2', null, '知识库'),
    props.failure === null
      ? null
      : h('p', { className: 'typed-error__message', role: 'alert' }, `${props.failure.code} ${props.failure.message}`),
    props.failure !== null ? null : props.rows === null
      ? h('p', { className: 'muted' }, '加载中…')
      : props.rows.length === 0
        ? h('p', { className: 'muted' }, '暂无记忆条目。')
        : h(
            'ul',
            { className: 'surface__list', 'aria-label': 'knowledge-rows' },
            props.rows.map((row) =>
              h(
                'li',
                { key: row.id },
                h('span', null, row.title ?? row.id),
                h('span', { className: 'surface__state' }, row.kind ?? ''),
              ),
            ),
          ),
  );
}

/* --------------------------------------------------------------- agents --- */

export interface AgentRow {
  readonly id: string;
  readonly status: string | null;
  readonly taskId: string | null;
  readonly roleId: string | null;
  readonly modelKey: string | null;
}

export const toAgentRows = (value: unknown): readonly AgentRow[] =>
  asArray(value).map((entry) => {
    const row = asRecord(entry) ?? {};
    return {
      id: text(row['executionId']) ?? text(row['id']) ?? '(unknown)',
      status: text(row['status']),
      taskId: text(row['taskId']),
      roleId: text(row['roleId']),
      modelKey: text(row['modelKey']),
    };
  });

export const loadAgents = async (bridge: WorkflowBridge): Promise<readonly AgentRow[]> => {
  const response = (await bridge.workflowRequest({
    operation: 'agent.list',
    payload: {},
  })) as { readonly ok: boolean; readonly value?: unknown };
  if (!response.ok) throw new Error('AGENTS_UNAVAILABLE');
  return toAgentRows(response.value);
};

export function AgentsSurfaceView(props: {
  readonly rows: readonly AgentRow[] | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}): JSX.Element {
  return h(
    'section',
    { className: 'card surface', 'aria-label': 'agents-surface' },
    h('h2', null, '智能体'),
    props.failure === null
      ? null
      : h('p', { className: 'typed-error__message', role: 'alert' }, `${props.failure.code} ${props.failure.message}`),
    props.rows === null
      ? h('p', { className: 'muted' }, '加载中…')
      : props.rows.length === 0
        ? h('p', { className: 'muted' }, '尚无执行记录。')
        : h(
            'ul',
            { className: 'surface__list', 'aria-label': 'agent-rows' },
            props.rows.map((row) =>
              h(
                'li',
                { key: row.id },
                h('span', null, row.id),
                h(
                  'span',
                  { className: 'surface__state' },
                  [row.status, row.roleId, row.modelKey].filter((part): part is string => part !== null).join(' · '),
                ),
              ),
            ),
          ),
  );
}

/** R4-F1/F2: real React mounts, canonical IPC shapes, no Electron or Provider. */
import './support/mini-dom.js';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  retrieveMemories,
  type MemoryRecord,
  type MemoryRetrievalInput,
  type MemoryRetrievalResult,
  type ToolRecord,
} from '@companyos/core';
import { App } from '../src/App.js';
import {
  loadKnowledge,
  loadTools,
  resolveSurfaceCompany,
  ToolsSurfaceView,
} from '../src/surfaces.js';
import {
  clickableWithText,
  createContainer,
  dispatchMiniEvent,
  removeContainer,
  type MiniElement,
} from './support/mini-dom.js';

const tools: readonly ToolRecord[] = Array.from({ length: 18 }, (_, i) => ({
  id: `tool.${String(i)}`,
  toolId: `tool.${String(i)}`,
  name: `Tool ${String(i)}`,
  enabled: i !== 1,
  description: 'Local test contract',
  version: '1.0.0',
  capabilities: [],
  inputSchema: {},
  outputSchema: {},
  riskLevel: 'LOW',
  requiredAuthorities: [],
  timeoutMs: 1000,
  idempotencyMode: 'NONE',
  auditPolicy: 'STANDARD',
  providerKind: 'mock',
  adapterRef: `fixture.${String(i)}`,
  createdAt: '2026-10-11T00:00:00Z',
  updatedAt: '2026-10-11T00:00:00Z',
}));
const page = (items: readonly unknown[], nextCursor: string | null = null) => ({
  ok: true,
  value: { items, nextCursor },
});
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};
const memory: MemoryRecord = {
  id: 'memory.1',
  memoryId: 'memory.1',
  version: 1,
  companyId: 'company_default',
  scope: { type: 'COMPANY', id: 'company_default' },
  kind: 'FACT',
  title: 'Canonical memory',
  content: 'Local test content',
  status: 'ACTIVE',
  importance: 'NORMAL',
  sourceType: 'USER',
  sourceRefs: [],
  trust: 'ASSERTED',
  provenance: { sourceType: 'USER', sourceRefs: [], trust: 'ASSERTED' },
  createdBy: 'test_owner',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  traceId: 'test_trace',
  metadata: {},
};
const memoryResult = (items: readonly MemoryRecord[]): MemoryRetrievalResult => ({
  items,
  conflicts: [],
  totalMatched: items.length,
  includedCount: items.length,
  truncated: false,
});
let root: Root | null = null;
let container: MiniElement | null = null;
const mount = async (element: ReturnType<typeof h>) => {
  container = createContainer();
  root = createRoot(container as unknown as Element);
  await act(async () => {
    root?.render(element);
  });
  await settle();
  return container;
};
const click = async (text: string) => {
  const button = clickableWithText(container as MiniElement, text);
  expect(button).not.toBeNull();
  await act(async () => {
    dispatchMiniEvent(button as MiniElement, 'click');
  });
  await settle();
};
afterEach(async () => {
  if (root !== null)
    await act(async () => {
      root?.unmount();
    });
  if (container !== null) removeContainer(container);
  root = null;
  container = null;
  delete (globalThis as unknown as Record<string, unknown>)['companyos'];
});

const installBridge = (
  reply: (operation: string, payload: unknown) => unknown,
  summary: unknown = { ok: true, value: { companyId: 'company_default', goals: [] } },
) => {
  const workflowRequest = vi.fn(async (request: { operation: string; payload?: unknown }) => {
    if (request.operation === 'models.selection') return { ok: true, value: {} };
    if (request.operation.startsWith('models.')) return { ok: true, value: [] };
    return reply(request.operation, request.payload);
  });
  const controlPlaneRequest = vi.fn(async (request: { operation: string }) => {
    if (request.operation === 'home.summary') return summary;
    if (request.operation === 'decisions.pending') return { ok: true, value: { pending: [] } };
    return { ok: true, value: null };
  });
  (globalThis as unknown as Record<string, unknown>)['companyos'] = {
    appVersion: async () => '0.0.0-r4',
    databaseStatus: async () => ({ path: '/test/db.sqlite', journalMode: 'wal', schemaVersion: 1 }),
    platformInfo: async () => ({
      platform: 'win32',
      arch: 'x64',
      electron: '44.5.1',
      node: 'test',
      chrome: 'test',
    }),
    channels: () => [],
    workflowRequest,
    controlPlaneRequest,
    workspaceCurrent: async () => '/test/workspace',
    workspaceSelect: async () => null,
    workspaceOpen: async (path: string) => ({ ok: true, root: path }),
    workspaceSwitch: async (path: string) => ({ ok: true, root: path }),
  };
  return { workflowRequest, controlPlaneRequest };
};

describe('R4-F1 canonical tool pages', () => {
  it('renders all 18 canonical items after a real App mount and click', async () => {
    installBridge(() => page(tools));
    const dom = await mount(h(App));
    await click('工具');
    const toolList = dom.childNodes
      .flatMap(function walk(node): typeof dom.childNodes {
        return [node, ...node.childNodes.flatMap(walk)];
      })
      .find((node) => (node as MiniElement).getAttribute?.('aria-label') === 'tool-rows');
    expect(toolList?.childNodes).toHaveLength(18);
    expect(dom.textContent).toContain('Tool 17');
    expect(dom.textContent).toContain('disabled');
    expect(dom.textContent).not.toContain('尚无注册工具');
  });
  it('renders empty only for an actual empty canonical page', async () => {
    installBridge(() => page([]));
    const dom = await mount(h(App));
    await click('工具');
    expect(dom.textContent).toContain('尚无注册工具');
    expect(dom.textContent).not.toContain('SURFACE_UNAVAILABLE');
  });
  it('preserves cursor and includeDisabled through multiple pages', async () => {
    const workflowRequest = vi
      .fn()
      .mockResolvedValueOnce(page(tools.slice(0, 10), 'opaque cursor'))
      .mockResolvedValueOnce(page(tools.slice(10)));
    expect(await loadTools({ workflowRequest })).toHaveLength(18);
    expect(workflowRequest.mock.calls).toEqual([
      [{ operation: 'tools.list', payload: { includeDisabled: true } }],
      [{ operation: 'tools.list', payload: { includeDisabled: true, cursor: 'opaque cursor' } }],
    ]);
  });
  it('does not publish a partial list when a later page fails', async () => {
    const workflowRequest = vi
      .fn()
      .mockResolvedValueOnce(page(tools.slice(0, 10), 'next'))
      .mockResolvedValueOnce({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(loadTools({ workflowRequest })).rejects.toThrow();
  });
  it('rejects a repeated cursor rather than looping', async () => {
    const workflowRequest = vi
      .fn()
      .mockResolvedValueOnce(page(tools.slice(0, 10), 'same'))
      .mockResolvedValueOnce(page(tools.slice(10), 'same'));
    await expect(loadTools({ workflowRequest })).rejects.toThrow();
    expect(workflowRequest).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    {},
    { ok: true },
    { ok: true, value: [] },
    { ok: true, value: { items: [], nextCursor: 1 } },
    { ok: true, value: { items: [] } },
    page([{}]),
    page([{ id: 'x', enabled: 'yes' }]),
  ])('rejects malformed response %j', async (response) => {
    await expect(loadTools({ workflowRequest: async () => response })).rejects.toThrow();
  });
  it.each([
    { ok: false, error: { code: 'PERMISSION_DENIED' } },
    { ok: true, value: [] },
  ])('renders an error, never a false empty state: %j', async (response) => {
    installBridge(() => response);
    const dom = await mount(h(App));
    await click('工具');
    expect(dom.textContent).toContain('SURFACE_UNAVAILABLE');
    expect(dom.textContent).not.toContain('尚无注册工具');
    expect(dom.textContent).not.toContain('加载中');
  });
  it('keeps loading while the real read is unresolved', async () => {
    installBridge(() => new Promise(() => {}));
    const dom = await mount(h(App));
    await click('工具');
    expect(dom.textContent).toContain('加载中');
    expect(dom.textContent).not.toContain('尚无注册工具');
  });
  it('keeps a multi-page mount loading until the final page, then shows all rows', async () => {
    let resolveLast: (value: unknown) => void = () => {};
    let calls = 0;
    installBridge(() => {
      calls += 1;
      return calls === 1
        ? page(tools.slice(0, 10), 'remaining')
        : new Promise((resolve) => {
            resolveLast = resolve;
          });
    });
    const dom = await mount(h(App));
    await click('工具');
    expect(dom.textContent).toContain('加载中');
    expect(dom.textContent).not.toContain('Tool 0');
    await act(async () => {
      resolveLast(page(tools.slice(10)));
    });
    await settle();
    expect(dom.textContent).toContain('Tool 0');
    expect(dom.textContent).toContain('Tool 17');
    expect(dom.textContent).not.toContain('加载中');
  });
  it('a late tool failure cannot overwrite the knowledge surface', async () => {
    let rejectTools: (error: Error) => void = () => {};
    installBridge((operation) =>
      operation === 'tools.list'
        ? new Promise((_resolve, reject) => {
            rejectTools = reject;
          })
        : { ok: true, value: memoryResult([]) },
    );
    const dom = await mount(h(App));
    await click('工具');
    await click('知识库');
    await act(async () => {
      rejectTools(new Error('transport'));
    });
    await settle();
    expect(dom.textContent).toContain('暂无记忆条目');
    expect(dom.textContent).not.toContain('SURFACE_UNAVAILABLE');
  });
  it('a late response after unmount does not update the detached React root', async () => {
    let resolveTools: (value: unknown) => void = () => {};
    installBridge(
      () =>
        new Promise((resolve) => {
          resolveTools = resolve;
        }),
    );
    const dom = await mount(h(App));
    await click('工具');
    await act(async () => {
      root?.unmount();
    });
    root = null;
    await act(async () => {
      resolveTools(page(tools));
    });
    await settle();
    expect(dom.textContent).toBe('');
  });
  it('failure takes precedence over an empty or stale projection', async () => {
    const dom = await mount(
      h(ToolsSurfaceView, { rows: [], failure: { code: 'FAILED', message: 'read failed' } }),
    );
    expect(dom.textContent).toContain('FAILED');
    expect(dom.textContent).not.toContain('尚无注册工具');
  });
});

describe('R4-F2 Company-scoped knowledge read', () => {
  it('does not label a budget-truncated nonempty memory store as empty', async () => {
    installBridge(() => ({
      ok: true,
      value: { ...memoryResult([]), totalMatched: 1, truncated: true },
    }));
    const dom = await mount(h(App));
    await click('知识库');
    expect(dom.textContent).toContain('SURFACE_UNAVAILABLE');
    expect(dom.textContent).not.toContain('暂无记忆条目');
  });
  it('uses the canonical retrieval result and current time, preserving expiry and Company filtering', async () => {
    const workflowRequest = vi.fn(async (request: { operation: string; payload?: unknown }) => ({
      ok: true,
      value: retrieveMemories(
        [
          memory,
          { ...memory, id: 'expired', memoryId: 'expired', expiresAt: '2000-01-01T00:00:00Z' },
          { ...memory, id: 'foreign', memoryId: 'foreign', companyId: 'other_company' },
        ],
        request.payload as MemoryRetrievalInput,
      ),
    }));
    expect(await loadKnowledge({ workflowRequest }, 'company_default')).toEqual([
      { id: 'memory.1', title: 'Canonical memory', kind: 'FACT' },
    ]);
  });
  it('renders the real canonical empty retrieval object as empty, without a shape error', async () => {
    installBridge(() => ({ ok: true, value: memoryResult([]) }));
    const dom = await mount(h(App));
    await click('知识库');
    expect(dom.textContent).toContain('暂无记忆条目');
    expect(dom.textContent).not.toContain('SURFACE_UNAVAILABLE');
  });
  it('rejects a malformed memory result instead of projecting a false empty state', async () => {
    const workflowRequest = vi.fn().mockResolvedValue({ ok: true, value: {} });
    await expect(loadKnowledge({ workflowRequest }, 'company_test')).rejects.toThrow(
      'KNOWLEDGE_RESPONSE_INVALID',
    );
  });
  it('resolves a non-default Company through the canonical read, not a hardcoded fallback', async () => {
    const controlPlaneRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { companyId: 'company_test', goals: [] } });
    expect(await resolveSurfaceCompany({ controlPlaneRequest }, 'company_test')).toBe(
      'company_test',
    );
    expect(controlPlaneRequest).toHaveBeenCalledWith({
      operation: 'home.summary',
      payload: { companyId: 'company_test' },
    });
  });
  it('sends the supplied canonical Company in companyId and scope, without a default', async () => {
    const workflowRequest = vi.fn().mockResolvedValue({ ok: true, value: memoryResult([]) });
    await loadKnowledge({ workflowRequest }, 'company_test');
    expect(workflowRequest).toHaveBeenCalledWith({
      operation: 'memory.retrieve',
      payload: {
        companyId: 'company_test',
        now: expect.any(String),
        scopes: [{ type: 'COMPANY', id: 'company_test' }],
      },
    });
  });
  it('fails closed without Company identity and does not dispatch a knowledge query', async () => {
    const workflowRequest = vi.fn();
    await expect(loadKnowledge({ workflowRequest }, '')).rejects.toThrow();
    expect(workflowRequest).not.toHaveBeenCalled();
  });
  it('actual App resolves canonical context before issuing the memory query', async () => {
    const bridge = installBridge((operation, payload) => {
      if (operation === 'memory.retrieve') {
        expect(payload).toEqual({
          companyId: 'company_default',
          now: expect.any(String),
          scopes: [{ type: 'COMPANY', id: 'company_default' }],
        });
        return { ok: true, value: memoryResult([memory]) };
      }
      return { ok: true, value: [] };
    });
    const dom = await mount(h(App));
    await click('知识库');
    expect(dom.textContent).toContain('Canonical memory');
    expect(bridge.controlPlaneRequest).toHaveBeenCalledWith({
      operation: 'home.summary',
      payload: { companyId: 'company_default' },
    });
    expect(dom.textContent).not.toContain('暂无记忆条目');
  });
  it.each([
    { ok: false, error: { code: 'PERMISSION_DENIED' } },
    { ok: true, value: { goals: [] } },
    { ok: true, value: { companyId: 'other_company', goals: [] } },
  ])('does not guess a Company when canonical context fails: %j', async (summary) => {
    const bridge = installBridge(() => ({ ok: true, value: [] }), summary);
    const dom = await mount(h(App));
    await click('知识库');
    expect(
      bridge.workflowRequest.mock.calls.some(
        ([request]) => request.operation === 'memory.retrieve',
      ),
    ).toBe(false);
    expect(dom.textContent).toContain('SURFACE_UNAVAILABLE');
    expect(dom.textContent).not.toContain('暂无记忆条目');
  });
  it('failed memory read stays an error instead of a knowledge empty state', async () => {
    installBridge(() => ({ ok: false, error: { code: 'PERMISSION_DENIED' } }));
    const dom = await mount(h(App));
    await click('知识库');
    expect(dom.textContent).toContain('SURFACE_UNAVAILABLE');
    expect(dom.textContent).not.toContain('暂无记忆条目');
    expect(dom.textContent).not.toContain('加载中');
  });
});

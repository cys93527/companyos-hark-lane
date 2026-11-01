/**
 * AUDIT renderer fixes — shared App mount harness over the mini DOM (no new dependency).
 * The bridge's controlPlaneRequest is a test-provided handler; localStorage is an
 * in-memory stub so submission intents and local drafts are observable.
 */
import './mini-dom.js';

import { createElement as h } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

import { App } from '../../src/App.js';
import { clickableWithText, createContainer, dispatchMiniEvent, removeContainer, type MiniElement } from './mini-dom.js';

export const WORKSPACE = '/audit-ws';

export interface ControlCall {
  readonly operation: string;
  readonly payload: Record<string, unknown>;
}

export const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
  };
};

export const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  });
};

let root: Root | null = null;
let container: MiniElement | null = null;

export interface MountOptions {
  readonly control: (call: ControlCall) => Promise<unknown> | unknown;
  readonly workflow?: (operation: string, payload: Record<string, unknown>) => Promise<unknown> | unknown;
  readonly storage?: ReturnType<typeof memoryStorage>;
  readonly modelSelected?: boolean;
  readonly artifactAction?: (request: { operation: string; artifactId: string }) => Promise<unknown>;
  readonly workspaceSwitch?: (root: string) => Promise<unknown>;
  readonly workspaceSelect?: () => Promise<string | null>;
}

export const mountApp = async (options: MountOptions) => {
  const calls: ControlCall[] = [];
  const storage = options.storage ?? memoryStorage();
  vi.stubGlobal('localStorage', storage);
  const modelSelected = options.modelSelected ?? true;
  const bridge = {
    appVersion: async () => '0.0.0-audit',
    platformInfo: async () => ({ platform: 'win32', arch: 'x64', electron: '0', node: '0', chrome: '0' }),
    databaseStatus: async () => ({ path: 'C:/db.sqlite', journalMode: 'wal', schemaVersion: 1 }),
    channels: () => [],
    workflowRequest: async (request: { operation: string; payload?: unknown }) => {
      const payload = (request.payload ?? {}) as Record<string, unknown>;
      if (options.workflow !== undefined) {
        const answer = await options.workflow(request.operation, payload);
        if (answer !== undefined) return answer;
      }
      if (request.operation === 'models.selection') {
        return { ok: true, value: modelSelected ? { resolvedModelKey: 'mdl_1' } : {} };
      }
      if (request.operation === 'models.list') {
        return {
          ok: true,
          value: modelSelected
            ? [{ modelKey: 'mdl_1', providerId: 'p', providerModelId: 'm', displayName: 'Model One', enabled: true }]
            : [],
        };
      }
      return { ok: true, value: [] };
    },
    workspaceSelect: options.workspaceSelect ?? (async () => null),
    workspaceOpen: async (r: string) => ({ ok: true, root: r }),
    workspaceCurrent: async () => WORKSPACE,
    workspaceSwitch: options.workspaceSwitch ?? (async (r: string) => ({ ok: true, root: r })),
    artifactAction: options.artifactAction ?? (async () => ({ ok: true, value: null })),
    controlPlaneRequest: async (request: { operation: string; payload?: unknown }) => {
      const call = { operation: request.operation, payload: (request.payload ?? {}) as Record<string, unknown> };
      calls.push(call);
      const answer = await options.control(call);
      if (answer !== undefined) return answer;
      if (request.operation === 'home.summary') return { ok: true, value: { goals: [] } };
      if (request.operation === 'decisions.pending') return { ok: true, value: { pending: [] } };
      return { ok: true, value: null };
    },
  };
  vi.stubGlobal('companyos', bridge);
  container = createContainer();
  root = createRoot(container as unknown as Element);
  const r = root;
  await act(async () => {
    r.render(h(App));
  });
  await settle();
  const view = container;
  return {
    view,
    calls,
    storage,
    callsOf: (operation: string) => calls.filter((call) => call.operation === operation),
    button: (label: string) => clickableWithText(view, label),
    click: async (label: string) => {
      const target = clickableWithText(view, label);
      if (target === null) throw new Error(`no button "${label}"`);
      await act(async () => {
        dispatchMiniEvent(target, 'click');
      });
      await settle();
    },
  };
};

export const unmountApp = (): void => {
  if (root !== null) {
    const r = root;
    act(() => r.unmount());
    root = null;
  }
  if (container !== null) removeContainer(container);
  container = null;
  vi.unstubAllGlobals();
};

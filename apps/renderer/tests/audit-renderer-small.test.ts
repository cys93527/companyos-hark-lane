/**
 * AUDIT R11 (validation 缺失 count), R12 (file-delivery requirement cleared after a
 * successful submit), R13 (Agents surface: failure without a permanent 加载中…).
 */
import './support/mini-dom.js';

import { act, createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatView } from '../src/chat.js';
import { createLocalDraftStore } from '../src/local-draft-store.js';
import { AgentsSurfaceView } from '../src/surfaces.js';
import { memoryStorage, mountApp, unmountApp, waitFor, WORKSPACE } from './support/audit-app-harness.js';
import type { MiniElement } from './support/mini-dom.js';

afterEach(() => unmountApp());

/** React's own props on a mounted host node (the mini DOM has no input-value tracking). */
const reactProps = (element: MiniElement): Record<string, unknown> => {
  const record = element as unknown as Record<string, unknown>;
  const key = Object.keys(record).find((name) => name.startsWith('__reactProps$'));
  if (key === undefined) throw new Error('no react props on element');
  return record[key] as Record<string, unknown>;
};

describe('AUDIT R11/R12/R13', () => {
  it('R11 the validation row prints the missing count, not the failed flag', () => {
    const html = renderToStaticMarkup(
      h(ChatView, {
        objective: 'x',
        entries: [{ kind: 'validation', completed: 2, failed: false, missing: 3 }],
        loading: false,
        failure: null,
      }),
    );
    expect(html).toContain('验证 · 完成 2 · 失败 0 · 缺失 3');
  });

  it('R13 the Agents surface shows the failure without a permanent 加载中…', () => {
    const html = renderToStaticMarkup(
      h(AgentsSurfaceView, { rows: null, failure: { code: 'SURFACE_UNAVAILABLE', message: 'x' } }),
    );
    expect(html).toContain('SURFACE_UNAVAILABLE');
    expect(html).not.toContain('加载中');
  });

  it('R12 a successful submit clears the file-delivery requirement so it does not ride on the next Goal', async () => {
    const storage = memoryStorage();
    createLocalDraftStore(storage).save('company_default', WORKSPACE, '目标一');
    const app = await mountApp({
      storage,
      control: (call) => (call.operation === 'goal.create' ? { ok: true, value: { runId: 'run_goal_r12' } } : undefined),
    });
    const fieldInLabel = (tag: string): MiniElement => {
      const walk = (node: MiniElement): MiniElement | null => {
        if (node.tagName === tag && (node.parentNode as MiniElement | null)?.tagName === 'LABEL') return node;
        for (const child of node.childNodes) {
          if ('tagName' in (child as object)) {
            const hit = walk(child as MiniElement);
            if (hit !== null) return hit;
          }
        }
        return null;
      };
      const hit = walk(app.view);
      if (hit === null) throw new Error(`no ${tag}`);
      return hit;
    };
    const setValue = async (element: MiniElement, value: string) => {
      const onChange = reactProps(element)['onChange'] as (event: { target: { value: string } }) => void;
      await act(async () => {
        onChange({ target: { value } });
      });
    };
    await setValue(fieldInLabel('INPUT'), 'out/result.txt');
    await setValue(fieldInLabel('TEXTAREA'), 'hello');
    await app.click('提交并开始执行');
    await waitFor(() => app.callsOf('goal.create').length > 0 && reactProps(fieldInLabel('INPUT'))['value'] === '');
    const first = app.callsOf('goal.create')[0];
    expect(JSON.stringify(first?.payload['structured'] ?? null)).toContain('out/result.txt');
    expect(reactProps(fieldInLabel('INPUT'))['value']).toBe('');
    expect(reactProps(fieldInLabel('TEXTAREA'))['value']).toBe('');
  });
});

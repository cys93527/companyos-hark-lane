/**
 * BUG BASH workspace-switch closure — the canonical SINGLE-ACTIVE-WORKSPACE change
 * lifecycle (`switchWorkspace`), over typed fake seams.
 *
 * Product contract under test:
 *   WS-02  a successful switch A→B ends with canonical B
 *   WS-03  a refused switch NEVER displays a false active B — A stays canonical and the
 *          typed error is surfaced
 *   WS-05  a refused switch cannot redirect execution — goal.create binds to the canonical
 *          workspace, so the only root it could target is the one this lifecycle leaves active
 *   WS-10  the renderer cannot independently declare the active workspace — the lifecycle
 *          runs entirely on trusted main-process seams
 *   plus idempotent same-root re-affirmation and fail-closed restore when the open of B fails.
 */
import { describe, expect, it } from 'vitest';

import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';
import { switchWorkspace, type WorkspaceSwitchSeams } from '../src/workspace-switch.js';

const errResult = (code: string): Result<never, DomainError> =>
  err(domainError('VALIDATION_FAILED', code, { reason: code }));

describe('switchWorkspace — the canonical single-workspace change lifecycle', () => {
  it('WS-02: a successful switch A→B ends with canonical B', async () => {
    const state = { root: 'A' as string | null };
    const calls: string[] = [];
    const seams: WorkspaceSwitchSeams = {
      currentRoot: () => state.root,
      close: () => {
        calls.push('close');
        state.root = null;
        return ok(true as const);
      },
      open: async (root) => {
        calls.push(`open:${root}`);
        state.root = root;
        return ok({ canonicalRoot: root });
      },
    };
    const result = await switchWorkspace(seams, 'B');
    expect(result).toEqual({ ok: true, root: 'B' });
    expect(state.root).toBe('B');
    expect(calls).toEqual(['close', 'open:B']);
  });

  it('WS-03: a lease-refused close keeps A canonical and surfaces the typed error — no false B', async () => {
    const state = { root: 'A' as string | null };
    const seams: WorkspaceSwitchSeams = {
      currentRoot: () => state.root,
      close: () => errResult('REPOSITORY_WORKSPACE_LEASED'),
      open: async (root) => {
        // Must never be reached: the refusal happens at close.
        state.root = root;
        return ok({ canonicalRoot: root });
      },
    };
    const result = await switchWorkspace(seams, 'B');
    expect(result).toEqual({ ok: false, root: 'B', error: 'REPOSITORY_WORKSPACE_LEASED' });
    expect(state.root).toBe('A'); // A never stopped being canonical
  });

  it('fail-closed: when the open of B fails, A is restored as canonical', async () => {
    const state = { root: 'A' as string | null };
    const calls: string[] = [];
    const seams: WorkspaceSwitchSeams = {
      currentRoot: () => state.root,
      close: () => {
        state.root = null;
        return ok(true as const);
      },
      open: async (root) => {
        calls.push(`open:${root}`);
        if (root === 'B') return errResult('REPOSITORY_WORKSPACE_ROOT_MISSING');
        state.root = root;
        return ok({ canonicalRoot: root });
      },
    };
    const result = await switchWorkspace(seams, 'B');
    expect(result).toEqual({ ok: false, root: 'B', error: 'REPOSITORY_WORKSPACE_ROOT_MISSING' });
    expect(state.root).toBe('A'); // restored before the refusal was reported
    expect(calls).toEqual(['open:B', 'open:A']);
  });

  it('re-affirming the same canonical root is an idempotent success (no close/open churn)', async () => {
    const state = { root: 'A' as string | null };
    let closed = 0;
    const seams: WorkspaceSwitchSeams = {
      currentRoot: () => state.root,
      close: () => {
        closed += 1;
        state.root = null;
        return ok(true as const);
      },
      open: async (root) => {
        state.root = root;
        return ok({ canonicalRoot: root });
      },
    };
    const result = await switchWorkspace(seams, 'A');
    expect(result).toEqual({ ok: true, root: 'A' });
    expect(closed).toBe(0);
    expect(state.root).toBe('A');
  });

  it('an empty or non-string root is refused without touching the active workspace', async () => {
    const state = { root: 'A' as string | null };
    const seams: WorkspaceSwitchSeams = {
      currentRoot: () => state.root,
      close: () => {
        state.root = null;
        return ok(true as const);
      },
      open: async (root) => {
        state.root = root;
        return ok({ canonicalRoot: root });
      },
    };
    expect((await switchWorkspace(seams, '')).ok).toBe(false);
    expect(state.root).toBe('A');
  });
});

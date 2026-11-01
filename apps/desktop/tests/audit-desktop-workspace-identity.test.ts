/**
 * AUDIT-D14 — workspace identity is canonical: workspaceOpen persists/returns the engine's
 * canonical root, and switchWorkspace treats case / trailing-separator / realpath variants of
 * the active root as the SAME workspace (no close→reopen, no lease refusal on a no-op).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { domainError, err, ok } from '@companyos/core';
import { sameWorkspaceRoot, switchWorkspace, type WorkspaceSwitchSeams } from '../src/workspace-switch.js';

const leasedSeams = (active: string, extra: Partial<WorkspaceSwitchSeams> = {}): { seams: WorkspaceSwitchSeams; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    seams: {
      currentRoot: () => active,
      close: () => { calls.push('close'); return err(domainError('VALIDATION_FAILED', 'leased', { reason: 'REPOSITORY_WORKSPACE_LEASED' })); },
      open: async (root) => { calls.push(`open:${root}`); return ok({ canonicalRoot: root }); },
      ...extra,
    },
  };
};

describe('AUDIT-D14 canonical workspace identity', () => {
  it('a case / trailing-separator variant of the active root on win32 is a no-op returning the canonical root', async () => {
    const { seams, calls } = leasedSeams('C:\\proj', { platform: 'win32' });
    expect(await switchWorkspace(seams, 'c:\\proj\\')).toEqual({ ok: true, root: 'C:\\proj' });
    expect(await switchWorkspace(seams, 'C:/PROJ')).toEqual({ ok: true, root: 'C:\\proj' });
    expect(calls).toEqual([]); // no close under the lease → no refusal
  });

  it('a realpath variant (subst/junction) resolved by the canonicalize seam is the same workspace', async () => {
    const { seams, calls } = leasedSeams('C:\\real\\proj', { platform: 'win32', canonicalize: (p) => (p.toLowerCase() === 'p:\\' ? 'C:\\real\\proj' : null) });
    expect(await switchWorkspace(seams, 'P:\\')).toEqual({ ok: true, root: 'C:\\real\\proj' });
    expect(calls).toEqual([]);
  });

  it('posix stays case-sensitive; prefixes are not identity', () => {
    expect(sameWorkspaceRoot('/home/u/proj/', '/home/u/proj', 'linux')).toBe(true);
    expect(sameWorkspaceRoot('/home/u/Proj', '/home/u/proj', 'linux')).toBe(false);
    expect(sameWorkspaceRoot('C:\\a', 'C:\\ab', 'win32')).toBe(false);
    expect(sameWorkspaceRoot('C:\\', 'c:/', 'win32')).toBe(true);
  });

  it('a genuinely different root still goes through close (and the lease refusal surfaces)', async () => {
    const { seams, calls } = leasedSeams('C:\\proj', { platform: 'win32' });
    expect(await switchWorkspace(seams, 'C:\\other')).toEqual({ ok: false, root: 'C:\\other', error: 'REPOSITORY_WORKSPACE_LEASED' });
    expect(calls).toEqual(['close']);
  });

  it('main.ts workspaceOpen persists and returns the canonical root', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    const start = main.indexOf('CHANNELS.workspaceOpen');
    const block = main.slice(start, main.indexOf('CHANNELS.workspaceSwitch', start));
    expect(block).toContain('opened.value.canonicalRoot');
    expect(block).toContain('{ root: canonicalRoot, selectedAt');
    expect(block).toContain('return { ok: true, root: canonicalRoot }');
    expect(block).not.toContain('return { ok: true, root };');
  });
});

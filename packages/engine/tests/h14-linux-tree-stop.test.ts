// H14 — the Linux tree stop walks /proc parent links, so a grandchild that left the child's
// process group (setsid / detached spawn) is still found. Pure parse test (no processes).
import { describe, expect, it } from 'vitest';
import { linuxDescendantPids } from '../src/repository/repository-process-runner.js';

const procOf = (rows: Record<string, { comm: string; ppid: number }>) => ({
  list: () => ['self', 'cpuinfo', ...Object.keys(rows)],
  stat: (pid: string) => {
    const row = rows[pid];
    if (row === undefined) throw new Error('ENOENT');
    return `${pid} (${row.comm}) S ${String(row.ppid)} ${pid} ${pid} 0 -1 4194560`;
  },
});

describe('linuxDescendantPids', () => {
  it('finds children, grandchildren and a setsid grandchild by parent link, not by group', () => {
    const proc = procOf({
      '100': { comm: 'node', ppid: 1 },
      '200': { comm: 'node', ppid: 100 },
      '300': { comm: 'sleep worker', ppid: 200 },
      '301': { comm: 'weird) S 1 (x', ppid: 200 },
      '400': { comm: 'unrelated', ppid: 1 },
    });
    expect(linuxDescendantPids(100, proc).sort()).toEqual([200, 300, 301]);
    expect(linuxDescendantPids(400, proc)).toEqual([]);
  });
  it('a process that exits between listing and reading is skipped; an unreadable /proc yields none', () => {
    const proc = { list: () => ['100', '200', '999'], stat: (pid: string) => (pid === '999' ? (() => { throw new Error('ENOENT'); })() : `${pid} (n) S ${pid === '200' ? '100' : '1'} 0`) };
    expect(linuxDescendantPids(100, proc)).toEqual([200]);
    expect(linuxDescendantPids(100, { list: () => { throw new Error('EACCES'); }, stat: () => '' })).toEqual([]);
  });
});

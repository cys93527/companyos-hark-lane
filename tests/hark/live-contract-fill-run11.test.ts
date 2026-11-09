/**
 * LIVE-CONTRACT-FILL run 11 (hark-live-goal 42564411429): 5 of 6 steps done and verified, then the goal
 * stopped GOAL_BUDGET_EXHAUSTED on its call guard at CNY 3.16 of 8. The next run must be able to continue
 * that work: the workflow seeds the project folder from a previous run, and CompanyOS tells the kernel
 * which work already exists in its workspace so it reuses it instead of paying to rebuild it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dshTaskTextOf } from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import { workspaceInventoryLineOf, workspaceInventoryOf } from '../../apps/desktop/src/executor/workspace-inventory.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'run11-inv-')); dirs.push(d); return d; };

describe('live contract-fill run 11: continue existing work', () => {
  it('a fresh (empty) workspace adds no line', () => {
    expect(workspaceInventoryLineOf(workspaceInventoryOf(tmp()))).toBeNull();
  });

  it('lists the project files (sorted, sized) and skips dependency stores, caches and VCS data', () => {
    const root = tmp();
    mkdirSync(join(root, 'contractfill', '__pycache__'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'contractfill', 'fields.py'), 'x'.repeat(2048));
    writeFileSync(join(root, 'contractfill', '__pycache__', 'fields.cpython-312.pyc'), 'c');
    writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'm');
    writeFileSync(join(root, '.git', 'HEAD'), 'h');
    writeFileSync(join(root, 'package.json'), '{}');
    const inv = workspaceInventoryOf(root);
    expect(inv.files.map((f) => f.path)).toEqual(['package.json', 'contractfill/fields.py']);
    const line = workspaceInventoryLineOf(inv)!;
    expect(line).toContain('contractfill/fields.py (2.0 KB)');
    expect(line).toMatch(/reuse, extend or fix what exists/u);
    expect(line).toMatch(/never rewrite a working file from scratch/u);
  });

  it('is bounded: a large tree is truncated and says so', () => {
    const root = tmp();
    for (let i = 0; i < 80; i += 1) writeFileSync(join(root, `f${String(i).padStart(3, '0')}.py`), 'p');
    const inv = workspaceInventoryOf(root);
    expect(inv.files).toHaveLength(60);
    expect(inv.truncated).toBe(true);
    expect(workspaceInventoryLineOf(inv)).toMatch(/, and more\. /u);
  });

  it('reaches the kernel task text after the objective, only when given', () => {
    const request = { runId: 'run_1', taskId: 'tsk_1', roleId: 'engineer', work: { objective: 'Step 6: integrate', acceptanceCriteria: [] } } as unknown as Parameters<typeof dshTaskTextOf>[0];
    const line = 'Workspace already contains work from earlier steps, attempts or runs: a.py (1 B).';
    const withLine = dshTaskTextOf(request, { workspaceInventoryLine: line });
    expect(withLine.split('\n')[0]).toBe('Step 6: integrate');
    expect(withLine).toContain(line);
    expect(dshTaskTextOf(request)).not.toContain('Workspace already contains');
  });

  it('the custom workflow can seed the project folder from a verified earlier hark-live-goal run', () => {
    const wf = readFileSync('.github/workflows/hark-live-goal.yml', 'utf8');
    const job = wf.slice(wf.indexOf('  live-goal-custom:'));
    expect(wf).toMatch(/resume_from_run:\n\s+description:/u);
    expect(job).toMatch(/\$r\.path -ne '\.github\/workflows\/hark-live-goal\.yml'/u);
    expect(job).toMatch(/name: hark-live-goal-evidence\n\s+path: resume-evidence\n\s+run-id: \$\{\{ inputs\.resume_from_run \}\}/u);
    expect(job).toMatch(/resume-source\.txt/u);
    // seeding happens before the GUI driver starts the goal
    expect(job.indexOf('Seed the user\'s project folder')).toBeLessThan(job.indexOf('The user\'s goal through the installed GUI'));
    // the id only reaches scripts through env
    const runLines = job.split('\n').filter((l) => !/^\s+(RESUME_RUN|run-id):/u.test(l) && !/^\s+if:/u.test(l)).join('\n');
    expect(runLines).not.toMatch(/inputs\.resume_from_run/u);
  });
});

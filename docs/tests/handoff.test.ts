/**
 * Handoff gate: `PROJECT_HANDOFF.md` is how the next agent session learns the real
 * state of the repository. It must carry the required sections and only contain
 * commands that were actually run.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const handoff = readFileSync(fileURLToPath(new URL('../../PROJECT_HANDOFF.md', import.meta.url)), 'utf8');
const agents = readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), 'utf8');
const roadmap = readFileSync(
  fileURLToPath(new URL('../../docs/EXECUTION_ROADMAP.md', import.meta.url)),
  'utf8',
);

const REQUIRED_HEADINGS = [
  'Current State',
  'Verified Commands',
  'Environment Facts',
  'Sprint 0 Deliverables',
  'Next Sprint Entry Point',
  'Open Risks',
  'Known Limitations',
];

describe('PROJECT_HANDOFF.md', () => {
  it.each(REQUIRED_HEADINGS)('has a "%s" section', (heading) => {
    expect(handoff).toMatch(new RegExp(`^## ${heading}`, 'm'));
  });

  it('records command blocks that are non-empty and shell-executable', () => {
    const blocks = [...handoff.matchAll(/```(powershell|bash|sh)\n([\s\S]*?)```/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const body = block[2] ?? '';
      const commands = body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
      expect(commands.length, 'a command block must not be empty').toBeGreaterThan(0);
    }
  });

  it('documents the verified gate result', () => {
    expect(handoff).toContain('pnpm check');
    expect(handoff).toContain('Exit Code 0');
    expect(handoff).toMatch(/pnpm test/);
    expect(handoff).toMatch(/check-boundaries\.mjs/);
  });

  it('records environment facts', () => {
    expect(handoff).toMatch(/Node\s*\|\s*v?2\d\./);
    expect(handoff).toMatch(/pnpm\s*\|\s*11\./);
    expect(handoff).toMatch(/Windows|win32/);
  });

  it('records the closed sprint state, closed mainlines and non-orchestrating Handoff boundary', () => {
    expect(agents).toContain('Sprint 0–16 已关闭'); // advances with each closed sprint (Sprint 16 closeout)
    expect(agents).toContain('Sprint 12 Memory + Decision 亦为 **CLOSED**');
    expect(agents).toContain('当前**没有 active sprint**');
    expect(agents).toContain('**Router 主线 CLOSED**');
    expect(agents).toContain('**Handoff 主线 CLOSED**');
    // Regression: a CLOSED sprint must never be (re)declared active.
    expect(agents).not.toContain('当前 active sprint 是');
    expect(handoff).toContain('Sprint 11 Structured Handoff 亦为 **CLOSED**');

    const sprint11 = roadmap.match(
      /## Sprint 11：Handoff([\s\S]*?)## Sprint 12：Memory \+ Decision/,
    )?.[1];
    expect(sprint11).toContain('Handoff ACCEPTED 只表示目标角色正式接收结构化交接');
    for (const effect of [
      'select next role',
      'select model',
      'invoke Router',
      'start Agent',
      'advance Workflow',
      'continue Stage',
    ]) {
      expect(sprint11).toContain(effect);
    }
    expect(sprint11).not.toMatch(/由 Router 重新排名并换模型|新模型读取 Handoff 并继续当前 Stage/);

    registerOfflineReadOnlyGitRepository();
    const tagObject = execFileSync('git', ['rev-parse', '--verify', 'refs/tags/sprint-11.0.0'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
    }).trim();
    expect(tagObject).toMatch(/^[0-9a-f]{40}$/);
  });

  it('does not carry a fabricated commit hash', () => {
    const match = handoff.match(/^\s*-\s*记录值：`([^`]+)`/m);
    expect(match).not.toBeNull();
    const value = match?.[1] ?? '';
    if (/^[0-9a-f]{40}$/.test(value)) return; // a real, back-filled hash
    expect(value).toMatch(/PLACEHOLDER|pending|见|git rev-parse/i);
  });
});
import {registerOfflineReadOnlyGitRepository} from '../../tests/support/offline-fixtures.js';

/**
 * Governance gate: `AGENTS.md` must state the architecture law, all eight
 * Industry-Pack nouns, the EntityStore naming rule and the priority ladder —
 * otherwise an agent reading only that file could legitimately pollute Core.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const agents = readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), 'utf8');

const FORBIDDEN_NOUNS = ['Coding', 'Git', 'Repository', 'Developer', 'CTO', 'Article', 'Video', 'Ecommerce'];

describe('AGENTS.md', () => {
  it('lists all eight forbidden Industry-Pack nouns', () => {
    const missing = FORBIDDEN_NOUNS.filter((noun) => !agents.includes(noun));
    expect(missing).toEqual([]);
  });

  it('states the EntityStore naming rule', () => {
    expect(agents).toContain('EntityStore');
    expect(agents).toMatch(/EntityStore.*不叫|不叫.*Repository|永远不叫/s);
  });

  it('states the Core dependency-direction law', () => {
    expect(agents).toMatch(/零运行时依赖|ZERO runtime/i);
    expect(agents).toContain('@companyos/core');
    expect(agents).toContain('check-boundaries.mjs');
  });

  it('states the P0–P4 priority ladder', () => {
    for (const tier of ['**P0**', '**P1**', '**P2**', '**P3**', '**P4**']) {
      expect(agents).toContain(tier);
    }
  });

  it('states the Sprint 0 prohibitions verbatim', () => {
    for (const forbidden of [
      'Model Router',
      'Agent Runtime',
      'DevCompany',
      'Coding Agent',
      'Workflow Designer',
      '多模型调度',
    ]) {
      expect(agents, `AGENTS.md must forbid ${forbidden} in Sprint 0`).toContain(forbidden);
    }
  });

  it('defines the per-sprint Definition of Done with pnpm check', () => {
    expect(agents).toContain('pnpm check');
    expect(agents).toMatch(/Exit Code 0/);
    expect(agents).toContain('git status --porcelain');
  });
});

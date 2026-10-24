/**
 * Sprint 5 STEP 6 — architecture boundary tests for the Designer (O and P).
 *
 * What is asserted:
 *   O. the renderer never imports SQLite or any storage package;
 *   P. the renderer never re-implements lifecycle/domain rules (no second truth source);
 *   the IPC surface has exactly one workflow channel, and every request goes through
 *      `parseWorkflowRequest` before touching the lifecycle service.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { expectedChainsRegex, sourceWithoutComments } from '../shared/expected-chains.js';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const sourceFiles = (dir: string): readonly string[] => {
  const walk = (current: string): readonly string[] =>
    readdirSync(current).flatMap((entry) => {
      const full = join(current, entry);
      return statSync(full).isDirectory()
        ? walk(full)
        : ['.ts', '.tsx', '.js', '.jsx'].includes(extname(full))
          ? [full]
          : [];
    });
  return walk(repo(dir));
};

const codeOnly = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const readAll = (dir: string): string =>
  sourceFiles(dir)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

describe('O. the renderer has no storage access', () => {
  it('never imports SQLite, persistence or the engine internals', () => {
    const raw = readAll('apps/renderer/src');
    const code = codeOnly(raw);
    expect(code).not.toMatch(/node:sqlite/);
    expect(code).not.toMatch(/@companyos\/persistence/);
    expect(code).not.toMatch(/@companyos\/engine/);
    expect(code).not.toMatch(/\bSELECT\b/);
    expect(code).not.toMatch(/CREATE TABLE/i);
    // No direct Electron/node escape hatches either.
    expect(code).not.toMatch(/require\('electron'\)/);
    expect(code).not.toMatch(/\bipcRenderer\b/);
    expect(code).not.toMatch(/from 'node:/);
  });

  it('only talks to the main process through the preload bridge', () => {
    const raw = readAll('apps/renderer/src');
    // The bridge key is the single door: no fetch/XHR/WebSocket side channel.
    expect(raw).toMatch(/companyos/);
    expect(codeOnly(raw)).not.toMatch(/\bfetch\(/);
    expect(codeOnly(raw)).not.toMatch(/new WebSocket/);
  });
});

describe('P. the renderer holds no lifecycle rules (state comes from the service)', () => {
  it('does not re-implement the lifecycle state machine', () => {
    const code = codeOnly(readAll('apps/renderer/src'));
    // Reading a state that came over IPC is fine - deciding transitions is not.
    expect(code).not.toMatch(/canTransition|nextState\s*\(|allowedEvents|TRANSITIONS/);
    expect(code).not.toMatch(/applyRunEvent|openRevision|publishRevision|saveDraftGraph/);
    // No client-side permission or risk policy either.
    expect(code).not.toMatch(/RISK_LEVELS|APPROVAL_MODES|assertEditable/);
  });

  it('the renderer model is a pure projection of the IPC response', () => {
    const model = readFileSync(repo('apps/renderer/src/designer-model.ts'), 'utf8');
    expect(model).toMatch(/export function toLibraryRows/);
    expect(model).toMatch(/export function toDesignerView/);
    // Purity: no IO, no timers, no randomness in the projection layer.
    const code = codeOnly(model);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/setTimeout|setInterval/);
  });
});

describe('the IPC surface is one channel with one validated entry point', () => {
  it('declares exactly one workflow channel and allow-lists it', () => {
    const channels = readFileSync(repo('apps/desktop/src/channels.ts'), 'utf8');
    expect(channels).toMatch(/workflow: 'companyos:workflow'/);
    expect(channels).toMatch(/CHANNELS\.workflow/);

    const preload = readFileSync(repo('apps/desktop/preload/preload.cjs'), 'utf8');
    expect(preload).toContain("'companyos:workflow'");
    expect(preload).toMatch(/workflowRequest: \(request\) => invoke\('companyos:workflow', request\)/);
  });

  it('routes every request through parseWorkflowRequest', () => {
    const api = readFileSync(repo('apps/desktop/src/workflows.ts'), 'utf8');
    const handleBody = api.slice(api.indexOf('async handle(raw: unknown)'));
    expect(handleBody.indexOf('parseWorkflowRequest(raw)')).toBeGreaterThanOrEqual(0);
    expect(handleBody.indexOf('parseWorkflowRequest(raw)')).toBeLessThan(
      handleBody.indexOf('switch (operation)'),
    );
  });

  it('never lets the desktop layer reach SQLite directly', () => {
    // The application layer composes the lifecycle service; SQL stays in persistence.
    const code = codeOnly(readFileSync(repo('apps/desktop/src/workflows.ts'), 'utf8'));
    expect(code).not.toMatch(/node:sqlite/);
    expect(code).not.toMatch(/\bSELECT\b/);
    expect(code).not.toMatch(/CREATE TABLE/i);
    // …and the ONLY durable handle is opened in main.ts, with every chain on
    // (Sprint 6 added provider, Sprint 7 registry, Sprint 7.5 selection, Sprint 8 agent).
    // Comments are stripped first so the guard bites the executable chain list,
    // not a frozen comment (post-Sprint-12 reconciliation).
    const main = readFileSync(repo('apps/desktop/src/main.ts'), 'utf8');
    expect(sourceWithoutComments(main)).toMatch(
      expectedChainsRegex(),
    );
    expect(main.match(/openDurableDatabase\(/g) ?? []).toHaveLength(1);
  });
});

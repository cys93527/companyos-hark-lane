/**
 * Sprint26 — the RENDERER TRUST BOUNDARY (Boss §9/§34/§53).
 *
 * The renderer is untrusted. These probes prove the boundary structurally
 * (source-level import bans), operationally (the mutation surface is exactly the
 * four typed commands, including ADR-0032 cancellation) and response-wise (no secret, no provider environment, no
 * raw credential can appear in a control-plane response).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONTROL_PLANE_OPERATIONS,
  createControlPlaneService,
  GOAL_WORK_KIND,
} from '../../apps/desktop/src/control-plane.js';

const rendererSources = readdirSync(join(process.cwd(), 'apps/renderer/src')).map((file) =>
  readFileSync(join(process.cwd(), 'apps/renderer/src', file), 'utf8'),
);

/** §53-1/2/3: the renderer never imports persistence, SQLite, providers or domain writers. */
const FORBIDDEN_RENDERER_IMPORTS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /@companyos\/persistence/, why: 'renderer must not touch the durable layer' },
  { pattern: /better-sqlite3/, why: 'renderer must not open SQLite' },
  { pattern: /node:sqlite/, why: 'renderer must not open SQLite' },
  { pattern: /@companyos\/engine/, why: 'renderer must not import domain services' },
  { pattern: /apps\/desktop\/src\/executor/, why: 'renderer must not reach provider adapters' },
  { pattern: /dsh-executor-provider/, why: 'renderer must not reach provider adapters' },
  { pattern: /child_process/, why: 'renderer must not spawn processes' },
];

describe('S26 renderer trust boundary (§9/§34)', () => {
  it('1/2/3. renderer sources contain no persistence/SQLite/provider/domain import', () => {
    for (const source of rendererSources) {
      for (const ban of FORBIDDEN_RENDERER_IMPORTS) {
        expect(source.match(ban.pattern) ?? [], `${ban.pattern} (${ban.why})`).toEqual([]);
      }
    }
  });

  it('4. the mutation surface is EXACTLY the four typed commands; everything else is read-only', () => {
    const mutating = CONTROL_PLANE_OPERATIONS.filter(
      (operation) =>
        operation.startsWith('goal.create') ||
        operation.startsWith('goal.advance') ||
        operation.startsWith('goal.cancel') ||
        operation.startsWith('approval.'),
    );
    expect(mutating.sort()).toEqual(['approval.respond', 'goal.advance', 'goal.cancel', 'goal.create']);
    // Every other operation is a projection by naming contract.
    for (const operation of CONTROL_PLANE_OPERATIONS) {
      if (mutating.includes(operation as never)) continue;
      expect(
        operation.startsWith('run.') || operation.startsWith('home.') || operation.startsWith('goal.workspace') || operation.startsWith('decisions.'),
        `${operation} is neither a typed command nor an obvious read`,
      ).toBe(true);
    }
  });

  it('there is NO control-plane operation for workspace, provider, secret or SQL (§22-24/§34)', () => {
    const joined = CONTROL_PLANE_OPERATIONS.join(' ');
    for (const forbidden of ['workspace.open', 'provider.', 'secret.', 'sql', 'spawn', 'file.']) {
      expect(joined.includes(forbidden), `${forbidden} must not be an operation`).toBe(false);
    }
  });

  it('22/23. no control-plane response can carry provider environment or secret-shaped fields', async () => {
    // A service over minimal deps: even a total read failure answers typed errors —
    // the envelope has exactly { ok, value?, error? } and error carries no env/secret.
    const service = createControlPlaneService({
      companyId: 'company_default',
      actorId: 'user_owner',
      clock: { nowIso: () => '2026-01-01T00:00:00.000Z' },
      ids: { id: (prefix: string) => `${prefix}_x` },
      currentWorkspace: () => null,
      tasks: { listByRun: () => Promise.resolve([]) },
      runs: {
        get: () => Promise.resolve(null),
        list: () => Promise.resolve({ items: [], total: 0 }),
      },
      templates: { list: () => Promise.resolve({ items: [], total: 0 }) },
      lifecycle: {
        createTemplate: () => Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }),
        saveDraftGraph: () => Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }),
        publish: () => Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }),
        createRun: () => Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }),
      },
      engine: {
        drive: () => Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }),
        dispatch: () => Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }),
      },
      materializer: null,
      planner: null,
      compiler: null,
      supervisor: null,
      observation: null,
      runGoal: null,
      artifacts: {
        listByRun: () => Promise.resolve([]),
        getByCreationCommand: () => Promise.resolve(null),
        commandIdOf: () => Promise.resolve(null),
        readContent: () => Promise.resolve(null),
      },
      workProfile: { stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 3 },
    });
    for (const operation of CONTROL_PLANE_OPERATIONS) {
      const envelope = (await service.handle({ operation, payload: { companyId: 'company_default', runId: 'run_x', taskId: 'tsk_x', objective: 'o', commandId: 'c', decision: 'approve' } })) as {
        readonly error?: { readonly message: string };
      };
      const serialized = JSON.stringify(envelope);
      expect(serialized.includes('process.env')).toBe(false);
      expect(serialized.match(/sk-[A-Za-z0-9]{8,}/) ?? []).toEqual([]);
    }
  });

  it('25. a read failure cannot mutate workflow state (UI failure is not workflow failure)', async () => {
    // The boundary proof: a read operation has NO write seam at all — its deps here
    // are read-only fakes; nothing exists to mutate. The invariant is structural:
    // reads touch runs/templates/artifacts reads only.
    const touched: string[] = [];
    const service = createControlPlaneService({
      companyId: 'company_default',
      actorId: 'user_owner',
      clock: { nowIso: () => '2026-01-01T00:00:00.000Z' },
      ids: { id: (prefix: string) => `${prefix}_x` },
      currentWorkspace: () => null,
      tasks: { listByRun: () => Promise.resolve([]) },
      runs: {
        get: (runId: string) => {
          touched.push(`runs.get:${runId}`);
          return Promise.resolve(null);
        },
        list: () => {
          touched.push('runs.list');
          return Promise.resolve({ items: [], total: 0 });
        },
      },
      templates: { list: () => Promise.resolve({ items: [], total: 0 }) },
      lifecycle: {
        createTemplate: () => { touched.push('createTemplate'); return Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }); },
        saveDraftGraph: () => { touched.push('saveDraftGraph'); return Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }); },
        publish: () => { touched.push('publish'); return Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }); },
        createRun: () => { touched.push('createRun'); return Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }); },
      },
      engine: {
        drive: () => { touched.push('engine.drive'); return Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }); },
        dispatch: () => { touched.push('engine.dispatch'); return Promise.resolve({ ok: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'x', details: {} } as never }); },
      },
      materializer: null,
      planner: null,
      compiler: null,
      supervisor: null,
      observation: null,
      runGoal: null,
      artifacts: {
        listByRun: () => Promise.resolve([]),
        getByCreationCommand: () => Promise.resolve(null),
        commandIdOf: () => Promise.resolve(null),
        readContent: () => Promise.resolve(null),
      },
      workProfile: { stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 3 },
    });
    await service.handle({ operation: 'run.overview', payload: { companyId: 'company_default', runId: 'run_x' } });
    await service.handle({ operation: 'home.summary', payload: { companyId: 'company_default' } });
    // Only READS fired; no write seam was touched.
    expect(touched.every((entry) => entry.startsWith('runs.get') || entry.startsWith('runs.list'))).toBe(true);
  });
});

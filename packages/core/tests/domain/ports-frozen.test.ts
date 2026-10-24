/**
 * Sprint 1 Task 7: the port boundary is FROZEN (ADR-0002) — 11 ports, contract-only
 * files stay free of runtime exports, and Core stays dependency-free.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as core from '@companyos/core';

const repo = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const read = (path: string): string => readFileSync(repo(path), 'utf8');

/** The frozen port set (ADR-0002 §2). */
const FROZEN_PORTS = [
  { name: 'Clock', file: 'clock.ts' },
  { name: 'IdFactory', file: 'id-factory.ts' },
  { name: 'Logger', file: 'logger.ts' },
  { name: 'EventBus', file: 'event-bus.ts' },
  { name: 'EntityStore', file: 'store.ts' },
  { name: 'MigrationRunner', file: 'store.ts' },
  { name: 'SecretResolver', file: 'secrets.ts' },
  { name: 'ModelGateway', file: 'model-gateway.ts' },
  { name: 'AgentRuntimePort', file: 'agent-runtime.ts' },
  { name: 'WorkflowEnginePort', file: 'workflow-engine.ts' },
  { name: 'EventStorePort', file: 'event-store.ts' },
] as const;

/** Files that must remain types-only (no runtime value the outer ring could import). */
const CONTRACT_ONLY_FILES = [
  'model-gateway.ts',
  'agent-runtime.ts',
  'workflow-engine.ts',
  'event-store.ts',
] as const;

describe('frozen port boundary', () => {
  it('ships exactly the 11 documented port modules', () => {
    expect(FROZEN_PORTS).toHaveLength(11);
    for (const port of FROZEN_PORTS) {
      expect(existsSync(repo(`packages/core/src/ports/${port.file}`)), port.file).toBe(true);
    }
    const adr = read('docs/adr/0002-core-domain-and-port-freeze.md');
    for (const port of FROZEN_PORTS) {
      expect(adr, `ADR-0002 must freeze ${port.name}`).toContain(port.name);
    }
    expect(adr).toContain('23');
    expect(adr).toContain('11');
  });

  it('keeps every contract-only port free of runtime exports', () => {
    for (const file of CONTRACT_ONLY_FILES) {
      const source = read(`packages/core/src/ports/${file}`);
      const runtimeExports = [...source.matchAll(/^export\s+(class|function|const|let|async)\b/gm)];
      expect(runtimeExports.map((match) => match[0]), `${file} must be types-only`).toEqual([]);
    }
  });

  it('keeps @companyos/core free of runtime dependencies', () => {
    const manifest = JSON.parse(read('packages/core/package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.devDependencies ?? {}).toEqual({});
  });

  it('exports the Sprint 1 base types and domain models', () => {
    const required = [
      'brand',
      'unbrand',
      'makeId',
      'DOMAIN_ID_PREFIX',
      'domainError',
      'CORE_CONCEPTS',
      'CORE_CONCEPT_COUNT',
      'createCompany',
      'createPackInstallation',
      'createWorkflow',
      'createWorkflowRun',
      'RUN_STATES',
      'nextRunState',
      'createStage',
      'createTask',
      'createRole',
      'createAgent',
      'createArtifact',
      'createValidation',
      'requestApproval',
      'createCoreDomainEvent',
      'CORE_DOMAIN_EVENT_TYPES',
    ] as const;
    for (const symbol of required) {
      expect(Object.hasOwn(core, symbol), `${symbol} must be exported`).toBe(true);
    }
    expect(Object.keys(core).length).toBeGreaterThan(80);
  });

  it('exposes the canonical id prefixes for every aggregate', () => {
    expect(core.DOMAIN_ID_PREFIX.company).toBe('cmp');
    expect(core.DOMAIN_ID_PREFIX.workflow).toBe('wfl');
    expect(core.DOMAIN_ID_PREFIX.stage).toBe('stg');
    expect(core.DOMAIN_ID_PREFIX.task).toBe('tsk');
    expect(core.DOMAIN_ID_PREFIX.agent).toBe('agt');
    expect(core.DOMAIN_ID_PREFIX.artifact).toBe('art');
    expect(core.DOMAIN_ID_PREFIX.validation).toBe('val');
    expect(core.DOMAIN_ID_PREFIX.approval).toBe('apr');
    expect(core.hasIdPrefix('task', 'tsk_01J')).toBe(true);
    expect(core.hasIdPrefix('task', 'tpl_01J')).toBe(false);
  });
});

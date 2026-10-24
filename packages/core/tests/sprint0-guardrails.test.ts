/**
 * Sprint 0 guardrails — executable proof that the execution directive's
 * prohibitions are respected:
 *
 *   FORBIDDEN in Sprint 0: Model Router · Agent Runtime · DevCompany ·
 *   Coding Agent · Workflow Designer · 多模型调度.
 *
 * A failing assertion here means somebody started a later sprint early, or
 * leaked a vertical concept into Core.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as core from '@companyos/core';

const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

describe('Sprint 0 scope guardrails', () => {
  it('ships no implementation for the forbidden Sprint 0 capabilities', () => {
    const forbidden = [
      'packages/model-router',
      'packages/agent-runtime',
      'packages/dev-company',
      'packages/coding-agent',
      'packages/workflow-designer',
      'packages/core/src/router',
      'packages/core/src/runtime',
      'packages/core/src/designer',
    ];
    for (const path of forbidden) {
      expect(existsSync(root(path)), `${path} must NOT exist in Sprint 0`).toBe(false);
    }
  });

  it('exposes the model gateway and agent runtime as TYPES ONLY (no runtime values)', () => {
    for (const file of [
      'packages/core/src/ports/model-gateway.ts',
      'packages/core/src/ports/agent-runtime.ts',
    ]) {
      const source = readFileSync(root(file), 'utf8');
      const runtimeExports = [...source.matchAll(/^export\s+(class|function|const|let|async)\b/gm)];
      expect(runtimeExports.map((m) => m[0]), `${file} must contain no runtime export`).toEqual([]);
    }
  });

  it('keeps @companyos/core free of runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(root('packages/core/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.devDependencies ?? {}).toEqual({});
  });

  it('resolves every industry-noun capability through the pack contract, not through Core', () => {
    const publicApi = Object.keys(core);
    const offenders = publicApi.filter((name) =>
      /^(coding|git|repository|developer|cto|article|video|ecommerce)/i.test(name),
    );
    expect(offenders).toEqual([]);
    // The Core public surface must still be substantial enough to be usable.
    expect(publicApi.length).toBeGreaterThan(50);
  });

  it('exposes all ten lifecycle capabilities through the public API', () => {
    const required = [
      'createWorkflowTemplate',
      'publishInitialVersion',
      'publishRevision',
      'openRevision',
      'forkTemplate',
      'deprecateTemplate',
      'archiveTemplate',
      'createWorkflowVersion',
      'createRunSnapshot',
      'createTemplateLock',
      'openChangeProposal',
      'computeWorkflowMetrics',
    ];
    for (const symbol of required) {
      expect(Object.hasOwn(core, symbol), `${symbol} must be exported by @companyos/core`).toBe(true);
    }
  });
});

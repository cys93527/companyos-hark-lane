/**
 * AUDIT-E5: the supervisor EXECUTING gate completed a run when every task was terminal and ONE task anywhere was
 * DONE, so a FAILED / never-materialized stage could pass into REVIEWING. Both seams now share one predicate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { executionDomainVerdict } from '../src/execution-domain.js';

const t = (stageId: string, state: string) => ({ stageId, state });

describe('AUDIT-E5 one execution-domain rule', () => {
  it('complete only when every stage has >= 1 DONE and nothing open', () => {
    expect(executionDomainVerdict(['A', 'B'], [t('A', 'DONE'), t('B', 'DONE'), t('B', 'FAILED')])).toEqual({ kind: 'complete' });
  });
  it('the old divergence: A DONE + B FAILED is failed (EXECUTION.FAIL), not complete', () => {
    expect(executionDomainVerdict(['A', 'B'], [t('A', 'DONE'), t('B', 'FAILED')])).toEqual({ kind: 'failed', stageIds: ['B'] });
    expect(executionDomainVerdict(['A', 'B'], [t('A', 'DONE'), t('B', 'CANCELLED'), t('B', 'SKIPPED')])).toEqual({ kind: 'failed', stageIds: ['B'] });
  });
  it('a stage without tasks or with an open task keeps the domain open', () => {
    expect(executionDomainVerdict(['A', 'B'], [t('A', 'DONE')])).toEqual({ kind: 'open' });
    expect(executionDomainVerdict(['A', 'B'], [t('A', 'DONE'), t('B', 'RUNNING')])).toEqual({ kind: 'open' });
    expect(executionDomainVerdict(['A', 'B'], [t('A', 'FAILED'), t('B', 'READY')])).toEqual({ kind: 'open' });
  });
  it('engine and supervisor both use it; the supervisor fails a terminal-without-DONE domain', () => {
    const engine = readFileSync(join(__dirname, '../src/engine.ts'), 'utf8');
    const sup = readFileSync(join(__dirname, '../src/supervisor/autonomous-supervisor.ts'), 'utf8');
    expect(engine).toContain("executionDomainVerdict(graph.value.nodes.map((node) => String(node.id)), tasks).kind === 'complete'");
    expect(sup).toContain('const verdict = executionDomainVerdict(nodes.map((node) => String(node.id)), runTasks);');
    expect(sup).toContain("type: complete ? 'EXECUTION.COMPLETE' : 'EXECUTION.FAIL'");
    expect(sup).not.toContain("const anyDone = inGraph.some((task) => task.state === 'DONE');");
  });
});

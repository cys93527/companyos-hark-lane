/**
 * Shared fixtures for the Core Domain suite. Not a test file itself.
 *
 * Capability namespaces are deliberately NEUTRAL (`pack-a:*`): Core tests must not
 * depend on a particular vertical (review finding NIT-3).
 */
import { FixedClock, SequenceIdFactory, type DomainError, type Result } from '@companyos/core';

export const EPOCH = Date.parse('2026-03-01T00:00:00.000Z');

export const makeClock = (): FixedClock => new FixedClock(EPOCH);
export const makeIds = (): SequenceIdFactory => new SequenceIdFactory();
export const nowIso = (offsetMs = 0): string => new Date(EPOCH + offsetMs).toISOString();

/** Unwrap a Result, failing the test with the domain error when it is an error. */
export function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** Unwrap the error side of a Result. */
export function expectErr<T>(result: Result<T, DomainError>): DomainError {
  if (result.ok) throw new Error('expected a domain error, got ok');
  return result.error;
}

/** A valid, neutral pack manifest for installation tests. */
/** Canonical (ADR-0024) pack fixture: industry-neutral, canonical field names. */
export const packManifestFixture = () => ({
  manifestVersion: 1,
  packId: 'pack-a',
  packVersion: '1.0.0',
  name: 'Pack A',
  coreApi: '1',
  capabilities: [
    { id: 'pack-a:build', description: 'run the build', approval: 'none' as const },
    { id: 'pack-a:deploy', description: 'deploy', approval: 'required' as const },
  ],
  dependsOn: [],
  declarations: {
    roles: [{ key: 'pack-a:reviewer', label: 'Reviewer', authorityRefs: ['workflow.review'] }],
    workflowTemplates: [{
      key: 'pack-a:feature', name: 'Feature flow', description: '',
      graph: { nodes: [{ id: 's1', kind: 'work', title: 'Work', config: {} }], edges: [] },
    }],
    prompts: [{ key: 'pack-a:summary', template: 'Summarize.', version: null }],
    tools: [{ key: 'pack-a:fs', toolId: 'tool.filesystem', capability: null }],
    validators: [{ key: 'pack-a:unit', validatorId: 'tool.unittest' }],
    artifacts: [{ key: 'pack-a:diff', label: 'Diff', description: '' }],
    riskRules: [{ key: 'pack-a:high-risk', riskLevel: 'HIGH', description: '' }],
    capabilityRules: [{ key: 'pack-a:needs-fs', requires: [], exposes: [] }],
    templates: [{ key: 'pack-a:document-template', kind: 'some-type', content: { title: 'x' } }],
  },
});

import { describe, expect, it } from 'vitest';

import {
  interpretIsolationStatus,
  isolationDispatchDecision,
} from '../../apps/desktop/src/executor/isolation/isolation-status.js';

/*
 * H16b: the start-time check reads the elevated helper's status line. Configured-but-broken
 * isolation must refuse dispatch (ISOLATION_DEGRADED); only "never configured" may launch
 * unisolated, and then visibly labelled. Anything malformed fails closed.
 */
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const ok = JSON.stringify({ state: 'ISOLATED', account: 'CompanyOSAgentab12cd', sid: SID, brokerPort: 47811, workspaceDirs: ['C:\\Users\\u\\Documents\\CompanyOS'], problems: [] });

describe('H16b isolation status', () => {
  it('ISOLATED with a consistent exit code launches as the agent account', () => {
    const s = interpretIsolationStatus(0, `\uFEFF${ok}\r\n`);
    expect(s.state).toBe('ISOLATED');
    expect(isolationDispatchDecision(s)).toEqual({ kind: 'launch-isolated', account: 'CompanyOSAgentab12cd', sid: SID, brokerPort: 47811, workspaceDirs: ['C:\\Users\\u\\Documents\\CompanyOS'] });
  });

  it('NOT_CONFIGURED launches unisolated with the visible label', () => {
    const s = interpretIsolationStatus(2, JSON.stringify({ state: 'NOT_CONFIGURED', problems: [] }));
    expect(isolationDispatchDecision(s)).toEqual({ kind: 'launch-unisolated', label: '未隔离' });
  });

  it('a degraded report refuses dispatch and keeps every problem', () => {
    const s = interpretIsolationStatus(2, JSON.stringify({ state: 'ISOLATION_DEGRADED', problems: ['wfp:filterV6:missing(0x80320003)', 'acl:missing:Allow:Modify:C:\\w'] }));
    expect(isolationDispatchDecision(s)).toEqual({
      kind: 'refuse', reasonCode: 'ISOLATION_DEGRADED', problems: ['wfp:filterV6:missing(0x80320003)', 'acl:missing:Allow:Modify:C:\\w'],
    });
  });

  it.each([
    ['no output', 1, ''],
    ['garbage', 0, '{not json'],
    ['ISOLATED but exit 2', 2, ok],
    ['ISOLATED but problems', 0, JSON.stringify({ ...JSON.parse(ok), problems: ['x'] })],
    ['bad sid', 0, JSON.stringify({ ...JSON.parse(ok), sid: 'S-1-1-0' })],
    ['privileged port', 0, JSON.stringify({ ...JSON.parse(ok), brokerPort: 80 })],
    ['NOT_CONFIGURED but exit 1', 1, JSON.stringify({ state: 'NOT_CONFIGURED', problems: [] })],
    ['unknown state', 0, JSON.stringify({ state: 'MAYBE', problems: [] })],
    ['degraded without problems', 2, JSON.stringify({ state: 'ISOLATION_DEGRADED', problems: [] })],
  ])('fails closed: %s', (_name, code, out) => {
    const s = interpretIsolationStatus(code, out);
    expect(s.state).toBe('ISOLATION_DEGRADED');
    expect(isolationDispatchDecision(s).kind).toBe('refuse');
  });

  it('H16b-3b: an ISOLATED report without granted workspace roots fails closed', () => {
    for (const workspaceDirs of [undefined, [], [''], [42]]) {
      const raw = { ...JSON.parse(ok), workspaceDirs };
      const s = interpretIsolationStatus(0, JSON.stringify(raw));
      expect(s.state).toBe('ISOLATION_DEGRADED');
      expect(s.problems).toEqual(['status:workspaceDirsMissing']);
    }
  });
});

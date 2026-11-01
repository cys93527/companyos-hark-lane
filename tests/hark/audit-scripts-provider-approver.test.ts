import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isValidSetupApprover, readProviderSetupProfile, writeProviderSetup } from '../../apps/desktop/src/provider-setup-write.js';
import { readDeploymentBudgetApproval } from '../../apps/desktop/src/deployment-budget-proof.js';

/*
 * AUDIT-S10/D11: approvedBy ($env:USERNAME) was limited to letters/digits/' ._@$-', so setup always failed for valid
 * Windows account names with an apostrophe, parentheses, '#', '&', '!', '~', braces or combining marks.
 */
const PROFILE = readProviderSetupProfile(join(__dirname, '../../scripts/hark/setup/provider-profile.json'));
const fresh = (): string => mkdtempSync(join(tmpdir(), 'audit-s10-'));

describe('AUDIT-S10 setup approver accepts every valid Windows account name', () => {
  const valid = ["O'Brien", 'dev(2)', 'team#1', 'a&b', 'wow!', 'x~y', '{svc}', 'राहुल', 'สมศักดิ์', '张三', 'user@corp', 'Ana María', 'a.b-c_d$', 'x'.repeat(128)];
  it.each(valid)('writes and reads back approvedBy %s', (name) => {
    const ud = fresh();
    writeProviderSetup({ userDataDir: ud, profile: PROFILE, capCny: 1, approvedBy: name });
    expect(readDeploymentBudgetApproval(join(ud, 'budget'))?.approvedBy).toBe(name);
  });

  const invalid = ['', 'x'.repeat(129), 'bad"name', 'a/b', 'a\\b', 'a[b', 'a]b', 'a:b', 'a;b', 'a|b', 'a=b', 'a,b', 'a+b', 'a*b', 'a?b', 'a<b', 'a>b',
    'tab\there', 'nl\nx', 'del\u007f', 'c1\u0085', '...', ' . ', 42, null];
  it.each(invalid.map((v) => [JSON.stringify(v), v] as const))('refuses %s', (_label, v) => {
    expect(isValidSetupApprover(v)).toBe(false);
  });

  it('a refused approver throws before writing anything', () => {
    const ud = fresh();
    expect(() => writeProviderSetup({ userDataDir: ud, profile: PROFILE, capCny: 1, approvedBy: 'a|b' })).toThrow(/local account/u);
    expect(existsSync(join(ud, 'provider'))).toBe(false);
    expect(existsSync(join(ud, 'budget'))).toBe(false);
  });
});

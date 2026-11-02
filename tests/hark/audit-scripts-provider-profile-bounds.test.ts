import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseProviderSetupProfile, readProviderSetupProfile, SETUP_PROFILE_CAP_BOUNDS, writeProviderSetup } from '../../apps/desktop/src/provider-setup-write.js';
import { readDeploymentBudgetApproval } from '../../apps/desktop/src/deployment-budget-proof.js';

/*
 * AUDIT-D12: the profile parser accepted budget values the app's approval parser refuses (maxCalls > 1000,
 * maxTokens > 1e8, durationMs > 1 day); setup then failed its read-back verify and left the new model.json, proof and
 * approval half-written over the user's previous setup. Now the bounds are identical (parity pinned here at min-1, min,
 * max, max+1) and a failed write restores the previous files and removes the new proof.
 */
const PROFILE_PATH = join(__dirname, '../../scripts/hark/setup/provider-profile.json');
const PROFILE = readProviderSetupProfile(PROFILE_PATH);
const RAW = JSON.parse(readFileSync(PROFILE_PATH, 'utf8')) as Record<string, unknown>;
const fresh = (): string => mkdtempSync(join(tmpdir(), 'audit-d12-'));

/** Whether the app's approval parser accepts an approval with these cap values (otherwise exactly what setup writes). */
const approvalAccepts = (cap: { maxCalls: number; maxTokens: number; durationMs: number }): boolean => {
  const ud = fresh();
  writeProviderSetup({ userDataDir: ud, profile: PROFILE, capCny: 1, approvedBy: 'alice' });
  const path = join(ud, 'budget', 'approvals.json');
  const a = JSON.parse(readFileSync(path, 'utf8')) as { cap: Record<string, number> };
  a.cap = { ...a.cap, ...cap };
  writeFileSync(path, JSON.stringify(a));
  return readDeploymentBudgetApproval(join(ud, 'budget')) !== null;
};

describe('AUDIT-D12 provider profile cap bounds = approval parser bounds', () => {
  const base = { maxCalls: PROFILE.maxCalls, maxTokens: PROFILE.maxTokens, durationMs: PROFILE.durationMs };
  for (const field of ['maxCalls', 'maxTokens', 'durationMs'] as const) {
    const b = SETUP_PROFILE_CAP_BOUNDS[field];
    it.each([b.min - 1, b.min, b.max, b.max + 1])(`${field}=%d: profile and approval parser agree`, (v) => {
      const profileOk = parseProviderSetupProfile({ ...RAW, [field]: v }) !== null;
      expect(profileOk).toBe(approvalAccepts({ ...base, [field]: v }));
      expect(profileOk).toBe(v >= b.min && v <= b.max);
    });
  }

  it('a profile at every max writes a setup the app reads back', () => {
    const ud = fresh();
    const profile = { ...PROFILE, maxCalls: 1_000, maxTokens: 100_000_000, durationMs: 86_400_000 };
    writeProviderSetup({ userDataDir: ud, profile, capCny: 100, approvedBy: 'alice' });
    expect(readDeploymentBudgetApproval(join(ud, 'budget'))?.cap).toEqual({ maxCalls: 1_000, maxTokens: 100_000_000, maxCostMicros: 100_000_000, durationMs: 86_400_000 });
  });
});

describe('AUDIT-D12 a failed setup write leaves the previous setup intact', () => {
  it('restores model.json/approvals.json and removes the new proof', () => {
    const ud = fresh();
    writeProviderSetup({ userDataDir: ud, profile: PROFILE, capCny: 2, approvedBy: 'alice', now: Date.now() - 10_000 });
    const modelPath = join(ud, 'provider', 'model.json');
    const approvalPath = join(ud, 'budget', 'approvals.json');
    const before = { model: readFileSync(modelPath), approval: readFileSync(approvalPath), proofs: readdirSync(join(ud, 'budget', 'proofs')).sort() };
    // the approval write fails (its temp path is occupied by a directory) after model.json and the proof were written
    mkdirSync(`${approvalPath}.tmp-${process.pid}`);
    expect(() => writeProviderSetup({ userDataDir: ud, profile: PROFILE, capCny: 7, approvedBy: 'alice' })).toThrow();
    expect(readFileSync(modelPath)).toEqual(before.model);
    expect(readFileSync(approvalPath)).toEqual(before.approval);
    expect(readdirSync(join(ud, 'budget', 'proofs')).sort()).toEqual(before.proofs);
    expect(readDeploymentBudgetApproval(join(ud, 'budget'))?.cap.maxCostMicros).toBe(2_000_000);
  });

  it('a first-time setup that fails leaves no model.json, approval or proof behind', () => {
    const ud = fresh();
    mkdirSync(join(ud, 'budget'), { recursive: true });
    mkdirSync(join(ud, 'budget', `approvals.json.tmp-${process.pid}`));
    expect(() => writeProviderSetup({ userDataDir: ud, profile: PROFILE, capCny: 1, approvedBy: 'alice' })).toThrow();
    expect(readdirSync(join(ud, 'provider'))).toEqual([]);
    expect(readdirSync(join(ud, 'budget', 'proofs'))).toEqual([]);
    expect(readdirSync(join(ud, 'budget')).filter((n) => n === 'approvals.json')).toEqual([]);
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { openDurableDatabase } from '@companyos/persistence';
import { outcomeEvidence, redactEvidence, saveOutcomeEvidence } from './support/kernel-outcome-evidence.js';
import { waitForScenarioReady, stopScenarioServer } from './support/scenario-server.js';

const child = () => Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn(() => true)}) as unknown as ChildProcess;
describe('offline incident fixture evidence — MOCK children, no Kernel or Provider', () => {
  it.each(['timeout', 'policy-denied', 'transport-failed', 'cancelled'])('%s is preserved and has no fabricated native exit code', kind => {
    const evidence = outcomeEvidence({kind, detail:'classified failure'});
    expect(evidence.kind).toBe(kind); expect(evidence.nativeExitCode).toBeNull(); expect(evidence.succeeded).toBe(false);
  });
  it('zero native exit rejected by protocol stays non-success', () => {
    expect(outcomeEvidence({kind:'provider-failed', reasonCode:'EMPTY_FINAL', exitCode:0})).toMatchObject({nativeExitCode:0, kind:'provider-failed', reasonCode:'EMPTY_FINAL', succeeded:false});
  });
  it('real reported nonzero field is preserved without changing its classification', () => {
    expect(outcomeEvidence({kind:'provider-failed', exitCode:-1073741795, stderrText:'native failure', terminationProven:false})).toMatchObject({nativeExitCode:-1073741795, terminationProven:false, succeeded:false});
  });
  it('missing/malformed result is not success and missing termination is UNKNOWN', () => {
    expect(outcomeEvidence(undefined)).toMatchObject({kind:'MALFORMED_OUTCOME', nativeExitCode:null, succeeded:false, terminationProven:null});
  });
  it('credential values are redacted and evidence cannot overwrite an earlier capture', () => {
    const dir=mkdtempSync(join(tmpdir(),'offline-evidence-')); const file=join(dir,'outcome.json');
    try {
      saveOutcomeEvidence(file,{kind:'transport-failed',detail:'Bearer abc.def token=synthetic_secret'},[],['synthetic_secret']);
      expect(readFileSync(file,'utf8')).not.toContain('synthetic_secret'); expect(readFileSync(file,'utf8')).not.toContain('abc.def');
      expect(() => saveOutcomeEvidence(file,{kind:'succeeded'},[])).toThrow();
      expect(redactEvidence('api_key=synthetic')).not.toContain('synthetic');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('server startup acknowledges the actual port even when the ready line is split', async () => {
    const c=child(); const ready=waitForScenarioReady(c);
    c.stdout!.emit('data',Buffer.from('scenario-model-server on 43')); c.stdout!.emit('data',Buffer.from('210 with 1 steps\n'));
    expect(await ready).toBe(43210); expect(c.listenerCount('exit')).toBe(0);
  });
  it('spawn failure remains distinct from native exit before readiness', async () => {
    const c=child(); const ready=expect(waitForScenarioReady(c)).rejects.toThrow('SCENARIO_SPAWN_FAILURE');
    c.emit('error', new Error('mock spawn')); await ready;
    const d=child(); const exited=expect(waitForScenarioReady(d)).rejects.toThrow('code=7'); d.emit('exit',7,null); await exited;
  });
  it('startup timeout is explicit and removes listeners', async () => {
    vi.useFakeTimers();
    try {const c=child(); const result=expect(waitForScenarioReady(c,10)).rejects.toThrow('SCENARIO_READY_TIMEOUT'); await vi.advanceTimersByTimeAsync(10); await result; expect(c.listenerCount('exit')).toBe(0);} finally {vi.useRealTimers();}
  });
  it('cleanup awaits exit; failure to prove exit is not recorded as stopped', async () => {
    const c=child(); const stopped=stopScenarioServer(c); expect(c.kill).toHaveBeenCalledOnce(); c.emit('exit',0,null); await stopped;
    vi.useFakeTimers();
    try {const d=child(); const result=expect(stopScenarioServer(d,10)).rejects.toThrow('SCENARIO_STOP_NOT_PROVEN'); await vi.advanceTimersByTimeAsync(10); await result;} finally {vi.useRealTimers();}
  });
  it('SQLite closes on an assertion error before fixture cleanup (no sleep/retry)', () => {
    const dir=mkdtempSync(join(tmpdir(),'offline-finally-')); const db=openDurableDatabase({dataDir:dir,appliedAt:'offline-test'});
    try {expect(() => {try {throw new Error('intentional assertion failure');} finally {db.close();}}).toThrow('intentional assertion failure');}
    finally {rmSync(dir,{recursive:true,force:true});}
    expect(() => db.db.prepare('SELECT 1')).toThrow();
  });
});

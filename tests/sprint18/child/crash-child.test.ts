/**
 * Task-18-08 REAL-PROCESS crash child. Spawned by `t18-08-real-crash.test.ts` through a
 * dedicated vitest config, with T18_08_CRASH_AT naming the checkpoint. The armed port calls
 * `process.exit(86)` — a REAL abrupt termination with no graceful cleanup, no afterEach, no
 * unwinding — exactly a killed process. The parent test then reopens the same durable files.
 *
 * The child reuses the shared T18-08 fixture, so the chain it runs is the production
 * composition with the same legal validator and routing model (no live model API).
 */
import { writeSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { FaultCheckpointName } from '@companyos/core';

import {
  closeFixtureArtifacts,
  compose,
  goalArtifactRefOf,
  happyScript,
  installScript,
  registerValidator,
  runSupervisor,
  seedRoutingModel,
  sessionActorOf,
  startRun,
  trackDatabase,
  type Core,
  type Started,
} from '../helpers/t18-08-fixture.js';

const crashAt = process.env.T18_08_CRASH_AT ?? '';
const dataDir = process.env.T18_08_DATA_DIR ?? '';
const casRoot = process.env.T18_08_CAS_ROOT ?? '';
/*
 * Sprint21: the generic execution-claim timeline fires its windows PER UNIT (work, review,
 * qa … each settles through the same checkpoints), so a window is named by checkpoint AND
 * ordinal: `T18_08_CRASH_AFTER_HITS=2` kills at the SECOND unit's window (the review unit's
 * carrier window). Default stays 1 for the per-run windows.
 */
const crashAfterHits = Number(process.env.T18_08_CRASH_AFTER_HITS ?? '1');
let hits = 0;

/** The REAL kill: abrupt process termination at the named checkpoint, no unwinding. */
const killerPort = {
  async checkpoint(name: FaultCheckpointName): Promise<void> {
    if (name !== crashAt) return;
    hits += 1;
    if (hits < crashAfterHits) return;
    // A SYNCHRONOUS fd write so the marker is durable BEFORE the kill (buffered stdout is
    // lost when a process dies; this is not).
    writeSync(2, `T18_08_CHILD_KILLED_AT ${name}
`);
    // SIGKILL to SELF: the one termination no test framework can intercept or convert into
    // a failure — TerminateProcess on Windows, kill -9 elsewhere. This is the real crash.
    process.kill(process.pid, 'SIGKILL');
  },
};

const writeMarker = (core: Core, started: Started, actor: string): void => {
  // The parent verifies recovery of exactly these durable identities.
  void core;
  void started;
  void actor;
};

describe('T18-08 real-process crash child', () => {
  it('runs the production chain until the abrupt kill', async () => {
    expect(crashAt).not.toBe('');
    expect(dataDir).not.toBe('');
    expect(casRoot).not.toBe('');
    const core = await compose({ dataDir, casRoot }, killerPort);
    trackDatabase(core.database); // deliberately NOT closed: the process dies instead
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const started = await startRun(core, actor, 'realcrash');
    const qaTarget = await goalArtifactRefOf(core, started.runId);
    installScript(happyScript(started.workTaskId, qaTarget));
    writeMarker(core, started, actor);
    await runSupervisor(core, started, actor, 'realcrash');
    // If the checkpoint never fired, fail loudly: the parent must see the kill, not a pass.
    closeFixtureArtifacts();
    throw new Error(`the child completed without the kill at "${crashAt}"`);
  });
});

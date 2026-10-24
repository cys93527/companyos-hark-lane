/**
 * Hark lane H4 — OWNER process used by the native tests (stands in for the
 * Supervisor). Runs the real lifetime adapter over koffi, optionally arms the
 * independent watchdog via onJobReady + a file lease, and can be made to hang
 * (busy loop) or be killed by the test (crash).
 *
 * argv: <mode> <workspaceRoot> <controlDir> <tag>
 *   mode: crash | crash-wd | hang-wd | release-wd
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createJobLifetimeAdapter } from '../../../../src/executor/native-lifetime/job-lifetime.js';
import { createKoffiHandleTransfer, createKoffiJobPort } from '../../../../src/executor/native-lifetime/koffi-job-port.js';
import { createFileLeaseWriter } from '../../../../src/executor/native-lifetime/lease-file.js';
import { verifyLaunch } from '../../../../src/executor/native-lifetime/launch-pins.js';
import { armNativeWatchdog } from '../../../../src/executor/native-lifetime/watchdog-process.js';
import { environmentBlock, helperEnvironment, loadKoffi, nodeCommandLine, sha256, sleep } from '../native-support.js';

const [mode = '', root = '', control = '', tag = ''] = process.argv.slice(2);
if (!['crash', 'crash-wd', 'hang-wd', 'release-wd'].includes(mode) || !root || !control || !tag) throw new Error('owner-args-refused');
const koffi = loadKoffi();
const port = createKoffiJobPort(koffi);
const transfer = createKoffiHandleTransfer(koffi);
const exe = join(root, 'node.exe');
const script = join(root, 'fixture.cjs');
const temp = join(root, 'tmp');
const childMode = mode === 'release-wd' ? 'normal' : 'tree';
const launch = verifyLaunch({
  identity: { runId: `h4-${tag}`, taskId: 'owner', attemptId: '1' },
  executable: { path: exe, sha256: sha256(readFileSync(exe)) },
  inputs: [{ path: script, sha256: sha256(readFileSync(script)) }],
  argv: [script, childMode, tag],
  workspaceRoot: root,
  cwd: root,
  environment: { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', TEMP: temp, TMP: temp, COMPANYOS_TEST_MODE: 'OFFLINE' },
  timeoutMs: 120_000,
}, { platform: 'win32', requireExeSuffix: true, maxTimeoutMs: 600_000 });

const withWatchdog = mode.endsWith('-wd');
const lease = withWatchdog ? createFileLeaseWriter(join(control, 'lease.rec'), { clock: () => performance.now(), minIntervalMs: 100 }) : undefined;
const info: { ownerPid: number; watchdogPid: number | null } = { ownerPid: process.pid, watchdogPid: null };
const watchdogEntry = join(import.meta.dirname, 'watchdog-fixture.ts');

const adapter = createJobLifetimeAdapter({
  port,
  clock: () => performance.now(),
  sleep,
  pollMs: 20,
  stopWaitMs: 5_000,
  ...(lease ? { lease } : {}),
  ...(withWatchdog ? {
    onJobReady: (job: bigint) => {
      const armed = armNativeWatchdog({
        port, transfer, job,
        executable: process.execPath,
        commandLine: nodeCommandLine(process.execPath, watchdogEntry, [join(control, 'watchdog-args.json')]),
        cwd: control,
        environmentBlock: environmentBlock(helperEnvironment(temp)),
        argsPath: join(control, 'watchdog-args.json'),
        leasePath: join(control, 'lease.rec'),
        resultPath: join(control, 'watchdog-result.json'),
        config: { heartbeatTimeoutMs: 1_500, startGraceMs: 5_000, hardDeadlineMs: 90_000 },
      });
      info.watchdogPid = armed.pid;
      port.close(armed.process);
    },
  } : {}),
});

writeFileSync(join(control, 'owner-info.json'), JSON.stringify(info));
if (mode === 'hang-wd') {
  // Owner becomes alive-but-unresponsive once the descendant exists: the event
  // loop is blocked forever, so neither its timer nor its lease beat can run.
  const leaf = join(root, `${tag}-leaf.json`);
  const timer = setInterval(() => {
    if (!existsSync(leaf)) return;
    clearInterval(timer);
    writeFileSync(join(control, 'owner-hanging.json'), JSON.stringify({ at: Date.now() }));
    for (;;) { /* deliberate hang */ }
  }, 25);
}
const pending = adapter.run(launch);
// onJobReady runs synchronously inside run() before its first await: the pid is known now.
writeFileSync(join(control, 'owner-info.json'), JSON.stringify(info));
const r = await pending;
lease?.close();
writeFileSync(join(control, 'owner-result.json'), JSON.stringify({ outcome: r.outcome, mode: r.assignmentMode, errors: r.errors, processes: r.processes }));

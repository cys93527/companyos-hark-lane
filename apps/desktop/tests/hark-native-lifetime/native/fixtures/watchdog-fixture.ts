/**
 * Hark lane H4 — watchdog process entry used by the native tests. Started by the
 * owner fixture, suspended and outside the Job; reads its own duplicated handles
 * from the args file and runs the independent watchdog loop.
 */
import { createKoffiJobPort } from '../../../../src/executor/native-lifetime/koffi-job-port.js';
import { runNativeWatchdog } from '../../../../src/executor/native-lifetime/watchdog-process.js';
import { loadKoffi, sleep } from '../native-support.js';

const argsPath = process.argv[2];
if (!argsPath) throw new Error('watchdog-args-missing');
const port = createKoffiJobPort(loadKoffi());
const result = await runNativeWatchdog({ port, argsPath, clock: () => performance.now(), sleep, pollMs: 25 });
process.exitCode = result.outcome === 'STOP_UNPROVEN' ? 3 : 0;

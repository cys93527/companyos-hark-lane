import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
export const STOP_GRACE_MS = 5000;
const MAX_OUTPUT = 256 * 1024 * 1024;

// The guard checks this PID against its live ChildProcess map and pins taskkill.
// A successful stop command alone is NOT proof: runCommand also awaits close.
export function stopOwnedChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const executable = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const result = spawnSync(executable, ['/PID', String(child.pid), '/T', '/F'], {shell:false,encoding:'utf8',timeout:2000});
    if (result.status !== 0) throw Error(`owned tree stop failed: ${result.error?.code ?? result.status}`);
  } else if (!child.kill('SIGTERM')) throw Error('owned child stop failed');
}

export function runCommand(command, {
  env, signal, timeoutMs = COMMAND_TIMEOUT_MS, graceMs = STOP_GRACE_MS,
  launch = spawn, stop = stopOwnedChild, timers = {setTimeout,clearTimeout},
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(graceMs) || graceMs <= 0) throw Error('invalid command deadline');
  if (signal?.aborted) return Promise.resolve({code:1,signal:null,stdout:'',stderr:'',kind:'INTERRUPTED',started:false,closeObserved:false,pid:null});
  return new Promise(resolve => {
    let child, timeout, grace, kind, spawnError, stopError, finished = false, bytes = 0;
    const stdout=[], stderr=[];
    const finish = (code, exitSignal, closeObserved) => {
      if (finished) return;
      finished=true;
      timers.clearTimeout(timeout); timers.clearTimeout(grace);
      signal?.removeEventListener('abort',onAbort);
      resolve({code:kind || !closeObserved ? 1 : (code ?? 1),nativeExitCode:code,signal:exitSignal ?? null,
        stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),
        kind:kind ?? (code === 0 ? 'SUCCESS' : 'NONZERO_EXIT'),spawnError,stopError,
        pid:child?.pid ?? null,started:Boolean(child?.pid),closeObserved});
    };
    const requestStop = reason => {
      if (finished || kind) return;
      kind=reason;
      try { stop(child); } catch (error) { stopError=error.message; }
      if (!finished) grace=timers.setTimeout(()=>finish(null,null,false),graceMs);
    };
    const onAbort=()=>requestStop('INTERRUPTED');
    try {
      child=launch(command.executable,command.argv,{cwd:command.cwd,env,shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true});
    } catch (error) {
      kind='SPAWN_ERROR'; spawnError=error.code ?? error.message; finish(null,null,false); return;
    }
    const capture = (list, chunk) => {
      if (finished) return;
      const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      const room=MAX_OUTPUT-bytes; bytes+=buffer.length;
      if (room>0) list.push(buffer.subarray(0,room));
      if (bytes>MAX_OUTPUT) requestStop('OUTPUT_LIMIT');
    };
    child.stdout?.on('data',chunk=>capture(stdout,chunk));
    child.stderr?.on('data',chunk=>capture(stderr,chunk));
    child.once('error',error=>{
      spawnError=error.code ?? error.message;
      if (!kind) kind='SPAWN_ERROR';
      if (!grace) grace=timers.setTimeout(()=>finish(null,null,false),graceMs);
    });
    child.once('close',(code,exitSignal)=>finish(code,exitSignal,true));
    timeout=timers.setTimeout(()=>requestStop('TIMEOUT'),timeoutMs);
    signal?.addEventListener('abort',onAbort,{once:true});
    // Close the race between the first aborted check and listener registration.
    if (signal?.aborted) onAbort();
  });
}

// Dependencies are injectable only through imports in tests, never via a CLI
// flag, environment variable or fake external executable that can report PASS.
export async function runStages(steps, {execute=runCommand,env,signal,log=console.log,stdout=chunk=>process.stdout.write(chunk),stderr=chunk=>process.stderr.write(chunk),persist=()=>null} = {}) {
  const results=[];
  for (const step of steps) {
    const started=performance.now();
    log(`\n${'═'.repeat(72)}\n▶ ${step.name}: ${step.cmd}\n${'═'.repeat(72)}`);
    const calls=[];
    for (const command of step.commands) {
      let result;
      try { result=await execute(command,{env,signal}); }
      catch (error) { result={code:1,kind:'SPAWN_ERROR',started:false,closeObserved:false,stderr:String(error),stdout:''}; }
      if (!result || typeof result.code !== 'number') result={code:1,kind:'INVALID_EXECUTION_RESULT',started:false,closeObserved:false,stderr:'executor returned no reliable exit evidence',stdout:''};
      // An executor that never started/observed its child cannot produce PASS.
      if (result.code === 0 && (!result.started || !result.closeObserved || result.kind !== 'SUCCESS' || result.nativeExitCode !== 0 || result.signal)) result={...result,code:1,kind:'EXECUTION_NOT_CONFIRMED'};
      calls.push({...result,command});
      if (result.stdout) stdout(result.stdout);
      if (result.stderr) stderr(result.stderr);
      if (result.code !== 0) break;
    }
    const last=calls.at(-1);
    const code=last && calls.length===step.commands.length ? last.code : 1;
    results.push({step:step.name,code,elapsed:performance.now()-started,calls});
    if (code !== 0) {
      const output=calls.map(r=>`command: ${JSON.stringify(r.command)}\nstatus: ${r.kind}; PID: ${r.pid ?? 'NOT STARTED'}; close observed: ${r.closeObserved}; native exit: ${r.nativeExitCode ?? 'UNKNOWN'}; stop error: ${r.stopError ?? 'none'}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`).join('\n');
      const file=persist(step.name,step.cmd,code,last?.signal,output);
      if (file) stderr(`🧷 failure diagnostics preserved: ${file}\n`);
      break;
    }
  }
  const failed=results.find(r=>r.code!==0)?.step ?? (results.length !== steps.length || !steps.length ? 'NOT_EXECUTED' : null);
  const summary=results.map(r=>`  ${r.code===0?'✅ PASS':'❌ FAIL'}  ${r.step.padEnd(12)} ${(r.elapsed/1000).toFixed(1)}s`).join('\n');
  log(`\n${'═'.repeat(72)}\nCompanyOS pnpm check — summary\n${'═'.repeat(72)}\n${summary}\n`);
  if (failed) stderr(`❌ pnpm check FAILED at step "${failed}" (step ${results.length}/${steps.length}). Exit Code 1\n`);
  else log(`✅ pnpm check PASSED — ${results.length}× PASS, all gates green. Exit Code 0`);
  return {code:failed?1:0,results,failed};
}

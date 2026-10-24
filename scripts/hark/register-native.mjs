// Preload for Hark lane NATIVE tests (Windows CI only): .js->.ts resolver plus
// a network guard. Unlike the offline guard, koffi may load, but ONLY from
// HARK_KOFFI_DIR. Test processes may not use child_process; the only process
// creation path is kernel32 CreateProcessW inside a Job Object.
import { register } from 'node:module';
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import child from 'node:child_process';
import Module from 'node:module';
import { resolve, sep } from 'node:path';

register('./ts-resolve-hook.mjs', import.meta.url);
const deny = name => function denied() { throw new Error(`HARK_NATIVE_GUARD_DENIED: ${name}`); };
net.Socket.prototype.connect = deny('net.Socket.connect');
net.connect = net.createConnection = deny('net.connect');
dns.lookup = deny('dns.lookup');
dns.promises.lookup = deny('dns.promises.lookup');
http.request = http.get = deny('http.request');
https.request = https.get = deny('https.request');
globalThis.fetch = deny('fetch');
if (process.env.NODE_TEST_CONTEXT) for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[k] = deny(`child_process.${k}`);
const allowed = resolve(process.env.HARK_KOFFI_DIR ?? '\0none').toLowerCase() + sep;
const originalLoad = Module._load;
Module._load = function guarded(request, parent, ...rest) {
  const text = String(request);
  if (/(^|[\\/])koffi([\\/]|$)|\.node$/u.test(text)) {
    const from = String(parent?.filename ?? '').toLowerCase();
    const target = text.toLowerCase();
    // createRequire(HARK_KOFFI_DIR/package.json) makes the parent live inside the allowed dir.
    if (!(from.startsWith(allowed) || target.startsWith(allowed))) {
      throw new Error(`HARK_NATIVE_GUARD_DENIED: native ${text} from ${from || '<unknown>'}`);
    }
  }
  return originalLoad.call(this, request, parent, ...rest);
};
process.env.COMPANYOS_TEST_MODE = 'OFFLINE';

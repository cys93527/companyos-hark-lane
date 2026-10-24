// Preload for Hark lane offline tests: install the .js->.ts resolver and deny
// every network / child-process / dynamic native-load entry point. A test that
// reaches one of these fails loudly; nothing is silently allowed.
import { register } from 'node:module';
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import child from 'node:child_process';
import Module from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);
const deny = name => function denied() { throw new Error(`HARK_OFFLINE_GUARD_DENIED: ${name}`); };
net.Socket.prototype.connect = deny('net.Socket.connect');
net.connect = net.createConnection = deny('net.connect');
dns.lookup = deny('dns.lookup');
dns.promises.lookup = deny('dns.promises.lookup');
http.request = http.get = deny('http.request');
https.request = https.get = deny('https.request');
globalThis.fetch = deny('fetch');
// The node:test parent orchestrates per-file child processes; only the test
// processes themselves (NODE_TEST_CONTEXT set) are denied process creation.
if (process.env.NODE_TEST_CONTEXT) for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[k] = deny(`child_process.${k}`);
process.dlopen = deny('process.dlopen');
const originalLoad = Module._load;
Module._load = function guarded(request, ...rest) {
  if (/(^|[\\/])koffi([\\/]|$)|\.node$/u.test(String(request))) throw new Error(`HARK_OFFLINE_GUARD_DENIED: native ${request}`);
  return originalLoad.call(this, request, ...rest);
};
process.env.COMPANYOS_TEST_MODE = 'OFFLINE';

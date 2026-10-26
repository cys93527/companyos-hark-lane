#!/usr/bin/env node
// Hark lane H17a: the NON-secret half of "CompanyOS 首次配置". Started by configure-deepseek.ps1 as
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) configure-provider.mjs write  --user-data <dir> --cap-cny <n> --approved-by <name>
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) configure-provider.mjs remove --user-data <dir>
// The API key never reaches this process (no argv, no env, no stdin): the PowerShell helper
// DPAPI-protects it into <userData>/provider/model-api-key.dpapi itself.
// Shipped at <install>/resources/setup/; the app modules live at <install>/resources/app/apps/desktop/dist/.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if (!['--user-data', '--cap-cny', '--approved-by', '--dist'].includes(k) || v === undefined) throw new Error(`unknown or incomplete argument ${k}`);
    opts[k.slice(2)] = v;
  }
  if (command !== 'write' && command !== 'remove') throw new Error('command must be write or remove');
  if (!opts['user-data']) throw new Error('--user-data is required');
  if (command === 'write' && (!opts['cap-cny'] || !opts['approved-by'])) throw new Error('write needs --cap-cny and --approved-by');
  return { command, ...opts };
};

const main = async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: 'SETUP_ARGS_INVALID', message: e.message }));
    return 2;
  }
  const dist = args.dist ?? join(here, '..', 'app', 'apps', 'desktop', 'dist');
  const mod = await import(pathToFileURL(join(dist, 'provider-setup-write.js')).href);
  try {
    if (args.command === 'remove') {
      console.log(JSON.stringify({ ok: true, ...mod.removeProviderSetup(args['user-data']) }));
      return 0;
    }
    const r = mod.writeProviderSetup({ userDataDir: args['user-data'], capCny: Number(args['cap-cny']), approvedBy: args['approved-by'] });
    console.log(JSON.stringify({ ok: true, proofRef: r.proofRef, capMicros: r.capMicros, keyFilePresent: r.keyFilePresent }));
    return r.keyFilePresent ? 0 : 4;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: e.code ?? 'SETUP_FAILED', message: e.message }));
    return 3;
  }
};

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}

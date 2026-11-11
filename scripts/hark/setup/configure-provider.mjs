#!/usr/bin/env node
// Hark lane H17a: the NON-secret half of "CompanyOS 首次配置". Started by configure-deepseek.ps1 as
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) configure-provider.mjs write  --user-data <dir> --cap-cny <n> --approved-by <name>
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) configure-provider.mjs write-custom --user-data <dir> --cap-cny <n> --approved-by <name>
//       --base-url <https url> --model-id <id> --input-cny <CNY per M> --output-cny <CNY per M> [--provider-id model.x] [--pricing-source <url>]
//   CompanyOS.exe (ELECTRON_RUN_AS_NODE=1) configure-provider.mjs remove --user-data <dir>
// The API key never reaches this process (no argv, no env, no stdin): the PowerShell helper
// DPAPI-protects it into <userData>/provider/model-api-key.dpapi itself.
// The provider profile (vendor/model/price data) is deployment data: provider-profile.json beside this script.
// Shipped at <install>/resources/setup/; the app modules live at <install>/resources/app/apps/desktop/dist/.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if (!['--user-data', '--cap-cny', '--approved-by', '--dist', '--profile', '--base-url', '--model-id', '--provider-id', '--input-cny', '--output-cny', '--pricing-source'].includes(k) || v === undefined) throw new Error(`unknown or incomplete argument ${k}`);
    opts[k.slice(2)] = v;
  }
  if (command !== 'write' && command !== 'write-custom' && command !== 'remove') throw new Error('command must be write, write-custom or remove');
  if (!opts['user-data']) throw new Error('--user-data is required');
  if ((command === 'write' || command === 'write-custom') && (!opts['cap-cny'] || !opts['approved-by'])) throw new Error(`${command} needs --cap-cny and --approved-by`);
  if (command === 'write-custom' && (!opts['base-url'] || !opts['model-id'] || !opts['input-cny'] || !opts['output-cny'])) throw new Error('write-custom needs --base-url, --model-id, --input-cny and --output-cny');
  return { command, ...opts };
};

export const main = async (argv = process.argv.slice(2), log = (line) => console.log(line)) => {
  const here = dirname(fileURLToPath(import.meta.url));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log(JSON.stringify({ ok: false, code: 'SETUP_ARGS_INVALID', message: e.message }));
    return 2;
  }
  const dist = args.dist ?? join(here, '..', 'app', 'apps', 'desktop', 'dist');
  try {
    // AUDIT-S13: inside the try, so a missing/broken app module still answers with a JSON error the helper shows.
    const mod = await import(pathToFileURL(join(dist, 'provider-setup-write.js')).href);
    const profile = mod.readProviderSetupProfile(args.profile ?? join(here, mod.PROVIDER_SETUP_PROFILE_FILE));
    if (args.command === 'remove') {
      log(JSON.stringify({ ok: true, ...mod.removeProviderSetup(args['user-data'], profile) }));
      return 0;
    }
    // UI-AUDIT-2: a user-chosen OpenAI-compatible service with the user's attested price.
    const effective = args.command === 'write-custom'
      ? mod.buildCustomProviderProfile(profile, {
          baseUrl: args['base-url'],
          modelId: args['model-id'],
          ...(args['provider-id'] ? { providerId: args['provider-id'] } : {}),
          inputCnyPerM: Number(args['input-cny']),
          outputCnyPerM: Number(args['output-cny']),
          ...(args['pricing-source'] ? { pricingSource: args['pricing-source'] } : {}),
        })
      : profile;
    const r = mod.writeProviderSetup({ userDataDir: args['user-data'], profile: effective, capCny: Number(args['cap-cny']), approvedBy: args['approved-by'] });
    log(JSON.stringify({ ok: true, proofRef: r.proofRef, capMicros: r.capMicros, keyFilePresent: r.keyFilePresent, providerId: effective.providerId, modelId: effective.modelId }));
    return r.keyFilePresent ? 0 : 4;
  } catch (e) {
    log(JSON.stringify({ ok: false, code: e.code ?? 'SETUP_FAILED', message: e.message }));
    return 3;
  }
};

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}

/* Test infrastructure only. Preload before Vitest or a reviewed fixture child.
 * This prevents accidental real execution; it is not an OS sandbox for hostile
 * test code or native addons. No production imports or security changes.
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
const { createGitPolicy, createPlatformPaths } = require('./test-offline-git.cjs');
const { createPackagePolicy } = require('./test-offline-package.cjs');
const ROOT = path.resolve(__dirname, '..');
const GUARD = __filename;
const stateKey = Symbol.for('companyos.offline-test-guard');
const kernelEntry = path.join(ROOT, '.companyos-embedded', 'dsh-runtime', 'runtime', 'apps', 'cli', 'lib', 'bin.js');
const kernelBytesHash = fs.existsSync(kernelEntry) ? crypto.createHash('sha256').update(fs.readFileSync(kernelEntry)).digest('hex') : null;
const secretName = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|ACCESS_KEY|COS_MODEL|^DSH_|REAL_DSH|LIVE_DSH|^(?:HTTP|HTTPS|ALL)_PROXY$|^COMPANYOS_EXECUTOR_PROVIDER$|^GIT_(?:SSH|ASKPASS|CONFIG|EXEC|TRACE))/i;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const frameworkIdentities = new Map();
let crashConfig = null;
try {
  const vitest = require.resolve('vitest/vitest.mjs');
  const pool = require.resolve('tinypool', {paths:[path.dirname(vitest)]});
  for (const entry of [vitest,path.join(path.dirname(pool),'entry','process.js')]) {
    const id=fixtureIdentity(entry);frameworkIdentities.set(id.path,id);
  }
  crashConfig=fixtureIdentity(path.join(ROOT,'tests','sprint18','child','vitest.config.ts'));
} catch { /* Unavailable framework stays fail-closed. */ }
// Vite's config transform starts this fixed build service, not a business tool.
function resolveBuildService() {
  const packages = {'win32:x64:LE':'@esbuild/win32-x64','linux:x64:LE':'@esbuild/linux-x64','linux:arm64:LE':'@esbuild/linux-arm64'};
  const name = packages[`${process.platform}:${process.arch}:${os.endianness()}`];
  if (!name) refuse('unsupported-esbuild-platform');
  const dependencyRoot = fs.realpathSync.native(path.join(ROOT,'node_modules'));
  if (dependencyRoot !== path.resolve(ROOT,'node_modules')) refuse('esbuild-dependency-root-alias');
  const inside = file => {
    const full=fs.realpathSync.native(file), rel=path.relative(dependencyRoot,full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) refuse('esbuild-outside-installed-dependencies');
    return full;
  };
  const vite = inside(require.resolve('vite', { paths: [path.dirname(require.resolve('vitest/vitest.mjs'))] }));
  const esbuild = inside(require.resolve('esbuild', { paths: [path.dirname(vite)] }));
  const host = inside(require.resolve('esbuild/package.json', { paths: [path.dirname(esbuild)] }));
  const pkg = inside(require.resolve(`${name}/package.json`, { paths: [path.dirname(esbuild)] }));
  const metadata = JSON.parse(fs.readFileSync(pkg,'utf8'));
  const hostMetadata = JSON.parse(fs.readFileSync(host,'utf8'));
  if (hostMetadata.name !== 'esbuild') refuse('esbuild-host-package-mismatch');
  const version = hostMetadata.version;
  if (metadata.name !== name || metadata.version !== version || !/^\d+\.\d+\.\d+$/.test(version)) refuse('esbuild-platform-package-mismatch');
  const relative = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  const requested = path.join(path.dirname(pkg),relative), exe=inside(requested);
  if (fs.lstatSync(requested).isSymbolicLink() || exe !== path.resolve(requested)) refuse('esbuild-binary-alias');
  if (process.platform === 'linux' && !(fs.statSync(exe).mode & 0o111)) refuse('esbuild-binary-not-executable');
  return {identity:fixtureIdentity(exe),version};
}
let buildService = null;
try { buildService=resolveBuildService(); } catch { /* Missing or invalid dependency stays fail-closed. */ }
function refuse(reason) {
  const error = new Error(`OFFLINE_TEST_EXECUTION_DENIED: ${reason}`);
  error.code = 'OFFLINE_TEST_EXECUTION_DENIED';
  throw error;
}
function canonical(file) {
  try { return fs.realpathSync.native(path.resolve(file)); } catch { return path.resolve(file); }
}
function protectedPath(file) {
  const value = canonical(file).replaceAll('\\', '/').toLowerCase();
  return /(?:^|\/)(?:\.companyos-embedded|\.dsh-stages|\.dsh-homes)(?:\/|$)/.test(value)
    || /(?:^|\/)deepseek\.gzq\/companyos(?:\/|$)/.test(value)
    || /(?:^|\/)sandbox-windows-acl(?:\/|$)/.test(value);
}
function fixtureIdentity(file) {
  if (protectedPath(file)) refuse('real-resource-fixture-registration');
  const full = canonical(file);
  const stat = fs.statSync(full, { bigint: true });
  if (!stat.isFile()) refuse('fixture-is-not-a-file');
  const hash = digest(fs.readFileSync(full));
  if (kernelBytesHash && hash === kernelBytesHash) refuse('real-kernel-entry-alias-or-copy');
  return { path: full, dev: String(stat.dev), ino: String(stat.ino), hash };
}
function safeEnvironment(input = {}) {
  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !secretName.test(key) && key.toUpperCase() !== 'NODE_OPTIONS'
        && !/^ELECTRON_/i.test(key) && !/^COMPANYOS_OFFLINE_/i.test(key)) env[key] = String(value);
  }
  env.COMPANYOS_TEST_MODE = 'OFFLINE';
  // NODE_OPTIONS parses backslashes as escapes inside quotes on Windows.
  env.NODE_OPTIONS = `--require "${GUARD.replaceAll('\\', '/')}"`;
  return env;
}
function installOfflineGuard() {
  if (globalThis[stateKey]) return globalThis[stateKey];
  const platformPaths=createPlatformPaths(refuse,protectedPath,ROOT);
  // A default setup cannot become live simply because an environment variable
  // or a future live-approval manifest happens to be present.
  const state = { mode: 'OFFLINE', scripts: new Map(), inline: new Set(), children: new Map(), spawnFailures: new Set(), gateCommands: [] };
  globalThis[stateKey] = state;
  let inherited = { scripts: [], inline: [] };
  try {
    if (process.env.COMPANYOS_OFFLINE_FIXTURE_LEDGER) {
      const bytes = fs.readFileSync(process.env.COMPANYOS_OFFLINE_FIXTURE_LEDGER);
      if (digest(bytes) !== process.env.COMPANYOS_OFFLINE_FIXTURE_LEDGER_SHA256) refuse('fixture-ledger-hash-mismatch');
      inherited = JSON.parse(bytes.toString('utf8'));
    } else if (process.env.COMPANYOS_OFFLINE_FIXTURES) inherited = JSON.parse(process.env.COMPANYOS_OFFLINE_FIXTURES);
  } catch { refuse('invalid-fixture-ledger'); }
  for (const entry of inherited.scripts ?? []) state.scripts.set(entry.path, entry);
  for (const entry of inherited.inline ?? []) state.inline.add(entry);
  state.gateCommands.push(...(inherited.gateCommands ?? []));
  const git = createGitPolicy(refuse, protectedPath, inherited.git ?? [], ROOT);
  process.env.COMPANYOS_TEST_MODE = 'OFFLINE';
  const node = canonical(process.execPath);
  if (/electron(?:\.exe)?$/i.test(node)) refuse('electron-test-host');
  const hostIdentity = fixtureIdentity(node);
  const taskkill = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe') : null;
  const taskkillIdentity = taskkill && fs.existsSync(taskkill) ? fixtureIdentity(taskkill) : null;

  function registerFixture(file, launch) {
    if (process.platform === 'linux') {
      const dir=platformPaths.directory(path.dirname(file));
      const rel=path.relative(platformPaths.repository(),dir);
      if (rel.startsWith('..') || path.isAbsolute(rel) || fs.lstatSync(file).isSymbolicLink()) refuse('linux-fixture-outside-repository');
      platformPaths.temporary();
    }
    const entry = fixtureIdentity(file);
    if (launch !== undefined) {
      const rel=path.relative(platformPaths.temporary(),entry.path);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !Array.isArray(launch.argv) || launch.argv.some(arg=>typeof arg!=='string')) refuse('fixture-launch-not-owned');
      entry.launch={argv:[...launch.argv],cwd:directoryIdentity(launch.cwd)};
      const cwdRel=path.relative(platformPaths.temporary(),entry.launch.cwd.path);
      if (!cwdRel || cwdRel.startsWith('..') || path.isAbsolute(cwdRel)) refuse('fixture-launch-cwd-not-owned');
    }
    state.scripts.set(entry.path, entry);
    return entry;
  }
  function registerInline(code) {
    if (typeof code !== 'string' || /\.companyos-embedded|\.dsh-stages|dsh-runtime[\\/]runtime[\\/]apps|sandbox-windows-acl|SetNamedSecurityInfo|\bicacls\b/i.test(code)) refuse('real-resource-inline-registration');
    state.inline.add(digest(code));
  }
  function registerSpawnFailure(file) {
    const full = path.resolve(file), temp = platformPaths.temporary();
    const rel = path.relative(temp, full);
    if (protectedPath(full) || !rel || rel.startsWith('..') || path.isAbsolute(rel) || fs.existsSync(full)) refuse('invalid-absent-fixture');
    state.spawnFailures.add(full);
  }
  function directoryIdentity(dir) {
    if (protectedPath(dir)) refuse('original-or-real-resource-cwd');
    const full = canonical(dir), stat = fs.statSync(full, {bigint:true});
    if (!stat.isDirectory()) refuse('gate-cwd-is-not-directory');
    return {path:full,dev:String(stat.dev),ino:String(stat.ino)};
  }
  function registerCheckCommands(argv = [], invocationCwd = ROOT) {
    // A finite expansion of six reviewed stages; callers cannot supply a CLI,
    // package name, script body or arbitrary options to this registration.
    const {createCheckPlan,parseCheckArgs}=require('./check-plan.cjs');
    const parsed=parseCheckArgs(argv);
    if (parsed.rootOverride) {
      const rel=path.relative(platformPaths.temporary(),canonical(parsed.rootOverride));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) refuse('gate-fixture-outside-owned-temp');
    }
    const plan=createCheckPlan(argv);
    const invocation=directoryIdentity(invocationCwd);
    if (invocation.path!==canonical(ROOT)) {
      const rel=path.relative(platformPaths.temporary(),invocation.path);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) refuse('gate-launcher-cwd-outside-owned-temp');
    }
    state.gateCommands.push({script:fixtureIdentity(path.join(ROOT,'scripts','check.mjs')),argv:[...argv],cwd:invocation});
    for (const stage of plan) for (const command of stage.commands) {
      state.gateCommands.push({script:fixtureIdentity(command.argv[0]),argv:command.argv.slice(1),cwd:directoryIdentity(command.cwd)});
    }
    return plan;
  }
  function frameworkScript(file) {
    const full = canonical(file), expected=frameworkIdentities.get(full);
    return Boolean(expected && JSON.stringify(fixtureIdentity(full))===JSON.stringify(expected));
  }
  const packages = createPackagePolicy(refuse, protectedPath, registerFixture, registerInline);
  function check(file, argv, options = {}, kind = 'spawn') {
    if (options.shell) refuse('shell-execution');
    if (typeof file !== 'string' || !Array.isArray(argv)) refuse('malformed-child-request');
    if (process.platform === 'linux') {
      const rel=path.relative(platformPaths.repository(),platformPaths.directory(options.cwd ?? process.cwd()));
      if (rel.startsWith('..') || path.isAbsolute(rel)) refuse('linux-child-cwd-outside-repository');
    }
    if (options.cwd && protectedPath(String(options.cwd))) refuse('original-or-real-resource-cwd');
    const packageRequest = packages.request(file, argv, options);
    if (packageRequest) {
      if (JSON.stringify(fixtureIdentity(packageRequest.file)) !== JSON.stringify(hostIdentity)) refuse('package-test-host-identity-drift');
      return packageRequest;
    }
    if (buildService && canonical(file) === buildService.identity.path
        && JSON.stringify(fixtureIdentity(file)) === JSON.stringify(buildService.identity)
        && argv[0] === `--service=${buildService.version}`
        && (argv.length === 1 || (argv.length === 2 && argv[1] === '--ping'))) return;
    if (/^(?:taskkill|taskkill\.exe)$/i.test(path.basename(file))) {
      if (!taskkillIdentity || (path.isAbsolute(file) && canonical(file) !== taskkillIdentity.path)
          || JSON.stringify(fixtureIdentity(taskkill)) !== JSON.stringify(taskkillIdentity)) refuse('tree-stop-binary-identity');
      const index = argv.findIndex((v) => String(v).toUpperCase() === '/PID');
      const pid = index < 0 ? NaN : Number(argv[index + 1]);
      const child = state.children.get(pid);
      if (!child || child.exitCode !== null || child.signalCode !== null) refuse('unowned-tree-stop');
      if (argv.some((v) => !['/PID', '/T', '/F', String(pid)].includes(String(v).toUpperCase()))) refuse('unexpected-tree-stop-argument');
      return;
    }
    const gitRequest = git.request(file, argv, options);
    if (gitRequest) return gitRequest;
    if (protectedPath(file) || argv.some((v) => typeof v === 'string' && protectedPath(v))) refuse('real-dsh-or-original-resource');
    if (canonical(file) !== node) refuse('unapproved-executable');
    const identity = fixtureIdentity(file);
    if (identity.dev !== hostIdentity.dev || identity.ino !== hostIdentity.ino || identity.hash !== hostIdentity.hash) refuse('test-host-identity-drift');
    if (kind === 'fork' && options.execPath && canonical(options.execPath) !== node) refuse('fork-executable-override');
    if (argv.length === 1 && argv[0] === '--version') return;
    // Gate CLI arguments belong to the script, not to Node: tsc's `-p` is
    // a project argument, not Node's inline --print. Check the exact pinned
    // request before the generic fixture option parser. Unknown requests deny.
    const gateScript=typeof argv[0]==='string' && !argv[0].startsWith('-') ? canonical(argv[0]) : null;
    const gateEntries=state.gateCommands.filter(entry=>entry.script.path===gateScript);
    if (gateEntries.length) {
      const actual=fixtureIdentity(gateScript), cwd=directoryIdentity(options.cwd ?? process.cwd());
      if (!gateEntries.some(entry=>JSON.stringify(entry.script)===JSON.stringify(actual)
          && JSON.stringify(entry.argv)===JSON.stringify(argv.slice(1))
          && JSON.stringify(entry.cwd)===JSON.stringify(cwd))) refuse('unreviewed-gate-command-or-cwd');
      return;
    }
    const codeIndex = argv.findIndex((v) => ['-e', '--eval', '-p', '--print'].includes(v));
    if (codeIndex >= 0) {
      const prefix = argv.slice(0, codeIndex);
      if (argv.length !== codeIndex + 2 || prefix.some(v => v !== '--input-type=module')) refuse('unreviewed-inline-options');
      if (!state.inline.has(digest(String(argv[codeIndex + 1])))) refuse('unreviewed-inline-fixture');
      return;
    }
    if (argv.some((v) => typeof v !== 'string' || /^--(?:eval|print)=/.test(v)) || !argv.length) refuse('unreviewed-node-options');
    // No arbitrary -r/--import/options that can run before the approved entry.
    if (argv[0].startsWith('-')) refuse('unreviewed-node-options');
    const script = canonical(argv[0]);
    if (frameworkScript(script)) {
      for (let index=1;index<argv.length;index++) {
        const arg=argv[index];
        if (/^(?:--(?:setupFiles|globalSetup|environment|workspace|project|root|dir|poolOptions|execArgv|inspect)(?:=|$)|-c$)/.test(arg)) refuse('unreviewed-framework-configuration');
        if (arg==='--config' || arg.startsWith('--config=')) {
          const config=arg==='--config'?argv[++index]:arg.slice('--config='.length);
          if (typeof config!=='string') refuse('missing-framework-config');
          const full=canonical(config);
          if (!crashConfig || full!==crashConfig.path || JSON.stringify(fixtureIdentity(full))!==JSON.stringify(crashConfig)) refuse('unreviewed-framework-config-file');
        }
        if (arg==='--reporter' || arg.startsWith('--reporter=')) {
          const reporter=arg==='--reporter'?argv[++index]:arg.slice('--reporter='.length);
          if (!['default','basic','json','dot','verbose','junit'].includes(reporter)) refuse('unreviewed-framework-reporter');
        }
      }
      return;
    }
    const expected = state.scripts.get(script);
    const pinned=expected && Object.fromEntries(Object.entries(expected).filter(([key])=>key!=='launch'));
    if (!expected || JSON.stringify(fixtureIdentity(script)) !== JSON.stringify(pinned)) refuse('unreviewed-or-changed-fixture');
    if (expected.launch && (JSON.stringify(argv.slice(1))!==JSON.stringify(expected.launch.argv)
        || JSON.stringify(directoryIdentity(options.cwd ?? process.cwd()))!==JSON.stringify(expected.launch.cwd))) refuse('unreviewed-fixture-argv-or-cwd');
  }
  function childOptions(options = {}) {
    const env = safeEnvironment(options.env ?? process.env);
    // Do not put the whole ledger into the Windows environment block or a
    // fixture's environment preview. Preserve immutable bytes in owned TEMP.
    const bytes = Buffer.from(JSON.stringify({ scripts: [...state.scripts.values()], inline: [...state.inline], git: git.ledger(), gateCommands:state.gateCommands }),'utf8');
    const ledger = path.join(os.tmpdir(), `offline-ledger-${crypto.randomUUID()}.json`);
    fs.writeFileSync(ledger, bytes, {flag:'wx'});
    env.COMPANYOS_OFFLINE_FIXTURE_LEDGER = ledger;
    env.COMPANYOS_OFFLINE_FIXTURE_LEDGER_SHA256 = digest(bytes);
    return { ...options, env };
  }
  function remember(child) {
    if (child?.pid && typeof child.once === 'function') {
      state.children.set(child.pid, child);
      child.once('close', () => state.children.delete(child.pid));
    }
    return child;
  }
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = cp[method];
    cp[method] = function(file, argv, options, callback) {
      const args = Array.isArray(argv) ? argv : [];
      const settings = typeof argv === 'object' && !Array.isArray(argv) && argv !== null ? argv : typeof options === 'object' && options !== null ? options : {};
      const cb = typeof argv === 'function' ? argv : typeof options === 'function' ? options : callback;
      if (method === 'spawn' && state.spawnFailures.has(path.resolve(file))) {
        if (settings.shell || fs.existsSync(file)) refuse('absent-fixture-became-executable');
        // Deterministic ENOENT fixture: no OS launch or executable allow rule.
        const child = new cp.ChildProcess();
        process.nextTick(() => child.emit('error', Object.assign(new Error('offline fixture ENOENT'), {code:'ENOENT'})));
        return child;
      }
      const request = check(file, args, settings);
      const executable = /^(?:taskkill|taskkill\.exe)$/i.test(path.basename(file)) ? taskkill : file;
      const child = remember(original.call(this, request?.file ?? executable, request?.argv ?? args, childOptions(request?.options ?? settings), cb));
      if (request?.packageTrace) {
        const trace = request.packageTrace;
        trace.PID = child.pid ?? null;
        if (typeof child.once === 'function') {
          child.once('close', (code, signal) => { trace.exitObserved = true; trace.exitCode = code; trace.signal = signal; trace.closedAt = new Date().toISOString(); });
          child.once('error', error => { trace.spawnError = error.code ?? 'UNKNOWN'; });
        } else { trace.exitObserved = true; trace.exitCode = child.status; trace.signal = child.signal; }
      }
      return child;
    };
  }
  const nativeFork = cp.fork;
  cp.fork = function(file, argv = [], options = {}) {
    if (!Array.isArray(argv)) { options = argv; argv = []; }
    check(options.execPath ?? process.execPath, [file, ...argv], options, 'fork');
    const execArgv = options.execArgv ?? process.execArgv;
    const frameworkConditions = frameworkScript(file) && execArgv.length % 2 === 0
      && execArgv.every((arg, i) => i % 2 === 0 ? arg === '--conditions' : ['node', 'module', 'development', 'production', 'node-addons'].includes(arg));
    if (execArgv.length && !frameworkConditions) refuse('unreviewed-fork-exec-options');
    return remember(nativeFork.call(this, file, argv, childOptions({ ...options, execArgv })));
  };
  cp.exec = (command, options, callback) => {
    // Vite's optional Windows mapped-drive optimisation already handles failure.
    // Return an explicit denial to that callback; never run `net use` or a shell.
    const cb = typeof options === 'function' ? options : callback;
    if (command === 'net use' && typeof cb === 'function') {
      const error = Object.assign(new Error('OFFLINE_TEST_EXECUTION_DENIED: optional-drive-query'), { code: 'OFFLINE_TEST_EXECUTION_DENIED' });
      process.nextTick(() => cb(error, '', ''));
      return new cp.ChildProcess();
    }
    return refuse('shell-execution');
  };
  cp.execSync = () => refuse('shell-execution');
  const local = (host) => host == null || host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(String(host));
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function(...args) {
    const data = Array.isArray(args[0]) ? args[0] : args;
    const arg = data[0];
    const pipe = typeof arg==='object' && arg!==null ? arg.path : typeof arg==='string' ? arg : null;
    if (typeof pipe==='string' && pipe.startsWith('\\\\') && !/^\\\\[.?]\\pipe\\/i.test(pipe)) refuse('nonlocal-named-pipe');
    if (typeof arg === 'object' && arg !== null && !arg.path && !local(arg.host)) refuse('nonlocal-network');
    if ((typeof arg === 'number' || (typeof arg === 'string' && /^\d+$/.test(arg))) && typeof data[1] === 'string' && !local(data[1])) refuse('nonlocal-network');
    return connect.apply(this, args);
  };
  const fetch = globalThis.fetch;
  if (fetch) globalThis.fetch = function(input, ...args) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!local(url.hostname)) refuse('nonlocal-network');
    return fetch.call(this, input, ...args);
  };
  syncBuiltinESMExports();
  Object.assign(state, { registerFixture, registerInline, registerGitWorkspace: git.register, registerReadOnlyGitRepository: git.registerReadOnlyRepository, registerSpawnFailure, registerPackageSnapshot: packages.register, registerCheckCommands, packageTraces: packages.traces, check });
  return state;
}
module.exports = { installOfflineGuard, safeEnvironment, protectedPath, resolveBuildService };
if (process.env.COMPANYOS_TEST_MODE === 'OFFLINE') {
  const fixtureChild = Boolean(process.env.COMPANYOS_OFFLINE_FIXTURE_LEDGER);
  installOfflineGuard();
  // Instrumentation has loaded before user code. It remains on patched APIs,
  // but private transport variables must not pollute production env probes.
  if (fixtureChild) for (const key of Object.keys(process.env)) {
    if (/^COMPANYOS_OFFLINE_/i.test(key) || key === 'NODE_OPTIONS' || key === 'COMPANYOS_TEST_MODE') delete process.env[key];
  }
}

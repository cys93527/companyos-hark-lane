// The finite expansion of the existing check gate, not a general npm runner.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const STAGES = [
  ['lint', 'pnpm exec eslint .'],
  ['typecheck', 'pnpm exec tsc -p tsconfig.json --noEmit'],
  ['boundaries', 'node scripts/check-boundaries.mjs'],
  ['architecture', 'node scripts/check-architecture.mjs'],
  ['test', 'node scripts/test-offline.mjs --exclude tests/provider/**'],
  ['build', 'pnpm run build'],
];
function parseCheckArgs(argv) {
  let only, rootOverride;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--only' || arg.startsWith('--only=')) {
      if (only !== undefined) throw Error('duplicate --only');
      only = arg === '--only' ? argv[++i] : arg.slice(7);
      if (!STAGES.some(([name]) => name === only)) throw Error(`unknown step "${only ?? ''}"`);
    } else if (arg === '--root' || arg.startsWith('--root=')) {
      if (rootOverride !== undefined) throw Error('duplicate --root');
      const value = arg === '--root' ? argv[++i] : arg.slice(7);
      if (!value || value.startsWith('-')) throw Error('--root requires a directory argument');
      rootOverride = path.resolve(value);
    } else throw Error(`unreviewed check argument: ${arg}`);
  }
  if (rootOverride && !['boundaries', 'architecture'].includes(only)) throw Error('--root requires --only boundaries or architecture');
  return { only, rootOverride };
}
function verifyBuildScripts(read = file => JSON.parse(fs.readFileSync(file, 'utf8'))) {
  const expected = [
    ['package.json', { build: 'pnpm run build:libs && pnpm run build:renderer && pnpm run build:desktop', 'build:libs': 'tsc -b tsconfig.build.json', 'build:renderer': 'pnpm --filter @companyos/renderer build', 'build:desktop': 'pnpm --filter @companyos/desktop build' }],
    ['apps/renderer/package.json', { build: 'vite build' }],
    ['apps/desktop/package.json', { build: 'tsc -b tsconfig.json' }],
  ];
  for (const [file, scripts] of expected) {
    const actual = read(path.join(ROOT, file)).scripts ?? {};
    for (const [key, value] of Object.entries(scripts)) {
      if (actual[key] !== value || actual[`pre${key}`] || actual[`post${key}`]) throw Error(`unreviewed build script: ${file}:${key}`);
    }
  }
}
function packageBin(pkg, name, cwd = ROOT) {
  const require = createRequire(path.join(cwd, 'package.json'));
  const metadata = require.resolve(`${pkg}/package.json`);
  const bin = JSON.parse(fs.readFileSync(metadata, 'utf8')).bin;
  const relative = typeof bin === 'string' ? bin : bin?.[name];
  if (!relative) throw Error(`missing CLI: ${pkg}:${name}`);
  const base = fs.realpathSync.native(path.dirname(metadata));
  const entry = fs.realpathSync.native(path.resolve(base, relative));
  const within = path.relative(base, entry);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) throw Error('CLI escaped package');
  return entry;
}
function createCheckPlan(argv = []) {
  const { only, rootOverride } = parseCheckArgs(argv);
  // Fail closed if the npm expansion ever changes, rather than omit new hooks.
  verifyBuildScripts();
  const command = (script, args = [], cwd = ROOT) => ({ executable: process.execPath, argv: [script, ...args], cwd });
  return STAGES.filter(([name]) => !only || name === only).map(([name, label]) => {
    let commands;
    switch (name) {
      case 'lint': commands = [command(packageBin('eslint', 'eslint'), ['.'])]; break;
      case 'typecheck': commands = [command(packageBin('typescript', 'tsc'), ['-p', 'tsconfig.json', '--noEmit'])]; break;
      case 'boundaries': case 'architecture':
        commands = [command(path.join(ROOT, 'scripts', `check-${name}.mjs`), rootOverride ? ['--root', rootOverride] : [])]; break;
      case 'test': commands = [command(path.join(ROOT, 'scripts', 'test-offline.mjs'), ['--exclude', 'tests/provider/**'])]; break;
      case 'build': {
        const renderer = path.join(ROOT, 'apps', 'renderer');
        commands = [command(packageBin('typescript', 'tsc'), ['-b', 'tsconfig.build.json']), command(packageBin('vite', 'vite', renderer), ['build'], renderer), command(packageBin('typescript', 'tsc'), ['-b', 'tsconfig.json'], path.join(ROOT, 'apps', 'desktop'))];
        break;
      }
      default: throw Error('unreviewed stage');
    }
    return { name, cmd: label, commands };
  });
}
module.exports = { ROOT, STAGES, parseCheckArgs, createCheckPlan, verifyBuildScripts };

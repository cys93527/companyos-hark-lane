// Test data only: never import the materializer or execute any supplied resource.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const B_HASH = '1A03DEE18683483FF6A1B27B2A1E650230DA6BCCA9A0F55F7D81B3308C3F307F';
export const TEXT_HASHES = Object.freeze({
  'profile-patch-template.yml': '4760E1A3CAEF826B2E712FA93F35982348434A26EFE570F66EE851DC09D72F9B',
  'headless-shell-guard.ps1': '076FF789BD2E6FE0242F30632969CED3E816BA89EC05642E404B6C238CE99BE7',
});
const EXPRESSIONS = Object.freeze({
  "profile-patch-template.yml": "72767FCA594D64F3B694F8C5AAE4CC9920326AD78DB7822212A5115F7631D849",
  "headless-shell-guard.ps1": "F4741DC6CADC654EC841E3A3AD50880DA248FFA1030074FCD6CD1CB78705CA1B"
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const fail = reason => { throw new Error(`OFFLINE_RESOURCE_PREPARATION_DENIED: ${reason}`); };
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

// Only a hash-pinned literal expression is evaluated in an empty, bounded VM.
// No materializer module, imports, process, filesystem, network or shell is exposed.
export function renderFixtureText(source, name) {
  if (!Object.hasOwn(TEXT_HASHES, name)) fail('unknown-text');
  const normalized = source.replaceAll('\r\n', '\n');
  // The same filename also appears in manifest metadata. Only the actual
  // writeFileSync literal declaration supplies test bytes.
  const markers = [...normalized.matchAll(new RegExp(`writeFileSync\\(\\s*join\\(target, '${name.replaceAll('.', '\\.')}'\\),`, 'g'))];
  if (markers.length !== 1) fail('ambiguous-template');
  const tail = normalized.slice(markers[0].index + markers[0][0].length);
  const match = /,\n\s*'utf8',/.exec(tail);
  if (!match) fail('missing-template-boundary');
  const expression = tail.slice(0, match.index).trim();
  if (digest(expression) !== EXPRESSIONS[name]) fail('template-source-drift');
  const text = new vm.Script(expression).runInNewContext(Object.create(null), {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false },
  });
  if (typeof text !== 'string' || digest(text) !== TEXT_HASHES[name]) fail('template-output-drift');
  return Buffer.from(text, 'utf8');
}

function checkedPath(root, rel, create = false) {
  let current = root;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (!inside(root, current)) fail('path-escape');
    if (!existsSync(current) && create && i < parts.length - 1) mkdirSync(current);
    // lstat also rejects dangling symlinks; existsSync alone does not.
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !inside(root, realpathSync(current))) fail('link-escape');
    if (i < parts.length - 1 && !stat.isDirectory()) fail('non-directory-parent');
    if (process.platform === 'linux' && (stat.uid !== process.getuid() || (stat.mode & 0o022))) fail('unowned-or-writable-path');
  }
  return current;
}

export function prepareOfflineResources(destination = ROOT) {
  if (!['win32', 'linux'].includes(process.platform)) fail('unknown-platform');
  if (typeof destination !== 'string' || destination.split(/[\\/]/).includes('..')) fail('path-traversal');
  if (destination === ROOT && globalThis[Symbol.for('companyos.offline-test-guard')]
      && !existsSync(path.join(ROOT, '.companyos-embedded/dsh-runtime/runtime/apps/cli/lib/bin.js'))) {
    fail('prepare-before-guard-preload-required');
  }
  // No environment variable grants a destination. Extra roots are owned local
  // regression fixtures below the repository's exact offline-gates directory.
  const lexical = path.resolve(destination);
  const root = realpathSync(lexical);
  const temporary = path.join(ROOT, '.tmp', 'offline-gates');
  if (lexical !== root || (root !== ROOT && !inside(temporary, root))) fail('unapproved-root');
  if (root !== ROOT) checkedPath(ROOT, path.relative(ROOT, root).split(path.sep).join('/'));
  const stat = statSync(root);
  if (!stat.isDirectory() || (process.platform === 'linux' && (stat.uid !== process.getuid() || (stat.mode & 0o022)))) fail('unowned-root');
  const kernel = readFileSync(checkedPath(ROOT, 'tests/fixtures/kernel-readonly/bin.js.txt'));
  if (kernel.length !== 11697 || digest(kernel) !== B_HASH) fail('kernel-byte-drift');
  const source = readFileSync(checkedPath(ROOT, 'scripts/materialize-embedded-dsh.mjs'), 'utf8');
  const records = [{ relativePath: '.companyos-embedded/dsh-runtime/runtime/apps/cli/lib/bin.js', bytes: kernel, sha256: B_HASH },
    ...Object.keys(TEXT_HASHES).map(name => ({ relativePath: `.companyos-embedded/dsh-runtime/${name}`, bytes: renderFixtureText(source, name), sha256: TEXT_HASHES[name] }))];
  // Check every existing target first. Never correct or overwrite a drifted file.
  for (const row of records) {
    const file = checkedPath(root, row.relativePath);
    if (existsSync(file) && (!lstatSync(file).isFile() || digest(readFileSync(file)) !== row.sha256)) fail('existing-resource-drift');
  }
  return records.map(row => {
    const file = checkedPath(root, row.relativePath, true);
    const created = !existsSync(file);
    if (created) writeFileSync(file, row.bytes, { flag: 'wx' });
    checkedPath(root, row.relativePath);
    if (digest(readFileSync(file)) !== row.sha256) fail('written-resource-drift');
    return { relativePath: row.relativePath, size: row.bytes.length, sha256: row.sha256, created };
  });
}

// Fixed, file-only preparation entry. It neither installs nor starts a Kernel.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) fail('unexpected-arguments');
  console.log(JSON.stringify(prepareOfflineResources()));
}

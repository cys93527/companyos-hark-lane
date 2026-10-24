/* Test-only expansion of the two reviewed validator fixture chains and M3.
 * This is not an npm interpreter or a production launcher. The production port
 * still owns capture/deadline/settlement; its exact shell request is expanded to
 * a pinned Node process only for these finite, lifecycle-free snapshot fixtures.
 */
const fs = require('node:fs');
const path = require('node:path');
const {createPlatformPaths} = require('./test-offline-git.cjs');
const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const real = file => fs.realpathSync.native(path.resolve(file));
const within = (root,file) => { const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel); };
const identity = file => {const stat=fs.statSync(file,{bigint:true});return {path:real(file),dev:String(stat.dev),ino:String(stat.ino)};};
const MATH_TEST = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { multiply } from '../src/math.ts';\ntest('multiply', () => { assert.equal(multiply(4, 3), 12); });\n";
const M3_MATH_TEST = "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { multiply } from '../src/math.ts'; test('multiply', () => assert.equal(multiply(4, 3), 12));\n";
const M3_MATH_SOURCES = ['export const multiply = (a: number, b: number) => a * b;\n', 'export const multiply = (a: number, b: number) => a - b;\n'];
const CORRECTIVE_MATH_TEST="import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add, multiply } from '../src/math.ts';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n});\n\ntest('multiply', () => {\n  assert.equal(multiply(4, 3), 12);\n});\n";
const F5_MATH_SOURCES=['a * b','a - b'].map(body=>`export function multiply(a: number, b: number): number {\n  return ${body};\n}\n`);
const CORRECTIVE_MATH_SOURCES=['a * b','a - b'].map(body=>`export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return ${body};\n}\n`);
const ENV_PROBE = "console.log(JSON.stringify({key:process.env.COS_MODEL_API_KEY??null,token:process.env.ACCESS_TOKEN??null,proxy:process.env.HTTPS_PROXY??null}))";
const inline = [
 "require('fs').writeFileSync('mutated-by-test.txt','x')",
 "require('fs').writeFileSync('../escape.txt','x')",
 "const fs=require('fs'); fs.writeFileSync('validator-write.txt','x'); fs.writeFileSync('../validator-escape.txt','x');",
 "const d=require('local-dep'); if(d.answer()!==42) process.exit(1)",
 "const fs=require('fs'); fs.writeFileSync('vint/written.txt','x'); fs.readFileSync('vint/keep.txt','utf8');",
 "process.exit(0)", "process.exit(23)", "console.log('two-chain-marker')",
 "setInterval(() => {}, 1000)", ENV_PROBE,
];
const scripts = new Map(inline.flatMap(code=>[
 [`node -e ${JSON.stringify(code)}`,['-e',code]],
 [`node -e "${code}"`,['-e',code]],
]));
scripts.set('node --test tests/math.test.ts',['--test','tests/math.test.ts']);
const modules = new Map([
 ['tests/math.test.ts',new Set([MATH_TEST, M3_MATH_TEST, CORRECTIVE_MATH_TEST])],
 ['src/math.ts',new Set(['export const multiply = (a: number, b: number): number => a * b;\n','export const multiply = (a: number, b: number): number => a - b;\n', ...M3_MATH_SOURCES,...F5_MATH_SOURCES,...CORRECTIVE_MATH_SOURCES])],
 ['node_modules/local-dep/index.js',new Set(['exports.answer = () => 42;\n'])],
]);
function createPackagePolicy(refuse, protectedPath, registerFixture, registerInline) {
 const paths=createPlatformPaths(refuse,protectedPath);
 const profiles=new Map(), traces=[];
 function inventory(cwd) {
  const root=paths.directory(cwd),temp=paths.temporary();
  if(!within(temp,root)||protectedPath(root)||!/^companyos-testcheck-/.test(path.basename(root))) refuse('package-snapshot-not-owned');
  for(let current=root;current!==path.parse(current).root;current=path.dirname(current)) if(fs.lstatSync(current).isSymbolicLink()) refuse('package-reparse-parent');
  const files=[];let bytes=0;
  function walk(dir) {
   for(const name of fs.readdirSync(dir).sort()) {
    const file=path.join(dir,name),stat=fs.lstatSync(file),rel=path.relative(root,file).replaceAll('\\','/');
    if(stat.isSymbolicLink()||!within(root,real(file))) refuse('package-snapshot-link');
    if(stat.isDirectory()) {if(rel.split('/').length>8)refuse('package-snapshot-depth');walk(file);continue;}
    if(!stat.isFile()||files.length>=128||(bytes+=stat.size)>1024*1024) refuse('package-snapshot-bounds');
    const content=fs.readFileSync(file), extension=path.extname(rel).toLowerCase();
    if(!['.json','.txt','.js','.ts'].includes(extension)) refuse('package-unreviewed-file-type');
    if(['.js','.ts'].includes(extension)&&!modules.get(rel)?.has(content.toString('utf8'))) refuse('package-unreviewed-module');
    if(rel==='node_modules/local-dep/package.json'&&JSON.stringify(JSON.parse(content))!==JSON.stringify({name:'local-dep',main:'index.js'})) refuse('package-unreviewed-dependency');
    if(extension==='.json'&&!['package.json','node_modules/local-dep/package.json'].includes(rel)) refuse('package-unreviewed-json');
    files.push({rel,identity:identity(file),hash:digest(content)});
   }
  }
  walk(root);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(Object.keys(manifest).length!==1||!manifest.scripts||Object.keys(manifest.scripts).join(',')!=='test'||!scripts.has(manifest.scripts.test)) refuse('package-unreviewed-script-or-lifecycle');
  const argv=scripts.get(manifest.scripts.test);
  if(argv[0]==='--test'&&!files.some(row=>row.rel===argv[1])) refuse('package-missing-test-entry');
  return {root:identity(root),files,script:manifest.scripts.test,argv};
 }
 function register(cwd) {
  const profile=inventory(cwd);
  for(const row of profile.files)if(modules.has(row.rel))registerFixture(row.identity.path);
  if(profile.argv[0]==='-e')registerInline(profile.argv[1]);
  profiles.set(profile.root.path,profile);
  return profile;
 }
 function request(file,argv,options) {
  const shell=path.basename(file).toLowerCase();
  if(!['cmd.exe','cmd','sh'].includes(shell))return null;
  const expected=process.platform==='win32'?['/d','/s','/c','npm test']:['-c','npm test'];
  if((process.platform==='win32'?file!=='cmd.exe':file!=='/bin/sh')||JSON.stringify(argv)!==JSON.stringify(expected)||options.shell) refuse('unreviewed-package-shell-request');
  const cwd=path.resolve(options.cwd??'.'),profile=profiles.get(cwd);
  if(!profile)refuse('unregistered-package-snapshot');
  if(JSON.stringify(inventory(cwd))!==JSON.stringify(profile))refuse('package-snapshot-identity-drift');
  const trace={requestedAt:new Date().toISOString(),parentPID:process.pid,requestedFile:file,requestedArgv:[...argv],cwd,node:real(process.execPath),expandedArgv:[...profile.argv],treeSHA256:digest(JSON.stringify(profile.files)),PID:null,exitObserved:false,exitCode:null,signal:null,spawnError:null};
  traces.push(trace);
  // A fresh --test root must not masquerade as the outer node:test worker.
  // Its own runner supplies child context to the reviewed math test afterwards.
  const env={...(options.env??process.env)};
  for(const key of Object.keys(env))if(/^NODE_TEST_/i.test(key))delete env[key];
  return {file:real(process.execPath),argv:[...profile.argv],options:{...options,env},packageTrace:trace};
 }
 return {register,request,traces};
}
module.exports={createPackagePolicy, MATH_TEST, M3_MATH_TEST, M3_MATH_SOURCES, ENV_PROBE};

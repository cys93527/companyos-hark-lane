import './offline-test-profile.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {createRequire} from 'node:module';

// MOCK platform/filesystem contracts: no Linux process or binary is executed.
// Load the actual three scripts, not a duplicate implementation of the policy.
const sources=new Map(['git','package','guard'].map(name=>[name,readFileSync(new URL(`../test-offline-${name}.cjs`,import.meta.url),'utf8')]));
function model(platform='linux',arch='x64',givenRoot=null) {
  const p=platform==='win32'?path.win32:path.posix;
  const root=givenRoot??(platform==='win32'?'F:\\CompanyOS-V1-Acceptance\\repo':'/home/runner/work/companyos/companyos');
  const tmp=p.join(root,'.tmp','offline-gates','worker-mock123');
  const rows=new Map(),aliases=new Map(); let serial=0;
  const normalize=s=>p.resolve(s);
  function directory(s) {s=normalize(s);if(rows.has(s))return;const parent=p.dirname(s);if(parent!==s)directory(parent);rows.set(s,{kind:'dir',ino:++serial,mode:0o40755});}
  function file(s,bytes='binary',mode=0o100755) {s=normalize(s);directory(p.dirname(s));rows.set(s,{kind:'file',ino:++serial,mode,bytes:Buffer.from(bytes)});return s;}
  function real(s) {s=normalize(s);for(const [from,to] of aliases)if(from!==to&&(s===from||s.startsWith(from+p.sep)))return real(to+s.slice(from.length));if(!rows.has(s))throw Object.assign(new Error('MOCK ENOENT'),{code:'ENOENT'});return s;}
  function stat(s,follow=true) {s=follow?real(s):normalize(s);const row=rows.get(s);if(!row)throw new Error('MOCK ENOENT');return {dev:1n,ino:BigInt(row.ino),uid:1000,mode:row.mode,size:row.bytes?.length??0,isDirectory:()=>row.kind==='dir',isFile:()=>row.kind==='file',isSymbolicLink:()=>aliases.has(s)};}
  const fs={realpathSync:Object.assign(real,{native:real}),statSync:stat,lstatSync:s=>stat(s,false),existsSync:s=>{try{real(s);return true;}catch{return false;}},
    readFileSync:(s,encoding)=>{const b=rows.get(real(s)).bytes;if(!b)throw new Error('MOCK EISDIR');return encoding?b.toString(encoding):b;},
    readdirSync:s=>{s=real(s);return [...rows.keys()].filter(key=>p.dirname(key)===s&&key!==s).map(key=>p.basename(key));},
    mkdirSync:directory,mkdtempSync:s=>{const d=s+'mock'+(++serial);directory(d);return d;}};
  directory(root);directory(tmp);
  const node=file(platform==='win32'?'C:\\Program Files\\nodejs\\node.exe':'/usr/bin/node');
  const git=file(platform==='win32'?'F:\\tools\\git.exe':'/usr/bin/git');
  const dep=p.join(root,'node_modules');directory(dep);
  const vite=file(p.join(dep,'.pnpm','vite','index.js'));
  const esbuild=file(p.join(dep,'.pnpm','esbuild','lib','main.js'));
  const host=file(p.join(dep,'.pnpm','esbuild','package.json'),JSON.stringify({name:'esbuild',version:'0.25.12'}));
  const name=platform==='win32'?'@esbuild/win32-x64':`@esbuild/linux-${arch}`;
  const pkg=file(p.join(dep,'.pnpm','platform','package.json'),JSON.stringify({name,version:'0.25.12'}));
  const binary=file(p.join(p.dirname(pkg),platform==='win32'?'esbuild.exe':'bin/esbuild'));
  const resolution={'vitest/vitest.mjs':file(p.join(dep,'vitest','vitest.mjs')),vite,esbuild,'esbuild/package.json':host,[`${name}/package.json`]:pkg};
  const proc={platform,arch,pid:123,getuid:()=>1000,env:{PATH:p.dirname(git),CI:'true'},cwd:()=>root,execPath:node,execArgv:[]};
  const cache=new Map();let nativeCalls=0;
  const cp=Object.fromEntries(['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork'].map(key=>[key,()=>{nativeCalls++;throw new Error('MOCK native launch forbidden');}]));
  const context=vm.createContext({Buffer,URL,console,process:proc});
  function load(name) {
    if(cache.has(name))return cache.get(name);
    const mod={exports:{}};cache.set(name,mod.exports);
    const req=id=>{
      const builtins={'node:fs':fs,'node:path':p,'node:os':{tmpdir:()=>tmpOverride??tmp,endianness:()=>endianness},'node:crypto':crypto,'node:child_process':cp,'node:net':{Socket:class{connect(){}}},'node:module':{syncBuiltinESMExports(){}}};
      if(id in builtins)return builtins[id];
      const match=/^\.\/test-offline-(git|package)\.cjs$/.exec(id);if(match)return load(match[1]);
      throw new Error('MOCK unregistered require '+id);
    };
    req.resolve=id=>{if(!(id in resolution))throw new Error('MOCK unregistered module '+id);return resolution[id];};
    vm.runInContext('(function(require,module,exports,__dirname,__filename){'+sources.get(name)+'\n})',context,{filename:`MOCK-${platform}-${name}.cjs`})(req,mod,mod.exports,p.join(root,'scripts'),p.join(root,'scripts',`test-offline-${name}.cjs`));
    cache.set(name,mod.exports);return mod.exports;
  }
  let tmpOverride=null,endianness='LE';
  const refuse=reason=>{throw new Error('OFFLINE_TEST_EXECUTION_DENIED: '+reason);};
  const protectedPath=()=>false;
  const paths=()=>load('git').createPlatformPaths(refuse,protectedPath);
  return {p,root,tmp,node,git,pkg,binary,host,rows,aliases,resolution,file,directory,load,proc,paths,refuse,protectedPath,
    temp:value=>{tmpOverride=value;},endian:value=>{endianness=value;},nativeCalls:()=>nativeCalls};
}
const denied=fn=>assert.throws(fn,/OFFLINE_TEST_EXECUTION_DENIED|MOCK ENOENT/);

for(const platform of ['win32','linux']) {
  test(`MOCK ${platform}: installed repository and owned temp ALLOW`,()=>{
    const m=model(platform);assert.equal(m.paths().repository(),m.root);assert.equal(m.paths().temporary(),m.tmp);
  });
  test(`MOCK ${platform}: Git exact read-only query ALLOW; mutation DENY`,()=>{
    const m=model(platform),policy=m.load('git').createGitPolicy(m.refuse,m.protectedPath,[],m.root);
    policy.registerReadOnlyRepository();assert.equal(policy.request(m.git,['ls-files','packs/dev-company'],{cwd:m.root}).file,m.git);
    denied(()=>policy.request(m.git,['commit','-m','escape'],{cwd:m.root}));
  });
  test(`MOCK ${platform}: registered package expands only reviewed npm test to Node`,()=>{
    const m=model(platform),cwd=m.p.join(m.tmp,'companyos-testcheck-fixture');m.directory(cwd);
    m.file(m.p.join(cwd,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(23)"'}}));
    const policy=m.load('package').createPackagePolicy(m.refuse,m.protectedPath,()=>{},()=>{});policy.register(cwd);
    const shell=platform==='win32'?'cmd.exe':'/bin/sh',args=platform==='win32'?['/d','/s','/c','npm test']:['-c','npm test'];
    const command=policy.request(shell,args,{cwd});assert.equal(command.file,m.node);assert.equal(command.argv[1],'process.exit(23)');
    denied(()=>policy.request(shell,[...args.slice(0,-1),'npm run arbitrary'],{cwd}));assert.equal(m.nativeCalls(),0);
  });
  test(`MOCK ${platform}: exact esbuild service ALLOW; impostor/argv/shell DENY`,()=>{
    const m=model(platform),guard=m.load('guard'),service=guard.resolveBuildService();assert.equal(service.identity.path,m.binary);
    const state=guard.installOfflineGuard();assert.equal(state.check(m.binary,['--service=0.25.12','--ping']),undefined);
    const fake=m.file(m.p.join(m.tmp,m.p.basename(m.binary)));
    for(const [file,args,opts] of [[fake,['--service=0.25.12'],{}],[m.binary,['--service=0.25.12','--eval=attack'],{}],[m.binary,['--service=0.25.12'],{shell:true}],['powershell',['icacls'],{}],['npm',['test'],{}]]) denied(()=>state.check(file,args,opts));
    assert.equal(m.nativeCalls(),0);
  });
}
test('MOCK Windows: non-F temporary path DENY',()=>{const m=model('win32');m.directory('C:\\temp');m.temp('C:\\temp');denied(()=>m.paths().temporary());});
test('MOCK Windows: unauthorized E-drive repository override DENY',()=>{const m=model('win32');m.directory('E:\\untrusted');denied(()=>m.load('git').createPlatformPaths(m.refuse,m.protectedPath,'E:\\untrusted'));});
test('MOCK Windows: script installed on E instead of F DENY',()=>{const m=model('win32','x64','E:\\untrusted');denied(()=>m.paths());});
test('MOCK Linux: arbitrary /tmp and CI/environment-selected roots DENY',()=>{
  const m=model();m.directory('/tmp/worker-owned-looking');m.temp('/tmp/worker-owned-looking');m.proc.env.COMPANYOS_REPO_ROOT=m.root;m.proc.env.CI='true';denied(()=>m.paths().temporary());
});
test('MOCK Linux: profile parent and unowned names DENY',()=>{const m=model();for(const rel of ['', 'unregistered-profile']){const dir=m.p.join(m.root,'.tmp','offline-gates',rel);m.directory(dir);m.temp(dir);denied(()=>m.paths().temporary());}});
test('MOCK Linux: unknown repository override DENY',()=>{const m=model();m.directory('/other/repo');denied(()=>m.load('git').createPlatformPaths(m.refuse,m.protectedPath,'/other/repo'));});
test('MOCK Linux: traversal and symlink escape DENY',()=>{const m=model();denied(()=>m.paths().directory(m.tmp+'/../worker-mock123'));m.directory('/outside');const link=m.p.join(m.tmp,'alias');m.directory(link);m.aliases.set(link,'/outside');denied(()=>m.paths().directory(link));});
test('MOCK Linux: symlink parent DENY even when final spelling aliases back',()=>{const m=model();const link=m.p.join(m.root,'.tmp');m.aliases.set(link,link);denied(()=>m.paths().temporary());});
test('MOCK Linux: root identity change after registration DENY',()=>{const m=model(),paths=m.paths();m.rows.get(m.root).ino++;denied(()=>paths.repository());});
test('MOCK Linux: group/world writable profile DENY',()=>{const m=model();m.rows.get(m.tmp).mode=0o40777;denied(()=>m.paths().temporary());});
test('MOCK unknown operating system DENY',()=>{const m=model('darwin');denied(()=>m.paths());denied(()=>m.load('guard').resolveBuildService());});
test('MOCK esbuild: unknown architecture/endianness DENY',()=>{for(const arch of ['s390x','unknown']){const m=model('linux',arch);denied(()=>m.load('guard').resolveBuildService());}const m=model();m.endian('BE');denied(()=>m.load('guard').resolveBuildService());});
test('MOCK esbuild: dependency path escape DENY',()=>{const m=model();m.resolution[`${JSON.parse(m.rows.get(m.pkg).bytes).name}/package.json`]=m.file('/tmp/package.json',JSON.stringify({name:'@esbuild/linux-x64',version:'0.25.12'}));denied(()=>m.load('guard').resolveBuildService());});
test('MOCK esbuild: metadata drift and binary alias DENY',()=>{
  const m=model();m.rows.get(m.pkg).bytes=Buffer.from(JSON.stringify({name:'fake-esbuild',version:'0.25.12'}));denied(()=>m.load('guard').resolveBuildService());
  const n=model();const outside=n.file('/outside/esbuild');n.aliases.set(n.binary,outside);denied(()=>n.load('guard').resolveBuildService());
});
test('MOCK Linux: unregistered Node/Shell/DSH targets and external cwd DENY',()=>{
  const m=model(),state=m.load('guard').installOfflineGuard();
  const unknown=m.file(m.p.join(m.tmp,'unregistered.cjs'),'process.exit(0)');
  const kernel=m.file(m.p.join(m.root,'.companyos-embedded','dsh-runtime','runtime','apps','cli','lib','bin.js'));
  for(const [file,args,opts] of [[m.node,[unknown],{}],[m.node,[kernel],{}],['/bin/sh',['-c','node arbitrary.cjs'],{}],[m.node,['--version'],{cwd:'/usr/bin'}]])denied(()=>state.check(file,args,opts));
  assert.equal(m.nativeCalls(),0);
});
test('MOCK esbuild: environment override cannot change admitted target',()=>{const m=model();m.proc.env.ESBUILD_BINARY_PATH='/tmp/esbuild';assert.equal(m.load('guard').resolveBuildService().identity.path,m.binary);});
test('Actual host: installed esbuild pinned identity accepts only reviewed service argv',()=>{
  const require=createRequire(import.meta.url),guard=require('../test-offline-guard.cjs'),service=guard.resolveBuildService();
  assert.equal(guard.installOfflineGuard().check(service.identity.path,[`--service=${service.version}`]),undefined);
  denied(()=>guard.installOfflineGuard().check(service.identity.path,['--version']));
  assert.equal(process.platform,os.platform());
});

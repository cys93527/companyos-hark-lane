import './offline-test-profile.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const cp=require('node:child_process');
const guard=require('../test-offline-guard.cjs').installOfflineGuard();
const root=fileURLToPath(new URL('../../',import.meta.url));
const denied=fn=>assert.throws(fn,/OFFLINE_TEST_EXECUTION_DENIED/);
const temporary=body=>{const dir=mkdtempSync(join(tmpdir(),'rc-boundary-'));try{return body(dir);}finally{rmSync(dir,{recursive:true,force:true});}};

test('RC2 only the two exact read-only candidate queries reach the pinned Git binary',()=>{
  const row=guard.registerReadOnlyGitRepository();
  assert.equal(row.readOnly,true);assert.match(row.binary.hash,/^[0-9a-f]{64}$/);
  assert.match(cp.execFileSync('git',['rev-parse','--verify','refs/tags/sprint-11.0.0'],{cwd:root,encoding:'utf8'}).trim(),/^[0-9a-f]{40}$/);
  assert.match(cp.execFileSync(row.binary.path,['ls-files','packs/dev-company'],{cwd:root,encoding:'utf8'}),/packs\/dev-company\/package.json/);
});
test('RC2 alternate refs/pathspecs, config injection and mutations remain denied',()=>{
  guard.registerReadOnlyGitRepository();
  for(const argv of [['rev-parse','--verify','HEAD'],['ls-files','.'],['ls-files','../outside'],['status'],['add','.'],['commit','-m','forbidden'],['fetch'],['-c','alias.attack=!cmd','attack']]) denied(()=>cp.spawn('git',argv,{cwd:root}));
});
test('RC2 unregistered cwd and same-name executable are not read-only aliases',()=>temporary(dir=>{
  guard.registerReadOnlyGitRepository();
  denied(()=>cp.spawn('git',['ls-files','packs/dev-company'],{cwd:dir}));
  const impostor=join(dir,'git.exe');writeFileSync(impostor,'not an executable');
  denied(()=>cp.spawn(impostor,['ls-files','packs/dev-company'],{cwd:root}));
  denied(()=>cp.spawn('git',['ls-files','packs/dev-company'],{cwd:root,shell:true}));
}));
test('RC3 exact fixture identity, argv and cwd execute actual stdout and native exit',()=>temporary(dir=>{
  const file=join(dir,'bin.cjs');writeFileSync(file,"process.stdout.write('actual-output');process.exit(23);\n");
  guard.registerFixture(file,{argv:['--profile','fixture','--json','task'],cwd:dir});
  const result=cp.spawnSync(process.execPath,[file,'--profile','fixture','--json','task'],{cwd:dir,encoding:'utf8',timeout:5000});
  assert.equal(result.status,23);assert.equal(result.stdout,'actual-output');
}));
test('RC3 altered argv/cwd/hash or unknown entry cannot reach an OS launch',()=>temporary(dir=>{
  const file=join(dir,'bin.cjs');writeFileSync(file,"process.stdout.write('x');\n");
  guard.registerFixture(file,{argv:['task'],cwd:dir});
  denied(()=>cp.spawn(process.execPath,[file,'other'],{cwd:dir}));
  const other=join(dir,'other');mkdirSync(other);
  denied(()=>cp.spawn(process.execPath,[file,'task'],{cwd:other}));
  denied(()=>cp.spawn(process.execPath,['--test'],{cwd:dir}));
  denied(()=>cp.spawn('cmd.exe',['/c',process.execPath,file],{cwd:dir}));
  writeFileSync(file,"process.stdout.write('changed');\n");
  denied(()=>cp.spawn(process.execPath,[file,'task'],{cwd:dir}));
}));

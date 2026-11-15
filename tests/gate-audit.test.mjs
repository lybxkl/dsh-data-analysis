/** Audit regressions use real Windows junctions, Python and current reports. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {readGatePolicy,loadStageReport} from '../src/gate-report.js';
import {inspectAfterRun,invalidateGateReports} from '../src/gate-inspection.js';
import {adjudicationSnapshot,evaluateHostProject} from '../src/gate-host.js';
import {implementationBindings} from '../src/gate-report.js';
import {validateSchema} from '../src/gate-schema.js';
import {Runner} from '../src/runner.js';
import {Workbench} from '../src/service.js';
import {acquireProjectLease} from '../src/gate-lease.js';
import {syncMaterialRoots} from '../src/gate-material-roots.js';
import {parseCsv} from '../src/audit.js';
import {gateTotals} from '../src/gates.js';

const skill=process.env.DSA_SKILL_ROOT;
assert.ok(skill,'DSA_SKILL_ROOT is required');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'dsa-audit-'));
const python=process.env.PYTHON||'python';
const write=(root,rel,value)=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='object'?JSON.stringify(value):value);};
const cli=(root,...args)=>spawnSync(python,[path.join(skill,'scripts/gates.py'),...args,'--root',root],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
const link=(target,file)=>fs.symlinkSync(target,file,process.platform==='win32'?'junction':'dir');
let passed=0,failed=0;
async function check(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
try{
  await check('Unknown schema keywords fail closed',()=>assert.throws(()=>validateSchema([1,2],{type:'array',maxItems:1}),/unsupported schema keyword/));
  await check('Formal CSV rejects missing cells, duplicate headers and unterminated quotes',()=>{
    for(const text of ['a,a\n1,2\n','a,b\n1\n','a\n"unterminated'])assert.throws(()=>parseCsv(text,{strict:true}));
  });
  const root=path.join(base,'project'),a=path.join(base,'a'),b=path.join(base,'b');
  for(const dir of [root,a,b,path.join(root,'data')])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(a,'source.csv'),'id,in_analysis\n001,1\n');
  fs.writeFileSync(path.join(b,'source.csv'),'id,in_analysis\n001,0\n');
  assert.equal(cli(root,'init-policy').status,0);
  write(root,'.workbench/gates/roots.json',{schema:'dsa.gate-roots/1',roots:{'material:a':a,'material:b':b}});
  const mount=path.join(root,'data/mount');link(a,mount);
  write(root,'research_registry.json',{source_root:'raw',datasets:[{id:'x',path:'data/mount/source.csv',key:'id'}]});
  assert.equal(cli(root,'evaluate','--stage','dataset').status,0);
  assert.equal(loadStageReport(root,{skill:{root:skill}},readGatePolicy(root),'dataset').find(g=>g.id==='dataset-in-analysis').status,'pass');
  if(process.platform==='win32')fs.rmdirSync(mount);else fs.unlinkSync(mount);
  link(b,mount);
  await check('JavaScript rejects a retargeted project alias',()=>{
    let status;try{status=loadStageReport(root,{skill:{root:skill}},readGatePolicy(root),'dataset').find(g=>g.id==='dataset-in-analysis').status;}catch{status='rejected';}
    assert.notEqual(status,'pass');
  });
  await check('Python rejects a retargeted project alias',()=>assert.notEqual(cli(root,'validate-report','--report','output/gates/dataset.json').status,0));

  const external=path.join(base,'external-state');fs.mkdirSync(external);
  write(external,'qa.json',{stage:'qa',phase:'running',generation:1});
  const recovery=path.join(base,'recovery');fs.mkdirSync(path.join(recovery,'output/gates'),{recursive:true});
  link(external,path.join(recovery,'output/gates/state'));
  await check('Recovery does not write through an outside state directory',()=>{
    const before=fs.readFileSync(path.join(external,'qa.json'),'utf8');
    assert.notEqual(cli(recovery,'recover').status,0);
    assert.equal(fs.readFileSync(path.join(external,'qa.json'),'utf8'),before);
  });
  await check('Production invalidation does not write outside the project',()=>{
    write(recovery,'.workbench/gates/policy.json',JSON.parse(fs.readFileSync(path.join(root,'.workbench/gates/policy.json'))));
    const before=fs.readFileSync(path.join(external,'qa.json'),'utf8');
    try{invalidateGateReports(recovery);}catch{}
    assert.equal(fs.readFileSync(path.join(external,'qa.json'),'utf8'),before);
  });
  await check('Invalid inspection stage cannot escape the state directory',async()=>{
    const target=path.join(base,'escape-target.json');
    await inspectAfterRun({root,skillRoot:skill,python,stageIds:['../../../../escape-target']});
    assert.ok(!fs.existsSync(target));
  });
  const review=path.join(base,'review');fs.mkdirSync(review);
  assert.equal(cli(review,'init-policy','--mode','skill').status,0);
  write(review,'research_registry.json',{datasets:[{id:'x',path:'data.csv',key:'id'}]});
  write(review,'data.csv','id,in_analysis\na,1\n');
  write(review,'output/recheck/issues.jsonl','');
  const project={skill:{root:skill}};
  assert.equal(cli(review,'evaluate','--stage','dataset').status,0);
  const snapshot=adjudicationSnapshot(review,project);
  assert.ok(snapshot,'fresh inspected project has a reviewable snapshot');
  await check('Pure checker refresh preserves the manual evidence snapshot',()=>{
    assert.equal(cli(review,'evaluate','--stage','dataset').status,0);
    assert.equal(adjudicationSnapshot(review,project),snapshot);
  });
  await check('Changing the issue ledger invalidates its manual signature',()=>{
    write(review,'output/recheck/issues.jsonl','{"id":"I1","severity":"error","status":"open"}\n');
    assert.notEqual(adjudicationSnapshot(review,project),snapshot);
  });
  await check('Malformed ledger cannot report zero unresolved issues',()=>{
    write(review,'output/recheck/issues.jsonl','{"id":"I1","severity":"error","status":"open"\n');
    const stages=evaluateHostProject({projectRoot:review,project});
    assert.equal(stages.find(s=>s.id==='recheck').gates.find(g=>g.id==='recheck-issues').status,'unjudged');
    const bench=new Workbench({getConfig:()=>({}),store:{get:()=>({}),set:()=>{}},runner:{}});
    bench.active=()=>({ok:true,path:review});
    const before=fs.readFileSync(path.join(review,'output/recheck/issues.jsonl'),'utf8');
    assert.equal(bench.recordIssue({id:'new',severity:'info'}).ok,false);
    assert.equal(fs.readFileSync(path.join(review,'output/recheck/issues.jsonl'),'utf8'),before);
  });
  await check('Deferred error remains a delivery blocker',()=>{
    write(review,'output/recheck/issues.jsonl','{"id":"I1","severity":"error","status":"deferred"}\n');
    const stages=evaluateHostProject({projectRoot:review,project});
    assert.equal(stages.find(s=>s.id==='recheck').gates.find(g=>g.id==='recheck-issues').status,'fail');
  });
  await check('Null snapshot cannot satisfy R8 coverage',()=>{
    const state=JSON.parse(fs.readFileSync(path.join(review,'output/gates/state/dataset.json')));
    write(review,'output/gates/state/dataset.json',{...state,phase:'running'});
    write(review,'output/recheck/coverage.json',{R8:{status:'checked',note:'reviewed',snapshotHash:null}});
    const stages=evaluateHostProject({projectRoot:review,project});
    assert.equal(stages.find(s=>s.id==='recheck').gates.find(g=>g.id==='recheck-machine').checks.find(c=>c.id==='R8').status,'unjudged');
  });
  await check('Manual decision cannot claim an absent current snapshot',()=>{
    const bench=new Workbench({getConfig:()=>({}),store:{get:()=>({}),set:()=>{}},runner:{}});
    bench.active=()=>({ok:true,path:review,id:'review'});bench.stageById=()=>({id:'qa'});
    bench.snapshot=()=>({stages:[{id:'qa',gates:[{id:'qa-signoff',manual:true,snapshotHash:null}]}]});
    assert.equal(bench.adjudicate({stageId:'qa',gateId:'qa-signoff',status:'pass'}).ok,false);
  });
  await check('Removing mounts also removes obsolete host root permissions',()=>{
    write(review,'.workbench/gates/roots.json',{schema:'dsa.gate-roots/1',roots:{'material:host-obsolete':a,'material:explicit':b}});
    syncMaterialRoots(review,{materials:{mounts:[]}},[]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(review,'.workbench/gates/roots.json'))).roots,{'material:explicit':b});
  });
  const copied=path.join(base,'copied-skill');
  function copy(source,target){
    fs.mkdirSync(target,{recursive:true});
    for(const entry of fs.readdirSync(source,{withFileTypes:true})){
      if(entry.name==='__pycache__')continue;
      const from=path.join(source,entry.name),to=path.join(target,entry.name);
      if(entry.isDirectory())copy(from,to);else fs.writeFileSync(to,fs.readFileSync(from));
    }
  }
  copy(skill,copied);
  await check('Changing a checker invalidates the manual snapshot',()=>{
    assert.equal(cli(review,'evaluate','--stage','dataset').status,0);
    assert.ok(adjudicationSnapshot(review,{skill:{root:copied}}));
    const code=path.join(copied,'scripts/gate_facts.py'),original=fs.readFileSync(code);
    fs.appendFileSync(code,'\n# changed checker implementation\n');
    assert.equal(adjudicationSnapshot(review,{skill:{root:copied}}),null);
    fs.writeFileSync(code,original);
  });
  await check('Unlisted importable code invalidates the package closure',()=>{
    implementationBindings(copied);
    fs.writeFileSync(path.join(copied,'scripts/unlisted_checker.py'),'raise RuntimeError("shadow")\n');
    assert.throws(()=>implementationBindings(copied),/membership/);
    const result=spawnSync(python,[path.join(copied,'scripts/gates.py'),'evaluate','--root',review,'--stage','dataset'],{encoding:'utf8'});
    assert.notEqual(result.status,0);
  });
  async function foreground(config,lease){
    const state={runs:[]};let finishes=0;
    const runner=new Runner({getConfig:()=>config,store:{get:()=>state,set:patch=>Object.assign(state,patch)}});
    const done=new Promise(resolve=>{runner.onFinish=run=>{finishes++;resolve(run);};});
    runner.start({project:{id:'audit-runner',path:review},stageId:'stats',steps:[{argv:['-c','import time;time.sleep(0.02)']}],projectLease:lease});
    const result=await done;
    assert.equal(finishes,1);assert.equal(result.status,'failed');assert.equal(runner.listLive().length,0);
  }
  await check('Failed foreground spawn settles once after close',async()=>{
    const lease=acquireProjectLease(review);
    try{await foreground({pythonPath:path.join(base,'missing-python')},lease);}finally{lease.release();}
  });
  for(const method of ['registerChild','childClosed'])await check(`Foreground ${method} failure settles without crashing`,async()=>{
    const lease=acquireProjectLease(review);
    const broken={...lease,[method](){throw Error('synthetic lease error');}};
    try{await foreground({pythonPath:python},broken);}finally{
      if(method==='childClosed'){
        const file=path.join(review,'output/gates/publication.lock');
        for(const pid of JSON.parse(fs.readFileSync(file)).children)lease.childClosed(pid);
      }
      lease.release();
    }
  });
  await check('Failed lease release clears memory while preserving the physical lock',()=>{
    const lease=acquireProjectLease(review);
    const bench=new Workbench({getConfig:()=>({}),store:{get:()=>({}),set:()=>{}},runner:{}});
    bench.gateLeases.set('review',lease);
    assert.ok(bench.releaseGateLease('review',{release(){throw Error('synthetic release failure');}}));
    assert.equal(bench.gateLeases.has('review'),false);
    assert.ok(fs.existsSync(path.join(review,'output/gates/publication.lock')));lease.release();
  });
  await check('A failed first inspection can be retried with the corrected interpreter',async()=>{
    const fresh=path.join(base,'retry');fs.mkdirSync(fresh);
    assert.equal(cli(fresh,'init-policy').status,0);
    assert.equal((await inspectAfterRun({root:fresh,skillRoot:skill,python:path.join(base,'missing-python'),stageIds:['dataset']})).status,'failed');
    assert.equal((await inspectAfterRun({root:fresh,skillRoot:skill,python,stageIds:['dataset']})).status,'completed');
  });
  await check('Informational source receipt does not trap a manual scope stage',()=>{
    write(review,'docs/scope.md','Synthetic scope, authored as an explicit test fixture.');
    const stages=evaluateHostProject({projectRoot:review,project});
    const scope=stages.find(s=>s.id==='scope');
    assert.equal(scope.status,'done');
    assert.equal(scope.gates.find(g=>g.id==='stage-source').status,'unjudged');
    assert.notEqual(scope.gates.find(g=>g.id==='stage-source').label,'stage-source');
    assert.equal(gateTotals([scope]).unjudged,0);
  });
  await check('An evidenced tabular-only coding stage stays not applicable without production',()=>{
    write(review,'output/audit/corpus_files.csv','rel_path,status\na.csv,valid\n');
    assert.equal(cli(review,'evaluate','--stage','coding').status,0);
    assert.equal(evaluateHostProject({projectRoot:review,project}).find(s=>s.id==='coding').status,'na');
  });
  await check('Public run metadata preserves production and checker outcomes separately',()=>{
    const bench=new Workbench({getConfig:()=>({}),store:{get:()=>({runs:[{id:'synthetic',projectId:'p1',status:'ok',exitCode:0,gateCheck:{status:'failed',results:[{stage:'audit',exitCode:2,reason:'checker-failed'}]}}]})},runner:{}});
    const run=bench.recentRuns(1,'p1')[0];
    assert.equal(run.status,'ok');assert.equal(run.exitCode,0);assert.equal(run.gateCheck.status,'failed');
    assert.equal(run.gateCheck.results[0].reason,'checker-failed');
  });
  console.log(`audit regressions: ${passed} passed, ${failed} failed`);
  process.exitCode=failed?1:0;
}finally{
  const actual=fs.realpathSync(base),temporary=fs.realpathSync(os.tmpdir());
  assert.ok(path.relative(temporary,actual)&&!path.relative(temporary,actual).startsWith('..'));
  fs.rmSync(base,{recursive:true,force:true});
}

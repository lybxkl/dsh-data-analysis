/** Cross-runtime acceptance using the actual supplied package and real children. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {createProject} from '../src/projects.js';
import {acquireProjectLease} from '../src/gate-lease.js';
import {inspectAfterRun} from '../src/gate-inspection.js';
import {gateCommand} from '../src/gate-control.js';
import {readGatePolicy,loadStageReport,projectResourcePath,safePath,gateAdmission} from '../src/gate-report.js';
import {productionReceipt} from '../src/gate-production.js';
import {evaluateProject} from '../src/gates.js';
import {adjudicationSnapshot} from '../src/gate-host.js';
import {Runner} from '../src/runner.js';
import {Workbench} from '../src/service.js';

const skillRoot=process.env.DSA_SKILL_ROOT;
assert.ok(skillRoot,'DSA_SKILL_ROOT must name the real package');
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'dsa-workflow-'));
const root=path.join(sandbox,'project');
const write=(rel,value)=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='object'?JSON.stringify(value):value);};
const python=process.env.PYTHON||'python';
let count=0;
function check(name,fn){fn();count++;console.log('✓ '+name);}
try {
  const result=createProject({dir:root,name:'Synthetic acceptance',skill:{packageDir:skillRoot}});
  check('new project consumes package policy, defaults to skill',()=>{
    assert.equal(result.ok,true,result.error);assert.equal(readGatePolicy(root).mode,'skill');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'.workbench/gates/policy.json'))),JSON.parse(fs.readFileSync(path.join(skillRoot,'contracts/gates/policy-template.json'))));
  });
  const completePolicy=fs.readFileSync(path.join(root,'.workbench/gates/policy.json'),'utf8');
  fs.unlinkSync(path.join(root,'.workbench/gates/policy.json'));
  check('missing policy never silently returns an enrolled project to legacy',()=>{
    assert.equal(readGatePolicy(root).invalid,true);
    const artifacts=new Proxy({},{get(){throw Error('silent legacy fallback');}});
    const stages=evaluateProject({projectRoot:root,project:result.project,artifacts});
    assert.equal(gateAdmission(stages,root,'delivery-ready').allowed,false);
  });
  write('.workbench/gates/policy.json',completePolicy);
  const missingRule=JSON.parse(completePolicy);missingRule.requirements=missingRule.requirements.filter(r=>r.gateId!=='dataset-in-analysis');
  write('.workbench/gates/policy.json',missingRule);
  check('policy omission cannot remove a required admission rule',()=>{
    const stages=evaluateProject({projectRoot:root,project:{skill:{root:skillRoot}},artifacts:{}});
    assert.ok(stages.every(s=>s.gates.some(g=>g.id==='platform.policy')));
  });
  write('.workbench/gates/policy.json',completePolicy);
  const requirements=JSON.parse(completePolicy).requirements;
  const stageFacts=[...new Set(requirements.map(r=>r.displayStage))].map(id=>({id,status:'review',gates:requirements.filter(r=>r.displayStage===id).map(r=>({id:r.gateId,status:['qa','recheck'].includes(r.reportStage)?'unjudged':'pass'}))}));
  const chainBench=new Workbench({getConfig:()=>({}),store:{get:()=>({}),set:()=>{}},runner:{}});
  let chain={status:'running',steps:['qa','recheck'],index:0};
  chainBench.active=()=>({ok:true,path:root});chainBench.snapshot=()=>({stages:stageFacts});
  chainBench.chainStatus=()=>chain;chainBench.patchChain=patch=>{chain={...chain,...patch};};chainBench.beginChainStep=()=>{};
  chainBench.applyRunToChain({stageId:'qa',status:'ok',exitCode:0});
  check('QA may advance to recheck before final signoff; delivery still blocked',()=>{
    assert.equal(chain.index,1);assert.equal(chain.status,'running');assert.equal(gateAdmission(stageFacts,root,'delivery-ready').allowed,false);
  });
  chain={status:'running',steps:['verify','stats'],index:0};
  stageFacts.find(s=>s.id==='verify').gates.find(g=>g.id==='verification-final').status='unjudged';
  chainBench.applyRunToChain({stageId:'verify',status:'ok',exitCode:0});
  check('prepare pauses in waiting until actual final reread',()=>assert.equal(chain.status,'waiting'));
  write('output/dataset/analysis.csv','id,in_analysis\n001,1\n002,0\n');
  let lease=acquireProjectLease(root);
  try {
    check('production blocks competing foreground writers',()=>assert.throws(()=>acquireProjectLease(root)));
    const inspected=await inspectAfterRun({root,skillRoot,python,lease,stageIds:['dataset']});
    check('independent inspection borrows lease and completes',()=>assert.equal(inspected.status,'completed'));
    const policy=readGatePolicy(root),project={skill:{root:skillRoot}};
    const facts=loadStageReport(root,project,policy,'dataset');
    const evidenceBench=new Workbench({getConfig:()=>({}),store:{get:()=>({}),set:()=>{}},runner:{}});
    evidenceBench.snapshot=()=>({stages:[{id:'dataset',gates:[{id:'dataset-in-analysis',source:'legacy'}],gateComparison:[facts.find(g=>g.id==='dataset-in-analysis')]}]});
    check('compare evidence opens the new report instead of the legacy fact',()=>assert.equal(evidenceBench.gateEvidence({stageId:'dataset',gateId:'dataset-in-analysis'}).gate.source,'skill'));
    check('independent inspection has no invented production run',()=>{
      const report=JSON.parse(fs.readFileSync(path.join(root,'output/gates/dataset.json')));
      assert.deepEqual(report.productionRuns,[]);assert.equal(facts.find(g=>g.id==='dataset-in-analysis').status,'pass');
    });
    const recovery=await gateCommand({root,skillRoot,python,action:'recover'});
    check('recovery cannot steal live lease',()=>assert.equal(recovery.ok,false));
  } finally {lease.release();}

  write('data/source.csv','id,in_analysis\n001,1\n');
  const receipt=productionReceipt(root,'audit','synthetic-real-run',[{argv:[],produces:['output/audit/result.csv']}]);
  write('output/audit/result.csv','n\n1\n');
  receipt.stepFinished({produces:['output/audit/result.csv']},0);
  check('production receipt binds inputs before execution',()=>assert.equal(receipt.finish('ok').status,'completed'));
  const changed=productionReceipt(root,'audit','synthetic-changed-run',[{argv:[],produces:['output/audit/result.csv']}]);
  write('data/source.csv','id,in_analysis\n001,0\n');
  check('input mutation prevents completed production receipt',()=>assert.equal(changed.finish('ok').status,'failed'));

  write('scripts/acceptance.py',"from pathlib import Path\np=Path('output/models/acceptance.csv')\np.parent.mkdir(parents=True,exist_ok=True)\np.write_text('n\\n1\\n')\n");
  const ledger={runs:[],projects:[],config:{skillRoot,pythonPath:python},adjudications:{},meta:{}};
  const store={get:()=>ledger,set:patch=>Object.assign(ledger,patch)};
  const getConfig=()=>ledger.config;
  const runner=new Runner({getConfig,store});
  const bench=new Workbench({getConfig,store,runner});
  const command=bench.commandFor(root,result.project,{id:'stats',script:'scripts/acceptance.py',steps:[{script:'scripts/acceptance.py',args:[],produces:['output/models/acceptance.csv']}]});
  check('command assembly retains declared foreground outputs',()=>{
    assert.equal(command.ok,true,command.error);assert.deepEqual(command.steps[0].produces,['output/models/acceptance.csv']);
  });
  lease=acquireProjectLease(root);
  const finished=new Promise(resolve=>{runner.onFinish=resolve;});
  runner.start({project:{id:'synthetic-foreground',path:root},stageId:'stats',steps:command.steps,projectLease:lease});
  const run=await finished;
  lease.release();
  check('real foreground run binds successful outputs and executed code',()=>{
    assert.equal(run.status,'ok');
    const bound=JSON.parse(fs.readFileSync(path.join(root,'output/gates/production/stats.json')));
    assert.equal(bound.status,'completed');assert.equal(bound.runId,run.id);
    assert.ok(bound.outputs.some(o=>o.path==='output/models/acceptance.csv'));assert.ok(bound.implementation.some(i=>i.path.endsWith('acceptance.py')));
  });
  const inspectedProduction=await inspectAfterRun({root,skillRoot,python,stageIds:['stats']});
  check('skill accepts freshness from the real foreground run',()=>{
    assert.equal(inspectedProduction.status,'completed');
    assert.equal(loadStageReport(root,{skill:{root:skillRoot}},readGatePolicy(root),'stats').find(g=>g.id==='stats-fresh').status,'pass');
  });

  const outside=path.join(sandbox,'materials');fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'source.csv'),'id,in_analysis\n001,1\n');
  fs.symlinkSync(outside,path.join(root,'data/mount'),process.platform==='win32'?'junction':'dir');
  check('unregistered outside link is rejected',()=>assert.throws(()=>projectResourcePath(root,'data/mount/source.csv')));
  write('.workbench/gates/roots.json',{schema:'dsa.gate-roots/1',roots:{'material:fixture':outside}});
  check('registered outside link resolves, strict host path remains confined',()=>{
    assert.ok(projectResourcePath(root,'data/mount/source.csv'));assert.throws(()=>safePath(root,'data/mount/source.csv'));
  });
  write('research_registry.json',{source_root:'data/mount',datasets:[{id:'x',path:'data/mount/source.csv',key:'id'}]});
  const checked=await inspectAfterRun({root,skillRoot,python,stageIds:['dataset']});
  check('real Windows junction works across Python and JavaScript',()=>{
    assert.equal(checked.status,'completed');
    const report=loadStageReport(root,{skill:{root:skillRoot}},readGatePolicy(root),'dataset');
    assert.equal(report.find(g=>g.id==='dataset-in-analysis').status,'pass');
    assert.ok(report.some(g=>g.resources.some(r=>r.rootId==='material:fixture')));
  });
  const auditedHash=crypto.createHash('md5').update(fs.readFileSync(path.join(outside,'source.csv'))).digest('hex');
  write('research_registry.json',{source_root:outside,datasets:[{id:'x',path:'data/mount/source.csv',key:'id'}]});
  write('output/audit/corpus_summary.json',{root:outside,total_files:1,truncated:false,hash_disabled:false});
  write('output/audit/corpus_files.csv',`rel_path,status,md5\nsource.csv,valid,${auditedHash}\n`);
  fs.writeFileSync(path.join(outside,'source.csv'),'id,in_analysis\n001,0\n');
  const absoluteAudit=await inspectAfterRun({root,skillRoot,python,stageIds:['audit']});
  check('absolute registered source roots keep failure evidence portable',()=>{
    assert.equal(absoluteAudit.status,'completed');
    const raw=fs.readFileSync(path.join(root,'output/gates/audit.json'),'utf8');
    assert.ok(!raw.includes(JSON.stringify(outside).slice(1,-1))&&!raw.includes(outside.replaceAll('\\','/')));
    assert.equal(loadStageReport(root,{skill:{root:skillRoot}},readGatePolicy(root),'audit').find(g=>g.id==='audit-freshness').status,'fail');
  });
  await inspectAfterRun({root,skillRoot,python,stageIds:['dataset']});
  check('formal host path does not call the legacy artifact evaluator',()=>{
    const artifacts=new Proxy({},{get(){throw Error('legacy domain read');}});
    const stages=evaluateProject({projectRoot:root,project:{skill:{root:skillRoot}},artifacts});
    assert.ok(stages.find(s=>s.id==='dataset').gates.find(g=>g.id==='dataset-in-analysis'));
  });
  await inspectAfterRun({root,skillRoot,python,stageIds:['stats','audit']});
  const before=adjudicationSnapshot(root,{skill:{root:skillRoot}});
  assert.ok(before,'all observed file collections are freshly inspected');
  write('scripts/added-after-review.py','# new code outside the inspected collection\n');
  check('new project script invalidates manual evidence snapshot',()=>assert.equal(adjudicationSnapshot(root,{skill:{root:skillRoot}}),null));
  fs.unlinkSync(path.join(root,'scripts/added-after-review.py'));
  fs.writeFileSync(path.join(outside,'source.csv'),'id,in_analysis\n001,1\n');
  check('external mutation invalidates manual evidence snapshot',()=>assert.notEqual(adjudicationSnapshot(root,{skill:{root:skillRoot}}),before));

  const fake=path.join(sandbox,'slow-skill');fs.mkdirSync(path.join(fake,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(fake,'contracts/gates'),{recursive:true});
  for(const name of ['catalog.json','policy.schema.json'])fs.writeFileSync(path.join(fake,'contracts/gates',name),fs.readFileSync(path.join(skillRoot,'contracts/gates',name)));
  fs.writeFileSync(path.join(fake,'scripts/gates.py'),'import time\ntime.sleep(60)\n');
  lease=acquireProjectLease(root);
  const controller=new AbortController();
  const pending=inspectAfterRun({root,skillRoot:fake,python,lease,stageIds:['dataset'],signal:controller.signal});
  setTimeout(()=>controller.abort(),250);
  const cancelled=await pending;
  check('cancellation waits for child exit before releasing lease',()=>{
    assert.equal(cancelled.status,'cancelled');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'output/gates/publication.lock'))).children,[]);
    lease.release();assert.ok(!fs.existsSync(path.join(root,'output/gates/publication.lock')));
  });
  const malformed=await inspectAfterRun({root,skillRoot:fake,python:path.join(sandbox,'missing-python'),stageIds:['dataset']});
  check('spawn error is an inspection failure',()=>assert.equal(malformed.status,'failed'));
  const redirected=path.join(sandbox,'redirected'),controlOutside=path.join(sandbox,'control-outside');
  fs.mkdirSync(redirected);fs.mkdirSync(controlOutside);
  fs.symlinkSync(controlOutside,path.join(redirected,'output'),process.platform==='win32'?'junction':'dir');
  const denied=await gateCommand({root:redirected,skillRoot,python,action:'init-policy'});
  check('control output cannot be redirected outside the project',()=>{
    assert.throws(()=>acquireProjectLease(redirected));assert.equal(denied.ok,false);assert.deepEqual(fs.readdirSync(controlOutside),[]);
  });
  console.log(`gate workflow acceptance: ${count} passed`);
} finally {fs.rmSync(sandbox,{recursive:true,force:true});}

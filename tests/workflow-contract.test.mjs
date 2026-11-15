/** Exercise a workflow the host has never seen, with real Python production. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {loadWorkflow,workflowArguments} from '../src/workflow.js';
import {createProject,projectId} from '../src/projects.js';
import {Workbench} from '../src/service.js';
import {Runner} from '../src/runner.js';

const source=process.env.DSA_SKILL_ROOT;
assert.ok(source,'DSA_SKILL_ROOT must identify the actual skill package');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dsa-workflow-contract-'));
const skill=path.join(temp,'skill'),root=path.join(temp,'project');
const python=process.env.PYTHON||'python';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='object'?JSON.stringify(value,null,2):value);};
function publish(){
  const members=[];
  function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='__pycache__'||/\.py[co]$/.test(entry.name)||entry.name==='package-manifest.json')continue;
    const file=path.join(dir,entry.name);if(entry.isDirectory())visit(file);else members.push({path:path.relative(skill,file).replaceAll('\\','/'),sha256:hash(file)});
  }}
  for(const name of ['scripts','references','contracts','profiles','assets'])visit(path.join(skill,name));
  members.push({path:'SKILL.md',sha256:hash(path.join(skill,'SKILL.md'))});
  members.sort((a,b)=>a.path.localeCompare(b.path));
  write(path.join(skill,'contracts/gates/package-manifest.json'),{schema:'dsa.package-manifest/1',members});
}
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
try{
  fs.cpSync(source,skill,{recursive:true,filter:file=>!file.includes('__pycache__')});
  const file=path.join(skill,'contracts/workflow/workflow.json');
  const original=JSON.parse(fs.readFileSync(file));
  const added={id:'independent-new-step',name:'全新动态阶段',purpose:'Prove package-only workflow changes execute.',short:'新阶段',dependsOn:[],script:'scripts/new_step.py',args:['--out','output/new-step/value.json','--value','first'],artifacts:['output/new-step/value.json'],admission:{},afterRun:{},inspectionStages:[],manualInstructions:[],ui:{panels:[],draftTask:''}};
  added.steps=[{script:added.script,args:added.args,produces:added.artifacts}];
  const spec=structuredClone(original);spec.stages.push(added);
  write(file,spec);
  write(path.join(skill,'scripts/new_step.py'),"import argparse,json\nfrom pathlib import Path\np=argparse.ArgumentParser();p.add_argument('--out');p.add_argument('--value');p.add_argument('--pause',type=float,default=0);a=p.parse_args();__import__('time').sleep(a.pause)\nf=Path(a.out);f.parent.mkdir(parents=True,exist_ok=True);f.write_text(json.dumps({'value':a.value}))\n");
  publish();
  const created=createProject({dir:root,name:'Synthetic dynamic workflow',skill:{packageDir:skill}});
  assert.equal(created.ok,true,created.error);
  const state={projects:[{id:projectId(root),path:root}],activeProjectId:projectId(root),activeProjectPath:root,runs:[],sources:[]};
  const store={get:(key,fallback)=>key===undefined?state:state[key]??fallback,set:(patch,value)=>typeof patch==='string'?state[patch]=value:Object.assign(state,patch),flushSoon(){}};
  const config={skillRoot:skill,pythonPath:python,maxRuns:60};
  const runner=new Runner({getConfig:()=>config,store});
  const bench=new Workbench({getConfig:()=>config,store,runner});
  runner.onFinish=run=>bench.onRunFinished(run);
  async function run(){
    const started=bench.runStage(added.id);assert.equal(started.ok,true,started.error);
    const deadline=Date.now()+120000;
    while(runner.activeFor(projectId(root))[added.id]||bench.gateChecks.has(projectId(root))){assert.ok(Date.now()<deadline,'run timed out');await new Promise(resolve=>setTimeout(resolve,30));}
    return started;
  }
  await check('A package-only eleventh stage appears in snapshots and task cards',()=>{
    const snapshot=bench.snapshot();assert.equal(snapshot.stages.length,11,snapshot.error);
    assert.equal(snapshot.stages.at(-1).name,added.name);
    assert.ok(bench.taskCard(added.id).text.includes('new_step.py'));
    assert.equal(created.project.stages[added.id].status,'todo');
  });
  await check('The previously unknown stage executes actual skill code and becomes done',async()=>{
    await run();assert.equal(JSON.parse(fs.readFileSync(path.join(root,added.artifacts[0]))).value,'first');
    assert.equal(bench.snapshot().stages.find(s=>s.id===added.id).status,'done');
  });
  await check('Package-only stage order, label and CLI edits reload without host changes',async()=>{
    added.name='热更新阶段';added.args=['--out',added.artifacts[0],'--value','second'];added.steps[0].args=added.args;
    spec.stages=[added,...original.stages];write(file,spec);publish();
    const snapshot=bench.snapshot();assert.equal(snapshot.stages[0].id,added.id);assert.equal(snapshot.stages[0].name,'热更新阶段');assert.equal(snapshot.stages[0].index,1);
    assert.equal(snapshot.stages[0].status,'review','old production must not satisfy a changed workflow');
    await run();assert.equal(JSON.parse(fs.readFileSync(path.join(root,added.artifacts[0]))).value,'second');
    assert.equal(bench.snapshot().stages[0].status,'done');
  });
  await check('Changing dynamic outputs invalidates completion even with unchanged size and time',()=>{
    const output=path.join(root,added.artifacts[0]),stat=fs.statSync(output),bytes=fs.readFileSync(output);
    fs.writeFileSync(output,bytes.toString().replace('second','forged'));fs.utimesSync(output,stat.atime,stat.mtime);
    assert.equal(fs.statSync(output).size,stat.size);
    assert.equal(bench.snapshot().stages[0].status,'review');
  });
  await check('A package-only action and a new tool binding use the shared runner',async()=>{
    spec.actions.push({id:'novel-action',tool:'novel-tool',stage:added.id,label:'新动作',admission:{},steps:[{script:added.script,args:['--out',added.artifacts[0],'--value','action'],produces:added.artifacts}],outFile:added.artifacts[0]});
    write(file,spec);publish();
    const result=await bench.runBoundWorkflowAction('novel-tool');
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result.value,'action');assert.ok(result.runId);
    assert.equal(bench.snapshot().stages[0].status,'done');
  });
  await check('Cancelling a declared action stops production without starting another checker',async()=>{
    spec.actions.at(-1).steps[0].args.push('--pause','3');write(file,spec);publish();
    const pending=bench.runWorkflowAction('novel-action');
    assert.ok(Object.keys(runner.activeFor(projectId(root))).length);
    assert.equal(bench.cancelStage(added.id).ok,true);
    const result=await pending;assert.equal(result.ok,false);
    const run=bench.recentRuns(1,projectId(root))[0];assert.equal(run.status,'cancelled');assert.equal(run.gateCheck.status,'cancelled');
    assert.equal(fs.existsSync(path.join(root,'output/gates/publication.lock')),false);
  });
  await check('Adding a dependency blocks actual execution until its evidence is ready',()=>{
    spec.stages=[...original.stages,{...added,dependsOn:['stats']}];write(file,spec);publish();
    const result=bench.runStage(added.id);assert.equal(result.ok,false);assert.ok(result.blockers.some(reason=>reason.includes('依赖阶段')));
  });
  await check('Completing a manual phase resumes the chain without rerunning it',async()=>{
    const actual=bench.snapshot.bind(bench);bench.snapshot=()=>({stages:[{id:'dataset',status:'done'}]});
    state.recheckChains={[projectId(root)]:{id:'manual-chain',status:'running',steps:['dataset'],index:0}};
    try{bench.beginChainStep();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(bench.chainStatus().status,'done');}
    finally{bench.snapshot=actual;state.recheckChains={};}
  });
  await check('A persisted chain replans from the skill after workflow changes',()=>{
    spec.rerunRules.unshift({match:'exact',pattern:'data/input.csv',stages:['scope']});write(file,spec);publish();
    write(path.join(root,'output/recheck/issues.jsonl'),JSON.stringify({id:'WF1',severity:'info',status:'open',patch:{path:'data/input.csv'}})+'\n');
    state.recheckChains={[projectId(root)]:{id:'old-chain',status:'interrupted',steps:['qa'],index:0,issueId:'WF1',workflowHash:'older-workflow'}};
    const result=bench.resumeChain({force:true});assert.equal(result.ok,true,result.error);
    assert.deepEqual(bench.chainStatus().steps,['scope']);assert.equal(bench.chainStatus().workflowHash,bench.workflow().sha256);
    assert.equal(bench.chainStatus().status,'waiting');state.recheckChains={};
  });
  await check('Unknown capabilities and broken DAGs fail closed in both runtimes',()=>{
    for(const bad of [{...spec,requiredFeatures:[...spec.requiredFeatures,'future-engine']},{...spec,stages:[{...added,dependsOn:['does-not-exist']},...original.stages]}]){
      write(file,bad);
      const snapshot=bench.snapshot();assert.equal(snapshot.workflow.ok,false);assert.equal(snapshot.admission.allowed,false);assert.deepEqual(snapshot.stages,[]);
      const cli=spawnSync(python,[path.join(skill,'scripts/workflow_contract.py'),'validate','--package',skill],{encoding:'utf8'});assert.notEqual(cli.status,0);
    }
  });
  await check('Missing workflow never falls back to the former ten-stage host table',()=>{
    fs.unlinkSync(file);const snapshot=bench.snapshot();assert.equal(snapshot.workflow.ok,false);assert.equal(snapshot.deliveryReady,false);assert.deepEqual(snapshot.stages,[]);
  });
  await check('Deleting an optional stage removes it without changing host code',()=>{
    write(file,original);publish();assert.equal(bench.snapshot().stages.length,10);assert.equal(bench.stageById(added.id),null);
  });
  await check('Command bindings reject unconfined project paths',()=>{
    const workflow=loadWorkflow(skill);write(path.join(root,'output/datasets/index.json'),{datasets:[{file:'../outside.csv'}]});
    assert.throws(()=>workflowArguments(workflow,root,['output/dataset/analysis.csv']));
  });
  console.log(`dynamic workflow acceptance: ${passed} passed`);
}finally{
  assert.ok(path.relative(os.tmpdir(),temp)&&!path.relative(os.tmpdir(),temp).startsWith('..'));
  fs.rmSync(temp,{recursive:true,force:true});
}

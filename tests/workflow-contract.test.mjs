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
import {Assistant,buildContext} from '../src/assistant.js';

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
  await check('A pinned project executes and checks its own skill after global configuration changes',async()=>{
    config.skillRoot=path.join(temp,'unrelated-missing-skill');
    try{
      const command=bench.commandFor(root,JSON.parse(fs.readFileSync(path.join(root,'project.json'))),bench.stageById(added.id));
      assert.equal(command.ok,true,command.error);assert.equal(command.steps[0].scriptAbs,path.join(skill,'scripts/new_step.py'));
      await run();assert.equal(bench.snapshot().stages.find(s=>s.id===added.id).status,'done');
    }finally{config.skillRoot=skill;}
  });
  await check('A project opened through a directory junction keeps valid relative output bindings',async()=>{
    const alias=path.join(temp,'project-alias');fs.symlinkSync(root,alias,process.platform==='win32'?'junction':'dir');
    const id=projectId(alias),ledger={projects:[{id,path:alias}],activeProjectId:id,activeProjectPath:alias,runs:[],sources:[]};
    const aliasStore={get:(key,fallback)=>key===undefined?ledger:ledger[key]??fallback,set:(key,value)=>typeof key==='string'?ledger[key]=value:Object.assign(ledger,key),flushSoon(){}};
    const aliasRunner=new Runner({getConfig:()=>config,store:aliasStore}),aliasBench=new Workbench({getConfig:()=>config,store:aliasStore,runner:aliasRunner});aliasRunner.onFinish=run=>aliasBench.onRunFinished(run);
    const started=aliasBench.runStage(added.id);assert.equal(started.ok,true,started.error);const deadline=Date.now()+120000;
    while(aliasRunner.activeFor(id)[added.id]||aliasBench.gateChecks.has(id)){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,30));}
    const snapshot=aliasBench.snapshot();assert.equal(snapshot.stages.find(s=>s.id===added.id).status,'done');
    const receipt=JSON.parse(fs.readFileSync(path.join(alias,`output/gates/production/${added.id}.json`)));assert.equal(receipt.outputs[0].path,added.artifacts[0]);
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
  await check('Imported package code changes invalidate a dynamic production receipt',async()=>{
    const script=path.join(skill,added.script),helper=path.join(skill,'scripts/new_helper.py');
    write(script,'import new_helper\n'+fs.readFileSync(script,'utf8'));write(helper,'VALUE = 1\n');publish();
    await run();assert.equal(bench.snapshot().stages[0].status,'done');
    const receipt=JSON.parse(fs.readFileSync(path.join(root,`output/gates/production/${added.id}.json`)));
    assert.ok(receipt.packageImplementation['scripts/new_helper.py']);
    const stat=fs.statSync(helper);write(helper,'VALUE = 2\n');fs.utimesSync(helper,stat.atime,stat.mtime);
    assert.equal(bench.snapshot().stages[0].status,'review','a still-unchanged manifest must not hide changed dependency bytes');
    write(helper,'VALUE = 1\n');publish();
  });
  await check('Project imports do not create caches that invalidate their own first production',async()=>{
    const projectFile=path.join(root,'project.json'),previous=fs.readFileSync(projectFile);const project=JSON.parse(previous);
    write(path.join(root,'scripts/local_helper.py'),'VALUE = 17\n');
    write(path.join(root,'scripts/project_step.py'),"import local_helper,json\nfrom pathlib import Path\nf=Path('"+added.artifacts[0]+"');f.parent.mkdir(parents=True,exist_ok=True);f.write_text(json.dumps({'value':local_helper.VALUE}))\n");
    project.stages[added.id]={steps:[{script:'scripts/project_step.py',args:[],produces:added.artifacts}]};write(projectFile,project);
    try{await run();assert.equal(bench.snapshot().stages[0].status,'done');assert.equal(fs.existsSync(path.join(root,'scripts/__pycache__')),false);}
    finally{fs.writeFileSync(projectFile,previous);}
  });
  await check('A successful no-op script cannot return an old output as a new action result',async()=>{
    const output=path.join(root,added.artifacts[0]),before=fs.readFileSync(output);
    write(path.join(skill,'scripts/no_output.py'),'# Deliberately produces no output.\n');
    spec.actions.push({id:'no-output',stage:added.id,label:'No output',steps:[{script:'scripts/no_output.py',args:[],produces:added.artifacts}],outFile:added.artifacts[0]});write(file,spec);publish();
    try{
      const result=await bench.runWorkflowAction('no-output');assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.code,0);assert.equal(result.result,null);
      assert.deepEqual(fs.readFileSync(output),before,'the old artifact is preserved, but is not presented as new');
      const receipt=JSON.parse(fs.readFileSync(path.join(root,`output/gates/production/${added.id}.json`)));assert.equal(receipt.status,'failed');assert.deepEqual(receipt.unproducedOutputs,added.artifacts);
    }finally{spec.actions.pop();write(file,spec);publish();}
  });
  await check('Cancelling post-production inspection cannot be returned as action success',async()=>{
    const pending=bench.runWorkflowAction('novel-action'),deadline=Date.now()+30000;
    while(!bench.gateChecks.has(projectId(root))){assert.ok(Date.now()<deadline,'inspection did not start');await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(bench.cancelStage(added.id).ok,true);
    const result=await pending;assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.result,null);assert.equal(result.inspectionStatus,'cancelled');
    assert.equal(fs.existsSync(path.join(root,'output/gates/publication.lock')),false);
  });
  await check('Broken workflow preserves a running process and allows cancellation',async()=>{
    const args=added.steps[0].args;added.steps[0].args=[...args,'--pause','3'];write(file,spec);publish();
    const started=bench.runStage(added.id);assert.equal(started.ok,true,started.error);
    try{
      write(file,{...spec,requiredFeatures:[...spec.requiredFeatures,'broken-while-running']});
      const snapshot=bench.snapshot();assert.equal(snapshot.workflow.ok,false);assert.ok(snapshot.activeRuns[added.id]);assert.ok(snapshot.runs.some(run=>run.id===started.run.id));
      assert.equal(bench.cancelStage(added.id).ok,true);
    }finally{
      added.steps[0].args=args;write(file,spec);publish();
      const deadline=Date.now()+30000;while(runner.activeFor(projectId(root))[added.id]||bench.gateChecks.has(projectId(root))){assert.ok(Date.now()<deadline,'cancel did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
    }
    assert.equal(bench.recentRuns(1,projectId(root))[0].status,'cancelled');
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
  await check('An unpinned legacy project uses the configured workflow and still gets current action receipts',async()=>{
    const legacyRoot=path.join(temp,'legacy-project');write(path.join(legacyRoot,'project.json'),{name:'Synthetic unpinned legacy project',schemaVersion:1,stages:{}});
    const legacyId=projectId(legacyRoot),ledger={projects:[{id:legacyId,path:legacyRoot}],activeProjectId:legacyId,activeProjectPath:legacyRoot,runs:[],sources:[]};
    const legacyStore={get:(key,fallback)=>key===undefined?ledger:ledger[key]??fallback,set:(key,value)=>typeof key==='string'?ledger[key]=value:Object.assign(ledger,key),flushSoon(){}};
    const legacyRunner=new Runner({getConfig:()=>config,store:legacyStore}),legacyBench=new Workbench({getConfig:()=>config,store:legacyStore,runner:legacyRunner});
    legacyRunner.onFinish=run=>legacyBench.onRunFinished(run);
    try{
      write(file,{...spec,stages:[{...added,dependsOn:[]},...original.stages]});publish();
      const snapshot=legacyBench.snapshot();assert.equal(snapshot.stages[0].id,added.id);assert.equal(snapshot.stages.length,11);assert.equal(snapshot.gateMode,'legacy');
      const result=await legacyBench.runWorkflowAction('novel-action');assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result.value,'action');assert.equal(result.inspectionStatus,'not-required');
      const policy=JSON.parse(fs.readFileSync(path.join(root,'.workbench/gates/policy.json')));policy.mode='legacy';write(path.join(legacyRoot,'.workbench/gates/policy.json'),policy);
      const disabled=await legacyBench.runWorkflowAction('novel-action');assert.equal(disabled.ok,true,JSON.stringify(disabled));assert.equal(disabled.inspectionStatus,'disabled');
      const inspected=await legacyBench.gateControl({action:'inspect',stageId:'dataset'});
      assert.equal(inspected.status,'completed',JSON.stringify(inspected));
      assert.equal(inspected.state.gateMode,'legacy','explicit checking must preserve the selected mode');
      assert.ok(inspected.inspectionFacts[0].gates.length>0,JSON.stringify(inspected.inspectionFacts));
      const migrated=await legacyBench.gateControl({action:'migrate',mode:'legacy'});
      assert.equal(migrated.ok,true,migrated.error);
      assert.deepEqual(migrated.modeTransition,{from:'legacy',to:'legacy'});
      assert.ok(migrated.notice);
    }finally{write(file,spec);publish();}
  });
  await check('Unknown capabilities and broken DAGs fail closed in both runtimes',()=>{
    for(const bad of [{...spec,requiredFeatures:[...spec.requiredFeatures,'future-engine']},{...spec,stages:[{...added,dependsOn:['does-not-exist']},...original.stages]}]){
      write(file,bad);
      const snapshot=bench.snapshot();assert.equal(snapshot.workflow.ok,false);assert.equal(snapshot.admission.allowed,false);assert.deepEqual(snapshot.stages,[]);
      const cli=spawnSync(python,[path.join(skill,'scripts/workflow_contract.py'),'validate','--package',skill],{encoding:'utf8'});assert.notEqual(cli.status,0);
    }
  });
  await check('Unknown or empty report filters cannot silently remove all admission requirements',()=>{
    for(const reportStages of [[],['unknown-report']]){
      write(file,{...spec,stages:[{...added,dependsOn:[],admission:{checkpoint:'data-ready',reportStages}},...original.stages]});
      assert.throws(()=>loadWorkflow(skill),/报告阶段/);
      const cli=spawnSync(python,[path.join(skill,'scripts/workflow_contract.py'),'validate','--package',skill],{encoding:'utf8'});assert.notEqual(cli.status,0);
    }
  });
  await check('Missing workflow never falls back to the former ten-stage host table',()=>{
    fs.unlinkSync(file);const snapshot=bench.snapshot();assert.equal(snapshot.workflow.ok,false);assert.equal(snapshot.deliveryReady,false);assert.deepEqual(snapshot.stages,[]);
  });
  await check('Deleting an optional stage removes it without changing host code',()=>{
    write(file,original);publish();assert.equal(bench.snapshot().stages.length,10);assert.equal(bench.stageById(added.id),null);
  });
  await check('Draft context follows declared files without injecting a former task-specific input list',()=>{
    write(path.join(root,'docs/declared.md'),'DECLARED_INPUT');write(path.join(root,'output/models/fit.csv'),'UNDECLARED_MODEL_INPUT');
    const result=buildContext(root,created.project,{id:'manuscript',contextFiles:['docs/declared.md']});
    assert.ok(result.context.includes('DECLARED_INPUT'));assert.ok(!result.context.includes('UNDECLARED_MODEL_INPUT'));assert.deepEqual(result.missing,[]);
  });
  await check('Draft reading and writing reject a junction escaping the project',()=>{
    const target=path.join(temp,'assistant-project'),outside=path.join(temp,'assistant-outside');
    const project=createProject({dir:target,name:'Synthetic draft isolation',skill:{packageDir:skill}});assert.equal(project.ok,true,project.error);
    fs.mkdirSync(outside);write(path.join(outside,'scope.md'),'PROTECTED_OUTSIDE_CONTENT');
    fs.rmdirSync(path.join(target,'docs'));fs.symlinkSync(outside,path.join(target,'docs'),process.platform==='win32'?'junction':'dir');
    const assistant=new Assistant({getConfig:()=>config,getActive:()=>({ok:true,id:'draft-project',path:target,project:project.project})});
    assert.equal(assistant.save({taskId:'scope',text:'do not overwrite',projectId:'draft-project'}).ok,false);
    assert.equal(fs.readFileSync(path.join(outside,'scope.md'),'utf8'),'PROTECTED_OUTSIDE_CONTENT');
    const context=buildContext(target,project.project,{contextFiles:['docs/scope.md']});assert.ok(!context.context.includes('PROTECTED_OUTSIDE_CONTENT'));assert.deepEqual(context.missing,['docs/scope.md']);
  });
  await check('Drafts cannot be generated or saved under a different project identity',async()=>{
    let called=false;const assistant=new Assistant({getConfig:()=>config,getActive:()=>({ok:true,id:'current-project',path:root,project:created.project}),
      agentDefaultModel:{currentSelection:()=>({provider:'synthetic',model:'synthetic'})},llm:{async*stream(){called=true;yield {type:'text-delta',text:'unexpected'};}}});
    const result=await assistant.draft({taskId:'scope',projectId:'original-project'});assert.equal(result.ok,false);assert.equal(called,false);
    assert.equal(assistant.save({taskId:'scope',text:'do not save',projectId:'original-project'}).ok,false);assert.equal(fs.existsSync(path.join(root,'docs/scope.md')),false);
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

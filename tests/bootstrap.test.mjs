/** Real filesystem regressions for the previously unreachable startup entry. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Workbench} from '../src/service.js';
import {Runner} from '../src/runner.js';
import {projectId} from '../src/projects.js';
import {wrapExecute} from '../src/binding.js';
import {admissionFor,whenArmed} from '../src/gating.js';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dsa-bootstrap-'));
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
function setup(label){
  const root=path.join(temp,label);fs.mkdirSync(root);
  const state={projects:[],bindings:{},armings:{},runs:[],meta:{},config:{skillRoot:process.env.DSA_SKILL_ROOT||'',pythonPath:'python',maxRuns:5}};
  const store={filePath:path.join(root,'ledger.json'),get:(key,fallback)=>key===undefined?state:state[key]??fallback,
    set:(key,value)=>typeof key==='string'?state[key]=value:Object.assign(state,key),flush(){},flushSoon(){}};
  const runner=new Runner({getConfig:()=>state.config,store});
  const wb=new Workbench({getConfig:()=>state.config,store,runner});
  const workspace=path.join(root,'已有论文和产物');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'final.docx'),'existing final must survive');
  wb.sessionCwd=()=>workspace;
  return {root,workspace,state,wb};
}
try{
  const env=setup('main'),{wb,workspace}=env;
  await check('An unarmed conversation can see start, but cannot see stage tools',()=>{
    const armed=whenArmed(wb);assert.equal(admissionFor(armed,'data_analysis_start'),undefined);
    assert.equal(admissionFor(armed,'data_analysis_run_stage').when({agent:{id:'a'}}),false);
  });
  await check('Missing session identity creates nothing and never activates a project',()=>{
    assert.equal(wb.startWorkbench({workspaceDir:workspace}).code,'SESSION_REQUIRED');
    assert.deepEqual(env.state.projects,[]);assert.deepEqual(fs.readdirSync(env.root),[path.basename(workspace)]);
  });
  let result;
  await check('Explicit startup preserves an occupied workspace and creates its sibling project',()=>{
    result=wb.startWorkbench({sessionId:'a'});assert.equal(result.ok,true,result.error);assert.equal(result.created,true);
    assert.equal(result.project.path,workspace+'-实证研究');assert.equal(wb.isArmed('a'),true);
    assert.equal(fs.readFileSync(path.join(workspace,'final.docx'),'utf8'),'existing final must survive');
    assert.deepEqual(fs.readdirSync(workspace),['final.docx']);
    const project=JSON.parse(fs.readFileSync(path.join(result.project.path,'project.json')));
    assert.equal(project.origin.workspace,workspace);assert.ok(project.workflow.sha256);assert.equal(env.state.runs.length,0);
    assert.equal(admissionFor(whenArmed(wb),'data_analysis_run_stage').when({agent:{id:'a'}}),true);
  });
  await check('Repeated startup is idempotent and does not run research',()=>{
    const again=wb.startWorkbench({sessionId:'a'});assert.equal(again.already,true);assert.equal(again.created,false);
    assert.equal(again.project.id,result.project.id);assert.equal(env.state.projects.length,1);assert.equal(env.state.runs.length,0);
  });
  await check('Another conversation in the same workspace gets its own project',()=>{
    const other=wb.startWorkbench({sessionId:'b'});assert.equal(other.ok,true,other.error);
    assert.equal(other.project.path,workspace+'-实证研究-2');assert.equal(wb.sessionBinding('a').projectId,result.project.id);
    assert.equal(wb.sessionBinding('b').projectId,other.project.id);
  });
  await check('Startup wrapper does not accidentally bind the globally active project first',async()=>{
    const execute=wrapExecute({name:'data_analysis_start',workbench:wb,original:(_args,exec)=>wb.startWorkbench({sessionId:exec.agent.session.id})});
    const out=await execute({}, {agent:{session:{id:'c'}}});assert.equal(out.ok,true,out.error);
    assert.equal(out.project.path,workspace+'-实证研究-3');assert.equal(wb.sessionBinding('a').projectId,result.project.id);
  });
  await check('Read-only probes never initialize or bind a new conversation',async()=>{
    const before=JSON.stringify(env.state);
    const probe=wrapExecute({name:'data_analysis_status',workbench:wb,original:()=>({ok:true})});
    await probe({}, {agent:{session:{id:'status-only'}}});
    assert.equal(JSON.stringify(env.state),before);assert.equal(wb.isArmed('status-only'),false);
  });
  await check('An unrelated global project is ignored, and an explicit switch is required',()=>{
    const own=wb.startWorkbench({sessionId:'a'});assert.equal(own.project.id,result.project.id);
    const target=path.join(env.root,'explicit');
    assert.equal(wb.startWorkbench({sessionId:'a',projectDir:target}).code,'SESSION_BOUND_ELSEWHERE');assert.equal(fs.existsSync(target),false);
    const moved=wb.startWorkbench({sessionId:'a',projectDir:target,switchProject:true});assert.equal(moved.ok,true,moved.error);
    assert.equal(wb.sessionBinding('a').projectId,projectId(target));
  });
  await check('An explicit existing project opens and binds without recreating it',()=>{
    const e=setup('existing');const target=path.join(e.root,'research');assert.equal(e.wb.createProject(target,'existing').ok,true);
    fs.writeFileSync(path.join(target,'docs','keep.txt'),'keep');
    const out=e.wb.startWorkbench({sessionId:'existing-chat',projectDir:target});assert.equal(out.ok,true,out.error);assert.equal(out.created,false);
    assert.equal(fs.readFileSync(path.join(target,'docs','keep.txt'),'utf8'),'keep');
  });
  await check('A nonempty explicit directory is rejected without binding or changing the active project',()=>{
    const e=setup('occupied'),before=JSON.stringify(e.state);
    const out=e.wb.startWorkbench({sessionId:'d',projectDir:e.workspace});assert.equal(out.ok,false);
    assert.equal(JSON.stringify(e.state),before);assert.deepEqual(fs.readdirSync(e.workspace),['final.docx']);
  });
  await check('An invalid skill workflow fails before any project or association is written',()=>{
    const e=setup('invalid');const bad=path.join(e.root,'bad-skill');fs.mkdirSync(bad);fs.writeFileSync(path.join(bad,'SKILL.md'),'invalid');
    e.state.config.skillRoot=bad;
    const target=path.join(e.root,'never-created');const out=e.wb.startWorkbench({sessionId:'e',projectDir:target});
    assert.equal(out.ok,false);assert.equal(fs.existsSync(target),false);assert.deepEqual(e.state.bindings,{});assert.equal(e.wb.isArmed('e'),false);
  });
  await check('A publication lock prevents switching into a busy project',()=>{
    const target=result.project.path;fs.mkdirSync(path.join(target,'output/gates'),{recursive:true});
    const lock=path.join(target,'output/gates/publication.lock');fs.writeFileSync(lock,'{}');
    try{const out=wb.startWorkbench({sessionId:'lock-test',projectDir:target,switchProject:true});assert.equal(out.code,'PROJECT_BUSY');assert.equal(wb.sessionBinding('lock-test'),null);}
    finally{fs.unlinkSync(lock);}
  });
  await check('A delegated session cannot start or steal a main conversation project',()=>{
    const e=setup('delegated');e.wb.liveSession=()=>({header:{origin:'subagent',delegationDepth:1}});
    assert.equal(e.wb.startWorkbench({sessionId:'child'}).code,'MAIN_SESSION_REQUIRED');assert.deepEqual(e.state.projects,[]);
  });
  await check('A corrupt project file is reported rather than overwritten',()=>{
    const e=setup('corrupt');fs.writeFileSync(path.join(e.workspace,'project.json'),'{broken');
    const out=e.wb.startWorkbench({sessionId:'corrupt'});assert.equal(out.ok,false);assert.equal(fs.readFileSync(path.join(e.workspace,'project.json'),'utf8'),'{broken');assert.deepEqual(e.state.projects,[]);
  });
  await check('A deleted bound project never falls back to another conversation project',()=>{
    const e=setup('missing');const first=e.wb.startWorkbench({sessionId:'first'}),second=e.wb.startWorkbench({sessionId:'second'});
    assert.equal(first.ok,true,first.error);assert.equal(second.ok,true,second.error);
    fs.unlinkSync(path.join(first.project.path,'project.json'));
    assert.equal(e.wb.startWorkbench({sessionId:'first'}).code,'BOUND_PROJECT_UNAVAILABLE');
    const active=e.wb.runForSession('first',()=>e.wb.active());assert.equal(active.ok,false);assert.equal(active.id,first.project.id);
    const callback=e.wb.runInProject(first.project.id,()=>e.wb.active());assert.equal(callback.ok,false);assert.equal(callback.id,first.project.id);
    assert.equal(e.wb.active().id,second.project.id);
    assert.equal(e.wb.runInProject('removed-project',()=>e.wb.active()).ok,false);
  });
  await check('Missing workspace and relative paths fail without guessing a global project',()=>{
    const e=setup('paths');e.wb.sessionCwd=()=>'';
    assert.equal(e.wb.startWorkbench({sessionId:'none'}).code,'DIRECTORY_REQUIRED');
    assert.equal(e.wb.startWorkbench({sessionId:'relative',projectDir:'relative'}).ok,false);
    assert.deepEqual(e.state.projects,[]);
  });
  await check('An explicitly changed workspace needs a switch and then selects the new workspace',()=>{
    const e=setup('workspace-switch');const first=e.wb.startWorkbench({sessionId:'chat'});assert.equal(first.ok,true,first.error);
    const next=path.join(e.root,'new-workspace');fs.mkdirSync(next);
    assert.equal(e.wb.startWorkbench({sessionId:'chat',workspaceDir:next}).code,'SESSION_BOUND_ELSEWHERE');
    const switched=e.wb.startWorkbench({sessionId:'chat',workspaceDir:next,switchProject:true});assert.equal(switched.ok,true,switched.error);
    assert.equal(switched.project.path,next+'-实证研究');assert.notEqual(switched.project.id,first.project.id);
    assert.equal(e.wb.startWorkbench({sessionId:'chat',workspaceDir:next}).already,true);
  });
  await check('An explicit project directory does not depend on an unrelated missing cwd',()=>{
    const e=setup('explicit-cwd');e.wb.sessionCwd=()=>path.join(e.root,'deleted-workspace');
    const target=path.join(e.root,'explicit-project');const result=e.wb.startWorkbench({sessionId:'chat',projectDir:target});
    assert.equal(result.ok,true,result.error);assert.equal(result.project.path,target);
  });
  await check('An armed temporary conversation cannot steal or run another conversation project',async()=>{
    const e=setup('temp-scope');const owner=e.wb.startWorkbench({sessionId:'owner'});assert.equal(owner.ok,true,owner.error);
    e.wb.armSession('temporary','install');let executed=false;
    const execute=wrapExecute({name:'data_analysis_run_stage',workbench:e.wb,original:()=>{executed=true;return {ok:true};}});
    const result=await execute({}, {agent:{session:{id:'temporary'}}});
    assert.equal(result.ok,false);assert.equal(result.code,'PROJECT_BOUND_ELSEWHERE');assert.equal(executed,false);
    assert.equal(e.wb.sessionBinding('owner').projectId,owner.project.id);assert.equal(e.wb.sessionBinding('temporary'),null);
  });
  await check('An orphaned binding never silently attaches to the global project',async()=>{
    const e=setup('orphan');const first=e.wb.startWorkbench({sessionId:'first'});assert.equal(first.ok,true,first.error);
    const second=e.wb.startWorkbench({sessionId:'second'});assert.equal(second.ok,true,second.error);
    e.state.projects=e.state.projects.filter(p=>p.id!==first.project.id);let executed=false;
    assert.equal(e.wb.runForSession('first',()=>e.wb.active()).ok,false);
    const execute=wrapExecute({name:'data_analysis_run_stage',workbench:e.wb,original:()=>{executed=true;return {ok:true};}});
    assert.equal((await execute({}, {agent:{session:{id:'first'}}})).ok,false);assert.equal(executed,false);
    assert.equal(e.wb.startWorkbench({sessionId:'first'}).code,'BOUND_PROJECT_UNAVAILABLE');assert.equal(e.wb.sessionBinding('second').projectId,second.project.id);
  });
  await check('Foreign or malformed project JSON is not adopted as a research project',()=>{
    for(const [label,value] of [['foreign',{name:'other application'}],['array',[]],['empty',{}],['bad-stages',{name:'bad',stages:[]}]] ){
      const e=setup('project-'+label);const file=path.join(e.workspace,'project.json');const original=JSON.stringify(value);fs.writeFileSync(file,original);
      const result=e.wb.startWorkbench({sessionId:'chat'});assert.equal(result.ok,false,label);assert.equal(fs.readFileSync(file,'utf8'),original);assert.deepEqual(e.state.projects,[]);
    }
  });
  await check('Focus and implicit binding cannot evict the project owner',()=>{
    const e=setup('focus-owner');const owner=e.wb.startWorkbench({sessionId:'owner'});assert.equal(owner.ok,true,owner.error);
    e.wb.sessionCwd=()=>owner.project.path;e.wb.focusSession('unrelated');
    assert.equal(e.wb.sessionBinding('unrelated'),null);assert.equal(e.wb.sessionBinding('owner').projectId,owner.project.id);
    assert.equal(e.wb.bindSessionTo('unrelated',owner.project.id).code,'PROJECT_BOUND_ELSEWHERE');
  });
  await check('Runtime configuration cannot be switched during production or checking',()=>{
    const e=setup('runtime-config'),before=JSON.stringify(e.state.config);
    e.state.runs.push({id:'synthetic-running',status:'running'});
    assert.equal(e.wb.updateConfig({pythonPath:'other-python'}).ok,false);assert.equal(e.wb.updateConfig({dataDir:path.join(e.root,'other-ledger')}).ok,false);
    assert.equal(JSON.stringify(e.state.config),before);e.state.runs=[];
    e.wb.gateChecks.set('synthetic-project',{});assert.equal(e.wb.updateConfig({pythonPath:'other-python'}).ok,false);e.wb.gateChecks.clear();
  });
  console.log(`All ${passed} bootstrap regressions passed`);
}finally{
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(temp,{recursive:true,force:true});
}

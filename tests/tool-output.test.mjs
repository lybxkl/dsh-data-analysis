/** Assert what DSH renders to the model, beyond the service's JSON return value. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {defaultWorkflow} from '../src/workflow.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsa-tool-output-'));
try{
  // The SDK's defineTool is an identity declaration builder; all actual tool code,
  // session wrapping and admission remain the production implementation.
  let source=fs.readFileSync(new URL('../src/tools.js',import.meta.url),'utf8');
  assert.ok(source.includes("import { defineTool } from '@deepseek-ai/dsh-tools';"));
  source=source.replace("import { defineTool } from '@deepseek-ai/dsh-tools';",'const defineTool=value=>value;');
  source=source.replaceAll(/from '(\.\/[^']+)'/g,(_all,rel)=>'from '+JSON.stringify(new URL('../src/'+rel.slice(2),import.meta.url).href));
  const file=path.join(root,'actual-tools.mjs');fs.writeFileSync(file,source);
  const {registerTools}=await import(pathToFileURL(file).href);
  const workflow=structuredClone(defaultWorkflow());
  workflow.stages.push({id:'unseen-stage',dependsOn:[],steps:[{script:'scripts/unseen.py',args:['--value','新参数']}],artifacts:['output/unseen.json']});
  workflow.actions.push({id:'unseen-action',stage:'unseen-stage',label:'新动作'});
  const evidence={ok:true,gate:{id:'synthetic-gate',status:'fail',detail:'content changed',resources:[{id:'input',sha256:'a'.repeat(64)}]}};
  const action={ok:false,runId:'synthetic-run',exitCode:0,error:'quality failed',result:{quality:'fail'}};
  const wb={workflow:()=>workflow,runWorkflowAction:()=>action,gateEvidence:()=>evidence,isArmed:()=>false};
  const definitions=new Map(),admissions=new Map();
  registerTools({tools:{register:(definition,admission)=>{definitions.set(definition.name,definition);admissions.set(definition.name,admission);}}},wb);
  const visible=async(name,args)=>{
    const definition=definitions.get(name);assert.ok(definition,'actual tool must be registered');
    const result=await definition.execute(args,{});
    const blocks=definition.output.render(args,result);
    assert.equal(blocks.length,1);assert.equal(blocks[0].type,'text');return JSON.parse(blocks[0].text);
  };
  const described=await visible('data_analysis_workflow',{action:'describe'});
  assert.deepEqual(described.workflow,workflow,'the complete declaration must survive the host render step');
  assert.equal(described.workflow.stages.at(-1).steps[0].args[1],'新参数');
  assert.deepEqual(await visible('data_analysis_workflow',{action:'run-action',actionId:'unseen-action'}),action,'a zero production exit must not hide failed quality');
  assert.deepEqual(await visible('data_analysis_gates',{action:'evidence'}),evidence,'the model must see the exact evidence and currentness binding');
  wb.gateControl=()=>({ok:true,status:'completed',state:{gateMode:'legacy',gateModeNotice:'Compatibility is not quality approval',deliveryReady:false,
    stages:[{id:'custom',status:'review',gates:[{id:'currentness',status:'unjudged',reason:'binding-mismatch',resources:[{payload:'x'.repeat(1024*1024)}]}]}]}});
  const inspected=await visible('data_analysis_gates',{action:'inspect'});
  assert.equal(inspected.state.deliveryReady,false);
  assert.equal(inspected.state.gateMode,'legacy');
  assert.equal(inspected.state.stages[0].gates[0].reason,'binding-mismatch');
  assert.ok(JSON.stringify(inspected).length<3000,'inspection summaries must not duplicate per-file evidence');
  assert.equal(admissions.get('data_analysis_start'),undefined);
  assert.equal(admissions.get('data_analysis_workflow').when({agent:{id:'unarmed'}}),false);
  console.log('PASS Model-visible workflow retains all dynamic stage arguments, dependencies, actions and instructions');
  console.log('PASS Model-visible action results retain failed quality despite a successful production exit');
  console.log('PASS Model-visible gate evidence retains status and exact resource hashes');
  console.log('PASS Output rendering preserves the startup and stage-tool admission boundary');
}finally{
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(root,{recursive:true,force:true});
}

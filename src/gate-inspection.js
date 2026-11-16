/** Run the skill's checker without changing the production exit status. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {readGatePolicy,safePath,validatePolicyCatalog} from './gate-report.js';

function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${crypto.randomUUID()}.tmp`;
  try{fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);}
  finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}

export function invalidateGateReports(root){
  if(!readGatePolicy(root))return;
  const dir=safePath(root,'output/gates/state');
  if(!fs.existsSync(dir))return;
  for(const entry of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))){
    const file=safePath(root,'output/gates/state/'+entry);
    // Mark corrupt pointers invalid as well; never leave a previous green state.
    let state={};try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
    delete state.resultPath;delete state.resultSha256;
    atomic(file,{...state,phase:'production-running',updatedAt:new Date().toISOString()});
  }
}

export async function inspectAfterRun({root,skillRoot,python,run,lease=null,stageIds=null,signal=null,explicit=false}){
  const policy=readGatePolicy(root);
  if(!policy||(policy.mode==='legacy'&&!explicit))return {status:'disabled'};
  if(policy.invalid)return {status:'failed',reason:'invalid-policy'};
  try{validatePolicyCatalog(policy,skillRoot);}catch{return {status:'failed',reason:'invalid-policy'};}
  const script=path.join(skillRoot,'scripts/gates.py');
  if(!fs.existsSync(script))return {status:'failed',reason:'missing-checker'};
  const stages=stageIds||[...new Set(policy.requirements.filter(x=>x.source==='skill').map(x=>x.reportStage))];
  const allowed=new Set(policy.requirements.filter(x=>x.source==='skill').map(x=>x.reportStage));
  if(!Array.isArray(stages)||!stages.length||stages.some(stage=>typeof stage!=='string'||!allowed.has(stage)))
    return {status:'failed',reason:'invalid-stage',error:'阶段不支持技能报告，请选择策略中已登记的技能检查阶段',results:[]};
  const results=[];
  for(const stage of stages){
    if(signal?.aborted)break;
    const exit=await new Promise(resolve=>{
      let settled=false, timedOut=false, cancelled=false, spawnError='',leaseError='';
      const child=spawn(python||'python',[script,'evaluate','--root',root,'--stage',stage,'--checkpoint',stage==='qa'||stage==='recheck'?'delivery-ready':'data-ready',...(run?.id?['--run-id',run.id]:[])],{cwd:root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',...(lease?{DSA_GATE_LEASE_TOKEN:lease.token}:{})},stdio:['ignore','ignore','pipe']});
      let error='';child.stderr.on('data',b=>{error=(error+b.toString()).slice(-2000);});
      function stop(){
        if(process.platform==='win32'&&child.pid)spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
        else child.kill('SIGTERM');
      }
      const abort=()=>{cancelled=true;stop();};
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
      const timer=setTimeout(()=>{timedOut=true;stop();},600000);
      if(child.pid&&lease){try{lease.registerChild(child.pid);}catch(error){leaseError=error.message;stop();}}
      function finish(result){if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(result);}
      child.once('error',error=>{spawnError=error.message;});
      child.once('close',code=>{
        if(child.pid&&lease){try{lease.childClosed(child.pid);}catch(error){leaseError=error.message;}}
        let reason=leaseError?'lease-update-failed':cancelled?'cancelled':timedOut?'timeout':spawnError?'spawn-failed':code===0?'':'checker-failed';
        if(reason){
          try{
            const file=safePath(root,`output/gates/state/${stage}.json`);
            let state={};try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
            delete state.resultPath;delete state.resultSha256;
            atomic(file,{...state,phase:cancelled?'cancelled':'crashed',reason,updatedAt:new Date().toISOString()});
          }catch{reason='control-write-failed';}
        }
        finish({exitCode:reason?null:code,reason});
      });
    });
    results.push({stage,...exit});
  }
  return {status:signal?.aborted?'cancelled':results.every(x=>x.exitCode===0)?'completed':'failed',results};
}

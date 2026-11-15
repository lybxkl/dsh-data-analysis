/** Explicit inspector operations; never enter the production runner recursively. */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function gateCommand({root,skillRoot,python,action,mode,stage,checkpoint,lease}) {
  if(!['init-policy','migrate-policy','recover','evaluate'].includes(action))return Promise.resolve({ok:false,error:'未知体检操作'});
  const script=path.join(skillRoot,'scripts/gates.py');
  if(!fs.existsSync(script))return Promise.resolve({ok:false,error:'技能包未提供当前体检协议'});
  const args=[script,action,'--root',root];
  if(mode)args.push('--mode',mode);
  if(stage)args.push('--stage',stage);
  if(checkpoint)args.push('--checkpoint',checkpoint);
  return new Promise(resolve=>{
    const child=spawn(python||'python',args,{cwd:root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',...(lease?{DSA_GATE_LEASE_TOKEN:lease.token}:{})},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',settled=false,spawnError='',leaseError='',timedOut=false;
    function finish(value){if(settled)return;settled=true;clearTimeout(timer);resolve(value);}
    function stop(){if(process.platform==='win32'&&child.pid)spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM');}
    const timer=setTimeout(()=>{timedOut=true;stop();},600000);
    if(child.pid&&lease){try{lease.registerChild(child.pid);}catch(error){leaseError=error.message;stop();}}
    child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(-64000);});
    child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-8000);});
    child.once('error',error=>{spawnError=error.message;});
    child.once('close',exitCode=>{
      if(child.pid&&lease){try{lease.childClosed(child.pid);}catch(error){leaseError=error.message;}}
      const ok=exitCode===0&&!spawnError&&!leaseError&&!timedOut;
      finish({ok,exitCode,...(ok?{}:{error:leaseError||spawnError||(timedOut?'体检操作超时':stderr||stdout||'体检操作未完成')})});
    });
  });
}

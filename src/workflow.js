/** Package-owned workflow; this module only interprets the versioned contract. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {homedir} from 'node:os';
import {validateSchema} from './gate-schema.js';
import {strictJson,safePath,projectResourcePath} from './gate-report.js';
import {readMemo} from './read-scope.js';

const FEATURES=new Set(['dag-v1','bindings-v1','actions-v1','gate-admission-v1','ui-v1']);
const ID=/^[a-z][a-z0-9-]{0,63}$/;
const PANELS=new Set(['corpus','analysis','models','figures','numbers','qa','manuscript','manuscriptSpec','recheck']);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function relative(value){
  if(typeof value!=='string'||!value||value.endsWith('/')||value.includes('\\')||value.includes(':')||value.includes('\0')||path.posix.normalize(value)!==value||path.isAbsolute(value)||value.split('/').includes('..'))throw Error('工作流含不安全的相对路径');
  return value;
}
function read(file){
  if(fs.statSync(file).size>2*1024*1024)throw Error('工作流文件超过读取预算');
  return fs.readFileSync(file);
}
export function defaultWorkflow(candidates=[]){
  const roots=[process.env.DSA_SKILL_ROOT,...candidates,path.join(homedir(),'.agents/skills/empirical-research-pipeline'),path.join(homedir(),'.codex/skills/empirical-research-pipeline')].filter(Boolean);
  for(const root of roots){
    if(fs.existsSync(path.join(root,'SKILL.md')))return loadWorkflow(root);
    if(fs.existsSync(path.join(root,'empirical-research-pipeline/SKILL.md')))return loadWorkflow(path.join(root,'empirical-research-pipeline'));
  }
  throw Error('未找到技能工作流：请配置包含 contracts/workflow/workflow.json 的技能包');
}
export function workflowFor(project={},configuredRoot=''){
  const root=project?.skill?.root||configuredRoot;
  if(!root)return defaultWorkflow();
  return loadWorkflow(fs.existsSync(path.join(root,'SKILL.md'))?root:path.join(root,'empirical-research-pipeline'));
}
export function loadWorkflow(root){
  return readMemo(`workflow:${root}`,()=>{
    try{
      const bytes=read(safePath(root,'contracts/workflow/workflow.json'));
      const schemaBytes=read(safePath(root,'contracts/workflow/workflow.schema.json'));
      const value=strictJson(bytes.toString('utf8'));
      validateSchema(value,strictJson(schemaBytes.toString('utf8')));
      if(value.requiredFeatures.some(feature=>!FEATURES.has(feature)))throw Error('插件不支持工作流要求的能力，请升级插件');
      if(!value.stages.length||value.stages.length>200||value.actions.length>400)throw Error('工作流阶段或动作数量超出协议范围');
      const ids=new Set(),seen=new Set();
      for(const stage of value.stages){
        if(!ID.test(stage.id)||ids.has(stage.id))throw Error('阶段 ID 无效或重复');
        ids.add(stage.id);
      }
      for(const stage of value.stages){
        if(stage.dependsOn.some(id=>!ids.has(id)||!seen.has(id)))throw Error(`阶段 ${stage.id} 的依赖不存在、成环或排在其后`);
        seen.add(stage.id);
        for(const panel of stage.ui?.panels||[])if(!PANELS.has(panel))throw Error(`不支持的工作流面板：${panel}`);
        for(const file of [...(stage.artifacts||[]),...(stage.ui?.requiredFiles||[]),...(stage.ui?.artifactPrefixes||[]).map(file=>file.replace(/\/$/,''))])relative(file);
        if(stage.ui?.legacySkipWhenMissing)relative(stage.ui.legacySkipWhenMissing);
        if(stage.resumeFile)relative(stage.resumeFile);
        if(stage.minTier&&!['explore','submission','archive'].includes(stage.minTier))throw Error(`阶段 ${stage.id} 的验收档无效`);
        if(stage.loop){relative(stage.loop.draftDir);relative(stage.loop.freezeFile);relative(stage.loop.sampleReport);}
        if(stage.hostCall){relative(stage.hostCall.input);if(!stage.hostCall.tool||!Array.isArray(stage.hostCall.returns)||!stage.hostCall.returns.length)throw Error(`阶段 ${stage.id} 的交付调用不完整`);}
      }
      const actions=new Set(),tools=new Set();
      for(const action of value.actions){
        if(!ID.test(action.id)||actions.has(action.id)||!ids.has(action.stage))throw Error('动作 ID 重复或引用未知阶段');
        actions.add(action.id);
        if(action.tool){const key=`${action.tool}:${action.variant||''}`;if(tools.has(key))throw Error('工具动作绑定重复');tools.add(key);}
        if(action.outFile)relative(action.outFile);
      }
      const tasks=new Set();
      for(const task of value.draftTasks){
        if(!ids.has(task.stage)||tasks.has(task.id))throw Error('起草任务引用未知阶段或 ID 重复');
        tasks.add(task.id);
        relative(task.file);
        for(const file of task.contextFiles||[])relative(file);
      }
      for(const stage of value.stages)if(stage.ui?.draftTask&&!tasks.has(stage.ui.draftTask))throw Error('阶段引用未知起草任务');
      for(const rule of value.rerunRules){relative(rule.pattern.replace(/\/$/,''));if(rule.stages.some(id=>!ids.has(id)))throw Error('重跑规则引用未知阶段');}
      for(const directory of value.workspace.directories)relative(directory);
      for(const stage of [...value.stages,...value.actions]){
        for(const key of ['admission','afterRun','legacyAdmission'])if(stage[key]?.whenFile)relative(stage[key].whenFile);
        for(const step of [stage,...(stage.steps||[])]){
          if(step.script)relative(step.script);
          if(step.whenFile)relative(step.whenFile);
          for(const file of step.produces||[])relative(file);
          for(const opt of [...(step.optionalArgs||[]),...(step.optionalFlags||[])]){if(opt.file)relative(opt.file);if(opt.whenFile)relative(opt.whenFile);}
        }
      }
      const tokens=new Set();
      for(const binding of value.argumentBindings){
        if(tokens.has(binding.token))throw Error('参数绑定 token 重复');
        if(binding.select==='directory-of'&&!tokens.has(binding.from))throw Error('参数绑定依赖不存在或排在其后');
        tokens.add(binding.token);
        for(const item of binding.paths||[]){if(typeof item==='string')relative(item);else relative(item.json);}
        if(binding.fallback)relative(binding.fallback);
        for(const file of Object.values(binding.cases||{}))relative(file);
      }
      const catalogFile=safePath(root,'contracts/gates/catalog.json');
      if(fs.existsSync(catalogFile)){
        const definitions=strictJson(read(catalogFile).toString('utf8')).gates;
        const gateIds=new Set(definitions.map(g=>g.id));
        const reports=new Set(definitions.filter(g=>g.owner==='skill').map(g=>g.reportStage));
        const reportStages=new Set(definitions.map(g=>g.reportStage));
        if(definitions.some(g=>!ids.has(g.displayStage)))throw Error('工作流缺少判据目录要求的显示阶段');
        for(const owner of [...value.stages,...value.actions]){
          for(const key of ['admission','afterRun','legacyAdmission'])if((owner[key]?.gates||[]).some(id=>!gateIds.has(id)))throw Error('工作流条件引用未知判据');
          for(const key of ['admission','afterRun','legacyAdmission']){
            const selected=owner[key]?.reportStages;
            if(selected&&(!selected.length||selected.some(id=>!reportStages.has(id))))throw Error('工作流条件引用空集合或未知报告阶段');
          }
          if((owner.inspectionStages||[]).some(id=>!reports.has(id)))throw Error('工作流引用未知体检阶段');
        }
      }
      if(value.acceptanceTiers&&!['explore','submission','archive'].includes(value.acceptanceTiers.default))throw Error('默认验收档无效');
      const stages=value.stages.map((stage,index)=>({...stage,index:index+1,script:stage.script||stage.steps?.[0]?.script||null,workflowHash:sha(bytes),taskConstraints:value.taskConstraints}));
      return {...value,stages,root,sha256:sha(bytes),schemaSha256:sha(schemaBytes),ok:true};
    }catch(error){throw Error(`技能工作流不可用：${error.message}`);}
  });
}

export function workflowFileExists(root,relative){
  try{return fs.statSync(projectResourcePath(root,relative)).isFile();}catch{return false;}
}

/** Resolve declarative file choices without knowing dataset, model or figure names. */
export function workflowArguments(workflow,root,args){
  const bindings=new Map();
  const file=rel=>projectResourcePath(root,relative(rel));
  const exists=rel=>{try{return fs.statSync(file(rel)).isFile();}catch{return false;}};
  for(const rule of workflow.argumentBindings){
    if(rule.select==='directory-of'){
      const selected=bindings.get(rule.from);
      bindings.set(rule.token,rule.cases?.[selected]||path.posix.dirname(selected));
      continue;
    }
    const paths=[];
    for(const item of rule.paths||[]){
      if(typeof item==='string')paths.push(item);
      else{
        try{
          const data=strictJson(read(file(item.json)).toString('utf8'));
          const rows=item.array.split('.').reduce((value,key)=>value?.[key],data);
          if(!Array.isArray(rows))throw Error('参数绑定的集合不是数组');
          paths.push(...rows.map(row=>row?.[item.field]).filter(value=>typeof value==='string'));
        }catch(error){if(fs.existsSync(file(item.json)))throw error;}
      }
    }
    for(const candidate of paths)relative(candidate);
    const available=paths.filter(exists);
    if(rule.select==='latest-existing')available.sort((a,b)=>fs.statSync(file(b)).mtimeMs-fs.statSync(file(a)).mtimeMs);
    bindings.set(rule.token,available[0]||rule.fallback);
  }
  return args.map(arg=>bindings.get(arg)||String(arg).replaceAll('{projectRoot}',root).replaceAll('{dataDir}','data').replaceAll('{outputDir}','output'));
}
export function rerunStages(workflow,file){
  const rel=String(file).replaceAll('\\','/').replace(/^\.\//,'');
  const rule=workflow.rerunRules.find(rule=>rule.match==='exact'?rel===rule.pattern:rel.startsWith(rule.pattern));
  return rule?[...rule.stages]:[];
}

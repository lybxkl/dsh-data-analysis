/** Consume portable skill facts. This module contains no research formulas. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import { validateSchema } from './gate-schema.js';

export const CHECKPOINTS=['data-ready','analysis-ready','figures-ready','manuscript-ready','delivery-ready'];
const states=['pass','fail','unjudged','na'];
const FEATURES=['coverage-v1','relative-roots-v1','project-aliases-v1','package-closure-v1'];
const sha=file=>{if(fs.statSync(file).size>2*1024**3)throw Error('verification-budget');const fd=fs.openSync(file,'r');try{const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,count));return hash.digest('hex');}finally{fs.closeSync(fd);}};

function relativeSyntax(relative) {
  if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.includes(':')||relative.includes('\0')||relative.split('/').includes('..')||path.posix.normalize(relative)!==relative||path.isAbsolute(relative))throw Error('unsafe-path');
}

export function safePath(root, relative) {
  relativeSyntax(relative);
  const base=fs.realpathSync(root), target=path.resolve(base,relative);
  let existing=target;
  while(!fs.existsSync(existing))existing=path.dirname(existing);
  const real=fs.realpathSync(existing), rel=path.relative(base,real);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('outside-root');
  return target;
}

export function materialRoots(root) {
  const file=safePath(root,'.workbench/gates/roots.json');
  if(!fs.existsSync(file))return {};
  const value=read(file);
  if(value.schema!=='dsa.gate-roots/1'||!value.roots||typeof value.roots!=='object')throw Error('invalid-material-roots');
  for(const [id,base] of Object.entries(value.roots))if(!/^material:[A-Za-z0-9_.-]+$/.test(id)||typeof base!=='string'||!path.isAbsolute(base))throw Error('invalid-material-root');
  return value.roots;
}

export function projectResourcePath(root,relative) {
  relativeSyntax(relative);
  try{return safePath(root,relative);}catch(error){
    const target=path.resolve(root,relative);
    let existing=target;
    while(!fs.existsSync(existing))existing=path.dirname(existing);
    const actual=fs.realpathSync(existing);
    for(const base of Object.values(materialRoots(root))){
      const rel=path.relative(fs.realpathSync(base),actual);
      if(!rel.startsWith('..')&&!path.isAbsolute(rel))return target;
    }
    throw error;
  }
}

// A recursive JSON reader rejects duplicate keys before JSON.parse can erase them.
export function strictJson(text) {
  let i=0;
  const ws=()=>{while(/[\x20\t\r\n]/.test(text[i]||'')&&i<text.length)i++;};
  function value(depth=0){
    if(depth>64)throw Error('json-depth');ws();
    if(text[i]==='"'){
      const start=i++;
      while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"')return JSON.parse(text.slice(start,i));}
      throw Error('json-string');
    }
    if(text[i]==='{'){
      i++;ws();const out=Object.create(null);if(text[i]==='}'){i++;return out;}
      for(;;){ws();if(text[i]!=='"')throw Error('json-key');const key=value(depth+1);if(Object.hasOwn(out,key))throw Error('duplicate-json-key');ws();if(text[i++]!==':')throw Error('json-colon');out[key]=value(depth+1);ws();const c=text[i++];if(c==='}')return out;if(c!==',')throw Error('json-object');}
    }
    if(text[i]==='['){i++;ws();const out=[];if(text[i]===']'){i++;return out;}for(;;){out.push(value(depth+1));ws();const c=text[i++];if(c===']')return out;if(c!==',')throw Error('json-array');}}
    const m=text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);if(!m)throw Error('json-token');i+=m[0].length;const result=JSON.parse(m[0]);if(typeof result==='number'&&!Number.isFinite(result))throw Error('json-nonfinite');return result;
  }
  const out=value();ws();if(i!==text.length)throw Error('json-trailing');return out;
}

function read(file){if(fs.statSync(file).size>8*1024*1024)throw Error('report-too-large');return strictJson(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}

export function readGatePolicy(root){
  try{
    const file=safePath(root,'.workbench/gates/policy.json');
    if(!fs.existsSync(file)){
      let required=false;
      try{required=read(safePath(root,'project.json')).gatePolicy?.required===true;}catch{}
      if(required||fs.existsSync(safePath(root,'.workbench/gates/required.json'))||fs.existsSync(safePath(root,'output/gates/state')))throw Error('missing-required-policy');
      return null;
    }
    const p=read(file);if(p.schema!=='dsa.gate-policy/1'||!['legacy','shadow','compare','skill'].includes(p.mode)||!Array.isArray(p.requirements)||!p.requirements.length||!p.scopeKey||new Set(p.requirements.map(r=>r.gateId)).size!==p.requirements.length||p.requirements.some(r=>!CHECKPOINTS.includes(r.blockingAt)||!['skill','workbench','legacy'].includes(r.source)||!r.definitionVersion||!r.reportStage||!r.displayStage))throw Error('invalid-policy');return p;
  }
  catch(error){return {mode:'skill',invalid:true,requirements:[],error:error.message};}
}

export function packageRoot(project){
  const dir=project.skill?.root;
  if(!dir)throw Error('missing-skill-root');
  return fs.existsSync(path.join(dir,'SKILL.md'))?dir:path.join(dir,'empirical-research-pipeline');
}

export function implementationBindings(skillRoot){
  const manifest=read(safePath(skillRoot,'contracts/gates/package-manifest.json'));
  const declared=manifest.members.map(entry=>entry.path);
  const expected=new Set(declared),actual=new Set(declared.filter(name=>!name.includes('/')&&fs.statSync(safePath(skillRoot,name)).isFile()));
  if(expected.size!==declared.length)throw Error('duplicate-implementation-member');
  const seen=new Set();
  function visit(relative){
    const directory=safePath(skillRoot,relative),real=fs.realpathSync(directory);
    if(seen.has(real))throw Error('implementation-cycle');seen.add(real);
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      if(entry.name==='__pycache__')continue;
      const name=path.posix.join(relative,entry.name),file=safePath(skillRoot,name);
      if(fs.statSync(file).isDirectory())visit(name);
      else if(entry.name!=='package-manifest.json'&&!/\.py[co]$/.test(entry.name))actual.add(name);
      if(actual.size>5000||seen.size>5000)throw Error('implementation-budget');
    }
  }
  for(const directory of new Set(declared.filter(name=>name.includes('/')).map(name=>name.split('/')[0])))visit(directory);
  if(actual.size!==expected.size||[...actual].some(name=>!expected.has(name)))throw Error('implementation-membership-changed');
  return Object.fromEntries(manifest.members.map(entry=>[entry.path,sha(safePath(skillRoot,entry.path))]));
}

export function validatePolicyCatalog(policy,skillRoot){
  validateSchema(policy,read(safePath(skillRoot,'contracts/gates/policy.schema.json')));
  const catalog=read(safePath(skillRoot,'contracts/gates/catalog.json'));
  if(sha(safePath(skillRoot,'contracts/gates/catalog.json'))!==policy.catalogSha256)throw Error('policy/catalog mismatch');
  if(catalog.gates.length!==policy.requirements.length)throw Error('incomplete-policy');
  const definitions=new Map(catalog.gates.map(g=>[g.id,g]));
  for(const r of policy.requirements){
    const g=definitions.get(r.gateId);
    if(!g||g.definitionVersion!==r.definitionVersion||g.reportStage!==r.reportStage||g.displayStage!==r.displayStage||g.owner!==r.source||
      (g.required!==false&&r.required!==true)||(r.allowNa&&!g.allowNa)||CHECKPOINTS.indexOf(r.blockingAt)>CHECKPOINTS.indexOf(g.blockingAt))throw Error('policy-rule-mismatch');
  }
}

export function currentEnvironment(skillRoot,python='python'){
  const process=spawnSync(python,[safePath(skillRoot,'scripts/gates.py'),'environment'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,windowsHide:true});
  if(process.status!==0)throw Error('environment-unavailable');
  return strictJson(process.stdout);
}

function realTarget(file){
  let existing=file;
  while(!fs.existsSync(existing))existing=path.dirname(existing);
  return path.resolve(fs.realpathSync(existing),path.relative(existing,file));
}

export function resourceAliasesCurrent(root,resource,canonical){
  return (resource.projectPaths||[]).every(alias=>
    path.relative(realTarget(canonical),realTarget(projectResourcePath(root,alias)))==='');
}

export function collectionMembers(root,collection){
  const base=collection.rootId==='project'?root:materialRoots(root)[collection.rootId];
  if(!base||!collection.complete||collection.selector?.recursive!==true)throw Error('unsupported-collection');
  const members=[],seen=new Set();
  const resolve=rel=>collection.rootId==='project'?projectResourcePath(root,rel):safePath(base,rel);
  function visit(rel){
    const dir=resolve(rel);if(!fs.existsSync(dir))return;
    const actual=fs.realpathSync(dir);if(seen.has(actual))throw Error('collection-cycle');seen.add(actual);
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const name=path.posix.join(rel,entry.name),file=resolve(name),stat=fs.statSync(file);
      if(stat.isDirectory())visit(name);else if(stat.isFile())members.push(name);
      if(members.length>5000||seen.size>5000)throw Error('collection-budget');
    }
  }
  visit(collection.basePath);return members.sort();
}

export function loadStageReport(root,project,policy,stage,runtime=null){
  const skillRoot=packageRoot(project);
  validatePolicyCatalog(policy,skillRoot);
  const state=read(safePath(root,`output/gates/state/${stage}.json`));
  if(state.phase!=='completed')throw Error('inspection-'+state.phase);
  const base=`output/gates/runs/${state.attemptId}/`;
  if(!/^[a-zA-Z0-9-]+$/.test(state.attemptId)||!state.requestPath?.startsWith(base)||!state.resultPath?.startsWith(base))throw Error('invalid-attempt-path');
  const requestFile=safePath(root,state.requestPath),resultFile=safePath(root,state.resultPath);
  if(sha(requestFile)!==state.requestSha256||sha(resultFile)!==state.resultSha256)throw Error('attempt-integrity');
  const request=read(requestFile),result=read(resultFile);
  if(result.outcome!=='completed'||result.attemptId!==state.attemptId||result.generation!==state.generation||request.attemptId!==state.attemptId||request.generation!==state.generation||!result.reportPath?.startsWith(base))throw Error('attempt-mismatch');
  const reportFile=safePath(root,result.reportPath);
  if(sha(reportFile)!==result.reportSha256)throw Error('report-integrity');
  const report=read(reportFile);
  const env=runtime||currentEnvironment(skillRoot);
  if(report.environment.python!==env.python||JSON.stringify(Object.entries(report.environment.modules||{}).sort())!==JSON.stringify(Object.entries(env.modules||{}).sort()))throw Error('environment-changed');
  if(state.stage!==stage||request.stage!==stage||request.scopeKey!==report.scopeKey||request.checkpoint!==report.checkpoint||request.catalogSha256!==report.catalogSha256||request.policySha256!==report.policySha256||result.checkerExitCode!==0)throw Error('attempt-context-mismatch');
  const requested=policy.requirements.filter(r=>r.source==='skill'&&r.reportStage===stage).map(r=>r.gateId).sort();
  if(JSON.stringify([...request.requestedGateIds].sort())!==JSON.stringify(requested)||JSON.stringify(report.gates.map(g=>g.id).sort())!==JSON.stringify(requested))throw Error('incomplete-gate-scope');
  validateSchema(report,read(safePath(skillRoot,'contracts/gates/report.schema.json')));
  validateSchema(policy,read(safePath(skillRoot,'contracts/gates/policy.schema.json')));
  const attemptSchema=read(safePath(skillRoot,'contracts/gates/attempt.schema.json'));
  for(const value of [state,request,result])validateSchema(value,attemptSchema);
  if(report.schema!=='dsa.gates/1'||report.stage!==stage||report.attemptId!==state.attemptId||report.generation!==state.generation||report.scopeKey!==policy.scopeKey||report.requiredFeatures.some(x=>!FEATURES.includes(x)))throw Error('report-contract');
  if(sha(safePath(root,'.workbench/gates/policy.json'))!==report.policySha256||report.catalogSha256!==policy.catalogSha256||sha(safePath(skillRoot,'contracts/gates/catalog.json'))!==policy.catalogSha256)throw Error('policy-mismatch');
  if(Object.entries(policy.thresholds).some(([key,value])=>typeof value!=='number'||!Number.isFinite(value)||value<=0||report.thresholds[key]!==value))throw Error('threshold-mismatch');
  const manifestFile=safePath(skillRoot,'contracts/gates/package-manifest.json');
  if(sha(manifestFile)!==report.skill.manifestSha256)throw Error('implementation-mismatch');
  const implementation=implementationBindings(skillRoot);
  for(const entry of read(manifestFile).members){if(implementation[entry.path]!==entry.sha256)throw Error('implementation-changed');}
  const invalidCollections=new Set();
  const collectionIds=new Set(report.collections.map(c=>c.id));
  if(collectionIds.size!==report.collections.length)throw Error('duplicate-collection');
  for(const c of report.collections){
    if(JSON.stringify(collectionMembers(root,c))!==JSON.stringify(c.members))invalidCollections.add(c.id);
  }
  const counts=Object.fromEntries(states.map(x=>[x,0])),ids=new Set(),resources=new Map();
  for(const r of report.resources){if(resources.has(r.id))throw Error('duplicate-resource');resources.set(r.id,r);}
  for(const g of report.gates){
    if(ids.has(g.id)||!states.includes(g.status))throw Error('duplicate-gate-or-status');ids.add(g.id);counts[g.status]++;
    const c=g.coverage;if(!c||['expected','checked','failed','unjudged'].some(k=>!Number.isSafeInteger(c[k])||c[k]<0)||c.expected!==c.checked+c.unjudged||c.failed>c.checked)throw Error('coverage-invalid');
    if(!g.evidence?.length||g.evidence.some(e=>!resources.has(e.resourceRef))||g.inputRefs.some(ref=>!resources.has(ref))||g.collectionRefs.some(ref=>!collectionIds.has(ref))||(g.status==='pass'&&(!c.expected||c.unjudged||c.failed))||(g.status==='unjudged'&&!g.reason)||(g.status==='na'&&!g.applicability))throw Error('gate-evidence-invalid');
  }
  if(states.some(x=>report.summary[x]!==counts[x]))throw Error('summary-mismatch');
  const invalid=new Set();
  for(const r of resources.values()){
    const resourceRoot=r.rootId==='project'?root:r.rootId==='skill'?skillRoot:materialRoots(root)[r.rootId];if(!resourceRoot)throw Error('unknown-root');
    const file=r.rootId==='project'?projectResourcePath(root,r.path):safePath(resourceRoot,r.path),exists=fs.existsSync(file)&&fs.statSync(file).isFile();
    if(!resourceAliasesCurrent(root,r,file)||exists!==r.exists||(exists&&sha(file)!==r.sha256))invalid.add(r.id);
  }
  return report.gates.map(g=>{const stale=g.inputRefs.some(x=>invalid.has(x))||g.collectionRefs.some(x=>invalidCollections.has(x));return {...g,reportedStatus:g.status,status:stale?'unjudged':g.status,validationState:stale?'invalid':'valid',validationReason:stale?'binding-mismatch':'',source:'skill',reportId:report.reportId,generation:report.generation,generatedAt:report.generatedAt,resources:g.inputRefs.map(ref=>resources.get(ref))};});
}

export function resolveGateResource(root,project,resource) {
  const base=resource.rootId==='project'?root:resource.rootId==='skill'?packageRoot(project):materialRoots(root)[resource.rootId];
  if(!base)throw Error('unregistered-resource-root');
  const file=resource.rootId==='project'?projectResourcePath(root,resource.path):safePath(base,resource.path);
  if(!resourceAliasesCurrent(root,resource,file)||!resource.exists||sha(file)!==resource.sha256)throw Error('证据文件已变化，请先重新体检');
  return file;
}

export function applyGateReports(stages,{projectRoot,project,pythonPath,gateRuntime}){
  const policy=readGatePolicy(projectRoot);
  if(!policy||policy.mode==='legacy')return stages;
  if(policy.invalid){for(const stage of stages){stage.gates.push({id:'platform.policy',label:'门禁策略损坏',level:'error',status:'unjudged',detail:policy.error});stage.status='blocked';}return stages;}
  try{validatePolicyCatalog(policy,packageRoot(project));}catch(error){for(const stage of stages){stage.gates.push({id:'platform.policy',label:'策略需要迁移',level:'error',status:'unjudged',detail:error.message});if(policy.mode==='skill')stage.status='blocked';}return stages;}
  const labels=new Map(read(safePath(packageRoot(project),'contracts/gates/catalog.json')).gates.map(g=>[g.id,g.label]));
  const loaded=new Map();let runtime;
  try{runtime=gateRuntime||currentEnvironment(packageRoot(project),pythonPath||'python');}catch{runtime={python:'unavailable',modules:{}};}
  for(const req of policy.requirements.filter(x=>x.source==='skill')){
    if(!loaded.has(req.reportStage)){
      try{loaded.set(req.reportStage,{gates:loadStageReport(projectRoot,project,policy,req.reportStage,runtime)});}
      catch(error){loaded.set(req.reportStage,{gates:[],reason:error.message});}
    }
    const result=loaded.get(req.reportStage),g=result.gates.find(g=>g.id===req.gateId&&g.definitionVersion===req.definitionVersion);
    const fact=g||{id:req.gateId,definitionVersion:req.definitionVersion,reportedStatus:null,validationState:'invalid',validationReason:result.reason||'missing-gate',level:'error',status:'unjudged',detail:'技能体检尚未完成或报告不可采信',reason:result.reason||'missing-gate',source:'skill'};
    fact.label=labels.get(req.gateId)||fact.label||req.gateId;
    Object.assign(fact,{instanceKey:`${req.gateId}@${req.definitionVersion}:${policy.scopeKey}`,effectiveStatus:fact.status,evidenceRefs:fact.inputRefs||[],lastVerifiedAt:fact.generatedAt||null});
    const stage=stages.find(s=>s.id===req.displayStage);if(!stage)continue;
    if(policy.mode!=='skill'){if(policy.mode==='compare')stage.gateComparison=[...(stage.gateComparison||[]),fact];continue;}
    const previous=stage.gates.find(g=>g.id===req.gateId);
    stage.gates=stage.gates.filter(g=>g.id!==req.gateId);stage.gates.push({...fact,label:fact.label||previous?.label||req.gateId,manual:false,blockingAt:req.blockingAt});
    if(fact.status!=='pass'&&fact.status!=='na')stage.status='review';
  }
  return stages;
}

export function reportBlockers(stages,root,checkpoint,options){
  return gateAdmission(stages,root,checkpoint,options).blockingInstances.map(instance=>instance.detail);
}

export function gateAdmission(stages,root,checkpoint,{reportStages=null}={}){
  const result={allowed:true,checkpoint,blockingInstances:[],pendingInstances:[],repairStages:[],validatedGeneration:[]};
  function invalid(detail){result.allowed=false;result.blockingInstances.push({gateId:'platform.policy',detail});return result;}
  const policy=readGatePolicy(root);if(!policy||policy.mode!=='skill')return result;
  if(policy.invalid)return invalid('门禁策略无效');
  if(stages.some(s=>s.gates.some(g=>g.id==='platform.policy')))return invalid('策略与当前判据目录不兼容，请显式迁移');
  const target=CHECKPOINTS.indexOf(checkpoint);if(target<0)return invalid('未知检查点');
  for(const r of policy.requirements.filter(r=>r.required!==false&&CHECKPOINTS.indexOf(r.blockingAt)<=target&&(!reportStages||reportStages.includes(r.reportStage)))){
    const g=stages.find(s=>s.id===r.displayStage)?.gates.find(g=>g.id===r.gateId);
    if(g?.reportId)result.validatedGeneration.push({stage:r.reportStage,generation:g.generation,reportId:g.reportId});
    if(g?.status==='pass'||(r.allowNa&&g?.status==='na'&&g.applicability))continue;
    const instance={gateId:r.gateId,instanceKey:`${r.gateId}@${r.definitionVersion}:${policy.scopeKey}`,source:r.source,stage:r.reportStage,
      status:g?.status||'unjudged',requiredNow:true,detail:`${r.gateId}：${g?.detail||'缺少当前判定'}`};
    result.blockingInstances.push(instance);
    if(instance.status==='unjudged')result.pendingInstances.push(instance);
    result.repairStages.push(r.reportStage);
  }
  result.allowed=result.blockingInstances.length===0;
  result.repairStages=[...new Set(result.repairStages)];
  result.validatedGeneration=[...new Map(result.validatedGeneration.map(r=>[r.stage,r])).values()];
  return result;
}

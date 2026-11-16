/** Host-owned facts only: mounts, workflow records and actual adjudications. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {workflowFor} from './workflow.js';
import {verifyMounts,derivedMountName} from './sources.js';
import {parseCsv} from './audit.js';
import {readIssueLedger, readCoverage,RECHECK_ITEMS} from './recheck.js';
import {readVisionLog} from './vision.js';
import {currentProductionReceipt} from './gate-production.js';
import {safePath, applyGateReports, resolveGateResource, projectResourcePath,readGatePolicy,strictJson,collectionMembers,implementationBindings,packageRoot,currentEnvironment,loadStageReport} from './gate-report.js';

function hash(file) {
  if(fs.statSync(file).size>2*1024**3)throw new Error('证据超过内容核验预算');
  const fd=fs.openSync(file,'r'),digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);
  try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null)))digest.update(buffer.subarray(0,count));return digest.digest('hex');}
  finally{fs.closeSync(fd);}
}
function fact(id, status, detail, extra = {}) {
  return {id, label: id, level: 'error', status, detail, source: 'workbench', ...extra};
}
function exists(root, rel) {
  try { const file=safePath(root,rel);return fs.statSync(file).isFile()&&fs.statSync(file).size>0; }
  catch { return false; }
}
function hostCsv(root,relative,required){
  try{
    const file=safePath(root,relative);
    if(fs.statSync(file).size>8*1024*1024)throw Error('host CSV budget');
    const value=parseCsv(fs.readFileSync(file,'utf8'),{strict:true});
    if(required.some(name=>!value.header.includes(name)))throw Error('missing CSV columns');
    return value;
  }catch{return null;}
}

export function adjudicationSnapshot(root, project, {runtime}={}) {
  const files = ['.workbench/gates/policy.json','project.json','docs/scope.md','research_registry.json','output/manuscript.docx','output/manuscript.pdf','output/recheck/issues.jsonl','output/recheck/report.md','output/review/review_pack.md','output/materials/provenance.csv','output/materials/selection.csv','output/audit/vision_log.csv'];
  const external={};
  let implementation,environment,hostImplementation;
  try {
    const skill=packageRoot(project);
    implementation=implementationBindings(skill);
    implementation['contracts/gates/package-manifest.json']=hash(safePath(skill,'contracts/gates/package-manifest.json'));
    environment=runtime||currentEnvironment(skill);
    for(const row of readVisionLog(root))for(const relative of [row.rel_path,row.derived_rel])if(relative)files.push(relative.startsWith('data/')?relative:'data/'+relative);
    const host=path.dirname(fileURLToPath(import.meta.url));
    hostImplementation=Object.fromEntries(fs.readdirSync(host).filter(name=>name.endsWith('.js')).sort().map(name=>[name,hash(safePath(host,name))]));
    const policy=readGatePolicy(root);
    if(!policy||policy.invalid) return null;
    const directory=safePath(root,'output/gates/state');
    if(fs.existsSync(directory))for(const entry of fs.readdirSync(directory).filter(x=>x.endsWith('.json'))){
      const state=strictJson(fs.readFileSync(safePath(root,`output/gates/state/${entry}`),'utf8'));
      if(state.phase!=='completed')return null;
      const gates=loadStageReport(root,project,policy,state.stage,environment);
      if(gates.some(g=>g.validationState!=='valid'))return null;
      const result=strictJson(fs.readFileSync(safePath(root,state.resultPath),'utf8'));
      const report=strictJson(fs.readFileSync(safePath(root,result.reportPath),'utf8'));
      for(const collection of report.collections||[])if(JSON.stringify(collectionMembers(root,collection))!==JSON.stringify(collection.members))return null;
      for(const resource of report.resources||[]){
        if(resource.rootId==='project'&&!resource.path.startsWith('output/gates/'))files.push(resource.path);
        else if(resource.rootId?.startsWith('material:'))external[`${resource.rootId}|${resource.path}`]=hash(resolveGateResource(root,project,resource));
      }
    }
  } catch { return null; }
  const bindings={...external};
  for(const rel of [...new Set(files)].sort()){
    try {const file=projectResourcePath(root,rel);bindings[rel]=fs.existsSync(file)?hash(file):null;}
    catch {return null;}
  }
  const sorted=object=>Object.fromEntries(Object.entries(object).sort(([a],[b])=>a.localeCompare(b)));
  return crypto.createHash('sha256').update(JSON.stringify({bindings:sorted(bindings),implementation:sorted(implementation),hostImplementation,hostRuntime:process.version,environment:{python:environment.python,modules:sorted(environment.modules||{})}})).digest('hex');
}

export function evaluateHostProject(context) {
  const {projectRoot:root,project,adjudications={},activeRuns={},runs=[],sources=[]}=context;
  let runtime;
  try{runtime=context.gateRuntime||currentEnvironment(packageRoot(project),context.pythonPath||'python');}catch{runtime={python:'unavailable',modules:{}};}
  const snapshot=adjudicationSnapshot(root,project,{runtime});
  const workflow=workflowFor(project);
  const hostFacts=[];
  const stages=workflow.stages.map(def=>({...def,gates:[],status:activeRuns[def.id]?'running':'todo',
    lastRun:runs.filter(r=>r.stageId===def.id).sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)))[0]||null}));
  const addHostFacts=(...facts)=>hostFacts.push(...facts);
  addHostFacts(fact('scope-doc',exists(root,'docs/scope.md')?'pass':'unjudged','研究范围文档必须存在且非空'));
  const mounts=project.materials?.mounts||[];
  try {
    const report=verifyMounts(root,{mounts});
    addHostFacts(fact('sources-mounted',report.every(r=>r.status==='ok')?'pass':'fail','核对实际挂载目标',{mounts:report}));
    const inside=mounts.filter(m=>{
      const source=sources.find(s=>s.id===m.sourceId);
      if(!source)return true;
      const rel=path.relative(path.resolve(root),path.resolve(source.path,m.entry||''));
      return !rel.startsWith('..')&&!path.isAbsolute(rel);
    });
    addHostFacts(fact('sources-outside',inside.length?'fail':'pass','原件挂载必须位于项目产出之外'));
  } catch {addHostFacts(fact('sources-mounted','unjudged','挂载无法读取'),fact('sources-outside','unjudged','挂载目标无法确认'));}
  const selection=hostCsv(root,'output/materials/selection.csv',['source_id','path_in_source','include','reason_code']);
  const provenance=hostCsv(root,'output/materials/provenance.csv',['rel_path','mount','source_id']);
  let selectionValid=Boolean(selection?.rows.length),provenanceValid=Boolean(provenance?.rows.length);
  const selectionIds=new Set();
  for(const row of selection?.rows||[]){
    try{
      const source=sources.find(s=>s.id===row.source_id),key=JSON.stringify([row.source_id,row.path_in_source]);
      const included=mounts.some(m=>m.sourceId===row.source_id&&(!m.entry||row.path_in_source===m.entry||row.path_in_source.startsWith(m.entry+'/')));
      if(!source||!row.reason_code?.trim()||selectionIds.has(key)||!['yes','no'].includes(row.include)||(row.include==='yes')!==included||!fs.statSync(safePath(source.path,row.path_in_source)).isFile())selectionValid=false;
      selectionIds.add(key);
    }catch{selectionValid=false;}
  }
  for(const row of provenance?.rows||[]){
    const mount=mounts.find(m=>m.sourceId===row.source_id&&(m.as===row.mount||derivedMountName(m)===row.mount));
    try{if(!mount||!row.rel_path.startsWith(row.mount+'/')||!fs.statSync(projectResourcePath(root,'data/'+row.rel_path)).isFile())provenanceValid=false;}catch{provenanceValid=false;}
  }
  for(const [id,rel,rows,valid] of [['materials-provenance','output/materials/provenance.csv',provenance,provenanceValid],['materials-selection','output/materials/selection.csv',selection,selectionValid]]){
    addHostFacts(fact(id,!mounts.length?'na':!rows?'unjudged':valid?'pass':'fail',!mounts.length?'没有外部挂载，不需要挂载登记':'按当前挂载、来源身份和实际文件核对登记',{...(mounts.length?{}:{applicability:{rule:'no-external-mounts'}}),sourcePath:rel}));
  }
  let covered='unjudged';
  if(!mounts.length)covered='na';
  else if(selection?.rows.length&&provenance?.rows.length){
    const expected=new Set(selection.rows.filter(r=>r.include==='yes').map(r=>`${r.source_id}|${r.path_in_source}`));
    const actual=new Set();let invalid=!selectionValid||!provenanceValid;
    for(const row of provenance.rows){
      if(row.derived_from||row.channel==='junk')continue;
      const mount=mounts.find(m=>m.as===row.mount&&m.sourceId===row.source_id);
      if(!mount){invalid=true;continue;}
      const prefix=`${row.mount}/`;
      if(!row.rel_path?.startsWith(prefix)){invalid=true;continue;}
      const sourceRel=[mount.entry,row.rel_path.slice(prefix.length)].filter(Boolean).join('/');
      actual.add(`${row.source_id}|${sourceRel}`);
    }
    covered=!invalid&&actual.size===expected.size&&[...expected].every(x=>actual.has(x))?'pass':'fail';
  }
  addHostFacts(fact('materials-provenance-cover',covered,!mounts.length?'没有外部挂载':'按当前挂载身份核对选材与来源集合',{...(!mounts.length?{applicability:{rule:'no-external-mounts'}}:{})}));
  const declared=Object.values(project.stages||{}).flatMap(s=>Array.isArray(s.outputs)?s.outputs:[]);
  addHostFacts(fact('artifacts-declared',!declared.length?'unjudged':declared.every(p=>exists(root,p))?'pass':'fail','核对项目明确声明的输出文件',{level:'warn'}));
  const visionTable=hostCsv(root,'output/audit/vision_log.csv',['rel_path','input_sha256','status','human_verified']);
  const visionFile=exists(root,'output/audit/vision_log.csv');
  const vision=visionTable?[...new Map(readVisionLog(root).map(row=>[JSON.stringify([row.rel_path,row.page]),row])).values()]:[];
  const visionCurrent=vision.every(r=>{
    if(!r.human_verified||!r.input_sha256||!r.source_sha256||!r.derived_sha256||!r.derived_rel||r.status!=='ok')return false;
    try{
      const rel=r.rel_path.startsWith('data/')?r.rel_path:`data/${r.rel_path}`;
      const derived=r.derived_rel.startsWith('data/')?r.derived_rel:`data/${r.derived_rel}`;
      return hash(projectResourcePath(root,rel))===r.source_sha256&&hash(projectResourcePath(root,derived))===r.derived_sha256;
    }catch{return false;}
  });
  const hasVisionDerivatives=provenance?.rows.some(row=>row.channel==='vision');
  const visionStatus=visionFile&&!visionTable?'unjudged':!vision.length?(hasVisionDerivatives?'unjudged':'na'):visionCurrent?'pass':'unjudged';
  addHostFacts(fact('qa-vision',visionStatus,visionStatus==='na'?'没有识图派生记录':'识图复核须绑定当前原件、渲染页和识别稿',{...(visionStatus==='na'?{applicability:{rule:'no-vision-derivatives'}}:{})}));
  for(const id of ['qa-decisions','qa-signoff']){
    const decision=adjudications[id];
    const valid=snapshot&&decision?.snapshotHash===snapshot;
    addHostFacts(fact(id,valid?decision.status:'unjudged',valid?'已绑定当前证据的裁定':'需要对当前交付快照作真实裁定',{manual:true,snapshotHash:snapshot}));
  }
  let issueStatus='unjudged',issueDetail='问题台账需要有效的逐行记录（明确为空也应保留文件）';
  try{
    const issues=readIssueLedger(root);
    const unresolved=issues.filter(i=>['open','deferred'].includes(i.status));
    issueStatus=unresolved.some(i=>i.severity==='error')?'fail':unresolved.length?'unjudged':'pass';
    issueDetail='当前问题台账中未关闭或暂缓的问题';
  }catch(error){issueDetail=error.message;}
  addHostFacts(fact('recheck-issues',issueStatus,issueDetail));
  addHostFacts(fact('recheck-report',exists(root,'output/recheck/report.md')?'pass':'unjudged','当前复核报告必须存在且非空'));
  for(const s of stages){
    const receipt=path.join(root,'output/gates/production',`${s.id}.json`);
    let known=false;
    try{const r=JSON.parse(fs.readFileSync(receipt,'utf8'));known=r.status==='completed'&&r.runId===s.lastRun?.id;}catch{}
    s.gates.push(fact('stage-source',known?'pass':'unjudged',known?'已关联宿主生产运行':'没有绑定当前宿主运行的生产回执',{level:'info'}));
  }
  const hostDefinitions=strictJson(fs.readFileSync(safePath(workflow.root,'contracts/gates/catalog.json'),'utf8')).gates;
  function assignHostFacts(){
    for(const requirement of hostDefinitions){
      if(requirement.owner!=='workbench')continue;
      const destination=stages.find(s=>s.id===requirement.displayStage);
      if(!destination)throw Error('工作流缺少策略要求的显示阶段：'+requirement.displayStage);
      const owned=hostFacts.find(f=>f.id===requirement.id);
      if(owned){destination.gates=destination.gates.filter(g=>g.id!==owned.id);destination.gates.push(owned);}
    }
  }
  assignHostFacts();
  applyGateReports(stages,{...context,gateRuntime:runtime});
  const all=stages.flatMap(s=>s.gates);
  const policy=readGatePolicy(root);
  const mapping={R1:['provenance-cells'],R2:['dataset-in-analysis'],R3:['stats-fit-n'],R4:['fig-fresh'],R5:['recheck.caption-n-consistent'],R6:['recheck.caption-n-present'],R7:['qa-numbers'],R9:['qa-report','qa-fresh'],R10:['manuscript-figures'],R11:['qa-fresh']};
  const machine=Object.entries(mapping).map(([id,ids])=>{
    const gates=ids.map(gid=>all.find(g=>g.id===gid));
    const status=gates.some(g=>g?.status==='fail')?'fail':gates.every(g=>g?.status==='pass'||(g?.status==='na'&&g.applicability&&policy?.requirements.some(r=>r.gateId===g.id&&r.allowNa)))?'pass':'unjudged';
    return {id,status,detail:ids.join(', ')};
  });
  const coverage=readCoverage(root);
  const reviewed=coverage?.R8;
  machine.push({id:'R8',status:snapshot&&reviewed?.status==='checked'&&Boolean(reviewed.note?.trim())&&reviewed.snapshotHash===snapshot?'pass':'unjudged',detail:'项目代码需要实际阅读并绑定当前快照'});
  const complete=Boolean(snapshot)&&Array.from({length:12},(_,i)=>`R${i+1}`).every(id=>coverage?.[id]?.status==='checked'&&Boolean(coverage[id].note?.trim())&&coverage[id].snapshotHash===snapshot);
  machine.push({id:'R12',status:complete&&machine.every(c=>c.status==='pass')?'pass':'unjudged',detail:'当前快照的十二项覆盖记录完整且不能覆盖机器事实'});
  for(const check of machine)check.label=RECHECK_ITEMS.find(item=>item.id===check.id)?.label||check.id;
  const state=machine.some(c=>c.status==='fail')?'fail':machine.every(c=>c.status==='pass')?'pass':'unjudged';
  addHostFacts(fact('recheck-machine',state,'复用当前技能事实及真实代码复核',{checks:machine}));
  addHostFacts(fact('recheck-coverage',complete&&state==='pass'?'pass':'unjudged','覆盖记录不能覆盖机器事实，也不能继承旧快照'));
  assignHostFacts();
  for(const s of stages){
    if(activeRuns[s.id])continue;
    const assessed=s.gates.filter(g=>g.level!=='info');
    if(assessed.some(g=>g.status==='fail'&&g.level==='error'))s.status='blocked';
    else if(assessed.some(g=>g.status==='unjudged'))s.status='review';
    else s.status=assessed.length&&assessed.every(g=>g.status==='na')?'na':'done';
    if(!assessed.length){
      const outputs=s.artifacts||[];
      let current=false;
      current=outputs.length>0&&currentProductionReceipt(root,{stage:s.id,runId:s.lastRun?.id,workflow,requiredOutputs:outputs,environment:runtime}).ok;
      s.status=current?'done':s.lastRun?.status==='failed'?'blocked':s.lastRun?'review':'todo';
    }
    if(s.status!=='na'&&!s.lastRun&&!(s.artifacts||[]).some(rel=>exists(root,rel))&&!s.gates.some(g=>g.manual&&g.status==='pass'))s.status='todo';
  }
  // Labels share the catalog with skill facts; host ids are never UI copy.
  try{
    const catalog=strictJson(fs.readFileSync(safePath(workflow.root,'contracts/gates/catalog.json'),'utf8'));
    const labels=new Map(catalog.gates.map(g=>[g.id,g.label]));
    for(const s of stages)for(const g of s.gates)if(g.source==='workbench')g.label=labels.get(g.id)||g.label;
  }catch{/* applyGateReports has already surfaced an invalid policy/catalog. */}
  return stages;
}

/** Bind the files actually available to a stage before its foreground steps. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {safePath, projectResourcePath,strictJson,implementationBindings,collectionMembers} from './gate-report.js';

function canonical(value){
  function ordered(item){
    if(Array.isArray(item))return item.map(ordered);
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,ordered(entry)]));
    return item;
  }
  return JSON.stringify(ordered(value));
}

function hash(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const result = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) result.update(buffer.subarray(0, length));
    return result.digest('hex');
  } finally { fs.closeSync(fd); }
}

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function outputIdentity(file){
  if(!fs.existsSync(file))return null;
  const stat=fs.statSync(file,{bigint:true});
  if(!stat.isFile())return null;
  return canonical({sha256:hash(file),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs),ino:String(stat.ino)});
}

export function productionReceipt(root, stage, runId, steps,{environment=null,workflow=null}={}) {
  const bound = new Map(), collections = new Map();
  const outputPaths=new Map(steps.flatMap(s=>s.produces||[]).map(relative=>[safePath(root,relative),relative]));
  const outputs = new Set(outputPaths.keys());
  const succeededOutputs=new Set(),implementation=new Map(),failedSteps=[],unproducedOutputs=new Set();
  const previousOutputs=new Map([...outputs].map(file=>[file,outputIdentity(file)]));
  for(const step of steps){
    const script=step.scriptAbs||step.argv?.[0];
    if(!script||!path.isAbsolute(script)||!fs.existsSync(script))continue;
    implementation.set(script,{path:script,sha256:hash(script)});
    const manifest=path.resolve(path.dirname(script),'../contracts/gates/package-manifest.json');
    if(fs.existsSync(manifest))implementation.set(manifest,{path:manifest,sha256:hash(manifest)});
  }
  if(workflow?.root){
    for(const relative of ['contracts/workflow/workflow.json','contracts/workflow/workflow.schema.json','contracts/gates/package-manifest.json']){
      const file=safePath(workflow.root,relative);implementation.set(file,{path:file,sha256:hash(file)});
    }
  }
  const outputRoots = ['output', 'runs', '.git', '.workbench'];
  function add(file) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const absolute = projectResourcePath(root, rel);
    if (!fs.statSync(absolute).isFile() || outputs.has(absolute)) return;
    if (fs.statSync(absolute).size > 2 * 1024 ** 3) throw new Error('输入超过内容核验预算');
    bound.set(rel, {path: rel, sha256: hash(absolute)});
  }
  function scan(relative) {
    const directory = projectResourcePath(root, relative), members = [], seen=new Set();
    if (!fs.existsSync(directory)) return;
    function walk(dir) {
      const actual=fs.realpathSync(dir);if(seen.has(actual))throw new Error('资料目录存在循环引用');seen.add(actual);
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const file = path.join(dir, entry.name);
        projectResourcePath(root,path.relative(root,file).replace(/\\/g,'/'));
        if (fs.statSync(file).isDirectory()) walk(file);
        else if (fs.statSync(file).isFile()) { members.push(path.relative(root, file).replace(/\\/g, '/')); add(file); }
      }
    }
    walk(directory);
    collections.set(relative, {basePath: relative, members: members.sort()});
  }
  // Root configuration and source/code folders form a conservative boundary.
  // Prior-stage output inputs are also bound from the actual argv below.
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    if (outputRoots.includes(entry.name) || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) scan(entry.name);
    else if (entry.isFile()) add(path.join(root, entry.name));
  }
  const excluded = new Set(['--out','--out-dir','--out-pdf','--out-docx','--figure-map','--log']);
  for (const step of steps) {
    for (let i = 1; i < step.argv.length; i++) {
      if (excluded.has(step.argv[i-1]) || String(step.argv[i]).startsWith('-')) continue;
      const file = path.resolve(root, String(step.argv[i]));
      const rel = path.relative(root, file);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file) || outputs.has(file)) continue;
      if (fs.statSync(file).isFile()) add(file);
      else if (!outputRoots.includes(rel.replace(/\\/g, '/'))) scan(rel.replace(/\\/g, '/'));
    }
  }
  const receipt = {schema:'dsa.production-receipt/1', stage, runId, status:'running',environment,
    workflow:workflow?{id:workflow.id,version:workflow.version,sha256:workflow.sha256}:null,
    inputs:[...bound.values()], collections:[...collections.values()],implementation:[...implementation.values()],failedSteps,
    packageImplementation:workflow?.root?implementationBindings(workflow.root):null,
    outputs:[], startedAt:new Date().toISOString()};
  const file = safePath(root, `output/gates/production/${stage}.json`);
  atomic(file, receipt);
  return {
    stepFinished(step,code){
      if(code===0)for(const output of step.produces||[]){
        const file=safePath(root,output),identity=outputIdentity(file);
        if(identity&&identity!==previousOutputs.get(file)){succeededOutputs.add(file);unproducedOutputs.delete(output);}
        else if(!succeededOutputs.has(file))unproducedOutputs.add(output);
      }
      else failedSteps.push(step.script||'foreground-step');
    },
    finish(status) {
      const changed = receipt.inputs.filter(r => !fs.existsSync(projectResourcePath(root, r.path)) || hash(projectResourcePath(root, r.path)) !== r.sha256).map(r => r.path);
      const finalOutputs = [];
      for (const absolute of succeededOutputs) {
        if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
          const rel = outputPaths.get(absolute);
          finalOutputs.push({path:rel, sha256:hash(safePath(root, rel))});
        }
      }
      receipt.outputs = finalOutputs;
      const changedCode=receipt.implementation.filter(r=>!fs.existsSync(r.path)||hash(r.path)!==r.sha256).map(r=>r.path);
      let packageChanged=false;
      try{packageChanged=Boolean(workflow?.root)&&canonical(implementationBindings(workflow.root))!==canonical(receipt.packageImplementation);}catch{packageChanged=true;}
      receipt.status = status === 'ok' && !changed.length && !changedCode.length && !packageChanged && !failedSteps.length && !unproducedOutputs.size && finalOutputs.length===succeededOutputs.size ? 'completed' : 'failed';
      receipt.unproducedOutputs=[...unproducedOutputs];
      receipt.changedPackageImplementation=packageChanged;
      receipt.changedImplementation=changedCode;
      receipt.changedInputs = changed;
      receipt.finishedAt = new Date().toISOString();
      atomic(file, receipt);
      return receipt;
    },
  };
}

/** Validate the actual run, including imported package code, before using its output. */
export function currentProductionReceipt(root,{stage,runId,workflow,requiredOutputs=[],environment}={}){
  try{
    const file=safePath(root,`output/gates/production/${stage}.json`);
    const receipt=strictJson(fs.readFileSync(file,'utf8'));
    if(receipt.status!=='completed'||receipt.runId!==runId||receipt.workflow?.sha256!==workflow?.sha256)throw Error('生产回执不属于本次有效运行');
    if(environment&&canonical(receipt.environment)!==canonical(environment))throw Error('生产环境已变化');
    if(!Array.isArray(receipt.inputs)||!Array.isArray(receipt.outputs)||!Array.isArray(receipt.implementation)||!Array.isArray(receipt.collections))throw Error('生产回执结构无效');
    if(requiredOutputs.some(rel=>!receipt.outputs.some(item=>item.path===rel)))throw Error('本次运行未生成声明的产物');
    for(const item of receipt.outputs)if(hash(safePath(root,item.path))!==item.sha256)throw Error('产物内容已变化');
    for(const item of receipt.inputs)if(hash(projectResourcePath(root,item.path))!==item.sha256)throw Error('生产输入已变化');
    for(const item of receipt.implementation)if(hash(item.path)!==item.sha256)throw Error('生产实现已变化');
    if(workflow?.root&&(!receipt.packageImplementation||canonical(implementationBindings(workflow.root))!==canonical(receipt.packageImplementation)))throw Error('技能包实现已变化');
    for(const collection of receipt.collections)if(canonical(collectionMembers(root,{...collection,rootId:'project',complete:true,selector:{recursive:true}}))!==canonical(collection.members))throw Error('生产输入集合已变化');
    return {ok:true,receipt};
  }catch(error){return {ok:false,error:String(error.message||error)};}
}

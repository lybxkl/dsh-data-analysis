/** Explicit agent entry. Read-only status never calls this function. */
import fs from 'node:fs';
import path from 'node:path';
import {projectId,readProject} from './projects.js';
import {workflowFor} from './workflow.js';

function same(a,b){
  const left=path.resolve(a),right=path.resolve(b);
  return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
}
function directory(value){
  const raw=String(value||'').trim();
  if(!raw)return '';
  if(!path.isAbsolute(raw))throw Error('请提供绝对目录路径，避免在错误的工作区创建项目');
  const resolved=path.resolve(raw);
  if(fs.existsSync(resolved)&&!fs.statSync(resolved).isDirectory())throw Error('指定路径不是目录');
  return resolved;
}
function researchProject(project){return Boolean(project&&(project.schemaVersion||project.contract?.version||project.skill?.root||project.stages&&typeof project.stages==='object'));}
function chooseProject(workspace,workbench,sessionId){
  const root=readProject(workspace);
  if(root.ok&&researchProject(root.project))return workspace;
  if(root.ok)throw Error('该目录的 project.json 不是工作台项目，请指定一个独立的项目空目录');
  if(fs.existsSync(path.join(workspace,'project.json')))throw Error(root.error);
  if(same(workspace,path.parse(workspace).root))throw Error('当前工作目录是磁盘根目录，请明确指定研究项目目录');
  const stem=workspace+'-实证研究';
  for(let suffix=1;suffix<=100;suffix++){
    const candidate=suffix===1?stem:stem+'-'+suffix;
    if(!fs.existsSync(candidate))return candidate;
    if(!fs.statSync(candidate).isDirectory())continue;
    const existing=readProject(candidate);
    if(existing.ok&&existing.project.origin?.kind==='workbench-bootstrap'&&existing.project.origin.workspace&&same(existing.project.origin.workspace,workspace)){
      const owner=Object.entries(workbench.sessionBindings()).find(([id,pid])=>id!==sessionId&&pid===projectId(candidate));
      if(!owner)return candidate;
    }
    if(fs.readdirSync(candidate).length===0)return candidate;
  }
  throw Error('工作目录旁已有过多同名项目，请明确指定一个项目目录');
}

export function startWorkbench(workbench,{sessionId,workspaceDir='',projectDir='',name='',switchProject=false}={}){
  const id=String(sessionId||'').trim();
  if(!id)return {ok:false,code:'SESSION_REQUIRED',error:'无法识别当前对话，未创建项目。请从 DSH 会话调用启动工具'};
  try{
    if(workbench.sessionIsDelegated(id))return {ok:false,code:'MAIN_SESSION_REQUIRED',error:'请由主对话启动并关联工作台，子代理不创建或抢占研究对话'};
    const explicit=directory(projectDir);
    const requestedWorkspace=directory(workspaceDir);
    const bound=workbench.sessionBinding(id);
    const boundRead=bound?readProject(bound.project.path):null;
    const sameWorkspace=bound&&requestedWorkspace&&(same(requestedWorkspace,bound.project.path)||boundRead?.ok&&boundRead.project.origin?.workspace&&same(requestedWorkspace,boundRead.project.origin.workspace));
    const reusing=bound&&(explicit?same(explicit,bound.project.path):!requestedWorkspace||sameWorkspace);
    if(reusing){
      const read=readProject(bound.project.path);
      if(!read.ok)return {ok:false,code:'BOUND_PROJECT_UNAVAILABLE',error:read.error};
      const workflow=workflowFor(read.project,workbench.getConfig().skillRoot);
      return {ok:true,already:true,created:false,armed:true,project:bound.project,workflow:{id:workflow.id,version:workflow.version,sha256:workflow.sha256},text:`本对话已关联工作台：${bound.project.name}\n项目：${bound.project.path}\n直接读取 data_analysis_status 的任务卡，再做它写的下一步。`};
    }
    if(bound&&switchProject!==true)return {ok:false,code:'SESSION_BOUND_ELSEWHERE',error:`本对话已关联 ${bound.project.path}；仅在用户明确要求切换项目时使用 switchProject=true`};
    if(!bound&&workbench.sessionBindings()[id]&&switchProject!==true)return {ok:false,code:'BOUND_PROJECT_UNAVAILABLE',error:'关联项目已不在台账中；明确重建关联时使用 switchProject=true'};
    if(bound&&(Object.keys(workbench.runner.activeFor(bound.projectId)).length||workbench.gateChecks.has(bound.projectId)))return {ok:false,code:'PROJECT_BUSY',error:'本对话的原项目仍有生产或体检任务，请先完成或停止任务再切换'};
    const workspace=requestedWorkspace||(!explicit?directory(workbench.sessionCwd(id)):'');
    if(!explicit&&!workspace)return {ok:false,code:'DIRECTORY_REQUIRED',error:'没有取得当前对话的工作目录，请提供 workspaceDir 或 projectDir；无需先到面板关联'};
    if(workspace&&!fs.existsSync(workspace))return {ok:false,code:'WORKSPACE_NOT_FOUND',error:'工作目录不存在，未创建项目：'+workspace};
    const target=explicit||chooseProject(workspace,workbench,id);
    const skill=workbench.skill();
    if(!skill.ok)return {ok:false,code:'SKILL_UNAVAILABLE',error:'技能包尚未就绪：'+skill.reason};
    // Validate before touching either a project or its session association.
    const read=readProject(target);
    if(read.ok&&!researchProject(read.project))return {ok:false,code:'PROJECT_INVALID',error:'目标 project.json 不是工作台项目，未改变项目与对话关联'};
    const workflow=workflowFor(read.ok?read.project:{},skill.packageDir);
    if(Object.keys(workbench.runner.activeFor(projectId(target))).length||workbench.gateChecks.has(projectId(target))||fs.existsSync(path.join(target,'output/gates/publication.lock')))
      return {ok:false,code:'PROJECT_BUSY',error:'目标项目正在生产、体检或等待锁恢复，未改变对话关联'};
    if(!read.ok&&fs.existsSync(path.join(target,'project.json')))return {ok:false,code:'PROJECT_INVALID',error:read.error};
    const owner=Object.entries(workbench.sessionBindings()).find(([other,pid])=>other!==id&&pid===projectId(target));
    if(owner&&switchProject!==true)return {ok:false,code:'PROJECT_BOUND_ELSEWHERE',error:'该项目已关联另一条研究对话；明确继续该项目时使用 switchProject=true，或指定新的 projectDir'};
    let created=false;
    if(read.ok){
      const result=workbench.openProject(target);
      if(!result.ok)return result;
    }else{
      const result=workbench.createProject(target,name||path.basename(workspace||target),null,{kind:'workbench-bootstrap',workspace:workspace||target});
      if(!result.ok)return {...result,code:'PROJECT_CREATE_FAILED',projectDir:target};
      created=true;
    }
    const linked=workbench.bindSessionTo(id,projectId(target),{force:switchProject===true});
    if(!linked.ok)return {...linked,created,projectDir:target};
    const project=linked.project;
    return {ok:true,already:false,created,armed:true,project,workflow:{id:workflow.id,version:workflow.version,sha256:workflow.sha256},
      text:`工作台已${created?'创建':'打开'}并关联本对话。\n项目：${project.path}\n工作流：${workflow.id} ${workflow.version}\n下一步：读取 data_analysis_status 的任务卡，用 data_analysis_materials 登记并挂载资料。初始化已完成，研究阶段尚未执行。`};
  }catch(error){return {ok:false,code:'START_FAILED',error:String(error.message||error)};}
}

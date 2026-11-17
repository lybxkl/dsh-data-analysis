/**
 * 子进程运行器。
 *
 * 只做三件事：起进程、把输出落盘、如实记录退出状态。
 * 插件不解析 stdout 下结论——结论来自产物，进程退出码只是"跑没跑完"的证据。
 *
 * 一个 run 可以由多步组成（终检就是 qa_outputs + verify_numbers）：
 * 顺序执行，日志合并进同一个文件，任何一步非零且未标 continueOnError 就停。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULT_PYTHON } from './defaults.js';
import { productionReceipt } from './gate-production.js';
import {currentEnvironment} from './gate-report.js';
import {resolveSkillRoot} from './skill.js';

const LIVE = new Map();
const STEP_KEYS = ['script', 'args', 'continueOnError', 'whenFile', 'produces'];

function nowIso() {
  return new Date().toISOString();
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `run-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export class Runner {
  constructor({ getConfig, store, onChange }) {
    this.getConfig = getConfig;
    this.store = store;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.onFinish = () => {};
  }

  /**
   * 宿主重启后，上一进程里的「running」记录已经没有子进程了。
   * 不修正的话，界面会永远显示"运行中"，也没法重跑。
   */
  reconcile() {
    const state = this.store.get();
    const runs = state.runs || [];
    let changed = 0;
    for (const run of runs) {
      if (run.status !== 'running') continue;
      run.status = 'interrupted';
      run.endedAt = run.endedAt || run.startedAt || nowIso();
      run.exitCode = null;
      run.signal = null;
      run.error = '宿主重启，进程已不在；本次运行按中断处理';
      changed += 1;
    }
    if (changed) this.store.set({ runs });
    return changed;
  }

  listLive() {
    return [...LIVE.values()].map((live) => this.summary(live));
  }

  /**
   * 运行中对象的对外视图：只给白名单字段。
   * 直接把 live 摊出去会把 child / stream / decoder 也塞进 API 响应，
   * JSON.stringify 遇到 fs.WriteStream 会抛错——「看日志」在跑着的时候直接 500。
   */
  summary(live) {
    return {
      id: live.id,
      stageId: live.stageId,
      projectId: live.projectId,
      projectRoot: live.projectRoot,
      startedAt: live.startedAt,
      logFile: live.logFile,
      command: live.command,
      logLines: live.logLines ? live.logLines.slice(-400) : [],
      cancelRequested: Boolean(live.cancelRequested),
      status: 'running',
      endedAt: null,
      exitCode: null,
      signal: null,
      alive: Boolean(live.child) && live.child.exitCode === null,
    };
  }

  getRun(id) {
    const live = LIVE.get(id);
    if (live) {
      // 运行中的记录还没结算：以台账里的那条（含 steps 状态）为底，补上「正在跑」的事实
      const stored = (this.store.get().runs || []).find((run) => run.id === id) || {};
      return { ...stored, ...this.summary(live), steps: stored.steps || [] };
    }
    const settled = (this.store.get().runs || []).find((run) => run.id === id);
    // 结算后的记录也带上 alive=false：调用方只要读这一个字段就能判断「还在不在跑」
    return settled ? { ...settled, alive: false } : null;
  }

  /** 某个项目某个阶段是否已有进程在跑。 */
  activeFor(projectId) {
    const map = {};
    for (const live of LIVE.values()) {
      if (!live.child || live.child.exitCode !== null) continue;
      if (live.projectId !== projectId) continue;
      map[live.stageId] = this.summary(live);
    }
    return map;
  }

  /**
   * steps: [{ script, argv, continueOnError }]
   * argv 已经展开成绝对脚本路径 + 参数。
   */
  start({ project, stageId, steps, projectLease = null, workflow=null, actionId='' }) {
    const config = this.getConfig();
    const projectRoot = project.path;
    const python = config.pythonPath || DEFAULT_PYTHON;
    const list = (Array.isArray(steps) ? steps : []).filter((step) => step && Array.isArray(step.argv) && step.argv.length);
    if (!list.length) return null;

    const id = runId();
    let environment=null;
    if(projectLease||actionId){try{const skill=workflow?.root?{ok:true,packageDir:workflow.root}:resolveSkillRoot(config.skillRoot);if(skill.ok)environment=currentEnvironment(skill.packageDir,python);}catch{}}
    const gateProduction = projectLease||actionId ? productionReceipt(projectRoot, stageId, id, list,{environment,workflow}) : null;
    const logDir = path.join(projectRoot, 'runs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${id}.log`);
    const stream = fs.createWriteStream(logFile, { flags: 'a' });

    const startedAt = nowIso();
    const run = {
      id,
      stageId,
      actionId,
      workflow:workflow?{id:workflow.id,version:workflow.version,sha256:workflow.sha256}:null,
      script: list[0].script || '',
      projectId: project.id,
      projectRoot,
      command: [python, ...list[0].argv],
      status: 'running',
      startedAt,
      endedAt: null,
      exitCode: null,
      signal: null,
      logFile: path.relative(projectRoot, logFile).replace(/\\/g, '/'),
      logLines: [],
      cancelRequested: false,
      steps: list.map((step) => ({ script: step.script || '', status: 'pending', exitCode: null, whenFile: step.whenFile || '' })),
    };

    const live = {
      id,
      stageId,
      projectId: project.id,
      projectRoot,
      startedAt,
      logFile: run.logFile,
      child: null,
      python,
      steps: list,
      command: run.command,
      index: -1,
      executed: 0,
      cancelRequested: false,
      logLines: [],
      decoder: null,
      decoderErr: null,
      stream,
      projectLease,
      gateProduction,
    };
    LIVE.set(id, live);
    this.pushRun(run);
    this.next(live, 0);
    return this.getRun(id);
  }

  next(live, index) {
    if (live.cancelRequested) {
      this.finish(live, { exitCode: null, signal: null, status: 'cancelled', stepIndex: index });
      return;
    }
    if (index >= live.steps.length) {
      // 全部步骤都因 whenFile 缺失被跳过：这不是「跑成功」，要说清楚。
      this.finish(live, { exitCode: 0, signal: null, status: live.executed ? 'ok' : 'skipped', stepIndex: index });
      return;
    }
    const step = live.steps[index];
    // 条件步骤在**执行到这一步时**才判断：同一阶段里前一步刚生成的产物
    //（例如 assemble_manuscript 写的 figure_map.json）才能被后一步看见。
    // 以前在阶段启动前统一判断，首次组稿永远跳过 export_pdf_hires。
    if (step.whenFile) {
      const gateAbs = path.isAbsolute(String(step.whenFile))
        ? String(step.whenFile)
        : path.join(live.projectRoot, String(step.whenFile));
      if (!fs.existsSync(gateAbs)) {
        this.appendLog(live, `[跳过] 缺 ${step.whenFile}：按条件不执行这一步\n`);
        this.markStep(live, index, { status: 'skipped', exitCode: null, whenFile: step.whenFile });
        this.next(live, index + 1);
        return;
      }
    }
    const argv = step.argv;
    live.index = index;
    live.executed = (live.executed || 0) + 1;
    live.decoder = new StringDecoder('utf8');
    live.decoderErr = new StringDecoder('utf8');
    this.appendLog(live, `第 ${index + 1}/${(live.steps || []).length || '?'} 步\n`);
    this.appendLog(live, `${index ? '\n' : ''}$ ${[live.python, ...argv].join(' ')}\n`);

    let child;
    try {
      child = spawn(live.python, argv, {
        cwd: live.projectRoot,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE:'1', PYTHONUNBUFFERED: '1' },
        windowsHide: true,
      });
    } catch (error) {
      this.appendLog(live, `[spawn error] ${error.message}\n`);
      this.finish(live, { exitCode: null, signal: null, status: 'failed', error: error.message, stepIndex: index });
      return;
    }

    live.child = child;
    let processError='';
    const stop=()=>{
      try{
        if(process.platform==='win32'&&child.pid){
          const killer=spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
          killer.on('error',()=>child.kill());
        }else child.kill('SIGTERM');
      }catch(error){this.appendLog(live,`[stop error] ${error.message}\n`);}
    };
    if(child.pid&&live.projectLease){try{live.projectLease.registerChild(child.pid);}catch(error){processError=error.message;stop();}}
    const maxLines = Math.max(100, Number(this.getConfig().maxLogLines) || 800);

    const pump = (chunk, decoder) => {
      const text = decoder.write(chunk);
      if (!text) return;
      live.stream?.write(text);
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        live.logLines.push(line);
        if (live.logLines.length > maxLines) live.logLines.splice(0, live.logLines.length - maxLines);
      }
      this.onChange({ kind: 'log', runId: live.id, text });
    };
    child.stdout?.on('data', (chunk) => pump(chunk, live.decoder));
    child.stderr?.on('data', (chunk) => pump(chunk, live.decoderErr));

    child.on('error', (error) => {
      const hint = error?.code === 'ENOENT'
        ? (process.platform === 'win32'
          ? `\n[提示] 找不到 Python 命令「${live.python}」：在设置里填 python.exe 的绝对路径。\n`
          : `\n[提示] 找不到 Python 命令「${live.python}」：macOS 上通常要写 python3 或它的绝对路径。\n`)
        : '';
      this.appendLog(live, `\n[spawn error] ${error.message}${hint}\n`);
      processError=error.message;
    });

    child.on('close', (code, signal) => {
      if(child.pid&&live.projectLease){try{live.projectLease.childClosed(child.pid);}catch(error){processError=error.message;}}
      if (live.decoder) {
        const tail = live.decoder.end();
        if (tail) live.stream?.write(tail);
      }
      if (live.decoderErr) {
        const tail = live.decoderErr.end();
        if (tail) live.stream?.write(tail);
      }
        this.markStep(live, index, { status: live.cancelRequested ? 'cancelled' : code === 0&&!processError ? 'ok' : 'failed', exitCode: live.cancelRequested||processError ? null : code });
        try{live.gateProduction?.stepFinished(step,live.cancelRequested||processError?null:code);}catch(error){processError=error.message;}
      live.child = null;
        if(processError){
          this.finish(live,{exitCode:null,signal:signal||null,status:'failed',error:processError,stepIndex:index});
          return;
        }
      if (live.cancelRequested) {
        this.appendLog(live, `\n[已取消 · signal=${signal || 'none'}]\n`);
        // 取消是用户动作，不是进程失败：不能把 taskkill 的退出码 1 记成「失败」的证据
        this.finish(live, { exitCode: null, signal: signal || null, status: 'cancelled', stepIndex: index });
        return;
      }
      this.appendLog(live, `\n[退出码 ${code}${signal ? ` · signal=${signal}` : ''}]\n`);
      if (code === 0 || step.continueOnError) {
        this.next(live, index + 1);
        return;
      }
      this.finish(live, { exitCode: code, signal: signal || null, status: 'failed', stepIndex: index });
    });
  }

  markStep(live, index, patch) {
    const state = this.store.get();
    const runs = (state.runs || []).slice();
    const at = runs.findIndex((item) => item.id === live.id);
    if (at < 0) return;
    const steps = Array.isArray(runs[at].steps) ? runs[at].steps.slice() : [];
    steps[index] = { ...(steps[index] || {}), ...patch };
    runs[at] = { ...runs[at], steps };
    this.store.set({ runs });
  }

  appendLog(live, text) {
    // 命令、退出码这类「我们自己写的」行也要落进日志文件，否则事后只剩脚本输出
    try {
      live.stream?.write(text);
    } catch {
      /* ignore */
    }
    live.logLines = live.logLines || [];
    live.logLines.push(...String(text).split(/\r?\n/).filter(Boolean));
  }

  finish(live, { exitCode, signal, status, error, stepIndex }) {
    // spawn 的 'error' 与 'close' 可能都触发（ENOENT 就是如此）：只允许结算一次
    if (live.finished) return;
    live.finished = true;
    if (live.gateProduction) {
      try { live.gateProduction.finish(status); }
      catch (bindingError) { status = 'failed'; error = '生产输入或产物绑定失败'; }
    }
    const endedAt = nowIso();
    const record = {
      status,
      endedAt,
      exitCode,
      signal,
      error,
      logLines: live.logLines ? live.logLines.slice(-400) : [],
    };
    const store = this.store;
    const state = store.get();
    const runs = state.runs.slice();
    const at = runs.findIndex((run) => run.id === live.id);
    if (at >= 0) {
      const steps = Array.isArray(runs[at].steps) ? runs[at].steps.slice() : [];
      if (Number.isInteger(stepIndex) && stepIndex < steps.length && status !== 'ok') {
        steps[stepIndex] = { ...(steps[stepIndex] || {}), status: status === 'cancelled' ? 'cancelled' : 'failed' };
      }
      runs[at] = { ...runs[at], ...record, steps };
    } else {
      runs.push({ id: live.id, stageId: live.stageId, projectId: live.projectId, logFile: live.logFile, projectRoot: live.projectRoot, command: [], startedAt: live.startedAt, steps: [], ...record });
    }
    const maxRuns = Math.max(10, Number(this.getConfig().maxRuns) || 60);
    state.runs = runs.slice(-maxRuns);
    store.set({ runs: state.runs });
    try {
      live.stream?.end();
    } catch {
      /* ignore */
    }
    LIVE.delete(live.id);
    this.onChange({ kind: 'run', runId: live.id, status });
    const settled = state.runs.find((run) => run.id === live.id) || null;
    try {
      Promise.resolve(this.onFinish(settled || { id: live.id, stageId: live.stageId, projectId: live.projectId, status, exitCode, error }))
        .catch(failure=>this.onChange({kind:'run-finalization-error',runId:live.id,error:String(failure?.message||failure)}));
    } catch {
      /* 收尾回调不能影响运行记录本身 */
    }
  }

  pushRun(run) {
    const state = this.store.get();
    const maxRuns = Math.max(10, Number(this.getConfig().maxRuns) || 60);
    const runs = [...state.runs.filter((item) => item.id !== run.id), { ...run, logLines: [] }];
    this.store.set({ runs: runs.slice(-maxRuns) });
  }

  cancel(id) {
    const live = LIVE.get(id);
    if (!live || !live.child || live.child.exitCode !== null) return { ok: false, reason: '该运行已结束或不存在' };
    live.cancelRequested = true;
    if (process.platform === 'win32' && live.child.pid) {
      // Windows 上子进程常再开 python 孙进程，必须整棵树杀
      spawn('taskkill', ['/pid', String(live.child.pid), '/t', '/f'], { windowsHide: true });
    } else {
      live.child.kill('SIGTERM');
    }
    this.onChange({ kind: 'log', runId: id, text: '\n[取消请求已发出]\n' });
    return { ok: true };
  }

  cancelStage(projectId, stageId) {
    const cancelled = [];
    for (const live of LIVE.values()) {
      if (live.projectId === projectId && live.stageId === stageId) {
        if (this.cancel(live.id).ok) cancelled.push(live.id);
      }
    }
    return cancelled;
  }

  logTail(id, limit = 200) {
    const live = LIVE.get(id);
    if (live) return (live.logLines || []).slice(-limit);
    const run = (this.store.get().runs || []).find((item) => item.id === id);
    return run?.logLines ? run.logLines.slice(-limit) : [];
  }

  /** 插件卸载/宿主退出时把还活着的子进程收掉，别留下孤儿 python。 */
  killAll() {
    for (const live of LIVE.values()) {
      if (!live.child || live.child.exitCode !== null) continue;
      live.cancelRequested = true;
      try {
        if (process.platform === 'win32' && live.child.pid) {
          spawn('taskkill', ['/pid', String(live.child.pid), '/t', '/f'], { windowsHide: true });
        } else {
          live.child.kill('SIGTERM');
        }
      } catch {
        /* ignore */
      }
    }
  }
}

export { STEP_KEYS };

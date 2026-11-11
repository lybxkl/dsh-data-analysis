/**
 * 工作台服务层：面板、工具、路由共用这一份逻辑。
 *
 * 一切「状态」都从磁盘现算：project.json + 产物文件 + 台账。
 * 不缓存判定结果，避免面板显示的是上一轮的旧绿灯。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  SKILL_CANDIDATES,
  SKILL_PACKAGE,
  STAGE_DEFS,
  STAGE_BY_ID,
  normalizeConfig,
  resolveArgs,
} from './defaults.js';
import { evaluateProject, summarizeStages, gateTotals } from './gates.js';
import { createProject, projectId, readProject, writeProject, runsDir } from './projects.js';
import { fingerprint, isInside, resolveSkillRoot, scriptPath, listScripts } from './skill.js';
import { scanArtifacts } from './audit.js';
import { runPreflight } from './preflight.js';
import { buildTaskCard } from './taskcard.js';
import { applyPatch, buildEvidence, readIssues, recheckSummary, writeIssues } from './recheck.js';

const EMPTY_SKILL = { ok: false, reason: '未配置 skillRoot', root: '', packageDir: '', version: '', sha256: '', scripts: [] };

export class Workbench {
  constructor({ getConfig, store, runner, onChange }) {
    this.getConfig = getConfig;
    this.store = store;
    this.runner = runner;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.skillCache = null;
    this.skillCacheKey = '';
    this.preflightState = { value: null, at: 0, promise: null };
  }

  /* ------------------------------ 技能包 ------------------------------ */

  skill() {
    const config = this.getConfig();
    const root = config.skillRoot || '';
    const resolved = resolveSkillRoot(root);

    if (!resolved.ok) {
      const tried = (resolved.tried || []).slice(0, 3).join('；');
      const reason = resolved.configured
        ? `配置的 skillRoot 无效（试过：${tried || root}）；请检查路径，或清空配置改用默认候选目录`
        : `没找到 ${SKILL_PACKAGE}（试过：${tried || '无'}）`;
      const key = `none|${root}|${tried}`;
      if (this.skillCacheKey !== key) {
        this.skillCache = { ...EMPTY_SKILL, reason, root };
        this.skillCacheKey = key;
      }
      return this.skillCache;
    }

    // 缓存键带上 SKILL.md 的 mtime/size：skill 升级后立即失效，不用重启面板
    let stamp = '';
    try {
      const st = fs.statSync(path.join(resolved.packageDir, 'SKILL.md'));
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = 'missing';
    }
    const cacheKey = `${resolved.packageDir}|${stamp}`;
    if (this.skillCache && this.skillCacheKey === cacheKey) return this.skillCache;

    let info = null;
    try {
      info = fingerprint(resolved);
    } catch (error) {
      info = { ok: false, note: `无法读取 SKILL.md：${error?.message || error}` };
    }
    if (!info?.ok) {
      this.skillCache = { ...EMPTY_SKILL, reason: info?.note || '读取失败', root: resolved.root, packageDir: resolved.packageDir };
      this.skillCacheKey = cacheKey;
      return this.skillCache;
    }
    this.skillCache = {
      ok: true,
      root: resolved.root,
      packageDir: resolved.packageDir,
      layout: resolved.layout,
      version: info.version || '',
      sha256: info.sha256,
      size: info.size,
      files: info.files,
      scripts: listScripts(resolved).map((item) => item.name),
      pythonWanted: this.getConfig().pythonPath,
    };
    this.skillCacheKey = cacheKey;
    return this.skillCache;
  }

  invalidateSkill() {
    this.skillCache = null;
  }

  /* ------------------------------ 启动自检 ------------------------------ */

  /** 面板/工具读这份摘要是同步的：还没查过就是 pending，不假装通过。 */
  preflightSummary() {
    const value = this.preflightState.value;
    if (!value) {
      return { status: 'pending', ok: null, checkedAt: '', python: '', checks: [] };
    }
    return value;
  }

  /**
   * 跑一次自检（带缓存）。并发调用共用同一个 promise，避免面板一刷新就起好几个 python。
   * force=true 时忽略缓存重跑。
   */
  async ensurePreflight({ force = false, maxAgeMs = 5 * 60 * 1000 } = {}) {
    const state = this.preflightState;
    if (!force && state.value && Date.now() - state.at < maxAgeMs) return state.value;
    if (!force && state.promise) return state.promise;
    const config = this.getConfig();
    state.promise = runPreflight({ skillRoot: config.skillRoot, pythonPath: config.pythonPath })
      .then((value) => {
        state.value = value;
        state.at = Date.now();
        return value;
      })
      .catch((error) => {
        const value = {
          status: 'unjudged',
          ok: null,
          checkedAt: new Date().toISOString(),
          python: '',
          checks: [
            {
              id: 'preflight',
              label: '启动自检',
              status: 'unjudged',
              detail: `自检本身失败：${error?.message || error}`,
              hint: '重试一次；仍然失败请查看宿主日志',
            },
          ],
        };
        state.value = value;
        state.at = Date.now();
        return value;
      })
      .finally(() => {
        state.promise = null;
      });
    return state.promise;
  }

  invalidatePreflight() {
    this.preflightState.value = null;
    this.preflightState.at = 0;
  }

  /* ------------------------------- 项目 ------------------------------- */

  projects() {
    const state = this.store.get();
    const list = [];
    for (const item of state.projects || []) {
      const read = readProject(item.path);
      list.push({
        id: item.id,
        path: item.path,
        name: item.name || (read.ok ? read.project.name : path.basename(item.path)),
        openedAt: item.openedAt,
        exists: read.ok,
        error: read.ok ? '' : read.error,
      });
    }
    return list;
  }

  remember(projectRoot, project) {
    const id = projectId(projectRoot);
    const state = this.store.get();
    const previous = (state.projects || []).find((item) => item.id === id);
    const projects = state.projects.filter((item) => item.id !== id);
    const entry = {
      id,
      path: projectRoot,
      name: project?.name || path.basename(projectRoot),
      openedAt: new Date().toISOString(),
    };
    // 会话绑定跟着项目走：重新打开项目不该丢掉「研究对话」的会话
    if (previous?.sessionId) entry.sessionId = previous.sessionId;
    projects.unshift(entry);
    this.store.set({
      projects: projects.slice(0, 20),
      activeProjectId: id,
      activeProjectPath: projectRoot,
    });
    return id;
  }

  /** 台账里的项目条目：项目元数据在 project.json，会话 id 等宿主状态在台账。 */
  ledgerProject(id) {
    const state = this.store.get();
    return (state.projects || []).find((item) => item.id === id) || null;
  }

  /**
   * 把面板里建好的 DSH 会话绑到当前项目。
   * 只记 sessionId，不校验会话是否存在——会话由 client 侧持有，宿主这里不猜测。
   */
  bindSession(sessionId) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const next = String(sessionId || '').trim();
    const state = this.store.get();
    const projects = (state.projects || []).map((item) =>
      item.id === active.id ? { ...item, sessionId: next } : item
    );
    this.store.set({ projects });
    this.onChange({ kind: 'session', projectId: active.id, sessionId: next });
    return { ok: true, sessionId: next, projectId: active.id };
  }

  /** 生成某阶段的任务卡（供面板投递到原生会话）。 */
  taskCard(stageId) {
    const stage = this.stageById(stageId);
    if (!stage) return { ok: false, error: `未知阶段：${stageId}` };
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };

    const artifacts = scanArtifacts(active.path);
    const stages = evaluateProject({
      projectRoot: active.path,
      project: active.project,
      artifacts,
      adjudications: this.adjudicationsFor(active.id),
      activeRuns: this.runner.activeFor(active.id),
      runs: this.recentRuns(200, active.id),
    });
    const evaluated = stages.find((item) => item.id === stage.id) || stage;
    // 评估结果只带判定，不带登记表里的「期望产物」；任务卡要后者
    const cardStage = { ...evaluated, artifacts: stage.artifacts || evaluated.artifacts || [] };

    const commands = [];
    const command = this.commandFor(active.path, active.project, stage);
    if (command.ok) for (const step of command.steps) commands.push({ display: step.display, continueOnError: step.continueOnError });

    const ledger = this.ledgerProject(active.id);
    const card = buildTaskCard({
      project: active.project,
      projectRoot: active.path,
      stage: cardStage,
      stages,
      commands,
      sessionId: ledger?.sessionId || '',
      // 卡片文案要区分「工作台能替你跑」和「只能在工作台外跑」：
      // 上一轮会话被卡片里的「在工作台外直接运行」误导，绕过台账跑脚本，产物来源无法追溯。
      scriptRegistered: Boolean(active.project?.stages?.[stage.id]?.script),
    });
    if (!card.ok) return card;
    return { ok: true, stageId: stage.id, stageName: stage.name, text: card.text, commands: commands.map((item) => item.display) };
  }

  active() {
    const state = this.store.get();
    let root = state.activeProjectPath || '';
    if (!root) {
      const last = (state.projects || [])[0];
      root = last ? last.path : '';
    }
    if (!root) return { ok: false, error: '还没有打开项目' };
    const read = readProject(root);
    if (!read.ok) return { ok: false, error: `${root}：${read.error}`, path: root };
    return { ok: true, path: root, project: read.project, id: projectId(root) };
  }

  openProject(dir) {
    const raw = String(dir || '').trim();
    if (!raw) return { ok: false, error: '请给出项目目录' };
    const root = path.resolve(raw);
    const read = readProject(root);
    if (!read.ok) return { ok: false, error: read.error, path: root };
    this.invalidateSkill();
    this.remember(root, read.project);
    this.onChange({ kind: 'project', path: root });
    return { ok: true, path: root, project: read.project, id: projectId(root) };
  }

  createProject(dir, name, scope) {
    const skill = this.skill();
    const result = createProject({ dir, name, scope, skill: skill.ok ? skill : null });
    if (!result.ok) return result;
    this.remember(result.root, result.project);
    this.onChange({ kind: 'project', path: result.root });
    return result;
  }

  closeProject() {
    this.store.set({ activeProjectId: '', activeProjectPath: '' });
    this.onChange({ kind: 'project', path: '' });
    return { ok: true };
  }

  adjudicationsFor(id) {
    const state = this.store.get();
    const all = state.adjudications?.[id] || {};
    return all;
  }

  /* ------------------------------ 状态快照 ------------------------------ */

  snapshot() {
    const config = this.getConfig();
    const skill = this.skill();
    const active = this.active();
    const projects = this.projects();
    if (!active.ok) {
      return {
        config: this.publicConfig(config),
        skill: this.publicSkill(skill),
        python: config.pythonPath,
        projects,
        active: null,
        error: active.error,
        preflight: this.preflightSummary(),
        stages: [],
        summary: { done: 0, blocked: 0, review: 0, todo: 9, running: 0 },
        totals: { pass: 0, fail: 0, unjudged: 0 },
        artifacts: null,
        runs: this.recentRuns(8),
        adjudications: {},
      };
    }

    const artifacts = scanArtifacts(active.path);
    const adjudications = this.adjudicationsFor(active.id);
    const activeRuns = this.runner.activeFor(active.id);
    const stages = evaluateProject({
      projectRoot: active.path,
      project: active.project,
      artifacts,
      adjudications,
      activeRuns,
      runs: this.recentRuns(200, active.id),
    });
    const summary = summarizeStages(stages);
    const totals = gateTotals(stages);

    return {
      config: this.publicConfig(config),
      skill: this.publicSkill(skill),
      python: config.pythonPath,
      projects,
      active: {
        id: active.id,
        path: active.path,
        name: active.project.name,
        createdAt: active.project.createdAt,
        updatedAt: active.project.updatedAt,
        scope: active.project.scope,
        skillPin: active.project.skill,
        sessionId: this.ledgerProject(active.id)?.sessionId || '',
        skillDrift: Boolean(skill.ok && active.project.skill?.sha256 && active.project.skill.sha256 !== skill.sha256),
      },
      error: '',
      preflight: this.preflightSummary(),
      stages,
      summary,
      totals,
      artifacts: this.publicArtifacts(artifacts),
      runs: this.recentRuns(12, active.id),
      adjudications,
      activeRuns,
    };
  }

  /** 原生对话里的徽章每 8–10 秒轮询一次：只回摘要，不搬图表清单与产物明细。 */
  summary() {
    const active = this.active();
    if (!active.ok) return { ok: true, active: null, summary: null, totals: null, next: null, running: false };
    const artifacts = scanArtifacts(active.path);
    const stages = evaluateProject({
      projectRoot: active.path,
      project: active.project,
      artifacts,
      adjudications: this.adjudicationsFor(active.id),
      activeRuns: this.runner.activeFor(active.id),
      runs: this.recentRuns(200, active.id),
    });
    const next = stages.find((item) => item.status !== 'done') || null;
    return {
      ok: true,
      active: {
        id: active.id,
        name: active.project.name,
        path: active.path,
        sessionId: this.ledgerProject(active.id)?.sessionId || '',
      },
      summary: summarizeStages(stages),
      totals: gateTotals(stages),
      next: next
        ? { id: next.id, index: next.index, name: next.name, status: next.status, script: next.script || null, args: next.args || [] }
        : null,
      running: Object.keys(this.runner.activeFor(active.id)).length > 0,
    };
  }

  publicConfig(config) {
    return {
      skillRoot: config.skillRoot,
      dataDir: config.dataDir,
      pythonPath: config.pythonPath,
      maxRuns: config.maxRuns,
      maxLogLines: config.maxLogLines,
      modelMode: config.modelMode,
      modelProvider: config.modelProvider,
      modelId: config.modelId,
      assistantMaxTokens: config.assistantMaxTokens,
    };
  }

  publicSkill(skill) {
    return {
      ok: skill.ok,
      reason: skill.reason || '',
      root: skill.root || '',
      packageDir: skill.packageDir || '',
      version: skill.version || '',
      sha256: skill.sha256 || '',
      scripts: (skill.scripts || []).slice(0, 60),
    };
  }

  /** 面板只需要摘要，不搬整个 CSV。 */
  publicArtifacts(artifacts) {
    return {
      flow: artifacts.flow,
      corpus: artifacts.corpus,
      figures: {
        file: artifacts.figures.file,
        total: artifacts.figures.rows.length,
        summary: artifacts.figures.summary,
        rows: artifacts.figures.rows.slice(0, 60),
      },
      models: artifacts.models.models,
      flowChecks: artifacts.models.flowChecks,
      verify: artifacts.verify
        ? {
            file: artifacts.verify.file,
            rows: artifacts.verify.rows,
            counts: artifacts.verify.counts,
            issues: (artifacts.verify.sample || []).slice(0, 8),
          }
        : null,
      qa: {
        count: artifacts.qa.length,
        reports: artifacts.qa.slice(0, 4).map((entry) => {
          const json = entry.json || {};
          return {
            name: entry.name,
            errors: Number(json.error_count ?? json.summary?.error_count ?? NaN),
            warnings: Number(json.warning_count ?? json.summary?.warning_count ?? 0),
            mtimeMs: entry.mtimeMs || 0,
          };
        }),
      },
      analysis: artifacts.analysis,
      manuscript: artifacts.manuscript.exists ? artifacts.manuscript.size : 0,
      analysisCsv: artifacts.analysisCsv.exists ? artifacts.analysisCsv.size : 0,
      tables: artifacts.tables,
    };
  }

  recentRuns(limit, forProjectId) {
    const state = this.store.get();
    const pool = (state.runs || []).filter((run) => !forProjectId || run.projectId === forProjectId);
    return pool
      .slice(-Math.max(1, limit))
      .reverse()
      .map((run) => ({
        id: run.id,
        stageId: run.stageId,
        projectId: run.projectId,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        exitCode: run.exitCode,
        signal: run.signal || null,
        logFile: run.logFile,
        error: run.error || '',
      }));
  }

  /* ------------------------------- 运行 ------------------------------- */

  stageById(stageId) {
    return STAGE_BY_ID.get(stageId) || null;
  }

  /**
   * 把项目里的 stage 覆盖与 skill 路径合成可执行的步骤列表。
   * 一个阶段可以是多步（终检 = qa_outputs + verify_numbers），顺序执行、日志合并。
   */
  commandFor(projectRoot, project, stage) {
    const override = project?.stages?.[stage.id] || {};
    const python = this.getConfig().pythonPath || 'python';
    const skill = this.skill();

    const spec = [];
    const stageSteps = Array.isArray(stage.steps) ? stage.steps : null;
    const sameArgs = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
    const customized = override.script !== undefined || Array.isArray(override.args);
    const untouched = !customized || (override.script === undefined || override.script === stage.script) && sameArgs(override.args, stage.args);
    if (Array.isArray(override.steps)) {
      for (const step of override.steps) spec.push(step);
    } else if (stageSteps && untouched) {
      // 阶段本身是多步（终检），项目里没改过它 → 按默认的多步跑
      for (const step of stageSteps) spec.push(step);
    } else {
      spec.push({ script: override.script === undefined ? stage.script : override.script, args: Array.isArray(override.args) ? override.args : stage.args });
    }

    const steps = [];
    for (const item of spec) {
      const scriptRel = item?.script;
      if (!scriptRel) return { ok: false, error: `${stage.name} 没有登记脚本：这一步由人/模型完成，面板只做验收`, steps: [] };

      const localScript = path.resolve(projectRoot, scriptRel);
      let scriptAbs = '';
      if (fs.existsSync(localScript) && isInside(projectRoot, localScript)) scriptAbs = localScript;
      else if (skill.ok) scriptAbs = scriptPath({ ok: true, packageDir: skill.packageDir }, scriptRel) || '';
      if (!scriptAbs || !fs.existsSync(scriptAbs)) {
        return { ok: false, error: `脚本不存在：${scriptRel}（既不在项目里，也不在 skill 包里）`, steps: [] };
      }

      const args = Array.isArray(item.args) ? item.args : [];
      // 宽表规范位置是 output/dataset/analysis.csv；旧项目仍在 data/ 时自动回退，
      // 不让「升级插件」等于「旧项目立刻跑不动」。
      const resolved = resolveArgs(args, { dataDir: 'data', outputDir: 'output', root: projectRoot }).map((arg) => {
        if (arg !== 'output/dataset/analysis.csv') return arg;
        if (fs.existsSync(path.join(projectRoot, arg))) return arg;
        return fs.existsSync(path.join(projectRoot, 'data', 'analysis.csv')) ? 'data/analysis.csv' : arg;
      });
      steps.push({
        script: scriptRel,
        scriptAbs,
        argv: [scriptAbs, ...resolved],
        display: [python, scriptAbs, ...resolved].join(' '),
        continueOnError: item.continueOnError === true,
      });
    }

    if (!steps.length) return { ok: false, error: `${stage.name} 没有可执行的命令`, steps: [] };
    return { ok: true, steps, script: steps[0].script, display: steps.map((item) => item.display).join('  &&  ') };
  }

  /** 前置闸门：前面阶段不许留着 blocked / 未裁定的人工项。 */
  blockers(projectRoot, project, stageId, adjudications) {
    const artifacts = scanArtifacts(projectRoot);
    const stages = evaluateProject({
      projectRoot,
      project,
      artifacts,
      adjudications,
      activeRuns: this.runner.activeFor(projectId(projectRoot)),
      runs: this.recentRuns(200, projectId(projectRoot)),
    });
    const index = stages.findIndex((item) => item.id === stageId);
    const reasons = [];
    for (let i = 0; i < index; i += 1) {
      const stage = stages[i];
      if (stage.status === 'blocked') {
        const failed = stage.gates.filter((g) => g.status === 'fail' && g.level === 'error');
        reasons.push(`${stage.name}：${failed.map((g) => g.label).join('、')} 未通过`);
      }
      const manual = stage.gates.filter((g) => g.manual && g.status === 'unjudged');
      if (manual.length) reasons.push(`${stage.name}：${manual.map((g) => g.label).join('、')} 待人工裁定`);
    }
    return reasons;
  }

  runStage(stageId, { force = false } = {}) {
    const stage = this.stageById(stageId);
    if (!stage) return { ok: false, error: `未知阶段：${stageId}` };
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };

    const live = this.runner.activeFor(active.id);
    if (live[stageId]) {
      return { ok: false, error: `${stage.name} 已有运行在跑（${live[stageId].id}），先等它结束或取消` };
    }

    const command = this.commandFor(active.path, active.project, stage);
    if (!command.ok) return { ok: false, error: command.error };

    if (!force) {
      const reasons = this.blockers(active.path, active.project, stageId, this.adjudicationsFor(active.id));
      if (reasons.length) {
        return {
          ok: false,
          error: `前置阶段未过：${reasons.join('；')}。确需跳过请显式 force。`,
          blockers: reasons,
        };
      }
    }

    const run = this.runner.start({
      project: { id: active.id, path: active.path },
      stageId,
      steps: command.steps,
    });
    this.onChange({ kind: 'run-start', runId: run.id, stageId });
    return { ok: true, run, command: command.display };
  }

  cancelStage(stageId) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const cancelled = this.runner.cancelStage(active.id, stageId);
    if (!cancelled.length) return { ok: false, error: '当前没有在跑的进程' };
    return { ok: true, cancelled };
  }

  runLog(runId, limit = 200) {
    const lines = this.runner.logTail(runId, limit);
    const run = this.runner.getRun(runId);
    return { ok: Boolean(run), run, lines };
  }

  /* ------------------------------- 裁定 ------------------------------- */

  adjudicate({ stageId, gateId, status, note }) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const allowed = new Set(['pass', 'fail', 'unjudged']);
    if (!allowed.has(status)) return { ok: false, error: '人工裁定只能是 pass / fail / unjudged' };
    const stage = this.stageById(stageId);
    if (!stage) return { ok: false, error: `未知阶段：${stageId}` };

    // 机器能判的事实不许被裁定改写：只有标了「人工」的闸门才接受人给结论
    const snap = this.snapshot();
    const evaluated = (snap.stages || []).find((item) => item.id === stageId);
    const gate = evaluated?.gates?.find((item) => item.id === gateId);
    if (!gate) return { ok: false, error: `阶段 ${stageId} 上没有闸门 ${gateId}` };
    if (!gate.manual) {
      return { ok: false, error: `闸门 ${gateId} 由脚本判定，不能被人工裁定改写（只有「人工」闸门可以）` };
    }

    const state = this.store.get();
    const all = { ...(state.adjudications || {}) };
    const mine = { ...(all[active.id] || {}) };
    if (status === 'unjudged') delete mine[gateId];
    else mine[gateId] = { status, note: String(note || ''), at: new Date().toISOString(), stageId };
    all[active.id] = mine;
    this.store.set({ adjudications: all });
    this.onChange({ kind: 'adjudicate', stageId, gateId, status });
    return { ok: true, adjudications: mine };
  }

  /* ----------------------------- 复核与修订 ----------------------------- */

  /** 机器复算 + 问题清单 + 覆盖表：复核页要的都在这里。 */
  recheckState() {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const runs = this.recentRuns(200, active.id);
    const state = recheckSummary(active.path, { project: active.project, runs });
    return {
      ok: true,
      projectId: active.id,
      checks: state.checks,
      issues: state.issues,
      coverage: state.coverage,
      openErrors: state.openErrors,
      openOthers: state.openOthers,
      report: state.report,
      chain: this.chainStatus(),
    };
  }

  /** 证据包：模型只读它，不给整份语料。 */
  recheckEvidence() {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const runs = this.recentRuns(200, active.id);
    const state = recheckSummary(active.path, { project: active.project, runs });
    const evidence = buildEvidence(active.path, {
      project: active.project,
      runs,
      checks: state.checks,
      issues: state.issues,
    });
    return { ok: true, projectId: active.id, chars: evidence.length, evidence };
  }

  /** 模型审计交上来的一条问题：只写清单，不改产物。 */
  recordIssue(issue) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const issues = readIssues(active.path);
    const at = issues.findIndex((item) => item.id === issue.id);
    if (at >= 0) issues[at] = { ...issues[at], ...issue, updatedAt: new Date().toISOString() };
    else issues.push(issue);
    writeIssues(active.path, issues);
    this.onChange({ kind: 'recheck-issue-record', id: issue.id });
    return { ok: true, issue: at >= 0 ? issues[at] : issue, total: issues.length };
  }

  /** 人给问题定状态：open → fixed / wontfix / deferred。 */
  updateIssue({ id, status, note }) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const allowed = new Set(['open', 'fixed', 'wontfix', 'deferred']);
    if (!allowed.has(status)) return { ok: false, error: '问题状态只能是 open / fixed / wontfix / deferred' };
    const issues = readIssues(active.path);
    const at = issues.findIndex((issue) => issue.id === id);
    if (at < 0) return { ok: false, error: `没有这条问题：${id}` };
    issues[at] = { ...issues[at], status, note: String(note ?? issues[at].note ?? ''), updatedAt: new Date().toISOString() };
    writeIssues(active.path, issues);
    this.onChange({ kind: 'recheck-issue', id, status });
    return { ok: true, issue: issues[at] };
  }

  /**
   * 套用一条补丁并（可选）重跑受影响的下游阶段。
   * 这是闭环的关键：模型只提案，人点「套用」，机器重跑，闸门重新判。
   */
  applyIssue(id, { advance = true } = {}) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const chain = this.chainStatus();
    if (chain && chain.status === 'running') return { ok: false, error: '上一轮重跑还没结束，先等它跑完或取消' };
    const issues = readIssues(active.path);
    const at = issues.findIndex((issue) => issue.id === id);
    if (at < 0) return { ok: false, error: `没有这条问题：${id}` };
    const issue = issues[at];
    if (issue.status !== 'open') return { ok: false, error: `这条问题状态是 ${issue.status}，只有 open 的可以套用` };
    const applied = applyPatch(active.path, issue);
    if (!applied.ok) return applied;
    issues[at] = {
      ...issue,
      status: 'fixed',
      appliedAt: new Date().toISOString(),
      appliedHash: applied.hash,
      backup: applied.backup,
    };
    writeIssues(active.path, issues);
    this.onChange({ kind: 'recheck-apply', id, file: applied.file });

    const steps = advance ? this.downstreamStages(issue.patch?.path || '') : [];
    if (!steps.length) return { ok: true, file: applied.file, backup: applied.backup, chain: null, note: '补丁已应用；该文件不影响下游阶段，未触发重跑' };
    this.startChain(active.id, steps, id);
    return { ok: true, file: applied.file, backup: applied.backup, chain: this.chainStatus() };
  }

  /** 改哪个层级的文件，就从哪个阶段开始重跑（保守：数据变了就全链重跑）。 */
  downstreamStages(file) {
    const rel = String(file).replace(/\\/g, '/');
    if (/^(data\/|scripts\/|output\/(coding|audit)\/)/.test(rel)) return ['coding', 'dataset', 'stats', 'figures', 'manuscript', 'qa'];
    if (/^output\/(models|tables)\//.test(rel)) return ['stats', 'figures', 'manuscript', 'qa'];
    if (/^(model_spec\.json|chart_config\.json)$/.test(rel)) return ['stats', 'figures', 'manuscript', 'qa'];
    if (/^output\/chart_pack\//.test(rel)) return ['figures', 'manuscript', 'qa'];
    if (/^(output\/manuscript|manuscript\.json)/.test(rel)) return ['manuscript', 'qa'];
    if (/^(output\/qa|output\/verify)\//.test(rel)) return ['qa'];
    return [];
  }

  startChain(projectIdValue, steps, issueId) {
    const state = this.store.get();
    const chains = { ...(state.recheckChains || {}) };
    chains[projectIdValue] = {
      id: `chain-${Date.now().toString(36)}`,
      steps,
      index: 0,
      status: 'running',
      issueId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: '',
    };
    this.store.set({ recheckChains: chains });
    this.store.flushSoon();
    this.beginChainStep();
  }

  beginChainStep() {
    const chain = this.chainStatus();
    if (!chain || chain.status !== 'running') return;
    if (chain.index >= chain.steps.length) {
      this.patchChain({ status: 'done', index: chain.steps.length });
      return;
    }
    const stageId = chain.steps[chain.index];
    const result = this.runStage(stageId, { force: true });
    if (!result.ok) {
      this.patchChain({ status: 'stopped', error: `${stageId} 无法启动：${result.error}` });
    }
  }

  /** 由 runner 在每次运行结束时回调。 */
  onRunFinished(run) {
    const chain = this.chainStatus();
    if (!chain || chain.status !== 'running') return;
    if (run.projectId && chain.projectId && run.projectId !== chain.projectId) return;
    const expected = chain.steps[chain.index];
    if (run.stageId !== expected) return;
    if (run.status === 'ok') {
      this.patchChain({ index: chain.index + 1 });
    } else {
      // 退出码非 0 不等于阶段失败：verify_numbers 找到问题就 exit 2，但那属于「待裁定」。
      // 以阶段闸门为准——只有真的被 error 级闸门拦住，才终止重跑链。
      const stageState = (this.snapshot().stages || []).find((stage) => stage.id === run.stageId);
      if (!stageState || stageState.status === 'blocked') {
        this.patchChain({
          status: 'stopped',
          error: `${expected} 运行${run.status === 'cancelled' ? '被取消' : '被闸门拦住'}（退出码 ${run.exitCode ?? '—'}）`,
        });
        return;
      }
      this.patchChain({
        index: chain.index + 1,
        note: `${expected} 退出码 ${run.exitCode ?? '—'}，但闸门只有待裁定项，继续`,
      });
    }
    const next = this.chainStatus();
    if (next && next.status === 'running') {
      // 让当前 finish 先落盘，再起下一步
      setTimeout(() => this.beginChainStep(), 0);
    }
  }

  cancelChain() {
    const chain = this.chainStatus();
    if (!chain || chain.status !== 'running') return { ok: false, error: '没有正在跑的重跑链' };
    this.patchChain({ status: 'cancelled', error: '用户取消' });
    this.cancelStage(chain.steps[chain.index]);
    return { ok: true };
  }

  chainStatus() {
    const active = this.active();
    if (!active.ok) return null;
    const chain = (this.store.get().recheckChains || {})[active.id];
    return chain ? { ...chain, projectId: active.id } : null;
  }

  patchChain(patch) {
    const active = this.active();
    if (!active.ok) return;
    const state = this.store.get();
    const chains = { ...(state.recheckChains || {}) };
    const current = chains[active.id];
    if (!current) return;
    chains[active.id] = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.store.set({ recheckChains: chains });
    this.store.flushSoon();
    this.onChange({ kind: 'recheck-chain', chain: chains[active.id] });
  }

  /* ------------------------------- 设置 ------------------------------- */

  updateConfig(patch = {}) {
    const current = this.getConfig();
    const next = normalizeConfig({ ...current, ...patch });
    this.store.set({ config: next });
    this.invalidateSkill();
    if ('skillRoot' in patch || 'pythonPath' in patch || 'dataDir' in patch) this.invalidatePreflight();
    this.onChange({ kind: 'config' });
    return { ok: true, config: next };
  }
}

export function stageCatalog() {
  return STAGE_DEFS.map((stage) => ({
    id: stage.id,
    index: stage.index,
    name: stage.name,
    short: stage.short,
    purpose: stage.purpose,
    script: stage.script,
    artifacts: stage.artifacts,
  }));
}

export { DEFAULT_CONFIG, runsDir, listScripts };

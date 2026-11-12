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
  DEFAULT_PYTHON,
  SKILL_CANDIDATES,
  SKILL_PACKAGE,
  STAGE_DEFS,
  STAGE_BY_ID,
  normalizeConfig,
  resolveArgs,
} from './defaults.js';
import { evaluateProject, summarizeStages, gateTotals } from './gates.js';
import { createProject, projectId, readProject, writeProject, runsDir } from './projects.js';
import { fingerprint, resolveSkillRoot, resolveStageScript, listScripts } from './skill.js';
import { clearCorpusScan, scanArtifacts } from './audit.js';
import { runPreflight } from './preflight.js';
import { buildTaskCard } from './taskcard.js';
import { applyPatch, buildEvidence, fileHash, readIssues, recheckSummary, writeIssues } from './recheck.js';
import {
  addSource as registerSource,
  derivedMountName,
  derivedRoot,
  findSource,
  formatBytes,
  isInside as isInsidePath,
  listDataEntries,
  listSources,
  migrateCopiedEntry,
  mountOne,
  mountPathOf,
  newId,
  readMaterials,
  receiptLine,
  removeSource as dropSource,
  rescanSource,
  safeAlias,
  scanSourceDir,
  unmountOne,
  verifyMounts,
  writeProvenance,
  writeSelection,
} from './sources.js';
import {
  buildPlan as buildVisionPlan,
  derivedInventory,
  markVerified as markVisionVerified,
  visionSummary,
} from './vision.js';
import { isLink, readMountMarker, removeTree } from './platform.js';

const EMPTY_SKILL = { ok: false, reason: '未配置 skillRoot', root: '', packageDir: '', version: '', sha256: '', scripts: [] };

/**
 * 脚本找不到时，把「为什么找不到」说清楚。
 *
 * 谎报「脚本不存在」会把排查引向错误方向：文件明明躺在磁盘上，问题在路径写法。
 * 所以区分两种失败——落在受保护范围之外（读得到，但不准读）与两处都没有这个文件。
 */
function scriptErrorMessage(stage, scriptRel, found, projectRoot, skill) {
  const scope = `项目 ${projectRoot}${skill?.ok ? ` / 技能包 ${skill.packageDir}` : '（技能包未配置）'}`;
  if (found.code === 'outside') {
    return `脚本指向受保护范围之外：${scriptRel}（文件存在，但阶段脚本只能读项目内或技能包内的文件；请把它放进项目的 scripts/ 再按相对路径登记）`;
  }
  return `脚本不存在：${scriptRel}（${scope} 里都没有；阶段脚本请写相对路径，如 scripts/auto_stats.py）`;
}

export class Workbench {
  constructor({ getConfig, store, runner, onChange, materials }) {
    this.getConfig = getConfig;
    this.store = store;
    this.runner = runner;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.skillCache = null;
    this.skillCacheKey = '';
    this.preflightState = { value: null, at: 0, promise: null };
    // 材料库的外部依赖：识图执行器（只被工具显式调用，不做自动流水线）+ 派生缓存目录
    this.materials = materials || null;
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
      // 重新打开/新建项目就算「回到工作台」，清掉关闭状态
      meta: { ...(state.meta || {}), detached: false },
    });
    return id;
  }

  /** 台账里的项目条目：项目元数据在 project.json，会话 id 等宿主状态在台账。 */
  ledgerProject(id) {
    const state = this.store.get();
    return (state.projects || []).find((item) => item.id === id) || null;
  }

  /**
   * 从台账里移除一个项目。
   * 只删登记（项目条目、运行记录、裁定、复核链），**磁盘上一个文件都不动**：
   * 用户点「移除」想清掉的是列表里的条目，不是他那份资料。
   * 项目目录是否还存在都不影响——目录没了的条目更需要能删。
   */
  forgetProject(id) {
    const key = String(id || '').trim();
    const state = this.store.get();
    const target = (state.projects || []).find((item) => item.id === key);
    if (!target) return { ok: false, error: '台账里没有这个项目（可能已经被移除）' };

    // 还在跑的阶段先停：否则移除后进程还在往一个没人看的项目里写产物
    let cancelled = 0;
    for (const run of Object.values(this.runner.activeFor(key) || {})) {
      const result = this.runner.cancel(run.id);
      if (result.ok) cancelled += 1;
    }

    const projects = (state.projects || []).filter((item) => item.id !== key);
    const runs = (state.runs || []).filter((run) => run.projectId !== key);
    const adjudications = { ...(state.adjudications || {}) };
    delete adjudications[key];
    const recheckChains = { ...(state.recheckChains || {}) };
    delete recheckChains[key];

    const patch = { projects, runs, adjudications, recheckChains };
    const wasActive = state.activeProjectId === key;
    if (wasActive) {
      // 移除当前项目 = 回到「没选项目」，不要偷偷切到另一个项目让用户以为切错了
      patch.activeProjectId = '';
      patch.activeProjectPath = '';
      patch.meta = { ...(state.meta || {}), detached: true };
    }
    this.store.set(patch);
    clearCorpusScan();

    return {
      ok: true,
      id: key,
      name: target.name || path.basename(target.path),
      path: target.path,
      active: wasActive,
      cancelled,
      removed: { runs: (state.runs || []).length - runs.length },
      diskKept: true,
      state: this.snapshot(),
    };
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
      sources: listSources(this.store),
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
      // 「关闭项目」要真的关掉：否则这里会回退到最近一个项目，界面上报了成功、实际还在原地跑。
      if (state.meta?.detached) return { ok: false, detached: true, error: '还没有打开项目' };
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
    const state = this.store.get();
    this.store.set({
      activeProjectId: '',
      activeProjectPath: '',
      meta: { ...(state.meta || {}), detached: true },
    });
    this.onChange({ kind: 'project', path: '' });
    return { ok: true };
  }

  adjudicationsFor(id) {
    const state = this.store.get();
    const all = state.adjudications?.[id] || {};
    return all;
  }

  /* ------------------------------ 材料库 ------------------------------ */

  materialServices() {
    return this.materials || {};
  }

  /** 派生缓存跟着台账走：换项目不用重算，也不往用户的材料目录里写东西。 */
  cacheDir() {
    const configured = this.materialServices().cacheDir;
    if (configured) return configured;
    const ledger = this.store?.filePath || '';
    // 这是「缓存根」，sources-cache 由 derivedRoot / workDir 自己拼，避免出现 sources-cache\sources-cache
    return ledger ? path.dirname(ledger) : path.join(process.cwd(), '.dsh-data-analysis');
  }

  /** 材料库清单（全局一份）+ 每个源被哪些项目用着。 */
  sources() {
    const projects = this.store.get().projects || [];
    const usedBy = new Map();
    for (const item of projects) {
      const read = readProject(item.path);
      if (!read.ok) continue;
      for (const mount of readMaterials(read.project).mounts) {
        const list = usedBy.get(mount.sourceId) || [];
        list.push({ project: read.project.name || path.basename(item.path), projectPath: item.path, as: mount.as });
        usedBy.set(mount.sourceId, list);
      }
    }
    return listSources(this.store).map((item) => {
      const scan = item.scan || null;
      return {
        id: item.id,
        label: item.label,
        path: item.path,
        note: item.note || '',
        createdAt: item.createdAt,
        exists: fs.existsSync(item.path),
        scan: scan
          ? {
              at: scan.at,
              files: scan.files,
              realFiles: scan.realFiles,
              bytes: scan.bytes,
              bytesText: formatBytes(scan.bytes),
              byChannel: scan.byChannel,
              byExt: scan.byExt,
              entries: (scan.entries || []).slice(0, 80),
              truncated: Boolean(scan.truncated),
              errors: (scan.errors || []).slice(0, 10),
            }
          : null,
        receipt: receiptLine(scan),
        usedBy: usedBy.get(item.id) || [],
      };
    });
  }

  addSource({ label = '', path: rawPath = '', note = '' } = {}) {
    const result = registerSource(this.store, { label, path: rawPath, note });
    if (!result.ok) return result;
    this.onChange({ kind: 'sources' });
    return { ...result, receipt: receiptLine(result.source?.scan), sources: this.sources() };
  }

  rescanSource(id) {
    const result = rescanSource(this.store, id);
    if (!result.ok) return result;
    this.onChange({ kind: 'sources' });
    return { ...result, receipt: receiptLine(result.source?.scan) };
  }

  removeSource(id, { force = false } = {}) {
    const projects = (this.store.get().projects || [])
      .map((item) => {
        const read = readProject(item.path);
        return read.ok ? { path: item.path, name: item.name, project: read.project } : null;
      })
      .filter(Boolean);
    const result = dropSource(this.store, id, { projects, force });
    if (!result.ok) return result;
    this.onChange({ kind: 'sources' });
    return { ...result, sources: this.sources() };
  }

  materialsOf() {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    return { ok: true, active, materials: readMaterials(active.project) };
  }

  saveMaterials(projectRoot, materials) {
    const read = readProject(projectRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const project = { ...read.project, materials: { version: 1, mounts: materials.mounts || [] } };
    writeProject(projectRoot, project);
    return { ok: true, project };
  }

  /** 挂载后的账：联接是否还有效 + 派生稿清单 + data/ 下现在有什么。 */
  mountsState(projectRoot) {
    const read = readProject(projectRoot);
    const materials = read.ok ? readMaterials(read.project) : { mounts: [] };
    const sources = listSources(this.store);
    const cacheDir = this.cacheDir();
    return {
      materials,
      mounts: verifyMounts(projectRoot, materials),
      derived: derivedInventory(materials, sources, cacheDir),
      entries: listDataEntries(projectRoot),
    };
  }

  /** 工具调用可能发生在还没打开项目的时候：给一份空账，别抛错。 */
  mountsStateSafe() {
    const active = this.active();
    if (!active.ok) return { materials: { mounts: [] }, mounts: [], derived: [], entries: [] };
    return this.mountsState(active.path);
  }

  /**
   * 交给会话处理材料时用的交办文案：挂载清单 + 只读约束 + 产物约定。
   * 面板点「让 AI 处理这些材料」→ GET /materials/card → 投进研究对话；
   * 怎么解析由会话决定，这里只把「不能做什么」说清楚。
   */
  materialsCard() {
    const active = this.active();
    if (!active.ok) return { ok: false, error: '还没有打开项目' };
    const state = this.mountsStateSafe();
    const mounts = state.mounts || [];
    if (!mounts.length) return { ok: false, error: '这个项目还没有挂载任何材料目录' };
    const byId = new Map(this.sources().map((item) => [item.id, item]));
    const name = (active.project && active.project.name) || active.path;
    const lines = [];
    lines.push(`[材料读取] 项目「${name}」的资料已经挂到 data/ 下，全程只读。`);
    lines.push('');
    lines.push('挂载（都在项目 data/ 下，指向用户自己的目录，不复制文件）：');
    for (const mount of mounts) {
      const source = byId.get(mount.sourceId);
      const files = Number(source && source.scan && source.scan.files);
      const where = source ? `${source.path}${mount.entry ? ' / ' + mount.entry : ''}` : '（材料源已删除，这条挂载失效）';
      lines.push(`- data/${mount.as} → ${where}${Number.isFinite(files) ? `（${files} 个文件）` : ''}`);
    }
    const derived = state.derived || [];
    if (derived.length) {
      lines.push('');
      lines.push('已有的派生稿（此前的识图/转码产物，未人工核对的不算数）：');
      for (const item of derived) lines.push(`- data/${item.mountName}（${item.files} 份）`);
    }
    lines.push('');
    lines.push('约束：');
    lines.push('1. 只读：不要修改、移动、删除用户原始资料目录里的任何文件；data/ 下这些目录就是指向源目录的挂载，往里写等于改原件。');
    lines.push('2. 派生只走派生目录：需要转写时先跑 data_analysis_vision（action=plan 只数页不花 token，确认后再 action=run），产物会自动落到 data/<挂载名>__识别稿/ 并记账；不要手写到别处。');
    lines.push('3. 不要自己把页图读进上下文：纯文本模型会把图片静默换成占位行，等于白跑一遍；识图交给工作台直连模型。');
    lines.push('4. doc/xls/ppt 下游脚本读不了文本：转换由你或用户在 Office/WPS 里另存为 docx/xlsx/pptx 后重扫材料；工作台不代转。');
    lines.push('5. 处理完重跑 audit：data/ 变了指纹就变，audit-freshness 会拦住后续阶段。');
    lines.push('');
    lines.push('先跑 data_analysis_status 看当前进度，再决定从哪个阶段继续。');
    return { ok: true, text: lines.join('\n'), mounts: mounts.length, project: active.path };
  }

  /** 重写留痕文件：provenance.csv / mounts.json / selection.csv。 */
  refreshMaterials(projectRoot) {
    const read = readProject(projectRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const materials = readMaterials(read.project);
    const sources = listSources(this.store);
    writeProvenance({ projectRoot, materials, sources, cacheDir: this.cacheDir() });
    writeSelection({ projectRoot, materials, sources });
    clearCorpusScan();
    return { ok: true };
  }

  /** 把材料挂到 data/ 下：Windows 用目录联接，macOS/Linux 用镜像目录，都不复制文件。 */
  async mountSource({ sourceId = '', entries = [], as = '' } = {}) {
    const state = this.materialsOf();
    if (!state.ok) return state;
    const { active } = state;
    const source = findSource(this.store, sourceId);
    if (!source) return { ok: false, error: '找不到这个材料源，先把目录登记进材料库' };
    if (!fs.existsSync(source.path)) return { ok: false, error: `材料目录不在了：${source.path}` };
    if (isInsidePath(active.path, source.path)) {
      return { ok: false, error: '这个目录在项目目录里面：项目自己的 data/ 本来就能读，不需要再挂一次' };
    }

    const picked = (Array.isArray(entries) ? entries : [])
      .map((item) => String(item).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
    const plan = [];
    if (!picked.length) {
      plan.push({ entry: '', as: safeAlias(as || source.label || path.basename(source.path)) });
    } else {
      for (const entry of picked) {
        const abs = path.join(source.path, ...entry.split('/'));
        if (!fs.existsSync(abs)) return { ok: false, error: `材料目录里没有「${entry}」` };
        plan.push({ entry, as: safeAlias(picked.length === 1 && as ? as : path.basename(entry)) });
      }
    }

    const materials = readMaterials(active.project);
    const taken = new Set(materials.mounts.map((item) => item.as));
    const seen = new Set();
    for (const item of plan) {
      if (taken.has(item.as)) return { ok: false, error: `data/${item.as} 已经挂过材料了` };
      if (seen.has(item.as)) return { ok: false, error: `这次选的里面有两个都叫「${item.as}」，先改个名再挂` };
      seen.add(item.as);
      if (fs.existsSync(mountPathOf(active.path, { as: item.as }))) {
        return { ok: false, error: `data/${item.as} 已经有东西了（真实目录或别的挂载），先处理掉再挂` };
      }
    }

    const created = [];
    const warnings = [];
    for (const item of plan) {
      // target 记的是「源根」，entry 是源内相对路径：解挂/校验/重连都按同一口径算绝对路径
      const mount = { id: newId('mnt'), sourceId: source.id, entry: item.entry, as: item.as, target: source.path, createdAt: new Date().toISOString() };
      const run = await mountOne({ projectRoot: active.path, mount });
      if (!run.ok) {
        for (const done of created) await unmountOne({ projectRoot: active.path, mount: done, includeDerived: true });
        return { ok: false, error: run.error || '建立挂载失败' };
      }
      if (run.warning) warnings.push(`data/${mount.as}：${run.warning}`);
      created.push(mount);
    }

    materials.mounts = [...materials.mounts, ...created];
    const saved = this.saveMaterials(active.path, materials);
    if (!saved.ok) {
      for (const done of created) await unmountOne({ projectRoot: active.path, mount: done, includeDerived: true });
      return saved;
    }

    for (const mount of created) await this.mountDerived(active.path, mount);
    this.refreshMaterials(active.path);
    this.onChange({ kind: 'project', path: active.path });
    return {
      ok: true,
      mounts: created,
      warnings,
      note: warnings.length
        ? `已挂上，但有 ${warnings.length} 条需要留意：${warnings.join('；')}`
        : '已挂上，不复制文件；审计阶段会直接扫这些目录。1 份都没有从磁盘上搬过。',
      state: this.mountsState(active.path),
    };
  }

  /** 识别稿挂进 data/：`<挂载名>__识别稿`，让技能把转写文本当普通材料读。 */
  async mountDerived(projectRoot, mount) {
    const root = derivedRoot(this.cacheDir(), mount.sourceId);
    if (!fs.existsSync(root)) return { ok: false, skipped: true, reason: '还没有识别稿' };
    const derivedMount = { as: derivedMountName(mount), target: root, entry: mount.entry };
    const link = mountPathOf(projectRoot, derivedMount);
    if (isLink(link) || fs.existsSync(link)) return { ok: true, existing: true };
    return mountOne({ projectRoot, mount: derivedMount });
  }

  async unmountSource({ as = '' } = {}) {
    const state = this.materialsOf();
    if (!state.ok) return state;
    const { active } = state;
    const materials = readMaterials(active.project);
    const key = String(as || '').trim();
    const mount = materials.mounts.find((item) => item.as === key || item.id === key);
    if (!mount) return { ok: false, error: `没有挂在 data/${key} 上的材料` };
    const run = await unmountOne({ projectRoot: active.path, mount, includeDerived: true });
    if (!run.ok) return run;
    materials.mounts = materials.mounts.filter((item) => item.id !== mount.id);
    const saved = this.saveMaterials(active.path, materials);
    if (!saved.ok) return saved;
    this.refreshMaterials(active.path);
    this.onChange({ kind: 'project', path: active.path });
    return { ok: true, removed: mount, note: '解挂只删挂载，材料原件和材料库条目都还在', state: this.mountsState(active.path) };
  }

  /** 联接被手动删掉/改指了：按 project.json 的记录重连一次（不碰源文件）。 */
  async repairMounts() {
    const state = this.materialsOf();
    if (!state.ok) return state;
    const { active } = state;
    const materials = readMaterials(active.project);
    const report = verifyMounts(active.path, materials);
    const fixed = [];
    for (const item of report) {
      if (item.status === 'ok') continue;
      const mount = materials.mounts.find((row) => row.id === item.id);
      if (!mount) continue;
      const target = mount.entry ? path.join(mount.target, mount.entry) : mount.target;
      if (!fs.existsSync(target)) {
        fixed.push({ as: mount.as, ok: false, error: '材料源目录不在了，先恢复它或改登记' });
        continue;
      }
      await unmountOne({ projectRoot: active.path, mount, includeDerived: false });
      const run = await mountOne({ projectRoot: active.path, mount });
      fixed.push({ as: mount.as, ok: run.ok, error: run.error || '' });
    }
    // macOS/Linux 的镜像目录：状态是 ok 也可能已经和源不同步（源里增删过文件），这里顺手对齐一次
    for (const item of report) {
      if (item.status !== 'ok' || item.mode !== 'mirror') continue;
      const mount = materials.mounts.find((row) => row.id === item.id);
      if (!mount) continue;
      const before = readMountMarker(mountPathOf(active.path, mount));
      const run = await mountOne({ projectRoot: active.path, mount });
      if (!run.ok) {
        fixed.push({ as: mount.as, ok: false, error: run.error || '' });
        continue;
      }
      const added = Math.max(0, Number(run.files || 0) - Number(before?.files || 0));
      const pruned = Number(run.pruned || 0);
      if (added || pruned) fixed.push({ as: mount.as, ok: true, added, pruned, error: '' });
    }
    this.refreshMaterials(active.path);
    this.onChange({ kind: 'project', path: active.path });
    return { ok: true, fixed, state: this.mountsState(active.path) };
  }

  /* ------------------------- 识图（扫描件转写） ------------------------- */

  visionPlan() {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const plan = buildVisionPlan({
      projectRoot: active.path,
      materials: readMaterials(active.project),
      sources: listSources(this.store),
      cacheDir: this.cacheDir(),
    });
    if (!plan.ok) return plan;
    return { ...plan, projectRoot: active.path };
  }

  visionStatus() {
    const active = this.active();
    const vision = this.materialServices().vision;
    return {
      ok: true,
      running: Boolean(vision?.status?.().running),
      task: vision?.status?.() || { running: false },
      summary: active.ok ? visionSummary(active.path) : null,
    };
  }

  /**
   * 开始识图。默认后台跑：一次几十页要几分钟，HTTP 请求和工具调用都不该挂着等。
   * wait=true 时同步等结果（面板里的小批量试跑用）。
   */
  async startVision({ limit = 40, pages = '', wait = false } = {}) {
    const vision = this.materialServices().vision;
    if (!vision) return { ok: false, error: '识图执行器没有初始化' };
    if (vision.status().running) return { ok: false, error: '已经有一个识图任务在跑，等它跑完或先取消' };
    const planned = this.visionPlan();
    if (!planned.ok) return planned;
    if (!(planned.items || []).length) {
      return { ok: false, error: '没有待识别的文件：要么审计还没跑（先跑 audit），要么没有扫描件 PDF', plan: planned };
    }
    const counted = await vision.countPages(planned);
    const args = { projectRoot: planned.projectRoot, plan: counted, limit, pageSpec: pages };
    const brief = {
      files: (counted.items || []).length,
      pages: counted.totals?.pages ?? null,
      skipped: (counted.skipped || []).length,
      limit,
      pageSpec: pages || '全部页',
    };
    if (wait) {
      const result = await vision.run(args);
      if (result.ok) await this.afterVision(planned.projectRoot);
      return { ...result, plan: brief };
    }
    this.visionJob = vision
      .run(args)
      .then(async (result) => {
        if (result.ok) await this.afterVision(planned.projectRoot);
        return result;
      })
      .catch((error) => ({ ok: false, error: error?.message || String(error) }));
    return { ok: true, started: true, plan: brief, note: '后台在跑，用 vision-status 看进度；不要重复点开始' };
  }

  cancelVision() {
    const vision = this.materialServices().vision;
    if (!vision) return { ok: false, error: '识图执行器没有初始化' };
    return vision.cancel();
  }

  async afterVision(projectRoot) {
    const read = readProject(projectRoot);
    if (!read.ok) return;
    const materials = readMaterials(read.project);
    for (const mount of materials.mounts) await this.mountDerived(projectRoot, mount);
    this.refreshMaterials(projectRoot);
    this.onChange({ kind: 'project', path: projectRoot });
  }

  verifyVision({ relPaths = [], all = false } = {}) {
    const active = this.active();
    if (!active.ok) return active;
    const result = markVisionVerified(active.path, { relPaths, all });
    if (result.ok) this.refreshMaterials(active.path);
    return result;
  }

  /* --------------------------- 旧项目迁移 --------------------------- */

  /**
   * 把早先复制进 data/ 的副本换成联接。默认只比对不删：
   * 全部逐份 md5 对上才允许 apply，任何一个对不上就整条停下。
   */
  async migrateSource({ sourceId = '', entries = [], as = '', apply = false } = {}) {
    const state = this.materialsOf();
    if (!state.ok) return state;
    const { active } = state;
    const source = findSource(this.store, sourceId);
    if (!source) return { ok: false, error: '找不到这个材料源' };
    const materials = readMaterials(active.project);
    const picked = (Array.isArray(entries) ? entries : [])
      .map((item) => String(item).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
    // entry 是源里的相对路径（整目录挂载时为空），as 是副本在 data/ 下的目录名——两者可能不同名
    const alias = String(as || '').trim();
    let targets;
    if (alias) {
      const mounted = materials.mounts.find((item) => item.as === alias);
      const entry = picked.length === 1 ? picked[0] : (mounted ? mounted.entry || '' : '');
      targets = [{ entry, as: alias }];
    } else if (picked.length) targets = picked.map((entry) => ({ entry, as: path.basename(entry) }));
    else {
      targets = materials.mounts
        .filter((item) => item.sourceId === source.id)
        .map((item) => ({ entry: item.entry || '', as: item.as }));
    }
    if (!targets.length) return { ok: false, error: '没有要比对的目录：先挂载，或直接给出源里的目录名' };

    const report = [];
    for (const target of targets) {
      const one = migrateCopiedEntry({ projectRoot: active.path, source, entry: target.entry, as: target.as });
      report.push(one);
    }
    const label = (item) => item.as || item.entry;
    const safe = report.every((item) => item.ok);
    if (!apply) {
      return {
        ok: true,
        applied: false,
        safe,
        report,
        note: safe
          ? '逐份 md5 全部一致，可以执行替换（会删掉 data/ 下的副本，原件在材料目录里不动）'
          : '有不一致或缺失的副本，不能替换；先看 report 里是哪几份',
      };
    }
    if (!safe) return { ok: false, error: '有副本没对上，已停止，没有删任何文件', safe, report };

    const done = [];
    for (const item of report) {
      if (item.ok === false) return { ok: false, error: `${label(item)}：${item.error}`, report };
      const localDir = item.localDir;
      if (isLink(localDir)) {
        done.push({ entry: item.as, skipped: '已经是联接' });
        continue;
      }
      // 删之前重新比对，避免比对后有人动过文件；删完要复核，删不掉就明确停下
      const again = migrateCopiedEntry({ projectRoot: active.path, source, entry: item.entry, as: item.as });
      if (!again.ok) return { ok: false, error: `${label(item)}：复检没通过，已停止`, report };
      const removal = await removeTree(localDir);
      if (!removal.ok || fs.existsSync(localDir)) {
        return {
          ok: false,
          error: `${label(item)}：删不掉 ${localDir}（${removal.error || '被占用'}），已停止；原件完好`,
          report,
        };
      }
      const mount = {
        id: newId('mnt'),
        sourceId: source.id,
        entry: item.entry,
        as: item.as,
        target: source.path,
        createdAt: new Date().toISOString(),
      };
      const run = await mountOne({ projectRoot: active.path, mount });
      if (!run.ok) return { ok: false, error: `副本已删但联接没建成：${run.error}（原件在 ${item.sourceDir}）`, report };
      materials.mounts = [...materials.mounts.filter((row) => row.as !== mount.as), mount];
      done.push({ entry: item.as, mounted: true });
    }
    const saved = this.saveMaterials(active.path, materials);
    if (!saved.ok) return saved;
    for (const mount of materials.mounts) await this.mountDerived(active.path, mount);
    this.refreshMaterials(active.path);
    this.onChange({ kind: 'project', path: active.path });
    return { ok: true, applied: true, done, report, note: '副本已换成挂载；请重跑审计，指纹会按源文件重算', state: this.mountsState(active.path) };
  }

  /** 快照里的材料段：只给面板要的东西，源目录的完整文件清单不进快照。 */
  publicMaterials(active) {
    const sources = this.sources();
    // 面板要按平台说人话：Windows 是目录联接，macOS/Linux 是镜像目录（逐文件软链）
    const platform = { platform: process.platform, isWindows: process.platform === 'win32' };
    if (!active?.ok) {
      return { sources, mounts: [], derived: [], entries: [], ...platform, vision: this.visionStatus() };
    }
    const state = this.mountsState(active.path);
    return {
      sources,
      mounts: state.mounts,
      derived: state.derived,
      entries: state.entries,
      ...platform,
      vision: this.visionStatus(),
    };
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
        // 主动关掉项目不是错误：空状态页自己会说「还没有打开项目」，这里再飘一条红字只会打扰
        error: active.detached ? '' : active.error,
        preflight: this.preflightSummary(),
        stages: [],
        summary: { done: 0, blocked: 0, review: 0, todo: 9, running: 0 },
        totals: { pass: 0, fail: 0, unjudged: 0 },
        artifacts: null,
        runs: this.recentRuns(8),
        adjudications: {},
        materials: this.publicMaterials(null),
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
      sources: listSources(this.store),
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
      materials: this.publicMaterials(active),
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
      sources: listSources(this.store),
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
    const python = this.getConfig().pythonPath || DEFAULT_PYTHON;
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

      const found = resolveStageScript({ projectRoot, skill, script: scriptRel });
      if (!found.ok) return { ok: false, error: scriptErrorMessage(stage, scriptRel, found, projectRoot, skill), steps: [] };
      const scriptAbs = found.abs;

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
      sources: listSources(this.store),
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
    if (at >= 0) {
      // 模型重录同一个 id 是常规动作；不能让它把人工裁定过的 fixed/wontfix/deferred 打回 open
      issues[at] = {
        ...issues[at],
        ...issue,
        status: issues[at].status || 'open',
        note: issue.note || issues[at].note || '',
        updatedAt: new Date().toISOString(),
      };
    } else {
      issues.push(issue);
    }
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
    // 已经套过一次、之后文件没再变过：重复套用只会再写一遍同样的内容
    if (issue.appliedHash && issue.patch?.path && fileHash(path.resolve(active.path, issue.patch.path)) === issue.appliedHash) {
      return { ok: false, error: '这条补丁已经套用过了（文件内容与套用后一致），不重复写' };
    }
    const applied = applyPatch(active.path, issue);
    if (!applied.ok) return applied;
    // 补丁落盘不等于问题解决：状态保持 open，等重跑 + 复算/人复核之后再改，
    // 否则「补丁写坏了」也会让 recheck-issues 闸门立刻变绿。
    issues[at] = {
      ...issue,
      status: 'open',
      appliedAt: new Date().toISOString(),
      appliedHash: applied.hash,
      backup: applied.backup,
      updatedAt: new Date().toISOString(),
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
    // output/dataset/analysis.csv 是规范宽表，stats / figures / qa 都拿它当 --data；
    // 漏掉它会让「补丁改了宽表」被报成「不影响下游阶段，未触发重跑」。
    if (/^output\/dataset\//.test(rel)) return ['stats', 'figures', 'manuscript', 'qa'];
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
    // 退出码不是判据，闸门才是：跑完 exit 0 但 error 级闸门 fail（例如没写 manifest）时，
    // 阶段是 blocked，链必须停，不能因为「进程成功」就当这一步过了。
    const stageState = (this.snapshot().stages || []).find((stage) => stage.id === run.stageId);
    const stageStatus = stageState?.status || '';
    if (!stageStatus || stageStatus === 'blocked' || run.status === 'cancelled') {
      const why = run.status === 'cancelled'
        ? '被取消'
        : stageStatus === 'blocked' ? '被 error 级闸门拦住' : '阶段状态读不到';
      this.patchChain({ status: 'stopped', error: `${expected} 运行${why}（退出码 ${run.exitCode ?? '—'}）` });
      return;
    }
    this.patchChain({
      index: chain.index + 1,
      note: run.status === 'ok' ? '' : `${expected} 退出码 ${run.exitCode ?? '—'}，但闸门没有拦住（${stageStatus}），继续`,
    });
    const next = this.chainStatus();
    if (next && next.status === 'running') {
      // 让当前 finish 先落盘，再起下一步
      setTimeout(() => this.beginChainStep(), 0);
    }
  }

  /** 宿主重启后，重跑链的回调不会再回来：把留在 running 的链标成中断，否则以后都点不动「套用」。 */
  recoverChains() {
    const state = this.store.get();
    const chains = { ...(state.recheckChains || {}) };
    let changed = 0;
    for (const [projectId, chain] of Object.entries(chains)) {
      if (!chain || chain.status !== 'running') continue;
      chains[projectId] = {
        ...chain,
        status: 'interrupted',
        error: '宿主重启（或中途切了项目），这一轮重跑已经中断，可以重新点「套用」',
        updatedAt: new Date().toISOString(),
      };
      changed += 1;
    }
    if (changed) {
      this.store.set({ recheckChains: chains });
      this.store.flushSoon();
    }
    return changed;
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


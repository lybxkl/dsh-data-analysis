import {workflowFor,defaultWorkflow,workflowArguments,rerunStages,workflowFileExists} from './workflow.js';
/**
 * 工作台服务层：面板、工具、路由共用这一份逻辑。
 *
 * 一切「状态」都从磁盘现算：project.json + 产物文件 + 台账。
 * 不缓存判定结果，避免面板显示的是上一轮的旧绿灯。
 * 允许的只有「同一轮计算内的读盘去重」：一次快照里 analysis.csv 会被闸门、复核、图表各读一遍，
 * 内容在这一轮里不会变，重复读只是把同样的字节再解析一次——那份去重作用域算完即丢（见 audit.js 的 withReadCache）。
 */

import fs from 'node:fs';
import { reportBlockers, gateAdmission, readGatePolicy, resolveGateResource,safePath,strictJson } from './gate-report.js';
import { inspectAfterRun, invalidateGateReports } from './gate-inspection.js';
import { acquireProjectLease } from './gate-lease.js';
import { gateCommand } from './gate-control.js';
import { syncMaterialRoots } from './gate-material-roots.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  DEFAULT_CONFIG,
  DEFAULT_PYTHON,
  SKILL_PACKAGE,
  normalizeConfig,
} from './defaults.js';
import { evaluateProject, summarizeStages, gateTotals, contractMode } from './gates.js';
import { createProject, projectId, readProject, writeProject, runsDir } from './projects.js';
import { fingerprint, resolveSkillRoot, resolveStageScript, listScripts } from './skill.js';
import { clearCorpusScan, readCsv, readFigures, readManuscriptSpec, scanArtifacts, withReadCache } from './audit.js';
import { adoptLegacy } from './adopt.js';
import {
  addClaim,
  confirmRow,
  projectPath as registryPath,
  readRegistry,
  removeRow,
  summarizeRegistry,
  upsert,
} from './registry.js';
import { runPreflight } from './preflight.js';
import { buildTaskCard } from './taskcard.js';
import { applyPatch, buildEvidence, fileHash, readIssues,readIssueLedger, readCoverage, recheckSummary, writeIssues } from './recheck.js';
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
import { isLink, readMountMarker, removeTree, runProcess } from './platform.js';
import { MAX_INHERIT_DEPTH } from './gating.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(MODULE_DIR, '..', 'assets');

/** 产物中心允许直接打开/下载的扩展名（白名单，防止把任意文件端出去）。 */
const ARTIFACT_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff', '.pdf',
  '.docx', '.csv', '.tsv', '.json', '.jsonl', '.md', '.txt', '.log', '.html',
]);
const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;

/** armings 表的上限：会话删掉后没人来销号，不设上限会一直长。 */
const ARMING_LIMIT = 200;

const EMPTY_SKILL = { ok: false, reason: '未配置 skillRoot', root: '', packageDir: '', version: '', sha256: '', scripts: [] };

/** 交办文案里给「状态不对的挂载」写一句人话，别让会话把旧副本/空目录当源文件。 */
const CARD_MOUNT_NOTE = {
  'not-link': '旧副本，不是挂载',
  'missing-link': '挂载不见了',
  'missing-target': '源目录不在了',
  retargeted: '挂载指到了别的目录',
};

/** 手稿骨架里的占位段落：明确说「数字要有出处」，也不含任何数字本身。 */
const MANUSCRIPT_PLACEHOLDER =
  '待补：这一节的论证、数据口径与主要发现。写进去的每个数字都要能在 output/models/ 或 output/dataset/analysis.csv 里找到原值。';

/** 中文小序号，够手稿的分节用；超了就直接用阿拉伯数字，不硬凑。 */
const CN_NUM = [
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
];

/** 手稿里默认挂的模型表：存在且有数据行才放进去。 */
const MANUSCRIPT_TABLES = [
  { csv: 'output/models/coef_all.csv', caption: '模型系数汇总' },
  { csv: 'output/models/descriptives.csv', caption: '描述统计' },
  { csv: 'output/models/fit.csv', caption: '模型拟合指标' },
];

/** CSV 里除了表头还有没有数据行。 */
function csvHasRows(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter((line) => line.trim()).length > 1;
  } catch {
    return false;
  }
}

/**
 * 脚本找不到时，把「为什么找不到」说清楚。
 *
 * 谎报「脚本不存在」会把排查引向错误方向：文件明明躺在磁盘上，问题在路径写法。
 * 所以区分两种失败——落在受保护范围之外（读得到，但不准读）与两处都没有这个文件。
 */
/**
 * 扫产物 + 读 v2 注册表。注册表读失败不能让整个面板黑掉：
 * 把错误挂到 artifacts.registryError，闸门据此判「判不了」。
 */
function scanAll(projectRoot) {
  // skill 模式由报告校验资料集合；旧 corpusCurrent 只服务 legacy 判据，避免再扫描一遍挂载树。
  const artifacts = scanArtifacts(projectRoot, { includeCorpusCurrent: readGatePolicy(projectRoot)?.mode !== 'skill' });
  try {
    artifacts.registry = readRegistry(projectRoot);
  } catch (error) {
    artifacts.registry = null;
    artifacts.registryError = String(error && error.message ? error.message : error).slice(0, 200);
  }
  return artifacts;
}

function scriptErrorMessage(stage, scriptRel, found, projectRoot, skill) {
  const scope = `项目 ${projectRoot}${skill?.ok ? ` / 技能包 ${skill.packageDir}` : '（技能包未配置）'}`;
  if (found.code === 'outside') {
    return `脚本指向受保护范围之外：${scriptRel}（文件存在，但阶段脚本只能读项目内或技能包内的文件；请把它放进项目的 scripts/ 再按相对路径登记）`;
  }
  return `脚本不存在：${scriptRel}（${scope} 里都没有；阶段脚本请写相对路径，如 scripts/auto_stats.py）`;
}

/**
 * 源内相对路径规整：统一正斜杠、去首尾斜杠。
 * 返回 null 表示这个路径不能用（`.`/`..` 之类会跳出材料目录的段）。
 */
function normalizeEntry(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  const parts = rel.split('/');
  if (parts.some((part) => part === '..' || part === '.')) return null;
  return rel;
}

/**
 * 两个路径是不是同一个目录。
 * Windows / macOS 的盘符与文件名大小写不敏感，Linux 敏感——一律 lowercase 会把
 * /a/Data 与 /a/data 当成同一个，那是两个不同的项目。
 */
function samePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(String(a));
  const right = path.resolve(String(b));
  if (process.platform === 'win32' || process.platform === 'darwin') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

export class Workbench {
  constructor({ getConfig, store, runner, onChange, materials, hostCtx }) {
    this.getConfig = getConfig;
    this.store = store;
    this.runner = runner;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    // 工具调用带着「哪条对话」进来时，active() 读的是这条对话绑定的项目，
    // 而不是左栏最近点开的那个——否则在对话里说「接着跑」，跑的是别人刚打开的项目。
    // 单线程里多个会话可能同时跑，所以用 AsyncLocalStorage 而不是一个全局字段。
    this.sessionScope = new AsyncLocalStorage();
    // 宿主 context：只用来读「这条会话的 cwd」这类只读事实，缺了也不影响绑定
    this.hostCtx = hostCtx || null;
    this.skillCache = null;
    this.skillCacheKey = '';
    this.preflightState = { value: null, at: 0, promise: null };
    // 材料库的外部依赖：识图执行器（只被工具显式调用，不做自动流水线）+ 派生缓存目录
    this.materials = materials || null;
    this.gateLeases = new Map();
    this.gateChecks = new Map();
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
        // 每个项目对应的那条 DSH 会话：左栏要能一眼看出「这个项目有没有研究对话」，
        // 并直接点进去接着聊。只回 id，不校验会话是否还在（由 client 侧 retain 时判断）。
        sessionId: item.sessionId || '',
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
    if (!entry.sessionId) {
      // 反向表里有这条项目的研究对话就沿用，别让「重开项目」把绑定丢了
      const stored = state.bindings || {};
      for (const sid of Object.keys(stored)) {
        if (stored[sid] && stored[sid].projectId === id) {
          entry.sessionId = sid;
          break;
        }
      }
    }
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
    // 反向表跟着条目一起清：留下的会话→项目指针会指向一个不存在的项目
    const bindings = {};
    for (const sid of Object.keys(state.bindings || {})) {
      if (state.bindings[sid] && state.bindings[sid].projectId === key) continue;
      bindings[sid] = state.bindings[sid];
    }
    // 指向这个项目的会话被清掉了，它们的启用登记也不能留下
    const armings = this.armings();
    for (const sid of Object.keys(state.bindings || {})) {
      if (state.bindings[sid] && state.bindings[sid].projectId === key) delete armings[sid];
    }

    const patch = { projects, runs, adjudications, recheckChains, bindings, armings };
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
   * 把面板里建好的 DSH 会话绑到当前项目（兼容旧路由：没给 projectId 就是当前项目）。
   * 只记 sessionId，不校验会话是否存在——会话由 client 侧持有，宿主这里不猜测。
   */
  bindSession(sessionId) {
    const result = this.bindSessionTo(sessionId, '', { force: true });
    if (!result.ok) return result;
    return { ...result, state: undefined };
  }

  /* ---------------------- 项目 ⇄ 研究对话（会话绑定） ---------------------- */

  /**
   * 会话 → 项目 的反向表。
   * 老台账只有 projects[].sessionId，先按它推一份，再叠上 bindings（新写法优先）。
   */
  sessionBindings() {
    const state = this.store.get();
    const map = {};
    for (const item of state.projects || []) {
      if (item.sessionId) map[item.sessionId] = item.id;
    }
    const stored = state.bindings || {};
    for (const sid of Object.keys(stored)) {
      const pid = stored[sid] && stored[sid].projectId;
      if (pid) map[sid] = pid;
      else delete map[sid];
    }
    return map;
  }

  /** 某条会话关联的项目（含 name/path），没绑过就是 null。 */
  sessionBinding(sessionId) {
    const key = String(sessionId || '').trim();
    if (!key) return null;
    const projectIdOf = this.sessionBindings()[key] || '';
    if (!projectIdOf) return null;
    const entry = this.ledgerProject(projectIdOf);
    if (!entry) return null;
    return {
      sessionId: key,
      projectId: projectIdOf,
      project: {
        id: projectIdOf,
        path: entry.path,
        name: entry.name || path.basename(entry.path),
      },
    };
  }

  /** 给面板/对话徽章用：这条会话属于哪个项目（没绑也回 ok，只是 bound:false）。 */
  projectForSession(sessionId) {
    const key = String(sessionId || '').trim();
    if (!key) return { ok: false, error: '没有会话 id' };
    const bound = this.sessionBinding(key);
    if (!bound) return { ok: true, bound: false, sessionId: key };
    const read = readProject(bound.project.path);
    return {
      ok: true,
      bound: true,
      sessionId: key,
      project: {
        id: bound.projectId,
        path: bound.project.path,
        name: bound.project.name,
        exists: read.ok,
        error: read.ok ? '' : read.error,
      },
    };
  }

  /* ---------------------- 触发门：这条对话启用工作台了吗 ---------------------- */

  /** 显式启用登记（sessionId → { at, reason }）。绑定项目算启用，但只往这里记「显式」那一份。 */
  armings() {
    const state = this.store.get();
    const map = state.armings && typeof state.armings === 'object' && !Array.isArray(state.armings) ? state.armings : {};
    return { ...map };
  }

  armedByFlag(sessionId) {
    const key = String(sessionId || '').trim();
    return Boolean(key) && Boolean(this.armings()[key]);
  }

  /**
   * 子代理沿用父对话的启用状态。
   * 不继承的话，已启用的对话派个子代理去干活，子代理突然没有 data_analysis_* 工具，
   * 看起来像「模型忘了怎么用」；继承也不写台账，会话没了就自然消失。
   */
  armedByParent(sessionId, depth = MAX_INHERIT_DEPTH, seen = new Set()) {
    const key = String(sessionId || '').trim();
    if (!key || depth <= 0 || seen.has(key)) return false;
    seen.add(key);
    const session = this.liveSession(key);
    const parent = session && session.header ? String(session.header.parentSession || '').trim() : '';
    if (!parent) return false;
    if (this.armedByFlag(parent) || Boolean(this.sessionBinding(parent))) return true;
    return this.armedByParent(parent, depth - 1, seen);
  }

  /**
   * 子代理应该落在哪个项目作用域里：沿 parentSession 链找最近一条「有绑定」的父对话。
   *
   * 子代理自己不记绑定（不占项目那唯一一条研究对话的名额），但它替父对话干活，
   * 读写必须落在父对话的项目里；否则面板当前项目是 B 时，子代理会把 A 的产物写到 B 上。
   */
  delegatedScopeSession(sessionId, depth = MAX_INHERIT_DEPTH, seen = new Set()) {
    const key = String(sessionId || '').trim();
    if (!key || depth <= 0 || seen.has(key)) return '';
    seen.add(key);
    const session = this.liveSession(key);
    const parent = session && session.header ? String(session.header.parentSession || '').trim() : '';
    if (!parent) return '';
    if (this.sessionBinding(parent)) return parent;
    return this.delegatedScopeSession(parent, depth - 1, seen);
  }

  /**
   * 触发门的唯一判定：显式启用 / 关联了项目 / 父对话已启用。
   * 默认必须是 false——任何「查不到就当能用」的写法都会把门关回去。
   */
  isArmed(sessionId) {
    const key = String(sessionId || '').trim();
    if (!key) return false;
    if (this.armedByFlag(key)) return true;
    if (this.sessionBinding(key)) return true;
    return this.armedByParent(key);
  }

  /**
   * 显式启用一条对话（不要求先有项目）。
   * 面板的「让 AI 装环境」开的是临时会话，装完要调 doctor/configure，所以它必须先启用。
   */
  armSession(sessionId, reason = 'panel') {
    const key = String(sessionId || '').trim();
    if (!key) return { ok: false, error: '没有会话 id' };
    const map = this.armings();
    map[key] = { at: new Date().toISOString(), reason: String(reason || 'panel') };
    const keys = Object.keys(map);
    if (keys.length > ARMING_LIMIT) {
      // 只留最近的若干条：旧会话大概率已经不在了，留着只会让台账越来越长
      keys.sort((a, b) => String(map[a] && map[a].at || '').localeCompare(String(map[b] && map[b].at || '')));
      for (const stale of keys.slice(0, keys.length - ARMING_LIMIT)) delete map[stale];
    }
    this.store.set({ armings: map });
    this.store.flushSoon?.(120);
    this.onChange({ kind: 'session', sessionId: key, armed: true, reason: String(reason || 'panel') });
    const bound = this.sessionBinding(key);
    return { ok: true, sessionId: key, armed: true, project: bound ? bound.project : null, reason: String(reason || 'panel') };
  }

  /** 停用：只清显式登记。还关联着项目的会话仍然是启用的（要停就先解绑）。 */
  disarmSession(sessionId) {
    const key = String(sessionId || '').trim();
    if (!key) return { ok: false, error: '没有会话 id' };
    const map = this.armings();
    const had = Boolean(map[key]);
    delete map[key];
    this.store.set({ armings: map });
    this.store.flushSoon?.(120);
    this.onChange({ kind: 'session', sessionId: key, armed: false });
    return { ok: true, sessionId: key, armed: this.isArmed(key), removed: had };
  }

  /**
   * 绑定会话与项目——唯一的写入口。
   *
   * 规则就是用户要的「不能随意切换」：
   *   - 一个项目只挂一条研究对话，一条会话也只属于一个项目；
   *   - 会话已经绑在别的项目上时，除非显式 force（用户点了「改绑」，或在对话里明确让切到另一个项目），
   *     一律拒绝并把原来的项目回传，让调用方去问人，而不是偷偷改。
   */
  bindSessionTo(sessionId, projectId, options = {}) {
    const key = String(sessionId || '').trim();
    if (!key) return { ok: false, error: '没有会话 id' };
    const wanted = String(projectId || '').trim();
    const activeNow = this.active();
    const targetId = wanted || (activeNow.ok ? activeNow.id : '');
    if (!targetId) return { ok: false, error: '还没有打开项目' };
    const target = this.ledgerProject(targetId);
    if (!target) return { ok: false, error: '台账里没有这个项目（可能已经被移除）' };

    const state = this.store.get();
    const current = this.sessionBinding(key);
    if (current && current.projectId !== targetId && options.force !== true) {
      return {
        ok: false,
        code: 'SESSION_BOUND_ELSEWHERE',
        error: `这条对话已经关联「${current.project.name || current.project.path}」，要改绑请明确确认`,
        bound: current.project,
      };
    }

    const bindings = {};
    for (const sid of Object.keys(state.bindings || {})) {
      const pid = state.bindings[sid] && state.bindings[sid].projectId;
      if (pid) bindings[sid] = { projectId: pid, at: state.bindings[sid].at || '' };
    }
    // 一个项目只留一条研究对话：新绑的这条顶掉旧的。
    // 老台账只有 projects[].sessionId，所以「这个项目原来那条会话」要从解析后的表里找，
    // 否则顶掉的只是新表里的记录，老字段会在下一次读取时把旧会话又复活回来。
    const resolved = this.sessionBindings();
    const evicted = new Set();
    for (const sid of Object.keys(bindings)) {
      if (bindings[sid].projectId === targetId && sid !== key) {
        evicted.add(sid);
        delete bindings[sid];
      }
    }
    for (const sid of Object.keys(resolved)) {
      if (resolved[sid] === targetId && sid !== key) evicted.add(sid);
    }
    bindings[key] = { projectId: targetId, at: new Date().toISOString() };

    // 绑定 = 启用：这条对话从此看得见整套 data_analysis_* 工具（触发门的第一个入口）
    const armings = this.armings();
    armings[key] = { at: new Date().toISOString(), reason: 'bind' };
    // 被顶掉的会话已经不是「研究对话」了：它的启用登记也要一起清。
    // 留着的话它仍然看得见整套工具，下一次调用还会被 ensureSessionBinding 绑回当前项目——两条会话来回抢。
    for (const sid of evicted) {
      if (sid !== key) delete armings[sid];
    }

    const projects = (state.projects || []).map((item) => {
      if (item.id === targetId) return { ...item, sessionId: key };
      // 被顶掉的会话在项目那一侧也不能留着：否则下次看「这条项目有没有对话」会读到旧 id
      if (item.sessionId === key || evicted.has(item.sessionId)) return { ...item, sessionId: '' };
      return item;
    });

    this.store.set({ bindings, projects, armings });
    const project = { id: targetId, path: target.path, name: target.name || path.basename(target.path) };
    const movedFrom = current && current.projectId !== targetId ? current.projectId : '';
    this.onChange({ kind: 'session', projectId: targetId, sessionId: key, movedFrom });
    return { ok: true, sessionId: key, projectId: targetId, project, movedFrom, already: false };
  }

  /** 解绑（会话被删了、或用户要重新开始）：只清登记，不动任何会话与文件。 */
  unbindSession(projectId) {
    const wanted = String(projectId || '').trim();
    const activeNow = this.active();
    const targetId = wanted || (activeNow.ok ? activeNow.id : '');
    if (!targetId) return { ok: true, projectId: '', cleared: 0 };
    const state = this.store.get();
    const projects = (state.projects || []).map((item) => (item.id === targetId ? { ...item, sessionId: '' } : item));
    const bindings = {};
    const armings = this.armings();
    let cleared = 0;
    for (const sid of Object.keys(state.bindings || {})) {
      const pid = state.bindings[sid] && state.bindings[sid].projectId;
      if (pid === targetId) {
        cleared += 1;
        // 解绑 = 停用：用户点「解绑」就是不希望这条对话再带着工作台跑
        delete armings[sid];
        continue;
      }
      if (pid) bindings[sid] = { projectId: pid, at: state.bindings[sid].at || '' };
    }
    this.store.set({ bindings, projects, armings });
    this.onChange({ kind: 'session', projectId: targetId, sessionId: '' });
    return { ok: true, projectId: targetId, cleared };
  }

  /**
   * 工具碰到工作台时顺手把「这条对话」绑到当前项目——只在还没绑过时绑，不抢别人的。
   * 这样「对话里让 AI 建的项目」也会自动关联，不用再去工作台点一次。
   */
  ensureSessionBinding(sessionId) {
    const key = String(sessionId || '').trim();
    if (!key) return { ok: false, error: '没有会话 id' };
    const existing = this.sessionBinding(key);
    if (existing) {
      return { ok: true, already: true, sessionId: key, projectId: existing.projectId, project: existing.project };
    }
    const activeNow = this.active();
    if (!activeNow.ok) return { ok: false, error: activeNow.error };
    const result = this.bindSessionTo(key, activeNow.id, { force: false });
    if (!result.ok) return result;
    return { ...result, already: false };
  }

  /**
   * 在「某个登记项目」里跑一段代码。
   *
   * 后台回调（运行结束、重跑链续跑）没有「当前会话」，也不能拿全局当前项目凑数：
   * 用户在面板里点开了 B 不等于刚才跑完的那次是 B 的。所以按运行记录里的 projectId 定作用域。
   */
  runInProject(projectId, fn) {
    const run = typeof fn === 'function' ? fn : () => undefined;
    const key = String(projectId || '').trim();
    if (!key) return run();
    const entry = this.ledgerProject(key);
    if (!entry) return run();
    const read = readProject(entry.path);
    if (!read.ok) return run();
    const scope = { ok: true, path: path.resolve(entry.path), project: read.project, id: key, sessionId: '' };
    return this.sessionScope.run(scope, run);
  }

  /**
   * 在「某条会话自己的项目」里跑一段代码。
   * 没绑定、或绑定的目录没了，就照老路用全局当前项目——不抛错、也不改台账。
   */
  runForSession(sessionId, fn) {
    const run = typeof fn === 'function' ? fn : () => undefined;
    const bound = this.sessionBinding(String(sessionId || '').trim());
    if (!bound) return run();
    const read = readProject(bound.project.path);
    if (!read.ok) return run();
    const scope = {
      ok: true,
      path: path.resolve(bound.project.path),
      project: read.project,
      id: bound.projectId,
      sessionId: bound.sessionId,
    };
    return this.sessionScope.run(scope, run);
  }

  /** 会话的 cwd（宿主会话服务里读，读不到就空串）。只用于「目录正好是项目根」这种强信号的自动关联。 */
  sessionCwd(sessionId) {
    const session = this.liveSession(sessionId);
    const cwd = session && session.header && session.header.cwd;
    return typeof cwd === 'string' ? cwd : '';
  }

  /** 宿主里活着的会话对象（读 header 这类只读事实用；读不到就是 null）。 */
  liveSession(sessionId) {
    const key = String(sessionId || '').trim();
    if (!key || !this.hostCtx) return null;
    try {
      const sessions = this.hostCtx.get('sessions');
      return sessions && typeof sessions.get === 'function' ? sessions.get(key) || null : null;
    } catch {
      return null;
    }
  }

  /** 子代理会话不参与绑定：它不该占用项目那唯一一条「研究对话」。 */
  sessionIsDelegated(sessionId) {
    const session = this.liveSession(sessionId);
    const header = session && session.header;
    if (!header) return false;
    if (header.origin === 'subagent') return true;
    const depth = Number(header.delegationDepth || 0);
    return Number.isFinite(depth) && depth > 0;
  }

  /**
   * 面板/对话把「现在屏幕上是哪条对话」告诉宿主。
   *
   * 只记事实（meta.focus），不自动改绑定：绑定是用户与工具的动作，切面板不该改它。
   * 唯一的例外是强信号——这条对话的 cwd 正好就是当前项目的根目录，那它就是这个项目的对话。
   */
  focusSession(sessionId) {
    const key = String(sessionId || '').trim();
    const state = this.store.get();
    if (!key) {
      if ((state.meta || {}).focusSessionId) {
        this.store.set({ meta: { ...(state.meta || {}), focusSessionId: '' } });
        this.store.flushSoon?.(150);
      }
      return { ok: true, sessionId: '', bound: null };
    }
    let bound = this.sessionBinding(key);
    if (!bound && !this.sessionIsDelegated(key)) {
      const activeNow = this.active();
      const cwd = this.sessionCwd(key);
      if (activeNow.ok && cwd && samePath(cwd, activeNow.path)) {
        const result = this.bindSessionTo(key, activeNow.id, { force: false });
        if (result.ok) bound = this.sessionBinding(key);
      }
    }
    if ((state.meta || {}).focusSessionId !== key) {
      this.store.set({ meta: { ...(state.meta || {}), focusSessionId: key } });
      // focus 只是「现在看的是哪条对话」，但它要跨面板重开活着：落一次盘
      this.store.flushSoon?.(150);
    }
    return { ok: true, sessionId: key, bound: bound ? bound.project : null };
  }

  /** 快照里的「当前对话」：面板要靠它跟着对话走，而不是跟着上次点开的项目走。 */
  focusSnapshot() {
    const state = this.store.get();
    const sessionId = (state.meta || {}).focusSessionId || '';
    if (!sessionId) return null;
    const bound = this.sessionBinding(sessionId);
    return {
      sessionId,
      projectId: bound ? bound.projectId : '',
      projectName: bound ? bound.project.name : '',
      projectPath: bound ? bound.project.path : '',
    };
  }

  /** 生成某阶段的任务卡（供面板投递到原生会话）。 */
  taskCard(stageId) {
    const stage = this.stageById(stageId);
    if (!stage) return { ok: false, error: `未知阶段：${stageId}` };
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };

    const artifacts = scanAll(active.path);
    const stages = evaluateProject({
      pythonPath: this.getConfig().pythonPath,
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
      scriptRegistered: Boolean(command.ok && command.steps.length),
    });
    if (!card.ok) return card;
    return { ok: true, stageId: stage.id, stageName: stage.name, text: card.text, commands: commands.map((item) => item.display) };
  }

  active() {
    // 会话作用域优先：工具调用把自己的项目带进来，读的就是它。
    const scoped = this.sessionScope.getStore();
    if (scoped) return scoped;
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

  async removeSource(id, { force = false } = {}) {
    const projects = (this.store.get().projects || [])
      .map((item) => {
        const read = readProject(item.path);
        return read.ok ? { path: item.path, name: item.name, project: read.project } : null;
      })
      .filter(Boolean);
    // 先查引用：force 不是「留一堆悬空引用」，而是「先把这些挂载摘掉，再删库条目」
    const refs = [];
    for (const project of projects) {
      const materials = readMaterials(project.project);
      for (const mount of materials.mounts) {
        if (mount.sourceId === id) refs.push({ project: project.path, name: project.name, as: mount.as });
      }
    }
    if (refs.length && !force) {
      return {
        ok: false,
        error: `还有 ${refs.length} 处挂载在用它（${refs.map((item) => item.as).join('、')}），先解挂再删`,
        refs,
      };
    }
    const detached = [];
    for (const project of projects) {
      const materials = readMaterials(project.project);
      const mine = materials.mounts.filter((mount) => mount.sourceId === id);
      if (!mine.length) continue;
      for (const mount of mine) {
        // 只删工作台自己建的联接/镜像；真实目录 unmountOne 会拒绝并报错
        const run = await unmountOne({ projectRoot: project.path, mount });
        if (!run.ok) {
          return {
            ok: false,
            error: `${project.name || project.path} 的 ${mount.as} 摘不掉：${(run.errors || []).join('；') || '未知原因'}`,
            refs,
            detached,
          };
        }
      }
      this.saveMaterials(project.path, {
        version: 1,
        mounts: materials.mounts.filter((mount) => mount.sourceId !== id),
      });
      this.refreshMaterials(project.path);
      detached.push({ project: project.path, name: project.name, as: mine.map((mount) => mount.as) });
    }
    const result = dropSource(this.store, id, { projects: [], force: true });
    if (!result.ok) return result;
    this.onChange({ kind: 'sources' });
    return { ...result, detached, sources: this.sources() };
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
    const broken = mounts.filter((item) => item.status !== 'ok');
    const lines = [];
    lines.push(`[材料读取] 项目「${name}」的资料已经挂到 data/ 下，全程只读。`);
    lines.push('');
    // 状态不对的挂载必须点名：不然会话会把「真实目录里的旧副本」或空目录当成源文件读
    if (broken.length) {
      lines.push(`注意：有 ${broken.length} 条挂载状态异常（见下面标注），先修挂载再读，否则读到的可能是旧副本或空目录。`);
      lines.push('');
    }
    lines.push('挂载（都在项目 data/ 下，指向用户自己的目录，不复制文件）：');
    for (const mount of mounts) {
      const source = byId.get(mount.sourceId);
      // 老台账里源还在但没扫过：Number(null) 是 0，会写成「（0 个文件）」骗人
      const scanned = source && source.scan ? Number(source.scan.files) : NaN;
      const files = Number.isFinite(scanned) ? scanned : null;
      const where = source ? `${source.path}${mount.entry ? ' / ' + mount.entry : ''}` : '（材料源已删除）';
      const target = mount.resolved || mount.target;
      const note = mount.status === 'ok' ? '' : `［${CARD_MOUNT_NOTE[mount.status] || mount.status}］`;
      lines.push(`- data/${mount.as} → ${where}${files !== null ? `（${files} 个文件）` : ''}${note}`);
      // not-link 是项目内的真实目录，报「实际指向」只会让人以为它连着别处
      if (mount.status !== 'ok' && mount.status !== 'not-link' && target) lines.push(`  实际指向：${target}`);
    }
    const derived = state.derived || [];
    if (derived.length) {
      lines.push('');
      lines.push('已有的派生稿（此前的识图产物，未人工核对的不算数）：');
      for (const item of derived) lines.push(`- data/${item.mountName}（${item.files} 份）`);
    }
    lines.push('');
    lines.push('约束：');
    lines.push('1. 只读：不要修改、移动、删除用户原始资料目录里的任何文件；data/ 下这些目录就是指向源目录的挂载，往里写等于改原件。');
    lines.push('   （标了「旧副本」的那条不是挂载，是项目内的复制品——也不要改，它会和源文件分叉。）');
    lines.push('2. 派生只走派生目录：需要转写时先跑 data_analysis_vision（action=plan 只数页不花 token，确认后再 action=run），产物会自动落到 data/<挂载名>__识别稿/ 并记账；不要手写到别处。');
    lines.push('3. 不要自己把页图读进上下文：纯文本模型会把图片静默换成占位行，等于白跑一遍；识图交给工作台直连模型。');
    lines.push('4. doc/xls/ppt 下游脚本读不了文本：转换由你或用户在 Office/WPS 里另存为 docx/xlsx/pptx 后重扫材料；工作台不代转。');
    lines.push('5. 处理完重跑 audit：data/ 变了指纹就变，audit-freshness 会拦住后续阶段。');
    lines.push('');
    lines.push('先跑 data_analysis_status 看当前进度，再决定从哪个阶段继续。');
    return { ok: true, text: lines.join('\n'), mounts: mounts.length, broken: broken.length, project: active.path };
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

    const picked = [];
    for (const raw of Array.isArray(entries) ? entries : []) {
      const rel = normalizeEntry(raw);
      if (rel === null) return { ok: false, error: `「${raw}」不是材料目录里的路径（不能带 .. 或 .）` };
      if (rel) picked.push(rel);
    }
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
    const task = vision?.status?.() || { running: false };
    return {
      ok: true,
      running: Boolean(task.running),
      task,
      // 后台任务失败不该只在日志里：面板/工具要看得到原因
      error: this.visionError || task.error || '',
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
    // 先把「模型不能看图」挡在门口：不然数页那步白跑，后台任务还会静默失败
    const capability = await vision.capability();
    if (!capability.ok) return { ok: false, error: capability.error || '当前模型不能看图', capability, plan: planned };
    const counted = await vision.countPages(planned);
    const args = { projectRoot: planned.projectRoot, plan: counted, limit, pageSpec: pages, capability };
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
    this.visionError = '';
    this.visionJob = vision
      .run(args)
      .then(async (result) => {
        if (result.ok) await this.afterVision(planned.projectRoot);
        else this.visionError = result.error || '识图失败';
        return result;
      })
      .catch((error) => {
        this.visionError = error?.message || String(error);
        return { ok: false, error: this.visionError };
      });
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
    const picked = [];
    for (const raw of Array.isArray(entries) ? entries : []) {
      const rel = normalizeEntry(raw);
      if (rel === null) return { ok: false, error: `「${raw}」不是材料目录里的路径（不能带 .. 或 .）` };
      if (rel) picked.push(rel);
    }
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
      // 已经是挂载的条目：跳过，别再走删除
      if (!item.localDir) {
        done.push({ entry: item.as || item.entry, skipped: item.skipped || '不需要替换' });
        continue;
      }
      const localDir = item.localDir;
      if (isLink(localDir)) {
        done.push({ entry: item.as, skipped: '已经是联接' });
        continue;
      }
      // 删之前重新比对，避免比对后有人动过文件；删完要复核，删不掉就明确停下
      const again = migrateCopiedEntry({ projectRoot: active.path, source, entry: item.entry, as: item.as });
      if (!again.ok) return { ok: false, error: `${label(item)}：复检没通过，已停止`, applied: done.length, report };
      const removal = await removeTree(localDir);
      if (!removal.ok || fs.existsSync(localDir)) {
        return {
          ok: false,
          error: `${label(item)}：删不掉 ${localDir}（${removal.error || '被占用'}），已停止；原件完好`,
          applied: done.length,
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
      if (!run.ok) {
        // 副本已经删了：先把已完成的挂载落盘，别让台账和磁盘脱节
        if (done.length) this.saveMaterials(active.path, materials);
        return { ok: false, error: `副本已删但联接没建成：${run.error}（原件在 ${item.sourceDir}）`, applied: done.length, report };
      }
      materials.mounts = [...materials.mounts.filter((row) => row.as !== mount.as), mount];
      // 每个条目落一次盘：中途停下时，之前换好的挂载必须记进 project.json
      const saved = this.saveMaterials(active.path, materials);
      if (!saved.ok) return saved;
      done.push({ entry: item.as, mounted: true });
    }
    const swapped = done.filter((item) => item.mounted).length;
    for (const mount of materials.mounts) await this.mountDerived(active.path, mount);
    this.refreshMaterials(active.path);
    this.onChange({ kind: 'project', path: active.path });
    return {
      ok: true,
      applied: true,
      swapped,
      done,
      report,
      note: swapped
        ? '副本已换成挂载；请重跑审计，指纹会按源文件重算'
        : '没有需要替换的副本（这些条目本来就是挂载）',
      state: this.mountsState(active.path),
    };
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
    // 整段计算包进「读盘去重」作用域：同一批产物在 scanArtifacts 与闸门里被反复读，
    // 一次快照只解析一遍。结果仍是现读的——作用域一结束就丢，判定不缓存。
    return withReadCache(() => {
      try{return this.buildSnapshot();}catch(error){return this.unavailableWorkflowState(error);}
    });
  }

  unavailableWorkflowState(error){
    const active=this.active(),config=this.getConfig();
    return {config:this.publicConfig(config),skill:this.publicSkill(this.skill()),python:config.pythonPath,projects:this.projects(),
      active:active.ok?{id:active.id,path:active.path,name:active.project?.name||active.path,skillPin:active.project?.skill}:null,
      workflow:{ok:false,error:String(error.message||error)},error:String(error.message||error),preflight:this.preflightSummary(),
      stages:[],summary:{done:0,blocked:0,review:0,todo:0,running:0},totals:{pass:0,fail:0,unjudged:0,na:0},
      admission:{allowed:false,blockingInstances:[{gateId:'platform.workflow',detail:String(error.message||error)}]},deliveryReady:false,deliveryBlockers:[String(error.message||error)],
      artifacts:null,registry:null,runs:[],adjudications:{},activeRuns:{},gateChecking:null,materials:null,focus:this.focusSnapshot()};
  }

  buildSnapshot() {
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
        summary: { done: 0, blocked: 0, review: 0, todo: 0, running: 0 },
        totals: { pass: 0, fail: 0, unjudged: 0 },
        artifacts: null,
        focus: this.focusSnapshot(),
        runs: this.recentRuns(8),
        adjudications: {},
        materials: this.publicMaterials(null),
        registry: null,
      };
    }

    const { workflow, artifacts, adjudications, activeRuns, stages, summary, totals } = this.evaluateActive(active);
    const deliveryBlockers = reportBlockers(stages, active.path, 'delivery-ready');

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
      workflow:{ok:true,id:workflow.id,version:workflow.version,sha256:workflow.sha256,draftTasks:workflow.draftTasks,actions:workflow.actions.map(({id,stage,label})=>({id,stage,label}))},
      error: '',
      preflight: this.preflightSummary(),
      stages,
      summary,
      totals,
      gateMode: readGatePolicy(active.path)?.mode || 'legacy',
      gateChecking: this.gateChecks.has(active.id) ? {stageId:this.gateChecks.get(active.id).stageId,startedAt:this.gateChecks.get(active.id).startedAt} : null,
      gateRecoveryNeeded: fs.existsSync(path.join(active.path,'output/gates/publication.lock'))&&!this.gateLeases.has(active.id),
      deliveryReady: readGatePolicy(active.path)?.mode === 'skill' && deliveryBlockers.length === 0,
      deliveryBlockers,
      admission: gateAdmission(stages,active.path,'delivery-ready'),
      artifacts: this.publicArtifacts(artifacts),
      runs: this.recentRuns(12, active.id),
      adjudications,
      activeRuns,
      materials: this.publicMaterials(active),
      registry: this.publicRegistry(artifacts.registry || readRegistry(active.path), active.path),
      // 现在屏幕上是哪条对话（可能属于另一个项目）：面板据此跟着对话走
      focus: this.focusSnapshot(),
    };
  }

  // 每次请求现读现判；withReadCache 只在本次计算内复用相同文件的读取。
  evaluateActive(active) {
    const activeRuns = this.runner.activeFor(active.id);
    const workflow=this.workflow(active);
    const artifacts = scanAll(active.path);
    const adjudications = this.adjudicationsFor(active.id);
    const stages = evaluateProject({
      pythonPath: this.getConfig().pythonPath,
      projectRoot: active.path,
      project: active.project,
      artifacts,
      adjudications,
      activeRuns,
      runs: this.recentRuns(200, active.id),
      sources: listSources(this.store),
    });
    for(const stage of stages){
      const definition=workflow.stages.find(item=>item.id===stage.id);
      const override=active.project.stages?.[stage.id]||{};
      stage.script=override.script===undefined?definition?.script:override.script;
      stage.args=Array.isArray(override.args)?override.args:definition?.args||[];
      stage.steps=Array.isArray(override.steps)?override.steps:definition?.steps||[];
      stage.ui={...(definition?.ui||{})};
      stage.missingInputs=(stage.ui.requiredFiles||[]).filter(relative=>!workflowFileExists(active.path,relative));
      stage.manualInstructions=definition?.manualInstructions||[];
      stage.taskConstraints=workflow.taskConstraints;
      stage.artifacts=definition?.artifacts||stage.artifacts||[];
      stage.outputFiles=stage.artifacts.map(relative=>{try{const file=safePath(active.path,relative),stat=fs.statSync(file);return {path:relative,exists:stat.isFile(),bytes:stat.size};}catch{return {path:relative,exists:false,bytes:0};}});
      if(stage.ui.legacySkipWhenMissing&&readGatePolicy(active.path)?.mode!=='skill')stage.hidden=!fs.existsSync(path.join(active.path,stage.ui.legacySkipWhenMissing));
    }
    const entry = {
      id: active.id,
      workflow,
      artifacts,
      adjudications,
      activeRuns,
      stages,
      summary: summarizeStages(stages),
      totals: gateTotals(stages),
    };
    return entry;
  }

  /** 原生对话里的徽章每 8–10 秒轮询一次：只回摘要，不搬图表清单与产物明细。 */
  summary() {
    // 与 snapshot 同一套读盘去重：摘要是「何时刷新」的判定依据，必须现读，但不能读两遍
    return withReadCache(() => {
      try{return this.buildSummary();}catch(error){const state=this.unavailableWorkflowState(error);return {ok:false,error:state.error,active:state.active,workflow:state.workflow,summary:state.summary,totals:state.totals,next:null,running:false};}
    });
  }

  buildSummary() {
    const active = this.active();
    if (!active.ok) return { ok: true, active: null, summary: null, totals: null, next: null, running: false };
    const running = Object.keys(this.runner.activeFor(active.id)).length > 0;
    const { workflow, stages, summary, totals } = this.evaluateActive(active);
    const next = stages.find((item) => !item.hidden&&!['done','na'].includes(item.status)) || null;
    const value = {
      ok: true,
      active: {
        id: active.id,
        name: active.project.name,
        path: active.path,
        // 契约版本：strict = 新项目（缺注册表/复核就拦），legacy = 旧项目（只判「判不了」）
        contract: contractMode(active.project),
        schemaVersion: active.project.schemaVersion || 1,
        stageApplicability: {
          coding: active.project?.stages?.coding?.applicability || 'auto',
        },
        sessionId: this.ledgerProject(active.id)?.sessionId || '',
      },
      workflow:{ok:true,id:workflow.id,version:workflow.version,sha256:workflow.sha256},
      summary,
      totals,
      contract: contractMode(active.project),
      next: next
        ? {
            id: next.id,
            index: next.index,
            name: next.name,
            // 简称也一起下发：输入行那颗芯片只放得下简称，但阶段名只有 skill 工作流一份，
            // 不能让前端自己截字或另抄一张对照表
            short: next.short || next.name,
            status: next.status,
            script: next.script || null,
            args: next.args || [],
          }
        : null,
      running,
    };
    return value;
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
      manuscriptSpec: artifacts.manuscript.spec || { exists: false },
      analysisCsv: artifacts.analysisCsv.exists ? artifacts.analysisCsv.size : 0,
      tables: artifacts.tables,
    };
  }

  /* ---------------------------- v2 契约层 ---------------------------- */

  /** 面板要的注册表视图：摘要 + 列表（列表都裁过，不会把整张表搬过去）。 */
  publicRegistry(registry, projectRoot) {
    const summary = summarizeRegistry(registry, projectRoot);
    return {
      ...summary,
      datasets: registry.datasets.rows.map((item) => ({
        id: item.id,
        title: item.title,
        unit: item.unit,
        file: item.file,
        rows: item.rows,
        columns: item.columns.length,
        inAnalysis: item.inAnalysis.n,
        inAnalysisColumn: item.inAnalysis.column,
        confirmed: item.confirmedByHuman,
        confidence: item.confidence,
        missingKinds: item.columns.reduce((acc, column) => {
          if (column.missing) acc[column.missingKind || 'unknown'] = (acc[column.missingKind || 'unknown'] || 0) + 1;
          return acc;
        }, {}),
      })),
      models: registry.models.rows.map((item) => ({
        id: item.id,
        estimator: item.estimator,
        family: item.family,
        outcome: item.outcome,
        dataset: item.dataset,
        n: item.n,
        events: item.events,
        clusters: item.clusters,
        dropped: item.dropped,
        dropReasons: item.dropReasons,
        terms: item.terms.length,
        flags: item.flags,
      })),
      artifacts: registry.artifacts.rows.slice(0, 200).map((item) => ({
        id: item.id,
        kind: item.kind,
        path: item.path,
        title: item.title,
        note: item.note,
        n: item.n,
        dpi: item.dpi,
        minFont: item.minFont,
        section: item.section,
        rows: item.rows,
        cols: item.cols,
      })),
      claims: registry.claims.rows.slice(0, 60).map((item) => ({
        id: item.id,
        text: item.text,
        where: item.where,
        status: item.status,
        assert: item.assert ? `${item.assert.left} ${item.assert.op} ${item.assert.right}` : '',
        evidence: item.evidence,
      })),
      sweep: registry.sweep.value,
      cells: registry.cells,
    };
  }

  registrySnapshot() {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const registry = readRegistry(active.path);
    return { ok: true, summary: summarizeRegistry(registry, active.path), registry: this.publicRegistry(registry, active.path) };
  }

  /** 登记一条数据集/模型/产物/结论。kind 接受单数或复数。 */
  registrySave({ kind, data } = {}) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const map = { dataset: 'datasets', datasets: 'datasets', model: 'models', models: 'models', artifact: 'artifacts', artifacts: 'artifacts', claim: 'claims', claims: 'claims', sweep: 'sweep' };
    const target = map[String(kind || '').trim()];
    if (!target) return { ok: false, error: `kind 只能是 dataset / model / artifact / claim / sweep（收到 ${kind || '空'}）` };
    let parsed = data;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch (error) {
        return { ok: false, error: `data 不是合法 JSON：${String(error?.message || error).slice(0, 120)}` };
      }
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: '缺 data（对象或 JSON 字符串）' };
    let result;
    if (target === 'claims') result = addClaim(active.path, parsed);
    else if (target === 'sweep') {
      result = { ok: false, error: 'sweep 由 data_analysis_sweep 生成，不接受手工登记' };
    } else result = upsert(active.path, target, parsed);

    clearCorpusScan();
    if (!result.ok) {
      return {
        ok: false,
        error: (result.errors || []).map((item) => `${item.where}: ${item.message}`).join('；') || result.error || '登记失败',
        warnings: result.warnings || [],
      };
    }
    const registry = readRegistry(active.path);
    return {
      ok: true,
      file: result.file,
      row: result.row || result.claim,
      warnings: (result.warnings || []).map((item) => `${item.where}: ${item.message}`),
      summary: summarizeRegistry(registry, active.path),
      registry: this.publicRegistry(registry, active.path),
    };
  }

  registryRemove({ kind, id } = {}) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const map = { dataset: 'datasets', datasets: 'datasets', model: 'models', models: 'models', artifact: 'artifacts', artifacts: 'artifacts', claim: 'claims', claims: 'claims' };
    const target = map[String(kind || '').trim()];
    if (!target) return { ok: false, error: 'kind 只能是 dataset / model / artifact / claim' };
    const result = removeRow(active.path, target, String(id || '').trim());

    if (!result.ok) return result;
    const registry = readRegistry(active.path);
    return { ok: true, file: result.file, summary: summarizeRegistry(registry, active.path), registry: this.publicRegistry(registry, active.path) };
  }

  /** 人确认「这条推断出来的结构是对的」。机器不能替人确认。 */
  registryConfirm({ kind, id } = {}) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const map = { dataset: 'datasets', datasets: 'datasets', model: 'models', models: 'models', artifact: 'artifacts', artifacts: 'artifacts' };
    const target = map[String(kind || '').trim()];
    if (!target) return { ok: false, error: 'kind 只能是 dataset / model / artifact' };
    const result = confirmRow(active.path, target, String(id || '').trim());

    if (!result.ok) return result;
    const registry = readRegistry(active.path);
    return { ok: true, file: result.file, summary: summarizeRegistry(registry, active.path), registry: this.publicRegistry(registry, active.path) };
  }

  registryAdopt({ overwrite = false } = {}) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const result = adoptLegacy(active.path, { overwrite: overwrite === true });

    clearCorpusScan();
    if (!result.ok) return result;
    const registry = readRegistry(active.path);
    return { ...result, summary: summarizeRegistry(registry, active.path), registry: this.publicRegistry(registry, active.path), state: this.snapshot() };
  }

  /* ----------------------------- 产物中心 ----------------------------- */

  /** 路径解析：词法越界、真实路径越界、扩展名白名单、大小上限，四道都要过。 */
  artifactResolve(rel) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const wanted = String(rel || '').trim();
    if (!wanted) return { ok: false, error: '缺 path' };
    const root = path.resolve(active.path);
    const abs = path.resolve(root, wanted);
    const relToRoot = path.relative(root, abs);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return { ok: false, error: '路径不在项目里' };
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return { ok: false, error: `文件不存在：${relToRoot}` };
    }
    if (!stat.isFile()) return { ok: false, error: '不是文件' };
    let real = abs;
    let realRoot = root;
    try {
      real = fs.realpathSync(abs);
    } catch {
      /* 用词法路径 */
    }
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      /* 用词法路径 */
    }
    if (!isInsidePath(realRoot, real)) return { ok: false, error: '这个路径指向项目外（材料挂载/联接不对外开）' };
    const ext = path.extname(real).toLowerCase();
    if (!ARTIFACT_EXTS.has(ext)) return { ok: false, error: `不支持的扩展名 ${ext || '(无)'}` };
    if (stat.size > ARTIFACT_MAX_BYTES) return { ok: false, error: `文件太大（${Math.round(stat.size / 1048576)} MB > 32 MB）` };
    return { ok: true, abs: real, rel: path.relative(root, abs).replace(/\\/g, '/'), size: stat.size, ext, mtimeMs: stat.mtimeMs };
  }

  /** output/ 下的文件树（深度 3、条目上限）；面板据此画产物目录。 */
  artifactTree({ limit = 800 } = {}) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const root = active.path;
    const base = path.join(root, 'output');
    if (!fs.existsSync(base)) return { ok: true, root: 'output', entries: [], truncated: false, totalFiles: 0, totalBytes: 0 };
    const entries = [];
    let truncated = false;
    let totalFiles = 0;
    let totalBytes = 0;
    const max = Math.min(2000, Math.max(20, Number(limit) || 800));
    const walk = (dir, depth) => {
      if (truncated || depth > 3) return;
      let items = [];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const abs = path.join(dir, item.name);
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (stat.isDirectory()) {
          entries.push({ kind: 'dir', rel, name: item.name, size: 0, mtimeMs: stat.mtimeMs });
          walk(abs, depth + 1);
        } else if (stat.isFile()) {
          const ext = path.extname(item.name).toLowerCase();
          totalFiles += 1;
          totalBytes += stat.size;
          entries.push({
            kind: 'file',
            rel,
            name: item.name,
            ext,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            viewable: ARTIFACT_EXTS.has(ext) && stat.size <= ARTIFACT_MAX_BYTES,
            image: /^\.(png|jpe?g|webp|gif|tiff?)$/.test(ext),
          });
        }
        if (entries.length >= max) {
          truncated = true;
          return;
        }
      }
    };
    walk(base, 0);
    return { ok: true, root: 'output', entries, truncated, totalFiles, totalBytes };
  }

  /** 读一个产物的内容：表格回前 N 行，文本回前 N 字，图片/文档只回元信息。 */
  artifactRead(rel, { limit = 200 } = {}) {
    const resolved = this.artifactResolve(rel);
    if (!resolved.ok) return resolved;
    const maxRows = Math.min(2000, Math.max(5, Number(limit) || 200));
    const ext = resolved.ext;
    const base = { ok: true, rel: resolved.rel, size: resolved.size, ext, mtimeMs: resolved.mtimeMs };
    if (/^\.(png|jpe?g|webp|gif|tiff?)$/.test(ext)) return { ...base, kind: 'image' };
    if (ext === '.pdf') return { ...base, kind: 'pdf' };
    if (ext === '.docx') return { ...base, kind: 'document' };
    if (ext === '.csv' || ext === '.tsv') {
      const csv = readCsv(resolved.abs);
      if (!csv) return { ok: false, error: 'CSV 解析失败' };
      return {
        ...base,
        kind: 'table',
        header: csv.header,
        rows: csv.rows.slice(0, maxRows).map((row) => csv.header.map((name) => row[name] ?? '')),
        totalRows: csv.rows.length,
        truncated: csv.rows.length > maxRows,
      };
    }
    if (ext === '.json' || ext === '.jsonl') {
      const text = fs.readFileSync(resolved.abs, 'utf8').replace(/^\uFEFF/, '');
      if (ext === '.json') {
        try {
          const value = JSON.parse(text);
          const pretty = JSON.stringify(value, null, 2);
          return { ...base, kind: 'json', text: pretty.length > 200000 ? `${pretty.slice(0, 200000)}\n…（已截断）` : pretty };
        } catch {
          return { ...base, kind: 'text', text: text.slice(0, 200000) };
        }
      }
      const lines = text.split(/\r?\n/).filter(Boolean);
      return { ...base, kind: 'text', text: lines.slice(0, maxRows).join('\n'), totalRows: lines.length, truncated: lines.length > maxRows };
    }
    const text = fs.readFileSync(resolved.abs, 'utf8');
    return { ...base, kind: 'text', text: text.length > 200000 ? `${text.slice(0, 200000)}\n…（已截断）` : text };
  }

  /** 缩略图：python + Pillow 生成一次，缓存到 output/.thumbs（键含尺寸与 mtime）。 */
  async artifactThumb(rel, { width = 320 } = {}) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const resolved = this.artifactResolve(rel);
    if (!resolved.ok) return resolved;
    if (!/^\.(png|jpe?g|webp|gif|bmp|tiff?|hei[cf])$/.test(resolved.ext)) return { ok: false, error: '只有图片能生成缩略图' };
    // 320 = 网格缩略图；2400 = 大图预览（TIFF/HEIC 浏览器不显示，只能靠这一步转 PNG）
    const px = Math.min(2400, Math.max(80, Number(width) || 320));
    const cacheDir = path.join(active.path, 'output', '.thumbs');
    const key = `${createHash('sha1').update(`${resolved.rel}|${resolved.size}|${resolved.mtimeMs}|${px}`).digest('hex').slice(0, 16)}.png`;
    const out = path.join(cacheDir, key);
    if (fs.existsSync(out)) return { ok: true, abs: out, rel: path.relative(active.path, out).replace(/\\/g, '/'), cached: true };
    fs.mkdirSync(cacheDir, { recursive: true });
    const python = this.getConfig().pythonPath || DEFAULT_PYTHON;
    const result = await runProcess(python, [path.join(ASSETS_DIR, 'thumb.py'), '--src', resolved.abs, '--out', out, '--width', String(px)], { timeoutMs: 60000 });
    if (!result.ok || !fs.existsSync(out)) {
      return { ok: false, error: `缩略图生成失败：${(result.stderr || result.stdout || '').slice(-300) || '未知错误'}` };
    }
    return { ok: true, abs: out, rel: path.relative(active.path, out).replace(/\\/g, '/'), cached: false };
  }

  /* ---------------------------- 研究适配器 ---------------------------- */

  /**
   * 跑 assets/<name>.py：这些脚本只读项目、只写 output/ 下的登记文件。
   * 统一契约：--root <项目> --out <结果 JSON>，退出码 0 且结果文件可解析才算成功。
   */
  async runAdapter(name, { timeoutMs = 900000, args = [] } = {}) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const script = path.join(ASSETS_DIR, `${name}.py`);
    if (!fs.existsSync(script)) return { ok: false, error: `缺适配器脚本 assets/${name}.py` };
    const outDir = path.join(active.path, 'output', '.adapter');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `${name}.json`);
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* ignore */
    }
    const python = this.getConfig().pythonPath || DEFAULT_PYTHON;
    const result = await runProcess(python, [script, '--root', active.path, '--out', out, ...args], {
      timeoutMs,
      cwd: active.path,
    });
    let payload = null;
    let parseError = '';
    try {
      payload = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      parseError = String(error?.message || error).slice(0, 160);
    }

    clearCorpusScan();
    const tail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split(/\r?\n/).slice(-12).join('\n');
    if (!result.ok || !payload) {
      return {
        ok: false,
        error: payload?.error || `适配器失败（退出码 ${result.code ?? '—'}）${parseError ? `：结果文件读不出（${parseError}）` : ''}`,
        log: tail,
        adapter: name,
      };
    }
    return { ok: true, adapter: name, result: payload, log: tail, state: this.snapshot() };
  }

  runSweep({ maxOutcomes = 0 } = {}) {
    // 普查只做诊断：结局清单来自 codebook / registry / 已登记模型，列名提示只补位。
    const args = [];
    if (Number(maxOutcomes) > 0) args.push('--max-outcomes', String(Math.trunc(Number(maxOutcomes))));
    return this.runAdapter('sweep_models', { args });
  }

  runVerifySource({ mode = 'build', datasetId = '' } = {}) {
    const args = ['--mode', mode === 'verify' ? 'verify' : 'build'];
    if (datasetId) args.push('--dataset', String(datasetId));
    return this.runAdapter('verify_source', { args, timeoutMs: 1800000 });
  }

  runFigureCheck() {
    return this.runAdapter('figure_check');
  }

  /** Old tool names are aliases; scripts, arguments and output locations come from the spec. */
  runDatasetVerification({stage='prepare'}={}){return this.runBoundWorkflowAction('dataset-verification',stage);}
  runResearchGate(){return this.runBoundWorkflowAction('research-gate');}
  runDecisionCheck(){return this.runBoundWorkflowAction('decision-check');}
  runReviewPack(){return this.runBoundWorkflowAction('review-pack');}

  runBoundWorkflowAction(tool,variant=''){
    const action=this.workflow().actions.find(action=>action.tool===tool&&(action.variant||'')===variant);
    return action?this.runWorkflowAction(action.id):Promise.resolve({ok:false,error:'当前技能没有声明此工具动作'});
  }

  async runWorkflowAction(actionId){
    const active=this.active();
    if(!active.ok)return {ok:false,error:active.error};
    const action=this.workflow(active).actions.find(action=>action.id===actionId);
    if(!action)return {ok:false,error:'当前技能没有声明此工作流动作'};
    const started=this.runStage(action.stage,{actionId});
    if(!started.ok)return started;
    const deadline=Date.now()+1800000;let timedOut=false;
    await new Promise(resolve=>{
      const timer=setInterval(()=>{
        if(Date.now()>deadline&&!timedOut){timedOut=true;this.runInProject(active.id,()=>this.cancelStage(action.stage));}
        if(!this.runner.activeFor(active.id)[action.stage]&&!this.gateChecks.has(active.id)){clearInterval(timer);resolve();}
      },100);
    });
    const run=this.recentRuns(200,active.id).find(run=>run.id===started.run.id);
    let result=null;
    if(action.outFile){try{result=strictJson(fs.readFileSync(safePath(active.path,action.outFile),'utf8'));}catch{}}
    return {ok:!timedOut&&run?.status==='ok'&&run?.gateCheck?.status!=='failed',code:run?.exitCode??null,runId:started.run.id,actionId,result,outFile:action.outFile||'',log:this.runner.logTail(started.run.id,200).join('\n'),...(timedOut?{error:'工作流动作超时，已取消'}:{})};
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
        actionId:run.actionId||'',
        workflow:run.workflow||null,
        projectId: run.projectId,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        exitCode: run.exitCode,
        signal: run.signal || null,
        logFile: run.logFile,
        error: run.error || '',
        gateCheck:run.gateCheck?{status:run.gateCheck.status,reason:run.gateCheck.reason||'',results:(run.gateCheck.results||[]).map(r=>({stage:r.stage,exitCode:r.exitCode,reason:r.reason||''}))}:null,
      }));
  }

  /* ------------------------------- 运行 ------------------------------- */

  workflow(active=this.active()) {
    return workflowFor(active?.project||{},this.getConfig().skillRoot||'');
  }

  stageById(stageId) {
    return this.workflow().stages.find(stage=>stage.id===stageId)||null;
  }

  /**
   * 把项目里的 stage 覆盖与 skill 路径合成可执行的步骤列表。
   * 一个阶段可以是多步（终检 = qa_outputs + verify_numbers + research_gate + review_pack），
   * 顺序执行、日志合并；whenFile 缺文件时整步跳过，optionalArgs 缺文件时不追加参数。
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
      // 阶段本身是多步，项目里没改过它 → 按默认的多步跑
      for (const step of stageSteps) spec.push(step);
    } else {
      spec.push({ script: override.script === undefined ? stage.script : override.script, args: Array.isArray(override.args) ? override.args : stage.args });
    }

    const exists = (rel) => Boolean(rel) && fs.existsSync(path.join(projectRoot, String(rel)));
    const skipped = [];

    const workflow=workflowFor(project,skill.packageDir);

    const optionals = (resolved, item, extras) => {
      const has = (flag) => resolved.includes(flag) || extras.includes(flag);
      for (const opt of Array.isArray(item?.optionalArgs) ? item.optionalArgs : []) {
        if (!opt || !opt.flag || has(opt.flag)) continue;
        if (opt.file) {
          if (!exists(opt.file)) continue;
          extras.push(opt.flag, opt.file);
        } else if (opt.whenFile) {
          if (!exists(opt.whenFile)) continue;
          extras.push(opt.flag);
        }
      }
      for (const opt of Array.isArray(item?.optionalFlags) ? item.optionalFlags : []) {
        if (!opt || !opt.flag || has(opt.flag)) continue;
        if (opt.whenFile && !exists(opt.whenFile)) continue;
        extras.push(opt.flag);
      }
    };

    const steps = [];
    const deferred = [];
    const produced = new Set();
    const normalizeRel = (rel) => String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
    for (const item of spec) {
      const scriptRel = item?.script;
      if (!scriptRel) return { ok: false, error: `${stage.name} 没有登记脚本：这一步由人/模型完成，面板只做验收`, steps: [] };

      // 条件步骤不在启动前统一跳过：同一阶段里前一步的产物（例如 assemble_manuscript
      // 写的 figure_map.json）要等它真的跑完才知道在不在。这里只登记 whenFile，
      // 由 runner 在执行到该步时判断。
      const whenFile = item.whenFile ? normalizeRel(item.whenFile) : '';
      const found = resolveStageScript({ projectRoot, skill, script: scriptRel });
      if (!found.ok) {
        // 条件步骤 + 文件现在不在 + 本阶段没有任何一步声明会产出它 → 这次本来就不跑，
        // 不该让「技能包少一个可选脚本」把整个阶段判死。
        const maybeLater = whenFile && produced.has(whenFile);
        const existsNow = whenFile ? exists(whenFile) : true;
        if (whenFile && !existsNow && !maybeLater) {
          skipped.push({ script: scriptRel, whenFile });
          continue;
        }
        return { ok: false, error: scriptErrorMessage(stage, scriptRel, found, projectRoot, skill), steps: [] };
      }
      const scriptAbs = found.abs;

      const args = Array.isArray(item.args) ? item.args : [];
      // 宽表规范位置是 output/dataset/analysis.csv；旧项目仍在 data/ 时自动回退，
      // 不让「升级插件」等于「旧项目立刻跑不动」。
      const resolved = workflowArguments(workflow,projectRoot,args);
      // 可选参数：项目里确实有这个文件才带上。
      // 不传的后果很实在——统计不到模型、图表推断不出结局变量直接退出 2；
      // qa 不传 --min-fontsize 则字号永远「未核」。
      const extras = [];
      optionals(resolved, item, extras);
      if (scriptRel === stage.script) optionals(resolved, stage, extras);
      const argv = [scriptAbs, ...resolved, ...extras];
      for (const rel of Array.isArray(item.produces) ? item.produces : []) produced.add(normalizeRel(rel));
      const step = {
        script: scriptRel,
        scriptAbs,
        produces: (Array.isArray(item.produces)?item.produces:[]).map(normalizeRel),
        argv,
        whenFile,
        display: [python, ...argv].join(' '),
        continueOnError: item.continueOnError === true,
      };
      if (whenFile) {
        deferred.push({ script: scriptRel, whenFile });
        step.display += `  [条件：${whenFile} 不存在则跳过]`;
      }
      steps.push(step);
    }

    if (!steps.length) {
      const missing = skipped.map((item) => item.whenFile).filter(Boolean);
      return {
        ok: false,
        error: missing.length
          ? `${stage.name} 没有可执行的步骤：缺 ${missing.join('、')}（按契约补齐后再跑，或显式改 project.json 的 stages.${stage.id}.steps）`
          : `${stage.name} 没有可执行的命令`,
        steps: [],
      };
    }
    const skippedNote = skipped.length
      ? `  [跳过 ${skipped.map((item) => item.whenFile).join('、')}：文件不存在]`
      : '';
    return {
      ok: true,
      steps,
      skipped,
      deferred,
      script: steps[0].script,
      display: steps.map((item) => item.display).join('  &&  ') + skippedNote,
    };
  }

  /** 前置闸门：前面阶段不许留着 blocked / 未裁定的人工项。 */
  blockers(projectRoot, project, stageId, adjudications, execution={}) {
    const artifacts = scanAll(projectRoot);
    const stages = evaluateProject({
      pythonPath: this.getConfig().pythonPath,
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
    const definition=workflowFor(project).stages.find(stage=>stage.id===stageId);
    if(!definition)return ['工作流中没有此阶段'];
    const formal=readGatePolicy(projectRoot)?.mode==='skill';
    for(const relative of execution.requiredFiles||definition.ui?.requiredFiles||[])if(!workflowFileExists(projectRoot,relative))reasons.push('缺少阶段输入：'+relative);
    const rule=execution.admission||(formal?definition.admission:definition.legacyAdmission||{});
    if(formal){
      for(const id of execution.dependsOn||definition.dependsOn){
        const dependency=stages.find(stage=>stage.id===id);
        if(!dependency||!['done','na'].includes(dependency.status))reasons.push(`依赖阶段 ${dependency?.name||id} 尚未完成`);
      }
    }else{
      for(const previous of stages.slice(0,index)){
        if(previous.status==='blocked')reasons.push(`${previous.name}：存在未通过的硬要求`);
        for(const gate of previous.gates.filter(g=>g.manual&&g.status==='unjudged'))reasons.push(`${previous.name}：${gate.label} 待人工裁定`);
      }
    }
    if(rule.checkpoint)reasons.push(...reportBlockers(stages,projectRoot,rule.checkpoint,{reportStages:rule.reportStages||null}));
    const available=!rule.whenFile||fs.existsSync(path.join(projectRoot,rule.whenFile));
    if(!available&&rule.requiredInStrict&&contractMode(project)==='strict')reasons.push('缺少工作流要求的输入：'+rule.whenFile);
    if(available)for(const id of rule.gates||[]){
      const gate=stages.flatMap(stage=>stage.gates).find(g=>g.id===id);
      if(!gate||!['pass','na'].includes(gate.status))reasons.push(gate?.detail||`尚未满足判据 ${id}`);
    }
    return reasons;
  }

  runStage(stageId, { force = false, actionId = '' } = {}) {
    let stage = this.stageById(stageId);
    if (!stage) return { ok: false, error: `未知阶段：${stageId}` };
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };


    const workflow=this.workflow(active);
    const operation=actionId?workflow.actions.find(action=>action.id===actionId&&action.stage===stageId):null;
    if(actionId&&!operation)return {ok:false,error:'工作流中没有此阶段动作'};
    if(operation)stage={...stage,steps:operation.steps,script:operation.steps[0].script,args:operation.steps[0].args||[]};
    const live = this.runner.activeFor(active.id);
    if (live[stageId]) {
      return { ok: false, error: `${stage.name} 已有运行在跑（${live[stageId].id}），先等它结束或取消` };
    }
    // 同一项目里别的阶段还在跑：两个脚本会同时往 output/ 里写，闸门读到的是半成品。
    const busyStages = Object.keys(live).filter((id) => id !== stageId);
    if (busyStages.length) {
      const names = busyStages.map((id) => (this.stageById(id) || {}).name || id);
      const error = `${names.join('、')} 正在运行，等它结束再跑这一步（确需并行请显式 force）`;
      if (!force || readGatePolicy(active.path)?.mode === 'skill') return { ok: false, error, blockers: [error] };
    }

    let lease = null;
    if (readGatePolicy(active.path)) {
      try {
        lease = acquireProjectLease(active.path);
        this.gateLeases.set(active.id, lease);
      } catch (error) {
        return {ok: false, error: '项目正在写入或体检；先等待完成，或恢复已中断的运行', blockers: ['project-lease']};
      }
    }
    let run, command;
    try {
      if(lease)syncMaterialRoots(active.path,active.project,listSources(this.store),this.cacheDir());
      command=this.commandFor(active.path,operation?{...active.project,stages:{...active.project.stages,[stageId]:{}}}:active.project,stage);
      if(!command.ok)return {ok:false,error:command.error};
      if(!force||readGatePolicy(active.path)?.mode==='skill'){
        const reasons=this.blockers(active.path,active.project,stageId,this.adjudicationsFor(active.id),operation?{admission:operation.admission||{},dependsOn:[],requiredFiles:[]}:{});
        if(reasons.length)return {ok:false,error:`前置阶段未过：${reasons.join('；')}`,blockers:reasons};
      }
      invalidateGateReports(active.path);
      run = this.runner.start({
        project: { id: active.id, path: active.path },
        stageId, steps: command.steps, projectLease: lease, workflow, actionId,
      });
    } catch (error) {
      return {ok: false, error: String(error.message || error)};
    } finally {
      if(!run&&lease)this.releaseGateLease(active.id,lease);
    }
    if (!run) return {ok: false, error: '没有可执行的阶段步骤'};
    this.onChange({ kind: 'run-start', runId: run.id, stageId });
    return { ok: true, run, command: command.display };
  }

  cancelStage(stageId) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };

    const checking=this.gateChecks.get(active.id);
    if(checking){checking.controller.abort();return {ok:true,cancelled:['gate-check']};}
    const cancelled = this.runner.cancelStage(active.id, stageId);
    if (!cancelled.length) return { ok: false, error: '当前没有在跑的进程' };
    return { ok: true, cancelled };
  }

  runLog(runId, limit = 200) {
    const lines = this.runner.logTail(runId, limit);
    const run = this.runner.getRun(runId);
    return { ok: Boolean(run), run, lines };
  }

  /* ----------------------------- 手稿骨架 ----------------------------- */

  /**
   * 文稿阶段吃的是 manuscript.json，而这个文件只有人/模型能写。
   * 这里把「机械的部分」拼好：图表清单里的每个 section、图块与题注、模型表。
   * 正文段落留成「待补」占位——骨架不放任何自己编的数字，质检阶段报出来的
   * 数字问题就都是真的，不会被骨架自己制造的假错淹掉。
   */
  manuscriptScaffold({ overwrite = false } = {}) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const root = active.path;
    const rel = 'manuscript.json';
    const specPath = path.join(root, rel);
    const existed = fs.existsSync(specPath);
    // 0 块的空壳（`{}` / `{"style":{}}`）不是「别人写过的稿子」——它本来就跑不通，
    // 拒绝重建只会让人先去点一次覆盖。只有真有块、且能解析的文件才要求 overwrite。
    const existing = existed ? readManuscriptSpec(root) : { exists: false, blocks: 0, error: '' };
    const keepExisting = existed && !existing.error && Number(existing.blocks) > 0;
    if (keepExisting && !overwrite) {
      return {
        ok: false,
        error: 'manuscript.json 已经存在（里面已经有正文了）。确认要用图表清单重排骨架，请显式 overwrite。',
        file: rel,
      };
    }

    const blocks = [{ type: 'title', text: String(active.project.name || '').trim() || '（标题待写）' }];
    blocks.push({ type: 'heading', level: 1, text: `${CN_NUM[0]}、研究设计` });
    blocks.push({ type: 'para', text: MANUSCRIPT_PLACEHOLDER });

    const figureSource = readFigures(root);
    // 清单里的 png 是「相对清单所在目录」的（auto_chart_pack 的 rel_path 就是这么写的），
    // 所以前缀要跟着清单走，不能一律当成 output/chart_pack/
    const figureBaseRel = figureSource.file
      ? path.posix.dirname(String(figureSource.file).replace(/\\/g, '/'))
      : 'output/chart_pack';
    const figurePng = (raw) => {
      const text = String(raw || '').replace(/\\/g, '/').trim();
      if (!text) return '';
      if (path.isAbsolute(text)) return text;
      if (text.startsWith('output/') || text.startsWith('data/')) return text;
      const rel = text.replace(/^\.?\//, '');
      return figureBaseRel && figureBaseRel !== '.' ? `${figureBaseRel}/${rel}` : rel;
    };
    const allRows = (figureSource.rows || []).filter((row) => row && row.png);
    // 画图失败的行（status=error*/skipped*）不会出现在骨架里；把它和「png 不存在」
    // 分开数——两种原因要用户做的事完全不同（重跑图表阶段 vs 把图补齐）。
    const badStatus = allRows.filter((row) => row.deliverable === false);
    const candidateRows = allRows.filter((row) => row.deliverable !== false);
    // png 缺了就别写进骨架：assemble_manuscript 遇到不存在的图会直接 SpecError，
    // 骨架把一个坏引用塞进去，等于把「图没画出来」伪装成「文稿写不出来」。
    const figureRows = candidateRows.filter((row) => row.pngExists !== false);
    const skippedNoPng = candidateRows.length - figureRows.length;
    const skippedFigures = skippedNoPng + badStatus.length;
    const cleanSection = (name) => String(name || '').trim().replace(/^[A-Z][.、:]?\s+/, '').trim() || '其他图表';
    const groups = [];
    for (const row of figureRows) {
      // 分组键也用规范化后的名字：清单里同时出现「A 数据质量」与「A. 数据质量」时
      // 不该生成两节同样内容
      const name = cleanSection(row.section);
      let group = groups.find((item) => item.name === name);
      if (!group) {
        group = { name, rows: [] };
        groups.push(group);
      }
      group.rows.push(row);
    }
    const cnLabel = (index) => (CN_NUM[index] ? CN_NUM[index] : String(index + 1));
    const warnings = [];
    if (!figureSource.file) {
      warnings.push('还没找到图表清单（图表阶段的输出）——骨架里暂时没有图；先跑图表阶段，再点「重排骨架」。');
    } else if (!figureRows.length) {
      warnings.push('图表清单里没有可用的图（png 缺失或 status 不是 ok）——骨架里暂时没有图；先把图表阶段跑通再重排。');
    }
    let headingIndex = 1;
    for (const group of groups) {
      blocks.push({ type: 'heading', level: 1, text: `${cnLabel(headingIndex)}、${group.name}` });
      blocks.push({ type: 'para', text: MANUSCRIPT_PLACEHOLDER });
      headingIndex += 1;
      for (const row of group.rows) {
        // 没有 caption 就用占位，不拿 question 顶替：brief 里说「caption 不许改」，
        // 拿研究问题当图注会让人只能违规去改
        const caption = String(row.caption || '').trim() || '（图题待写）';
        const block = {
          type: 'figure',
          png: figurePng(row.png),
          caption,
        };
        const n = Number(row.n);
        // 清单题注通常已经带 N=…（auto_chart_pack 的 fill_caption_n 写进去的）；
        // 这里再塞 n，组装出来就成了「（N=320）（N=320）」。
        if (Number.isFinite(n) && n > 0 && !/\bN\s*[=＝]/i.test(caption)) block.n = n;
        blocks.push(block);
      }
    }

    const tables = MANUSCRIPT_TABLES.filter((item) => csvHasRows(path.join(root, item.csv)));
    if (tables.length) {
      blocks.push({ type: 'heading', level: 1, text: `${cnLabel(headingIndex)}、模型与描述统计` });
      blocks.push({ type: 'para', text: MANUSCRIPT_PLACEHOLDER });
      for (const item of tables) blocks.push({ type: 'table', csv: item.csv, caption: item.caption });
    }

    // 覆盖前先留一份备份：正文是这一阶段最贵的产物，误点一次不该没法回头
    let backup = '';
    if (existed) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      backup = `manuscript.json.bak-${stamp}`;
      try {
        fs.copyFileSync(specPath, path.join(root, backup));
      } catch (error) {
        return { ok: false, error: `备份现有 manuscript.json 失败，没有覆盖：${error.message}`, file: rel };
      }
    }

    // 直接写在目标文件上：写到一半崩掉会留下半截 JSON，下次打开就成了「解析失败」
    const tmp = `${specPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify({ style: {}, page: {}, blocks }, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, specPath);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件可能没建出来，忽略 */
      }
      return { ok: false, error: `写不进 manuscript.json：${error.message}`, file: rel };
    }

    this.onChange({ kind: 'manuscript-scaffold', file: rel });
    const spec = readManuscriptSpec(root);
    if (!groups.length && !tables.length) warnings.push('骨架里只有「研究设计」一节：没有图也没有可用的模型表，正文需要你自己补结构。');
    return {
      ok: true,
      file: rel,
      warning: warnings.join(' '),
      overwritten: keepExisting,
      backup,
      figures: figureRows.length,
      skippedFigures,
      skippedNoPng,
      skippedBadStatus: badStatus.length,
      skippedBadExample: badStatus.length ? String(badStatus[0].id || badStatus[0].question || '') : '',
      tables: tables.length,
      sections: groups.length + (tables.length ? 1 : 0),
      figureSections: groups.length,
      blocks: blocks.length,
      placeholders: blocks.filter((block) => block.type === 'para' && block.text === MANUSCRIPT_PLACEHOLDER).length,
      spec,
      brief: this.manuscriptBrief(spec),
    };
  }

  /** 交给会话的改稿说明：说清哪些不许动、数字从哪来、跑完看什么。 */
  manuscriptBrief(spec = null) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    const root = active.path;
    const state = spec || readManuscriptSpec(root);
    let stateLine;
    if (!state.exists) {
      stateLine = '还没有 manuscript.json —— 先生成骨架';
    } else if (state.error) {
      stateLine = state.errorKind === 'structure'
        ? `跑不了：${state.error} —— 先按上面的结构改好，再跑文稿阶段`
        : `解析失败：${state.error} —— 先把 JSON 改对，再跑文稿阶段`;
    } else {
      stateLine = `${state.blocks} 块（图 ${state.figures} / 表 ${state.tables} / 待补段落 ${state.placeholders}）`;
      if (state.invalidBlocks) {
        stateLine += `；有 ${state.invalidBlocks} 块结构不对（type 不认识、table 缺 csv 或 csv 没有数据行），文稿阶段会直接报错`;
      }
      if (state.figuresMissing) {
        stateLine += `；有 ${state.figuresMissing} 个图块的 png 找不到（文稿阶段会直接报 figure image not found）`;
      }
    }
    const text = [
      '【手稿正文】把文稿阶段（文稿组装）的骨架写成正文',
      '',
      `项目目录：${root}`,
      `manuscript.json：${stateLine}`,
      '',
      '怎么做：',
      '1. 读 manuscript.json。figure 块的 png / caption 不要改；N 已经写在题注里（或 n 字段里），不要重复加，也不要把题注里的 N 删掉——它是质检阶段核对的统计口径。补 note 可以。',
      '2. 把每个「待补」的 para 换成真正的段落（问题、数据、方法、发现、局限）。每个数字都要能在 output/models/*.csv 或 output/dataset/analysis.csv 里找到原值；找不到就补一张表，不要在正文里估一个数出来。',
      '3. 正文至少引用每个图号一次（图1、图2…），图号从 1 连续；要加表就写 {"type":"table","csv":"output/models/coef_m1_probation.csv","caption":"…","columns":[{"col":"term","label":"变量"},{"col":"beta","label":"系数","fmt":".3f"}]}，数字由脚本从 CSV 取，不要抄进正文。',
      '   表的列选择写在 table 块的顶层 columns（不是 presentation.columns）：只选要发表的列，别把整张原始输出贴进论文。',
      '   注意：正文里的「图N」按块序自动编号——你调换 figure 块的顺序，图号就跟着变，正文引用必须同步改，否则图与正文会错配。',
      '4. 只改 manuscript.json，写完自己 JSON.parse 一遍；不要动 output/ 下的产物，也不要改 data/ 里的资料。',
      '5. 写完跑 data_analysis_run_stage(stageId="manuscript")，再跑终检，按 qa 报告逐条修。',
      '',
      '产物落点：output/manuscript.docx（另写 manuscript_numbers.csv 与 figure_map.json）；文稿阶段的闸门只认这个 docx（manuscript.json 是它的输入，不是闸门证据）。',
      '导 PDF：本阶段会自动跑 export_pdf_hires.py 回填 600dpi 图（需要本机 Word）；失败不影响 docx，但 qa 的 --pdf 检查会缺席。',
    ].join('\n');
    return { ok: true, text, spec: state };
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
    if(status!=='unjudged'&&readGatePolicy(active.path)?.mode==='skill'&&!gate.snapshotHash){
      return {ok:false,error:'当前体检证据尚不完整或已失效，请先重新体检，再对当前快照裁定'};
    }

    const state = this.store.get();
    const all = { ...(state.adjudications || {}) };
    const mine = { ...(all[active.id] || {}) };
    if (status === 'unjudged') delete mine[gateId];
    else mine[gateId] = { status, note: String(note || ''), at: new Date().toISOString(), stageId, ...(gate.snapshotHash?{snapshotHash:gate.snapshotHash}:{}) };
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
    const state = readGatePolicy(active.path)?.mode==='skill'
      ? this.skillRecheckState(active)
      : recheckSummary(active.path, { project: active.project, runs });
    return {
      ok: true,
      projectId: active.id,
      checks: state.checks,
      issues: state.issues,
      coverage: state.coverage,
      snapshotHash: state.snapshotHash || null,
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
    const state = readGatePolicy(active.path)?.mode==='skill'
      ? this.skillRecheckState(active)
      : recheckSummary(active.path, { project: active.project, runs });
    const evidence = buildEvidence(active.path, {
      project: active.project,
      runs,
      checks: state.checks,
      issues: state.issues,
    });
    return { ok: true, projectId: active.id, chars: evidence.length, evidence, snapshotHash: state.snapshotHash || null };
  }

  skillRecheckState(active) {
    const stages=this.snapshot().stages;
    const recheck=stages.find(s=>s.id==='recheck');
    const checks=recheck?.gates.find(g=>g.id==='recheck-machine')?.checks||[];
    const issues=readIssues(active.path);
    return {checks,issues,coverage:readCoverage(active.path),
      openErrors:issues.filter(i=>i.status==='open'&&i.severity==='error').length,
      openOthers:issues.filter(i=>i.status==='open'&&i.severity!=='error').length,
      report:fs.existsSync(path.join(active.path,'output/recheck/report.md')),
      snapshotHash:stages.find(s=>s.id==='qa')?.gates.find(g=>g.id==='qa-signoff')?.snapshotHash||null};
  }

  releaseGateLease(projectId,lease) {
    try{lease.release();return '';}
    catch(error){const message=String(error?.message||error);this.onChange({kind:'gate-lease-error',projectId,error:message});return message;}
    finally{this.gateLeases.delete(projectId);}
  }

  async gateControl({action='inspect',stageId,mode}={}) {
    const active=this.active();
    if(!active.ok)return {ok:false,error:active.error};
    if(Object.keys(this.runner.activeFor(active.id)).length||this.gateLeases.has(active.id))return {ok:false,error:'生产或体检正在运行，不能同时修改策略'};
    const skill=this.skill();
    if(!skill.ok)return {ok:false,error:skill.reason};
    const common={root:active.path,skillRoot:skill.packageDir,python:this.getConfig().pythonPath};
    let result;
    if(action==='inspect'){
      const policy=readGatePolicy(active.path);
      if(!policy||policy.invalid)return {ok:false,error:'先初始化有效的门禁策略'};
      let lease;
      try{
        lease=acquireProjectLease(active.path);this.gateLeases.set(active.id,lease);
        syncMaterialRoots(active.path,active.project,listSources(this.store),this.cacheDir());
        const declared=stageId?this.workflow(active).stages.find(stage=>stage.id===stageId):null;
        if(stageId&&!declared)throw Error('工作流中没有此检查阶段');
        const stageIds=declared?declared.inspectionStages:null;
        const checked=stageIds?.length===0?{status:'completed',results:[]}:await this.inspectGates(active.id,{...common,lease,stageIds});
        result={ok:checked.status==='completed',...checked};
      }catch(error){result={ok:false,error:error.message};}
      finally{if(lease){const error=this.releaseGateLease(active.id,lease);if(error)result={ok:false,error,status:'failed'};}}
    } else {
      const verb={init:'init-policy',migrate:'migrate-policy',recover:'recover'}[action];
      if(!verb)return {ok:false,error:'未知体检操作'};
      if(action==='recover')result=await gateCommand({...common,action:verb,mode});
      else {
        let lease;
        try{
          lease=acquireProjectLease(active.path);this.gateLeases.set(active.id,lease);
          syncMaterialRoots(active.path,active.project,listSources(this.store),this.cacheDir());
          result=await gateCommand({...common,action:verb,mode,lease});
          if(result.ok){
            const previous=active.project.skill||{};
            const pinned={root:skill.packageDir,version:skill.version||'',sha256:skill.sha256||''};
            const id=randomUUID();
            const directory=path.join(active.path,'.workbench/gates/migrations');
            fs.mkdirSync(directory,{recursive:true});
            fs.writeFileSync(path.join(directory,`pin-${id}.json`),JSON.stringify({schema:'dsa.skill-pin-migration/1',at:new Date().toISOString(),before:previous,after:pinned}),{flag:'wx'});
            const target=path.join(active.path,'project.json'),temporary=target+'.'+id+'.tmp';
            try{fs.writeFileSync(temporary,JSON.stringify({...active.project,skill:pinned,gatePolicy:{schema:'dsa.gate-policy-required/1',required:true},updatedAt:new Date().toISOString()},null,2)+'\n');fs.renameSync(temporary,target);}
            finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
          }
        }catch(error){result={ok:false,error:error.message};}
        finally{if(lease){const error=this.releaseGateLease(active.id,lease);if(error)result={ok:false,error,status:'failed'};}}
      }
    }

    this.onChange({kind:'gate-control',action,result});
    return {...result,state:this.snapshot()};
  }

  gateEvidence({stageId,gateId}={}) {
    const stage=this.snapshot().stages.find(s=>s.id===stageId);
    const gate=stage?.gateComparison?.find(g=>g.id===gateId)||stage?.gates.find(g=>g.id===gateId);
    if(!gate)return {ok:false,error:'当前阶段没有此判据'};
    return {ok:true,gate};
  }

  async inspectGates(projectId, options) {
    const controller=new AbortController();
    this.gateChecks.set(projectId,{controller,stageId:options.run?.stageId||options.stageIds?.[0]||'',startedAt:new Date().toISOString()});
    this.onChange({kind:'gate-check-start',projectId});
    try{return await inspectAfterRun({...options,signal:controller.signal});}
    finally{this.gateChecks.delete(projectId);this.onChange({kind:'gate-check-finish',projectId});}
  }

  async recoverGateLeases() {
    const skill=this.skill();if(!skill.ok)return [];
    const results=[];
    for(const project of this.store.get().projects||[]){
      if(!project.path||!fs.existsSync(path.join(project.path,'output/gates/publication.lock')))continue;
      const result=await gateCommand({root:project.path,skillRoot:skill.packageDir,python:this.getConfig().pythonPath,action:'recover'});
      results.push({projectId:project.id,...result});
    }
    if(results.length){this.onChange({kind:'gate-recovery',results});}
    return results;
  }

  gateResource({stageId,gateId,resourceId}={}) {
    const active=this.active();
    if(!active.ok)return {ok:false,error:active.error};
    const view=this.gateEvidence({stageId,gateId});
    const resource=view.gate?.resources?.find(r=>r.id===resourceId);
    if(!resource)return {ok:false,error:'当前报告中没有该证据引用'};
    try{return {ok:true,abs:resolveGateResource(active.path,active.project,resource)};}
    catch(error){return {ok:false,error:error.message};}
  }

  /** 模型审计交上来的一条问题：只写清单，不改产物。 */
  issuesForMutation(root) {
    return readGatePolicy(root)?.mode==='skill'&&fs.existsSync(safePath(root,'output/recheck/issues.jsonl'))?readIssueLedger(root):readIssues(root);
  }

  recordIssue(issue) {
    const active = this.active();
    if (!active.ok) return { ok: false, error: active.error };
    let issues;try{issues=this.issuesForMutation(active.path);}catch(error){return {ok:false,error:'问题台账损坏，先修复原始记录：'+error.message};}
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
    let issues;try{issues=this.issuesForMutation(active.path);}catch(error){return {ok:false,error:'问题台账损坏，先修复原始记录：'+error.message};}
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
    let issues;try{issues=this.issuesForMutation(active.path);}catch(error){return {ok:false,error:'问题台账损坏，先修复原始记录：'+error.message};}
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

  /**
   * 改哪个层级的文件，就从哪个阶段开始重跑。
   *
   * 依赖链：原始资料 → 审计 → 编码 → 数据集 → 全格复核 → 模型 → 图 → 文稿 → 终检。
   * 旧版漏了三件事：改 data/ 不重跑审计、改注册表/数据集不重跑全格复核、改模型产物却重跑统计
   * （会把刚套用的补丁覆盖掉）。人工步骤（verify 的 final、dataset 的宽表）不硬跑，变成等待点。
   */
  downstreamStages(file) {
    return rerunStages(this.workflow(),file);
  }

  /** 阶段有没有可执行脚本（没有 = 人工步骤，重跑链必须停下来等人）。 */
  stageRunnable(stageId) {
    const active = this.active();
    if (!active.ok) return false;
    const stage = this.stageById(stageId);
    if (!stage) return false;
    const hasScript = Boolean(stage.script) || (Array.isArray(stage.steps) && stage.steps.some((step) => step && step.script));
    if (!hasScript) return false;
    const command = this.commandFor(active.path, active.project, stage);
    return Boolean(command.ok && command.steps.length);
  }

  startChain(projectIdValue, steps, issueId) {
    const state = this.store.get();
    const chains = { ...(state.recheckChains || {}) };
    chains[projectIdValue] = {
      id: `chain-${Date.now().toString(36)}`,
      workflowHash:this.workflow().sha256,
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
    if(chain.workflowHash&&chain.workflowHash!==this.workflow().sha256){this.patchChain({status:'interrupted',error:'工作流已变化：继续时将按当前声明重新规划重跑范围'});return;}
    if (chain.index >= chain.steps.length) {
      this.patchChain({ status: 'done', index: chain.steps.length });
      return;
    }
    const stageId = chain.steps[chain.index];
    const current=this.snapshot().stages.find(stage=>stage.id===stageId);
    if(current&&['done','na'].includes(current.status)){
      this.patchChain({index:chain.index+1,waitingFor:'',error:''});setTimeout(()=>this.beginChainStep(),0);return;
    }
    // 没有脚本的阶段（dataset / recheck）是人工步骤：明确停下等人，不要 force 一个空命令，
    // 也不要「静悄悄跳过」——这两种都会让链看起来跑完了。
    if (!this.stageRunnable(stageId)) {
      const stage = this.stageById(stageId);
      this.patchChain({
        status: 'waiting',
        waitingFor: stageId,
        error: `${stage ? stage.name : stageId} 没有可执行脚本（人工步骤）：先按面板提示完成，再用 action=chain resume 继续`,
      });
      return;
    }
    // 不带 force：前置闸门没过就停下来等人看，而不是把「没过的阶段」当没事发生。
    const result = this.runStage(stageId, { force: false });
    if (!result.ok) {
      const blockers = Array.isArray(result.blockers) ? result.blockers : [];
      this.patchChain({
        status: 'waiting',
        waitingFor: stageId,
        blockers,
        error: blockers.length
          ? `${stageId} 的前置阶段未过：${blockers.join('；')}。处理后再 action=chain resume；确需跳过用 force=true`
          : `${stageId} 无法启动：${result.error}`,
      });
    }
  }

  /** 重跑链的人工续跑：resume 重新尝试当前步骤；force=true 才跳过前置闸门。 */
  resumeChain({ force = false } = {}) {
    let chain = this.chainStatus();
    if (!chain) return { ok: false, error: '没有重跑链' };
    if (chain.status === 'running') return { ok: false, error: '重跑链正在跑' };
    if (!['waiting', 'stopped', 'interrupted', 'cancelled'].includes(chain.status)) {
      return { ok: false, error: `当前状态 ${chain.status} 不需要续跑` };
    }
    const active=this.active(),workflow=this.workflow(active);
    if(chain.workflowHash&&chain.workflowHash!==workflow.sha256){
      const issue=readIssues(active.path).find(issue=>issue.id===chain.issueId);
      if(!issue?.patch?.path)return {ok:false,error:'工作流已变化，原链缺少可回查的补丁路径，无法安全重建'};
      const steps=rerunStages(workflow,issue.patch.path);
      this.patchChain({steps,index:0,workflowHash:workflow.sha256,waitingFor:'',note:'已按当前技能工作流重新规划'});
      chain=this.chainStatus();
    }
    this.patchChain({ status: 'running', error: '', blockers: [] });
    if (force) {
      // 只在这一步显式 force：用户已经看过 blockers 并决定跳过。
      const stageId = chain.steps[chain.index];
      const stage = this.stageById(stageId);
      if (stage && this.commandFor(this.active().path, this.active().project, stage).ok) {
        const result = this.runStage(stageId, { force: true });
        if (!result.ok) {
          this.patchChain({ status: 'waiting', error: result.error });
          return { ok: false, error: result.error, chain: this.chainStatus() };
        }
        return { ok: true, chain: this.chainStatus() };
      }
    }
    this.beginChainStep();
    return { ok: true, chain: this.chainStatus() };
  }

  /** 由 runner 在每次运行结束时回调。 */
  /**
   * 运行结束的回调。
   *
   * 这里没有「当前会话」，但面板可能正开着别的项目：整段放进这次运行自己的项目作用域里，
   * 否则读到的是别人项目的闸门——重跑链会据此走错下一步，或者停在莫名其妙的地方。
   */
  onRunFinished(run) {
    return this.runInProject(run && run.projectId, async () => {
      const active = this.active();
      const lease = this.gateLeases.get(run?.projectId);
      try {
        if (active.ok && readGatePolicy(active.path)) {
          const gateCheck = run.status==='cancelled'?{status:'cancelled',results:[]}:await this.inspectGates(active.id,{root: active.path, skillRoot: this.skill().packageDir, python: this.getConfig().pythonPath, run, lease});
          const state = this.store.get();
          this.store.set({runs: (state.runs || []).map(r => r.id === run.id ? {...r, gateCheck} : r)});
          this.onChange({kind: 'gate-check', runId: run.id, gateCheck});
        }
      } catch (error) {
        this.patchChain({status: 'stopped', error: '体检收尾失败，旧报告不可采信'});
        this.onChange({kind: 'gate-check', runId: run?.id, error: String(error?.message || error)});
      } finally {
        if(lease){const error=this.releaseGateLease(run.projectId,lease);if(error){this.patchChain({status:'stopped',error:'写锁收尾失败，请恢复后重新体检'});return;}}
      }
      this.applyRunToChain(run);
    });
  }

  applyRunToChain(run) {

    const chain = this.chainStatus();
    if (!chain || chain.status !== 'running') return;
    if (run.projectId && chain.projectId && run.projectId !== chain.projectId) return;
    const expected = chain.steps[chain.index];
    if (run.stageId !== expected) return;
    // 退出码不是判据，闸门才是：跑完 exit 0 但 error 级闸门 fail（例如没写 manifest）时，
    // 阶段是 blocked，链必须停，不能因为「进程成功」就当这一步过了。
    const stageState = (this.snapshot().stages || []).find((stage) => stage.id === run.stageId);
    const stageStatus = stageState?.status || '';
    if (run.status === 'skipped') {
      this.patchChain({
        status: 'waiting',
        waitingFor: run.stageId,
        error: `${run.stageId} 的步骤全部因缺条件文件被跳过：补齐后 action=chain resume`,
      });
      return;
    }
    const currentActive = this.active();
    const definition=this.stageById(run.stageId);
    const rule=definition?.afterRun||{};
    const all=this.snapshot().stages||[];
    if(rule.requireComplete!==false&&!['done','na'].includes(stageStatus)){
      this.patchChain({status:'waiting',waitingFor:run.stageId,error:rule.waitingMessage||'阶段尚未满足声明的完成要求'});return;
    }
    const missing=(rule.gates||[]).filter(id=>!all.some(stage=>stage.gates?.some(g=>g.id===id&&g.status==='pass')));
    if(missing.length){
      this.patchChain({status:'waiting',waitingFor:run.stageId,error:rule.waitingMessage||('需要完成：'+missing.join('、'))});
      return;
    }
    const gateReasons=currentActive.ok&&rule.checkpoint?reportBlockers(all,currentActive.path,rule.checkpoint,{reportStages:rule.reportStages||null}):currentActive.ok?[]:['项目不可访问'];
    if (!stageStatus || stageStatus === 'blocked' || run.status === 'cancelled' || gateReasons.length) {
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
  return defaultWorkflow().stages.map((stage) => ({
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


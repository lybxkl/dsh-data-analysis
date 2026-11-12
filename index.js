/**
 * @local/dsh-data-analysis —— 实证研究工作台（Host 半片）
 *
 * 职责：
 *   1. 登记一个 skill 包（只读），把它 scripts/ 下的脚本组织成 8 个阶段；
 *   2. 按阶段起子进程跑脚本，日志落项目的 runs/，退出状态如实记录；
 *   3. 只读解析产物（sample_flow / manifest / coef / number_issues），把闸门拆成
 *      pass / fail / unjudged 三态——判不了就说判不了；
 *   4. 给面板开同源 HTTP 路由，给模型开 data_analysis_* 工具。
 *
 * 隔离契约：skillRoot 只读，插件不复制、不 vendor、不改写 skill；每次运行记录 SKILL.md 的 sha256。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, normalizeConfig, SKILL_PACKAGE } from './src/defaults.js';
import { Store } from './src/store.js';
import { Runner } from './src/runner.js';
import { Workbench } from './src/service.js';
import { Assistant, DRAFT_TASKS } from './src/assistant.js';
import { Vision } from './src/vision.js';
import { registerTools } from './src/tools.js';
import { registerRoutes } from './src/routes.js';
import { registerPrompt } from './src/prompt.js';

export const name = 'data-analysis';

/** tools 与 webServer 是硬依赖；systemPrompt 可选，缺了只是不注入使用规则。 */
export const inject = ['tools', 'webServer'];

const ROUTE_BASE = '/data-analysis';

function hasData(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(raw?.projects) ? raw.projects.length > 0 : false;
  } catch {
    return false;
  }
}

/** 数据目录：优先选「已经有项目登记」的那个，避免宿主重启后换目录让用户以为数据丢了。 */
function resolveDataDir(config, logger) {
  if (config.dataDir) return path.resolve(String(config.dataDir));
  const homes = [];
  const push = (base) => {
    if (!base) return;
    try {
      const resolved = path.resolve(String(base));
      if (!homes.includes(resolved)) homes.push(resolved);
    } catch {
      /* ignore */
    }
  };
  push(process.env.DSH_PROFILE_DIR);
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) push(path.join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE));
  push(process.env.DSH_HOME);
  push(path.join(os.homedir(), '.dsh'));
  const dirs = homes.map((base) => path.join(base, 'data-analysis'));
  const existing = dirs.find((dir) => hasData(path.join(dir, 'data-analysis.json')));
  if (existing) {
    if (dirs[0] && existing !== dirs[0]) {
      logger?.info?.(`[data-analysis] 数据目录按已有项目选定：${existing}`);
    }
    return existing;
  }
  return dirs[0] || path.resolve(process.cwd(), '.data-analysis');
}

export function apply(ctx, rawConfig = {}) {
  const safeGet = (name) => {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };
  const logger = safeGet('logger');

  let config = normalizeConfig({ ...DEFAULT_CONFIG, ...(rawConfig || {}) });
  const dir = resolveDataDir(config, logger);
  const store = new Store({ filePath: path.join(dir, 'data-analysis.json'), logger }).load();

  // 面板里改过的设置优先于 cordis.patch.yml：用户现场改的最准
  const saved = store.get('config');
  if (saved && typeof saved === 'object') config = normalizeConfig({ ...config, ...saved });
  if (store.loadError) logger?.warn?.(`[data-analysis] 台账有问题已重建：${store.loadError}`);

  const getConfig = () => config;
  const setConfig = (patch) => {
    config = normalizeConfig({ ...config, ...(patch || {}) });
    store.set('config', config);
    store.flushSoon(50);
  };

  const runner = new Runner({
    getConfig,
    store,
    onChange: () => {
      store.flushSoon(200);
    },
  });
  // 宿主上次是异常退出的：台账里可能留着「running」，那些进程早没了
  const repaired = runner.reconcile();
  if (repaired) logger?.warn?.(`[data-analysis] ${repaired} 条遗留运行记录已标记为中断`);

  const workbench = new Workbench({
    getConfig,
    store,
    runner,
    onChange: (event) => {
      store.flushSoon(120);
      try {
        void event;
      } catch {
        /* ignore */
      }
    },
  });

  // 复核闭环：一次运行结束后，若是重跑链的当前步，由服务层推进下一步
  runner.onFinish = (run) => workbench.onRunFinished(run);

  // 重跑链的回调不会跨进程回来：留在 running 的链会把「套用」永久挡住，这里统一标中断
  const interrupted = workbench.recoverChains();
  if (interrupted) logger?.warn?.(`[data-analysis] ${interrupted} 条重跑链已标记为中断`);

  // LLM 桥：用宿主自己的模型选择（agentDefaultModel）与 llm 服务起草文本。
  // 缺服务时只降级，不让插件挂掉——面板会显示「模型不可用」而不是白屏。
  const assistant = new Assistant({
    getConfig,
    getActive: () => workbench.active(),
    llm: safeGet('llm'),
    agentDefaultModel: safeGet('agentDefaultModel'),
    attachments: safeGet('attachments'),
    logger,
  });

  // 材料库的识图执行器：扫描件与图片才需要它，且只被工具显式调用（不做自动流水线）。
  // 它持有「当前任务」状态，必须是单例；缓存目录跟着台账走，改 dataDir 后自动换位置。
  const vision = new Vision({
    getConfig,
    getCacheDir: () => workbench.cacheDir(),
    logger,
    assistant,
  });
  workbench.materials = { vision };

  // updateConfig 走 store，这里把「内存配置」同步回 workbench 的读取源；
  // dataDir 变了要换成另一份台账，否则「改了目录但项目列表还是旧的」。
  const originalUpdate = workbench.updateConfig.bind(workbench);
  workbench.updateConfig = async (patch) => {
    const touchesDataDir = patch && Object.prototype.hasOwnProperty.call(patch, 'dataDir');
    const result = originalUpdate(patch);
    if (result.ok) setConfig(result.config);
    if (result.ok && touchesDataDir) {
      const targetFile = path.join(resolveDataDir(result.config, logger), 'data-analysis.json');
      if (path.resolve(targetFile) !== path.resolve(store.filePath)) {
        await store.rebase(targetFile);
        // 新台账里可能留着旧配置；以用户刚提交的为准
        config = result.config;
        store.set('config', config);
        store.flushSoon(50);
      }
    }
    return { ...result, config };
  };

  const disposeTools = registerTools(ctx, workbench, { logger, assistant });
  const disposeRoutes = registerRoutes(ctx, workbench, { logger, basePath: ROUTE_BASE, assistant, tasks: DRAFT_TASKS });
  const disposePrompt = registerPrompt(ctx, { logger });

  ctx.effect(() => () => {
    try {
      disposePrompt?.();
    } catch {
      /* ignore */
    }
    try {
      disposeTools?.();
    } catch {
      /* ignore */
    }
    try {
      disposeRoutes?.();
    } catch {
      /* ignore */
    }
    try {
      runner.killAll();
    } catch {
      /* ignore */
    }
    try {
      store.flush();
    } catch {
      /* ignore */
    }
  }, 'data-analysis: lifecycle');

  // 启动自检：后台跑（不阻塞宿主启动），结果会出现在面板顶部与 data_analysis_doctor。
  // 它只读探测，不装任何东西；skill 没配好或 python 缺失都会如实记下来，而不是等第一次运行才报错。
  void workbench
    .ensurePreflight()
    .then((pre) => {
      const label = pre.status === 'pass' ? '通过' : pre.status === 'warn' ? '可用但有降级' : '未通过';
      const problems = (pre.checks || [])
        .filter((item) => item.status === 'fail')
        .map((item) => `${item.label}：${item.detail}`)
        .join('；');
      logger?.info?.(`[data-analysis] 环境自检${label}${pre.python ? ` · Python ${pre.python}` : ''}${problems ? `；${problems}` : ''}`);
    })
    .catch(() => {});

  const skill = workbench.skill();
  logger?.info?.(
    skill.ok
      ? `[data-analysis] 已启动，skill ${skill.version}（${skill.scripts.length} 脚本）· 台账 ${dir}`
      : `[data-analysis] 已启动，但 skill 未就位：${skill.reason}（在面板或 data_analysis_configure 里设置 skillRoot，期望包含 ${SKILL_PACKAGE}）`,
  );
}
/**
 * @local/dsh-data-analysis —— 只读渲染层（Host 半片）。
 *
 * 绑定一个研究产物目录 → 通用文件查看器（output/ 产物 + scripts/ 代码 + 目录进度）。
 * 不注入系统提示、不运行脚本、不写研究目录、不做闸门/判定/解释。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from './src/store.js';
import { Viewer } from './src/viewer.js';
import { WorkspaceService } from './src/workspace.js';
import { registerTools } from './src/tools.js';
import { registerRoutes } from './src/routes.js';

export const name = 'data-analysis';

export const inject = ['tools', 'webServer'];

const ROUTE_BASE = '/data-analysis';

function normalizeConfig(raw) {
  const dataDir = raw && typeof raw.dataDir === 'string' ? raw.dataDir.trim() : '';
  return { dataDir };
}

function hasData(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(raw?.workspaces) ? raw.workspaces.length > 0 : false;
  } catch {
    return false;
  }
}

/** 数据目录：优先选「已经有工作区登记」的那个，避免宿主重启后换目录让用户以为数据丢了。 */
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
      logger?.info?.(`[data-analysis] 数据目录按已有工作区选定：${existing}`);
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

  let config = normalizeConfig(rawConfig);
  const dir = resolveDataDir(config, logger);
  const store = new Store({ filePath: path.join(dir, 'data-analysis.json'), logger }).load();

  // 面板里改过的设置次之：显式配置优先，只有它为空时才用台账里保存的值
  const savedConfig = normalizeConfig(store.get('config'));
  config = normalizeConfig({ dataDir: config.dataDir || savedConfig.dataDir });
  if (store.loadError) logger?.warn?.(`[data-analysis] 台账有问题已重建：${store.loadError}`);

  const getConfig = () => config;

  const setDataDir = async (value) => {
    config = normalizeConfig({ dataDir: value });
    const target = path.join(resolveDataDir(config, logger), 'data-analysis.json');
    if (path.resolve(target) !== path.resolve(store.filePath)) {
      await store.rebase(target);
      // 新台账里可能留着旧配置；以用户刚提交的为准
      config = normalizeConfig({ dataDir: value });
    }
    store.set('config', config);
    store.flushSoon(50);
    return config;
  };

  const viewer = new Viewer({ store });
  const workspace = new WorkspaceService({ store, viewer });

  const disposeTools = registerTools(ctx, workspace, { logger });
  const disposeRoutes = registerRoutes(ctx, { store, viewer, workspace }, {
    logger,
    basePath: ROUTE_BASE,
    getConfig,
    setDataDir,
  });

  ctx.effect(() => () => {
    try {
      disposeTools?.forEach?.((dispose) => {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    try {
      disposeRoutes?.();
    } catch {
      /* ignore */
    }
    try {
      store.flush();
    } catch {
      /* ignore */
    }
  }, 'data-analysis: lifecycle');

  logger?.info?.(`[data-analysis] 已启动（只读查看器）· 工作区 ${workspace.workspaces().length} 个 · 台账 ${dir}`);
}
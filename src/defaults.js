/**
 * 配置与阶段登记表。
 *
 * 设计约束（来自 PRODUCT.md 与 skills/empirical-research-pipeline 的隔离契约）：
 *   - 插件单向依赖 skill，只读 skillRoot；一切脚本调用走子进程。
 *   - 阶段登记表是「数据」，不是 10 个写死的按钮：脚本、参数、产物都能在面板里改，
 *     模型现场写的新脚本也能登记进来（改 project.json 的 stages[].args / script 即可）。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultWorkflow } from './workflow.js';

/** 各平台最常见的 Python 命令：Windows 上是 python，macOS/Linux 上只有 python3。 */
export const DEFAULT_PYTHON = process.platform === 'win32' ? 'python' : 'python3';

export const DEFAULT_CONFIG = {
  skillRoot: '',
  dataDir: '',
  pythonPath: DEFAULT_PYTHON,
  maxRuns: 60,
  maxLogLines: 800,
  // 起草用的模型：follow = 跟随 DSH 当前的默认模型选择；custom = 面板里指定 provider/model
  modelMode: 'follow',
  modelProvider: '',
  modelId: '',
  assistantMaxTokens: 1800,
};

/** skill 包名：真脚本在 <skillRoot>/<SKILL_PACKAGE>/scripts/*.py。 */
export const SKILL_PACKAGE = 'empirical-research-pipeline';

/** Compatibility exports read the skill spec; there is no host-owned stage table. */
export function defaultStages(){return defaultWorkflow(SKILL_CANDIDATES).stages;}
export const STAGE_DEFS=new Proxy([], {get(_target,key){const stages=defaultStages();const value=Reflect.get(stages,key);return typeof value==='function'?value.bind(stages):value;}});
export const STAGE_BY_ID={get(id){return defaultStages().find(stage=>stage.id===id)||null;}};

/** 已知的 skill 目录候选：用户没配 skillRoot 时按顺序探测。 */
export const SKILL_CANDIDATES = [
  // DSH 发现技能的位置（安装方法见 README）：用户级 ~/.agents/skills、~/.dsh/skills
  join(homedir(), '.agents', 'skills', SKILL_PACKAGE),
  join(homedir(), '.dsh', 'skills', SKILL_PACKAGE),
  join(homedir(), '.agents', 'skills', 'SPSS-Style-Charting-Skill', SKILL_PACKAGE),
  // 手动 clone 到常见位置
  join(homedir(), 'SPSS-Style-Charting-Skill'),
  join(homedir(), 'SPSS-Style-Charting-Skill', SKILL_PACKAGE),
  // 开发机上的固定路径（老配置兜底）
  'F:\\测试文件\\SPSS-Style-Charting-Skill',
  'F:\\测试文件\\SPSS-Style-Charting-Skill\\empirical-research-pipeline',
];

function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function normalizeConfig(raw = {}) {
  const merged = { ...DEFAULT_CONFIG, ...(raw || {}) };
  const mode = str(merged.modelMode, 'follow').trim() === 'custom' ? 'custom' : 'follow';
  return {
    skillRoot: str(merged.skillRoot).trim(),
    dataDir: str(merged.dataDir).trim(),
    pythonPath: str(merged.pythonPath, DEFAULT_PYTHON).trim() || DEFAULT_PYTHON,
    maxRuns: num(merged.maxRuns, 60, 5, 500),
    maxLogLines: num(merged.maxLogLines, 800, 100, 5000),
    modelMode: mode,
    modelProvider: str(merged.modelProvider).trim(),
    modelId: str(merged.modelId).trim(),
    assistantMaxTokens: num(merged.assistantMaxTokens, 1800, 256, 8000),
  };
}

/** 把默认参数里的相对路径锚到项目根目录，返回真实 argv。 */
export function resolveArgs(args, project) {
  const map = {
    '{dataDir}': project.dataDir,
    '{outputDir}': project.outputDir,
    '{projectRoot}': project.root,
  };
  return (args || []).map((arg) => {
    let out = String(arg);
    for (const [key, value] of Object.entries(map)) {
      out = out.split(key).join(value);
    }
    return out;
  });
}

export { str, num };

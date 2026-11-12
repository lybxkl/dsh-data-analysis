/**
 * 配置与阶段登记表。
 *
 * 设计约束（来自 PRODUCT.md 与 skills/empirical-research-pipeline 的隔离契约）：
 *   - 插件单向依赖 skill，只读 skillRoot；一切脚本调用走子进程。
 *   - 阶段登记表是「数据」，不是 11 个写死的按钮：脚本、参数、产物都能在面板里改，
 *     模型现场写的新脚本也能登记进来（改 project.json 的 stages[].args / script 即可）。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

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

/**
 * 9 个阶段。args 是默认参数模板；{dataDir}/{outputDir}/{projectRoot} 运行时替换。
 * script 为 null 表示这一步由人/模型完成（例如写 scope、拼分析宽表），面板只做验收。
 */
export const STAGE_DEFS = [
  {
    id: 'scope',
    index: 1,
    name: '范围与口径',
    short: '范围',
    purpose: '研究问题、时间窗、纳入/排除标准写成 docs/scope.md',
    script: null,
    args: [],
    artifacts: ['docs/scope.md'],
  },
  {
    id: 'audit',
    index: 2,
    name: '资料审计',
    short: '审计',
    purpose: '逐份文件的可读性、重复、类型与字数审计，产出 sample_flow 与 corpus_files',
    script: 'scripts/audit_corpus.py',
    args: ['--root', 'data', '--out-dir', 'output/audit', '--min-chars', '100'],
    artifacts: ['output/audit/sample_flow.csv', 'output/audit/corpus_summary.json'],
  },
  {
    id: 'coding',
    index: 3,
    name: '编码与抽取',
    short: '编码',
    purpose: '按 profile 生成编码表；加 --extract 时落 dataset.csv 与 evidence.jsonl',
    script: 'scripts/make_coding_sheet.py',
    args: ['--root', 'data', '--out', 'output/coding'],
    artifacts: ['output/coding/coding_sheet.csv', 'output/coding/sample_flow.csv'],
  },
  {
    id: 'dataset',
    index: 4,
    name: '数据集',
    short: '数据集',
    purpose: '分析宽表 output/dataset/analysis.csv（一行一个分析单位，含 in_analysis 标记）',
    script: null,
    args: [],
    artifacts: ['output/dataset/analysis.csv'],
  },
  {
    id: 'stats',
    index: 5,
    name: '统计分析',
    short: '统计',
    purpose: '描述统计 + 回归 + 诊断，产出 coef_*.csv 与 model_meta.json',
    script: 'scripts/auto_stats.py',
    args: ['--data', 'output/dataset/analysis.csv', '--out', 'output/models'],
    // 项目根上有配置文件时自动带上：不传 --config 统计脚本会瞎猜结局变量，
    // 不传 --spec 则一张模型表都不产出（重跑一次就把已有模型洗掉）。
    optionalArgs: [
      { flag: '--config', file: 'chart_config.json' },
      { flag: '--spec', file: 'model_spec.json' },
    ],
    artifacts: ['output/models/model_meta.json'],
  },
  {
    id: 'figures',
    index: 6,
    name: '出版级图表',
    short: '图表',
    purpose: '全景图表包与 chart_manifest.csv（dpi / px_width / N / 调色板）',
    script: 'scripts/auto_chart_pack.py',
    args: ['--data', 'output/dataset/analysis.csv', '--out', 'output/chart_pack'],
    // 有 chart_config.json 就带上：不传的话脚本无法推断结局变量，直接退出 2。
    optionalArgs: [{ flag: '--config', file: 'chart_config.json' }],
    artifacts: ['output/chart_pack/chart_manifest.csv'],
  },
  {
    id: 'manuscript',
    index: 7,
    name: '文稿组装',
    short: '文稿',
    purpose: '按 spec 组装正文、图表与题注',
    script: 'scripts/assemble_manuscript.py',
    // --spec 是必填项：没有 manuscript.json 时让脚本自己报「spec not found」，比 argparse 的用法错误可读
    args: ['--spec', 'manuscript.json', '--out', 'output/manuscript.docx'],
    artifacts: ['output/manuscript.docx'],
  },
  {
    id: 'qa',
    index: 8,
    name: '终检',
    short: '终检',
    purpose: '图表合规 + 数字溯源 + 交付清单，任何未过项都不许报成功',
    script: 'scripts/qa_outputs.py',
    // 终检要跑两步：qa_outputs 出合规报告，verify_numbers 出数字溯源。
    // --exit-zero：让「跑完了」与「有没有过」分开，过没过由闸门读报告决定。
    steps: [
      {
        script: 'scripts/qa_outputs.py',
        args: [
          '--docx', 'output/manuscript.docx',
          '--data', 'output/dataset/analysis.csv',
          '--figures', 'output/chart_pack/figures',
          '--manifest', 'output/chart_pack/chart_manifest.csv',
          '--audit', 'output/audit/corpus_files.csv',
          '--min-dpi', '600',
          '--out', 'output/qa/qa_report.json',
          '--exit-zero',
        ],
        continueOnError: true,
      },
      {
        script: 'scripts/verify_numbers.py',
        args: [
          '--out', 'output/verify',
          '--tables', 'output/models',
          '--figures-manifest', 'output/chart_pack/chart_manifest.csv',
          '--sample-flow', 'output/audit/sample_flow.csv',
          '--docx', 'output/manuscript.docx',
        ],
      },
    ],
    args: [
      '--docx', 'output/manuscript.docx',
      '--data', 'output/dataset/analysis.csv',
      '--figures', 'output/chart_pack/figures',
      '--manifest', 'output/chart_pack/chart_manifest.csv',
      '--audit', 'output/audit/corpus_files.csv',
      '--min-dpi', '600',
      '--out', 'output/qa/qa_report.json',
      '--exit-zero',
    ],
    artifacts: ['output/qa/qa_report.json', 'output/verify/number_issues.csv'],
  },
  {
    id: 'recheck',
    index: 9,
    name: '复核与修订',
    short: '复核',
    purpose: '机器复算 + 交叉核对 + 模型审计，问题逐条可裁定，修完重跑受影响阶段',
    script: null,
    args: [],
    artifacts: ['output/recheck/issues.jsonl', 'output/recheck/coverage.json', 'output/recheck/report.md'],
  },
];

export const STAGE_BY_ID = new Map(STAGE_DEFS.map((stage) => [stage.id, stage]));

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

/**
 * 技能契约测试：插件登记的每个参数、每个产物、每个读取的字段，都必须在 skill 里真实存在。
 *
 * 这一条是 2026-11-13 那次 skill 升级的直接产物：插件里 10 个阶段、二十多条参数全是硬编码字符串，
 * skill 改了 CLI 或改了产物列名之后，现有测试**一条都不会失败**——面板照样显示绿灯，
 * 直到某个项目跑到一半报「unrecognized arguments」。
 *
 * 做法：从 STAGE_DEFS 里把 args / optionalArgs / optionalFlags 的 --flag 全抽出来，
 * 对照脚本源码里的 add_argument()；再核对几个「闸门读的字段」确实是脚本写出来的。
 *
 * 跑法：node tests/skill-contract.test.mjs
 * 找不到技能包时整份跳过（不把「没装 skill」判成插件坏了）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKILL_CANDIDATES, SKILL_PACKAGE, STAGE_DEFS } from '../src/defaults.js';
import { resolveSkillRoot } from '../src/skill.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
const problems = [];

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    problems.push({ name, message: String(error && error.message ? error.message : error) });
    process.stdout.write(`  ✗ ${name} — ${error?.message || error}\n`);
  }
}

function readIf(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** argparse 声明的长参数：add_argument("--flag", ...) / add_argument('--flag', ...) */
function declaredFlags(source) {
  const flags = new Set();
  const pattern = /add_argument\(\s*["'](--[A-Za-z0-9-]+)["']/g;
  let match = pattern.exec(source);
  while (match) {
    flags.add(match[1]);
    match = pattern.exec(source);
  }
  return flags;
}

/** 阶段里所有会被拼进 argv 的 --flag。 */
function stageFlags(def) {
  const flags = [];
  const push = (args) => {
    for (const arg of Array.isArray(args) ? args : []) {
      const text = String(arg || '');
      if (text.startsWith('--')) flags.push(text);
    }
  };
  push(def.args);
  for (const step of Array.isArray(def.steps) ? def.steps : []) push(step.args);
  for (const opt of Array.isArray(def.optionalArgs) ? def.optionalArgs : []) if (opt?.flag) flags.push(opt.flag);
  for (const opt of Array.isArray(def.optionalFlags) ? def.optionalFlags : []) if (opt?.flag) flags.push(opt.flag);
  for (const step of Array.isArray(def.steps) ? def.steps : []) {
    for (const opt of Array.isArray(step.optionalArgs) ? step.optionalArgs : []) if (opt?.flag) flags.push(opt.flag);
    for (const opt of Array.isArray(step.optionalFlags) ? step.optionalFlags : []) if (opt?.flag) flags.push(opt.flag);
  }
  return [...new Set(flags)];
}

/** 阶段里出现的所有脚本（主脚本 + steps）。 */
function stageScripts(def) {
  const scripts = new Set();
  if (def.script) scripts.add(def.script);
  for (const step of Array.isArray(def.steps) ? def.steps : []) {
    if (step?.script) scripts.add(step.script);
  }
  return [...scripts];
}

const configured = process.env.DATA_ANALYSIS_SKILL_ROOT || process.env.SKILL_ROOT || '';
const skill = resolveSkillRoot(configured);

if (!skill.ok) {
  process.stdout.write('\n技能契约测试：没找到技能包，整份跳过\n');
  process.stdout.write(`  探测过：${[...SKILL_CANDIDATES, configured].filter(Boolean).join('、') || '(空)'}\n`);
  process.stdout.write('  设 DATA_ANALYSIS_SKILL_ROOT 指向技能包（或仓库根）后再跑。\n\n');
  process.exit(0);
}

const packageDir = skill.packageDir;
const scriptsDir = path.join(packageDir, 'scripts');

process.stdout.write(`\n技能契约测试（${packageDir}）\n\n`);

check('阶段登记表每个脚本都在技能包里', () => {
  const missing = [];
  for (const def of STAGE_DEFS) {
    for (const script of stageScripts(def)) {
      if (script.startsWith('assets/')) continue; // 插件自带适配器，不属于 skill
      const abs = path.join(packageDir, script);
      if (!fs.existsSync(abs)) missing.push(`${def.id}: ${script}`);
    }
  }
  if (missing.length) throw new Error(`脚本不存在：${missing.join('、')}`);
});

check('每个阶段参数都被对应脚本的 argparse 接受', () => {
  const unknown = [];
  for (const def of STAGE_DEFS) {
    for (const script of stageScripts(def)) {
      const source = readIf(path.join(packageDir, script));
      if (!source) continue;
      const flags = declaredFlags(source);
      // 同一个阶段里的 optionalArgs 可能属于主脚本，而 step 的参数属于 step 脚本；
      // 这里按「单个脚本必须认识该阶段全部 flag」会误报，所以只在脚本自己出现在
      // args 的那一步上比对。做法：逐脚本收集它真正会收到的 flag。
      const tokens = [];
      const collect = (args) => {
        for (const arg of Array.isArray(args) ? args : []) {
          const text = String(arg || '');
          if (text.startsWith('--')) tokens.push(text);
        }
      };
      if (def.script === script) {
        collect(def.args);
        for (const opt of Array.isArray(def.optionalArgs) ? def.optionalArgs : []) if (opt?.flag) tokens.push(opt.flag);
        for (const opt of Array.isArray(def.optionalFlags) ? def.optionalFlags : []) if (opt?.flag) tokens.push(opt.flag);
      }
      for (const step of Array.isArray(def.steps) ? def.steps : []) {
        if (step?.script !== script) continue;
        collect(step.args);
        for (const opt of Array.isArray(step.optionalArgs) ? step.optionalArgs : []) if (opt?.flag) tokens.push(opt.flag);
        for (const opt of Array.isArray(step.optionalFlags) ? step.optionalFlags : []) if (opt?.flag) tokens.push(opt.flag);
      }
      for (const flag of new Set(tokens)) {
        if (!flags.has(flag)) unknown.push(`${def.id}/${path.basename(script)} ${flag}`);
      }
    }
  }
  if (unknown.length) throw new Error(`脚本不认识的参数：${unknown.join('、')}`);
});

check('阶段声明的产物名与脚本写出的一致（关键几件）', () => {
  const expectations = [
    ['scripts/audit_corpus.py', ['sample_flow.csv', 'corpus_summary.json', 'corpus_files.csv']],
    ['scripts/make_coding_sheet.py', ['skipped_documents.csv', 'coding_sheet.csv']],
    ['scripts/verify_dataset.py', ['dataset_verification.json', 'cell_issues.csv', 'verification_snapshot.json']],
    ['scripts/verify_numbers.py', ['number_issues.csv', 'run.json']],
    ['scripts/check_decisions.py', ['decision_issues.csv']],
  ];
  const missing = [];
  for (const [script, names] of expectations) {
    const source = readIf(path.join(packageDir, script));
    for (const name of names) {
      if (!source.includes(name)) missing.push(`${path.basename(script)} → ${name}`);
    }
  }
  if (missing.length) throw new Error(`脚本里找不到产物名：${missing.join('、')}`);
});

check('闸门读取的字段确实是脚本写出来的', () => {
  const qa = readIf(path.join(packageDir, 'scripts', 'qa_outputs.py'));
  const verify = readIf(path.join(packageDir, 'scripts', 'verify_numbers.py'));
  const chart = readIf(path.join(packageDir, 'scripts', 'auto_chart_pack.py'));
  const coding = readIf(path.join(packageDir, 'scripts', 'make_coding_sheet.py'));
  const manuscript = readIf(path.join(packageDir, 'scripts', 'assemble_manuscript.py'));
  const missing = [];
  // qa_report.checks.figures.pdfs[].min_fontsize_effective —— fig-font 的唯一实测来源
  for (const field of ['min_fontsize_effective', 'font_verified_image_hashes', 'pdfs']) {
    if (!qa.includes(field)) missing.push(`qa_outputs.py 缺 ${field}`);
  }
  // verify_numbers 的 run.json 版本：V-05 的新旧口径靠它区分
  for (const field of ['SCRIPT_VERSION', '"version"', 'n_dropna']) {
    if (!verify.includes(field)) missing.push(`verify_numbers.py 缺 ${field}`);
  }
  const version = (verify.match(/SCRIPT_VERSION\s*=\s*["']([0-9.]+)["']/) || [])[1] || '0.0.0';
  const parts = version.split('.').map(Number);
  if (!(parts[0] > 1 || (parts[0] === 1 && (parts[1] > 0 || (parts[1] === 0 && parts[2] >= 1))))) {
    missing.push(`verify_numbers.py 版本 ${version} 早于 1.0.1（V-05 仍会用 n_dropna 当 N）`);
  }
  // 图表清单：status / n_scope / px_width 是 fig-* 闸门的分母与字号依据
  for (const field of ['status', 'n_scope', 'px_width']) {
    if (!chart.includes(field)) missing.push(`auto_chart_pack.py 缺 ${field}`);
  }
  // 漏斗 kind：excluded 行不能参与单调性判断
  if (!coding.includes('"kind"') && !coding.includes("'kind'")) missing.push('make_coding_sheet.py 没有 sample_flow.kind 列');
  // 手稿表的列选择字段
  if (!manuscript.includes('columns')) missing.push('assemble_manuscript.py 没有 columns 字段');
  if (missing.length) throw new Error(missing.join('；'));
});

check('阶段序号连续且唯一（1..N）', () => {
  const indexes = STAGE_DEFS.map((def) => def.index).sort((a, b) => a - b);
  indexes.forEach((value, at) => {
    if (value !== at + 1) throw new Error(`阶段序号不连续：${indexes.join(',')}`);
  });
  if (STAGE_DEFS.length !== indexes.length) throw new Error('有阶段缺 index');
});

check('source 类的闸门都有对应的 stage 定义', () => {
  const ids = new Set(STAGE_DEFS.map((def) => def.id));
  for (const required of ['verify', 'qa', 'recheck']) {
    if (!ids.has(required)) throw new Error(`缺阶段 ${required}`);
  }
});

const skillName = path.basename(packageDir);
if (skillName !== SKILL_PACKAGE) {
  process.stdout.write(`  注意：技能包目录名是 ${skillName}，与 SKILL_PACKAGE=${SKILL_PACKAGE} 不同（不影响运行）\n`);
}

process.stdout.write(failed ? `\n✗ ${failed} 条失败\n\n` : '\n✓ 技能契约全部对得上\n\n');
if (failed) process.exit(1);

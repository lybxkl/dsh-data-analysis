/**
 * 第 9 阶段「复核与修订」：把「让模型再看一遍」拆成三件可验证的事。
 *
 *   L1 机器复算  —— 这里：行数闭合、模型 N、图与数据的先后、脚本里的静默丢样。
 *   L2 交叉核对  —— 这里：图注 N、正文数字（复用 verify_numbers）、文稿图表数。
 *   L3 模型审计  —— 不是这里：模型只把结论写成 issues.jsonl / coverage.json / report.md，
 *                    每条问题都要带定位与证据；修不修由人裁定。
 *
 * 这个文件不执行任何用户代码，只读产物与项目脚本。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  analysisFile,
  readCsv,
  readFigures,
  readModels,
  readQaReports,
  readVerify,
  statOf,
} from './audit.js';

/** 复核清单：固定 12 项，缺一项就是「没有复核」，不是「没问题」。 */
export const RECHECK_ITEMS = [
  { id: 'R1', label: '数据血缘闭合', why: 'dataset.csv 的每一条是否都进了 analysis.csv（或写明排除）' },
  { id: 'R2', label: 'in_analysis 真的生效', why: '统计与图表是否引用了筛选条件，而不是吃进全部行' },
  { id: 'R3', label: '模型 N 对得上', why: 'fit.csv 的 n 不能大于分析样本，缺失掉的行走缺失处理' },
  { id: 'R4', label: '图是当前数据画的', why: 'manifest 的 data_hash 一致，且图不比 analysis.csv 旧' },
  { id: 'R5', label: '图注 N 与样本一致', why: '图上写的 N 不能是另一版数据的 N' },
  { id: 'R6', label: '图注带 N', why: '图注没有 N 的图，读者无法判断样本' },
  { id: 'R7', label: '数字溯源', why: '正文/图注的数字能在表格里找到同值单元格' },
  { id: 'R8', label: '项目脚本可解释', why: 'dropna / 静默 except / 覆盖写，是不是会把样本吃掉' },
  { id: 'R9', label: '终检报告无 error', why: 'qa_outputs 的 error_count 必须为 0' },
  { id: 'R10', label: '文稿图表数对得上', why: 'docx 内嵌图数与文稿 spec 的 figure 块一致' },
  { id: 'R11', label: '产物是最新运行写的', why: '产物时间早于运行开始，说明它是旧文件' },
  { id: 'R12', label: '覆盖表完整', why: '12 项逐项写 checked / unchecked（附理由）' },
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function fileHash(file) {
  try {
    return `sha256:${sha256(fs.readFileSync(file))}`;
  } catch {
    return '';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listPy(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.py'));
  } catch {
    return [];
  }
}

function num(value) {
  const n = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function check(id, status, detail, evidence = '') {
  const meta = RECHECK_ITEMS.find((item) => item.id === id) || { label: id };
  return { id, label: meta.label, why: meta.why, status, detail, evidence };
}

/* ------------------------------ 单项检查 ------------------------------ */

function readDataset(projectRoot) {
  return readCsv(path.join(projectRoot, 'output/coding/dataset.csv'));
}

function readAnalysis(projectRoot) {
  return readCsv(analysisFile(projectRoot).abs);
}

function rowKeys(csv, preferred) {
  if (!csv || !csv.rows.length) return [];
  const header = csv.header;
  const key = preferred.find((name) => header.includes(name)) || header[0];
  return csv.rows.map((row) => String(row[key] || '').trim()).filter(Boolean);
}

export function inAnalysisCount(analysis) {
  if (!analysis || !analysis.header.includes('in_analysis')) return null;
  return analysis.rows.filter((row) => String(row.in_analysis).trim() === '1').length;
}

function checkR1(projectRoot) {
  const dataset = readDataset(projectRoot);
  const analysis = readAnalysis(projectRoot);
  if (!dataset || !dataset.rows.length) return check('R1', 'unjudged', '缺 output/coding/dataset.csv：没有可核对的上游');
  if (!analysis || !analysis.rows.length) return check('R1', 'unjudged', '缺 analysis.csv（output/dataset/ 或 data/）：没有下游宽表');
  const upstream = rowKeys(dataset, ['rel_path', 'file', 'doc_id']);
  const downstream = rowKeys(analysis, ['rel_path', 'doc_id', 'file', 'record_id']);
  if (!upstream.length || !downstream.length) return check('R1', 'unjudged', '两边都缺可作主键的列（rel_path/file/document id）');
  const downSet = new Set(downstream);
  const lost = upstream.filter((key) => !downSet.has(key) && !analysis.rows.some((row) => String(row.record_id || '') === key));
  const lostNote = lost.length
    ? `dataset 有 ${lost.length} 条不在 analysis 里（例：${lost.slice(0, 3).join('、')}）`
    : `dataset ${upstream.length} 条全部能在 analysis 找到`;
  // analysis 可能是合法子集（in_analysis=0），但必须能从 analysis 自己的行里看出来
  if (lost.length && !analysis.header.includes('in_analysis')) {
    return check('R1', 'fail', `${lostNote}，而 analysis 没有 in_analysis 标记，无法说明是被排除还是被丢掉`, lost.slice(0, 10).join('\n'));
  }
  if (lost.length) return check('R1', 'unjudged', `${lostNote}；需要人确认这些行属于「排除」而不是「丢样」`, lost.slice(0, 10).join('\n'));
  return check('R1', 'pass', lostNote);
}

function checkR2(projectRoot) {
  const analysis = readAnalysis(projectRoot);
  if (!analysis || !analysis.rows.length) return check('R2', 'unjudged', '缺 analysis.csv');
  if (!analysis.header.includes('in_analysis')) {
    return check('R2', 'fail', 'analysis.csv 没有 in_analysis 列：统计与图表无法只吃纳入样本');
  }
  const values = new Set(analysis.rows.map((row) => String(row.in_analysis).trim()));
  const mixed = values.has('0') && values.has('1');
  if (!mixed) return check('R2', 'pass', '全部行都是纳入样本，不存在混合筛选');
  // 与 dataset-in-analysis 闸门同一口径：model_spec.json 或 chart_config.json 任一引用即可，
  // 只认其中一个会在这两个文件分开放的时候假报 fail（而 recheck-machine 是 error 级，会卡住复核）。
  const configNames = ['model_spec.json', 'chart_config.json'].filter((name) => statOf(path.join(projectRoot, name)).exists);
  if (!configNames.length) {
    return check('R2', 'unjudged', '存在 in_analysis=0 的行，但还没有 model_spec.json / chart_config.json：判不了统计与图表会不会吃回去');
  }
  const hits = [];
  for (const name of configNames) {
    const text = (() => {
      try {
        return fs.readFileSync(path.join(projectRoot, name), 'utf8');
      } catch {
        return '';
      }
    })();
    if (text.includes('in_analysis')) hits.push(name);
  }
  if (hits.length) {
    return check('R2', 'pass', `存在 in_analysis=0 的行，${hits.join('、')} 已引用 in_analysis`);
  }
  return check('R2', 'fail', `存在 in_analysis=0 的行，但 ${configNames.join('、')} 都没有引用 in_analysis：统计与图表会把排除样本吃回去`);
}

function checkR3(projectRoot) {
  const models = readModels(projectRoot);
  const analysis = readAnalysis(projectRoot);
  const included = inAnalysisCount(analysis);
  if (!models.models.length) return check('R3', 'unjudged', '没有 coef_*.csv：还没跑统计或没有模型');
  const fits = models.models.map((m) => ({ id: m.id, n: m.fitN ?? m.n }));
  const unknown = fits.filter((f) => !Number.isFinite(f.n));
  if (unknown.length) return check('R3', 'unjudged', `模型 ${unknown.map((f) => f.id).join('、')} 的 fit.n 读不到`);
  // 没有 in_analysis 就没有「纳入样本」这个分母：比较集合为空不等于比过了。
  if (included === null) return check('R3', 'unjudged', 'analysis.csv 没有 in_analysis（或还没有 analysis.csv）：无法确定纳入样本数，N 比不了');
  const over = fits.filter((f) => f.n > included);
  if (over.length) {
    return check('R3', 'fail', `模型 ${over.map((f) => `${f.id} N=${f.n}`).join('、')} 大于纳入样本 ${included}`);
  }
  const fitRow = models.fits[0];
  const dropped = Number.isFinite(fitRow?.nDropna) ? fitRow.nDropna : null;
  const detail = `${fits.map((f) => `${f.id} N=${f.n}`).join('、')}${included === null ? '' : `，纳入样本 ${included}`}`
    + (dropped ? `；缺失剔除 ${dropped} 行（需在正文说明）` : '');
  return check('R3', dropped ? 'unjudged' : 'pass', detail);
}

/** 图表清单只认 readFigures 命中的那一份：自己另维护一份候选表，会出现「找到 A、读的是 B」。 */
function figuresInfo(projectRoot) {
  const figures = readFigures(projectRoot);
  if (!figures?.file) return { rel: '', abs: '', rows: [] };
  return { rel: figures.file, abs: path.join(projectRoot, figures.file), rows: figures.rows || [] };
}

function checkR4(projectRoot) {
  const figures = figuresInfo(projectRoot);
  const analysis = analysisFile(projectRoot).abs;
  if (!figures.rows.length) return check('R4', 'unjudged', '没有图表清单：还没生成图');
  const hashes = [...new Set(figures.rows.map((row) => row.dataHash).filter(Boolean))];
  if (hashes.length > 1) return check('R4', 'fail', `同一份清单里出现 ${hashes.length} 个 data_hash：图不是一次画出来的`);
  if (!hashes.length) return check('R4', 'unjudged', '清单没有 data_hash 列：无法证明图对应哪版数据');
  const analysisStat = statOf(analysis);
  const manifestStat = statOf(figures.abs);
  if (analysisStat.exists && manifestStat.exists && manifestStat.mtimeMs + 1000 < analysisStat.mtimeMs) {
    return check('R4', 'fail', 'analysis.csv 比图表清单新：图是旧数据画的，需要重跑图表', `analysis ${new Date(analysisStat.mtimeMs).toISOString()} / manifest ${new Date(manifestStat.mtimeMs).toISOString()}`);
  }
  return check('R4', 'pass', `data_hash=${hashes[0]}，图表清单不早于 analysis.csv`);
}

function checkR5(projectRoot) {
  const figures = figuresInfo(projectRoot);
  const analysis = readAnalysis(projectRoot);
  const included = inAnalysisCount(analysis);
  if (!figures.rows.length) return check('R5', 'unjudged', '没有图表清单');
  if (included === null) return check('R5', 'unjudged', 'analysis.csv 没有 in_analysis，无法确定应有 N');
  const sampleRows = figures.rows.filter((row) => ['sample', 'full', ''].includes(String(row.nScope || '').toLowerCase()));
  // 一张样本级图都没有时，「没有超标的图」是空集合的真命题，但那不叫核对过。
  if (!sampleRows.length) return check('R5', 'unjudged', `图表清单里没有样本级图（n_scope 都是 corpus）：无从核对图注 N，需人确认`);
  // 图注 N 可能小于纳入样本（该变量有缺失，图按完整案例画）——这是合法但需要人确认的；
  // 唯一能机器判死的是「图注 N 比纳入样本还大」，那说明图用的是另一版数据。
  const over = sampleRows.filter((row) => Number.isFinite(row.n) && row.n > included);
  if (over.length) {
    return check('R5', 'fail', `${over.length} 张图的 n 大于纳入样本 ${included}（例：${over[0].id} n=${over[0].n}）：图用的不是当前数据`);
  }
  const partial = sampleRows.filter((row) => Number.isFinite(row.n) && row.n !== included);
  const models = readModels(projectRoot);
  const modelNs = new Set(models.models.map((m) => m.fitN ?? m.n).filter((n) => Number.isFinite(n)));
  const unexplained = partial.filter((row) => !modelNs.has(row.n));
  if (unexplained.length) {
    return check('R5', 'unjudged', `${unexplained.length} 张图的 n 小于纳入样本且不是任何模型的 N（例：${unexplained[0].id} n=${unexplained[0].n}）：需确认是按完整案例画的`);
  }
  return check('R5', 'pass', `${sampleRows.length} 张图的 n 都不超过纳入样本 ${included}，且能落到模型 N 或完整案例`);
}

function checkR6(projectRoot) {
  const figures = figuresInfo(projectRoot);
  if (!figures.rows.length) return check('R6', 'unjudged', '没有图表清单');
  const missing = figures.rows.filter((row) => !/N\s*=\s*\d+/i.test(String(row.caption || '')));
  if (missing.length) {
    return check('R6', 'fail', `${missing.length}/${figures.rows.length} 张图的图注没有 N=（例：${missing.slice(0, 3).map((row) => row.id).join('、')}）`);
  }
  return check('R6', 'pass', '全部图注都带 N');
}

function checkR7(projectRoot) {
  const verify = readVerify(projectRoot);
  if (!verify || !verify.file) return check('R7', 'unjudged', '缺 number_issues.csv：没跑 verify_numbers');
  const realErrors = (verify.counts.error || 0) - (verify.counts.input || 0);
  if (realErrors > 0) {
    return check('R7', 'fail', `数字溯源 ${realErrors} 条 error（不含「输入缺失」类）`, verify.file);
  }
  if ((verify.counts.input || 0) > 0) {
    return check('R7', 'unjudged', `只有 ${verify.counts.input} 条输入缺失类 error：这是没得查，不是查出来没问题`, verify.file);
  }
  if ((verify.counts.deferred || 0) > 0) {
    return check('R7', 'unjudged', `${verify.counts.deferred} 条 V-05 待复核（n_dropna ≠ N 的判定缺陷）`, verify.file);
  }
  return check('R7', 'pass', verify.summary || '没有数字溯源 error');
}

const SCRIPT_PATTERNS = [
  { re: /\.dropna\s*\(/g, why: 'dropna 会静默减少样本，必须写明剔除了什么' },
  { re: /\.drop\s*\(/g, why: 'drop 会静默减少列/行' },
  { re: /except\s*(Exception)?\s*:\s*(pass|continue)/g, why: '吞异常会让失败看起来像成功' },
  { re: /mode\s*=\s*['"]a['"]/g, why: '追加写会让重复运行叠加行' },
  { re: /to_csv\s*\(/g, why: '输出覆盖：确认每次都重写而不是漏写某些行' },
];

function checkR8(projectRoot) {
  const dir = path.join(projectRoot, 'scripts');
  const files = listPy(dir);
  if (!files.length) return check('R8', 'pass', '项目没有自己的 Python 脚本（本步无脚本可审）');
  const hits = [];
  for (const name of files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const pattern of SCRIPT_PATTERNS) {
      const lineNo = text.split('\n').findIndex((line) => pattern.re.test(line));
      pattern.re.lastIndex = 0;
      if (lineNo >= 0) hits.push(`scripts/${name}:${lineNo + 1} ${pattern.why}`);
    }
  }
  if (!hits.length) return check('R8', 'pass', `${files.length} 个项目脚本里没有 dropna/静默 except/追加写`);
  return check('R8', 'unjudged', `项目脚本里有 ${hits.length} 处需要人读的写法`, hits.slice(0, 12).join('\n'));
}

function checkR9(projectRoot) {
  const reports = readQaReports(projectRoot);
  if (!reports.length) return check('R9', 'unjudged', '缺 output/qa/qa_report.json');
  const newest = reports.slice().sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
  const errors = Number(newest.json?.error_count ?? NaN);
  if (!Number.isFinite(errors)) return check('R9', 'unjudged', `${newest.name} 没有 error_count`);
  if (errors > 0) return check('R9', 'fail', `${newest.name}: error ${errors} / warning ${newest.json?.warning_count ?? '?'}`);
  return check('R9', 'pass', `${newest.name}: error 0 / warning ${newest.json?.warning_count ?? 0}`);
}

function checkR10(projectRoot) {
  const docx = path.join(projectRoot, 'output/manuscript.docx');
  if (!statOf(docx).exists) return check('R10', 'unjudged', '还没有 manuscript.docx');
  const spec = readJson(path.join(projectRoot, 'manuscript.json'));
  if (!spec || !Array.isArray(spec.blocks)) return check('R10', 'unjudged', '缺 manuscript.json：无法比对图表块');
  const wanted = spec.blocks.filter((block) => String(block.type) === 'figure').length;
  const reports = readQaReports(projectRoot);
  const newest = reports.slice().sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
  const embedded = newest?.json?.checks?.docx?.inline_images;
  if (!Number.isFinite(embedded)) return check('R10', 'unjudged', 'qa_report 没有 docx.inline_images，数不出内嵌图');
  if (embedded !== wanted) return check('R10', 'fail', `docx 内嵌 ${embedded} 张图，文稿 spec 里有 ${wanted} 个 figure 块`);
  return check('R10', 'pass', `docx 内嵌 ${embedded} 张图，与 spec 一致`);
}

function checkR11(projectRoot, project, runs) {
  if (!Array.isArray(runs) || !runs.length) return check('R11', 'unjudged', '没有运行记录，无法判断产物是谁写的');
  const byStage = new Map();
  for (const run of runs) {
    if (!byStage.has(run.stageId)) byStage.set(run.stageId, run);
  }
  const stale = [];
  for (const [stageId, run] of byStage) {
    if (run.status !== 'ok' || !run.startedAt) continue;
    const started = Date.parse(run.startedAt);
    for (const artifact of project?.stages?.[stageId]?.artifacts || []) {
      const st = statOf(path.join(projectRoot, artifact));
      if (st.exists && Number.isFinite(started) && st.mtimeMs + 1000 < started) {
        stale.push(`${artifact} 早于 ${stageId} 的最近一次运行`);
      }
    }
  }
  if (stale.length) return check('R11', 'fail', `${stale.length} 个产物比最近一次运行还旧`, stale.slice(0, 6).join('\n'));
  return check('R11', 'pass', `${byStage.size} 个阶段的产物都不早于各自最近一次运行`);
}

/* ------------------------------ 覆盖表 / 问题 ------------------------------ */

export function coverageFile(projectRoot) {
  return path.join(projectRoot, 'output/recheck/coverage.json');
}

export function readCoverage(projectRoot) {
  const data = readJson(coverageFile(projectRoot));
  const entries = {};
  if (data && typeof data === 'object') {
    for (const item of RECHECK_ITEMS) {
      const value = data[item.id];
      if (value && typeof value === 'object') {
        entries[item.id] = { status: String(value.status || ''), note: String(value.note || '') };
      }
    }
  }
  return entries;
}

function checkR12(projectRoot) {
  const entries = readCoverage(projectRoot);
  const missing = RECHECK_ITEMS.filter((item) => !entries[item.id] || !['checked', 'unchecked'].includes(entries[item.id].status));
  if (!Object.keys(entries).length) return check('R12', 'unjudged', '还没有 output/recheck/coverage.json：模型没交覆盖表');
  if (missing.length) return check('R12', 'fail', `覆盖表缺 ${missing.length} 项（${missing.map((m) => m.id).join('、')}）`);
  const unchecked = RECHECK_ITEMS.filter((item) => entries[item.id].status === 'unchecked');
  if (unchecked.length) return check('R12', 'unjudged', `${unchecked.length} 项标了 unchecked（未核），需人判断是否可接受`, unchecked.map((m) => `${m.id}: ${entries[m.id].note || '无理由'}`).join('\n'));
  return check('R12', 'pass', '12 项全部 checked');
}

export function issuesFile(projectRoot) {
  return path.join(projectRoot, 'output/recheck/issues.jsonl');
}

export function readIssues(projectRoot) {
  let text = '';
  try {
    text = fs.readFileSync(issuesFile(projectRoot), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const issue = JSON.parse(trimmed);
      if (issue && issue.id) out.push({ ...issue, status: issue.status || 'open' });
    } catch {
      /* 坏行跳过：它是模型写的，不能因此让整个复核页打不开 */
    }
  }
  return out;
}

export function writeIssues(projectRoot, issues) {
  const file = issuesFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = issues.map((issue) => JSON.stringify(issue)).join('\n') + (issues.length ? '\n' : '');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

/** 证据包：给模型看的受控上下文（不是全量原始材料）。 */
export function buildEvidence(projectRoot, { project, runs, checks, issues }) {
  const parts = [];
  const push = (title, text, limit = 6000) => {
    if (!text) return;
    const clipped = String(text).length > limit ? `${String(text).slice(0, limit)}\n…（截断）` : String(text);
    parts.push(`## ${title}\n${clipped}`);
  };
  push('项目', `名称：${project?.name || ''}\n目录：${projectRoot}`);
  push('机器复算', checks.map((c) => `${c.id} [${c.status}] ${c.label}：${c.detail}`).join('\n'), 5000);
  const openIssues = issues.filter((issue) => issue.status === 'open');
  push('已有问题（open）', openIssues.length
    ? openIssues.map((issue) => `${issue.id} [${issue.severity}] ${issue.where}：${issue.claim}`).join('\n')
    : '（无）', 3000);
  const analysis = readAnalysis(projectRoot);
  if (analysis) {
    push('analysis.csv 表头', analysis.header.join(','));
    push('analysis.csv 前 10 行', analysis.rows.slice(0, 10).map((row) => analysis.header.map((h) => row[h]).join(',')).join('\n'), 3000);
  }
  const dataset = readDataset(projectRoot);
  if (dataset) push('dataset.csv 前 3 行', dataset.rows.slice(0, 3).map((row) => dataset.header.map((h) => row[h]).join(',')).join('\n'), 2000);
  const models = readModels(projectRoot);
  if (models.models.length) push('模型', models.models.map((m) => `${m.id}: N=${m.fitN ?? m.n}（${m.file}）`).join('\n'), 1500);
  const figures = figuresInfo(projectRoot);
  if (figures.rows.length) {
    push('图表（前 8 张）', figures.rows.slice(0, 8).map((row) => `${row.id} n=${row.nText} caption=${row.caption}`).join('\n'), 3000);
  }
  const verify = readVerify(projectRoot);
  if (verify?.file) push('数字溯源（前 12 条）', (verify.issues || []).slice(0, 12)
    .map((row) => `${row.severity} ${row.check} ${row.where}: ${row.detail}`).join('\n'), 3000);
  const coverage = readCoverage(projectRoot);
  if (Object.keys(coverage).length) push('现有覆盖表', JSON.stringify(coverage, null, 2), 2000);
  // 补丁要带 baseHash 才能落盘；哈希必须由这里给出——不能让模型自己算（它没有工具，只能瞎猜）。
  const hashTargets = [
    'output/dataset/analysis.csv',
    'data/analysis.csv',
    'output/coding/coding_sheet.csv',
    'output/coding/dataset.csv',
    'model_spec.json',
    'chart_config.json',
    ...listPy(path.join(projectRoot, 'scripts')).map((name) => `scripts/${name}`),
  ];
  const hashLines = [];
  for (const rel of hashTargets) {
    const hash = fileHash(path.join(projectRoot, rel));
    if (hash) hashLines.push(`${rel}\t${hash}`);
  }
  if (hashLines.length) push('可补丁文件的当前哈希（patch.baseHash 必须用这里的值）', hashLines.join('\n'), 4000);
  for (const name of listPy(path.join(projectRoot, 'scripts'))) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(projectRoot, 'scripts', name), 'utf8');
    } catch {
      continue;
    }
    push(`项目脚本 scripts/${name}`, text, 5000);
  }
  return parts.join('\n\n');
}

/** 一次性把这一阶段的机器检查都算出来。 */
export function runChecks(projectRoot, { project, runs } = {}) {
  const checks = [
    checkR1(projectRoot),
    checkR2(projectRoot),
    checkR3(projectRoot),
    checkR4(projectRoot),
    checkR5(projectRoot),
    checkR6(projectRoot),
    checkR7(projectRoot),
    checkR8(projectRoot),
    checkR9(projectRoot),
    checkR10(projectRoot),
    checkR11(projectRoot, project, runs),
    checkR12(projectRoot),
  ];
  return checks;
}

/**
 * 取一个路径的真实位置（末级/中间级不存在时，用最近的存在的父目录做 realpath 再拼回去）。
 * 只用字符串前缀判越界是不够的：材料库把外部目录以目录联接挂在 data/<alias>，
 * 字符串上确实在项目内，写下去却落到用户的原始材料里。
 */
function resolveReal(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT') return path.resolve(target);
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** 套用模型给的补丁：校验路径与 baseHash → 备份 → 原子写。 */
export function applyPatch(projectRoot, issue) {
  const patch = issue?.patch;
  if (!patch || !patch.path || typeof patch.content !== 'string') {
    return { ok: false, error: '这条问题没有可套用的补丁（fix_kind 不是 edit-code/edit-text）' };
  }
  const abs = path.resolve(projectRoot, patch.path);
  const rootReal = resolveReal(projectRoot);
  const absReal = resolveReal(abs);
  if (absReal !== rootReal && !absReal.startsWith(rootReal + path.sep)) {
    return { ok: false, error: `补丁路径越界：${patch.path}（实际落在 ${absReal}，不在项目内）` };
  }
  const target = statOf(abs);
  if (target.exists) {
    let isFile = true;
    try {
      isFile = fs.statSync(abs).isFile();
    } catch {
      isFile = true;
    }
    if (!isFile) return { ok: false, error: `补丁目标是目录，不是文件：${patch.path}` };
  }
  const before = fileHash(abs);
  // 基线校验不能可跳过：baseHash 为空就等于「不管用户手改过什么，覆盖掉」。
  if (target.exists) {
    if (!patch.baseHash) {
      return { ok: false, error: `补丁缺少 baseHash：请先用 data_analysis_recheck（action=evidence）取到 ${patch.path} 的哈希，再重新生成补丁` };
    }
    if (patch.baseHash !== before) {
      return { ok: false, error: `补丁基线已变（文件在模型读它之后又改过），请重新生成补丁：${patch.path}` };
    }
  } else if (patch.baseHash && patch.baseHash !== before) {
    return { ok: false, error: `补丁基线不成立（文件已经不存在）：${patch.path}` };
  }
  const dir = path.join(projectRoot, 'output/recheck/diffs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // issue.id 是模型给的字符串：不清洗就能用 ../../ 把备份写到项目外
  const safeId = String(issue?.id || 'issue').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  const backup = path.join(dir, `${safeId}-${stamp}.bak`);
  if (target.exists) fs.copyFileSync(abs, backup);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, patch.content, 'utf8');
  fs.renameSync(tmp, abs);
  return {
    ok: true,
    file: patch.path,
    created: !target.exists,
    backup: path.relative(projectRoot, backup),
    hash: fileHash(abs),
  };
}

export function recheckSummary(projectRoot, { project, runs } = {}) {
  const checks = runChecks(projectRoot, { project, runs });
  const issues = readIssues(projectRoot);
  const openErrors = issues.filter((issue) => issue.status === 'open' && issue.severity === 'error').length;
  const openOthers = issues.filter((issue) => issue.status === 'open' && issue.severity !== 'error').length;
  return {
    checks,
    issues,
    coverage: readCoverage(projectRoot),
    openErrors,
    openOthers,
    report: statOf(path.join(projectRoot, 'output/recheck/report.md')).exists,
  };
}

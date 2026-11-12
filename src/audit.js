/**
 * 产物只读解析。
 *
 * 硬约束（见 docs/domain-spec）：插件只读、不重算、不猜。
 *   - 每个数字都能指回「哪个文件、哪一列、哪一行」。
 *   - 判不了就返回 unjudged，绝不默认成通过。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 15 cm 版心 → 5.9055 英寸；有效 dpi = px_width / 5.9055。 */
export const PLOT_INCHES = 15 / 2.54;
export const DPI_MIN = 597.0; // 600 × 0.995，容差来自 3543.3px 取整
export const FONT_MIN_PT = 7.2;
export const DELTA_L_MIN = 10.0;

/* ------------------------- 调色板灰度可分性 ------------------------- */

function srgbToLinear(v) {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** #RRGGBB → CIE L*（只看灰度可分性，色相不参与）。 */
export function hexToLabL(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const y = 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  const f = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  return 116 * f - 16;
}

/** manifest 的 palette 列实测是 8 个 hex 用 | 分隔；逗号/空格也容忍。 */
export function parsePalette(value) {
  return String(value || '')
    .split(/[|,;\s]+/)
    .map((item) => item.trim())
    .filter((item) => /^#?[0-9a-f]{6}$/i.test(item));
}

/** 两两 L* 差的最小值——低于 10 说明灰度打印时两条线分不出来。 */
export function paletteDeltaL(palette) {
  const list = Array.isArray(palette) ? palette : parsePalette(palette);
  if (list.length < 2) return null;
  const ls = list.map(hexToLabL).filter((v) => v !== null);
  if (ls.length < 2) return null;
  let min = Infinity;
  for (let i = 0; i < ls.length; i += 1) {
    for (let j = i + 1; j < ls.length; j += 1) {
      min = Math.min(min, Math.abs(ls[i] - ls[j]));
    }
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * 配色徽章：只判「声明的色环在灰度下是否可分」，判的是声明，不是渲染结果。
 * 单色/未声明 → unjudged（不是通过）。
 */
export function assessPalette(value) {
  const list = parsePalette(value);
  if (!list.length) return { state: 'unjudged', text: '未声明', min: null, count: 0 };
  const min = paletteDeltaL(list);
  if (min === null) return { state: 'unjudged', text: `${list.length} 色`, min: null, count: list.length };
  const rounded = Math.round(min * 10) / 10;
  return {
    state: min < DELTA_L_MIN ? 'fail' : 'pass',
    text: `ΔL* ${rounded}`,
    min,
    count: list.length,
  };
}

/* ------------------------------- CSV ------------------------------- */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // 等等 \n
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const clean = rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
  if (!clean.length) return { header: [], rows: [] };
  const header = clean[0].map((cell) => cell.trim());
  const records = clean.slice(1).map((cells) => {
    const record = {};
    header.forEach((key, index) => {
      record[key] = cells[index] === undefined ? '' : String(cells[index]).trim();
    });
    return record;
  });
  return { header, rows: records };
}

export function readCsv(file) {
  try {
    return parseCsv(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

/** 项目内相对路径 → 绝对路径；防止产物里写的 ../ 逃出项目。 */
export function insideProject(root, rel) {
  const abs = path.resolve(root, String(rel || ''));
  const base = path.resolve(root);
  const relative = path.relative(base, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return abs;
}

/* ------------------------------ 漏斗 ------------------------------ */

const FLOW_CANDIDATES = [
  { rel: 'output/audit/sample_flow.csv', source: '审计', unit: '份' },
  { rel: 'output/coding/sample_flow.csv', source: '编码', unit: '份' },
];

export function readFlow(projectRoot) {
  const chains = [];
  for (const candidate of FLOW_CANDIDATES) {
    const abs = path.join(projectRoot, candidate.rel);
    const csv = readCsv(abs);
    if (!csv || !csv.rows.length) continue;
    const steps = csv.rows
      .map((row) => ({
        stage: row.stage || row['阶段'] || '',
        n: Number(String(row.n ?? row['数量'] ?? '').replace(/,/g, '')),
        note: row.note || row['说明'] || '',
      }))
      .filter((step) => step.stage && Number.isFinite(step.n));
    if (!steps.length) continue;
    const monotonic = steps.every((step, index) => index === 0 || step.n <= steps[index - 1].n);
    chains.push({
      file: candidate.rel,
      source: candidate.source,
      unit: candidate.unit,
      steps,
      monotonic,
      first: steps[0].n,
      last: steps[steps.length - 1].n,
    });
  }
  return chains;
}

export function readCorpusSummary(projectRoot) {
  const file = path.join(projectRoot, 'output', 'audit', 'corpus_summary.json');
  const json = readJson(file);
  if (!json) return null;
  // 真实产出用 corpus_fingerprint（audit_corpus.py），旧版/手写摘要可能是 fingerprint。
  const fp = json.corpus_fingerprint || json.fingerprint || null;
  return {
    file: 'output/audit/corpus_summary.json',
    totalFiles: json.total_files ?? null,
    validFiles: json.valid_files ?? null,
    uniqueValidFiles: json.unique_valid_files ?? null,
    unreadableFiles: json.unreadable_files ?? null,
    truncated: Boolean(json.truncated),
    hashDisabled: Boolean(json.hash_disabled),
    generatedAt: json.generated_at || '',
    fingerprint: fp && Number.isFinite(Number(fp.files)) && Number.isFinite(Number(fp.bytes))
      ? { files: Number(fp.files), bytes: Number(fp.bytes), sha256: fp.sha256 || '' }
      : null,
  };
}

/* ------------------------------ 图表 ------------------------------ */

const MANIFEST_CANDIDATES = [
  'output/chart_pack/chart_manifest.csv',
  'output/figures/paper_figures_manifest.csv',
];

function pick(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return '';
}

function parseNumber(value) {
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text) return null;
  const match = text.match(/-?[0-9]+(?:\.[0-9]+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

export function readFigures(projectRoot) {
  for (const rel of MANIFEST_CANDIDATES) {
    const abs = path.join(projectRoot, rel);
    const csv = readCsv(abs);
    if (!csv || !csv.rows.length) continue;
    const baseDir = path.dirname(abs);
    const rows = csv.rows.map((row) => {
      const pngRel = pick(row, ['png', 'file']);
      const pngAbs = pngRel
        ? (path.isAbsolute(pngRel) ? pngRel : path.resolve(baseDir, pngRel))
        : '';
      const pngName = pngRel ? path.basename(pngRel) : '';
      // 有些 manifest 的 png 写的是项目相对路径，两种都试
      const pngProjectAbs = pngRel ? insideProject(projectRoot, pngRel) : null;
      const exists = Boolean((pngAbs && statOf(pngAbs).exists) || (pngProjectAbs && statOf(pngProjectAbs).exists));
      const note = pick(row, ['note']);
      const fontMatch = note.match(/min_fontsize\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
      const pxWidth = parseNumber(pick(row, ['px_width', 'pxwidth']));
      const declaredDpi = parseNumber(pick(row, ['dpi']));
      const effectiveDpi = pxWidth ? pxWidth / PLOT_INCHES : null;
      const nText = pick(row, ['n']);
      const n = parseNumber(nText);
      return {
        id: pick(row, ['id']) || pngName,
        question: pick(row, ['question', 'title']),
        chartType: pick(row, ['chart_type', 'type']),
        variables: pick(row, ['variables', 'variable']),
        section: pick(row, ['section']),
        n,
        nText,
        nScope: pick(row, ['n_scope']),
        caption: pick(row, ['caption', 'caption_text']),
        png: pngRel,
        pngExists: exists,
        note,
        status: pick(row, ['status']),
        palette: pick(row, ['palette']),
        declaredDpi,
        pxWidth,
        effectiveDpi,
        minFontsize: fontMatch ? Number(fontMatch[1]) : null,
        dataHash: pick(row, ['data_hash']),
      };
    });
    return { file: rel, rows };
  }
  return { file: '', rows: [] };
}

/** 一张图的合规徽章（三态：pass / fail / unjudged，绝不把 unjudged 画成通过）。 */
export function figureBadges(figure) {
  const badges = [];
  if (!figure.png || !figure.pngExists) {
    badges.push({ key: 'file', label: '文件', state: 'fail', text: figure.png ? '缺失' : '无路径' });
  } else {
    badges.push({ key: 'file', label: '文件', state: 'pass', text: '在' });
  }
  if (figure.effectiveDpi === null) {
    badges.push({ key: 'dpi', label: 'dpi', state: 'unjudged', text: '未测' });
  } else {
    const bad = figure.effectiveDpi < DPI_MIN;
    badges.push({
      key: 'dpi',
      label: 'dpi',
      state: bad ? 'fail' : 'pass',
      text: `${Math.round(figure.effectiveDpi)}`,
    });
  }
  if (figure.minFontsize === null) {
    badges.push({ key: 'font', label: '字号', state: 'unjudged', text: '未测' });
  } else {
    const bad = figure.minFontsize < FONT_MIN_PT;
    badges.push({ key: 'font', label: '字号', state: bad ? 'fail' : 'pass', text: `${figure.minFontsize}pt` });
  }
  const palette = assessPalette(figure.palette);
  badges.push({ key: 'palette', label: '配色', state: palette.state, text: palette.text });
  if (figure.n === null) {
    badges.push({ key: 'n', label: 'N', state: 'unjudged', text: '未测' });
  } else {
    badges.push({ key: 'n', label: 'N', state: 'pass', text: String(figure.n) });
  }
  return badges;
}

/* ------------------------------ 模型 ------------------------------ */

export function readModels(projectRoot) {
  const dirs = ['output/models', 'output/analysis_pack'];
  for (const dir of dirs) {
    const abs = path.join(projectRoot, dir);
    let entries = [];
    try {
      entries = fs.readdirSync(abs);
    } catch {
      continue;
    }
    const coefs = entries.filter((name) => /^coef_.*\.csv$/i.test(name));
    const fits = entries.filter((name) => /^fit.*\.csv$/i.test(name));
    const meta = readJson(path.join(abs, 'model_meta.json'));
    if (!coefs.length && !fits.length && !meta) continue;

    // fit.csv 的 n 才是模型实际估计样本；coef 表的 n 也要读，但不再被当成唯一来源。
    // fit.csv 常是「一行一个模型」（model 列），只取第一行会把 M2 的 N 记成 M1 的，
    // 跨模型 N 对账就整列失真，所以按 model 建索引，再留一个按文件名的兜底。
    const fitByStem = new Map();
    const fitByModel = new Map();
    for (const name of fits) {
      const csv = readCsv(path.join(abs, name));
      const stem = name.replace(/^fit_?/i, '').replace(/\.csv$/i, '') || 'main';
      const entryOf = (row) => ({
        file: `${dir}/${name}`,
        model: row?.model || stem,
        n: row ? parseNumber(row.n) : null,
        nDropna: row ? parseNumber(row.n_dropna) : null,
        rows: csv ? csv.rows.length : 0,
      });
      if (!csv) continue;
      fitByStem.set(stem.toLowerCase(), entryOf(csv.rows.find((row) => row.n) || null));
      for (const row of csv.rows) {
        const key = String(row.model || '').trim().toLowerCase();
        if (key) fitByModel.set(key, entryOf(row));
      }
    }

    const models = coefs.map((name) => {
      const csv = readCsv(path.join(abs, name));
      const first = csv ? csv.rows.find((row) => row.n) : null;
      const id = name.replace(/^coef_/i, '').replace(/\.csv$/i, '');
      const fit = fitByModel.get(id.toLowerCase()) || fitByStem.get(id.toLowerCase()) || fitByStem.get('main') || null;
      return {
        id,
        file: `${dir}/${name}`,
        n: first ? parseNumber(first.n) : null,
        fitN: fit ? fit.n : null,
        fitFile: fit ? fit.file : '',
        rows: csv ? csv.rows.length : 0,
      };
    });
    return {
      dir,
      models,
      fits: [...fitByStem.values()],
      flowChecks: Array.isArray(meta?.flow_checks) ? meta.flow_checks : [],
      meta,
    };
  }
  return { dir: '', models: [], fits: [], flowChecks: [], meta: null };
}

/* ---------------------------- 数字溯源 ---------------------------- */

export function readVerify(projectRoot) {
  const candidates = [
    'output/verify/number_issues.csv',
    'output/qa/number_issues.csv',
    'output/terminal/number_issues.csv',
  ];
  for (const rel of candidates) {
    const csv = readCsv(path.join(projectRoot, rel));
    if (!csv || !csv.header.length) continue;
    const counts = { error: 0, warning: 0, info: 0, unjudged: 0, deferred: 0, input: 0 };
    const deferred = [];
    for (const row of csv.rows) {
      const severity = String(row.severity || '').toLowerCase();
      const check = String(row.check || row.check_id || row.rule || row.id || '').trim();
      // input/parse 类是「没得查」（缺文件、解析失败），不是「查出来有问题」。
      // 两者在台账里都记 error，但结论必须分开说。
      const inputClass = /^(input|parse|io|read|missing)$/i.test(check);
      if (inputClass) counts.input += 1;
      // V-05 用 fit.csv.n_dropna 当 N（verify_numbers.py:1058-1062），而 n_dropna 是被剔除的行数。
      // 直接当 error 会假拦正确模型 / 放过错误模型，所以单列「待按 fit.n 复核」，不并入 error。
      if (/^V[-_]?0?5$/i.test(check)) {
        counts.deferred += 1;
        deferred.push(row);
        continue;
      }
      if (severity === 'error') counts.error += 1;
      else if (severity === 'warning' || severity === 'warn') counts.warning += 1;
      else if (severity === 'info') counts.info += 1;
      else counts.unjudged += 1;
    }
    return {
      file: rel,
      rows: csv.rows.length,
      counts,
      deferred,
      sample: csv.rows.slice(0, 20),
    };
  }
  return null;
}

export function readQaReports(projectRoot) {
  const dir = path.join(projectRoot, 'output', 'qa');
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .slice(0, 10)
    .map((name) => {
      const abs = path.join(dir, name);
      return { name, json: readJson(abs), mtimeMs: statOf(abs).mtimeMs || 0 };
    })
    .filter((entry) => entry.json);
}

/* ------------------------- 分析宽表 / 语料集合定位 ------------------------- */

/**
 * 分析宽表的规范位置是 output/dataset/analysis.csv：
 * data/ 是语料根，audit 与 coding 都拿它当 --root，宽表放进去会被当成一份「资料」
 * （2026-11-11 的 spss_analysis 会话就是这样：审计 223、编码走到 224、多出一份 analysis.csv）。
 * 旧项目仍把宽表写在 data/，这里保留兼容读取，闸门会提示迁移。
 */
export const ANALYSIS_CANDIDATES = ['output/dataset/analysis.csv', 'data/analysis.csv'];
export const ANALYSIS_CANONICAL = ANALYSIS_CANDIDATES[0];

export function analysisFile(projectRoot) {
  for (const rel of ANALYSIS_CANDIDATES) {
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs)) return { rel, abs, exists: true };
  }
  return { rel: ANALYSIS_CANONICAL, abs: path.join(projectRoot, ANALYSIS_CANONICAL), exists: false };
}

/** output/audit/corpus_files.csv → 审计走过的文件集合（valid 与非 valid 分开）。 */
export function readCorpusSet(projectRoot) {
  const file = 'output/audit/corpus_files.csv';
  const csv = readCsv(path.join(projectRoot, file));
  if (!csv || !csv.rows.length) return { file, valid: null, all: null };
  const key = csv.header.includes('rel_path') ? 'rel_path' : csv.header.includes('relpath') ? 'relpath' : null;
  if (!key) return { file, valid: null, all: null };
  const valid = new Set();
  const all = new Set();
  for (const row of csv.rows) {
    const rel = String(row[key] || '').trim();
    if (!rel) continue;
    all.add(rel);
    if (String(row.status || '').trim() === 'valid') valid.add(rel);
  }
  return { file, valid, all };
}

/** output/coding/coding_sheet.csv → 已编码文件的 rel_path 集合。 */
export function readCodingSet(projectRoot) {
  const file = 'output/coding/coding_sheet.csv';
  const csv = readCsv(path.join(projectRoot, file));
  if (!csv || !csv.rows.length) return { file, paths: null };
  const key = csv.header.includes('rel_path') ? 'rel_path' : csv.header.includes('relpath') ? 'relpath' : null;
  if (!key) return { file, paths: null };
  const paths = new Set();
  for (const row of csv.rows) {
    const rel = String(row[key] || '').trim();
    if (rel) paths.add(rel);
  }
  return { file, paths };
}

/** output/coding/skipped_documents.csv → rel_path -> { reason, stage }。 */
export function readSkippedSet(projectRoot) {
  const file = 'output/coding/skipped_documents.csv';
  const csv = readCsv(path.join(projectRoot, file));
  if (!csv || !csv.rows.length) return { file, byPath: new Map() };
  const key = csv.header.includes('rel_path') ? 'rel_path' : csv.header.includes('relpath') ? 'relpath' : null;
  if (!key) return { file, byPath: new Map() };
  const byPath = new Map();
  for (const row of csv.rows) {
    const rel = String(row[key] || '').trim();
    if (rel) byPath.set(rel, { reason: String(row.reason || ''), stage: String(row.skip_stage || '') });
  }
  return { file, byPath };
}

let corpusScanCache = new Map();
const CORPUS_SCAN_TTL = 5000;
const CORPUS_SCAN_MAX = 20000;

/**
 * 当前 data/ 的轻量签名（文件数 + 字节数），只 stat 不 hash。
 * 用来发现「审计之后 data/ 又变了」——corpus_summary 里的 fingerprint 是审计当时的快照。
 */
export function corpusCurrentSignature(projectRoot, { force = false } = {}) {
  const root = path.join(projectRoot, 'data');
  const now = Date.now();
  const cached = corpusScanCache.get(root);
  if (!force && cached && now - cached.at < CORPUS_SCAN_TTL) return cached.value;
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const seen = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 联接/镜像会让同一份真实目录从多个路径进来，按真实路径去重，避免重复计数和成环
    try {
      const real = fs.realpathSync(dir);
      if (seen.has(real)) return;
      seen.add(real);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= CORPUS_SCAN_MAX) {
        truncated = true;
        return;
      }
      const name = entry.name;
      // 注意：技能的 audit_corpus.py 把隐藏文件也算进 total_files（只是状态记为 hidden/metadata），
      // 所以这里不能再跳过点开头的文件，否则挂了带 .DS_Store 的材料就会假报「新鲜度对不上」。
      const abs = path.join(dir, name);
      // 不能用 entry.isDirectory()：目录联接在 Dirent 里是符号链接，isDirectory() 为 false，
      // 那样整个挂载目录都会被当成「不是文件也不是目录」跳过。用 stat 跟随链接判断。
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // 遍历时被移走，或断链
      }
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      files += 1;
      bytes += stat.size;
    }
  };
  walk(root);
  const value = { root, files, bytes, truncated };
  corpusScanCache.set(root, { at: now, value });
  return value;
}

export function clearCorpusScan() {
  corpusScanCache = new Map();
}

/** 分析宽表的行数/列数/in_analysis 计数：面板要在「数据集」阶段直接说清样本量。 */
function readAnalysisSummary(projectRoot) {
  const target = analysisFile(projectRoot);
  const csv = readCsv(target.abs);
  if (!csv || !csv.header.length) return null;
  const flagAt = csv.header.indexOf('in_analysis');
  const columns = csv.header.length;
  let inAnalysis = null;
  let excluded = null;
  if (flagAt >= 0) {
    inAnalysis = 0;
    for (const row of csv.rows) {
      if (String(row.in_analysis || '').trim() === '1') inAnalysis += 1;
    }
    excluded = csv.rows.length - inAnalysis;
  }
  return {
    file: target.rel,
    rows: csv.rows.length,
    columns,
    header: csv.header.slice(0, 16),
    inAnalysis,
    excluded,
  };
}

/** 图表合规汇总：面板先给「达标/不达标/待核」，别让人逐行数徽章。 */
function figureSummary(rows) {
  const summary = {
    total: rows.length,
    pass: 0,
    fail: 0,
    unjudged: 0,
    fontUnjudged: 0,
    dpiFail: 0,
    fontFail: 0,
    paletteFail: 0,
    fileFail: 0,
    nMissing: 0,
  };
  for (const row of rows) {
    const badges = Array.isArray(row.badges) ? row.badges : [];
    const hasFail = badges.some((b) => b.state === 'fail');
    const hasUnjudged = badges.some((b) => b.state === 'unjudged');
    if (hasFail) summary.fail += 1;
    else if (hasUnjudged) summary.unjudged += 1;
    else summary.pass += 1;
    for (const badge of badges) {
      if (badge.state === 'fail') {
        if (badge.key === 'dpi') summary.dpiFail += 1;
        if (badge.key === 'font') summary.fontFail += 1;
        if (badge.key === 'palette') summary.paletteFail += 1;
        if (badge.key === 'file') summary.fileFail += 1;
      }
      if (badge.key === 'font' && badge.state === 'unjudged') summary.fontUnjudged += 1;
      if (badge.key === 'n' && badge.state !== 'pass') summary.nMissing += 1;
    }
  }
  return summary;
}

/** 把项目里所有产物扫一遍，返回面板要的只读快照。 */
export function scanArtifacts(projectRoot) {
  const figures = readFigures(projectRoot);
  const enriched = figures.rows.map((row) => ({ ...row, badges: figureBadges(row) }));
  let tables = 0;
  try {
    tables = fs.readdirSync(path.join(projectRoot, 'output', 'tables')).filter((name) => name.endsWith('.csv')).length;
  } catch {
    tables = 0;
  }
  const analysisTarget = analysisFile(projectRoot);
  return {
    flow: readFlow(projectRoot),
    corpus: readCorpusSummary(projectRoot),
    corpusSet: readCorpusSet(projectRoot),
    codingSet: readCodingSet(projectRoot),
    skippedSet: readSkippedSet(projectRoot),
    corpusCurrent: corpusCurrentSignature(projectRoot),
    figures: { file: figures.file, rows: enriched, summary: figureSummary(enriched) },
    models: readModels(projectRoot),
    verify: readVerify(projectRoot),
    qa: readQaReports(projectRoot),
    manuscript: statOf(path.join(projectRoot, 'output', 'manuscript.docx')),
    analysisRel: analysisTarget.rel,
    analysisCsv: statOf(analysisTarget.abs),
    analysis: readAnalysisSummary(projectRoot),
    tables,
  };
}
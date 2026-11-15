/**
 * 产物只读解析。
 *
 * 硬约束（见 docs/domain-spec）：插件只读、不重算、不猜。
 *   - 每个数字都能指回「哪个文件、哪一列、哪一行」。
 *   - 判不了就返回 unjudged，绝不默认成通过。
 */

import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { readResearchLayer } from './research.js';

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

export function parseCsv(text,{strict=false}={}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closed=false;
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
          closed=true;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if(strict&&(field.length||closed))throw Error('invalid CSV quote');
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      closed=false;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      closed=false;
    } else if (ch === '\r') {
      // 等等 \n
    } else {
      if(strict&&closed&&!/\s/.test(ch))throw Error('CSV data after closing quote');
      field += ch;
    }
  }
  if(strict&&quoted)throw Error('unterminated CSV quote');
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const clean = rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
  if (!clean.length) return { header: [], rows: [] };
  const header = clean[0].map((cell) => cell.trim());
  if(strict&&(!header.length||header.some(h=>!h)||new Set(header).size!==header.length||clean.slice(1).some(cells=>cells.length!==header.length)))throw Error('invalid CSV columns or row width');
  const records = clean.slice(1).map((cells) => {
    const record = {};
    header.forEach((key, index) => {
      record[key] = cells[index] === undefined ? '' : String(cells[index]).trim();
    });
    return record;
  });
  return { header, rows: records };
}

/* --------------------------- 一次快照内的读盘去重 --------------------------- */

/**
 * 同一批产物在一次快照里会被反复读：
 *   analysis.csv 在 scanArtifacts、闸门与复核里一共读 8 次，corpus_files.csv 读 3 次。
 * 内容在一次同步计算里不会变，重复读只是把同样的字节再读、再解析一遍（实测占了打开面板等待的一大半）。
 *
 * 作用域是「一次同步计算」，不是全局 TTL 缓存：
 *   - 面板拿到的永远是这次现读出来的结果，不会出现「显示的是上一轮的旧绿灯」；
 *   - 计算一结束作用域就丢，下一次 /state 重新读盘——判定仍然不缓存。
 */
const readScope = new AsyncLocalStorage();

/** 把一段同步计算包进「读盘去重」作用域；嵌套调用复用外层，不重置已读到的内容。 */
export function withReadCache(fn) {
  if (readScope.getStore()) return fn();
  return readScope.run(new Map(), fn);
}

function absKey(file) {
  const text = String(file || '');
  try {
    return path.resolve(text);
  } catch {
    return text;
  }
}

function memo(key, load) {
  const store = readScope.getStore();
  if (!store) return load();
  if (store.has(key)) return store.get(key);
  const value = load();
  store.set(key, value);
  return value;
}

export function readCsv(file) {
  return memo(`csv:${absKey(file)}`, () => {
    try {
      return parseCsv(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  });
}

function readJson(file) {
  return memo(`json:${absKey(file)}`, () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  });
}

export function statOf(file) {
  return memo(`stat:${absKey(file)}`, () => {
    try {
      const st = fs.statSync(file);
      return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return { exists: false, size: 0, mtimeMs: 0 };
    }
  });
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
    const KINDS = new Set(['stage', 'excluded', 'model']);
    const steps = csv.rows
      .map((row) => {
        const nText = String(row.n ?? row['数量'] ?? '').trim().replace(/,/g, '');
        return {
          stage: row.stage || row['阶段'] || '',
          // 空 n 不能变成 0：那会在漏斗里凭空多一档 0，后面全被判成回升。
          n: nText === '' ? NaN : Number(nText),
          // kind：stage = 漏斗的一档；excluded = 复审排除（不是漏斗档位，数量可以回升）；
          // model 是另一条业务线。旧文件没有 kind 列 → 一律按 stage（向后兼容）。
          kind: String(row.kind || '').trim().toLowerCase() || 'stage',
          note: row.note || row['说明'] || '',
        };
      })
      .filter((step) => step.stage && Number.isFinite(step.n));
    if (!steps.length) continue;
    // 契约：kind 只认 stage/excluded/model，非法值要报出来，不能悄悄当成
    // 「非漏斗行」跳过——否则写错一个字母就等于绕过了单调性检查。
    const invalidKinds = steps.filter((step) => !KINDS.has(step.kind));
    // 单调性只对真正的漏斗档位成立：把「复审排除」也算进去，6→5→4 会被误判成漏斗回升。
    const funnel = steps.filter((step) => step.kind === 'stage');
    const monotonic = funnel.every((step, index) => index === 0 || step.n <= funnel[index - 1].n);
    chains.push({
      file: candidate.rel,
      source: candidate.source,
      unit: candidate.unit,
      steps,
      funnel,
      other: steps.filter((step) => step.kind !== 'stage'),
      invalidKinds,
      monotonic,
      first: (funnel.length ? funnel : steps)[0].n,
      last: (funnel.length ? funnel : steps)[(funnel.length ? funnel : steps).length - 1].n,
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
    // metadata / hidden 不计入「原始资料」：.DS_Store、._ 附属文件、隐藏目录
    // 都不该让来源覆盖账永远差几份。
    metadataFiles: json.metadata_files ?? null,
    hiddenFiles: json.hidden_files ?? null,
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
  // 科学计数法要认：统计软件导出的 N 可能是 1.2e+03，截成 1.2 会让「N 大于样本」永远判不成立
  const match = text.match(/-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

export function readFigures(projectRoot) {
  // 两套清单可以同时存在（chart_pack 全景图 + paper_figures 多面板图）：
  // 只说「取最新那份」会让旧清单里的图彻底从检查视图里消失——「没查到」被显示成「没有」。
  // 这里按清单各读一份，再合并成一份交付视图（同一张 png 以较新的清单为准）。
  const candidates = MANIFEST_CANDIDATES
    .map((rel) => ({ rel, abs: path.join(projectRoot, rel), mtimeMs: statOf(path.join(projectRoot, rel)).mtimeMs || 0 }))
    .filter((item) => statOf(item.abs).exists)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) return { file: '', files: [], rows: [], manifests: [] };

  // 实测值（output/artifacts/measure.json，由 figure_check.py 从 PDF 里量出来）优先于清单声明：
  // 清单常常没有 min_fontsize，而闸门不能因为「清单没写」就永远判不了。
  const measured = readJson(path.join(projectRoot, 'output', 'artifacts', 'measure.json')) || {};
  const byPng = measured && measured.byPng && typeof measured.byPng === 'object' ? measured.byPng : {};
  // qa_outputs 的 PDF 实测：给了 --min-fontsize 时 checks.figures.pdfs[] 会写
  // min_fontsize_effective（实际安置字号）。这是机器证据里最硬的一条——
  // 清单常常没有 min_fontsize，只靠 measure.json 会让 fig-font 永远未核。
  const qaFonts = new Map();
  for (const report of readQaReports(projectRoot)) {
    const pdfs = report?.json?.checks?.figures?.pdfs;
    for (const item of Array.isArray(pdfs) ? pdfs : []) {
      const value = parseNumber(item?.min_fontsize_effective ?? item?.min_fontsize);
      const name = path.basename(String(item?.file || ''));
      if (!name || value === null) continue;
      const key = name.replace(/\.[^.]+$/, '').toLowerCase();
      // 报告按 mtime 新→旧排列：先到的是最新结论，旧报告不能覆盖它。
      if (!qaFonts.has(key)) qaFonts.set(key, value);
    }
  }

  const manifests = [];
  // 同一张图可能在两套清单里都登记（chart_pack 与 paper_figures 引用同一个 png）。
  // 合并键用**解析后的绝对路径**：两条清单的相对写法不同（figures/x.png 与
  // ../chart_pack/figures/x.png），按字符串比会把同一张图算成两张。
  const seenPng = new Set();
  const merged = [];
  for (const { rel, abs, mtimeMs } of candidates) {
    const csv = readCsv(abs);
    if (!csv || !csv.rows.length) {
      manifests.push({ file: rel, mtimeMs, rows: 0, empty: true });
      continue;
    }
    const rows = [];
    const baseDir = path.dirname(abs);
    for (const row of csv.rows) {
      const built = buildFigureRow(row, { projectRoot, baseDir, byPng, qaFonts });
      built.manifest = rel;
      built.manifestMtime = mtimeMs;
      rows.push(built);
      const key = built.pngAbs
        ? path.resolve(built.pngAbs).toLowerCase()
        : `${rel}#${built.id}`;
      if (!seenPng.has(key)) {
        seenPng.add(key);
        merged.push(built);
      }
    }
    manifests.push({ file: rel, mtimeMs, rows: rows.length, empty: false });
  }
  return { file: candidates[0].rel, files: candidates.map((item) => item.rel), rows: merged, manifests };
}

function buildFigureRow(row, { projectRoot, baseDir, byPng, qaFonts }) {
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
  const declaredStatus = String(pick(row, ['status'])).trim();
  // 契约：status 不是 ok（skipped/error）的行不是交付物，不进分母。
  // 但它们仍然要显示出来——否则「12 张图里 6 张没渲染」会被悄悄藏掉。
  const deliverable = !declaredStatus || /^ok$/i.test(declaredStatus);
  const pxWidth = parseNumber(pick(row, ['px_width', 'pxwidth']));
  const declaredDpi = parseNumber(pick(row, ['dpi']));
  const effectiveDpi = pxWidth ? pxWidth / PLOT_INCHES : null;
  const nText = pick(row, ['n']);
  const n = parseNumber(nText);
  const measureKey = pngRel ? String(pngRel).replace(/\\/g, '/') : '';
  const hit = byPng[measureKey] || byPng[pngName] || null;
  const minFontMeasured = hit ? parseNumber(hit.minFont) : null;
  const dpiMeasured = hit ? parseNumber(hit.dpi) : null;
  const pxWidthMeasured = hit ? parseNumber(hit.pxWidth) : null;
  // 三处字号证据取最小：清单自报 / PDF 实测 / qa_outputs 的安置字号。
  // 任何一处说字小了，就是小了——不许被另一处的大数字盖掉。
  const qaFont = qaFonts.get(String(pngName).replace(/\.[^.]+$/, '').toLowerCase()) ?? null;
  const fontCandidates = [fontMatch ? Number(fontMatch[1]) : null, minFontMeasured, qaFont].filter(
    (value) => value !== null && Number.isFinite(Number(value)),
  );
  const minFontsize = fontCandidates.length ? Math.min(...fontCandidates.map(Number)) : null;
  const fontSource = !fontCandidates.length
    ? ''
    : qaFont !== null && minFontsize === qaFont
      ? 'qa'
      : minFontMeasured !== null && minFontsize === minFontMeasured
        ? 'measure'
        : 'note';
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
    // 合并检查视图时按解析后的绝对路径去重（两份清单的相对写法可能不同）
    pngAbs: (pngProjectAbs && statOf(pngProjectAbs).exists) ? pngProjectAbs : pngAbs,
    pngExists: exists,
    note,
    status: declaredStatus,
    deliverable,
    palette: pick(row, ['palette']),
    declaredDpi,
    pxWidth: pxWidth ?? pxWidthMeasured,
    effectiveDpi: effectiveDpi ?? (pxWidthMeasured ? pxWidthMeasured / PLOT_INCHES : null),
    // 实测值不许被清单自报盖掉：清单写 9pt、实测 6pt 时，按 6pt 判（取两者更小的）
    minFontsize,
    minFontMeasured: minFontMeasured !== null,
    minFontQa: qaFont,
    fontSource,
    measuredDpi: dpiMeasured,
    dataHash: pick(row, ['data_hash']),
  };
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
    // coef_all.csv 是「所有模型的系数合并表」，不是第 N 个模型：
    // 把它当模型数会让「2 个模型」实际只有 1 个，N 对账也会多出一行假模型。
    const coefs = entries.filter((name) => /^coef_.*\.csv$/i.test(name) && !/^coef_all\.csv$/i.test(name));
    const aggregate = entries.some((name) => /^coef_all\.csv$/i.test(name));
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
      fitByStem.set(stem.toLowerCase(), entryOf(csv.rows.find((row) => parseNumber(row.n) !== null) || null));
      for (const row of csv.rows) {
        const key = String(row.model || '').trim().toLowerCase();
        if (key) fitByModel.set(key, entryOf(row));
      }
    }

    const models = coefs.map((name) => {
      const csv = readCsv(path.join(abs, name));
      const first = csv ? csv.rows.find((row) => parseNumber(row.n) !== null) : null;
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
      aggregate,
      meta,
    };
  }
  return { dir: '', models: [], fits: [], flowChecks: [], aggregate: false, meta: null };
}

/* ---------------------------- 数字溯源 ---------------------------- */

export function readVerify(projectRoot) {
  const candidates = [
    'output/verify/number_issues.csv',
    'output/qa/number_issues.csv',
    'output/terminal/number_issues.csv',
  ];
  const versionOf = (text) => {
    const match = String(text || '').match(/([0-9]+)\.([0-9]+)\.([0-9]+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const atLeast = (a, b) => {
    if (!a) return false;
    for (let i = 0; i < 3; i += 1) {
      if (a[i] > b[i]) return true;
      if (a[i] < b[i]) return false;
    }
    return true;
  };
  for (const rel of candidates) {
    const abs = path.join(projectRoot, rel);
    const csv = readCsv(abs);
    if (!csv || !csv.header.length) continue;
    // run.json 的 version 是工具版本：1.0.1 起 V-05 用 n（实际估计样本），
    // 1.0.1 之前误把 n_dropna（被剔除行数）当 N。两者必须分开解释。
    const runJson = readJson(path.join(path.dirname(abs), 'run.json')) || {};
    const toolVersion = String(runJson.version || '').trim();
    const parsedVersion = versionOf(toolVersion);
    const v05Legacy = !parsedVersion || !atLeast(parsedVersion, [1, 0, 1]);
    const counts = { error: 0, warning: 0, info: 0, unjudged: 0, deferred: 0, input: 0, v05Error: 0, v05Unverifiable: 0 };
    const deferred = [];
    const v05Errors = [];
    for (const row of csv.rows) {
      const severity = String(row.severity || '').toLowerCase();
      const check = String(row.check || row.check_id || row.rule || row.id || '').trim();
      // input/parse 类是「没得查」（缺文件、解析失败），不是「查出来有问题」。
      // 两者在台账里都记 error，但结论必须分开说。
      const inputClass = /^(input|parse|io|read|missing)$/i.test(check);
      if (inputClass) counts.input += 1;
      if (/^V[-_]?0?5$/i.test(check)) {
        if (v05Legacy) {
          // 旧版结果：n_dropna 语义错误，不能当统计结论，也不能长期当「待复核」规则。
          counts.deferred += 1;
          deferred.push(row);
          continue;
        }
        if (severity === 'error') {
          // V-05 的差异不等于数据错误（契约 §13）：单列，由 qa-v05 判「待复核」，
          // 不并进 qa-numbers 的 error——否则每个 N 口径没解释清的项目都会卡死在终检。
          counts.v05Error += 1;
          v05Errors.push(row);
          continue;
        }
        if (severity === 'warning' || severity === 'warn') {
          // 新版：只有 n_dropna 没有 n 时 V-05 明说「无法核对」——这是 unjudged，不是通过
          counts.v05Unverifiable += 1;
          counts.unjudged += 1;
          continue;
        }
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
      v05Errors,
      v05Legacy,
      toolVersion,
      mtimeMs: statOf(abs).mtimeMs || 0,
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
    .map((name) => {
      const abs = path.join(dir, name);
      return { name, json: readJson(abs), mtimeMs: statOf(abs).mtimeMs || 0 };
    })
    .filter((entry) => entry.json)
    // 最新的一份排前面：多次终检时，字号/错误数都该看最近这次，不能按文件名撞运气。
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 10);
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

/**
 * output/audit/corpus_files.csv 的原始行：内容新鲜度要用「审计当时记下的 md5」逐份比对。
 * 返回空数组表示没有这份账（不能当成「没有变化」）。
 */
export function readCorpusFiles(projectRoot) {
  const file = 'output/audit/corpus_files.csv';
  const csv = readCsv(path.join(projectRoot, file));
  if (!csv || !csv.rows.length) return { file, exists: Boolean(csv), rows: [] };
  return { file, exists: true, rows: csv.rows };
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
/** 与 audit_corpus.py 的默认 --skip-dir 一致：隔离目录不是语料，扫进来会让新鲜度永远对不上。 */
const CORPUS_SKIP_DIRS = new Set(['_duplicates']);

/**
 * 当前 data/ 的清单：文件数 + 字节数 + 逐文件 size/mtime（不哈希）。
 * 新鲜度判定用这份清单核对审计账（corpus_files.csv）的 md5；
 * 只 stat 不 hash，所以可以每 2–8 秒扫一次（哈希由 fingerprint.js 按 mtime 缓存）。
 */
export function corpusCurrentSignature(projectRoot, { force = false } = {}) {
  const root = path.join(projectRoot, 'data');
  const cacheKey = path.resolve(root);
  const now = Date.now();
  const cached = corpusScanCache.get(cacheKey);
  if (!force && cached && now - cached.at < CORPUS_SCAN_TTL) return cached.value;
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const seen = new Set();
  const inventory = new Map();
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
      if (CORPUS_SKIP_DIRS.has(name)) continue;
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
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      inventory.set(rel, { rel, abs, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root);
  const value = { root, files, bytes, truncated, inventory };
  corpusScanCache.set(cacheKey, { at: now, value });
  return value;
}

/**
 * 语料形态：哪些文件是表格数据（CSV/TSV/JSON/XLSX…），哪些是需要编码的文本。
 *
 * 依据是 skill 自己的分岔：make_coding_sheet.py 对 STRUCTURED_EXTS / kind=spreadsheet
 * 直接跳过并提示「use auto_stats or CSV pipeline」。插件的编码闸门必须跟着资料形态走，
 * 而不是对着一份 CSV 硬要 coding_sheet.csv。
 */
const TABULAR_EXTS = new Set(['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xlsx', 'xlsm', 'xls', 'sav', 'dta']);

export function corpusProfile(projectRoot) {
  const csv = readCsv(path.join(projectRoot, 'output/audit/corpus_files.csv'));
  if (!csv || !csv.rows.length) {
    return { known: false, total: 0, valid: 0, tabular: 0, documents: 0, other: 0, mode: 'unknown', sample: [] };
  }
  let valid = 0;
  let tabular = 0;
  let documents = 0;
  let other = 0;
  const tabularSample = [];
  const docSample = [];
  for (const row of csv.rows) {
    const status = String(row.status || '').trim().toLowerCase();
    if (status !== 'valid') continue;
    valid += 1;
    const ext = String(row.ext || '').trim().toLowerCase().replace(/^\./, '');
    const kind = String(row.kind || '').trim().toLowerCase();
    if (TABULAR_EXTS.has(ext) || kind === 'spreadsheet') {
      tabular += 1;
      if (tabularSample.length < 5) tabularSample.push(String(row.rel_path || row.relpath || row.name || ''));
    } else if (['pdf', 'docx', 'odt', 'pptx', 'html', 'text', 'legacy_office', 'image'].includes(kind)) {
      documents += 1;
      if (docSample.length < 5) docSample.push(String(row.rel_path || row.relpath || row.name || ''));
    } else {
      other += 1;
    }
  }
  const mode = !valid ? 'empty' : tabular === valid ? 'tables' : tabular === 0 ? 'documents' : 'mixed';
  return { known: true, total: csv.rows.length, valid, tabular, documents, other, mode, sample: mode === 'tables' ? tabularSample : docSample };
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
/**
 * manuscript.json 的现状：第 8 阶段真正吃的是它，docx 只是产物。
 * 骨架里会留「待补」占位段，这里数出来，面板才能说清「还差几段正文」。
 */
export function readManuscriptSpec(projectRoot) {
  const rel = 'manuscript.json';
  const file = path.join(projectRoot, rel);
  const info = statOf(file);
  if (!info.exists) return { rel, exists: false };
  let data = null;
  let error = '';
  let errorKind = '';
  try {
    // 记事本/部分编辑器会写成 UTF-8 with BOM：JSON.parse 在 \uFEFF 上直接失败，
    // 用户看到的是「manuscript 解析失败」，但文件本身是好的
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    error = String(err && err.message ? err.message : err).slice(0, 160);
    errorKind = 'parse';
  }
  if (!error) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      error = '顶层要是一个对象';
      errorKind = 'structure';
    } else if (!Array.isArray(data.blocks)) {
      error = 'blocks 必须是数组';
      errorKind = 'structure';
    } else if (!data.blocks.length) {
      error = 'blocks 是空的';
      errorKind = 'structure';
    }
  }
  const blocks = data && Array.isArray(data.blocks) ? data.blocks : [];
  const typeOf = (block) => String((block && block.type) || '');
  // 占位段只认骨架自己写的那一行（「待补：…」或显式 placeholder:true），
  // 正文里偶尔提到「待补充材料」不该被算成还没写
  const isPlaceholder = (block) =>
    typeOf(block) === 'para' && (block.placeholder === true || /^待补[:：]/.test(String(block.text || '').trim()));
  const figureBlocks = blocks.filter((block) => typeOf(block) === 'figure');
  const tableBlocks = blocks.filter((block) => typeOf(block) === 'table');
  const paraBlocks = blocks.filter((block) => typeOf(block) === 'para');
  const bodyText = blocks
    .filter((block) => ['para', 'heading', 'note'].includes(typeOf(block)))
    .map((block) => String((block && block.text) || ''))
    .join('\n');
  // 「图 N 被引用了吗」：正文里的图号是块顺序，不是文件名。
  // 只认「图 N」且 N 后面不能再跟数字，否则「图 1」会把「图 10」也算成引用过。
  const citedFigures = [];
  const uncitedFigures = [];
  const titlesMissing = [];
  figureBlocks.forEach((block, index) => {
    const n = index + 1;
    const pattern = new RegExp(`(?:图|figure|fig\\.?)\\s*${n}(?![0-9])`, 'i');
    if (pattern.test(bodyText)) citedFigures.push(n);
    else uncitedFigures.push(n);
    const caption = String((block && block.caption) || '').trim();
    // 技能生成的题注常常只有「注：N=…」——读者看不到这张图在讲什么
    if (!caption || /^注[:：]/.test(caption)) titlesMissing.push(n);
  });
  const tableWidths = tableBlocks.map((block, index) => {
    const rel = String((block && block.csv) || '').trim();
    const csv = rel ? readCsv(path.isAbsolute(rel) ? rel : path.join(projectRoot, rel)) : null;
    const cols = csv ? csv.header.length : 0;
    // assemble_manuscript.py 的列选择是 table 块的顶层 columns: [{col,label,fmt}]；
    // presentation.columns 是旧写法，仍兼容读取，但新稿必须写 columns。
    const topLevel = Array.isArray(block?.columns) ? block.columns.length : 0;
    const legacy = block && block.presentation && Array.isArray(block.presentation.columns)
      ? block.presentation.columns.length
      : 0;
    const selected = topLevel || legacy;
    const selectedBy = topLevel ? 'columns' : legacy ? 'presentation' : '';
    return { n: index + 1, cols, presentation: selected, selectedBy, csv: rel, exists: Boolean(csv) && cols > 0 };
  });
  const paraChars = paraBlocks.reduce((acc, block) => {
    const textValue = String((block && block.text) || '').trim();
    return isPlaceholder(block) ? acc : acc + textValue.length;
  }, 0);
  // 图块的 png 找不到时 assemble_manuscript 会直接 SpecError——提前报出来，
  // 别让用户以为是文稿内容的问题
  const missingPng = figureBlocks.filter((block) => {
    const png = String((block && block.png) || '').trim();
    if (!png) return true;
    const full = path.isAbsolute(png) ? png : path.join(projectRoot, png);
    return !statOf(full).exists;
  }).length;
  // 结构不可跑的块：技能脚本会直接 SpecError，这里先数出来，
  // 免得面板说「已就绪」、用户一跑就收到看不懂的错
  const allowed = new Set(['title', 'authors', 'heading', 'para', 'note', 'table', 'figure', 'pagebreak']);
  const invalidBlocks = blocks.filter((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return true;
    const kind = typeOf(block);
    if (!allowed.has(kind)) return true;
    if (kind !== 'table') return false;
    const csv = String(block.csv || '').trim();
    if (!csv) return true;
    const full = path.isAbsolute(csv) ? csv : path.join(projectRoot, csv);
    if (!statOf(full).exists) return true;
    try {
      return fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim()).length < 2;
    } catch {
      return true;
    }
  }).length;
  return {
    rel,
    exists: true,
    bytes: info.size,
    mtimeMs: info.mtimeMs,
    error,
    errorKind,
    blocks: blocks.length,
    figures: figureBlocks.length,
    figuresMissing: missingPng,
    invalidBlocks,
    tables: blocks.filter((block) => typeOf(block) === 'table').length,
    placeholders: blocks.filter(isPlaceholder).length,
    // 引用与呈现：三个新闸门（fig-cited / fig-title / tbl-present）都读这几个字段
    paras: paraBlocks.length,
    paraChars,
    citedFigures,
    uncitedFigures,
    titlesMissing,
    tableWidths,
  };
}

export function scanArtifacts(projectRoot) {
  const figures = readFigures(projectRoot);
  const enriched = figures.rows.map((row) => ({ ...row, badges: figureBadges(row) }));
  // 契约：status 不是 ok 的行不是交付物。闸门的分母只数交付物，
  // 但「清单里还有 N 行被跳过/报错」必须保留——那是另一个问题（渲染失败），不能静默丢。
  const deliverable = enriched.filter((row) => row.deliverable);
  const skipped = enriched.filter((row) => !row.deliverable && !String(row.status || '').toLowerCase().startsWith('error'));
  const errored = enriched.filter((row) => !row.deliverable && String(row.status || '').toLowerCase().startsWith('error'));
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
    corpusFiles: readCorpusFiles(projectRoot),
    corpusProfile: corpusProfile(projectRoot),
    codingSet: readCodingSet(projectRoot),
    skippedSet: readSkippedSet(projectRoot),
    corpusCurrent: corpusCurrentSignature(projectRoot),
    figures: {
      file: figures.file,
      files: figures.files || [],
      manifests: figures.manifests || [],
      rows: enriched,
      deliverable,
      skipped,
      errored,
      summary: { ...figureSummary(deliverable), declared: enriched.length, notDeliverable: skipped.length + errored.length },
    },
    models: readModels(projectRoot),
    verify: readVerify(projectRoot),
    qa: readQaReports(projectRoot),
    manuscript: { ...statOf(path.join(projectRoot, 'output', 'manuscript.docx')), spec: readManuscriptSpec(projectRoot) },
    research: readResearchLayer(projectRoot),
    analysisRel: analysisTarget.rel,
    analysisCsv: statOf(analysisTarget.abs),
    analysis: readAnalysisSummary(projectRoot),
    tables,
  };
}

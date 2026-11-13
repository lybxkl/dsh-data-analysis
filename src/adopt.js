/**
 * 从「v1 约定路径」的现有产物里推断出 v2 注册表。
 *
 * 只在用户明确点「采纳现有产物」时跑：生成的条目全部带
 *   generatedBy: "adapter"、confidence: "inferred"、confirmedByHuman: false
 * 因为这是**猜出来**的结构——列类型、单位、缺失原因、模型族都得有人复核过才算数。
 * 不猜的东西一律留空（例如 missingKind、dropReasons、诊断），让闸门如实说「判不了」。
 */

import fs from 'node:fs';
import path from 'node:path';

import { analysisFile, readCsv, readFigures, readManuscriptSpec, readModels, statOf } from './audit.js';
import { readRegistry, writeRegistry } from './registry.js';

const UNIT_RULES = [
  { unit: 'defendant', keys: ['defendant_name', 'defendant', 'defendant_idx'] },
  { unit: 'case', keys: ['case_id', 'case_no'] },
  { unit: 'court', keys: ['court_code', 'court_name'] },
  { unit: 'document', keys: ['rel_path', 'relpath', 'doc_id', 'file'] },
];

function inferUnit(header) {
  const lower = header.map((name) => String(name || '').toLowerCase());
  for (const rule of UNIT_RULES) {
    if (rule.keys.some((key) => lower.includes(key))) return rule.unit;
  }
  return 'other';
}

function inferGrain(header) {
  const preferred = ['doc_id', 'rel_path', 'case_id', 'defendant_idx', 'defendant_name', 'id'];
  const picked = preferred.filter((key) => header.includes(key));
  return picked.length ? picked.slice(0, 2) : header.slice(0, 1);
}

function looksNumeric(values) {
  let seen = 0;
  let numeric = 0;
  for (const value of values) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    seen += 1;
    if (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(raw)) numeric += 1;
    if (seen >= 60) break;
  }
  return seen > 0 && numeric / seen >= 0.9;
}

function inferColumns(header, rows) {
  return header.map((name, index) => {
    const values = rows.slice(0, 200).map((row) => row[name]);
    const missing = rows.reduce((acc, row) => (String(row[name] ?? '').trim() ? acc : acc + 1), 0);
    let type = 'category';
    if (/^in_analysis$/i.test(name)) type = 'boolean';
    else if (/_src$|_page$|_id$|^id$/i.test(name)) type = 'id';
    else if (looksNumeric(values)) type = 'number';
    else if (values.slice(0, 20).every((value) => /^(0|1|true|false)$/i.test(String(value ?? '').trim()) && String(value ?? '').trim() !== '')) type = 'boolean';
    return {
      name,
      type,
      unit: '',
      missing,
      // 推断不出「为什么缺」：留 unknown，别猜成结构性缺失
      missingKind: 'unknown',
      note: '',
    };
  });
}

function splitCaption(caption) {
  const raw = String(caption || '').trim();
  if (!raw) return { title: '', note: '' };
  if (/^注[:：]/.test(raw)) return { title: '', note: raw };
  const at = raw.indexOf('注：');
  if (at > 0) return { title: raw.slice(0, at).trim(), note: raw.slice(at).trim() };
  return { title: raw, note: '' };
}

function csvShape(projectRoot, rel) {
  const csv = readCsv(path.join(projectRoot, rel));
  if (!csv) return { rows: 0, cols: 0 };
  return { rows: csv.rows.length, cols: csv.header.length };
}

/**
 * @param {string} projectRoot
 * @param {{overwrite?: boolean}} options
 * @returns {{ok:boolean, error?:string, counts?:object, files?:object, warnings:string[]}}
 */
export function adoptLegacy(projectRoot, { overwrite = false } = {}) {
  const current = readRegistry(projectRoot);
  // 读不懂的注册表不能当空表覆盖：宁可让用户先修 JSON（或显式 overwrite）
  const broken = [current.datasets, current.models, current.artifacts].find((slot) => slot.exists && slot.error);
  if (broken && !overwrite) {
    return { ok: false, error: `注册表读不懂（${broken.error}）：先修好那份 JSON，或用 overwrite 明确重排` };
  }
  const existing = current.datasets.rows.length + current.models.rows.length + current.artifacts.rows.length;
  if (existing && !overwrite) {
    return {
      ok: false,
      error: `已经有 ${existing} 条注册记录。确实要按现有产物重新推断（会覆盖 index.json），请显式 overwrite。`,
    };
  }

  const warnings = [];
  const datasets = [];
  const models = [];
  const artifacts = [];
  const now = new Date().toISOString();

  /* ------------------------------ 数据集 ------------------------------ */
  const target = analysisFile(projectRoot);
  const analysis = readCsv(target.abs);
  if (analysis && analysis.rows.length) {
    const header = analysis.header;
    const inColumn = header.includes('in_analysis') ? 'in_analysis' : '';
    let inN = null;
    if (inColumn) {
      inN = analysis.rows.reduce((acc, row) => (String(row[inColumn] ?? '').trim() === '1' ? acc + 1 : acc), 0);
    } else {
      warnings.push(`${target.rel} 没有 in_analysis 列：纳入样本量只能留空，模型 N 对账会判不了`);
    }
    datasets.push({
      id: 'analysis',
      title: '分析宽表（现有产物）',
      unit: inferUnit(header),
      grainKeys: inferGrain(header),
      file: target.rel,
      rows: analysis.rows.length,
      columns: inferColumns(header, analysis.rows),
      inAnalysis: { column: inColumn, rule: inColumn ? `${inColumn} == 1` : '', n: inN },
      source: { mount: '', files: null },
      provenance: {
        cells: `output/datasets/${'analysis'}/extract.jsonl`,
        derived: `output/datasets/${'analysis'}/derivations.csv`,
        sourceColumn: header.includes('rel_path') ? 'rel_path' : '',
        quoteColumn: header.includes('raw_item') ? 'raw_item' : '',
        sourceRoot: 'data',
      },
      generatedBy: 'adapter',
      confidence: 'inferred',
      confirmedByHuman: false,
      updatedAt: now,
    });
  }

  const codingRel = 'output/coding/dataset.csv';
  const coding = readCsv(path.join(projectRoot, codingRel));
  if (coding && coding.rows.length) {
    datasets.push({
      id: 'coding',
      title: '编码阶段宽表（技能产物 dataset.csv）',
      unit: inferUnit(coding.header),
      grainKeys: inferGrain(coding.header),
      file: codingRel,
      rows: coding.rows.length,
      columns: inferColumns(coding.header, coding.rows),
      inAnalysis: { column: '', rule: '', n: null },
      source: { mount: '', files: null },
      provenance: {
        cells: 'output/datasets/coding/extract.jsonl',
        derived: 'output/datasets/coding/derivations.csv',
        sourceColumn: coding.header.includes('rel_path') ? 'rel_path' : '',
        quoteColumn: '',
        sourceRoot: 'data',
      },
      generatedBy: 'adapter',
      confidence: 'inferred',
      confirmedByHuman: false,
      updatedAt: now,
    });
  }

  /* ------------------------------- 模型 ------------------------------- */
  const specPath = path.join(projectRoot, 'model_spec.json');
  let spec = null;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    spec = null;
  }
  const specById = new Map();
  for (const item of Array.isArray(spec?.models) ? spec.models : []) {
    if (item && item.id) specById.set(String(item.id), item);
  }
  const found = readModels(projectRoot);
  const analysisIn = datasets.find((item) => item.id === 'analysis');
  for (const model of found.models) {
    // coef_all.csv 是多模型汇总表，不是模型：把它当模型登记会让 models-index 直接 fail。
    // main/pooled 只在「没有别的系数表」时才算一个模型——单模型项目本来就常叫 coef_main.csv。
    const stem = String(model.id || '').toLowerCase();
    if (/^(all|combined)$/.test(stem)) continue;
    if (/^(main|pooled)$/.test(stem) && found.models.length > 1) continue;
    const coefRows = readCsv(path.join(projectRoot, model.file));
    const modelColumn = coefRows && coefRows.header.includes('model') ? coefRows.header.indexOf('model') : -1;
    if (modelColumn >= 0) {
      const distinct = new Set(coefRows.rows.map((row) => String(row.model ?? '').trim()).filter(Boolean));
      if (distinct.size > 1) continue; // 一张表里好几个模型：这是汇总表，不是单个模型
    }
    const declared = specById.get(model.id);
    const type = String(declared?.type || '').toLowerCase();
    const estimator = type === 'logit' ? 'logit' : type === 'ols' ? 'ols' : 'unknown';
    if (estimator === 'unknown') warnings.push(`${model.id} 在 model_spec.json 里没有登记估计量：先按 unknown 记录，请复核后改准`);
    const n = model.n;
    const base = analysisIn?.inAnalysis?.n;
    const dropped = Number.isFinite(n) && Number.isFinite(base) && base >= n ? base - n : null;
    models.push({
      id: model.id,
      estimator,
      family: estimator === 'logit' ? 'binomial' : estimator === 'ols' ? 'gaussian' : '',
      link: estimator === 'logit' ? 'logit' : estimator === 'ols' ? 'identity' : '',
      outcome: String(declared?.outcome || ''),
      dataset: analysisIn ? 'analysis' : '',
      terms: Array.isArray(declared?.predictors) ? declared.predictors.map(String) : [],
      n,
      events: null,
      clusters: null,
      clusterVar: String(spec?.models?.find?.((item) => item.id === model.id)?.cluster || spec?.cluster || ''),
      se: String(declared?.cov || spec?.cov || ''),
      dropped,
      dropReasons: {},
      coef: model.file,
      fit: model.fitFile || '',
      diagnostics: { vifMax: null, separation: false, converged: null, note: '' },
      flags: [],
      status: 'estimated',
      updatedAt: now,
    });
  }

  /* ------------------------------- 产物 ------------------------------- */
  const fromManuscript = readManuscriptSpec(projectRoot);
  const figureRows = readFigures(projectRoot).rows;
  const byPng = new Map();
  for (const row of figureRows) {
    if (row.png) byPng.set(String(row.png).replace(/\\/g, '/'), row);
  }

  // 编号优先按 manuscript.json 的 figure 块顺序（正文里的「图 N」就是它），
  // 没有手稿时退回清单顺序——否则引用检查会整体错位。
  let ordinal = 0;
  const citedPng = new Set();
  if (fromManuscript.exists && !fromManuscript.error) {
    const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manuscript.json'), 'utf8').replace(/^\uFEFF/, ''));
    for (const block of Array.isArray(raw.blocks) ? raw.blocks : []) {
      if (!block || block.type !== 'figure') continue;
      ordinal += 1;
      const png = String(block.png || '').replace(/\\/g, '/');
      citedPng.add(png);
      const row = byPng.get(png) || {};
      const { title, note } = splitCaption(block.caption);
      artifacts.push({
        id: `fig:${ordinal}`,
        kind: 'figure',
        path: png,
        title,
        note,
        dpi: row.effectiveDpi ?? null,
        minFont: row.minFontsize ?? null,
        n: Number(block.n) > 0 ? Number(block.n) : row.n ?? null,
        section: row.section || '',
        dataHash: row.dataHash || '',
        rows: null,
        cols: null,
        presentation: { columns: [], format: '' },
        source: 'manuscript.json',
        confidence: 'inferred',
        updatedAt: now,
      });
    }
  } else {
    for (const row of figureRows) {
      ordinal += 1;
      const { title, note } = splitCaption(row.caption);
      artifacts.push({
        id: `fig:${ordinal}`,
        kind: 'figure',
        path: row.png,
        title,
        note,
        dpi: row.effectiveDpi ?? null,
        minFont: row.minFontsize ?? null,
        n: row.n ?? null,
        section: row.section || '',
        dataHash: row.dataHash || '',
        rows: null,
        cols: null,
        presentation: { columns: [], format: '' },
        source: 'chart_manifest.csv',
        confidence: 'inferred',
        updatedAt: now,
      });
    }
  }
  if (fromManuscript.exists && figureRows.length && ordinal < figureRows.length) {
    warnings.push(`清单有 ${figureRows.length} 张图，手稿只嵌了 ${ordinal} 张：多出来的 ${figureRows.length - ordinal} 张不会出现在正文里`);
  }
  if (!figureRows.length) warnings.push('没有找到 chart_manifest.csv：产物注册表里不会有图');

  if (fromManuscript.exists && !fromManuscript.error) {
    const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manuscript.json'), 'utf8').replace(/^\uFEFF/, ''));
    let tableIndex = 0;
    for (const block of Array.isArray(raw.blocks) ? raw.blocks : []) {
      if (!block || block.type !== 'table') continue;
      tableIndex += 1;
      const rel = String(block.csv || '').replace(/\\/g, '/');
      const shape = csvShape(projectRoot, rel);
      artifacts.push({
        id: `tbl:${tableIndex}`,
        kind: 'table',
        path: rel,
        title: String(block.caption || ''),
        note: '',
        dpi: null,
        minFont: null,
        n: null,
        section: '',
        dataHash: '',
        rows: shape.rows,
        cols: shape.cols,
        presentation: { columns: [], format: '' },
        source: 'manuscript.json',
        confidence: 'inferred',
        updatedAt: now,
      });
    }
  }

  const docx = statOf(path.join(projectRoot, 'output', 'manuscript.docx'));
  if (docx.exists) {
    artifacts.push({
      id: 'doc:main',
      kind: 'document',
      path: 'output/manuscript.docx',
      title: '成稿',
      note: '',
      dpi: null,
      minFont: null,
      n: null,
      section: '',
      dataHash: '',
      rows: null,
      cols: null,
      presentation: { columns: [], format: '' },
      source: 'adapter',
      confidence: 'inferred',
      updatedAt: now,
    });
  }

  if (!datasets.length && !models.length && !artifacts.length) {
    return { ok: false, error: '没找到可以采纳的产物（analysis.csv / coef_*.csv / chart_manifest.csv 都没有）' };
  }

  writeRegistry(projectRoot, 'datasets', datasets);
  writeRegistry(projectRoot, 'models', models);
  writeRegistry(projectRoot, 'artifacts', artifacts);

  return {
    ok: true,
    counts: { datasets: datasets.length, models: models.length, artifacts: artifacts.length },
    files: { datasets: 'output/datasets/index.json', models: 'output/models/index.json', artifacts: 'output/artifacts/index.json' },
    warnings,
    note: '条目是推断出来的（confidence=inferred）：列类型、单位、缺失原因、模型族请复核后用 data_analysis_register（action=confirm）确认。',
  };
}

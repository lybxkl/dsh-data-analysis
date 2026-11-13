/**
 * v2 契约层：数据集 / 模型 / 产物 / 结论 的注册表与校验。
 *
 * 为什么要有这一层：
 *   v1 的闸门认的是「约定俗成的路径」（output/dataset/analysis.csv、coef_*.csv、
 *   output/chart_pack/chart_manifest.csv）。一旦研究里出现第二份数据集、第二种估计量、
 *   自绘图，所有闸门就同时失明——用户看到的是全绿，实际什么都没查。
 *   这里把「产物是什么」写成数据（index.json），闸门只读注册表；路径怎么放、用哪个脚本，
 *   交给模型自己决定。
 *
 * 三条硬规矩：
 *   1. 注册表是**声明**，不是证据：声明了没产出 → fail；产出了没声明 → warn。
 *   2. 读不懂的注册表不许当成空表：解析失败要报出来（否则闸门会假绿）。
 *   3. 迁移生成的条目带 `generatedBy:"adapter"` 与 `confirmedByHuman:false`：
 *      机器猜出来的结构可以参与校验，但在人确认之前不许冒充「已核实」。
 */

import fs from 'node:fs';
import path from 'node:path';

import { readCsv, statOf } from './audit.js';

export const REGISTRY_VERSION = 2;

export const REGISTRY_FILES = {
  datasets: 'output/datasets/index.json',
  models: 'output/models/index.json',
  artifacts: 'output/artifacts/index.json',
  claims: 'output/claims/claims.jsonl',
  sweep: 'output/models/sweep.json',
  measure: 'output/artifacts/measure.json',
  cells: 'output/verify/cell_checks.csv',
};

export const DATASET_UNITS = ['document', 'case', 'defendant', 'court', 'year', 'region', 'other'];
export const COLUMN_TYPES = ['number', 'integer', 'boolean', 'category', 'text', 'date', 'id'];
export const MISSING_KINDS = ['item', 'structural', 'unit', 'unknown'];
export const ARTIFACT_KINDS = ['figure', 'table', 'document', 'dataset', 'other'];
export const FAMILY_STATUS = ['estimated', 'available', 'blocked', 'not_needed', 'unknown'];

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/* ------------------------------- 小工具 ------------------------------- */

function text(value, max = 400) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function numOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intOr(value, fallback = 0) {
  const n = numOrNull(value);
  return n === null ? fallback : Math.trunc(n);
}

function boolOr(value, fallback = false) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function relSafe(value) {
  const rel = String(value || '').replace(/\\/g, '/').trim();
  if (!rel) return '';
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return rel; // 绝对路径原样保留，越界由闸门判
  return rel.replace(/^\.\/+/, '');
}

/** 项目内的相对路径（闸门用来判断文件在不在）。 */
export function projectPath(projectRoot, rel) {
  const value = String(rel || '');
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

function issue(code, where, message, severity = 'error') {
  return { code, where, message, severity };
}

/* ------------------------------- schema ------------------------------- */

export function normalizeDataset(raw = {}) {
  const inAnalysis = raw.inAnalysis || raw.in_analysis || {};
  return {
    id: text(raw.id, 64),
    title: text(raw.title || raw.name, 120),
    unit: DATASET_UNITS.includes(raw.unit) ? raw.unit : 'other',
    grainKeys: arr(raw.grainKeys || raw.keys).map((key) => text(key, 80)).filter(Boolean),
    file: relSafe(raw.file),
    rows: intOr(raw.rows, 0),
    columns: arr(raw.columns).map((column) => ({
      name: text(column?.name, 80),
      type: COLUMN_TYPES.includes(column?.type) ? column.type : 'unknown',
      unit: text(column?.unit, 24),
      missing: numOrNull(column?.missing),
      missingKind: MISSING_KINDS.includes(column?.missingKind) ? column.missingKind : 'unknown',
      note: text(column?.note, 200),
    })),
    inAnalysis: {
      column: text(inAnalysis.column, 80),
      rule: text(inAnalysis.rule, 160),
      n: numOrNull(inAnalysis.n),
    },
    source: {
      mount: text(raw.source?.mount, 120),
      files: numOrNull(raw.source?.files),
    },
    provenance: {
      cells: relSafe(raw.provenance?.cells),
      derived: relSafe(raw.provenance?.derived),
      sourceColumn: text(raw.provenance?.sourceColumn, 80),
      quoteColumn: text(raw.provenance?.quoteColumn, 80),
      sourceRoot: relSafe(raw.provenance?.sourceRoot) || 'data',
    },
    generatedBy: text(raw.generatedBy, 160),
    confidence: raw.confidence === 'inferred' ? 'inferred' : 'declared',
    confirmedByHuman: boolOr(raw.confirmedByHuman, false),
    updatedAt: text(raw.updatedAt, 40),
  };
}

export function validateDataset(dataset) {
  const errors = [];
  const warnings = [];
  if (!dataset.id) errors.push(issue('dataset.id', 'dataset.id', '缺 id'));
  else if (!ID_RE.test(dataset.id)) errors.push(issue('dataset.id.format', 'dataset.id', `id 只能是字母数字与 ._:-（收到 ${dataset.id}）`));
  if (!dataset.file) errors.push(issue('dataset.file', 'dataset.file', '缺 file（CSV 路径）'));
  if (!dataset.title) warnings.push(issue('dataset.title', 'dataset.title', '缺 title：面板里会只显示 id', 'warn'));
  if (!dataset.columns.length) warnings.push(issue('dataset.columns', 'dataset.columns', '没有列定义：列类型与缺失无法核对', 'warn'));
  if (!dataset.inAnalysis.column) warnings.push(issue('dataset.inAnalysis', 'dataset.inAnalysis', '缺 inAnalysis.column：纳入样本量无法复算', 'warn'));
  else if (dataset.inAnalysis.n === null) warnings.push(issue('dataset.inAnalysis.n', 'dataset.inAnalysis.n', '缺 inAnalysis.n：无法与模型 N 对账', 'warn'));
  for (const key of dataset.grainKeys) {
    if (!dataset.columns.some((column) => column.name === key) && dataset.columns.length) {
      warnings.push(issue('dataset.grain', `dataset.grainKeys.${key}`, `主键 ${key} 不在列定义里`, 'warn'));
    }
  }
  return { ok: !errors.length, errors, warnings };
}

export function normalizeModel(raw = {}) {
  const diagnostics = raw.diagnostics && typeof raw.diagnostics === 'object' ? raw.diagnostics : {};
  const dropReasons = {};
  for (const [key, value] of Object.entries(raw.dropReasons && typeof raw.dropReasons === 'object' ? raw.dropReasons : {})) {
    const n = numOrNull(value);
    if (n !== null) dropReasons[text(key, 60)] = Math.trunc(n);
  }
  return {
    id: text(raw.id, 64),
    estimator: text(raw.estimator || raw.type, 40),
    family: text(raw.family, 40),
    link: text(raw.link, 40),
    outcome: text(raw.outcome, 80),
    dataset: text(raw.dataset, 64),
    terms: arr(raw.terms || raw.predictors).map((term) => text(term, 80)).filter(Boolean),
    n: numOrNull(raw.n),
    events: numOrNull(raw.events),
    clusters: numOrNull(raw.clusters),
    clusterVar: text(raw.clusterVar, 80),
    se: text(raw.se, 40),
    dropped: numOrNull(raw.dropped),
    dropReasons,
    coef: relSafe(raw.coef),
    fit: relSafe(raw.fit),
    diagnostics: {
      vifMax: numOrNull(diagnostics.vifMax),
      separation: diagnostics.separation === true,
      converged: diagnostics.converged === undefined ? null : diagnostics.converged === true,
      note: text(diagnostics.note, 200),
    },
    flags: arr(raw.flags).map((flag) => text(flag, 160)).filter(Boolean),
    status: ['estimated', 'failed', 'skipped'].includes(raw.status) ? raw.status : 'estimated',
    updatedAt: text(raw.updatedAt, 40),
  };
}

export function validateModel(model) {
  const errors = [];
  const warnings = [];
  if (!model.id) errors.push(issue('model.id', 'model.id', '缺 id'));
  else if (!ID_RE.test(model.id)) errors.push(issue('model.id.format', 'model.id', `id 格式不对（${model.id}）`));
  if (!model.estimator) errors.push(issue('model.estimator', 'model.estimator', '缺 estimator（ols / logit / poisson / cox …）'));
  if (!model.outcome) errors.push(issue('model.outcome', 'model.outcome', '缺 outcome'));
  if (model.n === null) warnings.push(issue('model.n', 'model.n', '缺 n：无法与漏斗对账', 'warn'));
  if (!model.terms.length) warnings.push(issue('model.terms', 'model.terms', '没有 terms：无法核对用到的变量', 'warn'));
  if (model.dropped !== null) {
    const sum = Object.values(model.dropReasons).reduce((acc, n) => acc + n, 0);
    if (!sum) warnings.push(issue('model.dropReasons', `model.${model.id}.dropReasons`, '声明了 dropped 却没写原因分布', 'warn'));
    else if (sum !== model.dropped) warnings.push(issue('model.dropReasons.sum', `model.${model.id}.dropReasons`, `原因加总 ${sum} ≠ dropped ${model.dropped}`, 'warn'));
  }
  return { ok: !errors.length, errors, warnings };
}

export function normalizeArtifact(raw = {}) {
  return {
    id: text(raw.id, 64),
    kind: ARTIFACT_KINDS.includes(raw.kind) ? raw.kind : 'other',
    path: relSafe(raw.path),
    title: text(raw.title, 200),
    note: text(raw.note, 400),
    dpi: numOrNull(raw.dpi),
    minFont: numOrNull(raw.minFont || raw.minFontsize),
    n: numOrNull(raw.n),
    section: text(raw.section, 40),
    dataHash: text(raw.dataHash, 120),
    rows: numOrNull(raw.rows),
    cols: numOrNull(raw.cols),
    presentation: {
      columns: arr(raw.presentation?.columns).map((column) => text(column, 80)).filter(Boolean),
      format: text(raw.presentation?.format, 40),
    },
    source: text(raw.source, 120),
    confidence: raw.confidence === 'inferred' ? 'inferred' : 'declared',
    updatedAt: text(raw.updatedAt, 40),
  };
}

export function validateArtifact(artifact) {
  const errors = [];
  const warnings = [];
  if (!artifact.id) errors.push(issue('artifact.id', 'artifact.id', '缺 id'));
  else if (!ID_RE.test(artifact.id)) errors.push(issue('artifact.id.format', 'artifact.id', `id 格式不对（${artifact.id}）`));
  if (!artifact.path) errors.push(issue('artifact.path', 'artifact.path', '缺 path'));
  if (!artifact.title && artifact.kind === 'figure') {
    warnings.push(issue('artifact.title', `artifact.${artifact.id}.title`, '图没有 title：读者只能看到「注：」', 'warn'));
  }
  if (artifact.kind === 'table' && artifact.cols && artifact.cols > 12 && !artifact.presentation.columns.length) {
    warnings.push(issue('artifact.table.width', `artifact.${artifact.id}`, `表有 ${artifact.cols} 列且没声明展示列：放进文档会挤成一团`, 'warn'));
  }
  return { ok: !errors.length, errors, warnings };
}

export function normalizeClaim(raw = {}) {
  const assert = raw.assert && typeof raw.assert === 'object' ? raw.assert : null;
  return {
    id: text(raw.id, 64),
    where: text(raw.where, 200),
    text: text(raw.text, 600),
    assert: assert
      ? {
          op: text(assert.op, 20),
          // 兼容旧写法 ref/value：不认这两个别名的话，模型照旧文档写出来的断言会静默变成空操作数
          left: text(assert.left ?? assert.ref, 160),
          right: (() => {
            const raw = assert.right !== undefined ? assert.right : assert.value;
            return typeof raw === 'number' ? raw : text(raw, 160);
          })(),
          from: numOrNull(assert.from),
          to: numOrNull(assert.to),
        }
      : null,
    evidence: arr(raw.evidence).map((ref) => text(ref, 160)).filter(Boolean),
    status: ['supported', 'refuted', 'unverified', 'waived'].includes(raw.status) ? raw.status : 'unverified',
    note: text(raw.note, 300),
    checkedAt: text(raw.checkedAt, 40),
  };
}

export function validateClaim(claim) {
  const errors = [];
  const warnings = [];
  if (!claim.id) errors.push(issue('claim.id', 'claim.id', '缺 id'));
  else if (!ID_RE.test(claim.id)) errors.push(issue('claim.id.format', 'claim.id', `id 格式不对（${claim.id}）`));
  if (!claim.text) warnings.push(issue('claim.text', 'claim.text', '缺 text：无法知道这句结论是什么', 'warn'));
  if (!claim.assert) warnings.push(issue('claim.assert', `claim.${claim.id}.assert`, '没有 assert：只能人工读，闸门判不了', 'warn'));
  else if (!['gt', 'lt', 'gte', 'lte', 'eq', 'ne', 'abs_gt', 'in_range'].includes(claim.assert.op)) {
    errors.push(issue('claim.assert.op', `claim.${claim.id}.assert.op`, `不支持的比较 ${claim.assert.op}`));
  } else if (claim.assert.op === 'in_range') {
    if (claim.assert.from === null || claim.assert.to === null) {
      errors.push(issue('claim.assert.range', `claim.${claim.id}.assert`, 'in_range 缺 from/to：写不全就别写，闸门会把格式问题当成「数据反驳结论」'));
    }
  } else if (!claim.assert.left || claim.assert.right === '' || claim.assert.right === null) {
    // 空操作数是「写错了」，不是「判不了」：不报出来，这条结论就永远抓不到假
    errors.push(issue('claim.assert.operand', `claim.${claim.id}.assert`, 'assert 缺 left/right（引用写成 M1.coef.<term>.beta 或 dataset:<id>.rows）'));
  }
  if (!claim.evidence.length) warnings.push(issue('claim.evidence', `claim.${claim.id}.evidence`, '没有 evidence：结论与产物没绑定', 'warn'));
  return { ok: !errors.length, errors, warnings };
}

export function normalizeSweep(raw = {}) {
  return {
    generatedBy: text(raw.generatedBy, 120),
    at: text(raw.at, 40),
    outcomes: arr(raw.outcomes).map((outcome) => ({
      name: text(outcome?.name, 80),
      dataset: text(outcome?.dataset, 64),
      role: text(outcome?.role, 60),
      type: text(outcome?.type, 30),
      n: numOrNull(outcome?.n),
      censored: outcome?.censored === true,
      note: text(outcome?.note, 200),
      families: arr(outcome?.families).map((family) => ({
        family: text(family?.family, 60),
        status: FAMILY_STATUS.includes(family?.status) ? family.status : 'unknown',
        model: text(family?.model, 64),
        why: text(family?.why, 300),
      })),
    })),
  };
}

export function validateSweep(sweep) {
  const errors = [];
  const warnings = [];
  if (!sweep.outcomes.length) errors.push(issue('sweep.outcomes', 'sweep.outcomes', '普查表是空的'));
  for (const outcome of sweep.outcomes) {
    if (!outcome.name) errors.push(issue('sweep.outcome.name', 'sweep.outcomes[].name', '有结局变量没写名字'));
    if (!outcome.families.length) warnings.push(issue('sweep.families', `sweep.${outcome.name}`, '这个结局一个族都没表态', 'warn'));
    for (const family of outcome.families) {
      if (!family.family) errors.push(issue('sweep.family', `sweep.${outcome.name}`, '有族没写名字'));
      if ((family.status === 'blocked' || family.status === 'not_needed') && !family.why) {
        errors.push(issue('sweep.why', `sweep.${outcome.name}.${family.family}`, `${family.status} 必须写 why（否则等于没说）`));
      }
      if (family.status === 'estimated' && !family.model) {
        warnings.push(issue('sweep.model', `sweep.${outcome.name}.${family.family}`, 'estimated 但没指向具体模型', 'warn'));
      }
    }
  }
  return { ok: !errors.length, errors, warnings };
}

/* ------------------------------- 读写 ------------------------------- */

function emptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    datasets: { file: REGISTRY_FILES.datasets, exists: false, error: '', rows: [], issues: [] },
    models: { file: REGISTRY_FILES.models, exists: false, error: '', rows: [], issues: [] },
    artifacts: { file: REGISTRY_FILES.artifacts, exists: false, error: '', rows: [], issues: [] },
    claims: { file: REGISTRY_FILES.claims, exists: false, error: '', rows: [], issues: [] },
    sweep: { file: REGISTRY_FILES.sweep, exists: false, error: '', value: null, issues: [] },
    measure: { file: REGISTRY_FILES.measure, exists: false, value: null },
    cells: { file: REGISTRY_FILES.cells, exists: false, rows: 0, counts: { pass: 0, noise: 0, missing: 0, unreadable: 0, short: 0, unjudged: 0 } },
    legacy: true,
    issues: [],
  };
}

function readJsonFile(projectRoot, rel) {
  const abs = path.join(projectRoot, rel);
  const info = statOf(abs);
  if (!info.exists) return { exists: false, value: null, error: '' };
  try {
    const value = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
    return { exists: true, value, error: '' };
  } catch (err) {
    return { exists: true, value: null, error: `解析失败：${String(err && err.message ? err.message : err).slice(0, 160)}` };
  }
}

function readJsonlFile(projectRoot, rel, normalize, validate) {
  const abs = path.join(projectRoot, rel);
  const info = statOf(abs);
  if (!info.exists) return { exists: false, rows: [], error: '', issues: [] };
  const rows = [];
  const issues = [];
  let raw = '';
  try {
    raw = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    return { exists: true, rows: [], error: `读不了：${String(err && err.message ? err.message : err).slice(0, 160)}`, issues: [] };
  }
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      issues.push(issue('jsonl.parse', `${rel}:${index + 1}`, '这一行不是合法 JSON', 'error'));
      return;
    }
    const row = normalize(parsed);
    const check = validate(row);
    for (const item of [...check.errors, ...check.warnings]) {
      issues.push({ ...item, where: `${rel}:${index + 1} ${item.where}` });
    }
    rows.push(row);
  });
  return { exists: true, rows, error: '', issues };
}

/** 读三份注册表 + 两本台账；任何一份读不懂都要报出来，不许当成空表。 */
export function readRegistry(projectRoot) {
  const registry = emptyRegistry();

  const datasets = readJsonFile(projectRoot, REGISTRY_FILES.datasets);
  if (datasets.error) {
    registry.datasets.error = datasets.error;
    registry.datasets.exists = true;
    registry.issues.push(issue('registry.datasets', REGISTRY_FILES.datasets, datasets.error));
  } else if (datasets.exists) {
    registry.datasets.exists = true;
    const list = arr(datasets.value?.datasets).map(normalizeDataset);
    registry.datasets.rows = list;
    for (const item of list) {
      const check = validateDataset(item);
      for (const err of check.errors) registry.datasets.issues.push({ ...err, where: `${REGISTRY_FILES.datasets}#${item.id || '?'}` });
      for (const warn of check.warnings) registry.datasets.issues.push({ ...warn, where: `${REGISTRY_FILES.datasets}#${item.id || '?'}` });
    }
  }

  const models = readJsonFile(projectRoot, REGISTRY_FILES.models);
  if (models.error) {
    registry.models.error = models.error;
    registry.models.exists = true;
    registry.issues.push(issue('registry.models', REGISTRY_FILES.models, models.error));
  } else if (models.exists) {
    registry.models.exists = true;
    const list = arr(models.value?.models).map(normalizeModel);
    registry.models.rows = list;
    for (const item of list) {
      const check = validateModel(item);
      for (const err of check.errors) registry.models.issues.push({ ...err, where: `${REGISTRY_FILES.models}#${item.id || '?'}` });
      for (const warn of check.warnings) registry.models.issues.push({ ...warn, where: `${REGISTRY_FILES.models}#${item.id || '?'}` });
    }
  }

  const artifacts = readJsonFile(projectRoot, REGISTRY_FILES.artifacts);
  if (artifacts.error) {
    registry.artifacts.error = artifacts.error;
    registry.artifacts.exists = true;
    registry.issues.push(issue('registry.artifacts', REGISTRY_FILES.artifacts, artifacts.error));
  } else if (artifacts.exists) {
    registry.artifacts.exists = true;
    const list = arr(artifacts.value?.artifacts).map(normalizeArtifact);
    registry.artifacts.rows = list;
    for (const item of list) {
      const check = validateArtifact(item);
      for (const err of check.errors) registry.artifacts.issues.push({ ...err, where: `${REGISTRY_FILES.artifacts}#${item.id || '?'}` });
      for (const warn of check.warnings) registry.artifacts.issues.push({ ...warn, where: `${REGISTRY_FILES.artifacts}#${item.id || '?'}` });
    }
  }

  const claims = readJsonlFile(projectRoot, REGISTRY_FILES.claims, normalizeClaim, validateClaim);
  registry.claims.exists = claims.exists;
  registry.claims.rows = claims.rows;
  registry.claims.error = claims.error;
  registry.claims.issues = claims.issues;

  const sweep = readJsonFile(projectRoot, REGISTRY_FILES.sweep);
  if (sweep.exists) {
    registry.sweep.exists = true;
    if (sweep.error) {
      registry.sweep.error = sweep.error;
      registry.issues.push(issue('registry.sweep', REGISTRY_FILES.sweep, sweep.error));
    } else {
      const value = normalizeSweep(sweep.value);
      registry.sweep.value = value;
      const check = validateSweep(value);
      for (const err of [...check.errors, ...check.warnings]) registry.sweep.issues.push(err);
    }
  }

  const measure = readJsonFile(projectRoot, REGISTRY_FILES.measure);
  if (measure.exists && !measure.error) {
    registry.measure.exists = true;
    registry.measure.value = measure.value;
  }

  const cells = readCsv(path.join(projectRoot, REGISTRY_FILES.cells));
  if (cells && cells.rows.length) {
    registry.cells.exists = true;
    registry.cells.rows = cells.rows.length;
    for (const row of cells.rows) {
      const status = String(row.status || '').trim().toLowerCase();
      if (status === 'pass' || status === 'exact') registry.cells.counts.pass += 1;
      else if (status === 'noise') registry.cells.counts.noise += 1;
      else if (status === 'missing') registry.cells.counts.missing += 1;
      else if (status === 'unreadable') registry.cells.counts.unreadable += 1;
      else if (status === 'short') registry.cells.counts.short += 1;
      else registry.cells.counts.unjudged += 1;
    }
  }

  registry.legacy =
    !registry.datasets.exists && !registry.models.exists && !registry.artifacts.exists && !registry.claims.exists;
  return registry;
}

/** 原子写：先写临时文件再 rename，避免面板读到半个 JSON。 */
export function writeJsonAtomic(abs, value) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, abs);
}

export function writeJsonlAtomic(abs, rows) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, abs);
}

function stamp(row) {
  return { ...row, updatedAt: new Date().toISOString() };
}

export function writeRegistry(projectRoot, kind, rows) {
  const rel = REGISTRY_FILES[kind];
  if (!rel) throw new Error(`未知的注册表 ${kind}`);
  const abs = path.join(projectRoot, rel);
  if (kind === 'claims') {
    writeJsonlAtomic(abs, rows.map(stamp));
    return { ok: true, file: rel, rows: rows.length };
  }
  if (kind === 'sweep') {
    writeJsonAtomic(abs, rows);
    return { ok: true, file: rel };
  }
  writeJsonAtomic(abs, { schemaVersion: REGISTRY_VERSION, [kind]: rows.map(stamp) });
  return { ok: true, file: rel, rows: rows.length };
}

/** 文件在、但读不懂时，任何写操作都必须停下——否则一次 save 会把整份表覆盖成一条。 */
function guardReadable(registry, kind) {
  const slot = registry[kind];
  if (!slot || !slot.exists) return null;
  if (slot.error) {
    return {
      ok: false,
      error: `${REGISTRY_FILES[kind]} 读不懂（${slot.error}）：先把这份 JSON 修好或删掉，再登记——现在写会把已有记录整份盖掉`,
    };
  }
  // jsonl 里坏掉的行不会进 rows：这时重写等于把那几行删掉
  const broken = (slot.issues || []).filter((item) => item.code === 'jsonl.parse');
  if (broken.length) {
    return {
      ok: false,
      error: `${REGISTRY_FILES[kind]} 里有 ${broken.length} 行读不懂（${broken[0].where}）：先把它们修好再写，否则会被覆盖`,
    };
  }
  return null;
}

/** 登记一条：同 id 覆盖，不同 id 追加；返回写入后的完整列表。 */
export function upsert(projectRoot, kind, raw) {
  const registry = readRegistry(projectRoot);
  const blocked = guardReadable(registry, kind);
  if (blocked) return blocked;
  const normalize = kind === 'datasets' ? normalizeDataset : kind === 'models' ? normalizeModel : normalizeArtifact;
  const validate = kind === 'datasets' ? validateDataset : kind === 'models' ? validateModel : validateArtifact;
  const row = normalize(raw);
  const check = validate(row);
  if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings, row };
  const rows = registry[kind].rows.filter((item) => item.id !== row.id);
  rows.push(row);
  writeRegistry(projectRoot, kind, rows);
  return { ok: true, row, warnings: check.warnings, file: REGISTRY_FILES[kind] };
}

export function removeRow(projectRoot, kind, id) {
  const registry = readRegistry(projectRoot);
  const blocked = guardReadable(registry, kind);
  if (blocked) return blocked;
  const before = registry[kind].rows.length;
  const rows = registry[kind].rows.filter((item) => item.id !== id);
  if (rows.length === before) return { ok: false, error: `注册表里没有 ${id}` };
  writeRegistry(projectRoot, kind, rows);
  return { ok: true, file: REGISTRY_FILES[kind], removed: 1 };
}

export function confirmRow(projectRoot, kind, id) {
  const registry = readRegistry(projectRoot);
  const blocked = guardReadable(registry, kind);
  if (blocked) return blocked;
  const rows = registry[kind].rows.map((item) => (item.id === id ? { ...item, confirmedByHuman: true } : item));
  if (!rows.some((item) => item.id === id)) return { ok: false, error: `注册表里没有 ${id}` };
  writeRegistry(projectRoot, kind, rows);
  return { ok: true, file: REGISTRY_FILES[kind] };
}

export function addClaim(projectRoot, raw) {
  const registry = readRegistry(projectRoot);
  const blocked = guardReadable(registry, 'claims');
  if (blocked) return blocked;
  const claim = normalizeClaim(raw);
  const check = validateClaim(claim);
  if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings, claim };
  const rows = registry.claims.rows.filter((item) => item.id !== claim.id);
  rows.push(claim);
  writeRegistry(projectRoot, 'claims', rows);
  return { ok: true, claim, warnings: check.warnings, file: REGISTRY_FILES.claims };
}

/* --------------------------- 引用解析与断言 --------------------------- */

const COEF_ALIASES = {
  beta: ['beta', 'estimate', 'coef', 'coefficient', 'b'],
  se: ['se', 'std_error', 'std.error', 'stderr', 'robust_se'],
  p: ['p', 'p_value', 'p.value', 'pvalue', 'pr'],
  ciLow: ['ci_low', 'ci.low', 'conf_low', 'lower', 'll'],
  ciHigh: ['ci_high', 'ci.high', 'conf_high', 'upper', 'ul'],
};

/**
 * 严格取数：不做「剥掉不认识的字符」那种清洗。
 * 千分位逗号与 U+2212 减号可以认，括号负数 `(0.51)`、`0.51 (0.12)` 一律当「不是数字」报出来——
 * 悄悄把符号翻正比报错危险得多。
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const cleaned = raw.replace(/,/g, '').replace(/[\u2212\u2013\u2014]/g, '-');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function pick(row, keys) {  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return undefined;
}

/** 读取某个模型的系数行（相对路径；读不到返回空数组）。 */
export function modelCoefRows(projectRoot, model) {
  const rel = model?.coef;
  if (!rel) return [];
  const csv = readCsv(path.join(projectRoot, rel));
  return csv && csv.rows.length ? csv.rows : [];
}

/**
 * 解析引用：
 *   M1                        → 模型对象
 *   M1.n / M1.events          → 数值
 *   M1.coef.<term>.beta       → 系数（term 里可以带下划线，取最后一段当字段）
 *   dataset:<id>.rows         → 数据集行数
 *   dataset:<id>.inAnalysis.n → 纳入样本量
 *   fig:<id>.n / .dpi / .minFont
 * 失败返回 {ok:false,error}，让闸门说「判不了」而不是猜一个 0。
 */
export function resolveRef(registry, ref, options = {}) {
  const projectRoot = options.projectRoot || '';
  const coefCache = options.coefCache || new Map();
  const raw = String(ref || '').trim();
  if (!raw) return { ok: false, error: '空引用' };

  if (raw.startsWith('dataset:')) {
    const [id, ...rest] = raw.slice('dataset:'.length).split('.');
    const dataset = registry.datasets.rows.find((item) => item.id === id);
    if (!dataset) return { ok: false, error: `没有数据集 ${id}` };
    const key = rest.join('.');
    if (!key) return { ok: true, value: dataset };
    if (key === 'rows') return { ok: true, value: dataset.rows };
    if (key === 'inAnalysis.n') return { ok: true, value: dataset.inAnalysis.n };
    if (key === 'columns.length') return { ok: true, value: dataset.columns.length };
    if (key === 'confirmed') return { ok: true, value: dataset.confirmedByHuman };
    // 条件计数：dataset:analysis.count[year=2024]
    // 让「2024 比 2022 少」这种结论能被机检，而不是只比元数据。
    const count = key.match(/^count\[([^\]=]+)=([^\]]*)\]$/);
    if (count) {
      if (!projectRoot) return { ok: false, error: '条件计数需要项目路径' };
      const column = count[1].trim();
      const wanted = count[2].trim();
      let cache = options.dataCache || null;
      if (!cache) {
        cache = new Map();
        options.dataCache = cache;
      }
      let csv = cache.get(dataset.id);
      if (!csv) {
        csv = readCsv(path.join(projectRoot, dataset.file));
        cache.set(dataset.id, csv);
      }
      if (!csv || !csv.header.includes(column)) return { ok: false, error: `数据集 ${id} 没有列 ${column}` };
      let hits = 0;
      for (const row of csv.rows) {
        if (String(row[column] ?? '').trim() === wanted) hits += 1;
      }
      return { ok: true, value: hits };
    }
    return { ok: false, error: `数据集没有字段 ${key}` };
  }

  if (raw.startsWith('fig:')) {
    const [id, ...rest] = raw.slice('fig:'.length).split('.');
    const artifact = registry.artifacts.rows.find((item) => item.id === `fig:${id}`)
      || registry.artifacts.rows.find((item) => item.id === id);
    if (!artifact) return { ok: false, error: `没有图 ${id}` };
    const key = rest.join('.');
    if (!key) return { ok: true, value: artifact };
    if (key === 'n') return { ok: true, value: artifact.n };
    if (key === 'dpi') return { ok: true, value: artifact.dpi };
    if (key === 'minFont') return { ok: true, value: artifact.minFont };
    return { ok: false, error: `图没有字段 ${key}` };
  }

  if (raw.startsWith('tbl:')) {
    const [id, ...rest] = raw.slice('tbl:'.length).split('.');
    const artifact = registry.artifacts.rows.find((item) => item.id === `tbl:${id}`)
      || registry.artifacts.rows.find((item) => item.id === id);
    if (!artifact) return { ok: false, error: `没有表 ${id}` };
    const key = rest.join('.');
    if (!key) return { ok: true, value: artifact };
    if (key === 'rows') return { ok: true, value: artifact.rows };
    if (key === 'cols') return { ok: true, value: artifact.cols };
    return { ok: false, error: `表没有字段 ${key}` };
  }

  // 模型引用：M1 / M1.n / M1.coef.<term>.<field>
  const parts = raw.split('.');
  const id = parts.shift();
  const model = registry.models.rows.find((item) => item.id === id);
  if (!model) return { ok: false, error: `没有模型 ${id}` };
  if (!parts.length) return { ok: true, value: model };
  const head = parts.shift();
  if (head === 'n') return { ok: true, value: model.n };
  if (head === 'events') return { ok: true, value: model.events };
  if (head === 'clusters') return { ok: true, value: model.clusters };
  if (head === 'dropped') return { ok: true, value: model.dropped };
  if (head === 'coef') {
    const field = parts.pop();
    const term = parts.join('.');
    if (!term || !field) return { ok: false, error: '系数引用要写成 M1.coef.<term>.<beta|se|p>' };
    const alias = COEF_ALIASES[field];
    if (!alias) return { ok: false, error: `不认识的系数字段 ${field}` };
    let rows = coefCache.get(model.id);
    if (!rows) {
      rows = modelCoefRows(projectRoot, model);
      coefCache.set(model.id, rows);
    }
    if (!rows.length) return { ok: false, error: `${model.id} 的系数表读不到（${model.coef || '没登记 coef'}）` };
    const termKeys = ['term', 'variable', 'name', 'predictor', 'label'];
    const hit = rows.find((row) => termKeys.some((key) => String(row[key] ?? '').trim() === term));
    if (!hit) return { ok: false, error: `${model.id} 的系数表里没有 ${term}` };
    const value = pick(hit, alias);
    if (value === undefined) return { ok: false, error: `${model.id}.${term} 缺字段 ${field}` };
    const n = toNumber(value);
    return n === null ? { ok: false, error: `${model.id}.${term}.${field} 不是数字（${value}）` } : { ok: true, value: n };
  }
  return { ok: false, error: `不认识的引用 ${raw}` };
}

/**
 * 评估一条声明式断言。只支持比较，不执行任意表达式：
 *   想表达「2024 比 2022 少」，就写 {op:"lt", left:"dataset:case_level.count2024", right:"dataset:case_level.count2022"}。
 * 两边都可以是引用或常量；解析不了就是 unjudged，不许当成 true。
 */
export function evaluateAssert(assert, registry, options = {}) {
  if (!assert || !assert.op) return { ok: false, error: '没有 assert' };
  const read = (value) => {
    if (typeof value === 'number') return { ok: true, value };
    const raw = String(value ?? '').trim();
    if (!raw) return { ok: false, error: '空操作数' };
    const n = Number(raw);
    if (Number.isFinite(n) && /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(raw)) return { ok: true, value: n };
    return resolveRef(registry, raw, options);
  };
  const left = read(assert.left);
  if (!left.ok) return { ok: false, error: `左边读不出来：${left.error}` };
  const right = read(assert.right);
  if (!right.ok) return { ok: false, error: `右边读不出来：${right.error}` };
  const a = Number(left.value);
  const b = Number(right.value);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, error: '两边不都是数字' };
  let passed = false;
  switch (assert.op) {
    case 'gt': passed = a > b; break;
    case 'lt': passed = a < b; break;
    case 'gte': passed = a >= b; break;
    case 'lte': passed = a <= b; break;
    case 'eq': passed = a === b; break;
    case 'ne': passed = a !== b; break;
    case 'abs_gt': passed = Math.abs(a) > b; break;
    case 'in_range': {
      const from = toNumber(assert.from);
      const to = toNumber(assert.to);
      if (from === null || to === null) return { ok: false, error: 'in_range 需要数字 from 与 to（缺了就没法判）' };
      passed = a >= from && a <= to;
      break;
    }
    default: return { ok: false, error: `不支持的比较 ${assert.op}` };
  }
  return { ok: true, pass: passed, left: a, right: b, op: assert.op };
}

/* ------------------------------- 汇总 ------------------------------- */

const KEY_FIELD_HINTS = /(charge|sentence|prison|detention|suspended|probation|fine|amount|outcome|in_analysis)/i;

/** 面板/闸门用的摘要：不塞整表，只给计数与问题。 */
export function summarizeRegistry(registry, projectRoot = '') {
  const missingFiles = [];
  if (projectRoot) {
    for (const dataset of registry.datasets.rows) {
      if (dataset.file && !statOf(projectPath(projectRoot, dataset.file)).exists) missingFiles.push(dataset.file);
    }
    for (const artifact of registry.artifacts.rows) {
      if (artifact.path && !statOf(projectPath(projectRoot, artifact.path)).exists) missingFiles.push(artifact.path);
    }
  }
  const issues = [
    ...registry.issues,
    ...registry.datasets.issues,
    ...registry.models.issues,
    ...registry.artifacts.issues,
    ...registry.claims.issues,
    ...registry.sweep.issues,
  ];
  const errors = issues.filter((item) => item.severity !== 'warn');
  return {
    version: REGISTRY_VERSION,
    legacy: registry.legacy,
    counts: {
      datasets: registry.datasets.rows.length,
      models: registry.models.rows.length,
      artifacts: registry.artifacts.rows.length,
      claims: registry.claims.rows.length,
      errors: errors.length,
      warnings: issues.length - errors.length,
    },
    files: {
      datasets: registry.datasets.exists,
      models: registry.models.exists,
      artifacts: registry.artifacts.exists,
      claims: registry.claims.exists,
      sweep: registry.sweep.exists,
      cells: registry.cells.exists,
    },
    sweep: registry.sweep.value
      ? {
          outcomes: registry.sweep.value.outcomes.length,
          estimated: registry.sweep.value.outcomes.reduce((acc, item) => acc + item.families.filter((f) => f.status === 'estimated').length, 0),
          undecided: registry.sweep.value.outcomes.reduce((acc, item) => acc + item.families.filter((f) => f.status === 'unknown').length, 0),
        }
      : null,
    cells: registry.cells,
    issues: issues.slice(0, 40),
    missingFiles: missingFiles.slice(0, 20),
    hints: registry.legacy
      ? ['还没有 v2 注册表：可以在面板点「采纳现有产物」按现状生成，也可以用 data_analysis_register 手动登记。']
      : [],
  };
}

/** 数据集里值得做逐格回源的字段（缺 role 时按名字猜）。 */
export function keyFields(dataset) {
  const declared = dataset.columns.filter((column) => KEY_FIELD_HINTS.test(column.name));
  return (declared.length ? declared : dataset.columns.slice(0, 8)).map((column) => column.name);
}

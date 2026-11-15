/**
 * 全资料 / 全数据集 / 逐格复核层（skill 的 references/12-exhaustive-research.md）。
 *
 * 这一层不是「多几个文件」，而是三件可机判的事实：
 *   1. 每份原始资料都有处置（source_coverage.jsonl：included / excluded / unreadable）；
 *   2. 每个数据集的每一格都能回源并独立复算（provenance.jsonl + verify_dataset）；
 *   3. 数据进入正式计算前，逐格复核已经 final 且没有 error（dataset_verification.json）。
 *
 * 插件只读这些产物，不生成、不改写：它们是 Agent 与人的证据账。
 * 老项目没有这些文件时一律返回 exists=false，由闸门判「判不了」，不拦。
 */

import fs from 'node:fs';
import path from 'node:path';

import { readCsv, statOf } from './audit.js';
import { sha256File, verifyBindings } from './fingerprint.js';
import { projectPath } from './registry.js';

export const RESEARCH_REGISTRY = 'research_registry.json';

const DEFAULT_COVERAGE = 'output/source_coverage.jsonl';
const DEFAULT_MODEL_PLAN = 'output/model_plan.jsonl';
const VERIFICATION_DIR = 'output/data_verification';
const VERIFICATION_FILE = `${VERIFICATION_DIR}/dataset_verification.json`;
const RESEARCH_GATE_FILE = 'output/research_gate.json';

export const MODEL_TERMINAL = new Set(['completed', 'insufficient_data', 'not_applicable', 'unsupported', 'failed']);
export const COVERAGE_STATUS = new Set(['included', 'excluded', 'unreadable']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** JSONL：坏行不静默丢——记进行号，闸门要能说「这条没参与判定」。 */
export function readJsonl(file, { limit = 20000 } = {}) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return { exists: false, rows: [], broken: [], lines: 0 };
  }
  const rows = [];
  const broken = [];
  let lines = 0;
  let truncated = false;
  for (const raw of text.split(/\r?\n/)) {
    lines += 1; // 物理行号：报「第 N 行」要能直接在编辑器里跳过去
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value);
      else broken.push({ line: lines, error: '不是 JSON 对象' });
    } catch (error) {
      broken.push({ line: lines, error: String(error && error.message ? error.message : error).slice(0, 120) });
    }
  }
  return { exists: true, rows, broken, lines, truncated };
}

function num(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function mtimeOf(file) {
  const info = statOf(file);
  return info.exists ? info.mtimeMs || 0 : 0;
}

/**
 * /state 每 8 秒扫一次产物；registry 里的数据集、cell_issues、coverage/plan
 * 都可能是几万行。按「路径 + mtime + size」缓存解析结果，文件一变就失效，
 * 既不会把旧内容留在面板上，也不会每 8 秒重读一遍大 CSV。
 */
const parseCache = new Map();
const duplicateKeyCache = new Map();
const PARSE_CACHE_MAX = 48;

function cachedParse(key, build) {
  if (parseCache.has(key)) return parseCache.get(key);
  const value = build();
  if (parseCache.size >= PARSE_CACHE_MAX) parseCache.clear();
  parseCache.set(key, value);
  return value;
}

function readCsvCached(abs) {
  const info = statOf(abs);
  if (!info.exists) return null;
  return cachedParse(`csv|${abs}|${info.mtimeMs}|${info.size}`, () => readCsv(abs));
}

function readJsonlCached(abs, options) {
  const info = statOf(abs);
  if (!info.exists) return { exists: false, rows: [], broken: [], lines: 0, truncated: false };
  return cachedParse(
    `jsonl|${abs}|${info.mtimeMs}|${info.size}|${options?.limit || ''}`,
    () => readJsonl(abs, options),
  );
}

/* --------------------------- 项目注册表 --------------------------- */

/**
 * research_registry.json：任意数量的数据集，各自声明 unit / key / codebook / provenance / review。
 * 数据集路径、provenance、review 都可以是项目相对路径或绝对路径。
 */
export function readResearchRegistry(projectRoot) {
  const file = RESEARCH_REGISTRY;
  const abs = path.join(projectRoot, file);
  const info = statOf(abs);
  if (!info.exists) {
    return {
      file, exists: false, error: '', value: null, datasets: [], issues: [], auxPaths: [],
      sourceRoot: '', sourceInventory: '', sourceCoverage: DEFAULT_COVERAGE,
      discoveryReport: '', modelPlan: DEFAULT_MODEL_PLAN,
    };
  }
  let value = null;
  let error = '';
  try {
    value = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    error = String(err && err.message ? err.message : err).slice(0, 200);
  }
  if (!error && (!value || typeof value !== 'object' || Array.isArray(value))) {
    error = '顶层要是一个对象';
  }
  if (error) {
    return {
      file, exists: true, error, value: null, datasets: [], issues: [], auxPaths: [],
      sourceRoot: '', sourceInventory: '', sourceCoverage: DEFAULT_COVERAGE,
      discoveryReport: '', modelPlan: DEFAULT_MODEL_PLAN,
    };
  }

  const issues = [];
  const raw = Array.isArray(value.datasets) ? value.datasets : [];
  if (!raw.length) issues.push({ code: 'registry.empty', where: file, message: 'datasets 是空的：至少登记一份数据集', severity: 'error' });
  const seen = new Set();
  const datasets = raw.map((item, index) => {
    const where = `${file}#datasets[${index}]`;
    const id = String(item?.id || '').trim();
    const rel = String(item?.path || '').trim();
    if (!id) issues.push({ code: 'registry.id', where, message: '缺 id', severity: 'error' });
    else if (seen.has(id)) issues.push({ code: 'registry.dup', where, message: `id 重复：${id}`, severity: 'error' });
    seen.add(id);
    if (!rel) issues.push({ code: 'registry.path', where, message: '缺 path', severity: 'error' });
    const csv = rel ? readCsvCached(projectPath(projectRoot, rel)) : null;
    const exists = Boolean(rel) && statOf(projectPath(projectRoot, rel)).exists;
    if (rel && !exists) issues.push({ code: 'registry.path', where, message: `数据集文件不存在：${rel}`, severity: 'error' });
    else if (rel && !csv) issues.push({ code: 'registry.path', where, message: `数据集 CSV 读不出来（空文件/表头损坏）：${rel}`, severity: 'error' });
    const keys = (Array.isArray(item?.key) ? item.key : [item?.key]).map((k) => String(k || '').trim()).filter(Boolean);
    if (!keys.length) issues.push({ code: 'registry.key', where, message: '缺 key（单键字符串或复合键数组）', severity: 'error' });
    if (csv && keys.length) {
      const missingKeys = keys.filter((key) => !csv.header.includes(key));
      if (missingKeys.length) issues.push({ code: 'registry.key', where, message: `主键列不在 CSV 表头：${missingKeys.join('、')}`, severity: 'error' });
      else {
        // 主键查重是 O(行数)：/state 每 8 秒扫一次，不能每次都重算。
        // 按「文件 mtime + size + 键集合」缓存，数据集一变自动失效。
        const keyAbs = projectPath(projectRoot, rel);
        const keyInfo = statOf(keyAbs);
        const signature = `dup|${keyAbs}|${keyInfo.mtimeMs}|${keyInfo.size}|${keys.join(',')}`;
        let dup = duplicateKeyCache.get(signature);
        if (dup === undefined) {
          const counts = new Map();
          for (const row of csv.rows) {
            const sig = keys.map((key) => String(row[key] ?? '')).join('\u0001');
            counts.set(sig, (counts.get(sig) || 0) + 1);
          }
          dup = [...counts.values()].filter((n) => n > 1).length;
          if (duplicateKeyCache.size > 64) duplicateKeyCache.clear();
          duplicateKeyCache.set(signature, dup);
        }
        if (dup) issues.push({ code: 'registry.key', where, message: `${dup} 个主键重复：主键必须唯一`, severity: 'error' });
      }
    }
    const provenance = String(item?.provenance || '').trim();
    if (!provenance) issues.push({ code: 'registry.provenance', where, message: '缺 provenance（逐格证据账）', severity: 'error' });
    else if (!statOf(projectPath(projectRoot, provenance)).exists) {
      issues.push({ code: 'registry.provenance', where, message: `provenance 文件不存在：${provenance}`, severity: 'error' });
    }
    const review = String(item?.review || '').trim();
    if (review && !statOf(projectPath(projectRoot, review)).exists) {
      issues.push({ code: 'registry.review', where, message: `review 文件不存在：${review}`, severity: 'warn' });
    }
    const codebook = String(item?.codebook || '').trim();
    if (!codebook) issues.push({ code: 'registry.codebook', where, message: '缺 codebook：变量语义不能靠列名猜', severity: 'warn' });
    else if (!statOf(projectPath(projectRoot, codebook)).exists) {
      issues.push({ code: 'registry.codebook', where, message: `codebook 文件不存在：${codebook}`, severity: 'warn' });
    }
    const artifacts = (Array.isArray(item?.artifacts) ? item.artifacts : [])
      .map((entry) => (typeof entry === 'string'
        ? { path: entry.trim(), sha256: '' }
        : { path: String(entry?.path || '').trim(), sha256: String(entry?.sha256 || '').trim() }))
      .filter((entry) => entry.path);
    for (const entry of artifacts) {
      if (!statOf(projectPath(projectRoot, entry.path)).exists) {
        issues.push({ code: 'registry.artifact', where, message: `原生文件不存在：${entry.path}`, severity: 'error' });
      }
    }
    return {
      id,
      path: rel,
      abs: rel ? projectPath(projectRoot, rel) : '',
      exists,
      key: keys,
      unit: String(item?.unit || '').trim(),
      codebook,
      provenance,
      review,
      artifacts,
      rows: csv ? csv.rows.length : null,
      columns: csv ? csv.header.length : null,
    };
  });

  return {
    file,
    exists: true,
    error: '',
    value,
    datasets,
    issues,
    // 覆盖账的分母要用「原始资料」而不是「data/ 下所有文件」：skill 的示例把
    // codebook / provenance / review 也放在 data/ 里，若一起算进分母，覆盖账
    // 永远差几份。这些登记在案的文件由 registry 自己声明，逐条扣掉。
    auxPaths: (() => {
      const out = new Set();
      const add = (value) => {
        const text = String(value || '').trim().replace(/^\.\//, '');
        if (text) out.add(text);
      };
      for (const dataset of datasets) {
        add(dataset.path);
        add(dataset.codebook);
        add(dataset.provenance);
        add(dataset.review);
      }
      add(file);
      add(String(value.source_inventory || '').trim());
      add(String(value.source_coverage || DEFAULT_COVERAGE).trim());
      add(String(value.discovery_report || '').trim());
      add(String(value.model_plan || DEFAULT_MODEL_PLAN).trim());
      return [...out];
    })(),
    sourceRoot: String(value.source_root || '').trim(),
    sourceInventory: String(value.source_inventory || 'output/audit/corpus_files.csv').trim(),
    sourceCoverage: String(value.source_coverage || DEFAULT_COVERAGE).trim(),
    discoveryReport: String(value.discovery_report || 'output/discovery_report.md').trim(),
    modelPlan: String(value.model_plan || DEFAULT_MODEL_PLAN).trim(),
    mtimeMs: info.mtimeMs || 0,
  };
}

/* ------------------------- 逐格复核（prepare/final） ------------------------- */

export function readVerification(projectRoot, registry = null) {
  const file = VERIFICATION_FILE;
  const abs = path.join(projectRoot, file);
  const info = statOf(abs);
  const cellIssuesFile = 'cell_issues.csv';
  const cellIssuesAbs = path.join(projectRoot, VERIFICATION_DIR, cellIssuesFile);
  const cellCsv = readCsvCached(cellIssuesAbs);
  const issues = cellCsv ? cellCsv.rows : [];
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const row of issues) {
    const severity = String(row.severity || 'error').toLowerCase();
    if (severity === 'error') bySeverity.error += 1;
    else if (severity === 'warning' || severity === 'warn') bySeverity.warning += 1;
    else bySeverity.info += 1;
  }
  const templates = (() => {
    try {
      return fs.readdirSync(path.join(projectRoot, VERIFICATION_DIR)).filter((name) => /^review_template_.*\.jsonl$/i.test(name));
    } catch {
      return [];
    }
  })();
  if (!info.exists) {
    return {
      file, exists: false, error: '', json: null, stage: '', status: '', errorCount: null, cellCount: null,
      cellIssuesExists: Boolean(cellCsv), issues, bySeverity, templates, stale: [], fingerprint: '',
      freshness: 'none', bindingCheck: { checked: 0, total: 0, skipped: false, reason: 'no-report', reviewChecked: 0, reviewTotal: 0, snapshotChanged: false }, snapshotExists: false,
    };
  }
  const json = readJson(abs);
  if (!json) {
    return {
      file, exists: true, error: 'dataset_verification.json 读不懂', json: null, stage: '', status: '', errorCount: null,
      cellCount: null, cellIssuesExists: Boolean(cellCsv), issues, bySeverity, templates, stale: [], fingerprint: '',
      freshness: 'none', bindingCheck: { checked: 0, total: 0, skipped: false, reason: 'unreadable', reviewChecked: 0, reviewTotal: 0, snapshotChanged: false }, snapshotExists: false,
    };
  }
  // 原件 / 数据集 / 证据账 / 复核回执 任一变化 → 旧复核作废（契约明确要求）。
  //
  // 2026-11-13 的复核证明「只比 mtime」不够：改原文 AAA→BBB 不动数据集与证据账时，
  // final 复核仍然有效。skill 的 verification_snapshot.json 已经为 registry、数据集、
  // codebook、provenance、适配器与**每一份原始资料**记了 sha256（verify_dataset.py:329-333、
  // :190-193），所以这里直接逐项核对这些绑定，而不是另发明一套。
  const judgedAt = info.mtimeMs || 0;
  const snapshotRel = `${VERIFICATION_DIR}/verification_snapshot.json`;
  const snapshotAbs = path.join(projectRoot, snapshotRel);
  const snapshot = readJson(snapshotAbs);
  const snapshotStat = statOf(snapshotAbs);
  const bindingCheck = snapshot?.bindings
    ? verifyBindings(snapshot.bindings, { root: projectRoot })
    : { ok: false, checked: 0, total: 0, stale: [], skipped: false, reason: snapshot ? 'no-bindings' : 'no-snapshot' };
  // final 报告还绑了每份 review 文件的 sha256（verify_dataset.py:507-513）：
  // 复核记录被改过，同样要作废旧结论。
  const reviewBindings = json.review_bindings && typeof json.review_bindings === 'object' && !Array.isArray(json.review_bindings)
    ? verifyBindings(json.review_bindings, { root: projectRoot })
    : { ok: true, checked: 0, total: 0, stale: [], skipped: false, reason: '' };
  const snapshotSha = String(json.snapshot_sha256 || '').trim().toLowerCase();
  let snapshotChanged = false;
  if (snapshotSha) {
    const got = sha256File(snapshotAbs);
    snapshotChanged = !got.ok || got.hash !== snapshotSha;
  }

  const inputs = [];
  if (registry?.exists) {
    inputs.push({ rel: RESEARCH_REGISTRY, mtimeMs: registry.mtimeMs || 0 });
    for (const dataset of registry.datasets) {
      const tracked = [dataset.path, dataset.provenance, dataset.review, dataset.codebook]
        .concat((dataset.artifacts || []).map((item) => item.path))
        .filter(Boolean);
      for (const rel of tracked) {
        inputs.push({ rel, mtimeMs: mtimeOf(projectPath(projectRoot, rel)) });
      }
    }
  }
  for (const rel of [`${VERIFICATION_DIR}/verification_snapshot.json`, `${VERIFICATION_DIR}/cell_issues.csv`]) {
    inputs.push({ rel, mtimeMs: mtimeOf(path.join(projectRoot, rel)) });
  }

  // 有内容绑定就只信内容：文件被 touch 但内容没变不该判过期，反之改了内容一定要判过期。
  // 没有绑定（旧 skill / 手写报告）才退回 mtime，并明确标注证据弱。
  const contentFresh = Boolean(snapshot?.bindings) && bindingCheck.ok && reviewBindings.ok && !snapshotChanged;
  const stale = contentFresh
    ? []
    : (snapshot?.bindings
      ? [
          ...bindingCheck.stale.map((item) => `${item.path}（${item.reason}）`),
          ...reviewBindings.stale.map((item) => `${item.path}（${item.reason}）`),
          ...(snapshotChanged ? [`${snapshotRel}（快照哈希与 final 报告不一致）`] : []),
        ]
      : inputs.filter((item) => item.mtimeMs > judgedAt + 1000).map((item) => item.rel));
  return {
    file,
    exists: true,
    error: '',
    json,
    stage: String(json.stage || ''),
    status: String(json.status || ''),
    errorCount: num(json.error_count),
    cellCount: num(json.cell_count),
    scriptVersion: String(json.script_version || ''),
    fingerprint: json.fingerprint ? String(json.fingerprint) : '',
    snapshotPath: String(json.snapshot_path || ''),
    mtimeMs: judgedAt,
    cellIssuesExists: Boolean(cellCsv),
    issues: issues.slice(0, 40),
    bySeverity,
    templates,
    stale,
    // 证据强度：content = 逐文件 sha256（skill 的 bindings）；mtime = 只能比时间；none = 无从判断
    freshness: snapshot?.bindings ? 'content' : (json ? 'mtime' : 'none'),
    bindingCheck: {
      checked: bindingCheck.checked,
      total: bindingCheck.total,
      skipped: Boolean(bindingCheck.skipped),
      reason: bindingCheck.reason || '',
      reviewChecked: reviewBindings.checked,
      reviewTotal: reviewBindings.total,
      snapshotChanged,
    },
    snapshotExists: snapshotStat.exists,
  };
}

/* ---------------------------- 研究总闸门 ---------------------------- */

export function readResearchGate(projectRoot) {
  const file = RESEARCH_GATE_FILE;
  const abs = path.join(projectRoot, file);
  const info = statOf(abs);
  if (!info.exists) return { file, exists: false, error: '', json: null, status: '', errorCount: null, issues: [] };
  const json = readJson(abs);
  if (!json) return { file, exists: true, error: 'research_gate.json 读不懂', json: null, status: '', errorCount: null, issues: [] };
  const issues = Array.isArray(json.issues) ? json.issues : [];
  return {
    file,
    exists: true,
    error: '',
    json,
    status: String(json.status || ''),
    errorCount: num(json.error_count),
    issues,
    sourceCount: num(json.source_count),
    datasetCount: num(json.dataset_count),
    modelCount: num(json.model_count),
    mtimeMs: info.mtimeMs || 0,
  };
}

/* --------------------------- 来源覆盖 --------------------------- */

export function readSourceCoverage(projectRoot, registry = null) {
  const file = registry?.sourceCoverage || DEFAULT_COVERAGE;
  const abs = projectPath(projectRoot, file);
  const info = statOf(abs);
  const parsed = readJsonlCached(abs, { limit: 50000 });
  if (!parsed.exists) {
    return { file, exists: false, total: 0, effective: 0, rows: [], counts: { included: 0, excluded: 0, unreadable: 0, other: 0 }, countsEffective: { included: 0, excluded: 0, unreadable: 0, other: 0 }, issues: [], broken: [], truncated: false };
  }
  const counts = { included: 0, excluded: 0, unreadable: 0, other: 0 };
  // 只统计原始资料（不含 codebook/provenance 等登记在案的附属文件）：
  // 覆盖账可以把它们列进来，但「6 份资料：included 9」会让人以为分母错了。
  const countsEffective = { included: 0, excluded: 0, unreadable: 0, other: 0 };
  const issues = [];
  const seen = new Set();
  const bySource = new Map();
  // 覆盖账可能把 codebook / 证据账 / 数据集视图也列进来（它们在 data/ 下）。
  // 这些是登记在案的附属文件，不能算「原始资料」的处置进度。
  const aux = new Set();
  const sourceRoot = String(registry?.sourceRoot || '').replace(/\/+$/, '');
  for (const rel of registry?.auxPaths || []) {
    aux.add(rel);
    if (sourceRoot && rel.startsWith(`${sourceRoot}/`)) aux.add(rel.slice(sourceRoot.length + 1));
    if (rel.startsWith('data/')) aux.add(rel.slice('data/'.length));
  }
  let effective = 0;
  for (const [index, row] of parsed.rows.entries()) {
    const source = String(row.source || row.path || row.rel_path || '').trim();
    const status = String(row.status || '').trim().toLowerCase();
    if (!source) {
      issues.push({ code: 'coverage.source', where: `${file}#${index + 1}`, message: '缺 source', severity: 'error' });
      continue;
    }
    if (seen.has(source)) issues.push({ code: 'coverage.dup', where: source, message: '同一份来源出现多次', severity: 'error' });
    seen.add(source);
    bySource.set(source, row);
    const isAux = aux.has(source);
    if (!isAux) effective += 1;
    const bucket = status === 'included' || status === 'excluded' || status === 'unreadable' ? status : 'other';
    counts[bucket] += 1;
    if (!isAux) countsEffective[bucket] += 1;
    if (status !== 'included' && status !== 'excluded' && status !== 'unreadable') {
      issues.push({ code: 'coverage.status', where: source, message: `status 必须是 included/excluded/unreadable，实际是「${status || '(空)'}」`, severity: 'error' });
    }
    const reason = String(row.reason || '').trim();
    if (status === 'excluded' && !reason) {
      issues.push({ code: 'coverage.reason', where: source, message: 'excluded 必须写 reason', severity: 'error' });
    }
    if (status === 'included') {
      const ids = (Array.isArray(row.datasets) ? row.datasets : [row.datasets]).map((v) => String(v || '').trim()).filter(Boolean);
      if (!ids.length) issues.push({ code: 'coverage.datasets', where: source, message: 'included 必须写 datasets', severity: 'error' });
      const known = new Set((registry?.datasets || []).map((d) => d.id));
      for (const id of ids) {
        if (known.size && !known.has(id)) {
          issues.push({ code: 'coverage.datasets', where: source, message: `datasets 里的 ${id} 没有在 registry 登记`, severity: 'error' });
        }
      }
    }
    if (status === 'unreadable') {
      const attempts = Array.isArray(row.recovery_attempts) ? row.recovery_attempts : [];
      if (!attempts.length) issues.push({ code: 'coverage.recovery', where: source, message: 'unreadable 必须写 recovery_attempts（试过什么、结果如何）', severity: 'error' });
    }
  }
  return { file, exists: true, total: parsed.rows.length, effective, rows: parsed.rows, bySource, counts, countsEffective, issues, broken: parsed.broken, truncated: parsed.truncated };
}

/* ---------------------------- 模型计划 ---------------------------- */

export function readModelPlan(projectRoot, registry = null) {
  const file = registry?.modelPlan || DEFAULT_MODEL_PLAN;
  const abs = projectPath(projectRoot, file);
  const info = statOf(abs);
  const parsed = readJsonlCached(abs, { limit: 20000 });
  if (!parsed.exists) {
    return { file, exists: false, total: 0, rows: [], counts: {}, issues: [], broken: [], truncated: false };
  }
  const issues = [];
  const counts = {};
  const seen = new Set();
  if (!parsed.rows.length) {
    issues.push({ code: 'plan.empty', where: file, message: 'model_plan.jsonl 是空的：至少列出每个结局变量考虑过的模型族与终态', severity: 'error' });
  }
  for (const [index, row] of parsed.rows.entries()) {
    const id = String(row.id || '').trim();
    const where = id || `${file}#${index + 1}`;
    const status = String(row.status || '').trim();
    if (!id) issues.push({ code: 'plan.id', where, message: '缺 id', severity: 'error' });
    else if (seen.has(id)) issues.push({ code: 'plan.dup', where, message: '同一模型 id 出现在多行', severity: 'error' });
    seen.add(id);
    counts[status || '(empty)'] = (counts[status || '(empty)'] || 0) + 1;
    for (const field of ['dataset', 'family', 'question', 'requirements']) {
      if (!row[field] || (typeof row[field] === 'string' && !String(row[field]).trim())) {
        issues.push({ code: 'plan.field', where, message: `缺 ${field}`, severity: 'error' });
      }
    }
    if (!MODEL_TERMINAL.has(status)) {
      issues.push({ code: 'plan.status', where, message: `status=${status || '(空)'} 不是终态（completed/insufficient_data/not_applicable/unsupported/failed）`, severity: 'error' });
      continue;
    }
    // dataset 必须指向 registry 里登记过的数据集：否则模型是挂在空气上的。
    const datasetId = String(row.dataset || '').trim();
    if (datasetId && registry?.datasets?.length && !registry.datasets.some((item) => item.id === datasetId)) {
      issues.push({ code: 'plan.dataset', where, message: `dataset=${datasetId} 没有在 research_registry.json 登记`, severity: 'error' });
    }
    if (status === 'completed') {
      for (const field of ['receipt', 'diagnostics', 'sample', 'n']) {
        if (row[field] === undefined || row[field] === null || row[field] === '') {
          issues.push({ code: 'plan.completed', where, message: `completed 缺 ${field}`, severity: 'error' });
        }
      }
      // n 必须是可比较的实际估计样本量：写字符串或负数都视为没写。
      if (num(row.n) === null || num(row.n) < 0) {
        issues.push({ code: 'plan.completed', where, message: `completed 的 n 不是非负数字：「${row.n}」`, severity: 'error' });
      }
      // 回执/诊断/样本键都必须真的在：只写一个路径字符串不等于有回执。
      for (const field of ['receipt', 'diagnostics']) {
        // 契约是路径；宽容处理内联对象，别把合法写法误判成「文件不存在」。
        if (typeof row[field] !== 'string') continue;
        const rel = row[field].trim();
        if (rel && !statOf(projectPath(projectRoot, rel)).exists) {
          issues.push({ code: 'plan.completed', where, message: `${field} 文件不存在：${rel}`, severity: 'error' });
        }
      }
      const sample = String(row.sample || '').trim();
      if (sample) {
        const csv = readCsvCached(projectPath(projectRoot, sample));
        if (!csv) issues.push({ code: 'plan.sample', where, message: `sample 文件读不到：${sample}`, severity: 'error' });
        else {
          // 契约：n = 唯一键数，不是行数。样本键 CSV 重复行不能把 N 撑大。
          const unique = new Set(csv.rows.map((item) => JSON.stringify(item))).size;
          if (num(row.n) !== null && unique !== num(row.n)) {
            issues.push({ code: 'plan.sample', where, message: `n=${row.n} 与样本键 CSV 的唯一键数 ${unique}（${csv.rows.length} 行）不一致`, severity: 'error' });
          }
        }
      }
    } else {
      // not_applicable 也要写 assessment：为什么这份资料/设计用不上这个族，
      // 不能只写一个状态词。gaps/searches 只对三类「差数据/不支持/失败」要求。
      if (!row.assessment) issues.push({ code: 'plan.assessment', where, message: `${status} 必须写 assessment（有数据/设计依据）`, severity: 'error' });
      if (['insufficient_data', 'unsupported', 'failed'].includes(status)) {
        const gaps = Array.isArray(row.gaps) ? row.gaps : [];
        if (!gaps.length) issues.push({ code: 'plan.gaps', where, message: `${status} 必须写 gaps（缺什么、回查了哪些来源）`, severity: 'error' });
        const emptySearches = gaps.filter((gap) => !Array.isArray(gap?.searches) || !gap.searches.length);
        if (emptySearches.length) issues.push({ code: 'plan.gaps', where, message: `${emptySearches.length} 个 gap 没有 searches：不能只写 skipped`, severity: 'error' });
      }
    }
  }
  return { file, exists: true, total: parsed.rows.length, rows: parsed.rows, counts, issues, broken: parsed.broken, truncated: Boolean(parsed.truncated) };
}

/* --------------------------- 判断台账 / 复核包 --------------------------- */

export function readDecisions(projectRoot) {
  const file = 'decisions.jsonl';
  const parsed = readJsonlCached(path.join(projectRoot, file), { limit: 20000 });
  const issuesFile = 'output/qa/decision_issues.csv';
  const issuesStat = statOf(path.join(projectRoot, issuesFile));
  const csv = readCsvCached(path.join(projectRoot, issuesFile));
  const counts = { error: 0, warning: 0, info: 0 };
  const rows = csv ? csv.rows : [];
  for (const row of rows) {
    const severity = String(row.severity || '').toLowerCase();
    if (severity === 'error') counts.error += 1;
    else if (severity === 'warning' || severity === 'warn') counts.warning += 1;
    else counts.info += 1;
  }
  const decisionStat = statOf(path.join(projectRoot, file));
  return {
    file,
    exists: parsed.exists,
    total: parsed.rows.length,
    rows: parsed.rows,
    broken: parsed.broken,
    truncated: Boolean(parsed.truncated),
    mtimeMs: decisionStat.mtimeMs || 0,
    issuesFile,
    issuesExists: issuesStat.exists,
    issuesMtimeMs: issuesStat.mtimeMs || 0,
    issues: rows.slice(0, 30),
    counts,
    needsHuman: parsed.rows.filter((row) => row.needs_human === true).length,
  };
}

export function readReviewPack(projectRoot) {
  const file = 'output/review/review_pack.md';
  const info = statOf(path.join(projectRoot, file));
  return { file, exists: info.exists, bytes: info.size || 0, mtimeMs: info.mtimeMs || 0 };
}

export function readDedupePlan(projectRoot) {
  const file = 'output/audit/dedupe_plan.csv';
  const info = statOf(path.join(projectRoot, file));
  // 去重计划可能上万行；/state 每 8 秒扫一次，按 mtime+size 缓存解析结果。
  const csv = info.exists ? readCsvCached(path.join(projectRoot, file)) : null;
  const rows = csv ? csv.rows : [];
  const groups = new Set(rows.map((row) => String(row.group || row.duplicate_group || '')));
  groups.delete('');
  return { file, exists: info.exists, rows: rows.length, groups: groups.size };
}

/** 一次把所有研究层产物读齐：scanArtifacts 与闸门共用同一份视图。 */
export function readResearchLayer(projectRoot) {
  const registry = readResearchRegistry(projectRoot);
  const coverage = readSourceCoverage(projectRoot, registry);
  const plan = readModelPlan(projectRoot, registry);
  const decisions = readDecisions(projectRoot);
  // 快照每 8 秒发给面板：只留闸门要用的摘要，别把几万行 JSONL 塞进 /state。
  return {
    registry,
    verification: readVerification(projectRoot, registry),
    gate: readResearchGate(projectRoot),
    coverage: { ...coverage, rows: undefined, bySource: undefined },
    plan: { ...plan, rows: undefined },
    decisions: { ...decisions, rows: undefined },
    review: readReviewPack(projectRoot),
    dedupe: readDedupePlan(projectRoot),
  };
}

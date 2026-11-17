/**
 * 会话游标。
 *
 * 任务卡由当前工作流、验收档和项目里的确认文件生成。
 * 插件不另写一份阶段表：下一步只解释技能包已经声明的阶段。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCsv } from './audit.js';

export const TIER_RANK = { explore: 1, submission: 2, archive: 3 };
const MARKERS = {
  'inclusion.md': '纳入确认：',
  'primary-models.md': '主分析：',
  'figure-selection.md': '正文图：',
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}

export function tierRank(tier) {
  return TIER_RANK[tier] || 0;
}

export function readAcceptance(root) {
  const file = path.join(root, '.workbench', 'acceptance.json');
  const value = readJson(file, null);
  if (!value || !TIER_RANK[value.tier]) return { tier: '', fileExists: false, confirmedDowngrade: false };
  return { tier: value.tier, fileExists: true, confirmedDowngrade: value.confirmedDowngrade === true };
}

export function setAcceptance(root, tier, { confirmDowngrade = false } = {}) {
  if (!TIER_RANK[tier]) return { ok: false, error: '验收档只能是 explore、submission 或 archive' };
  const current = readAcceptance(root);
  if (current.fileExists && tierRank(tier) < tierRank(current.tier) && !confirmDowngrade) {
    return { ok: false, error: `降低验收档需要用户确认。当前是 ${current.tier}，请求改成 ${tier}` };
  }
  const next = {
    schema: 'dsa.acceptance/1',
    tier,
    confirmedDowngrade: tierRank(tier) < tierRank(current.tier) ? true : current.confirmedDowngrade,
    updatedAt: new Date().toISOString(),
  };
  writeJson(path.join(root, '.workbench', 'acceptance.json'), next);
  return { ok: true, acceptance: next };
}

export function archiveTierBlock(root, label) {
  const tier = readAcceptance(root).tier;
  if (tier !== 'explore' && tier !== 'submission') return '';
  return `当前验收档是 ${tier}。${label}只在归档档进行。按任务卡继续，不要用它换取统计或交付通过。`;
}

export function ensureAcceptance(root, tier) {
  const current = readAcceptance(root);
  if (current.fileExists) return setAcceptance(root, tier || current.tier, { confirmDowngrade: false });
  return setAcceptance(root, tier && TIER_RANK[tier] ? tier : 'submission');
}

function stageApplies(stage, tier) {
  // 没写验收档时沿用全部判据，不能把旧项目悄悄降成可投稿。
  if (!tier) return true;
  return tierRank(stage.minTier || 'explore') <= tierRank(tier);
}

function draftScripts(root, stage) {
  const dir = path.join(root, stage.loop.draftDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.py'));
}

function fileText(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8');
  } catch {
    return '';
  }
}

export function resumeBlock(root, stage) {
  if (!stage?.resumeFile) return '';
  const text = fileText(root, stage.resumeFile).trim();
  const marker = MARKERS[path.posix.basename(stage.resumeFile)] || '';
  if (!text || (marker && !text.includes(marker))) {
    return `先写 ${stage.resumeFile}${marker ? `，并包含「${marker}」` : '，写明这一步的决定'}`;
  }
  return '';
}

export function freezeState(root, stage) {
  if (!stage?.loop) return { required: false, ok: true };
  const freeze = readJson(path.join(root, stage.loop.freezeFile), null);
  const drafts = draftScripts(root, stage);
  // 没有草稿解析器时，阶段声明的内置脚本可以直接跑。
  if ((!freeze || typeof freeze.script !== 'string') && drafts.length === 0) return { required: false, ok: true };
  if (!freeze || typeof freeze.script !== 'string' || typeof freeze.sha256 !== 'string') {
    return { required: true, ok: false, reason: `草稿解析器尚未锁定。先把误差写入 ${stage.loop.sampleReport}，再 data_analysis_adopt_command` };
  }
  const script = path.join(root, freeze.script);
  let sha = '';
  try {
    sha = crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  } catch {
    return { required: true, ok: false, reason: `冻结脚本不在了：${freeze.script}` };
  }
  if (sha !== freeze.sha256) return { required: true, ok: false, reason: '冻结后的脚本已变化，需要重新采纳' };
  const sample = fileText(root, stage.loop.sampleReport).trim();
  if (!sample) return { required: true, ok: false, reason: `缺少样本误差记录 ${stage.loop.sampleReport}` };
  return { required: true, ok: true, freeze };
}

const DATA_STAGES = new Set(['verify', 'stats', 'figures', 'manuscript', 'qa']);
const CANONICAL_TABLE = 'output/dataset/analysis.csv';
const LEGACY_TABLE = 'data/analysis.csv';
const TABLE_SCAN_LIMIT = 32 * 1024 * 1024;

function safeRel(relative) {
  const rel = String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || path.isAbsolute(String(relative || '')) || rel.split('/').includes('..')) return '';
  return rel;
}

function fileInfo(root, relative) {
  const rel = safeRel(relative);
  if (!rel) return null;
  try {
    const info = fs.statSync(path.join(root, rel));
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

function keysOf(spec) {
  const raw = spec?.key;
  const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
  return list.map((item) => String(item || '').trim()).filter(Boolean);
}

function coversAllRows(root, spec) {
  const rule = spec?.analysis_selection;
  if (!rule || rule.kind !== 'all' || !String(rule.reason || '').trim()) return false;
  if (!Array.isArray(rule.evidence) || rule.evidence.length === 0) return false;
  return rule.evidence.every((item) => {
    const info = fileInfo(root, item);
    return Boolean(info && info.size > 0);
  });
}

function readTable(root, relative) {
  const info = fileInfo(root, relative);
  if (!info) return { missing: true };
  if (info.size > TABLE_SCAN_LIMIT) return { skipped: true };
  try {
    const parsed = parseCsv(fs.readFileSync(path.join(root, safeRel(relative)), 'utf8'));
    if (!parsed.header.length) return { error: `${relative} 没有表头` };
    return parsed;
  } catch {
    return { error: `${relative} 读不出来` };
  }
}

function keyProblem(table, keys) {
  if (!keys.length) return '缺 key。写成表头里真实存在、且每一行都不重复的列';
  const missing = keys.filter((key) => !table.header.includes(key));
  if (missing.length) return `主键列不在表头：${missing.join('、')}`;
  const seen = new Set();
  let blank = 0;
  let example = '';
  for (const row of table.rows) {
    const parts = keys.map((key) => String(row[key] ?? '').trim());
    if (parts.some((value) => !value)) {
      blank += 1;
      continue;
    }
    const signature = parts.join('\u0001');
    if (seen.has(signature)) {
      if (!example) example = parts.join('+');
    } else seen.add(signature);
  }
  if (blank) return `主键有 ${blank} 行是空的`;
  if (seen.size !== table.rows.length - blank) return `主键有重复${example ? `（例如 ${example}）` : ''}。key 要能唯一标识每一行`;
  return '';
}

function flagProblem(root, spec, table) {
  if (!table.header.includes('in_analysis')) {
    if (coversAllRows(root, spec)) return '';
    return '没有 in_analysis 列。补上 0/1，或写 analysis_selection.kind=all、非空 reason，以及非空 evidence 文件';
  }
  const flags = table.rows.map((row) => String(row.in_analysis ?? '').trim());
  if (flags.some((value) => value !== '0' && value !== '1')) return 'in_analysis 只能是 0 或 1';
  if (!flags.includes('1')) return 'in_analysis 全是 0，没有可分析的行';
  return '';
}

function indexConflict(root, datasets) {
  const file = path.join(root, 'output', 'datasets', 'index.json');
  if (!fs.existsSync(file)) return '';
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return 'output/datasets/index.json 读不懂。按 research_registry.json 改正，或删掉索引';
  }
  const rows = data?.datasets;
  if (!Array.isArray(rows)) return 'output/datasets/index.json 的 datasets 要是数组，并与注册表的 id、path 一致';
  const registered = new Map(datasets.map((item) => [item.id, item.path]));
  if (rows.length !== datasets.length || rows.some((row) => registered.get(String(row?.id || '').trim()) !== safeRel(row?.file || ''))) {
    return 'output/datasets/index.json 与 research_registry.json 的 id 或文件不一致。以注册表为准改正索引，或删掉索引';
  }
  return '';
}

/**
 * 数据集是否已经能被后续阶段读取。
 * 统计、图表、终检和文稿都读注册表里第一份实际存在的表；这里先把缺口写成一句下一步。
 */
function sampleReviewGap(root) {
  if (!fileInfo(root, 'output/coding/dataset.csv')) return '';
  const note = fileText(root, 'docs/decisions/coding-sample.md').trim();
  const reviewed = note.includes('抽样复核：') ? note.slice(note.indexOf('抽样复核：') + '抽样复核：'.length).trim() : '';
  if (reviewed.length >= 12) return '';
  const sample = fileText(root, 'draft/sample_errors.md').trim();
  if (sample.length >= 15 && /误差|原文|抽样/.test(sample)) return '';
  return '编码抽取仍是候选。写 docs/decisions/coding-sample.md，正文包含「抽样复核：」，写明抽查的原文、脚本值是否与原文一致、残留误差。不要把脚本值直接写成分析事实，也不要做逐格全覆盖。';
}

export function datasetPlan(root) {
  const hold = (next) => ({ ready: false, next, label: '', avoid: '先完成数据集登记' });
  const buildNext = `从 output/coding/dataset.csv 构建 ${CANONICAL_TABLE}：一行一个分析单位，保留 in_analysis（0 或 1）。脚本抽出的罪名、刑期、情节只是候选。表写好后，若存在 output/coding/dataset.csv，先写抽样复核，再写 research_registry.json`;
  let registryFile = false;
  let registry = null;
  try {
    const file = path.join(root, 'research_registry.json');
    registryFile = fs.existsSync(file);
    if (registryFile) registry = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return hold('research_registry.json 读不懂。修好这份 JSON');
  }
  const canonical = Boolean(fileInfo(root, CANONICAL_TABLE));
  const legacy = Boolean(fileInfo(root, LEGACY_TABLE));
  if (!registryFile) {
    if (!canonical && !legacy) return hold(buildNext);
    const sampleGap = sampleReviewGap(root);
    if (sampleGap) return hold(sampleGap);
    if (!canonical) return hold(`分析表在 ${LEGACY_TABLE}。移到 ${CANONICAL_TABLE}，再写 research_registry.json：datasets 至少一条，含 id、path、key。path 写成 ${CANONICAL_TABLE}`);
    if (legacy) return hold(`分析表以 ${CANONICAL_TABLE} 为准。写 research_registry.json 时 path 指向它，并把 ${LEGACY_TABLE} 移出语料根`);
    return hold(`分析表已在 ${CANONICAL_TABLE}。写 research_registry.json，datasets 至少一条：id、path 为 ${CANONICAL_TABLE}、key 为表头里真实存在且不重复的列。可投稿档不填写逐格证据账`);
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return hold('research_registry.json 的顶层要是对象');
  const raw = registry.datasets;
  if (!Array.isArray(raw) || raw.length === 0) {
    const sampleGap = sampleReviewGap(root);
    if (sampleGap && (canonical || legacy)) return hold(sampleGap);
    return hold(canonical
      ? `分析表已在 ${CANONICAL_TABLE}。research_registry.json 的 datasets 至少写一条：id、path 为这张表、key 为不重复的列`
      : buildNext);
  }
  const sourceRoot = safeRel(registry.source_root || 'data') || 'data';
  const datasets = [];
  const seen = new Set();
  for (const spec of raw) {
    const id = String(spec?.id || '').trim();
    const rel = safeRel(spec?.path || '');
    if (!id) return hold('research_registry.json 有数据集缺 id');
    if (seen.has(id)) return hold(`research_registry.json 的数据集 id 重复：${id}`);
    seen.add(id);
    if (!rel) return hold(`数据集 ${id} 缺 path。path 指向实际分析表，后续统计和图表读这个路径`);
    datasets.push({ id, path: rel, spec });
  }
  for (const item of datasets) {
    if (!fileInfo(root, item.path)) return hold(`数据集 ${item.id} 的 path「${item.path}」上没有文件。把 path 改成实际分析表`);
    if (item.path === sourceRoot || item.path.startsWith(`${sourceRoot}/`)) {
      return hold(`数据集 ${item.id} 的 path 在语料根 ${sourceRoot} 里。把表放到 ${CANONICAL_TABLE}，并把 path 改成同一路径`);
    }
    const table = readTable(root, item.path);
    if (table.error) return hold(table.error);
    if (table.skipped) continue;
    if (!table.rows.length) return hold(`${item.path} 没有数据行`);
    const keys = keyProblem(table, keysOf(item.spec));
    if (keys) return hold(`数据集 ${item.id}：${keys}`);
    const flags = flagProblem(root, item.spec, table);
    if (flags) return hold(`数据集 ${item.id} 的 ${item.path} ${flags}`);
  }
  const main = datasets[0];
  if (canonical && main.path !== CANONICAL_TABLE) {
    return hold(`注册表第一份是 ${main.path}。目录里还有 ${CANONICAL_TABLE}。后续统计、图表、终检和文稿读注册表这一份。把另一张移走，或把 path 改成它`);
  }
  if (main.path !== LEGACY_TABLE && fileInfo(root, LEGACY_TABLE)) {
    return hold(`语料根还有 ${LEGACY_TABLE}。把它移走。后续读取的是注册表里的 ${main.path}`);
  }
  const indexed = indexConflict(root, datasets);
  if (indexed) return hold(indexed);
  const sampleGap = sampleReviewGap(root);
  if (sampleGap) return hold(sampleGap);
  const label = `${main.id}（${main.path}）`;
  const extra = datasets.length > 1 ? `后续统计和图表默认只读第一份 ${label}。` : '体检通过后，统计、图表和文稿都读这张表。';
  return {
    ready: true,
    next: `调用 data_analysis_gates(action="inspect") 做数据集体检。登记表是 ${label}。${extra}`,
    label,
    avoid: '体检通过前停在数据集',
  };
}

export function entryBlock(root, stage, tier) {
  if (tier && !stageApplies(stage, tier)) return `当前验收档 ${tier} 不做阶段 ${stage.id}`;
  if (DATA_STAGES.has(stage?.id)) {
    const plan = datasetPlan(root);
    if (!plan.ready) return plan.next;
  }
  const resume = resumeBlock(root, stage);
  if (resume) return resume;
  const frozen = freezeState(root, stage);
  if (frozen.required && !frozen.ok) return frozen.reason;
  if (stage.hostCall) {
    const input = path.join(root, stage.hostCall.input);
    if (!fs.existsSync(input)) return `缺少交付输入 ${stage.hostCall.input}`;
    return `这一阶段不跑本地脚本。调用 ${stage.hostCall.tool}，输入 ${stage.hostCall.input}，再 data_analysis_record_handoff 记下 ${stage.hostCall.returns.join('、')}`;
  }
  return '';
}

function handoffReady(root, stage) {
  if (!stage?.hostCall) return false;
  const handoff = readJson(path.join(root, 'output', 'handoff.json'), null);
  if (!handoff || !stage.hostCall.returns.every((key) => handoff[key] !== undefined && handoff[key] !== '')) return false;
  const relative = handoff.manuscript || stage.hostCall.input;
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !handoff.manuscriptSha256) return false;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return sha256 === handoff.manuscriptSha256;
}

export function openDisputeIds(root) {
  const file = path.join(root, 'output', 'gates', 'disputes.jsonl');
  if (!fs.existsSync(file)) return new Set();
  const ids = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if ((row.status || 'open') === 'open' && row.gateId) ids.add(row.gateId);
    } catch {
      /* 坏行留在文件里，不把它当成已关闭 */
    }
  }
  return ids;
}

function stageStatus(stages, id) {
  return (stages || []).find((item) => item.id === id) || null;
}

export function buildCursor({ root, workflow, stages = [], tier }) {
  const acceptance = tier || readAcceptance(root).tier;
  const disputes = openDisputeIds(root);
  const visible = (workflow?.stages || []).filter((stage) => stageApplies(stage, acceptance));
  let current = visible.find((stage) => {
    if (stage.hostCall && handoffReady(root, stage)) return false;
    const state = stageStatus(stages, stage.id);
    return !state || !['done', 'na'].includes(state.status);
  }) || visible[visible.length - 1];
  const lines = [`验收档：${acceptance || '未设置（全部门禁仍生效）'}`, `当前位置：${current ? `${current.index}. ${current.name}` : '无'}`];
  let next = '调用 data_analysis_status 查看任务卡。';
  const avoid = [];
  const plan = current && (current.id === 'dataset' || DATA_STAGES.has(current.id)) ? datasetPlan(root) : null;
  if (current?.hostCall && handoffReady(root, current)) {
    next = '交付编号已记录。预览套版后停止本回合，等用户明确同意再套版。';
  } else if (current) {
    const resume = resumeBlock(root, current);
    const frozen = freezeState(root, current);
    const tableNote = plan?.ready ? `。主表是 ${plan.label}` : '';
    if (plan && current.id !== 'dataset' && !plan.ready) next = plan.next;
    else if (resume) next = `${resume}${tableNote}`;
    else if (frozen.required && !frozen.ok) {
      if (!fileText(root, current.loop.sampleReport).trim()) {
        next = `调用 data_analysis_workflow(action="run-action", actionId="suggest-profiles")，然后在 ${current.loop.draftDir}/ 试跑，并把误差写入 ${current.loop.sampleReport}`;
      } else next = `调用 data_analysis_adopt_command 锁定 ${current.id} 并留下回执`;
      avoid.push('不要手跑脚本代替回执', '不要修改 draft/ 以外的已完成审计');
    } else if (current.hostCall) {
      next = `调用 ${current.hostCall.tool}，输入 ${current.hostCall.input}。交接成功会写入 output/handoff.json；文本里没有写上时，再调用 data_analysis_record_handoff`;
      avoid.push('预览之后停止本回合');
    } else if (current.id === 'dataset') {
      const state = stageStatus(stages, 'dataset');
      const pending = (state?.gates || []).filter((gate) => ['fail', 'unjudged'].includes(gate.status) && gate.level !== 'info' && gate.id !== 'stage-source');
      const meaningful = pending.filter((gate) => gate.detail && !gate.detail.includes('技能体检尚未完成') && gate.detail !== gate.label);
      next = plan.ready && meaningful.length
        ? `按体检结果修改：${meaningful.slice(0, 3).map((gate) => `${gate.id}：${gate.detail}`).join('；')}。改完再调用 data_analysis_gates(action="inspect")`
        : plan.next;
      if (plan.avoid) avoid.push(plan.avoid);
    } else if (current.id === 'stats') {
      next = `主表是 ${plan.label}。调用 data_analysis_sweep，再用 data_analysis_register 登记模型，然后 data_analysis_run_stage(stageId="stats")`;
    } else if (current.id === 'qa') {
      next = '调用 data_analysis_run_stage(stageId="qa")';
      if (plan?.ready) next += `。数据表是 ${plan.label}`;
      if (acceptance === 'archive' || !acceptance) next += '。随后调用 data_analysis_research_gate';
    } else if (current.script || current.steps?.length) {
      next = `调用 data_analysis_run_stage(stageId="${current.id}")`;
      if (current.id === 'coding') next += '。脚本抽出的字段只是候选，语义值要有原文位置或判断记录后才能进分析表';
      if (plan?.ready) next += `。数据表是 ${plan.label}`;
    } else if (current.manualInstructions?.length) {
      next = current.manualInstructions[0];
    }
  }
  lines.push(`下一步：${next}`);
  if (avoid.length) lines.push(`先不要做：${avoid.join('；')}`);
  const open = [];
  const currentState = stageStatus(stages, current?.id);
  for (const gate of currentState?.gates || []) {
    if (!['fail', 'unjudged'].includes(gate.status) || disputes.has(gate.id)) continue;
    if (gate.level === 'info' || gate.id === 'stage-source') continue;
    if (gate.detail && (gate.detail === gate.label || gate.detail.includes('技能体检尚未完成'))) continue;
    open.push(`${gate.id}：${gate.detail || gate.label}`);
    if (open.length >= 2) break;
  }
  if (open.length) lines.push(`本阶段未结（下一步仍以上面那句为准）：${open.join('；')}`);
  if (disputes.size) lines.push(`争议 ${disputes.size} 条，不作为下一步，也不算通过`);
  const assumptions = path.join(root, 'output', 'assumptions.jsonl');
  if (fs.existsSync(assumptions)) {
    const count = fs.readFileSync(assumptions, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length;
    if (count) lines.push(`假设账 ${count} 条，终稿必须原样列出，不能写成用户已确认`);
  }
  lines.push('终稿状态以 output/handoff.json 和本任务卡为准。');
  const text = lines.join('\n');
  return {
    ok: true,
    text: text.length > 2000 ? `${text.slice(0, 1990)}\n…` : text,
    cursor: { tier: acceptance, stageId: current?.id || '', next },
  };
}

export function writeCursorFile(root, card) {
  writeJson(path.join(root, '.workbench', 'cursor.json'), {
    schema: 'dsa.cursor/1',
    ...card.cursor,
    text: card.text,
    updatedAt: new Date().toISOString(),
  });
}

function safeRelative(root, relative) {
  const rel = String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) return '';
  const abs = path.resolve(root, rel);
  const inside = path.relative(path.resolve(root), abs);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return '';
  return rel;
}

export function adoptCommand(root, { stage, script, args = [], artifacts = [] }) {
  const resume = resumeBlock(root, stage);
  if (resume) return { ok: false, error: resume };
  const scriptRel = safeRelative(root, script);
  if (!scriptRel || !fs.existsSync(path.join(root, scriptRel))) return { ok: false, error: '采纳的脚本必须是项目内已存在的相对路径' };
  if (!(scriptRel.startsWith('draft/') || scriptRel.startsWith('scripts/'))) {
    return { ok: false, error: '脚本只能来自 draft/ 或 scripts/' };
  }
  const sample = stage.loop ? fileText(root, stage.loop.sampleReport).trim() : 'ok';
  if (stage.loop && !sample) return { ok: false, error: `先写入 ${stage.loop.sampleReport}` };
  const cleanArgs = [];
  for (const item of args) {
    const text = String(item);
    if (text.includes('\0')) return { ok: false, error: '参数含有无效字符' };
    cleanArgs.push(text);
  }
  const produces = [];
  for (const item of artifacts.length ? artifacts : stage.artifacts || []) {
    const rel = safeRelative(root, item);
    if (!rel) return { ok: false, error: `产物路径不安全：${item}` };
    produces.push(rel);
  }
  let target = scriptRel;
  if (stage.loop && scriptRel.startsWith('draft/')) {
    target = `scripts/${stage.id}_frozen.py`;
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(root, scriptRel), path.join(root, target));
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, target))).digest('hex');
  if (stage.loop) {
    writeJson(path.join(root, stage.loop.freezeFile), {
      schema: 'dsa.freeze/1',
      stageId: stage.id,
      script: target,
      sha256,
      sampleReport: stage.loop.sampleReport,
      frozenAt: new Date().toISOString(),
    });
  }
  return { ok: true, script: target, args: cleanArgs, produces, sha256 };
}

export function recordDispute(root, { stageId, gateId, evidence }) {
  const note = String(evidence || '').trim();
  if (!stageId || !gateId || note.length < 8) return { ok: false, error: '争议需要阶段、判据编号，以及至少一句对账证据' };
  const file = path.join(root, 'output', 'gates', 'disputes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    stageId, gateId, evidence: note, status: 'open', at: new Date().toISOString(),
  }) + '\n');
  return { ok: true, file: 'output/gates/disputes.jsonl' };
}

export function recordHandoff(root, { fileId, paperId, versionId, previous, manuscript = 'output/manuscript.docx' }) {
  if (!fileId || paperId === undefined || paperId === '' || versionId === undefined || versionId === '') {
    return { ok: false, error: '交接需要 file_id、paper_id、version_id' };
  }
  const relative = safeRelative(root, manuscript);
  if (!relative || !fs.existsSync(path.join(root, relative))) return { ok: false, error: '找不到已登记的文稿' };
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
  const value = {
    schema: 'dsa.handoff/1',
    file_id: String(fileId),
    paper_id: paperId,
    version_id: versionId,
    manuscript: relative,
    manuscriptSha256: sha256,
    previousBinding: previous || null,
    at: new Date().toISOString(),
  };
  writeJson(path.join(root, 'output', 'handoff.json'), value);
  return { ok: true, handoff: value };
}

export function noteAssumption(root, text) {
  const note = String(text || '').trim();
  if (note.length < 4) return { ok: false, error: '假设需要写明内容和它代替了哪一项确认' };
  const file = path.join(root, 'output', 'assumptions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ text: note, at: new Date().toISOString() }) + '\n');
  return { ok: true, file: 'output/assumptions.jsonl' };
}

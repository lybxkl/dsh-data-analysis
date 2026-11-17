/**
 * 会话游标。
 *
 * 任务卡由当前工作流、验收档和项目里的确认文件生成。
 * 插件不另写一份阶段表：下一步只解释技能包已经声明的阶段。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

export function entryBlock(root, stage, tier) {
  if (tier && !stageApplies(stage, tier)) return `当前验收档 ${tier} 不做阶段 ${stage.id}`;
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
  if (current?.hostCall && handoffReady(root, current)) {
    next = '交付编号已记录。预览套版后停止本回合，等用户明确同意再套版。';
  } else if (current) {
    const resume = resumeBlock(root, current);
    const frozen = freezeState(root, current);
    if (resume) next = resume;
    else if (frozen.required && !frozen.ok) {
      if (!fileText(root, current.loop.sampleReport).trim()) {
        next = `调用 data_analysis_workflow(action="run-action", actionId="suggest-profiles")，然后在 ${current.loop.draftDir}/ 试跑，并把误差写入 ${current.loop.sampleReport}`;
      } else next = `调用 data_analysis_adopt_command 锁定 ${current.id} 并留下回执`;
      avoid.push('不要手跑脚本代替回执', '不要修改 draft/ 以外的已完成审计');
    } else if (current.hostCall) {
      next = `调用 ${current.hostCall.tool}，输入 ${current.hostCall.input}；返回后调用 data_analysis_record_handoff`;
      avoid.push('预览之后停止本回合');
    } else if (current.id === 'stats') {
      next = '调用 data_analysis_sweep，再用 data_analysis_register 登记模型，然后 data_analysis_run_stage(stageId="stats")';
    } else if (current.script || current.steps?.length) {
      next = `调用 data_analysis_run_stage(stageId="${current.id}")`;
      if (current.id === 'coding') next += '。脚本抽出的字段只是候选，语义值要有原文位置或判断记录后才能进分析表';
    } else if (current.manualInstructions?.length) {
      next = current.manualInstructions[0];
    }
  }
  lines.push(`下一步：${next}`);
  if (avoid.length) lines.push(`先不要做：${avoid.join('；')}`);
  const open = [];
  for (const stage of stages || []) {
    if (!stageApplies(workflow.stages.find((item) => item.id === stage.id) || stage, acceptance)) continue;
    for (const gate of stage.gates || []) {
      if (!['fail', 'unjudged'].includes(gate.status) || disputes.has(gate.id)) continue;
      if (gate.detail && gate.detail === gate.label) continue;
      open.push(`${gate.id}：${gate.detail || gate.label}`);
      if (open.length >= 4) break;
    }
    if (open.length >= 4) break;
  }
  if (open.length) lines.push(`本档待补：${open.join('；')}`);
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

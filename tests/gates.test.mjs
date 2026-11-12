// 闸门判定测试：不跑脚本，直接把产物摆成各种形状，看 evaluateProject 给什么结论。
// 关注点是「判不了 ≠ 通过」：该 unjudged 的不能 pass，该拦的不能只提醒。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateProject, gateTotals, summarizeStages } from '../src/gates.js';
import { scanArtifacts } from '../src/audit.js';

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (error) {
    failures.push(`${label}：${error.message}`);
    console.log(`✗ ${label} — ${error.message}`);
  }
}

const tmpRoots = [];
function makeProject(seed = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-gates-'));
  tmpRoots.push(root);
  for (const dir of ['data', 'docs', 'output', 'runs', 'scripts']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

const baseProject = (extra = {}) => ({
  id: 'test00000001',
  name: '闸门测试',
  path: '',
  stages: {},
  materials: { version: 1, mounts: [] },
  ...extra,
});

function judge(root, options = {}) {
  const artifacts = { ...scanArtifacts(root), ...(options.artifacts || {}) };
  const project = baseProject(options.project || {});
  project.path = root;
  const stages = evaluateProject({
    projectRoot: root,
    project,
    artifacts,
    adjudications: options.adjudications || {},
    activeRuns: options.activeRuns || {},
    runs: options.runs || [],
    sources: options.sources || [],
  });
  const all = [];
  for (const stage of stages) for (const g of stage.gates) all.push({ stage: stage.id, ...g });
  const byId = (id) => all.find((g) => g.id === id);
  const stageById = (id) => stages.find((s) => s.id === id);
  return { stages, all, byId, stageById };
}

const ALLOWED = new Set(['pass', 'fail', 'unjudged']);

// ── 1. 空项目：不能抛，状态词只能是三种 ─────────────────────────────
check('空项目能判，且不抛异常', () => {
  const root = makeProject();
  const { stages, all } = judge(root);
  assert.equal(stages.length, 9);
  for (const g of all) assert.ok(ALLOWED.has(g.status), `闸门 ${g.id} 状态异常：${g.status}`);
  for (const stage of stages) assert.ok(['todo', 'review', 'blocked', 'done', 'running'].includes(stage.status), `阶段 ${stage.id} 状态异常`);
});

check('空项目里审计新鲜度是「判不了」而不是「通过」', () => {
  const root = makeProject();
  const { byId } = judge(root);
  assert.equal(byId('audit-freshness').status, 'unjudged');
  assert.equal(byId('audit-flow').status, 'fail', '缺 sample_flow 应当 fail（文件闸门）');
});

check('没干过活的阶段是 todo，且 gateTotals 跳过 todo', () => {
  const root = makeProject();
  const { stages, stageById } = judge(root);
  assert.equal(stageById('coding').status, 'todo');
  assert.equal(stageById('coding').gates.some((g) => g.status === 'fail'), true, 'coding 确实带着一条 fail（缺编码表）');
  const totals = gateTotals(stages);
  const blockedFails = stages
    .filter((s) => s.status !== 'todo')
    .reduce((n, s) => n + s.gates.filter((g) => g.status === 'fail').length, 0);
  assert.equal(totals.fail, blockedFails, 'todo 阶段的 fail 不该计入总数');
  assert.equal(totals.fail, 1, '只有 scope 的 scope-doc 该计数');
  const counts = summarizeStages(stages);
  const sum = Object.values(counts).reduce((n, v) => n + v, 0);
  assert.equal(sum, 9, '九个阶段都要被归类');
});

// ── 2. 审计是否新鲜 ────────────────────────────────────────────────
function auditSeed(files = 2, bytes = 100) {
  const rows = [];
  for (let i = 0; i < files; i += 1) rows.push(`安徽/a${i}.pdf,安徽/a${i}.pdf,安徽,a${i}.pdf,.pdf,docx,${bytes}`);
  return {
    'output/audit/corpus_files.csv': `rel_path,relpath,top,name,ext,kind,bytes\r\n${rows.join('\r\n')}\r\n`,
    'output/audit/corpus_summary.json': JSON.stringify({
      total_files: files,
      valid_files: files,
      corpus_fingerprint: { files, bytes: bytes * files },
    }),
  };
}

check('data/ 与审计快照一致 → audit-freshness pass', () => {
  const seed = auditSeed(2, 50);
  seed['data/安徽/a0.pdf'] = 'x'.repeat(50);
  seed['data/安徽/a1.pdf'] = 'x'.repeat(50);
  const root = makeProject(seed);
  const { byId } = judge(root);
  assert.equal(byId('audit-freshness').status, 'pass', byId('audit-freshness').detail);
  assert.equal(byId('audit-freshness').level, 'warn');
});

check('data/ 变了 → audit-freshness fail(error)：拦住', () => {
  const seed = auditSeed(2, 50);
  seed['data/安徽/a0.pdf'] = 'x'.repeat(50);
  seed['data/安徽/a1.pdf'] = 'x'.repeat(50);
  seed['data/安徽/a2.pdf'] = 'x'.repeat(50); // 审计之后又放进一份
  const root = makeProject(seed);
  const { byId } = judge(root);
  const g = byId('audit-freshness');
  assert.equal(g.status, 'fail');
  assert.equal(g.level, 'error');
  assert.match(g.detail, /先重跑审计/);
});

check('缺 fingerprint → audit-freshness unjudged（不许当成通过）', () => {
  const root = makeProject({
    'output/audit/corpus_summary.json': JSON.stringify({ total_files: 1 }),
  });
  const { byId } = judge(root);
  assert.equal(byId('audit-freshness').status, 'unjudged');
});

// ── 3. 材料来源账对账 ─────────────────────────────────────────────
function mountedSeed(provRows, totalFiles) {
  return {
    'output/materials/provenance.csv': `rel_path,mount,source_id,source_label,source_path,bytes,ext,kind,channel\r\n${Array.from({ length: provRows }, (_, i) => `安徽__识别稿/a${i}.txt,安徽,src_1,安徽,F:/x,10,txt,derived,vision`).join('\r\n')}\r\n`,
    'output/materials/selection.csv': 'source_id,source_label,path_in_source,include,reason_code,channel\r\nsrc_1,安徽,a.pdf,yes,,read\r\n',
    'output/audit/corpus_files.csv': 'rel_path,relpath,top,name,ext,kind,bytes\r\n安徽/a.pdf,安徽/a.pdf,安徽,a.pdf,.pdf,docx,10\r\n',
    'output/audit/corpus_summary.json': JSON.stringify({ total_files: totalFiles, valid_files: totalFiles, corpus_fingerprint: { files: 1, bytes: 10 } }),
  };
}

check('来源账行数与审计文件数一致 → pass', () => {
  const real = makeProject(mountedSeed(3, 3));
  const { byId } = judge(real, {
    project: { materials: { version: 1, mounts: [{ id: 'm1', sourceId: 'src_1', entry: '', as: '安徽', target: 'F:/x' }] } },
  });
  const g = byId('materials-provenance-cover');
  assert.ok(g, '有挂载时必须出现来源账对账闸门');
  assert.equal(g.status, 'pass', g.detail);
});

check('来源账行数与审计文件数不等 → unjudged，并给出常见原因', () => {
  const real = makeProject(mountedSeed(3, 5));
  const { byId } = judge(real, {
    project: { materials: { version: 1, mounts: [{ id: 'm1', sourceId: 'src_1', entry: '', as: '安徽', target: 'F:/x' }] } },
  });
  const g = byId('materials-provenance-cover');
  assert.equal(g.status, 'unjudged', g.detail);
  assert.match(g.detail, /差 2/);
});

check('有挂载但来源账缺失 → materials-provenance fail', () => {
  const root = makeProject({ 'data/安徽/a.pdf': 'x' });
  const { byId } = judge(root, {
    project: { materials: { version: 1, mounts: [{ id: 'm1', sourceId: 'src_1', entry: '', as: '安徽', target: 'F:/x' }] } },
  });
  assert.equal(byId('materials-provenance').status, 'fail');
});

// ── 4. 闸门：fail 与 unjudged 的边界 ─────────────────────────────
check('qa-numbers：error 全是输入类 → unjudged（没得查，不是查错了）', () => {
  const root = makeProject({ 'data/a.pdf': 'x' });
  const { byId } = judge(root, {
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 4, input: 4, warning: 0, info: 0 } } },
  });
  const g = byId('qa-numbers');
  assert.equal(g.status, 'unjudged', g.detail);
  assert.equal(g.level, 'error');
});

check('qa-numbers：有真错 → fail', () => {
  const root = makeProject({ 'data/a.pdf': 'x' });
  const { byId } = judge(root, {
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 2, input: 0, warning: 1, info: 0 } } },
  });
  assert.equal(byId('qa-numbers').status, 'fail');
});

function visionSeed(verified) {
  return {
    'output/audit/vision_log.csv': `rel_path,page,input_sha256,model,prompt_version,at,tokens,status,human_verified,derived_rel,error\r\n扫描件/笔录.pdf,1,abc,deepseek,vision-v1,2026-11-12T01:00:00Z,120,ok,${verified},扫描件__识别稿/笔录.pdf.p0001.txt,\r\n`,
  };
}

check('识图未核对且被引用 → qa-vision unjudged，并点名引用者', () => {
  const seed = visionSeed('false');
  Object.assign(seed, {
    'output/verify/number_issues.csv': 'kind,detail,file\r\ninfo,引用 扫描件__识别稿/笔录.pdf.p0001.txt 的样本,output/verify/x.csv\r\n',
  });
  const root = makeProject(seed);
  const { byId } = judge(root, {
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 0, input: 0, warning: 0, info: 1 } } },
  });
  const g = byId('qa-vision');
  assert.equal(g.status, 'unjudged', g.detail);
  assert.match(g.detail, /还没人工核对/);
});

check('识图未核对但没被引用 → 仍然 unjudged（未核不是通过）', () => {
  const root = makeProject(visionSeed('false'));
  const { byId } = judge(root, {
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 0, input: 0, warning: 0, info: 0 } } },
  });
  assert.equal(byId('qa-vision').status, 'unjudged');
});

check('识图日志全是失败行 → qa-vision unjudged（不是「都核对过了」）', () => {
  const seed = {
    'output/audit/vision_log.csv': 'rel_path,page,input_sha256,model,prompt_version,at,tokens,status,human_verified,derived_rel,error\r\n'
      + '扫描件/笔录.pdf,1,,deepseek,vision-v1,2026-11-12T01:00:00Z,0,error,false,,模型返回了占位文本\r\n'
      + '扫描件/笔录.pdf,2,,deepseek,vision-v1,2026-11-12T01:00:01Z,0,error,false,,渲染失败\r\n',
  };
  const root = makeProject(seed);
  const { byId } = judge(root, {
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 0, input: 0, warning: 0, info: 0 } } },
  });
  const g = byId('qa-vision');
  assert.equal(g.status, 'unjudged', g.detail);
  assert.match(g.detail, /没有一行成功/);
});

check('识图全部人工核对 → qa-vision pass', () => {
  const root = makeProject(visionSeed('true'));
  const { byId } = judge(root, {
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 0, input: 0, warning: 0, info: 0 } } },
  });
  assert.equal(byId('qa-vision').status, 'pass');
});

check('dataset-in-analysis：有 spec 却没引用 in_analysis → fail(error)', () => {
  const root = makeProject({
    'output/dataset/analysis.csv': 'id,in_analysis\r\na,1\r\nb,0\r\n',
    'model_spec.json': JSON.stringify({ models: [{ id: 'm1', formula: 'y ~ x' }] }),
  });
  const { byId } = judge(root);
  const g = byId('dataset-in-analysis');
  assert.equal(g.status, 'fail', g.detail);
  assert.equal(g.level, 'error');
});

check('fig-dpi：596 → fail；597 → pass', () => {
  const row = (dpi) => ({ id: 'f1', png: 'output/figures/f1.png', pngExists: true, pxWidth: 600, effectiveDpi: dpi, minFontsize: 8, n: 100, status: 'pass', palette: { state: 'pass', min: 20 } });
  const root = makeProject({ 'output/figures/f1.png': 'x' });
  const low = judge(root, { artifacts: { figures: { file: 'output/figures/fig_manifest.csv', rows: [row(596)], summary: {} }, manuscript: null } });
  assert.equal(low.byId('fig-dpi').status, 'fail');
  const ok = judge(root, { artifacts: { figures: { file: 'output/figures/fig_manifest.csv', rows: [row(597)], summary: {} }, manuscript: null } });
  assert.equal(ok.byId('fig-dpi').status, 'pass');
});

check('fig-font：7.1 → fail；7.2 → pass', () => {
  const row = (pt) => ({ id: 'f1', png: 'output/figures/f1.png', pngExists: true, pxWidth: 600, effectiveDpi: 600, minFontsize: pt, n: 100, status: 'pass', palette: { state: 'pass', min: 20 } });
  const root = makeProject({ 'output/figures/f1.png': 'x' });
  const low = judge(root, { artifacts: { figures: { file: 'output/figures/fig_manifest.csv', rows: [row(7.1)], summary: {} } } });
  assert.equal(low.byId('fig-font').status, 'fail');
  const ok = judge(root, { artifacts: { figures: { file: 'output/figures/fig_manifest.csv', rows: [row(7.2)], summary: {} } } });
  assert.equal(ok.byId('fig-font').status, 'pass');
});

// ── 5. 人工裁定的时效 ────────────────────────────────────────────
check('裁定早于最近一次运行 → 退回 unjudged（标记 stale）', () => {
  const root = makeProject({ 'data/a.pdf': 'x' });
  const runs = [{ id: 'r1', stageId: 'qa', startedAt: '2026-11-12T10:00:00Z', endedAt: '2026-11-12T10:05:00Z', status: 'ok' }];
  const { byId } = judge(root, {
    runs,
    adjudications: { 'qa-signoff': { status: 'pass', at: '2026-11-12T09:00:00Z', note: '看过了' } },
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 0, input: 0, warning: 0, info: 0 } } },
  });
  const g = byId('qa-signoff');
  assert.equal(g.status, 'unjudged', g.detail);
  assert.equal(g.stale, true);
});

check('裁定晚于最近一次运行 → pass', () => {
  const root = makeProject({ 'data/a.pdf': 'x' });
  const runs = [{ id: 'r1', stageId: 'qa', startedAt: '2026-11-12T10:00:00Z', endedAt: '2026-11-12T10:05:00Z', status: 'ok' }];
  const { byId } = judge(root, {
    runs,
    adjudications: { 'qa-signoff': { status: 'pass', at: '2026-11-12T11:00:00Z', note: '看过了' } },
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 0, input: 0, warning: 0, info: 0 } } },
  });
  assert.equal(byId('qa-signoff').status, 'pass');
});

check('人工裁定「不通过」按 error 拦，不是提醒', () => {
  const root = makeProject({ 'data/a.pdf': 'x' });
  const { byId } = judge(root, {
    adjudications: { 'qa-signoff': { status: 'fail', at: '2026-11-12T11:00:00Z', note: '数字对不上' } },
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 0, input: 0, warning: 0, info: 0 } } },
  });
  assert.equal(byId('qa-signoff').status, 'fail');
  assert.equal(byId('qa-signoff').level, 'error');
});

// ── 6. 阶段状态机 ────────────────────────────────────────────────
check('error 级 fail 存在 → 该阶段 blocked', () => {
  const root = makeProject({ 'data/a.pdf': 'x', 'output/verify/number_issues.csv': 'kind\r\nerror\r\n' });
  const { stageById } = judge(root, {
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 1, input: 0, warning: 0, info: 0 } } },
  });
  assert.equal(stageById('qa').status, 'blocked');
});

check('只有 unjudged → review（不做成 done）', () => {
  const root = makeProject(visionSeed('false'));
  const { stageById } = judge(root, {
    artifacts: { verify: { file: 'output/verify/number_issues.csv', counts: { error: 0, input: 0, warning: 0, info: 0 } } },
  });
  assert.equal(stageById('qa').status, 'review');
});

// ── 收尾 ────────────────────────────────────────────────────────
for (const root of tmpRoots) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败 / ${passed + failures.length} 条`);
  for (const line of failures) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`✓ 闸门判定全部通过（${passed} 条）`);

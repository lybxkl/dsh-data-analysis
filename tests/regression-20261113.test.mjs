/*
 * 2026-11-13 复盘缺陷的回归测试（第五至十节）。
 *
 * 这里覆盖的是「不是靠加闸门、而是靠改行为」修掉的问题：
 *   五、首次组稿不再漏掉 PDF 导出（whenFile 在执行到那一步时判断）
 *   六、纯表格语料：编码阶段有依据地判「不适用」，不再拿编码表闸门卡死
 *   七、新项目默认严格契约；老项目仍按 legacy 放行
 *   八、多数据集：登记了几份就按几份验收，不再死盯 output/dataset/analysis.csv
 *   九、research_registry.json 桥接：不再需要维护两份数据集注册表
 *   十、图表清单合并：两套清单同时在时，旧清单里的图也进检查视图
 *   十一、复核汇总：unjudged 不再被汇总成 pass（覆盖表也不能洗白）
 *
 * 跑法：node tests/regression-20261113.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanArtifacts } from '../src/audit.js';
import { evaluateProject, gateTotals } from '../src/gates.js';
import { readRegistry } from '../src/registry.js';
import { Workbench } from '../src/service.js';
import { Runner } from '../src/runner.js';

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

/** async 版本：await 之后再判失败，别让 Promise 被当成同步通过。 */
async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (error) {
    failures.push(`${label}：${error.message}`);
    console.log(`✗ ${label} — ${error.message}`);
  }
}
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpRoots = [];
function makeProject(seed = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-reg-'));
  tmpRoots.push(root);
  for (const dir of ['data', 'docs', 'output', 'runs', 'scripts']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function judge(root, { project = {}, artifacts = {} } = {}) {
  const scanned = scanArtifacts(root);
  const merged = { ...scanned };
  for (const [key, value] of Object.entries(artifacts)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) && scanned[key] && typeof scanned[key] === 'object'
      ? { ...scanned[key], ...value }
      : value;
  }
  // 服务层（service.js）在 scanArtifacts 之上补了注册表视图；这里照做，
  // 否则「有注册表」的分支根本走不到，测出来的 pass/fail 都是假的。
  if (!merged.registry) {
    try {
      merged.registry = readRegistry(root);
    } catch (error) {
      merged.registry = null;
      merged.registryError = String(error && error.message ? error.message : error);
    }
  }
  const proj = {
    id: 'reg000000001',
    name: '回归项目',
    path: root,
    stages: {},
    materials: { version: 1, mounts: [] },
    schemaVersion: 1,
    ...project,
  };
  const stages = evaluateProject({
    projectRoot: root,
    project: proj,
    artifacts: merged,
    adjudications: {},
    activeRuns: {},
    runs: [],
    sources: [],
  });
  const all = [];
  for (const stage of stages) for (const gate of stage.gates) all.push({ stage: stage.id, ...gate });
  return {
    stages,
    all,
    byId: (id) => all.find((gate) => gate.id === id),
    stageById: (id) => stages.find((stage) => stage.id === id),
  };
}

function benchFor(root) {
  const ledger = {
    version: 1,
    projects: [{ id: 'reg', path: root }],
    activeProjectId: 'reg',
    activeProjectPath: root,
    runs: [],
    adjudications: {},
    recheckChains: {},
    meta: {},
    config: { skillRoot: '', pythonPath: process.env.DSA_PYTHON || 'python', dataDir: '', maxRuns: 60, maxLogLines: 400 },
  };
  const store = {
    filePath: path.join(root, '.ledger', 'data-analysis.json'),
    get: (k) => (k === undefined ? ledger : ledger[k]),
    set: (k, v) => {
      if (k && typeof k === 'object') Object.assign(ledger, k);
      else ledger[k] = v;
    },
    flush() {},
    flushSoon() {},
  };
  const getConfig = () => ledger.config;
  const runner = new Runner({ getConfig, store, onChange: () => {} });
  const wb = new Workbench({ getConfig, store, runner, onChange: () => {} });
  runner.onFinish = (run) => wb.onRunFinished(run);
  return { ledger, wb, runner };
}

async function waitRun(ledger, runId, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(150);
    const run = (ledger.runs || []).find((item) => item.id === runId);
    if (run && run.status && run.status !== 'running') return run;
  }
  return null;
}

/* ═════════════ 五、首次组稿不再漏掉 PDF 导出 ═════════════ */

const ASSEMBLE_SCRIPT = `import os, sys, json
args = sys.argv[1:]
out = "output/manuscript.docx"
for i, v in enumerate(args):
    if v == "--out":
        out = args[i + 1]
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "wb") as fh:
    fh.write(b"PK\\x03\\x04docx")
# 组装器顺带写 figure_map.json：PDF 导出那一步就靠它当条件
os.makedirs("output", exist_ok=True)
with open("output/figure_map.json", "w", encoding="utf-8") as fh:
    json.dump({"figures": []}, fh)
print("assembled", out)
`;

const PDF_SCRIPT = `import os, sys
args = sys.argv[1:]
out = "output/manuscript.pdf"
for i, v in enumerate(args):
    if v == "--out-pdf":
        out = args[i + 1]
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "wb") as fh:
    fh.write(b"%PDF-1.7 fake")
print("pdf", out)
`;

const REGISTERED_TABLE = {
  'output/dataset/analysis.csv': 'id,in_analysis\r\na,1\r\n',
  'research_registry.json': JSON.stringify({ datasets: [{ id: 'cases', path: 'output/dataset/analysis.csv', key: 'id' }] }),
};

function manuscriptBench() {
  const root = makeProject({
    ...REGISTERED_TABLE,
    'scripts/assemble_manuscript.py': ASSEMBLE_SCRIPT,
    'scripts/export_pdf_hires.py': PDF_SCRIPT,
    'manuscript.json': JSON.stringify({ blocks: [{ type: 'para', text: '正文' }] }),
    'docs/decisions/figure-selection.md': '正文图：图1\n',
    'project.json': JSON.stringify({ name: '组稿回归', schemaVersion: 2, contract: { version: 2, mode: 'strict' } }),
  });
  return { root, ...benchFor(root) };
}

section('五、首次组稿的 PDF 导出（whenFile 执行到该步才判断）');
await (async () => {
  const { root, wb, ledger } = manuscriptBench();
  wb.openProject(root);
  const stage = wb.stageById('manuscript');
  const command = wb.commandFor(root, wb.active().project, stage);
  await checkAsync('首次运行 commandFor 仍把 PDF 导出排在计划里（不再启动前就删掉）', () => {
    assert.equal(command.ok, true, command.error);
    assert.equal(command.steps.length, 2, `${command.steps.length} 步`);
  });
  await checkAsync('第一步声明了 figure_map.json 是它的产物', () => {
    const deferred = command.deferred || [];
    assert.ok(
      deferred.some((item) => item.script === 'scripts/export_pdf_hires.py' && item.whenFile === 'output/figure_map.json'),
      JSON.stringify(deferred),
    );
  });

  const started = wb.runStage('manuscript', { force: true });
  await checkAsync('组稿起步', () => assert.equal(started.ok, true, started.error || ''));
  const settled = await waitRun(ledger, started.run && started.run.id);
  await checkAsync('首次运行状态 ok', () => assert.ok(settled && settled.status === 'ok', settled && `${settled.status} exit=${settled.exitCode}`));
  await checkAsync('首次运行就生成了 manuscript.docx', () => assert.ok(fs.existsSync(path.join(root, 'output', 'manuscript.docx'))));
  await checkAsync('首次运行也生成了 manuscript.pdf（旧实现第一次会跳过）', () => assert.ok(fs.existsSync(path.join(root, 'output', 'manuscript.pdf'))));
  await checkAsync('运行记录里 PDF 步骤是 ok 而不是 skipped', () => {
    const run = (ledger.runs || []).find((item) => item.id === (started.run || {}).id);
    const pdfStep = (run && run.steps ? run.steps : []).find((step) => step.script === 'scripts/export_pdf_hires.py');
    assert.ok(pdfStep, JSON.stringify(run && run.steps));
    assert.equal(pdfStep.status, 'ok', JSON.stringify(pdfStep));
  });
})();

await (async () => {
  // 没有 figure_map 也没人会生成它：该步在执行到那里时才被跳过，并写进运行记录。
  const root = makeProject({
    ...REGISTERED_TABLE,
    'scripts/assemble_manuscript.py': 'print("no map")\n',
    'scripts/export_pdf_hires.py': PDF_SCRIPT,
    'docs/decisions/figure-selection.md': '正文图：图1\n',
    'project.json': JSON.stringify({ name: '无图映射', schemaVersion: 2 }),
  });
  const { wb, ledger } = benchFor(root);
  wb.openProject(root);
  const started = wb.runStage('manuscript', { force: true });
  const settled = await waitRun(ledger, started.run && started.run.id);
  const run = (ledger.runs || []).find((item) => item.id === (started.run || {}).id);
  const pdfStep = (run && run.steps ? run.steps : []).find((step) => step.script === 'scripts/export_pdf_hires.py');
  await checkAsync('执行时缺 figure_map → 该步如实标 skipped', () => {
    assert.ok(pdfStep, JSON.stringify(run && run.steps));
    assert.equal(pdfStep.status, 'skipped', JSON.stringify(pdfStep));
  });
  await checkAsync('其余步骤跑完，整体仍是 ok', () => assert.ok(settled && settled.status === 'ok', settled && settled.status));
})();

/* ═════════════ 六、纯表格语料：编码阶段「不适用」 ═════════════ */

section('六、纯表格语料不再拿编码表卡死');
function tableAuditSeed() {
  return {
    'output/audit/corpus_files.csv': 'rel_path,relpath,top,name,ext,kind,bytes,status\r\nsurvey.csv,survey.csv,,survey.csv,.csv,text,120,valid\r\n',
    'output/audit/corpus_summary.json': JSON.stringify({ total_files: 1, valid_files: 1, corpus_fingerprint: { files: 1, bytes: 120 } }),
  };
}

check('审计里全是表格 → coding-applicable=na，编码表不再报缺', () => {
  const root = makeProject(tableAuditSeed());
  const { byId } = judge(root);
  const applicable = byId('coding-applicable');
  assert.equal(applicable.status, 'na', applicable.detail);
  assert.match(applicable.detail, /表格/);
  assert.equal(byId('coding-sheet'), undefined, '不适用时不该再要求 coding_sheet.csv');
});

check('全是表格 → 编码阶段状态是 na（既不是 todo 也不是 blocked）', () => {
  const root = makeProject(tableAuditSeed());
  const { stageById, stages } = judge(root);
  const stage = stageById('coding');
  // 审计账本身就是「干过活」的证据：阶段不该停在 todo。
  assert.equal(stage.status, 'na', stage.gates.map((g) => `${g.id}:${g.status}`).join(','));
  const totals = gateTotals(stages);
  assert.equal(totals.na, 1, `na 应当计数（得到 ${JSON.stringify(totals)}）`);
});

check('混有文本资料（PDF）→ 仍然要求编码表（不能拿「也是表格」当借口）', () => {
  const root = makeProject({
    'output/audit/corpus_files.csv': 'rel_path,relpath,top,name,ext,kind,bytes,status\r\nsurvey.csv,survey.csv,,survey.csv,.csv,text,120,valid\r\na.pdf,a.pdf,,a.pdf,.pdf,pdf,900,valid\r\n',
  });
  const { byId } = judge(root);
  assert.equal(byId('coding-applicable').status, 'pass');
  assert.equal(byId('coding-sheet').status, 'fail');
});

check('项目登记 not_applicable 但与资料形态不符 → unjudged（登记不能绕过闸门）', () => {
  const root = makeProject({
    'output/audit/corpus_files.csv': 'rel_path,relpath,top,name,ext,kind,bytes,status\r\na.pdf,a.pdf,,a.pdf,.pdf,pdf,900,valid\r\n',
  });
  const { byId } = judge(root, { project: { stages: { coding: { applicability: 'not_applicable' } } } });
  const gate = byId('coding-applicable');
  assert.equal(gate.status, 'unjudged', gate.detail);
  assert.match(gate.detail, /与资料形态不符/);
});

check('项目登记 required → 即使全是表格也要编码', () => {
  const root = makeProject(tableAuditSeed());
  const { byId } = judge(root, { project: { stages: { coding: { applicability: 'required' } } } });
  assert.equal(byId('coding-applicable').status, 'pass');
  assert.equal(byId('coding-sheet').status, 'fail');
});

/* ═════════════ 七、新项目默认严格契约 ═════════════ */

section('七、新项目严格契约 / 老项目 legacy');
check('新项目（schemaVersion=2）缺 research_registry.json → registry-present fail(error)', () => {
  const root = makeProject({ 'project.json': JSON.stringify({ name: '新', schemaVersion: 2 }) });
  const { byId } = judge(root, { project: { schemaVersion: 2 } });
  const gate = byId('registry-present');
  assert.equal(gate.status, 'fail', gate.detail);
  assert.equal(gate.level, 'error');
  assert.match(gate.detail, /严格模式/);
});

check('老项目（schemaVersion=1）缺注册表 → unjudged，不拦', () => {
  const root = makeProject({});
  const { byId } = judge(root);
  assert.equal(byId('registry-present').status, 'unjudged');
});

check('contract.mode=legacy 可以显式降级（迁移前的逃生门）', () => {
  const root = makeProject({});
  const { byId } = judge(root, { project: { schemaVersion: 2, contract: { version: 2, mode: 'legacy' } } });
  assert.equal(byId('registry-present').status, 'unjudged');
});

check('严格项目有了分析宽表 → verify 阶段显形并被拦住（不能靠「没跑过」混过去）', () => {
  const root = makeProject({
    'output/dataset/analysis.csv': 'id,in_analysis\r\na,1\r\n',
    'project.json': JSON.stringify({ name: '新', schemaVersion: 2 }),
  });
  const { stageById } = judge(root, { project: { schemaVersion: 2 } });
  const verify = stageById('verify');
  assert.notEqual(verify.status, 'todo', '有宽表时不再是「未开始」');
  assert.equal(verify.status, 'blocked', verify.gates.map((g) => `${g.id}:${g.status}`).join(','));
});

/* ═════════════ 八、多数据集 ═════════════ */

section('八、多数据集：按登记验收，不只认 analysis.csv');
function multiDatasetSeed() {
  return {
    'output/datasets/person.csv': 'person_id,wave,score,in_analysis\r\np1,1,3,1\r\np1,2,,1\r\n',
    'output/datasets/court.csv': 'court_id,n_cases,in_analysis\r\nc1,12,1\r\nc2,5,0\r\n',
    'output/datasets/index.json': JSON.stringify({
      schemaVersion: 2,
      datasets: [
        {
          id: 'person_wave',
          title: '个体-波次',
          unit: 'other',
          grainKeys: ['person_id', 'wave'],
          file: 'output/datasets/person.csv',
          rows: 2,
          columns: [
            { name: 'person_id', type: 'id' },
            { name: 'wave', type: 'integer' },
            { name: 'score', type: 'number', missing: 1, missingKind: 'item' },
            { name: 'in_analysis', type: 'boolean' },
          ],
          inAnalysis: { column: 'in_analysis', rule: 'in_analysis == 1', n: 2 },
        },
        {
          id: 'court_level',
          title: '法院级',
          unit: 'court',
          grainKeys: ['court_id'],
          file: 'output/datasets/court.csv',
          rows: 2,
          columns: [
            { name: 'court_id', type: 'id' },
            { name: 'n_cases', type: 'integer' },
            { name: 'in_analysis', type: 'boolean' },
          ],
          inAnalysis: { column: 'in_analysis', rule: 'in_analysis == 1', n: 1 },
        },
      ],
    }),
  };
}

check('登记两份数据集、没有 analysis.csv → dataset-csv pass（不再报缺 analysis.csv）', () => {
  const root = makeProject(multiDatasetSeed());
  const { byId } = judge(root);
  const gate = byId('dataset-csv');
  assert.equal(gate.status, 'pass', gate.detail);
  assert.match(gate.detail, /person_wave/);
  assert.match(gate.detail, /court_level/);
});

check('多数据集时逐份核对 in_analysis 声明值与实际行数', () => {
  const seed = multiDatasetSeed();
  const index = JSON.parse(seed['output/datasets/index.json']);
  index.datasets[1].inAnalysis.n = 2; // 声明 2，实际只有 1
  seed['output/datasets/index.json'] = JSON.stringify(index);
  const root = makeProject(seed);
  const { byId } = judge(root);
  const gate = byId('dataset-in-analysis');
  assert.equal(gate.status, 'fail', gate.detail);
  assert.match(gate.detail, /声明 inAnalysis\.n=2/);
});

check('没登记 grainKeys 的宽表仍然要求来源键列', () => {
  const root = makeProject({ 'output/dataset/analysis.csv': 'a,in_analysis\r\n1,1\r\n' });
  const { byId } = judge(root);
  assert.equal(byId('dataset-key').status, 'fail');
});

check('登记了主键的数据集不再要求必须叫 rel_path/doc_id', () => {
  const root = makeProject(multiDatasetSeed());
  const { byId } = judge(root);
  const keyGate = byId('dataset-key');
  // dataset-key 只对主分析表判一次；person_wave 有 grainKeys，所以不该出现 claim 错误
  assert.ok(!keyGate || keyGate.status === 'pass' || keyGate.source !== 'output/datasets/person.csv', keyGate?.detail || '');
});

check('stats/figures 没 analysis.csv 时用登记的第一份数据集当主表', () => {
  const root = makeProject(multiDatasetSeed());
  const { wb } = benchFor(root);
  wb.openProject(root);
  const stage = wb.stageById('stats');
  const command = wb.commandFor(root, wb.active().project, stage);
  assert.equal(command.ok, true, command.error);
  const argv = command.steps[0].argv;
  const at = argv.indexOf('--data');
  assert.ok(at >= 0, argv.join(' '));
  assert.equal(argv[at + 1], 'output/datasets/person.csv', argv.join(' '));
});

check('注册表 path 优先于另一张 analysis.csv', () => {
  const seed = multiDatasetSeed();
  seed['research_registry.json'] = JSON.stringify({
    datasets: [{ id: 'court_level', path: 'output/datasets/court.csv', key: ['court_id'] }],
  });
  seed['output/dataset/analysis.csv'] = 'id,in_analysis\r\na,1\r\n';
  const root = makeProject(seed);
  const { wb } = benchFor(root);
  wb.openProject(root);
  const command = wb.commandFor(root, wb.active().project, wb.stageById('stats'));
  assert.equal(command.ok, true, command.error);
  const argv = command.steps[0].argv;
  const at = argv.indexOf('--data');
  assert.equal(argv[at + 1], 'output/datasets/court.csv', argv.join(' '));
});

/* ═════════════ 九、research_registry.json 桥接 ═════════════ */

section('九、skill 的 research_registry.json 直接当数据集视图用');
check('只有 research_registry.json 时 datasets-index 也能 pass（并标出来源）', () => {
  const root = makeProject({
    'research_registry.json': JSON.stringify({
      schema_version: 1,
      source_root: 'data',
      datasets: [
        {
          id: 'interview',
          path: 'data/interview.csv',
          key: ['pid'],
          unit: '一位受访者',
          codebook: 'docs/interview_codebook.md',
          provenance: 'data/interview_provenance.jsonl',
          review: 'data/interview_review.jsonl',
        },
      ],
    }),
    'data/interview.csv': 'pid,score\r\np1,3\r\np2,4\r\n',
  });
  const { byId } = judge(root);
  const gate = byId('datasets-index');
  assert.equal(gate.status, 'pass', gate.detail);
  assert.match(gate.detail, /research_registry\.json/);
  assert.match(gate.detail, /interview 2 行/);
});

check('桥接时文件缺失 → datasets-index fail（桥接不是免检）', () => {
  const root = makeProject({
    'research_registry.json': JSON.stringify({
      datasets: [{ id: 'interview', path: 'data/missing.csv', key: ['pid'] }],
    }),
  });
  const { byId } = judge(root);
  // 注册表明明登记了、只是文件不在：要说「登记错了」，不能退回「你还没登记」的 unjudged。
  const gate = byId('datasets-index');
  assert.equal(gate.status, 'fail', gate.detail);
  assert.match(gate.detail, /不存在|读不出来/);
});

/* ═════════════ 十、图表清单合并 ═════════════ */

section('十、两套图表清单都在时合并检查视图');
check('chart_pack 与 figures 两套清单里的图都进入检查视图', () => {
  const root = makeProject({
    'output/chart_pack/chart_manifest.csv': 'id,png,n,status,palette\r\nF01,figures/f01.png,100,ok,"#111111|#eeeeee"\r\n',
    'output/chart_pack/figures/f01.png': 'x',
    'output/figures/paper_figures_manifest.csv': 'id,png,n,status,palette\r\nP01,p01.png,120,ok,"#111111|#eeeeee"\r\n',
    'output/figures/p01.png': 'x',
  });
  const artifacts = scanArtifacts(root);
  const ids = artifacts.figures.rows.map((row) => row.id).sort();
  assert.deepEqual(ids, ['F01', 'P01'], JSON.stringify(ids));
  assert.equal(artifacts.figures.manifests.length, 2, JSON.stringify(artifacts.figures.manifests));
});

check('同一张 png 在两份清单里出现时只算一条检查记录（以较新的清单为准）', () => {
  const root = makeProject({
    'output/chart_pack/chart_manifest.csv': 'id,png,n,status\r\nF01,figures/f01.png,100,ok\r\n',
    'output/chart_pack/figures/f01.png': 'x',
    'output/figures/paper_figures_manifest.csv': 'id,png,n,status\r\nP01,../chart_pack/figures/f01.png,120,ok\r\n',
  });
  const artifacts = scanArtifacts(root);
  // 两条清单写的相对路径不同（figures/f01.png vs ../chart_pack/figures/f01.png），
  // 合并键按解析后的**绝对路径**归一，同一张图只进一次检查视图。
  assert.equal(artifacts.figures.rows.length, 1, JSON.stringify(artifacts.figures.rows.map((row) => row.id)));
  assert.equal(artifacts.figures.manifests.length, 2);
});

/* ═════════════ 十一、复核汇总三态 ═════════════ */

section('十一、复核汇总不把 unjudged 洗成 pass');
const MANY_UNJUDGED_SEED = () => {
  // 一个几乎没有证据的合成项目：11 项复算里大部分判不了。
  const seed = {};
  for (let i = 0; i < 12; i += 1) seed[`docs/note${i}.md`] = '# x\n';
  seed['output/recheck/report.md'] = '# 复核\n';
  seed['output/recheck/issues.jsonl'] = '';
  seed['output/recheck/coverage.json'] = JSON.stringify({
    R1: { status: 'checked', note: '看了' },
    R2: { status: 'checked', note: '看了' },
    R3: { status: 'checked', note: '看了' },
    R4: { status: 'checked', note: '看了' },
    R5: { status: 'checked', note: '看了' },
    R6: { status: 'checked', note: '看了' },
    R7: { status: 'checked', note: '看了' },
    R8: { status: 'checked', note: '看了' },
    R9: { status: 'checked', note: '看了' },
    R10: { status: 'checked', note: '看了' },
    R11: { status: 'checked', note: '看了' },
    R12: { status: 'checked', note: '看了' },
  });
  return seed;
};

check('10 项判不了 + 全覆盖表 → recheck-machine 是 unjudged（不是 pass）', () => {
  const root = makeProject(MANY_UNJUDGED_SEED());
  const { byId } = judge(root);
  const gate = byId('recheck-machine');
  assert.ok(gate, '应当有 recheck-machine 闸门');
  assert.equal(gate.status, 'unjudged', gate.detail);
  assert.match(gate.detail, /判不了不等于通过/);
});

check('覆盖表全写 checked 也不能把机器判不了的项洗成 pass（R12 判 unjudged）', () => {
  const root = makeProject(MANY_UNJUDGED_SEED());
  const { byId } = judge(root);
  const gate = byId('recheck-coverage') || byId('recheck-machine');
  assert.ok(gate, '应当有复核相关闸门');
  assert.notEqual(gate.status, 'pass', gate.detail);
});

check('复核阶段整段不会变成 done', () => {
  const root = makeProject(MANY_UNJUDGED_SEED());
  const { stageById } = judge(root);
  const stage = stageById('recheck');
  assert.notEqual(stage.status, 'done', `阶段状态 ${stage.status}`);
  assert.ok(['review', 'blocked'].includes(stage.status), `阶段状态 ${stage.status}`);
});

/* ═════════════ 十二、重跑链的失效范围与等待点 ═════════════ */

section('十二、重跑链按依赖算失效范围，人工阶段变等待点');
check('改 data/ 下原件 → 从审计重来（旧实现从统计开始）', () => {
  const root = makeProject({});
  const { wb } = benchFor(root);
  wb.openProject(root);
  assert.deepEqual(wb.downstreamStages('data/安徽/a.pdf'), ['audit', 'coding', 'dataset', 'verify', 'stats', 'figures', 'manuscript', 'qa']);
});

check('改 research_registry.json → 复核先作废', () => {
  const root = makeProject({});
  const { wb } = benchFor(root);
  wb.openProject(root);
  const steps = wb.downstreamStages('research_registry.json');
  assert.equal(steps[0], 'verify', steps.join(','));
});

check('改 output/datasets/ 下数据 → 复核先作废', () => {
  const root = makeProject({});
  const { wb } = benchFor(root);
  wb.openProject(root);
  assert.equal(wb.downstreamStages('output/datasets/person.csv')[0], 'verify');
});

check('改判断台账 → 从编码重来（它改变哪些行算样本）', () => {
  const root = makeProject({});
  const { wb } = benchFor(root);
  wb.openProject(root);
  assert.equal(wb.downstreamStages('decisions.jsonl')[0], 'coding');
});

check('改模型产物 → 不重跑统计（否则会把修好的系数表覆盖回去）', () => {
  const root = makeProject({});
  const { wb } = benchFor(root);
  wb.openProject(root);
  const steps = wb.downstreamStages('output/models/coef_m1.csv');
  assert.deepEqual(steps, ['figures', 'manuscript', 'qa'], steps.join(','));
});

check('dataset / recheck 阶段是人工步骤：没有可执行脚本', () => {
  const root = makeProject({});
  const { wb } = benchFor(root);
  wb.openProject(root);
  assert.equal(wb.stageRunnable('dataset'), false);
  assert.equal(wb.stageRunnable('recheck'), false);
});

check('重跑链停在人工步骤时是 waiting，而不是「跑完了」', () => {
  const root = makeProject({
    'output/dataset/analysis.csv': 'id,in_analysis,rel_path\r\na,1,x\r\n',
    'project.json': JSON.stringify({ name: '链', schemaVersion: 2 }),
  });
  const { wb } = benchFor(root);
  const active = wb.active();
  wb.openProject(root);
  wb.startChain(active.id, ['dataset'], 'RC-001');
  const chain = wb.chainStatus();
  assert.ok(chain, '应当有重跑链');
  assert.equal(chain.status, 'waiting', JSON.stringify(chain));
  assert.equal(chain.waitingFor, 'dataset');
  assert.match(String(chain.error || ''), /research_registry\.json/);
});

check('前置闸门没过时续跑先停在 waiting，force 才跳过', () => {
  const root = makeProject({ 'project.json': JSON.stringify({ name: '链', schemaVersion: 2 }) });
  const { wb } = benchFor(root);
  const active = wb.active();
  wb.openProject(root);
  wb.startChain(active.id, ['stats'], 'RC-002');
  const chain = wb.chainStatus();
  // stats 有脚本但前置闸门没过 → 停在 waiting 并带 blockers，不是直接 force 冲过去
  assert.ok(chain, '应当有重跑链');
  assert.equal(chain.status, 'waiting', JSON.stringify(chain));
  assert.ok(Array.isArray(chain.blockers), JSON.stringify(chain.blockers));
});

/* ═════════════ 十三、复核/审计新鲜度的「空证据」边界 ═════════════ */

section('十三、空证据不冒充「一致」');
check('审计账里一份能核内容的文件都没有 → audit-freshness unjudged', () => {
  const root = makeProject({
    'output/audit/corpus_files.csv': 'rel_path,relpath,top,name,ext,kind,bytes,status,md5\r\nmeta.txt,meta.txt,,meta.txt,.txt,text,10,metadata,\r\n',
    'output/audit/corpus_summary.json': JSON.stringify({ total_files: 1, valid_files: 0, corpus_fingerprint: { files: 1, bytes: 10 } }),
    'data/meta.txt': 'x'.repeat(10),
  });
  const { byId } = judge(root);
  const gate = byId('audit-freshness');
  assert.equal(gate.status, 'unjudged', gate.detail);
  assert.match(gate.detail, /没有一份能核内容/);
});

check('verify 报告的 bindings 为空 → verification-fresh unjudged（不是 pass）', () => {
  const root = makeProject({
    'output/data_verification/verification_snapshot.json': JSON.stringify({ created_at: '2026-11-13T00:00:00Z', fingerprint: {}, bindings: {}, cells: 0 }),
    'output/data_verification/dataset_verification.json': JSON.stringify({ stage: 'final', status: 'verified', error_count: 0, fingerprint: {}, snapshot_path: 'output/data_verification/verification_snapshot.json' }),
    'output/data_verification/cell_issues.csv': 'where,severity,detail\r\n',
  });
  const { byId } = judge(root);
  const gate = byId('verification-fresh');
  assert.equal(gate.status, 'unjudged', gate.detail);
});

/* ═════════════ 收尾 ═════════════ */
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
console.log(`✓ 2026-11-13 缺陷回归全部通过（${passed} 条）`);
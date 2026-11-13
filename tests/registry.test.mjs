/**
 * v2 契约层测试：schema 校验、注册表读写、引用解析、断言、旧产物采纳、闸门联动。
 *
 * 这里最要紧的两件事：
 *   1. 「读不懂」不许当「空表」——解析失败必须变成 issue，闸门据此 fail。
 *   2. 「采纳」只是推断——条目要带 inferred / confirmed=false，人确认前后语义不同。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { adoptLegacy } from '../src/adopt.js';
import { scanArtifacts } from '../src/audit.js';
import { evaluateProject } from '../src/gates.js';
import {
  addClaim,
  confirmRow,
  evaluateAssert,
  normalizeArtifact,
  normalizeClaim,
  normalizeDataset,
  normalizeModel,
  readRegistry,
  REGISTRY_FILES,
  resolveRef,
  summarizeRegistry,
  upsert,
  validateArtifact,
  validateClaim,
  validateDataset,
  validateModel,
  writeRegistry,
} from '../src/registry.js';

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

const roots = [];
function makeProject(seed = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-reg-'));
  roots.push(root);
  for (const dir of ['data', 'docs', 'output', 'scripts', 'runs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

/* ------------------------------ schema ------------------------------ */

check('数据集：缺 file 报错、缺 title 只提醒', () => {
  const bad = validateDataset(normalizeDataset({ id: 'd1' }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((item) => item.code === 'dataset.file'));
  assert.ok(bad.warnings.some((item) => item.code === 'dataset.title'));
});

check('数据集：id 格式非法被拒', () => {
  const result = validateDataset(normalizeDataset({ id: '有中文', file: 'a.csv' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'dataset.id.format'));
});

check('数据集：主键不在列定义里只提醒', () => {
  const result = validateDataset(
    normalizeDataset({
      id: 'd1',
      file: 'a.csv',
      rows: 10,
      grainKeys: ['doc_id'],
      columns: [{ name: 'x', type: 'number' }],
    }),
  );
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((item) => item.code === 'dataset.grain'));
});

check('模型：缺 estimator 报错；dropReasons 加总不符只提醒', () => {
  const missing = validateModel(normalizeModel({ id: 'M1', outcome: 'y' }));
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((item) => item.code === 'model.estimator'));

  const sum = validateModel(
    normalizeModel({ id: 'M1', estimator: 'ols', outcome: 'y', n: 100, dropped: 5, dropReasons: { missing: 3 } }),
  );
  assert.equal(sum.ok, true);
  assert.ok(sum.warnings.some((item) => item.code === 'model.dropReasons.sum'));
});

check('产物：图没有 title 只是 warn；超宽表没有展示列只是 warn', () => {
  const figure = validateArtifact(normalizeArtifact({ id: 'fig:1', kind: 'figure', path: 'a.png' }));
  assert.equal(figure.ok, true);
  assert.ok(figure.warnings.some((item) => item.code === 'artifact.title'));

  const table = validateArtifact(normalizeArtifact({ id: 'tbl:1', kind: 'table', path: 'a.csv', cols: 21 }));
  assert.equal(table.ok, true);
  assert.ok(table.warnings.some((item) => item.code === 'artifact.table.width'));

  const presented = validateArtifact(
    normalizeArtifact({ id: 'tbl:1', kind: 'table', path: 'a.csv', cols: 21, presentation: { columns: ['a', 'b'] } }),
  );
  assert.equal(presented.warnings.some((item) => item.code === 'artifact.table.width'), false);
});

check('结论：不支持的比较报错；没有 assert 只提醒', () => {
  const bad = validateClaim(normalizeClaim({ id: 'C1', text: 'x', assert: { op: 'regex', left: 1, right: 2 } }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((item) => item.code === 'claim.assert.op'));

  const soft = validateClaim(normalizeClaim({ id: 'C2', text: 'x' }));
  assert.equal(soft.ok, true);
  assert.ok(soft.warnings.some((item) => item.code === 'claim.assert'));
});

/* ------------------------------ 读写 ------------------------------ */

check('没有注册表时 legacy=true，不是「空表」', () => {
  const root = makeProject();
  const registry = readRegistry(root);
  assert.equal(registry.legacy, true);
  assert.equal(registry.datasets.exists, false);
  const summary = summarizeRegistry(registry, root);
  assert.equal(summary.legacy, true);
  assert.ok(summary.hints.length >= 1);
});

check('注册表解析失败 → issue，且 legacy=false', () => {
  const root = makeProject({ [REGISTRY_FILES.datasets]: '{ 坏 JSON' });
  const registry = readRegistry(root);
  assert.equal(registry.datasets.error.length > 0, true);
  assert.equal(registry.legacy, false);
  const summary = summarizeRegistry(registry, root);
  assert.ok(summary.counts.errors >= 1);
});

check('写入-读回-确认-删除的闭环', () => {
  const root = makeProject();
  const saved = upsert(root, 'datasets', { id: 'case_level', file: 'output/datasets/case_level.csv', rows: 3, title: '案例级' });
  assert.equal(saved.ok, true);
  assert.equal(fs.existsSync(path.join(root, REGISTRY_FILES.datasets)), true);

  let registry = readRegistry(root);
  assert.equal(registry.datasets.rows.length, 1);
  assert.equal(registry.datasets.rows[0].confirmedByHuman, false);

  const confirmed = confirmRow(root, 'datasets', 'case_level');
  assert.equal(confirmed.ok, true);
  registry = readRegistry(root);
  assert.equal(registry.datasets.rows[0].confirmedByHuman, true);

  const bad = upsert(root, 'datasets', { id: 'bad id', file: 'x.csv' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 1);
});

check('结论按 jsonl 追加；同 id 覆盖', () => {
  const root = makeProject();
  assert.equal(addClaim(root, { id: 'C1', text: '第一版' }).ok, true);
  assert.equal(addClaim(root, { id: 'C1', text: '第二版' }).ok, true);
  assert.equal(addClaim(root, { id: 'C2', text: '另一条' }).ok, true);
  const registry = readRegistry(root);
  assert.equal(registry.claims.rows.length, 2);
  assert.equal(registry.claims.rows.find((item) => item.id === 'C1').text, '第二版');
});

/* ---------------------------- 引用与断言 ---------------------------- */

function seedRegistry(root) {
  writeRegistry(root, 'datasets', [
    {
      id: 'analysis',
      title: '分析宽表',
      unit: 'defendant',
      file: 'output/dataset/analysis.csv',
      rows: 3,
      columns: [{ name: 'year', type: 'number' }, { name: 'prison_months', type: 'number' }],
      inAnalysis: { column: 'in_analysis', rule: 'in_analysis == 1', n: 3 },
    },
  ]);
  writeRegistry(root, 'models', [
    { id: 'M1', estimator: 'ols', family: 'gaussian', outcome: 'prison_months', dataset: 'analysis', n: 3, terms: ['x'], coef: 'output/models/coef_M1.csv' },
  ]);
  writeRegistry(root, 'artifacts', [
    { id: 'fig:1', kind: 'figure', path: 'output/chart_pack/figures/fig01.png', title: '年度分布', n: 3 },
    { id: 'tbl:1', kind: 'table', path: 'output/models/coef_all.csv', rows: 2, cols: 4 },
  ]);
  fs.mkdirSync(path.join(root, 'output/dataset'), { recursive: true });
  fs.mkdirSync(path.join(root, 'output/models'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'output/dataset/analysis.csv'),
    'id,year,prison_months,in_analysis\n1,2022,12,1\n2,2024,6,1\n3,2024,9,0\n',
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'output/models/coef_M1.csv'), 'term,beta,se,p\nconst,30,2,0\nx,15.38,3,0.0147\n', 'utf8');
  return readRegistry(root);
}

check('引用解析：模型 / 系数 / 数据集 / 条件计数 / 图', () => {
  const root = makeProject();
  const registry = seedRegistry(root);
  const options = { projectRoot: root };
  assert.equal(resolveRef(registry, 'M1.n', options).value, 3);
  assert.equal(resolveRef(registry, 'M1.coef.x.beta', options).value, 15.38);
  assert.equal(resolveRef(registry, 'M1.coef.x.p', options).value, 0.0147);
  assert.equal(resolveRef(registry, 'dataset:analysis.rows', options).value, 3);
  assert.equal(resolveRef(registry, 'dataset:analysis.inAnalysis.n', options).value, 3);
  assert.equal(resolveRef(registry, 'dataset:analysis.count[year=2024]', options).value, 2);
  assert.equal(resolveRef(registry, 'fig:1.n', options).value, 3);
  assert.equal(resolveRef(registry, 'tbl:1.cols', options).value, 4);
  assert.equal(resolveRef(registry, 'M9.n', options).ok, false);
  assert.equal(resolveRef(registry, 'M1.coef.nope.beta', options).ok, false);
});

check('断言：比较/区间/读不出来', () => {
  const root = makeProject();
  const registry = seedRegistry(root);
  const options = { projectRoot: root };
  assert.equal(evaluateAssert({ op: 'gt', left: 'M1.coef.x.beta', right: 0 }, registry, options).pass, true);
  assert.equal(evaluateAssert({ op: 'lt', left: 'dataset:analysis.count[year=2024]', right: 'dataset:analysis.count[year=2022]' }, registry, options).pass, false);
  assert.equal(evaluateAssert({ op: 'in_range', left: 5, right: 0, from: 1, to: 10 }, registry, options).pass, true);
  assert.equal(evaluateAssert({ op: 'eq', left: 'NOPE', right: 1 }, registry, options).ok, false);
  assert.equal(evaluateAssert({ op: 'wat', left: 1, right: 2 }, registry, options).ok, false);
});

/* ------------------------------ 采纳 ------------------------------ */

function seedLegacyProject() {
  const project = makeProject({
    'project.json': JSON.stringify({ name: '旧项目', root: '' }),
    'model_spec.json': JSON.stringify({
      models: [
        { id: 'M1', type: 'ols', outcome: 'prison_months', predictors: ['x'], cluster: 'court', cov: 'HC1' },
        { id: 'M2', type: 'logit', outcome: 'suspended', predictors: ['x'] },
      ],
    }),
    'output/dataset/analysis.csv': 'id,year,prison_months,suspended,in_analysis,raw_item,rel_path\n'
      + '1,2022,12,1,1,"判处有期徒刑一年","a.pdf"\n2,2024,6,0,1,"判处罚金","b.pdf"\n',
    'output/models/coef_M1.csv': 'term,beta,se,p,n\nx,1.5,0.4,0.01,2\n',
    'output/models/coef_M2.csv': 'term,beta,se,p,n\nx,0.7,0.2,0.02,2\n',
    'output/models/coef_all.csv': 'model,term,beta,n\nM1,x,1.5,2\nM2,x,0.7,2\n',
    'output/models/fit.csv': 'model,n,n_dropna\nM1,2,0\nM2,2,0\n',
    'output/chart_pack/chart_manifest.csv': 'id,section,caption,png,n,status\nF01,A,注：N=2；年度分布,figures/f01.png,2,ok\n',
    'manuscript.json': JSON.stringify({
      blocks: [
        { type: 'heading', text: '一、结果' },
        { type: 'para', text: '图 1 显示年度分布。' },
        { type: 'figure', png: 'output/chart_pack/figures/f01.png', caption: '注：N=2；年度分布' },
        { type: 'table', csv: 'output/models/coef_all.csv', caption: '表 1 系数' },
      ],
    }),
    'output/manuscript.docx': 'PK',
  });
  return project;
}

check('采纳：跳过 coef_all 汇总表；图按手稿顺序编号；缺题注被记下', () => {
  const root = seedLegacyProject();
  const result = adoptLegacy(root, { overwrite: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.counts.datasets, 1);
  assert.equal(result.counts.models, 2, `模型数应为 2（跳过 coef_all），实际 ${result.counts.models}`);
  assert.equal(result.counts.artifacts, 3); // fig:1 + tbl:1 + doc:main

  const registry = readRegistry(root);
  const fig = registry.artifacts.rows.find((item) => item.id === 'fig:1');
  assert.equal(fig.title, '', '只有「注：」的题注不该被当成标题');
  assert.equal(fig.note.startsWith('注：'), true);
  assert.equal(fig.confidence, 'inferred');
  assert.equal(registry.models.rows.find((item) => item.id === 'M1').estimator, 'ols');
  assert.equal(registry.models.rows.find((item) => item.id === 'M2').estimator, 'logit');
});

check('采纳：已有注册表时拒绝覆盖，除非 overwrite', () => {
  const root = seedLegacyProject();
  assert.equal(adoptLegacy(root, {}).ok, true);
  const again = adoptLegacy(root, {});
  assert.equal(again.ok, false);
  assert.match(again.error, /已经|覆盖/);
  assert.equal(adoptLegacy(root, { overwrite: true }).ok, true);
});

check('采纳：没有任何产物时说清楚，而不是生成空表', () => {
  const root = makeProject();
  const result = adoptLegacy(root, { overwrite: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /没找到/);
});

/* ---------------------------- 闸门联动 ---------------------------- */

function gatesFor(root, projectExtra = {}) {
  const artifacts = scanArtifacts(root);
  artifacts.registry = readRegistry(root);
  const project = {
    id: 'p1',
    name: '契约测试',
    stages: {},
    materials: { version: 1, mounts: [] },
    ...projectExtra,
  };
  return evaluateProject({ projectRoot: root, project, artifacts, adjudications: {}, activeRuns: {}, runs: [], sources: [] });
}

const gateOf = (stages, stageId, gateId) => {
  const stage = stages.find((item) => item.id === stageId);
  return stage ? stage.gates.find((item) => item.id === gateId) : null;
};

check('闸门：有注册表时 datasets-index pass；声明与实物不一致 fail', () => {
  const root = seedLegacyProject();
  adoptLegacy(root, { overwrite: true });
  let stages = gatesFor(root);
  assert.equal(gateOf(stages, 'dataset', 'datasets-index').status, 'pass');

  // 把声明的行数改错：这是「注册表说 99 行、实际 2 行」
  const registry = readRegistry(root);
  registry.datasets.rows[0].rows = 99;
  writeRegistry(root, 'datasets', registry.datasets.rows);
  stages = gatesFor(root);
  const gateItem = gateOf(stages, 'dataset', 'datasets-index');
  assert.equal(gateItem.status, 'fail');
  assert.match(gateItem.detail, /声明|实际/);
});

check('闸门：没有注册表时 v2 闸门全部 unjudged（老项目不回归）', () => {
  const root = makeProject();
  const stages = gatesFor(root);
  for (const [stageId, gateId] of [
    ['dataset', 'datasets-index'],
    ['stats', 'models-index'],
    ['stats', 'models-sweep'],
    ['figures', 'fig-title'],
    ['manuscript', 'fig-cited'],
    ['manuscript', 'tbl-present'],
    ['manuscript', 'manuscript-body'],
    ['qa', 'provenance-cells'],
    ['qa', 'provenance-claims'],
    ['qa', 'artifacts-declared'],
  ]) {
    const item = gateOf(stages, stageId, gateId);
    assert.ok(item, `${stageId}.${gateId} 不存在`);
    assert.equal(item.status, 'unjudged', `${stageId}.${gateId} 应为 unjudged，实际 ${item.status}`);
  }
});

check('闸门：图题缺失 / 图未被引用 / 原表直贴 / 正文太薄都被抓出来', () => {
  const root = seedLegacyProject();
  adoptLegacy(root, { overwrite: true });
  const stages = gatesFor(root);

  const title = gateOf(stages, 'figures', 'fig-title');
  assert.equal(title.status, 'unjudged');
  assert.match(title.detail, /1\/1/);

  const cited = gateOf(stages, 'manuscript', 'fig-cited');
  assert.equal(cited.status, 'pass', '正文里写了「图 1」，应判 pass');

  // 把正文里的引用删掉 → 必须变 unjudged
  fs.writeFileSync(path.join(root, 'manuscript.json'), JSON.stringify({
    blocks: [
      { type: 'para', text: '没有引用任何图。' },
      { type: 'figure', png: 'output/chart_pack/figures/f01.png', caption: '注：N=2' },
      { type: 'table', csv: 'output/models/coef_all.csv', caption: '表 1' },
    ],
  }));
  const stages2 = gatesFor(root);
  assert.equal(gateOf(stages2, 'manuscript', 'fig-cited').status, 'unjudged');
  assert.match(gateOf(stages2, 'manuscript', 'fig-cited').detail, /1\/1/);
  assert.equal(gateOf(stages2, 'manuscript', 'manuscript-body').status, 'unjudged');
});

check('闸门：结论假被机检抓住（2024 比 2022 少 → fail）', () => {
  const root = makeProject();
  seedRegistry(root);
  fs.mkdirSync(path.join(root, 'output/claims'), { recursive: true });
  addClaim(root, {
    id: 'C1',
    text: '2024 年比 2022 年少',
    assert: { op: 'lt', left: 'dataset:analysis.count[year=2024]', right: 'dataset:analysis.count[year=2022]' },
    evidence: ['dataset:analysis'],
  });
  const stages = gatesFor(root);
  const gateItem = gateOf(stages, 'qa', 'provenance-claims');
  assert.equal(gateItem.status, 'fail');
  assert.match(gateItem.detail, /矛盾|C1/);
});

check('闸门：结论真 → pass；没有 assert → unjudged', () => {
  const root = makeProject();
  seedRegistry(root);
  fs.mkdirSync(path.join(root, 'output/claims'), { recursive: true });
  addClaim(root, {
    id: 'C1',
    text: '多次作案与刑期正相关',
    assert: { op: 'gt', left: 'M1.coef.x.beta', right: 0 },
    evidence: ['M1'],
  });
  assert.equal(gateOf(gatesFor(root), 'qa', 'provenance-claims').status, 'pass');

  addClaim(root, { id: 'C2', text: '这句话没有断言' });
  assert.equal(gateOf(gatesFor(root), 'qa', 'provenance-claims').status, 'unjudged');
});

check('闸门：声明了产物但没产出 → fail', () => {
  const root = makeProject();
  const stages = gatesFor(root, {
    stages: { qa: { outputs: ['output/qa/qa_report.json'] } },
  });
  const gateItem = gateOf(stages, 'qa', 'artifacts-declared');
  assert.equal(gateItem.status, 'fail');
  assert.match(gateItem.detail, /qa_report\.json/);
});

check('闸门：模型挂在没登记的数据集上 → fail（不是静默跳过）', () => {
  const root = makeProject();
  seedRegistry(root);
  upsert(root, 'models', { id: 'M9', estimator: 'ols', outcome: 'y', dataset: 'ghost', coef: 'output/models/coef_m1.csv', n: 10 });
  const item = gateOf(gatesFor(root), 'stats', 'models-index');
  assert.equal(item.status, 'fail', item.detail);
  assert.match(item.detail, /没登记的数据集|ghost/);
});

check('闸门：cells=0 的证据账不能判 pass', () => {
  const root = makeProject();
  seedRegistry(root);
  const dir = path.join(root, 'output/datasets/analysis');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extract.meta.json'), JSON.stringify({
    dataset: 'analysis',
    rows: 3,
    fields: [{ name: 'raw_item', cells: 0, covered: 0, noise: 0, missing: 0, unreadable: 0 }],
  }), 'utf8');
  const item = gateOf(gatesFor(root), 'qa', 'provenance-cells');
  assert.equal(item.status, 'unjudged', item.detail);
  assert.match(item.detail, /一格都没核到|引文列/);
});

check('闸门：表块指向的 CSV 不存在 → fail（不是当「已编排」）', () => {
  const root = makeProject({ 'output/chart_pack/figures/f01.png': 'x' });
  fs.writeFileSync(path.join(root, 'manuscript.json'), JSON.stringify({
    blocks: [
      { type: 'para', text: '见表 1。图 1 是分布。' },
      { type: 'figure', png: 'output/chart_pack/figures/f01.png', caption: '图题' },
      { type: 'table', csv: 'output/tables/missing.csv', caption: '表 1 描述统计' },
    ],
  }), 'utf8');
  const item = gateOf(gatesFor(root), 'manuscript', 'tbl-present');
  assert.equal(item.status, 'fail', item.detail);
  assert.match(item.detail, /CSV 读不到|missing\.csv/);
});

check('闸门：断言用 ref/value 旧写法也能算（不再静默变空操作数）', () => {
  const root = makeProject();
  seedRegistry(root);
  fs.mkdirSync(path.join(root, 'output/claims'), { recursive: true });
  const claim = normalizeClaim({ id: 'C9', text: 'N 约为 3', assert: { ref: 'dataset:analysis.rows', op: 'eq', value: 3 } });
  assert.equal(claim.assert.left, 'dataset:analysis.rows');
  assert.equal(claim.assert.right, 3);
  const check = validateClaim(claim);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  addClaim(root, { id: 'C9', text: 'N 约为 3', assert: { ref: 'dataset:analysis.rows', op: 'eq', value: 3 } });
  const item = gateOf(gatesFor(root), 'qa', 'provenance-claims');
  assert.equal(item.status, 'pass', item.detail);
});

check('闸门：in_range 缺 from/to 时是登记错误（不是「与数据矛盾」）', () => {
  const bad = validateClaim(normalizeClaim({ id: 'C1', text: 'x', assert: { op: 'in_range', left: 'M1.n' } }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((item) => item.code === 'claim.assert.range'));
});

/* ------------------------------ 清理 ------------------------------ */

for (const root of roots) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 偶尔占用：临时目录留着不影响 */
  }
}

console.log(`\n契约层：${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
}

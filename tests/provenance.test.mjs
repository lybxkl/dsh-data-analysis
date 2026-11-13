/**
 * 逐格回源测试：verify_source.py 的三种判定 + 闸门联动。
 *
 * 为什么这条必须真跑 Python：它要证明「引文真的在原文里」，
 * 而这正是人最容易糊过去的一步。用 txt 造源文件（脚本对非 PDF 直接读文本），
 * 三种情形各造一条：
 *   pass     原句逐字符在
 *   noise    中间夹了页眉/页码
 *   missing  编造的句子
 */

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanArtifacts } from '../src/audit.js';
import { DEFAULT_PYTHON } from '../src/defaults.js';
import { evaluateProject } from '../src/gates.js';
import { readRegistry, writeRegistry } from '../src/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'assets', 'verify_source.py');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-prov-'));
  roots.push(root);
  for (const dir of ['data', 'docs', 'output', 'scripts']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function runVerify(root, extraArgs = []) {
  const out = path.join(root, 'output', '.adapter', 'verify.json');
  const result = spawnSync(DEFAULT_PYTHON, [SCRIPT, '--root', root, '--out', out, ...extraArgs], {
    encoding: 'utf8',
    timeout: 120000,
  });
  const payload = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', payload, out };
}

function seedDataset(root, { quote = '判处有期徒刑三年' } = {}) {
  fs.mkdirSync(path.join(root, 'output', 'datasets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'output', 'dataset'), { recursive: true });
  // 源文件：a.txt 原句在；b.txt 把页码插进句子中间；c.txt 完全没有
  fs.writeFileSync(path.join(root, 'data', 'a.txt'), '本院认为，被告人张三犯非法捕捞水产品罪，判处有期徒刑一年，缓刑一年。', 'utf8');
  fs.writeFileSync(path.join(root, 'data', 'b.txt'), '本院认为，被告人李四犯非法捕捞水产品罪，判处有期徒刑一年，判决书2/3缓刑一年。', 'utf8');
  fs.writeFileSync(path.join(root, 'data', 'c.txt'), '这一段与案件无关。', 'utf8');

  // 第二行故意跨过页眉：逐字符找不到，去掉页码后覆盖率 100% → 应判 noise
  const rows = [
    ['1', 'a.txt', '判处有期徒刑一年'],
    ['2', 'b.txt', '判处有期徒刑一年，缓刑一年'],
    ['3', 'c.txt', quote],
  ];
  fs.writeFileSync(
    path.join(root, 'output', 'dataset', 'analysis.csv'),
    'id,rel_path,raw_item,in_analysis\n' + rows.map((row) => `${row[0]},${row[1]},"${row[2]}",1`).join('\n') + '\n',
    'utf8',
  );
  writeRegistry(root, 'datasets', [
    {
      id: 'analysis',
      title: '回源测试',
      unit: 'defendant',
      grainKeys: ['id'],
      file: 'output/dataset/analysis.csv',
      rows: rows.length,
      columns: [
        { name: 'rel_path', type: 'id' },
        { name: 'raw_item', type: 'text' },
      ],
      inAnalysis: { column: 'in_analysis', rule: 'in_analysis == 1', n: rows.length },
      provenance: {
        cells: 'output/datasets/analysis/extract.jsonl',
        derived: 'output/datasets/analysis/derivations.csv',
        sourceColumn: 'rel_path',
        quoteColumn: 'raw_item',
        sourceRoot: 'data',
      },
    },
  ]);
  return root;
}

function gatesFor(root) {
  const artifacts = scanArtifacts(root);
  artifacts.registry = readRegistry(root);
  const project = { id: 'p', name: '回源', stages: {}, materials: { version: 1, mounts: [] } };
  return evaluateProject({ projectRoot: root, project, artifacts, adjudications: {}, activeRuns: {}, runs: [], sources: [] });
}

const gateOf = (stages, stageId, gateId) => {
  const stage = stages.find((item) => item.id === stageId);
  return stage ? stage.gates.find((item) => item.id === gateId) : null;
};

/* ------------------------------ 前置：python 可用 ------------------------------ */

const probe = spawnSync(DEFAULT_PYTHON, ['-c', 'print(1)'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log(`跳过：本机没有可用的 python（${DEFAULT_PYTHON}）`);
  process.exit(0);
}

/* ------------------------------ 回源 ------------------------------ */

const root = seedDataset(makeProject());
const run = runVerify(root, ['--mode', 'build']);
check('脚本跑得通，三态各一条', () => {
  assert.equal(run.status, 0, `退出码 ${run.status}：${run.stderr.slice(-400)}`);
  assert.equal(run.payload.ok, true, run.payload.error);
  const cells = run.payload.cells;
  assert.equal(cells.pass, 1, `pass=${cells.pass}`);
  assert.equal(cells.noise, 1, `noise=${cells.noise}`);
  assert.equal(cells.missing, 1, `missing=${cells.missing}`);
});

check('台账每格带页/字符区间/原句；方法标注清楚', () => {
  const ledger = path.join(root, 'output/datasets/analysis/extract.jsonl');
  assert.equal(fs.existsSync(ledger), true);
  const lines = fs.readFileSync(ledger, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  const exact = lines.find((item) => item.row === 1);
  assert.equal(exact.status, 'pass');
  assert.equal(exact.method, 'verbatim');
  assert.equal(exact.src.page, 1);
  assert.equal(typeof exact.src.charStart, 'number');
  assert.match(exact.src.quote, /判处有期徒刑一年/);

  const noisy = lines.find((item) => item.row === 2);
  assert.equal(noisy.status, 'noise');
  assert.equal(noisy.method, 'normalized');

  const missing = lines.find((item) => item.row === 3);
  assert.equal(missing.status, 'missing');
});

check('meta 写清每个字段的覆盖率', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'output/datasets/analysis/extract.meta.json'), 'utf8'));
  assert.equal(meta.rows, 3);
  assert.equal(meta.source.quoteColumn, 'raw_item');
  const field = meta.fields.find((item) => item.name === 'raw_item');
  assert.equal(field.cells, 3);
  assert.equal(field.covered, 2);
  assert.equal(field.noise, 1);
  assert.equal(field.missing, 1);
});

check('cell_checks.csv 人可读，且带 missing 行', () => {
  const file = path.join(root, 'output/verify/cell_checks.csv');
  assert.equal(fs.existsSync(file), true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /status/);
  assert.match(text, /missing/);
  assert.match(text, /noise/);
});

/* ------------------------------ 闸门 ------------------------------ */

check('闸门：有 missing → provenance-cells fail（不许当通过）', () => {
  const item = gateOf(gatesFor(root), 'qa', 'provenance-cells');
  assert.equal(item.status, 'fail');
  assert.match(item.detail, /missing|低于 98%/);
});

check('闸门：把编造的那行删掉重跑 → pass', () => {
  const clean = seedDataset(makeProject());
  fs.writeFileSync(
    path.join(clean, 'output', 'dataset', 'analysis.csv'),
    'id,rel_path,raw_item,in_analysis\n1,a.txt,"判处有期徒刑一年",1\n2,b.txt,"判处有期徒刑一年",1\n',
    'utf8',
  );
  const registry = readRegistry(clean);
  registry.datasets.rows[0].rows = 2;
  registry.datasets.rows[0].inAnalysis.n = 2;
  writeRegistry(clean, 'datasets', registry.datasets.rows);
  const result = runVerify(clean, ['--mode', 'build']);
  assert.equal(result.status, 0, result.stderr.slice(-300));
  assert.equal(result.payload.cells.missing, 0);
  const item = gateOf(gatesFor(clean), 'qa', 'provenance-cells');
  assert.equal(item.status, 'pass', item.detail);
});

check('闸门：只回源了一部分（--limit）→ unjudged，不能算通过', () => {
  const partial = seedDataset(makeProject());
  const result = runVerify(partial, ['--mode', 'build', '--limit', '1']);
  assert.equal(result.status, 0, result.stderr.slice(-300));
  const item = gateOf(gatesFor(partial), 'qa', 'provenance-cells');
  assert.equal(item.status, 'unjudged');
  assert.match(item.detail, /部分行|1\/3/);
});

check('闸门：没有证据账 → unjudged + 指路工具', () => {
  const empty = seedDataset(makeProject());
  const item = gateOf(gatesFor(empty), 'qa', 'provenance-cells');
  assert.equal(item.status, 'unjudged');
  assert.match(item.detail, /verify_source/);
});

check('脚本：没有 datasets/index.json 时明确报错', () => {
  const bare = makeProject();
  const result = runVerify(bare);
  assert.equal(result.status, 2);
  assert.match(String(result.payload && result.payload.error), /datasets\/index\.json/);
});

/* ------------------- 容错与反例：改一个字就该红，插一段页眉不该红 ------------------- */

function seedLong(rows) {
  const dir = makeProject();
  fs.mkdirSync(path.join(dir, 'output', 'datasets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'output', 'dataset'), { recursive: true });
  // 源文件：句子里被塞进了一段「当事人名单」页眉（真实语料里常见）
  fs.writeFileSync(
    path.join(dir, 'data', 'd.txt'),
    '四、被告人胡某犯污染环境罪，判处有期徒刑五年六个月，并处罚金人民币二十万元。周维海汤某污染环境一审刑事刑期从判决执行之日起计算。判决执行以前先行羁押的，羁押一日，折抵刑期一日。即自2018年2月2日起至2023年8月1日止。',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'output', 'dataset', 'analysis.csv'),
    'id,rel_path,raw_item,in_analysis\n' + rows.map((row) => `${row[0]},d.txt,"${row[1]}",1`).join('\n') + '\n',
    'utf8',
  );
  writeRegistry(dir, 'datasets', [
    {
      id: 'long',
      title: '长句回源',
      unit: 'defendant',
      grainKeys: ['id'],
      file: 'output/dataset/analysis.csv',
      rows: rows.length,
      columns: [
        { name: 'rel_path', type: 'id' },
        { name: 'raw_item', type: 'text' },
      ],
      inAnalysis: { column: 'in_analysis', rule: 'in_analysis == 1', n: rows.length },
      provenance: {
        cells: 'output/datasets/long/extract.jsonl',
        derived: 'output/datasets/long/derivations.csv',
        sourceColumn: 'rel_path',
        quoteColumn: 'raw_item',
        sourceRoot: 'data',
      },
    },
  ]);
  return dir;
}

const GOOD = '四、被告人胡某犯污染环境罪，判处有期徒刑五年六个月，并处罚金人民币二十万元。刑期从判决执行之日起计算。';
const TAMPERED = '四、被告人胡某犯污染环境罪，判处有期徒刑五年六个月，并处罚金人民币三十万元。刑期从判决执行之日起计算。';
const EXACT = '四、被告人胡某犯污染环境罪，判处有期徒刑五年六个月，并处罚金人民币二十万元。';

const longRoot = seedLong([
  ['1', EXACT],
  ['2', TAMPERED],
  ['3', GOOD],
]);
const longRun = runVerify(longRoot, ['--mode', 'build']);

check('引文改一个数字 → missing（不靠覆盖率放过）', () => {
  assert.equal(longRun.status, 0, longRun.stderr.slice(-300));
  const ledger = fs
    .readFileSync(path.join(longRoot, 'output/datasets/long/extract.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const bad = ledger.find((item) => item.row === 2);
  assert.equal(bad.status, 'missing', `第 2 行应判 missing，实际 ${bad.status}`);
  assert.equal(longRun.payload.cells.missing, 1, JSON.stringify(longRun.payload.cells));
});

check('句子中间插进一段当事人名单 → noise（容错，不是造假）', () => {
  const ledger = fs
    .readFileSync(path.join(longRoot, 'output/datasets/long/extract.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const split = ledger.find((item) => item.row === 3);
  assert.equal(split.status, 'noise', `第 3 行应判 noise，实际 ${split.status}`);
  assert.match(split.note || '', /插进/);
});

check('引文原样照抄 → pass（带精确页与偏移）', () => {
  const ledger = fs
    .readFileSync(path.join(longRoot, 'output/datasets/long/extract.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const exact = ledger.find((item) => item.row === 1);
  assert.equal(exact.status, 'pass');
  assert.equal(exact.method, 'verbatim');
});

/* ------------------------------ 清理 ------------------------------ */

for (const dir of roots) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录留着不影响 */
  }
}

console.log(`\n逐格回源：${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
}

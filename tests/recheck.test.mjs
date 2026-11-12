// 复核闭环里最危险的一步是「把模型写的补丁落到磁盘」：这组测试只盯这件事，外加几条
// 「判不了 ≠ 通过」的复算口径（R2/R3/R5）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyPatch, runChecks } from '../src/recheck.js';

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
function project(seed = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-recheck-'));
  roots.push(root);
  for (const dir of ['data', 'output', 'scripts', 'docs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

const issue = (patch) => ({ id: 'RC-001', patch });

// ── 补丁落盘的四道关 ────────────────────────────────────────────
check('文件存在但没给 baseHash → 拒绝（不能「不管现状直接覆盖」）', () => {
  const root = project({ 'scripts/a.py': 'print(1)\n' });
  const result = applyPatch(root, issue({ path: 'scripts/a.py', content: 'print(2)\n' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /baseHash/);
  assert.equal(fs.readFileSync(path.join(root, 'scripts/a.py'), 'utf8'), 'print(1)\n', '文件不能被改');
});

check('baseHash 与当前内容不符 → 拒绝（文件在模型读它之后改过）', () => {
  const root = project({ 'scripts/a.py': 'print(1)\n' });
  const result = applyPatch(root, issue({ path: 'scripts/a.py', baseHash: 'sha256:deadbeef', content: 'print(2)\n' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /基线已变/);
});

check('baseHash 正确 → 写入、留备份、返回新哈希', () => {
  const root = project({ 'scripts/a.py': 'print(1)\n' });
  const hash = hashOf(path.join(root, 'scripts/a.py'));
  const result = applyPatch(root, issue({ path: 'scripts/a.py', baseHash: hash, content: 'print(2)\n' }));
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(path.join(root, 'scripts/a.py'), 'utf8'), 'print(2)\n');
  assert.ok(result.backup && fs.existsSync(path.join(root, result.backup)), '备份要真的落盘');
  assert.equal(fs.readFileSync(path.join(root, result.backup), 'utf8'), 'print(1)\n');
});

check('路径跳出项目（../）→ 拒绝', () => {
  const root = project();
  const result = applyPatch(root, issue({ path: `../${path.basename(root)}-escape.txt`, content: 'x' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /越界/);
});

check('绝对路径 / 目录联接落到项目外 → 拒绝（字符串前缀不够）', () => {
  const root = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-outside-'));
  roots.push(outside);
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'original', 'utf8');
  const link = path.join(root, 'data', '安徽');
  let linked = true;
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    linked = false; // Windows 需要开发者模式；建不了就跳过这一条
  }
  if (!linked) {
    console.log('  （本机建不了 junction，跳过联接越界这一条）');
    return;
  }
  const result = applyPatch(root, issue({ path: 'data/安徽/victim.txt', content: 'hacked' }));
  assert.equal(result.ok, false, '穿过联接写到项目外必须被拦住');
  assert.match(result.error, /越界/);
  assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'original');
});

check('issue.id 带 ../ 也不会把备份写到项目外', () => {
  const root = project({ 'scripts/a.py': 'print(1)\n' });
  const hash = hashOf(path.join(root, 'scripts/a.py'));
  const result = applyPatch(root, {
    id: '../../../../evil',
    patch: { path: 'scripts/a.py', baseHash: hash, content: 'print(9)\n' },
  });
  assert.equal(result.ok, true, result.error);
  const backupAbs = path.join(root, result.backup);
  assert.ok(fs.existsSync(backupAbs), '备份应当还在项目里');
  assert.ok(!result.backup.includes('..'), `备份路径不该带 ..：${result.backup}`);
});

check('新文件（目标不存在）允许创建，并标记 created', () => {
  const root = project();
  const result = applyPatch(root, issue({ path: 'docs/new.md', content: '# 新文件\n' }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.created, true);
  assert.equal(fs.readFileSync(path.join(root, 'docs/new.md'), 'utf8'), '# 新文件\n');
});

// ── 复算口径：没有可比对象时不能算通过 ──────────────────────────
const checkById = (root, id) => runChecks(root).find((item) => item.id === id);

check('R2：没有 model_spec / chart_config 时是 unjudged，不是 fail', () => {
  const root = project({
    'output/dataset/analysis.csv': 'id,in_analysis\r\na,1\r\nb,0\r\n',
  });
  const item = checkById(root, 'R2');
  assert.equal(item.status, 'unjudged', item.detail);
});

check('R2：model_spec.json 引用了 in_analysis → pass（不只看 chart_config）', () => {
  const root = project({
    'output/dataset/analysis.csv': 'id,in_analysis\r\na,1\r\nb,0\r\n',
    'model_spec.json': JSON.stringify({ filter_query: 'in_analysis == 1' }),
  });
  assert.equal(checkById(root, 'R2').status, 'pass');
});

check('R2：有配置但都没引用 → fail', () => {
  const root = project({
    'output/dataset/analysis.csv': 'id,in_analysis\r\na,1\r\nb,0\r\n',
    'chart_config.json': JSON.stringify({ charts: [] }),
  });
  const item = checkById(root, 'R2');
  assert.equal(item.status, 'fail');
  assert.match(item.detail, /吃回去|没有引用/);
});

check('R3：没有 in_analysis 时是 unjudged（不能因为「没有超标的」就算过）', () => {
  const root = project({
    'output/models/coef_m1.csv': 'term,coef\r\nx,1\r\n',
    'output/models/fit.csv': 'model,n,n_dropna\r\nm1,50,0\r\n',
    'output/dataset/analysis.csv': 'id,y\r\na,1\r\n',
  });
  const item = checkById(root, 'R3');
  assert.equal(item.status, 'unjudged', item.detail);
});

check('R5：图都是 corpus 级（没有样本级图）→ unjudged', () => {
  const root = project({
    'output/dataset/analysis.csv': 'id,in_analysis\r\na,1\r\n',
    'output/chart_pack/chart_manifest.csv': 'id,n,n_scope,caption,data_hash\nF1,100,corpus,图 1（N=100） 描述,abc\n',
  });
  const item = checkById(root, 'R5');
  assert.equal(item.status, 'unjudged', item.detail);
});

check('科学计数法的 N 不再被截成小数（1.2e3 → 1200）', () => {
  const root = project({
    'output/dataset/analysis.csv': 'id,in_analysis\r\na,1\r\n',
    'output/models/coef_m1.csv': 'term,coef\r\nx,1\r\n',
    'output/models/fit.csv': 'model,n,n_dropna\r\nm1,1.2e+03,0\r\n',
  });
  const item = checkById(root, 'R3');
  assert.equal(item.status, 'fail', item.detail);
  assert.match(item.detail, /1200/);
});

function hashOf(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

for (const root of roots) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败 / ${passed + failures.length} 条`);
  for (const line of failures) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`✓ 复核闭环全部通过（${passed} 条）`);

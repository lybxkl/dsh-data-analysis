/**
 * 全量命名源（table_map/doc_map）与目录骨架分组（layout_conformance.json）读取回归。
 * 插件只读 skill 现成产物，不内嵌别名表；缺失/非法回退不崩。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/store.js';
import { Viewer } from '../src/viewer.js';
import { WorkspaceService } from '../src/workspace.js';

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

const temps = [];
function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsa-${name}-`));
  temps.push(dir);
  return dir;
}
function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function makeViewer(root) {
  const store = new Store({ filePath: path.join(tmp('ledger'), 'data-analysis.json') }).load();
  const viewer = new Viewer({ store });
  const workspace = new WorkspaceService({ store, viewer });
  workspace.bind({ dir: root });
  return viewer;
}

/* ------------------------------ table_map / doc_map ------------------------------ */

const root = tmp('name-ws');
write(root, 'output/reports/descriptive_stats.csv', 'a\n1\n');
write(root, 'output/tables/table1.csv', 'a\n1\n');
write(root, 'output/review/review_pack.md', '# 复核包\n');
const absCsv = path.join(root, 'output', 'reports', 'descriptive_stats.csv');
const outside = path.join(tmp('name-outside'), 'evil.csv');
fs.writeFileSync(outside, 'x');
write(root, 'output/table_map.json', JSON.stringify([
  { tag: '报表', title: '描述统计', file: absCsv },
  { tag: '表9', title: '越界', file: outside },
  { tag: '表8', title: '备用表题', file: 'output/tables/table1.csv' },
]));
write(root, 'output/doc_map.json', JSON.stringify([
  { title: '复核包', file: 'output/review/review_pack.md' },
]));
write(root, 'manuscript.json', JSON.stringify({
  blocks: [
    { type: 'title', text: '某研究' },
    { type: 'table', csv: 'output/tables/table1.csv', caption: '正文表题优先' },
  ],
}));
const viewer = makeViewer(root);

check('table_map 绝对路径条目归一成工作区相对 rel', () => {
  assert.equal(viewer.titleMap()['output/reports/descriptive_stats.csv'], '报表 描述统计');
});
check('doc_map 无 tag 条目只显示标题', () => {
  assert.equal(viewer.titleMap()['output/review/review_pack.md'], '复核包');
});
check('manuscript 表题优先于 table_map 同文件条目', () => {
  assert.equal(viewer.titleMap()['output/tables/table1.csv'], '表1 正文表题优先');
});
check('越界条目被拒绝、同文件不覆盖 manuscript 表题', () => {
  const map = viewer.titleMap();
  assert.equal(Object.values(map).includes('表9 越界'), false);
  assert.equal(Object.values(map).includes('表8 备用表题'), false);
  assert.equal(map[outside], undefined);
});
check('table_map 标题进入下载名', () => {
  const dn = viewer.downloadName('output/reports/descriptive_stats.csv');
  assert.equal(dn.name, '报表 描述统计.csv');
  assert.equal(dn.ascii, 'descriptive_stats.csv');
});
check('文件树条目带 table/doc 中文标题', () => {
  const tree = viewer.artifactTree({});
  const entry = tree.entries.find((e) => e.rel === 'output/review/review_pack.md');
  assert.equal(entry.title, '复核包');
});

const badRoot = tmp('name-bad');
write(badRoot, 'output/table_map.json', '{not json');
write(badRoot, 'output/doc_map.json', '{"docs": "nope"}');
const badViewer = makeViewer(badRoot);
check('非法 table_map/doc_map 不崩、退回文件名', () => {
  assert.deepEqual(badViewer.titleMap(), {});
});

/* ------------------------------ 目录骨架分组 ------------------------------ */

const layoutRoot = tmp('layout-ws');
write(layoutRoot, 'output/analysis_pack/fit.csv', 'a\n1\n');
write(layoutRoot, 'output/qa/layout_conformance.json', JSON.stringify({
  error_count: 0,
  groups: [
    { key: 'output/stats', label: '统计', dirs: ['output/analysis_pack'] },
    { key: 'output/tables', label: '表', dirs: ['output/reports', 'output/tables'] },
  ],
  stray: ['output/custom'],
}));
const layoutViewer = makeViewer(layoutRoot);

check('layout 读取闸门分组报告（规范组+杂散）', () => {
  const layout = layoutViewer.layout();
  assert.equal(layout.ok, true);
  assert.equal(layout.groups[0].label, '统计');
  assert.deepEqual(layout.groups[0].dirs, ['output/analysis_pack']);
  assert.deepEqual(layout.stray, ['output/custom']);
});
check('snapshot 携带 layout 供侧栏渲染', () => {
  const snap = layoutViewer.snapshot();
  assert.equal(snap.layout.ok, true);
  assert.equal(snap.layout.groups.length, 2);
});
check('无分组报告的旧工作区回退（ok=false）', () => {
  assert.equal(viewer.layout().ok, false);
  assert.deepEqual(viewer.layout().groups, []);
});

const badLayoutRoot = tmp('layout-bad');
write(badLayoutRoot, 'output/qa/layout_conformance.json', '{not json');
const badLayoutViewer = makeViewer(badLayoutRoot);
check('非法分组报告不崩', () => {
  assert.equal(badLayoutViewer.layout().ok, false);
});

const dirtyLayoutRoot = tmp('layout-dirty');
write(dirtyLayoutRoot, 'output/qa/layout_conformance.json', JSON.stringify({
  groups: [
    { key: 'output/stats', label: '统计', dirs: ['output/models', {}] },
    { key: 'output/tables', label: '表', dirs: 'not-an-array' },
  ],
  stray: ['output/custom', 42],
}));
const dirtyLayoutViewer = makeViewer(dirtyLayoutRoot);
check('分组报告脏元素被过滤（dirs 非串/非数组、stray 非串）', () => {
  const layout = dirtyLayoutViewer.layout();
  assert.equal(layout.ok, true);
  assert.equal(layout.groups.length, 1);
  assert.deepEqual(layout.groups[0].dirs, ['output/models']);
  assert.deepEqual(layout.stray, ['output/custom']);
});

for (const dir of temps) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
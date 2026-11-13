/**
 * 产物中心（artifactTree / artifactResolve / artifactRead / artifactThumb）的回归。
 *
 * 这是唯一把项目文件交给面板/模型的通道：路径越界、扩展名、大小上限、
 * CSV 截断、缩略图缓存键，任何一条松了都不是「少个功能」，是能把项目外的东西读出去。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { Workbench } from '../src/service.js';
import { DEFAULT_PYTHON, normalizeConfig } from '../src/defaults.js';

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
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-art-'));
  roots.push(root);
  for (const dir of ['data', 'docs', 'output', 'output/dataset', 'output/chart_pack/figures', 'scripts']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name: '产物', root, stages: {} }, null, 2));
  fs.writeFileSync(path.join(root, 'output/dataset/analysis.csv'), 'id,x\n1,2\n2,3\n', 'utf8');
  fs.writeFileSync(path.join(root, 'output/report.html'), '<script>alert(1)</script>', 'utf8');
  fs.writeFileSync(path.join(root, 'output/notes.md'), '# 说明\n正文', 'utf8');
  fs.writeFileSync(path.join(root, 'output/chart_pack/figures/f01.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(root, 'output/big.csv'), 'a\n' + 'x\n'.repeat(5000), 'utf8');
  fs.writeFileSync(path.join(root, 'secret.csv'), 'a\n1\n', 'utf8');
  return root;
}

function open(root) {
  const store = new Store({ filePath: path.join(root, 'ledger.json') });
  store.load();
  store.set('config', normalizeConfig({ skillRoot: '', pythonPath: DEFAULT_PYTHON, dataDir: '' }));
  const runner = new Runner({ getConfig: () => store.get('config'), getLogger: () => null });
  const wb = new Workbench({ getConfig: () => store.get('config'), store, runner, onChange: () => {} });
  wb.openProject(root);
  return wb;
}

const root = makeProject();
const wb = open(root);

/* ------------------------------ 路径安全 ------------------------------ */

check('相对路径越界一律拒绝', () => {
  for (const rel of ['../secret.csv', 'output/../../secret.csv', '..\\secret.csv']) {
    const got = wb.artifactResolve(rel);
    assert.equal(got.ok, false, `${rel} 不该放行`);
    assert.match(got.error, /路径不在项目里/);
  }
});

check('绝对路径越界拒绝', () => {
  const outside = path.join(os.tmpdir(), 'dsa-outside.csv');
  fs.writeFileSync(outside, 'a\n1\n', 'utf8');
  const got = wb.artifactResolve(outside);
  assert.equal(got.ok, false);
});

check('目录不能当文件读', () => {
  const got = wb.artifactResolve('output');
  assert.equal(got.ok, false);
  assert.match(got.error, /不是文件/);
});

check('扩展名白名单：.exe / .py 之类不放行', () => {
  fs.writeFileSync(path.join(root, 'output/tool.exe'), 'MZ', 'utf8');
  const got = wb.artifactResolve('output/tool.exe');
  assert.equal(got.ok, false);
  assert.match(got.error, /不支持的扩展名/);
});

check('符号链接指向项目外时拒绝（穿联接也不行）', () => {
  const link = path.join(root, 'output/link.csv');
  const outside = path.join(os.tmpdir(), 'dsa-link-target.csv');
  fs.writeFileSync(outside, 'a\n1\n', 'utf8');
  try {
    fs.symlinkSync(outside, link, 'file');
  } catch {
    return; // 本机没权限建软链：跳过这一条
  }
  const got = wb.artifactResolve('output/link.csv');
  assert.equal(got.ok, false, '指向项目外的软链不该放行');
  assert.match(got.error, /项目外/);
});

/* ------------------------------ 读内容 ------------------------------ */

check('CSV 读成表格，超行数标 truncated', () => {
  const got = wb.artifactRead('output/big.csv', { limit: 50 });
  assert.equal(got.ok, true, got.error);
  assert.equal(got.kind, 'table');
  assert.equal(got.header[0], 'a');
  assert.equal(got.rows.length, 50);
  assert.equal(got.totalRows, 5000);
  assert.equal(got.truncated, true);
});

check('文本回原文；JSON 回格式化结果', () => {
  const md = wb.artifactRead('output/notes.md');
  assert.equal(md.kind, 'text');
  assert.match(md.text, /# 说明/);
  fs.writeFileSync(path.join(root, 'output/meta.json'), '{"a":1}', 'utf8');
  const json = wb.artifactRead('output/meta.json');
  assert.equal(json.kind, 'json');
  assert.match(json.text, /"a": 1/);
});

check('图片只回元信息，不把二进制塞进 JSON', () => {
  const got = wb.artifactRead('output/chart_pack/figures/f01.png');
  assert.equal(got.ok, true, got.error);
  assert.equal(got.kind, 'image');
  assert.equal(got.text, undefined);
});

/* ------------------------------ 文件树 ------------------------------ */

check('文件树列 output/、带 viewable/image 标记、跳过隐藏项', () => {
  fs.writeFileSync(path.join(root, 'output/.hidden'), 'x', 'utf8');
  const tree = wb.artifactTree({ limit: 200 });
  assert.equal(tree.ok, true, tree.error);
  assert.equal(tree.entries.some((item) => item.rel === 'output/dataset/analysis.csv'), true);
  assert.equal(tree.entries.some((item) => item.name === '.hidden'), false, '隐藏文件不该出现');
  const png = tree.entries.find((item) => item.rel.endsWith('f01.png'));
  assert.equal(png.image, true);
  assert.equal(png.viewable, true);
  const html = tree.entries.find((item) => item.rel === 'output/report.html');
  assert.equal(html.viewable, true, '.html 可下载，但路由会强制 attachment');
});

check('条目上限会标 truncated（数值只是下界）', () => {
  // 服务端把 limit 夹在 [20, 2000]：造 30 个文件才能真正触发截断
  const dir = path.join(root, 'output', 'many');
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 30; index += 1) {
    fs.writeFileSync(path.join(dir, `n${String(index).padStart(2, '0')}.csv`), 'a\n1\n', 'utf8');
  }
  const tree = wb.artifactTree({ limit: 20 });
  assert.equal(tree.truncated, true);
  assert.ok(tree.entries.length <= 20);
});

/* ------------------------------ 大图预览（TIFF → PNG） ------------------------------ */

// 浏览器不显示 TIFF/HEIC：大图预览必须由服务端转 PNG，且宽度上限 2400 不能被绕过
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

function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString(), 'PNG', '不是 PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const wideTiff = path.join(root, 'output/chart_pack/figures/wide.tiff');
const made = spawnSync(
  DEFAULT_PYTHON,
  ['-c', `from PIL import Image; Image.new("RGB",(3000,10),(30,40,50)).save(r"${wideTiff}","TIFF")`],
  { encoding: 'utf8' },
);
check('能造一张 3000px 宽的 TIFF（需要 Pillow）', () => {
  assert.equal(made.status, 0, made.stderr || 'python 失败');
  assert.ok(fs.existsSync(wideTiff));
});

await checkAsync('TIFF 的大图预览是 PNG，且宽度被夹到 2400', async () => {
  const got = await wb.artifactThumb('output/chart_pack/figures/wide.tiff', { width: 4000 });
  assert.equal(got.ok, true, got.error || '');
  assert.equal(path.extname(got.abs), '.png');
  assert.equal(pngSize(got.abs).width, 2400);
});

await checkAsync('同一个 TIFF 第二次取预览走缓存', async () => {
  const again = await wb.artifactThumb('output/chart_pack/figures/wide.tiff', { width: 4000 });
  assert.equal(again.ok, true, again.error || '');
  assert.equal(again.cached, true);
});

await checkAsync('非图片不给生成预览', async () => {
  const got = await wb.artifactThumb('output/dataset/analysis.csv', { width: 320 });
  assert.equal(got.ok, false);
  assert.match(got.error, /只有图片/);
});

/* ------------------------------ 清理 ------------------------------ */

for (const dir of roots) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 留临时目录不影响结果 */
  }
}

console.log(`\n产物中心：${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
}

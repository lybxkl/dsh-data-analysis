/**
 * 路径边界回归：工作区登记校验 + artifactResolve 的四道防护。
 *
 * 四道防护是查看器唯一的安全边界：词法越界、realpath 越界、扩展名白名单、32MB 上限。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/store.js';
import { Viewer } from '../src/viewer.js';
import { WorkspaceService, workspaceIdOf } from '../src/workspace.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsa-path-${name}-`));
  temps.push(dir);
  return dir;
}

function makeService() {
  const stateDir = tmp('ledger');
  const store = new Store({ filePath: path.join(stateDir, 'data-analysis.json') }).load();
  const viewer = new Viewer({ store });
  const workspace = new WorkspaceService({ store, viewer });
  return { store, viewer, workspace };
}

check('工作区 id 对大小写稳定', () => {
  const dir = tmp('IdCase').replace(/\\/g, '\\');
  assert.equal(workspaceIdOf(dir), workspaceIdOf(dir.toUpperCase()));
  assert.match(workspaceIdOf(dir), /^[0-9a-f]{12}$/);
});

check('相对路径 / 空路径 / 磁盘根一律拒绝', () => {
  const { workspace } = makeService();
  const relative = workspace.bind({ dir: 'relative\\path' });
  assert.equal(relative.ok, false);
  assert.equal(relative.code, 'ABSOLUTE_REQUIRED');
  const empty = workspace.bind({ dir: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'DIR_REQUIRED');
  const root = workspace.bind({ dir: path.parse(process.cwd()).root });
  assert.equal(root.ok, false);
  assert.equal(root.code, 'ROOT_REFUSED');
});

check('文件路径不能当工作区', () => {
  const { workspace } = makeService();
  const dir = tmp('file');
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  const got = workspace.bind({ dir: file });
  assert.equal(got.ok, false);
  assert.equal(got.code, 'NOT_DIRECTORY');
});

check('接受已有非空目录，且不写目录', () => {
  const { workspace } = makeService();
  const dir = tmp('nonempty');
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'keep');
  const got = workspace.bind({ dir });
  assert.equal(got.ok, true);
  assert.deepEqual(fs.readdirSync(dir), ['existing.txt']);
});

check('真实路径越界：目录 junction 指向工作区外', () => {
  const dir = tmp('link');
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  const outside = tmp('target');
  fs.writeFileSync(path.join(outside, 'secret.csv'), 'a\n1\n');
  const link = path.join(dir, 'output', 'escape');
  fs.symlinkSync(outside, link, 'junction');
  const { viewer, workspace } = makeService();
  assert.equal(workspace.bind({ dir }).ok, true);
  try {
    const got = viewer.artifactResolve('output/escape/secret.csv');
    assert.equal(got.ok, false);
    assert.match(got.error, /路径指向工作区外/);
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
  }
});

check('词法越界：编码后的 .. 不会绕过 resolve', () => {
  const dir = tmp('traversal');
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(dir), 'outside.csv'), 'a\n1\n');
  const { viewer, workspace } = makeService();
  assert.equal(workspace.bind({ dir }).ok, true);
  for (const rel of ['output/../' + path.basename(path.dirname(dir)) + '/outside.csv', '../outside.csv', './../outside.csv']) {
    assert.equal(viewer.artifactResolve(rel).ok, false);
  }
});

check('白名单与大小上限仍在', () => {
  const dir = tmp('limits');
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'output', 'x.bin'), 'x');
  const big = path.join(dir, 'output', 'big.txt');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 32 * 1024 * 1024 + 1);
  const { viewer, workspace } = makeService();
  assert.equal(workspace.bind({ dir }).ok, true);
  assert.match(viewer.artifactResolve('output/x.bin').error, /不支持的扩展名/);
  assert.match(viewer.artifactResolve('output/big.txt').error, /文件太大/);
});

check('目录改名/删除后给出 WORKSPACE_MISSING', () => {
  const dir = tmp('missing');
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'output', 'a.csv'), 'a\n1\n');
  const { viewer, workspace } = makeService();
  assert.equal(workspace.bind({ dir }).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
  const got = viewer.artifactTree({});
  assert.equal(got.ok, false);
  assert.equal(got.code, 'WORKSPACE_MISSING');
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
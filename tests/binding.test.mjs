/*
 * 会话识别 + 工作区绑定回归。
 *
 * 覆盖：sessionIdOf 的读取口径、子代理守卫、绑定幂等/改绑、旧台账映射、
 * 以及「不装 skill 也能绑定并浏览文件」的零耦合保证。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/store.js';
import { Viewer } from '../src/viewer.js';
import { WorkspaceService } from '../src/workspace.js';
import { sessionIdOf, sessionIsDelegated } from '../src/binding.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsa-bind-${name}-`));
  temps.push(dir);
  return dir;
}

function makeService(filePath) {
  const store = new Store({ filePath: filePath || path.join(tmp('ledger'), 'data-analysis.json') }).load();
  const viewer = new Viewer({ store });
  const workspace = new WorkspaceService({ store, viewer });
  return { store, viewer, workspace };
}

function execOf(sessionId, header) {
  return { agent: { session: { id: sessionId, header: header || {} } } };
}

/* ------------------------------ 会话识别 ------------------------------ */

check('sessionIdOf：agent.session.id 优先', () => {
  assert.equal(sessionIdOf({ agent: { session: { id: 's1' } } }), 's1');
});

check('sessionIdOf：退回 agent.sessionId / exec.sessionId', () => {
  assert.equal(sessionIdOf({ agent: { sessionId: 's2' } }), 's2');
  assert.equal(sessionIdOf({ sessionId: 's3' }), 's3');
  assert.equal(sessionIdOf({}), '');
  assert.equal(sessionIdOf(null), '');
});

check('sessionIsDelegated：subagent 与 delegationDepth 都算', () => {
  assert.equal(sessionIsDelegated(execOf('a', { origin: 'subagent' })), true);
  assert.equal(sessionIsDelegated(execOf('a', { delegationDepth: 1 })), true);
  assert.equal(sessionIsDelegated(execOf('a', { origin: 'user' })), false);
  assert.equal(sessionIsDelegated(execOf('a')), false);
  assert.equal(sessionIsDelegated({}), false);
});

/* ------------------------------ 绑定 ------------------------------ */

check('缺会话时拒绝绑定，绝不猜 id', () => {
  const { workspace, store } = makeService();
  const dir = tmp('dir');
  const got = workspace.bindForExec({ dir }, {});
  assert.equal(got.ok, false);
  assert.equal(got.code, 'SESSION_REQUIRED');
  assert.deepEqual(store.get('workspaces'), []);
  assert.deepEqual(store.get('bindings'), {});
});

check('子代理不创建、不改绑', () => {
  const { workspace, store } = makeService();
  const dir = tmp('dir');
  const got = workspace.bindForExec({ dir }, execOf('child', { origin: 'subagent' }));
  assert.equal(got.ok, false);
  assert.equal(got.code, 'MAIN_SESSION_REQUIRED');
  assert.deepEqual(store.get('workspaces'), []);
});

check('主会话绑定：登记 + 绑定 + 文本', () => {
  const { workspace, store } = makeService();
  const dir = tmp('dir');
  const got = workspace.bindForExec({ dir, name: '研究 A' }, execOf('main-1'));
  assert.equal(got.ok, true);
  assert.equal(got.workspace.name, '研究 A');
  assert.equal(got.already, false);
  assert.equal(store.get('bindings')['main-1'], got.workspace.id);
  assert.equal(store.get('activeWorkspaceId'), got.workspace.id);
  assert.match(got.text, /本会话已绑定工作区/);
});

check('默认名带日期版本戳（目录名+YYYY-MM-DD），显式 name 不带', () => {
  const { workspace } = makeService();
  const dir = tmp('named');
  const got = workspace.bindForExec({ dir }, execOf('main-date'));
  assert.equal(got.ok, true);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(got.workspace.name, `${path.basename(dir)}（${stamp}）`);
  const named = workspace.bindForExec({ dir: tmp('explicit'), name: '自定义' }, execOf('main-date2'));
  assert.equal(named.workspace.name, '自定义');
});

check('同目录重复绑定幂等（already=true，不重复登记）', () => {
  const { workspace } = makeService();
  const dir = tmp('dir');
  const first = workspace.bindForExec({ dir }, execOf('main-2'));
  const second = workspace.bindForExec({ dir }, execOf('main-2'));
  assert.equal(second.ok, true);
  assert.equal(second.already, true);
  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(workspace.workspaces().length, 1);
});

check('异目录视为改绑，返回 movedFrom', () => {
  const { workspace, store } = makeService();
  const a = tmp('a');
  const b = tmp('b');
  const first = workspace.bindForExec({ dir: a }, execOf('main-3'));
  const second = workspace.bindForExec({ dir: b }, execOf('main-3'));
  assert.equal(second.ok, true);
  assert.equal(second.movedFrom.id, first.workspace.id);
  assert.equal(store.get('bindings')['main-3'], second.workspace.id);
  assert.match(second.text, /已改绑/);
});

check('子代理可读父会话绑定（父绑定不被改）', () => {
  const { workspace, store } = makeService();
  const dir = tmp('parent');
  const parent = workspace.bindForExec({ dir }, execOf('parent-1'));
  const child = workspace.bindForExec({ dir: tmp('child-dir') }, execOf('child-1', { delegationDepth: 2 }));
  assert.equal(child.ok, false);
  assert.equal(workspace.forSession('parent-1').id, parent.workspace.id);
  assert.equal(workspace.forSession('child-1'), null);
  assert.equal(store.get('bindings')['child-1'], undefined);
});

check('无会话的登记只选中工作区，不写 bindings', () => {
  const { workspace, store } = makeService();
  const dir = tmp('panel');
  const got = workspace.bind({ dir });
  assert.equal(got.ok, true);
  assert.deepEqual(store.get('bindings'), {});
  assert.equal(store.get('activeWorkspaceId'), got.workspace.id);
});

check('台账目录不能落在任何已登记工作区内', () => {
  const { workspace } = makeService();
  const dir = tmp('guard');
  workspace.bind({ dir });
  assert.equal(workspace.isInsideWorkspace(dir), true);
  assert.equal(workspace.isInsideWorkspace(path.join(dir, 'output')), true);
  assert.equal(workspace.isInsideWorkspace(tmp('guard-outside')), false);
  assert.equal(workspace.isInsideWorkspace('   '), false);
});

check('移除登记只动台账，不删目录', () => {
  const { workspace, store } = makeService();
  const dir = tmp('forget');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  const bound = workspace.bindForExec({ dir }, execOf('main-4'));
  const got = workspace.forget(bound.workspace.id);
  assert.equal(got.ok, true);
  assert.equal(got.diskKept, true);
  assert.deepEqual(fs.readdirSync(dir), ['keep.txt']);
  assert.equal(workspace.workspaces().length, 0);
  assert.deepEqual(store.get('bindings'), {});
});

check('磁盘目录被外部删除后：登记标记 missing，且仍可移除', () => {
  const { workspace } = makeService();
  const dir = tmp('gone');
  const bound = workspace.bindForExec({ dir }, execOf('main-gone'));
  fs.rmSync(dir, { recursive: true, force: true });
  const listed = workspace.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].missing, true);
  assert.equal(listed[0].fileCount, 0);
  const got = workspace.forget(bound.workspace.id);
  assert.equal(got.ok, true);
  assert.equal(workspace.list().length, 0);
});

/* ------------------------------ 零 skill 耦合 ------------------------------ */

check('不装 skill / 不配 skillRoot 也能绑定并浏览文件', () => {
  const { workspace, viewer, store } = makeService();
  const dir = tmp('no-skill');
  fs.mkdirSync(path.join(dir, 'output', 'stats'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'output', 'stats', 'coef.csv'), 'term,b\nx,1\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), 'print(1)\n');
  const got = workspace.bindForExec({ dir }, execOf('main-5'));
  assert.equal(got.ok, true);
  const tree = viewer.artifactTree({}, got.workspace.id);
  assert.equal(tree.ok, true);
  assert.ok(tree.entries.some((item) => item.rel === 'output/stats/coef.csv'));
  assert.ok(tree.entries.some((item) => item.rel === 'scripts/run.py'));
  assert.deepEqual(store.get('config'), { dataDir: '' }, '插件不应要求任何 skill 配置');
});

/* ------------------------------ 旧台账 ------------------------------ */

check('旧台账的 projects[] 映射为 workspaces，runs/armings 直接忽略', () => {
  const stateDir = tmp('legacy');
  const file = path.join(stateDir, 'data-analysis.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: [{ id: 'abc123abc123', name: '旧项目', path: 'F:\\old\\proj', stages: {} }],
    runs: [{ id: 'r1' }],
    armings: { s1: true },
    adjudications: { a: 1 },
    recheckChains: { c: 1 },
    config: { skillRoot: 'x', pythonPath: 'python', dataDir: 'D:\\ledger' },
    bindings: { 's-old': { projectId: 'abc123abc123', at: '2026-11-16T00:00:00Z' }, 's-bad': { foo: 1 }, 's-str': 'abc123abc123' },
  }));
  const store = new Store({ filePath: file }).load();
  assert.deepEqual(store.get('workspaces'), [
    { id: 'abc123abc123', name: '旧项目', root: 'F:\\old\\proj', createdAt: '' },
  ]);
  assert.deepEqual(store.get('bindings'), { 's-old': 'abc123abc123', 's-str': 'abc123abc123' });
  assert.deepEqual(store.get('config'), { dataDir: 'D:\\ledger' }, '旧配置项（skillRoot/pythonPath…）不应回流台账');
  const viewer = new Viewer({ store });
  const workspace = new WorkspaceService({ store, viewer });
  assert.equal(workspace.forSession('s-old').id, 'abc123abc123', '旧对象形 bindings 仍应被识别；否则升级后会话丢绑定');
  assert.equal(workspace.forSession('s-bad'), null);
  assert.equal(store.get('runs'), undefined);
  assert.equal(store.get('armings'), undefined);
  assert.equal(store.get('adjudications'), undefined);
  assert.equal(store.get('recheckChains'), undefined);
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
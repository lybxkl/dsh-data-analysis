/**
 * 只读查看器回归：文件树双根、读文件、目录进度、四道路径防护，
 * 以及红线静态守卫（无子进程 / 无提示注入 / 无 skill 耦合 / 不写研究目录）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.js';
import { Viewer } from '../src/viewer.js';
import { WorkspaceService } from '../src/workspace.js';
import { registerRoutes } from '../src/routes.js';
import { withReadCache } from '../src/read-scope.js';
import { sanitizeFilename } from '../src/util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(HERE, '..');

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

function makeWorkspaceDir() {
  const root = tmp('art');
  for (const dir of [
    'output',
    'output/audit',
    'output/figures',
    'output/models',
    'output/models/nested',
    'output/l1/l2/l3/l4',
    'output/.thumbs',
    'scripts',
    'scripts/tools/deep',
    'data',
    'docs',
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  write(root, 'output/audit/result.csv', 'id,x\n1,2\n2,3\n3,4\n4,5\n5,6\n6,7\n');
  write(root, 'output/audit/report.md', '# 审计\n正文');
  write(root, 'output/figures/f01.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  write(root, 'output/figures/f02.heic', 'heic-bytes');
  write(root, 'output/models/coef.csv', 'model,b\nM1,0.5\n');
  write(root, 'output/models/meta.json', JSON.stringify({ ok: true, n: 3 }));
  write(root, 'output/models/notes.txt', '第一行\n第二行');
  write(root, 'output/models/nested/inside.txt', 'nested');
  write(root, 'output/l1/l2/l3/keep.txt', 'depth3');
  write(root, 'output/l1/l2/l3/l4/drop.txt', 'depth4');
  write(root, 'output/.thumbs/hidden.png', 'dot');
  write(root, 'output/qc.pdf', '%PDF-1.4');
  write(root, 'output/report.docx', 'docx');
  write(root, 'output/run.exe', 'not-allowed');
  write(root, 'scripts/analysis.py', 'print("hello")\nprint("world")\n');
  write(root, 'scripts/tools/deep/helper.R', 'x <- 1\n');
  write(root, 'scripts/tools/deep/too/deep.jl', '1+1\n');
  write(root, 'data/source.csv', 'a\n1\n');
  write(root, 'docs/readme.md', 'docs');
  write(root, 'secret.csv', 'a\n1\n');
  return root;
}

function openService(root) {
  const stateDir = tmp('ledger');
  const store = new Store({ filePath: path.join(stateDir, 'data-analysis.json') }).load();
  const viewer = new Viewer({ store });
  const workspace = new WorkspaceService({ store, viewer });
  const bound = workspace.bind({ dir: root });
  assert.equal(bound.ok, true, bound.error);
  return { store, viewer, workspace };
}

const root = makeWorkspaceDir();
const { viewer, workspace, store } = openService(root);

/* ------------------------------ 路径安全 ------------------------------ */

check('相对路径越界一律拒绝', () => {
  for (const rel of ['../secret.csv', 'output/../../secret.csv', '..\\secret.csv']) {
    const got = viewer.artifactResolve(rel);
    assert.equal(got.ok, false, `${rel} 不该放行`);
    assert.match(got.error, /路径不在工作区里/);
  }
});

check('绝对路径越界拒绝', () => {
  const outside = path.join(tmp('outside'), 'x.csv');
  fs.writeFileSync(outside, 'a\n1\n');
  const got = viewer.artifactResolve(outside);
  assert.equal(got.ok, false);
});

check('目录不能当文件读', () => {
  const got = viewer.artifactResolve('output');
  assert.equal(got.ok, false);
  assert.match(got.error, /不是文件/);
});

check('白名单外的扩展名拒绝', () => {
  const got = viewer.artifactResolve('output/run.exe');
  assert.equal(got.ok, false);
  assert.match(got.error, /不支持的扩展名/);
});

check('Windows 备用数据流不能绕过扩展名白名单', () => {
  write(root, 'output/run.exe', 'exe');
  const got = viewer.artifactResolve('output/run.exe:secret.json');
  assert.equal(got.ok, false);
  if (process.platform === 'win32') assert.match(got.error, /不支持的路径/);
});

check('超过 32MB 拒绝', () => {
  const huge = path.join(root, 'output', 'huge.csv');
  fs.writeFileSync(huge, '');
  fs.truncateSync(huge, 32 * 1024 * 1024 + 1);
  const got = viewer.artifactResolve('output/huge.csv');
  assert.equal(got.ok, false);
  assert.match(got.error, /文件太大/);
  fs.rmSync(huge, { force: true });
});

check('junction 逃逸被 realpath 防护挡住', () => {
  const outside = tmp('junction-target');
  fs.writeFileSync(path.join(outside, 'secret.csv'), 'a\n1\n');
  const link = path.join(root, 'output', 'escape');
  fs.symlinkSync(outside, link, 'junction');
  try {
    const inside = viewer.artifactResolve('output/escape/secret.csv');
    assert.equal(inside.ok, false, 'junction 指向的工作区外文件不该放行');
    assert.match(inside.error, /路径指向工作区外/);
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
  }
});

/* ------------------------------ 读文件 ------------------------------ */

check('CSV 按表头回行并支持截断', () => {
  const got = viewer.artifactRead('output/audit/result.csv', { limit: 5 });
  assert.equal(got.ok, true);
  assert.equal(got.kind, 'table');
  assert.deepEqual(got.header, ['id', 'x']);
  assert.equal(got.rows.length, 5);
  assert.equal(got.totalRows, 6);
  assert.equal(got.truncated, true);
});

check('脚本按文本读取（code 页签依赖）', () => {
  const got = viewer.artifactRead('scripts/analysis.py');
  assert.equal(got.ok, true);
  assert.equal(got.kind, 'text');
  assert.match(got.text, /print\("hello"\)/);
  const tree = viewer.artifactTree({});
  const entry = tree.entries.find((item) => item.rel === 'scripts/analysis.py');
  assert.equal(entry.viewable, true);
});

check('JSON 美化、文本、图片、PDF、Word 分流', () => {
  assert.equal(viewer.artifactRead('output/models/meta.json').kind, 'json');
  assert.match(viewer.artifactRead('output/models/meta.json').text, /"ok": true/);
  assert.equal(viewer.artifactRead('output/models/notes.txt').kind, 'text');
  assert.equal(viewer.artifactRead('output/figures/f01.png').kind, 'image');
  assert.equal(viewer.artifactRead('output/figures/f02.heic').kind, 'image');
  assert.equal(viewer.artifactRead('output/qc.pdf').kind, 'pdf');
  assert.equal(viewer.artifactRead('output/report.docx').kind, 'document');
});

/* ------------------------------ 文件树 ------------------------------ */

check('双根：output/ 与 scripts/ 都列出，data/docs 不展开', () => {
  const tree = viewer.artifactTree({ limit: 800 });
  assert.equal(tree.ok, true);
  assert.deepEqual(tree.roots, ['output', 'scripts']);
  const rels = tree.entries.map((item) => item.rel);
  assert.ok(rels.includes('output'));
  assert.ok(rels.includes('scripts'));
  assert.ok(rels.includes('output/audit/result.csv'));
  assert.ok(rels.includes('scripts/analysis.py'));
  assert.ok(!rels.some((rel) => rel.startsWith('data')));
  assert.ok(!rels.some((rel) => rel.startsWith('docs')));
  assert.ok(!rels.some((rel) => rel.includes('.thumbs')));
  assert.ok(!rels.some((rel) => rel.includes('secret.csv')));
});

check('深度：output 3 层（第 4 层不展开），scripts 2 层', () => {
  const tree = viewer.artifactTree({});
  const rels = tree.entries.map((item) => item.rel);
  assert.ok(rels.includes('output/l1/l2/l3/keep.txt'));
  assert.ok(!rels.includes('output/l1/l2/l3/l4/drop.txt'));
  assert.ok(rels.includes('scripts/tools/deep/helper.R'));
  assert.ok(!rels.includes('scripts/tools/deep/too/deep.jl'));
});

check('条目截断生效', () => {
  const tree = viewer.artifactTree({ limit: 20 });
  assert.equal(tree.truncated, true);
  assert.ok(tree.entries.length <= 20);
});

check('每项带 viewable/image 标记', () => {
  const tree = viewer.artifactTree({});
  const png = tree.entries.find((item) => item.rel === 'output/figures/f01.png');
  const exe = tree.entries.find((item) => item.rel === 'output/run.exe');
  assert.equal(png.image, true);
  assert.equal(png.viewable, true);
  assert.equal(exe.viewable, false);
});

/* ------------------------------ 目录进度 ------------------------------ */

check('目录进度动态枚举 output/ 一级子目录', () => {
  const got = viewer.progress();
  assert.equal(got.ok, true);
  const names = got.progress.map((item) => item.name);
  assert.deepEqual(names, ['audit', 'figures', 'l1', 'models']);
  const audit = got.progress.find((item) => item.name === 'audit');
  assert.equal(audit.dir, 'output/audit');
  assert.equal(audit.fileCount, 2);
  assert.ok(audit.latestMtime > 0);
  const models = got.progress.find((item) => item.name === 'models');
  assert.equal(models.fileCount, 4, '递归计数');
});

check('目录进度只有文件事实，没有 pass/fail/阶段语义', () => {
  const got = viewer.progress();
  for (const item of got.progress) {
    assert.deepEqual(Object.keys(item).sort(), ['dir', 'fileCount', 'latestMtime', 'name']);
    const text = JSON.stringify(item);
    assert.ok(!/pass|fail|blocked|done|完成|通过|阶段/.test(text));
  }
});

check('一次快照内同一工作区的进度只扫描一次（read-scope 已接线）', () => {
  const base = path.join(root, 'output');
  const orig = fs.readdirSync;
  let count = 0;
  fs.readdirSync = function (target, ...rest) {
    if (String(target) === base) count += 1;
    return orig.call(fs, target, ...rest);
  };
  try {
    withReadCache(() => {
      viewer.progress();
      viewer.progress();
    });
  } finally {
    fs.readdirSync = orig;
  }
  assert.equal(count, 1);
});

check('output/ 不存在或为空时进度为空态', () => {
  const empty = tmp('empty-ws');
  const stateDir = tmp('empty-ledger');
  const emptyStore = new Store({ filePath: path.join(stateDir, 'data-analysis.json') }).load();
  const emptyViewer = new Viewer({ store: emptyStore });
  const emptyWorkspace = new WorkspaceService({ store: emptyStore, viewer: emptyViewer });
  emptyWorkspace.bind({ dir: empty });
  const got = emptyViewer.progress();
  assert.equal(got.ok, true);
  assert.deepEqual(got.progress, []);
  const tree = emptyViewer.artifactTree({});
  assert.equal(tree.ok, true);
  assert.deepEqual(tree.entries, []);
  assert.deepEqual(tree.roots, []);
});

check('无工作区时读取给出明确错误', () => {
  const stateDir = tmp('no-ws');
  const noStore = new Store({ filePath: path.join(stateDir, 'data-analysis.json') }).load();
  const noViewer = new Viewer({ store: noStore });
  const tree = noViewer.artifactTree({});
  assert.equal(tree.ok, false);
  assert.match(tree.error, /还没有绑定工作区/);
});

check('快照含 workspace/tree/progress', () => {
  const snap = viewer.snapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.workspace.id, store.get('activeWorkspaceId'));
  assert.ok(snap.tree.entries.length > 0);
  assert.ok(snap.progress.length > 0);
});

check('自引用目录联接不会递归不终止，也不进树/进度', () => {
  const loop = path.join(root, 'output', 'loop');
  fs.symlinkSync(path.join(root, 'output'), loop, 'junction');
  try {
    const started = Date.now();
    const tree = viewer.artifactTree({ limit: 2000 });
    const got = viewer.progress();
    assert.equal(tree.ok, true);
    assert.ok(Date.now() - started < 3000, '扫描应在 3s 内结束');
    assert.ok(!tree.entries.some((entry) => entry.rel === 'output/loop'));
    assert.ok(!got.progress.some((item) => item.name === 'loop'));
  } finally {
    fs.rmSync(loop, { recursive: true, force: true });
  }
});

check('指向工作区外的联接不泄露外部文件元信息', () => {
  const outside = tmp('link-meta');
  write(outside, 'secret.csv', 'a\n1\n');
  const link = path.join(root, 'output', 'outside-link');
  fs.symlinkSync(outside, link, 'junction');
  try {
    const tree = viewer.artifactTree({});
    assert.ok(!tree.entries.some((entry) => entry.rel.indexOf('output/outside-link') === 0));
    assert.ok(!JSON.stringify(tree.entries).includes('secret.csv'));
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
  }
});

/* ------------------------------ 只读保证 ------------------------------ */

function hashTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, item.name);
      if (item.isDirectory()) {
        out.push(`D:${path.relative(dir, abs)}`);
        walk(abs);
      } else if (item.isFile()) {
        out.push(`F:${path.relative(dir, abs)}:${fs.statSync(abs).size}:${fs.readFileSync(abs).toString('base64')}`);
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

check('绑定/浏览/读文件不往研究目录写任何东西', () => {
  const before = hashTree(root);
  workspace.bind({ dir: root, sessionId: 's-write-check' });
  viewer.artifactTree({});
  viewer.progress();
  viewer.artifactRead('output/audit/result.csv');
  viewer.snapshot();
  assert.equal(hashTree(root), before);
});

/* ------------------------------ 红线静态守卫 ------------------------------ */

const SURVIVING_SRC = ['binding.js', 'read-scope.js', 'routes.js', 'store.js', 'tools.js', 'util.js', 'viewer.js', 'workspace.js'];

function sources() {
  return SURVIVING_SRC.map((name) => ({ name, text: fs.readFileSync(path.join(ROOT_DIR, 'src', name), 'utf8') }));
}

check('无子进程 / 无 Python 运行依赖（脚本只按文本读取）', () => {
  const all = sources().concat([{ name: 'index.js', text: fs.readFileSync(path.join(ROOT_DIR, 'index.js'), 'utf8') }]);
  for (const file of all) {
    assert.ok(!/child_process|spawn\(|execFile|execSync|runProcess/.test(file.text), `${file.name} 含子进程`);
  }
  assert.equal(fs.existsSync(path.join(ROOT_DIR, 'assets')), false, 'assets/ 必须已删除');
});

check('无系统提示注入 / 无触发门 / 无 skill 耦合', () => {
  const all = sources().concat([
    { name: 'index.js', text: fs.readFileSync(path.join(ROOT_DIR, 'index.js'), 'utf8') },
    { name: 'client.js', text: fs.readFileSync(path.join(ROOT_DIR, 'client.js'), 'utf8') },
  ]);
  for (const file of all) {
    assert.ok(!/systemPrompt\.section|registerPrompt/.test(file.text), `${file.name} 注入系统提示`);
    assert.ok(!/whenArmed|isArmedSession|admissionFor/.test(file.text), `${file.name} 含触发门`);
    assert.ok(!/workflow\.json|skillRoot|SKILL_PACKAGE|workflowFor/.test(file.text), `${file.name} 含 skill 耦合`);
  }
});

check('绑定/查看/路由模块不写盘', () => {
  for (const name of ['workspace.js', 'viewer.js', 'tools.js', 'routes.js', 'util.js']) {
    const text = fs.readFileSync(path.join(ROOT_DIR, 'src', name), 'utf8');
    assert.ok(!/writeFileSync|appendFileSync|mkdirSync|createWriteStream|rmSync|unlinkSync/.test(text), `${name} 含写盘调用`);
  }
});

check('src 只剩 8 个查看器模块，assets/ 已删除', () => {
  const modules = fs.readdirSync(path.join(ROOT_DIR, 'src')).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(modules, SURVIVING_SRC.slice().sort());
  assert.equal(fs.existsSync(path.join(ROOT_DIR, 'assets')), false);
});

check('数据目录选择读 workspaces（不读旧 projects）', () => {
  const index = fs.readFileSync(path.join(ROOT_DIR, 'index.js'), 'utf8');
  assert.match(index, /raw\?\.workspaces/);
  assert.ok(!/raw\?\.projects/.test(index));
});

check('配置项只剩 dataDir', () => {
  const index = fs.readFileSync(path.join(ROOT_DIR, 'index.js'), 'utf8');
  const patch = fs.readFileSync(path.join(ROOT_DIR, 'cordis.patch.yml'), 'utf8');
  assert.match(index, /dataDir/);
  for (const gone of ['skillRoot', 'pythonPath', 'maxRuns', 'maxLogLines', 'pollInterval', 'showDataDir', 'modelProvider']) {
    assert.ok(!index.includes(gone), `index.js 仍含配置项 ${gone}`);
    assert.ok(!patch.includes(gone), `cordis.patch.yml 仍含配置项 ${gone}`);
  }
});

/* ------------------------------ HTTP 路由 ------------------------------ */

function mountRoutes(services = { store, viewer, workspace }) {
  let captured = null;
  const ctx = {
    effect(fn) {
      fn();
      return () => {};
    },
    webServer: {
      register(def) {
        captured = def;
        return () => {};
      },
    },
  };
  registerRoutes(ctx, services, { basePath: '/data-analysis', getConfig: () => ({ dataDir: '' }) });
  assert.ok(captured, '路由未注册到 webServer');
  const call = async (method, pathname, { body, host = '127.0.0.1:9999', remote = '127.0.0.1', contentType = 'application/json' } = {}) => {
    const req = {
      method,
      url: pathname,
      headers: { host, ...(method === 'POST' ? { 'content-type': contentType } : {}) },
      socket: { remoteAddress: remote },
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(body === undefined ? '' : JSON.stringify(body)));
        if (event === 'end') cb();
      },
    };
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      write() { return true; },
      end(payload) {
        this.body = payload;
      },
      on() {}, once() {}, emit() {},
    };
    await captured.handler(req, res);
    return { status: res.status, headers: res.headers || {}, json: res.body ? JSON.parse(res.body) : null };
  };
  return { call };
}

const http = mountRoutes();

await checkAsync('GET /api/state 返回工作区、目录进度与文件树', async () => {
  const got = await http.call('GET', '/data-analysis/api/state');
  assert.equal(got.status, 200);
  assert.equal(got.json.ok, true);
  assert.ok(got.json.state.workspaces.length >= 1);
  assert.ok(got.json.state.progress.length >= 1);
  assert.ok(got.json.state.tree.entries.length > 0);
  assert.deepEqual(got.json.state.config, { dataDir: '' });
});

await checkAsync('GET /api/artifacts/tree 按 workspaceId 读取', async () => {
  const id = store.get('activeWorkspaceId');
  const got = await http.call('GET', `/data-analysis/api/artifacts/tree?workspaceId=${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.ok, true);
  assert.ok(got.json.entries.some((item) => item.rel === 'output/audit/result.csv'));
});

await checkAsync('GET /api/session/project 按会话返回绑定', async () => {
  const sessionId = 'route-session';
  workspace.bind({ dir: root, sessionId });
  const got = await http.call('GET', `/data-analysis/api/session/project?sessionId=${sessionId}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.workspace.id, store.get('bindings')[sessionId]);
  const missing = await http.call('GET', '/data-analysis/api/session/project');
  assert.equal(missing.status, 400);
});

await checkAsync('POST /api/workspace 走同一绑定实现', async () => {
  const dir = tmp('route-ws');
  const got = await http.call('POST', '/data-analysis/api/workspace', { body: { dir, sessionId: 'route-session-2' } });
  assert.equal(got.status, 200);
  assert.equal(got.json.ok, true);
  assert.equal(got.json.state.active.id, got.json.workspace.id);
  const bad = await http.call('POST', '/data-analysis/api/workspace', { body: { dir: 'relative' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);
});

await checkAsync('非 loopback 远程地址一律 403（Host 不能短路远程检查）', async () => {
  const got = await http.call('GET', '/data-analysis/api/state', { remote: '192.168.1.50', host: '127.0.0.1:9999' });
  assert.equal(got.status, 403);
  const badHost = await http.call('GET', '/data-analysis/api/state', { remote: '127.0.0.1', host: 'evil.example.com' });
  assert.equal(badHost.status, 403);
});

await checkAsync('POST 只接受纯 application/json', async () => {
  const got = await http.call('POST', '/data-analysis/api/workspace', { body: { dir: root }, contentType: 'text/plain;application/json' });
  assert.equal(got.status, 415);
});

await checkAsync('dataDir 不能落在已登记工作区内', async () => {
  const got = await http.call('POST', '/data-analysis/api/config', { body: { dataDir: path.join(root, 'output') } });
  assert.equal(got.status, 409);
  assert.match(got.json.error, /工作区/);
});

await checkAsync('台账写失败后恢复 dirty，修复路径可重试成功', async () => {
  const dir = tmp('store-retry');
  const parent = path.join(dir, 'not-a-dir');
  fs.writeFileSync(parent, 'x');
  const store2 = new Store({ filePath: path.join(parent, 'data-analysis.json') }).load();
  store2.set('workspaces', []);
  await store2.flush();
  assert.equal(fs.existsSync(path.join(parent, 'data-analysis.json')), false);
  fs.rmSync(parent);
  fs.mkdirSync(parent);
  await store2.flush();
  assert.equal(fs.existsSync(path.join(parent, 'data-analysis.json')), true);
});

await checkAsync('旧流水线路由已不存在（无运行/裁定/材料/复核/缩略图）', async () => {
  for (const pathname of [
    '/data-analysis/api/stage/run',
    '/data-analysis/api/adjudicate',
    '/data-analysis/api/materials',
    '/data-analysis/api/recheck',
    '/data-analysis/api/artifacts/thumb',
    '/data-analysis/api/workflow',
    '/data-analysis/api/summary',
    '/data-analysis/api/chat/focus',
  ]) {
    const got = await http.call(pathname.startsWith('/data-analysis/api/stage') || pathname.includes('materials') || pathname.includes('adjudicate') ? 'POST' : 'GET', pathname, { body: {} });
    assert.equal(got.status, 404, `${pathname} 应已删除`);
  }
});

/* ------------------------------ 中文显示名（figure_map.json） ------------------------------ */

const titleRoot = tmp('title-ws');
fs.mkdirSync(path.join(titleRoot, 'output/figures'), { recursive: true });
const fig1 = path.join(titleRoot, 'output/figures/fig1_structure.png');
const fig2 = path.join(titleRoot, 'output/figures/fig2_gap.png');
fs.writeFileSync(fig1, Buffer.from('89504e470d0a1a0a', 'hex'));
fs.writeFileSync(fig2, Buffer.from('89504e470d0a1a0a', 'hex'));
const outsideImg = path.join(tmp('title-outside'), 'evil.png');
fs.writeFileSync(outsideImg, 'x');
fs.writeFileSync(path.join(titleRoot, 'output/figure_map.json'), JSON.stringify([
  { tag: '图1', title: '样本类别结构', image: fig1 },
  { tag: '图2', title: '处理差异', image: 'output/figures/fig2_gap.png' },
  { tag: '图9', title: '越界', image: outsideImg },
  { tag: '图8', title: '', image: fig1 },
]));
const titleStore = new Store({ filePath: path.join(tmp('title-ledger'), 'data-analysis.json') }).load();
const titleViewer = new Viewer({ store: titleStore });
const titleWorkspace = new WorkspaceService({ store: titleStore, viewer: titleViewer });
titleWorkspace.bind({ dir: titleRoot });

check('figure_map.json 合并中文标题进文件树', () => {
  const tree = titleViewer.artifactTree({});
  const e1 = tree.entries.find((e) => e.rel === 'output/figures/fig1_structure.png');
  assert.equal(e1.title, '图1 样本类别结构');
  const e2 = tree.entries.find((e) => e.rel === 'output/figures/fig2_gap.png');
  assert.equal(e2.title, '图2 处理差异');
});

check('image 绝对路径归一为工作区相对 rel', () => {
  const map = titleViewer.titleMap();
  assert.equal(map['output/figures/fig1_structure.png'], '图1 样本类别结构');
  assert.equal(map['output/figures/fig2_gap.png'], '图2 处理差异');
});

check('越界 image 与空标题被忽略', () => {
  const map = titleViewer.titleMap();
  assert.equal(Object.keys(map).length, 2);
  assert.ok(!Object.values(map).includes('图9 越界'));
});

check('downloadName：中文文件名 + 英文 ascii 回退', () => {
  const dn = titleViewer.downloadName('output/figures/fig1_structure.png');
  assert.equal(dn.name, '图1 样本类别结构.png');
  assert.equal(dn.ascii, 'fig1_structure.png');
  fs.writeFileSync(path.join(titleRoot, 'output/figures/plain.png'), 'x');
  const plain = titleViewer.downloadName('output/figures/plain.png');
  assert.equal(plain.name, 'plain.png');
  assert.equal(plain.ascii, 'plain.png');
});

check('sanitizeFilename 去非法字符保留中文', () => {
  assert.equal(sanitizeFilename('图1 样本/类别:结构?.png'), '图1 样本类别结构.png');
  assert.equal(sanitizeFilename('  a  b  '), 'a b');
  assert.equal(sanitizeFilename('name.'), 'name');
  const long = sanitizeFilename('x'.repeat(119) + ' y');
  assert.ok(long.length <= 120, '限长 120');
  assert.ok(!/[. ]$/.test(long), '截断后不得留尾部空格/点');
});

check('无 figure_map.json 时退回文件名（不报错）', () => {
  const empty = tmp('title-empty');
  fs.mkdirSync(path.join(empty, 'output'), { recursive: true });
  fs.writeFileSync(path.join(empty, 'output/a.png'), 'x');
  const st = new Store({ filePath: path.join(tmp('title-empty-ledger'), 'x.json') }).load();
  const v = new Viewer({ store: st });
  new WorkspaceService({ store: st, viewer: v }).bind({ dir: empty });
  assert.deepEqual(v.titleMap(), {});
  const e = v.artifactTree({}).entries.find((x) => x.rel === 'output/a.png');
  assert.equal(e.title, undefined);
  assert.equal(v.downloadName('output/a.png').name, 'a.png');
});

check('非法 figure_map.json 不崩', () => {
  const bad = tmp('title-bad');
  fs.mkdirSync(path.join(bad, 'output'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'output/figure_map.json'), '{not json');
  const st = new Store({ filePath: path.join(tmp('title-bad-ledger'), 'x.json') }).load();
  const v = new Viewer({ store: st });
  new WorkspaceService({ store: st, viewer: v }).bind({ dir: bad });
  assert.deepEqual(v.titleMap(), {});
});

const titleHttp = mountRoutes({ store: titleStore, viewer: titleViewer, workspace: titleWorkspace });

await checkAsync('raw 下载用中文 filename* + 英文 filename=', async () => {
  const got = await titleHttp.call('GET', '/data-analysis/api/artifacts/raw?path=' + encodeURIComponent('output/figures/fig1_structure.png') + '&download=1');
  assert.equal(got.status, 200);
  const cd = got.headers['content-disposition'] || '';
  assert.ok(cd.includes("filename*=UTF-8''" + encodeURIComponent('图1 样本类别结构.png')), cd);
  assert.ok(cd.includes('filename="fig1_structure.png"'), cd);
});

await checkAsync('无标题文件下载仍用英文名', async () => {
  const got = await titleHttp.call('GET', '/data-analysis/api/artifacts/raw?path=' + encodeURIComponent('output/figures/plain.png') + '&download=1');
  assert.equal(got.status, 200);
  const cd = got.headers['content-disposition'] || '';
  assert.ok(cd.includes('filename="plain.png"'), cd);
  assert.ok(cd.includes("filename*=UTF-8''plain.png"), cd);
});

/* ------------------------------ 文稿/表中文名（manuscript.json） ------------------------------ */

const msRoot = tmp('ms-ws');
fs.mkdirSync(path.join(msRoot, 'output/models'), { recursive: true });
fs.writeFileSync(path.join(msRoot, 'output/manuscript.docx'), 'docx');
fs.writeFileSync(path.join(msRoot, 'output/manuscript.pdf'), '%PDF');
fs.writeFileSync(path.join(msRoot, 'output/models/coef.csv'), 'a,b\n1,2\n');
fs.writeFileSync(path.join(msRoot, 'output/models/fit.csv'), 'a,b\n1,2\n');
fs.writeFileSync(path.join(msRoot, 'manuscript.json'), JSON.stringify({
  blocks: [
    { type: 'title', text: '数字政府研究论文' },
    { type: 'para', text: '正文' },
    { type: 'table', caption: '回归系数汇总', csv: 'output/models/coef.csv' },
    { type: 'table', caption: '模型拟合指标', csv: 'output/models/fit.csv', number: 5 },
  ],
}));
const msStore = new Store({ filePath: path.join(tmp('ms-ledger'), 'data-analysis.json') }).load();
const msViewer = new Viewer({ store: msStore });
new WorkspaceService({ store: msStore, viewer: msViewer }).bind({ dir: msRoot });

check('manuscript.json 标题块命名文稿 docx/pdf', () => {
  const map = msViewer.titleMap();
  assert.equal(map['output/manuscript.docx'], '数字政府研究论文');
  assert.equal(map['output/manuscript.pdf'], '数字政府研究论文');
});

check('manuscript.json 表块 csv → 表N 中文表题（含显式编号）', () => {
  const map = msViewer.titleMap();
  assert.equal(map['output/models/coef.csv'], '表1 回归系数汇总');
  assert.equal(map['output/models/fit.csv'], '表5 模型拟合指标');
});

check('文稿/表下载名中文 + 英文 ascii 回退', () => {
  assert.equal(msViewer.downloadName('output/manuscript.docx').name, '数字政府研究论文.docx');
  const dn = msViewer.downloadName('output/models/coef.csv');
  assert.equal(dn.name, '表1 回归系数汇总.csv');
  assert.equal(dn.ascii, 'coef.csv');
});

check('无 manuscript.json 时文稿退回文件名', () => {
  assert.equal(titleViewer.titleMap()['output/manuscript.docx'], undefined);
  assert.equal(titleViewer.downloadName('output/manuscript.docx').name, 'manuscript.docx');
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
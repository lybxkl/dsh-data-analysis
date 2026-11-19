/**
 * client.js 冒烟测试：不开浏览器，用极简假 React 把面板渲染成树。
 *
 * 覆盖：2 列骨架、四页签 + code、FileTree、lightbox、目录进度、
 * 4s 可见性轮询、follow-the-chat、绑定/设置对话框，以及「旧流水线 UI 已删除」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, '..', 'client.js');

let failures = 0;
let passed = 0;
function check(value, label, extra) {
  if (value) {
    passed += 1;
    console.log('✓ ' + label);
  } else {
    failures += 1;
    console.log('✗ ' + label + (extra ? ' — ' + extra : ''));
  }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------------- 极简 React ---------------- */

let current = null;
let store = new Map();
let cmpSeq = 0;
let dirty = false;

function slot() {
  if (!current) throw new Error('hook called outside render');
  const inst = current;
  const index = inst.i;
  inst.i += 1;
  return { inst, index };
}
function hookKey(inst, index) {
  return String(inst.key) + ':' + String(index);
}

const React = {
  createElement(type, props, ...children) {
    const merged = {};
    if (props) for (const key of Object.keys(props)) merged[key] = props[key];
    const kids = children.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false);
    merged.children = kids;
    return { type, props: merged };
  },
  useState(initial) {
    const { inst, index } = slot();
    const key = hookKey(inst, index);
    if (!store.has(key)) store.set(key, initial);
    const setter = (value) => {
      const next = typeof value === 'function' ? value(store.get(key)) : value;
      if (Object.is(next, store.get(key))) return;
      store.set(key, next);
      dirty = true;
    };
    return [store.get(key), setter];
  },
  useEffect(fn, deps) {
    if (!globalThis.__DSA_EFFECTS__) return;
    const { inst, index } = slot();
    const key = 'fx:' + hookKey(inst, index);
    const prior = store.get(key);
    if (prior && deps && prior.deps && !globalThis.__DSA_EFFECT_ALWAYS__) {
      const same = deps.length === prior.deps.length && deps.every((value, i) => Object.is(value, prior.deps[i]));
      if (same) return;
    }
    if (prior && typeof prior.cleanup === 'function') prior.cleanup();
    const effect = { deps: deps ? deps.slice() : null, cleanup: null };
    store.set(key, effect);
    effect.cleanup = fn();
  },
  useLayoutEffect() {},
  useMemo(fn) {
    slot();
    return fn();
  },
  useCallback(fn) {
    slot();
    return fn;
  },
  useRef(value) {
    const { inst, index } = slot();
    const key = hookKey(inst, index);
    if (!store.has(key)) store.set(key, { current: value });
    return store.get(key);
  },
};
React.default = React;

function expand(node, depth = 0) {
  if (depth > 100) throw new Error('渲染层数过深');
  if (Array.isArray(node)) return node.map((item) => expand(item, depth + 1)).filter((item) => item !== null);
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
  if (!node || typeof node !== 'object' || node.type === undefined) return { text: String(node) };
  const { type, props } = node;
  if (typeof type === 'function') {
    cmpSeq += 1;
    const inst = { fn: type, key: cmpSeq + '|' + (type.name || 'anonymous'), i: 0 };
    const prev = current;
    current = inst;
    let out;
    try {
      out = type(props);
    } finally {
      current = prev;
    }
    return expand(out, depth + 1);
  }
  return {
    tag: type,
    props: props || {},
    children: ((props && props.children) || []).map((item) => expand(item, depth + 1)).filter(Boolean),
  };
}

/* ---------------- 加载 client.js ---------------- */

const PATCHES = [
  ['var stateTuple = useState(STATE_CACHE.state);', 'var stateTuple = useState(globalThis.__DSA__.state);'],
  ['var treeTuple = useState(STATE_CACHE.tree);', 'var treeTuple = useState(globalThis.__DSA__.tree);'],
  ['var selectedState = useState(\'\');', 'var selectedState = useState(globalThis.__DSA__.selected || \'\');'],
  ['var loadingState = useState(!STATE_CACHE.state);', 'var loadingState = useState(false);'],
  ['var widthState = useState(\'wide\');', 'var widthState = useState(globalThis.__DSA__.width || \'wide\');'],
  ['var themeState = useState(\'light\');', 'var themeState = useState(globalThis.__DSA__.theme || \'light\');'],
  ['var dialogState = useState(null);', 'var dialogState = useState(globalThis.__DSA__.dialog || null);'],
];

function loadClient({ patch = true } = {}) {
  let source = fs.readFileSync(CLIENT, 'utf8');
  if (patch) {
    for (const [from] of PATCHES) {
      if (!source.includes(from)) throw new Error('client.js 结构变了：找不到 ' + from);
    }
    for (const [from, to] of PATCHES) source = source.replace(from, to);
  }
  let captured = null;
  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      load(def) {
        captured = def;
      },
    },
  };
  new Function('window', 'document', 'globalThis', source)(windowStub, globalThis.document || {}, globalThis);
  if (!captured || typeof captured.factory !== 'function') throw new Error('client.js 没有调用 __ModuleLoader__.load');
  const exported = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('client.js 请求了宿主模块：' + name);
  });
  const registered = new Map();
  exported.apply({
    effect(fn) {
      try {
        fn();
      } catch (error) {
        /* 宿主环境里的 effect 失败不影响测试 */
      }
      return () => {};
    },
    slots: {
      inject(name, fn) {
        fn();
        return () => {};
      },
      register(def, component) {
        registered.set(def && (def.name + ':' + (def.key || def.id || '')), component);
        return () => {};
      },
    },
  });
  return { panel: registered.get('main:data-analysis'), registered, source };
}

function mount(Component, props) {
  for (let pass = 0; pass < 20; pass += 1) {
    dirty = false;
    cmpSeq = 0;
    current = null;
    const tree = expand(React.createElement(Component, props || {}));
    if (!dirty) return tree;
  }
  throw new Error('面板没有收敛（可能是 setState 循环）');
}

/* ---------------- 树查询 ---------------- */

function walk(node, out = []) {
  if (!node) return out;
  out.push(node);
  (node.children || []).forEach((child) => walk(child, out));
  return out;
}
function textOf(node) {
  return walk(node).map((item) => (item.text !== undefined ? item.text : '')).join(' ');
}
function findText(node, label) {
  return walk(node).find((item) => item.text !== undefined && String(item.text).indexOf(label) >= 0);
}
function findAllByTag(node, tag) {
  return walk(node).filter((item) => item.tag === tag);
}
function buttons(node) {
  return findAllByTag(node, 'button');
}
function click(node, label) {
  const target = buttons(node).find((item) => textOf(item).indexOf(label) >= 0);
  if (!target) throw new Error('找不到按钮：' + label);
  target.props.onClick({ currentTarget: target, target, stopPropagation() {}, preventDefault() {} });
  return target;
}
function clickExact(node, label) {
  const target = buttons(node).find((item) => textOf(item).trim() === label);
  if (!target) throw new Error('找不到按钮（精确）：' + label);
  target.props.onClick({ currentTarget: target, target, stopPropagation() {}, preventDefault() {} });
  return target;
}
function classHas(name) {
  return (item) => String(item.props && item.props.className || '').split(/\s+/).indexOf(name) >= 0;
}
function byClass(node, name) {
  return walk(node).filter(classHas(name));
}
function inputByLabel(node, label) {
  const labels = walk(node).filter((item) => item.tag === 'label' && textOf(item).indexOf(label) >= 0);
  if (!labels.length) return null;
  const field = labels[0].children ? labels[0] : null;
  return field;
}

/* ---------------- 固定数据 ---------------- */

function fixtures() {
  const now = Date.now();
  const tree = {
    ok: true,
    roots: ['output', 'scripts'],
    entries: [
      { kind: 'dir', rel: 'output', name: 'output' },
      { kind: 'dir', rel: 'output/audit', name: 'audit' },
      { kind: 'file', rel: 'output/audit/result.csv', name: 'result.csv', ext: '.csv', size: 120, viewable: true, image: false },
      { kind: 'file', rel: 'output/figures/f01.png', name: 'f01.png', ext: '.png', size: 2048, mtimeMs: 111, viewable: true, image: true },
      { kind: 'file', rel: 'output/figures/f01.tif', name: 'f01.tif', ext: '.tif', size: 4096, viewable: true, image: true },
      { kind: 'file', rel: 'output/figures/f02.png', name: 'f02.png', ext: '.png', size: 2048, viewable: true, image: true },
      { kind: 'file', rel: 'output/qa_report.json', name: 'qa_report.json', ext: '.json', size: 300, viewable: true, image: false },
      { kind: 'file', rel: 'output/report.docx', name: 'report.docx', ext: '.docx', size: 5000, viewable: true, image: false },
      { kind: 'file', rel: 'output/qc.pdf', name: 'qc.pdf', ext: '.pdf', size: 9000, viewable: true, image: false },
      { kind: 'dir', rel: 'scripts', name: 'scripts' },
      { kind: 'dir', rel: 'scripts/tools', name: 'tools' },
      { kind: 'file', rel: 'scripts/tools/app.py', name: 'app.py', ext: '.py', size: 42, viewable: true, image: false },
      { kind: 'dir', rel: 'scripts/__pycache__', name: '__pycache__' },
      { kind: 'file', rel: 'scripts/__pycache__/app.cpython-312.pyc', name: 'app.cpython-312.pyc', ext: '.pyc', size: 60, viewable: false, image: false },
    ],
    totalFiles: 10,
    totalBytes: 21707,
    truncated: false,
  };
  const state = {
    workspaces: [
      { id: 'ws-1', name: '研究 A', root: 'F:\\研究\\A', fileCount: 6, latestMtime: now },
      { id: 'ws-2', name: '研究 B', root: 'F:\\研究\\B', fileCount: 0, latestMtime: null },
    ],
    active: { id: 'ws-1', name: '研究 A', root: 'F:\\研究\\A' },
    activeError: '',
    progress: [
      { dir: 'output/audit', name: 'audit', fileCount: 1, latestMtime: now - 120000 },
      { dir: 'output/figures', name: 'figures', fileCount: 3, latestMtime: now - 2 * 3600000 },
    ],
    tree,
    config: { dataDir: '' },
  };
  return { state, tree };
}

function setFixture(kind = 'panel') {
  const { state, tree } = fixtures();
  globalThis.__DSA__ = { state: kind === 'panel' ? state : null, tree, selected: 'ws-1', width: 'wide', theme: 'light' };
}

/* ---------------- 1. 槽位与骨架 ---------------- */

setFixture();
store = new Map();
let loaded = loadClient();
check(Boolean(loaded.panel), 'client.js 能加载并注册 main 面板');
check(loaded.registered.has('sidebar.panellist:data-analysis'), '保留侧栏图标槽位');
check(loaded.registered.has('conversation.session.header.actions:data-analysis-viewer'), '保留对话头部入口槽位');
check(![...loaded.registered.keys()].some((key) => key.startsWith('conversation.chat.turnTail')), 'turnTail 槽位已删除');
check(![...loaded.registered.keys()].some((key) => key.startsWith('conversation.input.left')), '输入行下一步槽位已删除');
check(![...loaded.registered.keys()].some((key) => key.startsWith('tool.call.toolview')), '工具卡槽位已删除');

store = new Map();
let view = mount(loaded.panel, {});
let text = textOf(view);
check(text.includes('实证研究查看器'), '标题存在');
check(text.includes('研究 A') && text.includes('研究 B'), '左栏列工作区');
check(text.includes('F:\\研究\\A'), '左栏显示路径');
check(text.includes('audit') && text.includes('figures'), '目录进度按 output/ 子目录展示');
check(/audit.*1 个文件/.test(text.replace(/\s+/g, ' ')), '进度显示文件数');
check(!/闸门|运行台|裁定|复核|阶段/.test(text), '旧流水线文案已清除');
check(!buttons(view).some((item) => /^(运行|停止|重跑|裁定|采纳)/.test(textOf(item).trim())), '旧操作按钮已清除');

const root = walk(view).find((item) => item.props && item.props.className === 'dsa-root');
check(root && root.props['data-dsa-width'] === 'wide', '根节点带宽度断点');
const rail = byClass(view, 'dsa-rail');
check(rail.length === 1, '左栏存在');
const tabs = byClass(view, 'dsa-tab').map(textOf);
check(tabs.some((item) => item.includes('图')), '页签：图');
check(tabs.some((item) => item.includes('表')), '页签：表');
check(tabs.some((item) => item.includes('文档')), '页签：文档');
check(tabs.some((item) => item.includes('全部')), '页签：全部');
check(tabs.some((item) => item.includes('code')), '页签：code');

store = new Map();
view = mount(loaded.panel, {});
const images = findAllByTag(view, 'img').filter((item) => String(item.props.src || '').includes('/artifacts/raw'));
check(images.length === 2, '图页签只显示可预览图（TIFF 孪生已隐藏）', '实际 ' + images.length);
check(String(images[0].props.src).includes('path=output%2Ffigures%2Ff01.png'), '缩略图直接走 raw（无 thumb 接口）');
check(String(images[0].props.src).includes('workspaceId=ws-1'), '图片地址带 workspaceId');
check(String(images[0].props.src).includes('v=111'), '图片地址带 mtime 版本（文件更新后强制刷新）');

view = mount(loaded.panel, {});
click(view, '图');
const tiffCards = byClass(view, 'dsa-card-ext').map(textOf);
check(tiffCards.indexOf('TIF') < 0, '隐藏的 TIFF 不单独成卡');

/* ---------------- 1a2. 工作区移除入口 ---------------- */

const goneFix = fixtures();
goneFix.state.workspaces[1] = Object.assign({}, goneFix.state.workspaces[1], { fileCount: 0, missing: true });
globalThis.__DSA__ = { state: goneFix.state, tree: goneFix.tree, selected: 'ws-1', width: 'wide', theme: 'light' };
store = new Map();
const wsView = mount(loaded.panel, {});
check(byClass(wsView, 'dsa-ws-remove').length === goneFix.state.workspaces.length, '每行工作区都有移除入口（选中与否都能移除）', '实际 ' + byClass(wsView, 'dsa-ws-remove').length);
check(byClass(wsView, 'dsa-ws-row').some(classHas('missing')), '失效登记带 missing 标记');
check(textOf(wsView).includes('目录不存在'), '磁盘目录已删除的登记显示「目录不存在」');

/* ---------------- 1b. 窄屏左栏交互 ---------------- */

store = new Map();
globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, { width: 'narrow' });
let narrowView = mount(loaded.panel, {});
check(byClass(narrowView, 'dsa-rail').length === 0, '窄屏默认隐藏左栏');
const railToggle = byClass(narrowView, 'dsa-rail-toggle')[0];
check(Boolean(railToggle), '窄屏有工作区开关');
railToggle.props.onClick();
narrowView = mount(loaded.panel, {});
check(byClass(narrowView, 'dsa-rail').length === 1 && byClass(narrowView, 'dsa-rail-backdrop').length === 1, '打开左栏并出现遮罩');
byClass(narrowView, 'dsa-rail-backdrop')[0].props.onClick();
narrowView = mount(loaded.panel, {});
check(byClass(narrowView, 'dsa-rail').length === 0, '点击遮罩关闭左栏');
globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, { width: 'wide' });

/* ---------------- 2. lightbox ---------------- */

store = new Map();
view = mount(loaded.panel, {});
const pngCard = buttons(view).find((item) => String(item.props.title || '') === 'output/figures/f01.png');
check(Boolean(pngCard), '图片卡片存在');
pngCard.props.onClick({});
view = mount(loaded.panel, {});
const lightbox = byClass(view, 'dsa-lightbox');
check(lightbox.length === 1, '点击图片打开 lightbox');
const big = findAllByTag(lightbox[0], 'img').find((item) => classHas('dsa-lightbox-img')(item));
check(big && String(big.props.src).includes('artifacts/raw'), 'lightbox 展示原图');
check(byClass(view, 'dsa-lightbox-nav').length === 2, '多图时有 ←/→ 翻页');
clickExact(view, '关闭');
view = mount(loaded.panel, {});
check(byClass(view, 'dsa-lightbox').length === 0, '关闭后 lightbox 消失');

/* ---------------- 2b. 中文显示名（figure_map/manuscript 标题） ---------------- */

store = new Map();
const titledFix = fixtures();
titledFix.tree.entries.find((e) => e.rel === 'output/figures/f01.png').title = '图1 样本类别结构';
titledFix.tree.entries.find((e) => e.rel === 'output/audit/result.csv').title = '表1 审计结果';
globalThis.__DSA__ = { state: titledFix.state, tree: titledFix.tree, selected: 'ws-1', width: 'wide', theme: 'light' };
view = mount(loaded.panel, {});
const titledCard = byClass(view, 'dsa-card').find((c) => String(c.props.title || '') === 'output/figures/f01.png');
check(titledCard && textOf(titledCard).includes('图1 样本类别结构'), '图卡显示中文标题');
check(titledCard && titledCard.props.title === 'output/figures/f01.png', '卡片 tooltip 保留真实路径');
check(textOf(view).includes('f02.png'), '无标题文件退回文件名');
titledCard.props.onClick({});
view = mount(loaded.panel, {});
const lbName = byClass(view, 'dsa-lightbox-name')[0];
check(lbName && textOf(lbName).includes('图1 样本类别结构'), 'lightbox 标题显示中文');
check(lbName && lbName.props.title === 'output/figures/f01.png', 'lightbox tooltip 保留真实路径');
const dlLink = findAllByTag(view, 'a').find((a) => String(a.props.href || '').includes('download=1'));
check(dlLink && dlLink.props.download === '图1 样本类别结构.png', '下载属性用中文文件名');
clickExact(view, '关闭');
view = mount(loaded.panel, {});
click(view, '表');
view = mount(loaded.panel, {});
check(textOf(view).includes('表1 审计结果'), '表页签显示中文表题');
click(view, '全部');
view = mount(loaded.panel, {});
byClass(view, 'dsa-search-input')[0].props.onChange({ target: { value: '样本类别' } });
view = mount(loaded.panel, {});
check(byClass(view, 'dsa-card').length === 1 && textOf(view).includes('图1 样本类别结构'), '按中文图题搜索命中');
byClass(view, 'dsa-search-input')[0].props.onChange({ target: { value: '审计结果' } });
view = mount(loaded.panel, {});
check(byClass(view, 'dsa-card').length === 1 && textOf(view).includes('表1 审计结果'), '按中文表题搜索命中');
setFixture();

/* ---------------- 3. 表格与文档页签 ---------------- */

store = new Map();

const fileResp = {
  'output/audit/result.csv': { ok: true, kind: 'table', header: ['id', 'x'], rows: [['1', '2'], ['2', '3']], totalRows: 2, truncated: false },
  'output/qa_report.json': { ok: true, kind: 'json', text: '{ "error_count": 0 }' },
  'output/qc.pdf': { ok: true, kind: 'pdf' },
  'output/report.docx': { ok: true, kind: 'document' },
  'scripts/tools/app.py': { ok: true, kind: 'text', text: 'print(1)\nprint(2)' },
};

globalThis.fetch = async (url) => {
  const textUrl = String(url);
  const hit = Object.keys(fileResp).find((rel) => textUrl.includes(encodeURIComponent(rel)));
  return { ok: true, status: 200, json: async () => (hit ? fileResp[hit] : { ok: false, error: 'unexpected ' + textUrl }) };
};

view = mount(loaded.panel, {});
click(view, '表');
view = mount(loaded.panel, {});
click(view, 'result.csv');
await flush();
view = mount(loaded.panel, {});
check(textOf(view).includes('2 行 × 2 列'), 'CSV 在 lightbox 里渲染成表');
check(findAllByTag(view, 'table').length >= 1, '表格元素存在');

store = new Map();
view = mount(loaded.panel, {});
click(view, '文档');
view = mount(loaded.panel, {});
click(view, 'qa_report.json');
await flush();
view = mount(loaded.panel, {});
check(textOf(view).includes('error_count'), 'skill 报告（JSON）由通用查看器原样渲染');

store = new Map();
view = mount(loaded.panel, {});
click(view, 'code');
view = mount(loaded.panel, {});
check(textOf(view).includes('app.py'), 'code 页签有 FileTree');
check(!textOf(view).includes('__pycache__') && !textOf(view).includes('.pyc'), 'code 页签不列 __pycache__/.pyc 噪声');
click(view, 'app.py');
await flush();
view = mount(loaded.panel, {});
check(textOf(view).includes('print(1)'), '脚本按等宽文本原样展示');
check(byClass(view, 'dsa-pre').length >= 1, '使用 pre 文本视图');

/* ---------------- 4. 进度过滤 ---------------- */

store = new Map();
view = mount(loaded.panel, {});
click(view, '表');
const progressButton = buttons(view).find((item) => String(item.props.title || '') === 'output/audit');
check(Boolean(progressButton), '目录进度可点击');
progressButton.props.onClick({});
view = mount(loaded.panel, {});
check(textOf(view).includes('仅看 output/audit'), '点击目录后查看器过滤到该前缀');
check(byClass(view, 'dsa-card').length === 1, '只显示该目录的文件');

/* ---------------- 4b. 文件名筛选 ---------------- */

store = new Map();
view = mount(loaded.panel, {});
const searchInput = byClass(view, 'dsa-search-input')[0];
check(Boolean(searchInput), '查看器有文件名筛选');
searchInput.props.onChange({ target: { value: 'f02' } });
view = mount(loaded.panel, {});
check(byClass(view, 'dsa-card').length === 1 && textOf(view).includes('f02.png'), '筛选后只显示匹配文件');
check(byClass(view, 'dsa-tab').map(textOf).some((text) => /图\s+1/.test(text)), '页签计数跟随筛选');

/* ---------------- 5. 对话框 ---------------- */

store = new Map();
view = mount(loaded.panel, {});
click(view, '绑定目录');
view = mount(loaded.panel, {});
check(textOf(view).includes('绑定工作区'), '打开绑定对话框');
const dirInput = findAllByTag(byClass(view, 'dsa-modal')[0], 'input')[0];
dirInput.props.onChange({ target: { value: 'F:\\研究\\C' } });
view = mount(loaded.panel, {});
const nameInput = findAllByTag(byClass(view, 'dsa-modal')[0], 'input')[1];
nameInput.props.onChange({ target: { value: '研究 C' } });
view = mount(loaded.panel, {});
let posted = [];
globalThis.fetch = async (url, init = {}) => {
  posted.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => ({ ok: true, workspace: { id: 'ws-3', name: '研究 C', root: 'F:\\研究\\C' }, state: fixtures().state }) };
};
clickExact(view, '绑定');
await flush();
check(posted.some((call) => call.method === 'POST' && call.url.endsWith('/workspace')), '提交走 /api/workspace');
const bindCall = posted.find((call) => call.method === 'POST' && call.url.endsWith('/workspace'));
check(bindCall && bindCall.body.dir === 'F:\\研究\\C' && bindCall.body.name === '研究 C', '提交带上目录与名称');

view = mount(loaded.panel, {});
click(view, '设置');
view = mount(loaded.panel, {});
check(textOf(view).includes('dataDir'), '设置里只有 dataDir');
posted = [];
clickExact(view, '保存');
await flush();
check(posted.some((call) => call.method === 'POST' && call.url.endsWith('/config') && call.body.dataDir === ''), '保存只提交 dataDir');

/* ---------------- 6. 轮询与 follow-the-chat ---------------- */

await (async function polling() {
  store = new Map();
  globalThis.__DSA__ = {};
  const { state } = fixtures();
  const listeners = {};
  const intervals = [];
  const calls = [];
  const original = {
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    document: globalThis.document,
  };
  try {
    globalThis.document = {
      visibilityState: 'visible',
      hidden: false,
      addEventListener(type, fn) {
        (listeners[type] || (listeners[type] = [])).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners[type] || [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      },
    };
    globalThis.setInterval = (fn, delay) => {
      const id = intervals.length + 1;
      intervals.push({ id, fn, delay });
      return id;
    };
    globalThis.clearInterval = () => {};
    globalThis.__DSA_EFFECTS__ = true;
    let bound = { id: 'ws-2', name: '研究 B', root: 'F:\\研究\\B' };
    globalThis.fetch = async (url) => {
      const textUrl = String(url);
      calls.push(textUrl);
      if (textUrl.includes('/session/project')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'chat-1', workspace: bound }) };
      }
      if (textUrl.includes('/artifacts/tree')) {
        return { ok: true, status: 200, json: async () => fixtures().tree };
      }
      const match = /workspaceId=(ws-\d)/.exec(textUrl);
      const id = match ? match[1] : '';
      const active = id ? state.workspaces.filter((item) => item.id === id)[0] : state.active;
      const selected = id ? Object.assign({}, state, { active }) : state;
      return { ok: true, status: 200, json: async () => ({ ok: true, state: selected }) };
    };

    loaded = loadClient({ patch: false });
    view = mount(loaded.panel, { sessionId: 'chat-1' });
    await flush();
    await flush();
    view = mount(loaded.panel, { sessionId: 'chat-1' });
    check(calls.some((url) => url.includes('/session/project?sessionId=chat-1')), '面板向宿主查询当前会话的绑定');
    check(calls.some((url) => url.includes('/state?workspaceId=ws-2')), '自动选中会话绑定的工作区');
    const poll = intervals.find((item) => item.delay === 4000);
    check(Boolean(poll), '设置 4s 轮询');

    const count = () => calls.filter((url) => url.includes('/state') || url.includes('/artifacts/tree')).length;
    let before = count();
    globalThis.document.visibilityState = 'hidden';
    globalThis.document.hidden = true;
    poll.fn();
    await flush();
    check(count() === before, 'hidden 时轮询暂停');

    globalThis.document.visibilityState = 'visible';
    globalThis.document.hidden = false;
    before = count();
    (listeners.visibilitychange || []).forEach((fn) => fn());
    await flush();
    check(count() > before, '回到前台立即刷新');
    check(!calls.some((url) => /summary|chat\/focus|stage\/run|adjudicate|materials|recheck/.test(url)), '不再请求旧流水线接口');

    bound = { id: 'ws-1', name: '研究 A', root: 'F:\\研究\\A' };
    poll.fn();
    await flush();
    view = mount(loaded.panel, { sessionId: 'chat-1' });
    await flush();
    await flush();
    view = mount(loaded.panel, { sessionId: 'chat-1' });
    await flush();
    check(calls.some((url) => url.includes('/state?workspaceId=ws-1')), '模型改绑后面板跟到新工作区');
    const img = findAllByTag(view, 'img').find((item) => String(item.props.src || '').includes('/artifacts/raw'));
    check(img && String(img.props.src).includes('workspaceId=ws-1'), '改绑后查看器切到新工作区');
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.setInterval = original.setInterval;
    globalThis.clearInterval = original.clearInterval;
    if (original.document === undefined) delete globalThis.document;
    else globalThis.document = original.document;
    globalThis.__DSA_EFFECTS__ = false;
  }
})();

/* ---------------- 7. 源码静态断言 ---------------- */

const source = fs.readFileSync(CLIENT, 'utf8');
check(!/data_analysis_artifacts|data_analysis_run_stage|data_analysis_status/.test(source), '不再引用旧工具名');
check(!/artifactThumbUrl|artifacts\/thumb/.test(source), '不再请求缩略图接口');
check(!/reportFocus|chat\/focus|summaryHub/.test(source), '已删除 focus 上报与共享摘要轮询');
check(/POLL_MS = 4000/.test(source), '轮询间隔硬编码 4s');
check(!/WorkbenchTail|NextStepControl|RegistryCard|MaterialsDialog|AdjudicateDialog/.test(source), '旧结构化组件已删除');
const cssStart = source.indexOf("'.dsa-cmp{");
const chatCss = source.slice(cssStart, source.indexOf('\n      ];', cssStart));
check(!/var\(--dsa-/.test(chatCss), '对话头部按钮不依赖 .dsa-root 内的 CSS 令牌');
check(/font-size:12px/.test(chatCss) && /border-radius:6px/.test(chatCss), '对话头部按钮字号/圆角使用字面量');

console.log('');
if (failures) {
  console.log('✗ ' + failures + ' 项失败');
  process.exit(1);
}
console.log('✓ 全部通过（' + passed + ' 项）');
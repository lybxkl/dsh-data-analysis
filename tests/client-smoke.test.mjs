/**
 * client.js 冒烟测试：不开浏览器，直接把面板渲染成树。
 *
 * 为什么需要它：client.js 是单文件、零构建、靠宿主给的 React 运行；host 侧改动要重启 DSH 才生效，
 * 面板写错一个标识符只有真机刷新才炸。这里用一个极小的「假 React」把组件渲染成字符串树，
 * 覆盖环境闸门、主界面、各个弹窗与窄屏/暗色，能在提交前抓住 ReferenceError 与明显的渲染崩溃。
 *
 * 跑法：node tests/client-smoke.test.mjs
 * 注意：它会按固定文案替换 client.js 里几行 useState 的初值（只在内存里改，不落盘）。
 * 面板那几行初始化被改写，本测试会直接报「结构变了」，提醒同步更新。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, '..', 'client.js');

/* ---------------- 极简 React ---------------- */

let current = null;
const instances = [];
let dirty = false;
// hook 状态按「组件位置 + hook 序号」存起来，跨多次 re-render 保真——
// 否则点一下按钮 setState 之后，下一轮渲染又把状态重置回初值，交互根本测不出来
let store = new Map();
let cmpSeq = 0;

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
  // 默认不跑 effect：绝大多数场景只看首屏排版，跑起来会真去 fetch。
  // 需要测「挂载后拉数据」的交互（产物中心）时，把 globalThis.__DSA_EFFECTS__ 打开并自带 fetch 桩。
  useEffect(fn) {
    if (!globalThis.__DSA_EFFECTS__) return;
    const { inst, index } = slot();
    const key = 'fx:' + hookKey(inst, index);
    if (store.has(key)) return;
    store.set(key, true);
    fn();
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

function isElement(value) {
  return Boolean(value) && typeof value === 'object' && value.type !== undefined;
}

function expand(node, depth = 0) {
  if (depth > 80) throw new Error('渲染层数过深，疑似循环');
  if (Array.isArray(node)) return node.map((item) => expand(item, depth + 1));
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
  if (!isElement(node)) return { text: String(node) };
  const { type, props } = node;
  if (typeof type === 'function') {
    cmpSeq += 1;
    const inst = { fn: type, key: cmpSeq, slots: {}, i: 0, changed: false };
    instances.push(inst);
    const prev = current;
    current = inst;
    let out;
    try {
      out = type(props);
    } finally {
      current = prev;
    }
    if (inst.changed) dirty = true;
    return expand(out, depth + 1);
  }
  return { tag: type, props, children: (props.children || []).map((item) => expand(item, depth + 1)).filter(Boolean) };
}

function renderRoot(Component, props) {
  instances.length = 0;
  store = new Map();
  for (let pass = 0; pass < 5; pass += 1) {
    dirty = false;
    current = null;
    cmpSeq = 0;
    const tree = expand(React.createElement(Component, props));
    if (!dirty) return tree;
  }
  cmpSeq = 0;
  return expand(React.createElement(Component, props));
}

/** 可交互的挂载：保留 hook 状态，能点按钮并等 re-render 收敛。 */
function mountPanel(props = {}) {
  instances.length = 0;
  store = new Map();
  const step = () => {
    dirty = false;
    current = null;
    cmpSeq = 0;
    return expand(React.createElement(PANEL, props));
  };
  let tree = step();
  for (let pass = 0; pass < 6 && dirty; pass += 1) tree = step();
  return {
    tree: () => tree,
    text: () => textOf(tree),
    /** 异步数据回来后（flush 之后）重新渲染一次，拿到新树 */
    render() {
      for (let pass = 0; pass < 6; pass += 1) {
        tree = step();
        if (!dirty) break;
      }
      return tree;
    },
    buttons: () => findAllByClass(tree, 'dsa-btn').map((item) => textOf(item).trim()).filter(Boolean),
    click(label) {
      const hit = findAllByClass(tree, 'dsa-btn').find((item) => textOf(item).trim() === label);
      if (!hit) return false;
      hit.props.onClick();
      for (let pass = 0; pass < 6; pass += 1) {
        tree = step();
        if (!dirty) break;
      }
      return true;
    },
    /** 点任意节点（缩略图卡片、翻页按钮……）：click() 只管 .dsa-btn */
    tap(node) {
      if (!node || typeof node.props.onClick !== 'function') return false;
      node.props.onClick();
      for (let pass = 0; pass < 6; pass += 1) {
        tree = step();
        if (!dirty) break;
      }
      return true;
    },
  };
}

function textOf(tree) {
  if (!tree) return '';
  if (tree.text !== undefined) return tree.text + ' ';
  if (!tree.children) return '';
  return tree.children.map(textOf).join('');
}

function hasClass(tree, name) {
  if (!tree || !tree.props) return false;
  const className = tree.props.className;
  if (typeof className === 'string' && className.split(/\s+/).includes(name)) return true;
  return (tree.children || []).some((child) => hasClass(child, name));
}

function findByClass(tree, name) {
  if (!tree || !tree.props) return null;
  const className = tree.props.className;
  if (typeof className === 'string' && className.split(/\s+/).includes(name)) return tree;
  for (const child of tree.children || []) {
    const hit = findByClass(child, name);
    if (hit) return hit;
  }
  return null;
}

function findAllByClass(tree, name, out = []) {
  if (!tree || !tree.props) return out;
  const className = tree.props.className;
  if (typeof className === 'string' && className.split(/\s+/).includes(name)) out.push(tree);
  for (const child of tree.children || []) findAllByClass(child, name, out);
  return out;
}

/* ---------------- 加载 client.js ---------------- */

const PATCHES = [
  ['var snapState = useState(null);', 'var snapState = useState(globalThis.__DSA__.snap);'],
  ['var preflightState = useState(null);', 'var preflightState = useState(globalThis.__DSA__.pre);'],
  ['var loadingState = useState(true);', 'var loadingState = useState(globalThis.__DSA__.loading);'],
  ['var dialogState = useState(null);', 'var dialogState = useState(globalThis.__DSA__.dialog);'],
  ['var widthState = useState(\'wide\');', 'var widthState = useState(globalThis.__DSA__.width);'],
  ['var themeState = useState(\'light\');', 'var themeState = useState(globalThis.__DSA__.theme);'],
  ['var selectedState = useState(\'scope\');', 'var selectedState = useState(globalThis.__DSA__.selected);'],
  // 手稿骨架的交互态：生成中 / 结果提示 / 重排确认条
  ['var manBusyState = useState(\'\');', 'var manBusyState = useState(globalThis.__DSA__.manBusy || \'\');'],
  ['var manNoteState = useState(\'\');', 'var manNoteState = useState(globalThis.__DSA__.manNote || \'\');'],
  ['var manAskState = useState(false);', 'var manAskState = useState(Boolean(globalThis.__DSA__.manAsk));'],
  // 输入行零件读的是 /summary；这里没有服务端，直接把摘要种进它的 useState
  ['var stateTuple = useState(null);', 'var stateTuple = useState(globalThis.__DSA__.wb);'],
];

function loadPanel() {
  let source = fs.readFileSync(CLIENT, 'utf8');
  for (const [from, to] of PATCHES) {
    if (!source.includes(from)) {
      throw new Error('client.js 的结构变了：找不到 ' + from + '，请更新本测试的 PATCHES');
    }
  }
  for (const [from, to] of PATCHES) source = source.replace(from, to);

  let captured = null;
  const noop = () => {};
  const windowStub = {
    __ModuleLoader__: {
      load(def) {
        captured = def;
      },
    },
    innerWidth: 1440,
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  };
  const documentStub = {
    createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, remove: noop }),
    createTextNode: () => ({}),
    head: { appendChild: noop },
    body: { appendChild: noop, classList: { add: noop, remove: noop } },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
  };
  const sandbox = new Function('window', 'document', 'globalThis', source);
  sandbox(windowStub, documentStub, globalThis);
  if (!captured || typeof captured.factory !== 'function') throw new Error('client.js 没有调用 __ModuleLoader__.load');

  const exported = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('client.js 请求了宿主模块：' + name);
  });

  // apply 只执行「注册型」effect；装样式那类需要 DOM，失败忽略
  const registered = new Map();
  exported.apply({
    // 宿主服务：默认一个都没有（老断言靠「会话服务不可用」也能跑），
    // 需要测会话桥的场景自己往 globalThis.__DSA_SVC__ 里塞 sessions / uiWorkspace
    get(name) {
      const table = globalThis.__DSA_SVC__ || {};
      return table[name] || null;
    },
    effect(fn) {
      try {
        fn();
      } catch (error) {
        /* 真实环境里这些 effect 由宿主驱动 */
      }
    },
    slots: {
      inject(name, fn) {
        fn();
        return () => {};
      },
      register(def, component) {
        registered.set(def && def.name, component);
        return () => {};
      },
    },
  });
  const panel = registered.get('main');
  if (!panel) throw new Error('没有注册 main 面板');
  return { panel, slots: [...registered.keys()], registered };
}

/* ---------------- 夹具 ---------------- */

function gate(status, index) {
  return {
    id: 'g' + index,
    label: '闸门 ' + (index + 1),
    level: index % 3 === 0 ? 'error' : index % 3 === 1 ? 'warn' : 'info',
    status,
    detail: '测试用闸门明细',
  };
}

function stage(id, index, name, status, gateStatuses) {
  return {
    id,
    index,
    name,
    short: name.slice(0, 2),
    purpose: name + '的用途说明',
    script: 'x.py',
    args: [],
    steps: [],
    status,
    gates: (gateStatuses || ['pass']).map((status2, i) => gate(status2, i)),
    artifacts: [{ label: '产物', rel: 'output/' + id + '/x.csv', exists: true, size: 128 }],
    lastRun: index === 1 ? { id: 'run-1', status: 'ok', startedAt: '2026-11-12T09:00:00Z', endedAt: '2026-11-12T09:01:00Z' } : null,
  };
}

const STAGES = [
  stage('scope', 0, '范围与口径', 'done', ['pass']),
  stage('audit', 1, '资料审计', 'review', ['pass', 'unjudged', 'pass']),
  stage('coding', 2, '编码与抽取', 'blocked', ['pass', 'fail']),
  stage('dataset', 3, '数据集', 'todo', []),
  stage('stats', 4, '统计分析', 'todo', []),
];

const SNAP = {
  ok: true,
  // 新版宿主一定带这个键（值可以是 null = 还没有 v2 注册表）；
  // 旧宿主快照里没有这个键，面板要据此降级成「重启 DSH 后可用」
  registry: null,
  config: { pythonPath: 'python', skillRoot: 'C:/skill', modelMode: 'follow', maxRuns: 60, maxLogLines: 800, dataDir: '', modelProvider: '', modelId: '', assistantMaxTokens: 1800 },
  skill: { ok: true, version: '9.9.9', sha256: 'abcdef1234', scripts: 12, root: 'C:/skill' },
  python: { ok: true, version: '3.11.5', executable: 'C:/Python311/python.exe' },
  projects: [
    { id: 'p1', name: '测试项目', path: 'C:/work/p1', updatedAt: '2026-11-12T09:00:00Z' },
    { id: 'p2', name: '另一个项目', path: 'C:/work/p2', updatedAt: '2026-11-10T09:00:00Z' },
  ],
  active: { id: 'p1', name: '测试项目', path: 'C:/work/p1', scope: { note: '研究范围一句话' }, sessionId: '', createdAt: '2026-11-01T00:00:00Z', skillDrift: false },
  error: '',
  preflight: { status: 'pass', checkedAt: '2026-11-12T10:00:00Z', checks: [] },
  stages: STAGES,
  summary: { done: 2, blocked: 1, review: 1, todo: 1, running: 0 },
  totals: { pass: 6, fail: 1, unjudged: 2 },
  artifacts: {
    figures: { rows: [], summary: { count: 0 } },
    corpus: { totalFiles: 223, validFiles: 220, uniqueValidFiles: 219, unreadableFiles: 1, truncated: 0, fingerprint: { files: 223, bytes: 36055673 } },
    qa: [],
    verify: [],
    models: null,
    flow: [],
  },
  runs: [
    { id: 'run-1', stageId: 'audit', status: 'ok', startedAt: '2026-11-12T09:00:00Z', endedAt: '2026-11-12T09:01:00Z', exitCode: 0 },
    { id: 'run-2', stageId: 'coding', status: 'failed', startedAt: '2026-11-12T09:05:00Z', endedAt: '2026-11-12T09:06:00Z', exitCode: 1 },
  ],
  adjudications: [{ stageId: 'audit', gateId: 'audit-summary', status: 'pass', at: '2026-11-12T09:10:00Z', note: '人看过' }],
  activeRuns: {},
  materials: {
    platform: 'win32',
    isWindows: true,
    sources: [
      { id: 'src_1', label: '刑事判例', path: 'F:/cases/criminal', files: 2907, realFiles: 2907, bytesText: '1.2 GB', byChannel: { read: 2907, vision: 0, convert: 0, none: 0, junk: 4 }, usedBy: [{ project: '测试项目', projectPath: 'C:/work/p1', as: '刑事' }], scannedAt: '2026-11-12T08:00:00Z' },
    ],
    mounts: [
      { as: '刑事', sourceId: 'src_1', sourceLabel: '刑事判例', entry: '', target: 'F:/cases/criminal', status: 'ok', mode: 'junction', resolved: 'F:/cases/criminal', detail: '挂载指向 F:/cases/criminal' },
      { as: '民事', sourceId: 'src_1', sourceLabel: '刑事判例', entry: '', target: 'F:/cases/civil', status: 'missing-target', mode: 'junction', resolved: 'F:/cases/civil', detail: '源目录不见了' },
    ],
    derived: [],
    entries: [{ name: '刑事', mode: 'junction', target: 'F:/cases/criminal', entries: 3 }],
  },
  layout: { width: 'wide' },
};

const PRE_FAIL = {
  ok: false,
  status: 'fail',
  checkedAt: '2026-11-12T10:00:00Z',
  platform: 'win32',
  isWindows: true,
  python: '',
  pythonCommand: '',
  skill: { ok: false, version: '', sha256: '', scripts: 0, root: '' },
  checks: [
    { id: 'skill', label: '技能包', status: 'fail', detail: '没找到技能包', hint: '在设置里填 skillRoot' },
    { id: 'python', label: 'Python', status: 'fail', detail: '试过 3 个命令都跑不起来', hint: '装 Python 3' },
    { id: 'modules', label: 'Python 依赖', status: 'unjudged', detail: 'Python 不可用，无从检查依赖', hint: '' },
  ],
};

const PRE_WARN = {
  ok: true,
  status: 'warn',
  checkedAt: '2026-11-12T10:00:00Z',
  platform: 'darwin',
  isWindows: false,
  python: '3.11.5',
  pythonCommand: 'python3',
  skill: { ok: true, version: '9.9.9', sha256: 'abc', scripts: 12, root: '/Users/x/skill' },
  checks: [
    { id: 'skill', label: '技能包', status: 'pass', detail: 'SKILL.md 9.9.9', hint: '' },
    { id: 'word', label: 'Word→PDF', status: 'unjudged', detail: '当前是 darwin：没有 Microsoft Word COM，这一步不适用', hint: 'soffice --headless --convert-to pdf' },
    { id: 'word', label: 'Word→PDF', status: 'warn', detail: '缺 pywin32', hint: 'pip install pywin32' },
  ],
};

/* ---------------- 断言 ---------------- */

let failedCount = 0;
function check(ok, label, detail) {
  if (ok) process.stdout.write('  ✓ ' + label + (detail ? ' — ' + detail : '') + '\n');
  else {
    failedCount += 1;
    process.stdout.write('  ✗ ' + label + (detail ? ' — ' + detail : '') + '\n');
  }
}

function scenario(name, fixture, assert) {
  process.stdout.write('\n' + name + '\n');
  globalThis.__DSA__ = Object.assign(
    { snap: SNAP, pre: SNAP.preflight, loading: false, dialog: null, width: 'wide', theme: 'light', selected: 'scope' },
    fixture || {},
  );
  let tree;
  try {
    tree = renderRoot(PANEL, {});
  } catch (error) {
    check(false, '渲染崩溃', String(error && error.stack ? error.stack.split('\n').slice(0, 2).join(' | ') : error));
    return;
  }
  try {
    assert(tree, textOf(tree));
  } catch (error) {
    check(false, '断言抛错', String((error && error.message) || error));
  }
}

process.stdout.write('\nclient.js 冒烟测试\n');

let PANEL = null;
let REGISTERED = new Map();
try {
  const loaded = loadPanel();
  PANEL = loaded.panel;
  REGISTERED = loaded.registered;
  check(true, 'client.js 能加载并注册面板', loaded.slots.join('、'));
} catch (error) {
  check(false, 'client.js 加载失败', String((error && error.message) || error));
  process.exit(1);
}

/* 1. 环境不齐：闸门 */
scenario('环境不齐', { pre: PRE_FAIL }, (tree, text) => {
  check(text.includes('环境还没就绪'), '显示环境闸门');
  check(text.includes('让 AI 装好环境'), '给出「让 AI 装好环境」');
  check(text.includes('手动配置'), '给出「手动配置」');
  check(text.includes('技能包'), '列出卡住的项目');
  check(!hasClass(tree, 'dsa-body'), '不渲染工作台主体');
  check(hasClass(tree, 'dsa-top'), '顶栏保留');
});

/* 2. 环境齐全：主界面 */
scenario('环境齐全', {}, (tree, text) => {
  check(!text.includes('环境还没就绪'), '闸门不出现');
  check(hasClass(tree, 'dsa-body'), '渲染工作台主体');
  check(text.includes('范围与口径'), '阶段栏有阶段');
  check(text.includes('测试项目'), '顶栏显示项目名');
  check(text.includes('资料审计'), '顶栏或阶段栏有审计');
  check(hasClass(tree, 'dsa-rail'), '左阶段栏存在');
  check(hasClass(tree, 'dsa-main'), '中栏存在');
  check(hasClass(tree, 'dsa-side'), '右运行台存在');
  // 三态圆点不能画错：blocked 的阶段必须是 err
  const rail = findByClass(tree, 'dsa-rail');
  const railText = textOf(rail);
  check(railText.includes('范围'), '阶段栏渲染出阶段名');
  // 项目是比阶段更高一层的概念：左栏顶部要能看到项目列表，当前那个要标出来
  const projRows = findAllByClass(tree, 'dsa-proj');
  check(projRows.length === 2, '左栏顶部列出全部项目');
  const selRows = findAllByClass(tree, 'dsa-proj').filter((row) => String(row.props.className).includes('sel'));
  check(selRows.length === 1, '只有一个项目被标为当前');
  check(textOf(selRows[0]).includes('测试项目'), '当前项目是选中那个');
  check(railText.includes('另一个项目'), '其他项目也可见，能直接点着切');
  check(railText.includes('+ 新建') && railText.includes('打开…'), '项目区带新建/打开入口');
  // 项目 = 目录 + 它那条研究对话：列表里必须能看见、点得进，不能只给「切项目」
  const projChats = findAllByClass(tree, 'dsa-proj-chat');
  check(projChats.length === 2, '每个项目行都带一条研究对话入口');
  check(textOf(projChats[0]).includes('研究对话'), '入口写的是「研究对话」');
  check(projChats.every((row) => !String(row.props.className).includes('bound')), '没有绑定时不谎报「已绑定」');
  check(projChats.every((row) => Boolean(findByClass(row, 'dsa-proj-chat-go'))), '入口带箭头（看得出是跳转）');
  check(projChats.every((row) => String(row.props.title || '').length > 0), '每行都有悬停说明');
  // 方向 C：hero 卡 + KPI 条 + 「资料/阶段」独立滚动容器（项目再多也不许把它们挤走）
  check(hasClass(tree, 'dsa-hero'), '主区顶部有 hero 卡');
  const kpis = findAllByClass(tree, 'dsa-kpi');
  check(kpis.length === 5, 'KPI 条是 5 个数，实际 ' + kpis.length);
  check(textOf(findByClass(tree, 'dsa-kpis')).includes('有效语料'), 'KPI 里有有效语料');
  check(hasClass(tree, 'dsa-logo'), '顶栏有品牌标');
  const railBody = findByClass(tree, 'dsa-rail-body');
  check(Boolean(railBody), '资料与阶段放在独立滚动容器里');
  check(findAllByClass(railBody, 'dsa-stage').length >= 6, '阶段都排在这个容器里');
  check(!findByClass(tree, 'dsa-proj-more'), '不再用「还有 N 个…」把项目藏起来');
});

/* 2b. 每个项目那条会话：绑过的写「已绑定」，没绑的不许写成一样 */
scenario(
  '项目会话状态',
  {
    snap: Object.assign({}, SNAP, {
      projects: [
        { id: 'p1', name: '测试项目', path: 'C:/work/p1', exists: true, sessionId: 's1' },
        { id: 'p2', name: '另一个项目', path: 'C:/work/p2', exists: true, sessionId: '' },
        { id: 'p3', name: '老项目', path: 'C:/work/p3', exists: false, sessionId: 's3' },
      ],
    }),
  },
  (tree) => {
    const rows = findAllByClass(tree, 'dsa-proj-chat');
    check(rows.length === 3, '三个项目各一条会话入口');
    check(String(rows[0].props.className).includes('bound'), '绑过会话的项目标成 bound');
    check(textOf(rows[0]).includes('已绑定'), '状态写「已绑定」');
    check(String(rows[0].props.title).includes('s1'), '悬停能看到会话 id');
    check(!String(rows[1].props.className).includes('bound') && textOf(rows[1]).includes('还没有'), '没绑的写「还没有」');
    check(rows[2].props.disabled === true, '目录不见的项目入口不可点');
    check(textOf(rows[2]).includes('目录不见了'), '并说明为什么点不了');
  },
);

/* 3. 自检未跑完 / macOS 只有 warn 与 unjudged：不拦 */
scenario('自检为空', { pre: null }, (tree, text) => {
  check(!text.includes('环境还没就绪'), '不误拦');
  check(hasClass(tree, 'dsa-body'), '正常渲染');
});
scenario('macOS warn + unjudged', { pre: PRE_WARN, snap: Object.assign({}, SNAP, { preflight: PRE_WARN }) }, (tree, text) => {
  check(!text.includes('环境还没就绪'), 'warn/unjudged 不拦（Mac 没有 Word COM）');
  check(hasClass(tree, 'dsa-body'), '正常渲染');
});

/* 4. 没有项目 */
scenario('没有项目', { snap: Object.assign({}, SNAP, { active: null, stages: [] }) }, (tree, text) => {
  check(!text.includes('环境还没就绪'), '不误拦');
  check(text.includes('新建项目') || text.includes('打开项目'), '给出建/开项目的入口');
});

/* 5. 窄屏 / 暗色 */
scenario('窄屏', { width: 'narrow' }, (tree, text) => {
  check(hasClass(tree, 'dsa-body'), '窄屏仍渲染主体');
  const root = tree;
  check(root && root.props && root.props['data-dsa-width'] === 'narrow', '根节点带窄屏标记');
});
scenario('暗色', { theme: 'dark' }, (tree) => {
  check(tree && tree.props && tree.props['data-dsa-theme'] === 'dark', '根节点带暗色标记');
});

/* 6. 八个弹窗都能开（用真实形状的入参，别拿半截数据骗自己） */
const dialogFixtures = {
  create: { kind: 'create' },
  open: { kind: 'open' },
  draft: { kind: 'draft', task: 'scope' },
  settings: { kind: 'settings' },
  materials: { kind: 'materials' },
  adjudicate: { kind: 'adjudicate', stage: STAGES[1], gate: STAGES[1].gates[1] },
  patch: {
    kind: 'patch',
    issue: {
      id: 'RC-001',
      severity: 'error',
      where: 'output/dataset/analysis.csv:12',
      claim: 'in_analysis 与图注 N 不一致',
      evidence: '12 vs 11',
      fix_kind: 'edit-code',
      patch: { path: 'scripts/make_dataset.py', baseHash: 'sha256:abcdef0123456789', content: 'import pandas as pd\nprint(1)\n' },
    },
  },
  forget: { kind: 'forget', project: { id: 'p1', name: '环境资源犯罪裁判文书实证分析', path: 'F:\\测试文件\\spss_analysis' } },
  artifacts: { kind: 'artifacts' },
};

for (const [kind, fixture] of Object.entries(dialogFixtures)) {
  scenario('弹窗：' + kind, { dialog: fixture }, (tree) => {
    check(Boolean(findByClass(tree, 'dsa-modal')), kind + ' 弹窗渲染出来了');
    check(hasClass(tree, 'dsa-body') || textOf(tree).includes('环境还没就绪'), '弹窗开着时底层仍在');
  });
}

/* 6a. 移除项目：必须二次确认（勾选之后「移除」才可点） */
scenario('弹窗：移除项目要二次确认', { dialog: dialogFixtures.forget }, (tree, text) => {
  check(Boolean(findByClass(tree, 'dsa-modal')), '移除弹窗渲染出来了');
  check(text.includes('一个都不会删'), '说清磁盘上的文件不动');
  check(Boolean(findByClass(tree, 'dsa-ack')), '有勾选确认那一行');
  const danger = findAllByClass(tree, 'dsa-btn').filter((node) => node.props && node.props.disabled);
  check(danger.length > 0, '没勾选时确认键是禁用的');
  const confirms = findAllByClass(tree, 'dsa-btn').filter((node) =>
    (node.children || []).some((child) => child && child.text === '移除'),
  );
  check(confirms.length === 1, '按钮文案就叫「移除」，不用「确认」混淆');
});

/* 6a-2. 新建/打开项目：路径旁边要有「选择…」，不能逼用户去资源管理器复制路径 */
for (const [kind, label] of [
  ['create', '新建项目'],
  ['open', '打开项目'],
]) {
  scenario('弹窗：' + label + '能选文件夹', { dialog: { kind } }, (tree, text) => {
    check(Boolean(findByClass(tree, 'dsa-input-row')), label + '的路径字段是「输入框 + 选择」一行');
    const picks = findAllByClass(tree, 'dsa-btn').filter((node) =>
      (node.children || []).some((child) => child && child.text === '选择…'),
    );
    check(picks.length === 1, '有一个「选择…」按钮');
    check(text.includes('项目目录') || text.includes('材料目录'), '路径字段的标签还在');
    // 填了一半的路径不能被一次误点清空：表单类弹窗不跟着点空白关
    const mask = findByClass(tree, 'dsa-mask');
    check(Boolean(mask) && !mask.props.onMouseDown, label + '不点空白关（有输入要保护）');
  });
}

/* 6b. 产物中心：弹窗打开时先给「正在读」，不是白屏 */
scenario('弹窗：产物中心', { dialog: { kind: 'artifacts' } }, (tree, text) => {
  check(Boolean(findByClass(tree, 'dsa-modal')), '产物中心渲染出来了');
  check(text.includes('产物中心'), '标题就是「产物中心」');
  check(text.includes('正在读') || text.includes('还没有产物'), '先给一句话，不留白屏');
  const mask = findByClass(tree, 'dsa-mask');
  check(Boolean(mask) && typeof mask.props.onMouseDown === 'function', '产物中心点空白处能关');
});

/* 6b-2. 宿主还没重启（快照里根本没有 registry 这个键）：不许发注定 404 的请求，也不许只报一句看不懂的错 */const STALE_SNAP = Object.assign({}, SNAP);
delete STALE_SNAP.registry;

scenario('旧宿主：产物中心说清要重启', { snap: STALE_SNAP, dialog: { kind: 'artifacts' } }, (tree, text) => {
  check(Boolean(findByClass(tree, 'dsa-modal')), '弹窗还是能打开');
  check(text.includes('重启 DSH'), '直接告诉用户重启 DSH');
  check(!text.includes('正在读'), '不假装在读文件');
  check(!/未知接口|404/.test(text), '不把 404 原样甩给用户');
});

scenario('旧宿主：契约卡不留空白', { snap: STALE_SNAP }, (tree, text) => {
  check(text.includes('契约卡需要新版宿主'), '契约卡位置给说明，而不是静默消失');
  check(text.includes('重启 DSH'), '说明里带动作');
});

/* 6c. 契约卡：有注册表看计数，没有注册表给迁移入口 */
const REGISTRY_CARD = {
  legacy: false,
  counts: { datasets: 2, models: 4, artifacts: 46, claims: 3, errors: 0, warnings: 2 },
  datasets: [{ id: 'analysis', rows: 388, columns: 50, inAnalysis: 381, confirmed: false, unit: 'defendant', title: '分析宽表' }],
  models: [{ id: 'M1', estimator: 'ols', outcome: 'prison_months', n: 361 }],
  artifacts: [],
  claims: [],
  sweep: { outcomes: 4, estimated: 4, undecided: 0 },
  issues: [{ severity: 'warn', message: '2 张表直接贴了原表' }],
  files: {},
  cells: { counts: { pass: 0, noise: 0, missing: 0 } },
  hints: [],
};

scenario('契约卡：有注册表', { snap: Object.assign({}, SNAP, { registry: REGISTRY_CARD }) }, (tree, text) => {
  check(Boolean(findByClass(tree, 'dsa-reg-card')), '契约卡渲染出来了');
  check(text.includes('analysis') && text.includes('M1'), '数据集与模型都列了名字');
  check(text.includes('待核 2'), '把待核项数摆出来');
  check(text.includes('产物中心'), '有产物中心入口');
  check(text.includes('2 张表直接贴了原表'), '把第一条问题原样说出来');
});

scenario(
  '契约卡：还没有 v2 注册表',
  {
    snap: Object.assign({}, SNAP, {
      registry: { legacy: true, counts: { datasets: 0, models: 0, artifacts: 0, claims: 0, errors: 0, warnings: 0 }, datasets: [], models: [], artifacts: [], claims: [], sweep: null, issues: [], hints: [] },
    }),
  },
  (tree, text) => {
    check(Boolean(findByClass(tree, 'dsa-reg-card')), '老项目也有契约卡');
    check(text.includes('采纳现有产物'), '给「采纳现有产物」入口，而不是空白');
    check(text.includes('判不了'), '说清「没确认之前闸门只判判不了」');
  },
);

/* 6b. 弹窗数据过期（闸门/问题已不存在）时不许崩 */
scenario('弹窗：拍板数据过期', { dialog: { kind: 'adjudicate' } }, (tree, text) => {
  check(Boolean(findByClass(tree, 'dsa-modal')), '仍然渲染出一个弹窗');
  check(text.includes('不在当前项目里') || text.includes('关掉'), '把「闸门没了」说清楚，而不是白屏');
});
scenario('弹窗：补丁数据过期', { dialog: { kind: 'patch' } }, (tree) => {
  check(Boolean(findByClass(tree, 'dsa-modal')), '补丁弹窗空数据也能渲染');
});

/* 7. 材料库弹窗在 macOS 下不能出现「目录联接」的 Windows 措辞 */
scenario(
  '材料库（macOS）',
  {
    dialog: { kind: 'materials' },
    snap: Object.assign({}, SNAP, {
      materials: Object.assign({}, SNAP.materials, { platform: 'darwin', isWindows: false }),
    }),
  },
  (tree, text) => {
    check(text.includes('材料'), '材料库弹窗有内容');
    check(text.includes('镜像目录'), 'macOS 文案提到镜像目录');
    check(!text.includes('目录联接（macOS'), '没有把 Mac 错写成联接');
  },
);

/* 7b. 材料库：转码已交给会话，面板上不该再出现转码按钮；识图也不再是「一键跑」 */
scenario(
  '材料库（交给会话）',
  { dialog: { kind: 'materials' }, snap: SNAP },
  (tree, text) => {
    check(text.includes('交给会话处理'), '有「交给会话处理」这块');
    check(text.includes('让 AI 处理这些材料'), '有「让 AI 处理这些材料」按钮');
    check(!text.includes('旧版 Office 转码'), '没有旧版 Office 转码块');
    check(!text.includes('开始转码'), '没有「开始转码」按钮');
    check(!text.includes('开始识别'), '识图不再有「开始识别」按钮（跑不跑由会话决定）');
    check(!text.includes('undefined'), '没有 undefined 漏到界面上');
    const mask = findByClass(tree, 'dsa-mask');
    check(Boolean(mask) && typeof mask.props.onMouseDown === 'function', '材料库点空白处能关');
  },
);

/* 7b. 手稿骨架：第 7 阶段的输入文件脚本造不出来，面板要给它一条入口 */
const MANUSCRIPT_STAGES = STAGES.concat([
  stage('figures', 5, '出版级图表', 'todo', []),
  stage('manuscript', 6, '文稿组装', 'todo', []),
  stage('qa', 7, '终检与复核', 'todo', []),
]);
scenario(
  '手稿骨架：还没有 manuscript.json',
  {
    selected: 'manuscript',
    snap: Object.assign({}, SNAP, {
      stages: MANUSCRIPT_STAGES,
      artifacts: Object.assign({}, SNAP.artifacts, { manuscriptSpec: { exists: false } }),
    }),
  },
  (tree, text) => {
    check(text.includes('还没有 manuscript.json'), '说清缺什么');
    check(text.includes('生成手稿骨架'), '给「生成手稿骨架」按钮');
    check(!text.includes('让 AI 写成正文'), '没有骨架时不给改稿按钮');
    check(!text.includes('undefined'), '没有 undefined 漏到界面上');
  },
);
scenario(
  '手稿骨架：结构在但正文还空着',
  {
    selected: 'manuscript',
    snap: Object.assign({}, SNAP, {
      stages: MANUSCRIPT_STAGES,
      artifacts: Object.assign({}, SNAP.artifacts, {
        manuscriptSpec: { exists: true, blocks: 7, figures: 3, tables: 1, placeholders: 2 },
      }),
    }),
  },
  (tree, text) => {
    check(text.includes('manuscript.json 已就绪'), '说清现状');
    check(text.includes('待补 2 段'), '把待补段落数摆出来');
    check(text.includes('让 AI 写成正文'), '给「让 AI 写成正文」按钮');
    check(text.includes('重排骨架'), '已有文件时按钮改成重排');
    check(!text.includes('undefined'), '没有 undefined 漏到界面上');
  },
);

scenario(
  '手稿骨架：宿主还是旧版，没有这个字段',
  {
    selected: 'manuscript',
    snap: Object.assign({}, SNAP, {
      stages: MANUSCRIPT_STAGES,
      artifacts: Object.assign({}, SNAP.artifacts),
    }),
  },
  (tree, text) => {
    check(text.includes('宿主还没有提供手稿骨架的接口'), '如实说宿主版本旧');
    check(!text.includes('生成手稿骨架'), '不谎报可以生成');
    check(!text.includes('还没有 manuscript.json'), '不谎报文件不存在');
  },
);
scenario(
  '手稿骨架：计数字段缺失也不漏 undefined',
  {
    selected: 'manuscript',
    snap: Object.assign({}, SNAP, {
      stages: MANUSCRIPT_STAGES,
      artifacts: Object.assign({}, SNAP.artifacts, { manuscriptSpec: { exists: true } }),
    }),
  },
  (tree, text) => {
    check(text.includes('块 0'), '缺计数按 0 显示');
    check(!text.includes('undefined'), '没有 undefined 漏到界面上');
  },
);
scenario(
  '手稿骨架：重排要先确认',
  {
    selected: 'manuscript',
    manAsk: true,
    snap: Object.assign({}, SNAP, {
      stages: MANUSCRIPT_STAGES,
      artifacts: Object.assign({}, SNAP.artifacts, {
        manuscriptSpec: { exists: true, blocks: 14, figures: 3, tables: 1, placeholders: 5 },
      }),
    }),
  },
  (tree, text) => {
    check(text.includes('都会被覆盖'), '确认条说清会覆盖什么');
    check(text.includes('确认重排') && text.includes('取消'), '确认条有确认与取消');
    check(text.includes('manuscript.json.bak-'), '说明会先备份');
    check(!text.includes('undefined'), '没有 undefined 漏到界面上');
  },
);

scenario(
  '手稿骨架：JSON 跑不了（结构不对）',
  {
    selected: 'manuscript',
    snap: Object.assign({}, SNAP, {
      stages: MANUSCRIPT_STAGES,
      artifacts: Object.assign({}, SNAP.artifacts, {
        manuscriptSpec: { exists: true, error: 'blocks 是空的', errorKind: 'structure', blocks: 0, figures: 0, tables: 0, placeholders: 0 },
      }),
    }),
  },
  (tree, text) => {
    check(text.includes('manuscript.json 跑不了'), '标题说跑不了，不说已就绪');
    check(text.includes('跑不了：blocks 是空的'), '把结构错误原样说出来');
    check(!text.includes('已就绪'), '不谎报已就绪');
  },
);
scenario(
  '手稿骨架：图块缺 png',
  {
    selected: 'manuscript',
    snap: Object.assign({}, SNAP, {
      stages: MANUSCRIPT_STAGES,
      artifacts: Object.assign({}, SNAP.artifacts, {
        manuscriptSpec: { exists: true, blocks: 12, figures: 3, figuresMissing: 2, tables: 1, placeholders: 2 },
      }),
    }),
  },
  (tree, text) => {
    check(text.includes('缺 2 张图'), '标题点名缺几张图');
    check(text.includes('第 8 阶段会失败'), '说清后果');
  },
);

/* 6b. 点「重排骨架」必须先弹确认条——不是直接覆盖 */
{
  process.stdout.write('\n手稿骨架：点重排先确认\n');
  globalThis.__DSA__ = {
    snap: Object.assign({}, SNAP, {
      stages: MANUSCRIPT_STAGES,
      artifacts: Object.assign({}, SNAP.artifacts, {
        manuscriptSpec: { exists: true, blocks: 14, figures: 3, tables: 1, placeholders: 5 },
      }),
    }),
    pre: SNAP.preflight,
    loading: false,
    dialog: null,
    width: 'wide',
    theme: 'light',
    selected: 'manuscript',
  };
  const view = mountPanel({});
  check(view.text().includes('重排骨架'), '有「重排骨架」按钮');
  const clicked = view.click('重排骨架');
  check(clicked, '按钮点得到');
  const after = view.text();
  check(/都会被覆盖/.test(after), '点后先出现确认条，没有直接覆盖');
  check(/确认重排/.test(after), '确认条里有「确认重排」');
  view.click('取消');
  check(!/都会被覆盖/.test(view.text()), '点取消后确认条收起');

  // 没有 manuscript.json 时，「运行」不该是实心主按钮：同屏只能有一个主动作（生成骨架）
  globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, {
    snap: Object.assign({}, SNAP, {
      stages: MANUSCRIPT_STAGES,
      artifacts: Object.assign({}, SNAP.artifacts, { manuscriptSpec: { exists: false } }),
    }),
  });
  const blank = mountPanel({});
  const runBtn = findAllByClass(blank.tree(), 'dsa-btn').find((item) => textOf(item).trim() === '运行');
  check(Boolean(runBtn), '无 spec 时仍有「运行」按钮');
  check(
    Boolean(runBtn) && !String(runBtn.props.className).split(/\s+/).includes('primary'),
    '无 spec 时「运行」不是实心主按钮',
    runBtn ? String(runBtn.props.className) : '',
  );
  check(blank.text().includes('生成手稿骨架'), '主按钮是「生成手稿骨架」');
}

/* 8. 运行台 / 运行日志的边界：没有运行记录、没有日志 */scenario('没有运行记录', { snap: Object.assign({}, SNAP, { runs: [], activeRuns: {} }) }, (tree, text) => {
  check(hasClass(tree, 'dsa-side'), '右运行台仍在');
  check(!text.includes('undefined'), '没有 undefined 漏到界面上');
});
scenario(
  '运行中',
  {
    selected: 'audit',
    snap: Object.assign({}, SNAP, { activeRuns: { audit: { id: 'run-9', stageId: 'audit', status: 'running', startedAt: '2026-11-12T10:00:00Z' } } }),
  },
  (tree, text) => {
    check(text.includes('停止') || text.includes('运行中'), '运行中的阶段有可见状态');
    check(!text.includes('undefined'), '没有 undefined 漏到界面上');
  },
);

/* 9. 随机组合：每个阶段状态 × 选中项 × 宽度 × 主题，渲染不许崩、不许漏 undefined */
const RICH_SNAP = Object.assign({}, SNAP, {
  artifacts: Object.assign({}, SNAP.artifacts, {
    figures: {
      file: 'output/figures/figure_manifest.csv',
      total: 3,
      summary: { count: 3, pass: 1, fail: 1, unjudged: 1, fontUnjudged: 1 },
      rows: [
        { id: 'F1', chartType: 'bar', nText: 'n = 320', caption: '图 1 描述统计', png: 'output/figures/f1.png', pngExists: true, effectiveDpi: 600, minFontsize: 8, palette: '#1f4e79,#a4372e', n: 320, badges: [{ key: 'file', label: '文件', state: 'pass', text: '在' }, { key: 'dpi', label: 'dpi', state: 'pass', text: '600' }] },
        { id: 'F2', chartType: 'line', nText: 'n = 320', caption: '', png: 'output/figures/f2.png', pngExists: false, effectiveDpi: 511, minFontsize: 6.5, palette: null, n: null, badges: [{ key: 'file', label: '文件', state: 'fail', text: '缺失' }, { key: 'n', label: 'N', state: 'unjudged', text: '未测' }] },
      ],
    },
    models: {
      models: [{ id: 'M1', file: 'output/models/coef_M1.csv', n: 320, fitN: 320, rows: [{ var: 'x1', coef: 0.42, p: 0.01 }] }],
      fits: [{ model: 'M1', n: 320, aic: 120.5 }],
      flowChecks: [{ model: 'M1', ok: false, note: '样本量对不上' }],
      meta: {},
    },
    verify: [{ row: 12, file: 'output/dataset/analysis.csv', claim: '表 2 的 N', actual: '320', status: 'error' }],
    qa: [{ file: 'output/qa/qa_report.json', errorCount: 2, warningCount: 1, inputErrors: 1 }],
    flow: [
      {
        file: 'output/audit/sample_flow.csv',
        source: 'corpus',
        unit: 'case',
        // 与 host 的 readFlow 同形：steps 是对象数组，不是数字
        steps: [
          { stage: '抓取', n: 223, note: '' },
          { stage: '去重', n: 220, note: '3 份重复' },
          { stage: '有效', n: 219, note: '' },
        ],
        monotonic: true,
        first: 223,
        last: 219,
      },
    ],
  }),
});

const STATUSES = ['done', 'blocked', 'review', 'todo', 'running'];
const FUZZ_STAGES = STAGES.concat([stage('manuscript', 5, '文稿组装', 'todo', [])]);
let seed = 20261112;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

let fuzzCrashes = 0;
let fuzzDirty = 0;
for (let round = 0; round < 24; round += 1) {
  const stages = FUZZ_STAGES.map((item) => {
    const status = STATUSES[Math.floor(rnd() * STATUSES.length)];
    return Object.assign({}, item, {
      status,
      gates: item.gates.map((gateItem) => Object.assign({}, gateItem, { status: ['pass', 'fail', 'unjudged'][Math.floor(rnd() * 3)] })),
    });
  });
  const selected = round % 7 === 6 ? 'ghost-stage' : stages[round % stages.length].id;
  const running = round % 3 === 0;
  const snap = Object.assign({}, RICH_SNAP, {
    stages,
    activeRuns: running ? { [stages[round % stages.length].id]: { id: 'run-x', stageId: stages[round % stages.length].id, status: 'running', startedAt: '2026-11-12T10:00:00Z' } } : {},
    // 一半轮次给完整计数、一半只给 exists：缺字段时不许漏 undefined
    artifacts: Object.assign({}, RICH_SNAP.artifacts, {
      manuscriptSpec: round % 2 ? { exists: true, blocks: 14, figures: 3, tables: 1, placeholders: 2 } : { exists: true },
    }),
  });
  globalThis.__DSA__ = {
    snap,
    pre: round % 4 === 0 ? PRE_WARN : SNAP.preflight,
    loading: false,
    dialog: null,
    width: round % 2 ? 'narrow' : 'wide',
    theme: round % 3 === 0 ? 'dark' : 'light',
    selected,
  };
  try {
    const tree = renderRoot(PANEL, {});
    const text = textOf(tree);
    const bad = text.match(/(undefined|NaN|\[object Object\])/);
    if (bad) {
      fuzzDirty += 1;
      if (fuzzDirty <= 2) {
        const at = text.indexOf(bad[0]);
        process.stdout.write('    （第 ' + round + ' 轮「' + bad[0] + '」：…' + text.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ') + '…）\n');
      }
    }
  } catch (error) {
    fuzzCrashes += 1;
    if (fuzzCrashes <= 2) process.stdout.write('    （第 ' + round + ' 轮崩溃：' + String((error && error.message) || error) + '）\n');
  }
}
process.stdout.write('\n随机组合（24 轮：阶段状态 × 选中项 × 窄屏 × 暗色 × 制品数据）\n');
check(fuzzCrashes === 0, '没有渲染崩溃', fuzzCrashes ? fuzzCrashes + ' 轮崩溃' : '');
check(fuzzDirty === 0, '没有 undefined / NaN 漏到界面', fuzzDirty ? fuzzDirty + ' 轮' : '');

/* ------------------------------------------------------------------ *
 * 10. 输入行左侧的「下一步」：四种状态 + 一次起跑
 *
 * 这段 UI 长在宿主的输入行里，不在面板里，源码里也是纯前端状态机，所以不开浏览器就能验：
 * 持久实例 + 假 fetch，断言「点下去只发一次 run」「结果写在按钮里」「会话对不上不掺和」。
 * 真排版（宽度封顶、边框、省略号）在 tests/visual.mjs 里量，两边分工不同。
 * ------------------------------------------------------------------ */

const NEXT_STEP = REGISTERED.get('conversation.input.left');
const WB_TAIL = REGISTERED.get('conversation.chat.turnTail');

// 持久实例：React 的 state 挂在实例上，而 renderRoot 每次都会新建实例，
// 这里自己管一个实例，渲染时只重置 hook 指针，setState 之后重渲染才看得到效果。
function mountComponent(Component, props) {
  const inst = { fn: Component, key: 'mounted', slots: {}, i: 0, changed: false };
  // 每个场景一份干净的 hook 状态；mount 之内多次 render 要保留状态（busy 这类交互才测得出来）
  store = new Map();
  const render = () => {
    inst.i = 0;
    inst.changed = false;
    instances.length = 0;
    cmpSeq = 0;
    const prev = current;
    current = inst;
    let out;
    try {
      out = Component(props);
    } finally {
      current = prev;
    }
    return expand(out);
  };
  return { inst, render };
}

function composerState(patch) {
  return Object.assign(
    {
      ok: true,
      active: { id: 'p1', name: '测试项目', path: 'C:/work/p1', sessionId: 's1' },
      summary: { done: 3, review: 1 },
      totals: { fail: 0 },
      running: false,
      next: { id: 'coding', index: 2, name: '编码与抽取', status: 'todo', script: 'x.py', args: [] },
    },
    patch,
  );
}

function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    const out = (await handler(String(url), method, body)) || {};
    const status = out.status || 200;
    const payload = out.payload === undefined ? { ok: true } : out.payload;
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const runsTo = (calls) => calls.filter((item) => item.url.includes('/stage/run'));

async function composerScenario(name, fixture, assert) {
  process.stdout.write('\n' + name + '\n');
  globalThis.__DSA__ = Object.assign(
    {
      snap: SNAP,
      pre: SNAP.preflight,
      loading: false,
      dialog: null,
      width: 'wide',
      theme: 'light',
      selected: 'scope',
      wb: composerState(),
      phase: 'idle',
      flash: '',
    },
    fixture || {},
  );
  const component = (fixture && fixture.slot) || NEXT_STEP;
  const props = (fixture && fixture.props) || { sessionId: 's1' };
  if (!component) {
    check(false, 'client.js 没有注册输入行零件（conversation.input.left）');
    return;
  }
  const mounted = mountComponent(component, props);
  let tree;
  try {
    tree = mounted.render();
  } catch (error) {
    check(false, '渲染崩溃', String((error && error.stack) || error).split('\n').slice(0, 2).join(' | '));
    return;
  }
  try {
    const out = assert(tree, textOf(tree), mounted);
    if (out && typeof out.then === 'function') await out;
  } catch (error) {
    check(false, '断言抛错', String((error && error.message) || error));
  }
}

await composerScenario('输入行：可运行的阶段', {}, (tree, text) => {
  const btn = findByClass(tree, 'dsa-chat-btn');
  check(Boolean(btn), '渲染出按钮');
  check(text.includes('运行下一步'), '标签是「运行下一步」');
  check(text.includes('编码与抽取'), '带阶段名');
  check(hasClass(tree, 'dsa-cmp'), '外面有封顶容器 dsa-cmp');
  check(tree && tree.props && tree.props.role === 'status', '整块带 role=status，读屏能读到状态变化');
  check(!hasClass(tree, 'dsa-hint'), '不再有挂在旁边的提示句（老实现会越写越长）');
  check(text.includes('▶'), '可运行时是 ▶，不是箭头指向面板');
});

await composerScenario('输入行：点一下只起跑一次', {}, async (tree, text, mounted) => {
  const stub = stubFetch((url) =>
    url.includes('/stage/run') ? { payload: { ok: true, run: { id: 'run-9' } } } : { payload: composerState() },
  );
  try {
    findByClass(tree, 'dsa-chat-btn').props.onClick();
    const mid = mounted.render();
    const busy = findByClass(mid, 'dsa-chat-btn');
    check(hasClass(mid, 'dsa-cmp-spin'), '点下去立刻转圈（不用等回包）');
    check(textOf(busy).includes('启动中'), '按钮文字换成「启动中」');
    check(busy.props.disabled === true, '启动中禁用，防连点');
    check(busy.props['aria-busy'] === 'true', '带 aria-busy=true');

    await flush();
    await flush();
    const after = mounted.render();
    const btn = findByClass(after, 'dsa-chat-btn');
    const wrap = findByClass(after, 'dsa-cmp');
    check(String(wrap && wrap.props.className).includes('tone-ok'), '成功后按钮自己变成成功色');
    check(textOf(btn).includes('已启动 编码与抽取'), '成功反馈写在按钮里：' + textOf(btn).trim());
    check(!btn.props.disabled, '成功后恢复可点（点一下去工作台看日志）');

    btn.props.onClick();
    await flush();
    check(runsTo(stub.calls).length === 1, '成功窗口内再点不会发第二次 run（实际 ' + runsTo(stub.calls).length + ' 次）');
    const runCall = stub.calls.find((call) => call.url.includes('/stage/run'));
    check(Boolean(runCall) && runCall.body.sessionId === 's1', '起跑时带上这条对话的 sessionId（宿主按它认项目）');
  } finally {
    stub.restore();
  }
});

await composerScenario('输入行：启动失败', {}, async (tree, text, mounted) => {
  const stub = stubFetch((url) =>
    url.includes('/stage/run')
      ? { status: 409, payload: { ok: false, error: '资料审计还有 2 个 error 级未过' } }
      : { payload: composerState() },
  );
  try {
    findByClass(tree, 'dsa-chat-btn').props.onClick();
    await flush();
    await flush();
    const after = mounted.render();
    const afterText = textOf(after);
    const btn = findByClass(after, 'dsa-chat-btn');
    const wrap = findByClass(after, 'dsa-cmp');
    check(String(wrap && wrap.props.className).includes('tone-err'), '失败转成错误色');
    check(afterText.includes('启动失败'), '按钮里写「启动失败」');
    check(afterText.includes('2 个 error 级未过'), '把服务端的原因带出来，不是只写失败');
    check(String(btn.props.title).includes('2 个 error 级未过'), '悬停能看到完整原因');
    check(!afterText.includes('运行下一步'), '失败时不再和「运行下一步」并存（老实现两种状态同时显示）');
  } finally {
    stub.restore();
  }
});

await composerScenario(
  '输入行：运行中',
  { wb: composerState({ running: true, next: { id: 'coding', index: 2, name: '编码与抽取', status: 'running', script: 'x.py', args: [] } }) },
  (tree, text) => {
    check(text.includes('运行中'), '标签是「运行中」');
    check(text.includes('编码与抽取'), '带阶段名');
    check(hasClass(tree, 'dsa-cmp-dot'), '有呼吸点');
    check(String((findByClass(tree, 'dsa-cmp') || {}).props.className || '').includes('tone-run'), '整体是运行色');
  },
);

await composerScenario(
  '输入行：运行中点一下只看日志',
  { wb: composerState({ running: true, next: { id: 'coding', index: 2, name: '编码与抽取', status: 'running', script: 'x.py', args: [] } }) },
  async (tree, text, mounted) => {
    const stub = stubFetch(() => ({ payload: composerState() }));
    try {
      findByClass(tree, 'dsa-chat-btn').props.onClick();
      await flush();
      check(runsTo(stub.calls).length === 0, '运行中再点不会重复起跑');
    } finally {
      stub.restore();
    }
  },
);

await composerScenario(
  '输入行：被拦住（待人工）',
  { wb: composerState({ next: { id: 'coding', index: 2, name: '编码与抽取', status: 'blocked', script: 'x.py', args: [] } }) },
  async (tree, text, mounted) => {
    check(text.includes('待人工'), '标签是「待人工」');
    check(text.includes('编码与抽取'), '仍然显示卡住的阶段，方便定位');
    check(text.includes('→'), '用 → 表示去面板处理，不用 ▶ 假装能直接跑');
    const stub = stubFetch(() => ({ payload: composerState() }));
    try {
      findByClass(tree, 'dsa-chat-btn').props.onClick();
      await flush();
      check(runsTo(stub.calls).length === 0, '被拦住时不发 run（服务端只会回 409）');
    } finally {
      stub.restore();
    }
  },
);

await composerScenario('输入行：九个阶段都完成了', { wb: composerState({ next: null }) }, (tree, text) => {
  check(text.includes('所有阶段都已完成'), '显示完成文案');
  check(!findByClass(tree, 'dsa-chat-btn'), '没有可点的按钮（不给假入口）');
  check(hasClass(tree, 'dsa-cmp-text'), '只是纯文本，不带边框');
});

await composerScenario('输入行：别的会话的工作台不掺和', { props: { sessionId: 's2' } }, (tree) => {
  check(tree === null || tree === undefined, '会话对不上就整块不渲染');
});

await composerScenario('输入行：没有脚本的待办阶段', { wb: composerState({ next: { id: 'coding', index: 2, name: '编码与抽取', status: 'todo', script: '', args: [] } }) }, (tree, text) => {
  check(text.includes('待人工'), '没脚本时不给「运行下一步」，避免点了必然失败');
});

await composerScenario(
  '对话尾部：状态条走自己的样式',
  { slot: WB_TAIL, props: { sessionId: 's1', seq: 1 } },
  (tree, text) => {
    check(hasClass(tree, 'dsa-cmp-tail'), '尾部状态条带 dsa-cmp-tail（不再依赖面板里的令牌）');
    check(text.includes('测试项目'), '显示当前项目');
    check(text.includes('完成 3'), '显示完成数');
    check(Boolean(findByClass(tree, 'dsa-chat-btn')), '带「打开工作台」按钮');
  },
);

/* 6d. 产物中心：点缩略图就地弹大图（←/→ 翻页、关闭回网格） */
{
  process.stdout.write('\n产物中心：点图弹大图\n');
  const stub = stubFetch((url) => {
    if (url.includes('/artifacts/tree')) {
      return {
        payload: {
          ok: true,
          totalFiles: 6,
          totalBytes: 18944,
          truncated: false,
          entries: [
            { rel: 'output/chart_pack/figures/a.png', name: 'a.png', ext: '.png', size: 1024, kind: 'file', image: true, viewable: true },
            { rel: 'output/chart_pack/figures/a.tiff', name: 'a.tiff', ext: '.tiff', size: 8192, kind: 'file', image: true, viewable: true },
            { rel: 'output/chart_pack/figures/b.png', name: 'b.png', ext: '.png', size: 2048, kind: 'file', image: true, viewable: true },
            { rel: 'output/chart_pack/figures/c.tiff', name: 'c.tiff', ext: '.tiff', size: 4096, kind: 'file', image: true, viewable: true },
            { rel: 'output/models/coef_all.csv', name: 'coef_all.csv', ext: '.csv', size: 512, kind: 'file', viewable: true },
            { rel: 'output/report.pdf', name: 'report.pdf', ext: '.pdf', size: 3072, kind: 'file', viewable: true },
          ],
        },
      };
    }
    if (url.includes('/artifacts/file')) {
      if (url.includes('report.pdf')) return { payload: { ok: true, kind: 'pdf', rel: 'output/report.pdf' } };
      return {
        payload: {
          ok: true,
          kind: 'table',
          rel: 'output/models/coef_all.csv',
          header: ['term', 'beta'],
          rows: [['multi_charge', '15.38'], ['prior_record', '-0.42']],
          totalRows: 3,
          truncated: false,
        },
      };
    }
    // /state、/preflight 之类：回同一份快照，否则面板会拿空快照把项目切换 effect 触发一遍（弹窗被关掉）
    if (url.includes('/preflight')) return { payload: SNAP.preflight };
    if (url.includes('/summary')) return { payload: SNAP.summary || {} };
    if (url.includes('/state')) return { payload: SNAP };
    return { payload: { ok: true } };
  });
  const realInterval = globalThis.setInterval;
  try {
    // 打开 effect 后面板会挂轮询定时器：把它们换成不落地的桩，否则脚本跑完不退出
    globalThis.setInterval = () => 0;
    globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, {
      snap: SNAP,
      pre: SNAP.preflight,
      loading: false,
      dialog: null,
      width: 'wide',
      theme: 'light',
      selected: 'scope',
    });
    const view = mountPanel({});
    await flush();
    view.render();
    globalThis.__DSA_EFFECTS__ = true;
    // 先让挂载期 effect 跑完（含「项目一换就关弹窗」那条），再点入口，否则刚开的弹窗会被它关掉
    view.render();
    await flush();
    view.render();
    // 走真实动线：点顶栏「产物」，不是直接把 dialog 种进去
    const entry = findAllByClass(view.tree(), 'dsa-settings-btn').find((item) => String(item.props.title || '').includes('产物'));
    check(Boolean(entry), '顶栏有「产物」入口');
    const tapped = view.tap(entry);
    check(tapped, '「产物」点得动');
    await flush();
    await flush();
    view.render();

    const cards = findAllByClass(view.tree(), 'dsa-art-card');
    check(cards.length === 3, '图表 tab 里三张图：成对的 a.tiff 不单独占卡，孤 TIFF 仍在');
    check(!cards.some((card) => textOf(card).includes('a.tiff')), '同名 TIFF 不出现在网格');
    check(cards.some((card) => textOf(card).includes('a.png')), '同名 PNG 仍在');
    check(textOf(view.tree()).includes('图 3'), '图计数不含被收掉的 TIFF');
    check(textOf(view.tree()).includes('5 个文件'), '右上角文件数扣掉被收掉的 TIFF（6 - 1）');
    check(!textOf(view.tree()).includes('6 个文件'), '右上角不再报服务端的原始文件数');
    const thumbs = cards.filter((card) => Boolean(findByClass(card, 'dsa-art-thumb')));
    check(thumbs.length === 3, '露出的图片都带缩略图（含孤 TIFF）');
    check(!findByClass(view.tree(), 'dsa-lightbox'), '没点之前不弹大图');

    check(view.tap(thumbs[0]), '缩略图点得动');
    const opened = view.tree();
    check(Boolean(findByClass(opened, 'dsa-lightbox')), '就地弹出大图层');
    const bigImg = findByClass(opened, 'dsa-lightbox-img');
    check(Boolean(bigImg) && String(bigImg.props.src).includes('/artifacts/raw?path='), '大图直接用原图地址');
    check(
      Boolean(bigImg) && String(bigImg.props.src).includes(encodeURIComponent('output/chart_pack/figures/a.png')),
      '大图指向被点的那一张',
    );
    check(textOf(findByClass(opened, 'dsa-lightbox-name')).includes('a.png'), '顶栏写着文件名');
    check(textOf(findByClass(opened, 'dsa-lightbox-bar')).includes('1 / 3'), '标出「第 1 / 共 3 张」（成对 TIFF 不进翻页）');
    const openedBar = textOf(findByClass(opened, 'dsa-lightbox-bar'));
    check(openedBar.includes('下载 PNG'), '有同名 TIFF 时按被点开的格式写成「下载 PNG」');
    check(openedBar.includes('下载 TIFF'), '旁边有「下载 TIFF」');
    const tiffLink = findAllByClass(opened, 'dsa-link').find((item) => textOf(item).includes('下载 TIFF'));
    check(
      Boolean(tiffLink) && String(tiffLink.props.href).includes(encodeURIComponent('output/chart_pack/figures/a.tiff')) && String(tiffLink.props.href).includes('download=1'),
      '下载 TIFF 指向同名原稿且带 download=1',
    );
    const pngLink = findAllByClass(opened, 'dsa-link').find((item) => textOf(item).trim() === '下载 PNG');
    check(
      Boolean(pngLink) && String(pngLink.props.href).includes(encodeURIComponent('output/chart_pack/figures/a.png')) && String(pngLink.props.href).includes('download=1'),
      '下载 PNG 指向被点开的那张',
    );
    check(
      !stub.calls.some((call) => call.url.includes('/artifacts/file')),
      '点图不请求 /artifacts/file（不再为了看大图去拉详情）',
    );

    const next = findAllByClass(opened, 'dsa-lightbox-nav').find((item) => hasClass(item, 'next'));
    check(Boolean(next), '多张图时有「下一张」');
    view.tap(next);
    const second = view.tree();
    const secondImg = findByClass(second, 'dsa-lightbox-img');
    check(
      Boolean(secondImg) && String(secondImg.props.src).includes(encodeURIComponent('output/chart_pack/figures/b.png')),
      '翻到第二张',
    );
    check(textOf(findByClass(second, 'dsa-lightbox-bar')).includes('2 / 3'), '页码跟着变');
    const secondBar = textOf(findByClass(second, 'dsa-lightbox-bar'));
    check(secondBar.includes('下载') && !secondBar.includes('下载 PNG') && !secondBar.includes('下载 TIFF'), '没有同名 TIFF 的图仍是一个「下载」');

    check(view.click('关闭'), '有「关闭」按钮');
    check(!findByClass(view.tree(), 'dsa-lightbox'), '关闭后回到网格');

    /* TIFF 浏览器不显示：大图必须走服务端转码预览，不能再把 raw 塞进 img */
    const tiffCard = findAllByClass(view.tree(), 'dsa-art-card').find((card) => textOf(card).includes('c.tiff'));
    check(Boolean(tiffCard), 'TIFF 也有卡片');
    view.tap(tiffCard);
    const tiffView = view.tree();
    const tiffImg = findByClass(tiffView, 'dsa-lightbox-img');
    check(Boolean(tiffImg), 'TIFF 也能打开大图');
    check(Boolean(tiffImg) && String(tiffImg.props.src).includes('/artifacts/thumb?path='), 'TIFF 走转码预览，不走 raw');
    check(Boolean(tiffImg) && String(tiffImg.props.src).includes('w=2400'), '预览请求 2400 宽');
    check(textOf(tiffView).includes('转码预览'), '说明这是转码预览、原图看下载');
    view.click('关闭');

    /* 表格同样要弹层：以前是在网格下面塞一块详情，得滚到最底下才看得到 */
    const allTab = findAllByClass(view.tree(), 'dsa-tab').find((item) => textOf(item).includes('全部'));
    check(Boolean(allTab), '有「全部」tab');
    view.tap(allTab);
    const csvCard = findAllByClass(view.tree(), 'dsa-art-card').find((card) => textOf(card).includes('coef_all.csv'));
    check(Boolean(csvCard), '表格也有卡片');
    view.tap(csvCard);
    await flush();
    await flush();
    const tableView = view.render();
    check(Boolean(findByClass(tableView, 'dsa-lightbox')), '表格也弹层，不再塞在网格下面');
    check(!findByClass(tableView, 'dsa-art-detail'), '网格下面不再有内联详情块');
    check(Boolean(findByClass(tableView, 'dsa-art-table')), '弹层里是真表格');
    check(textOf(tableView).includes('3 行 × 2 列'), '标出行列数');
    check(textOf(tableView).includes('multi_charge'), '表里有数据行');

    /* PDF：内嵌阅读器读 raw，不能拿缩略图地址去当 iframe（那是 PNG 生成器，PDF 会 404） */
    const pdfCard = findAllByClass(view.tree(), 'dsa-art-card').find((card) => textOf(card).includes('report.pdf'));
    check(Boolean(pdfCard), 'PDF 也有卡片');
    view.tap(pdfCard);
    await flush();
    await flush();
    const pdfView = view.render();
    const frame = findByClass(pdfView, 'dsa-lightbox-pdf');
    check(Boolean(frame), 'PDF 在弹层里给内嵌阅读器');
    check(Boolean(frame) && String(frame.props.src).includes('/artifacts/raw?path='), 'PDF 读的是 raw，不是缩略图');

    /* 点弹窗旁边的空白处直接关掉：不用非得去点「关闭」 */
    view.click('关闭');
    const mask = findByClass(view.tree(), 'dsa-mask');
    check(Boolean(mask) && typeof mask.props.onMouseDown === 'function', '遮罩带 onMouseDown');
    mask.props.onMouseDown({});
    view.render();
    check(!findByClass(view.tree(), 'dsa-modal'), '点空白处把产物中心关掉');
  } finally {
    stub.restore();
    globalThis.setInterval = realInterval;
    globalThis.__DSA_EFFECTS__ = false;
    globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, { dialog: null });
  }
}

/* 7. 左栏项目行：点「研究对话」= 切项目 → 复用/新建会话 → 跳进原生对话 */
await (async function projectChatEntry() {
  process.stdout.write('\n左栏项目行：一点就进那条会话\n');
  const created = [];
  const retained = [];
  const opened = [];
  const sessions = {
    retain(id) {
      retained.push(id);
      return {
        sessionId: id,
        ready: Promise.resolve(),
        binding: {
          session: {
            getSnapshot: () => ({ running: false }),
            subscribe: () => () => {},
            prompt: async () => ({}),
          },
        },
        release() {},
      };
    },
    create(opts) {
      created.push(opts || {});
      return 'sess-new';
    },
  };
  globalThis.__DSA_SVC__ = {
    sessions,
    uiWorkspace: { openSession(id) { opened.push(id); } },
    layout: { selectPanel() {} },
  };

  const base = Object.assign({}, SNAP);
  const twoProjects = (s1, s2) => [
    { id: 'p1', name: '测试项目', path: 'C:/work/p1', exists: true, sessionId: s1 },
    { id: 'p2', name: '另一个项目', path: 'C:/work/p2', exists: true, sessionId: s2 },
  ];

  // 点第二个项目（不是当前项目，且它自己有会话）：先切过去，再进它那条
  const fixtureA = Object.assign({}, base, {
    projects: twoProjects('', ''),
    active: Object.assign({}, base.active, { id: 'p1', path: 'C:/work/p1', sessionId: '' }),
  });
  const afterOpenA = Object.assign({}, fixtureA, {
    projects: twoProjects('', 's2'),
    active: Object.assign({}, base.active, { id: 'p2', name: '另一个项目', path: 'C:/work/p2', sessionId: 's2' }),
  });

  async function clickRow(fixture, afterOpen, index) {
    globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, {
      snap: fixture,
      pre: SNAP.preflight,
      loading: false,
      dialog: null,
      width: 'wide',
      theme: 'light',
      selected: 'scope',
    });
    const stub = stubFetch((url) => {
      if (url.includes('/project/open')) return { payload: { ok: true, state: afterOpen } };
      if (url.includes('/project/session')) return { payload: { ok: true, state: afterOpen } };
      if (url.includes('/state')) return { payload: afterOpen };
      return { payload: { ok: true } };
    });
    const view = mountPanel({});
    const rows = findAllByClass(view.tree(), 'dsa-proj-chat');
    check(rows.length === 2, '两行各一条会话入口');
    view.tap(rows[index]);
    for (let i = 0; i < 4; i += 1) {
      await flush();
      view.render();
    }
    return { stub, view };
  }

  const a = await clickRow(fixtureA, afterOpenA, 1);
  try {
    const openCall = a.stub.calls.find((call) => call.url.includes('/project/open'));
    check(Boolean(openCall) && openCall.body.dir === 'C:/work/p2', '先切到那个项目（绑定认的是当前项目）');
    check(openCall && openCall.method === 'POST', '切项目走 POST，不是悄悄改本地状态');
    check(retained.includes('s2'), '复用它自己的会话');
    check(created.length === 0, '已经有会话就不再新建一条');
    check(opened.includes('s2'), '点完直接跳到那条原生对话');
  } finally {
    a.stub.restore();
  }

  // 当前项目还没会话：点一下就建一条，绑定，再进去
  created.length = 0;
  retained.length = 0;
  opened.length = 0;
  const fixtureB = Object.assign({}, base, {
    projects: twoProjects('', ''),
    active: Object.assign({}, base.active, { id: 'p1', path: 'C:/work/p1', sessionId: '' }),
  });
  const b = await clickRow(fixtureB, fixtureB, 0);
  try {
    const sessionCall = b.stub.calls.find((call) => call.url.includes('/project/session'));
    check(Boolean(sessionCall) && sessionCall.body.sessionId === 'sess-new', '新会话立刻绑定到项目');
    check(Boolean(sessionCall) && sessionCall.body.projectId === 'p1', '绑定指名项目，不靠「碰巧是当前项目」');
    check(created.length === 1 && created[0].cwd === 'C:/work/p1', '会话建在项目目录里：' + JSON.stringify(created[0] || {}));
    check(!b.stub.calls.some((call) => call.url.includes('/project/open')), '已经是当前项目就不再切一次');
    check(opened.includes('sess-new'), '建完直接进去');
    check(findAllByClass(b.view.tree(), 'dsa-proj-chat').length === 2, '跳转后左栏仍完整（没有渲染崩溃）');
  } finally {
    b.stub.restore();
    globalThis.__DSA_SVC__ = undefined;
    globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, { snap: SNAP });
  }
})();

/* 8. 本对话 ⇄ 项目：面板跟着对话走，而不是跟着上次点开的项目 */
await (async function followCurrentChat() {
  process.stdout.write('\n本对话 ⇄ 项目：面板跟着对话走\n');
  const realInterval = globalThis.setInterval;
  try {
    globalThis.setInterval = () => 0;
    const base = Object.assign({}, SNAP);
    const projP1 = { id: 'p1', name: '测试项目', path: 'C:/work/p1', exists: true, sessionId: 's1' };
    const projP2 = { id: 'p2', name: '另一个项目', path: 'C:/work/p2', exists: true, sessionId: 's2' };
    const activeP1 = Object.assign({}, base.active, { id: 'p1', name: '测试项目', path: 'C:/work/p1', sessionId: 's1' });
    const activeP2 = Object.assign({}, base.active, { id: 'p2', name: '另一个项目', path: 'C:/work/p2', sessionId: 's2' });
    const focusP1 = { sessionId: 's1', projectId: 'p1', projectName: '测试项目', projectPath: 'C:/work/p1' };
    const focusP2 = { sessionId: 's2', projectId: 'p2', projectName: '另一个项目', projectPath: 'C:/work/p2' };

    async function mountWith(fixture, afterState) {
      globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, {
        snap: fixture,
        pre: SNAP.preflight,
        loading: false,
        dialog: null,
        width: 'wide',
        theme: 'light',
        selected: 'scope',
      });
      const stub = stubFetch((url) => {
        if (url.includes('/project/open')) return { payload: { ok: true, state: afterState } };
        if (url.includes('/state')) return { payload: afterState };
        return { payload: { ok: true } };
      });
      // effect 在首帧就打开：假 React 里 useEffect 关闭时不占 hook 位，
      // 中途打开会让后面的 useState 全部错位（读到的值是别的 hook 的）
      globalThis.__DSA_EFFECTS__ = true;
      const view = mountPanel({});
      for (let i = 0; i < 4; i += 1) {
        await flush();
        view.render();
      }
      return { view, stub };
    }

    // A. 屏幕上那条对话属于另一个项目：进面板就切过去
    const fixtureA = Object.assign({}, base, { projects: [projP1, projP2], active: activeP1, focus: focusP2 });
    const afterA = Object.assign({}, fixtureA, { active: activeP2 });
    const a = await mountWith(fixtureA, afterA);
    try {
      await flush();
      await flush();
      a.view.render();
      const openedNow = a.stub.calls.find((call) => call.url.includes('/project/open'));
      check(Boolean(openedNow) && openedNow.method === 'POST', '进面板时切到对话所属的项目');
      check(Boolean(openedNow) && openedNow.body.dir === 'C:/work/p2', '切的是 C:/work/p2，不是上次点开的 p1');
      check(a.stub.calls.filter((call) => call.url.includes('/project/open')).length === 1, '一条对话只跟一次，不反复切');
      check(textOf(a.view.tree()).includes('本对话'), '切过去后顶栏承认「本对话」属于当前项目');
    } finally {
      a.stub.restore();
    }

    // B. 对话就属于当前项目：不切、不再发一次请求，左栏那行标「当前对话」
    globalThis.__DSA_EFFECTS__ = false;
    const fixtureB = Object.assign({}, base, { projects: [projP1, projP2], active: activeP1, focus: focusP1 });
    const b = await mountWith(fixtureB, fixtureB);
    try {
      await flush();
      b.view.render();
      check(!b.stub.calls.some((call) => call.url.includes('/project/open')), '同一个项目就不再切一次');
      const pills = findAllByClass(b.view.tree(), 'dsa-proj-chat');
      check(pills.length === 2, '两行入口都在');
      check(textOf(pills[0]).includes('当前对话'), 'p1 那行标成「当前对话」');
      check(!textOf(pills[1]).includes('当前对话'), 'p2 那行不冒充当前对话');
      check(textOf(b.view.tree()).includes('本对话'), '顶栏也认这条对话');
    } finally {
      b.stub.restore();
    }

    // C. 还没跟/跟不过去：顶栏给「⇄ 对话在「X」」入口，而不是假装就是当前项目
    globalThis.__DSA_EFFECTS__ = false;
    const fixtureC = Object.assign({}, base, { projects: [projP1, projP2], active: activeP1, focus: focusP2 });
    globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, {
      snap: fixtureC,
      pre: SNAP.preflight,
      loading: false,
      dialog: null,
      width: 'wide',
      theme: 'light',
      selected: 'scope',
    });
    const viewC = mountPanel({});
    const chipC = findAllByClass(viewC.tree(), 'dsa-settings-btn').find((item) =>
      String(item.props.title || '').includes('这条对话关联的是')
    );
    check(Boolean(chipC), '顶栏给「对话在另一个项目」的入口');
    check(Boolean(chipC) && String(chipC.props.className).includes('dsa-chat-link'), '这个入口标了 dsa-chat-link（窄屏隐藏，顶栏装不下）');
    check(Boolean(chipC) && textOf(chipC).includes('另一个项目'), '按钮上写着是哪个项目：' + (chipC ? textOf(chipC).trim() : ''));

    // D. 宿主说「这个项目没有对话」时，本地副本不能把旧会话复活回来
    //    （否则改绑之后，旧项目的入口还指着一条已经属于别人的会话 = 随意切换）
    const withSession = { id: 'p1', name: '测试项目', path: 'C:/work/p1', exists: true, sessionId: 'sess-old' };
    const withoutSession = Object.assign({}, withSession, { sessionId: '' });
    async function mountAndStub(fixture) {
      globalThis.__DSA_EFFECTS__ = false;
      globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, {
        snap: fixture,
        pre: SNAP.preflight,
        loading: false,
        dialog: null,
        width: 'wide',
        theme: 'light',
        selected: 'scope',
      });
      const stub = stubFetch((url) => {
        if (url.includes('/state')) return { payload: fixture };
        return { payload: { ok: true } };
      });
      globalThis.__DSA_EFFECTS__ = true;
      const view = mountPanel({});
      for (let i = 0; i < 3; i += 1) {
        await flush();
        view.render();
      }
      return { view, stub };
    }

    const d1 = await mountAndStub(Object.assign({}, base, { projects: [withSession], active: Object.assign({}, activeP1, { sessionId: 'sess-old' }), focus: null }));
    try {
      check(textOf(findAllByClass(d1.view.tree(), 'dsa-proj-chat')[0]).includes('已绑定'), 'D1：有会话时入口显示「已绑定」——实际：' + textOf(findAllByClass(d1.view.tree(), 'dsa-proj-chat')[0]).trim() + ' / class=' + String(findAllByClass(d1.view.tree(), 'dsa-proj-chat')[0].props.className));
    } finally {
      d1.stub.restore();
    }
    const d2 = await mountAndStub(Object.assign({}, base, { projects: [withoutSession], active: Object.assign({}, activeP1, { sessionId: '' }), focus: null }));
    try {
      const pill = findAllByClass(d2.view.tree(), 'dsa-proj-chat')[0];
      check(textOf(pill).includes('还没有'), 'D2：宿主解绑后入口回到「还没有」：' + textOf(pill).trim());
      check(!textOf(pill).includes('已绑定'), 'D2：本地副本没有把旧会话复活');
    } finally {
      d2.stub.restore();
    }
  } finally {
    globalThis.setInterval = realInterval;
    globalThis.__DSA_EFFECTS__ = false;
    globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, { snap: SNAP });
  }
})();

/* 13. 重进面板：首屏骨架 + 上次快照先用 */
await (async function cachedRemount() {
  process.stdout.write('\n重进面板：骨架与上次快照\n');
  // 浏览器里刷新一次页面，模块级缓存就没了；测试进程里模块状态是活的，
  // 前面那些场景已经把缓存填过。要测「第一次进来」这条冷路径，只能重新求值一遍 bundle。
  PANEL = loadPanel().panel;
  const realInterval = globalThis.setInterval;
  const realFetch = globalThis.fetch;
  globalThis.setInterval = () => 0;
  try {
    // A. 第一次进来：还没有任何快照 → 骨架，不画「无项目」，技能包徽章不误报
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async (url) => {
      await gate;
      // 真实 /state 的形状是 { ok, state }：stub 必须照这个形状回，否则面板会走「拉失败」分支
      return { ok: true, status: 200, json: async () => (String(url).includes('/state') ? { ok: true, state: SNAP } : { ok: true }) };
    };
    globalThis.__DSA_EFFECTS__ = true;
    globalThis.__DSA__ = { snap: null, pre: null, loading: true, dialog: null, width: 'wide', theme: 'light', selected: 'scope' };
    const first = mountPanel({});
    await flush();
    const skeletonTree = first.tree();
    check(hasClass(skeletonTree, 'dsa-skeleton'), '首屏没有数据时渲染骨架');
    check(!textOf(skeletonTree).includes('从一个资料目录开始'), '首屏不再先画「无项目」空态卡');
    check(!textOf(skeletonTree).includes('技能包未就位'), '读取中不误报「技能包未就位」');
    release();
    await flush();
    await flush();
    first.render();
    check(!hasClass(first.tree(), 'dsa-skeleton'), '数据回来骨架就消失');
    check(textOf(first.tree()).includes('范围与口径'), '数据回来后面板正常渲染');

    // B. 新鲜快照该跟的对话要照跟（证明上面的守卫只拦「旧的一帧」，不是把功能关掉）。
    //    这一帧直接把快照种进初始 state：假 React 的 effect 只在挂载时跑一次，
    //    所以「先空后填」那种时序在这里测不出来，只能分别测两个状态。
    const withFocus = Object.assign({}, SNAP, {
      focus: { sessionId: 'sess-follow-test', projectId: 'p2', projectPath: 'C:/work/p2' },
    });
    const callsFresh = [];
    globalThis.fetch = async (url, init) => {
      callsFresh.push({ url: String(url), method: (init && init.method) || 'GET' });
      const payload = String(url).includes('/state') ? { ok: true, state: withFocus } : { ok: true };
      return { ok: true, status: 200, json: async () => payload };
    };
    globalThis.__DSA__ = { snap: withFocus, pre: null, loading: false, dialog: null, width: 'wide', theme: 'light', selected: 'scope' };
    mountPanel({});
    await flush();
    check(callsFresh.some((call) => call.url.includes('/project/open')), '新鲜快照该跟的对话照跟（切到 p2）');

    // C. 先把缓存换成带 focus 的那份，再模拟「宿主还在算」
    let release2 = null;
    const gate2 = new Promise((resolve) => {
      release2 = resolve;
    });
    globalThis.fetch = async (url) => {
      await gate2;
      const payload = String(url).includes('/state') ? { ok: true, state: withFocus } : { ok: true };
      return { ok: true, status: 200, json: async () => payload };
    };
    globalThis.__DSA__ = { snap: null, pre: null, loading: true, dialog: null, width: 'wide', theme: 'light', selected: 'scope' };
    const warm = mountPanel({});
    release2();
    await flush();
    await flush();
    warm.render();

    // D. 再进：请求挂起不返回，只能靠缓存；旧快照里「当前对话在 p2」，这一帧不许去切
    let release3 = null;
    const gate3 = new Promise((resolve) => {
      release3 = resolve;
    });
    const calls3 = [];
    globalThis.fetch = async (url, init) => {
      calls3.push({ url: String(url), method: (init && init.method) || 'GET' });
      await gate3;
      const payload = String(url).includes('/state') ? { ok: true, state: withFocus } : { ok: true };
      return { ok: true, status: 200, json: async () => payload };
    };
    globalThis.__DSA__ = { snap: null, pre: null, loading: true, dialog: null, width: 'wide', theme: 'light', selected: 'scope' };
    const second = mountPanel({});
    await flush();
    const cachedTree = second.tree();
    check(!hasClass(cachedTree, 'dsa-skeleton'), '重进面板不再等骨架');
    check(textOf(cachedTree).includes('范围与口径'), '重进面板第一帧就显示上次的快照');
    check(!calls3.some((call) => call.url.includes('/project/open')), '旧快照不会被拿去切项目');
    release3();
    await flush();
    await flush();
    second.render();
    check(!hasClass(second.tree(), 'dsa-skeleton'), '新数据到了也还在正常工作台');

    // E. 换项目之后缓存要跟着换：/project/open 回来的新 state 若没被记住，
    //    下次重进面板第一帧闪的还是上一个项目（数据是对的，但闪一下就是白改）。
    const P2_STATE = Object.assign({}, SNAP, {
      // skillDrift 只在顶栏按「当前项目」渲染：用它当标记，能证明第一帧到底画的是哪个项目
      active: Object.assign({}, SNAP.active, { id: 'p2', name: '另一个项目', path: 'C:/work/p2', skillDrift: true }),
      focus: { sessionId: 'sess-switch', projectId: 'p1', projectPath: 'C:/work/p1' },
    });
    const focusP2 = Object.assign({}, SNAP, {
      focus: { sessionId: 'sess-switch', projectId: 'p2', projectPath: 'C:/work/p2' },
    });
    globalThis.fetch = async (url) => {
      const isState = String(url).includes('/state');
      return { ok: true, status: 200, json: async () => (isState ? { ok: true, state: focusP2 } : { ok: true, state: P2_STATE }) };
    };
    globalThis.__DSA__ = { snap: focusP2, pre: null, loading: false, dialog: null, width: 'wide', theme: 'light', selected: 'scope' };
    const switched = mountPanel({});
    await flush();
    await flush();
    switched.render();

    let holdSwitch = null;
    const switchGate = new Promise((resolve) => {
      holdSwitch = resolve;
    });
    globalThis.fetch = async () => {
      await switchGate;
      return { ok: true, status: 200, json: async () => ({ ok: true, state: P2_STATE }) };
    };
    globalThis.__DSA__ = { snap: null, pre: null, loading: true, dialog: null, width: 'wide', theme: 'light', selected: 'scope' };
    const afterSwitch = mountPanel({});
    await flush();
    const switchedTree = afterSwitch.tree();
    check(textOf(switchedTree).includes('SKILL.md 指纹不一致'), '换项目之后重进面板第一帧就是新项目');
    check(!hasClass(switchedTree, 'dsa-skeleton'), '换项目之后重进面板也不用等骨架');
    holdSwitch();
    await flush();
    await flush();
    afterSwitch.render();
    check(!hasClass(afterSwitch.tree(), 'dsa-skeleton'), '换项目之后新数据到了照常渲染');
  } catch (error) {
    check(false, '重进面板场景抛错', String((error && error.message) || error));
  } finally {
    globalThis.setInterval = realInterval;
    globalThis.fetch = realFetch;
    globalThis.__DSA_EFFECTS__ = false;
    globalThis.__DSA__ = Object.assign({}, globalThis.__DSA__, { snap: SNAP, loading: false });
  }
})();

process.stdout.write('\n');
if (failedCount) {  process.stdout.write('✗ ' + failedCount + ' 项失败\n');
  process.exit(1);
}
process.stdout.write('✓ 全部通过\n');

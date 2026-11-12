/**
 * client.js 冒烟测试：不开浏览器，直接把面板渲染成树。
 *
 * 为什么需要它：client.js 是单文件、零构建、靠宿主给的 React 运行；host 侧改动要重启 DSH 才生效，
 * 面板写错一个标识符只有真机刷新才炸。这里用一个极小的「假 React」把组件渲染成字符串树，
 * 覆盖到环境闸门（EnvGate）与主界面两条渲染路径，能在提交前抓住 ReferenceError / 明显的渲染崩溃。
 *
 * 跑法：node tests/client-smoke.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, '..', 'client.js');

/* ---------------- 极简 React ---------------- */

let current = null; // 正在渲染的组件实例
const instances = [];

function slot() {
  if (!current) throw new Error('hook called outside render');
  const inst = current;
  const index = inst.i;
  inst.i += 1;
  return { inst, index };
}

const React = {
  createElement(type, props, ...children) {
    const merged = {};
    if (props) for (const key of Object.keys(props)) merged[key] = props[key];
    const kids = children.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false);
    merged.children = kids;
    return { type, props: merged, key: merged.key === undefined ? null : merged.key };
  },
  useState(initial) {
    const { inst, index } = slot();
    if (!(index in inst.slots)) inst.slots[index] = initial;
    const setter = (value) => {
      inst.slots[index] = typeof value === 'function' ? value(inst.slots[index]) : value;
      inst.changed = true;
    };
    return [inst.slots[index], setter];
  },
  useEffect() {},
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
    if (!(index in inst.slots)) inst.slots[index] = { current: value };
    return inst.slots[index];
  },
};
React.default = React;

function isElement(value) {
  return Boolean(value) && typeof value === 'object' && value.type !== undefined;
}

/** 渲染一棵树：函数组件就地展开，hook 下标按实例各自计数 */
function expand(node, depth = 0) {
  if (depth > 60) throw new Error('渲染层数过深，疑似循环');
  if (Array.isArray(node)) return node.map((item) => expand(item, depth + 1));
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
  if (!isElement(node)) return { text: String(node) };
  const { type, props } = node;
  if (typeof type === 'function') {
    const inst = { fn: type, slots: {}, i: 0, changed: false };
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
  return {
    tag: type,
    props,
    children: (props.children || []).map((item) => expand(item, depth + 1)).filter(Boolean),
  };
}

let dirty = false;

function renderRoot(Component, props) {
  instances.length = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    dirty = false;
    current = null;
    const tree = expand(React.createElement(Component, props));
    if (!dirty) return tree;
  }
  return expand(React.createElement(Component, props));
}

function textOf(tree) {
  if (!tree) return '';
  if (tree.text !== undefined) return tree.text + ' ';
  if (!tree.children) return '';
  return tree.children.map(textOf).join('');
}

/** 树里有没有某个 class：用来判断「工作台主体」到底渲没渲 */
function hasClass(tree, name) {
  if (!tree || !tree.props) return false;
  const className = tree.props.className;
  if (typeof className === 'string' && className.split(/\s+/).includes(name)) return true;
  return (tree.children || []).some((child) => hasClass(child, name));
}

/* ---------------- 加载 client.js ---------------- */

function loadClient() {
  let source = fs.readFileSync(CLIENT, 'utf8');
  const before = source.length;

  // 注入：把三个 useState 的初始值换成测试夹具（只在内存里改，不落盘）
  const snapHead = 'var snapState = useState(null);';
  const preHead = 'var preflightState = useState(null);';
  const loadHead = 'var loadingState = useState(true);';
  for (const head of [snapHead, preHead, loadHead]) {
    if (!source.includes(head)) {
      throw new Error('client.js 的结构变了：找不到 ' + head + '，请更新本测试');
    }
  }
  source = source.replace(snapHead, 'var snapState = useState(globalThis.__DSA_SNAP__);');
  source = source.replace(preHead, 'var preflightState = useState(globalThis.__DSA_PRE__);');
  // 首次拉取在 effect 里做（测试不跑 effect），直接把 loading 关掉，才能渲染到真实界面
  source = source.replace(loadHead, 'var loadingState = useState(false);');
  // 把夹具挂到 factory 作用域里
  source = source.replace(
    'var useCallback = React.useCallback;',
    'var useCallback = React.useCallback;\n      var __SNAP__ = globalThis.__DSA_SNAP__;\n      var __PRE__ = globalThis.__DSA_PRE__;',
  );
  if (source.length === before) throw new Error('注入失败');

  let captured = null;
  const windowStub = {
    __ModuleLoader__: {
      load(def) {
        captured = def;
      },
    },
  };
  const globalStub = { window: windowStub, document: { createElement: () => ({ style: {} }) } };
  const sandbox = new Function('window', 'document', 'globalThis', source);
  sandbox(windowStub, globalStub.document, globalThis);
  if (!captured || typeof captured.factory !== 'function') throw new Error('client.js 没有调用 __ModuleLoader__.load');

  const exported = captured.factory(function requireStub(name) {
    if (name === 'react') return React;
    throw new Error('client.js 请求了宿主模块：' + name);
  });
  return exported;
}

/* ---------------- 夹具 ---------------- */

function gates(stageId, statuses) {
  return statuses.map((status, index) => ({
    id: stageId + '-' + index,
    label: '闸门 ' + (index + 1),
    level: index === 0 ? 'error' : 'info',
    status,
    detail: '测试用',
  }));
}

function fakeStage(id, index, name, status) {
  return {
    id,
    index,
    name,
    short: name.slice(0, 2),
    purpose: name + '的用途',
    script: 'x.py',
    args: [],
    steps: [],
    status,
    gates: gates(id, status === 'done' ? ['pass'] : ['unjudged']),
    artifacts: [],
    lastRun: null,
  };
}

const SNAP = {
  ok: true,
  config: { pythonPath: 'python', skillRoot: '' },
  skill: { ok: true, version: '9.9.9', sha256: 'abc', scripts: 12, root: 'C:/skill' },
  python: { ok: true, version: '3.11.5', executable: 'C:/Python/python.exe' },
  projects: [{ id: 'p1', name: '测试项目', path: 'C:/work/p1' }],
  active: { id: 'p1', name: '测试项目', path: 'C:/work/p1', scope: { note: '' }, sessionId: '' },
  error: '',
  preflight: { status: 'pass', checkedAt: '2026-11-12T10:00:00Z', checks: [] },
  stages: [fakeStage('scope', 0, '范围与口径', 'review'), fakeStage('audit', 1, '资料审计', 'todo')],
  summary: { ok: true, active: { id: 'p1', name: '测试项目', path: 'C:/work/p1' }, summary: {}, totals: {}, next: null, running: [] },
  totals: { pass: 1, fail: 0, unjudged: 1 },
  artifacts: { figures: { rows: [] }, corpus: null, qa: [], verify: [], models: null },
  runs: [],
  adjudications: [],
  activeRuns: {},
  materials: { sources: [], mounts: [], derived: [], entries: [], platform: 'win32', isWindows: true },
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

/* ---------------- 断言 ---------------- */

let failed = 0;
function check(ok, label, detail) {
  if (ok) {
    process.stdout.write('  ✓ ' + label + (detail ? ' — ' + detail : '') + '\n');
  } else {
    failed += 1;
    process.stdout.write('  ✗ ' + label + (detail ? ' — ' + detail : '') + '\n');
  }
}

process.stdout.write('\nclient.js 冒烟测试\n\n');

let exported;
try {
  exported = loadClient();
  check(true, 'client.js 能被加载并交出模块');
} catch (error) {
  check(false, 'client.js 加载失败', String(error && error.message));
  process.exit(1);
}

const Panel = (() => {
  if (!exported || typeof exported.apply !== 'function') return null;
  const registered = new Map();
  const ctx = {
    effect(fn) {
      // 只执行注册型 effect（panel/工具栏那类），不执行需要 DOM/网络的
      try {
        fn();
      } catch (error) {
        /* 真实环境里这些 effect 由宿主驱动，这里失败不算错 */
      }
    },
    slots: {
      inject(name, fn) {
        // 宿主是「注入即调用，返回值是卸载函数」
        fn();
        return () => {};
      },
      register(def, component) {
        registered.set(def && def.name, component);
        return () => {};
      },
    },
  };
  exported.apply(ctx);
  return registered.get('main');
})();
check(typeof Panel === 'function', '导出了面板组件', typeof Panel);
if (typeof Panel !== 'function') process.exit(1);

/* 1. 环境不齐：整块被闸门挡住 */
globalThis.__DSA_SNAP__ = SNAP;
globalThis.__DSA_PRE__ = PRE_FAIL;
let tree;
try {
  tree = renderRoot(Panel, {});
  const text = textOf(tree);
  check(text.includes('环境还没就绪'), '环境有 fail 项时显示环境闸门');
  check(text.includes('让 AI 装好环境'), '闸门里给出「让 AI 装好环境」');
  check(text.includes('手动配置'), '闸门里给出「手动配置」');
  check(text.includes('技能包'), '闸门列出卡住的项目');
  check(!hasClass(tree, 'dsa-body'), '被挡住时不渲染工作台主体（左阶段栏 / 中栏 / 右运行台）');
  check(hasClass(tree, 'dsa-top'), '被挡住时顶栏还在');
} catch (error) {
  check(false, '渲染环境闸门时崩溃', String((error && error.stack) || error).split('\n').slice(0, 3).join(' | '));
}

/* 2. 环境就绪：正常渲染工作台 */
globalThis.__DSA_PRE__ = SNAP.preflight;
try {
  const tree2 = renderRoot(Panel, {});
  const text2 = textOf(tree2);
  check(!text2.includes('环境还没就绪'), '环境齐全时闸门不出现');
  check(hasClass(tree2, 'dsa-body'), '环境齐全时渲染工作台主体');
  check(text2.includes('范围与口径'), '阶段栏列出阶段', '范围与口径');
  check(text2.includes('资料审计'), '阶段栏列出第二个阶段', '资料审计');
  check(text2.includes('测试项目'), '顶栏显示当前项目名');
} catch (error) {
  check(false, '渲染主界面时崩溃', String((error && error.stack) || error).split('\n').slice(0, 3).join(' | '));
}

/* 3. 自检还没跑完（preflight 为空）：不拦，正常显示 */
globalThis.__DSA_PRE__ = null;
try {
  const tree3 = renderRoot(Panel, {});
  const text3 = textOf(tree3);
  check(!text3.includes('环境还没就绪'), '自检结果为空时不误拦');
} catch (error) {
  check(false, 'preflight 为空时渲染崩溃', String((error && error.stack) || error).split('\n').slice(0, 3).join(' | '));
}

process.stdout.write('\n');
if (failed) {
  process.stdout.write('✗ ' + failed + ' 项失败\n');
  process.exit(1);
}
process.stdout.write('✓ 全部通过\n');

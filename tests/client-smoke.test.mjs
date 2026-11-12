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
    return { type, props: merged };
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

function expand(node, depth = 0) {
  if (depth > 80) throw new Error('渲染层数过深，疑似循环');
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
  return { tag: type, props, children: (props.children || []).map((item) => expand(item, depth + 1)).filter(Boolean) };
}

function renderRoot(Component, props) {
  instances.length = 0;
  for (let pass = 0; pass < 5; pass += 1) {
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
  const windowStub = {
    __ModuleLoader__: {
      load(def) {
        captured = def;
      },
    },
  };
  const sandbox = new Function('window', 'document', 'globalThis', source);
  sandbox(windowStub, { createElement: () => ({ style: {} }) }, globalThis);
  if (!captured || typeof captured.factory !== 'function') throw new Error('client.js 没有调用 __ModuleLoader__.load');

  const exported = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('client.js 请求了宿主模块：' + name);
  });

  // apply 只执行「注册型」effect；装样式那类需要 DOM，失败忽略
  const registered = new Map();
  exported.apply({
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
  return { panel, slots: [...registered.keys()] };
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
try {
  const loaded = loadPanel();
  PANEL = loaded.panel;
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

/* 6. 七个弹窗都能开（用真实形状的入参，别拿半截数据骗自己） */
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
let seed = 20261112;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

let fuzzCrashes = 0;
let fuzzDirty = 0;
for (let round = 0; round < 24; round += 1) {
  const stages = STAGES.map((item) => {
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

process.stdout.write('\n');
if (failedCount) {
  process.stdout.write('✗ ' + failedCount + ' 项失败\n');
  process.exit(1);
}
process.stdout.write('✓ 全部通过\n');

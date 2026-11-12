/**
 * 视觉回归：把面板真实渲染成 HTML（真 CSS、真 DOM 结构），交给无头 Chrome 量尺寸。
 *
 * 为什么需要它：client.js 是单文件 React，样式全在 CSS 数组里；改版最容易出的问题是
 * 「横向溢出」「项目多了把阶段挤走」「KPI 挤成一行看不完」——这些都不是语法错，
 * node --check 和冒烟测试都抓不到，只有真排版才算得出来。
 *
 * 做法：用极简假 React 把 Panel 渲成树 → 序列化成 HTML（class/style/data-* 原样带上）
 *      → 注入 client.js 里那份 CSS → Chrome 打开 → CDP 量盒子 → 截图。
 *
 * 跑法：node tests/visual.mjs [--keep]
 *   --keep  保留生成的 HTML 与截图（默认也保留，放在 tests/out/，方便人肉看一眼）
 * 需要本机有 Chrome；找不到就报错退出（不静默跳过）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, '..', 'client.js');
const OUT = path.join(here, 'out');

/* ============================ 极简 React ============================ */

let current = null;
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

function expand(node, depth = 0) {
  if (depth > 80) throw new Error('渲染层数过深，疑似循环');
  if (Array.isArray(node)) return node.map((item) => expand(item, depth + 1)).filter((item) => item !== null);
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
  if (!node || typeof node !== 'object' || node.type === undefined) return { text: String(node) };
  const { type, props } = node;
  if (typeof type === 'function') {
    const inst = { fn: type, slots: {}, i: 0, changed: false };
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

function renderRoot(Component, props) {
  for (let pass = 0; pass < 5; pass += 1) {
    dirty = false;
    current = null;
    const tree = expand(React.createElement(Component, props));
    if (!dirty) return tree;
  }
  return expand(React.createElement(Component, props));
}

/* ============================ 加载 client.js ============================ */

const PATCHES = [
  ['var snapState = useState(null);', 'var snapState = useState(globalThis.__DSA__.snap);'],
  ['var preflightState = useState(null);', 'var preflightState = useState(globalThis.__DSA__.pre);'],
  ['var loadingState = useState(true);', 'var loadingState = useState(globalThis.__DSA__.loading);'],
  ['var dialogState = useState(null);', 'var dialogState = useState(globalThis.__DSA__.dialog);'],
  ["var widthState = useState('wide');", "var widthState = useState(globalThis.__DSA__.width);"],
  ["var themeState = useState('light');", "var themeState = useState(globalThis.__DSA__.theme);"],
  ["var selectedState = useState('scope');", "var selectedState = useState(globalThis.__DSA__.selected);"],
  // 输入行的「下一步」：它的数据来自 /summary 轮询、状态来自点击本身，静态渲染要能种进去才量得到
  ['var stateTuple = useState(null);', 'var stateTuple = useState(globalThis.__DSA__.wb);'],
  ["var phaseTuple = useState('idle');", "var phaseTuple = useState(globalThis.__DSA__.phase || 'idle');"],
  ["var flashTuple = useState('');", "var flashTuple = useState(globalThis.__DSA__.flash || '');"],
];

function loadPanel() {
  let source = fs.readFileSync(CLIENT, 'utf8');
  for (const [from] of PATCHES) {
    if (!source.includes(from)) throw new Error('client.js 结构变了：找不到 ' + from + '，请更新 PATCHES');
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
  new Function('window', 'document', 'globalThis', source)(
    windowStub,
    { createElement: () => ({ style: {} }) },
    globalThis,
  );
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
      } catch {
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
  return { panel, registered, source };
}

/** 直接从源码里取出 CSS 数组求值——不复制、不改写，量到的一定是面板真用的那份。 */
function extractCss(source) {
  const start = source.indexOf('var CSS = [');
  if (start < 0) throw new Error('client.js 里找不到 var CSS = [');
  const end = source.indexOf("].join('');", start);
  if (end < 0) throw new Error('client.js 里找不到 CSS 数组结尾');
  const arraySource = source.slice(start + 'var CSS = '.length, end + 1);
  return new Function('return ' + arraySource + ".join('');")();
}

/* ============================ 序列化成 HTML ============================ */

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function styleAttr(style) {
  if (!style || typeof style !== 'object') return '';
  const parts = [];
  for (const key of Object.keys(style)) {
    const value = style[key];
    if (value === null || value === undefined || value === '') continue;
    const prop = key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    parts.push(prop + ':' + String(value));
  }
  return parts.length ? parts.join(';') : '';
}

function attrsOf(props) {
  const out = [];
  if (props.className) out.push('class="' + escapeHtml(props.className) + '"');
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'className' || key === 'style') continue;
    if (typeof props[key] === 'function') continue;
    if (!/^(data-|aria-)/.test(key) && key !== 'title') continue;
    if (props[key] === undefined || props[key] === null || props[key] === false) continue;
    out.push(key + '="' + escapeHtml(props[key] === true ? '' : props[key]) + '"');
  }
  const style = styleAttr(props.style);
  if (style) out.push('style="' + escapeHtml(style) + '"');
  return out.length ? ' ' + out.join(' ') : '';
}

function serialize(node) {
  if (!node) return '';
  if (node.text !== undefined) return escapeHtml(node.text);
  const tag = node.tag;
  const open = '<' + tag + attrsOf(node.props || {}) + '>';
  if (VOID_TAGS.has(tag)) return open;
  const inner = (node.children || []).map(serialize).join('');
  return open + inner + '</' + tag + '>';
}

function buildPage({ panel, css, snap, pre, width, theme }) {
  globalThis.__DSA__ = { snap, pre, loading: false, dialog: null, width, theme, selected: 'audit' };
  const tree = renderRoot(panel, {});
  const body = serialize(tree);
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<title>visual</title><style>html,body{height:100%;margin:0}',
    // 面板在宿主的侧栏里，宽度由容器决定；这里给个固定视口宽，量到的就是那一档的排版
    'body{height:100vh;overflow:hidden}',
    css,
    '</style></head><body>',
    body,
    '</body></html>',
  ].join('');
}

/* ============================ Chrome / CDP ============================ */

function chromePath() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error('找不到 Chrome（试过：' + candidates.join(' / ') + '）');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  return res.json();
}

async function withChrome(fn) {
  const port = 9222 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-visual-'));
  const child = spawn(
    chromePath(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--user-data-dir=' + profile,
      '--remote-debugging-port=' + String(port),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    let targets = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        targets = await fetchJson('http://127.0.0.1:' + port + '/json/list');
        if (targets && targets.length) break;
      } catch {
        await sleep(150);
      }
    }
    if (!targets || !targets.length) throw new Error('Chrome 没有起来（CDP 端口 ' + port + '）');
    return await fn({ port, targets });
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经退了 */
    }
    await sleep(120);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function openPage({ port, url, width, height }) {
  const target = await fetchJson(
    'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url),
    { method: 'PUT' },
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) events.push(msg);
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.enable');
  await send('Page.navigate', { url });
  // 等字体与首帧；headless 里没有 web font，给一帧就够
  for (let i = 0; i < 40; i += 1) {
    const ready = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (ready.result && ready.result.value === 'complete') break;
    await sleep(100);
  }
  await sleep(250);

  return {
    send,
    async eval(expression) {
      const out = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: false,
      });
      if (out.exceptionDetails) throw new Error('页面里报错：' + JSON.stringify(out.exceptionDetails.text));
      return out.result.value;
    },
    async screenshot(file) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/* ============================ 夹具 ============================ */

function gate(status, index) {
  const level = index % 3 === 0 ? 'error' : index % 3 === 1 ? 'warn' : 'info';
  return {
    id: 'gate-' + index,
    label: ['语料指纹与现场一致', '来源账与审计对得上', '漏斗单步收敛', '图表字形不小于 7.2pt', '稿子里的数字对得上产物'][
      index % 5
    ],
    level,
    status,
    detail: '现在 223 个文件 / 36,055,673 字节，与审计快照逐项相等。',
  };
}

function stage(id, index, name, status, gateStatuses) {
  return {
    id,
    index,
    name,
    short: name.slice(0, 2),
    purpose: name + '：把这一步的产物做出来，并用闸门判它够不够格进下一步。',
    script: 'scripts/step.py',
    args: ['--root', 'data'],
    steps: [],
    status,
    gates: (gateStatuses || ['pass']).map((s, i) => gate(s, i)),
    artifacts: [{ label: '产物', rel: 'output/' + id + '/x.csv', exists: true, size: 2048 }],
    lastRun:
      index < 3
        ? { id: 'run-' + index, status: 'ok', startedAt: '2026-11-12T09:00:00Z', endedAt: '2026-11-12T09:01:00Z', exitCode: 0 }
        : null,
  };
}

const STAGE_DEFS = [
  ['scope', '范围与口径', 'done', ['pass', 'pass']],
  ['audit', '资料审计', 'review', ['pass', 'unjudged', 'pass', 'pass']],
  ['coding', '编码与抽取', 'blocked', ['pass', 'fail', 'pass']],
  ['dataset', '数据集', 'todo', []],
  ['stats', '统计分析', 'todo', []],
  ['figures', '图表', 'todo', []],
  ['manuscript', '文稿', 'todo', []],
  ['qa', '质检', 'todo', []],
  ['recheck', '复核', 'todo', []],
];

/** 项目列表必须能滚：这里造 14 个，真机上项目多了就是这个样子。 */
function projects(count) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    list.push({
      id: 'p' + i,
      name:
        i === 0
          ? '环境资源犯罪裁判文书实证分析'
          : '项目 ' + (i + 1) + (i % 4 === 0 ? '（生态修复·长江流域十年样本）' : ''),
      path: 'F:\\测试文件\\' + (i === 0 ? 'spss_analysis' : 'proj-' + (i + 1)),
      updatedAt: '2026-11-12T09:00:00Z',
      exists: i !== 13,
    });
  }
  return list;
}

function snapshot(projectCount) {
  const stages = STAGE_DEFS.map((def, i) => stage(def[0], i, def[1], def[2], def[3]));
  const counts = { done: 0, blocked: 0, review: 0, todo: 0, running: 0 };
  for (const s of stages) counts[s.status] += 1;
  return {
    ok: true,
    config: {
      pythonPath: 'python',
      skillRoot: 'C:\\Users\\x\\.agents\\skills\\empirical-research-pipeline',
      modelMode: 'follow',
      maxRuns: 60,
      maxLogLines: 800,
      dataDir: '',
      modelProvider: '',
      modelId: '',
      assistantMaxTokens: 1800,
    },
    skill: { ok: true, version: '2.3.0', sha256: 'abcdef1234', scripts: 12, root: 'C:/skill' },
    python: { ok: true, version: '3.11.5', executable: 'C:/Python311/python.exe' },
    projects: projects(projectCount),
    active: {
      id: 'p0',
      name: '环境资源犯罪裁判文书实证分析',
      path: 'F:\\测试文件\\spss_analysis',
      scope: { note: '环境资源犯罪裁判文书的量刑影响因素' },
      sessionId: 'sess-1',
      createdAt: '2026-11-01T00:00:00Z',
      skillDrift: false,
    },
    error: '',
    preflight: { status: 'pass', checkedAt: '2026-11-12T10:00:00Z', checks: [] },
    stages,
    summary: counts,
    totals: { pass: 9, fail: 1, unjudged: 2 },
    artifacts: {
      flow: [
        {
          file: 'output/audit/sample_flow.csv',
          source: 'audit',
          unit: '份',
          steps: [
            { stage: '扫描', n: 223, note: '' },
            { stage: '去重', n: 223, note: '' },
            { stage: '可读', n: 223, note: '' },
          ],
          monotonic: true,
          first: 223,
          last: 223,
        },
      ],
      corpus: {
        totalFiles: 223,
        validFiles: 223,
        uniqueValidFiles: 223,
        unreadableFiles: 0,
        truncated: 0,
        fingerprint: { files: 223, bytes: 36055673 },
      },
      figures: { file: 'output/figures/chart_manifest.csv', total: 6, summary: { count: 6 }, rows: [] },
      models: [],
      flowChecks: [],
      verify: { file: 'output/verify/number_issues.csv', rows: 0, counts: { error: 0, warning: 1 }, issues: [] },
      qa: [{ name: 'report.json', errors: 0, warnings: 2, mtimeMs: 0 }],
      analysis: { rows: 223 },
      manuscript: 120000,
      analysisCsv: 20480,
      tables: 4,
    },
    runs: [
      { id: 'run-8f2a1c', stageId: 'audit', status: 'ok', startedAt: '2026-11-12T04:41:07Z', endedAt: '2026-11-12T04:41:12Z', exitCode: 0 },
      { id: 'run-7c1d04', stageId: 'audit', status: 'failed', startedAt: '2026-11-12T04:33:12Z', endedAt: '2026-11-12T04:33:17Z', exitCode: 2 },
      { id: 'run-6a0e88', stageId: 'scope', status: 'ok', startedAt: '2026-11-12T03:58:40Z', endedAt: '2026-11-12T03:58:41Z', exitCode: 0 },
    ],
    adjudications: [],
    activeRuns: {},
    materials: {
      platform: 'win32',
      isWindows: true,
      sources: [
        {
          id: 'src_1',
          label: '刑事判例（29 省）',
          path: 'F:\\测试文件\\案例打包pdf\\刑事pdf',
          files: 2907,
          realFiles: 2907,
          bytesText: '1.2 GB',
          byChannel: { read: 2903, vision: 4, convert: 0, none: 0, junk: 4 },
          usedBy: [{ project: '环境资源犯罪裁判文书实证分析', projectPath: 'F:\\测试文件\\spss_analysis', as: '安徽' }],
          scannedAt: '2026-11-12T00:00:00Z',
        },
      ],
      mounts: [
        { as: '安徽', sourceId: 'src_1', sourceLabel: '刑事判例（29 省）', entry: '安徽', target: 'F:\\测试文件\\案例打包pdf\\刑事pdf', status: 'ok', mode: 'junction', resolved: 'F:\\测试文件\\案例打包pdf\\刑事pdf\\安徽', detail: '挂载指向 …\\刑事pdf\\安徽' },
        { as: '北京', sourceId: 'src_1', sourceLabel: '刑事判例（29 省）', entry: '北京', target: 'F:\\测试文件\\案例打包pdf\\刑事pdf', status: 'ok', mode: 'junction', resolved: 'F:\\测试文件\\案例打包pdf\\刑事pdf\\北京', detail: '挂载指向 …\\刑事pdf\\北京' },
        { as: '福建', sourceId: 'src_1', sourceLabel: '刑事判例（29 省）', entry: '福建', target: 'F:\\测试文件\\案例打包pdf\\刑事pdf', status: 'ok', mode: 'junction', resolved: 'F:\\测试文件\\案例打包pdf\\刑事pdf\\福建', detail: '挂载指向 …\\刑事pdf\\福建' },
      ],
      derived: [],
      entries: [],
    },
    layout: { width: 'wide' },
  };
}

const PRE_OK = {
  ok: true,
  status: 'pass',
  checkedAt: '2026-11-12T10:00:00Z',
  platform: 'win32',
  isWindows: true,
  python: 'C:/Python311/python.exe',
  pythonCommand: 'python',
  skill: { ok: true, version: '2.3.0', sha256: 'abcdef1234', scripts: 12, root: 'C:/skill' },
  checks: [
    { id: 'skill', label: '技能包', status: 'pass', detail: 'empirical-research-pipeline 2.3.0', hint: '' },
    { id: 'python', label: 'Python', status: 'pass', detail: '3.11.5', hint: '' },
    { id: 'modules', label: 'Python 依赖', status: 'pass', detail: '9 个依赖都在', hint: '' },
    { id: 'word', label: 'Word 转 PDF', status: 'pass', detail: '可用', hint: '' },
  ],
};

/* ============================ 原生对话里的零件 ============================ */

// 「运行下一步」长在宿主的输入行里，不在面板里：那里没有 --dsa-* 令牌，横向只有几百像素。
// 用一个假输入行（左簇 + 右簇）量它：按钮必须真画出边框（令牌一丢就退化成裸文字）、
// 总宽封顶、长阶段名走省略号，而且不许把右边的控件挤走。这几件事只有真排版算得出来。
const COMPOSER_WB = (patch) =>
  Object.assign(
    {
      ok: true,
      active: { id: 'p1', name: '测试项目', path: 'F:\\研究\\2026', sessionId: 's1' },
      summary: { done: 3, review: 1 },
      totals: { fail: 0 },
      running: false,
      next: { id: 'coding', index: 3, name: '编码与抽取', status: 'todo', script: 'scripts/03-code.py', args: [] },
    },
    patch,
  );

const COMPOSER_CASES = [
  {
    key: 'idle-long-name',
    phase: 'idle',
    flash: '',
    expectClip: true,
    wb: COMPOSER_WB({
      next: {
        id: 'stats',
        index: 4,
        name: '描述统计与回归（含稳健性与多重检验）',
        status: 'todo',
        script: 'scripts/04-stats.py',
        args: [],
      },
    }),
  },
  {
    key: 'running',
    phase: 'idle',
    flash: '',
    wb: COMPOSER_WB({
      running: true,
      next: { id: 'coding', index: 3, name: '编码与抽取', status: 'running', script: 'scripts/03-code.py', args: [] },
    }),
  },
  {
    key: 'error-long-text',
    phase: 'error',
    flash: '启动失败 资料审计还有 2 个 error 级未过，先修产物再往下走',
    expectClip: true,
    wb: COMPOSER_WB({}),
  },
];

function composerPage({ css, slotHtml }) {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>composer</title><style>',
    'html,body{margin:0}',
    'body{padding:28px;background:#fff;color:#1d2129;font:13px system-ui,"Microsoft YaHei",sans-serif}',
    '.host-row{display:flex;align-items:center;gap:10px;width:880px;box-sizing:border-box;padding:0 10px;',
    '  height:52px;border:1px solid #e5e6eb;border-radius:12px;}',
    '.host-left{display:flex;align-items:center;gap:10px;min-width:0;flex:0 1 auto;}',
    '.host-spacer{flex:1 1 auto;}',
    '.host-right{display:flex;align-items:center;gap:10px;flex:0 0 auto;}',
    '.host-btn{white-space:nowrap;color:#4e5969;}',
    '.host-fixed{width:96px;height:26px;line-height:26px;text-align:center;border:1px solid #c9cdd4;',
    '  border-radius:8px;box-sizing:border-box;}',
    css,
    '</style></head><body><div class="host-row"><div class="host-left">',
    '<span class="host-btn">＋</span><span class="host-btn">完全权限 ⌄</span><span class="host-btn">技能</span>',
    slotHtml,
    '</div><div class="host-spacer"></div><div class="host-right">',
    '<span class="host-btn">专家 ⌄</span><span class="host-fixed">发送</span>',
    '</div></div></body></html>',
  ].join('');
}

const COMPOSER_PROBE = `(() => {
  const alpha = (c) => {
    const rgba = c.match(/rgba?\\(([^)]+)\\)/);
    if (rgba) { const p = rgba[1].split(',').map(Number); return p.length === 4 ? p[3] : 1; }
    const slash = c.match(/\\/\\s*([\\d.]+)\\s*\\)/);
    return slash ? Number(slash[1]) : 1;
  };
  const row = document.querySelector('.host-row');
  const wrap = document.querySelector('.dsa-cmp');
  const btn = wrap && wrap.querySelector('.dsa-chat-btn');
  if (!btn) return { missing: true, html: document.body.innerHTML.slice(0, 240) };
  const cs = getComputedStyle(btn);
  const clip = wrap.querySelector('.dsa-cmp-name, .dsa-cmp-flash');
  const rect = btn.getBoundingClientRect();
  return {
    pillW: rect.width,
    wrapW: wrap.getBoundingClientRect().width,
    capW: parseFloat(getComputedStyle(wrap).maxWidth),
    rowW: row.getBoundingClientRect().width,
    rowScroll: row.scrollWidth,
    rightW: document.querySelector('.host-fixed').getBoundingClientRect().width,
    borderStyle: cs.borderTopStyle,
    borderWidth: cs.borderTopWidth,
    borderAlpha: alpha(cs.borderTopColor),
    fontSize: parseFloat(cs.fontSize),
    bg: cs.backgroundColor,
    clip: clip ? { scroll: clip.scrollWidth, client: clip.clientWidth } : null,
    label: btn.textContent.trim(),
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
  };
})()`;

/* ============================ 量尺寸 ============================ */

const PROBE = `(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  };
  const overflow = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible') continue;
    if (el.scrollWidth > el.clientWidth + 2) {
      overflow.push({
        sel: (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/)[0] : el.tagName),
        scroll: el.scrollWidth,
        client: el.clientWidth,
      });
    }
  }
  const projList = document.querySelector('.dsa-proj-list');
  const railBody = document.querySelector('.dsa-rail-body');
  const kpis = document.querySelector('.dsa-kpis');
  const kpiCols = kpis ? getComputedStyle(kpis).gridTemplateColumns.split(' ').length : 0;
  const stages = [...document.querySelectorAll('.dsa-rail-body .dsa-stage')];

  const lum = (hex) => {
    const m = hex.match(/\\d+/g);
    if (!m) return null;
    const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    if (a === null || b === null) return null;
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const pair = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    // 背景不能只看元素自己：卡片是白底但没设 background-color（用的是 panel 变量），
    // KPI 高亮项干脆是渐变。所以往上找第一个有底色/渐变色的祖先，别拿「透明」当黑色算出假比值。
    const bgOf = (start) => {
      let node = start;
      while (node) {
        const cs = getComputedStyle(node);
        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
        const match = cs.backgroundImage && cs.backgroundImage.match(/rgba?\\([^)]+\\)/);
        if (match) return match[0];
        node = node.parentElement;
      }
      return 'rgb(255, 255, 255)';
    };
    const color = getComputedStyle(el).color;
    const bg = bgOf(el);
    return { color, bg, ratio: ratio(color, bg) };
  };

  return {
    docWidth: document.documentElement.scrollWidth,
    viewWidth: window.innerWidth,
    docHeight: document.documentElement.scrollHeight,
    viewHeight: window.innerHeight,
    boxes: {
      top: rect('.dsa-top'),
      body: rect('.dsa-body'),
      rail: rect('.dsa-rail'),
      railSec: rect('.dsa-rail-sec'),
      projList: rect('.dsa-proj-list'),
      railBody: rect('.dsa-rail-body'),
      main: rect('.dsa-main'),
      hero: rect('.dsa-hero'),
      kpis: rect('.dsa-kpis'),
      side: rect('.dsa-side'),
    },
    projScroll: projList ? { scroll: projList.scrollHeight, client: projList.clientHeight, count: projList.children.length } : null,
    projRows: projList ? projList.children.length : 0,
    stageCount: stages.length,
    stagesBottom: stages.length ? Math.round(stages[stages.length - 1].getBoundingClientRect().bottom) : null,
    // 状态不能只靠颜色：每个阶段行都得有一段文字说明（完成/拦住/待办…）
    stagePills: [...document.querySelectorAll('.dsa-rail-body .dsa-stage .dsa-stage-meta')].map((el) => el.textContent.trim()),
    kpiValues: [...document.querySelectorAll('.dsa-kpis .dsa-kpi .v')].map((el) => el.textContent.trim()),
    kpiCols,
    kpiCount: kpis ? kpis.children.length : 0,
    // 形状层：确认 C 的视觉语言真的落到了计算样式上（不是只写在 CSS 里没人用）
    styles: (() => {
      const cs = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          h: Math.round(r.height),
          w: Math.round(r.width),
          radius: parseFloat(s.borderTopLeftRadius) || 0,
          shadow: s.boxShadow,
          bg: s.backgroundColor,
          color: s.color,
          size: parseFloat(s.fontSize) || 0,
          weight: Number(s.fontWeight) || 400,
        };
      };
      return {
        top: cs('.dsa-top'),
        logo: cs('.dsa-logo'),
        chip: cs('.dsa-chip'),
        btn: cs('.dsa-top .dsa-btn'),
        kpi: cs('.dsa-kpi'),
        hero: cs('.dsa-hero'),
        proj: cs('.dsa-proj'),
        stage: cs('.dsa-stage'),
        pill: cs('.dsa-stage-meta'),
        log: cs('.dsa-log'),
      };
    })(),
    sideVisible: (() => {
      const el = document.querySelector('.dsa-side');
      if (!el) return false;
      return getComputedStyle(el).display !== 'none';
    })(),
    // 细节体检：折叠行是否卡中卡、正文是否只写了一半、字号是否碎成一片
    folds: [...document.querySelectorAll('details')].map((el) => {
      const cs = getComputedStyle(el);
      const sum = el.querySelector(':scope > summary');
      const scs = sum ? getComputedStyle(sum) : null;
      const r = el.getBoundingClientRect();
      return {
        cls: el.className || '(none)',
        parent: (el.parentElement && el.parentElement.className) || '',
        nestedInCard: !!el.closest('.dsa-card'),
        open: el.open,
        w: Math.round(r.width),
        h: Math.round(r.height),
        border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
        // 卡里的折叠允许留一条顶部分隔线，但不该有左右/下边框（那是「又一个卡片」的标志）
        borderSides: [cs.borderLeftWidth, cs.borderRightWidth, cs.borderBottomWidth].join(' '),
        shadow: cs.boxShadow,
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
        summaryPad: scs ? scs.padding : '',
        summarySize: scs ? parseFloat(scs.fontSize) : 0,
      };
    }),
    mainGaps: (() => {
      const main = document.querySelector('.dsa-main');
      if (!main) return [];
      const kids = [...main.children];
      const out = [];
      for (let i = 1; i < kids.length; i += 1) {
        const prev = kids[i - 1].getBoundingClientRect();
        const cur = kids[i].getBoundingClientRect();
        out.push({
          cls: (kids[i].className || kids[i].tagName) + '',
          gap: Math.round(cur.top - prev.bottom),
        });
      }
      return out;
    })(),
    smallText: [...document.querySelectorAll('.dsa-main *, .dsa-rail *')]
      .filter((el) => {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) return false;
        const size = parseFloat(getComputedStyle(el).fontSize) || 0;
        return size > 0 && size < 11;
      })
      .map((el) => ({
        cls: (el.className || el.tagName) + '',
        size: parseFloat(getComputedStyle(el).fontSize),
        text: el.textContent.trim().slice(0, 24),
      })),
    overflow,
    contrast: {
      hint: pair('.dsa-hint'),
      kpiKey: pair('.dsa-kpi .k'),
      kpiValue: pair('.dsa-kpi .v'),
      stageMeta: pair('.dsa-stage.sel .dsa-stage-meta') || pair('.dsa-stage-meta'),
      purpose: pair('.dsa-sub'),
      title: pair('.dsa-h1'),
    },
  };
})()`;

/* ============================ 主流程 ============================ */

const VARIANTS = [
  { key: 'wide', width: 1560, height: 1000, widthClass: 'wide', theme: 'light', projects: 14 },
  { key: 'medium', width: 1180, height: 900, widthClass: 'compact', theme: 'light', projects: 14 },
  { key: 'narrow', width: 900, height: 900, widthClass: 'narrow', theme: 'light', projects: 4 },
  { key: 'dark', width: 1560, height: 1000, widthClass: 'wide', theme: 'dark', projects: 3 },
];

async function main() {
  const { panel, registered, source } = loadPanel();
  const css = extractCss(source);
  if (!css.includes('--dsa-bg')) throw new Error('取到的 CSS 里没有设计令牌，提取逻辑失效了');

  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const composerResults = [];

  await withChrome(async ({ port }) => {
    for (const variant of VARIANTS) {
      const snap = snapshot(variant.projects);
      const html = buildPage({
        panel,
        css,
        snap,
        pre: PRE_OK,
        width: variant.widthClass,
        theme: variant.theme,
      });
      const file = path.join(OUT, 'panel-' + variant.key + '.html');
      fs.writeFileSync(file, html, 'utf8');
      const page = await openPage({
        port,
        url: 'file:///' + file.replace(/\\/g, '/'),
        width: variant.width,
        height: variant.height,
      });
      try {
        const probe = await page.eval(PROBE);
        await page.screenshot(path.join(OUT, 'panel-' + variant.key + '.png'));
        results.push({ variant, probe });
      } finally {
        page.close();
      }
    }

    /* 输入行里的「下一步」：拿真组件 + 真 CSS 渲进假输入行，量宽度与边框 */
    const slot = registered.get('conversation.input.left');
    if (!slot) throw new Error('client.js 没有注册 conversation.input.left');
    for (const item of COMPOSER_CASES) {
      globalThis.__DSA__ = {
        snap: null,
        pre: null,
        loading: false,
        dialog: null,
        width: 'wide',
        theme: 'light',
        selected: 'scope',
        wb: item.wb,
        phase: item.phase,
        flash: item.flash,
      };
      const slotHtml = serialize(renderRoot(slot, { sessionId: 's1' }));
      const file = path.join(OUT, 'composer-' + item.key + '.html');
      fs.writeFileSync(file, composerPage({ css, slotHtml }), 'utf8');
      const page = await openPage({
        port,
        url: 'file:///' + file.replace(/\\/g, '/'),
        width: 960,
        height: 200,
      });
      try {
        const probe = await page.eval(COMPOSER_PROBE);
        let hoverBg = '';
        if (!probe.missing) {
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.cx, y: probe.cy });
          await sleep(220);
          hoverBg = await page.eval(
            "(() => { const b = document.querySelector('.dsa-cmp .dsa-chat-btn'); return b ? getComputedStyle(b).backgroundColor : ''; })()",
          );
        }
        await page.screenshot(path.join(OUT, 'composer-' + item.key + '.png'));
        composerResults.push({ item, probe, hoverBg });
      } finally {
        page.close();
      }
    }
  });

  /* ---------------- 断言 ---------------- */
  const problems = [];
  const check = (ok, message) => {
    if (!ok) problems.push(message);
  };

  for (const { variant, probe } of results) {
    const tag = variant.key + '(' + variant.width + 'px)';
    check(probe.docWidth <= probe.viewWidth + 2, tag + ' 有横向溢出：' + probe.docWidth + ' > ' + probe.viewWidth);
    check(probe.overflow.length === 0, tag + ' 有元素横向溢出：' + JSON.stringify(probe.overflow.slice(0, 3)));
    check(probe.kpiCount === 5, tag + ' KPI 应该是 5 个，实际 ' + probe.kpiCount);
    check(probe.kpiCols >= 2, tag + ' KPI 挤成 ' + probe.kpiCols + ' 列');
    check(probe.kpiValues.every((v) => v && v !== 'undefined' && v !== 'NaN'), tag + ' KPI 数值有空的：' + probe.kpiValues.join(' | '));
    check(probe.stageCount >= 9, tag + ' 阶段没排全：' + probe.stageCount);
    // 状态不只靠颜色：每一行都要有一段状态文字
    const blankPills = probe.stagePills.filter((text) => !text).length;
    check(blankPills === 0, tag + ' 有 ' + blankPills + ' 个阶段只有色点没有状态文字');
    if (variant.widthClass !== 'narrow' && probe.railBody && probe.stagesBottom !== null) {
      check(probe.stagesBottom <= probe.railBody.bottom + 2, tag + ' 阶段被挤到左栏可视区外');
    }
    // 项目多时列表自己滚，且不把下面顶走
    if (variant.projects > 10 && probe.projScroll) {
      check(probe.projScroll.scroll > probe.projScroll.client, tag + ' 项目列表没出现滚动条（' + JSON.stringify(probe.projScroll) + '）');
      check(probe.projRows === variant.projects, tag + ' 项目行数不对：' + probe.projRows);
      check(probe.boxes.railSec.h <= probe.boxes.rail.h * 0.5, tag + ' 项目区占了左栏 ' + probe.boxes.railSec.h + '/' + probe.boxes.rail.h);
    }
    for (const [name, pair] of Object.entries(probe.contrast)) {
      if (!pair || pair.ratio === null) continue;
      check(pair.ratio >= 4.5, tag + ' ' + name + ' 对比度只有 ' + pair.ratio + '（' + pair.color + ' on ' + pair.bg + '）');
    }

    // 形状层：圆角、阴影、尺寸这些「看起来像不像」的东西，只有算出来的值才算数
    const s = probe.styles;
    check(s.top && s.top.h === 58, tag + ' 顶栏不是 58px：' + (s.top && s.top.h));
    check(s.top && s.top.bg !== 'rgba(0, 0, 0, 0)', tag + ' 顶栏没有底色');
    check(s.logo && s.logo.radius >= 8 && s.logo.h === 30, tag + ' 品牌标不是 30px 圆角块');
    check(s.chip && s.chip.radius >= 100, tag + ' 顶栏徽章不是 pill（radius=' + (s.chip && s.chip.radius) + '）');
    check(s.btn && s.btn.h === 32 && s.btn.radius >= 8, tag + ' 顶栏按钮不是 32px/8px');
    check(s.kpi && s.kpi.radius >= 10 && s.kpi.shadow !== 'none', tag + ' KPI 卡没有圆角或阴影');
    check(s.kpi && s.kpi.size >= 0, tag + ' KPI 卡缺样式');
    check(s.hero && s.hero.shadow !== 'none' && s.hero.radius >= 10, tag + ' hero 卡没有圆角或阴影');
    check(s.proj && s.proj.radius >= 8, tag + ' 项目行没有圆角');
    check(s.stage && s.stage.radius >= 8, tag + ' 阶段行没有圆角');
    check(s.pill && s.pill.radius >= 100, tag + ' 阶段状态不是 pill');
    check(s.log && s.log.bg === 'rgb(20, 24, 33)', tag + ' 日志卡不是深色终端底：' + (s.log && s.log.bg));
    // 宽屏右栏常驻；窄一档起改成抽屉（有按钮能开），默认收起是设计如此
    if (variant.widthClass === 'wide') {
      check(probe.sideVisible, tag + ' 宽屏右栏不见了（那就再没有入口能看运行记录与日志）');
    }

    // 折叠行不能「卡中卡」：details 自带边框/圆角/阴影，塞进 .dsa-card 就是双重边框加内阴影
    for (const fold of probe.folds.filter((item) => item.nestedInCard)) {
      check(fold.borderSides === '0px 0px 0px', tag + ' 卡里的折叠行还带着左右/下边框：' + fold.cls + ' → ' + fold.borderSides);
      check(fold.shadow === 'none', tag + ' 卡里的折叠行还自带阴影：' + fold.cls);
      check(fold.radius === 0, tag + ' 卡里的折叠行还自带圆角：' + fold.cls + ' → ' + fold.radius);
    }
    check(probe.smallText.length === 0, tag + ' 有 ' + probe.smallText.length + ' 处小于 11px 的字：' + JSON.stringify(probe.smallText.slice(0, 3)));
  }

  /* ---------------- 输入行零件的断言 ---------------- */
  for (const { item, probe, hoverBg } of composerResults) {
    const tag = '输入行 ' + item.key;
    if (probe.missing) {
      check(false, tag + ' 没有渲出「下一步」按钮', String(probe.html || '').replace(/\s+/g, ' ').slice(0, 120));
      continue;
    }
    check(probe.pillW <= 281, tag + ' 按钮没有封顶：' + Math.round(probe.pillW) + 'px');
    check(probe.capW <= 281, tag + ' 封顶值不对：max-width=' + probe.capW);
    check(probe.rowScroll <= probe.rowW + 1, tag + ' 把输入行撑出溢出：' + probe.rowScroll + ' > ' + Math.round(probe.rowW));
    check(probe.rightW >= 95, tag + ' 右侧控件被挤窄：' + Math.round(probe.rightW) + 'px');
    check(
      probe.borderStyle === 'solid' && probe.borderWidth === '1px',
      tag + ' 按钮没有可见边框：' + probe.borderStyle + ' ' + probe.borderWidth,
    );
    check(probe.borderAlpha > 0.05, tag + ' 边框是透明的（令牌丢了）：alpha=' + probe.borderAlpha);
    check(probe.fontSize >= 12, tag + ' 字号小于 12px：' + probe.fontSize);
    check(
      Boolean(hoverBg) && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(hoverBg),
      tag + ' 悬停没有可见反馈：' + hoverBg,
    );
    if (item.expectClip && probe.clip) {
      check(probe.clip.scroll > probe.clip.client, tag + ' 长文本没走省略号：' + probe.clip.scroll + ' / ' + probe.clip.client);
    }
  }

  /* ---------------- 报告 ---------------- */
  const line = (label, value) => console.log('  ' + label.padEnd(10) + value);
  console.log('\n视觉回归（真渲染 + 真 CSS）\n');
  for (const { variant, probe } of results) {
    console.log(variant.key + '  ' + variant.width + '×' + variant.height + '  ' + variant.theme + '  项目 ' + variant.projects + ' 个');
    line('画布', probe.docWidth + ' / ' + probe.viewWidth + ' 宽');
    line('左栏', probe.boxes.rail ? probe.boxes.rail.w + 'px' : '—');
    line('项目区', probe.boxes.railSec ? probe.boxes.railSec.h + 'px（列表 ' + (probe.projScroll ? probe.projScroll.client + '/' + probe.projScroll.scroll : '—') + '）' : '—');
    line('阶段', probe.stageCount + ' 行，底边 ' + probe.stagesBottom + ' / 容器 ' + (probe.boxes.railBody ? probe.boxes.railBody.bottom : '—'));
    line('KPI', probe.kpiCount + ' 个 · ' + probe.kpiCols + ' 列');
    const contrast = Object.entries(probe.contrast)
      .filter(([, v]) => v && v.ratio !== null)
      .map(([k, v]) => k + ' ' + v.ratio)
      .join(' · ');
    line('对比度', contrast);
    line(
      '折叠',
      probe.folds.length
        ? probe.folds.map((f) => (f.cls || 'details') + ' ' + f.h + 'px' + (f.nestedInCard ? '（卡内）' : '')).join(' · ')
        : '—'
    );
    line('块间距', probe.mainGaps.map((g) => g.cls + ':' + g.gap).join(' · '));
    if (probe.smallText.length) line('小字', JSON.stringify(probe.smallText.slice(0, 6)));
    console.log('');
  }

  if (problems.length) {
    console.log('✗ 有问题 ' + problems.length + ' 条：');
    for (const problem of problems) console.log('  - ' + problem);
    process.exitCode = 1;
    return;
  }
  console.log('✓ 视觉回归全部通过（截图在 tests/out/）');
}

await main();

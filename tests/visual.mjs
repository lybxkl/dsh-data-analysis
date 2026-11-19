/**
 * 视觉回归：把新面板真实渲染成 HTML（真 CSS、真 DOM 结构），交给无头 Chrome 量尺寸。
 *
 * 盯的是改版最容易出的问题：横向溢出、左栏过宽、页签被挤掉、窄屏没有入口、暗色没生效。
 * 跑法：node tests/visual.mjs（需要本机 Chrome；找不到就报错，不静默跳过）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, '..', 'client.js');
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });

/* ============================ 极简 React ============================ */

let current = null;
let dirty = false;
let cmpSeq = 0;
let hookStore = new Map();

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
    merged.children = children.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false);
    return { type, props: merged };
  },
  useState(initial) {
    const { inst, index } = slot();
    const key = inst.key + ':' + index;
    if (!hookStore.has(key)) hookStore.set(key, initial);
    const setter = (value) => {
      const next = typeof value === 'function' ? value(hookStore.get(key)) : value;
      if (Object.is(next, hookStore.get(key))) return;
      hookStore.set(key, next);
      dirty = true;
    };
    return [hookStore.get(key), setter];
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(fn) {
    slot();
    return fn();
  },
  useCallback(fn) {
    slot();
    return fn();
  },
  useRef(value) {
    const { inst, index } = slot();
    const key = inst.key + ':' + index;
    if (!hookStore.has(key)) hookStore.set(key, { current: value });
    return hookStore.get(key);
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
  return { tag: type, props: props || {}, children: ((props && props.children) || []).map((item) => expand(item, depth + 1)).filter(Boolean) };
}

function renderRoot(Component, props) {
  for (let pass = 0; pass < 5; pass += 1) {
    dirty = false;
    cmpSeq = 0;
    current = null;
    const tree = expand(React.createElement(Component, props));
    if (!dirty) return tree;
  }
  return expand(React.createElement(Component, props));
}

/* ============================ 加载 client.js ============================ */

const PATCHES = [
  ['var stateTuple = useState(STATE_CACHE.state);', 'var stateTuple = useState(globalThis.__DSA__.state);'],
  ['var treeTuple = useState(STATE_CACHE.tree);', 'var treeTuple = useState(globalThis.__DSA__.tree);'],
  ["var selectedState = useState('');", "var selectedState = useState(globalThis.__DSA__.selected || '');"],
  ['var loadingState = useState(!STATE_CACHE.state);', 'var loadingState = useState(false);'],
  ["var widthState = useState('wide');", "var widthState = useState(globalThis.__DSA__.width || 'wide');"],
  ["var themeState = useState('light');", "var themeState = useState(globalThis.__DSA__.theme || 'light');"],
  ['var dialogState = useState(null);', 'var dialogState = useState(globalThis.__DSA__.dialog || null);'],
];

function loadPanel() {
  let source = fs.readFileSync(CLIENT, 'utf8');
  for (const [from] of PATCHES) {
    if (!source.includes(from)) throw new Error('client.js 结构变了：找不到 ' + from + '，请更新 PATCHES');
  }
  for (const [from, to] of PATCHES) source = source.replace(from, to);

  let captured = null;
  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: { load(def) { captured = def; } },
  };
  new Function('window', 'document', 'globalThis', source)(windowStub, {}, globalThis);
  if (!captured || typeof captured.factory !== 'function') throw new Error('client.js 没有调用 __ModuleLoader__.load');
  const exported = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('client.js 请求了宿主模块：' + name);
  });
  const registered = new Map();
  exported.apply({
    effect(fn) { try { fn(); } catch { /* ignore */ } return () => {}; },
    slots: {
      inject(name, fn) { fn(); return () => {}; },
      register(def, component) { registered.set(def && def.name, component); return () => {}; },
    },
  });
  const panel = registered.get('main');
  if (!panel) throw new Error('没有注册 main 面板');
  return { panel, source };
}

function extractCss(source) {
  const start = source.indexOf('var CSS = [');
  if (start < 0) throw new Error('client.js 里找不到 var CSS = [');
  const end = source.indexOf('\n      ];', start);
  if (end < 0) throw new Error('client.js 里找不到 CSS 数组结尾');
  const arraySource = source.slice(start + 'var CSS = '.length, end) + ']';
  return new Function('return ' + arraySource + ".join('');")();
}

/* ============================ 序列化 HTML ============================ */

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function styleAttr(style) {
  if (!style || typeof style !== 'object') return '';
  const parts = [];
  for (const key of Object.keys(style)) {
    const value = style[key];
    if (value === null || value === undefined || value === '') continue;
    parts.push(key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + String(value));
  }
  return parts.length ? parts.join(';') : '';
}
function attrsOf(props) {
  const out = [];
  if (props.className) out.push('class="' + escapeHtml(props.className) + '"');
  const keep = new Set(['title', 'width', 'height', 'viewBox', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'd', 'role', 'tabIndex', 'open']);
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'className' || key === 'style') continue;
    if (typeof props[key] === 'function') continue;
    if (!/^(data-|aria-)/.test(key) && !keep.has(key)) continue;
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
  return open + (node.children || []).map(serialize).join('') + '</' + tag + '>';
}

/* ============================ 夹具 ============================ */

function fixtures() {
  const now = Date.now();
  const tree = {
    ok: true,
    roots: ['output', 'scripts'],
    entries: [
      { kind: 'dir', rel: 'output', name: 'output' },
      { kind: 'dir', rel: 'output/audit', name: 'audit' },
      { kind: 'file', rel: 'output/audit/result.csv', name: 'result.csv', ext: '.csv', size: 120, viewable: true, image: false },
      { kind: 'file', rel: 'output/figures/f01.png', name: 'f01.png', ext: '.png', size: 2048, viewable: true, image: true },
      { kind: 'file', rel: 'output/figures/f02.png', name: 'f02.png', ext: '.png', size: 2048, viewable: true, image: true },
      { kind: 'file', rel: 'output/models/coef.csv', name: 'coef.csv', ext: '.csv', size: 120, viewable: true, image: false },
      { kind: 'file', rel: 'output/qa_report.json', name: 'qa_report.json', ext: '.json', size: 300, viewable: true, image: false },
      { kind: 'file', rel: 'output/report.docx', name: 'report.docx', ext: '.docx', size: 5000, viewable: true, image: false },
      { kind: 'dir', rel: 'scripts', name: 'scripts' },
      { kind: 'file', rel: 'scripts/analysis.py', name: 'analysis.py', ext: '.py', size: 42, viewable: true, image: false },
    ],
    totalFiles: 8,
    totalBytes: 21000,
    truncated: false,
  };
  const state = {
    workspaces: [
      { id: 'ws-1', name: '我的研究', root: 'F:\\research\\proj1', fileCount: 6, latestMtime: now },
      { id: 'ws-2', name: '第二份数据', root: 'F:\\research\\proj2', fileCount: 0, latestMtime: null },
      { id: 'ws-3', name: '已删除的研究', root: 'F:\\research\\gone', fileCount: 0, latestMtime: null, missing: true },
    ],
    active: { id: 'ws-1', name: '我的研究', root: 'F:\\research\\proj1' },
    activeError: '',
    progress: [
      { dir: 'output/audit', name: 'audit', fileCount: 1, latestMtime: now - 120000 },
      { dir: 'output/figures', name: 'figures', fileCount: 2, latestMtime: now - 2 * 3600000 },
      { dir: 'output/models', name: 'models', fileCount: 1, latestMtime: now - 86400000 },
    ],
    tree,
    config: { dataDir: '' },
  };
  return { state, tree };
}

function buildPage({ panel, css, width, theme }) {
  const { state, tree } = fixtures();
  globalThis.__DSA__ = { state, tree, selected: 'ws-1', width, theme };
  hookStore = new Map();
  const body = serialize(renderRoot(panel, {}));
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>visual</title>',
    '<style>html,body{height:100%;margin:0}body{height:100vh;overflow:hidden}' + css + '</style></head><body>',
    body,
    '</body></html>',
  ].join('');
}

/* ============================ Chrome / CDP ============================ */

function chromePath() {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')]
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
  const child = spawn(chromePath(), ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--force-device-scale-factor=1', '--user-data-dir=' + profile, '--remote-debugging-port=' + String(port), 'about:blank'], { stdio: 'ignore' });
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
    return await fn({ port });
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(120);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
async function openPage({ port, url, width, height }) {
  const target = await fetchJson('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Page.navigate', { url });
  for (let i = 0; i < 40; i += 1) {
    const ready = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (ready.result && ready.result.value === 'complete') break;
    await sleep(100);
  }
  await sleep(200);
  return {
    async eval(expression) {
      const out = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (out.exceptionDetails) throw new Error('页面里报错：' + JSON.stringify(out.exceptionDetails.text));
      return out.result.value;
    },
    async screenshot(file) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

/* ============================ 主流程 ============================ */

const problems = [];
function expect(condition, label) {
  if (!condition) problems.push(label);
  console.log((condition ? '  ✓ ' : '  ✗ ') + label);
}

async function main() {
  const { panel, source } = loadPanel();
  const css = extractCss(source);
  const variants = [
    { key: 'wide', width: 1440, height: 900, theme: 'light', breakpoint: 'wide' },
    { key: 'compact', width: 980, height: 800, theme: 'light', breakpoint: 'compact' },
    { key: 'narrow', width: 680, height: 800, theme: 'light', breakpoint: 'narrow' },
    { key: 'dark', width: 1440, height: 900, theme: 'dark', breakpoint: 'wide' },
  ];
  const pages = variants.map((item) => {
    const file = path.join(OUT, 'viewer-' + item.key + '.html');
    fs.writeFileSync(file, buildPage({ panel, css, width: item.breakpoint, theme: item.theme }));
    return { ...item, file };
  });

  await withChrome(async ({ port }) => {
    for (const item of pages) {
      console.log('\n' + item.key + '  ' + item.width + '×' + item.height + '  ' + item.theme);
      const page = await openPage({ port, url: 'file:///' + item.file.replace(/\\/g, '/'), width: item.width, height: item.height });
      try {
        const probe = await page.eval(`(() => {
          const root = document.querySelector('.dsa-root');
          const top = document.querySelector('.dsa-top');
          const rail = document.querySelector('.dsa-rail');
          const main = document.querySelector('.dsa-main');
          const tabs = [...document.querySelectorAll('.dsa-tab')];
          const cards = [...document.querySelectorAll('.dsa-card')];
          const toggle = document.querySelector('.dsa-rail-toggle');
          const missingRow = document.querySelector('.dsa-ws-row.missing');
          const missingRemove = missingRow ? missingRow.querySelector('.dsa-ws-remove') : null;
          const view = document.documentElement.clientWidth;
          const overflowing = [...document.querySelectorAll('.dsa-root *')].filter((el) => {
            const box = el.getBoundingClientRect();
            return box.width > 0 && (box.right > view + 1 || box.left < -1);
          }).length;
          const styles = getComputedStyle(root);
          return {
            doc: document.documentElement.scrollWidth,
            view,
            height: window.innerHeight,
            rootH: Math.round(root.getBoundingClientRect().height),
            topH: Math.round(top.getBoundingClientRect().height),
            railW: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
            railDisplay: rail ? getComputedStyle(rail).display : null,
            mainW: Math.round(main.getBoundingClientRect().width),
            tabs: tabs.length,
            tabTexts: tabs.map((tab) => tab.textContent.trim()),
            cards: cards.length,
            cardW: cards[0] ? Math.round(cards[0].getBoundingClientRect().width) : 0,
            toggleDisplay: toggle ? getComputedStyle(toggle).display : 'none',
            missingRemoveOpacity: missingRemove ? getComputedStyle(missingRemove).opacity : null,
            overflow: overflowing,
            bg: styles.backgroundColor,
            color: styles.color,
            minFont: Math.min(...[...document.querySelectorAll('.dsa-root *')].map((el) => parseFloat(getComputedStyle(el).fontSize)).filter((n) => n > 0)),
          };
        })()`);

        expect(probe.doc <= probe.view, '无横向溢出（' + probe.doc + ' ≤ ' + probe.view + '）');
        expect(probe.overflow === 0, '没有元素越出视口（' + probe.overflow + ' 个）');
        expect(probe.topH === 52, '顶栏 52px（' + probe.topH + '）');
        expect(probe.rootH === probe.height, '面板铺满高度（' + probe.rootH + '）');
        expect(probe.tabs === 5, '五个页签都在（' + probe.tabs + '）');
        expect(probe.tabTexts.some((text) => text.indexOf('code') >= 0), 'code 页签可见');
        expect(probe.cards >= 2, '图页签有卡片（' + probe.cards + '）');
        expect(probe.cardW >= 100, '卡片宽度合理（' + probe.cardW + 'px）');
        if (item.breakpoint === 'narrow') {
          expect(probe.railW === 0, '窄屏隐藏左栏');
          expect(probe.toggleDisplay !== 'none', '窄屏提供工作区入口');
        } else {
          expect(probe.railW >= 230 && probe.railW <= 290, '左栏宽度合理（' + probe.railW + 'px）');
          expect(probe.mainW > probe.railW, '查看器是主区域（' + probe.mainW + 'px）');
          expect(probe.missingRemoveOpacity === '1', '目录已删除的登记常显移除入口（' + probe.missingRemoveOpacity + '）');
        }
        const rgb = (probe.bg.match(/\d+/g) || []).map(Number);
        const dark = rgb.length >= 3 ? (rgb[0] + rgb[1] + rgb[2]) / 3 < 60 : false;
        expect(item.theme === 'dark' ? dark : !dark, '主题背景正确（' + probe.bg + '）');

        // 宽表格滚动条：用真实布局量厚度（offset-client），并留一张截图
        const bar = await page.eval(`(() => {
          const root = document.querySelector('.dsa-root');
          const wrap = document.createElement('div');
          wrap.className = 'dsa-tablewrap';
          wrap.setAttribute('data-probe', '1');
          wrap.style.cssText = 'position:fixed;left:24px;top:24px;width:520px;max-height:300px;z-index:9999;background:var(--dsa-panel);border:1px solid var(--dsa-line2);border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.25);';
          let head = '<tr>';
          for (let c = 0; c < 4; c += 1) head += '<th>列 ' + c + ' 示例表头</th>';
          head += '</tr>';
          let rows = '';
          for (let r = 0; r < 30; r += 1) {
            rows += '<tr><td>row-' + r + '-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</td><td>四川省宜宾市中级人民法院</td><td>民事/侵权责任纠纷</td><td>' + (2000 + r) + '.08.24</td></tr>';
          }
          wrap.innerHTML = '<table class="dsa-table"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
          root.appendChild(wrap);
          return { hBar: wrap.offsetHeight - wrap.clientHeight, vBar: wrap.offsetWidth - wrap.clientWidth };
        })()`);
        expect(bar.hBar >= 10, '表格横向滚动条可见（' + bar.hBar + 'px）');
        expect(bar.vBar >= 10, '表格纵向滚动条可见（' + bar.vBar + 'px）');
        if (item.key === 'wide') await page.screenshot(path.join(OUT, 'table-scroll.png'));
        await page.eval(`(() => { const el = document.querySelector('[data-probe="1"]'); if (el) el.remove(); return true; })()`);
        expect(probe.color !== probe.bg, '文字与背景有区分');
        expect(probe.minFont >= 12, '最小字号不低于 12px（' + probe.minFont + '）');

        await page.screenshot(path.join(OUT, 'viewer-' + item.key + '.png'));
      } finally {
        page.close();
      }
    }
  });

  console.log('\n截图与 HTML 在 ' + OUT);
  if (problems.length) {
    console.log('\n✗ 有问题 ' + problems.length + ' 条：');
    for (const problem of problems) console.log('  - ' + problem);
    process.exitCode = 1;
    return;
  }
  console.log('\n✓ 视觉回归全部通过');
}

await main();
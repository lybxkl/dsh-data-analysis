/**
 * 静态一致性审计：客户端与 host 侧「说的是不是同一件事」。
 *
 * 这类错不会被语法检查发现，也不会被单个测试覆盖：
 *   - 面板调了 t('xxx')，ZH 里没有这个键 → 界面上出现 undefined
 *   - 面板用了 class="dsa-yyy"，CSS 里没定义 → 排版塌掉
 *   - 面板 POST 了 /api/zzz，routes.js 里没有这个路由 → 点了没反应
 *   - 面板读 snap.qqq，host 快照里没有这个字段 → 恒为 undefined
 *
 * 跑法：node tests/consistency.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const client = read('client.js');
const routes = read('src/routes.js');
const tools = read('src/tools.js');
const service = read('src/service.js');
const gates = read('src/gates.js');

let failed = 0;
const problems = [];

function report(scope, ok, detail) {
  if (ok) {
    process.stdout.write('  ✓ ' + scope + (detail ? ' — ' + detail : '') + '\n');
  } else {
    failed += 1;
    problems.push({ scope, detail });
    process.stdout.write('  ✗ ' + scope + (detail ? ' — ' + detail : '') + '\n');
  }
}

process.stdout.write('\n静态一致性审计\n\n');

/* ---------------- 1. 文案键 ---------------- */

const zhBlock = client.slice(client.indexOf('var ZH = {'), client.indexOf('\n      };', client.indexOf('var ZH = {')));
const defined = new Set();
for (const match of zhBlock.matchAll(/^\s{8}([A-Za-z0-9_]+):/gm)) defined.add(match[1]);
// 多行写法 key: [ ... ].join('') 的键
for (const match of zhBlock.matchAll(/^\s{8}([A-Za-z0-9_]+):\s*\[\s*$/gm)) defined.add(match[1]);

const used = new Set();
for (const match of client.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) used.add(match[1]);

// 有一批文案是按状态查表用的（t(STATUS_TEXT[status])），键名只出现在 ZH 之外的表里，
// 所以再补一遍：只要键名在 ZH 块以外的代码里以字符串出现过，就算用到了。
const bodyOutsideZh = client.slice(0, client.indexOf('var ZH = {')) + client.slice(client.indexOf('var ZH = {') + zhBlock.length);
for (const key of [...defined]) {
  if (used.has(key)) continue;
  if (new RegExp("'" + key + "'").test(bodyOutsideZh)) used.add(key);
}

const missingKeys = [...used].filter((key) => !defined.has(key)).sort();
report('文案键都有定义', missingKeys.length === 0, missingKeys.length ? missingKeys.join('、') : `${used.size} 个键都在`);

// 反向：定义了却没人用（只报告，不算失败——有些键是给将来留的）
const unusedKeys = [...defined].filter((key) => !used.has(key)).sort();
if (unusedKeys.length) process.stdout.write('    （未使用的文案键：' + unusedKeys.join('、') + '）\n');

/* ---------------- 2. CSS 类名 ---------------- */

const cssText = (() => {
  const start = client.indexOf("'.dsa-root{position:relative;");
  const end = client.indexOf('].join', start);
  return client.slice(start, end);
})();

const definedClasses = new Set();
for (const match of cssText.matchAll(/\.(dsa-[A-Za-z0-9_-]+)/g)) definedClasses.add(match[1]);

const usedClasses = new Set();
for (const match of client.matchAll(/className:\s*'([^']+)'/g)) {
  for (const token of match[1].split(/\s+/)) if (token.startsWith('dsa-')) usedClasses.add(token);
}
// 模板拼接：className: 'dsa-dot ' + x
for (const match of client.matchAll(/className:\s*'([^']+)'\s*\+/g)) {
  for (const token of match[1].split(/\s+/)) if (token.startsWith('dsa-')) usedClasses.add(token);
}

const missingClasses = [...usedClasses].filter((name) => !definedClasses.has(name)).sort();
report('class 都有样式', missingClasses.length === 0, missingClasses.length ? missingClasses.join('、') : `${usedClasses.size} 个 class 都在`);

const unusedClasses = [...definedClasses].filter((name) => !usedClasses.has(name)).sort();
if (unusedClasses.length) process.stdout.write('    （定义了但没用到的 class：' + unusedClasses.join('、') + '）\n');

/* ---------------- 3. 客户端 API 调用 vs 路由 ---------------- */

const clientCalls = new Set();
for (const match of client.matchAll(/request\(\s*'(GET|POST)'\s*,\s*'([^']+)'/g)) {
  clientCalls.add(match[1] + ' ' + match[2]);
}
for (const match of client.matchAll(/request\(\s*"(GET|POST)"\s*,\s*'([^']+)'/g)) {
  clientCalls.add(match[1] + ' ' + match[2]);
}

// routes.js 里 path: `${basePath}/api/xxx` 与 method
const declaredRoutes = new Set();
const routeRe = /path:\s*`\$\{basePath\}(\/api\/[^`]+)`\s*,\s*\r?\n\s*method:\s*'(GET|POST)'/g;
for (const match of routes.matchAll(routeRe)) {
  declaredRoutes.add(match[2] + ' ' + match[1]);
}
report('路由表能解析', declaredRoutes.size > 0, declaredRoutes.size ? declaredRoutes.size + ' 条路由' : '一条都没解析出来，检查正则');

// 占位符形状：${id} 之类，按「参数段通配」比
function routeMatcher(rPath) {
  const escaped = rPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$\\\{[^}]+\\\}/g, '[^/]+');
  return new RegExp('^' + escaped + '$');
}

function matchesRoute(call) {
  const [method, pathText] = call.split(' ');
  // 客户端写的是相对 API 根（'/state'），路由声明带 /api 前缀
  const clean = '/api' + pathText.split('?')[0];
  return [...declaredRoutes].some((route) => {
    const [rMethod, rPath] = route.split(' ');
    if (rMethod !== method) return false;
    return routeMatcher(rPath).test(clean);
  });
}

const deadCalls = [...clientCalls].filter((call) => !matchesRoute(call)).sort();
report('客户端调用的接口都存在', deadCalls.length === 0, deadCalls.length ? deadCalls.join('、') : `${clientCalls.size} 个调用都能对上`);

/* ---------------- 4. 工具名 ---------------- */

const declaredTools = new Set();
for (const match of tools.matchAll(/name:\s*'(data_analysis_[a-z_]+)'/g)) declaredTools.add(match[1]);

const referencedTools = new Set();
for (const source of [client, read('src/prompt.js')]) {
  for (const match of source.matchAll(/(data_analysis_[a-z_]+)/g)) referencedTools.add(match[1]);
}
const ghostTools = [...referencedTools].filter((name) => !declaredTools.has(name)).sort();
report('提到的工具都注册了', ghostTools.length === 0, ghostTools.length ? ghostTools.join('、') : `${declaredTools.size} 个工具`);

/* ---------------- 5. 面板读的快照字段 ---------------- */

const snapshotKeys = new Set();
for (const match of service.matchAll(/^\s{6}([a-zA-Z][A-Za-z0-9]*):/gm)) snapshotKeys.add(match[1]);

// 只查最常读的顶层字段（deep 到二级的靠人工）
const clientSnapReads = new Set();
for (const match of client.matchAll(/\bsnap\s*&&\s*snap\.([A-Za-z0-9_]+)/g)) clientSnapReads.add(match[1]);
for (const match of client.matchAll(/\bsnap\.([A-Za-z0-9_]+)\b/g)) clientSnapReads.add(match[1]);

const knownSnapshotFields = new Set([
  'ok', 'config', 'skill', 'python', 'projects', 'active', 'error', 'preflight', 'stages', 'summary',
  'totals', 'artifacts', 'runs', 'adjudications', 'activeRuns', 'materials', 'platform', 'isWindows',
  'layout', 'recheck', 'deadline',
]);
const unknownSnapFields = [...clientSnapReads].filter((key) => !knownSnapshotFields.has(key)).sort();
report('面板只读快照里有的字段', unknownSnapFields.length === 0, unknownSnapFields.length ? unknownSnapFields.join('、') : `${clientSnapReads.size} 个字段`);

process.stdout.write('\n');
if (failed) {
  process.stdout.write('✗ ' + failed + ' 项失败\n');
  process.exit(1);
}
process.stdout.write('✓ 全部通过\n');

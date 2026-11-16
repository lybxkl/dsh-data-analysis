/*
 * 「项目 ⇄ 研究对话」绑定回归测试。
 *
 * 覆盖用户报的两个问题：
 *   1) 对话里让 AI 自己建的项目，为什么不关联？（工具调用必须顺手把这条对话绑上）
 *   2) 不管是对话里建的还是面板里点出来的会话，后续继续对话都要一直连着同一个项目，
 *      不能因为「左栏刚点开了别的项目」就跑到别人那儿去。
 *
 * 跑法：node tests/binding.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Workbench } from '../src/service.js';
import { Runner } from '../src/runner.js';
import { wrapExecute, sessionIdOf, sessionIsDelegated, withChatLink, PROJECT_SELECTING_TOOLS, NO_AUTOBIND_TOOLS } from '../src/binding.js';
import { projectId } from '../src/projects.js';

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
const section = (title) => console.log(`\n${title}`);

const tmpRoots = [];
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-bind-'));
  tmpRoots.push(root);
  return root;
}

function makeWorkbench() {
  const root = makeRoot();
  const ledger = {
    version: 1,
    projects: [],
    runs: [],
    bindings: {},
    adjudications: {},
    recheckChains: {},
    meta: {},
    activeProjectId: '',
    activeProjectPath: '',
    config: { skillRoot: '', pythonPath: 'python', dataDir: '', maxRuns: 5, maxLogLines: 200 },
  };
  const store = {
    filePath: path.join(root, '.ledger', 'data-analysis.json'),
    get: (k) => (k === undefined ? ledger : ledger[k]),
    set: (k, v) => {
      if (k && typeof k === 'object') Object.assign(ledger, k);
      else ledger[k] = v;
    },
    flush() {},
    flushSoon() {},
  };
  const getConfig = () => ledger.config;
  const runner = new Runner({ getConfig, store, onChange: () => {} });
  const wb = new Workbench({ getConfig, store, runner, onChange: () => {} });
  return { ledger, wb, runner, root };
}

/** 工具执行记录：宿主给的是 agent loop，会话 id 在 agent.session.id 上 */
const execOf = (sessionId) => ({ name: 'x', arguments: '', agent: { session: { id: sessionId } } });

/** 包一层「假工具」：实现里直接读 workbench.active()，用来观察作用域有没有生效 */
function toolOf(wb, name, run) {
  return wrapExecute({ name, workbench: wb, original: async (args) => run(args) });
}

/* ------------------------------------------------------------------ */

section('会话 id 是从执行记录里读出来的，读不到就空着');
check('宿主接线：tools.js 把 exec 透给 binding（否则拿不到会话 id）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'tools.js'), 'utf8');
  // 允许从 binding.js 多导入别的东西（触发门要 sessionIdOf），但 wrapExecute 这个接线不能在
  assert.match(src, /import \{[^}]*\bwrapExecute\b[^}]*\} from '\.\/binding\.js'/);
  assert.match(src, /wrapExecute\(\{ name: definition\.name, workbench, original \}\)\(args, exec\)/);
});
check('agent.session.id', () => {
  assert.equal(sessionIdOf(execOf('sess-A')), 'sess-A');
});
check('旧的 agent.sessionId 也认', () => {
  assert.equal(sessionIdOf({ agent: { sessionId: 'sess-B' } }), 'sess-B');
});
check('没有 agent 不猜一个 id 出来', () => {
  assert.equal(sessionIdOf({}), '');
  assert.equal(sessionIdOf(undefined), '');
});
check('三个换项目的工具在名单里', () => {
  assert.ok(PROJECT_SELECTING_TOOLS.has('data_analysis_create_project'));
  assert.ok(PROJECT_SELECTING_TOOLS.has('data_analysis_open_project'));
  assert.ok(!PROJECT_SELECTING_TOOLS.has('data_analysis_status'));
});
check('探路工具不许自动绑定（绑定即启用，会绕过触发门）', () => {
  assert.ok(NO_AUTOBIND_TOOLS.has('data_analysis_status'));
  assert.ok(!NO_AUTOBIND_TOOLS.has('data_analysis_open_project'));
});

section('结果文本：只在刚绑定/刚改绑时补一句');
check('刚关联', () => {
  const out = withChatLink({ ok: true, text: '已建立项目 X' }, { ok: true, project: { name: 'X' }, already: false });
  assert.match(out.text, /本对话已关联项目：X/);
});
check('已经绑过就不再刷屏', () => {
  const value = { ok: true, text: '已建立项目 X' };
  assert.equal(withChatLink(value, { ok: true, project: { name: 'X' }, already: true }), value);
});
check('改绑说清楚之前是别的项目', () => {
  const out = withChatLink({ ok: true, text: '已打开 Y' }, { ok: true, project: { name: 'Y' }, movedFrom: 'p1' });
  assert.match(out.text, /已改绑到项目：Y/);
});
check('失败的结果不补话', () => {
  const value = { ok: false, error: '目录不是空的' };
  assert.equal(withChatLink(value, { ok: true, project: { name: 'X' } }), value);
});

/* ------------------------------------------------------------------ */

section('对话里自己建的项目：工具跑完就关联上');
const env1 = makeWorkbench();
const rootA = path.join(env1.root, 'projA');
await checkAsync('data_analysis_create_project 之后，这条对话绑到了新项目', async () => {
  const create = toolOf(env1.wb, 'data_analysis_create_project', (args) => {
    const result = env1.wb.createProject(args.dir, args.name);
    return result.ok
      ? { ok: true, text: `已建立项目 ${result.project.name}`, root: result.root }
      : { ok: false, text: `操作未完成：${result.error}` };
  });
  const out = await create({ dir: rootA, name: '项目A' }, execOf('sess-A'));
  assert.equal(out.ok, true, out.text);
  assert.match(out.text, /本对话已关联项目/);
  const pid = projectId(rootA);
  assert.equal(env1.ledger.bindings['sess-A'].projectId, pid, '反向表里有这条会话');
  assert.equal(env1.ledger.projects.find((item) => item.id === pid).sessionId, 'sess-A', '项目那侧也记着这条会话');
  assert.equal(env1.wb.sessionBinding('sess-A').projectId, pid);
});

section('后续继续对话：一直作用在同一条项目上，不被面板「随手点开」带走');
const rootB = path.join(env1.root, 'projB');
await checkAsync('面板打开另一个项目，对话里的调用仍落在自己的项目', async () => {
  const created = env1.wb.createProject(rootB, '项目B');
  assert.equal(created.ok, true, created.error);
  assert.equal(env1.wb.active().path, path.resolve(rootB), '面板（全局）当前项目已经是 B');

  const status = toolOf(env1.wb, 'data_analysis_status', () => {
    const active = env1.wb.active();
    return { ok: true, text: `项目：${active.project.name}（${active.path}）` };
  });
  const out = await status({}, execOf('sess-A'));
  assert.match(out.text, /项目：项目A/, '这条对话仍然读项目A：' + out.text);
  assert.equal(env1.wb.active().path, path.resolve(rootB), '面板看到的还是 B，没有被对话拽走');
});

await checkAsync('没有会话归属的调用照旧用全局当前项目', async () => {
  const status = toolOf(env1.wb, 'data_analysis_status', () => {
    const active = env1.wb.active();
    return { ok: true, text: `项目：${active.project.name}` };
  });
  const out = await status({}, {});
  assert.match(out.text, /项目：项目B/);
});

await checkAsync('已经绑过的会话不会被「当前项目」抢走', async () => {
  const ensured = env1.wb.ensureSessionBinding('sess-A');
  assert.equal(ensured.ok, true);
  assert.equal(ensured.already, true);
  assert.equal(ensured.projectId, projectId(rootA));
});

section('绑定规则：一条会话只属于一个项目，改绑必须明确');
check('不带 force 的改绑被拒绝，并回传原来的项目', () => {
  const result = env1.wb.bindSessionTo('sess-A', projectId(rootB));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SESSION_BOUND_ELSEWHERE');
  assert.equal(result.bound.name, '项目A');
  assert.equal(env1.wb.sessionBinding('sess-A').projectId, projectId(rootA), '拒绝就真的没改');
});

await checkAsync('对话里明确让打开另一个项目：工具跑完就改绑过去', async () => {
  const open = toolOf(env1.wb, 'data_analysis_open_project', (args) => {
    const result = env1.wb.openProject(args.dir);
    return result.ok ? { ok: true, text: `已打开 ${result.project.name}` } : { ok: false, text: result.error };
  });
  const out = await open({ dir: rootB }, execOf('sess-A'));
  assert.equal(out.ok, true, out.text);
  assert.match(out.text, /已改绑到项目：项目B/);
  assert.equal(env1.wb.sessionBinding('sess-A').projectId, projectId(rootB));
  const oldA = env1.ledger.projects.find((item) => item.id === projectId(rootA));
  assert.equal(oldA.sessionId, '', '旧项目那侧不再挂着这条会话');
});

check('一个项目只留一条研究对话', () => {
  const pidA = projectId(rootA);
  const first = env1.wb.bindSessionTo('sess-X', pidA, { force: true });
  assert.equal(first.ok, true, first.error);
  const second = env1.wb.bindSessionTo('sess-Y', pidA, { force: true });
  assert.equal(second.ok, true, second.error);
  assert.equal(env1.wb.sessionBinding('sess-X'), null, '被顶掉的那条会话解绑了');
  assert.equal(env1.wb.sessionBinding('sess-Y').projectId, pidA);
  assert.equal(env1.ledger.projects.find((item) => item.id === pidA).sessionId, 'sess-Y');
});

section('解绑与移除项目：登记的指针要一起清掉');
check('解绑只清登记', () => {
  const result = env1.wb.unbindSession(projectId(rootA));
  assert.equal(result.ok, true);
  assert.equal(env1.wb.sessionBinding('sess-Y'), null);
  assert.equal(env1.ledger.projects.find((item) => item.id === projectId(rootA)).sessionId, '');
});
check('移除项目时把指向它的会话一起清掉', () => {
  env1.wb.bindSessionTo('sess-Z', projectId(rootB), { force: true });
  assert.ok(env1.wb.sessionBinding('sess-Z'));
  env1.wb.forgetProject(projectId(rootB));
  assert.equal(env1.wb.sessionBinding('sess-Z'), null);
  assert.equal(env1.ledger.bindings['sess-Z'], undefined);
});

section('子代理不抢项目那唯一一条研究对话');
check('子代理的执行记录认得出来', () => {
  assert.equal(sessionIsDelegated({ agent: { session: { id: 's', header: { origin: 'subagent' } } } }), true);
  assert.equal(sessionIsDelegated({ agent: { session: { id: 's', header: { delegationDepth: 2 } } } }), true);
  assert.equal(sessionIsDelegated({ agent: { session: { id: 's', header: {} } } }), false);
  assert.equal(sessionIsDelegated({}), false);
});
const env3 = makeWorkbench();
const rootS = path.join(env3.root, 'projS');
await checkAsync('子代理调用工具不会把这条会话绑成项目的对话', async () => {
  env3.wb.createProject(rootS, '项目S');
  const status = toolOf(env3.wb, 'data_analysis_status', () => ({ ok: true, text: '项目S 的状态' }));
  const out = await status({}, { agent: { session: { id: 'sess-S', header: { origin: 'subagent', delegationDepth: 1 } } } });
  assert.equal(out.text, '项目S 的状态');
  assert.equal(env3.wb.sessionBinding('sess-S'), null);
});

section('被顶掉的会话：绑定没了，启用也要没了');
{
  const env = makeWorkbench();
  const root = path.join(env.root, 'projE');
  env.wb.createProject(root, '项目E');
  env.wb.bindSessionTo('sess-old', projectId(root), { force: true });
  const armedBefore = env.wb.isArmed('sess-old');
  env.wb.bindSessionTo('sess-new', projectId(root), { force: true });
  check('新会话接管后，旧会话既不再绑定也不再启用', () => {
    assert.equal(armedBefore, true);
    assert.equal(env.wb.sessionBinding('sess-old'), null);
    assert.equal(env.wb.isArmed('sess-old'), false, '否则它仍看得见整套工具，还会被绑回来抢');
    assert.equal(env.wb.isArmed('sess-new'), true);
  });
}

section('子代理替父对话干活：读写落在父对话的项目里');
{
  const env = makeWorkbench();
  const rootP = path.join(env.root, 'projP');
  const rootQ = path.join(env.root, 'projQ');
  env.wb.createProject(rootP, '项目P');
  env.wb.createProject(rootQ, '项目Q');
  assert.equal(env.wb.active().project.name, '项目Q', '面板当前开着 Q');
  env.wb.bindSessionTo('sess-parent', projectId(rootP), { force: true });
  const headers = new Map([
    ['child-1', { header: { parentSession: 'sess-parent', origin: 'subagent', delegationDepth: 1 } }],
  ]);
  env.wb.hostCtx = { get: (name) => (name === 'sessions' ? { get: (id) => headers.get(id) || null } : undefined) };
  await checkAsync('子代理调用工具时作用域是父对话的项目 P（不是面板上的 Q）', async () => {
    const read = toolOf(env.wb, 'data_analysis_run_log', () => ({ ok: true, text: `active=${env.wb.active().project.name}` }));
    const out = await read({}, { agent: { session: { id: 'child-1', header: headers.get('child-1').header } } });
    assert.match(out.text, /active=项目P/);
    assert.equal(env.wb.active().project.name, '项目Q', '跑完作用域还原，面板还是 Q');
    assert.equal(env.wb.sessionBinding('child-1'), null, '子代理仍不占研究对话名额');
  });
  check('沿父链往上找最近一条有绑定的对话（fork / 多层委派）', () => {
    headers.set('child-2', { header: { parentSession: 'middle', origin: 'subagent', delegationDepth: 2 } });
    headers.set('middle', { header: { parentSession: 'sess-parent', origin: 'subagent', delegationDepth: 1 } });
    assert.equal(env.wb.delegatedScopeSession('child-1'), 'sess-parent');
    assert.equal(env.wb.delegatedScopeSession('child-2'), 'sess-parent');
    assert.equal(env.wb.delegatedScopeSession('nobody'), '');
  });
  await checkAsync('父对话没绑项目：子代理拒绝使用面板里的其他项目', async () => {
    headers.set('child-3', { header: { parentSession: 'sess-loose', origin: 'subagent', delegationDepth: 1 } });
    const read = toolOf(env.wb, 'data_analysis_run_log', () => ({ ok: true, text: `active=${env.wb.active().project.name}` }));
    const out = await read({}, { agent: { session: { id: 'child-3', header: headers.get('child-3').header } } });
    assert.equal(out.ok,false);assert.match(out.error,/父研究对话/);
  });
}

section('后台回调按运行记录的项目走，不按「面板最近点开的」');
const env4 = makeWorkbench();
const rootX = path.join(env4.root, 'projX');
const rootY = path.join(env4.root, 'projY');
await checkAsync('runInProject 把作用域钉在记录里的项目上', async () => {
  env4.wb.createProject(rootX, '项目X');
  env4.wb.createProject(rootY, '项目Y');
  assert.equal(env4.wb.active().path, path.resolve(rootY), '面板（全局）现在开着 Y');
  const seen = env4.wb.runInProject(projectId(rootX), () => env4.wb.active());
  assert.equal(seen.id, projectId(rootX), '作用域里读到的是 X，不是 Y');
  assert.equal(env4.wb.active().path, path.resolve(rootY), '跑完作用域还原，面板还是 Y');
});
await checkAsync('runForSession 让对话里的摘要也读自己的项目', async () => {
  const pidX = projectId(rootX);
  env4.wb.bindSessionTo('sess-X', pidX, { force: true });
  const inside = env4.wb.runForSession('sess-X', () => env4.wb.summary());
  assert.equal(inside.ok, true);
  assert.equal(inside.active.id, pidX, '摘要里的 active 是这条对话的项目');
  assert.equal(env4.wb.summary().active.id, projectId(rootY), '面板不分作用域，仍然看 Y');
});

section('「现在屏幕上是哪条对话」：只记事实，不自动改绑');
const env2 = makeWorkbench();
const rootC = path.join(env2.root, 'projC');
env2.wb.createProject(rootC, '项目C');
check('focus 落进快照，面板据此跟随', () => {
  const result = env2.wb.focusSession('sess-C');
  assert.equal(result.ok, true);
  const snap = env2.wb.snapshot();
  assert.ok(snap.focus, '快照里带 focus');
  assert.equal(snap.focus.sessionId, 'sess-C');
  assert.equal(snap.focus.projectId, '', '没绑就是没绑，focus 不替它绑');
});
check('会话 cwd 正好是项目根：这是强信号，直接关联', () => {
  const wb = env2.wb;
  const original = wb.sessionCwd;
  wb.sessionCwd = () => path.resolve(rootC);
  try {
    const result = wb.focusSession('sess-D');
    assert.equal(result.ok, true);
    assert.equal(wb.sessionBinding('sess-D').projectId, projectId(rootC));
  } finally {
    wb.sessionCwd = original;
  }
});
check('清空 focus', () => {
  env2.wb.focusSession('');
  assert.equal(env2.wb.snapshot().focus, null);
});

/* ------------------------------------------------------------------ */

for (const root of tmpRoots) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('');
if (failures.length) {
  for (const line of failures) console.log('  ' + line);
  console.log(`✗ ${failures.length} 项失败（通过 ${passed}）`);
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);

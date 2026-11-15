/*
 * 触发门（档②）回归测试：data_analysis_* 只在「这条对话已启用工作台」时出现。
 *
 * 覆盖三件事：
 *   1) 判定：没登记就是关；绑定项目 / 显式启用 / 父对话已启用才算开；
 *      解绑、移除项目要跟着关；子代理沿用它父对话的启用状态。
 *   2) 注册准入：28 个工具里只有 data_analysis_status 常驻，其余 27 个都带 `when`，
 *      且 `when` 对未启用的会话返回 false（该步工具表里根本没有这个工具）。
 *   3) 探路工具不许顺手绑定：否则模型调一次 status 就把门打开，门等于没设。
 *
 * 跑法：node tests/gating.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Workbench } from '../src/service.js';
import { Runner } from '../src/runner.js';
import { NO_AUTOBIND_TOOLS, PROJECT_AGNOSTIC_TOOLS, wrapExecute } from '../src/binding.js';
import { PROBE_TOOLS, admissionFor, isArmedSession, sessionIdFromActivation, whenArmed } from '../src/gating.js';
import { PROMPT } from '../src/prompt.js';
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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const tmpRoots = [];
function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-gate-'));
  tmpRoots.push(dir);
  return dir;
}

function makeWorkbench() {
  const dir = makeRoot();
  const ledger = {
    version: 1,
    projects: [],
    runs: [],
    bindings: {},
    armings: {},
    adjudications: {},
    recheckChains: {},
    meta: {},
    activeProjectId: '',
    activeProjectPath: '',
    config: { skillRoot: '', pythonPath: 'python', dataDir: '', maxRuns: 5, maxLogLines: 200 },
  };
  const store = {
    filePath: path.join(dir, '.ledger', 'data-analysis.json'),
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
  return { ledger, wb, runner, root: dir };
}

const execOf = (sessionId) => ({ name: 'x', arguments: '', agent: { session: { id: sessionId } } });
const toolOf = (wb, name, run) => wrapExecute({ name, workbench: wb, original: async (args) => run(args) });

/* ------------------------------------------------------------------ */

section('默认是关：没有登记 = 没有工具');
check('空 id / 未知会话都是关', () => {
  const env = makeWorkbench();
  assert.equal(env.wb.isArmed(''), false);
  assert.equal(env.wb.isArmed('sess-nobody'), false);
  assert.equal(isArmedSession(env.wb, 'sess-nobody'), false);
});
check('宿主少一个方法时按「没启用」处理（门禁默认必须关）', () => {
  assert.equal(isArmedSession({}, 'sess-A'), false);
  assert.equal(isArmedSession(null, 'sess-A'), false);
  assert.equal(isArmedSession({ isArmed: () => { throw new Error('boom'); } }, 'sess-A'), false);
});

section('三个启用入口：绑定项目 / 显式启用 / 父对话已启用');
check('绑定项目即启用', () => {
  const env = makeWorkbench();
  const dir = path.join(env.root, 'projA');
  env.wb.createProject(dir, '项目A');
  assert.equal(env.wb.isArmed('sess-A'), false);
  const bound = env.wb.bindSessionTo('sess-A', projectId(dir), { force: true });
  assert.equal(bound.ok, true, bound.error);
  assert.equal(env.wb.isArmed('sess-A'), true);
  assert.equal(env.ledger.armings['sess-A'].reason, 'bind', '台账里记了来源');
});
check('显式启用（装环境的临时会话用这个）', () => {
  const env = makeWorkbench();
  const result = env.wb.armSession('sess-env', 'install');
  assert.equal(result.ok, true);
  assert.equal(env.wb.isArmed('sess-env'), true);
  assert.equal(env.ledger.armings['sess-env'].reason, 'install');
});
check('停用只清显式登记', () => {
  const env = makeWorkbench();
  env.wb.armSession('sess-x', 'install');
  const off = env.wb.disarmSession('sess-x');
  assert.equal(off.ok, true);
  assert.equal(env.wb.isArmed('sess-x'), false);
});
check('子代理沿用父对话的启用状态（不继承的话派活就断）', () => {
  const env = makeWorkbench();
  env.wb.armSession('parent', 'panel');
  const original = env.wb.liveSession;
  env.wb.liveSession = (id) => (id === 'child' ? { header: { parentSession: 'parent', origin: 'subagent' } } : null);
  try {
    assert.equal(env.wb.isArmed('child'), true);
  } finally {
    env.wb.liveSession = original;
  }
});
check('父链成环也不会转不出来（判关）', () => {
  const env = makeWorkbench();
  const original = env.wb.liveSession;
  env.wb.liveSession = (id) => ({ header: { parentSession: id === 'a' ? 'b' : 'a' } });
  try {
    assert.equal(env.wb.isArmed('a'), false);
  } finally {
    env.wb.liveSession = original;
  }
});

section('关掉：解绑与移除项目都要跟着关');
check('解绑 = 停用', () => {
  const env = makeWorkbench();
  const dir = path.join(env.root, 'projB');
  env.wb.createProject(dir, '项目B');
  env.wb.bindSessionTo('sess-B', projectId(dir), { force: true });
  assert.equal(env.wb.isArmed('sess-B'), true);
  env.wb.unbindSession(projectId(dir));
  assert.equal(env.wb.isArmed('sess-B'), false);
  assert.equal(env.ledger.armings['sess-B'], undefined, '台账里也不能留');
});
check('移除项目把指向它的启用登记一起清掉', () => {
  const env = makeWorkbench();
  const dir = path.join(env.root, 'projC');
  env.wb.createProject(dir, '项目C');
  env.wb.bindSessionTo('sess-C', projectId(dir), { force: true });
  env.wb.forgetProject(projectId(dir));
  assert.equal(env.wb.isArmed('sess-C'), false);
  assert.equal(env.ledger.armings['sess-C'], undefined);
});
check('登记表有上限，不会无界增长', () => {
  const env = makeWorkbench();
  for (let i = 0; i < 240; i += 1) env.wb.armSession(`s-${i}`, 'panel');
  assert.ok(Object.keys(env.ledger.armings).length <= 200, `实际 ${Object.keys(env.ledger.armings).length} 条`);
});

section('注册准入：27 个进门，只有 status 常驻');
check('工具名单里 28 个，只有 data_analysis_status 不带 when', () => {
  const src = read('src/tools.js');
  const names = [...src.matchAll(/name:\s*'(data_analysis_[a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, 28, `实际 ${new Set(names).size} 个工具`);
  const env = makeWorkbench();
  const armed = whenArmed(env.wb);
  const ungated = names.filter((name) => admissionFor(armed, name) === undefined);
  assert.deepEqual(ungated, ['data_analysis_status']);
  for (const name of names) {
    const admission = admissionFor(armed, name);
    if (name === 'data_analysis_status') continue;
    assert.equal(typeof admission.when, 'function', `${name} 应该带 when`);
  }
});
await checkAsync('when 对未启用会话返回 false，对已启用返回 true', async () => {  const env = makeWorkbench();
  const armed = whenArmed(env.wb);
  assert.equal(armed({ agent: { id: 'sess-q' } }), false);
  env.wb.armSession('sess-q', 'panel');
  assert.equal(armed({ agent: { id: 'sess-q' } }), true);
  assert.equal(armed({ agent: { session: { id: 'sess-q' } } }), true, 'agent.session.id 也认');
  assert.equal(armed({}), false);
  assert.equal(armed(undefined), false);
  assert.equal(sessionIdFromActivation(null), '');
});

check('准入判定自己抛错：按「关」处理，不把模型步拖垮', () => {
  const armed = whenArmed(makeWorkbench().wb);
  assert.equal(armed({ get agent() { throw new Error('boom'); } }), false);
  assert.equal(armed({ agent: { get id() { throw new Error('boom'); } } }), false);
  assert.equal(sessionIdFromActivation({ get id() { throw new Error('boom'); } }), '');
});

section('探路工具与环境工具：能看状态、能装环境，但不许把门打开、也不许抢项目');
check('探路工具在 NO_AUTOBIND 名单里', () => {
  assert.ok(PROBE_TOOLS.has('data_analysis_status'));
  for (const name of PROBE_TOOLS) assert.ok(NO_AUTOBIND_TOOLS.has(name), `${name} 必须在 NO_AUTOBIND 名单里`);
  assert.ok(!NO_AUTOBIND_TOOLS.has('data_analysis_run_stage'), '需要项目的工具仍要自动绑定');
});
check('环境类工具（doctor/configure/list_stages）不许自动绑定，但仍受触发门约束', () => {
  for (const name of ['data_analysis_doctor', 'data_analysis_configure', 'data_analysis_list_stages']) {
    assert.ok(NO_AUTOBIND_TOOLS.has(name), `${name} 不该把装环境的临时会话绑进项目`);
    assert.ok(!PROBE_TOOLS.has(name), `${name} 不能常驻，否则未启用也能调`);
    assert.ok(PROJECT_AGNOSTIC_TOOLS.has(name));
    assert.equal(typeof admissionFor(whenArmed(makeWorkbench().wb), name).when, 'function', `${name} 仍要带 when`);
  }
});
const envP = makeWorkbench();
const rootP = path.join(envP.root, 'projP');
await checkAsync('未绑定的会话调 status：不建绑定、不启用', async () => {
  envP.wb.createProject(rootP, '项目P');
  const out = await toolOf(envP.wb, 'data_analysis_status', () => ({ ok: true, text: '项目P 的状态' }))({}, execOf('sess-U'));
  assert.equal(out.text, '项目P 的状态');
  assert.equal(envP.wb.sessionBinding('sess-U'), null, '一次「查一下」不许把门打开');
  assert.equal(envP.wb.isArmed('sess-U'), false);
});
await checkAsync('已绑定的会话调 status：仍跑在自己的项目作用域里', async () => {
  envP.wb.bindSessionTo('sess-W', projectId(rootP), { force: true });
  const out = await toolOf(envP.wb, 'data_analysis_status', () => ({ ok: true, text: envP.wb.active().project.name }))({}, execOf('sess-W'));
  assert.equal(out.text, '项目P');
});
await checkAsync('换项目的工具照旧会绑定（否则启用后仍拿不到项目）', async () => {
  const rootV = path.join(envP.root, 'projV');
  const out = await toolOf(envP.wb, 'data_analysis_create_project', (args) => {
    const created = envP.wb.createProject(args.dir, args.name);
    return created.ok ? { ok: true, text: `已建立项目 ${created.project.name}` } : { ok: false, text: created.error };
  })({ dir: rootV, name: '项目V' }, execOf('sess-V'));
  assert.equal(out.ok, true, out.text);
  assert.ok(envP.wb.sessionBinding('sess-V'), '建项目要把这条对话绑上');
  assert.equal(envP.wb.isArmed('sess-V'), true);
});

section('装环境的临时会话：装得动，但不许占研究对话的名额');
{
  const envD = makeWorkbench();
  const rootD = path.join(envD.root, 'projD');
  envD.wb.createProject(rootD, '项目D');
  envD.wb.armSession('sess-env', 'install');
  await checkAsync('doctor/configure/list_stages 不会把会话绑到项目上', async () => {
    for (const name of ['data_analysis_doctor', 'data_analysis_configure', 'data_analysis_list_stages']) {
      await toolOf(envD.wb, name, () => ({ ok: true, text: 'ok' }))({}, execOf('sess-env'));
      assert.equal(envD.wb.sessionBinding('sess-env'), null, `${name} 不许绑走项目`);
    }
    assert.ok(!envD.ledger.projects.find((item) => item.id === projectId(rootD)).sessionId, '项目那侧也没被占用');
    assert.equal(envD.wb.isArmed('sess-env'), true, '装环境会话本身仍然启用（否则一条命令都调不动）');
  });
  await checkAsync('只有真正需要项目的工具才会绑定', async () => {
    await toolOf(envD.wb, 'data_analysis_run_stage', () => ({ ok: true, text: 'ran' }))({}, execOf('sess-env'));
    assert.equal(envD.wb.sessionBinding('sess-env')?.projectId, projectId(rootD), 'run_stage 该绑');
  });
}

section('宿主接线：源码里那几行必须在');
check('tools.js：准入用的是 admissionFor + when', () => {
  const src = read('src/tools.js');
  assert.match(src, /const armedInStep = whenArmed\(workbench\)/);
  assert.match(src, /const admission = admissionFor\(armedInStep, definition\.name, options\)/);
  assert.match(src, /ctx\.tools\.register\(definition, admission\)/);
  assert.ok(!/const dispose = ctx\.tools\.register\(definition\);\s*\n/.test(src), '不该再有无条件注册的老写法');
});
check('tools.js：描述里不再写「任何涉及…先调它」', () => {
  const src = read('src/tools.js');
  assert.ok(!src.includes('任何涉及'), '强触发口径必须清掉');
});
check('tools.js：status 的 armed 与触发门用同一个判定', () => {
  assert.match(read('src/tools.js'), /const armed = isArmedSession\(workbench, sessionId\)/);
});
check('client.js：投任务卡先绑定再 prompt（否则卡在没工具的模型步里到达）', () => {
  const src = read('client.js');
  const at = src.indexOf('function deliverText');
  assert.ok(at > 0, '没找到 deliverText');
  const body = src.slice(at, src.indexOf('function deliverCard', at));
  const persistAt = body.indexOf('persistSession(sessionId)');
  const promptAt = body.indexOf("session.prompt([{ type: 'text', text: text }], 'queue')");
  assert.ok(persistAt > 0, '投卡前没绑定');
  assert.ok(promptAt > 0, '没找到 prompt');
  assert.ok(persistAt < promptAt, '绑定（=启用）必须在 prompt 之前');
});
check('routes.js：arm / disarm 两个入口都在', () => {
  const src = read('src/routes.js');
  assert.match(src, /path: `\$\{basePath\}\/api\/session\/arm`,\s*\r?\n\s*method: 'POST'/);
  assert.match(src, /path: `\$\{basePath\}\/api\/session\/disarm`,\s*\r?\n\s*method: 'POST'/);
});
check('client.js：装环境先启用再投提示词', () => {
  const src = read('client.js');
  const armAt = src.indexOf("'/session/arm'");
  const promptAt = src.indexOf('text: ENV_PROMPT');
  assert.ok(armAt > 0, '没找到启用调用');
  assert.ok(promptAt > 0, '没找到投递调用');
  assert.ok(armAt < promptAt, '启用必须在投递之前，否则那条会话照样没有 doctor/configure');
});
check('store.js：armings 有默认结构（老台账升级不炸）', () => {
  assert.match(read('src/store.js'), /data\.armings = \{\}/);
});
check('prompt.js：讲清触发门，且不再把「聊到数据」当启用', () => {
  assert.match(PROMPT, /### 触发门：这个工作台是「按对话启用」的/);
  assert.match(PROMPT, /### 已启用后的操作顺序/);
  assert.ok(!PROMPT.includes('### 标准动作'), '旧标题会把它读成常驻指令');
  assert.ok(!PROMPT.includes('用户提到数据/资料/编码/统计/图表/论文'), '旧的触发句必须删掉');
  assert.match(PROMPT, /不构成启用/);
  assert.match(PROMPT, /data_analysis_status/, '探路工具要在提示里出现');
});

/* ------------------------------------------------------------------ */

for (const dir of tmpRoots) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
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

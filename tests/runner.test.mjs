/*
 * 运行器与阶段命令的回归测试。
 *
 * 覆盖三件在真实全流程里出过事、但单元测试没盯着的地方：
 *   1. runner.getRun 在「跑着」的时候必须给出 status（缺了它，调用方会以为 1 秒就跑完了），
 *      而且不能把子进程的 stream/decoder 摊进 API 响应（JSON 序列化会炸）。
 *   2. 阶段命令的可选参数：项目根上真有 chart_config.json / model_spec.json 时才带 --config / --spec。
 *   3. 同一项目里已有别的阶段在跑时，拒绝再起一个（两个脚本同时往 output/ 写，闸门读到的就是半成品）。
 *
 * 全部在临时目录里造项目，不碰用户资料，也不需要技能包。
 * 跑法：node tests/runner.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Workbench } from '../src/service.js';
import { Runner } from '../src/runner.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一个假的图表脚本：写出清单就退出，用来验证命令拼装与运行器视图。 */
const CHART_SCRIPT = `import json, os, sys, time
out = None
args = sys.argv[1:]
for i, value in enumerate(args):
    if value == "--out":
        out = args[i + 1]
time.sleep(1.2)
out = out or "output/chart_pack"
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "chart_manifest.csv"), "w", encoding="utf-8") as fh:
    fh.write("id,caption\\nF01,测试图\\n")
print("chart pack ok", out)
`;

const MANUSCRIPT_SCRIPT = `import os, sys, time
out = None
args = sys.argv[1:]
for i, value in enumerate(args):
    if value == "--out":
        out = args[i + 1]
time.sleep(1.2)
out = out or "output/manuscript.docx"
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "wb") as fh:
    fh.write(b"PK\\x03\\x04fake")
print("manuscript ok", out)
`;

function makeBench({ withConfig = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-run-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'data'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'scripts', 'auto_chart_pack.py'), CHART_SCRIPT, 'utf8');
  fs.writeFileSync(path.join(proj, 'scripts', 'assemble_manuscript.py'), MANUSCRIPT_SCRIPT, 'utf8');
  if (withConfig) {
    fs.writeFileSync(path.join(proj, 'chart_config.json'), JSON.stringify({ outcome: 'probation' }), 'utf8');
    fs.writeFileSync(path.join(proj, 'model_spec.json'), JSON.stringify({ models: [] }), 'utf8');
  }
  fs.writeFileSync(
    path.join(proj, 'project.json'),
    JSON.stringify({ name: '运行器回归', root: proj, dataDir: 'data' }, null, 2),
  );

  const ledger = {
    version: 1,
    projects: [{ id: 'test', path: proj }],
    activeProjectId: 'test',
    activeProjectPath: proj,
    runs: [],
    adjudications: {},
    recheckChains: {},
    meta: {},
    config: { skillRoot: '', pythonPath: process.env.DSA_PYTHON || 'python', dataDir: '', maxRuns: 60, maxLogLines: 400 },
  };
  const store = {
    filePath: path.join(root, 'ledger', 'data-analysis.json'),
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
  runner.onFinish = (run) => wb.onRunFinished(run);
  return { root, proj, ledger, wb, runner };
}

async function waitRun(ledger, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    const run = (ledger.runs || []).find((item) => item.id === runId);
    if (run && run.status && run.status !== 'running') return run;
  }
  return null;
}

/* ------------------------- 一、可选参数按文件存在性拼接 ------------------------- */

section('一、可选参数：chart_config.json / model_spec.json');
{
  const bench = makeBench();
  const opened = bench.wb.openProject(bench.proj);
  check('打开项目', opened.ok === true, opened.error || '');
  const stage = bench.wb.stageById('figures');
  const withCfg = bench.wb.commandFor(bench.proj, bench.wb.active().project, stage);
  check('figures 命令可拼出', withCfg.ok === true, withCfg.error || '');
  const argv = (withCfg.steps[0] || {}).argv || [];
  check('带上了 --config chart_config.json', argv.includes('--config') && argv.includes('chart_config.json'), argv.join(' '));

  const statsStage = bench.wb.stageById('stats');
  const statsCmd = bench.wb.commandFor(bench.proj, bench.wb.active().project, statsStage);
  const statsArgv = (statsCmd.steps[0] || {}).argv || [];
  check(
    'stats 带上 --config 与 --spec',
    statsArgv.includes('--config') && statsArgv.includes('chart_config.json') && statsArgv.includes('--spec') && statsArgv.includes('model_spec.json'),
    statsArgv.join(' '),
  );
}

{
  const bench = makeBench({ withConfig: false });
  bench.wb.openProject(bench.proj);
  const stage = bench.wb.stageById('figures');
  const cmd = bench.wb.commandFor(bench.proj, bench.wb.active().project, stage);
  const argv = (cmd.steps[0] || {}).argv || [];
  check('没有配置文件时不带 --config', !argv.includes('--config'), argv.join(' '));
}

/* ------------------------ 二、跑着的 run 必须有 status ------------------------ */

section('二、运行中的 getRun 视图');
{
  const bench = makeBench();
  bench.wb.openProject(bench.proj);
  const started = bench.wb.runStage('figures', { force: true });
  check('figures 起步', started.ok === true, started.error || '');
  const runId = started.run && started.run.id;

  await sleep(250);
  const live = bench.runner.getRun(runId);
  check('运行中有 status=running', live && live.status === 'running', live && live.status);
  check('运行中 alive=true', live && live.alive === true, String(live && live.alive));
  check('运行中 steps 带 pending 状态', Boolean(live && live.steps && live.steps[0] && live.steps[0].status === 'pending'), JSON.stringify(live && live.steps));
  let serialized = '';
  let threw = '';
  try {
    serialized = JSON.stringify({ ok: true, run: live, lines: ['x'] });
  } catch (error) {
    threw = String(error && error.message);
  }
  check('运行中的对象能 JSON 序列化（不带 stream/decoder）', !threw && serialized.length > 0, threw || `${serialized.length} 字节`);
  check('序列化结果里没有 WriteStream 痕迹', !/decoder|_writableState|WriteStream/.test(serialized), '');

  const log = bench.wb.runLog(runId, 20);
  check('runLog 在跑着时也能取', log.ok === true && log.run && log.run.status === 'running', log.run && log.run.status);

  const settled = await waitRun(bench.ledger, runId);
  check('跑完状态 ok', settled && settled.status === 'ok', settled && `${settled.status} exit=${settled.exitCode}`);
  const done = bench.runner.getRun(runId);
  check('结算后 steps 标 ok', Boolean(done && done.steps && done.steps[0] && done.steps[0].status === 'ok'), JSON.stringify(done && done.steps));
  check('结算后 alive=false', done && done.alive === false, String(done && done.alive));
  check('产物清单写出来了', fs.existsSync(path.join(bench.proj, 'output', 'chart_pack', 'chart_manifest.csv')));
}

/* -------------------- 三、同项目已有阶段在跑时拒绝新阶段 -------------------- */

section('三、并发阶段守卫');
{
  const bench = makeBench();
  bench.wb.openProject(bench.proj);
  const first = bench.wb.runStage('figures', { force: true });
  check('先起 figures', first.ok === true, first.error || '');

  await sleep(250);
  const second = bench.wb.runStage('manuscript', { force: false });
  const reason = (second.blockers || []).join('；') || second.error || '';
  check('manuscript 被拒', second.ok === false, reason);
  check('拒绝理由点名在跑的阶段', /出版级图表/.test(reason) && /正在运行/.test(reason), reason);

  const forced = bench.wb.runStage('manuscript', { force: true });
  check('force 下不拦（面板之外的显式选择）', forced.ok === true, forced.error || '');

  await waitRun(bench.ledger, (first.run || {}).id);
  await waitRun(bench.ledger, (forced.run || {}).id);
  const stage = bench.wb.stageById('figures');
  const cmd = bench.wb.commandFor(bench.proj, bench.wb.active().project, stage);
  check('同一阶段重入仍被 runner 挡住', Boolean(cmd.ok));
}

console.log(failed ? `\n✗ ${failed} 条失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);

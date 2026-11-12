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

/* -------------------- 四、手稿骨架：只拼结构、不编数字 -------------------- */

section('四、手稿骨架与改稿说明');
{
  const bench = makeBench();
  bench.wb.openProject(bench.proj);
  const pack = path.join(bench.proj, 'output', 'chart_pack');
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(
    path.join(pack, 'chart_manifest.csv'),
    [
      'id,section,caption,png,n,status',
      'F01,A 数据质量,N=320；样本描述,figures/f01.png,320,ok',
      'F02,B 单变量,,figures/f02.png,320,ok',
      'F03,B 单变量,基准模型,figures/f03.png,318,error: 缺列',
      'F04,OLS 回归,系数图,figures/f04.png,120,ok',
      'F05,A 数据质量,缺图这一行,figures/f05.png,320,ok',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.mkdirSync(path.join(pack, 'figures'), { recursive: true });
  for (const name of ['f01.png', 'f02.png', 'f04.png']) {
    fs.writeFileSync(path.join(pack, 'figures', name), 'x', 'utf8');
  }
  fs.mkdirSync(path.join(bench.proj, 'output', 'models'), { recursive: true });
  fs.writeFileSync(path.join(bench.proj, 'output', 'models', 'coef_all.csv'), 'model,var,coef\nm1,a,1\n', 'utf8');

  const specPath = path.join(bench.proj, 'manuscript.json');
  const built = bench.wb.manuscriptScaffold({});
  check('生成 manuscript.json', built.ok === true && fs.existsSync(specPath), built.error || '');
  check('figure 块 3 个（error 行与被跳过的缺图行不算）', built.figures === 3, String(built.figures));
  check('缺 png 的图被跳过', built.skippedNoPng === 1, String(built.skippedNoPng));
  check('清单里失败状态的图也被跳过并单独报数', built.skippedBadStatus === 1, String(built.skippedBadStatus));
  check('跳过的图总数是两者之和', built.skippedFigures === 2, String(built.skippedFigures));
  check('按 section 分成 3 个图段 + 1 个表段', built.sections === 4 && built.figureSections === 3, `${built.sections}/${built.figureSections}`);
  check('表块 1 个（只算真有数据的 CSV）', built.tables === 1, String(built.tables));
  check('待补段落 = 研究设计 + 3 段 + 表段', built.placeholders === 5, String(built.placeholders));

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const figs = spec.blocks.filter((block) => block.type === 'figure');
  const headings = spec.blocks.filter((block) => block.type === 'heading').map((block) => block.text);
  check('标题取项目名', spec.blocks[0].type === 'title' && spec.blocks[0].text === '运行器回归', spec.blocks[0].text);
  check('png 路径跟清单目录走（清单里是 figures/x.png）', figs[0].png === 'output/chart_pack/figures/f01.png', figs[0].png);
  check('题注已带 N 时不再塞 n（避免「（N=320）（N=320）」）', figs[0].n === undefined, String(figs[0].n));
  check('题注没有 N 时才用清单的 n', figs[1].n === 320, String(figs[1].n));
  check('空图题有占位', figs[1].caption === '（图题待写）', figs[1].caption);
  check('section 去掉字母前缀', headings.includes('二、数据质量'), headings.join(' | '));
  check('不会把 OLS 的首字母当章节号吃掉', headings.some((text) => text.endsWith('、OLS 回归')), headings.join(' | '));
  check('缺 png 的那张不在骨架里', figs.every((block) => !/f05/.test(block.png)), figs.map((block) => block.png).join(' | '));
  check('正文段落不带自造数字', spec.blocks.filter((block) => block.type === 'para').every((block) => !/[0-9]/.test(block.text)));

  const again = bench.wb.manuscriptScaffold({});
  check('已有文件时不覆盖', again.ok === false && /已经存在/.test(again.error), again.error || '');
  check('第一次生成不算覆盖', built.overwritten === false, String(built.overwritten));
  const over = bench.wb.manuscriptScaffold({ overwrite: true });
  check('显式 overwrite 才重排', over.ok === true && over.overwritten === true, over.error || '');
  check(
    '覆盖前留了备份',
    /^manuscript\.json\.bak-\d{8}-\d{6}$/.test(over.backup || '') && fs.existsSync(path.join(bench.proj, over.backup || 'x')),
    over.backup || '(空)',
  );

  const brief = bench.wb.manuscriptBrief();
  check('brief 认得出骨架', brief.ok === true && brief.spec.exists === true, brief.error || '');
  check('brief 说清 figure 字段不许动', /png \/ caption 不要改/.test(brief.text), brief.text.split('\n')[6] || '');
  check('brief 说明 N 已在题注里、别重复加', /N 已经写在题注里/.test(brief.text));
  check('brief 提醒改块序会让图号错配', /图号就跟着变/.test(brief.text));
  check('brief 说闸门只认 docx', /闸门只认这个 docx/.test(brief.text));
  check('brief 要求图号从 1 连续', /图号从 1 连续/.test(brief.text));
  check('brief 要求数字可追到 CSV', /output\/models\/\*\.csv/.test(brief.text));

  // 带 BOM 的 JSON（记事本常见）不该被判成解析失败
  fs.writeFileSync(specPath, '\uFEFF' + JSON.stringify(spec), 'utf8');
  const bom = bench.wb.manuscriptBrief();
  check('UTF-8 BOM 也能解析', bom.ok === true && bom.spec.error === '' && bom.spec.blocks === spec.blocks.length, bom.spec.error || '');
  check('brief 的数字带 BOM 的骨架', bom.spec.figures === 3, String(bom.spec.figures));

  fs.writeFileSync(specPath, '{"blocks": [', 'utf8');
  const broken = bench.wb.manuscriptBrief();
  check('坏 JSON 时 brief 直说解析失败', /解析失败/.test(broken.text), broken.text.split('\n')[3] || '');
  const brokenStatus = bench.wb.manuscriptBrief(broken.spec);
  check('坏 JSON 的 spec 带 error', Boolean(brokenStatus.spec.error), brokenStatus.spec.error || '');

  // 结构不可跑的 spec：技能脚本会 SpecError，面板不能先说「已就绪」
  fs.writeFileSync(specPath, JSON.stringify({ style: {}, blocks: [] }), 'utf8');
  const empty = bench.wb.manuscriptBrief();
  check('空 blocks 被判成跑不了', empty.spec.error === 'blocks 是空的' && /跑不了/.test(empty.text), empty.spec.error || '');
  fs.writeFileSync(specPath, JSON.stringify({ blocks: [null, { type: 'figures' }] }), 'utf8');
  const bad = bench.wb.manuscriptBrief();
  check('结构不对的块被数出来', bad.spec.invalidBlocks === 2 && /结构不对/.test(bad.text), String(bad.spec.invalidBlocks));
  check('结构不对时状态行不说「已就绪」', !/已就绪/.test(bad.text), bad.text.split('\n')[3] || '');
  // 0 块的空壳不算「别人写过的稿子」：不该逼人先点一次覆盖
  fs.writeFileSync(specPath, JSON.stringify({ style: {} }), 'utf8');
  const rebuild = bench.wb.manuscriptScaffold({});
  check('空壳可以直接重建（不用先 overwrite）', rebuild.ok === true && rebuild.overwritten === false, rebuild.error || '');
  check('重建前仍然备份了空壳', /^manuscript\.json\.bak-/.test(rebuild.backup || ''), rebuild.backup || '');

  const fresh = bench.wb.manuscriptBrief({ exists: false, blocks: 0, figures: 0, tables: 0, placeholders: 0 });
  check('没有 spec 时 brief 直说「先生成骨架」', /先生成骨架/.test(fresh.text));

  // 没有图表清单就生成骨架：不该静默成功成「0 图的稿子」
  fs.rmSync(path.join(bench.proj, 'output/chart_pack/chart_manifest.csv'), { force: true });
  const noManifest = bench.wb.manuscriptScaffold({ overwrite: true });
  check('没有图表清单时骨架里 0 张图', noManifest.ok === true && noManifest.figures === 0, String(noManifest.figures));
  check('没有图表清单时会明确警告', /还没找到图表清单/.test(noManifest.warning || ''), noManifest.warning || '(空)');
  check('警告里指明先跑第 6 阶段', /第 6 阶段/.test(noManifest.warning || ''), noManifest.warning || '(空)');
  const noFigText = bench.wb.manuscriptScaffold({ overwrite: true });
  check('重排仍然可跑（不把警告当失败）', noFigText.ok === true, noFigText.error || '');
}

console.log(failed ? `\n✗ ${failed} 条失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);

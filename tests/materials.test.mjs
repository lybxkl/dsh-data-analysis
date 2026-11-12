/**
 * 材料库回归测试：通道分类、挂载/摘下/修复、旧副本迁移、识图全流程、来源账。
 * 全部在临时目录里造项目与材料，不碰用户的真实项目。
 *
 * 跑法：npm test   （或 node tests/materials.test.mjs）
 * 依赖：python（技能脚本用）、PyMuPDF（造扫描件 PDF 用）。缺了会跳过对应小节。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Workbench } from '../src/service.js';
import { Runner } from '../src/runner.js';
import { Vision, readVisionLog } from '../src/vision.js';
import { createDirLink, mirrorDir, pruneMirror, readMountMarker, removeMirror, removeTree } from '../src/platform.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = process.env.DSA_SKILL || 'F:\\测试文件\\SPSS-Style-Charting-Skill';

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

/** 造一个临时项目 + 台账 + 工作台。 */
function makeBench(prefix, { assistant = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const proj = path.join(root, 'proj');
  const sourceRoot = path.join(root, '材料');
  fs.mkdirSync(path.join(proj, 'data'), { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'project.json'),
    JSON.stringify({ name: '回归测试', root: proj, dataDir: 'data', createdAt: new Date().toISOString() }, null, 2),
  );
  const ledger = {
    version: 1,
    projects: [{ id: 'test', path: proj }],
    activeProjectId: 'test',
    activeProjectPath: proj,
    runs: [],
    adjudications: {},
    meta: {},
    config: { skillRoot: SKILL, pythonPath: 'python', dataDir: '' },
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
  const cfg = () => ledger.config;
  const runner = new Runner({ getConfig: cfg, store, onChange: () => {} });
  const vision = new Vision({ getConfig: cfg, getCacheDir: () => wb.cacheDir(), logger: console, assistant });
  const wb = new Workbench({ getConfig: cfg, store, runner, onChange: () => {}, materials: { vision } });
  runner.onFinish = (run) => wb.onRunFinished(run);
  return { root, proj, sourceRoot, ledger, store, wb, vision };
}

/** 等一次阶段运行结束。 */
async function waitRun(ledger, runId, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const run = (ledger.runs || []).find((item) => item.id === runId);
    if (run && run.status && run.status !== 'running') return run;
  }
  return null;
}

/* ------------------------------ 一、通道分类 ------------------------------ */

section('一、登记与通道分类');
{
  const bench = makeBench('dsa-t1-');
  const files = {
    'a.txt': 'text',
    'b.pdf': 'pdf',
    'c.doc': 'legacy',
    'd.png': 'image',
    'e.mhtml': 'none',
    'f.zip': 'archive',
    '.DS_Store': 'junk',
  };
  for (const [name] of Object.entries(files)) fs.writeFileSync(path.join(bench.sourceRoot, name), 'x');
  const added = bench.wb.addSource({ path: bench.sourceRoot, label: '通道样本' });
  const scan = added.source.scan;
  check('登记成功', added.ok === true, added.receipt);
  check('直读 2（txt+pdf）', scan.byChannel.read === 2, `read=${scan.byChannel.read}`);
  check('识图 1（png）', scan.byChannel.vision === 1, `vision=${scan.byChannel.vision}`);
  check('待转换 1（doc）', scan.byChannel.convert === 1, `convert=${scan.byChannel.convert}`);
  check('不支持 2（mhtml+zip）', scan.byChannel.none === 2, `none=${scan.byChannel.none}`);
  check('系统文件 1（.DS_Store）', scan.byChannel.junk === 1, `junk=${scan.byChannel.junk}`);
  const total = Object.values(scan.byChannel).reduce((a, b) => a + b, 0);
  check('四类相加 = 目录总数', total === scan.files, `${total} vs ${scan.files}`);
}

/* --------------------------- 二、挂载 / 摘下 / 修复 --------------------------- */

section('二、挂载、重复挂载、摘下、修复');
{
  const bench = makeBench('dsa-t2-');
  fs.mkdirSync(path.join(bench.sourceRoot, '安徽'), { recursive: true });
  fs.mkdirSync(path.join(bench.sourceRoot, '北京'), { recursive: true });
  fs.writeFileSync(path.join(bench.sourceRoot, '安徽', 'x.pdf'), 'x');
  fs.writeFileSync(path.join(bench.sourceRoot, '北京', 'y.pdf'), 'y');
  const added = bench.wb.addSource({ path: bench.sourceRoot, label: '挂载样本' });

  const mounted = await bench.wb.mountSource({ sourceId: added.source.id, entries: ['安徽'] });
  check('挂载 安徽', mounted.ok === true, mounted.error || '');
  const entry = (bench.wb.mountsState(bench.proj).entries || []).find((item) => item.name === '安徽');
  check('data/安徽 是联接', entry?.isLink === true, `mode=${entry?.mode}`);
  check('联接指向源目录', String(entry?.target || '').startsWith(path.join(bench.root, '材料')), entry?.target);

  const again = await bench.wb.mountSource({ sourceId: added.source.id, entries: ['安徽'] });
  check('重复挂载被拦', again.ok === false, again.error || '');

  const state = bench.wb.mountsState(bench.proj);
  check('mountsState 状态 ok', (state.mounts || []).every((m) => m.status === 'ok'), JSON.stringify((state.mounts || []).map((m) => m.status)));

  fs.unlinkSync(path.join(bench.proj, 'data', '安徽'));
  const broken = bench.wb.mountsState(bench.proj);
  check('手删联接后 status 变成 missing-link', (broken.mounts || []).some((m) => m.status === 'missing-link'));

  const repaired = await bench.wb.repairMounts();
  check('修复联接', repaired.ok === true, JSON.stringify(repaired.repaired || []));
  check('修复后又能列出源文件', fs.existsSync(path.join(bench.proj, 'data', '安徽', 'x.pdf')));

  const unmounted = await bench.wb.unmountSource({ as: '安徽' });
  check('摘下只删联接', unmounted.ok === true && !fs.existsSync(path.join(bench.proj, 'data', '安徽')));
  check('源文件仍在', fs.existsSync(path.join(bench.sourceRoot, '安徽', 'x.pdf')));
}

/* ------------------------ 二之二、交给会话的交办文案 ------------------------ */
section('二之二、materialsCard：挂载清单 + 只读约束（没有挂载就明确报错）');
{
  const bench = makeBench('dsa-t2b-');
  const empty = bench.wb.materialsCard();
  check('没有挂载时不硬造一张卡', empty.ok === false && /还没有挂载/.test(empty.error || ''), empty.error || '');

  fs.mkdirSync(path.join(bench.sourceRoot, '卷'), { recursive: true });
  fs.writeFileSync(path.join(bench.sourceRoot, '卷', 'a.pdf'), 'x');
  const added = bench.wb.addSource({ path: bench.sourceRoot, label: '交办样本' });
  await bench.wb.mountSource({ sourceId: added.source.id, entries: ['卷'] });

  const card = bench.wb.materialsCard();
  check('有挂载就能出卡', card.ok === true, card.error || '');
  const text = String(card.text || '');
  check('卡里点了挂载名与源路径', text.includes('data/卷') && text.includes(bench.sourceRoot.replace(/\\/g, '\\')), text.slice(0, 120));
  check('卡里写明只读', text.includes('只读') && text.includes('不要修改'));
  check('卡里指路 data_analysis_vision', text.includes('data_analysis_vision'));
  check('卡里不再提转换工具', !text.includes('data_analysis_convert'));
  check('卡里要求重跑审计', text.includes('重跑 audit'));
}

/* ------------------------------ 三、旧副本迁移 ------------------------------ */

section('三、旧副本 → 联接（逐份 md5）');
{
  const bench = makeBench('dsa-t3-');
  fs.mkdirSync(path.join(bench.sourceRoot, '安徽'), { recursive: true });
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
    fs.writeFileSync(path.join(bench.sourceRoot, '安徽', name), `内容-${name}`);
    fs.mkdirSync(path.join(bench.proj, 'data', '安徽'), { recursive: true });
    fs.writeFileSync(path.join(bench.proj, 'data', '安徽', name), `内容-${name}`);
  }
  const added = bench.wb.addSource({ path: bench.sourceRoot, label: '迁移样本' });

  const dry = await bench.wb.migrateSource({ sourceId: added.source.id, entries: ['安徽'], apply: false });
  check('试跑：全部对上', dry.ok === true && dry.safe === true, JSON.stringify(dry.report?.[0] || {}));
  check('试跑不动文件', fs.lstatSync(path.join(bench.proj, 'data', '安徽')).isSymbolicLink() === false);

  const applied = await bench.wb.migrateSource({ sourceId: added.source.id, entries: ['安徽'], apply: true });
  check('迁移成功', applied.ok === true && applied.applied === true, applied.error || '');
  check('data/安徽 变成联接', fs.lstatSync(path.join(bench.proj, 'data', '安徽')).isSymbolicLink() === true);
  check('源目录三份都还在', fs.readdirSync(path.join(bench.sourceRoot, '安徽')).length === 3);

  // 内容不一致时必须整体停下，一个都不删
  const bench2 = makeBench('dsa-t3b-');
  fs.mkdirSync(path.join(bench2.sourceRoot, '卷'), { recursive: true });
  fs.mkdirSync(path.join(bench2.proj, 'data', '卷'), { recursive: true });
  fs.writeFileSync(path.join(bench2.sourceRoot, '卷', 'same.pdf'), '一致');
  fs.writeFileSync(path.join(bench2.proj, 'data', '卷', 'same.pdf'), '一致');
  fs.writeFileSync(path.join(bench2.sourceRoot, '卷', 'diff.pdf'), '原件');
  fs.writeFileSync(path.join(bench2.proj, 'data', '卷', 'diff.pdf'), '被改过');
  const added2 = bench2.wb.addSource({ path: bench2.sourceRoot, label: '不一致样本' });
  const bad = await bench2.wb.migrateSource({ sourceId: added2.source.id, entries: ['卷'], apply: true });
  check('有差异就拒绝替换', bad.ok === false, bad.error || '');
  check('拒绝时副本原样留着', fs.readdirSync(path.join(bench2.proj, 'data', '卷')).length === 2);
}

/* ------------------------------ 四、CJK 删除回归 ------------------------------ */

section('四、非 ASCII 路径的递归删除（Node fs.rmSync 会静默失效）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-cjk-'));
  const target = path.join(dir, '安徽');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'a.pdf'), 'x');
  const removed = await removeTree(target);
  check('removeTree 删得掉中文目录', removed.ok === true && !fs.existsSync(target));
  await removeTree(dir);
}

/* ------------------------------ 五、识图全流程 ------------------------------ */

section('五、识图：计划、数页、留痕、派生稿、人工核对');
{
  // 现造一个「只有图、没有文字层」的 PDF
  const bench = makeBench('dsa-t5-');
  const scanPdf = path.join(bench.root, 'scan.pdf');
  let made = false;
  try {
    const py = path.join(bench.root, 'mk.py');
    fs.writeFileSync(
      py,
      [
        'import sys',
        'import fitz',
        'from PIL import Image, ImageDraw',
        'png = sys.argv[2]',
        'img = Image.new("RGB", (900, 1200), "white")',
        'ImageDraw.Draw(img).text((100, 200), "scanned page", fill="black")',
        'img.save(png)',
        'doc = fitz.open()',
        'for _ in range(3):',
        '    page = doc.new_page(width=595, height=842)',
        '    page.insert_image(fitz.Rect(20, 20, 575, 822), filename=png)',
        'doc.save(sys.argv[1])',
        'doc.close()',
      ].join('\n'),
      'utf8',
    );
    execFileSync('python', [py, scanPdf, path.join(bench.root, 'scan.png')], { stdio: 'ignore' });
    made = fs.existsSync(scanPdf);
  } catch {
    made = false;
  }
  if (!made) {
    console.log('  （没有 PyMuPDF，跳过识图小节）');
  } else {
    fs.mkdirSync(path.join(bench.sourceRoot, '扫描件'), { recursive: true });
    fs.copyFileSync(scanPdf, path.join(bench.sourceRoot, '扫描件', '笔录.pdf'));
    const added = bench.wb.addSource({ path: bench.sourceRoot, label: '扫描件' });
    await bench.wb.mountSource({ sourceId: added.source.id, entries: ['扫描件'] });

    const started = bench.wb.runStage('audit', { force: true });
    const ran = await waitRun(bench.ledger, started?.run?.id);
    check('审计跑完', ran?.status === 'ok', ran?.status || '没有运行记录');

    const plan = bench.wb.visionPlan();
    check('计划里有一份扫描件', (plan.items || []).length === 1, JSON.stringify(plan.totals));
    check('数是 3 页', plan.items?.[0]?.pages === 3);
    check('路径指到联接里', plan.items?.[0]?.abs?.includes('扫描件'));

    // 模型不支持图片 → 明确拒绝，绝不调用
    const blind = {
      available: () => ({ ok: true }),
      async imageCapability() {
        return { ok: false, error: '当前模型只吃文字' };
      },
      async seeImage() {
        blind.called = (blind.called || 0) + 1;
        return { ok: false };
      },
    };
    bench.vision.assistant = blind;
    const refused = await bench.wb.startVision({ wait: true });
    check('模型不支持图片时报错', refused.ok === false, refused.error || '');
    check('一次模型调用都没发', !blind.called);

    // 换成能看图的假模型，跑第 1 页
    let calls = 0;
    bench.vision.assistant = {
      available: () => ({ ok: true }),
      async imageCapability() {
        return { ok: true, provider: 'fake', model: 'fake-vision', modality: 'image' };
      },
      async seeImage() {
        calls += 1;
        return { ok: true, text: `【第 ${calls} 页】本院认为，被告人非法捕捞水产品。`, provider: 'fake', model: 'fake-vision', tokens: 100 };
      },
    };
    const one = await bench.vision.run({ projectRoot: bench.proj, plan: bench.wb.visionPlan(), limit: 1, pageSpec: '1' });
    check('识别第一页', one.ok === true && calls === 1, one.error || '');
    await bench.wb.afterVision(bench.proj);

    const log = readVisionLog(bench.proj);
    check('vision_log 记了一行', log.length === 1, JSON.stringify(log[0] || {}));
    check('留了页图 sha256', /^[0-9a-f]{64}$/.test(log[0]?.input_sha256 || ''));
    check('默认未人工核对', log[0]?.human_verified === false);

    const derivedHit = fs.existsSync(path.join(bench.proj, 'data', '扫描件__识别稿', '笔录.pdf.p0001.txt'));
    check('派生稿挂在 data/ 下', derivedHit);

    const derivedRow = fs
      .readFileSync(path.join(bench.proj, 'output', 'materials', 'provenance.csv'), 'utf8')
      .split('\n')
      .find((line) => line.includes('__识别稿'));
    check('来源账写了 derived_from', Boolean(derivedRow?.includes('扫描件/笔录.pdf')), derivedRow || '没有派生行');

    const gateBefore = (bench.wb.snapshot().stages.find((s) => s.id === 'qa')?.gates || []).find((g) => g.id === 'qa-vision');
    check('未核对 → qa-vision 判不了', gateBefore?.status === 'unjudged', gateBefore?.detail || '没有这条闸门');

    bench.wb.verifyVision({ all: true });
    const gateAfter = (bench.wb.snapshot().stages.find((s) => s.id === 'qa')?.gates || []).find((g) => g.id === 'qa-vision');
    check('核对后 → qa-vision 通过', gateAfter?.status === 'pass', gateAfter?.detail || '');
  }
}

/* ------------------------------ 六、来源账对得上 ------------------------------ */

section('六、来源账与审计文件数一致（含 macOS/Windows 的系统文件）');
{
  const bench = makeBench('dsa-t6-');
  fs.mkdirSync(path.join(bench.sourceRoot, '卷'), { recursive: true });
  for (const name of ['a.pdf', 'b.pdf']) fs.writeFileSync(path.join(bench.sourceRoot, '卷', name), 'x');
  // 技能审计会把隐藏文件也算进总文件数，所以来源账也必须记它们，否则行数对不上
  fs.writeFileSync(path.join(bench.sourceRoot, '卷', '.DS_Store'), 'junk');
  fs.writeFileSync(path.join(bench.sourceRoot, '卷', '._a.pdf'), 'junk');
  const added = bench.wb.addSource({ path: bench.sourceRoot, label: '对账样本' });
  const mounted = await bench.wb.mountSource({ sourceId: added.source.id, entries: ['卷'] });
  check('挂载成功（含系统文件也不报错）', mounted.ok, mounted.error || '');
  const started = bench.wb.runStage('audit', { force: true });
  await waitRun(bench.ledger, started?.run?.id);
  const snapshot = bench.wb.snapshot();
  const gate = (snapshot.stages.find((s) => s.id === 'audit')?.gates || []).find(
    (g) => g.id === 'materials-provenance-cover',
  );
  check('provenance 行数 = 审计文件数（系统文件也算）', gate?.status === 'pass', gate?.detail || '没有这条闸门');
  const fresh = (snapshot.stages.find((s) => s.id === 'audit')?.gates || []).find((g) => g.id === 'audit-freshness');
  check('audit-freshness 也把系统文件算进去', fresh?.status === 'pass', fresh?.detail || '');
}

/* ---------------------- 七、整目录挂载 + 副本名不同的迁移 ---------------------- */

section('七、整目录挂载（entry 为空）与副本改名后的迁移');
{
  const bench = makeBench('dsa-t7-');
  // 源里有两层结构；用户当初把 data/ 下的副本整个改名成「全部案子」
  fs.mkdirSync(path.join(bench.sourceRoot, '甲'), { recursive: true });
  fs.mkdirSync(path.join(bench.sourceRoot, '乙'), { recursive: true });
  fs.writeFileSync(path.join(bench.sourceRoot, '甲', 'a.pdf'), 'aaa');
  fs.writeFileSync(path.join(bench.sourceRoot, '乙', 'b.pdf'), 'bbb');

  const added = bench.wb.addSource({ path: bench.sourceRoot, label: '整包' });
  const mounted = await bench.wb.mountSource({ sourceId: added.source.id, as: '全部案子' });
  check('整目录挂载成功（entry 为空）', mounted.ok, mounted.error || '');
  const link = path.join(bench.proj, 'data', '全部案子');
  check('data/全部案子 是联接', fs.lstatSync(link).isSymbolicLink());

  // 拆掉联接，手工造一份「旧副本」但目录名不同
  await bench.wb.unmountSource({ as: '全部案子' });
  const copies = path.join(bench.proj, 'data', '全部案子');
  fs.mkdirSync(path.join(copies, '甲'), { recursive: true });
  fs.mkdirSync(path.join(copies, '乙'), { recursive: true });
  fs.writeFileSync(path.join(copies, '甲', 'a.pdf'), 'aaa');
  fs.writeFileSync(path.join(copies, '乙', 'b.pdf'), 'bbb');

  const dry = await bench.wb.migrateSource({ sourceId: added.source.id, as: '全部案子', apply: false });
  check('按别名 dry-run 比对通过', dry.ok && dry.safe, dry.error || JSON.stringify(dry.report?.[0] || {}));
  check('比对数 2 份', dry.report?.[0]?.verified === 2, String(dry.report?.[0]?.verified));

  const applied = await bench.wb.migrateSource({ sourceId: added.source.id, as: '全部案子', apply: true });
  check('按别名完成迁移', applied.ok && applied.applied, applied.error || '');
  check('副本换成联接', fs.lstatSync(link).isSymbolicLink());
  check('源里的文件一份没少', fs.existsSync(path.join(bench.sourceRoot, '甲', 'a.pdf')) && fs.existsSync(path.join(bench.sourceRoot, '乙', 'b.pdf')));
  const mounts = bench.wb.mountsStateSafe().mounts;
  check('挂载表里有这条（entry 为空）', mounts.some((m) => m.as === '全部案子' && !m.entry && m.status === 'ok'));
}

/* --------------------- 八、镜像目录（macOS/Linux 用的那条通道） --------------------- */

section('八、镜像目录：增量同步与残影清理');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-mirror-'));
  const source = path.join(root, '源');
  const dest = path.join(root, 'data', '镜像');
  fs.mkdirSync(path.join(source, '省', '子'), { recursive: true });
  fs.writeFileSync(path.join(source, '省', 'a.pdf'), 'aaa');
  fs.writeFileSync(path.join(source, '省', '子', 'b.pdf'), 'bbb');

  const first = mirrorDir(source, dest);
  const canLink = first.ok && !(first.failed || []).length;
  if (!canLink) {
    check('建不了软链时明确报错，不假装成功', first.ok === false || (first.failed || []).length > 0, JSON.stringify(first).slice(0, 160));
    console.log('  · 跳过后续断言：这台机器不允许建软链（Windows 需要开发者模式）');
  } else {
    check('镜像建成了', first.mode === 'mirror' && fs.existsSync(dest));
    check('文件是软链', fs.lstatSync(path.join(dest, '省', 'a.pdf')).isSymbolicLink());
    check('写了标记文件', Boolean(readMountMarker(dest)));
    check('内容读得出来', fs.readFileSync(path.join(dest, '省', '子', 'b.pdf'), 'utf8') === 'bbb');

    // 源里新增一份 → 再镜像一次要补上
    fs.writeFileSync(path.join(source, '省', 'c.pdf'), 'ccc');
    const second = mirrorDir(source, dest);
    check('新增的文件补齐了', fs.existsSync(path.join(dest, '省', 'c.pdf')), JSON.stringify(second));
    check('原有链接没被破坏', fs.readFileSync(path.join(dest, '省', 'a.pdf'), 'utf8') === 'aaa');

    // 源里删掉一份 → 镜像里的断链要被清掉
    fs.unlinkSync(path.join(source, '省', 'a.pdf'));
    const third = mirrorDir(source, dest);
    check('删掉的文件不再出现在镜像里', !fs.existsSync(path.join(dest, '省', 'a.pdf')) && third.pruned >= 1, JSON.stringify(third));

    const pruned = pruneMirror(dest);
    check('pruneMirror 幂等', pruned.ok && pruned.removed === 0, JSON.stringify(pruned));

    const removed = await removeMirror(dest);
    check('removeMirror 删得掉自己建的镜像', removed.ok && !fs.existsSync(dest), JSON.stringify(removed));

    // 没有标记文件的是用户自己的目录：必须拒绝
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const refused = await removeMirror(plain);
    check('没有标记文件的目录拒绝删除', refused.ok === false && fs.existsSync(plain));
  }
  await removeTree(root);
}

/* ---------------------- 九、镜像残影清理（用联接当链接替身） ---------------------- */

section('九、pruneMirror：清断链、清空目录、保留标记文件');
{
  // 在 Windows 上建不了软链，但联接在 lstat 里同样是链接，可以当替身验证同一条分支
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-prune-'));
  const src = path.join(root, 'src');
  const mirror = path.join(root, 'mirror');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'sub', 'a.txt'), 'a');
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(mirror, '.dsh-mount.json'), '{"source":"x"}');

  const link = path.join(mirror, 'sub');
  const made = await createDirLink(link, path.join(src, 'sub'));
  if (!made.ok) {
    console.log(`  · 跳过：这台机器建不了链接（${made.error}）`);
  } else {
    // 目标被删掉 → 镜像里的这条成了断链，prune 应该清掉
    await removeTree(src);
    const first = pruneMirror(mirror);
    check('断链被清掉', first.removed >= 1 && !fs.existsSync(link), JSON.stringify(first));
    check('再跑一次是幂等的', pruneMirror(mirror).removed === 0);
    check('标记文件不动', fs.existsSync(path.join(mirror, '.dsh-mount.json')));

    fs.mkdirSync(path.join(mirror, 'empty'), { recursive: true });
    const third = pruneMirror(mirror);
    check('空目录被清掉', !fs.existsSync(path.join(mirror, 'empty')), JSON.stringify(third));
  }
  await removeTree(root);
}

/* ------------------------ 十、移除项目：只删登记，不碰磁盘 ------------------------ */

section('十、移除项目：只删登记，不碰磁盘');
{
  const bench = makeBench('dsa-t10-');
  const other = path.join(bench.root, 'proj2');
  fs.mkdirSync(path.join(other, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(other, 'project.json'),
    JSON.stringify({ name: '第二个项目', root: other, dataDir: 'data' }, null, 2),
  );
  fs.writeFileSync(path.join(other, 'data', 'x.csv'), 'a,b\n1,2\n');
  bench.ledger.projects.push({ id: 'p2', path: other, name: '第二个项目' });
  bench.ledger.runs.push({ id: 'r1', projectId: 'p2', stageId: 'audit', status: 'ok', startedAt: new Date().toISOString() });
  bench.ledger.runs.push({ id: 'r2', projectId: 'test', stageId: 'scope', status: 'ok', startedAt: new Date().toISOString() });
  bench.ledger.adjudications.p2 = { 'qa-signoff': { status: 'pass', at: new Date().toISOString() } };
  bench.ledger.recheckChains = bench.ledger.recheckChains || {};
  bench.ledger.recheckChains.p2 = { projectId: 'p2', status: 'done', steps: [] };

  const result = bench.wb.forgetProject('p2');
  check('移除成功', result.ok === true, result.error || '');
  check('明确回报磁盘没动', result.diskKept === true);
  check('台账里不再有 p2', !(bench.ledger.projects || []).some((p) => p.id === 'p2'));
  check('这个项目的运行记录清了', !(bench.ledger.runs || []).some((r) => r.projectId === 'p2'));
  check('别的项目的运行记录还在', (bench.ledger.runs || []).some((r) => r.projectId === 'test'));
  check('这个项目的裁定清了', !bench.ledger.adjudications.p2);
  check('这个项目的复核链清了', !bench.ledger.recheckChains.p2);
  check('磁盘上的项目文件全在', fs.existsSync(path.join(other, 'data', 'x.csv')) && fs.existsSync(path.join(other, 'project.json')));

  const again = bench.wb.forgetProject('p2');
  check('重复移除报错而不是静默成功', again.ok === false, again.error || '');

  // 移除当前项目 = 回到「没选项目」，不许偷偷切到另一个项目
  const activeId = bench.ledger.activeProjectId;
  const current = bench.wb.forgetProject(activeId);
  check('移除当前项目成功', current.ok === true && current.active === true);
  check('活动项目清空', bench.ledger.activeProjectId === '' && bench.ledger.activeProjectPath === '');
  check('active() 不再报 ok', bench.wb.active().ok === false);
  check('当前项目的目录也还在', fs.existsSync(bench.proj) && fs.existsSync(path.join(bench.proj, 'project.json')));
  await removeTree(bench.root);
}

/* -------------------------------- 收尾 -------------------------------- */

console.log(`\n${failed ? `✗ ${failed} 项未通过` : '✓ 全部通过'}`);
process.exit(failed ? 1 : 0);
console.log(here);

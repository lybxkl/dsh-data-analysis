/**
 * 真实语料端到端：把项目复制到临时目录，把 223 份副本换成目录联接，再跑真实审计。
 * 只在材料包存在时运行；不碰原项目里的任何文件。
 *
 * 材料包路径可用环境变量改：
 *   DSA_PROJECT  原项目（默认 F:\测试文件\spss_analysis）
 *   DSA_SOURCE   材料源目录（默认 F:\测试文件\案例打包pdf\刑事pdf）
 *   DSA_ENTRIES  要迁移的子目录，逗号分隔（默认 安徽,北京,福建）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Workbench } from '../src/service.js';
import { Runner } from '../src/runner.js';

const SKILL = process.env.DSA_SKILL || 'F:\\测试文件\\SPSS-Style-Charting-Skill';
const REAL = process.env.DSA_PROJECT || 'F:\\测试文件\\spss_analysis';
const SOURCE = process.env.DSA_SOURCE || 'F:\\测试文件\\案例打包pdf\\刑事pdf';
const ENTRIES = (process.env.DSA_ENTRIES || '安徽,北京,福建').split(',').map((s) => s.trim()).filter(Boolean);

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

if (!fs.existsSync(REAL) || !fs.existsSync(SOURCE)) {
  console.log('（没有真实材料包，跳过端到端；用 DSA_PROJECT / DSA_SOURCE 指定）');
  process.exit(0);
}

const copyTree = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-e2e-'));
const proj = path.join(root, 'proj');
copyTree(path.join(REAL, 'data'), path.join(proj, 'data'));
fs.copyFileSync(path.join(REAL, 'project.json'), path.join(proj, 'project.json'));

const ledger = {
  version: 1,
  projects: [{ id: 'e2e', path: proj }],
  activeProjectId: 'e2e',
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
const wb = new Workbench({ getConfig: cfg, store, runner, onChange: () => {} });
runner.onFinish = (run) => wb.onRunFinished(run);

const countFiles = (dir) => {
  let n = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        try {
          if (fs.statSync(abs).isDirectory()) walk(abs);
          else n += 1;
        } catch {
          /* 断链 */
        }
      } else n += 1;
    }
  };
  walk(dir);
  return n;
};

console.log(`\n真实语料端到端（${ENTRIES.join(' / ')}）`);
const before = countFiles(path.join(proj, 'data'));
check('复制出 223 份样本', before > 0, `${before} 份`);

const added = wb.addSource({ path: SOURCE, label: '刑事裁判文书' });
const migrated = await wb.migrateSource({ sourceId: added.source.id, entries: ENTRIES, apply: true });
const report = (migrated.report || []).map((row) => `${row.entry}:${row.verified}/${row.totalLocal}`);
check('逐份 md5 全等后换成联接', migrated.ok === true && migrated.applied === true, report.join(' '));
check('一个副本都没漏', (migrated.report || []).every((row) => row.mismatched.length === 0 && row.missing.length === 0));
const after = countFiles(path.join(proj, 'data'));
check('联接后仍然数得到同样多的文件', after === before, `${after} 份`);
check(
  '子目录是联接',
  ENTRIES.every((name) => fs.lstatSync(path.join(proj, 'data', name)).isSymbolicLink()),
);

const started = wb.runStage('audit', { force: true });
const deadline = Date.now() + 12 * 60 * 1000;
let ran = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  ran = (ledger.runs || []).find((run) => run.id === started?.run?.id);
  if (ran && ran.status && ran.status !== 'running') break;
}
check('审计跑完', ran?.status === 'ok', `status=${ran?.status} exit=${ran?.exitCode}`);

const summaryFile = path.join(proj, 'output', 'audit', 'corpus_summary.json');
let summary = null;
try {
  summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
} catch {
  summary = null;
}
const total = Number(summary?.total_files ?? summary?.files ?? 0);
check('审计扫到同样的总数', total === before, `${total} vs ${before}`);

const gates = wb.snapshot().stages;
const findGate = (stageId, gateId) => (gates.find((s) => s.id === stageId)?.gates || []).find((g) => g.id === gateId);
check('sources-mounted 通过', findGate('scope', 'sources-mounted')?.status === 'pass', findGate('scope', 'sources-mounted')?.detail);
check('sources-outside 通过', findGate('scope', 'sources-outside')?.status === 'pass', findGate('scope', 'sources-outside')?.detail);
check('audit-freshness 通过', findGate('audit', 'audit-freshness')?.status === 'pass', findGate('audit', 'audit-freshness')?.detail);
check(
  '来源账与审计对得上',
  findGate('audit', 'materials-provenance-cover')?.status === 'pass',
  findGate('audit', 'materials-provenance-cover')?.detail,
);

console.log(`\n临时目录（可删）：${root}`);
console.log(failed ? `✗ ${failed} 项未通过` : '✓ 端到端通过');
process.exit(failed ? 1 : 0);

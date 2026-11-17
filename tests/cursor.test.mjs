/** 任务卡、验收档、冻结和交接的纯逻辑。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adoptCommand,
  archiveTierBlock,
  buildCursor,
  datasetPlan,
  entryBlock,
  recordDispute,
  recordHandoff,
  setAcceptance,
} from '../src/cursor.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-cursor-'));
const workflow = {
  stages: [
    { id: 'audit', index: 1, name: '资料审计', script: 'scripts/audit_corpus.py', dependsOn: [], artifacts: [], manualInstructions: [] },
    {
      id: 'coding', index: 2, name: '编码与抽取', script: 'scripts/make_coding_sheet.py', dependsOn: ['audit'],
      resumeFile: 'docs/decisions/inclusion.md',
      loop: { draftDir: 'draft', freezeFile: 'draft/freeze.json', sampleReport: 'draft/sample_errors.md' },
      artifacts: ['output/coding/coding_sheet.csv'], manualInstructions: [],
    },
    { id: 'verify', index: 3, name: '全格复核', minTier: 'archive', dependsOn: ['coding'], artifacts: [], manualInstructions: [] },
    {
      id: 'publish', index: 4, name: '交付到格式匠', dependsOn: ['manuscript'], artifacts: [],
      hostCall: { tool: 'formatjiang_receive_manuscript', input: 'output/manuscript.docx', returns: ['file_id', 'paper_id', 'version_id'] },
      manualInstructions: [],
    },
  ],
};

function write(relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

try {
  const first = setAcceptance(root, 'submission');
  assert.equal(first.ok, true);
  const denied = setAcceptance(root, 'explore');
  assert.equal(denied.ok, false);
  const allowed = setAcceptance(root, 'explore', { confirmDowngrade: true });
  assert.equal(allowed.acceptance.tier, 'explore');
  setAcceptance(root, 'submission');

  const early = buildCursor({
    root, workflow, tier: 'submission',
    stages: [
      { id: 'audit', status: 'done', gates: [] },
      { id: 'coding', status: 'todo', gates: [] },
      { id: 'verify', status: 'todo', gates: [{ id: 'verification-final', status: 'unjudged', label: '逐格', detail: '逐格' }] },
    ],
  });
  assert.match(early.text, /纳入确认/);
  assert.equal(early.cursor.stageId, 'coding');

  write('docs/decisions/inclusion.md', '纳入确认：保留刑事判决。');
  write('draft/sample_errors.md', '样本 20 份，罪名误差 1。');
  write('draft/parser.py', 'print("frozen")\n');
  const adopted = adoptCommand(root, { stage: workflow.stages[1], script: 'draft/parser.py', args: ['--root', 'data'], artifacts: ['output/coding/coding_sheet.csv'] });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.script, 'scripts/coding_frozen.py');
  assert.equal(fs.existsSync(path.join(root, 'draft/freeze.json')), true);

  const builtin = buildCursor({
    root, workflow,
    stages: [
      { id: 'audit', status: 'done', gates: [] },
      { id: 'coding', status: 'todo', gates: [] },
    ],
  });
  assert.match(builtin.text, /data_analysis_run_stage\(stageId="coding"\)/);
  assert.doesNotMatch(builtin.text, /adopt_command/);

  const unsetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-cursor-unset-'));
  try {
    const unset = buildCursor({
      root: unsetRoot, workflow,
      stages: [
        { id: 'audit', status: 'done', gates: [] },
        { id: 'coding', status: 'done', gates: [] },
        { id: 'verify', status: 'todo', gates: [] },
      ],
    });
    assert.equal(unset.cursor.stageId, 'verify');
    assert.match(unset.text, /未设置/);
  } finally {
    fs.rmSync(unsetRoot, { recursive: true, force: true });
  }

  const bad = adoptCommand(root, {
    stage: workflow.stages[1], script: 'draft/parser.py', args: [], artifacts: ['../outside.csv'],
  });
  assert.equal(bad.ok, false);

  const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-cursor-plain-'));
  try {
    const inclusion = path.join(plainRoot, 'docs', 'decisions', 'inclusion.md');
    fs.mkdirSync(path.dirname(inclusion), { recursive: true });
    fs.writeFileSync(inclusion, '纳入确认：全部纳入。');
    const plain = buildCursor({
      root: plainRoot, workflow, tier: 'submission',
      stages: [
        { id: 'audit', status: 'done', gates: [] },
        { id: 'coding', status: 'todo', gates: [] },
      ],
    });
    assert.match(plain.text, /data_analysis_run_stage\(stageId="coding"\)/);
    assert.doesNotMatch(plain.text, /adopt_command/);
  } finally {
    fs.rmSync(plainRoot, { recursive: true, force: true });
  }

  const ready = buildCursor({
    root, workflow, tier: 'submission',
    stages: [
      { id: 'audit', status: 'done', gates: [] },
      { id: 'coding', status: 'todo', gates: [] },
    ],
  });
  assert.match(ready.text, /data_analysis_run_stage\(stageId="coding"\)/);

  write('output/manuscript.docx', 'docx');
  const publish = buildCursor({
    root, workflow, tier: 'submission',
    stages: [
      { id: 'audit', status: 'done', gates: [] },
      { id: 'coding', status: 'done', gates: [] },
      { id: 'publish', status: 'todo', gates: [] },
    ],
  });
  assert.match(publish.text, /formatjiang_receive_manuscript/);
  assert.doesNotMatch(publish.text, /verification-final/);

  const dispute = recordDispute(root, { stageId: 'qa', gateId: 'qa-numbers', evidence: '95%CI 被读成了 95' });
  assert.equal(dispute.ok, true);
  const handoff = recordHandoff(root, { fileId: 'f_1', paperId: 9, versionId: 3, previous: '8' });
  assert.equal(handoff.ok, true);
  assert.equal(handoff.handoff.paper_id, 9);

  const delivered = buildCursor({
    root, workflow, tier: 'submission',
    stages: [
      { id: 'audit', status: 'done', gates: [] },
      { id: 'coding', status: 'done', gates: [] },
      { id: 'verify', status: 'review', gates: [{ id: 'verification-final', status: 'unjudged', level: 'error', detail: '逐格' }] },
      { id: 'publish', status: 'todo', gates: [] },
    ],
  });
  assert.equal(delivered.cursor.stageId, 'publish');
  assert.match(delivered.text, /交付编号已记录/);
  assert.doesNotMatch(delivered.text, /verification-final/);

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-cursor-data-'));
  const dataFlow = {
    stages: [
      { id: 'dataset', index: 4, name: '数据集', manualInstructions: ['从编码结果构建'], artifacts: ['output/dataset/analysis.csv'] },
      { id: 'verify', index: 5, name: '全格复核', minTier: 'archive', script: 'scripts/verify_dataset.py', manualInstructions: [] },
      {
        id: 'stats', index: 6, name: '统计分析', script: 'scripts/auto_stats.py',
        resumeFile: 'docs/decisions/primary-models.md', manualInstructions: [],
      },
      { id: 'figures', index: 7, name: '图表', script: 'scripts/auto_chart_pack.py', manualInstructions: [] },
    ],
  };
  try {
    const empty = datasetPlan(dataRoot);
    assert.equal(empty.ready, false);
    assert.match(empty.next, /构建 output\/dataset\/analysis.csv/);
    assert.match(empty.next, /候选/);
    const writeAt = (relative, text) => {
      const file = path.join(dataRoot, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    writeAt('output/dataset/analysis.csv', 'id,in_analysis\r\na,1\r\nb,0\r\n');
    const bare = buildCursor({
      root: dataRoot, workflow: dataFlow, tier: 'submission',
      stages: [{ id: 'dataset', status: 'review', gates: [] }],
    });
    assert.equal(bare.cursor.stageId, 'dataset');
    assert.match(bare.text, /写 research_registry\.json/);
    assert.doesNotMatch(bare.text, /构建 output\/dataset\/analysis\.csv/);
    writeAt('research_registry.json', JSON.stringify({
      datasets: [{ id: 'cases', path: 'output/dataset/analysis.csv', key: 'doc' }],
    }));
    assert.match(datasetPlan(dataRoot).next, /主键列不在表头/);
    writeAt('research_registry.json', JSON.stringify({
      datasets: [{ id: 'cases', path: 'output/dataset/analysis.csv', key: 'id' }],
    }));
    const readyPlan = datasetPlan(dataRoot);
    assert.equal(readyPlan.ready, true);
    assert.match(readyPlan.next, /inspect/);
    assert.match(readyPlan.label, /cases/);
    const registered = buildCursor({
      root: dataRoot, workflow: dataFlow, tier: 'submission',
      stages: [{ id: 'dataset', status: 'review', gates: [{ id: 'dataset-key', status: 'fail', level: 'error', detail: '主键有重复（例如 a）' }] }],
    });
    assert.match(registered.text, /主键有重复/);
    assert.match(registered.text, /inspect/);
    writeAt('docs/decisions/primary-models.md', '主分析：结局为 in_analysis。');
    const stats = buildCursor({
      root: dataRoot, workflow: dataFlow, tier: 'submission',
      stages: [
        { id: 'dataset', status: 'done', gates: [] },
        { id: 'stats', status: 'todo', gates: [] },
      ],
    });
    assert.equal(stats.cursor.stageId, 'stats');
    assert.match(stats.text, /主表是 cases/);
    assert.match(stats.text, /data_analysis_sweep/);
    const figures = buildCursor({
      root: dataRoot, workflow: dataFlow, tier: 'submission',
      stages: [
        { id: 'dataset', status: 'done', gates: [] },
        { id: 'stats', status: 'done', gates: [] },
        { id: 'figures', status: 'todo', gates: [] },
      ],
    });
    assert.match(figures.text, /数据表是 cases/);
    const statsStage = dataFlow.stages[2];
    assert.equal(entryBlock(dataRoot, statsStage, 'submission'), '');
    const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-cursor-block-'));
    try {
      assert.match(entryBlock(blockedRoot, statsStage, 'submission'), /构建 output\/dataset\/analysis\.csv/);
    } finally {
      fs.rmSync(blockedRoot, { recursive: true, force: true });
    }
    writeAt('output/coding/dataset.csv', 'id,charge\r\na,盗窃\r\n');
    assert.match(datasetPlan(dataRoot).next, /抽样复核：/);
    assert.equal(datasetPlan(dataRoot).ready, false);
    writeAt('docs/decisions/coding-sample.md', '抽样复核：');
    assert.equal(datasetPlan(dataRoot).ready, false);
    writeAt('docs/decisions/coding-sample.md', '抽样复核：抽了 a，脚本写盗窃，原文一致，残留误差无。');
    assert.equal(datasetPlan(dataRoot).ready, true);
    assert.equal(archiveTierBlock(dataRoot, '全格复核'), '');
    setAcceptance(dataRoot, 'submission');
    assert.match(archiveTierBlock(dataRoot, '全格复核'), /submission/);
    assert.match(archiveTierBlock(dataRoot, '全格复核'), /归档档/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  console.log('cursor ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

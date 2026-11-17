/** 任务卡、验收档、冻结和交接的纯逻辑。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adoptCommand,
  buildCursor,
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

  console.log('cursor ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

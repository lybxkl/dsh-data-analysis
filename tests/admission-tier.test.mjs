/** 高于当前验收档的判据不能挡住该档的阶段运行。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateAdmission } from '../src/gate-report.js';

const skill = process.env.DSA_SKILL_ROOT || 'F:/测试文件/SPSS-Style-Charting-Skill/empirical-research-pipeline';
assert.equal(fs.existsSync(path.join(skill, 'SKILL.md')), true, '需要可用的技能包');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tier-admission-'));

function write(rel, value) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

const stages = [
  { id: 'scope', gates: [{ id: 'scope-doc', status: 'pass' }] },
  { id: 'verify', gates: [{ id: 'verification-final', status: 'unjudged', level: 'error', detail: '还没有逐格复核' }] },
  { id: 'qa', gates: [{ id: 'qa-numbers', status: 'unjudged', level: 'error', detail: '缺 number_issues.csv' }] },
];

try {
  write('project.json', { name: '档位准入', skill: { root: skill } });
  write('.workbench/gates/policy.json', {
    schema: 'dsa.gate-policy/1',
    mode: 'skill',
    scopeKey: 'tier-test',
    requirements: [
      { gateId: 'scope-doc', definitionVersion: '2.0', reportStage: 'scope', displayStage: 'scope', blockingAt: 'data-ready', source: 'workbench', allowNa: false, required: true },
      { gateId: 'verification-final', definitionVersion: '2.0', reportStage: 'verify', displayStage: 'verify', blockingAt: 'analysis-ready', source: 'skill', allowNa: false, required: true },
      { gateId: 'qa-numbers', definitionVersion: '2.0', reportStage: 'qa', displayStage: 'qa', blockingAt: 'delivery-ready', source: 'skill', allowNa: false, required: true },
    ],
  });
  write('.workbench/acceptance.json', { schema: 'dsa.acceptance/1', tier: 'submission' });

  const analysis = gateAdmission(stages, root, 'analysis-ready');
  assert.equal(analysis.blockingInstances.some((item) => item.gateId === 'verification-final'), false, JSON.stringify(analysis.blockingInstances));
  assert.equal(analysis.allowed, true, JSON.stringify(analysis.blockingInstances));

  const delivery = gateAdmission(stages, root, 'delivery-ready');
  assert.equal(delivery.blockingInstances.some((item) => item.gateId === 'verification-final'), false);
  assert.equal(delivery.blockingInstances.some((item) => item.gateId === 'qa-numbers'), true, JSON.stringify(delivery.blockingInstances));

  fs.rmSync(path.join(root, '.workbench', 'acceptance.json'));
  const unset = gateAdmission(stages, root, 'analysis-ready');
  assert.equal(unset.blockingInstances.some((item) => item.gateId === 'verification-final'), true);
  console.log('admission tier ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * 阶段任务卡：把「工作台看到的现状」翻译成一段模型能直接执行的任务说明。
 *
 * 设计约束：
 *  - 卡片是确定性的：同一份状态生成的卡片逐字一致，便于测试与复盘。
 *  - 只写项目内路径；skill 包只读，卡片里明确写「不要改 skill」。
 *  - 卡片不替模型做研究判断：它给现状、命令、约束、期望产物，不给结论。
 */

import { datasetPlan } from './cursor.js';

const SHORT_STATUS = {
  done: '已完成',
  blocked: '被拦住',
  review: '待裁定',
  todo: '未开始',
  running: '运行中',
};

function statusLine(stage) {
  const marks = { pass: 0, fail: 0, unjudged: 0 };
  for (const gate of stage.gates || []) {
    if (gate.status === 'pass') marks.pass += 1;
    else if (gate.status === 'fail') marks.fail += 1;
    else marks.unjudged += 1;
  }
  const bits = [`✓${marks.pass}`, `✗${marks.fail}`, `?${marks.unjudged}`];
  return `${SHORT_STATUS[stage.status] || stage.status}（${bits.join(' ')}）`;
}

function describeFailures(stage) {
  const failed = (stage.gates || []).filter((gate) => gate.status === 'fail');
  if (!failed.length) return '';
  return failed
    .slice(0, 6)
    .map((gate) => `  - ${gate.label}：${gate.detail || '未通过'}`)
    .join('\n');
}

function describeManual(stage) {
  const manual = (stage.gates || []).filter((gate) => gate.manual && gate.status === 'unjudged');
  if (!manual.length) return '';
  return manual
    .slice(0, 6)
    .map((gate) => `  - ${gate.label}：${gate.detail || '需要人工裁定'}`)
    .join('\n');
}

export function buildTaskCard({ project, projectRoot, stage, stages, commands = [], sessionId = '', scriptRegistered = false }) {
  if (!stage) return { ok: false, error: '未知阶段' };
  const name = project?.name || '';
  const index = stage.index || 0;
  // 阶段总数按登记表算；传进来的若只是子集，也不要写成「6/3」这种谎
  const total = Math.max(index, (stages || []).length);
  const lines = [];

  lines.push(`[实证研究工作台 · 阶段任务卡 ${index}/${total}]`);
  lines.push(`项目：${name || projectRoot}`);
  lines.push(`目录：${projectRoot}（下面所有命令都在这个目录里执行）`);
  // 别让模型去读插件源码推断闸门：源码是磁盘上的，运行中的实例可能还是旧版本。
  // 上一轮会话就因为照着源码改了宽表路径，而 live 实例只认旧路径，来回搬了三次。
  lines.push('闸门与阶段状态一律以 data_analysis_status（或面板）的输出为准；不要去读工作台源码推断行为，也不要修改工作台。');
  lines.push(`阶段：${stage.name} —— ${stage.purpose}`);
  if (sessionId) lines.push(`会话：${sessionId}`);
  lines.push('');

  lines.push('当前状态（工作台按产物自动判定）：');
  const previous = (stages || []).filter((item) => (stage.dependsOn||[]).includes(item.id));
  if (previous.length) {
    for (const item of previous) {
      lines.push(`- ${item.index}. ${item.name}：${statusLine(item)}`);
      const fails = describeFailures(item);
      if (fails) lines.push(fails);
    }
  } else {
    lines.push('- 当前阶段没有前置依赖。');
  }
  lines.push(`- 本阶段：${statusLine(stage)}`);
  const currentFails = describeFailures(stage);
  if (currentFails) {
    lines.push('  本阶段未过项：');
    lines.push(currentFails);
  }
  const manual = describeManual(stage);
  if (manual) {
    lines.push('  待人工裁定（不需要你改产物，提醒用户在工作台里裁定）：');
    lines.push(manual);
  }
  const unjudged = (Array.isArray(stage.gates) ? stage.gates : []).filter((g) => g.status === 'unjudged' && !g.manual);
  if (unjudged.length) {
    lines.push('  判不了（不是通过，也不要用改标签/改产物把它变绿）：');
    for (const g of unjudged.slice(0, 6)) lines.push(`  - ${g.label}：${g.detail}`);
    lines.push('  处理方式：缺证据就补输入/补产物后重跑；需要人拍板的，把证据写进回答并停下，等用户在面板点「去拍板」，不要自己宣布通过。');
  }
  lines.push('');

  const artifacts = Array.isArray(stage.artifacts) ? stage.artifacts : [];
  lines.push(`本阶段产物：${artifacts.length ? artifacts.join('、') : '无登记'}`);
  lines.push('');

  lines.push('本次要做：');
  if (commands.length) {
    if (commands.length === 1) {
      lines.push(
        scriptRegistered
          ? `1. 在「实证研究工作台」点「运行本阶段」即可（脚本已登记在 project.json）；若要手动跑，命令是：${commands[0].display}`
          : `1. 在工作台外直接运行：${commands[0].display}`,
      );
    } else {
      lines.push(
        scriptRegistered
          ? `1. 在「实证研究工作台」点「运行本阶段」，它会按顺序跑 ${commands.length} 步（第 1 步失败也可继续时卡里会注明）；手动等价命令：`
          : `1. 在工作台外依次运行（${commands.length} 步）：`,
      );
      commands.forEach((command, i) => {
        lines.push(`   ${i + 1}) ${command.display}${command.continueOnError ? '（允许失败后继续下一步）' : ''}`);
      });
    }
    lines.push(`${commands.length + 1}. 读产物与报告；闸门不过就按报告修输入/参数后重跑，不要手改结果文件让闸门变绿。`);
  } else if (stage.id === 'dataset' && projectRoot) {
    lines.push(`1. ${datasetPlan(projectRoot).next}`);
    lines.push('2. 完成后查看 data_analysis_status。');
  } else {
    const brief = stage.manualInstructions;
    if (brief) brief.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    else lines.push('1. 这一步没有登记脚本，由你按阶段目标完成，产物写进项目目录。');
  }
  lines.push('');

  lines.push('约束：');
  lines.push('- 技能包（SKILL.md、scripts/、profiles/）只读：不要修改、不要复制进项目。');
  lines.push('- 不要手改 CSV/JSON/docx 让闸门通过；也不要改脚本输出标签去迎合闸门——闸门只能被真实产物满足。');
  for(const constraint of stage.taskConstraints||[])lines.push('- '+constraint);
  lines.push('');

  if (artifacts.length) {
    lines.push('期望产出：');
    for (const item of artifacts) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('完成后：查看 data_analysis_status 的 gateMode 与闸门。skill/compare 模式如缺少当前报告，调用 data_analysis_gates(action="inspect")；完成体检后刷新。仍不过就按证据修输入并重跑，不要改判定。');
  return { ok: true, text: lines.join('\n') };
}

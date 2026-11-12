/**
 * 阶段任务卡：把「工作台看到的现状」翻译成一段模型能直接执行的任务说明。
 *
 * 设计约束：
 *  - 卡片是确定性的：同一份状态生成的卡片逐字一致，便于测试与复盘。
 *  - 只写项目内路径；skill 包只读，卡片里明确写「不要改 skill」。
 *  - 卡片不替模型做研究判断：它给现状、命令、约束、期望产物，不给结论。
 */

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

const MANUAL_BRIEF = {
  scope: [
    '写 docs/scope.md，至少包含：研究问题、分析单位、时间窗、纳入/排除标准、关键变量的操作化口径、已知局限。',
    '这一步不产生数字；不要为了「看起来完整」编造样本量或文献引用。',
    '写完后在工作台点「刷新」，scope 闸门会检查文件是否存在且非空。',
  ],
  dataset: [
    '从 output/coding/dataset.csv（逐份抽取结果）构建 output/dataset/analysis.csv：一行一个分析单位。',
    '必须保留 in_analysis 标记（0/1）并说明排除理由；派生变量（分组、对数等）要写进 docs/codebook.md。',
    '不要改动 evidence.jsonl 里的原文证据；分析表只做可追溯的转换。',
    '构建脚本放 scripts/ 并在 project.json 里登记（可选），但产物必须是 output/dataset/analysis.csv——data/ 是语料根，宽表放进去会被下一次审计当成一份资料。',
  ],
  manuscript: [
    '先调 data_analysis_manuscript action=scaffold 生成骨架（按图表清单的 section 分组，figure 块的 png/caption 照抄清单，正文留「待补」；png 缺失或 status 不是 ok 的图会被跳过）。',
    '再按 action=brief 的改稿说明把「待补」写成正文，只改 manuscript.json；不要凭空手写一份 spec 绕过骨架。',
    '正文里的每个数字都要能落到 output/models/*.csv 或 output/dataset/analysis.csv 的原值；图注里的 N 不要重复加。',
    '改完必须重跑第 7 阶段（data_analysis_run_stage(stageId="manuscript")）生成 output/manuscript.docx——闸门只认这个 docx；再跑第 8 阶段终检。',
    '不要手改 docx 绕过统计结果；数字对不上就回到 stats/figures 修产物。',
  ],
  recheck: [
    '先调 data_analysis_recheck（action=status）看 12 项机器复算，再取 action=evidence 的证据包。',
    '逐条写问题：id（RC-001…）、severity、where（文件:行 或 阶段）、claim、evidence、fix_kind；用 data_analysis_issue 落库。',
    '修数据只能改 scripts/ 或 data/ 后重跑受影响阶段；不要手改 output/ 产物让闸门变绿。',
    '最后交 12 项覆盖表（R1–R12：checked / unchecked+理由）与 report.md；人逐条裁定后闭环。',
  ],
};

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
  const previous = (stages || []).filter((item) => (item.index || 0) < index);
  if (previous.length) {
    for (const item of previous) {
      lines.push(`- ${item.index}. ${item.name}：${statusLine(item)}`);
      const fails = describeFailures(item);
      if (fails) lines.push(fails);
    }
  } else {
    lines.push('- 这是第一阶段，前面没有依赖。');
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
  } else {
    const brief = MANUAL_BRIEF[stage.id];
    if (brief) brief.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    else lines.push('1. 这一步没有登记脚本，由你按阶段目标完成，产物写进项目目录。');
  }
  lines.push('');

  lines.push('约束：');
  lines.push('- 技能包（SKILL.md、scripts/、profiles/）只读：不要修改、不要复制进项目。');
  lines.push('- 不要手改 CSV/JSON/docx 让闸门通过；也不要改脚本输出标签去迎合闸门——闸门只能被真实产物满足。');
  lines.push('- 每个数字都要能溯源：正文数字要么来自 analysis.csv（output/dataset/）的统计，要么在 output/tables/*.csv 有同值单元格。');
  lines.push('- 缺少输入时停下来在回答里说明缺什么，不要伪造数据、N、p 值或文献。');
  lines.push('- 图表按 600 dpi 生成；图注写 N 与口径；配色用可灰度区分的色环。');
  lines.push('- 中文核对走 UTF-8 文件（必要时设 PYTHONIOENCODING=utf-8）；pwsh 直接打印可能乱码，不要把乱码当成数据错误。');
  lines.push('- 命令以项目登记为准；若脚本自己改写 sys.argv，命令行参数可能被忽略，以脚本实际行为为准。');
  lines.push('');

  if (artifacts.length) {
    lines.push('期望产出：');
    for (const item of artifacts) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('完成后：回到「实证研究工作台」点「刷新」，闸门会按产物自动重算。仍不过就继续修产物，不要改判定。');
  return { ok: true, text: lines.join('\n') };
}
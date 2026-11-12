/**
 * 模型工具（data_analysis_*）。
 *
 * 每个工具都是 Workbench 的薄封装：面板路由和工具走同一份 service，
 * 避免「面板上通过、工具里失败」这种两边不一致。
 */

import fs from 'node:fs';

import { defineTool } from '@deepseek-ai/dsh-tools';

const STATUS_LABEL = {
  done: '已完成',
  blocked: '被拦住',
  review: '待裁定',
  todo: '未开始',
  running: '运行中',
};

const GATE_LABEL = { pass: '✓', fail: '✗', unjudged: '?' };

function fail(message) {
  return [{ type: 'text', text: `操作失败：${message}` }];
}

/**
 * 工具返回值必须是无损 JSON：undefined / 函数 / 非有限数 / Date 都要先归一。
 * 快照里天然有大量可选字段（lastRun、verify、skillDrift…），不归一会被宿主判为
 * 不可序列化而整次调用失败。
 */
function jsonSafe(value) {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return undefined;
  if (kind === 'number') return Number.isFinite(value) ? value : null;
  if (kind === 'bigint') return String(value);
  if (kind === 'string' || kind === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = jsonSafe(item);
      return next === undefined ? null : next;
    });
  }
  if (kind === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const next = jsonSafe(item);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return undefined;
}

function okText(line) {
  return [{ type: 'text', text: line }];
}

function stageLine(stage) {
  // 未开工的阶段：闸门还没被评价，报 ✓/✗ 计数会误导（那些 ✗ 只是「产物还没生成」）
  if (stage.status === 'todo') return `${stage.index}. ${stage.name} · 未开始`;
  const counts = { pass: 0, fail: 0, unjudged: 0 };
  for (const g of stage.gates) counts[g.status] = (counts[g.status] || 0) + 1;
  return `${stage.index}. ${stage.name} · ${STATUS_LABEL[stage.status] || stage.status}（✓${counts.pass} ✗${counts.fail} ?${counts.unjudged}）`;
}

function gateLine(gate) {
  const mark = GATE_LABEL[gate.status] || '?';
  const level = gate.level === 'error' ? 'error' : 'warn';
  return `  ${mark} [${level}${gate.manual ? '·人工' : ''}] ${gate.label} — ${gate.detail}`;
}

const CHECK_MARK = { pass: '✓', fail: '✗', warn: '!', unjudged: '?' };

function preflightLine(pre) {
  if (!pre || !pre.status || pre.status === 'pass') return '';
  if (pre.status === 'pending') return '环境自检：尚未检查（调 data_analysis_doctor 或打开面板会自动检查）';
  const bad = (pre.checks || []).filter((item) => item.status === 'fail');
  if (!bad.length) {
    const warn = (pre.checks || []).filter((item) => item.status === 'warn');
    return `环境自检：可用但有降级 —— ${warn.map((item) => item.detail).join('；') || '无'}`;
  }
  return `环境自检：未通过 —— ${bad.map((item) => `${item.label}：${item.detail}`).join('；')}（用 data_analysis_doctor 看处理建议）`;
}

export function registerTools(ctx, workbench, helpers = {}) {
  const { logger, assistant } = helpers;
  const disposers = [];

  function register(definition) {
    try {
      const original = definition.execute;
      definition.execute = async (args) => jsonSafe(await original(args));
      const dispose = ctx.tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    } catch (error) {
      const message = String(error?.message || error);
      if (/duplicate/i.test(message)) {
        logger?.warn?.(`[data-analysis] 工具 ${definition.name} 已存在，跳过重复注册`);
        return () => {};
      }
      logger?.error?.(`[data-analysis] 注册工具 ${definition.name} 失败：${message}`);
      return () => {};
    }
  }

  /* ---------------------------- 只读 ---------------------------- */

  register(defineTool({
    name: 'data_analysis_status',
    description:
      '查看实证研究工作台当前状态：skill 是否就位、当前项目 8 个阶段各自的闸门判定（✓通过 / ✗未过 / ?判不了）、'
      + '最近运行记录、图表清单摘要。任何涉及「下一步跑什么」「为什么被拦住」的问题先调它。',
    parameters: {
      verbose: { type: 'boolean', description: '是否逐条列出闸门明细（默认只列阶段汇总）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已获取工作台状态') },
    async execute(args) {
      const snap = workbench.snapshot();
      const compactSkill = { ok: snap.skill.ok, version: snap.skill.version, packageDir: snap.skill.packageDir, reason: snap.skill.reason };
      const lines = [];
      lines.push(snap.skill.ok
        ? `skill：${snap.skill.version}（${snap.skill.scripts.length} 个脚本，sha256 ${snap.skill.sha256.slice(0, 12)}）`
        : `skill：不可用 —— ${snap.skill.reason}`);
      const preLine = preflightLine(snap.preflight);
      if (preLine) lines.push(preLine);
      if (!snap.active) {
        lines.push(`项目：未打开${snap.error ? `（${snap.error}）` : ''}`);
        if (snap.projects.length) lines.push(`已知项目：${snap.projects.map((p) => p.path).join('、')}`);
        return { ok: true, text: lines.join('\n'), skill: compactSkill, preflight: snap.preflight, active: null, projects: snap.projects.map((p) => p.path), summary: snap.summary, stages: [] };
      }
      lines.push(`项目：${snap.active.name}（${snap.active.path}）`);
      if (snap.active.skillDrift) lines.push('注意：项目的 SKILL.md 指纹与当前 skill 不一致，旧产物可能来自旧版本。');
      const matLine = materialsLine(snap.materials);
      if (matLine) lines.push(matLine);
      for (const stage of snap.stages) {
        lines.push(stageLine(stage));
        if (args?.verbose) for (const gate of stage.gates) lines.push(gateLine(gate));
        if (stage.lastRun) lines.push(`     最近运行 ${stage.lastRun.status} · ${stage.lastRun.exitCode ?? '—'} · ${stage.lastRun.startedAt}`);
      }
      if (snap.artifacts?.verify) {
        lines.push(`数字溯源：error ${snap.artifacts.verify.counts.error} / warning ${snap.artifacts.verify.counts.warning} / V-05 待复核 ${snap.artifacts.verify.counts.deferred}`);
      }
      if (snap.artifacts?.figures?.rows?.length) {
        lines.push(`图表：${snap.artifacts.figures.rows.length} 张（清单 ${snap.artifacts.figures.file}）`);
      }
      // 只回摘要与闸门，不回整份产物快照：模型不需要 60 张图的每一列
      return {
        ok: true,
        text: lines.join('\n'),
        skill: compactSkill,
        preflight: snap.preflight,
        active: { id: snap.active.id, name: snap.active.name, path: snap.active.path, skillDrift: Boolean(snap.active.skillDrift) },
        summary: snap.summary,
        materials: snap.materials || null,
        stages: snap.stages.map((stage) => ({
          id: stage.id,
          index: stage.index,
          name: stage.name,
          status: stage.status,
          lastRun: stage.lastRun,
          gates: stage.gates.map((gate) => ({
            id: gate.id,
            label: gate.label,
            level: gate.level,
            status: gate.status,
            manual: Boolean(gate.manual),
            stale: Boolean(gate.stale),
            detail: gate.detail,
          })),
        })),
      };
    },
  }));

  register(defineTool({
    name: 'data_analysis_doctor',
    description:
      '检查运行环境：技能包是否就位（SKILL.md、阶段脚本是否齐全）、Python 是否可用及版本、'
      + '依赖是否装齐（pandas/numpy/scipy/statsmodels/matplotlib/PyMuPDF/python-docx/openpyxl/Pillow）、'
      + 'Word→PDF（pywin32）是否可用。启动时会自动查一次；用户问「插件装好了吗」「环境对不对」'
      + '「为什么脚本跑不起来」时调它。refresh=true 强制重新探测。',
    parameters: {
      refresh: { type: 'boolean', description: '忽略缓存，重新探测一次（改过 Python 路径或刚装完依赖时用）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '自检完成') },
    async execute(args) {
      const pre = await workbench.ensurePreflight({ force: Boolean(args?.refresh) });
      const label = { pass: '通过', fail: '未通过', warn: '可用但有降级', unjudged: '判不了', pending: '待检查' };
      const lines = [`环境自检：${label[pre.status] || pre.status}${pre.python ? ` · Python ${pre.python}` : ''}`];
      if (pre.platform) lines.push(`平台：${pre.platform}${pre.pythonCommand ? ` · 用的是 ${pre.pythonCommand}` : ''}`);
      for (const item of pre.checks || []) {
        lines.push(`${CHECK_MARK[item.status] || '?'} ${item.label} — ${item.detail}`);
        if (item.hint && item.status !== 'pass') lines.push(`   → ${item.hint}`);
      }
      return {
        ok: pre.ok !== false,
        status: pre.status,
        text: lines.join('\n'),
        checkedAt: pre.checkedAt,
        platform: pre.platform || '',
        python: pre.python,
        pythonCommand: pre.pythonCommand || '',
        checks: pre.checks,
      };
    },
  }));

  register(defineTool({
    name: 'data_analysis_list_stages',
    description: '列出工作台的 8 个阶段、每个阶段的用途、绑定的 skill 脚本与预期产物；用于向用户解释流程。',
    parameters: {},
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已列出阶段') },
    async execute() {
      const snap = workbench.snapshot();
      const lines = snap.stages.length
        ? snap.stages.map((s) => `${s.index}. ${s.name} — ${s.purpose}（脚本 ${s.script || '无 · 人工'}）`)
        : [];
      return {
        ok: true,
        text: lines.join('\n') || '还没有打开项目',
        stages: snap.stages.map((s) => ({ id: s.id, index: s.index, name: s.name, script: s.script, status: s.status })),
      };
    },
  }));

  register(defineTool({
    name: 'data_analysis_figures',
    description:
      '查看图表清单与每张图的合规徽章（文件 / 有效 dpi / 最小字号 / 配色 / N），三态：pass、fail、unjudged（判不了≠通过）。'
      + '用于回答「哪些图不达标」「为什么字号是未核」。',
    parameters: {
      onlyProblems: { type: 'boolean', description: '只看 fail 或 unjudged 的图（默认 false）' },
      limit: { type: 'number', description: '最多列几张，默认 40' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已读取图表清单') },
    async execute(args) {
      const snap = workbench.snapshot();
      if (!snap.active) return { ok: false, error: snap.error };
      const rows = snap.artifacts?.figures?.rows || [];
      if (!rows.length) {
        return { ok: true, text: `没有图表清单（${snap.artifacts?.figures?.file || 'output/chart_pack/chart_manifest.csv'} 不存在）`, figures: [] };
      }
      const limit = Math.min(200, Math.max(1, Number(args?.limit) || 40));
      const filtered = args?.onlyProblems
        ? rows.filter((row) => row.badges.some((b) => b.state !== 'pass'))
        : rows;
      const lines = filtered.slice(0, limit).map((row) => {
        const marks = row.badges.map((b) => `${b.state === 'pass' ? '✓' : b.state === 'fail' ? '✗' : '?'}${b.label}${b.text}`).join(' ');
        return `- ${row.id}${row.chartType ? `（${row.chartType}）` : ''} N=${row.nText || '—'} ${marks}`;
      });
      // 「判不了」不是「有问题」：把 fail 与 unjudged 分开报，否则 33 张 PNG
      // 会因为「字号没有 PDF 文字层可测」被整体说成 33 张有问题。
      const failed = filtered.filter((row) => row.badges.some((b) => b.state === 'fail')).length;
      const unjudged = filtered.length - failed;
      return {
        ok: true,
        text: `图表 ${rows.length} 张${args?.onlyProblems ? `，不达标 ${failed} 张 · 待核 ${unjudged} 张` : ''}\n${lines.join('\n')}`,
        // 只回徽章结论，不回 manifest 的全部原始列
        figures: filtered.slice(0, limit).map((row) => ({
          id: row.id,
          chartType: row.chartType,
          n: row.nText,
          effectiveDpi: row.effectiveDpi === null ? null : Math.round(row.effectiveDpi),
          minFontsize: row.minFontsize,
          badges: row.badges.map((badge) => ({ key: badge.key, state: badge.state, text: badge.text })),
        })),
      };
    },
  }));

  /* ---------------------------- 项目 ---------------------------- */

  register(defineTool({
    name: 'data_analysis_create_project',
    description:
      '在一个空目录里从零搭研究工作台骨架（data/ docs/ output/ scripts/ runs/ + project.json）并设为当前项目。'
      + 'v0.1 只支持空目录，已有内容的目录会被拒绝。',
    parameters: {
      dir: { type: 'string', required: true, description: '项目目录的绝对路径（必须是空目录或不存在）' },
      name: { type: 'string', description: '项目名，默认取目录名' },
      scope: { type: 'string', description: '研究范围一句话（写进 project.json 的 scope.note 前不会覆盖文档）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已建立项目') },
    async execute(args) {
      const result = workbench.createProject(args.dir, args.name, args.scope ? { note: String(args.scope) } : null);
      if (!result.ok) return { ok: false, error: result.error, text: `操作未完成：${result.error}` };
      return {
        ok: true,
        text: `已建立项目 ${result.project.name}\n路径：${result.root}\n创建：${result.created.join('、')}\n下一步：把研究资料放进 data/，在 docs/scope.md 写清纳入/排除标准。`,
        project: result.project,
        root: result.root,
      };
    },
  }));

  register(defineTool({
    name: 'data_analysis_open_project',
    description: '打开一个已有的研究工作台项目（目录里要有 project.json），作为当前项目。',
    parameters: {
      dir: { type: 'string', required: true, description: '项目绝对路径' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已打开项目') },
    async execute(args) {
      const result = workbench.openProject(args.dir);
      if (!result.ok) return { ok: false, error: result.error, text: `操作未完成：${result.error}` };
      const snap = workbench.snapshot();
      return {
        ok: true,
        text: `已打开 ${result.project.name}\n${snap.stages.map(stageLine).join('\n')}`,
        project: result.project,
        root: result.path,
      };
    },
  }));

  /* ---------------------------- 运行 ---------------------------- */

  register(defineTool({
    name: 'data_analysis_run_stage',
    description:
      '在当前项目的某个阶段上运行绑定脚本（子进程执行，日志落 runs/<runId>.log）。'
      + '前置阶段有 error 闸门未过或待人工裁定时会被拦住；返回 runId 后用 data_analysis_run_log 查看输出。'
      + '注意：退出码 0 不等于阶段完成，完成与否看闸门与产物。',
    parameters: {
      stageId: { type: 'string', required: true, description: 'scope | audit | coding | dataset | stats | figures | manuscript | qa' },
      force: { type: 'boolean', description: '跳过前置闸门检查（只在确认要跳过时用）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已启动运行') },
    async execute(args) {
      const result = workbench.runStage(String(args.stageId || '').trim(), { force: Boolean(args.force) });
      if (!result.ok) return { ok: false, error: result.error, text: `操作未完成：${result.error}` };
      return {
        ok: true,
        text: `已启动 ${args.stageId}：${result.run.id}\n命令：${result.command}\n日志：${result.run.logFile}\n用 data_analysis_run_log 查看输出。`,
        run: result.run,
        command: result.command,
      };
    },
  }));

  register(defineTool({
    name: 'data_analysis_run_log',
    description: '读取一次运行的日志尾部与状态（运行中 / ok / failed / cancelled，退出码与信号）。',
    parameters: {
      runId: { type: 'string', required: true, description: '运行 id（run-xxx）' },
      limit: { type: 'number', description: '读最后多少行，默认 120' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已读取日志') },
    async execute(args) {
      const result = workbench.runLog(String(args.runId || '').trim(), Math.min(400, Math.max(10, Number(args.limit) || 120)));
      if (!result.ok) return { ok: false, error: '找不到这次运行' };
      const run = result.run;
      const head = `${run.stageId} · ${run.status} · 退出码 ${run.exitCode ?? '—'}${run.signal ? ` · signal ${run.signal}` : ''}`;
      return {
        ok: true,
        text: `${head}\n—— 日志尾部 ——\n${result.lines.join('\n') || '（暂无输出）'}`,
        run,
        lines: result.lines,
      };
    },
  }));

  register(defineTool({
    name: 'data_analysis_cancel_stage',
    description: '取消当前项目某个阶段正在跑的进程（Windows 下整棵进程树一起结束）。',
    parameters: {
      stageId: { type: 'string', required: true, description: '阶段 id' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已发出取消') },
    async execute(args) {
      const result = workbench.cancelStage(String(args.stageId || '').trim());
      if (!result.ok) return { ok: false, error: result.error, text: `操作未完成：${result.error}` };
      return { ok: true, text: `已向 ${args.stageId} 的运行发出取消请求` };
    },
  }));

  /* ---------------------------- 裁定 ---------------------------- */

  register(defineTool({
    name: 'data_analysis_adjudicate',
    description:
      '对人工闸门做裁定（pass / fail / 撤销=unjudged）并写台账。只能裁定标了「人工」的闸门；'
      + '机器能判的事实（dpi、文件存在、数字溯源 error）不允许被改成通过。',
    parameters: {
      stageId: { type: 'string', required: true, description: '阶段 id' },
      gateId: { type: 'string', required: true, description: '闸门 id，如 qa-signoff' },
      status: { type: 'string', required: true, description: 'pass | fail | unjudged' },
      note: { type: 'string', description: '裁定理由（写进台账，未来可追溯）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已记录裁定') },
    async execute(args) {
      const result = workbench.adjudicate({
        stageId: String(args.stageId || '').trim(),
        gateId: String(args.gateId || '').trim(),
        status: String(args.status || '').trim(),
        note: args.note,
      });
      if (!result.ok) return { ok: false, error: result.error, text: `操作未完成：${result.error}` };
      const label = args.status === 'pass' ? '通过' : args.status === 'fail' ? '不通过' : '撤销裁定';
      return { ok: true, text: `已记录 ${args.gateId}：${label}${args.note ? `（${args.note}）` : ''}`, adjudications: result.adjudications };
    },
  }));

  /* ---------------------------- 复核与修订 ---------------------------- */

  register(defineTool({
    name: 'data_analysis_recheck',
    description:
      '第 9 阶段复核：先跑机器复算（12 项：数据血缘、in_analysis 生效、模型 N、图与数据新旧、图注 N、'
      + '数字溯源、项目脚本静默丢样、终检报告、文稿图表数、产物新鲜度、覆盖表），再返回问题清单与证据包。'
      + 'action=status 只看复算；action=evidence 取受控证据包（给模型审计用）；'
      + 'action=issues 列问题；action=set 改一条问题的状态；action=apply 套用补丁并按下游重跑。',
    parameters: {
      action: { type: 'string', required: true, description: 'status | evidence | issues | set | apply' },
      id: { type: 'string', description: '问题 id（set / apply 必填）' },
      status: { type: 'string', description: 'set 时的新状态：open | fixed | wontfix | deferred' },
      note: { type: 'string', description: 'set 时的备注（为什么撤销/延后）' },
      advance: { type: 'boolean', description: 'apply 后是否自动重跑下游阶段（默认 true）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '复核完成') },
    execute(args) {
      const action = String(args.action || 'status');
      if (action === 'evidence') {
        const result = workbench.recheckEvidence();
        if (!result.ok) return { ok: false, error: result.error, text: `取证据包失败：${result.error}` };
        return { ...result, text: `证据包 ${result.chars} 字符：项目/复算/问题/样本/脚本，可直接据此写 issues.jsonl` };
      }
      if (action === 'set') {
        const result = workbench.updateIssue({ id: args.id, status: args.status, note: args.note });
        if (!result.ok) return { ok: false, error: result.error, text: `改问题状态失败：${result.error}` };
        return { ok: true, issue: result.issue, text: `${result.issue.id} → ${result.issue.status}` };
      }
      if (action === 'apply') {
        const result = workbench.applyIssue(String(args.id || ''), { advance: args.advance !== false });
        if (!result.ok) return { ok: false, error: result.error, text: `套用失败：${result.error}` };
        return {
          ok: true,
          file: result.file,
          backup: result.backup,
          chain: result.chain,
          note: result.note,
          text: result.chain
            ? `已应用 ${result.file}（备份 ${result.backup}），开始重跑 ${result.chain.steps.join(' → ')}`
            : `已应用 ${result.file}（备份 ${result.backup}）${result.note ? `；${result.note}` : ''}`,
        };
      }
      if (!['status', 'issues'].includes(action)) {
        return { ok: false, text: `不认识的 action：${action}（status|evidence|issues|set|apply）` };
      }
      const state = workbench.recheckState();
      if (!state.ok) return { ok: false, error: state.error, text: `复核状态不可用：${state.error}` };
      if (action === 'issues') {
        return {
          ok: true,
          issues: state.issues,
          openErrors: state.openErrors,
          openOthers: state.openOthers,
          text: state.issues.length
            ? state.issues.map((issue) => `${issue.id} [${issue.severity}/${issue.status}] ${issue.where}：${issue.claim}`).join('\n')
            : '还没有 issues.jsonl（模型尚未审计）',
        };
      }
      const lines = state.checks.map((item) => `${item.id} [${item.status}] ${item.label}：${item.detail}`);
      return {
        ok: true,
        checks: state.checks,
        coverage: state.coverage,
        openErrors: state.openErrors,
        openOthers: state.openOthers,
        chain: state.chain,
        text: lines.join('\n'),
      };
    },
  }));

  register(defineTool({
    name: 'data_analysis_issue',
    description:
      '向 output/recheck/issues.jsonl 追加（或更新）一条复核问题。模型审计时用：每条问题必须写清'
      + ' severity（error/warning/info）、where（文件:行 或 阶段）、claim（哪里不成立）、evidence（证据），'
      + 'fix_kind（edit-text/edit-code/rerun/accept-risk/ask-user）；若要给补丁，用 patch_path（项目内相对路径）、'
      + ' patch_base_hash（改动前文件的 sha256:...，必须取自 data_analysis_recheck 的 evidence 里「可补丁文件的当前哈希」）、'
      + ' patch_content（改动后的整份新内容）——三个字段都要给，缺一个补丁就不会保存。'
      + '模型不直接改产物：补丁由人点「套用」后才会落盘并重跑下游。',
    parameters: {
      id: { type: 'string', required: true, description: '问题 id，如 RC-001' },
      severity: { type: 'string', required: true, description: 'error | warning | info' },
      where: { type: 'string', required: true, description: '定位：文件:行 或 阶段 id' },
      claim: { type: 'string', required: true, description: '一句话：哪里不成立' },
      evidence: { type: 'string', description: '证据（数字、行号、命令输出）' },
      fix_kind: { type: 'string', description: 'edit-text | edit-code | rerun | accept-risk | ask-user' },
      patch_path: { type: 'string', description: '补丁目标文件（项目内相对路径）' },
      patch_base_hash: { type: 'string', description: '改动前该文件的 sha256:...' },
      patch_content: { type: 'string', description: '补丁后的整份文件内容' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已写入问题') },
    execute(args) {
      const severity = String(args.severity || '');
      if (!['error', 'warning', 'info'].includes(severity)) {
        return { ok: false, error: 'severity 只能是 error / warning / info', text: '未写入：severity 不合法' };
      }
      const fixKind = String(args.fix_kind || 'ask-user');
      const issue = {
        id: String(args.id),
        severity,
        where: String(args.where),
        claim: String(args.claim),
        evidence: String(args.evidence || ''),
        fix_kind: fixKind,
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      // 兼容两种写法：平铺的 patch_*，或一个 patch 对象（描述里提过 patch.path，模型会照着写）
      const patchIn = args.patch && typeof args.patch === 'object' ? args.patch : {};
      const patchPath = args.patch_path ?? patchIn.path;
      const patchHash = args.patch_base_hash ?? patchIn.baseHash;
      const patchContent = args.patch_content ?? patchIn.content;
      if (patchPath && patchContent) {
        issue.patch = {
          path: String(patchPath),
          baseHash: String(patchHash || ''),
          content: String(patchContent),
        };
      }
      const state = workbench.recheckState();
      if (!state.ok) return { ok: false, error: state.error, text: `写问题失败：${state.error}` };
      const result = workbench.recordIssue(issue);
      if (!result.ok) return { ok: false, error: result.error, text: `写问题失败：${result.error}` };
      return { ok: true, issue: result.issue, total: result.total, text: `已记录 ${issue.id}（${severity}）：${issue.claim}` };
    },
  }));

  register(defineTool({
    name: 'data_analysis_draft',
    description:
      '让工作台用「DSH 当前默认模型」（或面板设置里指定的模型）为一个阶段起草文本：scope=研究范围、'
      + 'codebook=变量字典、figures=图表题注与解读、manuscript=文稿小节、qa=质检问题说明。'
      + '工作台只读项目产物拼上下文，模型没有工具、不会运行脚本；返回可编辑的 Markdown。'
      + 'save=true 时同时写入该任务固定的 docs/ 落点（scope.md / codebook.md / figure-notes.md / '
      + 'manuscript-notes.md / qa-notes.md）。',
    parameters: {
      task: { type: 'string', required: true, description: '起草任务：scope | codebook | figures | manuscript | qa' },
      instruction: { type: 'string', description: '补充要求（口吻、篇幅、重点变量、要讨论的图号等）' },
      save: { type: 'boolean', description: '是否直接写入项目 docs/ 下的固定文件（默认 false，只返回文本）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '起草完成') },
    async execute(args) {
      if (!assistant) return { ok: false, text: '宿主没有 llm 服务，无法起草' };
      const result = await assistant.draft({ taskId: args.task, instruction: args.instruction });
      if (!result.ok) return { ok: false, error: result.error, text: `起草失败：${result.error}` };
      let saved = null;
      if (args.save) saved = assistant.save({ taskId: result.task, text: result.text });
      // 写盘失败不能报成功：模型会据此告诉用户「已经写进 docs/ 了」
      if (args.save && !saved?.ok) {
        return {
          ok: false,
          error: saved?.error || '写入 docs/ 失败',
          text: `起草完成，但没写进 docs/：${saved?.error || '未知原因'}`,
          draft: result.text,
          task: result.task,
        };
      }
      return {
        ok: true,
        text: result.text,
        task: result.task,
        file: result.file,
        provider: result.provider,
        model: result.model,
        routeSource: result.routeSource,
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        missing: result.missing,
        saved: saved && saved.ok ? saved.file : null,
        saveError: saved && !saved.ok ? saved.error : null,
      };
    },
  }));

  /* ---------------------------- 材料库 ---------------------------- */

  const MOUNT_STATUS = {
    ok: '有效',
    'not-link': '不是工作台建的挂载（真实目录）',
    'missing-link': '挂载不见了',
    retargeted: '挂载指到了别的目录',
    'missing-target': '目标目录不在了',
  };

  function splitList(raw) {
    return String(raw || '')
      .split(/[\n,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  /** 工具参数里的布尔偶尔是字符串（"false"）；Boolean('false') 是 true，破坏性开关不能这么转。 */
  function isTrue(value) {
    if (value === true) return true;
    if (value === false || value === undefined || value === null) return false;
    const text = String(value).trim().toLowerCase();
    return text === 'true' || text === '1' || text === 'yes';
  }

  function materialsText(sources, mounts = [], derived = []) {
    const lines = [];
    if (!sources.length) lines.push('材料库：空 —— 先用 action=add 登记一个材料目录（path=绝对路径）');
    else {
      lines.push(`材料库：${sources.length} 个目录（全局一份，多个项目可以共用）`);
      sources.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.label}${item.exists ? '' : '（目录不在了！）'} — ${item.path}`);
        if (item.receipt) lines.push(`   ${item.receipt}`);
        if (item.usedBy?.length) lines.push(`   已挂到：${item.usedBy.map((row) => `${row.project} → data/${row.as}`).join('、')}`);
        else lines.push('   还没有项目挂载它');
      });
    }
    if (mounts.length) {
      lines.push('当前项目 data/ 下的挂载：');
      for (const mount of mounts) {
        const bad = mount.status !== 'ok';
        lines.push(` ${bad ? '✗' : '✓'} data/${mount.as} → ${mount.target}（${MOUNT_STATUS[mount.status] || mount.status}）${mount.detail ? ` — ${mount.detail}` : ''}`);
      }
    }
    if (derived.length) {
      lines.push(`派生稿：${derived.map((item) => `${item.mountName}（${item.files} 份）`).join('、')}`);
    }
    return lines.join('\n');
  }

  /** status 里的一行材料摘要；没挂任何材料时返回空串，不占版面。 */
  function materialsLine(materials) {
    if (!materials) return '';
    const mounts = materials.mounts || [];
    const sources = materials.sources || [];
    if (!mounts.length) {
      return sources.length
        ? `材料库：已登记 ${sources.length} 个目录但当前项目没挂载（data_analysis_materials action=mount 可挂上）`
        : '';
    }
    const bad = mounts.filter((item) => item.status !== 'ok');
    const derived = materials.derived || [];
    const head = `材料：data/ 下 ${mounts.length} 条挂载（${mounts.map((item) => item.as).join('、')}）`;
    const tail = derived.length ? `，派生稿 ${derived.reduce((sum, item) => sum + (item.files || 0), 0)} 份` : '';
    return bad.length
      ? `${head}${tail} —— ⚠ ${bad.length} 条失效：${bad.map((item) => `data/${item.as}（${MOUNT_STATUS[item.status] || item.status}）`).join('、')}，用 data_analysis_materials action=repair 修`
      : `${head}${tail}`;
  }

  register(defineTool({
    name: 'data_analysis_materials',
    description:
      '管理材料库：把用户准备好的资料目录登记进来（全局一份，与项目解耦），再挂到项目 data/ 下（Windows 目录联接 / macOS·Linux 镜像目录，都不复制文件）。'
      + 'action=list 看清单与挂载状态；add 登记目录（path）；remove 删条目（先查引用）；'
      + 'mount 挂载（sourceId + 可选 entries 逗号分隔的子目录）；unmount 解挂（as）；repair 修断掉的联接。'
      + '登记回执会把目录里的文件按「直读 / 识图 / 待转换 / 不支持」四类报数。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | add | remove | mount | unmount | repair' },
      path: { type: 'string', description: 'add：材料目录绝对路径' },
      label: { type: 'string', description: 'add：给这个目录起的名（默认取目录名）' },
      sourceId: { type: 'string', description: 'mount/remove：材料库条目 id' },
      entries: { type: 'string', description: 'mount：只挂源里的这几个子目录，逗号或换行分隔；留空=挂整个目录' },
      as: { type: 'string', description: 'mount：挂到 data/ 下用什么名字；unmount：要摘掉的那个名字' },
      force: { type: 'boolean', description: 'remove：确认删（有项目在用时仍需 force）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '材料库已更新') },
    async execute(args) {
      const action = String(args?.action || 'list');
      if (action === 'list') {
        const list = workbench.sources();
        const state = workbench.mountsStateSafe();
        return { ok: true, text: materialsText(list, state.mounts, state.derived), sources: list, mounts: state.mounts, derived: state.derived, entries: state.entries };
      }
      if (action === 'add') {
        const result = workbench.addSource({ label: args?.label, path: args?.path });
        if (!result.ok) return { ok: false, error: result.error, text: `登记失败：${result.error}` };
        return {
          ok: true,
          text: [`已登记「${result.source.label}」— ${result.source.path}`, result.receipt || '', '这一步只登记，没有复制任何文件；要让它进项目就再 action=mount'].filter(Boolean).join('\n'),
          source: result.source,
          sources: result.sources,
        };
      }
      if (action === 'remove') {
        const result = workbench.removeSource(args?.sourceId, { force: Boolean(args?.force) });
        if (!result.ok) return { ok: false, error: result.error, text: `删除失败：${result.error}` };
        return { ok: true, text: '已从材料库删掉这个目录（磁盘上的文件没动）', sources: result.sources };
      }
      if (action === 'mount') {
        const result = await workbench.mountSource({
          sourceId: args?.sourceId,
          entries: splitList(args?.entries),
          as: args?.as,
        });
        if (!result.ok) return { ok: false, error: result.error, text: `挂载失败：${result.error}` };
        const state = result.state || {};
        return {
          ok: true,
          text: [materialsText(workbench.sources(), state.mounts, state.derived), '', result.note].filter(Boolean).join('\n'),
          mounts: result.mounts,
          state,
        };
      }
      if (action === 'unmount') {
        const result = await workbench.unmountSource({ as: args?.as });
        if (!result.ok) return { ok: false, error: result.error, text: `解挂失败：${result.error}` };
        const state = result.state || {};
        return { ok: true, text: `${result.note}\n${materialsText(workbench.sources(), state.mounts, state.derived)}`, state };
      }
      if (action === 'repair') {
        const result = await workbench.repairMounts();
        if (!result.ok) return { ok: false, error: result.error, text: `修复失败：${result.error}` };
        const fixed = (result.fixed || []).filter((row) => row.ok);
        const failed = (result.fixed || []).filter((row) => !row.ok);
        const lines = [`重连 ${fixed.length} 条`];
        if (failed.length) lines.push(`仍有 ${failed.length} 条没修好：${failed.map((row) => `${row.as}（${row.error}）`).join('；')}`);
        return { ok: true, text: lines.join('\n'), fixed: result.fixed };
      }
      return { ok: false, text: `不认识的 action：${action}（list|add|remove|mount|unmount|repair）` };
    },
  }));

  register(defineTool({
    name: 'data_analysis_vision',
    description:
      '扫描件识图：把审计判为 image_only 的 PDF 与图片交给多模态模型转写成文本，产物挂回 data/ 作为可直读材料。'
      + 'action=plan 看待识别清单（不花 token）；run 开始识别（默认后台跑，limit 是本次最多识别多少页、pages 只跑指定页如 1-20）；'
      + 'status 看进度；verify 人工核对后打勾。识图文本未经人工核对时，数字溯源闸门只会判「判不了」，不会放行。',
    parameters: {
      action: { type: 'string', required: true, description: 'plan | run | status | verify' },
      limit: { type: 'number', description: 'run：本次最多识别多少「页」，默认 40' },
      pages: { type: 'string', description: 'run：只跑这些页，如 1-20 / 3 / 1,3,5-7；留空=全部页' },
      wait: { type: 'boolean', description: 'run：同步等跑完（小批量试跑用；默认后台）' },
      relPaths: { type: 'string', description: 'verify：要打勾的文件（逗号分隔的相对路径）' },
      all: { type: 'boolean', description: 'verify：把已识别过的全部打勾' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '识图任务已处理') },
    async execute(args) {
      const action = String(args?.action || 'plan');
      if (action === 'plan') {
        const plan = workbench.visionPlan();
        if (!plan.ok) return { ok: false, error: plan.error, text: `无法生成识别清单：${plan.error}` };
        const items = plan.items || [];
        const skipped = plan.skipped || [];
        const lines = [`待识别：${items.length} 份`];
        if (items.length) {
          for (const item of items.slice(0, 10)) lines.push(`  · ${item.relPath}${item.pages ? `（${item.pages} 页）` : ''}`);
          if (items.length > 10) lines.push(`  …另有 ${items.length - 10} 份`);
          lines.push('还没调模型，不花 token；确认后 action=run 再开始。');
        }
        if (skipped.length) {
          lines.push(`跳过 ${skipped.length} 份：`);
          for (const item of skipped.slice(0, 8)) lines.push(`  · ${item.relPath} — ${item.reason}`);
        }
        if (!items.length) lines.push('没有待识别的文件：要么审计还没跑，要么目录里没有扫描件 PDF。');
        return { ok: true, text: lines.join('\n'), items: items.slice(0, 200), skipped: skipped.slice(0, 50), totals: plan.totals };
      }
      if (action === 'run') {
        const result = await workbench.startVision({ limit: args?.limit ?? 40, pages: args?.pages || '', wait: Boolean(args?.wait) });
        if (!result.ok) return { ok: false, error: result.error, text: `识图没能开始：${result.error}` };
        if (result.started) {
          return {
            ok: true,
            started: true,
            text: `已开始（${result.plan.files} 份 / ${result.plan.pages ?? '?'} 页，本次上限 ${result.plan.limit} 页）。${result.note}`,
            plan: result.plan,
          };
        }
        const done = result.state?.donePages ?? 0;
        const failed = result.state?.failedPages ?? 0;
        const cancelled = result.state?.cancelled ? '（中途被停）' : '';
        return {
          ok: true,
          text: `识图完成${cancelled}：${done} 页成功 / ${failed} 页失败，共 ${result.state?.files ?? 0} 份。`
            + '文本已写进派生目录并挂回 data/；记得逐页对照原件后在面板点「标记已核对」。',
          result,
        };
      }
      if (action === 'status') {
        const status = workbench.visionStatus();
        const summary = status.summary || null;
        const lines = [status.running ? '识图：正在跑' : '识图：空闲'];
        if (status.running && status.task) {
          lines.push(`进度 ${status.task.donePages ?? 0}/${status.task.totalPages ?? '?'} 页，正在处理 ${status.task.current || '—'}`);
        }
        if (summary) {
          const files = Array.isArray(summary.files) ? summary.files.length : Number(summary.files) || 0;
          lines.push(`已识别 ${summary.pagesOk ?? 0} 页 / ${files} 份；人工已核 ${summary.pagesVerified ?? 0} 页`);
          if (summary.pagesFailed) lines.push(`失败 ${summary.pagesFailed} 页（看 output/audit/vision_log.csv 的 error 列）`);
        }
        return { ok: true, text: lines.join('\n'), status };
      }
      if (action === 'verify') {
        const result = workbench.verifyVision({ relPaths: splitList(args?.relPaths), all: Boolean(args?.all) });
        if (!result.ok) return { ok: false, error: result.error, text: `打勾失败：${result.error}` };
        return { ok: true, text: `已标记 ${result.changed ?? 0} 页为人工已核。`, result };
      }
      return { ok: false, text: `不认识的 action：${action}（plan|run|status|verify）` };
    },
  }));

  register(defineTool({
    name: 'data_analysis_convert',
    description:
      '旧版 Office（.doc/.xls/.ppt）转码：调用本机桌面 Office 另存为 docx/xlsx/pptx，产物挂回 data/ 后技能就能直读。'
      + 'action=probe 查本机 Office 能不能用；plan 看待转换清单；run 开始转（默认后台）；status 看进度。'
      + 'macOS 上没有这条通道，需要用户在 Office/WPS 里自己另存为新格式。',
    parameters: {
      action: { type: 'string', required: true, description: 'probe | plan | run | status' },
      limit: { type: 'number', description: 'run：本次最多转几个文件，默认 20' },
      wait: { type: 'boolean', description: 'run：同步等跑完（默认后台）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '转码任务已处理') },
    async execute(args) {
      const action = String(args?.action || 'plan');
      if (action === 'probe') {
        const info = await workbench.officeProbe({ force: true });
        return {
          ok: info.ok,
          text: info.ok
            ? `本机 Office 可用：${(info.apps || []).map((app) => app.name).join('、') || [info.word && 'Word', info.excel && 'Excel', info.ppt && 'PowerPoint'].filter(Boolean).join('、')}`
            : [`旧版 Office 转码不可用：${info.error || info.detail || '未知原因'}`, info.hint || ''].filter(Boolean).join('\n'),
          office: info,
        };
      }
      if (action === 'plan') {
        const plan = workbench.convertPlan();
        if (!plan.ok) return { ok: false, error: plan.error, text: `无法生成转码清单：${plan.error}` };
        const items = plan.items || [];
        const lines = [`待转换：${items.length} 份`];
        for (const item of items.slice(0, 10)) lines.push(`  · ${item.relPath} → ${item.targetExt}`);
        if (items.length > 10) lines.push(`  …另有 ${items.length - 10} 份`);
        if (!items.length) lines.push('没有 .doc/.xls/.ppt。');
        return { ok: true, text: lines.join('\n'), items: items.slice(0, 200) };
      }
      if (action === 'run') {
        const result = await workbench.startConvert({ limit: args?.limit ?? 20, wait: Boolean(args?.wait) });
        if (!result.ok) return { ok: false, error: result.error, text: `转码没能开始：${result.error}` };
        if (result.started) return { ok: true, started: true, text: `已开始（${result.plan.files} 份，本次上限 ${result.plan.limit} 份）。${result.note}`, plan: result.plan };
        return {
          ok: true,
          text: `转码完成：${result.state?.done ?? 0} 份成功 / ${result.state?.failed ?? 0} 份失败。`,
          result,
        };
      }
      if (action === 'status') {
        const status = workbench.convertStatus();
        const summary = status.summary || null;
        const lines = [status.running ? '转码：正在跑' : '转码：空闲'];
        if (status.running && status.task) {
          lines.push(`进度 ${status.task.done ?? 0}/${status.task.total ?? '?'} 份，正在处理 ${status.task.current || '—'}`);
        }
        if (summary) {
          lines.push(`累计已转 ${summary.converted ?? 0} 份，失败 ${summary.failed ?? 0} 份`);
          if (summary.lastError) lines.push(`最近一次失败：${summary.lastError}`);
        }
        return { ok: true, text: lines.join('\n'), status };
      }
      return { ok: false, text: `不认识的 action：${action}（probe|plan|run|status）` };
    },
  }));

  register(defineTool({
    name: 'data_analysis_migrate',
    description:
      '把老项目里复制进 data/ 的副本换成材料库的挂载：先逐份 md5 比对源文件，全部一致才允许 apply。'
      + 'apply=false（默认）只比对、不删任何东西，返回 report；有不一致或缺失的会明确列出来，整条停下问用户。',
    parameters: {
      sourceId: { type: 'string', required: true, description: '材料库条目 id' },
      entries: { type: 'string', description: '要比对的目录名（源里的相对路径），逗号或换行分隔；留空=该项目已挂载的全部条目' },
      as: { type: 'string', description: '副本在 data/ 下的目录名，和源里的路径不同名时才用（整目录挂载时也用它定位）' },
      apply: { type: 'boolean', description: 'true 才真的删副本并建联接（必须先跑过一次 apply=false 且 safe=true）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '迁移检查完成') },
    async execute(args) {
      const result = await workbench.migrateSource({
        sourceId: args?.sourceId,
        entries: splitList(args?.entries),
        as: args?.as || '',
        apply: isTrue(args?.apply),
      });
      if (!result.ok) {
        // 不能替它下结论说「未执行」：apply 时副本可能已经删了、只是联接没建成，
        // 两种相反后果都走这个分支，原样透传错误 + 报告让人自己看。
        const removed = (result.report || []).some((item) => item.applied || item.removed);
        return {
          ok: false,
          error: result.error,
          text: `${removed ? '迁移中途失败（副本可能已删）' : '迁移未执行'}：${result.error}`,
          report: result.report,
        };
      }
      const lines = [];
      for (const item of result.report || []) {
        const name = item.as || item.entry || '(根目录)';
        if (item.skipped) {
          lines.push(`· ${name}：${item.skipped === 'already-linked' ? '已经是联接，跳过' : item.skipped}`);
          continue;
        }
        lines.push(`· ${name}：核对 ${item.verified}/${item.totalLocal} 份完全一致${item.onlyInSource ? `，源里另有 ${item.onlyInSource} 份没被复制` : ''}`);
        if (item.mismatched?.length) lines.push(`    内容不一致：${item.mismatched.join('、')}`);
        if (item.missing?.length) lines.push(`    源里找不到：${item.missing.join('、')}`);
      }
      if (result.note) lines.push('', result.note);
      return { ok: true, text: lines.filter(Boolean).join('\n'), safe: result.safe, applied: result.applied, report: result.report, done: result.done };
    },
  }));

  /* ---------------------------- 配置 ---------------------------- */

  register(defineTool({
    name: 'data_analysis_configure',
    description:
      '修改工作台配置（skillRoot / pythonPath / dataDir）。skillRoot 指向 SPSS-Style-Charting-Skill 仓库根或其中的 empirical-research-pipeline 包目录；插件对它是只读的。',
    parameters: {
      skillRoot: { type: 'string', description: '技能包目录' },
      pythonPath: { type: 'string', description: 'python 可执行文件（Windows 默认 python；macOS/Linux 默认 python3）；改了会重新自检' },
      dataDir: { type: 'string', description: '台账目录（留空=按 profile 默认）；改了会换一份项目登记' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已更新配置') },
    async execute(args) {
      const patch = {};
      if (args.skillRoot !== undefined) patch.skillRoot = String(args.skillRoot);
      if (args.pythonPath !== undefined) patch.pythonPath = String(args.pythonPath);
      if (args.dataDir !== undefined) patch.dataDir = String(args.dataDir);
      if (!Object.keys(patch).length) {
        return { ok: false, text: '没有要改的配置项：请至少给 skillRoot / pythonPath / dataDir 之一' };
      }
      // skillRoot 写错会静默变成「skill 不可用」，先在这里挡一下（不存在就直说）
      const root = String(patch.skillRoot || '').trim();
      if (root && !fs.existsSync(root)) {
        return { ok: false, text: `skillRoot 不存在：${root}。请给出 SPSS-Style-Charting-Skill 的仓库根或 empirical-research-pipeline 包目录` };
      }
      const result = await workbench.updateConfig(patch);
      const snap = workbench.snapshot();
      return {
        ok: true,
        text: snap.skill.ok
          ? `配置已更新；skill ${snap.skill.version} 就位（${snap.skill.packageDir}）`
          : `配置已更新，但 skill 仍不可用：${snap.skill.reason}`,
        config: result.config,
        skill: snap.skill,
      };
    },
  }));

  return disposers;
}

export { STATUS_LABEL };
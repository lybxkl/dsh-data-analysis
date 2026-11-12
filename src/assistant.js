/**
 * LLM 桥：把「写东西」这一步接回 DSH 自己的模型选择与 llm 服务。
 *
 * 两条边界，先说清楚：
 *   1. 这里只做「文本起草」——host 读项目里的产物，拼成受控上下文，调 ctx.llm.stream 拿回 Markdown。
 *      模型在这条路上没有工具、跑不了脚本，所以它不会假装跑过任何东西。
 *   2. 「用工具把活干完」那条路是 DSH 会话本身：工作台已经注册了 data_analysis_* 工具，
 *      任何对话里的 agent 都能读产物、跑阶段；data_analysis_draft 只是把起草能力也交给它。
 *
 * 隔离契约不变：只读项目与 skill，唯一会写的是项目自己的 docs/ 下的笔记文件。
 */

import fs from 'node:fs';
import path from 'node:path';

import { isInside } from './skill.js';
import { analysisFile } from './audit.js';
import { recheckSummary } from './recheck.js';

/** 起草任务：每一项对应「人/模型负责」的一步，落点固定在项目 docs/ 下。 */
export const DRAFT_TASKS = [
  {
    id: 'scope',
    stage: 'scope',
    label: '研究范围与口径',
    file: 'docs/scope.md',
    brief: '写研究范围：研究问题、假设、样本与时间口径、纳入排除标准、关键变量与测量、分析策略、交付物清单。',
    need: ['项目骨架', 'docs/scope.md（若有）', 'data/ 文件清单', '审计摘要'],
  },
  {
    id: 'codebook',
    stage: 'coding',
    label: '变量字典与编码规则',
    file: 'docs/codebook.md',
    brief: '写变量字典：每个变量一行（变量名、含义、类型、取值/编码、来源字段、缺失处理、是否进分析）。只写材料里能看到的列。',
    need: ['analysis.csv 表头与样本行', 'docs/scope.md', '编码/审计摘要'],
  },
  {
    id: 'figures',
    stage: 'figures',
    label: '图表题注与解读',
    file: 'docs/figure-notes.md',
    brief: '为清单里的每张图写一条题注（图号、标题、含 N）与 2–3 句解读；N 只能取 manifest 的 n 列。缺 N 的图要明确写「N 未记录」。',
    need: ['chart_pack/chart_manifest.csv', 'docs/scope.md'],
  },
  {
    id: 'manuscript',
    stage: 'manuscript',
    label: '文稿小节',
    file: 'docs/manuscript-notes.md',
    brief: '按实证论文结构写「方法」「结果」小节草稿。每个数字都要来自统计输出，句末用（模型名 · 变量）标注来源；没有出处就不写数字。',
    need: ['output/models 的系数与拟合摘要', '图表清单', 'docs/scope.md'],
  },
  {
    id: 'qa',
    stage: 'qa',
    label: '质检问题说明',
    file: 'docs/qa-notes.md',
    brief: '把终检报告里的问题按 error / warning 分组，逐条说明「是什么、影响什么、怎么处理」；input 类（没得查）单独一节，不要算成数字错误。',
    need: ['output/qa/qa_report.json', 'output/verify/number_issues.csv'],
  },
  {
    id: 'recheck',
    stage: 'recheck',
    label: '复核问题清单',
    file: 'docs/recheck-notes.md',
    brief: '按 12 项复核清单逐项判断：每条问题写 id（RC-001…）、severity（error/warning/info）、where（文件:行 或 阶段）、claim（哪里不成立）、evidence（数字/行号）、fix_kind（edit-text/edit-code/rerun/accept-risk/ask-user）。'
      + '只依据证据包，不要猜；证据不足就写「证据不足，建议人工核对」。最后给一张 12 项覆盖表（R1–R12：checked / unchecked+理由）。',
    need: ['机器复算 12 项', 'analysis.csv 与 dataset.csv 样本', '图表清单与模型摘要', '数字溯源与终检报告'],
  },
];

export const DRAFT_BY_ID = new Map(DRAFT_TASKS.map((task) => [task.id, task]));

const CONTEXT_BUDGET = 14000;
const MAX_TEXT = 200000;

const SYSTEM = [
  '你是实证研究流程里的写作助手，输出中文 Markdown。',
  '规则：只依据给定材料；材料里没有的数字、文献、样本量一律不写，缺什么就写「材料未提供」。',
  '不要声称运行过脚本、不要编造 p 值/系数/N；不要给材料以外的事实。',
  '标题用 ##，列表用 -，表格用 Markdown；篇幅控制在该任务需要的最小长度。',
].join('\n');

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…（已截断，原文 ${value.length} 字符）` : value;
}

function readText(root, rel, limit) {
  try {
    const abs = path.resolve(root, rel);
    if (!isInside(root, abs)) return { ok: false, note: `${rel} 不在项目内` };
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { ok: false, note: `${rel} 不是文件` };
    if (stat.size > 4 * 1024 * 1024) return { ok: false, note: `${rel} 过大（${stat.size} 字节），跳过` };
    return { ok: true, text: clip(fs.readFileSync(abs, 'utf8'), limit) };
  } catch {
    return { ok: false, note: '不存在' };
  }
}

function listFiles(dir, root, depth = 0) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.slice(0, 60)) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (depth < 2) out.push(...listFiles(abs, root, depth + 1));
    } else {
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        size = 0;
      }
      out.push({ rel, size });
    }
  }
  return out;
}

/** 受控上下文：只挑这一步真正需要的产物，每份都有上限。 */
export function buildContext(projectRoot, project, task) {
  const parts = [];
  const missing = [];
  const push = (title, body) => {
    if (!body) return;
    parts.push(`### ${title}\n${body}`);
  };
  const take = (title, rel, limit) => {
    const read = readText(projectRoot, rel, limit);
    if (read.ok && read.text.trim()) push(title, read.text);
    else missing.push(rel);
  };

  const scopeNote = typeof project?.scope === 'string'
    ? project.scope
    : project?.scope && typeof project.scope.note === 'string'
      ? project.scope.note
      : '';
  push('项目', [
    `名称：${project?.name || path.basename(projectRoot)}`,
    `目录：${projectRoot}`,
    scopeNote ? `范围备注：${scopeNote}` : '',
    project?.createdAt ? `建立时间：${project.createdAt}` : '',
  ].filter(Boolean).join('\n'));

  const files = listFiles(path.join(projectRoot, 'data'), projectRoot).slice(0, 40);
  push('data/ 文件清单', files.length ? files.map((f) => `${f.rel}（${f.size} 字节）`).join('\n') : '空');

  const analysisTarget = analysisFile(projectRoot);
  const header = readText(projectRoot, analysisTarget.rel, 1200);
  if (header.ok) push('analysis.csv 开头', header.text);
  else missing.push(analysisTarget.rel);

  take('研究范围 docs/scope.md', 'docs/scope.md', 4000);

  if (task.id === 'figures' || task.id === 'manuscript') {
    take('图表清单 chart_manifest.csv', 'output/chart_pack/chart_manifest.csv', 3500);
    const figs = listFiles(path.join(projectRoot, 'output/chart_pack/figures'), projectRoot).slice(0, 40);
    if (figs.length) push('图文件', figs.map((f) => `${f.rel}（${f.size} 字节）`).join('\n'));
    else missing.push('output/chart_pack/figures');
  }
  if (task.id === 'manuscript' || task.id === 'qa') {
    for (const name of ['fit_ols.csv', 'fit_logit.csv', 'coef_ols.csv', 'coef_logit.csv']) {
      take(`模型输出 ${name}`, `output/models/${name}`, 2500);
    }
    take('变量描述 descriptives.csv', 'output/models/descriptives.csv', 2000);
  }
  if (task.id === 'qa') {
    take('终检报告', 'output/qa/qa_report.json', 5000);
    take('数字溯源 number_issues.csv', 'output/verify/number_issues.csv', 2500);
  }
  if (task.id === 'recheck') {
    const state = recheckSummary(projectRoot, { project, runs: [] });
    push('机器复算（12 项）', state.checks
      .map((item) => `${item.id} [${item.status}] ${item.label}：${item.detail}${item.evidence ? `\n  证据：${String(item.evidence).split('\n').slice(0, 6).join(' | ')}` : ''}`)
      .join('\n'));
    if (state.issues.length) {
      push('已有问题清单', state.issues.slice(0, 40)
        .map((issue) => `${issue.id} [${issue.severity}/${issue.status}] ${issue.where}：${issue.claim}`)
        .join('\n'));
    }
    take('图表清单 chart_manifest.csv', 'output/chart_pack/chart_manifest.csv', 3000);
    take('变量描述 descriptives.csv', 'output/models/descriptives.csv', 2000);
    take('终检报告', 'output/qa/qa_report.json', 3000);
    take('数字溯源 number_issues.csv', 'output/verify/number_issues.csv', 3000);
    const scripts = listFiles(path.join(projectRoot, 'scripts'), projectRoot).slice(0, 20);
    push('项目脚本', scripts.length ? scripts.map((item) => item.rel).join('\n') : '（项目没有自己的脚本）');
  }
  if (task.id === 'codebook') {
    take('编码清单 coding_sheet.csv', 'output/coding/coding_sheet.csv', 2500);
  }
  take('审计摘要', 'output/audit/corpus_summary.json', 2000);

  let context = parts.join('\n\n');
  if (context.length > CONTEXT_BUDGET) context = `${context.slice(0, CONTEXT_BUDGET)}\n…（上下文已截断）`;
  return { context, missing: [...new Set(missing)] };
}

function normalizeRoute(config, defaultSelection) {
  if (config?.modelMode === 'custom') {
    const provider = String(config.modelProvider || '').trim();
    const model = String(config.modelId || '').trim();
    if (provider && model) return { provider, model, source: 'custom' };
    return { provider: '', model: '', source: 'custom', error: '自定义模型没选完整（provider/model 都必填）' };
  }
  const provider = String(defaultSelection?.provider || '').trim();
  const model = String(defaultSelection?.model || '').trim();
  if (provider && model) {
    return { provider, model, source: 'follow', reasoningEffort: defaultSelection?.reasoningEffort };
  }
  return { provider: '', model: '', source: 'follow', error: 'DSH 还没有默认模型选择：先在宿主里选一个模型，或在设置里自定义' };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)),
  ]);
}

export class Assistant {
  constructor({ getConfig, getActive, llm, agentDefaultModel, attachments, logger }) {
    this.getConfig = getConfig;
    this.getActive = getActive;
    this.llm = llm || null;
    this.agentDefaultModel = agentDefaultModel || null;
    this.attachments = attachments || null;
    this.logger = logger;
    this.modelCache = { at: 0, value: null };
  }

  available() {
    if (!this.llm?.stream) return { ok: false, reason: '宿主没有 llm 服务，无法调用模型' };
    return { ok: true };
  }

  route() {
    const config = this.getConfig();
    let selection = null;
    try {
      selection = this.agentDefaultModel?.currentSelection?.() || null;
    } catch {
      selection = null;
    }
    return normalizeRoute(config, selection);
  }

  /** 供设置弹窗选模型：provider 列表 + 各自模型；默认路由单独回。 */
  async models({ force = false } = {}) {
    const gate = this.available();
    if (!gate.ok) return { ok: false, error: gate.reason, providers: [], default: null };
    const now = Date.now();
    if (!force && this.modelCache.value && now - this.modelCache.at < 5 * 60 * 1000) {
      return { ...this.modelCache.value, route: this.route() };
    }
    const providers = [];
    let listError = '';
    try {
      const raw = this.llm.listProviders?.() || [];
      for (const provider of raw.slice(0, 20)) {
        let models = [];
        try {
          const found = await withTimeout(this.llm.listModels(provider.id), 4000, `${provider.id} 模型列表`);
          models = (found || []).slice(0, 80).map((item) => ({ id: item.id, name: item.name || item.id }));
        } catch (error) {
          listError = listError || `${provider.id}：${error?.message || error}`;
        }
        providers.push({ id: provider.id, name: provider.name || provider.id, models });
      }
    } catch (error) {
      listError = String(error?.message || error);
    }
    const value = { ok: true, providers, default: this.route(), error: listError };
    this.modelCache = { at: now, value };
    return value;
  }

  resolveProject() {
    const active = this.getActive?.();
    if (!active?.ok) return { ok: false, error: active?.error || '还没有打开项目' };
    return active;
  }

  /**
   * 这条路由能不能看图。返回 modality：image（公布支持）/ unknown（没公布）/ text（明确只收文本）。
   * 不能看图时**明确报错**，绝不把图片悄悄换成占位文本再当成识别完了。
   */
  async imageCapability() {
    const gate = this.available();
    if (!gate.ok) return { ok: false, error: gate.reason };
    const route = this.route();
    if (route.error) return { ok: false, error: route.error };
    if (!this.attachments?.admitPromptContent) {
      return { ok: false, provider: route.provider, model: route.model, error: '宿主没有附件服务（attachments），无法把图片交给模型' };
    }
    let info = null;
    if (typeof this.llm.resolveModelInfo === 'function') {
      try {
        info = await withTimeout(this.llm.resolveModelInfo(route.provider, route.model), 8000, '模型能力查询');
      } catch {
        info = null;
      }
    }
    const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : null;
    if (modalities && !modalities.includes('image')) {
      return {
        ok: false,
        provider: route.provider,
        model: route.model,
        modality: 'text',
        modalities,
        error: `${route.provider}/${route.model} 只接受文本输入，不能识图。请在设置里换一个支持图片的模型（自定义模型选一个多模态的），而不是让工作台把扫描件当成「没有内容」。`,
      };
    }
    return {
      ok: true,
      provider: route.provider,
      model: route.model,
      modality: modalities ? 'image' : 'unknown',
      modalities: modalities || [],
      note: modalities ? '' : '模型没有公布输入模态，按支持图片尝试；一旦宿主把它换成占位文本，这里会报错停下',
    };
  }

  /** 把一页图交给模型看，拿回转写文本。 */
  async seeImage({ bytes, mediaType = 'image/png', prompt, signal, sessionId, maxTokens } = {}) {
    const gate = this.available();
    if (!gate.ok) return { ok: false, fatal: true, error: gate.reason };
    const route = this.route();
    if (route.error) return { ok: false, fatal: true, error: route.error };
    if (!this.attachments?.admitPromptContent) {
      return { ok: false, fatal: true, error: '宿主没有附件服务（attachments），无法把图片交给模型' };
    }
    const content = String(prompt || '');
    if (!content.trim()) return { ok: false, fatal: true, error: '没有给识别提示词' };

    let admitted = null;
    try {
      admitted = await this.attachments.admitPromptContent([
        { type: 'image', mediaType, data: Buffer.from(bytes).toString('base64') },
        { type: 'text', text: content },
      ]);
    } catch (error) {
      return { ok: false, fatal: true, error: `图片没能交给宿主：${error?.message || error}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    if (signal) {
      try {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
      } catch {
        /* ignore */
      }
    }

    const startedAt = Date.now();
    let text = '';
    let usage = null;
    try {
      const stream = this.llm.stream({
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        messages: [{ role: 'user', content: admitted.map((part) => (part.type === 'image' ? { type: 'image', attachment: part.attachment } : part)) }],
        temperature: 0.1,
        maxTokens: Number(maxTokens) || 2400,
        sessionId: sessionId || 'data-analysis-vision',
        purpose: 'data-analysis-vision',
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'usage') usage = chunk.usage;
        else if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            const failure = chunk.reason.failure || {};
            throw new Error(`模型调用${chunk.reason.kind === 'aborted' ? '被中止' : '失败'}：${failure.code || ''} ${failure.message || ''}`.trim());
          }
        }
      }
    } catch (error) {
      return {
        ok: false,
        fatal: true,
        error: String(error?.message || error),
        provider: route.provider,
        model: route.model,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }

    // 宿主对纯文本模型的降级是「把图片换成一行占位文本」。这条要当场拦下，不能当成识别结果。
    if (/image omitted because this model accepts text only/i.test(text)) {
      return {
        ok: false,
        fatal: true,
        provider: route.provider,
        model: route.model,
        error: `${route.provider}/${route.model} 把图片替换成了占位文本（说明它只支持文本输入），本次识别作废。请换一个多模态模型。`,
      };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, fatal: false, provider: route.provider, model: route.model, error: '模型没有返回文本（可能只有推理内容）' };
    }
    const total = Number(
      usage?.totalTokens ?? usage?.total ?? (Number(usage?.inputTokens || 0) + Number(usage?.outputTokens || 0)),
    ) || 0;
    return {
      ok: true,
      text: clip(trimmed, MAX_TEXT),
      provider: route.provider,
      model: route.model,
      tokens: total,
      usage,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async draft({ taskId, instruction = '', signal } = {}) {
    const gate = this.available();
    if (!gate.ok) return { ok: false, error: gate.reason };
    const task = DRAFT_BY_ID.get(String(taskId || ''));
    if (!task) return { ok: false, error: `未知任务：${taskId}` };

    const route = this.route();
    if (route.error) return { ok: false, error: route.error, route };

    const active = this.resolveProject();
    if (!active.ok) return { ok: false, error: active.error };

    const { context, missing } = buildContext(active.path, active.project, task);
    const wants = [
      `任务：${task.label}`,
      task.brief,
      `落点：${task.file}（由用户在面板里确认后才写入）`,
      instruction ? `用户补充要求：${instruction}` : '',
      `材料未提供：${missing.length ? missing.join('、') : '无'}`,
    ].filter(Boolean).join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    if (signal) {
      try {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      } catch {
        /* ignore */
      }
    }

    const startedAt = Date.now();
    let text = '';
    let reasoning = 0;
    let usage = null;
    let finish = null;
    try {
      const stream = this.llm.stream({
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        system: SYSTEM,
        messages: [
          { role: 'user', content: [{ type: 'text', text: `${wants}\n\n## 可用材料\n${context}` }] },
        ],
        temperature: 0.3,
        maxTokens: Number(this.getConfig().assistantMaxTokens) || 1800,
        // 有的 provider（如 opencode）按会话路由，缺 sessionId 会直接 400；
        // 起草不是宿主对话，给一个稳定的合成 id 即可，不写进任何会话历史。
        sessionId: `data-analysis-draft-${active.id || 'project'}`,
        purpose: 'data-analysis-draft',
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'reasoning-delta') reasoning += 1;
        else if (chunk.type === 'usage') usage = chunk.usage;
        else if (chunk.type === 'finish') {
          finish = chunk.reason;
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            const failure = chunk.reason.failure || {};
            throw new Error(`模型调用${chunk.reason.kind === 'aborted' ? '被中止' : '失败'}：${failure.code || ''} ${failure.message || ''}`.trim());
          }
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error),
        provider: route.provider,
        model: route.model,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }

    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: '模型没有返回文本（可能只有推理内容）', provider: route.provider, model: route.model };
    return {
      ok: true,
      task: task.id,
      label: task.label,
      file: task.file,
      text: clip(trimmed, MAX_TEXT),
      provider: route.provider,
      model: route.model,
      routeSource: route.source,
      usage,
      reasoningChunks: reasoning,
      finish: finish ? finish.kind : '',
      elapsedMs: Date.now() - startedAt,
      missing,
    };
  }

  /** 只允许写回该任务固定的 docs/ 落点；不覆盖非本插件生成的文件除非用户明确点了写入。 */
  save({ taskId, text } = {}) {
    const task = DRAFT_BY_ID.get(String(taskId || ''));
    if (!task) return { ok: false, error: `未知任务：${taskId}` };
    const body = String(text || '');
    if (!body.trim()) return { ok: false, error: '没有内容可写' };
    const active = this.resolveProject();
    if (!active.ok) return { ok: false, error: active.error };

    const abs = path.resolve(active.path, task.file);
    if (!isInside(active.path, abs)) return { ok: false, error: '落点不在项目内，拒绝写入' };
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const header = `<!-- 由实证研究工作台起草（${new Date().toISOString().slice(0, 19).replace('T', ' ')}），请人工核对后使用 -->\n\n`;
      const tmp = `${abs}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, header + body, 'utf8');
      fs.renameSync(tmp, abs);
      return { ok: true, file: task.file, bytes: Buffer.byteLength(body, 'utf8') };
    } catch (error) {
      return { ok: false, error: `写入失败：${error?.message || error}` };
    }
  }

  invalidate() {
    this.modelCache = { at: 0, value: null };
  }
}

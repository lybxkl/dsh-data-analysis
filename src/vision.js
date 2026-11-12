/**
 * 识图通道：扫描件与图片没有文字层，OCR 是另一套重工程；这里直接用多模态模型看页面并转写。
 *
 * 三条硬口径：
 *   1. **不偷偷降级**：模型不支持图片就报错停下，绝不让宿主把图片换成占位文本再当成「识别完了」。
 *   2. **每一页都留痕**：input_sha256（渲染后的页图）、provider/model、prompt 版本、产物路径、令牌数、
 *      是否人工核验，全写进 output/audit/vision_log.csv。没有 sha256 的识别结果不可复核。
 *   3. **没核验 ≠ 通过**：human_verified 默认 false；识别稿被引用而没人核验时，闸门只能是 unjudged。
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { readCsv } from './audit.js';
import { DEFAULT_PYTHON } from './defaults.js';
import { IS_WINDOWS, killChildTree, removeTree } from './platform.js';
import {
  derivedFile,
  derivedMountName,
  derivedRoot,
  isJunk,
  toCsv,
  walkFiles,
  writeFileAtomic,
} from './sources.js';

export const PROMPT_VERSION = 'vision-v1';

export const VISION_PROMPT = [
  '你是裁判文书识别员。下面是一份扫描件的单独一页，可能歪斜、有印章、有水印、有手写批注。',
  '任务：把这页上的全部印刷文字逐段转写出来，保持原有的段落与顺序。',
  '规则：',
  '1. 不要总结、不要改写、不要润色，不要补全看不清的字。',
  '2. 看不清的字用 ▢ 代替；连续看不清的一段用 ▢▢… 表示。',
  '3. 印章、手写批注、页眉页码各另起一行，分别用【印章】【手写】【页眉】开头。',
  '4. 只输出转写结果本身，不要任何前言、解释或「以下是」之类的话。',
  '5. 如果整页没有任何可辨认文字，只输出一行：【空白页】。',
].join('\n');

export const LOG_FIELDS = [
  'rel_path', 'page', 'input_sha256', 'model', 'prompt_version', 'at', 'tokens',
  'status', 'human_verified', 'derived_rel', 'error',
];

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = path.join(MODULE_DIR, '..', 'assets', 'render_pages.py');

export function visionLogPath(projectRoot) {
  return path.join(path.resolve(projectRoot), 'output', 'audit', 'vision_log.csv');
}

export function readVisionLog(projectRoot) {
  const parsed = readCsv(visionLogPath(projectRoot));
  if (!parsed) return [];
  return parsed.rows.map((row) => ({
    rel_path: row.rel_path || '',
    page: Number(row.page) || 0,
    input_sha256: row.input_sha256 || '',
    model: row.model || '',
    prompt_version: row.prompt_version || '',
    at: row.at || '',
    tokens: Number(row.tokens) || 0,
    status: row.status || '',
    human_verified: String(row.human_verified || '').toLowerCase() === 'true',
    derived_rel: row.derived_rel || '',
    error: row.error || '',
  }));
}

function logKey(relPath, page) {
  return `${relPath}#${page}`;
}

export function logIndex(rows) {
  const map = new Map();
  for (const row of rows) map.set(logKey(row.rel_path, row.page), row);
  return map;
}

function appendLog(projectRoot, records) {
  if (!records.length) return;
  const file = visionLogPath(projectRoot);
  const existing = readCsv(file);
  const rows = existing ? existing.rows : [];
  for (const record of records) {
    const next = {};
    for (const key of LOG_FIELDS) next[key] = record[key] === undefined ? '' : record[key];
    rows.push(next);
  }
  writeFileAtomic(file, toCsv(LOG_FIELDS, rows));
}

/** 识图摘要：给闸门与面板用。 */
export function visionSummary(projectRoot) {
  const rows = readVisionLog(projectRoot);
  let ok = 0;
  let failed = 0;
  let verified = 0;
  const files = new Set();
  const unverifiedFiles = new Set();
  for (const row of rows) {
    files.add(row.rel_path);
    if (row.status === 'ok') ok += 1;
    else failed += 1;
    if (row.human_verified) verified += 1;
    else unverifiedFiles.add(row.rel_path);
  }
  return {
    file: visionLogPath(projectRoot),
    exists: fs.existsSync(visionLogPath(projectRoot)),
    rows: rows.length,
    pagesOk: ok,
    pagesFailed: failed,
    pagesVerified: verified,
    files: files.size,
    unverifiedFiles: unverifiedFiles.size,
  };
}

/* ------------------------------ Python 渲染 ------------------------------ */

let jobSeq = 0;

/** 渲染/转码失败时给一句能照做的建议，而不是把 Python 的原始报错直接甩给用户。 */
function renderHint(message) {
  const text = String(message || '').trim() || '渲染失败';
  if (/heic|heif/i.test(text)) {
    return IS_WINDOWS
      ? `${text} —— HEIC 需要 pillow-heif（pip install pillow-heif），或在「照片」里另存为 JPG 后重新登记`
      : `${text} —— 用「预览」把 HEIC 导出为 PNG/JPG 再登记，或 pip install pillow-heif`;
  }
  if (/cannot identify image|unidentifiedimage|not a supported/i.test(text)) {
    return `${text} —— 这个图片格式 Python 读不了，转成 PNG/JPG 再登记`;
  }
  if (/encrypted|password/i.test(text)) {
    return `${text} —— PDF 有密码：先在阅读器里去掉加密再登记`;
  }
  if (/ENAMETOOLONG|path too long|too long/i.test(text)) {
    return `${text} —— 路径太长：把台账目录（dataDir）或材料目录挪到更浅的位置，Windows 还可以开启长路径支持`;
  }
  return text;
}

function runPython(pythonPath, job, workDir, { timeoutMs = 600000, signal } = {}) {
  const command = String(pythonPath || '').trim() || (IS_WINDOWS ? 'python' : 'python3');
  return new Promise((resolve) => {
    const stem = `job-${Date.now()}-${jobSeq++}`;
    const jobFile = path.join(workDir, `${stem}.json`);
    const resultFile = path.join(workDir, `${stem}.result.json`);
    try {
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');
    } catch (error) {
      resolve({ ok: false, error: `准备渲染任务失败：${error?.message || error}`, items: [] });
      return;
    }
    const child = spawn(command, [RENDER_SCRIPT, '--job', jobFile, '--result', resultFile], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      stderr += decoder.write(chunk);
      if (stderr.length > 40000) stderr = stderr.slice(-40000);
    });
    const cleanup = () => {
      for (const file of [jobFile, resultFile]) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
    };
    // 没有超时的子进程会把整个识图任务挂死：`state.running` 永远是 true，
    // 之后每次点「开始」都被拒，只能重启插件。宁可报错也不能这样卡住。
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      cleanup();
      resolve({ ...payload, stderr: stderr.trim() });
    };
    const onAbort = () => {
      killChildTree(child);
      finish({ ok: false, error: '识图已取消', items: [] });
    };
    const timer = setTimeout(() => {
      killChildTree(child);
      finish({ ok: false, error: `渲染超时（${Math.round(timeoutMs / 1000)} 秒）：文件可能太大或损坏，可以先单独试一页`, items: [] });
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (error) => {
      const code = error?.code;
      const hint = code === 'ENOENT'
        ? (IS_WINDOWS
          ? `找不到 Python 命令「${command}」：在设置里改成可执行的 python.exe`
          : `找不到 Python 命令「${command}」：macOS 上通常要写 python3`)
        : String(error?.message || error);
      finish({ ok: false, error: hint, items: [] });
    });
    child.on('close', () => {
      if (settled) return;
      stderr += decoder.end();
      let payload = null;
      try {
        payload = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      } catch (error) {
        payload = { ok: false, error: `渲染脚本没有产出结果：${stderr.trim() || error?.message || error}`, items: [] };
      }
      finish(payload);
    });
  });
}

/* ------------------------------ 计划 ------------------------------ */

const IMAGE_KINDS = new Set(['image']);

function firstSegment(relPath) {
  return String(relPath || '').split('/')[0] || '';
}

function relWithoutMount(relPath) {
  const parts = String(relPath || '').split('/');
  parts.shift();
  return parts.join('/');
}

/**
 * 从哪里看出「这一份要识图」：审计的 corpus_files.csv 里 status=image_only。
 * 口径与技能一致（带 logo 但有文字层的 PDF 不会被误判成 image_only）。
 */
export function readAuditRows(projectRoot) {
  const file = path.join(path.resolve(projectRoot), 'output', 'audit', 'corpus_files.csv');
  const parsed = readCsv(file);
  if (!parsed) return null;
  return { file, rows: parsed.rows };
}

function recount(items, failedPages) {
  const totals = { files: items.length, pages: 0, todoFiles: 0, todoPages: 0, doneFiles: 0, failedPages: failedPages || 0 };
  for (const item of items) {
    totals.pages += item.pages || 0;
    const remaining = item.pagesKnown ? Math.max(0, (item.pages || 1) - item.donePages.length) : 1;
    if (remaining > 0) {
      totals.todoFiles += 1;
      if (item.pagesKnown) totals.todoPages += remaining;
    } else {
      totals.doneFiles += 1;
    }
  }
  return totals;
}

export function buildPlan({ projectRoot, materials, sources, cacheDir }) {
  const audit = readAuditRows(projectRoot);
  const byId = new Map((sources || []).map((item) => [item.id, item]));
  const mountsByName = new Map((materials?.mounts || []).map((mount) => [mount.as, mount]));
  const log = logIndex(readVisionLog(projectRoot));
  const items = [];
  const skipped = [];

  if (!audit) {
    return {
      ok: false,
      error: '还没有审计产物 output/audit/corpus_files.csv：先跑第 2 阶段「资料审计」，才知道哪些文件需要识图',
      items: [],
      skipped,
      totals: { files: 0, pages: 0, todoFiles: 0, todoPages: 0, doneFiles: 0, failedPages: 0 },
    };
  }

  for (const row of audit.rows) {
    if (row.status !== 'image_only') continue;
    const relPath = row.rel_path || '';
    if (!relPath) continue;
    const mount = mountsByName.get(firstSegment(relPath));
    if (!mount) {
      skipped.push({ relPath, reason: 'not_mounted', detail: '这一份不在挂载的源里（可能是复制进 data/ 的老文件）' });
      continue;
    }
    const source = byId.get(mount.sourceId);
    if (!source) {
      skipped.push({ relPath, reason: 'source_missing', detail: '挂载记录指向的材料源已经不在材料库里' });
      continue;
    }
    const rest = relWithoutMount(relPath);
    const entry = mount.entry || '';
    const pathInSource = entry ? `${entry}/${rest}` : rest;
    const kind = IMAGE_KINDS.has(row.kind) ? 'image' : 'pdf';
    const abs = path.join(path.resolve(projectRoot), 'data', ...relPath.split('/'));
    const pages = kind === 'image' ? 1 : Number(row.pages) || 0;
    const donePages = [];
    for (let page = 1; page <= Math.max(1, pages || 1); page += 1) {
      const record = log.get(logKey(relPath, page));
      if (record && record.status === 'ok') donePages.push(page);
    }
    items.push({
      relPath,
      abs,
      exists: fs.existsSync(abs),
      kind,
      entry,
      sourceId: mount.sourceId,
      sourceLabel: source.label || '',
      mount: mount.as,
      pathInSource,
      pages,
      pagesKnown: kind === 'image' || pages > 0,
      donePages,
      derivedMount: derivedMountName(mount),
      reason: kind === 'image' ? '位图，没有文字层' : '扫描件：没有可用文字层',
    });
  }

  const failedPages = [...log.values()].filter((row) => row.status !== 'ok').length;
  return { ok: true, file: audit.file, items, skipped, totals: recount(items, failedPages), at: new Date().toISOString() };
}

/* ------------------------------ 执行 ------------------------------ */

export class Vision {
  constructor({ getConfig, cacheDir, getCacheDir, logger, assistant }) {
    this.getConfig = getConfig;
    this._cacheDir = cacheDir;
    this.getCacheDir = typeof getCacheDir === 'function' ? getCacheDir : null;
    this.logger = logger;
    this.assistant = assistant;
    this.state = null;
    this.controller = null;
  }

  /** 台账目录可能在运行期被改（dataDir）：每次现取，避免派生稿写到旧位置。 */
  get cacheDir() {
    return this.getCacheDir ? this.getCacheDir() : this._cacheDir;
  }

  workDir() {
    return path.join(path.resolve(this.cacheDir), 'sources-cache', '.jobs');
  }

  /** 进程崩溃/断电时 job-*.json 会留在 .jobs 里：跑之前顺手清掉一天前的（不影响正在用的）。 */
  sweepJobs() {
    const dir = this.workDir();
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of names) {
      if (!/^job-.*\.(json|result\.json)$/.test(name)) continue;
      const abs = path.join(dir, name);
      try {
        if (fs.statSync(abs).mtimeMs >= cutoff) continue;
        fs.unlinkSync(abs);
        removed += 1;
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  status() {
    return this.state ? { ...this.state } : { running: false };
  }

  cancel() {
    if (!this.controller) return { ok: false, error: '没有正在跑的识图任务' };
    try {
      this.controller.abort();
    } catch {
      /* ignore */
    }
    return { ok: true };
  }

  /** 先把总页数数出来（只读 PDF 页数，不调模型、不花钱）。 */
  async countPages(plan, { signal } = {}) {
    const unknown = (plan.items || []).filter((item) => !item.pagesKnown);
    if (!unknown.length) return plan;
    const pythonPath = String(this.getConfig()?.pythonPath || DEFAULT_PYTHON);
    const payload = await runPython(pythonPath, {
      mode: 'count',
      items: unknown.map((item) => ({ id: item.relPath, path: item.abs })),
    }, this.workDir(), { timeoutMs: 120000, signal });
    const found = new Map((payload.items || []).map((item) => [item.id, item]));
    for (const item of plan.items) {
      if (item.pagesKnown) continue;
      const hit = found.get(item.relPath);
      if (hit?.ok) {
        item.pages = Number(hit.pages) || 0;
        item.pagesKnown = true;
      } else {
        item.pagesError = hit?.error || payload.error || '数页失败';
      }
    }
    plan.totals = recount(plan.items, plan.totals?.failedPages || 0);
    return plan;
  }

  /**
   * 真跑：逐份渲染 → 逐页识别 → 落派生文件 → 记账。
   * limit 是本次最多处理「页」数；pageSpec 是页范围（"1-20"），试跑用。
   */
  async run({ projectRoot, plan, limit = 40, pageSpec = '', signal, onTick } = {}) {
    if (this.state?.running) return { ok: false, error: '已经有一个识图任务在跑' };
    // 先看模型通道是否可用；没有 available() 的实现不拦，交给 imageCapability 给准确原因
    if (typeof this.assistant?.available === 'function') {
      const gate = this.assistant.available() || { ok: false, reason: '模型服务不可用' };
      if (!gate.ok) return { ok: false, error: gate.reason };
    }

    const capability = await this.assistant.imageCapability();
    if (!capability.ok) return { ok: false, error: capability.error, capability };

    this.controller = new AbortController();
    if (signal) {
      try {
        signal.addEventListener('abort', () => this.controller.abort(), { once: true });
      } catch {
        /* ignore */
      }
    }

    const pythonPath = String(this.getConfig()?.pythonPath || DEFAULT_PYTHON);
    this.sweepJobs();
    const work = this.workDir();
    const tmpRoot = path.join(work, 'pages');
    const state = {
      running: true,
      startedAt: new Date().toISOString(),
      provider: capability.provider,
      model: capability.model,
      modality: capability.modality,
      totalPages: plan?.totals?.todoPages || 0,
      totalFiles: plan?.totals?.todoFiles || 0,
      donePages: 0,
      failedPages: 0,
      files: 0,
      current: '',
      limit,
      error: '',
      cancelled: false,
    };
    this.state = state;
    const pending = [];
    let budget = Math.max(1, Number(limit) || 40);

    try {
      for (const item of plan.items || []) {
        if (budget <= 0 || this.controller.signal.aborted) break;
        if (!item.exists) {
          state.failedPages += 1;
          pending.push(this.logRow(item, 1, { status: 'error', error: `文件不在了：${item.abs}` }));
          continue;
        }
        if (item.pagesError) {
          // 页数都没数出来（PDF 损坏 / 加密 / 打不开图片），别再去渲染一遍浪费一次子进程
          state.failedPages += 1;
          pending.push(this.logRow(item, 1, { status: 'error', error: item.pagesError }));
          continue;
        }
        const total = item.pagesKnown ? item.pages || 1 : 1;
        const remainingPages = [];
        for (let page = 1; page <= total; page += 1) {
          if (item.donePages.includes(page)) continue;
          if (pageSpec && !matchesSpec(pageSpec, page)) continue;
          remainingPages.push(page);
        }
        if (!remainingPages.length) continue;

        state.current = item.relPath;
        state.files += 1;
        onTick?.({ ...state });

        // 1) 渲染成 PNG（图片直接转码，PDF 逐页渲染）
        let rendered = [];
        if (item.kind === 'image') {
          fs.mkdirSync(tmpRoot, { recursive: true });
          const target = path.join(tmpRoot, `${crypto.randomUUID()}.png`);
          const payload = await runPython(pythonPath, {
            mode: 'image',
            maxEdge: 2400,
            items: [{ id: item.relPath, path: item.abs, out: target }],
          }, work, { timeoutMs: 180000, signal });
          const hit = payload.items?.[0];
          if (!hit?.ok) {
            state.failedPages += 1;
            if (this.controller.signal.aborted) {
              state.cancelled = true;
              pending.push(this.logRow(item, 1, { status: 'error', error: '已取消' }));
              break;
            }
            pending.push(this.logRow(item, 1, { status: 'error', error: renderHint(hit?.error || payload.error || '转码失败') }));
            continue;
          }
          rendered = Array.isArray(hit.images) && hit.images.length
            ? hit.images.map((image) => ({ page: Number(image.page) || 1, file: image.file })).filter((image) => remainingPages.includes(image.page))
            : [{ page: 1, file: hit.file }];
        } else {
          const outDir = path.join(tmpRoot, `${crypto.randomUUID()}`);
          fs.mkdirSync(outDir, { recursive: true });
          const payload = await runPython(pythonPath, {
            mode: 'render',
            dpi: 150,
            maxEdge: 2400,
            outDir,
            items: [{ id: item.relPath, path: item.abs, pages: remainingPages.join(',') }],
          }, work, { timeoutMs: 600000, signal });
          const hit = payload.items?.[0];
          if (!hit?.ok) {
            state.failedPages += 1;
            if (this.controller.signal.aborted) {
              state.cancelled = true;
              pending.push(this.logRow(item, remainingPages[0], { status: 'error', error: '已取消' }));
              break;
            }
            pending.push(this.logRow(item, remainingPages[0], { status: 'error', error: renderHint(hit?.error || payload.error || '渲染失败') }));
            continue;
          }
          rendered = (hit.images || []).map((image) => ({ page: image.page, file: image.file }));
        }
        if (!rendered.length) {
          state.failedPages += 1;
          pending.push(this.logRow(item, remainingPages[0], { status: 'error', error: '这一页没有渲染出图片' }));
          continue;
        }

        // 2) 逐页识别
        for (const page of rendered) {
          if (budget <= 0 || this.controller.signal.aborted) break;
          let bytes = null;
          try {
            bytes = fs.readFileSync(page.file);
          } catch (error) {
            state.failedPages += 1;
            pending.push(this.logRow(item, page.page, { status: 'error', error: `读渲染图失败：${error?.message || error}` }));
            continue;
          }
          const sha = crypto.createHash('sha256').update(bytes).digest('hex');
          const answer = await this.assistant.seeImage({
            bytes,
            mediaType: 'image/png',
            prompt: VISION_PROMPT,
            signal: this.controller.signal,
            sessionId: `data-analysis-vision-${path.basename(path.resolve(projectRoot))}`,
          });
          budget -= 1;
          if (!answer.ok) {
            state.failedPages += 1;
            pending.push(this.logRow(item, page.page, {
              status: 'error',
              sha,
              model: answer.model || capability.model,
              error: answer.error || '识别失败',
            }));
            appendLog(projectRoot, pending.splice(0, pending.length));
            if (answer.fatal) {
              state.error = answer.error || '模型拒绝处理图片';
              throw new Error(state.error);
            }
            continue;
          }
          const suffix = item.kind === 'image' ? '.txt' : `.p${String(page.page).padStart(4, '0')}.txt`;
          const target = derivedFile(this.cacheDir, item.sourceId, item.pathInSource, suffix);
          const header = [
            `# 识别稿 · ${item.relPath}${item.kind === 'pdf' ? ` 第 ${page.page} 页` : ''}`,
            `# 模型 ${answer.provider}/${answer.model} · 提示词 ${PROMPT_VERSION} · 页图 sha256 ${sha}`,
            '# 由实证研究工作台生成，未经人工核验前不得当作原文引用',
            '',
          ].join('\n');
          try {
            writeFileAtomic(target, `${header}${answer.text.trim()}\n`);
          } catch (error) {
            // 写不进派生目录（路径超长 / 没权限 / 磁盘满）不该让整批停下：记一行错误，接着处理下一页
            state.failedPages += 1;
            pending.push(this.logRow(item, page.page, {
              status: 'error',
              sha,
              model: answer.model || capability.model,
              error: renderHint(`写不进派生目录：${error?.message || error}`),
            }));
            appendLog(projectRoot, pending.splice(0, pending.length));
            continue;
          }
          state.donePages += 1;
          pending.push(this.logRow(item, page.page, {
            status: 'ok',
            sha,
            model: answer.model || capability.model,
            tokens: answer.tokens || 0,
            derived_rel: derivedRelPath(item, suffix),
          }));
          appendLog(projectRoot, pending.splice(0, pending.length));
          onTick?.({ ...state });
          try {
            fs.unlinkSync(page.file);
          } catch {
            /* ignore */
          }
        }
        if (pageSpec) break;
      }
    } catch (error) {
      state.error = state.error || String(error?.message || error);
      state.cancelled = this.controller.signal.aborted;
    } finally {
      if (pending.length) appendLog(projectRoot, pending.splice(0, pending.length));
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.current = '';
      this.controller = null;
      // 页图是中间产物（已在派生稿里留了 sha256），跑完就删；中断时也不留垃圾
      await removeTree(tmpRoot);
    }
    return { ok: !state.error, state: this.status() };
  }

  logRow(item, page, extra = {}) {
    return {
      rel_path: item.relPath,
      page,
      input_sha256: extra.sha || '',
      model: extra.model || this.state?.model || '',
      prompt_version: PROMPT_VERSION,
      at: new Date().toISOString(),
      tokens: extra.tokens || 0,
      status: extra.status || 'ok',
      human_verified: false,
      derived_rel: extra.derived_rel || '',
      error: extra.error || '',
    };
  }
}

/** 派生稿在「识别稿挂载点」里的相对路径。 */
function derivedRelPath(item, suffix) {
  const prefix = item.entry ? `${item.entry}/` : '';
  const base = prefix && item.pathInSource.startsWith(prefix)
    ? item.pathInSource.slice(prefix.length)
    : item.pathInSource;
  return `${item.derivedMount}/${base}${suffix}`;
}

function matchesSpec(spec, page) {
  const text = String(spec || '').trim();
  if (!text) return true;
  for (const chunk of text.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [left, right] = part.split('-');
      const start = Number(left) || 1;
      const end = Number(right) || Number.MAX_SAFE_INTEGER;
      if (page >= start && page <= end) return true;
    } else if (Number(part) === page) {
      return true;
    }
  }
  return false;
}

/** 人工核验：把某几份（或全部）识别稿标成 verified。 */
export function markVerified(projectRoot, { relPaths = [], all = false } = {}) {
  const rows = readVisionLog(projectRoot);
  if (!rows.length) return { ok: false, error: '还没有识别记录' };
  const wanted = new Set(relPaths.map(String));
  let changed = 0;
  const next = rows.map((row) => {
    if (row.human_verified || row.status !== 'ok') return row;
    if (!all && !wanted.has(row.rel_path)) return row;
    changed += 1;
    return { ...row, human_verified: true };
  });
  if (!changed) return { ok: true, changed: 0 };
  writeFileAtomic(visionLogPath(projectRoot), toCsv(LOG_FIELDS, next.map((row) => ({
    ...row,
    human_verified: row.human_verified ? 'true' : 'false',
  }))));
  return { ok: true, changed };
}

/** 派生稿已经产出的文件清单（给挂载与闸门看）。 */
export function derivedInventory(materials, sources, cacheDir) {
  const byId = new Map((sources || []).map((item) => [item.id, item]));
  const out = [];
  for (const mount of materials?.mounts || []) {
    const source = byId.get(mount.sourceId);
    if (!source) continue;
    const root = mount.entry
      ? path.join(derivedRoot(cacheDir, mount.sourceId), ...String(mount.entry).split('/'))
      : derivedRoot(cacheDir, mount.sourceId);
    if (!fs.existsSync(root)) continue;
    const walked = walkFiles(root, { maxFiles: 40000 });
    const files = walked.files.filter((file) => !isJunk(file.name));
    if (!files.length) continue;
    out.push({
      mount: mount.as,
      mountName: derivedMountName(mount),
      sourceId: mount.sourceId,
      target: root,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
      sample: files.slice(0, 5).map((file) => file.rel),
    });
  }
  return out;
}

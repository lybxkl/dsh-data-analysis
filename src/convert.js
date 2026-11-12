/**
 * 桌面转换通道：.doc / .xls / .ppt 是老二进制格式，技能不抽文本（kind_of → legacy_office）。
 *
 * 做法：用**用户桌面上已经装好的** Office，把它另存为 OOXML（docx/xlsx/pptx），落到派生目录，
 * 原件一个字节都不动（转换前先拷到临时目录，避免 Word 在用户的材料目录里留下 ~$ 锁文件）。
 *
 * Mac 上没有这条路：明确告诉用户自己另存为 docx/xlsx 后重新登记，而不是假装转过了。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCsv } from './audit.js';
import { derivedFile, toCsv, writeFileAtomic } from './sources.js';
import { IS_WINDOWS, removeTree, runPowerShell } from './platform.js';

export const CONVERT_LOG_FIELDS = [
  'rel_path', 'from_ext', 'to_ext', 'engine', 'at', 'status', 'derived_rel', 'bytes', 'error',
];

const TARGET = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };
const KIND_ENGINE = { doc: 'word', xls: 'excel', ppt: 'ppt' };

export function convertTargetExt(ext) {
  return TARGET[String(ext || '').toLowerCase()] || '';
}

export function convertLogPath(projectRoot) {
  return path.join(path.resolve(projectRoot), 'output', 'audit', 'convert_log.csv');
}

export function readConvertLog(projectRoot) {
  const parsed = readCsv(convertLogPath(projectRoot));
  if (!parsed) return [];
  return parsed.rows.map((row) => ({
    rel_path: row.rel_path || '',
    from_ext: row.from_ext || '',
    to_ext: row.to_ext || '',
    engine: row.engine || '',
    at: row.at || '',
    status: row.status || '',
    derived_rel: row.derived_rel || '',
    bytes: Number(row.bytes) || 0,
    error: row.error || '',
  }));
}

function appendConvertLog(projectRoot, records) {
  if (!records.length) return;
  const file = convertLogPath(projectRoot);
  const existing = readCsv(file);
  const rows = existing ? existing.rows : [];
  for (const record of records) {
    const next = {};
    for (const key of CONVERT_LOG_FIELDS) next[key] = record[key] === undefined ? '' : record[key];
    rows.push(next);
  }
  writeFileAtomic(file, toCsv(CONVERT_LOG_FIELDS, rows));
}

export function convertSummary(projectRoot) {
  const rows = readConvertLog(projectRoot);
  const ok = rows.filter((row) => row.status === 'ok');
  const failed = rows.filter((row) => row.status !== 'ok');
  return {
    file: convertLogPath(projectRoot),
    exists: fs.existsSync(convertLogPath(projectRoot)),
    rows: rows.length,
    converted: ok.length,
    failed: failed.length,
    files: new Set(ok.map((row) => row.rel_path)).size,
    lastError: failed.length ? failed[failed.length - 1].error : '',
  };
}

/* ------------------------------ 能力探测 ------------------------------ */

let officeCache = { at: 0, value: null };

export async function probeOffice({ force = false } = {}) {
  if (!IS_WINDOWS) {
    const detail = '不是 Windows：没有桌面 Office 可调用，请自己另存为 docx/xlsx/pptx 后重新登记';
    return {
      ok: false,
      platform: process.platform,
      word: false,
      excel: false,
      ppt: false,
      error: detail,
      detail,
      hint: process.platform === 'darwin'
        ? 'Mac 上打开原文件 → 文件 → 另存为 → 选择 .docx / .xlsx / .pptx，放回原目录即可重新登记'
        : 'Linux 上可用 LibreOffice 命令行批量转：soffice --headless --convert-to docx 文件.doc',
    };
  }
  if (!force && officeCache.value && Date.now() - officeCache.at < 5 * 60 * 1000) {
    return officeCache.value;
  }
  const script = `
$out = @{ word = $false; excel = $false; ppt = $false; detail = '' }
foreach ($name in @('Word.Application','Excel.Application','PowerPoint.Application')) {
  $proc = @{ 'Word.Application' = 'WINWORD'; 'Excel.Application' = 'EXCEL'; 'PowerPoint.Application' = 'POWERPNT' }[$name]
  # 用户已经开着这个程序时，New-Object 拿到的是用户那个实例：探测完不能 Quit，也不能藏起来
  $existing = @(Get-Process $proc -ErrorAction SilentlyContinue).Count -gt 0
  try {
    $app = New-Object -ComObject $name
    if (-not $existing) { try { $app.Visible = $false } catch {} }
    if (-not $existing) { try { $app.Quit() } catch {} }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
    switch ($name) {
      'Word.Application' { $out.word = $true }
      'Excel.Application' { $out.excel = $true }
      'PowerPoint.Application' { $out.ppt = $true }
    }
  } catch {
    if ($out.detail -eq '') { $out.detail = $name + ': ' + $_.Exception.Message }
  }
}
$out | ConvertTo-Json -Compress
`;
  const run = await runPowerShell(script, { timeoutMs: 60000 });
  let parsed = null;
  try {
    parsed = JSON.parse(String(run.stdout || '').trim());
  } catch {
    parsed = null;
  }
  const value = {
    ok: Boolean(parsed && (parsed.word || parsed.excel || parsed.ppt)),
    platform: process.platform,
    word: Boolean(parsed?.word),
    excel: Boolean(parsed?.excel),
    ppt: Boolean(parsed?.ppt),
    detail: parsed?.detail || (run.ok ? '' : (run.stderr || '探测 Office 失败').trim()),
    hint: '如果这里没探测到 Office：装了 WPS 也行，但需要它注册了 Word.Application；'
      + '实在转不了的，可以装 dsh-computer-use-win，让模型直接在桌面上打开文档另存为。',
  };
  value.error = value.ok ? '' : (value.detail || '没有探测到可用的 Office（Word / Excel / PowerPoint）');
  officeCache = { at: Date.now(), value };
  return value;
}

/* ------------------------------ 转换 ------------------------------ */

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * PowerShell 的报错要洗净：成功时也可能把进度记录以 CLIXML 形式塞进 stderr，
 * 失败时真正的 'ERR: ...' 在 stdout 里。这里优先取 ERR 行，其次取像样的 stderr。
 */
function cleanPsMessage(run) {
  const stdout = String(run?.stdout || '');
  const errLine = stdout.split(/\r?\n/).find((line) => line.trim().startsWith('ERR:'));
  if (errLine) return errLine.replace(/^\s*ERR:\s*/, '').trim();
  const stderr = String(run?.stderr || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .filter((line) => !/^#<\s*CLIXML/.test(line) && !/^<Objs |<\/Objs>|^<Obj |^<\/Obj>/.test(line.trim()))
    .join('\n')
    .trim();
  if (stderr) return stderr;
  if (run?.code === null) return 'Office 转换超时';
  return '转换失败：Office 没有产出文件';
}

/**
 * 转换脚本。关键点：Word/Excel/PowerPoint 的自动化服务器是**单实例**的——
 * 用户已经开着 Word 时，`New-Object -ComObject Word.Application` 拿到的是用户那个实例，
 * 顺手 `Quit(0)` 会把用户正在编辑的文档一起关掉（且不保存）。所以先看进程在不在，
 * 已有实例时只操作自己的 Document，绝不 Quit、也不去改它的 Visible。
 */
function buildScript(engine, tmpIn, done) {
  const head = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'`;
  const tail = `
} catch {
  Write-Output ('ERR: ' + $_.Exception.Message)
  exit 1
}`;
  if (engine === 'word') {
    return `${head}
$existing = @(Get-Process WINWORD -ErrorAction SilentlyContinue).Count -gt 0
$app = $null
try {
  $app = New-Object -ComObject Word.Application
  if (-not $existing) { $app.Visible = $false }
  $app.DisplayAlerts = 0
  $doc = $app.Documents.Open(${psQuote(tmpIn)}, $false, $false)
  $doc.SaveAs2(${psQuote(done)}, 16)
  $doc.Close(0)
  Write-Output 'OK'
${tail} finally {
  # COM 的 Quit 在 PowerShell 里要 [ref]，直接写 Quit(0) 会抛 PSReference 错误且 Word 不会退出（临时目录被攥住）
  if ($app -and -not $existing) { try { $app.Quit([ref]0) } catch { try { $app.Quit() } catch {} } }
}
`;
  }
  if (engine === 'excel') {
    return `${head}
$existing = @(Get-Process EXCEL -ErrorAction SilentlyContinue).Count -gt 0
$app = $null
try {
  $app = New-Object -ComObject Excel.Application
  if (-not $existing) { $app.Visible = $false }
  $app.DisplayAlerts = $false
  $wb = $app.Workbooks.Open(${psQuote(tmpIn)}, 0, $false)
  $wb.SaveAs(${psQuote(done)}, 51)
  $wb.Close($false)
  Write-Output 'OK'
${tail} finally {
  if ($app -and -not $existing) { try { $app.Quit() } catch {} }
}
`;
  }
  return `${head}
$existing = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$app = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $pres = $app.Presentations.Open(${psQuote(tmpIn)}, $true, $false, $false)
  $pres.SaveAs(${psQuote(done)}, 24)
  $pres.Close()
  Write-Output 'OK'
${tail} finally {
  if ($app -and -not $existing) { try { $app.Quit() } catch {} }
}
`;
}

/** 单个文件转换。kind 取 doc/xls/ppt。 */
export async function convertOne({ sourceFile, outFile, kind }) {
  const engine = KIND_ENGINE[kind];
  if (!engine) return { ok: false, error: `不支持的格式：${kind}` };
  if (!IS_WINDOWS) return { ok: false, error: '不是 Windows，无法调用桌面 Office（请自己另存为 docx/xlsx/pptx 后重新登记）' };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // 先拷到临时目录再转：Word 会在文档旁边写 ~$ 锁文件，不能让它写进用户的材料目录
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'da-convert-'));
  const warnings = [];
  try {
    const tmpIn = path.join(tmpDir, path.basename(sourceFile));
    try {
      fs.copyFileSync(sourceFile, tmpIn);
    } catch (error) {
      return { ok: false, error: `复制到临时目录失败：${error?.message || error}` };
    }

    const done = path.join(tmpDir, `out.${convertTargetExt(kind)}`);
    const script = buildScript(engine, tmpIn, done);
    const run = await runPowerShell(script, { timeoutMs: 180000 });
    if (run.timeout) {
      return { ok: false, error: 'Office 转换超时（进程已结束）；这份文件可能太大或损坏' };
    }
    // 退不退出码不作判据（Windows PowerShell 5.1 正常结束也可能返回 1），但「产物是不是
    // 一个完整的 OOXML」必须验：超时/被中断时 Word 可能已经写出一个几 KB 的残缺 docx。
    const check = inspectOoxml(done);
    if (!check.ok) {
      const message = check.reason === 'missing' ? cleanPsMessage(run) : check.reason;
      return { ok: false, error: message };
    }
    try {
      fs.copyFileSync(done, outFile);
    } catch (error) {
      return { ok: false, error: `写出派生文件失败：${error?.message || error}` };
    }
    let written = check.bytes;
    try {
      written = fs.statSync(outFile).size;
    } catch {
      written = check.bytes;
    }
    return {
      ok: true,
      engine,
      out: outFile,
      bytes: written,
      detail: 'Office 另存为',
      warnings,
    };
  } finally {
    const removal = await removeTree(tmpDir);
    if (!removal.ok) warnings.push(`临时目录没删掉：${tmpDir}（${removal.error}）`);
  }
}

/** 产物是不是完整的 OOXML：zip 魔数 + 非空。只看「文件存在且非 0 字节」会把半截文件当成功。 */
function inspectOoxml(file) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, reason: 'missing', bytes: 0 };
  }
  if (!stat.isFile() || !stat.size) return { ok: false, reason: 'missing', bytes: 0 };
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      if (head.toString('latin1') !== 'PK\u0003\u0004') {
        return { ok: false, reason: 'Office 写出的文件不是 OOXML（可能被中断或另存为失败）', bytes: stat.size };
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { ok: false, reason: `读不了转换产物：${error?.message || error}`, bytes: stat.size };
  }
  return { ok: true, bytes: stat.size };
}

/* ------------------------------ 计划与执行 ------------------------------ */

export function buildConvertPlan({ projectRoot, materials, sources, cacheDir }) {
  const file = path.join(path.resolve(projectRoot), 'output', 'audit', 'corpus_files.csv');
  const parsed = readCsv(file);
  const byId = new Map((sources || []).map((item) => [item.id, item]));
  const mountsByName = new Map((materials?.mounts || []).map((mount) => [mount.as, mount]));
  const log = new Set(readConvertLog(projectRoot).filter((row) => row.status === 'ok').map((row) => row.rel_path));
  if (!parsed) {
    return {
      ok: false,
      error: '还没有审计产物 output/audit/corpus_files.csv：先跑第 2 阶段「资料审计」',
      items: [],
      skipped: [],
      totals: { files: 0, todo: 0, done: 0 },
    };
  }
  const items = [];
  const skipped = [];
  for (const row of parsed.rows) {
    if (row.kind !== 'legacy_office') continue;
    const relPath = row.rel_path || '';
    if (!relPath) continue;
    const mount = mountsByName.get(String(relPath).split('/')[0]);
    if (!mount) {
      skipped.push({ relPath, reason: 'not_mounted', detail: '不在挂载的源里' });
      continue;
    }
    const source = byId.get(mount.sourceId);
    if (!source) {
      skipped.push({ relPath, reason: 'source_missing', detail: '材料源已不在材料库里' });
      continue;
    }
    const rest = String(relPath).split('/').slice(1).join('/');
    const entry = mount.entry || '';
    const pathInSource = entry ? `${entry}/${rest}` : rest;
    const ext = String(row.ext || '').toLowerCase();
    const target = convertTargetExt(ext);
    if (!target) {
      skipped.push({ relPath, reason: 'no_target', detail: `不知道怎么转 .${ext}` });
      continue;
    }
    items.push({
      relPath,
      abs: path.join(path.resolve(projectRoot), 'data', ...relPath.split('/')),
      ext,
      targetExt: target,
      kind: ext,
      entry,
      mount: mount.as,
      sourceId: mount.sourceId,
      sourceLabel: source.label || '',
      pathInSource,
      done: log.has(relPath),
      derivedMount: `${mount.as}__识别稿`,
    });
  }
  const todo = items.filter((item) => !item.done).length;
  return { ok: true, file, items, skipped, totals: { files: items.length, todo, done: items.length - todo } };
}

export class Converter {
  constructor({ getConfig, cacheDir, getCacheDir, logger }) {
    this.getConfig = getConfig;
    this._cacheDir = cacheDir;
    this.getCacheDir = typeof getCacheDir === 'function' ? getCacheDir : null;
    this.logger = logger;
    this.state = null;
    this.aborted = false;
  }

  /** 台账目录可能在运行期被改（dataDir）：每次现取。 */
  get cacheDir() {
    return this.getCacheDir ? this.getCacheDir() : this._cacheDir;
  }

  status() {
    return this.state ? { ...this.state } : { running: false };
  }

  /** 停止：正在转的那一份会写完再停（Office 另存一半就被杀掉会留下坏文件）。 */
  cancel() {
    if (!this.state?.running) return { ok: false, error: '没有正在跑的转换任务' };
    this.aborted = true;
    this.state.cancelling = true;
    return { ok: true };
  }

  /** 一份一份转；失败不中断（每份都单独记账）。 */
  async run({ projectRoot, plan, limit = 20, onTick } = {}) {
    if (this.state?.running) return { ok: false, error: '已经有一个转换任务在跑' };
    this.aborted = false;
    const office = await probeOffice();
    const state = {
      running: true,
      startedAt: new Date().toISOString(),
      total: Math.min(plan?.totals?.todo || 0, limit),
      done: 0,
      failed: 0,
      current: '',
      limit,
      office: { word: office.word, excel: office.excel, ppt: office.ppt },
      error: '',
    };
    this.state = state;
    const pending = [];
    let budget = Math.max(1, Number(limit) || 20);
    try {
      for (const item of plan.items || []) {
        if (this.aborted) break;
        if (budget <= 0 || item.done) continue;
        state.current = item.relPath;
        onTick?.({ ...state });
        if (!fs.existsSync(item.abs)) {
          state.failed += 1;
          budget -= 1;
          pending.push(this.row(item, { status: 'error', error: `文件不在了：${item.abs}` }));
          appendConvertLog(projectRoot, pending.splice(0, pending.length));
          continue;
        }
        const engineReady = item.kind === 'doc' ? office.word : item.kind === 'xls' ? office.excel : office.ppt;
        if (!office.ok || !engineReady) {
          state.failed += 1;
          budget -= 1;
          pending.push(this.row(item, {
            status: 'error',
            error: `桌面 Office 里没有可用的 ${item.kind === 'doc' ? 'Word' : item.kind === 'xls' ? 'Excel' : 'PowerPoint'}`,
          }));
          appendConvertLog(projectRoot, pending.splice(0, pending.length));
          continue;
        }
        const suffix = `.${item.targetExt}`;
        const base = item.pathInSource.slice(0, item.pathInSource.length - item.ext.length - 1);
        const out = derivedFile(this.cacheDir, item.sourceId, base, suffix);
        const result = await convertOne({ sourceFile: item.abs, outFile: out, kind: item.kind });
        budget -= 1;
        if (result.ok) state.done += 1;
        else state.failed += 1;
        if (result.warnings?.length) {
          // 临时目录没删掉这类问题不改变「这份转好了」，但必须留痕，否则 %TEMP% 会越积越多
          for (const line of result.warnings) this.logger?.warn?.(`[data-analysis] 转码：${line}`);
        }
        pending.push(this.row(item, result.ok
          ? { status: 'ok', derived_rel: derivedRel(item, suffix), bytes: result.bytes }
          : { status: 'error', error: result.error }));
        appendConvertLog(projectRoot, pending.splice(0, pending.length));
        onTick?.({ ...state });
      }
    } catch (error) {
      state.error = String(error?.message || error);
    } finally {
      if (pending.length) appendConvertLog(projectRoot, pending.splice(0, pending.length));
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.current = '';
    }
    return { ok: !state.error, state: this.status() };
  }

  row(item, extra = {}) {
    return {
      rel_path: item.relPath,
      from_ext: item.ext,
      to_ext: item.targetExt,
      engine: KIND_ENGINE[item.kind] || '',
      at: new Date().toISOString(),
      status: extra.status || 'ok',
      derived_rel: extra.derived_rel || '',
      bytes: extra.bytes || 0,
      error: extra.error || '',
    };
  }
}

function derivedRel(item, suffix) {
  const prefix = item.entry ? `${item.entry}/` : '';
  const base = prefix && item.pathInSource.startsWith(prefix)
    ? item.pathInSource.slice(prefix.length)
    : item.pathInSource;
  return `${item.derivedMount}/${base.slice(0, base.length - item.ext.length - 1)}${suffix}`;
}

/** 给面板用：哪些文件能转、转了没有。 */
export function convertDigest(plan) {
  if (!plan?.ok) return { ok: false, error: plan?.error || '无法规划转换' };
  return {
    ok: true,
    files: plan.totals.files,
    todo: plan.totals.todo,
    done: plan.totals.done,
    skipped: plan.skipped.length,
  };
}


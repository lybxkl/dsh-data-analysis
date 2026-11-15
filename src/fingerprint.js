/**
 * 内容指纹：把「文件变了没有」从「大小相同就算没变」升级成「内容哈希相同」。
 *
 * 为什么单独一个模块：
 *   - 审计新鲜度（gates.js）与全格复核新鲜度（research.js）都要校验原件内容；
 *   - /state 每 2–8 秒扫一次产物，不能每次把整个语料重新哈希一遍。
 *
 * 设计：
 *   - 只读、同步（闸门判定是同步的），按 1MB 分块读，避免把大 PDF 整个读进内存；
 *   - 缓存键是「路径 + size + mtime + 算法」：文件没动就只花一次 stat；
 *   - 任何读不了/超限都返回 `{ ok:false, reason }`，由调用方判 unjudged——
 *     不许把「算不了」当成「没变」。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const CACHE_MAX = 4096;
const CHUNK = 1024 * 1024;
/** 单个文件超过 2GB 不哈希：PDF/CSV 研究资料极少到这个量级，硬算会把面板拖死。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** 一次校验最多哈希 5000 个文件 / 2GB：超了就如实说「没核完」，不装通过。 */
export const MAX_BATCH_FILES = 5000;
export const MAX_BATCH_BYTES = 2 * 1024 * 1024 * 1024;

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { at: Date.now(), value });
}

export function clearDigestCache() {
  cache.clear();
}

/** 同步哈希一个文件；返回 `{ ok, hash, size, mtimeMs, reason }`。 */
export function digestFile(file, algo = 'sha256') {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    return { ok: false, hash: '', size: 0, mtimeMs: 0, reason: error?.code === 'ENOENT' ? 'missing' : 'stat-failed' };
  }
  if (!stat.isFile()) return { ok: false, hash: '', size: stat.size, mtimeMs: stat.mtimeMs, reason: 'not-a-file' };
  if (stat.size > MAX_FILE_BYTES) {
    return { ok: false, hash: '', size: stat.size, mtimeMs: stat.mtimeMs, reason: 'too-large' };
  }
  const key = `${algo}|${file}|${stat.size}|${stat.mtimeMs}`;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };

  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const hash = crypto.createHash(algo);
    const buffer = Buffer.allocUnsafe(CHUNK);
    let read = 0;
    for (;;) {
      read = fs.readSync(fd, buffer, 0, CHUNK, null);
      if (!read) break;
      hash.update(read === CHUNK ? buffer : buffer.subarray(0, read));
    }
    const value = { ok: true, hash: hash.digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs, reason: '' };
    cacheSet(key, value);
    return value;
  } catch (error) {
    return { ok: false, hash: '', size: stat.size, mtimeMs: stat.mtimeMs, reason: error?.code || 'read-failed' };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关不掉也不该让闸门抛异常 */
      }
    }
  }
}

export function md5File(file) {
  return digestFile(file, 'md5');
}

/**
 * 已经知道 size/mtime 时的取指纹：先查缓存，命中就一次 stat 都不做。
 *
 * 新鲜度核对要为审计账里每一行算 md5，而这一行的 size/mtime 刚由目录清单
 * （corpusCurrentSignature 的 inventory）扫出来——再 stat 一次纯属重复劳动。
 * 清单与账之间的差异仍按清单判定；真需要读文件时 digestFile 会自己 stat 一次，
 * 把真实 mtime 写进缓存键，不会把两次扫描之间的改动缓存成「没变」。
 */
export function digestFileKnown(file, { size = 0, mtimeMs = 0 } = {}, algo = 'sha256') {
  const key = `${algo}|${file}|${size}|${mtimeMs}`;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };
  return digestFile(file, algo);
}

export function sha256File(file) {
  return digestFile(file, 'sha256');
}

/** 面板/提示里用短路径：项目内给相对路径，项目外只给文件名，避免泄露主机目录结构。 */
export function displayPath(file, root) {
  const abs = String(file || '');
  if (!abs) return '';
  const base = String(root || '');
  if (base) {
    const rel = pathRelative(base, abs);
    if (rel && !rel.startsWith('..') && !isAbsoluteLike(rel)) return rel.replace(/\\/g, '/');
  }
  const parts = abs.replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

function isAbsoluteLike(value) {
  return /^([A-Za-z]:|\/)/.test(String(value || ''));
}

function pathRelative(base, target) {
  const normalize = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const from = normalize(base);
  const to = normalize(target);
  if (!from) return to;
  const caseSensitive = process.platform !== 'win32';
  const a = caseSensitive ? from : from.toLowerCase();
  const b = caseSensitive ? to : to.toLowerCase();
  if (a === b) return '';
  if (!b.startsWith(`${a}/`)) return to;
  return to.slice(from.length + 1);
}

/** 审计账里「可哈希」的状态：与 audit_corpus.py 的负面清单保持一致。 */
const UNHASHABLE_STATUS = new Set(['metadata', 'hidden', 'quarantined', 'zero_byte', 'unreadable', 'unsupported']);

/**
 * 用审计账（corpus_files.csv 的行）核对当前语料。
 *
 * 返回：
 *   { ok, checked, changed:[rel], missing:[rel], extra:[rel], opaque:[rel], skipped, reason }
 * - changed：大小或 md5 变了（同大小不同内容也能抓到，因为比的是 md5）；
 * - opaque：账上应有 md5 却没有（--no-hash / 读不了），这些格子判不了；
 * - skipped：语料超过批量上限，没逐文件核。
 */
export function verifyAuditRows(root, rows, inventory) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && (row.rel_path || row.relpath));
  if (!list.length) return { ok: false, checked: 0, changed: [], missing: [], extra: [], opaque: [], skipped: false, reason: 'empty-audit' };
  if (inventory?.truncated) return { ok: false, checked: 0, changed: [], missing: [], extra: [], opaque: [], skipped: true, reason: 'inventory-truncated' };
  if (list.length > MAX_BATCH_FILES) return { ok: false, checked: 0, changed: [], missing: [], extra: [], opaque: [], skipped: true, reason: 'too-many-files' };

  const current = inventory?.inventory instanceof Map ? inventory.inventory : new Map();
  const expected = new Set();
  let bytes = 0;
  for (const row of list) bytes += Number(row.bytes) || 0;
  if (bytes > MAX_BATCH_BYTES) return { ok: false, checked: 0, changed: [], missing: [], extra: [], opaque: [], skipped: true, reason: 'too-many-bytes' };

  const changed = [];
  const missing = [];
  const opaque = [];
  const extra = [];
  let checked = 0;
  let unhashed = 0;

  for (const row of list) {
    const rel = String(row.rel_path || row.relpath || '').replace(/\\/g, '/').trim();
    if (!rel) continue;
    expected.add(rel);
    const now = current.get(rel);
    if (!now) {
      missing.push(rel);
      continue;
    }
    const auditBytes = Number(row.bytes);
    if (Number.isFinite(auditBytes) && Number(now.bytes) !== auditBytes) {
      changed.push(rel);
      continue;
    }
    const recorded = String(row.md5 || '').trim().toLowerCase();
    const status = String(row.status || '').trim().toLowerCase();
    if (recorded) {
      // 用本次盘点里的 size/mtime 查缓存：命中就不必再 stat 一次（热路径少约 3000 次 stat）。
      // 代价说清楚：inventory 自身有 5 秒 TTL（见 CORPUS_SCAN_TTL），文件若在这 5 秒里变了，
      // 本轮仍按旧 size/mtime 命中旧哈希，和账上的 md5 比出来是「没变」——下一轮重扫必定抓到。
      // 这样换的是「新鲜度最多晚一轮（≤5s + 一次轮询）」，换来每次 /state 不用逐文件重核。
      // 清单上的 md5 仍然逐行真比对，判不了的文件仍然算 opaque，不会当成一致。
      const got = digestFileKnown(now.abs || '', { size: now.bytes, mtimeMs: now.mtimeMs }, 'md5');
      if (!got.ok) {
        opaque.push(rel);
        continue;
      }
      checked += 1;
      if (got.hash !== recorded) changed.push(rel);
      continue;
    }
    if (UNHASHABLE_STATUS.has(status)) {
      // 元数据/隐藏/0 字节/不可读：审计本来就不哈希，只比大小（它们也不进分析样本）
      checked += 1;
      unhashed += 1;
      continue;
    }
    // 可读文件却没有 md5：审计用了 --no-hash，或当时哈希失败 → 内容判不了
    opaque.push(rel);
  }

  for (const rel of current.keys()) {
    if (!expected.has(rel)) extra.push(rel);
  }

  const ok = !changed.length && !missing.length && !extra.length && !opaque.length;
  if (!checked) {
    // 一份都没核到内容：不能因为「没有不同」就说「一致」。
    return { ok: false, checked: 0, unhashed, changed, missing, extra, opaque, skipped: false, reason: 'checked-nothing' };
  }
  return { ok, checked, unhashed, changed, missing, extra, opaque, skipped: false, reason: '' };
}

/**
 * 核对 verification_snapshot.json 的 bindings（path → sha256）。
 * 这是 skill 自己的定义：prepare 时绑定 registry/数据集/codebook/provenance/原始资料/脚本，
 * 任一文件内容变化都必须让 final 失效。插件不重算 skill 的 digest，只逐项核对绑定。
 */
export function verifyBindings(bindings, { root = '', maxFiles = MAX_BATCH_FILES, maxBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  const entries = bindings && typeof bindings === 'object' ? Object.entries(bindings) : [];
  if (!entries.length) return { ok: false, checked: 0, total: 0, stale: [], skipped: false, reason: 'no-bindings' };
  if (entries.length > maxFiles) return { ok: false, checked: 0, total: entries.length, stale: [], skipped: true, reason: 'too-many-files' };

  let bytes = 0;
  for (const [file] of entries) {
    try {
      bytes += fs.statSync(file).size;
    } catch {
      /* 缺失留给下面逐项报 */
    }
    if (bytes > maxBytes) return { ok: false, checked: 0, total: entries.length, stale: [], skipped: true, reason: 'too-many-bytes' };
  }

  const stale = [];
  let checked = 0;
  for (const [file, expected] of entries) {
    const want = String(expected || '').trim().toLowerCase();
    if (!want) {
      stale.push({ path: displayPath(file, root), reason: 'no-recorded-hash' });
      continue;
    }
    const got = sha256File(file);
    if (!got.ok) {
      stale.push({ path: displayPath(file, root), reason: got.reason || 'unreadable' });
      continue;
    }
    checked += 1;
    if (got.hash !== want) stale.push({ path: displayPath(file, root), reason: 'content-changed' });
  }
  return { ok: !stale.length, checked, total: entries.length, stale, skipped: false, reason: '' };
}

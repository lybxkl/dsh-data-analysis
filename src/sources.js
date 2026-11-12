/**
 * 材料库（sources）：用户的资料放在哪儿，工作台只记地址，不搬家。
 *
 * 三条边界，先说清楚：
 *   1. 材料库是**全局一份**，存在台账里（与 projects 同级）。项目只存引用，不复制材料；
 *      解挂不等于删库，删库前要查引用。
 *   2. 挂载靠目录联接（junction）：`<项目>/data/安徽` → `F:\...\刑事pdf\安徽`。
 *      技能脚本的 `--root data` 一行不用改，os.walk 会正常下钻。
 *   3. 登记回执必须能对上账：直读 / 识图 / 待转换 / 不支持，四类相加 = 目录里的文件数
 *      （系统文件单列，不混进这四个数）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  IS_WINDOWS,
  createDirLink,
  isLink,
  linkTarget,
  mirrorDir,
  readMountMarker,
  removeDirLink,
  removeMirror,
  samePath,
} from './platform.js';

/* ------------------------------ 扩展名分类 ------------------------------ */
// 必须与技能 scripts/text_extract.py 的分组保持一致，否则「工作台说能读、技能读不出来」。

export const EXT_GROUPS = {
  text: new Set(['txt', 'text', 'md', 'markdown', 'rst', 'tex', 'log',
    'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'rtf']),
  pdf: new Set(['pdf']),
  docx: new Set(['docx', 'docm']),
  odt: new Set(['odt']),
  pptx: new Set(['pptx', 'pptm']),
  sheet: new Set(['xlsx', 'xlsm']),
  html: new Set(['html', 'htm', 'xhtml']),
  image: new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif', 'heic']),
  media: new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm']),
  archive: new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']),
  legacy: new Set(['doc', 'xls', 'ppt']),
};

/**
 * 通道：read=直读、vision=识图、convert=待转换（doc/xls/ppt，交给会话或用户去转，工作台不代做）、
 * none=不支持（mhtml/压缩包/音视频等）。这里只是分类标签，不等于「工作台会处理」。
 */
export const CHANNEL_LABEL = {
  read: '直读',
  vision: '识图',
  convert: '待转换',
  none: '不支持',
  junk: '系统文件',
};

const KIND_CHANNEL = {
  text: 'read',
  pdf: 'read',
  docx: 'read',
  odt: 'read',
  pptx: 'read',
  sheet: 'read',
  html: 'read',
  image: 'vision',
  legacy: 'convert',
  media: 'none',
  archive: 'none',
  unknown: 'none',
};

const JUNK_NAMES = new Set(['thumbs.db', 'desktop.ini', 'ehthumbs.db', '.ds_store']);

export function extOf(filePath) {
  const base = path.basename(String(filePath || ''));
  const index = base.lastIndexOf('.');
  if (index <= 0 || index === base.length - 1) return '';
  return base.slice(index + 1).toLowerCase();
}

/** 与技能 kind_of() 同口径。 */
export function kindOf(filePath) {
  const ext = extOf(filePath);
  for (const [kind, list] of Object.entries(EXT_GROUPS)) {
    if (list.has(ext)) return kind;
  }
  return 'unknown';
}

export function channelOfKind(kind) {
  return KIND_CHANNEL[kind] || 'none';
}

export function channelOf(filePath) {
  return channelOfKind(kindOf(filePath));
}

/** 系统文件：不参与任何通道计数，单列。 */
export function isJunk(name) {
  const base = String(name || '');
  if (!base) return true;
  if (base.startsWith('.')) return true;
  if (base.startsWith('~$')) return true;
  return JUNK_NAMES.has(base.toLowerCase());
}

/** 技能里 image_only 的判定只对「有图但没字的 PDF」成立，这里给一句话解释口径。 */
export const VISION_NOTE = '扫描件 PDF 要等审计跑完才知道（有文字层的按直读处理，不会误判）。';

export function emptyChannels() {
  return { read: 0, vision: 0, convert: 0, none: 0, junk: 0 };
}

/* ------------------------------ 通用工具 ------------------------------ */

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

export function safeAlias(input, fallback = '材料') {
  const raw = String(input || '').trim();
  let cleaned = raw
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .replace(/^\.+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Windows 会把结尾的点和空格默默吃掉，导致「登记的名字」和「真实的目录名」对不上
  cleaned = cleaned.replace(/[. ]+$/, '');
  // Windows 保留设备名（CON/NUL/COM1…）不能当目录名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) cleaned = `${cleaned}_`;
  return cleaned.slice(0, 40).trim() || fallback;
}

export function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

export function isInside(root, abs) {
  const base = path.resolve(root);
  const target = path.resolve(abs);
  if (target === base) return true;
  const rel = path.relative(base, target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function hashFile(filePath) {
  const digest = crypto.createHash('md5');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) digest.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest('hex');
}

/**
 * 遍历目录。不跟随「指向外部的链接目录」以外的花活，但会下钻源里真实存在的子目录。
 * 返回 { files:[{rel,abs,name,size,top,depth}], errors, truncated }。
 */
export function walkFiles(root, { maxFiles = 80000, maxDepth = 16 } = {}) {
  const out = { files: [], errors: [], truncated: false };
  const stack = [{ dir: path.resolve(root), depth: 0, top: '' }];
  const seenDirs = new Set();
  while (stack.length) {
    if (out.files.length >= maxFiles) {
      out.truncated = true;
      break;
    }
    const { dir, depth, top } = stack.pop();
    // 源里可能有指回上层的链接：按真实路径去重，避免重复计数和无限递归
    try {
      const real = fs.realpathSync(dir);
      if (seenDirs.has(real)) continue;
      seenDirs.add(real);
    } catch {
      continue;
    }
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      out.errors.push(`${dir}: ${error?.code || String(error)}`);
      continue;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const abs = path.join(dir, item.name);
      const topName = depth === 0 ? item.name : top;
      let isDir = item.isDirectory();
      let isFile = item.isFile();
      if (item.isSymbolicLink()) {
        try {
          const stat = fs.statSync(abs);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (depth < maxDepth) stack.push({ dir: abs, depth: depth + 1, top: topName });
        continue;
      }
      if (!isFile) continue;
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        size = 0;
      }
      out.files.push({
        rel: toRel(root, abs),
        abs,
        name: item.name,
        size,
        top: topName,
        depth,
      });
    }
  }
  return out;
}

/* ------------------------------ 扫描回执 ------------------------------ */

/** 统计一组文件（只认相对路径），返回四通道计数 + 明细。 */
export function summarizeFiles(files, rootLabel = '') {
  const byChannel = emptyChannels();
  const byKind = {};
  const byExt = {};
  let bytes = 0;
  for (const file of files) {
    const name = file.name || path.basename(file.rel);
    if (isJunk(name)) {
      byChannel.junk += 1;
      continue;
    }
    const kind = kindOf(name);
    const channel = channelOfKind(kind);
    byChannel[channel] += 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
    const ext = extOf(name) || '(无扩展名)';
    byExt[ext] = (byExt[ext] || 0) + 1;
    bytes += file.size || 0;
  }
  const total = files.length;
  const accounted = byChannel.read + byChannel.vision + byChannel.convert + byChannel.none + byChannel.junk;
  return { byChannel, byKind, byExt, bytes, total, accounted, root: rootLabel };
}

/** 扫一个源目录：总数、四通道、每个顶层条目各多少。 */
export function scanSourceDir(root, { maxFiles } = {}) {
  const walked = walkFiles(root, { maxFiles });
  const summary = summarizeFiles(walked.files, root);
  const entries = new Map();
  for (const file of walked.files) {
    const name = file.name || path.basename(file.rel);
    const top = file.top || name;
    if (!entries.has(top)) {
      entries.set(top, { name: top, files: 0, bytes: 0, byChannel: emptyChannels() });
    }
    const bucket = entries.get(top);
    bucket.files += 1;
    if (isJunk(name)) {
      bucket.byChannel.junk += 1;
      continue;
    }
    bucket.bytes += file.size || 0;
    bucket.byChannel[channelOfKind(kindOf(name))] += 1;
  }
  const list = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    at: new Date().toISOString(),
    root,
    files: summary.total,
    realFiles: summary.total - summary.byChannel.junk,
    bytes: summary.bytes,
    byChannel: summary.byChannel,
    byKind: summary.byKind,
    byExt: summary.byExt,
    entries: list,
    truncated: walked.truncated,
    errors: walked.errors.slice(0, 20),
  };
}

/** 把回执压成一行人类可读的账，四处相加必须等于总数。 */
export function receiptLine(scan) {
  if (!scan) return '尚未扫描';
  const c = scan.byChannel || emptyChannels();
  const parts = [
    `${CHANNEL_LABEL.read} ${c.read}`,
    `${CHANNEL_LABEL.vision} ${c.vision}`,
    `${CHANNEL_LABEL.convert} ${c.convert}`,
    `${CHANNEL_LABEL.none} ${c.none}`,
  ];
  if (c.junk) parts.push(`${CHANNEL_LABEL.junk} ${c.junk}`);
  return `${scan.files} 个文件（${formatBytes(scan.bytes)}）：${parts.join(' · ')}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ------------------------------ 材料库（台账） ------------------------------ */

export function listSources(store) {
  const list = store.get('sources', []);
  return Array.isArray(list) ? list : [];
}

export function saveSources(store, list) {
  store.set('sources', list);
  store.flushSoon(80);
}

export function findSource(store, id) {
  return listSources(store).find((item) => item.id === id) || null;
}

export function addSource(store, { label, path: rawPath, note = '' } = {}) {
  const raw = String(rawPath || '').trim();
  if (!raw) return { ok: false, error: '请给出材料目录的绝对路径' };
  const abs = path.resolve(raw);
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat) return { ok: false, error: `目录不存在：${abs}` };
  if (!stat.isDirectory()) return { ok: false, error: `不是一个目录：${abs}（单份材料请登记它所在的文件夹，再用 include 精确到那一份）` };
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    real = abs;
  }
  const list = listSources(store);
  const dup = list.find((item) => path.resolve(item.path) === real || path.resolve(item.path) === abs);
  if (dup) return { ok: false, error: `这个目录已经登记过了（${dup.label}）`, source: dup };

  const scan = scanSourceDir(real);
  const source = {
    id: newId('src'),
    label: String(label || '').trim() || path.basename(real) || '材料',
    path: real,
    kind: 'material',
    derivedFrom: '',
    note: String(note || '').trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scan,
  };
  list.push(source);
  saveSources(store, list);
  return { ok: true, source };
}

export function rescanSource(store, id) {
  const list = listSources(store);
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, error: '找不到这个材料源' };
  const source = list[index];
  const scan = scanSourceDir(source.path);
  list[index] = { ...source, scan, updatedAt: new Date().toISOString() };
  saveSources(store, list);
  return { ok: true, source: list[index] };
}

/** 删源前先查引用：任何项目的 mounts 里还有它，就拒绝。 */
export function removeSource(store, id, { projects = [], force = false } = {}) {
  const list = listSources(store);
  const source = list.find((item) => item.id === id);
  if (!source) return { ok: false, error: '找不到这个材料源' };
  const refs = [];
  for (const project of projects) {
    const materials = readMaterials(project.project || project);
    for (const mount of materials.mounts) {
      if (mount.sourceId === id) refs.push({ project: project.path || project.project?.root || '', as: mount.as });
    }
  }
  if (refs.length && !force) {
    return {
      ok: false,
      error: `还有 ${refs.length} 个项目挂着它（${refs.map((item) => item.as).join('、')}），先解挂再删`,
      refs,
    };
  }
  saveSources(store, list.filter((item) => item.id !== id));
  return { ok: true, removed: id };
}

/* ------------------------------ 项目的挂载表 ------------------------------ */

export function readMaterials(project) {
  const raw = project?.materials;
  if (raw && Array.isArray(raw.mounts)) {
    return {
      version: 1,
      mounts: raw.mounts.filter((item) => item && item.as && item.sourceId),
      note: typeof raw.note === 'string' ? raw.note : '',
    };
  }
  return { version: 1, mounts: [], note: '' };
}

export function mountPathOf(projectRoot, mount) {
  return path.join(path.resolve(projectRoot), 'data', mount.as);
}

export function derivedMountName(mount) {
  return `${mount.as}__识别稿`;
}

/**
 * 派生文件 → 原件在 data/ 里的相对路径。
 * 识图稿是 `<原名>.pNNNN.txt`；`<原名>.<docx/xlsx/pptx>` 是更早版本工作台转出来的 OOXML
 * （转换已交给会话/用户，这类文件只会来自旧账，认得出来就记来源，认不出就不写这行）。
 * 对不上形状的返回 null（那就不算派生，宁可不写也不瞎标）。
 */
export function derivedOrigin(mount, relInDerived) {
  const rel = String(relInDerived || '').split(path.sep).join('/');
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const base = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
  const prefix = (name) => `${mount.as}/${dir ? `${dir}/` : ''}${name}`;
  const vision = base.match(/^(.*)\.p(\d{1,6})\.txt$/i);
  if (vision) {
    return { from: prefix(vision[1]), channel: 'vision', page: Number(vision[2]) || 0 };
  }
  const back = { docx: 'doc', xlsx: 'xls', pptx: 'ppt' };
  const ext = extOf(base);
  const originExt = back[ext];
  if (originExt && base.length > ext.length + 1) {
    return { from: prefix(`${base.slice(0, base.length - ext.length - 1)}.${originExt}`), channel: 'convert', page: 0 };
  }
  return null;
}

/** 活看 data/ 下现在有什么：是真目录、还是联接、指向哪儿。 */
export function listDataEntries(projectRoot) {
  const dataDir = path.join(path.resolve(projectRoot), 'data');
  let items = [];
  try {
    items = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    const abs = path.join(dataDir, item.name);
    const link = isLink(abs);
    let isDir = item.isDirectory();
    let size = 0;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      try {
        size = fs.statSync(abs).size;
      } catch {
        size = 0;
      }
    }
    out.push({
      name: item.name,
      abs,
      rel: `data/${item.name}`,
      isLink: link,
      mode: link ? 'junction' : readMountMarker(abs) ? 'mirror' : 'real',
      target: link ? linkTarget(abs) : readMountMarker(abs)?.source || '',
      exists: fs.existsSync(abs),
      isDir,
      bytes: size,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 逐条核对挂载：链接在不在、是不是还指着当初那个目录。 */
export function verifyMounts(projectRoot, materials) {
  return materials.mounts.map((mount) => {
    const abs = mountPathOf(projectRoot, mount);
    const target = String(mount.target || '');
    // mount.target 是源根，entry 是源内相对路径：对外一律给拼好的绝对路径
    const wanted = mount.entry ? path.join(target, ...String(mount.entry).split('/')) : target;
    const link = isLink(abs);
    const actual = link ? linkTarget(abs) : '';
    let status = 'ok';
    let detail = '';
    if (link) {
      if (wanted && !samePath(actual, wanted)) {
        status = 'retargeted';
        detail = `挂载指向 ${actual}，与登记的 ${wanted} 不一致`;
      } else if (!fs.existsSync(wanted)) {
        status = 'missing-target';
        detail = `目标目录不在了：${wanted}`;
      }
      return { ...mount, abs, resolved: wanted, status, detail, actual, mode: 'junction' };
    }

    const marker = readMountMarker(abs);
    if (marker) {
      if (wanted && !samePath(marker.source, wanted)) {
        status = 'retargeted';
        detail = `镜像指向 ${marker.source}，与登记的 ${wanted} 不一致`;
      } else if (!fs.existsSync(wanted)) {
        status = 'missing-target';
        detail = `镜像的来源目录不在了：${wanted}`;
      } else if (marker.kind !== 'mirror') {
        status = 'not-link';
        detail = '这个位置上的标记文件不是工作台写的';
      }
      return { ...mount, abs, resolved: wanted, status, detail, actual: String(marker.source || ''), mode: 'mirror' };
    }

    if (fs.existsSync(abs)) {
      status = 'not-link';
      detail = 'data 下的这个名字是个真实目录，不是工作台建的挂载（可能是老项目复制过来的文件）';
    } else {
      status = 'missing-link';
      detail = '挂载不见了（被手工删掉，或随项目拷到了别的机器）';
    }
    return { ...mount, abs, resolved: wanted, status, detail, actual: '' };
  });
}

/** 挂一个条目。entry 为空串表示「整个源根」。 */
export async function mountOne({ projectRoot, mount }) {
  const abs = mountPathOf(projectRoot, mount);
  const target = mount.entry ? path.join(mount.target, mount.entry) : mount.target;
  if (!fs.existsSync(target)) return { ok: false, error: `材料目录不在了：${target}` };

  if (IS_WINDOWS) {
    const result = await createDirLink(abs, target);
    if (!result.ok) return { ok: false, error: result.already ? `${mount.as} 已经存在（先解挂或换个名字）` : result.error };
    return { ok: true, path: abs, target, mode: 'junction' };
  }

  // POSIX：技能不跟随目录软链，改用「真实目录 + 逐文件软链」的镜像（零复制）
  const run = mirrorDir(target, abs);
  if (!run.ok) return run;
  const warning = run.truncated
    ? `文件太多，只链了前 ${run.files} 个；挂更小的子目录更稳`
    : run.partial
      ? `${run.partial} 个文件没链上（看 repair 的报错）`
      : '';
  return { ok: true, path: abs, target, mode: 'mirror', files: run.files, warning, pruned: run.pruned || 0 };
}

export async function unmountOne({ projectRoot, mount, includeDerived = true }) {
  const removed = [];
  const errors = [];
  const abs = mountPathOf(projectRoot, mount);
  if (isLink(abs)) {
    const run = removeDirLink(abs);
    if (run.ok) removed.push(`data/${mount.as}`);
    else errors.push(`data/${mount.as}: ${run.error}`);
  } else if (readMountMarker(abs)) {
    // 镜像目录（POSIX）：只删工作台自己建的
    const run = await removeMirror(abs);
    if (run.ok) removed.push(`data/${mount.as}`);
    else errors.push(`data/${mount.as}: ${run.error}`);
  } else if (fs.existsSync(abs)) {
    errors.push(`data/${mount.as} 是真实目录（不是联接也不是镜像），工作台不动它`);
  }
  if (includeDerived) {
    const derivedAbs = path.join(path.resolve(projectRoot), 'data', derivedMountName(mount));
    if (isLink(derivedAbs)) {
      const run = removeDirLink(derivedAbs);
      if (run.ok) removed.push(`data/${derivedMountName(mount)}`);
      else errors.push(`data/${derivedMountName(mount)}: ${run.error}`);
    } else if (readMountMarker(derivedAbs)) {
      const run = await removeMirror(derivedAbs);
      if (run.ok) removed.push(`data/${derivedMountName(mount)}`);
      else errors.push(`data/${derivedMountName(mount)}: ${run.error}`);
    }
  }
  return { ok: errors.length === 0, removed, errors };
}

/** 派生材料的落点（按源 id 分开，跨项目复用）。 */
export function derivedRoot(cacheDir, sourceId) {
  return path.join(path.resolve(cacheDir), 'sources-cache', sourceId, 'derived');
}

/** 源内相对路径 → 派生文件绝对路径（保留目录结构，文件名带 .pNNNN 或 .docx）。 */
export function derivedFile(cacheDir, sourceId, pathInSource, suffix) {
  const root = derivedRoot(cacheDir, sourceId);
  const rel = String(pathInSource || '').split('/').filter(Boolean).join(path.sep);
  return path.join(root, `${rel}${suffix}`);
}

/* ------------------------------ 留痕产物 ------------------------------ */

export function materialsDir(projectRoot) {
  return path.join(path.resolve(projectRoot), 'output', 'materials');
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(fields, rows) {
  const lines = [fields.join(',')];
  for (const row of rows) lines.push(fields.map((key) => csvEscape(row[key])).join(','));
  return `${lines.join('\n')}\n`;
}

export function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * 产出挂载清单与来源台账。这是工作台自己的产物，落在 output/materials/，
 * 不碰技能写的 output/audit/。
 */
export function writeProvenance({ projectRoot, materials, sources, cacheDir = '' }) {
  const byId = new Map(sources.map((item) => [item.id, item]));
  const rows = [];
  const mounts = [];
  // 账要能对上审计：审计扫的是 data/ 里真实存在的每个文件，所以这里也以「挂载点」为准，
  // 而不是以源目录为准——两者在 POSIX 上差一个镜像标记文件，在 Windows 上也差隐藏文件。
  const pushWalked = (walkRoot, mountName, target, base) => {
    const walked = fs.existsSync(walkRoot)
      ? walkFiles(walkRoot)
      : { files: [], errors: ['目标不存在'], truncated: false };
    let bytes = 0;
    for (const file of walked.files) {
      const channel = isJunk(file.name) ? 'junk' : channelOf(file.name);
      if (channel !== 'junk') bytes += file.size || 0;
      rows.push({
        ...base,
        rel_path: `${mountName}/${file.rel}`,
        mount: mountName,
        source_path: target,
        bytes: file.size || 0,
        ext: extOf(file.name),
        kind: isJunk(file.name) ? 'junk' : kindOf(file.name),
        channel,
      });
    }
    return { walked, bytes };
  };

  for (const mount of materials.mounts) {
    const source = byId.get(mount.sourceId);
    const abs = mountPathOf(projectRoot, mount);
    const target = mount.entry ? path.join(mount.target, mount.entry) : mount.target;
    const base = {
      source_id: mount.sourceId,
      source_label: source?.label || '',
    };
    const { walked, bytes } = pushWalked(abs, mount.as, target, base);
    mounts.push({
      as: mount.as,
      entry: mount.entry || '',
      sourceId: mount.sourceId,
      sourceLabel: source?.label || '',
      target,
      link: abs,
      files: rows.filter((row) => row.mount === mount.as).length,
      bytes,
      truncated: walked.truncated,
      errors: walked.errors.slice(0, 5),
    });
  }
  // 派生稿也在 data/ 里，同样要有出处：rel_path 用 `<as>__识别稿/…`，并写明 derived_from 指回原件。
  // 不写进来的话，provenance 的行数会比审计看到的文件数少，账就对不上了。
  for (const mount of materials.mounts) {
    const derivedAbs = path.join(path.resolve(projectRoot), 'data', derivedMountName(mount));
    if (!fs.existsSync(derivedAbs)) continue;
    const owner = byId.get(mount.sourceId);
    const target = cacheDir
      ? path.join(derivedRoot(cacheDir, mount.sourceId), ...(mount.entry ? [mount.entry] : []))
      : derivedAbs;
    const walked = walkFiles(derivedAbs);
    for (const file of walked.files) {
      const origin = derivedOrigin(mount, file.rel);
      if (!origin) {
        // 镜像挂载的标记文件也在 data/ 里，审计会把它算成 hidden 一行；账上同样留一行，否则差 1
        if (!isJunk(file.name)) continue;
        rows.push({
          rel_path: `${derivedMountName(mount)}/${file.rel}`,
          mount: derivedMountName(mount),
          source_id: mount.sourceId,
          source_label: owner?.label || '',
          source_path: target,
          bytes: file.size || 0,
          ext: extOf(file.name),
          kind: 'junk',
          channel: 'junk',
        });
        continue;
      }
      rows.push({
        rel_path: `${derivedMountName(mount)}/${file.rel}`,
        mount: derivedMountName(mount),
        source_id: mount.sourceId,
        source_label: owner?.label || '',
        source_path: target,
        bytes: file.size || 0,
        ext: extOf(file.name),
        kind: kindOf(file.name),
        channel: origin.channel,
        derived_from: origin.from,
        page: origin.page || '',
      });
    }
  }
  const dir = materialsDir(projectRoot);
  writeFileAtomic(path.join(dir, 'provenance.csv'), toCsv(
    ['rel_path', 'mount', 'source_id', 'source_label', 'source_path', 'bytes', 'ext', 'kind', 'channel', 'derived_from', 'page'],
    rows,
  ));
  writeFileAtomic(path.join(dir, 'mounts.json'), `${JSON.stringify({
    at: new Date().toISOString(),
    project: path.resolve(projectRoot),
    mounts,
    totalFiles: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  }, null, 2)}\n`);
  return { dir, rows, mounts };
}

/** 选材清单：每个源里的每一份文件，进不进这次分析、为什么。 */
export function writeSelection({ projectRoot, materials, sources }) {
  const rows = [];
  const mounted = new Map();
  for (const mount of materials.mounts) {
    if (!mounted.has(mount.sourceId)) mounted.set(mount.sourceId, []);
    mounted.get(mount.sourceId).push(mount);
  }
  for (const source of sources) {
    const picked = mounted.get(source.id) || [];
    const pickedEntries = new Set(picked.map((item) => item.entry || ''));
    const whole = pickedEntries.has('');
    const walked = fs.existsSync(source.path) ? walkFiles(source.path) : { files: [], errors: [], truncated: false };
    for (const file of walked.files) {
      if (isJunk(file.name)) continue;
      const top = file.top || path.basename(file.rel);
      const include = whole || pickedEntries.has(top);
      rows.push({
        source_id: source.id,
        source_label: source.label,
        path_in_source: file.rel,
        include: include ? 'yes' : 'no',
        reason_code: include
          ? (whole ? 'mounted_whole_source' : `mounted_entry:${top}`)
          : 'entry_not_mounted',
        channel: channelOf(file.name),
      });
    }
  }
  const dir = materialsDir(projectRoot);
  writeFileAtomic(path.join(dir, 'selection.csv'), toCsv(
    ['source_id', 'source_label', 'path_in_source', 'include', 'reason_code', 'channel'],
    rows,
  ));
  return { dir, rows };
}

/**
 * 把一个「已经复制进 data/ 的真实目录」换成联接。默认 dryRun，只报告不改。
 * 只有逐份 md5 全等、且文件数一致，才允许真删。
 */
export function migrateCopiedEntry({ projectRoot, source, entry = '', as = '' }) {
  // entry 统一用正斜杠存：Windows 用户可能手输反斜杠，跨平台读的时候不能靠 path.sep
  const rel = String(entry || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  // 副本在 data/ 下的目录名可能和源里的相对路径不同（整目录挂载时 entry 为空），所以别名单独给
  const localName = String(as || rel || path.basename(source.path)).replace(/\\/g, '/');
  const localDir = path.join(path.resolve(projectRoot), 'data', localName);
  const sourceDir = rel ? path.join(source.path, rel) : source.path;
  if (isLink(localDir)) {
    // 已经是联接：带上 localDir，调用方据此跳过（不能让它走到删除那一步）
    return { ok: true, skipped: 'already-linked', entry: rel, as: localName, localDir, sourceDir, verified: 0 };
  }
  let stat = null;
  try {
    stat = fs.statSync(localDir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) return { ok: false, error: `data/${localName} 不是真实目录`, entry: rel, as: localName };
  if (!fs.existsSync(sourceDir)) return { ok: false, error: `源里没有 ${rel || localName}`, entry: rel, as: localName };

  const local = walkFiles(localDir);
  const remote = new Map(walkFiles(sourceDir).files.map((file) => [file.rel, file]));
  const mismatched = [];
  const missing = [];
  let verified = 0;
  let counted = 0;
  const localReal = new Set();
  for (const file of local.files) {
    if (isJunk(file.name)) continue;
    counted += 1;
    localReal.add(file.rel);
    const peer = remote.get(file.rel);
    if (!peer) {
      missing.push(file.rel);
      continue;
    }
    let same = false;
    try {
      same = file.size === peer.size && hashFile(file.abs) === hashFile(peer.abs);
    } catch {
      same = false;
    }
    if (same) verified += 1;
    else mismatched.push(file.rel);
  }
  const extra = [...remote.keys()].filter((rel) => {
    if (isJunk(path.basename(rel))) return false;
    return !localReal.has(rel);
  });
  return {
    ok: mismatched.length === 0 && missing.length === 0,
    entry: rel,
    as: localName,
    localDir,
    sourceDir,
    verified,
    mismatched: mismatched.slice(0, 20),
    missing: missing.slice(0, 20),
    onlyInSource: extra.length,
    totalLocal: counted,
  };
}


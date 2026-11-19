/**
 * 渲染核：只读文件树、读文件、目录进度。
 *
 * 这里没有流水线状态：workspace 来自 store 的登记，其余全部是磁盘事实。
 * 安全边界只有 `artifactResolve` 的四道防护，任何读盘入口都必须先过它。
 */

import fs from 'node:fs';
import path from 'node:path';

import { isInside, readCsv, sanitizeFilename } from './util.js';
import { readMemo } from './read-scope.js';

/** 产物中心允许直接打开/下载的扩展名（白名单，防止把任意文件端出去）。 */
const ARTIFACT_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.tif', '.tiff', '.heic', '.heif', '.pdf',
  '.docx', '.csv', '.tsv', '.json', '.jsonl', '.md', '.txt', '.log', '.html',
  // 脚本页签（只按文本读取，插件从不执行它们）
  '.py', '.r', '.jl', '.do', '.sps',
]);
const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;

const IMAGE_EXT = /^\.(png|jpe?g|webp|gif|bmp|avif|tiff?|hei[cf])$/;

const TREE_ROOTS = [
  { name: 'output', depth: 3 },
  { name: 'scripts', depth: 2 },
];

const PROGRESS_SCAN_CAP = 10000;

function sortEntries(items) {
  return items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
}

function isPlainDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export class Viewer {
  constructor({ store }) {
    this.store = store;
  }

  workspaceById(id) {
    const workspaces = this.store.get('workspaces') || [];
    const wanted = String(id || '').trim() || String(this.store.get('activeWorkspaceId') || '');
    if (!wanted) return { ok: false, code: 'NO_WORKSPACE', error: '还没有绑定工作区' };
    const hit = workspaces.find((item) => item && item.id === wanted);
    if (!hit) return { ok: false, code: 'NO_WORKSPACE', error: '工作区不存在' };
    const root = path.resolve(hit.root);
    if (!fs.existsSync(root) || !isPlainDir(root)) {
      return { ok: false, code: 'WORKSPACE_MISSING', error: `工作区目录不存在：${hit.root}` };
    }
    return {
      ok: true,
      id: hit.id,
      name: hit.name || path.basename(root),
      path: root,
      workspace: { id: hit.id, name: hit.name || path.basename(root), root },
    };
  }

  /** 路径解析：词法越界、真实路径越界、扩展名白名单、大小上限，四道都要过。 */
  artifactResolve(rel, wsId) {
    const active = this.workspaceById(wsId);
    if (!active.ok) return active;
    const wanted = String(rel || '').trim();
    if (!wanted) return { ok: false, error: '缺 path' };
    const root = path.resolve(active.path);
    const abs = path.resolve(root, wanted);
    const relToRoot = path.relative(root, abs);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return { ok: false, error: '路径不在工作区里' };
    // Windows 备用数据流（c.exe:secret.json）会让扩展名白名单失效，直接拒绝冒号
    if (relToRoot.includes('\0') || (process.platform === 'win32' && relToRoot.includes(':'))) {
      return { ok: false, error: '不支持的路径' };
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return { ok: false, error: `文件不存在：${relToRoot}` };
    }
    if (!stat.isFile()) return { ok: false, error: '不是文件' };
    let real = abs;
    let realRoot = root;
    try {
      real = fs.realpathSync(abs);
    } catch {
      /* 用词法路径 */
    }
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      /* 用词法路径 */
    }
    if (!isInside(realRoot, real)) return { ok: false, error: '这个路径指向工作区外' };
    const ext = path.extname(real).toLowerCase();
    if (!ARTIFACT_EXTS.has(ext)) return { ok: false, error: `不支持的扩展名 ${ext || '(无)'}` };
    if (stat.size > ARTIFACT_MAX_BYTES) return { ok: false, error: `文件太大（${Math.round(stat.size / 1048576)} MB > 32 MB）` };
    return {
      ok: true,
      abs: real,
      rel: path.relative(root, abs).replace(/\\/g, '/'),
      size: stat.size,
      ext,
      mtimeMs: stat.mtimeMs,
    };
  }

  /** output/（深度 3）+ scripts/（深度 2）的文件树。 */
  artifactTree({ limit = 800 } = {}, wsId) {
    const active = this.workspaceById(wsId);
    if (!active.ok) return active;
    const root = active.path;
    const max = Math.min(2000, Math.max(20, Number(limit) || 800));
    const entries = [];
    const roots = [];
    let truncated = false;
    let totalFiles = 0;
    let totalBytes = 0;

    const walk = (dir, depth, maxDepth) => {
      if (truncated || depth > maxDepth) return;
      let items = [];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of sortEntries(items.slice())) {
        if (item.name.startsWith('.')) continue;
        const abs = path.join(dir, item.name);
        let stat;
        try {
          stat = fs.lstatSync(abs);
        } catch {
          continue;
        }
        // 联接/符号链接不展开：避免越界元数据泄露与自引用目录导致递归不终止
        if (stat.isSymbolicLink()) continue;
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (stat.isDirectory()) {
          entries.push({ kind: 'dir', rel, name: item.name, size: 0, mtimeMs: stat.mtimeMs });
          if (entries.length >= max) {
            truncated = true;
            return;
          }
          walk(abs, depth + 1, maxDepth);
        } else if (stat.isFile()) {
          const ext = path.extname(item.name).toLowerCase();
          totalFiles += 1;
          totalBytes += stat.size;
          entries.push({
            kind: 'file',
            rel,
            name: item.name,
            ext,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            viewable: ARTIFACT_EXTS.has(ext) && stat.size <= ARTIFACT_MAX_BYTES,
            image: IMAGE_EXT.test(ext),
          });
        }
        if (entries.length >= max) {
          truncated = true;
          return;
        }
      }
    };

    for (const item of TREE_ROOTS) {
      const base = path.join(root, item.name);
      let stat;
      try {
        stat = fs.lstatSync(base);
      } catch {
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      roots.push(item.name);
      entries.push({
        kind: 'dir',
        rel: item.name,
        name: item.name,
        size: 0,
        mtimeMs: stat.mtimeMs,
      });
      walk(base, 0, item.depth);
      if (truncated) break;
    }

    const titles = this.titleMap(active.id);
    for (const entry of entries) {
      if (entry.kind === 'file' && titles[entry.rel]) entry.title = titles[entry.rel];
    }
    return { ok: true, roots, entries, truncated, totalFiles, totalBytes };
  }

  /** 读一个产物的内容：表格回前 N 行，文本回前 N 字，图片/文档只回元信息。 */
  artifactRead(rel, { limit = 200 } = {}, wsId) {
    const resolved = this.artifactResolve(rel, wsId);
    if (!resolved.ok) return resolved;
    const maxRows = Math.min(2000, Math.max(5, Number(limit) || 200));
    const ext = resolved.ext;
    const base = { ok: true, rel: resolved.rel, size: resolved.size, ext, mtimeMs: resolved.mtimeMs };
    if (IMAGE_EXT.test(ext)) return { ...base, kind: 'image' };
    if (ext === '.pdf') return { ...base, kind: 'pdf' };
    if (ext === '.docx') return { ...base, kind: 'document' };
    if (ext === '.csv' || ext === '.tsv') {
      const csv = readCsv(resolved.abs);
      if (!csv) return { ok: false, error: 'CSV 解析失败' };
      return {
        ...base,
        kind: 'table',
        header: csv.header,
        rows: csv.rows.slice(0, maxRows).map((row) => csv.header.map((name) => row[name] ?? '')),
        totalRows: csv.rows.length,
        truncated: csv.rows.length > maxRows,
      };
    }
    if (ext === '.json' || ext === '.jsonl') {
      const text = fs.readFileSync(resolved.abs, 'utf8').replace(/^\uFEFF/, '');
      if (ext === '.json') {
        try {
          const value = JSON.parse(text);
          const pretty = JSON.stringify(value, null, 2);
          return { ...base, kind: 'json', text: pretty.length > 200000 ? `${pretty.slice(0, 200000)}\n…（已截断）` : pretty };
        } catch {
          return { ...base, kind: 'text', text: text.slice(0, 200000) };
        }
      }
      const lines = text.split(/\r?\n/).filter(Boolean);
      return { ...base, kind: 'text', text: lines.slice(0, maxRows).join('\n'), totalRows: lines.length, truncated: lines.length > maxRows };
    }
    const text = fs.readFileSync(resolved.abs, 'utf8');
    return { ...base, kind: 'text', text: text.length > 200000 ? `${text.slice(0, 200000)}\n…（已截断）` : text };
  }

  /** 中文显示名来自 skill 现成产物：output/figure_map.json（图）+ 根目录 manuscript.json（文稿标题/表题），不另造文件。 */
  titleMap(wsId) {
    const active = this.workspaceById(wsId);
    if (!active.ok) return {};
    return readMemo(`titles:${active.id}`, () => this.readTitleMap(active));
  }

  readTitleMap(active) {
    const map = {};
    this.mergeFigureMap(active, map);
    this.mergeManuscript(active, map);
    return map;
  }

  /** 把 figure_map/manuscript 里的绝对或相对路径归一成工作区相对 rel；越界返回空。 */
  relKey(active, raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    let rel = path.isAbsolute(text) ? path.relative(active.path, text) : text;
    rel = rel.replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return rel;
  }

  mergeFigureMap(active, map) {
    const resolved = this.artifactResolve('output/figure_map.json', active.id);
    if (!resolved.ok) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(resolved.abs, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const title = String(item.title || '').trim();
      if (!title) continue;
      const rel = this.relKey(active, item.image);
      if (!rel || map[rel]) continue;
      const tag = String(item.tag || '').trim();
      map[rel] = tag ? `${tag} ${title}` : title;
    }
  }

  mergeManuscript(active, map) {
    const resolved = this.artifactResolve('manuscript.json', active.id);
    if (!resolved.ok) return;
    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(resolved.abs, 'utf8'));
    } catch {
      return;
    }
    const blocks = spec && Array.isArray(spec.blocks) ? spec.blocks : [];
    const titleBlock = blocks.find((b) => b && b.type === 'title' && String(b.text || '').trim());
    if (titleBlock) {
      const docTitle = String(titleBlock.text).trim();
      for (const rel of ['output/manuscript.docx', 'output/manuscript.pdf']) {
        if (!map[rel]) map[rel] = docTitle;
      }
    }
    let tableNo = 0;
    for (const block of blocks) {
      if (!block || block.type !== 'table') continue;
      const caption = String(block.caption || '').trim();
      if (!caption) continue;
      const rel = this.relKey(active, block.csv);
      if (!rel || map[rel]) continue;
      const explicit = Number(block.number);
      tableNo = Number.isFinite(explicit) && explicit > 0 ? explicit : tableNo + 1;
      map[rel] = `表${tableNo} ${caption}`;
    }
  }

  /** 下载文件名：有中文标题用「标题+原扩展名」，否则退回英文 basename；ascii 回退始终用英文名。 */
  downloadName(rel, wsId) {
    const key = String(rel || '').replace(/\\/g, '/');
    const base = path.basename(key);
    const title = this.titleMap(wsId)[key];
    if (!title) return { name: base, ascii: base };
    const named = sanitizeFilename(title + path.extname(key)) || base;
    return { name: named, ascii: base };
  }

  /** output/ 一级子目录的文件数 + 最近修改时间（纯目录事实，无阶段语义）。 */
  progress(wsId) {
    const active = this.workspaceById(wsId);
    if (!active.ok) return { ok: false, error: active.error, code: active.code, progress: [] };
    return readMemo(`progress:${active.id}`, () => this.progressFor(active));
  }

  progressFor(active) {
    const base = path.join(active.path, 'output');
    let baseStat;
    try {
      baseStat = fs.lstatSync(base);
    } catch {
      return { ok: true, progress: [] };
    }
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) return { ok: true, progress: [] };
    let items = [];
    try {
      items = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return { ok: true, progress: [] };
    }
    const progress = [];
    for (const item of sortEntries(items.slice())) {
      if (!item.isDirectory() || item.isSymbolicLink() || item.name.startsWith('.')) continue;
      const dir = path.join(base, item.name);
      const scan = { fileCount: 0, latestMtime: 0 };
      const walk = (current, depth) => {
        if (scan.fileCount >= PROGRESS_SCAN_CAP || depth > 32) return;
        let children = [];
        try {
          children = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const child of children) {
          if (child.name.startsWith('.')) continue;
          const abs = path.join(current, child.name);
          let stat;
          try {
            stat = fs.lstatSync(abs);
          } catch {
            continue;
          }
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) walk(abs, depth + 1);
          else if (stat.isFile()) {
            scan.fileCount += 1;
            if (stat.mtimeMs > scan.latestMtime) scan.latestMtime = stat.mtimeMs;
            if (scan.fileCount >= PROGRESS_SCAN_CAP) return;
          }
        }
      };
      walk(dir, 0);
      progress.push({
        dir: `output/${item.name}`,
        name: item.name,
        fileCount: scan.fileCount,
        latestMtime: scan.latestMtime || null,
      });
    }
    return { ok: true, progress };
  }

  snapshot(wsId) {
    const active = this.workspaceById(wsId);
    if (!active.ok) {
      return { ok: false, code: active.code, error: active.error, workspace: null, tree: null, progress: [] };
    }
    const progress = this.progress(active.id);
    return {
      ok: true,
      workspace: active.workspace,
      tree: this.artifactTree({}, active.id),
      progress: progress.ok ? progress.progress : [],
    };
  }
}

export { ARTIFACT_EXTS, ARTIFACT_MAX_BYTES };
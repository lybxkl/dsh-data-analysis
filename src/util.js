/**
 * 纯工具函数：CSV 读取与路径包含判定。
 *
 * 这两件事曾经分散在 audit.js / sources.js 里，被整条流水线依赖；
 * 精简成查看器后只留下渲染真正需要的部分，不再带任何判定/扫描逻辑。
 */

import fs from 'node:fs';
import path from 'node:path';

import { readMemo } from './read-scope.js';

/** abs 是否落在 root 之内（词法判定；realpath 判定由调用方先做）。 */
export function isInside(root, abs) {
  const base = path.resolve(root);
  const target = path.resolve(abs);
  if (target === base) return true;
  const rel = path.relative(base, target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function parseCsv(text, { strict = false } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closed = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (strict && (field.length || closed)) throw Error('invalid CSV quote');
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      closed = false;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      closed = false;
    } else if (ch === '\r') {
      /* 等 \n */
    } else {
      if (strict && closed && !/\s/.test(ch)) throw Error('CSV data after closing quote');
      field += ch;
    }
  }
  if (strict && quoted) throw Error('unterminated CSV quote');
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const clean = rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
  if (!clean.length) return { header: [], rows: [] };
  const header = clean[0].map((cell) => cell.trim());
  if (strict && (!header.length || header.some((h) => !h) || new Set(header).size !== header.length || clean.slice(1).some((cells) => cells.length !== header.length))) {
    throw Error('invalid CSV columns or row width');
  }
  const records = clean.slice(1).map((cells) => {
    const record = {};
    header.forEach((key, index) => {
      record[key] = cells[index] === undefined ? '' : String(cells[index]).trim();
    });
    return record;
  });
  return { header, rows: records };
}

function absKey(file) {
  const text = String(file || '');
  try {
    return path.resolve(text);
  } catch {
    return text;
  }
}

function memo(key, load) {
  return readMemo(key, load);
}

export function readCsv(file) {
  return memo(`csv:${absKey(file)}`, () => {
    try {
      return parseCsv(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  });
}

/** 中文显示名 → 合法下载文件名：去 Windows 非法字符与控制字符、折叠空白、限长、去首尾点空格。 */
export function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/g, '');
}
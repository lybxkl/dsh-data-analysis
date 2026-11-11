/**
 * 项目骨架：只做「从零新建」。
 *
 * 目录是固定的：data / docs / output / scripts / runs + project.json。
 * 建之前先做空目录校验 —— 已经有东西的目录一律拒绝，避免把别人的项目改坏。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { STAGE_DEFS } from './defaults.js';

export const PROJECT_FILE = 'project.json';
export const PROJECT_DIRS = ['data', 'docs', 'output', 'scripts', 'runs'];

export function projectId(root) {
  const normalized = path.resolve(root).toLowerCase();
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

export function defaultProjectFile({ name, root, skill }) {
  const stages = {};
  for (const stage of STAGE_DEFS) {
    // 只登记「项目自己的状态与覆盖」；script/args 不复制——默认值以代码里的阶段表为准，
    // 复制一份会让「代码升级了但项目里还是旧参数」这种漂移悄悄发生。
    stages[stage.id] = {
      status: 'todo',
      note: '',
    };
  }
  return {
    schemaVersion: 1,
    name,
    root: path.resolve(root),
    createdAt: new Date().toISOString(),
    skill: {
      root: skill?.packageDir || '',
      version: skill?.version || '',
      sha256: skill?.sha256 || '',
    },
    scope: {
      root: 'data',
      extensions: [],
      minChars: 100,
      timeRange: '',
      include: '',
      exclude: '',
      note: '',
    },
    stages,
  };
}

export function emptyDirCheck(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, entries: [] };
    return { ok: false, error: `无法读取目录：${error?.message || error}` };
  }
  return { ok: entries.length === 0, entries };
}

/**
 * 建骨架。返回 { ok, root, created, project } 或 { ok:false, error }。
 * 注意：这里只写空目录与 project.json，绝不写任何研究内容。
 */
export function createProject({ dir, name, scope, skill }) {
  const raw = String(dir || '').trim();
  if (!raw) return { ok: false, error: '请给出项目目录（建议在空文件夹里新建）' };
  const root = path.resolve(raw);
  const label = String(name || '').trim() || path.basename(root) || '未命名项目';

  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) return { ok: false, error: '目标路径不是目录' };
    const check = emptyDirCheck(root);
    if (!check.ok && check.error) return { ok: false, error: check.error };
    if (check.ok === false) {
      const preview = check.entries.slice(0, 5).join('、');
      return {
        ok: false,
        error: `目录不是空的（${preview}${check.entries.length > 5 ? ' 等' : ''}）。v0.1 只从零新建，请换一个空目录或先清空。`,
      };
    }
  }

  const created = [];
  try {
    for (const sub of PROJECT_DIRS) {
      const full = path.join(root, sub);
      fs.mkdirSync(full, { recursive: true });
      created.push(`${sub}/`);
    }
    const project = defaultProjectFile({ name: label, root, skill });
    if (scope && typeof scope === 'object') {
      for (const key of Object.keys(project.scope)) {
        if (scope[key] !== undefined && scope[key] !== null && scope[key] !== '') project.scope[key] = scope[key];
      }
    }
    fs.writeFileSync(path.join(root, PROJECT_FILE), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    created.push(PROJECT_FILE);
    return { ok: true, root, created, project };
  } catch (error) {
    return { ok: false, error: `建骨架失败：${error?.message || error}` };
  }
}

export function readProject(root) {
  const file = path.join(path.resolve(root), PROJECT_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('project.json 不是对象');
    return { ok: true, project: parsed, file };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: `没有找到 ${PROJECT_FILE}` };
    return { ok: false, error: `${PROJECT_FILE} 读取失败：${error?.message || error}` };
  }
}

export function writeProject(root, project) {
  const file = path.join(path.resolve(root), PROJECT_FILE);
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  return file;
}

/** 运行台要展示的运行目录（每次运行写一个 .log）。 */
export function runsDir(root) {
  return path.join(path.resolve(root), 'runs');
}
/**
 * 工作区：把会话绑定到一个研究产物目录。
 *
 * 这是插件唯一的主动能力，也只做登记：目录可以是已有的，也可以是将来才建的；
 * 这里不创建目录、不写项目文件、不运行任何东西。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sessionIdOf, sessionIsDelegated } from './binding.js';
import { isInside } from './util.js';

export function workspaceIdOf(dir) {
  const normalized = path.resolve(dir).toLowerCase();
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

/** 本地日期 YYYY-MM-DD，作默认名的版本戳（不用 UTC，避免深夜差一天）。 */
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fail(code, error) {
  return { ok: false, code, error, text: `操作未执行：${error}` };
}

function checkDir(dir) {
  const raw = String(dir || '').trim();
  if (!raw) return fail('DIR_REQUIRED', '请给出产物目录的绝对路径');
  if (!path.isAbsolute(raw)) return fail('ABSOLUTE_REQUIRED', '目录必须是绝对路径');
  const root = path.resolve(raw);
  if (path.parse(root).root === root) return fail('ROOT_REFUSED', '不能把磁盘根目录当作工作区');
  if (fs.existsSync(root)) {
    let stat;
    try {
      stat = fs.statSync(root);
    } catch (error) {
      return fail('DIR_UNREADABLE', `无法读取目录：${error?.message || error}`);
    }
    if (!stat.isDirectory()) return fail('NOT_DIRECTORY', '目标路径不是目录');
  }
  return { ok: true, root };
}

export class WorkspaceService {
  constructor({ store, viewer }) {
    this.store = store;
    this.viewer = viewer;
  }

  workspaces() {
    return this.store.get('workspaces') || [];
  }

  byId(id) {
    return this.workspaces().find((item) => item && item.id === id) || null;
  }

  forSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const bound = (this.store.get('bindings') || {})[id] || '';
    return bound ? this.byId(bound) : null;
  }

  list() {
    return this.workspaces().map((item) => {
      const progress = this.viewer.progress(item.id);
      const dirs = progress.ok ? progress.progress : [];
      const fileCount = dirs.reduce((sum, dir) => sum + (Number(dir.fileCount) || 0), 0);
      const latestMtime = dirs.reduce((latest, dir) => Math.max(latest, Number(dir.latestMtime) || 0), 0);
      // 目录可能已被用户在插件外删掉：登记仍要能显示、更要能移除
      return { ...item, fileCount, latestMtime: latestMtime || null, missing: !progress.ok };
    });
  }

  bind({ dir, name, sessionId } = {}) {
    const checked = checkDir(dir);
    if (!checked.ok) return checked;
    const root = checked.root;
    const id = workspaceIdOf(root);
    const session = String(sessionId || '').trim();
    const workspaces = this.workspaces();
    const existing = workspaces.find((item) => item && item.id === id);
    let workspace = existing;
    if (!existing) {
      const base = path.basename(root) || '未命名工作区';
      const label = String(name || '').trim().slice(0, 80) || `${base}（${dateStamp()}）`;
      workspace = { id, name: label, root, createdAt: new Date().toISOString() };
      this.store.set('workspaces', workspaces.concat(workspace));
    }
    this.store.set('activeWorkspaceId', id);

    let already = false;
    let movedFrom = null;
    if (session) {
      const bindings = { ...(this.store.get('bindings') || {}) };
      const prior = bindings[session] || '';
      if (prior === id) {
        already = true;
      } else if (prior) {
        const previous = this.byId(prior);
        if (previous) movedFrom = { id: previous.id, name: previous.name, root: previous.root };
        bindings[session] = id;
        this.store.set('bindings', bindings);
      } else {
        bindings[session] = id;
        this.store.set('bindings', bindings);
      }
    }
    this.store.flushSoon(50);

    const publicWorkspace = { id: workspace.id, name: workspace.name, root: workspace.root };
    const text = session
      ? `本会话已${movedFrom ? '改绑' : '绑定'}工作区：${publicWorkspace.name}（${publicWorkspace.root}）。工作台将只读展示该目录的产物。`
      : `已登记工作区：${publicWorkspace.name}（${publicWorkspace.root}）。`;
    return {
      ok: true,
      workspace: publicWorkspace,
      already: session ? already : undefined,
      movedFrom: movedFrom || undefined,
      text,
    };
  }

  bindForExec(args, exec) {
    const sessionId = sessionIdOf(exec);
    if (!sessionId) return fail('SESSION_REQUIRED', '这条调用不属于任何会话，无法绑定工作区');
    if (sessionIsDelegated(exec)) return fail('MAIN_SESSION_REQUIRED', '请由主对话绑定工作区，子代理不改变归属');
    return this.bind({ dir: args?.dir, name: args?.name, sessionId });
  }

  /** 插件台账不能落在任何已登记工作区内：研究目录归 skill 所有，插件只读。 */
  isInsideWorkspace(dir) {
    const raw = String(dir || '').trim();
    if (!raw) return false;
    let target;
    try {
      target = path.resolve(raw);
    } catch {
      return false;
    }
    return this.workspaces().some((item) => {
      let root;
      try {
        root = path.resolve(item.root);
      } catch {
        return false;
      }
      return target === root || isInside(root, target);
    });
  }

  select(id) {
    const workspace = this.byId(String(id || ''));
    if (!workspace) return fail('NO_WORKSPACE', '工作区不存在');
    this.store.set('activeWorkspaceId', workspace.id);
    this.store.flushSoon(50);
    return { ok: true, workspace };
  }

  forget(id) {
    const wanted = String(id || '');
    const workspace = this.byId(wanted);
    if (!workspace) return fail('NO_WORKSPACE', '工作区不存在');
    this.store.set('workspaces', this.workspaces().filter((item) => item.id !== wanted));
    const bindings = { ...(this.store.get('bindings') || {}) };
    let changed = false;
    for (const session of Object.keys(bindings)) {
      if (bindings[session] === wanted) {
        delete bindings[session];
        changed = true;
      }
    }
    if (changed) this.store.set('bindings', bindings);
    if (this.store.get('activeWorkspaceId') === wanted) this.store.set('activeWorkspaceId', '');
    this.store.flushSoon(50);
    return {
      ok: true,
      id: workspace.id,
      name: workspace.name,
      root: workspace.root,
      diskKept: true,
      text: `已移除登记：${workspace.name}（磁盘目录未改动）`,
    };
  }
}
/**
 * 极小的 JSON 台账：工作区登记、会话绑定、配置（只剩 dataDir）。
 *
 * 原子写、串行落盘、读坏了重建。台账里不存运行记录/判定/裁定——
 * 那些都是流水线时代的字段，读到时直接忽略。
 */

import fs from 'node:fs';
import path from 'node:path';

function shape(data) {
  const raw = data && typeof data === 'object' ? data : {};
  const next = {};
  next.version = 2;
  next.workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces
        .filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.root === 'string')
        .map((item) => ({
          id: item.id,
          name: typeof item.name === 'string' ? item.name : '',
          root: item.root,
          createdAt: item.createdAt || '',
        }))
    : [];
  // 旧台账只有 projects[]：只取 id/name/root 映射成工作区，不写迁移报告。
  if (!next.workspaces.length && Array.isArray(raw.projects)) {
    for (const item of raw.projects) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id !== 'string' || typeof item.path !== 'string') continue;
      next.workspaces.push({ id: item.id, name: item.name || '', root: item.path, createdAt: item.createdAt || '' });
    }
  }
  // 绑定表只保留「会话 → 工作区 id」；旧版本把值写成 {projectId, at}，这里只取 projectId。
  const rawBindings = raw.bindings && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings) ? raw.bindings : {};
  next.bindings = {};
  for (const [sessionId, value] of Object.entries(rawBindings)) {
    const id = typeof value === 'string' ? value : value && typeof value.projectId === 'string' ? value.projectId : '';
    if (sessionId && id) next.bindings[sessionId] = id;
  }
  next.config = { dataDir: raw.config && typeof raw.config.dataDir === 'string' ? raw.config.dataDir : '' };
  next.activeWorkspaceId = typeof raw.activeWorkspaceId === 'string' ? raw.activeWorkspaceId : '';
  return next;
}

export class Store {
  constructor({ filePath, logger }) {
    this.filePath = filePath;
    this.logger = logger;
    this.data = {};
    this.loadError = null;
    this.pending = Promise.resolve();
    this.dirty = false;
    this.timer = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = shape(JSON.parse(raw));
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.loadError = error?.message || String(error);
        this.logger?.warn?.(`[data-analysis] 台账读取失败，将重建：${this.loadError}`);
      }
      this.data = shape({});
    }
    return this;
  }

  get(key, fallback) {
    if (key === undefined) return this.data;
    const value = this.data?.[key];
    return value === undefined ? fallback : value;
  }

  set(key, value) {
    if (typeof key === 'object' && key !== null) {
      Object.assign(this.data, key);
    } else {
      this.data[key] = value;
    }
    this.dirty = true;
    return this;
  }

  async rebase(filePath) {
    const target = path.resolve(String(filePath));
    if (target === path.resolve(this.filePath)) return this;
    await this.flush();
    await this.pending.catch(() => {});
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.filePath = target;
    this.loadError = null;
    this.dirty = false;
    this.load();
    return this;
  }

  flush() {
    if (!this.dirty) return this.pending;
    this.dirty = false;
    const snapshot = JSON.stringify(this.data, null, 2);
    const target = this.filePath;
    const tmp = `${target}.tmp`;
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(tmp, snapshot, 'utf8');
        await fs.promises.rename(tmp, target);
      })
      .catch((error) => {
        // 写失败不能把未落盘的数据当成已保存：恢复 dirty，下一次 flush 还会重试
        this.dirty = true;
        this.logger?.warn?.(`[data-analysis] 台账落盘失败：${error?.message || error}`);
      });
    return this.pending;
  }

  flushSoon(delay = 120) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}
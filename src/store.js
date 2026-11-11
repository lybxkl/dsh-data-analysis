/**
 * 极小的 JSON 状态仓：原子写、串行落盘、读坏了不致命。
 *
 * 状态文件里只放「台账」（项目登记、运行记录、裁定），项目自己的产物一律留在项目目录，
 * 这样删掉插件数据也不会动到用户的研究资料。
 */

import fs from 'node:fs';
import path from 'node:path';

function shape(data) {
  if (!data || typeof data !== 'object') data = {};
  if (!data.version) data.version = 1;
  if (!Array.isArray(data.projects)) data.projects = [];
  if (!Array.isArray(data.runs)) data.runs = [];
  if (!data.adjudications || typeof data.adjudications !== 'object' || Array.isArray(data.adjudications)) data.adjudications = {};
  if (!data.recheckChains || typeof data.recheckChains !== 'object' || Array.isArray(data.recheckChains)) data.recheckChains = {};
  if (!data.meta || typeof data.meta !== 'object') data.meta = {};
  if (typeof data.activeProjectId !== 'string') data.activeProjectId = '';
  if (typeof data.activeProjectPath !== 'string') data.activeProjectPath = '';
  return data;
}

export class Store {
  constructor({ filePath, logger }) {
    this.filePath = filePath;
    this.logger = logger;
    this.data = {};
    this.loadError = null;
    this.pending = Promise.resolve();
    this.dirty = false;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = shape(JSON.parse(raw));
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.loadError = error?.message || String(error);
        this.logger?.warn?.(`[data-analysis] 状态文件读取失败，将重建：${this.loadError}`);
      }
      this.data = shape({});
    }
    return this;
  }

  /** get() 返回整份状态；get('runs') 取其中一个键。 */
  get(key, fallback) {
    if (key === undefined) return this.data;
    const value = this.data?.[key];
    return value === undefined ? fallback : value;
  }

  /** set({...}) 合并顶层键；set('key', value) 也支持。 */
  set(key, value) {
    if (typeof key === 'object' && key !== null) {
      Object.assign(this.data, key);
    } else {
      this.data[key] = value;
    }
    this.dirty = true;
    return this;
  }

  /**
   * 换一个台账文件（用户在面板里改了 dataDir 时）。
   * 先把旧台账落盘，再加载新文件；新文件不存在就从空状态开始。
   */
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

  /** 落盘：写入临时文件再 rename，避免断电留下半个 JSON。 */
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
        this.logger?.warn?.(`[data-analysis] 状态落盘失败：${error?.message || error}`);
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
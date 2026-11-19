import { AsyncLocalStorage } from 'node:async_hooks';

/* --------------------------- 一次快照内的读盘去重 --------------------------- */

/**
 * 同一批文件在一次同步计算里会被反复读（树、进度、查看器各读一遍）。
 * 作用域只在一次计算内有效：算完即丢，下一次请求重新读盘，不缓存任何判定。
 */
const readScope = new AsyncLocalStorage();

export function withReadCache(fn) {
  if (readScope.getStore()) return fn();
  return readScope.run(new Map(), fn);
}

/** 作用域内按 key 去重；不在作用域里就每次现算。缓存的是「读出来的事实」。 */
export function readMemo(key, load) {
  const store = readScope.getStore();
  if (!store) return load();
  if (store.has(key)) return store.get(key);
  const value = load();
  store.set(key, value);
  return value;
}
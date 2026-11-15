import { AsyncLocalStorage } from 'node:async_hooks';

/* --------------------------- 一次快照内的读盘去重 --------------------------- */

/**
 * 同一批产物在一次快照里会被反复读：
 *   analysis.csv 在 scanArtifacts、闸门与复核里一共读 8 次，corpus_files.csv 读 3 次。
 * 内容在一次同步计算里不会变，重复读只是把同样的字节再读、再解析一遍（实测占了打开面板等待的一大半）。
 *
 * 作用域是「一次同步计算」，不是全局 TTL 缓存：
 *   - 面板拿到的永远是这次现读出来的结果，不会出现「显示的是上一轮的旧绿灯」；
 *   - 计算一结束作用域就丢，下一次 /state 重新读盘——判定仍然不缓存。
 *
 * 独立成模块是为了让 gate-report 的路径核验（safePath）也能挂进同一作用域：
 * 它和 audit 互相不构成 import 环。
 */
const readScope = new AsyncLocalStorage();

/** 把一段同步计算包进「读盘去重」作用域；嵌套调用复用外层，不重置已读到的内容。 */
export function withReadCache(fn) {
  if (readScope.getStore()) return fn();
  return readScope.run(new Map(), fn);
}

/** 作用域内按 key 去重；不在作用域里就每次现算。缓存的是「读出来的事实」，不是判定。 */
export function readMemo(key, load) {
  const store = readScope.getStore();
  if (!store) return load();
  if (store.has(key)) return store.get(key);
  const value = load();
  store.set(key, value);
  return value;
}
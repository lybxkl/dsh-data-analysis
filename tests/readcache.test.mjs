// 读盘去重（withReadCache）与「已知 size/mtime 取指纹」的单元测试。
//
// 这两件事只影响「打开面板要等多久」，不影响任何判定结论——但正因如此，写错了不会有人发现：
// 面板会照常显示，只是慢；更糟的是作用域没清干净，下一次快照读到上一次的旧内容。
// 所以这里盯三件事：
//   1. 一次快照内同样的文件只读一次；
//   2. 作用域一结束就丢，下一次读必须重新读盘（判定不缓存）；
//   3. digestFileKnown 命中缓存时不再 stat，内容变了则一定失效。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withReadCache, readCsv, statOf } from '../src/audit.js';
import { digestFileKnown } from '../src/fingerprint.js';

let passed = 0;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (error) {
    failures.push(`${label}：${error.message}`);
    console.log(`✗ ${label} — ${error.message}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-readcache-'));
const csvFile = path.join(tmpRoot, 'analysis.csv');
fs.writeFileSync(csvFile, 'id,n\n1,10\n2,20\n', 'utf8');

/* ---------------- 计数桩：只数我们关心的那几个文件 ---------------- */

const counts = { read: 0, stat: 0 };
const origRead = fs.readFileSync;
const origStat = fs.statSync;
fs.readFileSync = function (file, ...rest) {
  if (String(file) === csvFile) counts.read += 1;
  return origRead.call(fs, file, ...rest);
};
fs.statSync = function (file, ...rest) {
  if (String(file) === csvFile) counts.stat += 1;
  return origStat.call(fs, file, ...rest);
};

const reset = () => {
  counts.read = 0;
  counts.stat = 0;
};

/* ---------------- 1. 作用域内去重 ---------------- */

await check('作用域内：同一份 CSV 读两次只落一次盘', () => {
  reset();
  withReadCache(() => {
    const a = readCsv(csvFile);
    const b = readCsv(csvFile);
    assert.equal(a.rows.length, 2);
    assert.equal(b.rows.length, 2);
    assert.equal(a, b, '两次读应拿到同一个对象（同一作用域里不重复解析）');
  });
  assert.equal(counts.read, 1, `实际读了 ${counts.read} 次`);
});

await check('作用域内：statOf 同样只 stat 一次', () => {
  reset();
  withReadCache(() => {
    const a = statOf(csvFile);
    const b = statOf(csvFile);
    assert.equal(a.exists, true);
    assert.deepEqual(a, b);
  });
  assert.equal(counts.stat, 1, `实际 stat 了 ${counts.stat} 次`);
});

await check('嵌套 withReadCache 复用外层作用域，不重置已读内容', () => {
  reset();
  withReadCache(() => {
    readCsv(csvFile);
    withReadCache(() => readCsv(csvFile));
  });
  assert.equal(counts.read, 1, `实际读了 ${counts.read} 次`);
});

/* ---------------- 2. 作用域结束就丢（判定不缓存） ---------------- */

await check('作用域外：两次读就是两次落盘（缓存只活在这一次计算里）', () => {
  reset();
  readCsv(csvFile);
  readCsv(csvFile);
  assert.equal(counts.read, 2, `实际读了 ${counts.read} 次`);
});

await check('两次独立快照之间不会互相复用', () => {
  reset();
  withReadCache(() => readCsv(csvFile));
  withReadCache(() => readCsv(csvFile));
  assert.equal(counts.read, 2, `实际读了 ${counts.read} 次`);
});

await check('作用域里读不到的内容，下一次现读能拿到（内容真的会变）', () => {
  const fresh = path.join(tmpRoot, 'flow.csv');
  fs.writeFileSync(fresh, 'stage,n\n审计,3\n', 'utf8');
  withReadCache(() => {
    assert.equal(readCsv(fresh).rows[0].n, '3');
  });
  fs.writeFileSync(fresh, 'stage,n\n审计,3\n编码,2\n', 'utf8');
  assert.equal(readCsv(fresh).rows.length, 2);
});

await check('作用域跟着 async 上下文走：await 之后仍算同一次快照', async () => {
  reset();
  let readsInside = 0;
  const out = await withReadCache(async () => {
    readCsv(csvFile);
    await Promise.resolve();
    readCsv(csvFile);
    readsInside = counts.read;
    return 'done';
  });
  assert.equal(out, 'done');
  assert.equal(readsInside, 1, '同一次计算里 await 前后仍算一次快照');
  // 出了作用域再读，必须重新落盘
  reset();
  readCsv(csvFile);
  assert.equal(counts.read, 1);
});

/* ---------------- 3. 已知 size/mtime 的指纹 ---------------- */

await check('digestFileKnown：命中缓存后不再 stat', () => {
  const file = path.join(tmpRoot, 'source.txt');
  fs.writeFileSync(file, 'ABCDEF', 'utf8');
  const st = origStat.call(fs, file);
  const first = digestFileKnown(file, { size: st.size, mtimeMs: st.mtimeMs });
  assert.equal(first.ok, true);
  reset();
  const second = digestFileKnown(file, { size: st.size, mtimeMs: st.mtimeMs });
  assert.equal(second.hash, first.hash);
  assert.equal(counts.stat, 0, `命中缓存还 stat 了 ${counts.stat} 次`);
});

await check('digestFileKnown：mtime 变了就重新算，内容不同则哈希不同', () => {
  const file = path.join(tmpRoot, 'source2.txt');
  fs.writeFileSync(file, 'AAAAAA', 'utf8');
  const st1 = origStat.call(fs, file);
  const first = digestFileKnown(file, { size: st1.size, mtimeMs: st1.mtimeMs });
  // 同样大小、不同内容：必须靠 mtime 变（或重新哈希）识别出来
  fs.writeFileSync(file, 'BBBBBB', 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  const st2 = origStat.call(fs, file);
  const second = digestFileKnown(file, { size: st2.size, mtimeMs: st2.mtimeMs });
  assert.notEqual(second.hash, first.hash, '内容变了哈希必须变');
  assert.equal(second.hash, crypto.createHash('sha256').update('BBBBBB').digest('hex'));
});

await check('digestFileKnown：清单里的 mtime 与磁盘对不上时按磁盘现算，不返回旧值', () => {
  const file = path.join(tmpRoot, 'source3.txt');
  fs.writeFileSync(file, 'EEEEEE', 'utf8');
  const real = origStat.call(fs, file);
  // 清单过期/错乱（mtime 对不上任何一次真实状态）：键不命中 → 现读现算，
  // 返回的哈希必须是磁盘上的内容，缓存也按真实 mtime 记
  const wrong = { size: real.size, mtimeMs: real.mtimeMs + 123454321 };
  const got = digestFileKnown(file, wrong);
  assert.equal(got.hash, crypto.createHash('sha256').update('EEEEEE').digest('hex'));
  assert.equal(got.mtimeMs, real.mtimeMs);
});

await check('digestFileKnown：文件不存在时如实报 failed，不编一个空哈希冒充一致', () => {
  const got = digestFileKnown(path.join(tmpRoot, 'never.txt'), { size: 10, mtimeMs: 1 });
  assert.equal(got.ok, false);
  assert.equal(got.hash, '');
});

/* ---------------- 收尾 ---------------- */

fs.readFileSync = origRead;
fs.statSync = origStat;
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败 / ${passed + failures.length} 条`);
  for (const item of failures) console.log('  - ' + item);
  process.exitCode = 1;
} else {
  console.log(`✓ 读盘去重与指纹缓存全部通过（${passed} 条）`);
}

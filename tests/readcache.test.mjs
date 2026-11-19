// 读盘去重（withReadCache/readMemo）与 CSV 解析的单元测试。
//
// 缓存只影响「打开面板要等多久」，不影响内容：作用域一结束就丢，
// 下一次请求必须重新读盘。这里盯住这两件事。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withReadCache, readMemo } from '../src/read-scope.js';
import { readCsv, parseCsv } from '../src/util.js';

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
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

const counts = { read: 0 };
const origRead = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  if (String(file) === csvFile) counts.read += 1;
  return origRead.call(fs, file, ...rest);
};
const reset = () => {
  counts.read = 0;
};

check('作用域内：同一份 CSV 读两次只落一次盘', () => {
  reset();
  withReadCache(() => {
    const a = readCsv(csvFile);
    const b = readCsv(csvFile);
    assert.deepEqual(a, b);
    assert.equal(a.rows.length, 2);
  });
  assert.equal(counts.read, 1);
});

check('作用域外：每次现读，不缓存结论', () => {
  reset();
  readCsv(csvFile);
  readCsv(csvFile);
  assert.equal(counts.read, 2);
});

check('嵌套作用域复用外层已读内容', () => {
  reset();
  withReadCache(() => {
    readCsv(csvFile);
    withReadCache(() => readCsv(csvFile));
  });
  assert.equal(counts.read, 1);
});

check('作用域结束后重新读盘（不会拿到上一轮旧内容）', () => {
  reset();
  withReadCache(() => readCsv(csvFile));
  fs.writeFileSync(csvFile, 'id,n\n1,99\n', 'utf8');
  let next = null;
  withReadCache(() => {
    next = readCsv(csvFile);
  });
  assert.equal(counts.read, 2);
  assert.equal(next.rows.length, 1);
  assert.equal(next.rows[0].n, '99');
  fs.writeFileSync(csvFile, 'id,n\n1,10\n2,20\n', 'utf8');
});

check('readMemo 在作用域内按 key 去重', () => {
  let calls = 0;
  const load = () => {
    calls += 1;
    return { v: calls };
  };
  withReadCache(() => {
    assert.equal(readMemo('k', load).v, 1);
    assert.equal(readMemo('k', load).v, 1);
  });
  assert.equal(calls, 1);
});

check('readMemo 在作用域外每次现算', () => {
  let calls = 0;
  const load = () => {
    calls += 1;
    return calls;
  };
  readMemo('k2', load);
  readMemo('k2', load);
  assert.equal(calls, 2);
});

check('parseCsv：BOM、引号、内嵌逗号与换行', () => {
  const parsed = parseCsv('\uFEFFname,note\n"a,1","line1\nline2"\n');
  assert.deepEqual(parsed.header, ['name', 'note']);
  assert.equal(parsed.rows[0].name, 'a,1');
  assert.equal(parsed.rows[0].note, 'line1\nline2');
});

check('readCsv：读不到时返回 null', () => {
  assert.equal(readCsv(path.join(tmpRoot, 'missing.csv')), null);
});

fs.readFileSync = origRead;
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
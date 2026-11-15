/** Persistent owner-token lease. All production and inspection share it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {safePath} from './gate-report.js';

function replace(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function acquireProjectLease(root) {
  const file = safePath(root, 'output/gates/publication.lock');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const record = {
    schema: 'dsa.gate-lease/1', token: crypto.randomBytes(24).toString('hex'),
    pid: process.pid, hostname: os.hostname(), children: [],
    kind: 'production', createdAt: new Date().toISOString(),
  };
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  function current() {
    const value = JSON.parse(fs.readFileSync(safePath(root,'output/gates/publication.lock'), 'utf8'));
    if (value.token !== record.token) throw new Error('项目写锁已发生冲突');
    return value;
  }
  return {
    token: record.token,
    registerChild(pid) {
      const value = current();
      if (!value.children.includes(pid)) value.children.push(pid);
      replace(file, value);
    },
    childClosed(pid) {
      const value = current();
      value.children = value.children.filter(x => x !== pid);
      replace(file, value);
    },
    release() {
      const value = current();
      if (value.children.length) throw new Error('前台子进程尚未退出，不能释放项目写锁');
      fs.unlinkSync(file);
    },
  };
}

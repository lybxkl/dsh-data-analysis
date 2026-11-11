/**
 * skill 只读指纹。
 *
 * 隔离契约：插件只读 skillRoot，不复制、不 vendor、不修改。每次运行记录 SKILL.md 的
 * sha256 与 mtime —— 升级 skill 不会破坏工作台，但事后能回答「这个数字是哪一版跑出来的」。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SKILL_CANDIDATES, SKILL_PACKAGE } from './defaults.js';

function isSkillPackage(dir) {
  try {
    return fs.existsSync(path.join(dir, 'SKILL.md')) && fs.existsSync(path.join(dir, 'scripts'));
  } catch {
    return false;
  }
}

/**
 * 允许配置两种写法：技能仓库根（里面再套一层包目录）或包目录本身。
 * 返回 { ok, root, packageDir, note }。
 *
 * 配置了就只认配置：配置写错时直接报错，不再偷偷回退到候选目录——
 * 否则用户改错了路径，面板还显示"技能包就位"，那是最难查的一类错觉。
 */
export function resolveSkillRoot(configSkillRoot) {
  const tried = [];
  const configured = String(configSkillRoot || '').trim();
  const candidates = configured ? [configured] : SKILL_CANDIDATES.slice();
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    const abs = path.resolve(raw);
    tried.push(abs);
    if (isSkillPackage(abs)) {
      return { ok: true, root: abs, packageDir: abs, layout: 'package' };
    }
    const nested = path.join(abs, SKILL_PACKAGE);
    if (isSkillPackage(nested)) {
      return { ok: true, root: abs, packageDir: nested, layout: 'repo' };
    }
  }
  return { ok: false, root: '', packageDir: '', tried, configured: Boolean(configured) };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 读 SKILL.md 头部，抓版本号（没有就退回文件 hash 前 8 位）。 */
export function fingerprint(skill) {
  if (!skill?.ok) {
    return { ok: false, root: skill?.root || '', version: '', sha256: '', files: 0, note: 'skillRoot 无效' };
  }
  const mdPath = path.join(skill.packageDir, 'SKILL.md');
  let head = '';
  let hash = '';
  let mtimeMs = 0;
  let size = 0;
  try {
    const buf = fs.readFileSync(mdPath);
    hash = sha256(buf);
    size = buf.length;
    mtimeMs = fs.statSync(mdPath).mtimeMs;
    head = buf.subarray(0, 4096).toString('utf8');
  } catch (error) {
    return {
      ok: false,
      root: skill.packageDir,
      version: '',
      sha256: '',
      files: 0,
      note: `SKILL.md 读取失败：${error?.message || error}`,
    };
  }
  const versionMatch = head.match(/\bversion\b[^\n]*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i)
    || head.match(/\bv([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b/i);
  let files = 0;
  try {
    files = fs.readdirSync(path.join(skill.packageDir, 'scripts')).filter((name) => name.endsWith('.py')).length;
  } catch {
    files = 0;
  }
  return {
    ok: true,
    root: skill.packageDir,
    version: versionMatch ? versionMatch[1] : `sha:${hash.slice(0, 8)}`,
    sha256: hash,
    mtimeMs,
    size,
    files,
    note: '',
  };
}

/** 登记表用：skill 提供哪些脚本（只读目录，不执行）。 */
export function listScripts(skill) {
  if (!skill?.ok) return [];
  const dir = path.join(skill.packageDir, 'scripts');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
      .map((entry) => {
        const full = path.join(dir, entry.name);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        return { name: entry.name, size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * 阶段脚本解析：只允许读到「项目根」与「技能包」这两处。
 *
 * 隔离契约约束的是「能读到哪」，不是「路径长什么样」：
 * 指向包外的绝对路径一律拒绝，但落在项目内或技能包内的绝对路径本身不越界，可以接受
 * （project.json 是数据，面板/AI 把人手写的绝对路径登记进来是很常见的，不该因此跑不动）。
 *
 * 返回 { ok: true, abs, source } 或 { ok: false, code }：
 *   code='empty'   没登记脚本
 *   code='outside' 文件在磁盘上存在，但落在项目与技能包之外
 *   code='missing' 两处都没有这个文件
 */
export function resolveStageScript({ projectRoot, skill, script } = {}) {
  const rel = String(script || '').trim();
  if (!rel) return { ok: false, code: 'empty' };

  const root = path.resolve(projectRoot || '.');
  const local = path.resolve(root, rel);
  const skillDir = skill?.ok ? path.resolve(skill.packageDir) : '';
  const insideProject = isInside(root, local);
  const insideSkill = Boolean(skillDir) && isInside(skillDir, local);

  if ((insideProject || insideSkill) && fs.existsSync(local)) {
    return { ok: true, abs: local, source: insideProject ? 'project' : 'skill' };
  }

  // 相对路径在技能包里再找一次：scripts/xxx.py 指的是技能包自己那份（项目没覆盖同名脚本时）
  if (skill?.ok && !path.isAbsolute(rel)) {
    const inSkill = scriptPath(skill, rel);
    if (inSkill && fs.existsSync(inSkill)) return { ok: true, abs: inSkill, source: 'skill' };
  }

  const outside = !insideProject && !insideSkill;
  return { ok: false, code: outside && fs.existsSync(local) ? 'outside' : 'missing' };
}

/** 校验某个阶段脚本是否真的存在（运行前用它把「脚本没了」变成可读错误）。 */
export function scriptPath(skill, relative) {
  if (!skill?.ok || !relative) return '';
  // 只接受包内相对路径：绝对路径或带 '..' 的配置一律拒绝，避免读到包外文件
  if (path.isAbsolute(relative)) return '';
  const rel = String(relative).replace(/\\/g, '/');
  if (rel.split('/').includes('..')) return '';
  const abs = path.resolve(skill.packageDir, rel);
  return isInside(skill.packageDir, abs) ? abs : '';
}

export function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
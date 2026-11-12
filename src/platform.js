/**
 * 平台差异都收在这里：建/删目录联接（junction）、跑一段 PowerShell、判断一个路径是不是链接。
 *
 * 为什么用目录联接而不是复制：材料是用户的，工作台只该记地址。Windows 上 junction 不需要管理员权限，
 * 且 Python 的 os.walk 会正常下钻（它只跳过 islink()，而 junction 在 Python 里不是符号链接），
 * 所以技能脚本的 `--root data` 一行都不用改。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

/**
 * 跑一段 PowerShell，返回 { ok, code, stdout, stderr }。不抛异常。
 * 非 Windows 直接返回失败：调用方都应当先判断 IS_WINDOWS，这里是最后一道防线，
 * 免得在 macOS 上抛一个看不懂的 spawn ENOENT。
 */
export function runPowerShell(script, { timeoutMs = 60000, cwd } = {}) {
  if (!IS_WINDOWS) {
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: `当前是 ${process.platform}，没有 PowerShell：这部分功能只在 Windows 上可用`,
    });
  }
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n超时（${timeoutMs}ms）`.trim() });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 200000) stdout = stdout.slice(0, 200000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 200000) stderr = stderr.slice(0, 200000);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: String(error?.message || error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Windows 的链接目标有时带 \\?\ 或 \??\ 前缀，去掉后再比较/拼接。 */
export function stripLongPrefix(value) {
  const text = String(value || '');
  let rest = '';
  if (text.startsWith('\\\\?\\')) rest = text.slice(4);
  else if (text.startsWith('\\??\\')) rest = text.slice(4);
  else return text;
  // \\?\UNC\srv\share\x 正常写法是 \\srv\share\x
  if (/^UNC\\/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return rest;
}

/**
 * 两个路径是不是同一个目录。
 * Windows 上要按不区分大小写比较（F:\X 与 f:\x 是同一个），并且两边都可能带长路径前缀。
 */
export function samePath(left, right) {
  const normalize = (value) => {
    let text = stripLongPrefix(String(value || ''));
    try {
      text = path.resolve(text);
    } catch {
      /* 保留原样 */
    }
    return IS_WINDOWS ? text.toLowerCase().replace(/\//g, '\\') : text;
  };
  if (!left || !right) return false;
  return normalize(left) === normalize(right);
}

/** 这个路径本身是不是一个链接/联接（不跟随）。 */
export function isLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 跟随链接后的真实路径；不是链接就返回 null。 */
export function linkTarget(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) return null;
    const raw = String(fs.readlinkSync(target));
    // 有的实现返回 \\?\F:\... 或 \??\F:\...，带前缀的路径不能直接 path.resolve
    const clean = stripLongPrefix(raw);
    if (path.isAbsolute(clean)) return path.normalize(clean);
    return path.resolve(path.dirname(target), clean);
  } catch {
    return null;
  }
}

/**
 * 建目录联接。已存在则返回 already=true（不覆盖任何东西）。
 * 目标必须是已存在的目录。
 */
export async function createDirLink(linkPath, targetPath) {
  const absLink = path.resolve(linkPath);
  const absTarget = path.resolve(targetPath);
  try {
    if (fs.existsSync(absLink) || isLink(absLink)) return { ok: false, already: true, error: '这个位置已经有东西了' };
  } catch {
    /* ignore */
  }
  let stat = null;
  try {
    stat = fs.statSync(absTarget);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) return { ok: false, error: '目标目录不存在' };
  fs.mkdirSync(path.dirname(absLink), { recursive: true });

  if (IS_WINDOWS) {
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `New-Item -ItemType Junction -Path ${psQuote(absLink)} -Target ${psQuote(absTarget)} | Out-Null`,
      `Write-Output 'ok'`,
    ].join('; ');
    const run = await runPowerShell(script, { timeoutMs: 20000 });
    if (!run.ok) return { ok: false, error: (run.stderr || run.stdout || '创建联接失败').trim() };
    // PowerShell 说成功但联接没落地的情况（老版本/策略限制）要当场发现，不能等审计报错
    if (!isLink(absLink)) return { ok: false, error: '联接没有创建成功（目录里看不到它）' };
    return { ok: true, path: absLink, target: absTarget };
  }

  try {
    fs.symlinkSync(absTarget, absLink, 'dir');
    if (!isLink(absLink)) return { ok: false, error: '软链没有创建成功' };
    return { ok: true, path: absLink, target: absTarget };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * 删一个目录联接。只删链接本身，绝不动目标里的文件。
 * 这里刻意不用 fs.rm(recursive)：递归删除在链接上的行为各平台不一致，风险太大。
 */
export function removeDirLink(linkPath) {
  const abs = path.resolve(linkPath);
  if (!isLink(abs)) return { ok: false, error: '这不是一个联接（不删真实目录）' };
  try {
    fs.unlinkSync(abs);
    return { ok: true };
  } catch (error) {
    try {
      fs.rmdirSync(abs);
      return { ok: true };
    } catch {
      return { ok: false, error: String(error?.message || error) };
    }
  }
}

/** 目录里是不是空的（链接不算递归，只看条目名）。 */
export function dirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/* --------------------------- 递归删除（自己走一遍） --------------------------- */

/**
 * 为什么不用 fs.rmSync({ recursive: true })：
 * Node 24 在 Windows 上遇到非 ASCII 路径（data/安徽、data/北京……）会静默失效——
 * 既不抛错，也不删任何东西，只在目录里留下原来那堆文件。实测 readdirSync /
 * unlinkSync / rmdirSync 对同样的路径全部正常，所以这里自己走一遍，不求快只求准。
 * 链接一律 unlink，绝不跟进去删目标。
 */
function removeOnce(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    // 联接/软链只删链接本身：Windows 上 unlink 对联接可能报 EPERM，退回 rmdir
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (!stat.isSymbolicLink()) throw error;
      fs.rmdirSync(target);
    }
    return;
  }
  for (const name of fs.readdirSync(target)) removeOnce(path.join(target, name));
  fs.rmdirSync(target);
}

/**
 * 删一个文件或目录树，失败会重试（杀毒/索引偶尔占句柄）。
 * 返回 { ok, attempts, error }；不抛异常，让调用方决定怎么报。
 */
export async function removeTree(target, { retries = 4, delayMs = 120 } = {}) {
  const abs = path.resolve(target);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      removeOnce(abs);
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (!fs.existsSync(abs)) return { ok: true, attempts: attempt + 1 };
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const hint = lastError?.code === 'ENAMETOOLONG'
    ? '（路径超长：Windows 需要打开「长路径」策略，或把材料放到更浅的目录）'
    : '';
  return {
    ok: false,
    attempts: retries + 1,
    error: `${String(lastError?.message || lastError || '删不掉')}${hint}`,
  };
}

/* --------------------------- POSIX 的镜像挂载 --------------------------- */

export const MOUNT_MARKER = '.dsh-mount.json';

/** 读镜像挂载的标记文件；不是工作台建的就返回 null（那就绝不递归删）。 */
export function readMountMarker(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MOUNT_MARKER), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * POSIX 上没有 junction，而技能用的是 `os.walk(root)`（followlinks=False），
 * 目录软链不会被下钻——挂上去等于没挂。所以这里建的是镜像：
 * 真实目录 + 逐文件软链。os.walk 能看到目录，open() 读到的是原件，一个字节都不复制。
 *
 * 代价是源目录增删文件后镜像会过期，要重跑 sync（面板上的「修复联接」）。
 */
export function mirrorDir(source, dest, { maxFiles = 80000 } = {}) {
  const absSource = path.resolve(source);
  const absDest = path.resolve(dest);
  let stat = null;
  try {
    stat = fs.statSync(absSource);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) return { ok: false, error: `源目录不存在：${absSource}` };
  try {
    fs.mkdirSync(absDest, { recursive: true });
  } catch (error) {
    return { ok: false, error: `建不了 ${absDest}：${error?.message || error}` };
  }

  let files = 0;
  let dirs = 0;
  let truncated = false;
  const failed = [];
  const seen = new Set();
  const walk = (srcDir, dstDir) => {
    // 源里如果有指向自己的链接，按真实路径去重，避免无限递归
    try {
      const real = fs.realpathSync(srcDir);
      if (seen.has(real)) return;
      seen.add(real);
    } catch {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.name === MOUNT_MARKER) continue;
      const from = path.join(srcDir, entry.name);
      const to = path.join(dstDir, entry.name);
      // 源里的目录软链也要当目录处理（isDirectory() 对链接是 false）
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(from);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue; // 断链
        }
      }
      if (isDir) {
        try {
          fs.mkdirSync(to, { recursive: true });
          dirs += 1;
        } catch (error) {
          failed.push(`${entry.name}: ${error?.message || error}`);
          continue;
        }
        walk(from, to);
        continue;
      }
      if (!isFile) continue;
      try {
        // 断链（existsSync 跟随链接，对断链返回 false）要先摘掉再重连，否则 symlink 会报 EEXIST
        const existing = fs.lstatSync(to, { throwIfNoEntry: false });
        if (existing && !fs.existsSync(to)) fs.unlinkSync(to);
        if (!existing || !fs.existsSync(to)) fs.symlinkSync(from, to, 'file');
        files += 1;
      } catch (error) {
        failed.push(`${entry.name}: ${error?.message || error}`);
      }
    }
  };
  walk(absSource, absDest);
  // 源里删掉/改名的文件，镜像里对应的软链也该消失，否则 data/ 会一直多出已经不存在的条目
  const pruned = pruneMirror(absDest);

  try {
    fs.writeFileSync(
      path.join(absDest, MOUNT_MARKER),
      `${JSON.stringify({ kind: 'mirror', source: absSource, files, dirs, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* 标记写不进去只影响后续识别，不影响读取；不为此失败 */
  }
  // 一条都没建成（Windows 没开发者模式、macOS 权限不足）时必须报失败：
  // 说「ok」却一个文件都没链过去，等于骗人去跑审计。
  const hardFail = files === 0 && failed.length > 0;
  return {
    ok: !hardFail,
    error: hardFail
      ? `建不了软链：${failed[0]}${process.platform === 'win32' ? '（Windows 需要开启开发者模式，或用管理员权限运行）' : ''}`
      : '',
    mode: 'mirror',
    files,
    dirs,
    failed: failed.slice(0, 10),
    partial: !hardFail && failed.length ? failed.length : 0,
    pruned: pruned.removed,
    truncated,
    path: absDest,
    target: absSource,
  };
}

/** 删掉镜像里「源已经没有了」的软链与空目录（镜像本身是可重建的，不留残影）。 */
export function pruneMirror(dest) {
  const abs = path.resolve(dest);
  let removed = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === MOUNT_MARKER) continue;
      const abs2 = path.join(dir, entry.name);
      let stat = null;
      try {
        stat = fs.lstatSync(abs2);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        // 断链 = 源里的文件被删/改名了：镜像里这一条也该消失
        if (!fs.existsSync(abs2)) {
          try {
            fs.unlinkSync(abs2);
            removed += 1;
          } catch {
            /* ignore */
          }
        }
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs2);
        try {
          if (!fs.readdirSync(abs2).length) {
            fs.rmdirSync(abs2);
            removed += 1;
          }
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(abs);
  return { ok: true, removed };
}

/** 删掉镜像目录。只删工作台自己建的（有标记文件），否则拒绝。 */
export async function removeMirror(dest) {
  const abs = path.resolve(dest);
  if (isLink(abs)) return removeDirLink(abs);
  const marker = readMountMarker(abs);
  if (!marker) return { ok: false, error: '这不是工作台建的镜像目录（没有标记文件），不删' };
  return removeTree(abs);
}

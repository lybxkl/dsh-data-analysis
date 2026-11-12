/**
 * 启动自检（preflight）：把「skill 在不在」「Python 和依赖装没装」变成可读的结论。
 *
 * 原则与闸门一致：判不了就说判不了。
 *   pass     检查过，确认可用
 *   fail     缺东西，会直接影响跑阶段
 *   warn     能用，但有降级（例如没有 pywin32 → Word 转 PDF 不可用）
 *   unjudged 前置条件不成立，这次没查到（例如 skill 没配好，就无从检查脚本）
 *
 * 只读、只探测：不安装任何东西，不改 skill，不写项目目录。
 */

import { spawn } from 'node:child_process';

import { DEFAULT_PYTHON, STAGE_DEFS } from './defaults.js';
import { IS_WINDOWS } from './platform.js';
import { fingerprint, resolveSkillRoot, scriptPath } from './skill.js';

export const MIN_PYTHON = [3, 9];

/**
 * Python 命令的候选顺序：配置优先，然后是各平台最常见的写法。
 * macOS 上 `python` 往往不存在（只有 python3），Windows 上反过来；不猜，逐个试。
 */
export function pythonCandidates(pythonPath) {
  const configured = String(pythonPath || '').trim();
  // Windows 上 python 可能不在 PATH 但 py 启动器在；顺序按「最常见」排，避免把能跑的 python 判成不可用
  const fallback = IS_WINDOWS ? ['python', 'py', 'python3'] : ['python3', 'python'];
  const list = [];
  const push = (value) => {
    const name = String(value || '').trim();
    if (name && !list.includes(name)) list.push(name);
  };
  push(configured);
  for (const name of fallback) push(name);
  return list;
}

/** SKILL.md 声明的第三方依赖（缺一个，对应阶段一定跑不动）。 */
export const REQUIRED_MODULES = [
  { id: 'pandas', label: 'pandas', why: '读 CSV / 统计宽表' },
  { id: 'numpy', label: 'numpy', why: '数值计算' },
  { id: 'scipy', label: 'scipy', why: '统计检验' },
  { id: 'statsmodels', label: 'statsmodels', why: 'OLS / Logistic 回归' },
  { id: 'matplotlib', label: 'matplotlib', why: '出版级图表' },
  { id: 'fitz', label: 'PyMuPDF (fitz)', why: 'PDF 文本层 / 字号核验' },
  { id: 'docx', label: 'python-docx', why: '读写成稿 .docx' },
  { id: 'openpyxl', label: 'openpyxl', why: 'Excel 资料与导出' },
  { id: 'PIL', label: 'Pillow (PIL)', why: '图片尺寸 / dpi 核验' },
];

const PROBE_CODE = `
import json, sys
info = {"python": sys.version.split()[0], "executable": sys.executable, "modules": {}, "word": False}
for name in ["pandas", "numpy", "scipy", "statsmodels", "matplotlib", "fitz", "docx", "openpyxl", "PIL"]:
    try:
        mod = __import__(name)
        info["modules"][name] = str(getattr(mod, "__version__", "ok"))
    except Exception:
        info["modules"][name] = None
try:
    import win32com.client  # noqa
    info["word"] = True
except Exception:
    info["word"] = False
print("@@PREFLIGHT@@" + json.dumps(info, ensure_ascii=False))
`;

function check(id, label, status, detail, hint = '') {
  return { id, label, status, detail, hint };
}

/** 跑一次 python -c，拿版本与依赖；超时/找不到都算 fail，并给出可操作提示。 */
export function probePython(pythonPath, { timeoutMs = 25000 } = {}) {
  const command = String(pythonPath || DEFAULT_PYTHON).trim() || DEFAULT_PYTHON;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, ['-c', PROBE_CODE], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: error?.message || String(error) });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* ignore */
      }
      finish({ ok: false, timeout: true, error: `探测超时（>${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: error?.code === 'ENOENT' ? `找不到可执行文件「${command}」` : error?.message || String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((row) => row.startsWith('@@PREFLIGHT@@'));
      if (code !== 0 || !line) {
        finish({ ok: false, exitCode: code, error: (err || out).trim().split(/\r?\n/).slice(-3).join(' ') || '无输出' });
        return;
      }
      try {
        finish({ ok: true, ...JSON.parse(line.slice('@@PREFLIGHT@@'.length)) });
      } catch (error) {
        finish({ ok: false, error: `探测输出无法解析：${error?.message || error}` });
      }
    });
  });
}

/**
 * 依次试候选命令，返回第一个能跑通的探测结果。
 * 只有全部失败时才算失败，并把每个候选的错误拼起来，方便用户看清到底缺什么。
 */
export async function probePythonAny(pythonPath, { timeoutMs = 25000 } = {}) {
  const tried = [];
  for (const command of pythonCandidates(pythonPath)) {
    const result = await probePython(command, { timeoutMs });
    if (result.ok) return { ...result, command, tried };
    tried.push({ command, error: result.error });
    // 超时通常意味着命令存在但环境有问题（conda 初始化慢等），再试别的意义不大
    if (result.timeout) break;
  }
  const first = tried[0] || { command: String(pythonPath || DEFAULT_PYTHON), error: '没有可用的 Python 命令' };
  return { ok: false, error: first.error, tried, command: first.command };
}

export function compareVersion(actual, min) {
  const parse = (value) => (Array.isArray(value) ? value : String(value || '').split(/[.\-+]/))
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
  const a = parse(actual);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

/** 阶段登记表里真正要跑的脚本（含 steps），去重。 */
export function expectedScripts(defs = STAGE_DEFS) {
  const names = new Set();
  for (const stage of defs) {
    if (stage.script) names.add(stage.script);
    for (const step of stage.steps || []) {
      if (step.script) names.add(step.script);
    }
  }
  return [...names];
}

export async function runPreflight({ skillRoot = '', pythonPath = 'python', defs = STAGE_DEFS } = {}) {
  const checks = [];
  const checkedAt = new Date().toISOString();

  const skill = resolveSkillRoot(skillRoot);
  let skillInfo = null;
  if (!skill.ok) {
    checks.push(
      check(
        'skill',
        '技能包',
        'fail',
        skill.configured ? `配置的 skillRoot 里找不到 ${'empirical-research-pipeline'}` : '还没有设置技能包目录',
        '在设置里填 SPSS-Style-Charting-Skill 仓库根或 empirical-research-pipeline 包目录',
      ),
    );
  } else {
    skillInfo = fingerprint(skill);
    checks.push(
      check(
        'skill',
        '技能包',
        'pass',
        `SKILL.md ${skillInfo.version} · ${skillInfo.files} 个脚本 · 布局 ${skill.layout}`,
        '',
      ),
    );
  }

  const wanted = expectedScripts(defs);
  if (!skill.ok) {
    checks.push(check('scripts', '阶段脚本', 'unjudged', '技能包未就位，无从检查', '先修好技能包目录'));
  } else {
    const missing = wanted.filter((rel) => !scriptPath(skill, rel));
    checks.push(
      missing.length
        ? check('scripts', '阶段脚本', 'fail', `缺少 ${missing.length} 个：${missing.join('、')}`, '技能包不完整，重新解压一份完整包')
        : check('scripts', '阶段脚本', 'pass', `${wanted.length} 个阶段脚本都在`, ''),
    );
  }

  const probe = await probePythonAny(pythonPath);
  if (!probe.ok) {
    const triedText = (probe.tried || []).map((item) => `${item.command}（${item.error}）`).join('；');
    checks.push(
      check(
        'python',
        'Python',
        'fail',
        probe.timeout ? probe.error : `试过 ${(probe.tried || []).length} 个命令都跑不起来：${triedText}`,
        IS_WINDOWS
          ? '把设置里的 Python 命令改成可执行的 python.exe（或 py），并确认能用 pip 装依赖'
          : '把设置里的 Python 命令改成 python3 的绝对路径（macOS 常是 /usr/bin/python3 或 Homebrew 的路径）',
      ),
    );
    checks.push(check('modules', 'Python 依赖', 'unjudged', 'Python 不可用，无从检查依赖', '先修好 Python'));
    if (IS_WINDOWS) checks.push(check('word', 'Word→PDF', 'unjudged', 'Python 不可用，无从检查', ''));
  } else {
    const versionOk = compareVersion(probe.python, MIN_PYTHON) >= 0;
    const switched = probe.command && probe.command !== String(pythonPath || '').trim();
    checks.push(
      check(
        'python',
        'Python',
        versionOk ? 'pass' : 'fail',
        `${probe.python} · ${probe.executable || probe.command}${switched ? `（配置里写的是 ${pythonPath}，实际用 ${probe.command}）` : ''}`,
        versionOk ? '' : `技能包要求 Python ${MIN_PYTHON.join('.')}+，请升级`,
      ),
    );

    const missing = REQUIRED_MODULES.filter((mod) => !probe.modules?.[mod.id]);
    const present = REQUIRED_MODULES.length - missing.length;
    checks.push(
      missing.length
        ? check(
            'modules',
            'Python 依赖',
            'fail',
            `缺 ${missing.length} 个：${missing.map((mod) => `${mod.label}（${mod.why}）`).join('、')}`,
            `用 ${probe.command || 'python'} -m pip install ${missing.map((mod) => (mod.id === 'fitz' ? 'PyMuPDF' : mod.id === 'docx' ? 'python-docx' : mod.id === 'PIL' ? 'Pillow' : mod.id)).join(' ')}`,
          )
        : check('modules', 'Python 依赖', 'pass', `${present}/${REQUIRED_MODULES.length} 可导入`, ''),
    );

    if (IS_WINDOWS) {
      checks.push(
        probe.word
          ? check('word', 'Word→PDF', 'pass', 'pywin32 可用（另需本机安装 Microsoft Word）', '')
          : check(
              'word',
              'Word→PDF',
              'warn',
              '缺 pywin32：Word 转 PDF 这一步不可用，其他阶段不受影响',
              '需要该能力时执行 pip install pywin32（并安装 Microsoft Word）',
            ),
      );
    } else {
      // macOS / Linux 没有 Word COM，pywin32 也装不上——这不是缺陷，是平台不提供这条通道
      checks.push(
        check(
          'word',
          'Word→PDF',
          'unjudged',
          `当前是 ${process.platform}：没有 Microsoft Word COM，这一步不适用`,
          '需要 PDF 时用 LibreOffice 另存（soffice --headless --convert-to pdf），或在本机 Word/WPS 里导出',
        ),
      );
    }
  }

  const failed = checks.filter((item) => item.status === 'fail');
  const warned = checks.filter((item) => item.status === 'warn');
  return {
    ok: failed.length === 0,
    status: failed.length ? 'fail' : warned.length ? 'warn' : 'pass',
    checkedAt,
    platform: process.platform,
    isWindows: IS_WINDOWS,
    python: probe.ok ? probe.python : '',
    pythonCommand: probe.ok ? probe.command : '',
    checks,
    skill: skillInfo
      ? { ok: true, version: skillInfo.version, sha256: skillInfo.sha256, scripts: skillInfo.files, root: skillInfo.root }
      : { ok: false, version: '', sha256: '', scripts: 0, root: '' },
  };
}
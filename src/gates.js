/**
 * 闸门判定。
 *
 * 三种状态，缺一不可：
 *   pass      有证据且达标
 *   fail      有证据且不达标（error 级会拦住下一步）
 *   unjudged  判不了（缺列、缺文件、缺文字层）——它**不是**通过
 *
 * 人工裁定只对声明了 manual 的闸门生效；机器能判的事实不允许被「改成通过」。
 */

import fs from 'node:fs';
import { applyGateReports } from './gate-report.js';
import { readGatePolicy } from './gate-report.js';
import { evaluateHostProject } from './gate-host.js';
import path from 'node:path';

import { analysisFile, assessPalette, readCsv, statOf } from './audit.js';
import { STAGE_DEFS } from './defaults.js';
import { verifyAuditRows } from './fingerprint.js';
import { recheckSummary } from './recheck.js';
import { evaluateAssert, projectPath } from './registry.js';
import { analyseInAnalysis, readSampleSettings } from './sample.js';
import { verifyMounts } from './sources.js';
import { readVisionLog } from './vision.js';

function gate(id, label, level, status, detail, extra = {}) {
  return { id, label, level, status, detail, ...extra };
}

/** 目标路径是否落在 base 里面（含 base 本身）。 */
function inside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target || ''));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 台账里存的是 ISO UTC：面板读起来像乱码，缩短成 MM-DD HH:mm（本地时区）。 */
function shortTime(iso) {
  const text = String(iso || '');
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 逐格证据账：output/datasets/<id>/extract.meta.json（由 verify_source.py 写）。 */
function readLedgerMetas(projectRoot) {
  const base = path.join(projectRoot, 'output', 'datasets');
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = [];
  for (const entry of entries) {
    const rel = `output/datasets/${entry.name}/extract.meta.json`;
    const info = statOf(path.join(projectRoot, rel));
    if (!info.exists) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(projectRoot, rel), 'utf8').replace(/^\uFEFF/, ''));
      metas.push({ dataset: entry.name, file: rel, ...value });
    } catch (error) {
      metas.push({ dataset: entry.name, file: rel, error: String(error && error.message ? error.message : error).slice(0, 160) });
    }
  }
  return metas;
}

/**
 * 阶段声明的产物（project.json 的 stages[].outputs）：声明了没产出 → fail；
 * 没声明但阶段目录里有新产物 → warn（不许悄悄产出用户不知道的东西）。
 */
function declaredOutputs(project) {
  const list = [];
  for (const [stageId, stage] of Object.entries(project?.stages || {})) {
    for (const rel of Array.isArray(stage?.outputs) ? stage.outputs : []) {
      if (typeof rel === 'string' && rel.trim()) list.push({ stageId, rel: rel.trim() });
    }
  }
  return list;
}

function fileGate(id, label, file, { level = 'error', requireRows = false } = {}) {
  const abs = file.abs;
  const stat = statOf(abs);
  if (!stat.exists) return gate(id, label, level, 'fail', `${file.rel} 不存在`, { source: file.rel });
  if (requireRows) {
    const csv = readCsv(abs);
    if (!csv) return gate(id, label, level, 'fail', `${file.rel} 无法解析`, { source: file.rel });
    if (!csv.rows.length) return gate(id, label, level, 'fail', `${file.rel} 没有数据行`, { source: file.rel });
    return gate(id, label, level, 'pass', `${csv.rows.length} 行`, { source: file.rel });
  }
  return gate(id, label, level, 'pass', stat.size < 1024 ? `${stat.size} B` : `${Math.round(stat.size / 1024)} KB`, { source: file.rel });
}

/**
 * 编码阶段适不适用，由**资料形态**决定，不由阶段序号决定。
 *
 * 依据（skill）：make_coding_sheet.py 对 STRUCTURED_EXTS / kind=spreadsheet 直接跳过并提示
 * 「tabular/structured data; use auto_stats or CSV pipeline」。一份 25 行的 CSV 项目
 * 强行要求 coding_sheet.csv，只会让人以为流程坏了。
 *
 * 三道保险：
 *   - project.json 的 stages.coding.applicability = "required" → 始终适用（人要编码表格里的自由文本）；
 *   - = "not_applicable" → 必须与语料形态相符，否则 fail（不能拿登记绕过闸门）；
 *   - 默认 auto → 只有「审计到的有效资料全部是表格」才判不适用；已有编码表则视为适用。
 */
function codingApplicability(project, artifacts, root) {
  const profile = artifacts.corpusProfile || { known: false, mode: 'unknown', valid: 0, tabular: 0, documents: 0, sample: [] };
  const declared = String(project?.stages?.coding?.applicability || 'auto').toLowerCase();
  const hasSheet = statOf(path.join(root, 'output', 'coding', 'coding_sheet.csv')).exists;
  if (declared === 'required') {
    return { applicable: true, basis: 'project.json 的 stages.coding.applicability=required：按需要编码处理' };
  }
  if (declared === 'not_applicable' || declared === 'na') {
    if (!profile.known) {
      return { applicable: null, basis: '登记为不适用，但缺 output/audit/corpus_files.csv：无法核对语料形态' };
    }
    if (profile.mode !== 'tables') {
      return {
        applicable: null,
        basis: `登记为不适用，但审计里 ${profile.valid} 份有效资料中有 ${profile.documents + profile.other} 份不是表格（例如 ${(profile.sample || []).slice(0, 3).join('、') || '—'}）：与资料形态不符，判不了该不该编码`,
      };
    }
    return { applicable: false, basis: `项目显式登记不适用；审计里 ${profile.valid} 份有效资料全部是表格数据` };
  }
  if (hasSheet) return { applicable: true, basis: '已有编码表：按实际做过的工作处理' };
  if (!profile.known) {
    // 老项目可能没有 corpus_files.csv：保持原行为（要求编码表），不替它改成「不适用」
    return { applicable: true, basis: '缺审计账：无法判断语料形态，按需要编码处理' };
  }
  if (profile.mode === 'tables') {
    return {
      applicable: false,
      basis: `审计里 ${profile.valid} 份有效资料全部是表格数据（${(profile.sample || []).slice(0, 3).join('、')}）：skill 的 make_coding_sheet 会跳过它们，直接走统计流程`,
    };
  }
  return {
    applicable: true,
    basis: `${profile.documents} 份文本资料${profile.tabular ? ` + ${profile.tabular} 份表格` : ''}：需要编码`,
  };
}

/**
 * 项目契约版本。
 *
 * schemaVersion 1 的老项目：缺 research_registry.json 只判「判不了」，不拦——升级插件不能把旧项目搞红。
 * schemaVersion >= 2（新建项目）默认严格：缺注册表就是 fail，先登记再往下走。
 * 老项目要升级，在 project.json 里加 `"contract": {"version": 2, "mode": "strict"}` 即可。
 */
export function contractMode(project) {
  const mode = String(project?.contract?.mode || '').toLowerCase();
  if (mode === 'strict' || mode === 'legacy') return mode;
  return Number(project?.schemaVersion) >= 2 ? 'strict' : 'legacy';
}

export function evaluateProject({ projectRoot, project, artifacts, adjudications = {}, activeRuns = {}, runs = [], sources = [], pythonPath }) {
  if (readGatePolicy(projectRoot)?.mode === 'skill') {
    return evaluateHostProject({projectRoot, project, artifacts, adjudications, activeRuns, runs, sources,pythonPath});
  }
  const stages = [];
  const cancel = new Set();

  /** 最近一次运行：优先用宿主台账里的记录，project.json 里没有 runs 时不能当成「没跑过」。 */
  const lastRunOf = (stageId) => {
    const pool = (Array.isArray(runs) ? runs : []).filter((item) => item && item.stageId === stageId);
    if (!pool.length) {
      const legacy = (project?.runs || []).filter((item) => item && item.stageId === stageId);
      return legacy.length ? legacy[legacy.length - 1] : null;
    }
    return pool.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  };

  for (const def of STAGE_DEFS) {
    const gates = [];
    const root = projectRoot;
    const stageProject = project?.stages?.[def.id] || {};
    const manual = (gateId, label, detail) => {
      const decision = adjudications[gateId];
      const lastRun = lastRunOf(def.id);
      // 裁定之后阶段又跑过一次：产物变了，旧裁定不再是针对当前产物，必须退回「待裁定」。
      const stale = Boolean(
        decision && decision.at && lastRun?.endedAt && String(decision.at) < String(lastRun.endedAt),
      );
      if (decision && stale) {
        return gate(
          gateId,
          label,
          'warn',
          'unjudged',
          `上次裁定在 ${decision.at}，之后阶段又运行过（${lastRun.endedAt}）：裁定已失效，需对新产物重新确认`,
          { manual: true, stale: true },
        );
      }
      if (decision && decision.status === 'pass') {
        return gate(
          gateId,
          label,
          'warn',
          'pass',
          `人工裁定通过 · ${shortTime(decision.at)}${decision.note ? `：${decision.note}` : ''}`,
          { manual: true, decisionAt: decision.at || '', decisionNote: decision.note || '' },
        );
      }
      if (decision && decision.status === 'fail') {
        // 人明确说「不通过」就是拦住，不是一条提醒：放过去等于让 pipeline 覆盖人的判断
        return gate(
          gateId,
          label,
          'error',
          'fail',
          `人工裁定不通过 · ${shortTime(decision.at)}${decision.note ? `：${decision.note}` : ''}`,
          { manual: true, decisionAt: decision.at || '', decisionNote: decision.note || '' },
        );
      }
      return gate(gateId, label, 'warn', 'unjudged', detail || '需要人工裁定', { manual: true });
    };

    if (def.id === 'scope') {
      gates.push(fileGate('scope-doc', '范围与口径文档', { abs: path.join(root, 'docs', 'scope.md'), rel: 'docs/scope.md' }, { level: 'error' }));

      // 材料挂载：联接在不在、还指着当初那个目录、源是不是被放进了项目里面。
      // 老项目（没有 materials 字段）本来就是 data/ 里放文件，这里判 pass 而不是「判不了」。
      const mounts = Array.isArray(project?.materials?.mounts) ? project.materials.mounts : [];
      if (!mounts.length) {
        gates.push(gate('sources-mounted', '材料目录挂载', 'error', 'pass', '没有挂载材料目录（data/ 里的文件按项目自有材料处理）'));
        gates.push(gate('sources-outside', '材料目录在项目之外', 'error', 'pass', '没有挂载材料目录'));
      } else {
        const report = verifyMounts(root, { mounts });
        const bad = report.filter((item) => item.status !== 'ok');
        // Windows 上是目录联接，macOS/Linux 上是镜像目录（真实目录 + 逐文件软链）：文案要说清是哪一种
        const junctionCount = report.filter((item) => item.mode === 'junction').length;
        const mirrorCount = report.filter((item) => item.mode === 'mirror').length;
        const modeText = [junctionCount ? `${junctionCount} 条目录联接` : '', mirrorCount ? `${mirrorCount} 条镜像目录` : '']
          .filter(Boolean)
          .join(' + ');
        gates.push(
          bad.length
            ? gate('sources-mounted', '材料目录挂载', 'error', 'fail', `${bad.length}/${report.length} 条挂载失效：${bad.map((item) => `${item.as}（${item.detail || item.status}）`).join('；')}`, { mounts: report })
            : gate('sources-mounted', '材料目录挂载', 'error', 'pass', `${report.length} 条挂载有效（${modeText}，不复制文件）`, { mounts: report }),
        );
        const byId = new Map((Array.isArray(sources) ? sources : []).map((item) => [item.id, item]));
        const problems = [];
        for (const mount of mounts) {
          const source = byId.get(mount.sourceId);
          if (!source) {
            problems.push(`${mount.as}：材料库条目 ${mount.sourceId} 已经不在了`);
            continue;
          }
          const target = mount.entry ? path.join(source.path, ...String(mount.entry).split('/')) : source.path;
          if (inside(root, target)) problems.push(`${mount.as} → ${target}（在项目目录里）`);
        }
        gates.push(
          problems.length
            ? gate('sources-outside', '材料目录在项目之外', 'error', 'fail', problems.join('；'))
            : gate('sources-outside', '材料目录在项目之外', 'error', 'pass', `${mounts.length} 条挂载都指向项目外的材料目录`),
        );
      }
    }

    if (def.id === 'audit') {
      gates.push(fileGate('audit-flow', '样本流程 sample_flow', { abs: path.join(root, 'output', 'audit', 'sample_flow.csv'), rel: 'output/audit/sample_flow.csv' }, { requireRows: true }));
      const chain = artifacts.flow.find((c) => c.file.startsWith('output/audit/'));
      if (chain) {
        gates.push(
          chain.invalidKinds?.length
            ? gate('audit-monotonic', '漏斗单调不上升', 'error', 'fail', `${chain.invalidKinds.length} 行 kind 非法（${chain.invalidKinds.map((s) => `${s.stage}=${s.kind}`).slice(0, 3).join('、')}）：只认 stage / excluded / model，写错的值不能绕开单调性`, { source: chain.file })
            : chain.monotonic
              ? gate('audit-monotonic', '漏斗单调不上升', 'error', 'pass', chain.funnel.map((s) => `${s.stage} ${s.n}`).join(' → '), { source: chain.file })
              : gate('audit-monotonic', '漏斗单调不上升', 'error', 'fail', '有阶段数量比上一阶段更大（分母或口径混了）', { source: chain.file }),
        );
      } else {
        gates.push(gate('audit-monotonic', '漏斗单调不上升', 'error', 'unjudged', '没有 sample_flow，无法判断'));
      }
      const corpus = artifacts.corpus;
      gates.push(
        corpus
          ? gate('audit-summary', '审计摘要 corpus_summary', 'warn', 'pass', `有效资料 ${corpus.validFiles ?? '?'} / 总数 ${corpus.totalFiles ?? '?'}`, { source: corpus.file })
          : gate('audit-summary', '审计摘要 corpus_summary', 'warn', 'unjudged', '缺 output/audit/corpus_summary.json'),
      );
      // 去重计划是审计阶段的第二步：它失败不影响审计结论，但「有没有重复件、
      // 怎么处置」会缺一页。计划在就报数，不在就明说没跑成，别静默。
      const dedupe = artifacts.research?.dedupe;
      gates.push(
        dedupe?.exists
          ? gate('audit-dedupe', '去重计划 dedupe_plan.csv', 'warn', 'pass', `${dedupe.rows} 行 / ${dedupe.groups} 组重复件（只出计划，不动原件）`, { source: dedupe.file })
          : gate('audit-dedupe', '去重计划 dedupe_plan.csv', 'warn', 'unjudged', '还没有 output/audit/dedupe_plan.csv：dedupe_corpus.py 没跑成或还没跑（审计结论本身不受影响）', { source: 'output/audit/dedupe_plan.csv' }),
      );
      // 审计之后 data/ 又变了（典型：把 analysis.csv 写进了语料根）：审计结论已经过期。
      // 2026-11-13 的复核证明「文件数 + 字节数」不够：把原文 AAA 改成 BBB（同大小）仍然报通过。
      // 现在用审计账里的逐文件 md5 核对内容；没有账时只能比大小，那就如实判「判不了」。
      const fingerprint = corpus?.fingerprint;
      const current = artifacts.corpusCurrent;
      const auditFiles = artifacts.corpusFiles || { rows: [] };
      const legacy = analysisFile(root);
      const legacyHint = legacy.rel === 'data/analysis.csv'
        ? '；另外 analysis.csv 是分析宽表，放在语料根会被当成一份资料，建议移到 output/dataset/analysis.csv 后再重跑审计'
        : '';
      if (auditFiles.rows?.length) {
        const check = verifyAuditRows(root, auditFiles.rows, current);
        // 「只核到不可哈希的文件」不算核过：metadata/hidden/0 字节这些走的是大小分支，
        // check.checked 里包含了它们，所以这里按「有没有真正比过 md5」分开判。
        const hashedOnly = Math.max(0, check.checked - (check.unhashed || 0));
        const reasonText = check.reason === 'too-many-files'
          ? '语料文件超过 5000 份：逐文件内容校验没有做，先缩小语料根或分批审计'
          : check.reason === 'too-many-bytes'
            ? '语料超过 2GB：逐文件内容校验没有做，先缩小语料根或分批审计'
            : check.reason === 'inventory-truncated'
              ? 'data/ 文件超过 2 万，只扫到一部分：无法确认审计是否过期'
              : check.reason === 'checked-nothing'
                ? '审计账里没有一份能核内容的文件（全部不可哈希）：内容是否变过判不了'
                : '没有可用的审计账';
        if (check.skipped || check.reason === 'inventory-truncated') {
          gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'unjudged', reasonText));
        } else if (check.missing.length) {
          gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'error', 'fail', `审计之后有 ${check.missing.length} 份文件不在 data/ 了（${check.missing.slice(0, 3).join('、')}）：先重跑审计再往下走`, { source: 'output/audit/corpus_files.csv' }));
        } else if (check.extra.length) {
          gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'error', 'fail', `审计之后新增了 ${check.extra.length} 份文件（${check.extra.slice(0, 3).join('、')}）：新资料没有纳入审计，先重跑审计再往下走${legacyHint}`, { source: 'output/audit/corpus_files.csv' }));
        } else if (check.changed.length) {
          gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'error', 'fail', `${check.changed.length} 份文件的**内容**在审计之后变过（${check.changed.slice(0, 3).join('、')}；大小相同也会被 md5 抓到）：审计与编码的结论都已过期，先重跑审计`, { source: 'output/audit/corpus_files.csv' }));
        } else if (check.opaque.length) {
          gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'unjudged', `${check.opaque.length} 份可读文件在审计账里没有 md5（--no-hash 或哈希失败）：内容是否变过判不了；去掉 --no-hash 重跑审计再判`, { source: 'output/audit/corpus_files.csv' }));
        } else if (!hashedOnly) {
          gates.push(
            gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'unjudged', `审计账里 ${check.unhashed} 份文件按口径都不哈希（元数据/隐藏/0 字节/不可读）：没有一份能核内容，同大小改内容判不了`, { source: 'output/audit/corpus_files.csv' }),
          );
        } else {
          gates.push(
            gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'pass', `${hashedOnly} 份文件的大小与 md5 与审计快照逐份一致${check.unhashed ? `（另有 ${check.unhashed} 份按审计口径不哈希：元数据/隐藏/0 字节/不可读，只比大小）` : ''}`, { source: 'output/audit/corpus_files.csv' }),
          );
        }
      } else if (!fingerprint || !Number.isFinite(Number(fingerprint.files)) || !Number.isFinite(Number(fingerprint.bytes))) {
        gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'unjudged', '缺 corpus_summary 的 fingerprint：无法判断 data/ 是否变过', { source: 'output/audit/corpus_summary.json' }));
      } else if (current?.truncated) {
        gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'unjudged', 'data/ 文件过多（>2 万），只做了部分 stat，无法确认审计是否过期'));
      } else if (current && (Number(current.files) !== Number(fingerprint.files) || Number(current.bytes) !== Number(fingerprint.bytes))) {
        gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'error', 'fail', `data/ 已变化：审计时 ${fingerprint.files} 个文件 / ${fingerprint.bytes} 字节，现在 ${current.files} 个 / ${current.bytes} 字节；先重跑审计再往下走${legacyHint}`, { source: 'output/audit/corpus_summary.json' }));
      } else {
        gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'unjudged', `${current.files} 个文件 / ${current.bytes} 字节与审计快照一致，但缺 corpus_files.csv 的逐文件 md5：同大小改内容这件事判不了（重跑一次 audit_corpus.py 会生成这份账）`, { source: 'output/audit/corpus_summary.json' }));
      }
      if (corpus?.truncated) {
        gates.push(gate('audit-truncated', '扫描是否完整', 'warn', 'unjudged', 'corpus_summary.truncated=true：只扫了前 N 个文件，总数是下界', { source: corpus.file }));
      }
      if (corpus?.hashDisabled) {
        gates.push(gate('audit-hash', '去重口径', 'warn', 'unjudged', 'hash_disabled=true：唯一样本数退化为有效资料数', { source: corpus.file }));
      }
      // 有挂载材料时，来源账与选材清单必须跟着审计一起在：它们是「这些文件从哪来」的唯一凭据。
      const mountCount = Array.isArray(project?.materials?.mounts) ? project.materials.mounts.length : 0;
      if (mountCount) {
        const provCsv = readCsv(path.join(root, 'output', 'materials', 'provenance.csv'));
        gates.push(
          provCsv && provCsv.rows.length
            ? gate('materials-provenance', '材料来源 provenance', 'warn', 'pass', `${provCsv.rows.length} 行（源目录 / 联接目标 / 时间）`, { source: 'output/materials/provenance.csv' })
            : gate('materials-provenance', '材料来源 provenance', 'warn', 'fail', '有挂载材料但缺 output/materials/provenance.csv：重新挂载或点一次「修复联接」即可生成', { source: 'output/materials/provenance.csv' }),
        );
        const selCsv = readCsv(path.join(root, 'output', 'materials', 'selection.csv'));
        gates.push(
          selCsv && selCsv.rows.length
            ? gate('materials-selection', '选材清单 selection', 'warn', 'pass', `${selCsv.rows.length} 份材料各有 include/exclude 与理由`, { source: 'output/materials/selection.csv' })
            : gate('materials-selection', '选材清单 selection', 'warn', 'fail', '缺 output/materials/selection.csv 或没有数据行', { source: 'output/materials/selection.csv' }),
        );
        // 账要对得上：provenance 的行数应当等于审计扫到的文件数。
        // 对不上通常只有三种原因——挂了新目录还没重跑审计、data/ 里还有旧的副本、派生稿是审计之后才生成的。
        const scanned = Number(corpus?.totalFiles);
        if (provCsv && provCsv.rows.length && Number.isFinite(scanned) && scanned > 0) {
          const derivedRows = provCsv.rows.filter((row) => row.derived_from).length;
          if (provCsv.rows.length === scanned) {
            gates.push(
              gate('materials-provenance-cover', '来源账与审计对得上', 'warn', 'pass', `${provCsv.rows.length} 行，与审计扫描到的 ${scanned} 个文件一致${derivedRows ? `（其中派生稿 ${derivedRows} 份）` : ''}`, { source: 'output/materials/provenance.csv' }),
            );
          } else {
            gates.push(
              gate(
                'materials-provenance-cover',
                '来源账与审计对得上',
                'warn',
                'unjudged',
                `provenance 记了 ${provCsv.rows.length} 行，审计扫到 ${scanned} 个文件，差 ${Math.abs(provCsv.rows.length - scanned)}。常见原因：挂了新目录还没重跑审计 / data/ 里还留着旧副本 / 识图或另存转换之后没重跑审计。判不了，先重跑审计再看`,
                { source: 'output/materials/provenance.csv' },
              ),
            );
          }
        }
      }
    }

    if (def.id === 'coding') {
      const applicability = codingApplicability(project, artifacts, root);
      if (applicability.applicable === false) {
        gates.push(
          gate(
            'coding-applicable',
            '编码阶段是否适用',
            'warn',
            'na',
            `${applicability.basis}。本阶段按「不适用」处理，不要求 coding_sheet.csv；表格数据直接进入数据集/复核/统计（skill 阶段 1B）。要强制编码文本，把 project.json 的 stages.coding.applicability 改成 "required"`,
            { source: 'output/audit/corpus_files.csv', applicable: false, basis: applicability.basis },
          ),
        );
      } else if (applicability.applicable === null) {
        gates.push(gate('coding-applicable', '编码阶段是否适用', 'warn', 'unjudged', `${applicability.basis}；先重跑审计或改 project.json 的 stages.coding.applicability`, { source: 'output/audit/corpus_files.csv' }));
      } else {
        gates.push(gate('coding-applicable', '编码阶段是否适用', 'warn', 'pass', applicability.basis, { source: 'output/audit/corpus_files.csv' }));
      }
      if (applicability.applicable !== false) {
        // 判不了（applicability=null）时也要检查编码表：
        // 已有表说明活干过，缺表才是真缺失——不能因为「判不了适不适用」把缺表也放过去。
        gates.push(fileGate('coding-sheet', '编码表 coding_sheet.csv', { abs: path.join(root, 'output', 'coding', 'coding_sheet.csv'), rel: 'output/coding/coding_sheet.csv' }, { requireRows: true }));
      const codingChain = artifacts.flow.find((c) => c.file.startsWith('output/coding/'));
      const nonStage = codingChain?.other?.length ? `（另有 ${codingChain.other.length} 条非漏斗行：${codingChain.other.map((s) => s.stage).join('、')}）` : '';
      gates.push(
        codingChain
          ? codingChain.invalidKinds?.length
            ? gate('coding-flow', '编码阶段漏斗', 'error', 'fail', `${codingChain.invalidKinds.length} 行 kind 非法（${codingChain.invalidKinds.map((s) => `${s.stage}=${s.kind}`).slice(0, 3).join('、')}）：只认 stage / excluded / model`, { source: codingChain.file })
            : gate('coding-flow', '编码阶段漏斗', 'warn', 'pass', `${codingChain.first} → ${codingChain.last}${nonStage}`, { source: codingChain.file })
          : gate('coding-flow', '编码阶段漏斗', 'warn', 'unjudged', '缺 output/coding/sample_flow.csv'),
      );
      // 对账不看 stage 名字，看「文件集合」：名字是可以改的标签，集合才是语料本身。
      // 2026-11-11 的 spss_analysis 会话就是靠改首档名字把这条闸门变绿的——不能再留这个口子。
      const auditSet = artifacts.corpusSet?.valid;
      const codingPaths = artifacts.codingSet?.paths;
      if (auditSet && codingPaths) {
        const extra = [...codingPaths].filter((rel) => !auditSet.has(rel));
        const missing = [...auditSet].filter((rel) => !codingPaths.has(rel));
        if (extra.length) {
          const sample = extra.slice(0, 3).join('、');
          gates.push(gate(
            'coding-cross',
            '编码口径与审计对账',
            'error',
            'fail',
            `编码表里有 ${extra.length} 个文件不在审计语料中（${sample}${extra.length > 3 ? '…' : ''}）：两次 --root 或语料不是同一份`,
            { source: artifacts.codingSet.file },
          ));
        } else if (!missing.length) {
          gates.push(gate('coding-cross', '编码口径与审计对账', 'warn', 'pass', `两链文件集合逐条一致（${codingPaths.size}/${auditSet.size}）`, { source: artifacts.codingSet.file }));
        } else {
          const skippedMap = artifacts.skippedSet?.byPath || new Map();
          const untraced = missing.filter((rel) => !skippedMap.has(rel));
          const suspicious = missing.filter((rel) => /not listed in the --audit CSV/i.test(String(skippedMap.get(rel)?.reason || '')));
          if (untraced.length) {
            gates.push(gate(
              'coding-cross',
              '编码口径与审计对账',
              'warn',
              'unjudged',
              `编码表是审计集的真子集（${codingPaths.size}/${auditSet.size}），其中 ${untraced.length} 份没有排除留痕：是有意筛选还是漏编，需人工确认`,
              { source: artifacts.codingSet.file },
            ));
          } else if (suspicious.length) {
            gates.push(gate(
              'coding-cross',
              '编码口径与审计对账',
              'warn',
              'unjudged',
              `编码表比审计少 ${missing.length} 份；其中 ${suspicious.length} 份的排除原因是「不在审计 CSV 里」——通常是产物混进了语料目录，不是 --root 选错了`,
              { source: artifacts.codingSet.file },
            ));
          } else {
            gates.push(gate(
              'coding-cross',
              '编码口径与审计对账',
              'warn',
              'pass',
              `编码表是审计集的有意子集（${codingPaths.size}/${auditSet.size}），排除的 ${missing.length} 份均有 skipped_documents 留痕`,
              { source: artifacts.codingSet.file },
            ));
          }
        }
      } else {
        gates.push(gate('coding-cross', '编码口径与审计对账', 'warn', 'unjudged', '缺 corpus_files.csv 或 coding_sheet.csv 的 rel_path 列：无法逐条比对文件集合'));
      }
      const skipped = path.join(root, 'output', 'coding', 'skipped_documents.csv');
      if (!statOf(skipped).exists) {
        gates.push(gate('coding-skipped', '被排除文件逐条留痕', 'warn', 'unjudged', '缺 skipped_documents.csv：排除原因不可回溯'));
      } else {
        const entries = [...(artifacts.skippedSet?.byPath?.values?.() || [])];
        const confusing = entries.filter((item) => /not listed in the --audit CSV|wrong --root|another directory/i.test(item.reason || ''));
        gates.push(
          confusing.length
            ? gate(
              'coding-skipped',
              '被排除文件逐条留痕',
              'warn',
              'unjudged',
              `${confusing.length} 条排除理由写的是「不在审计清单里」：通常是 --root 与审计用的目录不一致，或语料根混进了非资料文件（例如 analysis.csv）；先核对 data/ 再重跑审计，不要把它当成正常筛选`,
              { source: 'output/coding/skipped_documents.csv' },
            )
            : gate('coding-skipped', '被排除文件逐条留痕', 'warn', 'pass', entries.length ? `${entries.length} 条排除都写了原因` : 'skipped_documents.csv 在（无排除）', { source: 'output/coding/skipped_documents.csv' }),
        );
      }
      }
    }

    if (def.id === 'dataset') {
      const registry = artifacts.registry || null;
      const registered = registry?.datasets?.rows?.length ? registry.datasets.rows : [];
      const analysisTarget = analysisFile(root);
      // 有注册表就按登记的数据集验收；没有注册表才退回「唯一宽表 output/dataset/analysis.csv」。
      // 这不是放松：注册表本身有 datasets-index 闸门（文件在、行数对、主键唯一）。
      const datasets = registered
        .map((item) => ({ id: item.id, rel: item.file, abs: projectPath(root, item.file), row: item }))
        .filter((item) => item.rel)
        .filter((item) => statOf(item.abs).exists);
      if (datasets.length) {
        gates.push(
          gate(
            'dataset-csv',
            '数据集文件',
            'error',
            'pass',
            `${datasets.length} 份登记的数据集都在：${datasets.slice(0, 3).map((item) => `${item.id}（${item.rel}）`).join('，')}${datasets.length > 3 ? '…' : ''}`,
            { source: 'output/datasets/index.json' },
          ),
        );
        const inCorpus = datasets.filter((item) => /^data\//i.test(String(item.rel).replace(/\\/g, '/')));
        gates.push(
          inCorpus.length
            ? gate('dataset-path', '数据集放在语料目录外', 'warn', 'unjudged', `${inCorpus.length} 份数据集在 data/（语料根）里：audit/coding 的 --root 就是 data，下一次审计会把它们当成资料；移到 output/datasets/ 后重跑审计`, { source: inCorpus[0].rel })
            : gate('dataset-path', '数据集放在语料目录外', 'warn', 'pass', `${datasets.length} 份数据集都不在语料根`),
        );
      } else {
        gates.push(fileGate('dataset-csv', '分析宽表 analysis.csv', analysisTarget, { requireRows: true }));
        // 宽表放在 data/（语料根）会污染下一次审计：audit/coding 的 --root 就是 data。
        // 还没有宽表时不表态——否则一个空项目会靠这条 pass 被误判成「干过活」。
        if (analysisTarget.exists) {
          gates.push(
            analysisTarget.rel === 'data/analysis.csv'
              ? gate('dataset-path', '宽表放在语料目录外', 'warn', 'unjudged', 'analysis.csv 在 data/（语料根）：audit/coding 的 --root 是 data，下一次审计会把它当成一份资料；建议移到 output/dataset/analysis.csv 后重跑审计', { source: analysisTarget.rel })
              : gate('dataset-path', '宽表放在语料目录外', 'warn', 'pass', `${analysisTarget.rel} 不在语料根`, { source: analysisTarget.rel }),
          );
        }
      }

      // in_analysis：逐份数据集核「纳入样本量 + 筛选是否真的生效 + 模型 N 有没有超」。
      // 只查配置里有没有 'in_analysis' 这个字符串是假证据，2026-11-13 的复核已复现两种误判。
      const settings = readSampleSettings(root);
      const targets = datasets.length
        ? datasets.map((item) => ({ id: item.id, rel: item.rel, abs: item.abs, row: item.row }))
        : (analysisTarget.exists ? [{ id: 'analysis', rel: analysisTarget.rel, abs: analysisTarget.abs, row: null }] : []);
      if (!targets.length) {
        gates.push(gate('dataset-flag', '分析样本标记 in_analysis', 'warn', 'unjudged', '没有可检查的数据集'));
        gates.push(gate('dataset-in-analysis', '排除样本不会被统计误吃', 'warn', 'unjudged', '没有可检查的数据集'));
      } else {
        const verdicts = [];
        for (const target of targets) {
          const csv = readCsv(target.abs);
          const hasFlag = Boolean(csv?.header?.some((name) => /^in_analysis$/i.test(String(name || '').trim())));
          const declaredN = Number(target.row?.inAnalysis?.n);
          if (hasFlag && Number.isFinite(declaredN)) {
            const included = csv.rows.filter((row) => String(row.in_analysis ?? '').trim() === '1').length;
            if (included !== declaredN) {
              verdicts.push({ id: target.id, state: 'fail', detail: `${target.id} 声明 inAnalysis.n=${declaredN}，实际 in_analysis=1 的行是 ${included}` });
              continue;
            }
          }
          const verdict = analyseInAnalysis({ csv, settings, models: artifacts.models, source: target.rel });
          verdicts.push({ id: target.id, ...verdict });
        }
        const flagsMissing = verdicts.filter((item) => /没有 in_analysis 列|没有可解析的分析宽表/.test(item.detail || ''));
        gates.push(
          flagsMissing.length
            ? gate('dataset-flag', '分析样本标记 in_analysis', 'warn', 'unjudged', `${flagsMissing.map((item) => item.id).join('、')} 没有 in_analysis 列：描述统计的样本量只能人工声明，排除样本也判不了`, { source: flagsMissing[0].id })
            : gate('dataset-flag', '分析样本标记 in_analysis', 'warn', 'pass', `${verdicts.length} 份数据集都有 in_analysis 列`, { source: targets[0].rel }),
        );
        const failed = verdicts.filter((item) => item.state === 'fail');
        const unknown = verdicts.filter((item) => item.state === 'unjudged');
        gates.push(
          failed.length
            ? gate('dataset-in-analysis', '排除样本不会被统计误吃', 'error', 'fail', failed.map((item) => `${item.id}：${item.detail}`).join('；'), { source: targets[0].rel, verdicts })
            : unknown.length
              ? gate('dataset-in-analysis', '排除样本不会被统计误吃', 'warn', 'unjudged', unknown.map((item) => `${item.id}：${item.detail}`).join('；'), { source: targets[0].rel, verdicts })
              : gate('dataset-in-analysis', '排除样本不会被统计误吃', 'warn', 'pass', verdicts.map((item) => `${item.id}：${item.detail}`).join('；'), { source: targets[0].rel, verdicts }),
        );
      }

      // qa_outputs --data 要求宽表里有一个键列（rel_path/relpath/file/path/doc_id/id），
      // 否则它报 input error——那是「没得查」，不是「查出来有问题」。提前在这里说清楚。
      const keyColumns = ['rel_path', 'relpath', 'file', 'path', 'doc_id', 'id'];
      for (const target of targets) {
        const csv = readCsv(target.abs);
        if (!csv?.header?.length) continue;
        if (target.row?.grainKeys?.length) break; // 注册表已声明主键，datasets-index 会单独校验唯一性
        const key = keyColumns.find((name) => csv.header.includes(name));
        gates.push(
          key
            ? gate('dataset-key', '宽表带来源键列', 'warn', 'pass', `${target.id} 的键列 ${key}：数字溯源能把每行追回资料`, { source: target.rel })
            : gate(
                'dataset-key',
                '宽表带来源键列',
                'warn',
                'fail',
                `${target.id} 没有 ${keyColumns.join(' / ')} 任一键列：qa_outputs 会报 input error，数字也追不回资料；补一列来源键（多来源可用 rel_path 存分号分隔的路径）`,
                { source: target.rel },
              ),
        );
        break; // 这条闸门只对「主分析表」判一次，避免多数据集时重复堆消息
      }

      // v2 契约：先看注册表在不在，再看「声明」和「实物」对不对得上。
      // 新项目（contract.mode=strict）缺注册表是 fail；老项目是 unjudged（迁移前照样能跑）。
      if (!registry) {
        gates.push(gate('datasets-index', '数据集注册表', 'warn', 'unjudged', '服务没有提供注册表视图：重启 DSH 后再看'));
      } else if (registry.datasets.error) {
        gates.push(
          gate('datasets-index', '数据集注册表', 'error', 'fail', `output/datasets/index.json 读不懂：${registry.datasets.error}`, {
            source: 'output/datasets/index.json',
          }),
        );
      } else if (!registry.datasets.exists) {
        gates.push(
          gate(
            'datasets-index',
            '数据集注册表',
            'warn',
            'unjudged',
            '还没有 output/datasets/index.json：在面板点「采纳现有产物」按现状生成，或用 data_analysis_register 登记（多数据集、多粒度都靠它）',
            { source: 'output/datasets' },
          ),
        );
      } else {
        const rows = registry.datasets.rows;
        const hard = registry.datasets.issues.filter((item) => item.severity !== 'warn');
        const missing = rows.filter((item) => item.file && !statOf(projectPath(root, item.file)).exists);
        const mismatch = [];
        for (const item of rows) {
          if (!item.file) continue;
          const csv = readCsv(projectPath(root, item.file));
          if (csv && item.rows && csv.rows.length !== item.rows) {
            mismatch.push(`${item.id} 声明 ${item.rows} 行 / 实际 ${csv.rows.length} 行`);
          }
        }
        const derived = registry.datasets.derivedFrom ? `；视图来自 ${registry.datasets.derivedFrom}（未另建 index.json）` : '';
        gates.push(
          hard.length
            ? gate('datasets-index', '数据集注册表', 'error', 'fail', `${hard.length} 条注册错误：${hard[0].where} —— ${hard[0].message}`, { source: 'output/datasets/index.json' })
            : missing.length
              ? gate('datasets-index', '数据集注册表', 'error', 'fail', `${missing.length} 份数据集文件不存在：${missing.slice(0, 3).map((item) => item.file).join('、')}`, { source: 'output/datasets/index.json' })
              : mismatch.length
                ? gate('datasets-index', '数据集注册表', 'error', 'fail', `声明与实物不一致：${mismatch.slice(0, 3).join('；')}`, { source: 'output/datasets/index.json' })
                : gate(
                    'datasets-index',
                    '数据集注册表',
                    'error',
                    'pass',
                    `${rows.length} 份数据集（${rows.slice(0, 3).map((item) => `${item.id} ${item.rows} 行/${item.columns.length} 列`).join('，')}${rows.length > 3 ? '…' : ''}）${derived}`,
                    { source: registry.datasets.derivedFrom ? registry.datasets.derivedFrom : 'output/datasets/index.json' },
                  ),
        );
      }
    }

    if (def.id === 'verify') {
      const research = artifacts.research || null;
      if (!research) {
        gates.push(
          gate('registry-present', '研究注册表 research_registry.json', 'warn', 'unjudged', '服务没有提供研究层视图：重启 DSH 后再看'),
          gate('verification-final', '逐格复核已完成（final）', 'error', 'unjudged', '服务没有提供研究层视图：重启 DSH 后再看'),
        );
      } else {
        const registry = research.registry;
        const strict = contractMode(project) === 'strict';
        // 1) 注册表：任意数量的数据集，各自声明主键 / 单位 / codebook / 证据账。
        if (!registry.exists) {
          gates.push(
            strict
              ? gate(
                  'registry-present',
                  '研究注册表 research_registry.json',
                  'error',
                  'fail',
                  '本项目的契约版本是 2（严格模式）：没有 research_registry.json。先按 references/12 登记至少一份数据集（id/path/key/unit/codebook/provenance），再跑 prepare/final；把 project.json 的 contract.mode 改成 "legacy" 才会按旧项目放行',
                  { source: 'research_registry.json', strict: true },
                )
              : gate(
                  'registry-present',
                  '研究注册表 research_registry.json',
                  'warn',
                  'unjudged',
                  '还没有 research_registry.json：本项目按旧契约（legacy）处理，可以继续跑；要交付「每格回源」，按 references/12 登记数据集、主键、codebook、provenance 与 review',
                  { source: 'research_registry.json' },
                ),
          );
        } else if (registry.error) {
          gates.push(gate('registry-present', '研究注册表 research_registry.json', 'error', 'fail', `读不懂：${registry.error}`, { source: registry.file }));
        } else {
          const hard = registry.issues.filter((item) => item.severity !== 'warn');
          const soft = registry.issues.filter((item) => item.severity === 'warn');
          gates.push(
            hard.length
              ? gate('registry-present', '研究注册表 research_registry.json', 'error', 'fail', `${hard.length} 条注册错误：${hard[0].message}`, { source: registry.file })
              : gate(
                  'registry-present',
                  '研究注册表 research_registry.json',
                  'warn',
                  'pass',
                  `${registry.datasets.length} 份数据集：${registry.datasets.slice(0, 3).map((item) => `${item.id}${item.rows !== null ? ` ${item.rows} 行` : ''}${item.key.length ? `（键 ${item.key.join('+')}）` : ''}`).join('，')}${registry.datasets.length > 3 ? '…' : ''}${soft.length ? `；${soft.length} 条提醒（codebook 等）` : ''}`,
                  { source: registry.file },
                ),
          );
        }

        // 2) 逐格复核：prepare 只是「模板」，final + verified + 0 error 才能让数据进统计。
        const verification = research.verification;
        if (!registry.exists) {
          gates.push(
            strict
              ? gate('verification-final', '逐格复核已完成（final）', 'error', 'fail', '严格模式要求全格复核：先登记 research_registry.json，再跑 prepare → 逐格复读 → final', { source: 'research_registry.json', strict: true })
              : gate('verification-final', '逐格复核已完成（final）', 'error', 'unjudged', '没有 research_registry.json：不知道要复核哪些数据集（旧契约不拦）', { source: 'research_registry.json' }),
          );
        } else if (!verification.exists) {
          gates.push(
            gate(
              'verification-final',
              '逐格复核已完成（final）',
              'error',
              'unjudged',
              '还没有 output/data_verification/dataset_verification.json：先跑本阶段 prepare，再逐格复核、跑 data_analysis_verify_dataset(action=final)',
              { source: 'output/data_verification' },
            ),
          );
        } else if (verification.error) {
          gates.push(gate('verification-final', '逐格复核已完成（final）', 'error', 'fail', verification.error, { source: verification.file }));
        } else if (verification.stage !== 'final') {
          gates.push(
            gate(
              'verification-final',
              '逐格复核已完成（final）',
              'error',
              'unjudged',
              `现在是 prepare：${verification.cellCount ?? '?'} 格已生成待核模板，但还没有逐格复读。把 review_template_*.jsonl 核完，再跑 data_analysis_verify_dataset(action=final)`,
              { source: verification.file },
            ),
          );
        } else if (verification.status !== 'verified' || verification.errorCount !== 0) {
          gates.push(
            gate(
              'verification-final',
              '逐格复核已完成（final）',
              'error',
              'fail',
              `final 复核没通过：status=${verification.status || '?'} / error ${verification.errorCount ?? '?'} 条，先按 cell_issues.csv 修数据或证据`,
              { source: verification.file },
            ),
          );
        } else {
          gates.push(
            gate(
              'verification-final',
              '逐格复核已完成（final）',
              'error',
              'pass',
              `${verification.cellCount ?? '?'} 格逐格复核通过（script ${verification.scriptVersion || '?'}）`,
              { source: verification.file },
            ),
          );
        }

        // 3) 复核是否还对得上当前原件：原件/数据集/证据账/回执 任一改动都会让 final 作废。
        if (!verification.exists) {
          gates.push(gate('verification-fresh', '复核版本仍然有效', 'error', 'unjudged', '还没有复核报告'));
        } else if (verification.stale.length) {
          gates.push(
            gate(
              'verification-fresh',
              '复核版本仍然有效',
              'error',
              'fail',
              `复核之后又改过：${verification.stale.slice(0, 4).join('、')}${verification.stale.length > 4 ? '…' : ''}——旧复核作废，重建数据后重跑 prepare/final`,
              { source: verification.file },
            ),
          );
        } else if (verification.stage !== 'final') {
          gates.push(gate('verification-fresh', '复核版本仍然有效', 'warn', 'unjudged', '还没 final，暂不比较'));
        } else if (verification.freshness === 'content' && verification.bindingCheck?.skipped) {
          gates.push(
            gate(
              'verification-fresh',
              '复核版本仍然有效',
              'warn',
              'unjudged',
              `复核绑定文件太多（${verification.bindingCheck.reason || '超限'}）：${verification.bindingCheck.checked}/${verification.bindingCheck.total} 个文件核过内容哈希，剩下的判不了；缩小语料再复核`,
              { source: verification.file },
            ),
          );
        } else if (!verification.bindingCheck?.total) {
          // 没核过任何绑定 ≠ 核过且一致：不能因为 stale 为空就判通过。
          gates.push(gate('verification-fresh', '复核版本仍然有效', 'warn', 'unjudged', '没有可核对的内容绑定（bindings 为空）：原件是否变过判不了', { source: verification.file }));
        } else if (verification.freshness === 'content') {
          gates.push(
            gate(
              'verification-fresh',
              '复核版本仍然有效',
              'warn',
              'pass',
              `${verification.bindingCheck?.checked ?? '?'} 个绑定（原始资料 / 数据集 / codebook / 证据账 / 适配器）逐项 sha256 一致${verification.bindingCheck?.reviewChecked ? `，另有 ${verification.bindingCheck.reviewChecked} 份复核记录一致` : ''}`,
              { source: verification.file },
            ),
          );
        } else {
          // 旧报告 / 手写报告只有 mtime：文件被 touch 或少改都能混过去，不能当「同上」。
          gates.push(
            gate(
              'verification-fresh',
              '复核版本仍然有效',
              'warn',
              'unjudged',
              '这份复核报告没有 verification_snapshot.json 的内容绑定，只能比较修改时间：无法证明原件内容没变；用当前 skill 重跑 prepare/final',
              { source: verification.file },
            ),
          );
        }

        // 4) 逐格问题清单：cell_issues.csv 里还有 error 就是没核完。
        if (!verification.exists) {
          gates.push(gate('verification-cells', '逐格问题清单', 'warn', 'unjudged', '还没有 cell_issues.csv'));
        } else if (verification.cellIssuesExists === false) {
          // 报告在、问题清单被删/没写：不能因为「读不到 error」就判通过。
          gates.push(gate('verification-cells', '逐格问题清单', 'warn', 'unjudged', 'dataset_verification.json 在，但同目录没有 cell_issues.csv：逐格问题判不了，重跑 prepare 生成'));
        } else if (verification.bySeverity.error) {
          gates.push(
            gate(
              'verification-cells',
              '逐格问题清单',
              'warn',
              'fail',
              `${verification.bySeverity.error} 条 error：${verification.issues.filter((row) => String(row.severity || '').toLowerCase() === 'error').slice(0, 3).map((row) => `${row.where || row.column || '?'} ${row.message || row.detail || ''}`.trim()).join('；')}`,
              { source: `${verification.file.replace(/dataset_verification\.json$/, '')}cell_issues.csv` },
            ),
          );
        } else if (verification.bySeverity.warning) {
          gates.push(gate('verification-cells', '逐格问题清单', 'warn', 'unjudged', `${verification.bySeverity.warning} 条 warning 还没裁定（未核 ≠ 通过）`, { source: 'output/data_verification/cell_issues.csv' }));
        } else {
          gates.push(gate('verification-cells', '逐格问题清单', 'warn', 'pass', 'cell_issues.csv 没有 error/warning', { source: 'output/data_verification/cell_issues.csv' }));
        }

        // 5) 来源覆盖：审计扫到的每份文件都要有处置（included / excluded / unreadable）。
        const coverage = research.coverage;
        if (!registry.exists) {
          gates.push(gate('source-coverage', '来源覆盖 source_coverage', 'warn', 'unjudged', '没有 research_registry.json：来源覆盖判不了'));
        } else if (!coverage.exists) {
          gates.push(
            gate(
              'source-coverage',
              '来源覆盖 source_coverage',
              'warn',
              'unjudged',
              `还没有 ${coverage.file}：每份原始资料都要写清 included / excluded / unreadable 与理由`,
              { source: coverage.file },
            ),
          );
        } else if (!artifacts.corpus) {
          gates.push(gate('source-coverage', '来源覆盖 source_coverage', 'warn', 'unjudged', '没有 output/audit/corpus_summary.json：不知道原始资料有多少份，覆盖完整不完整判不了', { source: coverage.file }));
        } else if (coverage.truncated) {
          gates.push(gate('source-coverage', '来源覆盖 source_coverage', 'warn', 'unjudged', 'source_coverage.jsonl 超过 5 万行，只读了前 5 万行：完整性判不了', { source: coverage.file }));
        } else {
          const hard = coverage.issues.filter((item) => item.severity !== 'warn');
          // 分母只该是「原始资料」：registry 登记在案的 codebook / provenance /
          // review / 数据集本身，以及 metadata、hidden 文件都不算待处置资料。
          const exempt = new Set();
          const sourceRoot = String(registry.sourceRoot || '').replace(/\/+$/, '');
          for (const rel of registry.auxPaths || []) {
            exempt.add(rel);
            // 覆盖账的来源是相对 source_root（审计根）的路径：data/x.csv 对
            // x.csv，materials/x.csv 对 x.csv。两套前缀都试，避免换目录就误判。
            if (sourceRoot && rel.startsWith(`${sourceRoot}/`)) exempt.add(rel.slice(sourceRoot.length + 1));
            if (rel.startsWith('data/')) exempt.add(rel.slice('data/'.length));
          }
          let derived = 0;
          for (const rel of artifacts.corpusSet?.all || []) {
            if (exempt.has(rel)) derived += 1;
          }
          const meta = Number(artifacts.corpus?.metadataFiles) || 0;
          const hidden = Number(artifacts.corpus?.hiddenFiles) || 0;
          const rawScanned = Number(artifacts.corpus?.totalFiles);
          const scanned = Number.isFinite(rawScanned) && rawScanned > 0
            ? Math.max(0, rawScanned - derived - meta - hidden)
            : 0;
          const covered = coverage.effective ?? coverage.total ?? 0;
          const missing = scanned > 0 ? scanned - covered : 0;
          const extra = scanned > 0 && covered > scanned ? covered - scanned : 0;
          gates.push(
            coverage.broken.length
              ? gate('source-coverage', '来源覆盖 source_coverage', 'warn', 'fail', `${coverage.broken.length} 行 JSONL 读不懂（第 ${coverage.broken[0].line} 行）`, { source: coverage.file })
              : hard.length
                ? gate('source-coverage', '来源覆盖 source_coverage', 'warn', 'fail', `${hard.length} 条覆盖错误：${hard[0].where} —— ${hard[0].message}`, { source: coverage.file })
                : extra > 0
                  ? gate(
                      'source-coverage',
                      '来源覆盖 source_coverage',
                      'warn',
                      'fail',
                      `覆盖账有 ${covered} 行，比审计的 ${scanned} 份原始资料多 ${extra} 行：多半是旧文件或路径写法不一致，先删/改对再判`,
                      { source: coverage.file },
                    )
                : missing > 0
                  ? gate(
                      'source-coverage',
                      '来源覆盖 source_coverage',
                      'warn',
                      'fail',
                      `审计扫到 ${scanned} 份原始资料，覆盖账只有 ${covered} 份：还有 ${missing} 份没有处置`,
                      { source: coverage.file },
                    )
                  : gate(
                      'source-coverage',
                      '来源覆盖 source_coverage',
                      'warn',
                      'pass',
                      `${covered} 份资料：included ${coverage.countsEffective?.included ?? coverage.counts.included} / excluded ${coverage.countsEffective?.excluded ?? coverage.counts.excluded} / unreadable ${coverage.countsEffective?.unreadable ?? coverage.counts.unreadable}`,
                      { source: coverage.file },
                    ),
          );
        }
      }
    }

    if (def.id === 'stats') {
      const models = artifacts.models;
      if (models.models.length) {
        const lines = models.models.map((m) => `${m.id} N=${m.fitN ?? m.n ?? '?'}`);
        gates.push(
          gate('stats-models', '模型系数表', 'error', 'pass', `${models.models.length} 个模型（${models.dir}）· ${lines.slice(0, 4).join('，')}${models.aggregate ? '；另有 coef_all.csv（合并表，不计入模型数）' : ''}`, { source: models.dir }),
        );
        const mismatched = models.models.filter((m) => m.fitN !== null && m.n !== null && m.fitN !== m.n);
        // 数据改了、模型没重跑：系数表还是上一版样本的。以最新的模型产物为准，
        // 分析表比它还新就判「过期」，别让旧系数混进终检。
        const modelMtimes = models.models
          .map((m) => (m.file ? statOf(path.join(root, m.file)).mtimeMs || 0 : 0))
          .filter((value) => value > 0);
        const newestModel = modelMtimes.length ? Math.max(...modelMtimes) : 0;
        if (newestModel && Number(artifacts.analysisCsv?.mtimeMs) > newestModel + 1000) {
          gates.push(gate('stats-fresh', '模型是否对应这版数据', 'warn', 'unjudged', '分析表比模型系数表新：模型还是上一版数据估的，重跑第 6 阶段', { source: models.dir }));
        }
        gates.push(
          mismatched.length
            ? gate(
                'stats-fit-n',
                '模型 N 取 fit.n',
                'warn',
                'fail',
                `${mismatched.length} 个模型 coef.n 与 fit.n 不一致（${mismatched.map((m) => `${m.id} ${m.n}/${m.fitN}`).join('，')}）：以 fit.n 为准`,
                { source: models.dir },
              )
            : gate(
                'stats-fit-n',
                '模型 N 取 fit.n',
                'warn',
                models.fits.length ? 'pass' : 'unjudged',
                models.fits.length ? '已找到 fit.csv，N 以它为口径' : '缺 fit.csv：只能用 coef 表里的 n，且 n_dropna 不是 N',
                { source: models.dir },
              ),
        );
      } else if (models.meta) {
        gates.push(gate('stats-models', '模型系数表', 'error', 'unjudged', '有 model_meta.json 但没有 coef_*.csv', { source: models.dir }));
      } else {
        gates.push(gate('stats-models', '模型系数表', 'error', 'fail', '没有 output/models/coef_*.csv', { source: 'output/models' }));
      }
      if (Array.isArray(models.flowChecks) && models.flowChecks.length) {
        const bad = models.flowChecks.filter((item) => item && item.match === false);
        gates.push(
          gate(
            'stats-flow',
            '模型 N 与漏斗一致',
            'warn',
            bad.length ? 'fail' : 'pass',
            bad.length ? `${bad.length} 个模型 N 与漏斗对不上` : `${models.flowChecks.length} 项一致`,
            { source: 'output/models/model_meta.json' },
          ),
        );
      } else {
        gates.push(gate('stats-flow', '模型 N 与漏斗一致', 'warn', 'unjudged', '缺 model_meta.json 的 flow_checks'));
      }

      // v2：模型注册表 + 普查表。老项目没有这两样，判「判不了」，不拦。
      const registry = artifacts.registry || null;
      if (!registry) {
        gates.push(gate('models-index', '模型注册表', 'warn', 'unjudged', '服务没有提供注册表视图：重启 DSH 后再看'));
        gates.push(gate('models-sweep', '模型族普查', 'warn', 'unjudged', '服务没有提供注册表视图：重启 DSH 后再看'));
      } else {
        if (registry.models.error) {
          gates.push(gate('models-index', '模型注册表', 'error', 'fail', `output/models/index.json 读不懂：${registry.models.error}`));
        } else if (!registry.models.exists) {
          gates.push(
            gate('models-index', '模型注册表', 'warn', 'unjudged', '还没有 output/models/index.json：在面板点「采纳现有产物」，或用 data_analysis_register 登记（估计量/族/N/剔除原因）', { source: 'output/models' }),
          );
        } else {
          const rows = registry.models.rows;
          const hard = registry.models.issues.filter((item) => item.severity !== 'warn');
          const missingCoef = rows.filter((item) => item.coef && !statOf(projectPath(root, item.coef)).exists);
          const badN = rows.filter((item) => item.n !== null && item.n < 0);
          const inconsistent = [];
          const orphan = [];
          for (const item of rows) {
            if (!item.dataset) continue;
            const dataset = registry.datasets.rows.find((entry) => entry.id === item.dataset);
            if (!dataset) {
              // 模型挂在一张没登记的表上：N 从哪来就说不清了，不能当通过
              orphan.push(`${item.id} → ${item.dataset}`);
              continue;
            }
            const base = dataset.inAnalysis?.n;
            if (Number.isFinite(base) && Number.isFinite(item.n) && Number.isFinite(item.dropped) && base - item.dropped !== item.n) {
              inconsistent.push(`${item.id}: ${base} - ${item.dropped} ≠ ${item.n}`);
            }
          }
          gates.push(
            hard.length
              ? gate('models-index', '模型注册表', 'error', 'fail', `${hard.length} 条注册错误：${hard[0].where} —— ${hard[0].message}`, { source: 'output/models/index.json' })
              : missingCoef.length
                ? gate('models-index', '模型注册表', 'error', 'fail', `${missingCoef.length} 个模型的系数表不存在：${missingCoef.slice(0, 3).map((item) => item.coef).join('、')}`, { source: 'output/models/index.json' })
                : badN.length
                  ? gate('models-index', '模型注册表', 'error', 'fail', `${badN.length} 个模型 N 为负：${badN.map((item) => item.id).join('、')}`, { source: 'output/models/index.json' })
                  : orphan.length
                    ? gate('models-index', '模型注册表', 'error', 'fail', `${orphan.length} 个模型挂在没登记的数据集上：${orphan.slice(0, 3).join('，')}——先登记那张表，或把 dataset 改成正确的 id`, { source: 'output/models/index.json' })
                    : inconsistent.length
                    ? gate('models-index', '模型注册表', 'error', 'fail', `模型 N 与数据集对不上：${inconsistent.slice(0, 3).join('；')}`, { source: 'output/models/index.json' })
                    : gate(
                        'models-index',
                        '模型注册表',
                        'error',
                        'pass',
                        `${rows.length} 个模型（${rows.slice(0, 4).map((item) => `${item.id} ${item.estimator || '?'} N=${item.n ?? '?'}`).join('，')}${rows.length > 4 ? '…' : ''}）`,
                        { source: 'output/models/index.json' },
                      ),
          );
        }

        if (registry.sweep.error) {
          gates.push(gate('models-sweep', '模型族普查', 'error', 'fail', `output/models/sweep.json 读不懂：${registry.sweep.error}`));
        } else if (!registry.sweep.exists) {
          gates.push(
            gate('models-sweep', '模型族普查', 'warn', 'unjudged', '还没有 output/models/sweep.json：跑 data_analysis_sweep，让每个结局把「哪些族估了/可估/估不了」都表态', { source: 'output/models' }),
          );
        } else {
          const sweep = registry.sweep.value;
          const hard = registry.sweep.issues.filter((item) => item.severity !== 'warn');
          const thin = sweep.outcomes.filter((item) => item.families.length < 2);
          const unknown = sweep.outcomes.flatMap((item) => item.families.filter((f) => f.status === 'unknown').map((f) => `${item.name}.${f.family}`));
          const blocked = sweep.outcomes.flatMap((item) => item.families.filter((f) => f.status === 'blocked'));
          // blocked 必须写 why（结构性不可估的理由），否则「估不了」就成了不用解释的免死金牌。
          const silentBlocked = blocked.filter((item) => !String(item.why || '').trim());
          // 只被「疑似」列撑起来的普查：codebook / registry / 模型登记都没声明结局时，
          // 普查表本身是猜的，不能拿来当「方法已交代」。
          const suspectOnly = sweep.outcomes.length > 0
            && sweep.outcomes.every((item) => String(item.source || '') === 'suspect');
          gates.push(
            hard.length
              ? gate('models-sweep', '模型族普查', 'error', 'fail', `${hard.length} 条普查错误：${hard[0].message}`, { source: 'output/models/sweep.json' })
              : silentBlocked.length
                ? gate('models-sweep', '模型族普查', 'error', 'fail', `${silentBlocked.length} 个族标了 blocked 却没写 why（${silentBlocked.slice(0, 3).map((item) => `${item.name ?? ''}.${item.family}`).join('、')}）：结构性不可估必须写清缺什么`, { source: 'output/models/sweep.json' })
                : suspectOnly
                  ? gate('models-sweep', '模型族普查', 'warn', 'unjudged', `普查表只覆盖了 ${sweep.outcomes.length} 个「按列名猜的」结局：在 codebook 里给结局写 outcome: true / outcome_type，或在 registry 的 datasets[].outcomes 里列出真正的结局变量，再重跑 data_analysis_sweep`, { source: 'output/models/sweep.json' })
                  : thin.length
                ? gate('models-sweep', '模型族普查', 'warn', 'unjudged', `${thin.length} 个结局只表态了 1 个族（${thin.map((item) => item.name).join('、')}）：至少要说明「另一个族为什么不用」`, { source: 'output/models/sweep.json' })
                : unknown.length
                  ? gate('models-sweep', '模型族普查', 'warn', 'unjudged', `${unknown.length} 个族状态还是 unknown：${unknown.slice(0, 4).join('、')}`, { source: 'output/models/sweep.json' })
                  : gate(
                      'models-sweep',
                      '模型族普查',
                      'warn',
                      'pass',
                      `${sweep.outcomes.length} 个结局、${sweep.outcomes.reduce((acc, item) => acc + item.families.length, 0)} 个族已表态${blocked.length ? `（${blocked.length} 个 blocked 已写原因）` : ''}`,
                      { source: 'output/models/sweep.json' },
                    ),
          );
        }
      }
    }

    // 模型计划（model_plan.jsonl）：候选不封顶，但每个候选都要有终态、依据与回执。
    // 没有 registry 的老项目不表态（unjudged），不拦。
    if (def.id === 'stats') {
      const research = artifacts.research || null;
      const plan = research?.plan;
      if (!research) {
        gates.push(gate('models-plan', '模型计划 model_plan.jsonl', 'warn', 'unjudged', '服务没有提供研究层视图：重启 DSH 后再看'));
      } else if (!research.registry?.exists) {
        gates.push(gate('models-plan', '模型计划 model_plan.jsonl', 'warn', 'unjudged', '没有 research_registry.json：模型计划是可选层（老项目不拦）', { source: plan?.file || 'output/model_plan.jsonl' }));
      } else if (!plan?.exists) {
        gates.push(
          gate(
            'models-plan',
            '模型计划 model_plan.jsonl',
            'warn',
            'unjudged',
            `还没有 ${plan?.file || 'output/model_plan.jsonl'}：每个候选模型要写清问题、数据要求、诊断、选择理由与终态（completed / insufficient_data / …）`,
            { source: plan?.file || 'output/model_plan.jsonl' },
          ),
        );
      } else if (plan.truncated) {
        gates.push(gate('models-plan', '模型计划 model_plan.jsonl', 'warn', 'unjudged', 'model_plan.jsonl 超过 2 万行，只读了前 2 万行：终态统计不完整', { source: plan.file }));
      } else {
        const hard = plan.issues.filter((item) => item.severity !== 'warn');
        const counts = Object.entries(plan.counts).map(([key, value]) => `${key} ${value}`).join(' / ');
        gates.push(
          plan.broken.length
            ? gate('models-plan', '模型计划 model_plan.jsonl', 'warn', 'fail', `${plan.broken.length} 行 JSONL 读不懂（第 ${plan.broken[0].line} 行）`, { source: plan.file })
            : hard.length
              ? gate('models-plan', '模型计划 model_plan.jsonl', 'warn', 'fail', `${hard.length} 条计划问题：${hard[0].where} —— ${hard[0].message}`, { source: plan.file })
              : gate('models-plan', '模型计划 model_plan.jsonl', 'warn', 'pass', `${plan.total ?? 0} 个候选（${counts}）`, { source: plan.file }),
        );
      }
    }

      // methods.json 是显式选择：选了却没产出报告，或报告比配置旧，都不叫「跑过」。
      if (def.id === 'stats' && fs.existsSync(path.join(root, 'methods.json'))) {
        const report = statOf(path.join(root, 'output', 'methods', 'methods_report.md'));
        const spec = statOf(path.join(root, 'methods.json'));
        gates.push(
          !report.exists || !report.size
            ? gate('methods-report', '方法包报告 methods_report', 'warn', 'unjudged', '有 methods.json，但没有 output/methods/methods_report.md（或文件为空）：methods_pack.py 没跑成', { source: 'output/methods/methods_report.md' })
            : report.mtimeMs + 1000 < spec.mtimeMs
              ? gate('methods-report', '方法包报告 methods_report', 'warn', 'unjudged', 'methods.json 在报告之后又改过：重跑第 6 阶段', { source: 'output/methods/methods_report.md' })
              : gate('methods-report', '方法包报告 methods_report', 'warn', 'pass', `已生成（${report.size} B）`, { source: 'output/methods/methods_report.md' }),
        );
      }

    if (def.id === 'figures') {
      const figures = artifacts.figures;
      // 契约：清单里 status 不是 ok 的行不是交付物，闸门的分母只数可交付行。
      const rows = Array.isArray(figures.deliverable) ? figures.deliverable : figures.rows;
      const skippedRows = Array.isArray(figures.skipped) ? figures.skipped : [];
      // 图是数据画的：分析表比清单新，图就可能还是上一版（清单里的 data_hash 是更硬的证据，
      // 但老清单常常没写；先用 mtime 把「明显过期」拦下来）。
      // 图是数据画的：分析表比清单新，图就可能还是上一版（清单里的 data_hash 是更硬的证据，
      // 但老清单常常没写；先用 mtime 把「明显过期」拦下来）。两份清单时取最晚的一份：
      // 较早那份过期不代表整套图过期，较晚那份过期才说明最后一批图没跟上数据。
      const manifestTimes = (Array.isArray(figures.manifests) && figures.manifests.length
        ? figures.manifests
        : (figures.file ? [{ file: figures.file, mtimeMs: statOf(path.join(root, figures.file)).mtimeMs }] : []))
        .map((item) => ({ file: item.file, mtimeMs: Number(item.mtimeMs) || 0 }));
      const manifestStat = manifestTimes.length
        ? manifestTimes.reduce((max, item) => (item.mtimeMs > max.mtimeMs ? item : max), manifestTimes[0])
        : { file: '', mtimeMs: 0 };
      if (manifestStat.file && Number(artifacts.analysisCsv?.mtimeMs) > Number(manifestStat.mtimeMs) + 1000) {
        gates.push(gate('fig-fresh', '图表是否对应这版数据', 'warn', 'unjudged', '分析表比图表清单新：图可能还是上一版数据画的，重跑第 7 阶段后再交付', { source: manifestStat.file }));
      }
      const erroredRows = Array.isArray(figures.errored) ? figures.errored : [];
      // paper.json 也是显式选择：选了却没有多面板清单（或清单比配置旧），
      // 不能因为 chart_pack 还有图就当作没这回事。
      if (fs.existsSync(path.join(root, 'paper.json'))) {
        const paperPath = path.join(root, 'output', 'figures', 'paper_figures_manifest.csv');
        const paperManifest = statOf(paperPath);
        const paperCsv = paperManifest.exists ? readCsv(paperPath) : null;
        const paperSpec = statOf(path.join(root, 'paper.json'));
        gates.push(
          !paperManifest.exists
            ? gate('fig-paper', '多面板图 paper_figures', 'warn', 'unjudged', '有 paper.json，但没有 output/figures/paper_figures_manifest.csv：paper_figures.py 没跑成', { source: 'output/figures/paper_figures_manifest.csv' })
            : !paperCsv?.rows?.length
              ? gate('fig-paper', '多面板图 paper_figures', 'warn', 'unjudged', '多面板清单是空的：paper.json 里的图一张都没出来', { source: 'output/figures/paper_figures_manifest.csv' })
              : paperManifest.mtimeMs + 1000 < paperSpec.mtimeMs
              ? gate('fig-paper', '多面板图 paper_figures', 'warn', 'unjudged', 'paper.json 在多面板清单之后又改过：重跑第 7 阶段', { source: 'output/figures/paper_figures_manifest.csv' })
              : gate('fig-paper', '多面板图 paper_figures', 'warn', 'pass', '多面板清单已生成且不比 paper.json 旧', { source: 'output/figures/paper_figures_manifest.csv' }),
        );
      }
      if (!rows.length) {
        gates.push(
          gate(
            'fig-manifest',
            '图表清单 chart_manifest.csv',
            'error',
            skippedRows.length + erroredRows.length ? 'unjudged' : 'fail',
            skippedRows.length + erroredRows.length
              ? `清单有 ${skippedRows.length + erroredRows.length} 行 status 不是 ok（skipped/error），没有一张可交付的图：先看 note 里的原因`
              : '没有找到图表清单',
            { source: figures.file || 'output/chart_pack' },
          ),
        );
      } else {
        const manifestNote = Array.isArray(figures.files) && figures.files.length > 1
          ? `（合并 ${figures.files.length} 份清单：${figures.files.map((item) => path.basename(String(item))).join('、')}）`
          : '';
        gates.push(gate('fig-manifest', '图表清单', 'error', 'pass', `${rows.length} 张可交付图${manifestNote}${skippedRows.length + erroredRows.length ? `（另有 ${skippedRows.length + erroredRows.length} 行 status≠ok，不计入分母）` : ''}`, { source: figures.file }));
        // 跳过（数据不适配）和渲染失败要分开说：前者不是错，后者是。
        if (skippedRows.length || erroredRows.length) {
          gates.push(
            gate(
              'fig-status',
              '清单里的非交付行',
              'warn',
              erroredRows.length ? 'fail' : 'pass',
              erroredRows.length
                ? `${erroredRows.length} 张渲染失败（${erroredRows.slice(0, 3).map((row) => `${row.id}：${row.status}`).join('，')}）：先修数据/配置再重跑本阶段`
                : `${skippedRows.length} 张因数据不适配被跳过（不是错，但没有出图）：交付时要说明为什么这些图缺`,
              { source: figures.file },
            ),
          );
        }
        const dpiRows = rows.filter((row) => row.effectiveDpi !== null);
        const dpiBad = dpiRows.filter((row) => row.effectiveDpi < 597);
        if (!dpiRows.length) {
          gates.push(gate('fig-dpi', '有效 dpi ≥ 597', 'error', 'unjudged', '所有可交付行都缺 px_width：无法折算有效 dpi'));
        } else {
          gates.push(
            gate(
              'fig-dpi',
              '有效 dpi ≥ 597',
              'error',
              dpiBad.length ? 'fail' : 'pass',
              dpiBad.length
                ? `${dpiBad.length}/${dpiRows.length} 张不达标（最低 ${Math.round(Math.min(...dpiBad.map((r) => r.effectiveDpi)))}）`
                : `${dpiRows.length} 张全部达标`,
            ),
          );
        }
        const fontRows = rows.filter((row) => row.minFontsize !== null);
        const fontBad = fontRows.filter((row) => row.minFontsize < 7.2);
        if (!fontRows.length) {
          gates.push(
            gate(
              'fig-font',
              '最小字号 ≥ 7.2 pt',
              'error',
              'unjudged',
              '清单没写 min_fontsize，qa 报告里也没有 PDF 实测：字号判不了。跑终检时传 --min-fontsize 7.2（插件默认已带），且要先出 PDF（export_pdf_hires）——qa_outputs 只能从 PDF 量实际安置字号',
            ),
          );
        } else {
          const byQa = fontRows.filter((row) => row.fontSource === 'qa').length;
          gates.push(
            gate(
              'fig-font',
              '最小字号 ≥ 7.2 pt',
              'error',
              fontBad.length ? 'fail' : 'pass',
              fontBad.length
                ? `${fontBad.length} 张 < 7.2pt（最低 ${Math.min(...fontBad.map((row) => row.minFontsize))}pt）`
                : `${fontRows.length} 张达标${byQa ? `（${byQa} 张是 PDF 实测安置字号）` : ''}`,
            ),
          );
        }
        const missing = rows.filter((row) => !row.pngExists);
        gates.push(
          missing.length
            ? gate('fig-files', '图片文件存在', 'error', 'fail', `${missing.length} 张可交付图的 PNG 缺失`, { source: figures.file })
            : gate('fig-files', '图片文件存在', 'error', 'pass', '全部命中', { source: figures.file }),
        );
        const paletteRows = rows.map((row) => ({ row, p: assessPalette(row.palette) }));
        const undeclared = paletteRows.filter((item) => item.p.state === 'unjudged');
        const paletteBad = paletteRows.filter((item) => item.p.state === 'fail');
        if (paletteBad.length) {
          gates.push(
            gate(
              'fig-palette',
              '配色灰度可分（ΔL* ≥ 10）',
              'error',
              'fail',
              `${paletteBad.length} 张声明的色环灰度不可分（最低 ΔL* ${Math.round(Math.min(...paletteBad.map((item) => item.p.min)) * 10) / 10}）：灰度打印会糊成一条线`,
              { source: figures.file },
            ),
          );
        } else {
          gates.push(
            gate(
              'fig-palette',
              '配色灰度可分（ΔL* ≥ 10）',
              'warn',
              undeclared.length ? 'unjudged' : 'pass',
              undeclared.length
                ? `${undeclared.length} 张未声明 palette 或只有单色：只能人工看图`
                : `全部已声明且最小 ΔL* ${Math.round(Math.min(...paletteRows.map((item) => item.p.min)) * 10) / 10}`,
              { source: figures.file },
            ),
          );
        }
      }
      // v2：图题。技能生成的题注常常只有「注：N=…」——读者看不到这张图画的是什么，
      // 而「有没有标题」是机器能判的，不该留给人肉看图。
      const spec = artifacts.manuscript?.spec || null;
      if (spec && spec.exists && !spec.error) {
        const missing = Array.isArray(spec.titlesMissing) ? spec.titlesMissing : [];
        gates.push(
          missing.length
            ? gate(
                'fig-title',
                '每张图有图题',
                'warn',
                'unjudged',
                `${missing.length}/${spec.figures} 张图没有图题（题注只有「注：」）：${missing.slice(0, 6).map((n) => `图 ${n}`).join('、')}${missing.length > 6 ? '…' : ''}；在 manuscript.json 的 caption 前补一句标题`,
                { source: 'manuscript.json' },
              )
            : gate('fig-title', '每张图有图题', 'warn', 'pass', `${spec.figures} 张图都有图题`),
        );
      } else {
        gates.push(gate('fig-title', '每张图有图题', 'warn', 'unjudged', '还没有可解析的 manuscript.json：图题判不了'));
      }
    }

    if (def.id === 'manuscript') {
      gates.push(fileGate('manuscript-docx', '成稿 output/manuscript.docx', { abs: path.join(root, 'output', 'manuscript.docx'), rel: 'output/manuscript.docx' }));
      // 闸门只查 docx 存在，所以「改了 manuscript.json 却没重新组装」会一直显示 done，
      // 读者拿到的还是旧稿。这里比一次 mtime，把这种静默不一致摆到台面上。
      const specStat = statOf(path.join(root, 'manuscript.json'));
      const docxStat = statOf(path.join(root, 'output', 'manuscript.docx'));
      if (specStat.exists && docxStat.exists && specStat.mtimeMs > docxStat.mtimeMs + 1000) {
        gates.push(
          gate(
            'manuscript-fresh',
            '手稿与成稿同步',
            'warn',
            'unjudged',
            `manuscript.json 比 output/manuscript.docx 新（${shortTime(new Date(specStat.mtimeMs).toISOString())} > ${shortTime(new Date(docxStat.mtimeMs).toISOString())}）——改完稿必须重跑第 8 阶段，否则交付的是旧稿`,
            { source: 'manuscript.json / output/manuscript.docx' },
          ),
        );
      }
      // 图重画了、docx 没重跑：Word 里嵌的还是旧图。清单 mtime 是这里能拿到的最硬证据。
      const figManifestStat = artifacts.figures?.file ? statOf(path.join(root, artifacts.figures.file)) : { exists: false, mtimeMs: 0 };
      if (figManifestStat.exists && docxStat.exists && figManifestStat.mtimeMs > docxStat.mtimeMs + 1000) {
        gates.push(gate('manuscript-figures', '图集与成稿同步', 'warn', 'unjudged', '图表清单比 output/manuscript.docx 新：成稿里嵌的可能还是旧图，重跑第 8 阶段', { source: artifacts.figures.file }));
      }

      // v2 三件：图被引用了吗、表是不是原表直贴、正文够不够撑起这些图。
      // 这三条都从 manuscript.json 直接算——不靠人读稿，也不靠「文件存在」蒙混。
      const spec = artifacts.manuscript?.spec || null;
      if (!spec || !spec.exists || spec.error) {
        gates.push(
          gate('fig-cited', '每张图在正文被引用', 'warn', 'unjudged', '还没有可解析的 manuscript.json：引用关系判不了'),
          gate('tbl-present', '表格经过编排', 'warn', 'unjudged', '还没有可解析的 manuscript.json：表格判不了'),
          gate('manuscript-body', '正文撑得起图集', 'warn', 'unjudged', '还没有可解析的 manuscript.json：正文体量判不了'),
        );
      } else {
        const total = Number(spec.figures) || 0;
        const uncited = Array.isArray(spec.uncitedFigures) ? spec.uncitedFigures : [];
        gates.push(
          !total
            ? gate('fig-cited', '每张图在正文被引用', 'warn', 'unjudged', '文稿里还没有图块：先跑图表阶段再组装')
            : uncited.length
              ? gate(
                  'fig-cited',
                  '每张图在正文被引用',
                  'warn',
                  'unjudged',
                  `${uncited.length}/${total} 张图正文从未引用：${uncited.slice(0, 8).map((n) => `图 ${n}`).join('、')}${uncited.length > 8 ? '…' : ''}；图集不是论文，正文至少要说明它们在讲什么`,
                  { source: 'manuscript.json' },
                )
              : gate('fig-cited', '每张图在正文被引用', 'warn', 'pass', `${total} 张图都在正文被引用`),
        );

        const widths = Array.isArray(spec.tableWidths) ? spec.tableWidths : [];
        const wide = widths.filter((item) => item.cols > 12 && !item.presentation);
        const deadTables = widths.filter((item) => item.exists === false);
        gates.push(
          !widths.length
            ? gate('tbl-present', '表格经过编排', 'warn', 'unjudged', '文稿里还没有表块')
            : deadTables.length
              ? gate(
                  'tbl-present',
                  '表格经过编排',
                  'warn',
                  'fail',
                  `${deadTables.length} 张表的 CSV 读不到（${deadTables.map((item) => `表 ${item.n}：${item.csv || '没写 csv'}`).join('，')}）：第 8 阶段会直接报 table csv not found`,
                  { source: 'manuscript.json' },
                )
              : wide.length
              ? gate(
                  'tbl-present',
                  '表格经过编排',
                  'warn',
                  'unjudged',
                  `${wide.length} 张表直接贴了原表（${wide.map((item) => `表 ${item.n}：${item.cols} 列`).join('，')}）：给 table 块加顶层 columns: [{col,label,fmt}] 选列，或先在 output/tables 里整理成论文表`,
                  { source: 'manuscript.json' },
                )
              : gate('tbl-present', '表格经过编排', 'warn', 'pass', `${widths.length} 张表都做过选列/编排${widths.some((item) => item.selectedBy === 'presentation') ? '（其中有用旧写法 presentation.columns 的，新稿请改成顶层 columns）' : ''}`),
        );

        const chars = Number(spec.paraChars) || 0;
        const perFigure = total ? Math.round((chars / total) * 10) / 10 : null;
        gates.push(
          !total
            ? gate('manuscript-body', '正文撑得起图集', 'warn', 'unjudged', '文稿里还没有图块')
            : chars < total * 80
              ? gate(
                  'manuscript-body',
                  '正文撑得起图集',
                  'warn',
                  'unjudged',
                  `正文 ${chars} 字 / ${total} 张图 = 每图约 ${perFigure} 字（低于 80）：这是图集，不是论文；把每张图在讲什么写进正文章节`,
                  { source: 'manuscript.json' },
                )
              : gate('manuscript-body', '正文撑得起图集', 'warn', 'pass', `正文 ${chars} 字 / ${total} 张图 = 每图约 ${perFigure} 字`),
        );
      }
    }

    if (def.id === 'qa') {
      const verify = artifacts.verify;
      const qaReports = artifacts.qa;

      // 识图文本的留痕口径：未人工核对的识别稿一旦进了数字溯源/质检记录，就只能判「判不了」。
      // 已经识别但还没核对，也同样不能算通过——「未核」不是「通过」。
      const visionRows = readVisionLog(root);
      if (visionRows.length) {
        const okRows = visionRows.filter((row) => row.status === 'ok');
        const pending = okRows.filter((row) => !row.human_verified);
        if (!okRows.length) {
          // 全是失败行：这不是「都核对过了」，是根本没有可用的识别结果
          gates.push(gate('qa-vision', '识图文本已人工核对', 'warn', 'unjudged',
            `识别日志有 ${visionRows.length} 行，但没有一行成功；逐页排除失败原因后重跑`));
        } else if (!pending.length) {
          gates.push(gate('qa-vision', '识图文本已人工核对', 'warn', 'pass', `${okRows.length} 页识别结果都已人工核对`));
        } else {
          const absOf = (rel) => (path.isAbsolute(String(rel || '')) ? String(rel) : path.join(root, String(rel || '')));
          const needles = new Set(['__识别稿']);
          for (const row of pending) {
            if (row.derived_rel) needles.add(row.derived_rel);
            if (row.rel_path) needles.add(row.rel_path);
          }
          const hits = [];
          const scanFile = (rel) => {
            if (!rel || hits.length) return;
            const abs = absOf(rel);
            try {
              const st = fs.statSync(abs);
              if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
              const text = fs.readFileSync(abs, 'utf8');
              for (const needle of needles) {
                if (needle && text.includes(needle)) {
                  hits.push(String(rel));
                  return;
                }
              }
            } catch {
              /* 文件不在或读不了：不算引用 */
            }
          };
          if (verify?.file) scanFile(verify.file);
          for (const report of Array.isArray(qaReports) ? qaReports : []) scanFile(report?.file);
          gates.push(
            gate(
              'qa-vision',
              '识图文本已人工核对',
              'warn',
              'unjudged',
              hits.length
                ? `${pending.length} 页识别结果还没人工核对，但已被 ${hits[0]} 引用：核对后用 data_analysis_vision（action=verify）打勾，或改回直读材料`
                : `${pending.length} 页识别结果还没人工核对；交付前要逐页核对并打勾`,
              { source: hits[0] || 'output/audit/vision_log.csv' },
            ),
          );
        }
      }
      if (verify) {
        const v05Errors = verify.counts.v05Error || 0;
        const inputOnly = verify.counts.error > 0 && (verify.counts.input || 0) >= verify.counts.error;
        gates.push(
          gate(
            'qa-numbers',
            '数字溯源无 error',
            'error',
            verify.counts.error ? (inputOnly ? 'unjudged' : 'fail') : v05Errors ? 'unjudged' : 'pass',
            inputOnly
              ? `error ${verify.counts.error} 条全部是输入类（缺文件/解析失败）：这是「没得查」，不是「查出来数字不对」，补齐 docx / manifest / sample_flow 后重跑`
              : verify.counts.error
                ? `error ${verify.counts.error} / warning ${verify.counts.warning} / info ${verify.counts.info}`
                : v05Errors
                  ? `其余检查没有 error；V-05 的 ${v05Errors} 条差异单列在下面（差异不等于数据错误，要按 fit.n 回查）`
                  : `error 0 / warning ${verify.counts.warning} / info ${verify.counts.info}`,
            { source: verify.file },
          ),
        );
        // V-05 契约（skill references/10-contracts.md §13）：
        // 以 fit.csv / coef 的 n 为实际估计 N；n_dropna 是因缺失剔除的行数，不参与比较。
        // 差异或无法核对都保留「待复核」，不能改数字消警，也不能当成低优先级规则。
        if (verify.v05Legacy) {
          gates.push(
            gate(
              'qa-v05',
              '模型样本量一致性（V-05）',
              'warn',
              'unjudged',
              verify.counts.deferred
                ? `verify_numbers 版本 ${verify.toolVersion || '未知'}（早于 1.0.1）：旧版把 n_dropna 当 N，这次 V-05 的 ${verify.counts.deferred} 条结果不可信。旧版字段语义错误，等待重新核查——用修复版重跑 verify_numbers 后再看`
                : `verify_numbers 版本 ${verify.toolVersion || '未知'}（早于 1.0.1）：本次没有产生 V-05 条目，无法确认它真的比较过 n。升级后重跑 verify_numbers 再判`,
              { source: verify.file },
            ),
          );
        } else if (v05Errors) {
          gates.push(
            gate(
              'qa-v05',
              '模型样本量一致性（V-05）',
              'warn',
              'unjudged',
              `${v05Errors} 条差异：同一 n_scope 的模型 N 不一致（${verify.v05Errors.slice(0, 2).map((row) => `${row.where || ''} ${row.expected || '?'} vs ${row.actual || '?'}`.trim()).join('；')}）。以 fit.csv / coef 的 n 为实际估计 N，逐模型说明样本范围与排除原因；差异不等于数据错误，也不许改写统计结果来消警`,
              { source: verify.file },
            ),
          );
        } else if (verify.counts.v05Unverifiable) {
          gates.push(
            gate(
              'qa-v05',
              '模型样本量一致性（V-05）',
              'warn',
              'unjudged',
              `${verify.counts.v05Unverifiable} 条无法核对（缺 n 或只有 n_dropna）：n_dropna 是剔除行数，不能当 N；补上实际估计样本 n 后重跑`,
              { source: verify.file },
            ),
          );
        } else {
          gates.push(
            gate(
              'qa-v05',
              '模型样本量一致性（V-05）',
              'warn',
              'pass',
              `本次 V-05 检查通过：${verify.toolVersion ? `verify_numbers ${verify.toolVersion}，` : ''}实际估计样本 n 跨表一致、无无法核对项（不代表所有数据来源与研究语义已验证）`,
              { source: verify.file },
            ),
          );
        }
      } else {
        gates.push(gate('qa-numbers', '数字溯源无 error', 'error', 'unjudged', '缺 number_issues.csv：没跑 verify_numbers 或没输出到 output/verify'));
      }
      // 终检报告是不是针对「现在这版」产物：docx、分析表、图表清单或 PDF
      // 在报告之后又改过，报告里的字号/页数/图表数就已经过期了。
      if (artifacts.qa?.length) {
        const report = artifacts.qa[0];
        const watch = [
          ['output/manuscript.docx', artifacts.manuscript?.mtimeMs],
          ['分析数据表', artifacts.analysisCsv?.mtimeMs],
          ['图表清单', artifacts.figures?.file ? statOf(path.join(root, artifacts.figures.file)).mtimeMs : 0],
          ['output/manuscript.pdf', statOf(path.join(root, 'output', 'manuscript.pdf')).mtimeMs],
        ].filter(([, mtime]) => Number(mtime) > 0);
        const newer = watch.filter(([, mtime]) => Number(report.mtimeMs) + 1000 < Number(mtime));
        gates.push(
          newer.length
            ? gate(
                'qa-fresh',
                '终检报告是否过期',
                'warn',
                'unjudged',
                `${newer.map(([name]) => name).join('、')} 在终检之后又改过：报告里的结论已过期，重跑第 9 阶段`,
                { source: `output/qa/${report.name}` },
              )
            : gate('qa-fresh', '终检报告是否过期', 'warn', 'pass', '终检之后 docx / 数据 / 图表清单都没有再改', { source: `output/qa/${report.name}` }),
        );
      }

      const reports = (qaReports || []).filter((entry) => entry && entry.json);
      if (!reports.length) {
        gates.push(gate('qa-report', '终检报告', 'warn', 'unjudged', '缺 output/qa/qa_report.json：qa_outputs 的报告没生成'));
      } else {
        const newest = reports.slice().sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
        const json = newest.json;
        const errors = Number(json.error_count ?? json.summary?.error_count ?? NaN);
        const warnings = Number(json.warning_count ?? json.summary?.warning_count ?? 0);
        if (!Number.isFinite(errors)) {
          gates.push(gate('qa-report', '终检报告', 'warn', 'unjudged', `${newest.name} 里没有 error_count，判不了它到底过没过`, { source: `output/qa/${newest.name}` }));
        } else {
          gates.push(
            gate(
              'qa-report',
              '终检报告无 error',
              errors ? 'error' : 'warn',
              errors ? 'fail' : 'pass',
              errors ? `${newest.name}：error ${errors} / warning ${warnings}` : `${newest.name}：error 0 / warning ${warnings}`,
              { source: `output/qa/${newest.name}` },
            ),
          );
        }
      }
      // Word→PDF 是交付物的一部分：docx 有了、pdf 没有，说明回填 600dpi 的那步
      // 没跑成（常见于没装 Word / pywin32）。不能因为 qa_outputs 没拿到 --pdf
      // 就把「没检查」当成「通过」。
      if (artifacts.manuscript?.exists && !statOf(path.join(root, 'output', 'manuscript.pdf')).exists) {
        gates.push(
          gate(
            'qa-pdf',
            'PDF 交付件',
            'warn',
            'unjudged',
            '有 output/manuscript.docx，但没有 output/manuscript.pdf：export_pdf_hires.py 没跑成（Windows 需要 Word + pywin32），终检也没做 PDF 侧检查',
            { source: 'output/manuscript.pdf' },
          ),
        );
      } else if (statOf(path.join(root, 'output', 'manuscript.pdf')).exists) {
        const pdfStat = statOf(path.join(root, 'output', 'manuscript.pdf'));
        const docxStat = statOf(path.join(root, 'output', 'manuscript.docx'));
        const figManifestStat = artifacts.figures?.file ? statOf(path.join(root, artifacts.figures.file)) : { exists: false, mtimeMs: 0 };
        // PDF 早于成稿或图集：里面还是旧图/旧排版。终检查的是一个过期文件，
        // 「通过」没有意义。
        const staleAgainst = [
          docxStat.exists && pdfStat.mtimeMs + 1000 < docxStat.mtimeMs ? 'output/manuscript.docx' : '',
          figManifestStat.exists && pdfStat.mtimeMs + 1000 < figManifestStat.mtimeMs ? artifacts.figures.file : '',
        ].filter(Boolean);
        // PDF 在还不够：终检必须真的查过它（qa_outputs --pdf）。只生成不检查，
        // 「通过」就只是 docx 侧的结论。
        const checked = Boolean(artifacts.qa?.[0]?.json?.checks?.pdf);
        gates.push(
          staleAgainst.length
            ? gate('qa-pdf', 'PDF 交付件', 'warn', 'unjudged', `PDF 早于 ${staleAgainst.join('、')}：里面还是旧图/旧排版，重跑第 8 阶段后再判`, { source: 'output/manuscript.pdf' })
            : checked
              ? gate('qa-pdf', 'PDF 交付件', 'warn', 'pass', 'output/manuscript.pdf 已生成，终检按 PDF 实测字号/位宽', { source: 'output/manuscript.pdf' })
              : gate('qa-pdf', 'PDF 交付件', 'warn', 'unjudged', 'output/manuscript.pdf 在，但最近一次 qa_report 没有 PDF 检查结果：重跑终检（插件会自动带 --pdf）后再判', { source: 'output/manuscript.pdf' }),
        );
      }

      const registry = artifacts.registry || null;

      // 逐格回源：数据集的每个关键格，能不能在原文里找到那句话。
      // 没有证据账不是错，是「判不了」——但只要有账，缺格就必须显形。
      const ledgers = readLedgerMetas(root);
      if (!ledgers.length) {
        gates.push(
          gate(
            'provenance-cells',
            '逐格回源',
            'warn',
            'unjudged',
            '还没有逐格证据账：跑 data_analysis_verify_source（mode=build），把「值 → 原文引文 + 页 + 字符区间」写进 output/datasets/<id>/extract.jsonl',
            { source: 'output/datasets' },
          ),
        );
      } else {
        const broken = ledgers.filter((meta) => meta.error);
        const thin = [];
        let cells = 0;
        let covered = 0;
        for (const meta of ledgers) {
          for (const field of Array.isArray(meta.fields) ? meta.fields : []) {
            const total = Number(field.cells) || 0;
            const hit = Number(field.covered) || 0;
            // 源文件读不出文字的格子（扫描件/加密/损坏）不进分母：
            // 它们不是「回源失败」，是「没得判」，单列一条 unjudged
            const unreadable = Number(field.unreadable) || 0;
            const judgeable = Math.max(0, total - unreadable);
            cells += judgeable;
            covered += hit;
            if (judgeable && hit / judgeable < 0.98) thin.push(`${meta.dataset}.${field.name} ${hit}/${judgeable}`);
          }
        }
        // 只回源了一部分行（试跑用了 --limit）不能算通过：证据账要覆盖整份数据集
        const partial = [];
        for (const meta of ledgers) {
          const dataset = registry?.datasets?.rows?.find((item) => item.id === meta.dataset);
          let total = Number(dataset?.rows) || 0;
          // 注册表没写 rows 时退回数 CSV：否则 --limit 跑出来的部分台账会被当成全量
          if (!total && dataset?.file) {
            const csv = readCsv(projectPath(root, dataset.file));
            if (csv) total = csv.rows.length;
          }
          const done = Number(meta.rows) || 0;
          if (total && done < total) partial.push(`${meta.dataset} ${done}/${total} 行`);
        }
        const missingCells = registry?.cells?.counts?.missing || 0;
        const unreadableCells = registry?.cells?.counts?.unreadable || 0;
        const shortCells = registry?.cells?.counts?.short || 0;
        gates.push(
          broken.length
            ? gate('provenance-cells', '逐格回源', 'warn', 'fail', `${broken.length} 份证据账读不懂：${broken[0].file} —— ${broken[0].error}`, { source: broken[0].file })
            : partial.length
              ? gate(
                  'provenance-cells',
                  '逐格回源',
                  'warn',
                  'unjudged',
                  `证据账只覆盖了部分行：${partial.join('，')}——去掉 --limit 重跑 data_analysis_verify_source，否则没回源的行等于没核`,
                  { source: 'output/datasets' },
                )
              : !cells
                ? gate(
                    'provenance-cells',
                    '逐格回源',
                    'warn',
                    'unjudged',
                    '证据账里一格都没核到（引文列是空的，或引文都短于 6 字）：先确认 provenance.quoteColumn 指对了列',
                    { source: 'output/datasets' },
                  )
                : thin.length
                ? gate(
                    'provenance-cells',
                    '逐格回源',
                    'warn',
                    'fail',
                    `${thin.length} 个字段回源率低于 98%：${thin.slice(0, 4).join('，')}——这些格子没有原文支撑，等于让模型自己说数`,
                    { source: 'output/datasets' },
                  )
                : missingCells
                  ? gate('provenance-cells', '逐格回源', 'warn', 'fail', `cell_checks.csv 里有 ${missingCells} 条 missing：引文在原文里找不到`, { source: registry?.cells?.file || 'output/verify/cell_checks.csv' })
                  : unreadableCells
                    ? gate(
                        'provenance-cells',
                        '逐格回源',
                        'warn',
                        'unjudged',
                        `${unreadableCells} 格的源文件读不出文字（扫描件没有文字层 / 加密 / 损坏）：这些格没得判，先把它们转成可读文本再重跑 data_analysis_verify_source`,
                        { source: registry?.cells?.file || 'output/verify/cell_checks.csv' },
                      )
                    : shortCells
                      ? gate(
                          'provenance-cells',
                          '逐格回源',
                          'warn',
                          'unjudged',
                          `${shortCells} 格的引文短于 6 字（如「有」「1」「。」）：太短定位不到原句，先换一个能定位的引文列或补足句子`,
                          { source: registry?.cells?.file || 'output/verify/cell_checks.csv' },
                        )
                      : gate('provenance-cells', '逐格回源', 'warn', 'pass', `${ledgers.length} 份证据账、${covered}/${cells} 格可回源（覆盖率 ≥ 98%，无 missing）`, { source: 'output/datasets' }),
        );
      }

      // 结论断言：每句结论绑证据，并且能机检真假。
      if (!registry) {
        gates.push(gate('provenance-claims', '结论与证据一致', 'warn', 'unjudged', '服务没有提供注册表视图：重启 DSH 后再看'));
      } else if (registry.claims.error) {
        gates.push(gate('provenance-claims', '结论与证据一致', 'warn', 'fail', `output/claims/claims.jsonl 读不懂：${registry.claims.error}`));
      } else if (!registry.claims.exists) {
        gates.push(
          gate(
            'provenance-claims',
            '结论与证据一致',
            'warn',
            'unjudged',
            '还没有 output/claims/claims.jsonl：把正文的关键结论登记成 {id, text, assert, evidence}，闸门才能机检「这句话和数据一致吗」',
            { source: 'output/claims' },
          ),
        );
      } else {
        const claims = registry.claims.rows;
        const brokenLines = (registry.claims.issues || []).filter((item) => item.code === 'jsonl.parse');
        if (brokenLines.length) {
          // 坏行不会进 claims.rows：不报出来，那条结论就静默消失了
          gates.push(
            gate('provenance-claims', '结论与证据一致', 'error', 'fail', `${brokenLines.length} 行 claims.jsonl 读不懂：${brokenLines.slice(0, 3).map((item) => item.where).join('、')}——这几条结论没参与机检，先修好 JSONL`, {
              source: 'output/claims/claims.jsonl',
            }),
          );
        } else if (!claims.length) {
          gates.push(gate('provenance-claims', '结论与证据一致', 'warn', 'unjudged', 'claims.jsonl 是空文件'));
        } else {
          let supported = 0;
          let waived = 0;
          const refuted = [];
          const unknown = [];
          for (const claim of claims) {
            if (claim.status === 'waived') {
              waived += 1;
              continue;
            }
            if (!claim.assert) {
              unknown.push(claim.id);
              continue;
            }
            const result = evaluateAssert(claim.assert, registry, { projectRoot: root });
            if (!result.ok) unknown.push(`${claim.id}（${result.error}）`);
            else if (result.pass) supported += 1;
            else refuted.push(`${claim.id}：${claim.text || claim.assert.left} → ${result.left} ${result.op} ${result.right} 不成立`);
          }
          gates.push(
            refuted.length
              ? gate('provenance-claims', '结论与证据一致', 'error', 'fail', `${refuted.length} 条结论与数据矛盾：${refuted.slice(0, 3).join('；')}`, { source: 'output/claims/claims.jsonl' })
              : unknown.length
                ? gate('provenance-claims', '结论与证据一致', 'warn', 'unjudged', `${unknown.length} 条结论没有可机检的 assert：${unknown.slice(0, 4).join('、')}（只能人工读）`, { source: 'output/claims/claims.jsonl' })
                : gate('provenance-claims', '结论与证据一致', 'warn', 'pass', `${supported} 条结论全部被数据支持${waived ? `（${waived} 条人工豁免）` : ''}`, { source: 'output/claims/claims.jsonl' }),
          );
        }
      }

      // 阶段声明了哪些产物：声明了没产出 → fail；这是「产物路径不再写死」的落地方式。
      const declared = declaredOutputs(project);
      if (registry?.artifacts?.error) {
        gates.push(
          gate('artifacts-declared', '阶段产物声明', 'warn', 'fail', `output/artifacts/index.json 读不懂：${registry.artifacts.error}——产物声明现在是空的，先把 JSON 修好`, {
            source: 'output/artifacts/index.json',
          }),
        );
      } else if (!declared.length) {
        gates.push(
          gate('artifacts-declared', '阶段产物声明', 'warn', 'unjudged', '没有任何阶段声明 outputs：在 project.json 的 stages.<id>.outputs 里写清这个阶段该交什么，闸门才能按声明验收', { source: 'project.json' }),
        );
      } else {
        const missingDeclared = declared.filter((item) => !statOf(projectPath(root, item.rel)).exists);
        gates.push(
          missingDeclared.length
            ? gate(
                'artifacts-declared',
                '阶段产物声明',
                'warn',
                'fail',
                `${missingDeclared.length} 个已声明产物没有产出：${missingDeclared.slice(0, 4).map((item) => `${item.stageId} → ${item.rel}`).join('，')}`,
                { source: 'project.json' },
              )
            : gate('artifacts-declared', '阶段产物声明', 'warn', 'pass', `${declared.length} 个声明产物都在`),
        );
      }

      // 研究层：来源覆盖 / 模型回查 / 运行回执 / 复核版本，统一由 research_gate.py 汇总。
      // 有 registry 就必须有这份总闸门；老项目没有 registry 时整层不表态。
      const research = artifacts.research || null;
      if (!research) {
        gates.push(
          gate('research-gate', '研究总闸门 research_gate', 'warn', 'unjudged', '服务没有提供研究层视图：重启 DSH 后再看'),
          gate('qa-decisions', '判断台账 decisions', 'warn', 'unjudged', '服务没有提供研究层视图：重启 DSH 后再看'),
        );
      } else {
        const registryExists = Boolean(research.registry?.exists);
        const researchGate = research.gate;
        if (!registryExists) {
          gates.push(
            gate('research-gate', '研究总闸门 research_gate', 'warn', 'unjudged', '没有 research_registry.json：研究总闸门是可选层（老项目不拦）', { source: 'research_registry.json' }),
          );
        } else if (!researchGate.exists) {
          gates.push(
            gate(
              'research-gate',
              '研究总闸门 research_gate',
              'warn',
              'unjudged',
              '还没有 output/research_gate.json：检查来源覆盖 / 数据集终态 / 模型回查 / 运行回执 / 复核版本；终检会自动跑 research_gate.py',
              { source: 'output/research_gate.json' },
            ),
          );
        } else if (researchGate.error) {
          gates.push(gate('research-gate', '研究总闸门 research_gate', 'error', 'fail', researchGate.error, { source: researchGate.file }));
        } else if (
          Number(researchGate.mtimeMs) + 1000 < Math.max(
            Number(research.verification?.mtimeMs) || 0,
            Number(research.registry?.mtimeMs) || 0,
            Number(statOf(projectPath(root, research.coverage?.file || 'output/source_coverage.jsonl')).mtimeMs) || 0,
            Number(statOf(projectPath(root, research.plan?.file || 'output/model_plan.jsonl')).mtimeMs) || 0,
          )
        ) {
          gates.push(gate('research-gate', '研究总闸门 research_gate', 'warn', 'unjudged', '总闸门报告早于逐格复核 / registry / 来源覆盖 / 模型计划：这些输入改过，重跑 research_gate.py', { source: researchGate.file }));
        } else if (researchGate.status !== 'verified' || researchGate.errorCount !== 0) {
          const sample = (researchGate.issues || []).slice(0, 3).map((item) => `${item.where || ''} ${item.message || item.detail || ''}`.trim()).filter(Boolean);
          gates.push(
            gate(
              'research-gate',
              '研究总闸门 research_gate',
              'error',
              'fail',
              `${Number(researchGate.errorCount) || (researchGate.issues || []).length} 条未过：${sample.join('；') || '见 output/research_gate.json'}`,
              { source: researchGate.file },
            ),
          );
        } else {
          gates.push(
            gate(
              'research-gate',
              '研究总闸门 research_gate',
              'error',
              'pass',
              `${researchGate.sourceCount ?? '?'} 份来源 / ${researchGate.datasetCount ?? '?'} 份数据集 / ${researchGate.modelCount ?? '?'} 个模型：覆盖、终态、回查、回执与复核版本都通过（不能证明穷尽了所有变量与模型）`,
              { source: researchGate.file },
            ),
          );
        }

        // 判断台账：同一 target 的第二次判断必须 supersede；needs_human 在交付前必须清掉。
        const decisions = research.decisions;
        if (!decisions.exists) {
          gates.push(
            gate(
              'qa-decisions',
              '判断台账 decisions',
              'warn',
              'unjudged',
              '还没有 decisions.jsonl：筛选、排除、取值、方法选择都要留一条带证据的判断（字段见 references/10-contracts.md）',
              { source: 'decisions.jsonl' },
            ),
          );
        } else if (decisions.truncated) {
          gates.push(gate('qa-decisions', '判断台账 decisions', 'warn', 'unjudged', 'decisions.jsonl 超过 2 万行，只校验了前 2 万行：完整性判不了', { source: 'decisions.jsonl' }));
        } else if (decisions.broken.length) {
          gates.push(gate('qa-decisions', '判断台账 decisions', 'error', 'fail', `${decisions.broken.length} 行 JSONL 读不懂（第 ${decisions.broken[0].line} 行）——这几条判断没参与校验`, { source: 'decisions.jsonl' }));
        } else if (!decisions.total) {
          gates.push(gate('qa-decisions', '判断台账 decisions', 'warn', 'unjudged', 'decisions.jsonl 是空的：筛选、排除、取值、方法选择都要留一条带证据的判断', { source: 'decisions.jsonl' }));
        } else if (decisions.issuesExists && Number(decisions.mtimeMs) > Number(decisions.issuesMtimeMs) + 1000) {
          // 台账改了、校验没重跑：decision_issues.csv 里的结论已经对不上现在的台账。
          gates.push(gate('qa-decisions', '判断台账 decisions', 'warn', 'unjudged', 'decisions.jsonl 比 decision_issues.csv 新：校验结果已过期，先重跑 check_decisions.py', { source: 'output/qa/decision_issues.csv' }));
        } else if (!decisions.issuesExists) {
          // 有台账但没跑校验：不能因为「没读到 error」就判通过。
          gates.push(gate('qa-decisions', '判断台账 decisions', 'warn', 'unjudged', '还没有 output/qa/decision_issues.csv：先跑 check_decisions.py（编码阶段会自动跑），再按 issues 逐条处理', { source: 'decisions.jsonl' }));
        } else if (decisions.counts.error) {
          const first = decisions.issues.find((row) => String(row.severity || '').toLowerCase() === 'error');
          gates.push(
            gate(
              'qa-decisions',
              '判断台账 decisions',
              'error',
              'fail',
              `${decisions.counts.error} 条判断有 error：${first ? `${first.target || ''} ${first.detail || first.message || ''}`.trim() : '见 decision_issues.csv'}（先跑 check_decisions.py）`,
              { source: decisions.issuesFile },
            ),
          );
        } else if (decisions.needsHuman) {
          gates.push(
            gate('qa-decisions', '判断台账 decisions', 'error', 'fail', `${decisions.needsHuman} 条判断还标着 needs_human=true：交付前必须逐条定下来（草稿才允许 --allow-unresolved）`, { source: 'decisions.jsonl' }),
          );
        } else {
          gates.push(gate('qa-decisions', '判断台账 decisions', 'warn', 'pass', `${decisions.total ?? 0} 条判断，没有 error/待人工项`, { source: 'decisions.jsonl' }));
        }

        // 复核包：给人看的一页纸（图、表、模型、未关闭问题、缺失项）。
        if (!registryExists) {
          gates.push(gate('qa-review', '复核包 review_pack', 'warn', 'unjudged', '没有 research_registry.json：复核包是可选层', { source: 'output/review/review_pack.md' }));
        } else if (!research.review.exists || !research.review.bytes) {
          gates.push(
            gate('qa-review', '复核包 review_pack', 'warn', 'unjudged', '还没有 output/review/review_pack.md（或文件为空）：终检会自动跑 review_pack.py，或点 data_analysis_review_pack 单独生成', { source: 'output/review/review_pack.md' }),
          );
        } else {
          // 复核包是「某一版产物」的快照：复核/终检后来又跑过，旧包就不能当现结论。
          const freshAfter = Math.max(
            Number(research.verification?.mtimeMs) || 0,
            Number(artifacts.qa?.[0]?.mtimeMs) || 0,
            Number(artifacts.verify?.mtimeMs) || 0,
            Number(research.gate?.mtimeMs) || 0,
            Number(research.decisions?.mtimeMs) || 0,
            Number(research.registry?.mtimeMs) || 0,
            Number(statOf(projectPath(root, research.coverage?.file || 'output/source_coverage.jsonl')).mtimeMs) || 0,
            Number(statOf(projectPath(root, research.plan?.file || 'output/model_plan.jsonl')).mtimeMs) || 0,
          );
          if (freshAfter && Number(research.review.mtimeMs) + 1000 < freshAfter) {
            gates.push(gate('qa-review', '复核包 review_pack', 'warn', 'unjudged', '复核包早于最近的逐格复核/终检：重跑 review_pack.py 再看', { source: research.review.file }));
          } else {
            gates.push(gate('qa-review', '复核包 review_pack', 'warn', 'pass', `已生成（${research.review.bytes} B）`, { source: research.review.file }));
          }
        }
      }

      gates.push(manual('qa-signoff', '交付清单人工确认', '终检交付清单需要人确认（脚本只负责列出未过项）'));
    }

    if (def.id === 'recheck') {
      // 复核读的是用户手改过的产物（issues.jsonl / manuscript.json / coverage.json）：
      // 里面留一个 null 就把异常抛到 snapshot 上，整个面板都打不开。降级成「判不了」。
      let state = null;
      let recheckError = '';
      try {
        state = recheckSummary(root, { project, runs });
      } catch (error) {
        recheckError = String(error && error.message ? error.message : error);
      }
      const started = statOf(path.join(root, 'output/recheck/issues.jsonl')).exists
        || statOf(path.join(root, 'output/recheck/coverage.json')).exists
        || statOf(path.join(root, 'output/recheck/report.md')).exists;
      if (!started) {
        gates.push(
          gate('recheck-machine', '机器复算', 'error', 'unjudged', '还没开始复核：缺 output/recheck/report.md'),
          gate('recheck-issues', '问题清单', 'error', 'unjudged', '还没开始复核：缺 output/recheck/issues.jsonl'),
          gate('recheck-coverage', '复核覆盖表', 'warn', 'unjudged', '还没开始复核：缺 output/recheck/coverage.json'),
          gate('recheck-report', '复核报告', 'warn', 'unjudged', '还没开始复核：缺 output/recheck/report.md'),
        );
      } else if (!state) {
        gates.push(
          gate('recheck-machine', '机器复算', 'error', 'unjudged', `复核数据读不出来：${recheckError}`),
          gate('recheck-issues', '问题清单', 'error', 'unjudged', `复核数据读不出来：${recheckError}`),
          gate('recheck-coverage', '复核覆盖表', 'warn', 'unjudged', `复核数据读不出来：${recheckError}`),
          gate('recheck-report', '复核报告', 'warn', 'unjudged', '复核数据读不出来，没有可用报告'),
        );
      } else {
      const machineFails = state.checks.filter((item) => item.status === 'fail' && item.id !== 'R12');
      const machineUnjudged = state.checks.filter((item) => item.status === 'unjudged' && item.id !== 'R12');
      // 复算项数从实际结果数出来：写死「11 项」在清单变动后会变成假话（R12 单独由覆盖表闸门判）。
      const machineTotal = state.checks.filter((item) => item.id !== 'R12').length;
      gates.push(
        machineFails.length
          ? gate('recheck-machine', '机器复算', 'error', 'fail', `${machineFails.length} 项复算不通过：${machineFails.map((item) => item.id).join('、')}`, { source: machineFails.map((item) => `${item.id} ${item.detail}`).join('\n') })
          : machineUnjudged.length
            // 判不了 ≠ 通过：10 项 unjudged 绝不能汇总成一条 pass。
            // 这条闸门以前只要「没有 fail」就报通过，合成项目里 10/11 项判不了也能让复核显示 done。
            ? gate(
                'recheck-machine',
                '机器复算',
                'error',
                'unjudged',
                `${machineUnjudged.length} 项复算判不了：${machineUnjudged.map((item) => item.id).join('、')}——判不了不等于通过；逐项看 detail 补齐证据，或由人裁定后把结论写进 coverage 并说明理由`,
                { source: machineUnjudged.map((item) => `${item.id} ${item.detail}`).join('\n') },
              )
            : gate('recheck-machine', '机器复算', 'error', 'pass', `${machineTotal} 项复算全部有证据且通过`),
      );
      gates.push(
        state.openErrors
          ? gate('recheck-issues', '问题清单', 'error', 'fail', `${state.openErrors} 条 error 级问题未关闭（共 ${state.issues.filter((i) => i.status === 'open').length} 条 open）`, { source: 'output/recheck/issues.jsonl' })
          : gate('recheck-issues', '问题清单', 'warn', state.openOthers ? 'unjudged' : 'pass', state.openOthers
            ? `还有 ${state.openOthers} 条 warning/info 级问题未关闭`
            : '没有未关闭的问题', { source: 'output/recheck/issues.jsonl' }),
      );
      const coverageGate = state.checks.find((item) => item.id === 'R12');
      gates.push(
        coverageGate.status === 'pass'
          ? gate('recheck-coverage', '复核覆盖表', 'error', 'pass', coverageGate.detail)
          : coverageGate.status === 'fail'
            ? gate('recheck-coverage', '复核覆盖表', 'error', 'fail', coverageGate.detail)
            : gate('recheck-coverage', '复核覆盖表', 'warn', 'unjudged', coverageGate.detail),
      );
      gates.push(
        state.report
          ? gate('recheck-report', '复核报告', 'warn', 'pass', 'output/recheck/report.md 已生成')
          : gate('recheck-report', '复核报告', 'warn', 'unjudged', '缺 output/recheck/report.md：模型没有交复盘报告'),
      );
      }
    }

    // 产物来源：有登记脚本的阶段，如果产物没有对应的运行记录、或产物比最近一次运行还新，
    // 说明它是工作台外生成/被手改的——「done」不能被误读成「工作台跑过」。
    const sourceExpected = Array.isArray(def.artifacts) ? def.artifacts : [];
    if (!activeRuns[def.id] && (def.script || (Array.isArray(def.steps) && def.steps.length))) {
      const existing = sourceExpected
        .map((rel) => ({ rel, stat: statOf(path.join(root, rel)) }))
        .filter((item) => item.stat.exists);
      if (existing.length) {
        const newest = existing.reduce((max, item) => (item.stat.mtimeMs > max.stat.mtimeMs ? item : max), existing[0]);
        const sourceRun = lastRunOf(def.id);
        const endedMs = sourceRun?.endedAt ? Date.parse(sourceRun.endedAt) : 0;
        if (!sourceRun) {
          gates.push(gate('stage-source', '产物来源', 'warn', 'unjudged', `产物（${newest.rel}）存在，但工作台没有该阶段的运行记录：这是工作台外生成的，闸门只按产物判定`, { source: newest.rel }));
        } else if (endedMs && newest.stat.mtimeMs > endedMs + 2000) {
          gates.push(gate('stage-source', '产物来源', 'warn', 'unjudged', `产物（${newest.rel}）比最近一次运行（${shortTime(sourceRun.endedAt)}）还新：可能是工作台外生成的/被手改过，闸门只按产物判定`, { source: newest.rel }));
        }
      }
    }

    // 运行态：有 active run 的 stage 直接标 running
    const active = activeRuns[def.id];
    const lastRun = lastRunOf(def.id);

    const failed = gates.filter((g) => g.status === 'fail' && g.level === 'error');
    const unjudged = gates.filter((g) => g.status === 'unjudged');
    // `na`（不适用）是一种**有依据的结论**，既不是 pass，也不是「还没开始」。
    // 只有全部闸门都是 na 时阶段才是 na；混有 pass 时算 done（detail 里能看到哪条不适用）。
    const notApplicable = gates.filter((g) => g.status === 'na');
    const anyPass = gates.some((g) => g.status === 'pass') || notApplicable.length > 0;
    let status;
    if (active) status = 'running';
    else if (failed.length) status = 'blocked';
    else if (!gates.length) status = 'todo';
    else if (unjudged.length) status = 'review';
    else if (gates.every((g) => g.status === 'pass' || g.status === 'na')) {
      status = notApplicable.length && notApplicable.length === gates.length ? 'na' : 'done';
    } else status = 'review'; // 只剩 warn 级未过：不是「未开始」，而是「要人看一眼」
    // 一个还没开工的阶段（预期产物一个都不在、也没有运行记录）是「未开始」，不是「被拦住」
    // ——但正在跑的阶段不能被这些历史规则改写状态。
    const expected = Array.isArray(def.artifacts) ? def.artifacts : [];
    // 严格契约下，「已经有分析宽表」就意味着数据要进统计了：验数据这一关必须显形，
    // 不能因为「还没跑过 verify」被当成 todo 混过去。
    const strictContract = contractMode(project) === 'strict';
    // 「有没有干过活」按阶段自己的产物判断：别的阶段的宽表/图表不能把本阶段从「未开始」抬成「被拦住」。
    const stageSignals = {
      audit: Boolean(artifacts.corpus || artifacts.corpusSet?.valid?.size),
      coding: Boolean(artifacts.codingSet?.paths?.size),
      dataset: Boolean(artifacts.analysisCsv?.exists || artifacts.registry?.datasets?.rows?.length),
      verify: Boolean(artifacts.research?.verification?.exists || artifacts.research?.registry?.exists)
        || (strictContract && Boolean(artifacts.analysisCsv?.exists || artifacts.registry?.datasets?.rows?.length)),
      stats: Boolean(artifacts.models?.models?.length),
      figures: Boolean(artifacts.figures?.rows?.length),
      manuscript: Boolean(artifacts.manuscript?.exists),
      qa: Boolean(artifacts.verify || artifacts.qa?.length),
    };
    const anyArtifact = expected.some((rel) => statOf(path.join(root, rel)).exists)
      || Boolean(stageSignals[def.id]);
    // 已经有人工裁定过（哪怕是通过/不通过）就不算「未开始」：人的结论不能被「没产物」抹掉。
    // 判「适不适用」得到的 pass/na 只是对该阶段做一次定性，不算「干过活」——
    // 否则一个空项目的编码阶段会带着「缺编码表 fail」被抬成 blocked。
    const hasDecision = gates.some((g) => g.manual && adjudications[g.id]);
    // 判「适不适用」得到的 pass/na 只是对该阶段做一次定性，不算「干过活」——
    // 否则一个空项目的编码阶段会带着「缺编码表 fail」被抬成 blocked。
    const applicableGate = gates.find((g) => g.id === 'coding-applicable');
    const applicabilityNa = Boolean(applicableGate && applicableGate.status === 'na');
    const realPass = gates.some((g) => g.status === 'pass' && g.id !== 'coding-applicable');
    if (status !== 'running' && !lastRun && !realPass && !anyArtifact && !hasDecision) status = applicabilityNa ? 'na' : 'todo';
    // 「不适用」不能被 lastRun 规则抹掉：没有运行脚本的判定本身就是结论。
    else if (status === 'na' && lastRun && lastRun.status === 'failed') status = 'review';
    // 严格契约下，「已经有分析宽表」就意味着数据要进统计了：验数据这一关必须显形，
    // 不能因为「还没跑过 verify」被当成 todo 混过去。
    // 最近一次运行失败/取消：产物可能是旧的，不能继续报「已完成」。
    // 但如果已经跑出了可用产物、且没有任何 error 级闸门判 fail（例如 verify_numbers
    // 只因 V-05 退出非零），那是「要人看一眼」，不是「被拦住」——否则每个正常项目
    // 都会在终检卡死。真正崩掉、一个 pass 都没有的运行仍然 blocked。
    if (status !== 'running' && lastRun && lastRun.status === 'failed') status = failed.length || !anyPass ? 'blocked' : 'review';
    else if (status !== 'running' && lastRun && lastRun.status === 'cancelled' && status === 'done') status = 'review';
    if (status === 'done' && def.script && lastRun && lastRun.status !== 'ok') status = 'review';

    stages.push({
      id: def.id,
      index: def.index,
      name: def.name,
      short: def.short,
      purpose: def.purpose,
      script: stageProject.script === undefined ? def.script : stageProject.script,
      args: Array.isArray(stageProject.args) ? stageProject.args : [...def.args],
      // 多步阶段（终检）把每一步的脚本列出来：面板只显示一个脚本名会误导用户
      steps: Array.isArray(stageProject.steps)
        ? stageProject.steps.map((step) => step?.script || '')
        : Array.isArray(def.steps)
          ? def.steps.map((step) => step?.script || '')
          : [],
      status,
      gates,
      // 面板要能说清「这一阶段该产出什么」，不能只给闸门
      artifacts: expected,
      lastRun: lastRun
        ? { id: lastRun.id, status: lastRun.status, startedAt: lastRun.startedAt, endedAt: lastRun.endedAt, exitCode: lastRun.exitCode }
        : null,
    });
  }

  return applyGateReports(stages, { projectRoot, project,pythonPath });
}

/** 阶段汇总：几个 done / blocked / review，给顶栏用。 */
export function summarizeStages(stages) {
  // `na` 是第四种结论，必须单独计数：混进 todo 会让「不适用」看起来像「还没开始」。
  const counts = { done: 0, blocked: 0, review: 0, todo: 0, running: 0, na: 0 };
  for (const stage of stages) counts[stage.status] = (counts[stage.status] || 0) + 1;
  return counts;
}

export function gateTotals(stages) {
  let pass = 0;
  let fail = 0;
  let unjudged = 0;
  let na = 0;
  for (const stage of stages) {
    // 未开工的阶段还没被评价：把「产物还没生成」算进「未过」会虚报失败数
    if (stage.status === 'todo') continue;
    for (const g of stage.gates) {
      if(g.level==='info')continue;
      if (g.status === 'pass') pass += 1;
      else if (g.status === 'fail') fail += 1;
      else if (g.status === 'na') na += 1;
      else unjudged += 1;
    }
  }
  return { pass, fail, unjudged, na };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

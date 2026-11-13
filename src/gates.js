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
import path from 'node:path';

import { analysisFile, assessPalette, readCsv, statOf } from './audit.js';
import { STAGE_DEFS } from './defaults.js';
import { recheckSummary } from './recheck.js';
import { evaluateAssert, projectPath } from './registry.js';
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

export function evaluateProject({ projectRoot, project, artifacts, adjudications = {}, activeRuns = {}, runs = [], sources = [] }) {
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
          chain.monotonic
            ? gate('audit-monotonic', '漏斗单调不上升', 'error', 'pass', chain.steps.map((s) => `${s.stage} ${s.n}`).join(' → '), { source: chain.file })
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
      // 审计之后 data/ 又变了（典型：把 analysis.csv 写进了语料根）：审计结论已经过期。
      // 只比文件数 + 字节数，成本低；hidden/._ 的跳过规则与 audit_corpus.py 一致。
      const fingerprint = corpus?.fingerprint;
      const current = artifacts.corpusCurrent;
      if (!fingerprint || !Number.isFinite(Number(fingerprint.files)) || !Number.isFinite(Number(fingerprint.bytes))) {
        gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'unjudged', '缺 corpus_summary 的 fingerprint：无法判断 data/ 是否变过', { source: 'output/audit/corpus_summary.json' }));
      } else if (current?.truncated) {
        gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'unjudged', 'data/ 文件过多（>2 万），只做了部分 stat，无法确认审计是否过期'));
      } else if (current && (Number(current.files) !== Number(fingerprint.files) || Number(current.bytes) !== Number(fingerprint.bytes))) {
        const legacy = analysisFile(root);
        const hint = legacy.rel === 'data/analysis.csv'
          ? '；另外 analysis.csv 是分析宽表，放在语料根会被当成一份资料，建议移到 output/dataset/analysis.csv 后再重跑审计'
          : '';
        gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'error', 'fail', `data/ 已变化：审计时 ${fingerprint.files} 个文件 / ${fingerprint.bytes} 字节，现在 ${current.files} 个 / ${current.bytes} 字节；先重跑审计再往下走${hint}`, { source: 'output/audit/corpus_summary.json' }));
      } else {
        gates.push(gate('audit-freshness', '审计是否仍然新鲜', 'warn', 'pass', `${current.files} 个文件 / ${current.bytes} 字节，与审计快照一致`, { source: 'output/audit/corpus_summary.json' }));
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
      gates.push(fileGate('coding-sheet', '编码表 coding_sheet.csv', { abs: path.join(root, 'output', 'coding', 'coding_sheet.csv'), rel: 'output/coding/coding_sheet.csv' }, { requireRows: true }));
      const codingChain = artifacts.flow.find((c) => c.file.startsWith('output/coding/'));
      gates.push(
        codingChain
          ? gate('coding-flow', '编码阶段漏斗', 'warn', 'pass', `${codingChain.first} → ${codingChain.last}`, { source: codingChain.file })
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

    if (def.id === 'dataset') {
      const analysisTarget = analysisFile(root);
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
      const csv = readCsv(analysisTarget.abs);
      if (csv?.header?.length) {
        const hasFlag = csv.header.includes('in_analysis');
        gates.push(
          gate(
            'dataset-flag',
            '分析样本标记 in_analysis',
            'warn',
            hasFlag ? 'pass' : 'unjudged',
            hasFlag ? '列存在' : '缺 in_analysis 列：描述统计的样本量只能人工声明',
            { source: analysisTarget.rel },
          ),
        );
        if (hasFlag) {
          const values = new Set(csv.rows.map((row) => String(row.in_analysis ?? '').trim()));
          const mixed = values.size > 1;
          // auto_stats 只认 --data 与 chart_config.filter_query，不会自动遵守 in_analysis；
          // 宽表里留了 0 的行而配置没过滤，排除样本会静默进描述统计与模型。
          // 所以这里能机器判：配置文件里是否真的引用了 in_analysis。
          const specFiles = ['model_spec.json', 'chart_config.json'].filter((name) =>
            fs.existsSync(path.join(projectRoot, name)),
          );
          const referenced = specFiles.filter((name) => {
            try {
              return /in_analysis/.test(fs.readFileSync(path.join(projectRoot, name), 'utf8'));
            } catch {
              return false;
            }
          });
          gates.push(
            !mixed
              ? gate('dataset-in-analysis', '排除样本不会被统计误吃', 'warn', 'pass', 'in_analysis 全为同一值，无静默混入风险', { source: analysisTarget.rel })
              : referenced.length
                ? gate('dataset-in-analysis', '排除样本不会被统计误吃', 'warn', 'pass', `${referenced.join('、')} 引用了 in_analysis，排除样本会被过滤`, { source: analysisTarget.rel })
                : specFiles.length
                  ? gate(
                      'dataset-in-analysis',
                      '排除样本不会被统计误吃',
                      'error',
                      'fail',
                      `${specFiles.join('、')} 存在但没有引用 in_analysis：auto_stats.py 不会自动过滤，排除样本会进统计与图表；在 filter_query 里写 in_analysis == 1 后重跑本阶段`,
                      { source: analysisTarget.rel },
                    )
                  : manual(
                      'dataset-in-analysis',
                      '排除样本不会被统计误吃',
                      '宽表含 in_analysis=0/1，还没有 model_spec.json / chart_config.json：你可以拍板「保留全部行，统计与图表会写 filter_query: in_analysis == 1」，或打回先补配置；拍板后统计阶段仍要真写这条过滤',
                    ),
          );
        }
      } else {
        gates.push(gate('dataset-flag', '分析样本标记 in_analysis', 'warn', 'unjudged', '没有宽表可检查'));
      }

      // v2 契约：先看注册表在不在，再看「声明」和「实物」对不对得上。
      // 没有注册表不是错，而是「判不了」——迁移前的老项目照样能跑，只是这条闸门永远不绿。
      const registry = artifacts.registry || null;
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
                    `${rows.length} 份数据集（${rows.slice(0, 3).map((item) => `${item.id} ${item.rows} 行/${item.columns.length} 列`).join('，')}${rows.length > 3 ? '…' : ''}）`,
                    { source: 'output/datasets/index.json' },
                  ),
        );
      }
    }

    if (def.id === 'stats') {
      const models = artifacts.models;
      if (models.models.length) {
        const lines = models.models.map((m) => `${m.id} N=${m.fitN ?? m.n ?? '?'}`);
        gates.push(
          gate('stats-models', '模型系数表', 'error', 'pass', `${models.models.length} 个模型（${models.dir}）· ${lines.slice(0, 4).join('，')}`, { source: models.dir }),
        );
        const mismatched = models.models.filter((m) => m.fitN !== null && m.n !== null && m.fitN !== m.n);
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
      if (models.flowChecks.length) {
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
          gates.push(
            hard.length
              ? gate('models-sweep', '模型族普查', 'error', 'fail', `${hard.length} 条普查错误：${hard[0].message}`, { source: 'output/models/sweep.json' })
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

    if (def.id === 'figures') {
      const figures = artifacts.figures;
      if (!figures.rows.length) {
        gates.push(gate('fig-manifest', '图表清单 chart_manifest.csv', 'error', 'fail', '没有找到图表清单', { source: figures.file || 'output/chart_pack' }));
      } else {
        gates.push(gate('fig-manifest', '图表清单 chart_manifest.csv', 'error', 'pass', `${figures.rows.length} 张图`, { source: figures.file }));
        const dpiRows = figures.rows.filter((row) => row.effectiveDpi !== null);
        const dpiBad = dpiRows.filter((row) => row.effectiveDpi < 597);
        if (!dpiRows.length) {
          gates.push(gate('fig-dpi', '有效 dpi ≥ 597', 'error', 'unjudged', '所有行都缺 px_width：无法折算有效 dpi'));
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
        const fontRows = figures.rows.filter((row) => row.minFontsize !== null);
        const fontBad = fontRows.filter((row) => row.minFontsize < 7.2);
        if (!fontRows.length) {
          gates.push(gate('fig-font', '最小字号 ≥ 7.2 pt', 'error', 'unjudged', '清单里没有 min_fontsize：PNG 判不了字号'));
        } else {
          gates.push(
            gate(
              'fig-font',
              '最小字号 ≥ 7.2 pt',
              'error',
              fontBad.length ? 'fail' : 'pass',
              fontBad.length ? `${fontBad.length} 张 < 7.2pt` : `${fontRows.length} 张达标`,
            ),
          );
        }
        const missing = figures.rows.filter((row) => !row.pngExists);
        gates.push(
          missing.length
            ? gate('fig-files', '图片文件存在', 'error', 'fail', `${missing.length} 张 PNG 缺失`, { source: figures.file })
            : gate('fig-files', '图片文件存在', 'error', 'pass', '全部命中', { source: figures.file }),
        );
        const paletteRows = figures.rows.map((row) => ({ row, p: assessPalette(row.palette) }));
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
            `manuscript.json 比 output/manuscript.docx 新（${shortTime(new Date(specStat.mtimeMs).toISOString())} > ${shortTime(new Date(docxStat.mtimeMs).toISOString())}）——改完稿必须重跑第 7 阶段，否则交付的是旧稿`,
            { source: 'manuscript.json / output/manuscript.docx' },
          ),
        );
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
                  `${deadTables.length} 张表的 CSV 读不到（${deadTables.map((item) => `表 ${item.n}：${item.csv || '没写 csv'}`).join('，')}）：第 7 阶段会直接报 table csv not found`,
                  { source: 'manuscript.json' },
                )
              : wide.length
              ? gate(
                  'tbl-present',
                  '表格经过编排',
                  'warn',
                  'unjudged',
                  `${wide.length} 张表直接贴了原表（${wide.map((item) => `表 ${item.n}：${item.cols} 列`).join('，')}）：给 table 块加 presentation.columns 选列，或先在 output/tables 里整理成论文表`,
                  { source: 'manuscript.json' },
                )
              : gate('tbl-present', '表格经过编排', 'warn', 'pass', `${widths.length} 张表都做过选列/编排`),
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
        const inputOnly = verify.counts.error > 0 && (verify.counts.input || 0) >= verify.counts.error;
        gates.push(
          gate(
            'qa-numbers',
            '数字溯源无 error',
            'error',
            verify.counts.error ? (inputOnly ? 'unjudged' : 'fail') : 'pass',
            inputOnly
              ? `error ${verify.counts.error} 条全部是输入类（缺文件/解析失败）：这是「没得查」，不是「查出来数字不对」，补齐 docx / manifest / sample_flow 后重跑`
              : `error ${verify.counts.error} / warning ${verify.counts.warning} / info ${verify.counts.info}`,
            { source: verify.file },
          ),
        );
        const deferred = verify.counts.deferred || 0;
        gates.push(
          gate(
            'qa-v05',
            'V-05 N 口径待复核',
            'warn',
            deferred ? 'unjudged' : 'pass',
            deferred
              ? `${deferred} 条 V-05 是「图注 N ≠ n_dropna」判定，而 n_dropna 是被剔除行数，不是模型 N；需按 fit.n 逐条复核，不能直接当 error`
              : '没有 V-05 争议项',
            { source: verify.file },
          ),
        );
      } else {
        gates.push(gate('qa-numbers', '数字溯源无 error', 'error', 'unjudged', '缺 number_issues.csv：没跑 verify_numbers 或没输出到 output/verify'));
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
      gates.push(
        machineFails.length
          ? gate('recheck-machine', '机器复算', 'error', 'fail', `${machineFails.length} 项复算不通过：${machineFails.map((item) => item.id).join('、')}`, { source: machineFails.map((item) => `${item.id} ${item.detail}`).join('\n') })
          : gate('recheck-machine', '机器复算', 'error', 'pass', `11 项复算无 fail${machineUnjudged.length ? `（${machineUnjudged.length} 项判不了：${machineUnjudged.map((item) => item.id).join('、')}）` : ''}`),
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
    const anyPass = gates.some((g) => g.status === 'pass');
    let status;
    if (active) status = 'running';
    else if (failed.length) status = 'blocked';
    else if (!gates.length) status = 'todo';
    else if (unjudged.length) status = 'review';
    else if (gates.every((g) => g.status === 'pass')) status = 'done';
    else status = 'review'; // 只剩 warn 级未过：不是「未开始」，而是「要人看一眼」
    // 一个还没开工的阶段（预期产物一个都不在、也没有运行记录）是「未开始」，不是「被拦住」
    // ——但正在跑的阶段不能被这些历史规则改写状态。
    const expected = Array.isArray(def.artifacts) ? def.artifacts : [];
    // 「有没有干过活」按阶段自己的产物判断：别的阶段的宽表/图表不能把本阶段从「未开始」抬成「被拦住」。
    const stageSignals = {
      audit: Boolean(artifacts.corpus || artifacts.corpusSet?.valid?.size),
      coding: Boolean(artifacts.codingSet?.paths?.size),
      dataset: Boolean(artifacts.analysisCsv?.exists),
      stats: Boolean(artifacts.models?.models?.length),
      figures: Boolean(artifacts.figures?.rows?.length),
      manuscript: Boolean(artifacts.manuscript?.exists),
      qa: Boolean(artifacts.verify || artifacts.qa?.length),
    };
    const anyArtifact = expected.some((rel) => statOf(path.join(root, rel)).exists)
      || Boolean(stageSignals[def.id]);
    // 已经有人工裁定过（哪怕是通过/不通过）就不算「未开始」：人的结论不能被「没产物」抹掉
    const hasDecision = gates.some((g) => g.manual && adjudications[g.id]);
    if (status !== 'running' && !lastRun && !anyPass && !anyArtifact && !hasDecision) status = 'todo';
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

  return stages;
}

/** 阶段汇总：几个 done / blocked / review，给顶栏用。 */
export function summarizeStages(stages) {
  const counts = { done: 0, blocked: 0, review: 0, todo: 0, running: 0 };
  for (const stage of stages) counts[stage.status] = (counts[stage.status] || 0) + 1;
  return counts;
}

export function gateTotals(stages) {
  let pass = 0;
  let fail = 0;
  let unjudged = 0;
  for (const stage of stages) {
    // 未开工的阶段还没被评价：把「产物还没生成」算进「未过」会虚报失败数
    if (stage.status === 'todo') continue;
    for (const g of stage.gates) {
      if (g.status === 'pass') pass += 1;
      else if (g.status === 'fail') fail += 1;
      else unjudged += 1;
    }
  }
  return { pass, fail, unjudged };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

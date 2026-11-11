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

function gate(id, label, level, status, detail, extra = {}) {
  return { id, label, level, status, detail, ...extra };
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

export function evaluateProject({ projectRoot, project, artifacts, adjudications = {}, activeRuns = {}, runs = [] }) {
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
    }

    if (def.id === 'manuscript') {
      gates.push(fileGate('manuscript-docx', '成稿 output/manuscript.docx', { abs: path.join(root, 'output', 'manuscript.docx'), rel: 'output/manuscript.docx' }));
    }

    if (def.id === 'qa') {
      const verify = artifacts.verify;
      const qaReports = artifacts.qa;
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
      gates.push(manual('qa-signoff', '交付清单人工确认', '终检交付清单需要人确认（脚本只负责列出未过项）'));
    }

    if (def.id === 'recheck') {
      const state = recheckSummary(root, { project, runs });
      // 一项复核产物都没有时，不能把「没有 open 问题」当成通过：那是还没开始
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
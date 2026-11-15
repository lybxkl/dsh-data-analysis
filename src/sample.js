/**
 * 「排除样本会不会进统计」这件事，只查字符串里有没有 `in_analysis` 是假的证据。
 *
 * skill 的真实语义（scripts/analysis_utils.py:212-299 `apply_filter`）：
 *   1. 宽表有 `in_analysis` 列且没有 `keep_out_of_scope` 时，**默认**先按 `in_analysis == 1` 过滤；
 *   2. `filter_query` 提到 `in_analysis` 时，它自己就是那道闸门（不再叠加默认过滤）；
 *   3. `keep_out_of_scope: true` 显式关掉默认过滤——这是研究决定，必须留痕，不能当通过。
 *
 * 所以闸门要核的是三件事：
 *   - 宽表里到底有几行纳入（全 0 = 分析样本为空，必须拦）；
 *   - 配置有没有把默认闸门关掉、或用 filter_query 反向筛选；
 *   - 已有模型的实际估计 N 有没有超过纳入样本（超过就是排除行真的进了模型）。
 *
 * 这个模块不执行任何用户表达式：只做字段级识别与计数。
 */

import fs from 'node:fs';
import path from 'node:path';

/** in_analysis 的取值归一：1/true/yes/是 → 纳入；0/false/no/否 → 排除；其余 → null。 */
export function normalizeInAnalysis(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (['1', 'true', 'yes', 'y', '是', '纳入', 'in'].includes(text)) return 1;
  if (['0', 'false', 'no', 'n', '否', '排除', 'out'].includes(text)) return 0;
  const n = Number(text);
  if (Number.isFinite(n) && (n === 0 || n === 1)) return n;
  return null;
}

function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const value = JSON.parse(text);
    return { exists: true, ok: true, value, error: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, ok: false, value: null, error: '' };
    return { exists: true, ok: false, value: null, error: String(error?.message || error).slice(0, 160) };
  }
}

/** 从 filter_query 里读出 in_analysis 的比较方向；读不出就返回 null（不猜）。 */
function readFlagPredicate(expression) {
  const text = String(expression || '');
  if (!/in_analysis/i.test(text)) return null;
  const match = text.match(/in_analysis\s*(==|!=|>=|<=|>|<|=)\s*('[^']*'|"[^"]*"|true|false|[0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return { kind: 'unparsed', text };
  const op = match[1] === '=' ? '==' : match[1];
  const raw = match[2].replace(/^['"]|['"]$/g, '').toLowerCase();
  const wanted = normalizeInAnalysis(raw);
  if (wanted === null) return { kind: 'unparsed', text };
  if ((op === '==' && wanted === 1) || (op === '!=' && wanted === 0) || (op === '>=' && wanted === 1)) {
    return { kind: 'include', op, value: wanted, text: match[0] };
  }
  if ((op === '==' && wanted === 0) || (op === '!=' && wanted === 1) || (op === '<' && wanted === 1)) {
    return { kind: 'exclude', op, value: wanted, text: match[0] };
  }
  return { kind: 'unparsed', text };
}

/**
 * 读项目里的筛选配置：只认真正会传给脚本的字段。
 * chart_config.json 是 auto_stats / auto_chart_pack 的 `--config`；
 * model_spec.json 的 models[].subset 是逐模型收窄（在默认闸门之后执行）。
 */
export function readSampleSettings(projectRoot) {
  const files = ['chart_config.json', 'model_spec.json'];
  const configs = [];
  const broken = [];
  const filters = [];
  const keepOutOfScope = [];
  const modelSubsets = [];
  for (const name of files) {
    const read = readJsonFile(path.join(projectRoot, name));
    if (!read.exists) continue;
    if (!read.ok) {
      broken.push(`${name}：${read.error}`);
      continue;
    }
    const value = read.value && typeof read.value === 'object' ? read.value : {};
    configs.push(name);
    if (value.keep_out_of_scope === true || value.keepOutOfScope === true) keepOutOfScope.push(name);
    const query = value.filter_query ?? value.filterQuery;
    if (query !== undefined && query !== null && String(query).trim()) {
      filters.push({ file: name, where: 'filter_query', expression: String(query) });
    }
    const filter = value.filter;
    if (filter && typeof filter === 'object' && !Array.isArray(filter)) {
      for (const [key, wanted] of Object.entries(filter)) {
        if (/^in_analysis$/i.test(key)) {
          filters.push({ file: name, where: `filter.${key}`, expression: `in_analysis == ${String(wanted)}` });
        }
      }
    }
    for (const model of Array.isArray(value.models) ? value.models : []) {
      const subset = model?.subset ?? model?.sample;
      if (typeof subset === 'string' && subset.trim() && /in_analysis/i.test(subset)) {
        modelSubsets.push({ file: name, model: String(model.id || ''), expression: subset.trim() });
      }
    }
  }
  const predicates = filters.map((item) => ({ ...item, predicate: readFlagPredicate(item.expression) }));
  const modelPredicates = modelSubsets.map((item) => ({ ...item, predicate: readFlagPredicate(item.expression) }));
  return { configs, broken, filters: predicates, keepOutOfScope, modelSubsets: modelPredicates };
}

function countFlag(csv) {
  const header = Array.isArray(csv?.header) ? csv.header : [];
  const at = header.findIndex((name) => /^in_analysis$/i.test(String(name || '').trim()));
  if (at < 0) return { has: false, total: csv?.rows?.length || 0, included: null, excluded: null, unknown: 0 };
  let included = 0;
  let excluded = 0;
  let unknown = 0;
  for (const row of csv.rows) {
    const flag = normalizeInAnalysis(row[header[at]]);
    if (flag === 1) included += 1;
    else if (flag === 0) excluded += 1;
    else unknown += 1;
  }
  return { has: true, total: csv.rows.length, included, excluded, unknown };
}

/**
 * 判定。返回 { state: pass|fail|unjudged, detail, included, excluded, evidence }。
 *
 * `models` 是 audit.readModels 的结果（models.models[] 带 fitN/n）。
 */
export function analyseInAnalysis({ csv, settings, models, source = 'analysis.csv' } = {}) {
  if (!csv || !csv.header?.length) {
    return { state: 'unjudged', detail: '没有可解析的分析宽表，纳入样本量判不了', included: null, excluded: null };
  }
  const counts = countFlag(csv);
  if (!counts.has) {
    return { state: 'unjudged', detail: '宽表没有 in_analysis 列：无法确定哪些行进入描述统计', included: null, excluded: null };
  }
  if (!counts.total) {
    return { state: 'unjudged', detail: '宽表没有数据行', included: 0, excluded: 0 };
  }
  if (counts.unknown) {
    return {
      state: 'unjudged',
      detail: `in_analysis 有 ${counts.unknown} 行不是 0/1（或为空）：取值口径没定，过滤行为不可预测`,
      included: counts.included,
      excluded: counts.excluded,
    };
  }
  if (counts.included === 0) {
    return {
      state: 'fail',
      detail: `${source} 的 ${counts.total} 行 in_analysis 全为 0：纳入样本为 0，auto_stats/auto_chart_pack 的默认闸门会直接报 “gate left 0 rows”；先修正标记再跑统计`,
      included: 0,
      excluded: counts.excluded,
    };
  }
  if (!counts.excluded) {
    return {
      state: 'pass',
      detail: `${counts.total} 行全部 in_analysis=1：没有排除样本，不存在静默混入`,
      included: counts.included,
      excluded: 0,
    };
  }

  const configs = settings?.configs || [];
  if (settings?.broken?.length) {
    return {
      state: 'unjudged',
      detail: `筛选配置读不懂（${settings.broken.join('；')}）：判不了过滤是否生效`,
      included: counts.included,
      excluded: counts.excluded,
    };
  }

  const excludes = [...(settings?.filters || []), ...(settings?.modelSubsets || [])]
    .filter((item) => item.predicate?.kind === 'exclude');
  if (excludes.length) {
    const first = excludes[0];
    return {
      state: 'fail',
      detail: `${first.file} 的 ${first.where} 写成「${first.expression}」，把 in_analysis=1 的行筛掉了：排除行会变成唯一进入统计的样本；改成 in_analysis == 1 或删掉这条条件`,
      included: counts.included,
      excluded: counts.excluded,
    };
  }

  const keepOut = settings?.keepOutOfScope || [];
  if (keepOut.length) {
    return {
      state: 'unjudged',
      detail: `${keepOut.join('、')} 显式设了 keep_out_of_scope=true：排除样本会进统计与图表（skill 的 apply_filter 会跳过默认闸门）。这是研究决定，需在 decisions.jsonl 记录理由并说明；判不了它是否合适`,
      included: counts.included,
      excluded: counts.excluded,
    };
  }

  const explicit = (settings?.filters || []).filter((item) => item.predicate?.kind === 'include');
  const fits = (Array.isArray(models?.models) ? models.models : [])
    .map((model) => ({ id: model.id, n: Number.isFinite(model.fitN) ? model.fitN : model.n }))
    .filter((item) => Number.isFinite(item.n));
  if (fits.length) {
    const over = fits.filter((item) => item.n > counts.included);
    if (over.length) {
      return {
        state: 'fail',
        detail: `模型 ${over.map((item) => `${item.id} N=${item.n}`).join('、')} 大于纳入样本 ${counts.included}：in_analysis=0 的行进了模型（检查 filter_query / subset / 是否绕过 apply_filter）`,
        included: counts.included,
        excluded: counts.excluded,
      };
    }
    const seen = fits.map((item) => `${item.id} N=${item.n}`).join('、');
    return {
      state: 'pass',
      detail: `纳入 ${counts.included} / 排除 ${counts.excluded}；模型实际 N（${seen}）没有超过纳入样本${explicit.length ? `；filter_query 也显式写了 ${explicit[0].predicate.text}` : ''}`,
      included: counts.included,
      excluded: counts.excluded,
      evidence: fits,
    };
  }

  // 还没有模型：证据是「配置没有关掉默认闸门」+「skill 的 apply_filter 会先按 in_analysis==1 过滤」。
  // 这不是拍脑袋：analysis_utils.py:238-269 的默认分支就是这道闸门。
  return {
    state: 'pass',
    detail: `纳入 ${counts.included} / 排除 ${counts.excluded}；${configs.length ? `${configs.join('、')} 没有 keep_out_of_scope` : '还没有筛选配置'}，skill 的 apply_filter 会先按 in_analysis == 1 过滤${explicit.length ? `（filter_query 也写了 ${explicit[0].predicate.text}）` : ''}；尚未有模型可实测 N`,
    included: counts.included,
    excluded: counts.excluded,
  };
}

#!/usr/bin/env python3
"""模型族普查：**只做诊断与候选，不估参数、不替研究者做方法决定**。

为什么要重写这个小工具（2026-11-13 复盘的结论）：

  旧版带着「裁判文书项目」的烙印——结局靠刑期/罚金/缓刑这几个中文/英文字段名去认，
  每份数据集最多取 8 个结局，还用固定样本阈值（n<50、事件<10）直接把族判成 blocked。
  这套逻辑放到问卷、访谈、面板、开放数据上全是错的：它会把「研究者压根没想到的结局」
  当成不存在，又把「样本小但可以用精确检验/Firth」的族说成估不了。

  现在的分工是 skill 的契约（SKILL.md「核心目标与自由度」+ references/12 §5）：
    - **语义由研究问题、codebook、研究设计提供**：结局清单读 codebook 的
      `outcome: true` / `role: outcome` / `outcome_type`，读 registry 的 `codebook` 路径，
      读 output/models/index.json 里已登记的模型 outcome；
    - **程序只做机械诊断**：类型、样本量、事件数、零值比例、离散度、唯一值数、
      缺失率、每个族需要什么、当前缺什么；
    - **阈值只产生提醒（diagnostic），不再判 blocked**：样本小不等于估不了，
      可以用精确检验、Firth、稳健标准误；真正 blocked 只用于「结构性不可能」，
      例如没有随访时间却要 Cox、没有分母却要率模型。这些判断都要写 why，供 Agent 取舍。

契约（插件侧只读这个文件）：
    python sweep_models.py --root <项目> --out <结果.json>
    → output/models/sweep.json
      {
        "generatedBy": "sweep_models.py",
        "at": "...",
        "scope": {...},              # 这次扫了哪些数据集、共多少列、为什么只扫了这些
        "outcomes": [
          {"name": "duration_months", "dataset": "person_wave", "declared": "codebook",
           "role": "持续时间", "type": "duration", "n": 362, "diagnostics": ["右偏 ..."],
           "families": [
             {"family": "ols", "status": "estimated", "model": "M1"},
             {"family": "survival_cox", "status": "blocked", "why": "没有随访时间/事件时点"},
             {"family": "quantile", "status": "available", "why": "样本偏小，可用稳健/自助法"}
           ]}
        ]
      }

退出码：0 正常；2 没有数据集注册表；3 注册表读不懂；4 缺 pandas；5 没有可诊断的列。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

# ── 语义提示：**只是提示**，不决定结局清单 ────────────────────────────────
# 角色/类型靠这些词提示，但一个列是不是结局，由 codebook / registry / 已有模型说了算。
# 加词是为了少漏掉明显的结局，不是为了让程序替研究者做判断。
SUSPECT_HINTS = {
    "binary": ("是否", "有无", "命中", "采用", "同意", "满意", "binary", "dummy", "flag", "hit", "yes_no"),
    "count": ("次数", "人数", "个数", "件数", "数量", "频次", "count", "freq", "times"),
    "duration": ("时长", "期限", "月数", "天数", "年数", "duration", "months", "days", "elapsed"),
    "amount": ("金额", "收入", "费用", "价格", "赔偿", "amount", "income", "cost", "price", "fee"),
}

OUTCOME_DECLARATIONS = ("outcome", "outcome_type", "is_outcome")
RESERVED_KEYS = {"id", "key", "grain", "in_analysis"}


def role_hint(name: str, codebook_entry: dict | None) -> str:
    """角色说明：codebook 写了就照用，没写才按列名给一个「可能是什么」的提示。"""
    if isinstance(codebook_entry, dict):
        for key in ("role", "label", "meaning", "description", "variable_label"):
            value = str(codebook_entry.get(key) or "").strip()
            if value:
                return value[:60]
    lower = name.lower()
    for kind, words in SUSPECT_HINTS.items():
        for word in words:
            if word.lower() in lower:
                return f"疑似{_kind_word(kind)}（按列名提示，需 codebook 确认）"
    return ""


def _kind_word(kind: str) -> str:
    """把 hint 分类名翻成中文——**不能**从词表里猜（词表里没有「时长」字样的中文词会猜错）。"""
    mapping = {
        "binary": "二值结局",
        "count": "计数",
        "duration": "持续时间",
        "amount": "金额",
    }
    return mapping.get(kind, "结局")


def family(entry: str, status: str, why: str = "", model: str = "", needs: str = "") -> dict:
    item = {"family": entry, "status": status}
    if model:
        item["model"] = model
    if why:
        item["why"] = why
    if needs:
        item["needs"] = needs
    return item


def classify(series, name: str = "", declared: str = "") -> tuple[str, dict]:
    """诊断结局的类型与分布。

    顺序：
      1. codebook 显式写的 outcome_type 最硬（continuous/binary/count/duration/amount/category）；
      2. 取值本身：二值、整数非负、取值少 → 类别；
      3. 最后才用列名提示区分「持续时间 / 金额 / 普通连续」。
    """
    import pandas as pd

    numeric = pd.to_numeric(series, errors="coerce")
    values = numeric.dropna()
    stats = {
        "n": int(series.notna().sum()),
        "numeric": int(values.shape[0]),
        "missing": int(series.isna().sum()),
        "zeros": int((values == 0).sum()),
        "min": float(values.min()) if len(values) else None,
        "max": float(values.max()) if len(values) else None,
        "mean": float(values.mean()) if len(values) else None,
        "sd": float(values.std()) if len(values) > 1 else None,
    }
    declared_kind = str(declared or "").strip().lower()
    alias = {
        "continuous": "continuous", "numeric": "continuous", "number": "continuous",
        "binary": "binary", "boolean": "binary", "dummy": "binary",
        "count": "count", "integer": "count",
        "duration": "duration", "time": "duration", "survival": "duration",
        "amount": "amount", "money": "amount",
        "category": "category", "categorical": "category", "ordinal": "category",
    }
    forced = alias.get(declared_kind, "")
    if not len(values):
        text_n = int(series.dropna().astype(str).str.strip().replace("", pd.NA).dropna().shape[0])
        stats["n"] = text_n
        return (forced or "category"), stats

    unique = sorted(set(float(item) for item in values.unique().tolist()))
    integral = bool((values % 1 == 0).all())
    name_lower = (name or "").lower()
    has_duration_hint = any(w.lower() in name_lower for w in SUSPECT_HINTS["duration"])
    has_amount_hint = any(w.lower() in name_lower for w in SUSPECT_HINTS["amount"])
    if forced:
        kind = forced
    elif len(unique) == 2 and set(unique) <= {0.0, 1.0}:
        kind = "binary"
    elif len(unique) == 2 and set(unique) <= {1.0, 2.0}:
        kind = "binary"
    elif has_duration_hint:
        kind = "duration"
    elif has_amount_hint:
        kind = "amount"
    elif integral and stats["min"] is not None and stats["min"] >= 0 and (
        len(unique) > 12 or any(w.lower() in name_lower for w in SUSPECT_HINTS["count"])
    ):
        kind = "count"
    elif len(unique) <= 12:
        kind = "category"
    else:
        kind = "continuous"
    if kind == "binary":
        stats["events"] = int((values == 1).sum()) if set(unique) <= {0.0, 1.0} else int((values == 2).sum())
        stats["levels"] = [float(v) for v in unique]
    return kind, stats


def diagnostics(kind: str, stats: dict) -> list[str]:
    """机械诊断：只描述事实，不下「能不能估」的结论。"""
    out: list[str] = []
    n = int(stats.get("n") or 0)
    if n:
        missing = int(stats.get("missing") or 0)
        if missing:
            out.append(f"缺失 {missing} 行（{missing / (n + missing) * 100:.0f}%）")
    if kind == "binary":
        events = int(stats.get("events") or 0)
        if n:
            out.append(f"事件 {events}/{n}（{events / n * 100:.1f}%）")
            if events and events < 10:
                out.append("事件数偏少：对数似然可能不稳，可考虑精确检验 / Firth；不等于估不了")
    mean = stats.get("mean")
    sd = stats.get("sd")
    if mean is not None and sd is not None:
        if kind in {"count", "amount"} and mean > 0:
            out.append(f"均值 {mean:.3g} / 标准差 {sd:.3g}（sd²/mean = {sd * sd / max(mean, 1e-9):.2f}，明显 >1 提示过度离散）")
        elif kind not in {"binary", "category"}:
            out.append(f"均值 {mean:.3g} / 标准差 {sd:.3g}")
    if kind == "count" and n:
        share = int(stats.get("zeros") or 0) / n
        out.append(f"零值占 {share * 100:.0f}%" + ("（零膨胀族值得考虑）" if share > 0.3 else ""))
    if kind in {"amount", "duration"} and stats.get("min") is not None:
        if stats["min"] <= 0:
            out.append("存在 0/负值：截断或两部分模型可能有意义")
    if n and n < 30:
        out.append(f"样本偏小（N={n}）：小样本不等于不可估，可用精确检验/自助法并在正文说明")
    return out


def families_for(kind: str, stats: dict, outcome: str, models: list[dict]) -> list[dict]:
    """给这个结局列出「该考虑的族」，并标出已估 / 可估 / 结构性不可估 / 不必要。

    三态纪律：
      estimated      已有模型估了
      available      数据形态支持，尚未估（可以由 Agent 决定补）
      blocked        结构性不可估（缺时点、缺分母、缺配对……），必须写 why
      not_needed     可以说明为什么不需要（例如没有 0 值就不必 Tobit）
    **不再因为样本量阈值把族判成 blocked**：小样本最多在 diagnostics 里提醒。
    """
    n = int(stats.get("n") or 0)
    events = int(stats.get("events") or 0)
    zeros = int(stats.get("zeros") or 0)
    mean = stats.get("mean")
    sd = stats.get("sd")
    estimated: dict[str, str] = {}
    for model in models:
        if str(model.get("outcome") or "") != outcome:
            continue
        for key in (model.get("estimator"), model.get("family")):
            name = str(key or "").strip().lower()
            if name:
                estimated.setdefault(name, str(model.get("id") or ""))

    out: list[dict] = []

    def add(name: str, aliases: list[str], blocked: str = "", not_needed: str = "", needs: str = "") -> None:
        model = next((estimated[a] for a in aliases if a in estimated), "")
        if model:
            out.append(family(name, "estimated", model=model))
        elif blocked:
            out.append(family(name, "blocked", blocked))
        elif not_needed:
            out.append(family(name, "not_needed", not_needed))
        else:
            out.append(family(name, "available", needs=needs))

    if kind == "binary":
        add("logit", ["logit", "logistic"], needs="至少一个二值/分类预测变量")
        add("probit", ["probit"], needs="同 logit 的变量条件")
        add("cloglog", ["cloglog"], needs="比例风险或离散时间设定")
        add(
            "rare_events",
            ["rare_events", "firth", "relogit"],
            not_needed="" if (events and events < 50) else f"事件 {events}，不需要稀有事件校正",
            needs="Firth/惩罚似然；事件少时尤其值得考虑",
        )
        add("marginal_effects", ["marginal_effects", "ame", "margins"], needs="已估的 logit/probit 结果")
    elif kind == "count":
        add("poisson", ["poisson"], needs="非负整数结局（已有）")
        add("negbin", ["negbin", "nbreg", "negative_binomial"], needs="过度离散时优先")
        add("zero_inflated", ["zero_inflated", "zip", "zinb"], needs="零值多且零与正值机制不同")
        add("quantile", ["quantile", "qreg"], needs="想看分布上端/下端")
        if mean is not None and sd is not None and mean > 0:
            ratio = sd * sd / max(mean, 1e-9)
            if ratio < 1.2 and zeros == 0:
                out.append(family("negbin", "not_needed", why=f"方差与均值接近（sd²/mean={ratio:.2f}），泊松够用"))
    elif kind == "duration":
        add("ols", ["ols", "ols_level"], needs="作为连续时长的基准")
        add("quantile", ["quantile", "qreg"], needs="分布偏斜时比均值更稳")
        add(
            "survival_cox",
            ["survival_cox", "cox", "km", "survival"],
            blocked="没有事件时点/随访长度/删失标记：只有「结果值」无法构造生存时间",
            needs="随访时长 + 事件指示",
        )
        add("tobit", ["tobit"], needs="存在 0/下限截断时")
        add("robust_regression", ["robust_regression", "rlm", "huber"], needs="离群值明显时")
    elif kind == "amount":
        add("ols", ["ols", "ols_level"], needs="水平模型（基准）")
        add("ols_log", ["ols_log", "log_ols"], needs="右偏时取对数后解释弹性")
        add("tobit", ["tobit"], needs="大量 0 值/下限截断时")
        add("two_part", ["two_part", "hurdle"], needs="是否发生 + 发生多少是两套机制时")
        add("quantile", ["quantile", "qreg"], needs="关注分布上端（高额）")
    elif kind == "category":
        levels = len(stats.get("levels") or []) or None
        add("multinomial_logit", ["multinomial_logit", "mlogit", "multinom"], needs="无序多类别")
        add("ordered_logit", ["ordered_logit", "ologit", "ordered"], needs="类别有序（量表/等级）")
        if levels and levels <= 2:
            out.append(family("multinomial_logit", "not_needed", why="只有两个类别，用二值模型即可"))
    else:
        add("ols", ["ols", "ols_level"], needs="基准")
        add("quantile", ["quantile", "qreg"], needs="稳健性/分布异质")
        add("robust_regression", ["robust_regression", "rlm", "huber"], needs="离群值/异方差")
        add("cluster_robust", ["cluster_robust", "cluster"], needs="有聚类单位（学校/地区/个体）")
    if n and n < 30:
        for item in out:
            if item["status"] == "available" and not item.get("note"):
                item["note"] = "样本偏小，建议同时报告精确/自助法与敏感性分析"
    return out


def read_codebook(path: str) -> dict:
    """codebook 可以是 JSON（列名 → 说明），也可以是 md 里逐条写的表。

    这里只做保守解析：JSON 一定读；markdown 的表格行按「列名 | 类型 | 说明」取用。
    读不出来就返回空——**不要**因为读不懂 codebook 就把结局清单清空。
    """
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            text = handle.read()
    except OSError:
        return {}
    if path.lower().endswith(".json"):
        try:
            data = json.loads(text)
        except Exception:  # noqa: BLE001
            return {}
        if isinstance(data, dict):
            columns = data.get("columns") if isinstance(data.get("columns"), (dict, list)) else data
            if isinstance(columns, dict):
                return {str(k): v for k, v in columns.items() if isinstance(v, dict)}
            if isinstance(columns, list):
                return {str(item.get("name")): item for item in columns if isinstance(item, dict) and item.get("name")}
        return {}
    table: dict[str, dict] = {}
    for line in text.splitlines():
        if not line.strip().startswith("|") or line.count("|") < 3:
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2 or set(cells[0]) <= set("-: "):
            continue
        name = cells[0].strip("`* ")
        if not name or name.lower() in {"变量", "列", "name", "column"}:
            continue
        entry = {"type": cells[1].strip("`* ")}
        if len(cells) > 2:
            entry["role"] = cells[2].strip("`* ")
        table[name] = entry
    return table


def collect_outcomes(dataset: dict, frame, models: list[dict], codebook: dict, classified: list[dict]) -> list[dict]:
    """结局清单的来源，按可信度排序：

      1. codebook 显式声明（outcome: true / role 里含「结局/因变量」/ outcome_type）；
      2. output/models/index.json 里已登记的模型 outcome；
      3. 用户在注册表里写的 outcome 字段（dataset.outcomes / dataset.outcome）；
      4. 剩下的「疑似」列：只在没有 1–3 时补位，并标注 source=suspect，交 Agent 判断。
    """
    declared: dict[str, dict] = {}

    for column, entry in (codebook or {}).items():
        if not isinstance(entry, dict):
            continue
        flagged = any(entry.get(key) in (True, "true", "yes", 1) for key in ("outcome", "is_outcome"))
        role = str(entry.get("role") or "")
        declared_type = str(entry.get("outcome_type") or entry.get("type") or "")
        if flagged or "结局" in role or "因变量" in role or entry.get("outcome_type"):
            declared[column] = {"source": "codebook", "declared": declared_type, "role": role}

    for key in ("outcomes", "outcome"):
        value = dataset.get(key)
        for name in (value if isinstance(value, list) else [value]):
            if isinstance(name, str) and name:
                declared.setdefault(name, {"source": "registry", "declared": "", "role": ""})

    for model in models:
        if model.get("dataset") != dataset.get("id"):
            continue
        name = str(model.get("outcome") or "")
        if name:
            declared.setdefault(name, {"source": "models-index", "declared": "", "role": ""})

    for name in list(declared):
        if name not in frame.columns:
            declared.pop(name)

    if not declared:
        # 没有任何声明时才按列名提示补位：这是「候选」，不是断言。
        for column in frame.columns:
            if any(
                hint.lower() in str(column).lower()
                for words in SUSPECT_HINTS.values()
                for hint in words
            ):
                declared[str(column)] = {"source": "suspect", "declared": "", "role": ""}

    out = []
    for name, meta in declared.items():
        entry = codebook.get(name) if isinstance(codebook, dict) else None
        kind, stats = classify(frame[name], name, meta.get("declared") or "")
        out.append({"name": name, **meta, "type": kind, "stats": stats})
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--max-outcomes",
        type=int,
        default=0,
        help="每份数据集最多诊断多少个结局（0=不限；只在被怀疑的列上生效）",
    )
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    result = {"ok": False, "written": "", "datasets": [], "warnings": [], "scope": {}}

    index_path = os.path.join(root, "output", "datasets", "index.json")
    if not os.path.exists(index_path):
        result["error"] = "没有 output/datasets/index.json：先登记数据集（或用 research_registry.json 桥接）"
        write_out(args.out, result)
        return 2
    try:
        with open(index_path, "r", encoding="utf-8-sig") as handle:
            index = json.load(handle)
    except Exception as error:  # noqa: BLE001
        result["error"] = f"注册表读不懂：{error}"
        write_out(args.out, result)
        return 3
    models_path = os.path.join(root, "output", "models", "index.json")
    models: list[dict] = []
    if os.path.exists(models_path):
        try:
            with open(models_path, "r", encoding="utf-8-sig") as handle:
                models = [item for item in json.load(handle).get("models", []) if isinstance(item, dict)]
        except Exception as error:  # noqa: BLE001
            result["warnings"].append(f"output/models/index.json 读不懂（按没有模型处理）：{error}")

    try:
        import pandas as pd
    except Exception as error:  # noqa: BLE001
        result["error"] = f"需要 pandas：{error}"
        write_out(args.out, result)
        return 4

    # skill 的 research_registry.json 也能提供 codebook 路径：两份注册表谁在就用谁。
    skill_registry: dict[str, dict] = {}
    research_path = os.path.join(root, "research_registry.json")
    if os.path.exists(research_path):
        try:
            with open(research_path, "r", encoding="utf-8-sig") as handle:
                for item in json.load(handle).get("datasets", []):
                    if isinstance(item, dict) and item.get("id"):
                        skill_registry[str(item["id"])] = item
        except Exception:  # noqa: BLE001
            pass

    all_outcomes: list[dict] = []
    scanned = 0
    columns_total = 0
    for dataset in index.get("datasets", []):
        if not isinstance(dataset, dict):
            continue
        rel = dataset.get("file") or ""
        csv_path = os.path.join(root, rel)
        if not rel or not os.path.exists(csv_path):
            result["warnings"].append(f"{dataset.get('id')} 的数据集文件不存在：{rel}")
            continue
        try:
            frame = pd.read_csv(csv_path, encoding="utf-8-sig", low_memory=False)
        except Exception as error:  # noqa: BLE001
            result["warnings"].append(f"{rel} 读不出来：{error}")
            continue
        scanned += 1
        columns_total += len(frame.columns)

        codebook_rel = dataset.get("codebook") or skill_registry.get(str(dataset.get("id")), {}).get("codebook") or ""
        codebook = read_codebook(os.path.join(root, codebook_rel)) if codebook_rel else {}
        if codebook_rel and not codebook:
            result["warnings"].append(f"{codebook_rel} 没解析出列说明：结局只能按模型登记与列名提示")

        found = collect_outcomes(dataset, frame, models, codebook, [])
        suspects = [item for item in found if item.get("source") == "suspect"]
        if args.max_outcomes and len(suspects) > args.max_outcomes:
            keep = [item for item in found if item.get("source") != "suspect"]
            found = keep + suspects[: args.max_outcomes]
        outcomes = []
        for item in found:
            stats = item["stats"]
            outcomes.append(
                {
                    "name": item["name"],
                    "dataset": dataset.get("id") or "",
                    "source": item.get("source") or "",
                    "role": item.get("role") or role_hint(item["name"], codebook.get(item["name"])),
                    "type": item["type"],
                    "n": stats.get("n"),
                    "missing": stats.get("missing", 0),
                    "events": stats.get("events"),
                    "censored": False,
                    "diagnostics": diagnostics(item["type"], stats),
                    "families": families_for(item["type"], stats, item["name"], models),
                }
            )
        all_outcomes.extend(outcomes)
        result["datasets"].append({
            "id": dataset.get("id"),
            "rows": int(frame.shape[0]),
            "columns": len(frame.columns),
            "outcomes": outcomes,
            "codebook": codebook_rel,
        })

    result["scope"] = {
        "datasets": scanned,
        "columns": columns_total,
        "outcomeSources": sorted({item.get("source") for item in all_outcomes if item.get("source")}),
    }
    if not all_outcomes:
        result["error"] = (
            "没有可诊断的结局：codebook 没有标 outcome、模型登记里没有 outcome、列名也没有明显提示。"
            "请在 codebook 里给结局写 outcome: true / outcome_type，或在 registry 的 datasets[].outcomes 里列出。"
        )
        write_out(args.out, result)
        return 5

    payload = {
        "generatedBy": "sweep_models.py",
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
        # 三态语义：阈值只产生 diagnostics，族状态只有 estimated/available/blocked/not_needed 四值；
        # 每条 blocked 都必须写 why（结构性不可估），不许拿样本量当借口。
        "semantics": {
            "statuses": ["estimated", "available", "blocked", "not_needed"],
            "note": "available 表示数据形态支持、尚未估；由 Agent 结合研究问题决定补或不补，并在 model_plan 里说明。",
        },
        "scope": result["scope"],
        "outcomes": all_outcomes,
    }
    target = os.path.join(root, "output", "models", "sweep.json")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = f"{target}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, target)

    result["ok"] = True
    result["written"] = "output/models/sweep.json"
    write_out(args.out, result)
    print(json.dumps({"ok": True, "outcomes": len(all_outcomes), "datasets": scanned}, ensure_ascii=False))
    return 0


def write_out(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    sys.exit(main())
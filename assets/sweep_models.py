#!/usr/bin/env python3
"""模型族普查：只做诊断，不估参数。

为什么需要它：`auto_stats.py` 只认 logit / ols（`auto_stats.py:1257-1258`），
于是「刑期」永远只有 OLS、「罚金」永远只有 OLS——不是研究者选的，是脚本能做的。
普查表把「这个结局有哪些族可用、哪些用不了、缺什么」摊开：
闸门只要求每个族**表态**，不要求都估，但不许装作没这回事。

契约：
    python sweep_models.py --root <项目> --out <结果.json>
产物：output/models/sweep.json
    {"generatedBy":"sweep_models.py","at":"...","outcomes":[
       {"name":"prison_months","dataset":"analysis","role":"刑期","type":"duration",
        "n":362,"censored":false,"families":[
          {"family":"ols","status":"estimated","model":"M1"},
          {"family":"survival_cox","status":"blocked","why":"材料里没有释放日期/随访时间"}
        ]}]}
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

ROLE_HINTS = [
    ("sentence", "刑期"), ("prison", "刑期"), ("detention", "刑期"), ("months", "刑期"),
    ("fine", "罚金"), ("amount", "金额"), ("money", "金额"),
    ("suspended", "缓刑"), ("probation", "缓刑"), ("guilty", "定罪"), ("convict", "定罪"),
    ("charge", "罪名"), ("crime", "罪名"),
]


def hint_role(name: str) -> str:
    lower = name.lower()
    for key, role in ROLE_HINTS:
        if key in lower:
            return role
    return ""


def family(entry: str, status: str, why: str = "", model: str = "") -> dict:
    item = {"family": entry, "status": status}
    if model:
        item["model"] = model
    if why:
        item["why"] = why
    return item


DURATION_HINT = re.compile(r"month|duration|sentence|prison|term|days|years?|刑期|期限|时长|月数", re.I)
AMOUNT_HINT = re.compile(r"fine|amount|money|compensation|income|fee|cost|罚金|金额|赔偿|数额", re.I)
COUNT_HINT = re.compile(r"count|num|number|times|n_|次数|人数|个数|件数|被告人数", re.I)


def classify(series, name: str = "") -> tuple[str, dict]:
    """判结局的类型。

    先看列名（刑期/罚金这类语义无法只靠分布判断），再看取值：
    二值（0/1 或 1/2）→ binary；整数非负且取值多 → count；取值少 → category；其余 continuous。
    连续变量方差天然远大于均值，不能拿「sd² > mean」当计数变量的判据。
    """
    import pandas as pd

    numeric = pd.to_numeric(series, errors="coerce")
    values = numeric.dropna()
    stats = {
        "n": int(series.notna().sum()),
        "numeric": int(values.shape[0]),
        "zeros": int((values == 0).sum()),
        "min": float(values.min()) if len(values) else None,
        "max": float(values.max()) if len(values) else None,
        "mean": float(values.mean()) if len(values) else None,
        "sd": float(values.std()) if len(values) > 1 else None,
    }
    if not len(values):
        # 纯文本列：只能当类别
        text_n = int(series.dropna().astype(str).str.strip().replace("", pd.NA).dropna().shape[0])
        stats["n"] = text_n
        return "category", stats

    unique = sorted(set(float(item) for item in values.unique().tolist()))
    if len(unique) == 2 and set(unique) <= {0.0, 1.0}:
        stats["events"] = int((values == 1).sum())
        return "binary", stats
    if len(unique) == 2 and set(unique) <= {1.0, 2.0}:
        # 1/2 编码的二值变量：2 当事件
        stats["events"] = int((values == 2).sum())
        return "binary", stats

    integral = bool((values % 1 == 0).all())
    if DURATION_HINT.search(name or ""):
        return "duration", stats
    if AMOUNT_HINT.search(name or ""):
        return "amount", stats
    if integral and stats["min"] is not None and stats["min"] >= 0 and (len(unique) > 12 or COUNT_HINT.search(name or "")):
        return "count", stats
    if len(unique) <= 12:
        return "category", stats
    return "continuous", stats


def families_for(kind: str, stats: dict, outcome: str, models: list[dict]) -> list[dict]:
    n = int(stats.get("n") or 0)
    events = int(stats.get("events") or 0)
    zeros = int(stats.get("zeros") or 0)
    estimated = {}
    for model in models:
        if str(model.get("outcome") or "") != outcome:
            continue
        estimator = str(model.get("estimator") or "").lower()
        if estimator:
            estimated[estimator] = model.get("id") or ""

    out: list[dict] = []

    def add(name: str, aliases: list[str], why_blocked: str = "", why_not_needed: str = "") -> None:
        model = next((estimated[a] for a in aliases if a in estimated), "")
        if model:
            out.append(family(name, "estimated", model=model))
        elif why_blocked:
            out.append(family(name, "blocked", why_blocked))
        elif why_not_needed:
            out.append(family(name, "not_needed", why_not_needed))
        else:
            out.append(family(name, "available"))

    if kind == "binary":
        too_small = n < 50
        few_events = events < 10
        add("logit", ["logit"], "样本不足（N=%d）" % n if too_small else ("事件数太少（%d）" % events if few_events else ""))
        add("probit", ["probit"], "样本不足（N=%d）" % n if too_small else "")
        add("cloglog", ["cloglog"])
        add("rare_events", ["rare_events", "firth", "relogit"], "", "" if events and events < 50 else "事件数 %d，不需要稀有事件校正" % events)
    elif kind == "count":
        add("poisson", ["poisson"], "样本不足（N=%d）" % n if n < 30 else "")
        overdispersed = bool(stats.get("mean")) and bool(stats.get("sd")) and stats["sd"] > math.sqrt(max(stats["mean"], 1e-9))
        add("negbin", ["negbin", "nbreg", "negative_binomial"], "", "" if overdispersed else "方差不大：泊松够用（sd %.2f / mean %.2f）" % (stats.get("sd") or 0, stats.get("mean") or 0))
        zero_share = zeros / n if n else 0
        add("zero_inflated", ["zero_inflated", "zip", "zinb"], "", "" if zero_share > 0.3 else "零值只占 %.0f%%" % (zero_share * 100))
    elif kind == "duration":
        add("ols", ["ols", "ols_level"], "")
        add("quantile", ["quantile", "qreg"], "" if n >= 30 else "样本不足（N=%d）" % n)
        add("survival_cox", ["survival_cox", "cox"], "材料里没有随访时间/删失标记：刑期是「判多久」而不是「多久后发生」")
        has_zero = stats.get("min") is not None and stats["min"] <= 0
        add("tobit", ["tobit"], "", "" if has_zero else "没有 0 值，不需要左截断")
    elif kind == "amount":
        add("ols", ["ols", "ols_level"], "")
        add("ols_log", ["ols_log", "log_ols"], "")
        has_zero = zeros > 0
        add("tobit", ["tobit"], "", "" if has_zero else "没有 0 值，不需要左截断")
        add("two_part", ["two_part", "hurdle"], "", "" if has_zero else "没有 0 值，两部分模型与 OLS 等价")
    elif kind == "category":
        add("multinomial_logit", ["multinomial_logit", "mlogit", "multinom"], "" if n >= 50 else "样本不足（N=%d）" % n)
        add("ordered_logit", ["ordered_logit", "ologit", "ordered"])
    else:
        add("ols", ["ols", "ols_level"], "")
        add("quantile", ["quantile", "qreg"], "" if n >= 30 else "样本不足（N=%d）" % n)
        add("robust_regression", ["robust_regression", "rlm", "huber"])
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    result = {"ok": False, "written": "", "datasets": [], "warnings": []}

    index_path = os.path.join(root, "output", "datasets", "index.json")
    if not os.path.exists(index_path):
        result["error"] = "没有 output/datasets/index.json：先登记数据集（或采纳现有产物）"
        write_out(args.out, result)
        return 2
    try:
        index = json.loads(open(index_path, "r", encoding="utf-8-sig").read())
        models_index = json.loads(open(os.path.join(root, "output", "models", "index.json"), "r", encoding="utf-8-sig").read())
    except Exception as error:  # noqa: BLE001
        result["error"] = f"注册表读不懂：{error}"
        write_out(args.out, result)
        return 3

    models = [item for item in models_index.get("models", []) if isinstance(item, dict)]
    try:
        import pandas as pd
    except Exception as error:  # noqa: BLE001
        result["error"] = f"需要 pandas：{error}"
        write_out(args.out, result)
        return 4

    all_outcomes: list[dict] = []
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

        wanted: list[str] = []
        for model in models:
            if model.get("dataset") == dataset.get("id") and model.get("outcome"):
                wanted.append(str(model["outcome"]))
        for column in frame.columns:
            if hint_role(str(column)) and str(column) not in wanted:
                wanted.append(str(column))
        # 只保留真实存在的列；最多 8 个结局，避免把 50 列全扫一遍
        wanted = [name for name in dict.fromkeys(wanted) if name in frame.columns][:8]

        outcomes = []
        for name in wanted:
            series = frame[name]
            kind, stats = classify(series, name)
            item = {
                "name": name,
                "dataset": dataset.get("id") or "",
                "role": hint_role(name),
                "type": kind,
                "n": stats.get("n"),
                "censored": False,
                "families": families_for(kind, stats, name, models),
            }
            if stats.get("zeros"):
                item["note"] = f"0 值 {stats['zeros']} 行"
            outcomes.append(item)
        all_outcomes.extend(outcomes)
        result["datasets"].append({"id": dataset.get("id"), "rows": int(frame.shape[0]), "outcomes": outcomes})

    if not all_outcomes:
        result["error"] = "没有可普查的结局变量（注册表里没有模型 outcome，列名也没有刑期/罚金/缓刑之类）"
        write_out(args.out, result)
        return 5

    payload = {
        "generatedBy": "sweep_models.py",
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
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
    print(json.dumps({"ok": True, "outcomes": len(all_outcomes)}, ensure_ascii=False))
    return 0


def write_out(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    sys.exit(main())

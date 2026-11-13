#!/usr/bin/env python3
"""逐格回源：把数据集里的引文格，逐条回查到源文件，留下「页 + 字符区间 + 原句」。

为什么要它：闸门能查「文件在不在」「N 对不对」，但查不了「这一格是不是编的」。
真实项目里 388 行数据据说是从 223 份判决书里抽的——这件事只能靠回源证明，
而人工核 388 条要半天。脚本跑一遍 30 秒。

判定三态（与闸门一致，不许含糊）：
    pass     原句在源文里逐字符命中
    noise    只在「去掉空白/页眉页脚」后命中（真实项目里 24/381 都是这一类）
    missing  找不到（或只找到不到 60% 的片段）——这才是「没有原文支撑」

契约：
    python verify_source.py --root <项目> --out <结果.json> [--mode build|verify] [--dataset id] [--limit N]
输入：output/datasets/index.json 里每份数据集的
    provenance.sourceColumn（哪一列是源文件相对路径）
    provenance.quoteColumn （哪一列是要回源的原句）
    provenance.sourceRoot  （源文件根目录，默认 data）
产物：
    output/datasets/<id>/extract.jsonl      每格一行
    output/datasets/<id>/extract.meta.json  每个字段的覆盖率（闸门读它）
    output/verify/cell_checks.csv           人可读的对账单
"""

from __future__ import annotations

import argparse
import csv
import difflib
import json
import os
import re
import sys
from datetime import datetime

try:  # Windows 控制台默认 cp936，中文 JSON 会炸
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

WS = re.compile(r"\s+")
# 页码/页眉是真实项目里最主要的「差异来源」：判决书 3/3 会被插进句子中间。
# 这类差异不是造假，单独记 noise；但必须先证明「去掉页码后逐字符命中」。
PAGE_NOISE = re.compile(r"(?:判决书|裁定书|调解书)?\s*\d+\s*/\s*\d+")
# 标点/空白差异同样不是造假：数据集里的引文常被清洗过（全角变半角、去掉空格）。
# 去掉标点后再做一次**连续**匹配，仍然要求整段连续出现，不是按覆盖率猜。
LOOSE = re.compile(r"[，,。.；;：:！!？?（）()\[\]【】“”\"'‘’《》<>·\s、—–\-]+")


def norm(text: str) -> str:
    return WS.sub("", text or "")


def strip_noise(text: str) -> str:
    return PAGE_NOISE.sub("", text or "")


def loose(text: str) -> str:
    return LOOSE.sub("", text or "")


def header_candidates(pages: list[tuple[int, str]]) -> set[str]:
    """在多页里重复出现的短行，基本就是页眉（判决书标题）/页脚。

    真实项目里剩下的 15 条 miss 全是这一类：句子中间被插入了
    「蒋云海非法捕捞水产品罪一审刑事」这种书名式页眉。
    """
    counts: dict[str, int] = {}
    for _page_no, text in pages:
        seen = set()
        for line in (text or "").splitlines():
            item = line.strip()
            if not item or len(item) > 60 or item in seen:
                continue
            seen.add(item)
            counts[item] = counts.get(item, 0) + 1
    return {line for line, count in counts.items() if count >= 2}


def strip_headers(text: str, headers: set[str]) -> str:
    if not headers:
        return text or ""
    return "\n".join(line for line in (text or "").splitlines() if line.strip() not in headers)


def read_csv_rows(path: str) -> tuple[list[str], list[dict]]:
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def index_sources(root: str) -> tuple[dict, dict, dict]:
    """建三份索引，解决「引文里的相对路径从哪算起」这个真实歧义：

    - by_rel   相对 sourceRoot 的完整路径
    - by_tail  去掉第一层目录后的路径（材料挂在 data/<挂载名>/ 下时，数据里常写 <挂载名>/ 之后的部分）
    - by_name  文件名 → 绝对路径列表（重名时**不猜**，直接判 missing）
    """
    by_rel: dict[str, str] = {}
    by_tail: dict[str, list[str]] = {}
    by_name: dict[str, list[str]] = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            abs_path = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_path, root).replace("\\", "/")
            by_rel[rel] = abs_path
            parts = rel.split("/")
            if len(parts) > 1:
                tail = "/".join(parts[1:])
                by_tail.setdefault(tail, []).append(abs_path)
            by_name.setdefault(name, []).append(abs_path)
    return by_rel, by_tail, by_name


def resolve_source(by_rel: dict, by_tail: dict, by_name: dict, rel: str) -> tuple[str, str]:
    """返回 (绝对路径, 失败原因)。"""
    normalized = rel.replace("\\", "/").lstrip("./")
    if normalized in by_rel:
        return by_rel[normalized], ""
    tails = by_tail.get(normalized) or []
    if len(tails) == 1:
        return tails[0], ""
    if len(tails) > 1:
        return "", f"同名路径有 {len(tails)} 个，无法确定是哪一份"
    names = by_name.get(os.path.basename(normalized)) or []
    if len(names) == 1:
        return names[0], ""
    if len(names) > 1:
        return "", f"同名文件有 {len(names)} 个（不同目录），无法确定是哪一份"
    return "", "源文件找不到"


def page_texts(path: str) -> list[tuple[int, str]]:
    # 文本类材料直接读（测试与纯文本语料都走这条），PDF 才用 PyMuPDF 逐页取
    if not path.lower().endswith(".pdf"):
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            return [(1, handle.read())]

    import fitz  # PyMuPDF

    pages: list[tuple[int, str]] = []
    with fitz.open(path) as doc:
        for index, page in enumerate(doc):
            try:
                pages.append((index + 1, page.get_text("text")))
            except Exception:  # noqa: BLE001
                pages.append((index + 1, ""))
    return pages


def bigram_coverage(quote: str, text: str) -> float:
    """2-gram 覆盖率：只用来解释「差多少」，不拿它判 pass/noise。"""
    a = norm(quote)
    b = norm(text)
    if len(a) < 2:
        return 1.0 if a and a in b else 0.0
    grams = [a[i : i + 2] for i in range(len(a) - 1)]
    hits = sum(1 for gram in grams if gram in b)
    return round(hits / float(len(grams)), 3)


def combined_index(pages: list[tuple[int, str]], transform) -> tuple[str, list[tuple[int, int]]]:
    """把各页转换后拼成一整篇，并记住每页在拼接串里的起点。

    为什么不能只逐页找：判项常常跨页（「判处有期徒刑一年，」在页末、「缓刑二年」在下一页），
    真实项目里 33/388 就是这么 miss 的。整篇拼接后命中，再按偏移反查页号。
    """
    chunks = []
    starts: list[tuple[int, int]] = []
    total = 0
    for page_no, text in pages:
        piece = transform(text)
        starts.append((page_no, total))
        chunks.append(piece)
        total += len(piece)
    return "".join(chunks), starts


def page_of(starts: list[tuple[int, int]], offset: int) -> int | None:
    page_no = None
    for number, start in starts:
        if start <= offset:
            page_no = number
        else:
            break
    return page_no


def segmented_match(needle: str, hay: str, max_gap: int = 320) -> dict | None:
    """允许句子中间被插入一小段（页眉/当事人名单），但引文本身必须逐字命中。

    用最长匹配块对齐（不是贪心）：贪心遇到重复段落会跳错位置。
    硬条件：引文的**每一个字**都要按序出现在原文里（covered == len(needle)），
    只是原文里可以多出几段（总空隙 ≤ max_gap）。改一个数字就过不了——
    这就是「不许编」的那道线。
    """
    if not needle or not hay or len(needle) < 24:
        return None
    anchor = needle[:8]
    start = hay.find(anchor)
    if start < 0:
        return None
    window = hay[start : start + len(needle) + 900]
    matcher = difflib.SequenceMatcher(None, needle, window, autojunk=False)
    blocks = [item for item in matcher.get_matching_blocks() if item.size >= 4]
    if not blocks:
        return None
    covered = sum(item.size for item in blocks)
    if covered != len(needle):
        return None
    gap = 0
    last = 0
    for item in blocks:
        gap += item.b - last
        last = item.b + item.size
    if gap > max_gap:
        return None
    return {"gaps": gap, "coverage": round(covered / float(len(needle)), 3), "at": start + blocks[0].b}


def locate(quote: str, pages: list[tuple[int, str]]) -> dict:
    """返回 {status, page, start, end, coverage, note}。

    pass     原句逐字符命中（start/end 是原文偏移）
    noise    去掉空白 / 页码 / 标点后才连续命中（不编造偏移，只给页号与页数）
    missing  其余——没有原文支撑
    """
    if not quote or not quote.strip():
        return {"status": "missing", "page": None, "start": None, "end": None, "coverage": 0.0, "note": "空引文"}

    # 1) 逐页逐字符：能拿到精确偏移
    for page_no, text in pages:
        at = text.find(quote)
        if at >= 0:
            return {"status": "pass", "page": page_no, "start": at, "end": at + len(quote), "coverage": 1.0, "note": ""}

    # 2) 整篇逐字符：跨页命中（偏移是拼接后的，页号按片段起点反查）
    combined, starts = combined_index(pages, lambda text: text)
    at = combined.find(quote)
    if at >= 0:
        return {
            "status": "pass",
            "page": page_of(starts, at),
            "start": at,
            "end": at + len(quote),
            "coverage": 1.0,
            "note": "原句跨页，按整篇拼接命中",
        }

    # 3) 空白差异
    needle = norm(quote)
    combined, starts = combined_index(pages, norm)
    at = combined.find(needle) if needle else -1
    if at >= 0:
        return {
            "status": "noise",
            "page": page_of(starts, at),
            "start": None,
            "end": None,
            "coverage": 1.0,
            "note": "原句与原文只差空白/换行",
        }

    # 4) 页码/页眉插进句子
    needle = strip_noise(norm(quote))
    combined, starts = combined_index(pages, lambda text: strip_noise(norm(text)))
    at = combined.find(needle) if needle else -1
    if at >= 0:
        return {
            "status": "noise",
            "page": page_of(starts, at),
            "start": None,
            "end": None,
            "coverage": 1.0,
            "note": "原句被页码/页眉打断，去掉页码后连续命中",
        }

    # 5) 标点/空白差异（引文被清洗过）
    needle = loose(strip_noise(norm(quote)))
    combined, starts = combined_index(pages, lambda text: loose(strip_noise(norm(text))))
    at = combined.find(needle) if needle else -1
    if at >= 0:
        return {
            "status": "noise",
            "page": page_of(starts, at),
            "start": None,
            "end": None,
            "coverage": 1.0,
            "note": "原句只在去掉标点/空白后连续命中（引文被清洗过）",
        }

    # 6) 页眉插进句子：先删掉「多页重复的短行」，再做同样的宽松匹配
    plain, plain_starts = combined, starts
    headers = header_candidates(pages)
    combined, starts = combined_index(
        pages, lambda text: loose(strip_noise(norm(strip_headers(text, headers))))
    )
    at = combined.find(needle) if needle else -1
    if at >= 0:
        return {
            "status": "noise",
            "page": page_of(starts, at),
            "start": None,
            "end": None,
            "coverage": 1.0,
            "note": "原句被页眉/页脚打断，去掉重复行后连续命中",
        }

    # 7) 句子中间插了一小段（单页文档的当事人名单/案由，只出现一次）：分块对齐容错
    #    用未删行的版本——删行可能把正文行一起删掉
    hit = segmented_match(needle, plain)
    if hit:
        return {
            "status": "noise",
            "page": page_of(plain_starts, hit["at"]),
            "start": None,
            "end": None,
            "coverage": hit["coverage"],
            "note": f"原句中间插进了 {hit['gaps']} 字（页眉/当事人名单），其余逐字命中",
        }

    # 8) 都不中：给一个「最接近多少」的解释，但仍然判 missing
    best = {"status": "missing", "page": None, "start": None, "end": None, "coverage": 0.0, "note": "找不到原句"}
    for page_no, text in pages:
        coverage = bigram_coverage(quote, text)
        if coverage > best["coverage"]:
            best = {
                "status": "missing",
                "page": page_no,
                "start": None,
                "end": None,
                "coverage": coverage,
                "note": f"最接近的一页只覆盖 {coverage:.0%}：这句话多半不是原文",
            }
    return best


def row_key(row: dict, grain: list[str], index: int) -> str:
    parts = [str(row.get(key, "")).strip() for key in grain if str(row.get(key, "")).strip()]
    return "|".join(parts) if parts else f"row{index + 1}"


def process_dataset(root: str, dataset: dict, mode: str, limit: int, warnings: list[str]) -> dict:
    rel_file = dataset.get("file") or ""
    source_root_rel = (dataset.get("provenance") or {}).get("sourceRoot") or "data"
    source_col = (dataset.get("provenance") or {}).get("sourceColumn") or ""
    quote_col = (dataset.get("provenance") or {}).get("quoteColumn") or ""
    dataset_id = dataset.get("id") or "dataset"

    info = {
        "id": dataset_id,
        "rows": 0,
        "ledger": f"output/datasets/{dataset_id}/extract.jsonl",
        "meta": f"output/datasets/{dataset_id}/extract.meta.json",
        "fields": [],
        "skipped": 0,
        "warnings": [],
    }
    if not rel_file or not quote_col or not source_col:
        info["warnings"].append(
            f"{dataset_id} 缺 provenance.sourceColumn/quoteColumn：不知道该拿哪一列回源，跳过"
        )
        return info

    csv_path = os.path.join(root, rel_file)
    if not os.path.exists(csv_path):
        info["warnings"].append(f"{dataset_id} 的数据集文件不存在：{rel_file}")
        return info

    header, rows = read_csv_rows(csv_path)
    if quote_col not in header or source_col not in header:
        info["warnings"].append(f"{dataset_id} 的列不在表里：{source_col} / {quote_col}")
        return info

    source_root = os.path.join(root, source_root_rel)
    if not os.path.isdir(source_root):
        info["warnings"].append(f"{dataset_id} 的源根不存在：{source_root_rel}")
        return info
    by_rel, by_tail, by_name = index_sources(source_root)

    grain = [key for key in (dataset.get("grainKeys") or []) if key in header]
    cache: dict[str, list[tuple[int, str]]] = {}
    ledger: list[dict] = []
    checks: list[dict] = []
    fields = {quote_col: {"name": quote_col, "cells": 0, "covered": 0, "noise": 0, "missing": 0, "skipped": 0}}

    total = rows if not limit else rows[:limit]
    for index, row in enumerate(total):
        quote = str(row.get(quote_col, "") or "").strip()
        rel = str(row.get(source_col, "") or "").strip().replace("\\", "/")
        if not quote:
            fields[quote_col]["cells"] += 0
            info["skipped"] += 1
            continue
        fields[quote_col]["cells"] += 1
        key = row_key(row, grain, index)

        if not rel:
            fields[quote_col]["missing"] += 1
            checks.append({"dataset": dataset_id, "row": index + 1, "row_key": key, "field": quote_col,
                           "status": "missing", "page": "", "coverage": 0, "file": "", "quote": quote[:80],
                           "note": "这一行没有源文件路径"})
            continue

        abs_path, why = resolve_source(by_rel, by_tail, by_name, rel)
        if not abs_path or not os.path.isfile(abs_path):
            fields[quote_col]["missing"] += 1
            checks.append({"dataset": dataset_id, "row": index + 1, "row_key": key, "field": quote_col,
                           "status": "missing", "page": "", "coverage": 0, "file": rel, "quote": quote[:80],
                           "note": why or "源文件找不到"})
            continue

        if abs_path not in cache:
            try:
                cache[abs_path] = page_texts(abs_path)
            except Exception as error:  # noqa: BLE001
                cache[abs_path] = []
                warnings.append(f"读不了 {rel}：{error}")
        hit = locate(quote, cache[abs_path])
        status = hit["status"]
        if status == "pass":
            fields[quote_col]["covered"] += 1
        elif status == "noise":
            fields[quote_col]["covered"] += 1
            fields[quote_col]["noise"] += 1
        else:
            fields[quote_col]["missing"] += 1

        ledger.append(
            {
                "row": index + 1,
                "row_key": key,
                "field": quote_col,
                "value": quote,
                "src": {
                    "file": rel,
                    "page": hit["page"],
                    "charStart": hit["start"],
                    "charEnd": hit["end"],
                    "quote": quote,
                    "coverage": hit["coverage"],
                },
                "method": "verbatim" if status == "pass" else ("normalized" if status == "noise" else "none"),
                "status": status,
                "extractor": {"name": "verify_source.py", "field": quote_col},
                "note": hit["note"],
            }
        )
        checks.append({"dataset": dataset_id, "row": index + 1, "row_key": key, "field": quote_col,
                       "status": status, "page": hit["page"] or "", "coverage": hit["coverage"],
                       "file": rel, "quote": quote[:80], "note": hit["note"]})

    info["rows"] = len(total)
    info["fields"] = list(fields.values())

    ledger_path = os.path.join(root, "output", "datasets", dataset_id, "extract.jsonl")
    os.makedirs(os.path.dirname(ledger_path), exist_ok=True)
    if mode == "build":
        tmp = f"{ledger_path}.tmp-{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as handle:
            for item in ledger:
                handle.write(json.dumps(item, ensure_ascii=False) + "\n")
        os.replace(tmp, ledger_path)
        meta = {
            "dataset": dataset_id,
            "mode": mode,
            "builtAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "script": "verify_source.py",
            "rows": len(total),
            "source": {"root": source_root_rel, "fileColumn": source_col, "quoteColumn": quote_col},
            "fields": info["fields"],
            "cellChecks": "output/verify/cell_checks.csv",
        }
        meta_path = os.path.join(root, "output", "datasets", dataset_id, "extract.meta.json")
        with open(meta_path, "w", encoding="utf-8") as handle:
            json.dump(meta, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

    info["_checks"] = checks
    return info


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--mode", default="build", choices=["build", "verify"])
    parser.add_argument("--dataset", default="")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    result = {"ok": False, "mode": args.mode, "datasets": [], "cells": {"pass": 0, "noise": 0, "missing": 0}, "warnings": []}

    index_path = os.path.join(root, "output", "datasets", "index.json")
    if not os.path.exists(index_path):
        result["error"] = "没有 output/datasets/index.json：先在面板点「采纳现有产物」或用 data_analysis_register 登记数据集"
        write_out(args.out, result)
        return 2
    try:
        index = json.loads(open(index_path, "r", encoding="utf-8-sig").read())
    except Exception as error:  # noqa: BLE001
        result["error"] = f"datasets/index.json 读不懂：{error}"
        write_out(args.out, result)
        return 3

    datasets = [item for item in index.get("datasets", []) if isinstance(item, dict)]
    if args.dataset:
        datasets = [item for item in datasets if item.get("id") == args.dataset]
    if not datasets:
        result["error"] = "注册表里没有可回源的数据集（需要 provenance.sourceColumn 与 quoteColumn）"
        write_out(args.out, result)
        return 4

    all_checks: list[dict] = []
    for dataset in datasets:
        info = process_dataset(root, dataset, args.mode, args.limit, result["warnings"])
        all_checks.extend(info.pop("_checks", []))
        result["datasets"].append(info)

    for check in all_checks:
        status = check["status"]
        if status == "pass":
            result["cells"]["pass"] += 1
        elif status == "noise":
            result["cells"]["noise"] += 1
        else:
            result["cells"]["missing"] += 1

    if all_checks:
        target = os.path.join(root, "output", "verify", "cell_checks.csv")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = f"{target}.tmp-{os.getpid()}"
        columns = ["dataset", "row", "row_key", "field", "status", "page", "coverage", "file", "quote", "note"]
        with open(tmp, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            for check in all_checks:
                writer.writerow({key: check.get(key, "") for key in columns})
        os.replace(tmp, target)

    result["ok"] = True
    write_out(args.out, result)
    print(json.dumps({k: result[k] for k in ("ok", "mode", "cells")}, ensure_ascii=False))
    return 0


def write_out(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    sys.exit(main())

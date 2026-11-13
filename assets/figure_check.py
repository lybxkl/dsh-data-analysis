#!/usr/bin/env python3
"""实测图表合规：最小字号、页面宽度、有效 dpi。

为什么需要它：chart_manifest.csv 常常不写 min_fontsize，而 fig-font 闸门
「缺列就判不了」。与其让每个项目自己写一遍 wrapper（真实项目里就写了 61 行），
不如由工作台从每张图的 PDF 里量一次，写进 output/artifacts/measure.json——
技能产物一个字节都不改，readFigures 会把实测值合并进来。

契约：
    python figure_check.py --root <项目> --out <结果.json>
结果 JSON：
    {"ok":true,"written":"output/artifacts/measure.json","figures":46,"measured":46,
     "minFont":7.4,"missingPdf":0,"warnings":[]}
measure.json：
    {"at":"...","script":"figure_check.py",
     "byPng":{"figures/fig01.png":{"minFont":7.4,"dpi":600.0,"pxWidth":3000,"pageWidthIn":5.0,"pages":1}}}
"""

from __future__ import annotations

import csv
import json
import os
import sys

MANIFESTS = [
    "output/chart_pack/chart_manifest.csv",
    "output/figures/paper_figures_manifest.csv",
]


def read_rows(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def pick(row: dict, keys: list[str]) -> str:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return str(value)
    return ""


def resolve(base: str, root: str, value: str) -> str:
    if not value:
        return ""
    value = value.replace("\\", os.sep)
    if os.path.isabs(value):
        return value
    candidate = os.path.abspath(os.path.join(base, value))
    if os.path.exists(candidate):
        return candidate
    return os.path.abspath(os.path.join(root, value))


def measure_pdf(path: str) -> dict:
    import fitz  # PyMuPDF

    min_size = None
    pages = 0
    page_width_in = None
    with fitz.open(path) as doc:
        pages = doc.page_count
        for page in doc:
            if page_width_in is None:
                page_width_in = float(page.rect.width) / 72.0
            try:
                data = page.get_text("dict")
            except Exception:  # noqa: BLE001
                continue
            for block in data.get("blocks", []):
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        text = str(span.get("text", "")).strip()
                        if not text:
                            continue
                        size = float(span.get("size", 0) or 0)
                        if size <= 0:
                            continue
                        if min_size is None or size < min_size:
                            min_size = size
    return {"minFont": round(min_size, 2) if min_size else None, "pages": pages, "pageWidthIn": page_width_in}


def png_width(path: str) -> float | None:
    try:
        from PIL import Image

        with Image.open(path) as image:
            return float(image.size[0])
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    result = {"ok": False, "written": "", "figures": 0, "measured": 0, "minFont": None, "missingPdf": 0, "warnings": []}

    manifest = ""
    for rel in MANIFESTS:
        candidate = os.path.join(root, rel)
        if os.path.exists(candidate):
            manifest = candidate
            break
    if not manifest:
        result["error"] = "没有找到 chart_manifest.csv（先跑第 6 阶段）"
        write_out(args.out, result)
        return 2

    base = os.path.dirname(manifest)
    try:
        rows = read_rows(manifest)
    except Exception as error:  # noqa: BLE001
        result["error"] = f"清单读不出来：{error}"
        write_out(args.out, result)
        return 3

    by_png: dict[str, dict] = {}
    measured = 0
    fonts: list[float] = []
    for row in rows:
        png_rel = pick(row, ["png", "file"]).replace("\\", "/")
        pdf_rel = pick(row, ["pdf"]).replace("\\", "/")
        if not png_rel and not pdf_rel:
            continue
        entry: dict = {}
        if pdf_rel:
            pdf_abs = resolve(base, root, pdf_rel)
            if os.path.isfile(pdf_abs):
                try:
                    info = measure_pdf(pdf_abs)
                    entry.update({k: v for k, v in info.items() if v is not None})
                    if info.get("minFont") is not None:
                        fonts.append(float(info["minFont"]))
                    measured += 1
                except Exception as error:  # noqa: BLE001
                    result["warnings"].append(f"{pdf_rel} 量不了：{error}")
            else:
                result["missingPdf"] += 1
        png_abs = resolve(base, root, png_rel) if png_rel else ""
        if png_abs and os.path.isfile(png_abs):
            width = png_width(png_abs)
            if width:
                entry["pxWidth"] = width
                page_width = entry.get("pageWidthIn")
                if page_width:
                    entry["dpi"] = round(width / page_width, 1)
        if entry and png_rel:
            by_png[png_rel] = entry
            # 清单里可能只写文件名：再放一份 basename 键，readFigures 两种都能命中
            by_png.setdefault(os.path.basename(png_rel), entry)

    if not by_png:
        result["error"] = "清单里没有可用行（png/pdf 都不存在？）"
        write_out(args.out, result)
        return 4

    payload = {
        "at": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "script": "figure_check.py",
        "manifest": os.path.relpath(manifest, root).replace("\\", "/"),
        "byPng": by_png,
    }
    target = os.path.join(root, "output", "artifacts", "measure.json")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = f"{target}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, target)

    result.update(
        {
            "ok": True,
            "written": os.path.relpath(target, root).replace("\\", "/"),
            "figures": len({k for k in by_png if "/" in k or os.sep in k}) or len(by_png),
            "measured": measured,
            "minFont": round(min(fonts), 2) if fonts else None,
        }
    )
    write_out(args.out, result)
    print(json.dumps(result, ensure_ascii=False))
    return 0


def write_out(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    sys.exit(main())

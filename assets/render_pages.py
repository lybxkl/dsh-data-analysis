#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 PDF 页 / 图片统一渲染成 PNG，供多模态模型识别。

为什么放在工作台自己的 assets/ 里而不是技能包里：
技能是只读的，而且「渲染成图给模型看」是工作台这条识图通道的实现细节，不属于研究流程。

调用约定（一次一个 job 文件，结果写回 result 文件，Node 侧只读 JSON）：
    python render_pages.py --job job.json --result result.json

job.json:
    {
      "mode": "count" | "render" | "image",
      "dpi": 150,
      "maxEdge": 2600,
      "outDir": "临时输出目录",              # render 用
      "items": [ {"id": "...", "path": "...", "pages": "1-20", "out": "x.png"} ]
    }

result.json:
    {"ok": true, "mode": "...", "items": [ {"id": "...", "ok": true, "pages": 12,
                                            "images": [{"page": 1, "file": "...", "bytes": 12345, "width": 1240, "height": 1754}],
                                            "file": "...", "bytes": 123} ]}

一条失败不影响其它条：错误写在 items[i].error 里，ok=false 只表示「整体没能开始」
（比如 job 文件读不了）。绝不静默降级：渲染不出来就报错，不返回空图。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

MAX_PAGES_PER_ITEM = 200


def resample_filter():
    """Pillow 10 把重采样常量挪进了 Image.Resampling；两边都兼容。"""
    from PIL import Image

    return getattr(Image, "LANCZOS", None) or Image.Resampling.LANCZOS


def is_pdf(path):
    return os.path.splitext(path)[1].lower() == ".pdf"


def parse_pages(spec, total):
    """把 "1-20" / "3" / "1,3,5-7" / "" 解析成页号列表（1 基），并按总页数裁剪。"""
    if total <= 0:
        return []
    text = str(spec or "").strip()
    if not text:
        return list(range(1, min(total, MAX_PAGES_PER_ITEM) + 1))
    wanted = []
    for chunk in text.replace("，", ",").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            left, _, right = chunk.partition("-")
            try:
                start = int(left) if left.strip() else 1
                end = int(right) if right.strip() else total
            except ValueError:
                continue
            if start > end:
                start, end = end, start
            wanted.extend(range(start, end + 1))
        else:
            try:
                wanted.append(int(chunk))
            except ValueError:
                continue
    pages = []
    seen = set()
    for page in wanted:
        if 1 <= page <= total and page not in seen:
            seen.add(page)
            pages.append(page)
    return pages[:MAX_PAGES_PER_ITEM]


def clamp_size(width, height, max_edge):
    """按最长边等比缩小，避免把 4000px 的扫描页整张塞给模型。"""
    longest = max(width, height)
    if longest <= max_edge:
        return width, height
    scale = max_edge / float(longest)
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def count_pdf(path):
    import fitz  # PyMuPDF

    doc = fitz.open(path)
    try:
        return int(doc.page_count)
    finally:
        doc.close()


def render_pdf(item, job):
    """把 PDF 的指定页渲染成 PNG，返回 images 列表。"""
    import fitz  # PyMuPDF

    dpi = int(job.get("dpi") or 150)
    max_edge = int(job.get("maxEdge") or 2600)
    out_dir = job.get("outDir") or ""
    path = item["path"]
    doc = fitz.open(path)
    images = []
    try:
        total = int(doc.page_count)
        pages = parse_pages(item.get("pages"), total)
        for page_no in pages:
            page = doc.load_page(page_no - 1)
            try:
                pix = page.get_pixmap(dpi=dpi, alpha=False)
            except TypeError:  # 老版本 PyMuPDF 没有 dpi 参数
                zoom = dpi / 72.0
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            width, height = clamp_size(pix.width, pix.height, max_edge)
            name = "p%04d.png" % page_no
            target = os.path.join(out_dir, name)
            if (width, height) != (pix.width, pix.height):
                # 缩放也要落在文件上：模型看到的尺寸即 input_sha256 的输入
                from PIL import Image

                tmp = os.path.join(out_dir, name + ".raw.png")
                pix.save(tmp)
                with Image.open(tmp) as raw:
                    raw = raw.convert("RGB").resize((width, height), resample_filter())
                    raw.save(target, format="PNG", optimize=True)
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            else:
                pix.save(target)
            images.append({
                "page": page_no,
                "file": target,
                "bytes": os.path.getsize(target),
                "width": width,
                "height": height,
            })
        return {"pages": total, "images": images}
    finally:
        doc.close()


def image_to_png(item, job):
    """把任意位图转成 PNG（模型只吃 PNG/JPEG/WebP/GIF，tif/bmp/heic 必须先转）。"""
    from PIL import Image

    max_edge = int(job.get("maxEdge") or 2600)
    out = item.get("out") or ""
    with Image.open(item["path"]) as img:
        if getattr(img, "n_frames", 1) > 1:
            img.seek(0)  # GIF 取首帧
        has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
        img = img.convert("RGBA" if has_alpha else "RGB")
        width, height = clamp_size(img.width, img.height, max_edge)
        if (width, height) != (img.width, img.height):
            img = img.resize((width, height), resample_filter())
        img.save(out, format="PNG", optimize=True)
        return {"file": out, "bytes": os.path.getsize(out), "width": width, "height": height, "pages": 1}


def run_job(job):
    mode = job.get("mode") or "count"
    out_dir = job.get("outDir") or ""
    if mode in ("render", "image") and out_dir:
        os.makedirs(out_dir, exist_ok=True)
    results = []
    for item in job.get("items") or []:
        entry = {"id": item.get("id"), "ok": False}
        try:
            path = item.get("path") or ""
            if not path or not os.path.isfile(path):
                raise RuntimeError("文件不存在：%s" % path)
            if mode == "count":
                # 图片没有「页」的概念，直接 1 页；只有 PDF 才去问 PyMuPDF
                entry.update({"ok": True, "pages": count_pdf(path) if is_pdf(path) else 1})
            elif mode == "render":
                info = render_pdf(item, job)
                entry.update({"ok": True, "pages": info["pages"], "images": info["images"]})
            elif mode == "image":
                info = image_to_png(item, job)
                entry.update({"ok": True, "pages": 1, "file": info["file"], "bytes": info["bytes"],
                              "width": info["width"], "height": info["height"]})
            else:
                raise RuntimeError("未知 mode：%s" % mode)
        except Exception as exc:  # noqa: BLE001 - 一条失败不能拖垮整批
            message = "%s: %s" % (type(exc).__name__, exc)
            ext = os.path.splitext(str(item.get("path") or ""))[1].lower()
            if ext in (".heic", ".heif"):
                message += "（HEIC 需要 pillow-heif：pip install pillow-heif，或先导出为 JPG/PNG）"
            entry["error"] = message
            entry["trace"] = traceback.format_exc(limit=3)
        results.append(entry)
    return {"ok": True, "mode": mode, "items": results}


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--result", required=True)
    args = parser.parse_args(argv)

    payload = {"ok": False, "items": [], "error": ""}
    try:
        with open(args.job, "r", encoding="utf-8") as fh:
            job = json.load(fh)
        payload = run_job(job)
    except Exception as exc:  # noqa: BLE001
        payload["error"] = "%s: %s" % (type(exc).__name__, exc)
        payload["trace"] = traceback.format_exc(limit=5)

    with open(args.result, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

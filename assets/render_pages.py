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


def image_frames(path, limit=200):
    """多帧图像（多页 TIFF、动态 GIF）有多少「页」。单帧返回 1。"""
    if is_pdf(path):
        return count_pdf(path)
    from PIL import Image

    with Image.open(path) as img:
        return max(1, min(int(getattr(img, "n_frames", 1) or 1), limit))


def image_to_png(item, job):
    """把任意位图转成 PNG（模型只吃 PNG/JPEG/WebP/GIF，tif/bmp/heic 必须先转）。

    多帧图不能只转第一帧：那样 vision_log 里是一行 status=ok，剩下的页却从来没被识别，
    属于「静默丢页」。这里逐帧输出，页号即帧号。
    """
    from PIL import Image

    max_edge = int(job.get("maxEdge") or 2600)
    out = item.get("out") or ""
    images = []
    with Image.open(item["path"]) as img:
        frames = max(1, min(int(getattr(img, "n_frames", 1) or 1), 200))
        for index in range(frames):
            if frames > 1:
                try:
                    img.seek(index)
                except EOFError:
                    break
            target = out if frames == 1 else "%s.f%04d.png" % (out[:-4] if out.endswith(".png") else out, index + 1)
            has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
            frame = img.convert("RGBA" if has_alpha else "RGB")
            width, height = clamp_size(frame.width, frame.height, max_edge)
            if (width, height) != (frame.width, frame.height):
                frame = frame.resize((width, height), resample_filter())
            frame.save(target, format="PNG", optimize=True)
            images.append({
                "page": index + 1,
                "file": target,
                "bytes": os.path.getsize(target),
                "width": width,
                "height": height,
            })
    if not images:
        raise RuntimeError("这张图没有可读的帧：%s" % item["path"])
    return {"pages": len(images), "images": images}


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
                # 图片的「页」就是帧数：多页 TIFF / 动态 GIF 不能只算 1 页
                entry.update({"ok": True, "pages": image_frames(path)})
            elif mode == "render":
                info = render_pdf(item, job)
                entry.update({"ok": True, "pages": info["pages"], "images": info["images"]})
            elif mode == "image":
                info = image_to_png(item, job)
                entry.update({"ok": True, "pages": info["pages"], "images": info["images"],
                              "file": info["images"][0]["file"], "bytes": info["images"][0]["bytes"],
                              "width": info["images"][0]["width"], "height": info["images"][0]["height"]})
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

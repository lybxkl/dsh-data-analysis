#!/usr/bin/env python3
"""缩略图：产物中心的图库用它，避免把 600dpi 的大图整张塞进面板。

契约：
    python thumb.py --src <图片> --out <输出.png> --width 320
成功时往 stdout 打一行 JSON：{"ok": true, "width": ..., "height": ..., "bytes": ...}
失败时退出码非 0，stderr 写原因（调用方会把 stderr 尾部直接展示给用户）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=320)
    args = parser.parse_args()

    src = os.path.abspath(args.src)
    out = os.path.abspath(args.out)
    if not os.path.isfile(src):
        print(f"源文件不存在：{src}", file=sys.stderr)
        return 2
    try:
        from PIL import Image
    except Exception as error:  # noqa: BLE001
        print(f"缺 Pillow：{error}", file=sys.stderr)
        return 3

    try:
        with Image.open(src) as image:
            # 多帧图（GIF/TIFF）只取第一帧：缩略图不需要动图
            try:
                image.seek(0)
            except Exception:  # noqa: BLE001
                pass
            if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
                image = image.convert("RGBA")
            else:
                image = image.convert("RGB")
            width, height = image.size
            target = max(80, min(960, int(args.width)))
            if width > target:
                ratio = target / float(width)
                image = image.resize((target, max(1, int(round(height * ratio)))), Image.LANCZOS)
            os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
            image.save(out, "PNG", optimize=True)
            payload = {
                "ok": True,
                "src": src,
                "out": out,
                "width": image.size[0],
                "height": image.size[1],
                "bytes": os.path.getsize(out),
            }
            print(json.dumps(payload, ensure_ascii=False))
            return 0
    except Exception as error:  # noqa: BLE001
        print(f"生成缩略图失败：{error}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())

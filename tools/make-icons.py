#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成扩展图标（16/32/48/128）。
用法： python tools/make-icons.py
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "icons")
S = 512  # 用大图再缩小，省得自己写抗锯齿


def lerp(c1, c2, t):
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))


def build_base():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 竖向渐变底
    grad = Image.new("RGB", (1, S))
    top = (32, 106, 235)
    bottom = (122, 76, 245)
    for y in range(S):
        grad.putpixel((0, y), lerp(top, bottom, y / (S - 1)))
    grad = grad.resize((S, S))

    # 圆角矩形遮罩
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    cx = S * 0.47
    cy = S * 0.46
    ring = S * 0.285
    w = max(3, int(S * 0.052))

    # 表盘
    d.ellipse([cx - ring, cy - ring, cx + ring, cy + ring], outline=(255, 255, 255, 240), width=w)
    # 指针：指向 10 点 10 分，视觉最舒服
    d.line([cx, cy, cx - ring * 0.46, cy - ring * 0.46], fill=(255, 255, 255, 255), width=w)
    d.line([cx, cy, cx + ring * 0.55, cy - ring * 0.34], fill=(255, 255, 255, 255), width=w)
    d.ellipse([cx - w * 0.8, cy - w * 0.8, cx + w * 0.8, cy + w * 0.8], fill=(255, 255, 255, 255))

    # 右下角定位点（代表“出口地区”）
    px = S * 0.755
    py = S * 0.745
    pr = S * 0.145
    d.ellipse([px - pr, py - pr, px + pr, py + pr], fill=(255, 255, 255, 245))
    inner = pr * 0.62
    d.ellipse([px - inner, py - inner, px + inner, py + inner], fill=(255, 172, 32, 255))

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    base = build_base()
    sizes = [16, 32, 48, 128]
    for s in sizes:
        out = os.path.join(OUT_DIR, "icon%d.png" % s)
        base.resize((s, s), Image.LANCZOS).save(out)
        print("wrote", out)
    # 顺手存一张大图给 README 用
    big = os.path.join(OUT_DIR, "icon512.png")
    base.save(big)
    print("wrote", big)


if __name__ == "__main__":
    main()

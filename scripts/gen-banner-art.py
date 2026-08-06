#!/usr/bin/env python3
"""
scripts/gen-banner-art.py

设计期工具：生成智慧之眼 braille 点阵（主层 + 金棕层）——**旧全构图大眼**存档档。

> 2026-08-06 改版后，产品 banner 使用小号扁平眼（见 docs/design/DESIGN-BANNER.md
> §1/§6），本脚本保留全构图大眼（FACTOR=2.2 扁化档）作为设计期存档/复现工具；
> 当前 `src/tui/banner-art.ts` 中的 EYE_LINES/EYE_GOLD_LINES 已是小眼，
> **不要用本脚本输出直接回填**（会覆盖成旧大眼）。

源图：docs/design/1785827453.png（1664x928，含背景）。
主体 bbox 实测：TH=200 -> bbox=(424,71,1240,856)，size=816x785，ratio=1.039。

公式：
  1) TH=200 灰度阈值生成 mask，mask.getbbox() 裁掉背景得主体；
  2) 主层（墨绿）= 主体 < TH 的点；
  3) 金棕层 = RGB mask（r>140 ∧ b<80 ∧ r−b>80）的点，与主层同几何（同样先
     crop 主体 bbox 再 resize 到 (COLS*2, ROWS*4)，保证两层网格完全对齐）；
  4) ROWS = max(1, round(COLS * sh / (FACTOR * sw)))，FACTOR=2.0
     （终端 braille 字符宽高比 1:2）。

只输出，不读不改 banner-art.ts；将 stdout 末尾的 TS 块手动贴入
src/tui/banner-art.ts（仅当改回大眼时）。

依赖：Pillow（已通过 PEP 668 绕过：python3 -m pip install --user
--break-system-packages Pillow）。
"""
from PIL import Image
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "docs" / "design" / "1785827453.png"
TH = 200
# COLS=48：全构图大眼宽（存档档）。BANNER_MIN_COLS（旧）=48+3+43+2=96。
COLS = 48
# FACTOR：终端 braille 字符高宽比补偿（1 字符 = 2×4 点阵）。FACTOR=2.0 时
# 主体在终端显示为正方形（显示比 ≈1.04）；2026-08-06 曾调至 2.2 → ROWS=21，
# 显示比 ≈1.14 略扁；随后改版为小眼，本参数仅存档参考。
FACTOR = 2.2

img_rgb = Image.open(SRC).convert("RGB")
img = img_rgb.convert("L")
mask = img.point(lambda p: 255 if p < TH else 0)
bb = mask.getbbox()
assert bb, "源图无主体 bbox"
sw = bb[2] - bb[0]
sh = bb[3] - bb[1]
subject = img.crop(bb)
subject_rgb = img_rgb.crop(bb)
ROWS = max(1, round(COLS * sh / (FACTOR * sw)))

# 主层点阵
dots_main = subject.resize((COLS * 2, ROWS * 4), Image.LANCZOS)
p_main = dots_main.load()

# 金棕层点阵：RGB mask 在主体 bbox 内同样几何（同 COLS*2 x ROWS*4 网格）。
# 逐像素 RGB 判断（不依赖 numpy）：构造同尺寸单通道 L 图像，背景=255
# （非金棕 = 白），金棕 = 0。resize 后用与主层同一阈值 TH 比较 —
# 这样保证两层网格完全对齐（LANCZOS 在白底上不会扩散到周围 cell）。
gw, gh = subject_rgb.size
gold_img = Image.new("L", (gw, gh), 255)
g_pix = gold_img.load()
s_pix = subject_rgb.load()
for y in range(gh):
    for x in range(gw):
        r, g, b = s_pix[x, y]
        if r > 140 and b < 80 and (r - b) > 80:
            g_pix[x, y] = 0
dots_gold = gold_img.resize((COLS * 2, ROWS * 4), Image.LANCZOS)
p_gold = dots_gold.load()

BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]


def cell_at(p, r, c):
    code = 0
    for dy in range(4):
        for dx in range(2):
            if p[c * 2 + dx, r * 4 + dy] < TH:
                code |= BITS[dy][dx]
    return chr(0x2800 + code)


main_lines = ["".join(cell_at(p_main, r, c) for c in range(COLS)) for r in range(ROWS)]
gold_lines = ["".join(cell_at(p_gold, r, c) for c in range(COLS)) for r in range(ROWS)]


def fmt_array(name: str, lines: list[str]) -> str:
    parts = [f"export const {name}: ReadonlyArray<string> = ["]
    for line in lines:
        parts.append(f"  `{line}`,")
    parts.append("];")
    return "\n".join(parts)


print(f"# 主体 bbox: {bb}")
print(f"# 主体尺寸: {sw}x{sh}, ratio={sw/sh:.3f}")
print(f"# 输出点阵: {COLS} cols x {ROWS} rows braille（终端显示比 ≈ COLS/(ROWS*2) = {COLS/(ROWS*2):.3f}）")
print()
print(fmt_array("EYE_LINES", main_lines))
print()
print(fmt_array("EYE_GOLD_LINES", gold_lines))
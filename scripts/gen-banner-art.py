#!/usr/bin/env python3
"""
scripts/gen-banner-art.py

Design-time tool: generates the wise-eye braille dot matrix (main layer +
gold-brown layer) — archived variant of the OLD full-composition large eye.

The product banner now uses the small flat eye (see
docs/design/DESIGN-BANNER.md); this script keeps the full-composition large
eye (FACTOR=2.2 flattened preset) only as a design-time archive /
reproduction tool. EYE_LINES/EYE_GOLD_LINES in `src/tui/banner-art.ts` are
already the small eye — do NOT paste this script's output back into it (it
would overwrite the small eye with the old large one).

Source image: docs/design/1785827453.png (1664x928, with background).
Measured subject bbox: TH=200 -> bbox=(424,71,1240,856), size=816x785, ratio=1.039.

Algorithm:
  1) grayscale threshold TH=200 -> mask; mask.getbbox() crops the background
     to isolate the subject;
  2) main layer (ink green) = subject pixels < TH;
  3) gold-brown layer = RGB mask (r>140 ∧ b<80 ∧ r−b>80) pixels, same
     geometry as the main layer (crop the subject bbox first, then resize to
     (COLS*2, ROWS*4)) so the two grids align exactly;
  4) ROWS = max(1, round(COLS * sh / (FACTOR * sw))), FACTOR=2.0
     (terminal braille cell aspect ratio 1:2).

Output only; never reads or writes banner-art.ts. The TS block at the end of
stdout is pasted into src/tui/banner-art.ts by hand (only when reverting to
the large eye).

Dependency: Pillow (installed via the PEP 668 bypass: python3 -m pip install
--user --break-system-packages Pillow).
"""
from PIL import Image
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "docs" / "design" / "1785827453.png"
TH = 200
# COLS=48: width of the full-composition large eye (archived preset).
# Legacy BANNER_MIN_COLS = 48+3+43+2 = 96.
COLS = 48
# FACTOR: compensates the terminal braille cell aspect ratio (1 char = 2×4
# dot matrix). At FACTOR=2.0 the subject renders square on the terminal
# (display ratio ≈1.04); it was once tuned to 2.2 → ROWS=21 (ratio ≈1.14,
# slightly flat) before the switch to the small eye, so this value is
# archival reference only.
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

# Main layer dot matrix
dots_main = subject.resize((COLS * 2, ROWS * 4), Image.LANCZOS)
p_main = dots_main.load()

# Gold-brown layer dot matrix: RGB mask inside the subject bbox, same
# geometry (same COLS*2 x ROWS*4 grid). Per-pixel RGB test (no numpy):
# build a same-size single-channel L image, background=255 (non-gold =
# white), gold = 0; after resize compare with the same threshold TH as the
# main layer — this keeps both grids aligned (LANCZOS on a white base does
# not bleed into neighbouring cells).
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
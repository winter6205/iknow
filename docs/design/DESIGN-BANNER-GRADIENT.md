# Startup banner eye-color gradient exploration · e2 dusk philosopher's stone, final

> Task: the logo redesign (continuing the ink→@opentui/react migration). This
> file is the full exploration archive for moving the banner eye palette "from
> two discrete color layers to an irregular diagonal gradient".
> Formal implementation: `eyeGradientCells()` in `src/tui/banner.ts` (merged).
>
> This file is an **upgrade** of `docs/design/DESIGN-BANNER.md` §2 (two-color
> layering: ink-green line art + gold-brown R rune), not a replacement; §2's
> geometry cropping / threshold pipeline / truecolor degradation still hold.
> What changes is **the palette: from two discrete colors to one diagonal
> gradient**.

## Decision in one sentence

Banner eye color = **e2 dusk philosopher's stone**: per-cell coloring on the
13×32 grid, endpoints `#1a1d6e` (deep blue-purple) → `#ffafaf` (pink-gold),
diagonal direction `t = 0.6·(c/31) + 0.4·(r/12)`, linear interpolation in RGB
space. Each row's 32 cells carry `{ text, hex }` and are fg-colored by the
renderer.

## 1. Background and motivation

The original `DESIGN-BANNER.md` §2 was "two-color layering": ink-green
`#183223` (eye outline + ring + 8 crossing boxes) + gold-brown `#b97f1c` (only
the R rune inside the pupil). Its strength is **complete preservation of
geometric information** (crisp eye outline), but at the logo-redesign
acceptance the operator asked to **"repaint the colors"** — concretely, to move
the palette beyond the discrete two-color scheme toward "soft transitions /
atmosphere". Visual verification stayed open, and the redesign re-opened the
exploration.

Constraints (fixed before exploring, so candidates started bounded):

- **Keep the glyphs**: the 32×13 braille raster (`EYE_LINES`) is reused
  untouched — regenerating glyphs risks a "the eye looks different" regression;
  avoided.
- **Keep the geometry**: the spatial distribution of eye outline / ring / R
  rune / lower lid is exactly the alpha>128 subject mask of `EYE_LINES`;
  recoloring must not break the geometry.
- **Dark to light**: the pupil zone (center) must land in the visually bright
  area, otherwise the "pupil" information is lost.
- **Truecolor terminals are the premise** (COLORTERM=truecolor); the ANSI256
  degradation tier was researched as a secondary constraint (§5).

## 2. 16 gradient candidates in 4 families (round one: four families × four)

Round one expressed directions as "families" (row-wise / column-wise / radial /
exotic-hue), each family with 4 candidates fine-tuning the endpoint colors and
weights. The visual descriptions state the expected effect of rendering the
13×32 grid cell by cell.

### 2.1 Vertical family v (interpolate per row, r direction)

| Cand. | Endpoints / formula                                        | Visual in one line                           |
| ----- | ---------------------------------------------------------- | -------------------------------------------- |
| v1    | `#5a3a10` → `#ffe082`, linear top-to-bottom                | dark lid on top, mid-bright pupil zone, mid-dark lower edge (gold ramp) |
| v2    | `#ffffff` → `#b97f1c` (the design's original gold-brown)   | white-hot landing into a gold-brown dome (keeps the design's gold endpoint) |
| v3    | `#4a1d6e` → `#ffd75f`, `0.2·sin` bump on pupil rows r=5/6/7 | burning-gold pupil (artificial brightness bump on the middle three rows) |
| v4    | `#e8e4d8` → `#3a2410`, manuscript feel                     | white top, aged gold-black sediment at the bottom (old-scroll tone) |

### 2.2 Horizontal family h (interpolate per column, c direction)

| Cand. | Endpoints / formula            | Visual in one line                                   |
| ----- | ------------------------------ | ---------------------------------------------------- |
| h1    | `#b97f1c` → `#ffffff`          | light shines in from the right (gold left, white right — side lighting) |
| h2    | `#1a1004` → `#ffd75f`          | same hue, different intensity; dark-left/bright-right reads like "opening" (a waking-up feel) |
| h3    | both ends `#8a5a14`, midpoint `#fff4b0` | brightest at the pupil column: a horizontal light band (U-shaped) |
| h4    | `#4a1d6e` → `#ffd75f`          | cool-to-warm sweep (purple → gold, single horizontal row) |

### 2.3 Radial family r (Euclidean distance from center `(6,16)`, normalized)

| Cand. | Endpoints / formula                                                   | Visual in one line                             |
| ----- | --------------------------------------------------------------------- | ---------------------------------------------- |
| r1    | `#fff4b0` → `#8a5a14`, center outward                                 | pupil highlight decays outward (standard glow) |
| r2    | dual centers `(6,12)` `(6,20)`, `#ffd75f` → `#1a1004`, Voronoi nearest point | two-pupil eye (strong artistic feel, but no longer reads as the Eye of Wisdom) |
| r3    | 5-step quantization of `#fff4b0/#b97f1c/#3a2410`, aperture banding    | concentric rings (comic-panel feel)            |
| r4    | `#1a1004` → `#ffd75f`, inverted radial                                 | dark center, bright rim (mysterious, artsy)    |

### 2.4 Exotic-hue family e (experiment: wide hue span)

| Cand.   | Endpoints / formula                                                      | Visual in one line                                                       |
| ------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| e1      | `#ffffff` → `#ffe082` → `#1a1004` three stops, pupil zone forced white-hot | molten white heat (strongest fire feel; the pupil gets too bright and swallows detail — rejected) |
| **e2**  | **`#1a1d6e` → `#ffafaf` diagonal, c weight 0.6 / r weight 0.4**          | **dusk philosopher's stone (blue-purple → pink-gold, irregular diagonal — the finalist)** |
| e3      | ink-green line art `#0a3a2a` monochrome + pupil gold ramp `#ffd75f` via `EYE_GOLD_LINES` | green eye, gold pupil (the two-color-layer baseline, the only one close to the original §2; the operator confirmed wanting out of two-color) |
| e4      | `#3a0e08` → `#d9a343` + central copper glow `#dc7a2c`                     | cast bronze, gilded artifact (too heavy)                                  |

Round-one observations:

- The v/h families' single-direction interpolation looks stiff (a gradient
  whose direction is obvious at a glance = design value lost).
- The r family has a strong radial feel, but r2/r3/r4 all "stopped looking
  like an eye" — the pupil center is wrong; rejected.
- The e family — wide hue span + irregular direction — had the best
  atmosphere. e1's pupil is too bright and swallows detail, e3 is just the
  two-color layering in a wrapper, e4 is too heavy; **e2 dusk philosopher's
  stone settled the direction in one draft**.

## 3. e2 dusk philosopher's stone: 5 variants (round two: tune endpoints + formula)

e2 v0 (original endpoints + diagonal weights) was already confirmed by the
operator as the direction; round two kept the direction and varied only
endpoints / formula / pupil lock, comparing 5 variants side by side:

| Variant | Endpoints / formula                                                                      | Visual in one line                                                          |
| ------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **v0**  | **`#1a1d6e` → `#ffafaf`, diagonal `t = 0.6·(c/31) + 0.4·(r/12)`**                         | **the original dusk philosopher's stone — the operator's final pick**        |
| v1      | three stops `#1a1d6e` → `#b97f1c` → `#ffd75f` (purple → the design's gold-brown → bright gold) | purple-gold classic (a three-part narrative, but its middle third is too close to the original design's gold-brown — rejected) |
| v2      | both ends `#4a1d6e` (purple rim), pupil center forced gold `#ffd75f` (circular mask overriding the gradient) | gold heart, purple rim (the forced-gold pupil is the only gold focal point; barely different from v0's gradient — rejected) |
| v3      | `#1a1d6e` → `#8a5a14` (first 35%) → `#8a5a14` → `#ffd75f` (last 65%), gold-led            | heavy gold (the front segment is too dark — it loses the blue-purple coolness — rejected) |
| v4      | diagonal t quantized into 4 segments purple→gold→purple→gold, pupil segment forced bright gold | purple-gold stripes (quantized patchiness — rejected: loses the gradient's smoothness) |

Round-two observation: **the v0 original is the final**. v1/v3's endpoint
changes polluted the gradient's character; v2/v4's locks bypassed the gradient
itself; only v0 — "blue-purple coolness + pink-gold warmth + unlocked
diagonal" — kept all three of **soft transitions + atmosphere + the pupil
naturally landing in the central warm zone**.

## 4. Final decision (operator's call)

**e2 v0 dusk philosopher's stone**:

- Endpoints: `from = #1a1d6e` (deep blue-purple) / `to = #ffafaf` (pink-gold)
- Formula: per-cell coloring on 13×32, `t = clamp01(0.6·(c/31) + 0.4·(r/12))`,
  `lerpColor(from, to, t)`; linear interpolation in RGB space returning
  `#rrggbb`.
- Color-weight semantics: **c weight 0.6 = horizontal (pupil-column direction)
  leads**, **r weight 0.4 = vertical (row direction) assists** — the pupil rows
  r≈5/6/7 and the central columns c≈14/15/16/17 land in the visual middle, so
  all three cues point naturally at the blue-purple → pink-gold warm focus;
  the pupil zone sits near the bright gold end without any artificial lock
  (measured t≈0.5 → rgb(143,103,143) = `#8f678f`, approaching pink-gold).
- Product implementation: pure function
  `eyeGradientCells({from, to, cWeight, rWeight})` at `src/tui/banner.ts:149`;
  `src/tui/chat-view.tsx:128-160` embeds `<span fg={hex}>` per cell inside
  each row's `<text>`; `src/tui/theme.ts:99-100` `logoInk = #1a1d6e` /
  `logoGold = #ffafaf` (endpoint SSOT).
- Verification: 6 unit tests at `tests/tui/banner-lines.test.ts:100-` cover
  shape / endpoints / midpoint / weight direction.

## 5. ANSI256 degradation notes (research conclusion)

Research question: under ANSI256 (COLORTERM without truecolor), what does the
hex gradient collapse to after quantization?

- **The gold family (the `#1a1d6e → #ffafaf` range)**: the 32-step gradient
  collapses to **2-3 steps** — the blue-purple end lands near the ANSI256 cube
  `#5f00ff`, the pink-gold end near the `#ffaf87`/`#ffafaf` cube, with
  quantization jumps in between. Worse than "two colors hit exactly": with two
  discrete colors, gold-brown could hit the `#af8700` cube; under the gradient
  there is not even a middle transition — just two flat blocks.
- **6×6×6 RGB cube**: the gold-pink range (yellow → pink) offers only 3
  brightness steps; the gradient steps are visible to the eye.
- **Conclusion**: **truecolor terminals are the premise of the e2 gradient**.
  On ANSI256 terminals it degrades to single-color `logoInk` (product semantics
  kept, atmosphere given up); the renderer degrades by terminal capability, and
  the application layer never hand-writes ANSI (the "no hand-written ANSI in
  the application layer" discipline at `theme.ts:17-18`).

Fallback (already implemented in the product): narrow terminals
(`cols < BANNER_MIN_COLS = 80`) render the single line `◆ iknow <version>` in
uniform `logoInk` monochrome — that itself is the ANSI256-friendly degradation
path, so no extra fallback is needed.

## 6. Relationship to the original two-color layering in DESIGN-BANNER.md §2

An upgrade, not a replacement:

- **Geometry unchanged**: the same 13×32 braille glyphs + alpha>128 subject
  mask.
- **Color goes discrete → continuous**: original §2 merged two masks
  ("ink-green line art + gold-brown R rune"); now it is a single diagonal
  gradient ("blue-purple → pink-gold") with no second `EYE_GOLD_LINES` mask.
- **Dead-code cleanup**: the old `EYE_GOLD_LINES` constant, `BannerSegment`
  type, `eyeSegments()` function, and the whole RGB-mask `r>140 ∧ b<80 ∧
  (r-b)>80` gold-layer pipeline in `src/tui/banner.ts` (deleted in commit
  `6d3a3f2`) — none of it is needed anymore, since the gradient itself is the
  continuous product of "gold-brown + purple".
- **Narrow-terminal degradation kept**: the `BANNER_MIN_COLS = 80` threshold,
  the `bannerShortLine` single-line mode, and the degraded monochrome are the
  same as §2.

## 7. Verification record (matches the merged artifact)

- `tests/tui/banner-lines.test.ts:100-`: 6 unit tests for `eyeGradientCells`
  - 13 rows × 32 cells shape
  - every cell `{text, hex}` with hex in `#rrggbb` format
  - text identical to `EYE_LINES` cell by cell (braille raster width must not drift)
  - first cell `(0,0)` = `#1a1d6e` (t = 0)
  - last cell `(12,31)` = `#ffafaf` (t = 1)
  - middle cell `(6,16)` = `#8f678f` (aligned with the preview script
    `exotic-e2.ts`, t ≈ 0.51)
  - weight direction: setting c/r weights to 1.0 respectively verifies direction
- Real-TTY smoke: `npm run dev:tui` renders correctly in a real terminal (see
  the acceptance checklist in
  `docs/handoff/2026-08-10-tui-321-regression-fixes.md`).

## 8. References

| Kind                          | Path / reference                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| product implementation (merged) | `src/tui/banner.ts` `eyeGradientCells`                                             |
| call site                     | `src/tui/chat-view.tsx:128-160` (banner segment rendering)                             |
| endpoint SSOT                 | `src/tui/theme.ts:99-100` `logoInk` / `logoGold`                                       |
| unit tests                    | `tests/tui/banner-lines.test.ts:100-`                                                |
| old two-color layering (deprecated) | `docs/design/DESIGN-BANNER.md §2`; previous implementation via `git show 6d3a3f2~1:src/tui/banner.ts` |
| glyph SSOT (untouched)        | `src/tui/banner.ts:29-43` `EYE_LINES` (braille 32×13)                                 |
| source image                  | `docs/design/eyeshape.png` (836×836 RGBA transparent)                                |
| related final                 | `docs/design/DESIGN-BANNER.md §6` (the e2 dusk philosopher's-stone gradient final)   |

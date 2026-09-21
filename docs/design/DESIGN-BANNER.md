# Startup banner visual decision · Eye of Wisdom (prototype branch merged into the TUI)

> Formal implementation: `src/tui/banner.ts` + `src/tui/banner-art.ts` (moved in
> from the prototype branch `worktree-tui-design-prototype`,
> `tui-prototype/src/logo-braille/`).
> This file is the implementation-time copy of the prototype branch's
> `tui-prototype/docs/DESIGN-BANNER.md`: it keeps the design adjudication record
> while paths are rewritten to the formal implementation. Source image:
> `docs/design/1785827453.png` (1785827447 / 1785827458 are same-batch candidates).

## Decision in one sentence

Startup banner = Eye of Wisdom (braille variant C): **a rounded line frame that
fills the whole row width** (same `borderStyle="round"` as the PromptInput box,
no horizontal centering); the **complete eye** (32×13 braille, 32 cols × 13
terminal rows; source `docs/design/eyeshape.png`, uncropped) sits left, the info
column (Version / Cwd / Data dir) sits right, vertically centered; the top frame
inlays a **centered** title `◆ iknow`; two-color layering (ink-green line art +
gold-brown R-rune accent); on narrow terminals (cols < 80) the banner degrades
to not rendering. Glyphs = U+2800-28FF braille (not ASCII, not emoji) — the
earlier spec's "banner is pure ASCII" requirement is explicitly superseded by
this decision.

## 1. Revision: full row width + smaller layout + info on the right

Diagnosis history (four iterations, archived so we don't regress):

1. Measured content bbox of the full composition is 816×785 (ratio 1.04,
   **inherently square**) — the eye + ring + 8 rune boxes simply form a square;
   almost all of the 1664×928 source canvas's "width" is background whitespace.
2. Tried a wide grid (36×10, display ratio 1.80) letterboxed — the square motif
   shrank into a small centered block with large empty side margins; looked
   worse; rejected.
3. Tried cropping to the subject (eye shape only, bbox 810×431 = 1.879,
   naturally wide) — the operator ruled **"the runes are still needed"**;
   rejected.
4. First revision: from the full-composition large eye (48×21 braille) to a
   **16×6 small eye generated from a ±95px square window around the pupil** —
   the eye was small but parts of the complete eye shape (lid, frame, the area
   around the R rune) had been cut off; on re-review the operator ruled **"you
   cropped the eye; show it in full"**; that attempt was voided.
5. Third round: second round's 24×12 → **32×13** (operator confirmed it matches
   the reference image); the title drops `tui` and becomes **centered**
   `◆ iknow`. COLS=32, ROWS=13 (FACTOR≈2.37), display ratio
   32/(13×2)=1.231 — slightly flat.

**Final plan (operator: "show the new image in full")**: the operator supplied a
new source image `docs/design/eyeshape.png` (836×836 RGBA with transparent
background; subject = the complete eye: lid + frame + pupil R rune + lower lid).
RGBA alpha isolates the background naturally, so there is **no cropping** —
pixels with alpha>128 are the subject (measured bbox (13,27,826,810),
size=813×783, ratio=1.038, near-square). Raster generation goes:

- TH=200 grayscale threshold (dark-green line art RGB≈(24,50,35), luminance≈43,
  safely separated)
- COLS=32, ROWS=13 (32 cols × 13 terminal rows; FACTOR≈2.37 =
  32×783/(13×813) compensates the character height-to-width ratio; display
  ratio 32/(13×2)=1.231, slightly flat)
- main layer ink-green (alpha>128 → subject) + gold-brown R rune (RGB mask
  `r>140 ∧ b<80 ∧ (r-b)>80`, restricted to subject pixels)

- The info column is a wide rectangle, so the motif lands naturally on the
  left. **A square motif must not be stretched horizontally (stretching
  distorts the eye).**
- threshold=180 / trimThreshold=200 (raster-generation parameters; do not
  touch).

## 2. Two-color layering (painted from the source PNG; background unpainted)

Color-probe measurements at full resolution (1664×928 histogram +
connected-component partitioning):

| Color family   | HEX     | Share            | Usage                                        |
| -------------- | ------- | ---------------- | -------------------------------------------- |
| warm-white bg  | #f7f7f1 | 90%              | **not rendered**; the terminal background is |
| ink-green line | #183223 | ~94% (non-bg)    | eye outline + ring runes + 8 crossing boxes (same color) |
| gold-brown acc | #b97f1c | ~6% (non-bg)     | **only** the R rune inside the pupil (no green pixels bleed into its bbox) |

Rendering is two-color layered: the green layer uses the threshold pipeline
(180 naturally filters out gold-brown pixels at V≈185); the gold layer uses the
RGB mask (r>140 ∧ b<80 ∧ r−b>80) run through the **same geometry** as the green
layer (same bbox / grid) mask → braille, with both layers aligned per cell;
when `banner.ts` merges, non-empty gold cells render fully gold (a few green
dots get covered — accepted in the final decision), everything else stays
ink-green.

Color source: COLORTERM=truecolor → `38;2;24;50;35` / `38;2;185;127;28`
(measured values emitted directly); otherwise ANSI256 → 22 `#005f00` / 136
`#af8700` (nearest CIE76 candidates). NO_COLOR / non-TTY: paint degrades to a
no-op and renders plain text (no-color.org discipline).

## 3. Layout and degradation (formal-implementation wrap-up)

> **Later override**: this section's "single-line frame + whole-panel horizontal
> centering + 96-column degradation" was the V7 plan at move-in time; it has
> been superseded by the §1 revision (full-width rounded frame, motif left +
> info right, centered title `◆ iknow` in the top frame, `BANNER_MIN_COLS` now
> = 32 + 3 + 43 + 2 = 80). Kept as a historical archive.

- V7 layout: the banner **carries its own single-line frame**
  (borderStyle="single") with a centered `◆ iknow tui ◆` title inlaid at the
  top / bottom border; the info column covers only version / cwd / dataDir
  (prototype runtime items like sessionId / tools were not moved over).
- The frame is deliberately distinct from the input box's line frame
  (borderStyle="round"); its color follows `FG_BORDER` (ink 256-color 244 ≈
  #8a877e, same source as `tuiPalette.dim` in theme.ts).
- **Whole-panel horizontal centering**: the panel made of motif + GAP + info
  column + frame (1 column padding each side) gets equal left/right whitespace
  within `cols` (the square braille motif is not stretched — symmetric
  whitespace is enough; this fixed the "motif + info column jammed on the
  left" look). When cols > `BANNER_MIN_COLS` the slack splits evenly on both
  sides; at cols === `BANNER_MIN_COLS` the left padding = 0.
- **GAP=3 between motif and info column**: the original GAP=1 made the two
  read as a left-aligned lump; 3 columns give them room to breathe.
- **Mid-string truncation for long info values**: when an absolute path such
  as dataDir exceeds `VAL_W=32` columns, keep the leading path prefix + the
  trailing filename/extension joined by a middle `…` (mid-truncation is easier
  to recognize than tail truncation).
- **Narrow-terminal degradation**: cols < 96 (`BANNER_MIN_COLS = 48 + 3 + 43 +
  2`) -> return an empty line set (render no banner) to avoid broken wrapping.
- SHORT tier (single line `◆ iknow`): the prototype V7 tier for short
  terminals; its rendering capability was kept at move-in but it is not wired
  into the product path (height auto-fit was not required; left as a later
  follow-up).
- Raster regeneration goes through `scripts/gen-banner-art.py` (a one-off
  design-time script that crops the subject and compensates the ratio per the
  §4 formula); the glyphs were moved verbatim into `src/tui/banner-art.ts` —
  **do not hand-edit**.

## 4. On the "logo squeezed horizontally" problem (option 4, final)

User question: "how do we fix the logo looking horizontally squeezed — is it
because the source PNG has a background, and the solid subject in the middle
gets compressed?"

### 4.1 Root cause (the user's formula hit the nail on the head)

The user gave two root causes + the correct pipeline; confirmed by measurement:

1. **Wrong ratio baseline**. The source PNG `docs/design/1785827453.png` has a
   1664×928 canvas (ratio 1.79, wide), but the subject's (eye + ring + 8 rune
   boxes) measured bbox is only **816×785 (ratio 1.04, square)** — the subject
   occupies roughly the middle half of the canvas width; both sides are mostly
   warm-white background `#f7f7f1`. The old raster (34×17) sampled the **whole
   canvas**, so the subject was scaled into the middle of the raster "by
   canvas ratio", leaving only ~16.7 columns horizontally; display ratio =
   16.7 : (17×2) = **0.49 — tall and thin**. That is the truth behind "squeezed
   horizontally".
2. **Terminal character cells are not square**. Monospace width:height ≈ 1:2,
   and a braille codepoint (U+2800-28FF) is 1 column wide × 2 rows tall (1
   codepoint = a 2×4 dot matrix). So sampling "1:1 by subject pixel ratio"
   into cols×rows shows the subject twice as thin; `FACTOR=2.0` compensation is
   required.
3. **The background itself causes no distortion**, but it must first be removed
   via `image.crop(mask.getbbox())`; otherwise the sampled ratio is the
   canvas's 1.79 rather than the subject's 1.04.

Correct pipeline (condensed from the user's own words): **crop the subject ->
compensate the character ratio with `cols = rows × (subject width / subject
height) × FACTOR` -> sample the braille dot matrix (1 char = 2×4 dots) -> emit
a static string**.

### 4.2 Diagnostic evidence for the old 34×17 raster (kept to prevent regression)

Overall non-empty bbox of the old `EYE_LINES` (34×17, sampled by canvas): cols
`[0, 34)` × rows `[0, 17)` (the whole 34×17 grid is in use; all 34 columns have
at least one dotted row). **The raster itself has no background whitespace** —
but the subject had been scaled into the middle by canvas ratio, occupying only
~16.7 columns horizontally; that is the squeeze source. The bbox table proves
"it is not raster padding" — it is "wrong sampling baseline".

### 4.3 Option comparison and decision

| Option             | Approach                                 | Result                                             |
| ------------------ | ---------------------------------------- | -------------------------------------------------- |
| option 1           | runtime trim of cols 0-1 + cols 32-33    | deletes the eye's wings -> loses the horizontal spread, **actually more cramped** |
| option 2           | regenerate but keep the background       | still samples the 1664×928 canvas; the subject is squashed just the same |
| option 3           | document the terminal character ratio, change no code | **rejected** — the user explicitly asked to regenerate per the formula |
| **option 4 (final)** | **crop to subject bbox + FACTOR=2 compensation + resample** | subject rendered at the 816×785 ratio with character-ratio compensation; square on screen |

### 4.4 Implementation parameters (`scripts/gen-banner-art.py`)

- `TH=200`: background is near-white (~245), subject dark; 200 is a safe
  threshold (measured: TH=180 and TH=200 yield identical bboxes).
- `COLS=48`: subject is square and big enough, and the info column fits
  alongside. `ROWS = round(48 × 785 / (2.2 × 816)) = 21`.
- `FACTOR=2.2`: terminal braille character height-to-width ratio.
  **Calibration baseline**: a 45° diagonal in the source still looks 45° in
  the terminal; fonts with a character ratio off 1:2 need a small 2.1/2.2
  adjustment, then it is frozen.
  **Flattening iteration**: after review the user ruled "it is squeezed too
  thin, make it a bit flatter", so FACTOR moved 2.0 → 2.2 → ROWS 23→21,
  display ratio 1.04 → 1.14 (slightly flat), and the banner height shrank
  accordingly (easing the "too big" impression).
- gold-brown layer (pupil R rune) = RGB mask `r>140 ∧ b<80 ∧ (r-b)>80`, using
  the **same geometry** as the main layer (crop the subject bbox first, then
  resize to `(48×2, 21×4)`), aligned per cell.
- New raster `48×21`: `cols/(rows×2) = 48/42 = 1.143`, rendering slightly flat
  (the old 34×17's `34/(17×2)=1.000` looked square, but the subject only
  filled 0.49 of it; the FACTOR=2.0 tier `48/23` renders square at ≈1.043).
- `BANNER_MIN_COLS` stays 96 (`48 + 3 + 43 + 2`); 80-column terminals still
  degrade to empty like any narrow terminal (consistent with the old 82
  threshold behavior).

### 4.5 Font tuning (supporting)

Option 4 fixed the sampling baseline, but the terminal font's character ratio
still affects the final look: if the character width-to-height ratio deviates
from 0.5:1 (braille is 1 col × 2 rows), the square subject still renders
slightly flat. iTerm + Cascadia Code / JetBrains Mono are recommended
(character ratios close to 0.5:1; braille renders most nearly square).

## 5. Verification record (after move-in + second revision)

- `tests/tui/render-smoke.test.tsx`: banner renders via renderToString at 80 /
  120 / 160 columns without overflow, every line fills cols (no horizontal
  centering), narrow terminals (cols < 80) degrade to an empty result, the
  rounded frame (╭/╰/╮/╯) + centered title `◆ iknow`, the info column
  (Version / Cwd / Data dir) + the complete eye (32×13 braille) are asserted;
  the UI element layer contains no emoji (U+1F300-1FAFF absent).
- pty smoke: the banner renders correctly on a real TTY (see the manual table
  in `docs/handoff/2026-08-05-tui-implementation.md`).

## 6. e2 dusk philosopher's-stone gradient, final

> This section archives the palette upgrade that supersedes the
> "two-color layering (ink-green line art + gold-brown R rune)" described in
> §1-§5. Full exploration record: `docs/design/DESIGN-BANNER-GRADIENT.md`.

After the logo-redesign acceptance, the operator finalized **e2 v0 dusk
philosopher's stone**:

- **Exploration**: 16 gradient candidates in 4 families (vertical v /
  horizontal h / radial r / exotic-hue e, 4 candidates per family) in the
  first round → e2 direction confirmed → second round compared 5 e2 variants
  (v0-v4) side by side → the operator selected the **e2 v0 original**.
- **Endpoints**: `#1a1d6e` (deep blue-purple) → `#ffafaf` (pink-gold).
- **Formula**: per-cell coloring on the 13×32 grid, diagonal
  `t = 0.6·(c/31) + 0.4·(r/12)`, linear interpolation in RGB space
  (`c` weight 0.6 / `r` weight 0.4). See `src/tui/banner.ts`
  `eyeGradientCells({from, to, cWeight, rWeight})`; endpoint SSOT =
  `logoInk` / `logoGold` in `src/tui/theme.ts`.
- **This upgrades §2's two-color layering**: an irregular diagonal gradient
  replaces the two discrete color layers. The geometry (13×32 braille +
  alpha>128 subject mask) is unchanged; color moves from two discrete masks
  ("ink-green + gold-brown") to one continuous layer ("blue-purple →
  pink-gold"); the old gold-layer pipeline `EYE_GOLD_LINES` / `BannerSegment`
  / `eyeSegments()` was deleted (commit `6d3a3f2`).
- **Narrow-terminal degradation kept**: `BANNER_MIN_COLS = 80`, single line
  `◆ iknow <version>`, degraded monochrome = same as §2.
- **Details / rejection reasons per candidate / ANSI256 degradation research**:
  see `docs/design/DESIGN-BANNER-GRADIENT.md`.

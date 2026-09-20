/**
 * src/tui/banner.ts
 *
 * Startup banner text constants / generators (OpenTUI port).
 *
 * Semantics aligned with archive/tui-ink/src/banner.ts + banner-art.ts (the
 * All-Seeing Eye variant C):
 *  - eye glyph 32×13 braille (EYE_LINES glyph data moved verbatim; the source
 *    image is generated from docs/design/eyeshape.png, never hand-edit);
 *  - version SSOT = cli/usage.ts getVersion() (reads package.json, same source
 *    as the archived version.ts);
 *  - info column: three lines Version / Cwd / Data dir;
 *  - if the eye fits (≥ 32 columns + frame) draw the full 13-row eye; only
 *    when the eye itself cannot fit fall back to the single line
 *    `◆ iknow <version>`. Do not let the 80-column combined width discard the
 *    whole eye.
 *
 * Difference from the archived version: it emitted ANSI-painted strings (manual
 * paint in the ink era); under OpenTUI coloring is the renderer's fg job, so
 * this file only yields plain text + per-cell gradient segments
 * (eyeGradientCells), never ANSI. The gradient endpoints live in theme.ts
 * (logoInk / logoGold = e2 twilight magic stone: deep blue-purple #1a1d6e
 * → pink-gold #ffafaf).
 */
import stringWidth from "string-width";
import { getVersion } from "../cli/usage.js";
import { padEndVisual } from "./visual.js";

/** Version string shown in the TUI (SSOT = package.json, via getVersion()). */
export const VERSION: string = getVersion();

// ── Eye glyphs (verbatim from the archived banner-art.ts, do not hand-edit)────

export const EYE_LINES: ReadonlyArray<string> = [
  `⠀⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⡶⠋⠀⠀⠙⢶⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡀⠀`,
  `⠀⠀⠹⣶⣄⢀⣤⡾⠃⢀⣴⠟⠁⠀⠀⠀⠀⠀⠀⠉⠻⣦⡀⠘⢷⣄⡀⣠⡶⠋⠀⠀`,
  `⠀⠀⠀⠀⠙⢿⣏⡀⢶⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⠶⢀⣹⡿⠋⠀⠀⠀⠀`,
  `⠀⠀⠘⢶⣄⣠⡿⠿⣦⡀⠀⠀⣀⣠⣤⣤⣤⣤⣤⣤⣀⡀⢀⣴⠿⢿⣄⣠⡶⠃⠀⠀`,
  `⠀⠀⢀⣤⡿⠋⠀⠀⣈⣵⣾⣿⣿⣿⣿⠿⠶⢶⣶⣾⣭⣟⡳⢦⣀⠀⠙⢿⣄⡀⠀⠀`,
  `⢀⣴⠟⠉⠀⠀⣠⣾⡿⠛⢩⣿⠋⠀⢸⡿⢦⣄⠈⠙⣿⡉⠛⢷⣮⡓⠀⠀⠉⠻⣦⡀`,
  `⣉⠀⠀⠀⠀⢼⣿⡁⠀⠀⢸⡇⠀⠀⢸⣷⣞⠋⠀⠀⢹⡇⠀⠀⢈⣿⡦⠀⠀⠀⠀⣉`,
  `⠈⠳⣦⣀⠀⠀⠙⠻⣶⣄⡘⢿⣄⠀⢸⡇⠉⠻⠂⣠⡿⢃⣠⣶⠟⠋⠀⠀⣠⣴⠟⠁`,
  `⠀⠀⠈⠙⢷⣄⠀⠀⢀⣍⠛⠿⢿⣿⣾⣶⣶⣶⣿⡿⠿⠛⣩⡀⠀⠀⣠⡾⠋⠁⠀⠀`,
  `⠀⠀⠀⠀⠀⠙⣷⣶⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣶⣾⠋⠀⠀⠀⠀⠀`,
  `⠀⠀⠀⢀⣠⣾⣏⠀⠻⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⠟⠀⣹⣷⣄⠀⠀⠀⠀`,
  `⠀⠀⣠⠟⠋⠀⠙⢷⡄⠈⠻⣷⣄⠀⠀⠀⠀⠀⠀⣠⡾⠛⠁⢠⡾⠋⠀⠙⠳⣄⠀⠀`,
  `⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠳⣄⠀⠀⣠⠞⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀`,
];

// ── Layout constants (semantics aligned with the archived banner.ts)─────────────

/** Banner top-frame title (same prefix as the narrow-terminal single-line fallback). */
export const BANNER_TITLE = "◆ iknow";
/** Gap columns between the eye and the info column. */
const GAP = 3;
/** Slack on the key column relative to the longest key. */
const KEY_EXTRA = 2;
/** Value column width (fits a typical dataDir path). Over-long values are clipped by the renderer box. */
const VAL_W = 32;
/** Info-column labels (same order as the archive). */
const KV_KEYS: ReadonlyArray<readonly [string, keyof BannerInfo]> = [
  ["Version", "version"],
  ["Cwd", "cwd"],
  ["Data dir", "dataDir"],
];

const KEY_W = Math.max(...KV_KEYS.map(([k]) => stringWidth(k))) + KEY_EXTRA;

/** Total info-column width = key column + 1 gap column + value column. */
export const BANNER_INFO_WIDTH = KEY_W + 1 + VAL_W;

/**
 * The full side-by-side layout (eye + GAP + info + frame) wants 80 columns.
 * This is NOT the threshold for "draw the eye or not": the 32×13 grid itself
 * is 32 columns; a 79-column terminal should still draw the full eye, with
 * the info column left to renderer clipping.
 */
export const BANNER_MIN_COLS =
  stringWidth(EYE_LINES[0] ?? "") + GAP + BANNER_INFO_WIDTH + 2;

/** Fall back to the single line only when the eye itself does not fit. The frame costs 2 columns. */
export const BANNER_EYE_MIN_COLS = stringWidth(EYE_LINES[0] ?? "") + 2;

// ── Generators (pure functions, no ANSI / no React)───────────────────────────────

export interface BannerInfo {
  readonly version: string;
  readonly cwd: string;
  readonly dataDir: string;
}

/** Narrow-terminal fallback single line: `◆ iknow <version>`. */
export function bannerShortLine(version: string): string {
  return `${BANNER_TITLE} ${version}`;
}

function basenameOf(p: string): string {
  const segs = p.split("/").filter((s) => s !== "");
  return segs[segs.length - 1] ?? p;
}

/** The three info-column lines (plain text, key-aligned; coloring is the component layer's fg job). */
export function bannerInfoLines(info: BannerInfo): string[] {
  const values: Record<keyof BannerInfo, string> = {
    version: info.version,
    cwd: basenameOf(info.cwd),
    dataDir: info.dataDir,
  };
  return KV_KEYS.map(([key, field]) => `${key.padEnd(KEY_W)} ${values[field]}`);
}

/**
 * Render the banner as scrollbox text lines (shares the scroll space with
 * messages).
 *
 *   - Eye does not fit → single line `bannerShortLine(version)`.
 *   - Otherwise the full 13-line eye: each line = EYE_LINES[r] + GAP(3) +
 *     info-column line (32 + 3 + 43 = 78). Even slightly below 80 columns
 *     the eye is still drawn; the info column may be clipped.
 *
 * Pure function, no React / no ANSI, unit-testable.
 */
export function renderBannerLines(
  info: BannerInfo,
  cols: number
): ReadonlyArray<string> {
  if (!Number.isFinite(cols) || cols < BANNER_EYE_MIN_COLS) {
    return [bannerShortLine(info.version)]; // EXIT: eye itself does not fit
  }
  const infoLines = bannerInfoLines(info);
  // Vertically center the 3 info lines on the middle rows of the 13-row eye (rows 5,6,7, 0-indexed).
  const infoRowStart = Math.floor((EYE_LINES.length - infoLines.length) / 2);
  const blank = " ".repeat(BANNER_INFO_WIDTH);
  return EYE_LINES.map((eyeLine, r) => {
    const infoText =
      r >= infoRowStart && r < infoRowStart + infoLines.length
        ? (infoLines[r - infoRowStart] ?? "")
        : blank;
    return `${eyeLine}${" ".repeat(GAP)}${padEndVisual(
      infoText,
      BANNER_INFO_WIDTH
    )}`;
  });
}

/**
 * e2 "twilight magic stone" gradient (finalized in the logo redesign): 13×32
 * per-cell coloring, composed left→right + top→bottom (diagonal),
 * t = cWeight·(c/31) + rWeight·(r/12), linear interpolation between from/to
 * in RGB space. Mirrors scripts/banner-gradient-preview/exotic-e2.ts exactly
 * (endpoints #1a1d6e deep blue-purple → #ffafaf pink-gold; c weight 0.6 /
 * r weight 0.4).
 *
 * Pure function, no React / no ANSI, unit-testable.
 */
export function eyeGradientCells(opts: {
  readonly from: string;
  readonly to: string;
  readonly cWeight: number;
  readonly rWeight: number;
}): ReadonlyArray<
  ReadonlyArray<{ readonly text: string; readonly hex: string }>
> {
  return EYE_LINES.map((line, r) => {
    const cols = line.length - 1;
    return [...line].map((ch, c) => {
      const t = clamp01(
        opts.cWeight * (c / cols) + opts.rWeight * (r / (EYE_LINES.length - 1))
      );
      return { text: ch, hex: lerpColorHex(opts.from, opts.to, t) };
    });
  });
}

/**
 * Linear RGB-space interpolation between two #rrggbb endpoints (t ∈ [0,1]
 * auto-clamped), returns #rrggbb. Reuses the existing lerpColor semantics
 * (RGB-space interpolation), aligned with the preview script _gradient.ts;
 * no new interpolation function introduced.
 */
function lerpColorHex(from: string, to: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  const [ar, ag, ab] = hexRgb(from);
  const [br, bg, bb] = hexRgb(to);
  const comp = (a: number, b: number): string =>
    Math.round(a + (b - a) * tt)
      .toString(16)
      .padStart(2, "0");
  return `#${comp(ar, br)}${comp(ag, bg)}${comp(ab, bb)}`;
}

/** "#rrggbb" → [r, g, b] triple (0..255). Throws on invalid input. */
function hexRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`bad hex color: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Clamp t into [0,1]. */
function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

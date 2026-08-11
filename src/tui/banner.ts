/**
 * src/tui/banner.ts
 *
 * 启动 banner 文本常量 / 生成（#343 T1，OpenTUI 版）。
 *
 * 语义对齐 archive/tui-ink/src/banner.ts + banner-art.ts（智慧之眼变体 C，
 * 2026-08-06 三轮定稿）：
 *  - 眼字形 32×13 braille（EYE_LINES 字形数据原样搬入，源图
 *    docs/design/eyeshape.png 生成，勿手改）；
 *  - 版本号 SSOT = cli/usage.ts getVersion()（读 package.json，与归档
 *    version.ts 同源）；
 *  - info 栏三行 Version / Cwd / Data dir；
 *  - 窄终端降级：cols < BANNER_MIN_COLS → 单行 `◆ iknow <version>`。
 *
 * 与归档版的差异：归档版输出 ANSI 上色字符串（ink 时代手动 paint）；
 * OpenTUI 下上色交给渲染器 fg 属性，本文件只产出纯文本 + 逐 cell 渐变分段
 * 结构（eyeGradientCells），不产 ANSI。渐变端点落在 theme.ts（logoInk /
 * logoGold = e2 黄昏魔法石：深蓝紫 #1a1d6e → 粉金 #ffafaf）。
 */
import stringWidth from "string-width";
import { getVersion } from "../cli/usage.js";
import { padEndVisual } from "./visual.js";

/** TUI 展示用版本号（SSOT = package.json，经 getVersion()）。 */
export const VERSION: string = getVersion();

// ── 眼字形（归档 banner-art.ts 原样搬入，勿手改）────────────────────

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

// ── 布局常量（语义对齐归档 banner.ts）──────────────────────────────

/** banner 顶框 title（窄终端降级单行同款前缀）。 */
export const BANNER_TITLE = "◆ iknow";
/** 眼睛与 info 栏之间的间距列数。 */
const GAP = 3;
/** key 列相对最长 key 的余量。 */
const KEY_EXTRA = 2;
/** value 列宽（容纳典型 dataDir 路径）。超长值交给渲染器 box 裁切。 */
const VAL_W = 32;
/** info 栏标签（与归档同序）。 */
const KV_KEYS: ReadonlyArray<readonly [string, keyof BannerInfo]> = [
  ["Version", "version"],
  ["Cwd", "cwd"],
  ["Data dir", "dataDir"],
];

const KEY_W = Math.max(...KV_KEYS.map(([k]) => stringWidth(k))) + KEY_EXTRA;

/** info 栏总宽 = key 列 + 1 列间隔 + value 列。 */
export const BANNER_INFO_WIDTH = KEY_W + 1 + VAL_W;

/**
 * 窄终端降级阈值（语义对齐归档）：眼睛宽 + GAP + info 栏宽 + 外框开销（2）。
 * 32 列完整眼 → 32 + 3 + 43 + 2 = 80 列。cols < 80 → 单行降级。
 */
export const BANNER_MIN_COLS =
  stringWidth(EYE_LINES[0] ?? "") + GAP + BANNER_INFO_WIDTH + 2;

// ── 生成函数（纯函数，无 ANSI / 无 React）─────────────────────────

export interface BannerInfo {
  readonly version: string;
  readonly cwd: string;
  readonly dataDir: string;
}

/** 窄终端降级单行：`◆ iknow <version>`。 */
export function bannerShortLine(version: string): string {
  return `${BANNER_TITLE} ${version}`;
}

function basenameOf(p: string): string {
  const segs = p.split("/").filter((s) => s !== "");
  return segs[segs.length - 1] ?? p;
}

/** info 栏三行（纯文本，key 列对齐；上色由组件层 fg 承担）。 */
export function bannerInfoLines(info: BannerInfo): string[] {
  const values: Record<keyof BannerInfo, string> = {
    version: info.version,
    cwd: basenameOf(info.cwd),
    dataDir: info.dataDir,
  };
  return KV_KEYS.map(([key, field]) => `${key.padEnd(KEY_W)} ${values[field]}`);
}

/**
 * 渲染 banner 为 scrollbox 文本行（spec #321 方案 B：与消息共享 scroll
 * space）。
 *
 *   - cols < BANNER_MIN_COLS → 单行 `bannerShortLine(version)`，**不**加
 *     分隔线（窄终端单行模式保留，规范一致性）。
 *   - cols ≥ BANNER_MIN_COLS → 13 行：每行 = EYE_LINES[r] + GAP(3) +
 *     info 栏行（32 + 3 + 43 = 78 列 ≤ 80，不溢出）。info 三行（Version /
 *     Cwd / Data dir）垂直居中于眼睛 13 行的中间 3 行（第 5/6/7 行，
 *     0-indexed），其余 10 行 info 段空格填充至 BANNER_INFO_WIDTH 保持右缘
 *     对齐（#343 定案：图案居左 + info 居右并排）。眼形渐变上色不归本函数
 *     负责（见 eyeGradientCells）；窄终端单行短 banner 统一 logoInk 单色。
 *     分隔线不再由本函数输出。
 *
 * 纯函数，无 React / 无 ANSI，可单测。
 */
export function renderBannerLines(
  info: BannerInfo,
  cols: number
): ReadonlyArray<string> {
  if (cols < BANNER_MIN_COLS) {
    return [bannerShortLine(info.version)];
  }
  const infoLines = bannerInfoLines(info);
  // info 三行垂直居中：眼睛 13 行的中间 3 行（row 5,6,7，0-indexed）。
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
 * e2 黄昏魔法石渐变（#321 logo 重设计定案）：13×32 逐 cell 上色，左→右 + 上→下
 * 合成（对角线），t = cWeight·(c/31) + rWeight·(r/12)，在 from/to 之间 RGB
 * 空间线性插值。与 scripts/banner-gradient-preview/exotic-e2.ts 完全一致
 * （端点 #1a1d6e 深蓝紫 → #ffafaf 粉金；c 权重 0.6 / r 权重 0.4）。
 *
 * 纯函数，无 React / 无 ANSI，可单测。
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
 * #rrggbb 双端点 RGB 空间线性插值（t ∈ [0,1] 自动 clamp），返回 #rrggbb。
 * 复用现有 lerpColor 语义（RGB 空间插值），与预览脚本 _gradient.ts 对齐；
 * 不引入新插值函数。
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

/** "#rrggbb" → [r, g, b] 三元组（0..255）。非法输入抛错。 */
function hexRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`bad hex color: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** t ∈ [0,1] clamp。 */
function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

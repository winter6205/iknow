/**
 * src/tui/banner.ts
 *
 * 启动 banner（智慧之眼变体 C → 2026-08-06 改版）：纯函数，输出 ANSI 上色行。
 *
 * 改版动机（用户复看裁定）：旧版是「大号方形点阵 + 单线外框 + 整体水平居中」，
 * 眼睛偏大、被挤瘦、面板不占满行宽。新版改为：
 *  - 占满整行宽度的圆角线框（borderStyle="round"，与输入框 PromptInput 同款），
 *    无水平居中，左右边界对齐屏幕；
 *  - 小号扁平眼睛（16×6 braille）放左侧一小块（不改大、不挤瘦）；
 *  - info 栏（Version / Cwd / Data dir）放眼睛右侧，垂直居中；
 *  - 顶框内嵌左对齐 title `◆ iknow tui`，底框为横线。
 *
 * 来源：原型分支 worktree-tui-design-prototype `tui-prototype/src/logo-braille/banner.ts`
 * 的 renderVariantC（面板布局）+ visualWidth / padEndVisual / padStartVisual。
 * 裁决：#146（V7 布局 + 智慧之眼定案）/ #154（窗口适配：SHORT 档折一行
 * `◆ iknow`）/ #171（docs/design/DESIGN-BANNER.md：双色分层、图案居左 +
 * info 栏居右并排、窄终端降级）/ 2026-08-06（banner 占满行宽 + 小眼 + info 居右）。
 *
 * 色彩策略（照原型，源图实测双色）：
 *  - truecolor（COLORTERM=truecolor/24bit）→ 38;2;24;50;35（墨绿 ~#183223）/
 *    38;2;185;127;28（金棕 ~#b97f1c）；
 *  - 否则 256 色 → 22 #005f00 / 136 #af8700（CIE76 最近候选）；
 *  - NO_COLOR 或非 TTY → 不上色（paint 退化为 no-op）。
 *  - 外框走独立 dim 上色（与 logo 双色分层解耦，颜色用 FG_BORDER）。
 */
import { EYE_GOLD_LINES, EYE_LINES } from "./banner-art.js";

export interface BannerInfo {
  readonly version: string;
  readonly cwd: string;
  readonly dataDir: string;
}

// ── 颜色 / ANSI ───────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const FG_TITLE = "\x1b[38;5;255m";
const FG_DIM = "\x1b[38;5;244m";
/** 外框色（#171 任务 A：banner 自带外框，与输入框线框同风格；
 *  走 dim 中性灰，遵循 ink 256 色 244 ≈ #8a877e，与 theme.ts tuiPalette.dim
 *  同源，避免引入硬编码 hex）。 */
const FG_BORDER = "\x1b[38;5;244m";

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  return Boolean(process.stdout.isTTY);
}

function useTruecolor(): boolean {
  const ct = process.env.COLORTERM ?? "";
  return ct === "truecolor" || ct === "24bit";
}

// 源图实测双色（智慧之眼 1785827453.png）：
// - 墨绿线稿 ~#183223（眼轮廓 / 环带 / 8 符文方框同色），256 回退 22 #005f00
// - 金棕强调 ~#b97f1c（仅瞳孔内 R 符文），256 回退 136 #af8700
// 背景暖白 #f7f7f1 不渲染（用户裁定：只上色主体，背景留终端承担）。
function fgLogoInk(): string {
  return useTruecolor() ? "\x1b[38;2;24;50;35m" : "\x1b[38;5;22m";
}

function fgLogoGold(): string {
  return useTruecolor() ? "\x1b[38;2;185;127;28m" : "\x1b[38;5;136m";
}

function paint(s: string, open: string): string {
  if (!useColor()) return s;
  return `${open}${s}${RESET}`;
}

/**
 * 双色合并：墨绿主层 + 金棕强调层。逐 cell：金层非空 cell 整体用金色
 * （少量绿点被金覆盖，原型可接受），其余绿色。未开色时 paint 是 no-op，
 * 整行按主色走（即纯文本）。
 */
function mergeDualColor(
  inkLines: ReadonlyArray<string>,
  goldLines: ReadonlyArray<string>
): string[] {
  return inkLines.map((inkLine, r) => {
    const goldLine = goldLines[r];
    if (!goldLine || !useColor()) return paint(inkLine, fgLogoInk());
    let out = "";
    const inkChars = [...inkLine];
    const goldChars = [...goldLine];
    for (let c = 0; c < inkChars.length; c++) {
      const goldCell = goldChars[c] ?? "⠀";
      const inkCell = inkChars[c] ?? " ";
      if (goldCell !== "⠀" && goldCell !== " ") {
        out += paint(goldCell, fgLogoGold());
      } else if (inkCell !== "⠀" && inkCell !== " ") {
        out += paint(inkCell, fgLogoInk());
      } else {
        // 空格 cell：两层的空白 cell 码点一致，原样保留以保持宽度。
        out += inkCell === "⠀" ? "⠀" : inkCell;
      }
    }
    return out;
  });
}

// ── 视觉列宽辅助 ─────────────────────────────────────────────────────
//
// 等宽终端里"一个码点 = 一列"不成立：CJK 占 2 列，组合标记占 0 列，
// ANSI 转义序列不占位。用码点数做对齐，框线会突出、居中会偏移。

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** East Asian Wide / Fullwidth 常用子集：落在区间内的码点占 2 列。 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo 初声
  [0x2e80, 0x303e], // CJK 部首补充 … 康熙部首 … CJK 符号标点
  [0x3041, 0x33ff], // 平假名 / 片假名 / 注音 / 谚文兼容 / CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文音节
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe10, 0xfe19], // 竖排标点
  [0xfe30, 0xfe6f], // CJK 兼容形式 / 小写变体
  [0xff00, 0xff60], // 全角 ASCII 变体
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // 杂项符号与图形 / 表情
  [0x1f900, 0x1f9ff], // 补充符号与图形
  [0x20000, 0x3fffd], // CJK 扩展 B 及以上
];

/** 单个码点的视觉列宽。 */
function codePointWidth(cp: number): number {
  // 组合标记叠加在前一个字符上，不单独占列。
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  // Braille U+2800–U+28FF 是窄字符，占 1 列。它落在下面第一个 CJK 区间
  // (0x2e80) 之前，天然不冲突；显式前置是防止后续扩表时被误并进宽区间
  // —— 智慧之眼的点阵全靠它对齐。
  if (cp >= 0x2800 && cp <= 0x28ff) return 1;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

/**
 * 视觉列宽：等宽终端里这个字符串占多少列。
 * 先剥掉 ANSI 转义序列（否则上色后对齐全乱），再逐码点累加。
 */
export function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    w += codePointWidth(ch.codePointAt(0)!);
  }
  return w;
}

/** 视觉列宽版 padEnd：按缺的列数补空格，不是按码点数。 */
export function padEndVisual(s: string, width: number): string {
  const cur = visualWidth(s);
  if (cur >= width) return s;
  return s + " ".repeat(width - cur);
}

/** 视觉列宽版 padStart。 */
export function padStartVisual(s: string, width: number): string {
  const cur = visualWidth(s);
  if (cur >= width) return s;
  return " ".repeat(width - cur) + s;
}

/**
 * 中段截断：值超长时保留首尾（首段优先带路径前缀、尾段带文件名/扩展名），
 * 中间用 `…` 衔接。用于 dataDir 等绝对路径，末尾截断会丢文件名。
 * 视觉列宽计算（braille/CJK 各 1/2 列都对齐）。
 */
export function truncateMiddle(s: string, width: number): string {
  const cur = visualWidth(s);
  if (cur <= width) return s;
  // chars = Array.from(s) 保证码点级切片（braille 在 BMP 单码点 OK，CJK 也单码点）。
  const chars = [...s];
  // 偶数宽度优先，否则尾段比首段多 1 列（避免引入额外宽度偏差）。
  const headLen = Math.max(1, Math.floor((width - 1) / 2));
  const tailLen = Math.max(1, width - 1 - headLen);
  const head = chars.slice(0, headLen).join("");
  const tail = chars.slice(chars.length - tailLen).join("");
  return head + "…" + tail;
}

// ── 布局常量 ─────────────────────────────────────────────────────────

/** 眼睛图标与 info 栏之间的间距列数（#171 体验迭代 GAP=3 语义保留）。 */
const GAP = 3;
/** key 列相对最长 key 的余量。 */
const KEY_EXTRA = 2;
/** value 列宽（容纳典型 dataDir 路径如 ~/.local/share/iknow）。 */
const VAL_W = 32;
/** info 栏标签。 */
const KV_KEYS: readonly [string, string][] = [
  ["Version", "version"],
  ["Cwd", "cwd"],
  ["Data dir", "dataDir"],
];

/** key 列宽 = 最长 key 文本宽 + KEY_EXTRA。 */
const KEY_W = Math.max(...KV_KEYS.map(([k]) => visualWidth(k))) + KEY_EXTRA;

/**
 * info 栏总宽 = key 列 + 1 列间隔 + value 列。
 */
export const BANNER_INFO_WIDTH = KEY_W + 1 + VAL_W;

// ── 外框常量（2026-08-06 改版：与输入框同款圆角线框，占满行宽）──────
//
// 用 ANSI 手写框线字符（保持 renderBanner 是纯函数、返回 string[]，
// 不依赖 React）。圆角风格（borderStyle="round"，与输入框 PromptInput 相同）。
// 角字符 + 横竖线均为 1 列宽。
const BOX_TL = "╭";
const BOX_TR = "╮";
const BOX_BL = "╰";
const BOX_BR = "╯";
const BOX_H = "─";
const BOX_V = "│";
/** 顶框内嵌 title（◆ 占 1 列宽），左对齐。 */
const BOX_TITLE = "◆ iknow tui";
/** 框宽占用列数（左 +1、右 +1 = 2）。 */
const BOX_FRAMING_OVERHEAD = 2;

/**
 * 窄终端降级阈值：banner 面板总宽 = 小眼宽 + GAP + info 栏宽 + 外框开销（2）。
 * 小眼 16 列 → MIN = 16 + 3 + 43 + 2 = 64 列。cols < 64 → 返回 []。
 * （旧大眼档 48 列 MIN=96；小眼显著更宽窄终端可渲染。）
 */
export const BANNER_MIN_COLS =
  visualWidth(EYE_LINES[0] ?? "") +
  GAP +
  BANNER_INFO_WIDTH +
  BOX_FRAMING_OVERHEAD;

// ── renderBanner ─────────────────────────────────────────────────────

function basenameOf(p: string): string {
  const segs = p.split("/").filter((s) => s !== "");
  return segs[segs.length - 1] ?? p;
}

function buildInfoLines(info: BannerInfo): string[] {
  const values: Record<string, string> = {
    version: info.version,
    cwd: basenameOf(info.cwd),
    dataDir: info.dataDir,
  };
  return KV_KEYS.map(([k, field]) => {
    // key 列左对齐（dim）+ 1 列间距 + 值左对齐（默认前景）。
    // 值超长走中段截断（保留首段路径前缀 + 尾段文件名/扩展名），比末尾截断更易识别。
    const keyPainted = paint(padEndVisual(k, KEY_W), FG_DIM);
    const raw = values[field] ?? "";
    const valuePainted = truncateMiddle(raw, VAL_W);
    // 截断后右侧补空格到 VAL_W 列（保持 kv 列对齐与边框感）。
    const valuePad = padEndVisual(valuePainted, VAL_W);
    return keyPainted + " " + valuePad;
  });
}

/**
 * 渲染启动 banner（纯函数，不触碰 React）。
 *
 * 返回 ANSI 上色行（圆角外框占满 cols）：小眼睛居左 + info 栏居右并排，
 * 顶框内嵌左对齐 title `◆ iknow tui`，底框为横线。无水平居中——面板
 * 始终撑满 cols（与输入框 PromptInput 一致）。
 * cols < BANNER_MIN_COLS → []（窄终端降级）；short=true
 * → 单行 `◆ iknow <version>`（原型 L7 极简 + V7 SHORT 档，无外框）。
 */
export function renderBanner(
  info: BannerInfo,
  opts: { cols: number; short: boolean }
): string[] {
  if (opts.cols < BANNER_MIN_COLS) return [];

  if (opts.short) {
    return [paint(`◆ iknow ${info.version}`, BOLD + FG_TITLE)];
  }

  const LOGO_W = visualWidth(EYE_LINES[0] ?? "");
  const LOGO_H = EYE_LINES.length;
  const logoColored = mergeDualColor(EYE_LINES, EYE_GOLD_LINES);
  const infoLines = buildInfoLines(info);

  // info 栏在 logo 高度内垂直居中。
  const infoStart = Math.max(0, Math.floor((LOGO_H - infoLines.length) / 2));

  // 面板撑满 cols：框内宽 = cols - 2（左右框线各 1 列）。
  const innerW = Math.max(
    BANNER_MIN_COLS - BOX_FRAMING_OVERHEAD,
    opts.cols - BOX_FRAMING_OVERHEAD
  );

  // 顶框：title 左对齐 + 其余横线铺满。
  const titleVisualW = visualWidth(BOX_TITLE);
  const topBorder =
    BOX_TL +
    paint(BOX_TITLE, BOLD + FG_TITLE) +
    BOX_H.repeat(Math.max(0, innerW - titleVisualW)) +
    BOX_TR;
  const bottomBorder = BOX_BL + BOX_H.repeat(innerW) + BOX_BR;

  const borderPainted = (s: string): string => paint(s, FG_BORDER);

  const lines: string[] = [];
  lines.push(borderPainted(topBorder));
  for (let i = 0; i < LOGO_H; i++) {
    const left = padEndVisual(logoColored[i] ?? "", LOGO_W + GAP);
    const infoIdx = i - infoStart;
    const right = infoLines[infoIdx] ?? "";
    // 中段行：左框线 + 内文 + 右框线；内文视觉宽 = innerW。
    const inner = padEndVisual(left + right, innerW);
    lines.push(borderPainted(BOX_V) + inner + borderPainted(BOX_V));
  }
  lines.push(borderPainted(bottomBorder));
  return lines;
}

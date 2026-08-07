/**
 * src/tui/selection.ts — 应用内选区模型（#238 鼠标拖选复制）。
 *
 * 设计：opencode 同款 — app 自维护选区；DECSET 1002h 上报 drag 坐标；
 * mouseup 触发了复制协议（按 CellPos → 文本映射回消息内容）。
 *
 * 坐标口径（与 ChatView 行账对齐）：
 *  - `row` = 物理行号 0-based；内容流 = banner + 消息 + tail 的 flat 拼接；
 *    window = `[startRow, endRow)` 为当前可见子区间。
 *  - `col` = visual column 0-based（CJK/Emoji/宽字符按 2 列，ANSI 不计列）；
 *    在 `messageRender.lines` / banner lines / tail lines 中均按 visualWidth 计。
 *
 * 单元性：本文件只依赖纯函数 — 不读 stdin、不写 ANSI。app.tsx 负责把
 * SGR 坐标 → CellPos、把 CellPos → 调用 copyToClipboard；ChatView 负责把
 * CellPos → ink `<Text inverse>` 高亮。
 */

/** 选区单元坐标（content-row / visual-col，0-based）。 */
export interface CellPos {
  readonly row: number;
  readonly col: number;
}

/** 应用内选区（anchor..active，未规范化）。 */
export interface Selection {
  readonly anchor: CellPos;
  readonly active: CellPos;
}

/** content 视口窗口（ChatView 计算后透传；用于 SGR → 内容的行映射）。 */
export interface ContentWindow {
  /** contentRows 视角下当前可见的起始行（含）。 */
  readonly startRow: number;
  /** 结束行（不含）。 */
  readonly endRow: number;
  /** 视口宽度（terminal cols，与 markdownToLines 折行宽度一致）。 */
  readonly cols: number;
}

/** 比较两个 CellPos，按 row 先 col 后（用于规范化与排序）。 */
function cellCmp(a: CellPos, b: CellPos): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

/** 规范化：保证 anchor 在前、active 在后（无论用户拖动方向）。 */
export function normalize(sel: Selection): Selection {
  if (cellCmp(sel.anchor, sel.active) <= 0) return sel;
  return { anchor: sel.active, active: sel.anchor };
}

/** 选区是否为空（anchor === active）。 */
export function isEmpty(sel: Selection): boolean {
  return sel.anchor.row === sel.active.row && sel.anchor.col === sel.active.col;
}

/** 计算选区覆盖的内容行范围（闭区间）；规范化后调用。 */
export function rowRange(sel: Selection): { from: number; to: number } {
  const n = normalize(sel);
  return { from: n.anchor.row, to: n.active.row };
}

/**
 * SGR (1-based x,y, 内容区相对终端 1-based 行) → 内容 CellPos（0-based row, col）。
 *
 * y 是**内容区相对坐标**：ChatView 内容区占据终端第 1 行起的 `viewportRows` 行
 *（无顶部 chrome；方案 B 指示器已删，banner 入 row window）。调用方只需把
 * `y = SGR_y - 0` 直接传入（当 ChatView 起点 = 终端行 1）—— 或在 app 层减
 * 去 banner 前的终端行偏移后传入。
 *
 *  - y 落在 `[1, endRow - startRow]` 之外 → null（视口外不更新选区）；
 *  - x 落在 `[1, win.cols+1]` 之内 → col = x-1；越界则 clamp 到最近合法值
 *    （拖到右边出窗口时按右端计算，反之亦然）。
 */
export function terminalToCellPos(
  x: number,
  y: number,
  win: ContentWindow
): CellPos | null {
  const visibleRows = win.endRow - win.startRow;
  if (y < 1 || y > visibleRows) return null;
  const row = win.startRow + (y - 1);
  const col = Math.max(0, Math.min(win.cols - 1, x - 1));
  return { row, col };
}

/**
 * 给定内容行 r（0-based）、其可见文本 line、当前选区（须先 normalize），
 * 返回该行的反色高亮列范围（半开区间 `[start, end)`）。
 *  - 行不在选区覆盖范围内 → null；
 *  - 完全覆盖（中间行）→ `[0, visualWidth)`；
 *  - 部分覆盖（首 / 尾行）→ 按 visual col 截取；
 *  - `end` 恒为 exclusive（切片用 `substrVisual(line, start, end)`）。
 *
 * visualWidth 计：CJK/Emoji/宽字符 = 2 列，剩余 = 1 列。ANSI 序列不计列
 * （line 由 messageRender / banner 产出，不含 SGR）；如调用方传入的 line
 * 含 SGR，应预先 strip 掉。
 */
export function highlightRangeForLine(
  row: number,
  line: string,
  sel: Selection
): { start: number; end: number } | null {
  const n = normalize(sel);
  if (row < n.anchor.row || row > n.active.row) return null;
  const totalCols = visualWidthOf(line);
  if (totalCols === 0) return null;
  // clamp 到合法列范围（end 为 exclusive：active.col 是用户释放列，含）
  const startCol = row === n.anchor.row ? n.anchor.col : 0;
  const endCol = row === n.active.row ? n.active.col + 1 : totalCols;
  if (endCol <= startCol) return null;
  if (startCol >= totalCols) return null;
  return { start: startCol, end: Math.min(endCol, totalCols) };
}

/**
 * 把选区展开为文本：从首行 `sel.anchor` 起、到尾行 `sel.active` 止，逐行
 * 取行内可见文本，行间用 `\n` 拼接；完全未选中的行不计入。
 *
 * `lines` 为内容流 flat 数组（与 ChatView 中 banner + messageRender.lines
 * + tail 行顺序逐行对齐），其下标即内容行号。传入方负责保证一致性。
 *
 * 列偏移（首 / 尾行）按 visual col 截取（substrVisual）。空行 / 边距行
 * （" " 占位）按字面留 — 调用方可在拼好后 trim。
 */
export function extractSelectionText(
  sel: Selection,
  lines: ReadonlyArray<string>
): string {
  const n = normalize(sel);
  const out: string[] = [];
  for (let r = n.anchor.row; r <= n.active.row; r += 1) {
    const ln = lines[r] ?? "";
    if (ln.length === 0) continue;
    const totalCols = visualWidthOf(ln);
    if (totalCols === 0) continue;
    if (r === n.anchor.row && r === n.active.row) {
      // 单行选区
      const sliced = substrVisual(ln, n.anchor.col, n.active.col + 1);
      if (sliced.length > 0) out.push(sliced);
    } else if (r === n.anchor.row) {
      const sliced = substrVisual(ln, n.anchor.col, totalCols);
      if (sliced.length > 0) out.push(sliced);
    } else if (r === n.active.row) {
      const sliced = substrVisual(ln, 0, n.active.col + 1);
      if (sliced.length > 0) out.push(sliced);
    } else {
      // 中间行整行
      out.push(ln);
    }
  }
  return out.join("\n");
}

// ── visual 宽度 + 子串（CJK 宽字符计 2 列；与 banner.js / text.ts 同款） ──

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isWide(cp: number): boolean {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** visual 列宽（CJK/Emoji = 2，其余 = 1）。与 banner.js visualWidth 等价。 */
export function visualWidthOf(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return w;
}

/**
 * 按 visual 列切子串（`[colStart, colEnd)`，闭开）。
 * 实现：从左扫，累加 visual 宽度；起始 col 之前丢弃；结束 col 之后丢弃；
 * 不做 unicode normalization — 字符按 UTF-16 code unit 切，对 BMP 与代理对
 * 均一致（emoji 代理对整体 = 2 列，与 CJK 同口径）。
 */
export function substrVisual(
  s: string,
  colStart: number,
  colEnd: number
): string {
  if (colStart >= colEnd) return "";
  let w = 0;
  let out = "";
  let started = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const cw = isWide(cp) ? 2 : 1;
    if (w + cw > colEnd) break;
    if (started) {
      out += ch;
    } else if (w + cw > colStart) {
      out += ch;
      started = true;
    }
    w += cw;
    if (w >= colEnd) break;
  }
  return out;
}

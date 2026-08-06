/**
 * src/tui/row-window.ts — #189 行级窗口数学（纯函数，无 JSX）。
 *
 * 把 ChatView 的滚动 / 裁剪逻辑抽到独立模块，供 message-blocks.tsx 与
 * chat-view.tsx 共同消费。SSOT：
 *  - `computeRowWindow`：`scrollRows` → `{ scroll, endRow, startRow, maxScroll }`。
 *    maxScroll = max(0, max(totalRows - viewportRows, totalRows - 1))（Fix1
 *    短内容可滚到顶边）。
 *  - `clipSpan` / `clipUserRange` / `clipTextRange` / `toolUseInSlice`：把
 *    message 内的块行映射按窗口 slice 裁剪，返回 sliced 物理行数组。
 *
 * 不依赖 ink / react，便于在测试里直接断言。
 */
import type { BlockRowSpan } from "./message-rows.js";
import { wrapText } from "./text.js";

/** 消息级窗口切片（行号半开区间 `[start, end)`，相对 message 顶部）。 */
export interface RowSlice {
  readonly start: number;
  readonly end: number;
}

/** `computeRowWindow` 的产物（clamp 后）。 */
export interface RowWindow {
  readonly scroll: number;
  readonly endRow: number;
  readonly startRow: number;
  readonly maxScroll: number;
}

/**
 * 行级窗口数学（SSOT）：
 *  - viewportRows <= 0 表示无限视口 → maxScroll = 0（不滚）；
 *  - `scroll` clamp 到 `[0, maxScroll]`；
 *  - `endRow` = `totalRows - scroll`（含 tail 的底），`startRow` 向上推
 *    `viewportRows` 但不下穿 0。
 */
export function computeRowWindow(
  totalRows: number,
  scrollRows: number,
  viewportRows: number
): RowWindow {
  const edgeMaxScroll = totalRows > 1 ? totalRows - 1 : 0;
  const maxScroll =
    viewportRows > 0
      ? Math.max(0, Math.max(totalRows - viewportRows, edgeMaxScroll))
      : 0;
  const scroll = Math.min(Math.max(0, scrollRows), maxScroll);
  const endRow = totalRows - scroll;
  const startRow = viewportRows > 0 ? Math.max(0, endRow - viewportRows) : 0;
  return { scroll, endRow, startRow, maxScroll };
}

/** span 与窗口 slice 的相交裁剪坐标；不相交返回 `visible: false`。 */
export function clipSpan(
  span: BlockRowSpan,
  slice: RowSlice
): {
  readonly clipStart: number;
  readonly clipEnd: number;
  readonly visible: boolean;
} {
  const spanStart = span.startRow;
  const spanEnd = spanStart + span.rows;
  if (spanEnd <= slice.start || spanStart >= slice.end) {
    return { clipStart: 0, clipEnd: 0, visible: false };
  }
  const clipStart = Math.max(0, slice.start - spanStart);
  const clipEnd = Math.min(span.rows, slice.end - spanStart);
  return { clipStart, clipEnd, visible: clipEnd > clipStart };
}

/**
 * 工具摘要行（tool_use 伪块第 0 行）是否落在窗口。rows=2 的伪块只有
 * 第 0 行是摘要，第 1 行是视觉余量 margin。窗口只覆盖 margin 行则
 * 不渲染（与原 `clipStart < 1 && clipEnd > 0` 等价）。
 */
export function toolUseInSlice(span: BlockRowSpan, slice: RowSlice): boolean {
  const clip = clipSpan(span, slice);
  return clip.visible && clip.clipStart < 1 && clip.clipEnd > 0;
}

/**
 * user 文本按 `cols - 2`（❯ 前缀）折行后裁剪到窗口。user 块的 startRow
 * 恒为 0，故 slice 直接是块内行号。`prefixFirst = true` 时调用方在第一
 * 行前拼 `❯ `。
 */
export function clipUserRange(
  text: string,
  cols: number,
  slice: RowSlice
): { readonly lines: ReadonlyArray<string>; readonly prefixFirst: boolean } {
  const wrapped = wrapText(text, Math.max(1, cols - 2));
  const clipEnd = Math.min(wrapped.length, slice.end);
  const clipStart = Math.max(0, slice.start);
  return {
    lines: wrapped.slice(clipStart, clipEnd),
    prefixFirst: slice.start === 0,
  };
}

/**
 * 文本类块（thinking / redacted / text）按 `cols` 折行后裁剪到窗口。
 * thinking 与 text/redacted 在行级裁剪阶段走同一折行规则；redacted 的
 * `span.text` 已是占位串 `REDACTED_PLACEHOLDER`，无需特判。
 */
export function clipTextRange(
  span: BlockRowSpan,
  cols: number,
  slice: RowSlice
): ReadonlyArray<string> {
  const wrapped = wrapText(span.text, cols);
  const clip = clipSpan(span, slice);
  return clip.visible ? wrapped.slice(clip.clipStart, clip.clipEnd) : [];
}

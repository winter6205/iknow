/**
 * src/tui/row-window.ts — #189 行级窗口类型。
 *
 * 窗口数学（endRow / startRow / scroll clamp / chrome 预算）已内聚到
 * chat-view.tsx（需要 tailSlot / indicator 行账协同，纯函数难以承载）；
 * 块级裁剪（clipSpan / clipUserRange / clipTextRange / toolUseInSlice）已随
 * 「flat 物理行 SSOT」（message-rows.ts `messageRender`）重写移除——裁剪路径
 * 现直接对 flat 行数组取 `[start, end)` 切片，与全可见路径逐行一致。
 *
 * 本文件只保留共享的窗口切片坐标类型 `RowSlice`。
 */

/** 消息级窗口切片（行号半开区间 `[start, end)`，相对消息 flat 行数组顶部）。 */
export interface RowSlice {
  readonly start: number;
  readonly end: number;
}

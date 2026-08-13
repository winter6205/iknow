/** @jsxImportSource @opentui/react */
/**
 * src/tui/scrollable-output-region.tsx
 *
 * T3（plans/tui-render-optimization.md）：固定高度工具输出区 — 把工具调用后的
 * 完整输出（bash stdout/stderr、write/edit diff 统一 `toolPreviewRows`）收进
 * 固定高度内部滚动区，不再撑开主消息流。
 *
 * 结构：OpenTUI `<scrollbox>`（任意可嵌套 + sticky 实例级，P0 调研已确认）
 *  - `stickyScroll stickyStart="bottom"`：追加内容默认贴底跟随，用户上滚后
 *    停止跟随、滚回底部恢复（同 ChatView 滚动纪律 SC3）；
 *  - `viewportCulling`：视口外行跳过渲染（大量行不拖慢绘制）；
 *  - `height` 由调用方固定（默认 12，write/edit diff 折叠建议 6）。
 *
 * 渲染：每行一个 `<text wrapMode="none">` —— 超宽截断不折行（行账 1 行），
 * 与主消息流 Markdown（wrapMode="word"）正交。空 lines 渲染单个空 `<text>`
 * 占位（不返回 null，避免父级条件渲染抖动）。
 *
 * 导出：
 *  - `ScrollableOutputRegion`（forwardRef，暴露 `scrollToBottom()`）—
 *    上层在 post_tool_use 后可强制滚底；
 *  - `scrollableOutputRegionRows(lines, cols, height)` — 行账函数，供
 *    chrome 预算（上层按物理行数预算时用）。
 *
 * 边界：cols / height ≤ 0 时退化为空（不抛错，调用方预 split 由自身保证）。
 */
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { tuiPalette } from "./theme.js";

export interface ScrollableOutputRegionHandle {
  /** 强制滚底（post_tool_use 后调用）：scrollTop 直达 scrollHeight - 视口底。 */
  scrollToBottom(): void;
  /**
   * 内部 scrollbox renderable 直查入口（布局实测 SSOT，同 ChatViewHandle）：
   * scrollTop / scrollHeight / viewport.height。未挂载时为 null。
   */
  readonly scrollbox: ScrollBoxRenderable | null;
}

export interface ScrollableOutputRegionProps {
  /** 输出文本行（pre-split）。空数组渲染单行占位。 */
  readonly lines: ReadonlyArray<string>;
  /** 终端列宽（区域内容宽度）。 */
  readonly cols: number;
  /** 固定高度行数（默认 12）。 */
  readonly height?: number;
  /** 可选标题（如「bash 输出」），渲染为区内首行 dim 摘要。 */
  readonly title?: string;
}

/** 行账函数：区域占用的可见物理行数 = min(lines.length, height)。
 *  供 chrome 预算；空 lines 返回 0（占位行不计预算）。
 *  注意：**不含** title 行——title 渲染于区内首行（fixed 预算内挤压），
 *  调用方若需精确 chrome 账目应自行 +1。`cols` 保留为签名对齐（plan T3
 *  契约），当前预算与终端宽度无关。 */
export function scrollableOutputRegionRows(
  lines: ReadonlyArray<string>,
  _cols: number,
  height: number
): number {
  if (height <= 0) return 0;
  return Math.min(lines.length, height);
}

export const ScrollableOutputRegion = forwardRef<
  ScrollableOutputRegionHandle,
  ScrollableOutputRegionProps
>(function ScrollableOutputRegion(props, ref): ReactNode {
  const height = props.height ?? 12;
  // Hooks 必须先于条件返回（Rules of Hooks）：即使空区域也保持 hook 序稳定。
  const sbRef = useRef<ScrollBoxRenderable | null>(null);
  useImperativeHandle(ref, () => ({
    scrollToBottom() {
      const sb = sbRef.current;
      if (sb === null) return;
      sb.scrollTop = Math.max(0, sb.scrollHeight - sb.viewport.height);
    },
    get scrollbox() {
      return sbRef.current;
    },
  }));
  if (height <= 0 || props.cols <= 0) return null;
  const lines = props.lines.length === 0 ? [""] : props.lines;
  return (
    <scrollbox
      ref={sbRef}
      width={props.cols}
      height={height}
      stickyScroll={true}
      stickyStart="bottom"
      viewportCulling={true}
    >
      {props.title !== undefined && props.title.length > 0 && (
        <text fg={tuiPalette.dim} wrapMode="none">
          {props.title}
        </text>
      )}
      {lines.map((line, i) => (
        <text key={`${i}`} wrapMode="none">
          {line}
        </text>
      ))}
    </scrollbox>
  );
});

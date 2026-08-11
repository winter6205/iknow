/**
 * src/tui/selection-render.tsx — 选区反色高亮渲染（#238 鼠标拖选复制）。
 *
 * 设计：opencode 同款视觉 — 拖选区域以反色（inverse video）呈现。实现
 * 不走 Markdown 完整渲染（AST 颜色 + 反色叠加有优先级冲突），而是**当选区
 * 存在时强制走 MessageBlocksClipped 路径**（message-rows.ts 的 flat 物理行，
 * 与全可见路径逐行一致，parity 由 markdownToLines 测试锁死），对每条选中
 * 物理行把高亮段包成 `<Text inverse>`。
 *
 * 坐标口径：`row` = 内容流行号（banner + 消息 + tail 的 flat 拼接）；
 * `col` = visual 列（CJK/Emoji = 2）。见 selection.ts。
 *
 * 组件职责（保持 JSX 轻量）：
 *  - `HighlightedLine`：单行 → 三明治（前 / 中<inverse> / 后），供
 *    MessageBlocksClipped 与 banner 共用；
 *  - `SelectionSection`：多行文本段 → 逐行调用 HighlightedLine（banner / tail
 *    用）。
 *
 * 折叠 / 处理优先：selection 非 null 时，消息路径统一 `MessageBlocksClipped`
 *（含 full slice），不复用 `MessageBlocks` —— 保证高亮注入只有一个入口。
 */
import type { ReactElement } from "react";
import { Text } from "ink";
import type { Selection } from "./selection.js";
import { highlightRangeForLine, substrVisual } from "./selection.js";
import { visualWidthOf } from "./selection.js";

/** 单行高亮：把 `[start, end)`（visual col 半开）包成 `<Text inverse>`。 */
export function HighlightedLine(props: {
  readonly line: string;
  /** 已 normalize 的选区；行不在选区 → 原样渲染。 */
  readonly selection: Selection | undefined;
  /** 该行在内容流中的行号（0-based）。 */
  readonly row: number;
  /** 前景色（ColorName），selection 存在且行选中时仍保留。 */
  readonly color?: string;
  readonly bold?: boolean;
  readonly dimColor?: boolean;
}): ReactElement {
  const { line, selection, row } = props;
  if (selection === undefined || line.length === 0) {
    return (
      <Text color={props.color} bold={props.bold} dimColor={props.dimColor}>
        {line === "" ? " " : line}
      </Text>
    );
  }
  const range = highlightRangeForLine(row, line, selection);
  if (range === null) {
    return (
      <Text color={props.color} bold={props.bold} dimColor={props.dimColor}>
        {line === "" ? " " : line}
      </Text>
    );
  }
  const before = substrVisual(line, 0, range.start);
  const mid = substrVisual(line, range.start, range.end);
  const after = substrVisual(line, range.end, visualWidthOf(line));
  return (
    <Text color={props.color} bold={props.bold} dimColor={props.dimColor}>
      {before}
      <Text inverse>{mid}</Text>
      {after}
    </Text>
  );
}

/** 多行文本段 → 逐行 HighlightedLine（banner / tail 用；消息走 MessageBlocksClipped）。 */
export function SelectionSection(props: {
  readonly lines: ReadonlyArray<string>;
  /** 内容流中该段的首行行号（0-based）。 */
  readonly startRow: number;
  readonly selection: Selection | undefined;
  readonly color?: string;
}): ReactElement {
  return (
    <>
      {props.lines.map((ln, i) => (
        <HighlightedLine
          key={props.startRow + i}
          line={ln}
          row={props.startRow + i}
          selection={props.selection}
          color={props.color}
        />
      ))}
    </>
  );
}

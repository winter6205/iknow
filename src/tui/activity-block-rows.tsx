/** @jsxImportSource @opentui/react */
/**
 * src/tui/activity-block-rows.tsx
 *
 * 过程块行装配单源（specs/tui-activity-block.md T4–T7）：块标题一行 +
 * 可选 dim 预览一行（仅当该块槽是 `tool-preview`）。
 *
 * 消费方三处共用本模板：历史消息行（`MessageBlocks` 按 contentBlockIndex
 * 锚点插入）、tail 的未锚定块壳（`TranscriptTail`）。模板单列成本模块是
 * 因为 `message-blocks` 也要用它 —— 留在 `message-row` 会让二者形成
 * 循环 import（message-row 已 import MessageBlocks）。
 */
import type { ReactNode } from "react";
import * as React from "react";
import { tuiPalette } from "./theme.js";

/** 块标题 / 预览行的共享装配。keys 由调用方给（各消费方的 React key
 *  前缀不同，模板本身一致）。 */
export function renderActivityBlockRows(
  blockTitles: ReadonlyArray<string>,
  slotPreviews: ReadonlyArray<string | null>,
  contentWidth: number,
  keyOf: (blockIdx: number) => string
): ReactNode {
  return blockTitles.map((title, blockIdx) => {
    const preview = slotPreviews[blockIdx] ?? null;
    return (
      <React.Fragment key={keyOf(blockIdx)}>
        <text
          fg={tuiPalette.dim}
          wrapMode="none"
          width={Math.max(1, contentWidth - 2)}
        >
          {title}
        </text>
        {preview !== null ? (
          <text
            fg={tuiPalette.dim}
            wrapMode="none"
            width={Math.max(1, contentWidth - 2)}
          >
            {preview}
          </text>
        ) : null}
      </React.Fragment>
    );
  });
}

/** @jsxImportSource @opentui/react */
/**
 * src/tui/completed-tool-preview-view.tsx
 *
 * 完成态 write/edit 预览的共用渲染（代码行 / 截断 DiffView / 溢出文案）。
 * live box 与历史 `ToolPreviewRows` 都走这里，避免两处复制 JSX。
 * 数据 SSOT 仍是 `completedToolPreview`；本文件只渲染。
 */
import type { ReactNode } from "react";
import {
  previewOverflowLabel,
  type CompletedToolPreview,
} from "./tool-summary.js";
import { DiffView, diffRowTexts } from "./diff-view.js";
import { CodeBlock } from "./markdown.js";
import { tuiPalette } from "./theme.js";

/** 完成态预览的纯文本行（行账 / live text lines 与 JSX 同源）。 */
export function completedToolPreviewTextLines(
  preview: CompletedToolPreview,
  cols: number
): string[] {
  if (preview.kind === "empty") return [];
  const lines =
    preview.kind === "code"
      ? [...preview.lines]
      : diffRowTexts(preview.rows, cols);
  if (preview.hiddenLineCount > 0) {
    lines.push(previewOverflowLabel(preview.hiddenLineCount));
  }
  return lines;
}

/** 完成态 write/edit 预览节点：代码行或截断 DiffView，加可选溢出行。 */
export function CompletedToolPreviewView(props: {
  readonly preview: CompletedToolPreview;
  readonly cols: number;
}): ReactNode {
  const { preview, cols } = props;
  if (preview.kind === "empty") return null;
  const overflow =
    preview.hiddenLineCount > 0
      ? previewOverflowLabel(preview.hiddenLineCount)
      : null;
  return (
    <>
      {preview.kind === "code" ? (
        <CodeBlock lang="" lines={preview.lines} />
      ) : (
        preview.rows.length > 0 && <DiffView rows={preview.rows} cols={cols} />
      )}
      {overflow !== null && (
        <text fg={tuiPalette.dim} wrapMode="none">
          {overflow}
        </text>
      )}
    </>
  );
}

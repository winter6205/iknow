/** @jsxImportSource @opentui/react */
/**
 * src/tui/completed-tool-preview-view.tsx
 *
 * 完成态 write/edit 预览的共用渲染（代码行 / 截断 DiffView / 溢出文案）。
 * live box 与历史 `ToolPreviewRows` 都走这里，避免两处复制 JSX。
 * 数据 SSOT 仍是 `completedToolPreview`；本文件只渲染。
 *
 * #693 T4 D4:扩 resultPreview —— 标题行下方的 dim 尾部预览
 * （bash / skill 等子进程输出，行数由共享 result preview 合同定）。live + 历史共用同一渲染面。
 * 失败由 caller 在外层包 error 色 token 体现；preview 文本本身不变。
 *
 * 正文 gutter：单条 `│`（装饰 dim）；溢出 `… +N 行` 不加 gutter / 不加 `>`。
 */
import type { ReactNode } from "react";
import {
  resultPreviewOverflowLabel,
  writePreviewOverflowLabel,
  type CompletedToolPreview,
  type ResultPreview,
} from "./tool-summary.js";
import { DiffView, diffRowTexts } from "./diff-view.js";
import { CodeBlock } from "./markdown.js";
import { tuiPalette } from "./theme.js";

/** 结果预览正文 gutter（spec D4 dim 装饰）。一条 `│`，不再每行 `>`。 */
const RESULT_PREVIEW_PREFIX = "│";

/** 结果预览行（带 │ gutter），供行账（liveToolPreviewRows）与渲染同源。 */
export function resultPreviewTextLines(preview: ResultPreview): string[] {
  if (preview.kind === "empty") return [];
  const out: string[] = [];
  if (preview.hiddenLineCount > 0) {
    out.push(resultPreviewOverflowLabel(preview.hiddenLineCount));
  }
  for (const line of preview.lines) {
    out.push(`${RESULT_PREVIEW_PREFIX} ${line}`);
  }
  return out;
}

/** 完成态预览的纯文本行（行账 / live text lines 与 JSX 同源）。
 *  挤档（D5）无正文行 —— 标题行由调用方拼装（`squeezeWriteSummary`）。 */
export function completedToolPreviewTextLines(
  preview: CompletedToolPreview,
  cols: number
): string[] {
  if (preview.kind === "empty" || preview.kind === "squeeze") return [];
  const lines =
    preview.kind === "code"
      ? [...preview.lines]
      : diffRowTexts(preview.rows, cols);
  if (preview.hiddenLineCount > 0) {
    lines.push(writePreviewOverflowLabel(preview.hiddenLineCount));
  }
  return lines;
}

/** 完成态 write/edit 预览节点：代码行（新建 10 行 + `+N more lines`）或
 *  本次改动 DiffView（不截断）。挤档（D5）由调用方走 `squeezeWriteSummary`
 *  的标题行，本节点不渲染。 */
export function CompletedToolPreviewView(props: {
  readonly preview: CompletedToolPreview;
  readonly cols: number;
  /** #693 T4 D4:结果预览（bash / skill 输出,result preview 尾窗）。缺省 / empty 不渲染。 */
  readonly resultPreview?: ResultPreview;
}): ReactNode {
  const { preview, cols, resultPreview } = props;
  if (
    (preview.kind === "empty" || preview.kind === "squeeze") &&
    (resultPreview === undefined || resultPreview.kind === "empty")
  ) {
    return null;
  }
  const overflow =
    (preview.kind === "code" || preview.kind === "diff") &&
    preview.hiddenLineCount > 0
      ? writePreviewOverflowLabel(preview.hiddenLineCount)
      : null;
  const resultOverflow =
    resultPreview !== undefined &&
    resultPreview.kind === "result" &&
    resultPreview.hiddenLineCount > 0
      ? resultPreviewOverflowLabel(resultPreview.hiddenLineCount)
      : null;
  return (
    <>
      {preview.kind === "code" ? (
        <CodeBlock lang="" lines={preview.lines} />
      ) : preview.kind === "squeeze" ? (
        <text fg={tuiPalette.dim} wrapMode="none">
          {preview.line}
        </text>
      ) : (
        preview.kind === "diff" &&
        preview.rows.length > 0 && <DiffView rows={preview.rows} cols={cols} />
      )}
      {overflow !== null && (
        <text fg={tuiPalette.dim} wrapMode="none">
          {overflow}
        </text>
      )}
      {resultPreview !== undefined && resultPreview.kind === "result" && (
        <>
          {resultOverflow !== null && (
            <text fg={tuiPalette.dim} wrapMode="none">
              {resultOverflow}
            </text>
          )}
          {resultPreview.lines.map((line, i) => (
            // #tui-render-overhaul T1:dim 只属装饰（gutter / 溢出）—— 内容行
            // 走正文色，避免「结果预览一坨灰」。gutter 与内容分段渲染，分属
            // 不同 fg token 互不污染。
            <text key={`rp-${i}`} wrapMode="none">
              <span fg={tuiPalette.dim}>{`${RESULT_PREVIEW_PREFIX} `}</span>
              <span fg={tuiPalette.text}>{line}</span>
            </text>
          ))}
        </>
      )}
    </>
  );
}

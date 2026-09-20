/** @jsxImportSource @opentui/react */
/**
 * src/tui/completed-tool-preview-view.tsx
 *
 * Shared rendering for completed write/edit previews (code lines / truncated
 * DiffView / overflow label). Both the live box and the historical
 * `ToolPreviewRows` come through here instead of duplicating the JSX. The
 * data SSOT stays `completedToolPreview`; this file only renders.
 *
 * Extended with resultPreview —— a dim tail preview below the title row
 * (subprocess output for bash / skill etc.; line count is set by the shared
 * result-preview contract). Live and history share the same render surface.
 * Failure is applied by the caller wrapping an error-color token outside;
 * the preview text itself never changes.
 *
 * Body gutter: a single `│` (decorative dim); the overflow label carries no
 * gutter and no `>`.
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

/** Result-preview body gutter (dim decoration). One `│`, no per-line `>` anymore. */
const RESULT_PREVIEW_PREFIX = "│";

/** Result-preview lines (with │ gutter), same source for the row account (liveToolPreviewRows) and rendering. */
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

/** Plain text lines of the completed preview (row account / live text lines share
 *  one source with the JSX). The squeeze mode has no body lines —— its title row
 *  is assembled by the caller (`squeezeWriteSummary`). */
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

/** Completed write/edit preview node: code lines (first lines on create +
 *  overflow label) or this change's DiffView (untruncated). Squeeze mode goes
 *  through the caller's `squeezeWriteSummary` title row; this node renders nothing. */
export function CompletedToolPreviewView(props: {
  readonly preview: CompletedToolPreview;
  readonly cols: number;
  /** Result preview (bash / skill output, result-preview tail window). Absent / empty → no render. */
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
            // Dim belongs only to decoration (gutter / overflow) —— content lines
            // use the body color, so the result preview never reads as one gray lump.
            // Gutter and content render as separate spans with distinct fg tokens.
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

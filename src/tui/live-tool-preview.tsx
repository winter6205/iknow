/** @jsxImportSource @opentui/react */
/**
 * src/tui/live-tool-preview.tsx
 *
 * #343 T4（自 archive/tui-ink/src/live-tool-preview.tsx 迁移 ink → OpenTUI）：
 * live 工具 tail 的渲染 + 行账单一 SSOT —— `liveToolPreviewTextLines` 供
 * 渲染（liveToolPreviewBox）与行账（liveToolPreviewRows）共用，行账与渲染
 * 不漂移（parity）。
 *
 * T5 (tui-render-optimization)：running 态若有 `partialInput`（tool_input_delta
 * 累积），渲染 `[运行中] name · <partial 摘要>`（parse 成功走 summarizeToolCall，
 * 不完整 JSON 原样截断）；无增量 → 保持 `[运行中] name` 基础行。摘要统一由
 * `summarizePartialInput`（tool-summary.ts）产出，行账仍 1 行。
 *
 * write_file / edit_file 运行中不渲染 `content` 正文（含不完整 JSON）；
 * 完成后用 `completedToolPreview` 截断代码或 diff。
 *
 * 行账口径：box 渲染 = 状态行 1 行 + 预览行 N 行（diff 行按宽度折叠后
 * 可见的行）。`liveToolPreviewRows` 返回 box 实际占用的物理行数。
 */
import type { ReactNode } from "react";
import type { LiveToolRun } from "./live-tool-state.js";
import {
  formatCompletedToolLine,
  formatRunningToolLine,
} from "./live-tool-state.js";
import {
  completedToolPreview,
  formatToolStatusLine,
  summarizePartialInput,
  summarizeToolCall,
  clipOneLineVisual,
  visualWidth,
} from "./tool-summary.js";
import {
  CompletedToolPreviewView,
  completedToolPreviewTextLines,
} from "./completed-tool-preview-view.js";
import { tuiPalette } from "./theme.js";

function isWriteEditTool(name: string): boolean {
  return name === "write_file" || name === "edit_file";
}

function writeEditRunningLine(run: LiveToolRun, cols: number): string {
  const partial = run.partialInput;
  if (partial === undefined || partial.length === 0) {
    return formatRunningToolLine(run);
  }
  try {
    const parsed: unknown = JSON.parse(partial);
    if (typeof parsed !== "object" || parsed === null) {
      return formatRunningToolLine(run);
    }
    const rec = parsed as Record<string, unknown>;
    const path =
      typeof rec.path === "string" && rec.path.length > 0 ? rec.path : "?";
    // Running write/edit: name + path (+ write line count). Never old/new/content.
    const summary =
      run.name === "write_file"
        ? summarizeToolCall("write_file", parsed, cols).detail
        : clipOneLineVisual(
            `编辑 ${path}`,
            Math.min(80, Math.max(4, cols - visualWidth(run.name) - 12))
          );
    return summary.length === 0
      ? formatRunningToolLine(run)
      : formatToolStatusLine({
          toolName: run.name,
          input: parsed,
          status: "running",
          detail: summary,
          cols,
        });
  } catch {
    // EXIT: incomplete write/edit JSON → keep the running summary line;
    // do not stream content or dump raw partial JSON.
    return formatRunningToolLine(run);
  }
}

/**
 * running 状态行：有 partialInput 增量 → `[运行中] name · <partial 摘要>`；
 * 空 / 无增量 → 基础 `[运行中] name`（formatRunningToolLine）。摘要单源 =
 * summarizePartialInput，行账 1 行。write/edit 不把 content 流进该行。
 * #693 T1 D7：含 partial 的形态拼装委托 formatToolStatusLine（tool-summary SSOT），
 * 与历史 ToolSummaryRow 同源 —— 字节一致，无重复模板。
 */
function runningLine(run: LiveToolRun, cols: number): string {
  if (isWriteEditTool(run.name)) return writeEditRunningLine(run, cols);
  const partial = run.partialInput;
  if (partial === undefined || partial.length === 0) {
    return formatRunningToolLine(run);
  }
  const summary = summarizePartialInput(run.name, partial, cols);
  if (summary.length === 0) return formatRunningToolLine(run);
  return formatToolStatusLine({
    toolName: run.name,
    input: run.input,
    status: "running",
    detail: summary,
    cols,
  });
}

function completedPreviewOf(run: LiveToolRun) {
  return completedToolPreview(run.name, run.input, {
    oldContent: run.oldContent,
    newContent: run.newContent,
  });
}

/**
 * live 工具 box 的纯文本行（[状态行, ...预览行]），供行账 + flat 投影共用。
 * 完成态预览与 `completedToolPreview` 同源（代码或截断 diff）。
 */
export function liveToolPreviewTextLines(
  run: LiveToolRun,
  cols: number
): ReadonlyArray<string> {
  if (run.status === "running") {
    return [runningLine(run, cols)];
  }
  const out: string[] = [formatCompletedToolLine(run, cols)];
  for (const l of completedToolPreviewTextLines(
    completedPreviewOf(run),
    cols
  )) {
    out.push(l);
  }
  return out;
}

/** live 工具 box 占用的物理行数（状态 1 行 + 可见预览行）。 */
export function liveToolPreviewRows(run: LiveToolRun, cols: number): number {
  return liveToolPreviewTextLines(run, cols).length;
}

/** live 工具 tail box：状态行 + 完成态截断预览。
 *  运行态仅状态行（T5：有 partialInput 增量时含 `· <partial 摘要>`）；
 *  write/edit 运行中不画 content。 */
export function liveToolPreviewBox(run: LiveToolRun, cols: number): ReactNode {
  const status =
    run.status === "running"
      ? runningLine(run, cols)
      : formatCompletedToolLine(run, cols);
  const preview = run.status === "running" ? null : completedPreviewOf(run);
  return (
    <box key={run.id} flexDirection="column">
      <text fg={tuiPalette.dim} wrapMode="none">
        {status}
      </text>
      {preview !== null && (
        <CompletedToolPreviewView preview={preview} cols={cols} />
      )}
    </box>
  );
}

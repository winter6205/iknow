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
 * 行账口径：box 渲染 = 状态行 1 行 + 预览行 N 行（diff 行按宽度折叠后
 * 可见的行）。`liveToolPreviewRows` 返回 box 实际占用的物理行数。
 */
import type { ReactNode } from "react";
import type { LiveToolRun } from "./live-tool-state.js";
import {
  formatCompletedToolLine,
  formatRunningToolLine,
} from "./live-tool-state.js";
import { summarizePartialInput, toolPreviewRows } from "./tool-summary.js";
import { DiffView, diffRowTexts } from "./diff-view.js";
import { tuiPalette } from "./theme.js";

/**
 * running 状态行：有 partialInput 增量 → `[运行中] name · <partial 摘要>`；
 * 空 / 无增量 → 基础 `[运行中] name`（formatRunningToolLine）。摘要单源 =
 * summarizePartialInput，行账 1 行。
 */
function runningLine(run: LiveToolRun, cols: number): string {
  const partial = run.partialInput;
  if (partial === undefined || partial.length === 0) {
    return formatRunningToolLine(run);
  }
  const summary = summarizePartialInput(run.name, partial, cols);
  return summary.length === 0
    ? formatRunningToolLine(run)
    : `[运行中] ${run.name} · ${summary}`;
}

/**
 * live 工具 box 的纯文本行（[状态行, ...预览行]），供行账 + flat 投影共用。
 * 预览行 = diff 行按宽度折叠后可见的行（diffRowTexts 非空），与
 * `<DiffView>` 渲染行数逐行一致。
 */
export function liveToolPreviewTextLines(
  run: LiveToolRun,
  cols: number
): ReadonlyArray<string> {
  if (run.status === "running") {
    return [runningLine(run, cols)];
  }
  const out: string[] = [formatCompletedToolLine(run, cols)];
  const rows = toolPreviewRows(run.name, run.input, cols, {
    oldContent: run.oldContent,
    newContent: run.newContent,
  });
  const previewText = diffRowTexts(rows, cols);
  for (const l of previewText) out.push(l);
  return out;
}

/** live 工具 box 占用的物理行数（状态 1 行 + 可见预览行）。 */
export function liveToolPreviewRows(run: LiveToolRun, cols: number): number {
  return liveToolPreviewTextLines(run, cols).length;
}

/** live 工具 tail box：状态行 + 统一 diff 预览（红绿 + 行号）。
 *  运行态仅状态行（T5：有 partialInput 增量时含 `· <partial 摘要>`）；
 *  完成态追加 diff 预览。 */
export function liveToolPreviewBox(run: LiveToolRun, cols: number): ReactNode {
  const status =
    run.status === "running"
      ? runningLine(run, cols)
      : formatCompletedToolLine(run, cols);
  const rows =
    run.status === "running"
      ? []
      : toolPreviewRows(run.name, run.input, cols, {
          oldContent: run.oldContent,
          newContent: run.newContent,
        });
  return (
    <box key={run.id} flexDirection="column">
      <text fg={tuiPalette.dim} wrapMode="none">
        {status}
      </text>
      {rows.length > 0 && <DiffView rows={rows} cols={cols} />}
    </box>
  );
}

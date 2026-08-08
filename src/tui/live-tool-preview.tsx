/**
 * src/tui/live-tool-preview.tsx
 *
 * #298 T5 ACR line-cap 修复：把 chat-view.tsx 里 live 工具 tail 的
 * `formatCompletedToolLine + toolPreviewLines` 三处调用抽出来，收敛成单一
 * SSOT —— 渲染（liveToolPreviewBox）与行账（liveToolPreviewRows）共用
 * `liveToolPreviewTextLines`，行账与渲染不漂移（#189 parity）。
 *
 * 行账口径：box 渲染 = 状态行 1 行 + 预览行 N 行（diff 行按宽度折叠后
 * 可见的行）。`liveToolPreviewRows` 返回 box 实际占用的物理行数，
 * tailSlot / flatContentLines 用它保证窗口映射不漂移。
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { LiveToolRun } from "./live-tool-state.js";
import {
  formatCompletedToolLine,
  formatRunningToolLine,
} from "./live-tool-state.js";
import { toolPreviewRows } from "./tool-summary.js";
import { DiffView, diffRowTexts } from "./diff-view.js";
import { tuiPalette } from "./theme.js";

/**
 * live 工具 box 的纯文本行（[状态行, ...预览行]），供行账 + flatContentLines
 * 共用。预览行 = diff 行按宽度折叠后可见的行（diffRowTexts 非空），与
 * `<DiffView>` 渲染行数逐行一致（空行渲染为 `<></>` 不占行）。
 */
export function liveToolPreviewTextLines(
  run: LiveToolRun,
  cols: number
): ReadonlyArray<string> {
  if (run.status === "running") {
    return [formatRunningToolLine(run)];
  }
  const out: string[] = [formatCompletedToolLine(run)];
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

/** live 工具 tail box：状态行 + 统一 diff 预览（红绿 + 行号）。 */
export function liveToolPreviewBox(
  run: LiveToolRun,
  cols: number
): ReactElement {
  const status =
    run.status === "running"
      ? formatRunningToolLine(run)
      : formatCompletedToolLine(run);
  const rows =
    run.status === "running"
      ? []
      : toolPreviewRows(run.name, run.input, cols, {
          oldContent: run.oldContent,
          newContent: run.newContent,
        });
  return (
    <Box key={run.id} flexDirection="column">
      <Text color={tuiPalette.dim}>{status}</Text>
      {rows.length > 0 && <DiffView rows={rows} cols={cols} />}
    </Box>
  );
}

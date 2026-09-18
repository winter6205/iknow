/** @jsxImportSource @opentui/react */
/**
 * src/tui/live-tool-preview.tsx
 *
 * #343 T4（自 archive/tui-ink/src/live-tool-preview.tsx 迁移 ink → OpenTUI）：
 * live 工具 tail 的渲染 + 行账单一 SSOT —— `liveToolPreviewTextLines` 供
 * 渲染（liveToolPreviewBox）与行账（liveToolPreviewRows）共用，行账与渲染
 * 不漂移（parity）。
 *
 * 例外 = 子代理卡路径（specs/tui-subagent-transcript-live.md）：card 命中时
 * 渲染与文本行都改由 `SubagentCardView`/卡级投影承担，本模块两者都只做
 * 分流（`cardIfLive`）—— 该分支的行数恒 2，两处仍同源。
 *
 * T5 (tui-render-optimization)：running 态若有 `partialInput`（tool_input_delta
 * 累积），渲染英文过程行 `name · <partial 摘要>`（bash 为
 * `Running 1 shell command… · <command>`；parse 成功走 summarizeToolCall，
 * 不完整 JSON 原样截断）；无增量 → 基础过程行（bash 只余 shell 前缀）。
 * 摘要统一由 `summarizePartialInput`（tool-summary.ts）产出，行账仍 1 行。
 * 无 `[运行中]`（spec D1）。
 *
 * write_file / edit_file 运行中不渲染 `content` 正文（含不完整 JSON）；
 * 完成后用 `completedToolPreview` 截断代码或 diff。
 *
 * 行账口径：box 渲染 = 状态行 1 行 + 预览行 N 行（diff 行按宽度折叠后
 * 可见的行）。`liveToolPreviewRows` 返回 box 实际占用的物理行数。
 */
import type { ReactNode } from "react";
import type { SubagentCardLines } from "./subagent-message-lines.js";
import { SubagentCardView } from "./subagent-card-view.js";
import type { LiveToolRun } from "./live-tool-state.js";
import {
  formatCompletedToolLine,
  formatRunningToolLine,
} from "./live-tool-state.js";
import {
  completedToolPreview,
  formatToolStatusLine,
  resultToolPreview,
  summarizePartialInput,
  summarizeToolCall,
  clipOneLineVisual,
  clipErrorLine,
  visualWidth,
} from "./tool-summary.js";
import { deriveSlot, settledColorToFg } from "./tool-settled.js";
import {
  CompletedToolPreviewView,
  completedToolPreviewTextLines,
  resultPreviewTextLines,
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
    // Running write/edit: `Wrote <path> (N lines)` / `Edited <path>` —— 行数
    // 只在流式 content 已成非空 string 时出现（半成品里缺失 ≠ 0 行）。绝不
    // 把 old/new/content 正文流进状态行。
    const summary =
      run.name === "write_file"
        ? summarizeToolCall("write_file", parsed, cols, { running: true })
            .detail
        : clipOneLineVisual(
            `Edited ${path}`,
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
 * running 状态行：有 partialInput 增量 → 英文过程行 `name · <partial 摘要>`
 * （bash 前缀 `Running 1 shell command…`）；空 / 无增量 → 基础过程行
 * （formatRunningToolLine）。摘要单源 = summarizePartialInput，行账 1 行。
 * write/edit 不把 content 流进该行。
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

/** live 路径：完成态工具结果预览（bash）。走 run.stdout / run.stderr
 *  旁路（不依赖历史 tool_result 反序列化）。preview 声明缺席 / 字段缺席
 *  → empty。D5：失败件核置 showPreview 假 —— 不用 dim ⎿ 堆 stderr 长文
 *  （失败只走一行短错误）。 */
function resultPreviewOf(run: LiveToolRun) {
  if (run.status === "running") {
    return { kind: "empty" as const };
  }
  if (run.status === "failed") {
    return { kind: "empty" as const };
  }
  return resultToolPreview(run.name, run.input, {
    stdout: run.stdout,
    stderr: run.stderr,
  });
}

/**
 * 锁句 5 的失败横切：**失败的 run 不吃 card 投影**（走既有 failure
 * overlay），其余情形下非空 card 才是本 run 的卡级两行。
 *
 * 单一函数而非两处 `&&` 链：渲染面（`liveToolPreviewBox`）与文本面
 * （`liveToolPreviewTextLines`）都要这条判据，两处各写一遍时任何一处漂移
 * 都会让「行账说 2 行、渲染画 3 行」这类不一致重新出现。
 */
function cardIfLive(
  run: LiveToolRun,
  card: SubagentCardLines | null | undefined
): SubagentCardLines | null {
  if (run.status === "failed") return null;
  return card ?? null;
}

/**
 * live 工具 box 的纯文本行（[状态行, ...预览行]），供行账 + flat 投影共用。
 * 完成态预览与 `completedToolPreview` 同源（代码或截断 diff）；结果预览
 * 走 `resultToolPreview`（bash stdout/stderr 尾部 tail）。
 */
export function liveToolPreviewTextLines(
  run: LiveToolRun,
  cols: number,
  /** specs/tui-subagent-transcript-live.md：本 run 是 spawn 卡且 join 上了子代理
   *  时，卡的文本行改由卡级投影提供（第 1 行 `{role} running...`、第 2 行 dim
   *  预览 / 绿 `done`）。缺席 → 与改前逐字节一致（非 spawn 工具、轮询卡、未
   *  join 的 spawn 卡都走既有路径）。 */
  card?: SubagentCardLines | null
): ReadonlyArray<string> {
  const live = cardIfLive(run, card);
  if (live !== null) {
    return [live.roleLine, live.detailLine];
  }
  if (run.status === "running") {
    return [runningLine(run, cols)];
  }
  const out: string[] = [formatCompletedToolLine(run, cols)];
  if (run.status === "failed") {
    // D5：失败一行短错误（截断），不画 dim 预览。数据源 = run.message ??
    // run.detail（live 旁路字段）—— 与历史路径 message-blocks.failureTextOf
    // 的 JSON envelope 解析**有意分叉**：live 事件尚未经 tool_result 编码，
    // 没有 envelope 可解析；历史只有落盘文本，无旁路字段。两侧错误文本不
    // 承诺字节一致（同源截断纪律 = clipErrorLine）。
    const err = clipErrorLine(run.message ?? run.detail ?? "", cols);
    if (err.length > 0) out.push(err);
    return out;
  }
  for (const l of completedToolPreviewTextLines(
    completedPreviewOf(run),
    cols
  )) {
    out.push(l);
  }
  for (const l of resultPreviewTextLines(resultPreviewOf(run))) {
    out.push(l);
  }
  return out;
}

/** live 工具 box 占用的物理行数（状态 1 行 + 可见预览行）。
 *  card 命中 → 2 行（第 1 行身份 + 第 2 行预览 / `done`），行账与
 *  `liveToolPreviewTextLines` 同源（两行路径同样由它产出，parity 不破）。 */
export function liveToolPreviewRows(
  run: LiveToolRun,
  cols: number,
  card?: SubagentCardLines | null
): number {
  return liveToolPreviewTextLines(run, cols, card).length;
}

/** live 工具 runs 容器：相邻卡之间空一行（plans/tui-tool-rhythm.md T3）。
 *
 *  keep class 标题卡的卡间距与历史 MessageBlocks 的 `withBlockSpacing`
 *  （相邻块间 1 行）同一节奏 —— 历史侧由 message-blocks 的块包裹负责。
 *  间距只在卡与卡之间插入，首卡不带顶部空行（与历史首块不补顶 margin
 *  一致）。过程组摘要行不是 keep 卡，不套这条间距（本容器只收 runs，
 *  摘要行由调用方另画）。
 *
 *  `memo` 不适用：runs 为每帧新建数组的调用惯例，容器本身无状态。
 *
 *  `cards`（specs/tui-subagent-transcript-live.md）：toolUseId → 卡级两行投影
 *  （`subagentCardLinesMap` 产出）。按 `run.id` 精确查表 —— 缺表 / 缺项 →
 *  该卡走既有形态，不借用别的 worker 的预览（锁句 6）。 */
export function liveToolRunsBox(
  runs: ReadonlyArray<LiveToolRun>,
  cols: number,
  cards?: ReadonlyMap<string, SubagentCardLines>
): ReactNode {
  return (
    <box flexDirection="column" width={cols}>
      {runs.map((run, i) => (
        <box
          key={`${run.id}-card`}
          flexDirection="column"
          marginTop={i === 0 ? 0 : 1}
        >
          {liveToolPreviewBox(run, cols, cards?.get(run.id))}
        </box>
      ))}
    </box>
  );
}

/** live 工具 tail box：状态行 + 完成态截断预览。
 *  运行态仅状态行（T5：有 partialInput 增量时含 `· <partial 摘要>`）；
 *  write/edit 运行中不画 content。D5/D6：颜色消费 deriveSlot 的 color
 *  token —— 失败 error、accent 类成功 accent，dim 不再染所有完成行。
 *
 *  `card`（specs/tui-subagent-transcript-live.md）：命中时该 spawn 卡画
 *  `SubagentCardView` 两行（第 1 行 `{role} running...`、第 2 行 dim 预览 /
 *  绿 `done`），整卡不再走既有标题 + 预览组合；failed 卡不吃 card（锁句 5
 *  的失败横切在 box 这一层同样成立）。 */
export function liveToolPreviewBox(
  run: LiveToolRun,
  cols: number,
  card?: SubagentCardLines | null
): ReactNode {
  const live = cardIfLive(run, card);
  if (live !== null) {
    return (
      <box key={run.id} flexDirection="column">
        <SubagentCardView card={live} />
      </box>
    );
  }
  const running = run.status === "running";
  const status = running
    ? runningLine(run, cols)
    : formatCompletedToolLine(run, cols);
  const preview = running ? null : completedPreviewOf(run);
  const resultPreview = running ? undefined : resultPreviewOf(run);
  const slot = deriveSlot(run.name, {
    running,
    failed: run.status === "failed",
  });
  const fg = settledColorToFg(slot.color, {
    default: tuiPalette.text,
    accent: tuiPalette.accent,
    error: tuiPalette.error,
  });
  // #tui-render-overhaul T2:accent 类（skill / worktree 生命周期）标题加
  // bold —— 与 message-blocks.ToolSummaryRow 同源（live + 历史字节一致）。
  const isAccentTitle = slot.color === "accent";
  return (
    <box key={run.id} flexDirection="column">
      {isAccentTitle ? (
        <text fg={fg} wrapMode="none">
          <b>{status}</b>
        </text>
      ) : (
        <text fg={fg} wrapMode="none">
          {status}
        </text>
      )}
      {preview !== null && (
        <CompletedToolPreviewView
          preview={preview}
          cols={cols}
          resultPreview={resultPreview}
        />
      )}
    </box>
  );
}

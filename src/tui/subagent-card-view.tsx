/** @jsxImportSource @opentui/react */
/**
 * src/tui/subagent-card-view.tsx
 *
 * specs/tui-subagent-transcript-live.md（锁句 1–2、5–6）：活子代理两行的
 * **唯一渲染面** —— live tail（`live-tool-preview.tsx`）与历史卡
 * （`message-blocks.tsx`）共用本组件。与 `CompletedToolPreviewView` 同款
 * 分工：投影在纯函数模块（`subagent-message-lines.ts`），渲染单源在此，
 * 两宿主不得各写一套 JSX —— 否则 dim / 绿色与空行占位会在两条路径上漂移。
 *
 * 颜色纪律：第 1 行恒默认正文色（live 为 `{role} running...`，completed 只作
 * 身份 —— 锁句 2 reopen）；概述行恒 dim（完成态不改它的着色，绿只属于完成
 * 标记）；`doneLine` 在场时以其下第 3 行绿 `tuiPalette.add` 画逐字 `✓ Done`。
 * 空预览渲染单空格占位：行账恒定，卡片不塌陷（锁句 1 的「占两行」）。
 */
import type { ReactNode } from "react";
import type { SubagentCardLines } from "./subagent-message-lines.js";
import { tuiPalette } from "./theme.js";

export function SubagentCardView(props: {
  readonly card: SubagentCardLines;
}): ReactNode {
  const { card } = props;
  return (
    <box flexDirection="column">
      <text fg={tuiPalette.text} wrapMode="none">
        {card.roleLine}
      </text>
      <text fg={tuiPalette.dim} wrapMode="none">
        {card.detailLine === "" ? " " : card.detailLine}
      </text>
      {card.doneLine === undefined ? null : (
        <text fg={tuiPalette.add} wrapMode="none">
          {card.doneLine}
        </text>
      )}
    </box>
  );
}

/** @jsxImportSource @opentui/react */
/**
 * src/tui/agent-status-line.tsx
 *
 * ADR-0028 状态栏的 TUI 投影：只把未勾待办给人看（mode 行上方、单行压缩）。
 * last_tool 仍进模型 `<agent_status>` 栏与 tool_call trace，不映射到 chrome。
 *
 * 数据契约：唯一来源是 harness 注入栏同一计算点的 `agent_status` 流事件；
 * 本模块不读待办账本文件。replace-on-event：每个事件产完整独立快照。
 *
 * 显示：有未勾项 → 一行 `□ a · b · c`（视觉宽度截断）；无未勾 / null → 0 行。
 */
import type { ReactNode } from "react";
import type { AgentStatusSnapshot } from "../harness/agent-status.js";
import { OPEN_PREFIX } from "../harness/aci/tools/todo-write.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

const ITEM_PREFIX = "□ ";

export interface AgentStatusLine {
  readonly fg: string;
  readonly text: string;
}

export function agentStatusFromEvent(
  event: HarnessStreamEvent
): AgentStatusSnapshot | null {
  if (event.type !== "agent_status") return null;
  return Object.freeze({
    lastTool: event.lastTool,
    openTodoLines: Object.freeze([...event.openTodoLines]),
  });
}

function todoBody(raw: string): string {
  return raw.startsWith(OPEN_PREFIX) ? raw.slice(OPEN_PREFIX.length) : raw;
}

export function agentStatusLines(
  snapshot: AgentStatusSnapshot | null,
  cols: number
): ReadonlyArray<AgentStatusLine> {
  if (snapshot === null) return [];
  const items = snapshot.openTodoLines;
  if (items.length === 0) return [];
  const joined = items.map(todoBody).join(" · ");
  const budget = Math.max(0, cols - visualWidth(ITEM_PREFIX));
  return [
    {
      fg: tuiPalette.dim,
      text: `${ITEM_PREFIX}${clipOneLineVisual(joined, budget)}`,
    },
  ];
}

export interface AgentStatusPanelProps {
  readonly snapshot: AgentStatusSnapshot | null;
  readonly cols: number;
}

export function AgentStatusPanel(props: AgentStatusPanelProps): ReactNode {
  const lines = agentStatusLines(props.snapshot, props.cols);
  if (lines.length === 0) return null;
  return (
    <box flexDirection="column">
      {lines.map((line, idx) => (
        <text key={idx} fg={line.fg} wrapMode="none">
          {line.text}
        </text>
      ))}
    </box>
  );
}

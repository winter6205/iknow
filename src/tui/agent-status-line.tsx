/** @jsxImportSource @opentui/react */
/**
 * src/tui/agent-status-line.tsx
 *
 * #647 T3 / ADR-0028 / CONTEXT「状态栏」:agent 现势显示 —— 渲染在
 * ContextBar(上下文用量条,token 口径)**下方**的几行「即将送进模型的同一份
 * 现势」(last_tool + 未勾 todo)。命名刻意用 AgentStatus 前缀:本组件是模型
 * 向现势快照,与 context usage (display) 是两回事(CONTEXT Avoid:与 context
 * usage 混名)。
 *
 * 数据契约(ADR-0028「UI 只读最新一份现势,不另建账本」):
 *   - 唯一来源是 harness 在注入 `<agent_status>` 栏的同一计算点发出的
 *     `agent_status` 流事件;本模块绝不读 todo 账本文件、不 import 账本
 *     读取器(tests/tui/agent-status-panel.test.ts grep 守卫钉死);
 *   - replace-on-event:每个事件的投影(agentStatusFromEvent)是**完整独立**
 *     快照 → app 单 state 槽整体替换,无历史、无合并,不可能出现新旧混合;
 *   - 纯展示组件,零 effect / 订阅 / 轮询(与 subagent-panel 同款两层结构:
 *     纯函数投影 + 渲染壳),行数由调用方传 chromeReserveRows.agentStatusRows
 *     入账。
 *
 * 显示形状(空槽不广告,对齐栏语义):
 *   - 有未勾项:`◇ last_tool: <name>` + 每项一行 `□ <item>`(剥掉账本
 *     `- [ ] ` 前缀,条目按视觉宽度截断);
 *   - 无未勾项:仅 `◇ last_tool: <name>` 一行,不印空清单占位;
 *   - 未勾项超过 MAX_OPEN_TODO_ROWS:前 N 行 + `… 另有 M 项未勾` footer
 *     (显示侧封顶 4 行未勾 + 溢出 footer,#648 落地前防 chrome 行账无界,
 *     见 plans/agent-status-bar.md T3);
 *   - 尚无快照(null)→ 0 行,组件渲染 null。
 *
 * 字形纪律(spec #146:86 无 emoji UI 字形):只用几何字形 `◇ □ …`(项目
 * 既有惯例,见 subagent-panel 的 ● ○ ✓ ✗ ▤)。
 */
import type { ReactNode } from "react";
import type { AgentStatusSnapshot } from "../harness/agent-status.js";
import { OPEN_PREFIX } from "../harness/aci/tools/todo-write.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

/**
 * 未勾项显示行上限;超出折叠为 `… 另有 M 项未勾` footer。显示侧封顶 4 行
 * 未勾 + 溢出 footer(#648 落地前防 chrome 行账无界;写入口条数硬顶归
 * #648,plans/agent-status-bar.md T3 追认此显示侧封顶)。
 */
export const MAX_OPEN_TODO_ROWS = 4;

/** header 前缀 `◇ `(几何字形,2 列)。 */
const HEADER_PREFIX = "◇ ";
/** 未勾项前缀 `□ `(几何字形,2 列)。 */
const ITEM_PREFIX = "□ ";

export interface AgentStatusLine {
  readonly fg: string;
  /** 完整行文本(含前缀字形),组件直接 `<text>{text}</text>`。 */
  readonly text: string;
}

/**
 * 事件 → 快照投影(agent_status 专用;其余事件 → null,调用方保持旧快照)。
 * 返回**完整独立**的冻结快照 —— replace-on-event 语义的构造性保证:不读取
 * 任何先前状态,app 的单 state 槽 setAgentStatus(本投影) 即整体替换。
 *
 * null 臂注:app 调用点(app.tsx onStream)已在 `event.type === "agent_status"`
 * 分支内调用,类型上不可能走 null;保留全量签名(不为调用点 narrow 成非空)
 * 是为了直接单测直驱(非 agent_status 事件 → null 用例)与防御性收窄 —— 若
 * 未来调用点漏了 type guard,投影返回 null 也不会把垃圾写进 state。
 */
export function agentStatusFromEvent(
  event: HarnessStreamEvent
): AgentStatusSnapshot | null {
  if (event.type !== "agent_status") return null;
  return Object.freeze({
    lastTool: event.lastTool,
    openTodoLines: Object.freeze([...event.openTodoLines]),
  });
}

/**
 * 纯函数投影:快照 → 显示行(不 touch OpenTUI,可单测直驱)。
 * null → 空数组(组件渲染 null,调用方入账 0 行)。条目逐行折叠空白 + 按
 * 视觉宽度截断(CJK 安全,与 subagent-panel 同纪律);last_tool 名同样折叠
 * (防内嵌换行让一行变多行)。
 */
export function agentStatusLines(
  snapshot: AgentStatusSnapshot | null,
  cols: number
): ReadonlyArray<AgentStatusLine> {
  if (snapshot === null) return [];
  const headerLabel = "last_tool: ";
  const header: AgentStatusLine = {
    fg: tuiPalette.running,
    text: `${HEADER_PREFIX}${headerLabel}${clipOneLineVisual(
      snapshot.lastTool.replace(/\s+/g, " ").trim(),
      Math.max(0, cols - visualWidth(HEADER_PREFIX + headerLabel))
    )}`,
  };
  const items = snapshot.openTodoLines;
  if (items.length === 0) return [header];
  const itemBudget = Math.max(0, cols - visualWidth(ITEM_PREFIX));
  const lines: AgentStatusLine[] = [header];
  const shown = Math.min(items.length, MAX_OPEN_TODO_ROWS);
  for (let i = 0; i < shown; i++) {
    const raw = items[i]!;
    // 剥账本前缀(与写入方 OPEN_PREFIX 同一真源);非该形态的行逐字保留。
    const body = raw.startsWith(OPEN_PREFIX)
      ? raw.slice(OPEN_PREFIX.length)
      : raw;
    lines.push({
      fg: tuiPalette.dim,
      text: `${ITEM_PREFIX}${clipOneLineVisual(body, itemBudget)}`,
    });
  }
  if (items.length > MAX_OPEN_TODO_ROWS) {
    lines.push({
      fg: tuiPalette.dim,
      text: `… 另有 ${items.length - MAX_OPEN_TODO_ROWS} 项未勾`,
    });
  }
  return lines;
}

export interface AgentStatusPanelProps {
  /** 最新一份现势快照(agent_status 事件投影;null = 尚未有事件)。 */
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

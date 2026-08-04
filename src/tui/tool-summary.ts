/**
 * src/tui/tool-summary.ts
 *
 * #146 Q5b=B 工具调用摘要行（纯格式化，可单测）：
 *  - 摘要行 = 工具名 + 参数摘要 + 状态；
 *  - 生成/编辑类增强：write_file/edit_file 显示「生成了什么」
 *    （路径 + 行数；diff 完整形态留实施细化，受无 emoji 约束）。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";

export interface ToolSummaryLine {
  readonly toolName: string;
  readonly detail: string;
  /** ok | failed | unknown（tool_result 未到达，如 cancelled 中断）。 */
  readonly status: "ok" | "failed" | "unknown";
}

const MAX_DETAIL = 80;

function clip(s: string, max = MAX_DETAIL): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

/** 单个工具调用的参数摘要。 */
export function summarizeToolCall(
  name: string,
  input: unknown
): { detail: string } {
  const rec = inputRecord(input);
  switch (name) {
    case "write_file": {
      const path = typeof rec.path === "string" ? rec.path : "?";
      const lines = countLines(rec.content);
      return { detail: `写入 ${path}（${lines} 行）` };
    }
    case "edit_file": {
      const path = typeof rec.path === "string" ? rec.path : "?";
      const all = rec.replace_all === true;
      return {
        detail: `编辑 ${path}${all ? "（全部替换）" : ""}：${clip(
          String(rec.old_str ?? "")
        )} → ${clip(String(rec.new_str ?? ""))}`,
      };
    }
    case "bash":
      return { detail: clip(String(rec.command ?? "")) };
    case "read_file":
      return { detail: `读取 ${String(rec.path ?? "?")}` };
    case "grep":
      return { detail: `搜索 ${String(rec.pattern ?? "?")}` };
    case "glob":
      return { detail: `匹配 ${String(rec.pattern ?? "?")}` };
    default:
      return { detail: clip(JSON.stringify(rec)) };
  }
}

/** tool_use_id → is_error 状态映射（tool_result 精确配对，SSOT）。 */
export function toolResultStatusMap(
  messages: ReadonlyArray<AnthropicNativeMessage>
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        map.set(block.tool_use_id, block.is_error === true);
      }
    }
  }
  return map;
}

/**
 * 从权威 messages 投影工具摘要行（resume 渲染 / 单测用）：
 * assistant.tool_use 产出行，tool_result 按 tool_use_id 回填状态。
 */
export function projectToolLines(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<ToolSummaryLine> {
  const statusMap = toolResultStatusMap(messages);
  const lines: ToolSummaryLine[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const { detail } = summarizeToolCall(block.name, block.input);
      const hasResult = statusMap.has(block.id);
      const failed = statusMap.get(block.id) === true;
      lines.push({
        toolName: block.name,
        detail,
        status: !hasResult ? "unknown" : failed ? "failed" : "ok",
      });
    }
  }
  return lines;
}

/** 运行时 postToolUse 事件的摘要行文案（turn 进行中逐条出现）。 */
export function formatLiveToolEvent(opts: {
  readonly toolName: string;
  readonly input: unknown;
  readonly kind: string;
}): string {
  const { detail } = summarizeToolCall(opts.toolName, opts.input);
  const status = opts.kind === "ok" ? "ok" : "failed";
  return `${opts.toolName} · ${detail} · ${status}`;
}

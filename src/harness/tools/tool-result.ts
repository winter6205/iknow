/**
 * ToolExecutionResult 帮助函数:015 拥有。
 *
 * Registry / Executor 把 ToolExecutionResult 视为一次性匹配身份的确定
 * 性收据,无状态、无副作用、可丢弃。Model Adapter 负责把它编码成原生
 * tool_result 消息。
 */

import type {
  AnthropicContentBlock,
} from "../model-adapter/types.js";
import type { ToolExecutionResult } from "./types.js";

/**
 * 把 ToolExecutionResult 转成 Anthropic tool_result content blocks 列表。
 * 失败标签统一渲染为 `is_error: true` 的原生 tool_result,身份匹配 tool_use_id。
 */
export function toAnthropicToolResults(
  results: ReadonlyArray<ToolExecutionResult>,
): AnthropicContentBlock[] {
  return results.map((r) => {
    if (r.kind === "ok") {
      return {
        type: "tool_result",
        tool_use_id: r.toolUseId,
        content: r.payload,
      } satisfies AnthropicContentBlock;
    }
    const text = describeFailure(r);
    return {
      type: "tool_result",
      tool_use_id: r.toolUseId,
      is_error: true,
      content: [{ type: "text", text }],
    } satisfies AnthropicContentBlock;
  });
}

function describeFailure(r: ToolExecutionResult): string {
  switch (r.kind) {
    case "validation_failed":
      return `[validation_failed] ${r.message}`;
    case "execution_failed":
      return `[execution_failed] ${r.message}`;
    case "tool_not_found":
      return `[tool_not_found] tool not found: ${r.toolName}`;
    case "ok":
      return "ok"; // unreachable
  }
}
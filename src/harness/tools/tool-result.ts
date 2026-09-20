/**
 * ToolExecutionResult helpers.
 *
 * Registry / Executor treat a result as a one-shot identity-matched receipt:
 * stateless, side-effect-free, discardable. Encoding into a native
 * tool_result message is the Model Adapter's job.
 */

import type { AnthropicContentBlock } from "../model-adapter/types.js";
import type { ToolExecutionResult } from "./types.js";

/**
 * Convert ToolExecutionResults into Anthropic tool_result content blocks.
 * All failure labels render uniformly as `is_error: true`, matched to tool_use_id.
 */
export function toAnthropicToolResults(
  results: ReadonlyArray<ToolExecutionResult>
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

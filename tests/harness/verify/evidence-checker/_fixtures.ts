/**
 * evidence-checker 测试共享 fixture (Dup Code 收敛, Fowler #2)。
 * 6 个测试文件共用 toolUse/toolResult/textBlock/message/greenTranscript;
 * VITEST_GREEN 是 vitest 绿摘要标准 fixture。
 */
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../../src/harness/model-adapter/types.js";

export function toolUse(id: string, command: string): AnthropicContentBlock {
  return { type: "tool_use", id, name: "bash", input: { command } };
}

export function toolResult(
  id: string,
  content: unknown,
  is_error = false
): AnthropicContentBlock {
  return { type: "tool_result", tool_use_id: id, content, is_error };
}

export function editFile(id: string, filePath: string): AnthropicContentBlock {
  return { type: "tool_use", id, name: "edit_file", input: { filePath } };
}

export function writeFile(
  id: string,
  filePath: string,
  content: unknown
): AnthropicContentBlock {
  return {
    type: "tool_use",
    id,
    name: "write_file",
    input: { filePath, content },
  };
}

export function textBlock(text: string): AnthropicContentBlock {
  return { type: "text", text };
}

export function message(
  role: "user" | "assistant",
  ...blocks: AnthropicContentBlock[]
): AnthropicNativeMessage {
  return { role, content: blocks };
}

export const VITEST_GREEN = " ✓ Tests  3 passed (3)\n";

/**
 * 标准绿证据 transcript: task → bash(tool_use + tool_result 绿摘要) → done。
 * tail 可追加绿后编辑等 message (时效/soft 信号场景)。
 */
export function greenTranscript(
  command: string,
  stdout: string,
  tail: AnthropicNativeMessage[] = []
): AnthropicNativeMessage[] {
  const id = "g01";
  return [
    message("user", textBlock("task")),
    message(
      "assistant",
      toolUse(id, command),
      toolResult(id, JSON.stringify({ code: 0, stdout, stderr: "" }))
    ),
    ...tail,
    message("user", textBlock("done")),
  ];
}

/** 绿 bash run 块 (tool_use + tool_result) 供 CONTRADICTED 场景组合。 */
export function greenRun(id: string): AnthropicContentBlock[] {
  return [
    toolUse(id, "npx vitest run"),
    toolResult(
      id,
      JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
    ),
  ];
}

/**
 * Shared fixtures for the evidence-checker tests (deduplicated across the six
 * test files): toolUse/toolResult/textBlock/message/greenTranscript.
 * VITEST_GREEN is the standard vitest green-summary fixture.
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
 * Standard green-evidence transcript: task → bash (tool_use + tool_result with
 * a green summary) → done. `tail` appends post-green messages (staleness /
 * soft-signal scenarios).
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

/** Green bash run pair (tool_use + tool_result) for composing CONTRADICTED scenarios. */
export function greenRun(id: string): AnthropicContentBlock[] {
  return [
    toolUse(id, "npx vitest run"),
    toolResult(
      id,
      JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
    ),
  ];
}

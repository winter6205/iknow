import { describe, expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import {
  toolResultStatusMap,
  toolResultTextMap,
} from "../../src/tui/tool-summary.js";
import { toolUseIdsOf } from "../../src/tui/turn-activity.js";
import { syncToolIndex } from "../../src/tui/tool-result-index.js";

function userToolResult(
  id: string,
  content: string,
  isError = false
): AnthropicNativeMessage {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: id, content, is_error: isError },
    ],
  } as AnthropicNativeMessage;
}

function assistantToolUse(id: string, name = "bash"): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  } as AnthropicNativeMessage;
}

function assistantText(text: string): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as AnthropicNativeMessage;
}

function baseMessages(): AnthropicNativeMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "ask" }] },
    assistantToolUse("t1"),
    userToolResult("t1", "out-1"),
    assistantToolUse("t2", "read_file"),
    userToolResult("t2", "out-2", true),
  ];
}

describe("syncToolIndex: equivalence with the full-map builders", () => {
  test("cold build equals toolResultStatusMap / toolResultTextMap / toolUseIdsOf", () => {
    const messages = baseMessages();
    const index = syncToolIndex(null, messages);
    expect(new Map(index.statusMap)).toEqual(toolResultStatusMap(messages));
    expect(new Map(index.resultTextMap)).toEqual(toolResultTextMap(messages));
    expect(new Set(index.toolUseIds)).toEqual(new Set(toolUseIdsOf(messages)));
  });

  test("tool_use in a non-assistant message stays out of toolUseIds (same role guard as toolUseIdsOf)", () => {
    const malformed = {
      role: "user",
      content: [{ type: "tool_use", id: "ghost", name: "bash", input: {} }],
    } as unknown as AnthropicNativeMessage;
    const messages = [...baseMessages(), malformed];
    const index = syncToolIndex(null, messages);
    expect(index.toolUseIds.has("ghost")).toBe(false);
    expect(new Set(index.toolUseIds)).toEqual(new Set(toolUseIdsOf(messages)));
    // The maps keep the oracles' role-agnostic scan (tool_result lives in
    // user messages), so the guard must not leak into them.
    expect(new Map(index.statusMap)).toEqual(toolResultStatusMap(messages));
    expect(new Map(index.resultTextMap)).toEqual(toolResultTextMap(messages));
    // Same verdict through the incremental append path (tail scan).
    const warm = syncToolIndex(syncToolIndex(null, baseMessages()), messages);
    expect(warm.toolUseIds.has("ghost")).toBe(false);
  });

  test("empty input builds empty index", () => {
    const index = syncToolIndex(null, []);
    expect(index.statusMap.size).toBe(0);
    expect(index.resultTextMap.size).toBe(0);
    expect(index.toolUseIds.size).toBe(0);
  });

  test("string-array tool_result content joins text blocks (same rule as toolResultTextMap)", () => {
    const messages: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      } as AnthropicNativeMessage,
    ];
    const index = syncToolIndex(null, messages);
    expect(index.resultTextMap.get("t1")).toBe("ab");
  });

  test("empty-content tool_result stays absent from the text map", () => {
    const index = syncToolIndex(null, [userToolResult("t1", "")]);
    expect(index.resultTextMap.has("t1")).toBe(false);
  });
});

describe("syncToolIndex: incremental extend on append", () => {
  test("same messages reference returns the identical index", () => {
    const messages = baseMessages();
    const index = syncToolIndex(null, messages);
    expect(syncToolIndex(index, messages)).toBe(index);
  });

  test("pure append with no tool blocks keeps map/set references identical", () => {
    const messages = baseMessages();
    const index = syncToolIndex(null, messages);
    const appended = [...messages, assistantText("no tools here")];
    const next = syncToolIndex(index, appended);
    expect(next.statusMap).toBe(index.statusMap);
    expect(next.resultTextMap).toBe(index.resultTextMap);
    expect(next.toolUseIds).toBe(index.toolUseIds);
    expect(next.source).toBe(appended);
  });

  test("pure append extends entries and stays equivalent to the full build", () => {
    const messages = baseMessages();
    const index = syncToolIndex(null, messages);
    const appended = [
      ...messages,
      assistantToolUse("t3"),
      userToolResult("t3", "out-3"),
    ];
    const next = syncToolIndex(index, appended);
    expect(new Map(next.statusMap)).toEqual(toolResultStatusMap(appended));
    expect(new Map(next.resultTextMap)).toEqual(toolResultTextMap(appended));
    expect(new Set(next.toolUseIds)).toEqual(new Set(toolUseIdsOf(appended)));
    // old entries survive with their values
    expect(next.statusMap.get("t2")).toBe(true);
  });

  test("duplicate tool_use_id keeps last-wins semantics across the append boundary", () => {
    const index = syncToolIndex(null, [userToolResult("t1", "first", false)]);
    const appended = [
      userToolResult("t1", "first", false),
      userToolResult("t1", "second", true),
    ];
    const next = syncToolIndex(index, appended);
    expect(next.statusMap.get("t1")).toBe(true);
    expect(next.resultTextMap.get("t1")).toBe("second");
    expect(new Map(next.statusMap)).toEqual(toolResultStatusMap(appended));
  });
});

describe("syncToolIndex: rebuild on non-append change", () => {
  test("mid-list replacement rebuilds and removed entries disappear", () => {
    const index = syncToolIndex(null, baseMessages());
    const mutated = baseMessages();
    mutated[4] = userToolResult("tX", "other");
    const next = syncToolIndex(index, mutated);
    expect(next.statusMap.has("t2")).toBe(false);
    expect(new Map(next.statusMap)).toEqual(toolResultStatusMap(mutated));
    expect(new Map(next.resultTextMap)).toEqual(toolResultTextMap(mutated));
  });

  test("truncation (rewind/compact shape) rebuilds without stale tail entries", () => {
    const index = syncToolIndex(null, baseMessages());
    const truncated = baseMessages().slice(0, 3);
    const next = syncToolIndex(index, truncated);
    expect(next.statusMap.has("t2")).toBe(false);
    expect(new Map(next.statusMap)).toEqual(toolResultStatusMap(truncated));
  });

  test("head replacement with same length rebuilds fully", () => {
    const index = syncToolIndex(null, baseMessages());
    const replacedHead = [assistantText("summary"), ...baseMessages().slice(1)];
    const next = syncToolIndex(index, replacedHead);
    expect(new Map(next.statusMap)).toEqual(toolResultStatusMap(replacedHead));
  });
});

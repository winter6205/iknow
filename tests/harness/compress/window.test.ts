import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
} from "../../../src/harness/compress/constant.ts";
import { compactMessages } from "../../../src/harness/compress/window.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";

const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

const toolUse = (id: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "lookup", input: {} }],
});

const toolResult = (id: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

describe("compactMessages", () => {
  it("leaves empty, singleton, and shorter windows untouched", () => {
    const empty: AnthropicNativeMessage[] = [];
    assert.strictEqual(compactMessages(empty), empty);
    const singleton = [text("one")];
    assert.strictEqual(compactMessages(singleton), singleton);
    const short = Array.from({ length: DEFAULT_KEEP_RECENT - 1 }, (_, i) =>
      text(String(i))
    );
    assert.strictEqual(compactMessages(short), short);
  });

  it("replaces discarded prefix with the exact boundary placeholder", () => {
    const messages = Array.from({ length: 10 }, (_, i) => text(String(i)));
    const result = compactMessages(messages);
    assert.notStrictEqual(result, messages);
    assert.deepStrictEqual(result[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });
    assert.deepStrictEqual(result.slice(1), messages.slice(4));
    assert.deepStrictEqual(
      messages,
      Array.from({ length: 10 }, (_, i) => text(String(i)))
    );
  });

  it("keeps the tool_use paired with a tail tool_result", () => {
    const messages = [
      text("0"),
      text("1"),
      text("2"),
      text("3"),
      text("4"),
      toolUse("call-1"),
      text("6"),
      toolResult("call-1"),
    ];
    const result = compactMessages(messages, 2);
    assert.deepStrictEqual(result.slice(1), messages.slice(5));
  });

  it("throws when a kept tool_use has no result", () => {
    const messages = [
      ...Array.from({ length: 5 }, (_, i) => text(String(i))),
      toolUse("missing"),
    ];
    assert.throws(() => compactMessages(messages, 1), /missing tool_result/);
  });
});

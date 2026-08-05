/**
 * Pure-function tests for turn-projection (T1).
 *
 * Boundary classes (per arthurpower:defensive-contract-validator):
 *   - empty:    empty input → undefined
 *   - normal:   mixed thinking + toolCalls projection, block order preserved
 *   - redacted: redacted_thinking → redactedCount, no entries
 *   - overflow: truncation at 2000 / 500 / 1500
 *   - mask:     mask applied before truncation
 *   - missing:  tool_use without matching tool_result → outputPreview="", isError=false
 *   - boundary: empty thinking text → skipped; no thinking at all → undefined
 *   - error:    tool_result.is_error=true → isError=true
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";
import {
  MAX_THINKING_TEXT_CHARS,
  MAX_TOOL_INPUT_PREVIEW_CHARS,
  MAX_TOOL_OUTPUT_PREVIEW_CHARS,
  projectThinkingView,
  projectToolCalls,
} from "../../src/session-api/turn-projection.ts";

// helpers ---------------------------------------------------------------

const identity = (s: string): string => s;
/** Replace any occurrence of `secret` with `***` for SC20 boundary checks. */
const maskSecret =
  (secret: string): ((s: string) => string) =>
  (s: string): string =>
    s.split(secret).join("***");

const assistant = (
  role: "user" | "assistant",
  blocks: ReadonlyArray<AnthropicNativeMessage["content"][number]>
): AnthropicNativeMessage => ({ role, content: blocks });

// -- boundary 1: empty ----------------------------------------------------

describe("boundary: empty input", () => {
  it("projectThinkingView([]) → undefined", () => {
    assert.equal(projectThinkingView([], identity), undefined);
  });

  it("projectToolCalls([]) → undefined", () => {
    assert.equal(projectToolCalls([], identity), undefined);
  });

  it("messages with no thinking/toolUse → both undefined", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "hi" }]),
      assistant("assistant", [{ type: "text", text: "hello" }]),
    ];
    assert.equal(projectThinkingView(messages, identity), undefined);
    assert.equal(projectToolCalls(messages, identity), undefined);
  });
});

// -- boundary 2: normal projection ---------------------------------------

describe("boundary: normal projection", () => {
  it("thinking entry text is masked-then-truncated; redacted counted separately", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: "deep thought", signature: "sig" },
        { type: "redacted_thinking", data: "encrypted-blob" },
        { type: "text", text: "final answer" },
      ]),
    ];
    const view = projectThinkingView(messages, identity);
    assert.deepEqual(view, {
      entries: [{ text: "deep thought" }],
      redactedCount: 1,
    });
  });

  it("thinking + toolCalls on the wire (block order across messages preserved)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "do stuff" }]),
      assistant("assistant", [
        { type: "thinking", thinking: "plan", signature: "s" },
        { type: "tool_use", id: "t1", name: "noop", input: { q: 1 } },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "ok" }],
        },
      ]),
      assistant("assistant", [
        { type: "thinking", thinking: "wrap", signature: "s2" },
        { type: "text", text: "done" },
      ]),
    ];
    const thinking = projectThinkingView(messages, identity);
    const toolCalls = projectToolCalls(messages, identity);
    assert.deepEqual(thinking, {
      entries: [{ text: "plan" }, { text: "wrap" }],
      redactedCount: 0,
    });
    assert.deepEqual(toolCalls, [
      {
        id: "t1",
        name: "noop",
        inputPreview: '{"q":1}',
        outputPreview: "ok",
        isError: false,
        truncated: false,
      },
    ]);
  });

  it("tool_result with is_error=true → isError propagated", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "x",
          is_error: true,
          content: [{ type: "text", text: "boom" }],
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    assert.equal(toolCalls?.length, 1);
    assert.equal(toolCalls?.[0]?.isError, true);
    assert.equal(toolCalls?.[0]?.outputPreview, "boom");
  });
});

// -- boundary 3: redacted alone ------------------------------------------

describe("boundary: redacted only (no entries)", () => {
  it("only redacted_thinking → ThinkingView with empty entries, redactedCount=N", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "redacted_thinking", data: "blob1" },
        { type: "redacted_thinking", data: "blob2" },
      ]),
    ];
    const view = projectThinkingView(messages, identity);
    assert.deepEqual(view, { entries: [], redactedCount: 2 });
  });
});

// -- boundary 4: overflow / truncation ----------------------------------

describe("boundary: overflow — truncation caps", () => {
  const overflowText = "x".repeat(MAX_THINKING_TEXT_CHARS + 100);
  const overflowInput = { pad: "y".repeat(MAX_TOOL_INPUT_PREVIEW_CHARS + 50) };
  const overflowOutput = "z".repeat(MAX_TOOL_OUTPUT_PREVIEW_CHARS + 50);

  it("thinking text truncated at MAX_THINKING_TEXT_CHARS with ellipsis", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: overflowText, signature: "s" },
      ]),
    ];
    const view = projectThinkingView(messages, identity);
    const text = view?.entries[0]?.text;
    assert.ok(text !== undefined);
    assert.equal(text.length, MAX_THINKING_TEXT_CHARS + 1); // + "…"
    assert.ok(text.endsWith("…"));
  });

  it("inputPreview truncated at MAX_TOOL_INPUT_PREVIEW_CHARS", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: overflowInput },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    const preview = toolCalls?.[0]?.inputPreview;
    assert.ok(preview !== undefined);
    assert.equal(preview.length, MAX_TOOL_INPUT_PREVIEW_CHARS + 1);
    assert.ok(preview.endsWith("…"));
  });

  it("outputPreview truncated and truncated=true when over cap", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "x",
          content: [{ type: "text", text: overflowOutput }],
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    const entry = toolCalls?.[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.truncated, true);
    assert.equal(entry.outputPreview.length, MAX_TOOL_OUTPUT_PREVIEW_CHARS + 1);
    assert.ok(entry.outputPreview.endsWith("…"));
  });

  it("short output is NOT truncated (truncated=false)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "x",
          content: [{ type: "text", text: "tiny" }],
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    assert.equal(toolCalls?.[0]?.truncated, false);
    assert.equal(toolCalls?.[0]?.outputPreview, "tiny");
  });
});

// -- boundary 5: mask applied before truncation --------------------------

describe("boundary: mask", () => {
  it("mask applied to thinking text before truncation", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        {
          type: "thinking",
          thinking: "secret-token-alpha-plan",
          signature: "s",
        },
      ]),
    ];
    const view = projectThinkingView(messages, maskSecret("secret-token"));
    assert.equal(view?.entries[0]?.text, "***-alpha-plan");
  });

  it("mask applied to outputPreview", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "x",
          content: [{ type: "text", text: "here is secret-token" }],
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, maskSecret("secret-token"));
    assert.equal(toolCalls?.[0]?.outputPreview, "here is ***");
  });

  it("mask applied to inputPreview", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        {
          type: "tool_use",
          id: "x",
          name: "noop",
          input: { token: "secret-token" },
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, maskSecret("secret-token"));
    assert.equal(toolCalls?.[0]?.inputPreview, '{"token":"***"}');
  });
});

// -- boundary 6: tool_result missing -------------------------------------

describe("boundary: missing tool_result", () => {
  it('tool_use without matching tool_result → outputPreview="", isError=false, truncated=false', () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    assert.deepEqual(toolCalls, [
      {
        id: "x",
        name: "noop",
        inputPreview: "{}",
        outputPreview: "",
        isError: false,
        truncated: false,
      },
    ]);
  });
});

// -- boundary 7: empty thinking text skipped ----------------------------

describe("boundary: empty thinking text", () => {
  it("thinking block with empty text → no entry; if no other thinking → undefined", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "hi" },
      ]),
    ];
    assert.equal(projectThinkingView(messages, identity), undefined);
  });

  it("empty thinking + a redacted_thinking → ThinkingView (entries empty, redactedCount>0)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "redacted_thinking", data: "blob" },
      ]),
    ];
    const view = projectThinkingView(messages, identity);
    assert.deepEqual(view, { entries: [], redactedCount: 1 });
  });
});

// -- boundary 8: block order preservation -------------------------------

describe("boundary: block order across multiple assistant turns", () => {
  it("entries and toolCalls preserve order across multiple assistant messages", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: "first", signature: "s" },
      ]),
      assistant("assistant", [
        { type: "tool_use", id: "t1", name: "a", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "r1" }],
        },
      ]),
      assistant("assistant", [
        { type: "thinking", thinking: "second", signature: "s" },
      ]),
      assistant("assistant", [
        { type: "tool_use", id: "t2", name: "b", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: "r2" }],
        },
      ]),
    ];
    const thinking = projectThinkingView(messages, identity);
    const toolCalls = projectToolCalls(messages, identity);
    assert.deepEqual(
      thinking?.entries.map((e) => e.text),
      ["first", "second"]
    );
    assert.deepEqual(
      toolCalls?.map((c) => c.id),
      ["t1", "t2"]
    );
  });
});

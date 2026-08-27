/**
 * auto-memory T4: auto-memory-wire.ts tests.
 *
 * Spec: specs/auto-memory.md D1/D2; ADR-0031 Decision 1/2. This is the seam
 * that keeps `src/harness/memory/` free of ModelAdapter knowledge, so what is
 * pinned here is the shape of the bridge, not memory policy.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  TRANSCRIPT_CHAR_CAP,
  TRANSCRIPT_MESSAGE_CAP,
  createAdapterExtractLlm,
  renderTranscript,
} from "../../src/harness/auto-memory-wire.ts";
import type {
  AnthropicNativeMessage,
  ModelAdapter,
} from "../../src/harness/model-adapter/types.ts";
import { assistantResult } from "../cli/_fixtures.ts";

const text = (
  role: "user" | "assistant",
  body: string
): AnthropicNativeMessage => ({
  role,
  content: [{ type: "text", text: body }],
});

// -- renderTranscript --------------------------------------------------------

describe("renderTranscript", () => {
  it("renders role-prefixed text lines", () => {
    const out = renderTranscript([
      text("user", "which entry point is thread-safe?"),
      text("assistant", "bar() is."),
    ]);
    assert.equal(
      out,
      "user: which entry point is thread-safe?\n\nassistant: bar() is."
    );
  });

  it("drops tool_use and tool_result blocks", () => {
    const out = renderTranscript([
      text("user", "run it"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      text("assistant", "done"),
    ]);
    assert.equal(out, "user: run it\n\nassistant: done");
  });

  // empty boundary
  it("returns an empty string for no messages", () => {
    assert.equal(renderTranscript([]), "");
  });

  it("returns an empty string when every message is non-text", () => {
    assert.equal(
      renderTranscript([
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
        },
      ]),
      ""
    );
  });

  // overflow boundary
  it("keeps only the trailing messages past the message cap", () => {
    const many = Array.from({ length: TRANSCRIPT_MESSAGE_CAP + 10 }, (_, i) =>
      text("user", `line ${i}`)
    );
    const out = renderTranscript(many);
    assert.ok(!out.includes("line 0"), "the oldest message must be dropped");
    assert.ok(out.includes(`line ${TRANSCRIPT_MESSAGE_CAP + 9}`));
  });

  it("caps the rendered length and keeps the tail", () => {
    const out = renderTranscript([
      text("user", "x".repeat(TRANSCRIPT_CHAR_CAP)),
      text("assistant", "the newest line"),
    ]);
    assert.ok(out.length <= TRANSCRIPT_CHAR_CAP, `got ${out.length}`);
    assert.ok(out.endsWith("the newest line"));
  });
});

// -- createAdapterExtractLlm -------------------------------------------------

describe("createAdapterExtractLlm", () => {
  it("sends the prompt as a single user message and returns the assistant text", async () => {
    let seen: unknown;
    const adapter: ModelAdapter = {
      step: async (state) => {
        seen = state;
        return assistantResult({ texts: ["[]"] });
      },
    };
    const out = await createAdapterExtractLlm(adapter).complete("extract this");
    assert.equal(out, "[]");
    const state = seen as { messages: AnthropicNativeMessage[] };
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0]!.role, "user");
    assert.deepEqual(state.messages[0]!.content, [
      { type: "text", text: "extract this" },
    ]);
  });

  it("offers the model no tools — extraction must not reach the filesystem", async () => {
    let request: unknown;
    const adapter: ModelAdapter = {
      step: async (_state, req) => {
        request = req;
        return assistantResult({ texts: ["[]"] });
      },
    };
    await createAdapterExtractLlm(adapter).complete("extract this");
    assert.equal((request as { tools?: unknown }).tools, undefined);
  });

  it("joins multiple text blocks", async () => {
    const adapter: ModelAdapter = {
      step: async () => assistantResult({ texts: ["[", "]"] }),
    };
    assert.equal(await createAdapterExtractLlm(adapter).complete("p"), "[\n]");
  });

  it("propagates the abort signal", async () => {
    let seen: AbortSignal | undefined;
    const adapter: ModelAdapter = {
      step: async (_s, _r, signal) => {
        seen = signal;
        return assistantResult({ texts: ["[]"] });
      },
    };
    const controller = new AbortController();
    await createAdapterExtractLlm(adapter).complete("p", controller.signal);
    assert.equal(seen, controller.signal);
  });
});

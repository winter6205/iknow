/**
 * Ordered user content (text + image blocks) on the harness side: the adapter
 * encoder for a block payload, the loop engine's accepted user message, and the
 * turn-boundary rule that decides whether an image-only message starts a turn.
 *
 * The image block shape is the Anthropic base64 source shape; nothing here
 * decodes bytes, so every assertion reads the payload back verbatim.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  encodeUserContent,
  encodeUserText,
} from "../../src/harness/model-adapter/anthropic-adapter.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { isTurnQuery, messageText } from "../../src/harness/turn-boundary.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../src/harness/model-adapter/types.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createSecretRegistry } from "../../src/harness/secret-roundtrip/index.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import {
  imageBlock,
  secretShapedBase64,
  textBlock,
} from "../fixtures/image-payloads.ts";

function base64Of(block: AnthropicContentBlock): string {
  if (block.type !== "image") throw new Error("not an image block");
  return block.source.data;
}

function makeEngineDeps() {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  const adapter = createStubModel({
    responses: [assistantResult({ texts: ["ok"] })],
  });
  return { adapter, executor, registry, maxTurns: 5 };
}

describe("adapter: encodeUserContent", () => {
  it("carries the blocks in the given order, text and image interleaved", () => {
    const blocks = [textBlock("before"), imageBlock(), textBlock("after")];
    const message = encodeUserContent(blocks);
    assert.equal(message.role, "user");
    assert.deepEqual(
      message.content.map((b) => b.type),
      ["text", "image", "text"]
    );
    assert.deepEqual(message.content[1], imageBlock());
  });

  it("keeps encodeUserText's single-text-block shape for text-only input", () => {
    assert.deepEqual(
      encodeUserContent([textBlock("hi")]),
      encodeUserText("hi")
    );
  });
});

describe("loop engine: host-encoded user message", () => {
  it("appends the provided message verbatim and never masks image data", async () => {
    const deps = makeEngineDeps();
    const secretRegistry = createSecretRegistry();
    const provided: AnthropicNativeMessage = {
      role: "user",
      content: [
        textBlock("already masked by the host"),
        imageBlock(secretShapedBase64("A")),
      ],
    };
    const { result } = await run(
      "already masked by the host",
      { ...deps, secretRegistry, secretsMode: "roundtrip" },
      undefined,
      { userMessage: provided }
    );
    const accepted = result.messages.find((m) =>
      m.content.some((b) => b.type === "image")
    );
    assert.ok(accepted, "the provided user message must enter the history");
    assert.deepEqual(accepted.content, provided.content);
    assert.equal(base64Of(accepted.content[1]!), secretShapedBase64("A"));
    assert.equal(secretRegistry.size, 0);
  });

  it("a text-only run keeps taking the encodeUserText path", async () => {
    const deps = makeEngineDeps();
    let encoded = 0;
    const adapter = {
      ...deps.adapter,
      encodeUserText: (text: string) => {
        encoded += 1;
        return deps.adapter.encodeUserText(text);
      },
    };
    const { result } = await run("plain", { ...deps, adapter }, undefined, {});
    assert.equal(encoded, 1);
    assert.equal(messageText(result.messages[0]!), "plain");
  });
});

describe("turn boundary: image-only user message", () => {
  it("counts an image-only user message as the query that starts a turn", () => {
    const imageOnly: AnthropicNativeMessage = {
      role: "user",
      content: [imageBlock()],
    };
    assert.equal(messageText(imageOnly), "");
    assert.equal(isTurnQuery(imageOnly), true);
  });

  it("still excludes a tool_result continuation", () => {
    const toolResultOnly: AnthropicNativeMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [textBlock("done")],
        },
      ],
    };
    assert.equal(isTurnQuery(toolResultOnly), false);
  });
});

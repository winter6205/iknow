/**
 * read-image-vision SC7: an SDK image block nested inside
 * `tool_result.content` must survive sanitize → save → load and the
 * `buildMessageParams` assembly untouched.
 *
 * The `tool_result` branch of `isValidContentBlock` (schema.ts) checks only
 * `tool_use_id` + `"content" in block` — it deliberately does NOT recurse
 * into `content`. These tests pin that non-recursion as the contract: a
 * future tightening of the validator must fail here instead of silently
 * stripping pixels from vision history.
 *
 * Store tests use a real SessionStore on a temp dir with fresh
 * conversationIds (project test rule: no mocked store, no pre-seeded files).
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  sanitizeSessionFile,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import { buildMessageParams } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";
import type { RealAnthropicAdapterOptions } from "../../../src/harness/model-adapter/anthropic-adapter.ts";

// -- fixtures ----------------------------------------------------------------

/** Image block shape as produced by src/harness/aci/tools/read-image.ts (T1). */
const IMAGE_BLOCK = {
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUg==",
  },
} as const;

const toolResultBlock = (
  content: unknown
): AnthropicContentBlock => ({
  type: "tool_result",
  tool_use_id: "tu_read_1",
  content,
});

/** The three-message shape the executor writes after one successful
 *  read_image turn: user text → assistant tool_use → user tool_result. */
const messagesWithNestedImage = (content: unknown): AnthropicNativeMessage[] => [
  { role: "user", content: [{ type: "text", text: "看下这张图" }] },
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "tu_read_1", name: "read_image", input: { path: "/tmp/a.png" } },
    ],
  },
  { role: "user", content: [toolResultBlock(content)] },
];

/** Discriminated-union narrowing (assert.fail is never-returning for TS). */
function toolResultOf(block: AnthropicContentBlock): {
  readonly tool_use_id: string;
  readonly content: unknown;
} {
  if (block.type !== "tool_result") {
    assert.fail(`expected tool_result block, got ${block.type}`);
  }
  return block;
}

const extractNestedImage = (
  messages: ReadonlyArray<AnthropicNativeMessage>
): { block: AnthropicContentBlock; nested: Record<string, unknown> } => {
  const toolResultMsg = messages[2]!;
  const block = toolResultMsg.content[0]!;
  assert.equal(block.type, "tool_result");
  const contentArr = toolResultOf(block).content as ReadonlyArray<
    Record<string, unknown>
  >;
  assert.ok(Array.isArray(contentArr), "tool_result.content must stay an array");
  const nested = contentArr.find((b) => b["type"] === "image")!;
  assert.ok(nested, "an image block must be present in tool_result.content");
  return { block, nested };
};

// -- SC7 A: sanitizeSessionFile keeps the nested image block -----------------

describe("SC7 A: sanitizeSessionFile preserves image blocks nested in tool_result.content", () => {
  const v1File = (
    messages: ReadonlyArray<AnthropicNativeMessage>
  ): Record<string, unknown> => ({
    schemaVersion: 1,
    conversation_id: "conv-nest-sanitize",
    messages,
    jsonMode: false,
    turnCount: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("content = [image] survives sanitize unchanged", () => {
    const messages = messagesWithNestedImage([IMAGE_BLOCK]);
    const sanitized = sanitizeSessionFile(v1File(messages));
    assert.deepEqual(
      extractNestedImage(sanitized.messages).nested,
      IMAGE_BLOCK
    );
    // The whole tool_result block (incl. tool_use_id) must be byte-equal.
    assert.deepEqual(
      sanitized.messages[2]!.content[0],
      messages[2]!.content[0]
    );
  });

  it("content = [image, text] survives sanitize with both siblings intact", () => {
    const content = [
      IMAGE_BLOCK,
      { type: "text", text: "read_image: /tmp/a.png" },
    ];
    const messages = messagesWithNestedImage(content);
    const sanitized = sanitizeSessionFile(v1File(messages));
    const toolResultMsg = sanitized.messages[2]!;
    assert.deepEqual(
      toolResultOf(toolResultMsg.content[0]!).content,
      content,
      "nested content array must round-trip element-for-element"
    );
  });
});

// -- SC7 B/C: real store save → load → buildMessageParams ---------------------

describe("SC7 B/C: SessionStore save→load round trip keeps the nested image; buildMessageParams does not strip it", () => {
  let store: SessionStore;
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-nested-image-"));
    store = new SessionStore(baseDir, process.cwd());
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const sampleFile = (
    id: string,
    messages: ReadonlyArray<AnthropicNativeMessage>
  ): SessionFileV1 => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "vision round trip",
    cwd: "/tmp/test",
    sanitized_at: new Date().toISOString(),
    messages,
    jsonMode: false,
    turnCount: 1,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  });

  it("save → load: media_type/data stay field-equal and no closeout backfill fires", async () => {
    const id = "conv-nested-image-rt"; // fresh conversationId, no pre-seeded file
    const messages = messagesWithNestedImage([IMAGE_BLOCK]);
    await store.save({ id, file: sampleFile(id, messages) });
    const loaded = await store.load(id);

    // The answered tool_use must NOT be rewritten by closeoutOrphanToolUses:
    // same length, same order (element 2 is still the tool_result message).
    assert.equal(loaded.messages.length, 3);
    const { nested } = extractNestedImage(loaded.messages);
    const source = nested["source"] as Record<string, unknown>;
    assert.equal(nested["type"], "image");
    assert.equal(source["type"], "base64");
    assert.equal(source["media_type"], "image/png");
    assert.equal(source["data"], "iVBORw0KGgoAAAANSUhEUg==");
    assert.deepEqual(nested, IMAGE_BLOCK);
  });

  it("loaded messages through buildMessageParams still carry the image block", async () => {
    const id = "conv-nested-image-wire";
    await store.save({
      id,
      file: sampleFile(
        id,
        messagesWithNestedImage([
          IMAGE_BLOCK,
          { type: "text", text: "read_image: /tmp/a.png" },
        ])
      ),
    });
    const loaded = await store.load(id);

    const opts: RealAnthropicAdapterOptions = {
      // client is only referenced by step(), never by buildMessageParams.
      client: {} as never,
      model: "claude-test-model",
      maxTokens: 256,
    };
    const state: LoopState = { messages: loaded.messages, turnCount: 1 };
    const params = buildMessageParams(opts, state, {});

    const wireToolResultMsg = params.messages[2] as unknown as AnthropicNativeMessage;
    assert.deepEqual(
      toolResultOf(wireToolResultMsg.content[0]!).content,
      [IMAGE_BLOCK, { type: "text", text: "read_image: /tmp/a.png" }],
      "buildMessageParams must pass tool_result.content through unchanged"
    );
  });
});

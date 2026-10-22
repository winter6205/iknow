/**
 * A user-authored top-level `image` block is legal in an accepted user message
 * record.
 *
 * `isValidContentBlock` (schema.ts) rejected every top-level block type outside
 * its whitelist, so an image-bearing user message failed sanitize with
 * `schema_invalid "messages"`. The image arm keeps the `redacted_thinking`
 * posture (opaque payload stored verbatim, never rewritten) and fails closed on
 * a malformed source, because authoritative history is immutable — sanitize
 * repairs nothing.
 *
 * Store cases use a real SessionStore on a fresh temp dir with fresh
 * conversationIds (project test rule: no mocked store, no repository `data/`).
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
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";
import {
  MAX_IMAGE_BASE64_CHARS,
  PNG_BASE64,
} from "../../fixtures/image-payloads.ts";

// -- fixtures ----------------------------------------------------------------

const imageBlock = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
  ...overrides,
});

const userMsg = (
  ...blocks: ReadonlyArray<Record<string, unknown>>
): AnthropicNativeMessage =>
  ({
    role: "user",
    content: blocks,
  }) as unknown as AnthropicNativeMessage;

const v1File = (
  messages: ReadonlyArray<AnthropicNativeMessage>
): Record<string, unknown> => ({
  schemaVersion: 1,
  conversation_id: "conv-user-image",
  messages,
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** `sanitizeSessionFile` throws the structured literal, not a bare Error. */
const schemaInvalidField = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (err) {
    const e = err as { kind?: string; field?: string };
    assert.equal(
      e.kind,
      "schema_invalid",
      "rejection must stay schema_invalid"
    );
    return e.field;
  }
};

// -- valid block survives sanitize + the real store ---------------------------

describe("valid top-level image block round-trips", () => {
  it("sanitize keeps the image block byte-identical beside its text sibling", () => {
    const image = imageBlock();
    const messages = [userMsg(image, { type: "text", text: "看下这张图" })];
    const sanitized = sanitizeSessionFile(v1File(messages));
    const stored = sanitized.messages[0]!.content[0] as Record<string, unknown>;
    assert.deepEqual(stored, image);
    assert.deepEqual(sanitized.messages[0]!.content, [
      image,
      { type: "text", text: "看下这张图" },
    ]);
  });

  it("an image-only user message (no text block) is accepted", () => {
    const messages = [userMsg(imageBlock())];
    const sanitized = sanitizeSessionFile(v1File(messages));
    assert.equal(sanitized.messages.length, 1);
    assert.equal(sanitized.messages[0]!.content[0]!.type, "image");
    // No text block → extractTitle has nothing to excerpt; the record still loads.
    assert.equal(sanitized.title, "");
  });

  it("every media_type the read_image classifier can emit is accepted", () => {
    for (const media_type of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ]) {
      const block = imageBlock({
        source: { type: "base64", media_type, data: PNG_BASE64 },
      });
      const sanitized = sanitizeSessionFile(v1File([userMsg(block)]));
      assert.deepEqual(sanitized.messages[0]!.content[0], block, media_type);
    }
  });

  it("the wire raw budget is the cap on the encoded form", () => {
    const atCap = "A".repeat(MAX_IMAGE_BASE64_CHARS);
    const block = imageBlock({
      source: { type: "base64", media_type: "image/png", data: atCap },
    });
    const sanitized = sanitizeSessionFile(v1File([userMsg(block)]));
    assert.deepEqual(sanitized.messages[0]!.content[0], block);
  });
});

describe("SessionStore save → load keeps the authoritative image message", () => {
  let store: SessionStore;
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-user-image-"));
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
    title: "user image",
    cwd: "/tmp/test",
    sanitized_at: new Date().toISOString(),
    messages,
    jsonMode: false,
    turnCount: 1,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  });

  it("a reopened store returns the same image block", async () => {
    const id = "conv-user-image-rt";
    const image = imageBlock();
    const messages = [userMsg(image, { type: "text", text: "describe it" })];
    await store.save({ id, file: sampleFile(id, messages) });

    const reopened = new SessionStore(baseDir, process.cwd());
    const loaded = await reopened.load(id);

    assert.equal(loaded.messages.length, 1);
    assert.deepEqual(loaded.messages[0]!.content, [
      image,
      { type: "text", text: "describe it" },
    ]);
  });
});

// -- malformed blocks are rejected fail-closed --------------------------------

describe("malformed top-level image blocks are rejected", () => {
  const rejectCases: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["missing source", { type: "image" }],
    ["source is null", { type: "image", source: null }],
    ["source is a string", { type: "image", source: PNG_BASE64 }],
    [
      "source.type is url",
      {
        type: "image",
        source: {
          type: "url",
          media_type: "image/png",
          data: PNG_BASE64,
        },
      },
    ],
    [
      "source.type missing",
      { type: "image", source: { media_type: "image/png", data: PNG_BASE64 } },
    ],
    [
      "data is not a string",
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: 1234 },
      },
    ],
    [
      "data is empty",
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "" },
      },
    ],
    [
      "data missing",
      { type: "image", source: { type: "base64", media_type: "image/png" } },
    ],
    [
      "media_type missing",
      { type: "image", source: { type: "base64", data: PNG_BASE64 } },
    ],
    [
      "media_type is application/pdf",
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: PNG_BASE64,
        },
      },
    ],
    [
      "media_type is a bogus image type",
      {
        type: "image",
        source: { type: "base64", media_type: "image/bmp", data: PNG_BASE64 },
      },
    ],
    [
      "media_type is not a string",
      {
        type: "image",
        source: { type: "base64", media_type: 7, data: PNG_BASE64 },
      },
    ],
    [
      "data exceeds the wire raw budget",
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "A".repeat(MAX_IMAGE_BASE64_CHARS + 1),
        },
      },
    ],
  ];

  for (const [label, block] of rejectCases) {
    it(`${label} → schema_invalid "messages"`, () => {
      const field = schemaInvalidField(() =>
        sanitizeSessionFile(v1File([userMsg(block)]))
      );
      assert.equal(field, "messages", `${label} must be rejected`);
    });
  }

  it("a malformed image poisons the whole record, never just the one block", () => {
    const messages = [
      userMsg({ type: "text", text: "fine" }),
      userMsg({ type: "image" }),
    ];
    assert.equal(
      schemaInvalidField(() => sanitizeSessionFile(v1File(messages))),
      "messages"
    );
  });

  // The per-type validators are a keyed roster, so the lookup key itself is a
  // gate: anything that is not a string type must match nothing, including a
  // value whose stringification spells an accepted type.
  it("a non-string type matches no validator, image-shaped payload or not", () => {
    for (const type of [
      ["image"],
      5,
      undefined,
      null,
      { toString: () => "image" },
    ]) {
      const block = imageBlock({ type });
      const field = schemaInvalidField(() =>
        sanitizeSessionFile(v1File([userMsg(block)]))
      );
      assert.equal(
        field,
        "messages",
        `type ${JSON.stringify(type)} must be rejected`
      );
    }
  });
});

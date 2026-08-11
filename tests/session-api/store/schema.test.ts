/**
 * schema.ts direct unit tests (022 SC21 coverage gate + #120 T1 range check).
 *
 * Why a dedicated file: validateSessionFile branches are not fully exercised
 * by session-store.test.ts (which only hits schemaVersion + messages cases
 * via load()). The 6 field-validation branches must each be covered to clear
 * the 80/70 gate. Each invalid field surfaces the field name in the error,
 * which is what hub.ts → http.ts → wire uses to build the schema_invalid body.
 *
 * #120 T1 change: schemaVersion check is now a range (≤ CURRENT accepted →
 * sanitize, > CURRENT rejected) — old strict-equality-to-1 assertion deleted.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  CURRENT_SCHEMA_VERSION,
  isSessionFileV1,
  sanitizeSessionFile,
  validateSessionFile,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import { interpretMessage } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import type {
  Message as SdkMessage,
  ContentBlock,
  ThinkingBlock,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

const valid: SessionFileV1 = {
  schemaVersion: 3,
  conversation_id: "abc",
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  summary: "",
  cwd: "",
  sanitized_at: "2026-01-01T00:00:00.000Z",
  checkpoints: [],
};

// -- happy path --------------------------------------------------------------

describe("validateSessionFile — happy path", () => {
  it("returns null for a fully-valid SessionFileV1 shape", () => {
    assert.equal(validateSessionFile(valid), null);
  });

  it("CURRENT_SCHEMA_VERSION is the canonical v3 literal (3) — checkpoint data layer", () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 3);
    assert.equal(validateSessionFile({ ...valid }), null);
  });

  it("accepts schemaVersion 1 (forward-compat: sanitize fills v2 fields)", () => {
    // v1 file lacks summary/cwd/sanitized_at but passes the range check;
    // sanitizeSessionFile is responsible for filling them on load.
    const v1 = {
      schemaVersion: 1,
      conversation_id: "abc",
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    assert.equal(validateSessionFile(v1), null);
  });
});

// -- range check (#120 T1) ---------------------------------------------------

describe("validateSessionFile — schemaVersion range check (#120)", () => {
  it("accepts schemaVersion 1, 2 and 3 (≤ CURRENT) and rejects anything above", () => {
    assert.equal(validateSessionFile({ ...valid, schemaVersion: 1 }), null);
    assert.equal(validateSessionFile({ ...valid, schemaVersion: 2 }), null);
    assert.equal(validateSessionFile({ ...valid, schemaVersion: 3 }), null);
    assert.equal(
      validateSessionFile({ ...valid, schemaVersion: 4 }),
      "schemaVersion"
    );
    assert.equal(
      validateSessionFile({ ...valid, schemaVersion: 99 }),
      "schemaVersion"
    );
  });
});

// -- v3: checkpoints field (T1 checkpoint data layer) -------------------------

describe("validateSessionFile — v3 checkpoints field", () => {
  it("accepts a valid checkpoints array", () => {
    const file = {
      ...valid,
      checkpoints: [
        {
          turnIndex: 1,
          messagesCount: 2,
          interruptedAt: "2026-08-11T00:00:00.000Z",
          interruptReason: "cancelled",
        },
      ],
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("accepts checkpoints entries with lastUsage (passthrough, no shape gate)", () => {
    const file = {
      ...valid,
      checkpoints: [
        {
          turnIndex: 1,
          messagesCount: 2,
          interruptedAt: "t",
          interruptReason: "timeout",
          lastUsage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
        },
      ],
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("rejects a non-array checkpoints → 'checkpoints'", () => {
    assert.equal(
      validateSessionFile({ ...valid, checkpoints: "oops" }),
      "checkpoints"
    );
    assert.equal(
      validateSessionFile({ ...valid, checkpoints: 42 }),
      "checkpoints"
    );
    assert.equal(
      validateSessionFile({ ...valid, checkpoints: {} }),
      "checkpoints"
    );
  });

  it("rejects a checkpoint with an invalid interruptReason → 'checkpoints'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        checkpoints: [
          {
            turnIndex: 1,
            messagesCount: 2,
            interruptedAt: "t",
            interruptReason: "mystery",
          },
        ],
      }),
      "checkpoints"
    );
  });

  it("rejects a checkpoint missing a required field → 'checkpoints'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        checkpoints: [
          {
            turnIndex: 1,
            messagesCount: 2,
            interruptedAt: "t",
            // interruptReason missing
          },
        ],
      }),
      "checkpoints"
    );
  });

  it("sanitize rejects a malformed checkpoints element (never repairs)", () => {
    assert.throws(
      () =>
        sanitizeSessionFile({
          ...valid,
          checkpoints: [{ turnIndex: "x", messagesCount: 1 }],
        }),
      (err: unknown) =>
        (err as { kind?: string; field?: string }).kind === "schema_invalid" &&
        (err as { kind?: string; field?: string }).field === "checkpoints"
    );
  });
});

// -- root-level guards -------------------------------------------------------

describe("validateSessionFile — root guard", () => {
  it("returns 'root' for null", () => {
    assert.equal(validateSessionFile(null), "root");
  });

  it("returns 'root' for a primitive (non-object)", () => {
    assert.equal(validateSessionFile("a string"), "root");
    assert.equal(validateSessionFile(42), "root");
    assert.equal(validateSessionFile(true), "root");
    assert.equal(validateSessionFile(undefined), "root");
  });
});

// -- per-field invalid branches ---------------------------------------------

describe("validateSessionFile — per-field rejection", () => {
  it("rejects non-number or missing schemaVersion → 'schemaVersion'", () => {
    assert.equal(
      validateSessionFile({ ...valid, schemaVersion: "1" }),
      "schemaVersion"
    );
    // Missing key entirely
    const { schemaVersion: _omit, ...without } = valid;
    assert.equal(validateSessionFile(without), "schemaVersion");
  });

  it("rejects non-string conversation_id → 'conversation_id'", () => {
    assert.equal(
      validateSessionFile({ ...valid, conversation_id: 123 }),
      "conversation_id"
    );
    assert.equal(
      validateSessionFile({ ...valid, conversation_id: null }),
      "conversation_id"
    );
    assert.equal(
      validateSessionFile({ ...valid, conversation_id: true }),
      "conversation_id"
    );
  });

  it("rejects non-array messages → 'messages'", () => {
    assert.equal(
      validateSessionFile({ ...valid, messages: "not-an-array" }),
      "messages"
    );
    assert.equal(validateSessionFile({ ...valid, messages: {} }), "messages");
    assert.equal(validateSessionFile({ ...valid, messages: null }), "messages");
  });

  it("rejects non-boolean jsonMode → 'jsonMode'", () => {
    assert.equal(
      validateSessionFile({ ...valid, jsonMode: "true" }),
      "jsonMode"
    );
    assert.equal(validateSessionFile({ ...valid, jsonMode: 0 }), "jsonMode");
    assert.equal(validateSessionFile({ ...valid, jsonMode: null }), "jsonMode");
  });

  it("rejects non-number turnCount → 'turnCount'", () => {
    assert.equal(
      validateSessionFile({ ...valid, turnCount: "0" }),
      "turnCount"
    );
    assert.equal(
      validateSessionFile({ ...valid, turnCount: null }),
      "turnCount"
    );
    assert.equal(
      validateSessionFile({ ...valid, turnCount: true }),
      "turnCount"
    );
  });

  it("rejects non-string updatedAt → 'updatedAt'", () => {
    assert.equal(
      validateSessionFile({ ...valid, updatedAt: 1234567890 }),
      "updatedAt"
    );
    assert.equal(
      validateSessionFile({ ...valid, updatedAt: null }),
      "updatedAt"
    );
    assert.equal(
      validateSessionFile({ ...valid, updatedAt: true }),
      "updatedAt"
    );
  });
});

// -- type guard companion ----------------------------------------------------

describe("isSessionFileV1 — type guard companion", () => {
  it("returns true when validateSessionFile returns null", () => {
    assert.equal(isSessionFileV1(valid), true);
  });

  it("returns false for any rejected value", () => {
    assert.equal(isSessionFileV1(null), false);
    // schemaVersion above CURRENT (CURRENT is 3 now — checkpoint data layer)
    assert.equal(isSessionFileV1({ ...valid, schemaVersion: 4 }), false);
    assert.equal(isSessionFileV1({ ...valid, turnCount: "x" }), false);
  });
});

// -- T1: thinking / redacted_thinking content blocks -----------------------
// T1: harness retains thinking blocks in the authoritative history; the
// session store must accept them on save and replay them verbatim.

describe("validateSessionFile — content blocks accept thinking (T1)", () => {
  it("accepts a thinking block with thinking + signature", () => {
    const file = {
      ...valid,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "deep thought",
              signature: "sig-1",
            },
          ],
        },
      ],
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("accepts a redacted_thinking block with data", () => {
    const file = {
      ...valid,
      messages: [
        {
          role: "assistant",
          content: [{ type: "redacted_thinking", data: "encrypted-blob" }],
        },
      ],
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("rejects a thinking block missing thinking field → 'messages'", () => {
    const file = {
      ...valid,
      messages: [
        { role: "assistant", content: [{ type: "thinking", signature: "x" }] },
      ],
    };
    assert.throws(
      () => sanitizeSessionFile(file),
      (err: unknown) =>
        (err as { kind?: string; field?: string }).kind === "schema_invalid" &&
        (err as { kind?: string; field?: string }).field === "messages"
    );
  });

  it("rejects a redacted_thinking block missing data field → 'messages'", () => {
    const file = {
      ...valid,
      messages: [
        { role: "assistant", content: [{ type: "redacted_thinking" }] },
      ],
    };
    assert.throws(
      () => sanitizeSessionFile(file),
      (err: unknown) =>
        (err as { kind?: string; field?: string }).kind === "schema_invalid" &&
        (err as { kind?: string; field?: string }).field === "messages"
    );
  });

  it('#191 regression: adapter-normalized thinking block (missing signature → "") passes schema', async () => {
    // deepseek-flash-combo 返回无 signature 的 thinking 块;interpretMessage
    // 归一化为空串后,session store 校验必须通过 — 这是线上 schema_invalid
    // (field=messages) 的回归护栏。
    const sdkResp: SdkMessage = {
      id: "msg_think_nosig_schema",
      type: "message",
      role: "assistant",
      model: "deepseek-flash-combo",
      content: [
        {
          type: "thinking",
          thinking: "We need answer.",
        } as unknown as ThinkingBlock,
        { type: "text", text: "final" } as TextBlock,
      ] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    const result = interpretMessage(sdkResp);

    // 归一化后 signature 存在(空串),可过 schema 校验
    const file = {
      ...valid,
      conversation_id: "schema-regression",
      messages: [result.nativeMessage],
    };
    assert.equal(validateSessionFile(file), null);
    assert.equal(
      (
        result.nativeMessage.content[0] as {
          type: "thinking";
          signature: string;
        }
      ).signature,
      ""
    );
  });
});

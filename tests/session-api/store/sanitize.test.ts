/**
 * #120 T1: sanitizeSessionFile + extractSummary pure-function tests.
 *
 * Spec: specs/120-session-persistence.md (Testing Strategy Unit list, SC 3-7
 * schema half, Boundaries Never). These are pure functions — no IO, so the
 * tests build plain object fixtures and assert on returned values.
 *
 * Failure path: sanitize throws a structured literal object
 * `{ kind: "schema_invalid", field }` (mirrors session-store.ts:48-53
 * `satisfies SessionStoreError` throw style — not a bare Error, not a return).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";
import {
  CURRENT_SCHEMA_VERSION,
  extractSummary,
  sanitizeSessionFile,
} from "../../../src/session-api/store/index.ts";

// -- fixtures ----------------------------------------------------------------

const text = (t: string) => ({ type: "text", text: t }) as const;

const userMsg = (...texts: string[]): AnthropicNativeMessage => ({
  role: "user",
  content: texts.map(text),
});

const toolResultMsg = (): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
});

/** Raw v1 file shape (no summary/cwd/sanitized_at) as JSON.parse would yield. */
const v1File = (opts?: {
  readonly messages?: ReadonlyArray<AnthropicNativeMessage>;
  readonly updatedAt?: string;
}): Record<string, unknown> => ({
  schemaVersion: 1,
  conversation_id: "conv-1",
  messages: opts?.messages ?? [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: opts?.updatedAt ?? "2026-01-01T00:00:00.000Z",
});

/** Complete raw v2 file shape. */
const v2File = (): Record<string, unknown> => ({
  schemaVersion: 2,
  conversation_id: "conv-2",
  messages: [userMsg("hello")],
  jsonMode: true,
  turnCount: 3,
  updatedAt: "2026-02-02T00:00:00.000Z",
  summary: "hello",
  cwd: "/work",
  sanitized_at: "2026-02-02T00:00:00.000Z",
});

/** Validator: throw must be { kind: "schema_invalid", field: <expected> }. */
const isSchemaInvalid = (field: string) => (e: unknown) => {
  if (e === null || typeof e !== "object") return false;
  const obj = e as Record<string, unknown>;
  return obj.kind === "schema_invalid" && obj.field === field;
};

// -- extractSummary ----------------------------------------------------------

describe("extractSummary", () => {
  it("takes the first text block of the first user message with a text block", () => {
    assert.equal(extractSummary([userMsg("what is iknow")]), "what is iknow");
  });

  it("takes only the first text block when a user message has several", () => {
    assert.equal(
      extractSummary([userMsg("first part", "second part")]),
      "first part"
    );
  });

  it("skips user messages that carry only tool_result blocks", () => {
    assert.equal(
      extractSummary([toolResultMsg(), userMsg("real question")]),
      "real question"
    );
  });

  it("does not take text from assistant messages even when they come first", () => {
    const assistant: AnthropicNativeMessage = {
      role: "assistant",
      content: [text("assistant speaks first")],
    };
    assert.equal(extractSummary([assistant]), "");
    assert.equal(
      extractSummary([assistant, userMsg("user asks")]),
      "user asks"
    );
  });

  it("returns '' for empty messages", () => {
    assert.equal(extractSummary([]), "");
  });

  it("truncates to 80 characters after trimming", () => {
    const long = "x".repeat(200);
    const out = extractSummary([userMsg(long)]);
    assert.equal(out.length, 80);
    assert.equal(out, "x".repeat(80));
  });

  it("strips leading and trailing whitespace before truncating", () => {
    assert.equal(
      extractSummary([userMsg("  padded question  ")]),
      "padded question"
    );
  });
});

// -- sanitizeSessionFile — v1 input backfill --------------------------------

describe("sanitizeSessionFile — v1 input backfill", () => {
  it("fills summary from extractSummary(messages)", () => {
    const out = sanitizeSessionFile(
      v1File({ messages: [userMsg("summarize me")] })
    );
    assert.equal(out.summary, "summarize me");
    assert.equal(out.schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it("fills cwd with '' and sanitized_at with the file's own updatedAt", () => {
    const out = sanitizeSessionFile(
      v1File({ updatedAt: "2031-05-05T05:05:05.000Z" })
    );
    assert.equal(out.cwd, "");
    assert.equal(out.sanitized_at, "2031-05-05T05:05:05.000Z");
  });
});

// -- sanitizeSessionFile — unknown-field preservation (v1 and v2 inputs) ----

describe("sanitizeSessionFile — unknown top-level fields are preserved", () => {
  it("keeps unknown fields on a schemaVersion 1 file", () => {
    const out = sanitizeSessionFile({
      ...v1File(),
      future_flag: true,
    }) as unknown as Record<string, unknown>;
    assert.equal(out["future_flag"], true);
  });

  it("keeps unknown fields on a schemaVersion 2 file", () => {
    const out = sanitizeSessionFile({
      ...v2File(),
      next_field: { nested: 1 },
    }) as unknown as Record<string, unknown>;
    assert.deepEqual(out["next_field"], { nested: 1 });
  });
});

// -- sanitizeSessionFile — reject-first ordering ----------------------------

describe("sanitizeSessionFile — reject-first ordering", () => {
  it("rejects schemaVersion above CURRENT before any field preservation", () => {
    // Future-version file with unknown fields + bad messages: the version
    // check must win, never entering the field-preservation branch.
    assert.throws(
      () =>
        sanitizeSessionFile({
          ...v2File(),
          schemaVersion: 3,
          future_field: 1,
          messages: [{ role: "martian", content: [] }],
        }),
      isSchemaInvalid("schemaVersion")
    );
  });
});

// -- sanitizeSessionFile — structural rejection (never repairs) -------------

describe("sanitizeSessionFile — structural rejection", () => {
  it("rejects a non-object root → 'root'", () => {
    for (const bad of [null, "a string", 42, undefined]) {
      assert.throws(
        () => sanitizeSessionFile(bad),
        isSchemaInvalid("root"),
        `must reject ${JSON.stringify(bad)} as root`
      );
    }
  });

  it("rejects a missing schemaVersion key → 'schemaVersion'", () => {
    const { schemaVersion: _omit, ...rest } = v1File();
    assert.throws(
      () => sanitizeSessionFile(rest),
      isSchemaInvalid("schemaVersion")
    );
  });

  it("rejects a message with an out-of-range role → 'messages'", () => {
    assert.throws(
      () =>
        sanitizeSessionFile({
          ...v1File(),
          messages: [{ role: "system", content: [text("x")] }],
        }),
      isSchemaInvalid("messages")
    );
  });

  it("rejects a message whose content is not an array → 'messages'", () => {
    assert.throws(
      () =>
        sanitizeSessionFile({
          ...v1File(),
          messages: [{ role: "user", content: "just a string" }],
        }),
      isSchemaInvalid("messages")
    );
  });

  it("rejects a message with an illegal block shape → 'messages'", () => {
    const cases: unknown[] = [
      [{ type: "unknown" }],
      [{ type: "text" }], // text block without text field
      [{ type: "tool_use", id: "tu_1", name: "echo" }], // missing input
      [{ type: "tool_result" }], // missing tool_use_id + content
      ["not-a-block"],
      [null],
    ];
    for (const content of cases) {
      assert.throws(
        () =>
          sanitizeSessionFile({
            ...v1File(),
            messages: [{ role: "user", content }],
          }),
        isSchemaInvalid("messages"),
        `content ${JSON.stringify(content)} must be rejected`
      );
    }
  });
});

// -- sanitizeSessionFile — complete v2 passes through -----------------------

describe("sanitizeSessionFile — schemaVersion 2 complete file", () => {
  it("passes through with every field equal to the input", () => {
    const input = v2File();
    const out = sanitizeSessionFile(input);
    assert.deepEqual(out, input);
  });
});

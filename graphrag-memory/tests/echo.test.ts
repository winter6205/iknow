import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { echoHandler, EchoInputSchema } from "../src/tools/echo.ts";

describe("EchoInputSchema", () => {
  it("accepts a non-empty message", () => {
    const result = EchoInputSchema.safeParse({ message: "hello" });
    assert.equal(result.success, true);
  });

  it("rejects an empty message", () => {
    const result = EchoInputSchema.safeParse({ message: "" });
    assert.equal(result.success, false);
  });

  it("rejects a missing message", () => {
    const result = EchoInputSchema.safeParse({});
    assert.equal(result.success, false);
  });

  it("rejects a non-string message", () => {
    const result = EchoInputSchema.safeParse({ message: 42 });
    assert.equal(result.success, false);
  });
});

describe("echoHandler", () => {
  it("returns the message as text content", () => {
    const result = echoHandler({ message: "hello" });
    assert.deepEqual(result, {
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("preserves unicode and special characters", () => {
    const msg = "中文 🚀 \n  spaces  ";
    const result = echoHandler({ message: msg });
    assert.deepEqual(result, {
      content: [{ type: "text", text: msg }],
    });
  });

  it("does not mutate or trim the input", () => {
    const original = "  padded  ";
    const result = echoHandler({ message: original });
    assert.equal(result.content[0]?.text, original);
  });
});

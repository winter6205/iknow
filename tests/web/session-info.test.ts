import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { formatSessionInfo } from "../../web/src/lib/session-info.ts";

describe("formatSessionInfo", () => {
  it("含 conversation_id / turnCount / thinking 行", () => {
    const text = formatSessionInfo({
      conversationId: "abc",
      turnCount: 2,
      jsonMode: false,
      phase: "ready",
      contextWindow: 200000,
      lastUsage: null,
      thinkingEnabled: false,
      effort: "",
    });
    assert.ok(text.includes("conversation_id: abc"));
    assert.ok(text.includes("turnCount: 2"));
    assert.ok(text.includes("thinking: off"));
    assert.ok(text.includes("tokens: —"));
  });
});

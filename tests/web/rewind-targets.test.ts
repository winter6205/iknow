/**
 * Web rewind anchors share the GET rewind-targets data model (head event id) with the TUI.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { WebRewindTarget } from "../../web/src/lib/rewind-targets.ts";

describe("WebRewindTarget", () => {
  it("锚点以 head 标识，不再使用 keepTurns", () => {
    const t: WebRewindTarget = {
      head: null,
      userMessageText: "hello",
      fullText: "hello",
      anchoredAt: "",
      fillInput: true,
      anchorTurnIndex: 0,
    };
    assert.equal(t.head, null);
    assert.equal(t.userMessageText, "hello");
  });
});

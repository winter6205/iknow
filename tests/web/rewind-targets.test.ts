/**
 * Web rewind 锚点与 TUI 共用 GET rewind-targets 数据模型（head 事件 id）。
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

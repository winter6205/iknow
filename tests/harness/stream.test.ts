/**
 * T2 (#175): HarnessStreamEvent 判别联合契约 SSOT (src/harness/stream.ts)。
 *
 * D1 最小集 (plans/harness-streaming.md §2):
 *   - text_delta / tool_call_start 两种事件;
 *   - 留位不发 thinking_delta / input_json_delta (v1 不承诺)。
 *
 * 本文件只验契约形状:判别字段 type 收窄后,event-shape 字段的访问编译期正确。
 * 端到端 streaming 行为归 T3/T4 测。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";

describe("HarnessStreamEvent contract (D1 minimal set)", () => {
  it("text_delta event carries text field and discriminates on type", () => {
    const e: HarnessStreamEvent = { type: "text_delta", text: "hello" };
    assert.equal(e.type, "text_delta");
    assert.equal(e.text, "hello");
  });

  it("tool_call_start event carries name field and discriminates on type", () => {
    const e: HarnessStreamEvent = { type: "tool_call_start", name: "echo" };
    assert.equal(e.type, "tool_call_start");
    assert.equal(e.name, "echo");
  });

  it("discriminated union narrows text_delta to its text payload", () => {
    const events: HarnessStreamEvent[] = [
      { type: "text_delta", text: "a" },
      { type: "tool_call_start", name: "echo" },
      { type: "text_delta", text: "b" },
    ];
    const textPieces: string[] = [];
    for (const e of events) {
      if (e.type === "text_delta") {
        // 编译期正确:窄化后只有 text 字段,没有 name
        textPieces.push(e.text);
      }
    }
    assert.deepEqual(textPieces, ["a", "b"]);
  });

  it("discriminated union narrows tool_call_start to its name payload", () => {
    const events: HarnessStreamEvent[] = [
      { type: "tool_call_start", name: "echo" },
      { type: "text_delta", text: "x" },
      { type: "tool_call_start", name: "get_time" },
    ];
    const names: string[] = [];
    for (const e of events) {
      if (e.type === "tool_call_start") {
        // 编译期正确:窄化后只有 name 字段,没有 text
        names.push(e.name);
      }
    }
    assert.deepEqual(names, ["echo", "get_time"]);
  });
});

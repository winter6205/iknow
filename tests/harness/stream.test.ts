/**
 * T2 (#175): HarnessStreamEvent 判别联合契约 SSOT (src/harness/stream.ts)。
 *
 * D1 最小集 (plans/harness-streaming.md §2) + 阶段扩展:
 *   - text_delta / tool_call_start 两种事件;
 *   - 阶段二 (plans/tui-stream-phase2.md): thinking_delta / tool_call_start.id;
 *   - T1 (plans/tui-render-optimization.md): tool_input_delta — tool input 增量
 *     流逐段 emit (增量只服务展示层,权威 input 仍由 finalMessage() 一次性交付)。
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

  it("tool_call_start event carries name + id fields and discriminates on type", () => {
    const e: HarnessStreamEvent = {
      type: "tool_call_start",
      name: "echo",
      id: "toolu_1",
    };
    assert.equal(e.type, "tool_call_start");
    assert.equal(e.name, "echo");
    assert.equal(e.id, "toolu_1");
  });

  it("thinking_delta event carries text field and discriminates on type", () => {
    const e: HarnessStreamEvent = { type: "thinking_delta", text: "思考中…" };
    assert.equal(e.type, "thinking_delta");
    assert.equal(e.text, "思考中…");
  });

  it("tool_input_delta event carries id + partialJson fields and discriminates on type", () => {
    const e: HarnessStreamEvent = {
      type: "tool_input_delta",
      id: "toolu_1",
      partialJson: '{"value":"x"}',
    };
    assert.equal(e.type, "tool_input_delta");
    assert.equal(e.id, "toolu_1");
    assert.equal(e.partialJson, '{"value":"x"}');
  });

  it("discriminated union narrows text_delta to its text payload", () => {
    const events: HarnessStreamEvent[] = [
      { type: "text_delta", text: "a" },
      { type: "tool_call_start", name: "echo", id: "toolu_1" },
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

  it("discriminated union narrows tool_call_start to its name + id payload", () => {
    const events: HarnessStreamEvent[] = [
      { type: "tool_call_start", name: "echo", id: "toolu_1" },
      { type: "text_delta", text: "x" },
      { type: "tool_call_start", name: "get_time", id: "toolu_2" },
    ];
    const names: string[] = [];
    const ids: string[] = [];
    for (const e of events) {
      if (e.type === "tool_call_start") {
        // 编译期正确:窄化后同时持有 name + id
        names.push(e.name);
        ids.push(e.id);
      }
    }
    assert.deepEqual(names, ["echo", "get_time"]);
    assert.deepEqual(ids, ["toolu_1", "toolu_2"]);
  });

  it("discriminated union narrows tool_input_delta to its id + partialJson payload", () => {
    const events: HarnessStreamEvent[] = [
      { type: "tool_call_start", name: "echo", id: "toolu_1" },
      { type: "tool_input_delta", id: "toolu_1", partialJson: '{"v' },
      { type: "text_delta", text: "x" },
      { type: "tool_input_delta", id: "toolu_1", partialJson: 'alue":"y"}' },
    ];
    const pieces: string[] = [];
    const ids: string[] = [];
    for (const e of events) {
      if (e.type === "tool_input_delta") {
        // 编译期正确:窄化后同时持有 id + partialJson,没有 text/name
        ids.push(e.id);
        pieces.push(e.partialJson);
      }
    }
    assert.deepEqual(ids, ["toolu_1", "toolu_1"]);
    assert.deepEqual(pieces, ['{"v', 'alue":"y"}']);
  });
});

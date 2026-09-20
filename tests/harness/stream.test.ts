/**
 * HarnessStreamEvent discriminated-union contract SSOT (src/harness/stream.ts).
 *
 * Minimal set + phased extensions:
 *   - text_delta / tool_call_start events;
 *   - thinking_delta / tool_call_start.id (stream phase 2);
 *   - tool_input_delta — tool-input increments emitted segment by segment
 *     (increments serve the display layer only; the authoritative input is
 *     still delivered in full by finalMessage()).
 *
 * This file verifies the contract shape only: after narrowing on the
 * discriminant `type`, field access per event shape is compile-time correct.
 * End-to-end streaming behavior is covered by other tests.
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
        // Compile-time correct: after narrowing only the text field exists, no name
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
        // Compile-time correct: after narrowing both name + id are held
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
        // Compile-time correct: after narrowing both id + partialJson are held, no text/name
        ids.push(e.id);
        pieces.push(e.partialJson);
      }
    }
    assert.deepEqual(ids, ["toolu_1", "toolu_1"]);
    assert.deepEqual(pieces, ['{"v', 'alue":"y"}']);
  });

  it("graph_progress event carries snapshot or null and discriminates on type", () => {
    const live: HarnessStreamEvent = {
      type: "graph_progress",
      snapshot: {
        waveIndex: 0,
        nodes: [{ id: "a", deps: [], status: "running" }],
      },
    };
    const cleared: HarnessStreamEvent = {
      type: "graph_progress",
      snapshot: null,
    };
    assert.equal(live.type, "graph_progress");
    assert.equal(live.snapshot?.nodes[0]?.id, "a");
    assert.equal(cleared.snapshot, null);
  });
});

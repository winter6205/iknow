/**
 * #179 T6 (#147 D0/D3) — chat 增量渲染接缝。
 *
 * Three guarantees, driven through the real harness stub path (no TTY needed):
 *   1. `processChatLine` forwards its optional `onStream` to `run()`, so a
 *      streaming adapter (stub-model `streamEventsByStep` seam) delivers the
 *      complete event sequence to the chat host.
 *   2. `createStreamPreviewSink` renders text_delta increments + tool_call_start
 *      hints through an injected writer (the TTY spinner-replacement seam).
 *   3. When `onStream` is absent (the `runPiped` path always, and
 *      `runInteractive` when `process.stderr.isTTY` is false), the rendered
 *      output is unchanged — this is the structural pipe/non-TTY regression
 *      guard.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  processChatLine,
  createStreamPreviewSink,
} from "../../src/cli/chat-session.ts";
import type { HarnessStreamEvent } from "../../src/harness/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";

describe("processChatLine onStream forwarding (#179 T6)", () => {
  it("forwards onStream to run(): stub stream events reach the chat host", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["hello world"] })],
      streamEventsByStep: [
        [
          { type: "text_delta", text: "hello " },
          { type: "text_delta", text: "world" },
        ],
      ],
    });
    const received: HarnessStreamEvent[] = [];
    const r = await processChatLine({
      line: "say hello",
      ctx,
      onStream: (event) => received.push(event),
    });
    assert.equal(r.ranQuery, true);
    assert.equal(r.output.includes("hello world"), true);
    assert.deepEqual(received, [
      { type: "text_delta", text: "hello " },
      { type: "text_delta", text: "world" },
    ]);
  });

  it("without onStream: identical behavior (no events observed, output unchanged)", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["same"] })],
      streamEventsByStep: [[{ type: "text_delta", text: "same" }]],
    });
    const r = await processChatLine({ line: "q", ctx });
    assert.equal(r.ranQuery, true);
    assert.equal(r.output.includes("same"), true);
  });

  it("pipe / non-TTY regression: processChatLine without onStream leaves output unchanged", async () => {
    // Mirrors the structural guarantee:
    //   - runPiped always calls processChatLine({line, ctx}) (chat-session.ts:512).
    //   - runInteractive calls processChatLine({line, ctx, onStream}) only when
    //     process.stderr.isTTY is true (chat-session.ts:354-372). When stderr
    //     is not a TTY, the ternary collapses to onStream = undefined, matching
    //     this test exactly. So this test is the regression gate for both
    //     pipe / non-TTY paths: no onStream → output unchanged.
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["final"] })],
      streamEventsByStep: [
        [
          { type: "text_delta", text: "should-not-observe-1" },
          { type: "text_delta", text: "should-not-observe-2" },
          { type: "tool_call_start", name: "should-not-observe" },
        ],
      ],
    });
    const r = await processChatLine({ line: "q", ctx });
    assert.equal(r.ranQuery, true);
    assert.ok(r.output.includes("final"));
    assert.ok(!r.output.includes("should-not-observe-1"));
  });
});

describe("createStreamPreviewSink (#179 T6 TTY spinner replacement)", () => {
  it("writes each text_delta increment through the writer", () => {
    const chunks: string[] = [];
    const sink = createStreamPreviewSink({ write: (s) => chunks.push(s) });
    sink({ type: "text_delta", text: "he" });
    sink({ type: "text_delta", text: "llo" });
    assert.deepEqual(chunks, ["he", "llo"]);
  });

  it("emits a tool-name hint for tool_call_start", () => {
    const chunks: string[] = [];
    const sink = createStreamPreviewSink({ write: (s) => chunks.push(s) });
    sink({ type: "tool_call_start", name: "bash" });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.includes("bash"), true);
  });

  it("writer errors are swallowed (observer must not break the turn)", () => {
    const sink = createStreamPreviewSink({
      write: () => {
        throw new Error("stderr write failed");
      },
    });
    // Must not throw.
    sink({ type: "text_delta", text: "x" });
    sink({ type: "tool_call_start", name: "t" });
  });
});

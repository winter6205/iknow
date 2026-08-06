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

/** Capture bytes written to a fake stdout / stderr writer pair. */
function captureStreams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writers: {
      writeOut: (s: string) => out.push(s),
      writeErr: (s: string) => err.push(s),
    },
  };
}

describe("createStreamPreviewSink (#179 T6 TTY spinner replacement)", () => {
  it("writes each text_delta increment through the stdout writer", () => {
    const { out, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    sink.feed({ type: "text_delta", text: "he" });
    sink.feed({ type: "text_delta", text: "llo" });
    assert.deepEqual(out, ["he", "llo"]);
    assert.equal(sink.textStreamed, true);
  });

  it("emits a tool-name hint to stderr for tool_call_start", () => {
    const { err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    sink.feed({ type: "tool_call_start", name: "bash" });
    // First chunk clears the spinner, second carries the tool hint.
    const joined = err.join("");
    assert.ok(joined.includes("bash"));
    // tool_call_start is a status hint, not answer text.
    assert.equal(sink.textStreamed, false);
  });

  it("writer errors are swallowed (observer must not break the turn)", () => {
    const sink = createStreamPreviewSink({
      writeOut: () => {
        throw new Error("stdout write failed");
      },
      writeErr: () => {
        throw new Error("stderr write failed");
      },
    });
    // Must not throw.
    sink.feed({ type: "text_delta", text: "x" });
    sink.feed({ type: "tool_call_start", name: "t" });
  });

  it("#195 regression: multi-line streamed text is not double-printed", () => {
    const { out, err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    // A multi-line answer delivered as several text_delta chunks.
    const chunks = ["line1\n", "line2\n", "line3"];
    for (const c of chunks) sink.feed({ type: "text_delta", text: c });
    // The FULL multi-line answer must appear on stdout exactly once.
    const joined = out.join("");
    assert.equal(out.length, chunks.length);
    assert.ok(joined.includes("line1\nline2\nline3"));
    // Count occurrences of a printable substring — must be exactly 1.
    const occurrences = joined.split("line2").length - 1;
    assert.equal(occurrences, 1, "answer text must not be duplicated");
    // Answer text must never land on stderr (only the spinner-clear sequence may).
    assert.ok(
      err.every((chunk) => !chunk.includes("line")),
      "answer text must never land on stderr"
    );
    assert.equal(sink.textStreamed, true);
  });

  it("#195 regression: textStreamed flips once and tool_call_start does not reset it", () => {
    const { writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    assert.equal(sink.textStreamed, false);
    sink.feed({ type: "text_delta", text: "a" });
    assert.equal(sink.textStreamed, true);
    sink.feed({ type: "tool_call_start", name: "bash" });
    assert.equal(
      sink.textStreamed,
      true,
      "tool hint must not clear textStreamed"
    );
    sink.feed({ type: "text_delta", text: "b" });
    assert.equal(sink.textStreamed, true);
  });
});

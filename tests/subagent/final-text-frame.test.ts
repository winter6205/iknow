/**
 * T3 `final_text` side-channel frame — wire grammar plus the worker's sink.
 *
 * The frame is the only channel that carries a folded report's raw body to the
 * host, so its closedness is load-bearing: an over-broad schema would let a
 * second meaning ride the same stdout wire, and a frame line must never pass
 * envelope validation (both envelope schemas stay byte-identical).
 *
 * The fold threshold is the production `TRUNCATION_LIMIT`, imported from
 * envelope.ts, so a changed limit cannot leave these cases measuring an old band.
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { ProtocolError } from "../../src/harness/errors.ts";
import {
  FINAL_TEXT_FRAME_SCHEMA,
  PARENT_SCHEMA,
  TRUNCATION_LIMIT,
  frameTag,
  parseFinalTextFrame,
  parseParentEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import type { FinalTextFrame } from "../../src/harness/subagent/envelope.ts";
import { createFinalTextSink } from "../../src/harness/subagent/worker.ts";

function frameLine(frame: Record<string, unknown>): string {
  return `${JSON.stringify(frame)}\n`;
}

describe("final_text frame schema (closed, tagged)", () => {
  it("PARENT_SCHEMA is untouched by the frame: no raw-text field was added", () => {
    assert.equal(PARENT_SCHEMA.additionalProperties, false);
    const props = PARENT_SCHEMA.properties as Record<string, unknown>;
    // A new envelope body field would make every already-stamped envelope a
    // ProtocolError; the frame channel exists so this stays as it was.
    assert.equal("final_text" in props, false);
    assert.equal("text" in props, false);
  });

  it("parses a valid frame and hands back the raw body unbounded", () => {
    const raw = `${"x".repeat(TRUNCATION_LIMIT * 3)}\n<<TAIL-WITNESS>>`;
    const frame = parseFinalTextFrame(
      frameLine({ type: "final_text", text: raw })
    );
    assert.equal(frame.type, "final_text");
    assert.equal(frame.text, raw);
    assert.equal(frame.text.length, raw.length);
  });

  it("accepts an empty body (the schema bounds shape, not report content)", () => {
    const frame = parseFinalTextFrame(
      frameLine({ type: "final_text", text: "" })
    );
    assert.equal(frame.text, "");
  });

  it("rejects a missing / non-string / additional-key body with ProtocolError", () => {
    for (const bad of [
      { type: "final_text" },
      { type: "final_text", text: 42 },
      { type: "final_text", text: "r", extra: true },
    ]) {
      assert.throws(
        () => parseFinalTextFrame(frameLine(bad)),
        ProtocolError,
        `expected rejection for ${JSON.stringify(bad)}`
      );
    }
  });

  it("rejects a wrong or missing tag", () => {
    assert.throws(
      () =>
        parseFinalTextFrame(
          frameLine({ type: "review_request", request_id: "r" })
        ),
      ProtocolError
    );
    assert.throws(
      () => parseFinalTextFrame(frameLine({ text: "r" })),
      ProtocolError
    );
  });

  it("rejects non-object and malformed JSON lines", () => {
    for (const bad of [
      '[{"type":"final_text"}]',
      '"just a string"',
      "{not json",
    ]) {
      assert.throws(() => parseFinalTextFrame(bad), ProtocolError);
    }
  });

  it("declares the tag and the two required keys, nothing more", () => {
    assert.deepEqual(
      Object.keys(
        FINAL_TEXT_FRAME_SCHEMA.properties as Record<string, unknown>
      ),
      ["type", "text"]
    );
    assert.deepEqual(FINAL_TEXT_FRAME_SCHEMA.required, ["type", "text"]);
    assert.equal(FINAL_TEXT_FRAME_SCHEMA.additionalProperties, false);
  });
});

describe("frame / envelope dispatch discrimination", () => {
  const raw = "y".repeat(TRUNCATION_LIMIT + 1);
  const line = frameLine({ type: "final_text", text: raw });

  it("frameTag names the line so the host can dispatch before validation", () => {
    assert.equal(frameTag(line), "final_text");
  });

  it("a final_text line is never a parent envelope", () => {
    // Under PARENT_SCHEMA's additionalProperties:false an unhandled frame
    // falling through must die as a protocol error, not parse as an envelope.
    assert.throws(() => parseParentEnvelope(line), ProtocolError);
  });

  it("an unknown tag is tolerated by no frame schema", () => {
    const unknown = frameLine({ type: "mystery_frame", text: raw });
    assert.equal(frameTag(unknown), "mystery_frame");
    assert.throws(() => parseFinalTextFrame(unknown), ProtocolError);
    assert.throws(() => parseParentEnvelope(unknown), ProtocolError);
  });
});

describe("worker final_text sink (production wire shape)", () => {
  it("serializes one newline-terminated frame line per raw body", () => {
    const written: string[] = [];
    const sink = createFinalTextSink((line) => written.push(line));
    const raw = `${"z".repeat(TRUNCATION_LIMIT + 2)}\n<<TAIL-WITNESS-SINK>>`;
    sink(raw);

    assert.equal(written.length, 1);
    assert.ok(written[0]!.endsWith("\n"));
    const frame: FinalTextFrame = parseFinalTextFrame(written[0]!);
    assert.equal(frame.type, "final_text");
    // Byte-exact round trip: nothing on the way out escapes or trims the body.
    assert.equal(frame.text, raw);
  });

  it("a stdout write failure is swallowed, never rethrown into the run", () => {
    const sink = createFinalTextSink(() => {
      throw new Error("EPIPE");
    });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      assert.doesNotThrow(() => sink("anything"));
    } finally {
      stderr.mockRestore();
    }
  });
});

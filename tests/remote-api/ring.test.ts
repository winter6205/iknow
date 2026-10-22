/**
 * Seat event ring buffer tests (spec specs/remote-sync.md §5.6, §5.7).
 *
 * Why a dedicated suite: reconnect catch-up is "replay from the ring or send a
 * snapshot"; both the sequence monotonicity and the two retention caps decide
 * whether a replay has a gap. The ring is instance-agnostic by design (the
 * host owns instanceId and snapshot decisions), so the assertions stay on
 * seq/bytes/window only.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createSeatEventRing,
  DEFAULT_SEAT_RING_MAX_BYTES,
  DEFAULT_SEAT_RING_MAX_EVENTS,
} from "../../src/remote-api/ring.ts";

const TIME = "2026-01-01T00:00:00.000Z";

function event(text: string) {
  return { time: TIME, event: { kind: "notice", text } as const };
}

/** Byte size the ring records for a stored event (UTF-8 JSON of the envelope). */
function storedBytes(seq: number, text: string): number {
  return Buffer.byteLength(
    JSON.stringify({ seq, time: TIME, event: { kind: "notice", text } }),
    "utf8"
  );
}

describe("createSeatEventRing", () => {
  it("starts empty with seq 1 as the first event", () => {
    const ring = createSeatEventRing();
    assert.equal(ring.oldestSeq, undefined);
    assert.equal(ring.latestSeq, 0);
    assert.equal(ring.size, 0);
    const first = ring.push(event("a"));
    assert.equal(first.seq, 1);
    assert.equal(ring.oldestSeq, 1);
    assert.equal(ring.latestSeq, 1);
    assert.equal(ring.size, 1);
  });

  it("increments seq by one per event regardless of capacity", () => {
    const ring = createSeatEventRing({ maxEvents: 2 });
    assert.equal(ring.push(event("a")).seq, 1);
    assert.equal(ring.push(event("b")).seq, 2);
    assert.equal(ring.push(event("c")).seq, 3);
    assert.equal(ring.latestSeq, 3);
  });

  it("keeps the pushed event payload and adds seq", () => {
    const ring = createSeatEventRing();
    const pushed = ring.push(event("hello"));
    assert.deepEqual(pushed, {
      seq: 1,
      time: TIME,
      event: { kind: "notice", text: "hello" },
    });
  });

  it("replays the retained window after sinceSeq", () => {
    const ring = createSeatEventRing();
    ring.push(event("a"));
    ring.push(event("b"));
    ring.push(event("c"));
    assert.deepEqual(
      ring.replaySince(0).map((e) => e.seq),
      [1, 2, 3]
    );
    assert.deepEqual(
      ring.replaySince(1).map((e) => e.seq),
      [2, 3]
    );
    assert.deepEqual(ring.replaySince(3), []);
    assert.deepEqual(ring.replaySince(99), []);
  });

  it("trims from the front when the event cap is exceeded", () => {
    const ring = createSeatEventRing({ maxEvents: 3 });
    for (const text of ["a", "b", "c", "d", "e"]) ring.push(event(text));
    assert.equal(ring.size, 3);
    assert.equal(ring.oldestSeq, 3);
    assert.equal(ring.latestSeq, 5);
    assert.deepEqual(
      ring.replaySince(2).map((e) => e.event),
      [
        { kind: "notice", text: "c" },
        { kind: "notice", text: "d" },
        { kind: "notice", text: "e" },
      ]
    );
  });

  it("trims from the front when the byte cap is exceeded", () => {
    const one = storedBytes(1, "0123456789");
    const ring = createSeatEventRing({ maxEvents: 100, maxBytes: one * 2 });
    ring.push(event("0123456789"));
    ring.push(event("0123456789"));
    assert.equal(ring.size, 2);
    ring.push(event("0123456789"));
    // Three events do not fit, the oldest goes.
    assert.equal(ring.size, 2);
    assert.equal(ring.oldestSeq, 2);
  });

  it("keeps the newest event even when it alone exceeds the byte cap", () => {
    const ring = createSeatEventRing({ maxBytes: 4 });
    ring.push(event("a much longer payload than four bytes"));
    assert.equal(ring.size, 1);
    assert.equal(ring.latestSeq, 1);
    ring.push(event("another long payload that does not fit either"));
    assert.equal(ring.size, 1);
    assert.equal(ring.oldestSeq, 2);
    assert.equal(ring.latestSeq, 2);
  });

  it("defaults to 2000 events and 4 MiB", () => {
    assert.equal(DEFAULT_SEAT_RING_MAX_EVENTS, 2000);
    assert.equal(DEFAULT_SEAT_RING_MAX_BYTES, 4 * 1024 * 1024);
    const ring = createSeatEventRing({ maxEvents: 2 });
    assert.equal(ring.size, 0);
    for (let i = 0; i < 5; i += 1) ring.push(event(`e${i}`));
    assert.equal(ring.size, 2);
  });

  it("stays instance-independent: no instance fields on events", () => {
    const ring = createSeatEventRing();
    const pushed = ring.push({
      time: TIME,
      conversationId: "c_1",
      event: { kind: "text", delta: "hi" },
    });
    assert.deepEqual(pushed, {
      seq: 1,
      time: TIME,
      conversationId: "c_1",
      event: { kind: "text", delta: "hi" },
    });
  });
});

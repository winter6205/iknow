/**
 * Contract tests for `scripts/eval/tui/delivery.ts` (#1219).
 *
 * WHY: the historical driver fired a clock-based timetable unconditionally and,
 * after 45 s without proof, wrote ANOTHER `\r` — up to four times. `app.tsx`
 * refuses input while a round is active (`"当前会话正在运行；…"`), so those
 * retries were lost work, and run3 sent six. These cases pin the two rules that
 * replace it: due times are EARLIEST, and a submission is never repeated or
 * discarded without an explicit verdict.
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceLedger } from "../../../../scripts/eval/tui/acceptance.ts";
import {
  composerClear,
  decideDelivery,
  planChunks,
} from "../../../../scripts/eval/tui/delivery.ts";
import { parseProtocol } from "../../../../scripts/eval/tui/protocol.ts";
import { takeBaseline } from "../../../../scripts/eval/tui/session-store-reader.ts";
import { initStore, validProtocol, type FixtureLocation } from "./fixture.ts";

const roots: string[] = [];

function makeLoc(): FixtureLocation {
  const root = mkdtempSync(join(tmpdir(), "iknow-delivery-"));
  roots.push(root);
  return {
    dataDir: join(root, "data"),
    cwd: join(root, "repo"),
    conversationId: "conv-1219",
  };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const DELIVERY = {
  chunkBytes: 200,
  chunkDelayMs: 10,
  settleBeforeSubmit: true,
  settleWaitMs: 5000,
  acceptTimeoutMs: 30000,
  retryEnter: false,
};

function makeLedger(over: Record<string, unknown> = {}) {
  const loc = makeLoc();
  initStore(loc, "seed");
  const baseline = takeBaseline(loc);
  const protocol = parseProtocol(
    validProtocol({ delivery: { ...DELIVERY, ...over } })
  );
  return {
    ledger: new AcceptanceLedger({ baseline, stimuli: protocol.stimuli }),
    protocol,
  };
}

describe("planChunks — paced writes", () => {
  it("splits text into bounded chunks and paces them", () => {
    const chunks = planChunks("abcdefghij", {
      chunkBytes: 4,
      chunkDelayMs: 10,
    });

    assert.deepEqual(
      chunks.map((c) => c.text),
      ["abcd", "efgh", "ij"]
    );
    assert.deepEqual(
      chunks.map((c) => c.delayMs),
      [0, 10, 10],
      "the first chunk is immediate, the rest are paced"
    );
    assert.equal(chunks.map((c) => c.text).join(""), "abcdefghij");
  });

  it("never splits inside a multi-byte character", () => {
    const chunks = planChunks("中文测试内容", {
      chunkBytes: 4,
      chunkDelayMs: 5,
    });

    assert.equal(chunks.map((c) => c.text).join(""), "中文测试内容");
    for (const chunk of chunks) {
      assert.equal(
        chunk.text.includes("\ufffd"),
        false,
        `chunk split a surrogate/UTF-8 boundary: ${chunk.text}`
      );
    }
  });

  it("rejects an empty or invalid chunk budget instead of writing in one burst", () => {
    assert.throws(
      () => planChunks("abc", { chunkBytes: 0, chunkDelayMs: 10 }),
      /chunkBytes/
    );
    assert.throws(
      () => planChunks("abc", { chunkBytes: 10, chunkDelayMs: -1 }),
      /chunkDelayMs/
    );
  });

  it("builds a composer-clear plan of exactly n keystrokes", () => {
    assert.deepEqual(composerClear(3), ["\u007f", "\u007f", "\u007f"]);
    assert.deepEqual(composerClear(0), []);
  });
});

describe("decideDelivery — earliest-due scheduling", () => {
  it("waits until the earliest due time", () => {
    const { ledger, protocol } = makeLedger();
    const early = decideDelivery({ protocol, ledger, nowMs: 999, busy: false });

    assert.equal(early.action, "wait_due" as const);
    assert.equal(early.tag, "S1");
    assert.equal(early.dueAtMs, 1000);
  });

  it("submits a due stimulus when the round is idle", () => {
    const { ledger, protocol } = makeLedger();
    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 1000,
      busy: false,
    });

    assert.equal(decision.action, "submit" as const);
    assert.equal(decision.tag, "S1");
    assert.equal(
      decision.text,
      "first",
      "the fixture protocol submits the fixed stimulus text verbatim"
    );
  });

  it("defers a due stimulus while a round is active instead of losing it", () => {
    const { ledger, protocol } = makeLedger();
    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 1000,
      busy: true,
    });

    assert.equal(decision.action, "wait_settle" as const);
    assert.equal(decision.tag, "S1");
    assert.equal(
      ledger.record("S1")?.sent_at_ms,
      null,
      "a deferred stimulus is not marked sent"
    );
    assert.ok(
      decision.reason.includes("deferred"),
      `the reason must name the deferral; got: ${decision.reason}`
    );
  });

  it("classifies a stimulus refused by a busy round once the bounded wait elapses", () => {
    const { ledger, protocol } = makeLedger();
    ledger.markSent("S1", 1000);
    ledger.markRefused(
      "S1",
      6000,
      "round still running after the bounded settle wait"
    );
    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 8000,
      busy: true,
      busySinceMs: 1000,
    });

    assert.equal(
      decision.action,
      "refused" as const,
      "the refusal must be reported, not silently dropped"
    );
    assert.equal(
      decision.tag,
      "S2",
      "the refusal applies to the stimulus that could not be submitted"
    );
    assert.equal(
      ledger.record("S1")?.verdict,
      "refused" as const,
      "the earlier refusal is retained per stimulus"
    );
    assert.equal(
      ledger.record("S2")?.sent_at_ms,
      null,
      "a refused stimulus is never marked submitted"
    );
  });

  it("never re-submits a stimulus that was already sent, even when it is still unproven", () => {
    const { ledger, protocol } = makeLedger();
    ledger.markSent("S1", 1000);
    ledger.markSent("S2", 1000);
    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 45000,
      busy: true,
    });

    assert.notEqual(
      decision.action,
      "submit" as const,
      `a 45s-later blind resend must not happen; got: ${JSON.stringify(decision)}`
    );
    assert.equal(decision.action, "wait_settle" as const);
  });

  it("reports done when every stimulus is sent and settled", () => {
    const { ledger, protocol } = makeLedger();
    for (const tag of ["S1", "S2"]) ledger.markSent(tag, 1000);
    ledger.markAccepted("S1", { eventId: "e1", anchor: "e1", atMs: 1100 });
    ledger.markSettled("S1", "e2", 1200);
    ledger.markAccepted("S2", { eventId: "e3", anchor: "e3", atMs: 2100 });
    ledger.markSettled("S2", "e4", 2200);
    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 9000,
      busy: false,
    });

    assert.equal(decision.action, "done" as const);
  });

  it("does not report done while an accepted stimulus is still unsettled", () => {
    const { ledger, protocol } = makeLedger();
    for (const tag of ["S1", "S2"]) ledger.markSent(tag, 1000);
    ledger.markAccepted("S1", { eventId: "e1", anchor: "e1", atMs: 1100 });
    ledger.markSettled("S1", "e2", 1200);
    ledger.markAccepted("S2", { eventId: "e3", anchor: "e3", atMs: 2100 });
    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 9000,
      busy: true,
    });

    assert.notEqual(
      decision.action,
      "done" as const,
      "an unsettled round must keep the run open"
    );
    assert.equal(decision.action, "wait_settle" as const);
  });
});

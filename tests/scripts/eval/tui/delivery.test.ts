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
  type DeliveryAction,
} from "../../../../scripts/eval/tui/delivery.ts";
import { parseProtocol } from "../../../../scripts/eval/tui/protocol.ts";
import {
  SessionTailReader,
  takeBaseline,
} from "../../../../scripts/eval/tui/session-store-reader.ts";
import {
  appendAssistant,
  appendNativeState,
  appendUser,
  initStore,
  validProtocol,
  type FixtureLocation,
} from "./fixture.ts";

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

/**
 * The outstanding-stimulus gate (#1221).
 *
 * WHY this block exists: `settleBeforeSubmit` was parsed, documented and set by
 * every fixture, and NOTHING read it. `decideDelivery` gated only on `busy` —
 * the persisted lifecycle's last word — and a stimulus that was TYPED but not
 * yet ACCEPTED publishes no boundary at all, so it is not busy. The next due
 * stimulus was therefore typed into the same composer, and the measured #1221
 * run persisted S1 and S2 as ONE user event.
 */
describe("decideDelivery — the outstanding-stimulus gate", () => {
  it("holds a sent-but-unaccepted stimulus even with NO busy record at all", () => {
    const { ledger, protocol } = makeLedger();
    ledger.markSent("S1", 1000);

    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 2000,
      // The persisted lifecycle has published nothing: `busy` is false, which is
      // exactly the state the #1221 merge happened in.
      busy: false,
    });

    assert.equal(
      decision.action,
      "wait_settle" as const,
      `a sent stimulus that is not yet accepted is outstanding; got: ${JSON.stringify(decision)}`
    );
    assert.notEqual(decision.action, "submit" as const);
    assert.equal(decision.tag, "S2", "the held stimulus is the next one due");
    assert.equal(
      ledger.record("S2")?.sent_at_ms,
      null,
      "the next stimulus must not have been typed"
    );
    assert.match(
      decision.reason,
      /S1/,
      `the reason must name the outstanding stimulus; got: ${decision.reason}`
    );
    assert.ok(
      decision.reason.length > 20,
      `the reason must be human-readable evidence, not a code; got: ${decision.reason}`
    );
  });

  it("still holds it when acceptance landed but the round has not settled", () => {
    const { ledger, protocol } = makeLedger();
    ledger.markSent("S1", 1000);
    ledger.markAccepted("S1", { eventId: "e1", anchor: "e1", atMs: 1100 });

    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 2000,
      busy: false,
    });

    assert.equal(
      decision.action,
      "wait_settle" as const,
      `acceptance without settlement is still in flight; got: ${JSON.stringify(decision)}`
    );
    assert.equal(ledger.record("S2")?.sent_at_ms, null);
  });

  it("submits the next stimulus once the preceding one is accepted AND settled", () => {
    const { ledger, protocol } = makeLedger();
    ledger.markSent("S1", 1000);
    ledger.markAccepted("S1", { eventId: "e1", anchor: "e1", atMs: 1100 });
    ledger.markSettled("S1", "e2", 1200);

    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 2000,
      busy: false,
    });

    assert.equal(decision.action, "submit" as const);
    assert.equal(decision.tag, "S2");
    assert.equal(decision.text, "second");
  });

  it("refuses at the bounded acceptance deadline instead of typing into the same composer", () => {
    const { ledger, protocol } = makeLedger();
    ledger.markSent("S1", 1000);
    // acceptTimeoutMs is 30000 in this fixture, so 31001 is the first instant
    // the acceptance half of the gate is allowed to refuse.
    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 31_001,
      busy: false,
    });

    assert.equal(
      decision.action,
      "refused" as const,
      `the bounded acceptance wait must refuse, never submit; got: ${JSON.stringify(decision)}`
    );
    assert.equal(decision.tag, "S2");
    assert.equal(
      ledger.record("S2")?.sent_at_ms,
      null,
      "a refused stimulus was never written"
    );
    assert.match(decision.reason, /30000ms/);
  });

  it("refuses an accepted-but-unsettled round at the bounded settle deadline", () => {
    const { ledger, protocol } = makeLedger();
    ledger.markSent("S1", 1000);
    ledger.markAccepted("S1", { eventId: "e1", anchor: "e1", atMs: 1100 });

    // settleWaitMs is 5000 in this fixture, measured from the acceptance.
    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 1100 + 5000 + 1,
      busy: false,
    });

    assert.equal(
      decision.action,
      "refused" as const,
      `a round that never settles must refuse at the deadline; got: ${JSON.stringify(decision)}`
    );
    assert.equal(decision.tag, "S2");
    assert.match(decision.reason, /5000ms/);
  });

  it("keeps the gate OFF when settleBeforeSubmit is false, as before", () => {
    const { ledger, protocol } = makeLedger({ settleBeforeSubmit: false });
    ledger.markSent("S1", 1000);

    const decision = decideDelivery({
      protocol,
      ledger,
      nowMs: 2000,
      busy: false,
    });

    assert.equal(
      protocol.delivery.settleBeforeSubmit,
      false,
      "the fixture must really have the gate disabled for this case"
    );
    assert.equal(
      decision.action,
      "submit" as const,
      `an opted-out protocol keeps the historical behaviour; got: ${JSON.stringify(decision)}`
    );
  });
});

/** One of the states a stimulus record can be in for the gate's purposes. */
type RecordState =
  | "unsent"
  | "sent_unaccepted"
  | "sent_accepted"
  | "sent_accepted_settled"
  | "sent_refused"
  | "sent_timeout";

const RECORD_STATES: readonly RecordState[] = [
  "unsent",
  "sent_unaccepted",
  "sent_accepted",
  "sent_accepted_settled",
  "sent_refused",
  "sent_timeout",
];

function putRecord(
  ledger: AcceptanceLedger,
  tag: string,
  state: RecordState
): void {
  if (state === "unsent") return;
  ledger.markSent(tag, 1000);
  if (state === "sent_accepted" || state === "sent_accepted_settled")
    ledger.markAccepted(tag, {
      eventId: `e-${tag}`,
      anchor: `e-${tag}`,
      atMs: 1100,
    });
  if (state === "sent_accepted_settled")
    ledger.markSettled(tag, `t-${tag}`, 1200);
  if (state === "sent_refused")
    ledger.markRefused(tag, 1300, "fixture: already refused");
  if (state === "sent_timeout")
    ledger.markTimeout(tag, 1300, "fixture: acceptance never arrived");
}

describe("decideDelivery — vacuous total over a ledger-state matrix", () => {
  it("returns exactly one decision for every state, clock and busy combination", () => {
    const gates: readonly DeliveryAction[] = [
      "submit",
      "wait_due",
      "wait_settle",
      "refused",
      "done",
    ];
    let cases = 0;

    for (const s1 of RECORD_STATES) {
      for (const s2 of RECORD_STATES) {
        for (const nowMs of [0, 999, 1000, 2000, 31_001, 60_001]) {
          for (const busy of [false, true]) {
            for (const settleBeforeSubmit of [true, false]) {
              const { ledger, protocol } = makeLedger({ settleBeforeSubmit });
              putRecord(ledger, "S1", s1);
              putRecord(ledger, "S2", s2);

              const decision = decideDelivery({
                protocol,
                ledger,
                nowMs,
                busy,
                busySinceMs: 1000,
              });
              cases++;

              assert.notEqual(
                decision,
                null,
                `no decision for S1=${s1} S2=${s2} now=${nowMs} busy=${String(busy)}`
              );
              assert.notEqual(
                decision,
                undefined,
                `decideDelivery returned undefined for S1=${s1} S2=${s2} now=${nowMs}`
              );
              assert.ok(
                gates.includes(decision.action),
                `unknown action ${decision.action} for S1=${s1} S2=${s2} now=${nowMs}`
              );
              assert.equal(
                typeof decision.reason,
                "string",
                "the reason must always be a string, never undefined"
              );
              assert.ok(
                decision.reason.length > 0,
                `an empty reason is not evidence; S1=${s1} S2=${s2} now=${nowMs}`
              );
              if (decision.action !== "submit") continue;
              assert.ok(
                decision.tag !== null && decision.text !== null,
                "a submit must name the stimulus and carry its text"
              );
              assert.equal(
                ledger.record(decision.tag)?.sent_at_ms,
                null,
                "a submit is only ever returned for a stimulus nothing has typed"
              );
              // The outstanding-state rule is the GATE's contract, so it can
              // only be asserted where the gate is on. With the gate off, a
              // submit beside an unaccepted record is the historical behaviour
              // this block must not silently redefine.
              if (!settleBeforeSubmit) continue;
              const outstanding = ledger
                .records()
                .filter(
                  (r) =>
                    r.sent_at_ms !== null &&
                    !(r.verdict === "accepted" && r.settled_at_ms !== null)
                );
              assert.equal(
                outstanding.length,
                0,
                `submit with ${outstanding.length} outstanding record(s) (${JSON.stringify(outstanding)}): S1=${s1} S2=${s2} now=${nowMs} busy=${String(busy)}`
              );
            }
          }
        }
      }
    }

    assert.equal(cases, 6 * 6 * 6 * 2 * 2, "the whole matrix must be covered");
  });
});

/**
 * The ledger path, against a REAL session store.
 *
 * WHY not a mocked poll: the whole point of the #1221 merge is that two
 * stimuli can land in ONE persisted user event, so the claim under test is
 * about the bytes the store received. The fixture appends exactly what a real
 * host persists for one submission, one event at a time.
 */
describe("two stimuli, two independently tagged acknowledgements", () => {
  it("persists each stimulus as its own tagged record", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const baseline = takeBaseline(loc);
    const protocol = parseProtocol(validProtocol({ delivery: DELIVERY }));
    const ledger = new AcceptanceLedger({
      baseline,
      stimuli: protocol.stimuli,
    });
    const reader = new SessionTailReader({ location: loc, baseline });

    // S1 is typed and accepted; its round is still running when S2 comes due,
    // which is the exact instant the historical driver typed S2 as well.
    ledger.markSent("S1", 1000);
    appendUser({ loc, index: 1, parent: "e0", text: "first" });
    appendNativeState({
      loc,
      anchorEventId: "e1",
      boundary: "input",
      messageCount: 2,
      createdAt: "2026-10-06T12:00:57.196Z",
    });
    ledger.observe(reader.poll(), 1100);

    const held = decideDelivery({ protocol, ledger, nowMs: 2000, busy: false });
    assert.equal(
      held.action,
      "wait_settle" as const,
      `S2 must be held while S1's round runs; got: ${JSON.stringify(held)}`
    );
    assert.equal(
      ledger.record("S2")?.sent_at_ms,
      null,
      "nothing may have been typed into the composer"
    );

    // S1's round settles; only now may S2 be submitted.
    appendAssistant({ loc, index: 2, parent: "e1", text: "ack" });
    appendNativeState({
      loc,
      anchorEventId: "e2",
      boundary: "terminal",
      messageCount: 3,
      createdAt: "2026-10-06T12:00:58.100Z",
    });
    ledger.observe(reader.poll(), 1200);

    const released = decideDelivery({
      protocol,
      ledger,
      nowMs: 2000,
      busy: false,
    });
    assert.equal(released.action, "submit" as const, JSON.stringify(released));
    assert.equal(ledger.markSent("S2", 2000), true);
    appendUser({ loc, index: 3, parent: "e2", text: "second" });
    appendNativeState({
      loc,
      anchorEventId: "e3",
      boundary: "input",
      messageCount: 4,
      createdAt: "2026-10-06T12:01:20.000Z",
    });
    appendAssistant({ loc, index: 4, parent: "e3", text: "ack 2" });
    appendNativeState({
      loc,
      anchorEventId: "e4",
      boundary: "terminal",
      messageCount: 5,
      createdAt: "2026-10-06T12:01:24.000Z",
    });
    ledger.observe(reader.poll(), 2200);

    assert.deepEqual(
      ledger.acceptedTags(),
      ["S1", "S2"],
      `each stimulus must carry its OWN persisted acceptance; got: ${JSON.stringify(ledger.records())}`
    );
    assert.deepEqual(ledger.settledTags(), ["S1", "S2"]);
    const ids = ledger.records().map((r) => r.accepted_event_id);
    assert.equal(
      new Set(ids).size,
      2,
      `two independently TAGGED acknowledgements need two distinct events; got: ${JSON.stringify(ids)}`
    );
    assert.equal(
      decideDelivery({ protocol, ledger, nowMs: 9000, busy: false }).action,
      "done" as const
    );
  });

  it("treats a refusal as final: no resend, ever", () => {
    const { ledger, protocol } = makeLedger();
    ledger.markSent("S1", 1000);
    ledger.markAccepted("S1", { eventId: "e1", anchor: "e1", atMs: 1100 });
    ledger.markSettled("S1", "e2", 1200);
    ledger.markRefused(
      "S2",
      2000,
      "fixture: the host stayed busy past the deadline"
    );

    for (const nowMs of [2001, 10_000, 60_000]) {
      const decision = decideDelivery({ protocol, ledger, nowMs, busy: false });
      assert.notEqual(
        decision.action,
        "submit" as const,
        `a refused stimulus must never be typed again; now=${nowMs} got: ${JSON.stringify(decision)}`
      );
    }
    assert.equal(
      ledger.markSent("S2", 60_000),
      false,
      "the ledger itself refuses a second submission of a refused stimulus"
    );
    assert.equal(ledger.record("S2")?.sent_at_ms, null);
  });
});

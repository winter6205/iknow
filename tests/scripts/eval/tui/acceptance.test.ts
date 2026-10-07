/**
 * Contract tests for `scripts/eval/tui/acceptance.ts` (#1219).
 *
 * WHY these cases exist: the historical driver declared a stimulus "submitted"
 * the moment a new `.jsonl` file appeared under `projects/`. That check was
 * measured FALSE POSITIVE (S4 "verified" 113 ms before two sub-agent session
 * dirs appeared, with S4's text in no store file) and FALSE NEGATIVE (resume1
 * journaled zero verifications while R1 was demonstrably accepted). Every case
 * below pins one of those two wrong answers so it cannot come back.
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AcceptanceLedger,
  classifyAcceptance,
  pendingRecord,
  type Verdict,
} from "../../../../scripts/eval/tui/acceptance.ts";
import {
  SessionTailReader,
  takeBaseline,
} from "../../../../scripts/eval/tui/session-store-reader.ts";
import type { Stimulus } from "../../../../scripts/eval/tui/protocol.ts";
import {
  appendAssistant,
  appendNativeState,
  appendUser,
  initEmptyStore,
  initStore,
  initSubagentStore,
  type FixtureLocation,
} from "./fixture.ts";

const roots: string[] = [];

function makeLoc(): FixtureLocation {
  const root = mkdtempSync(join(tmpdir(), "iknow-acceptance-"));
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

const S1: Stimulus = { at: 1000, tag: "S1", text: "first stimulus text" };
const S2: Stimulus = { at: 2000, tag: "S2", text: "second stimulus text" };

function makeLedger(
  loc: FixtureLocation,
  stimuli: readonly Stimulus[] = [S1, S2]
) {
  const baseline = takeBaseline(loc);
  const reader = new SessionTailReader({ location: loc, baseline });
  const ledger = new AcceptanceLedger({ baseline, stimuli });
  return { ledger, reader, baseline };
}

/** Write one full accepted+ssettled round: message, input boundary, reply, terminal. */
function writeRound(
  loc: FixtureLocation,
  args: {
    index: number;
    parent: string | null;
    text: string;
    replyParent: string;
    replyIndex: number;
  }
): { acceptedId: string; settledId: string } {
  const acceptedId = appendUser({
    loc,
    index: args.index,
    parent: args.parent,
    text: args.text,
  }).id;
  appendNativeState({
    loc,
    anchorEventId: acceptedId,
    boundary: "input",
    messageCount: args.index + 1,
    createdAt: "2026-10-06T12:00:57.196Z",
  });
  const settledId = appendAssistant({
    loc,
    index: args.replyIndex,
    parent: args.replyParent,
    text: "ack",
  }).id;
  appendNativeState({
    loc,
    anchorEventId: settledId,
    boundary: "terminal",
    messageCount: args.replyIndex + 1,
    createdAt: "2026-10-06T12:01:02.926Z",
  });
  return { acceptedId, settledId };
}

describe("acceptance — a stimulus is verified by a persisted event, not by a new file", () => {
  it("acknowledges a FIRST input from a persisted user-message event matching text and conversation", () => {
    const loc = makeLoc();
    initEmptyStore(loc);
    const { ledger, reader } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    writeRound(loc, {
      index: 0,
      parent: null,
      text: S1.text,
      replyParent: "e0",
      replyIndex: 1,
    });
    ledger.observe(reader.poll(), 1016);
    const record = ledger.record("S1");

    assert.equal(
      record?.verdict,
      "accepted" as Verdict,
      `expected accepted; got: ${JSON.stringify(record)}`
    );
    assert.equal(record?.accepted_event_id, "e0");
    assert.equal(record?.input_anchor, "e0");
    assert.equal(record?.settled_anchor, "e1");
    assert.equal(record?.settled_at_ms, 1016);
    assert.equal(record?.sent_at_ms, 1000);
    assert.equal(record?.due_at_ms, S1.at);
    assert.ok(
      record?.accepted_at_ms !== null && record.accepted_at_ms > 0,
      `accepted time must be recorded separately from sent time; got: ${JSON.stringify(record?.accepted_at_ms)}`
    );
  });

  it("acknowledges a FOLLOW-UP input in the SAME store file", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader, baseline } = makeLedger(loc);
    writeRound(loc, {
      index: 1,
      parent: "e0",
      text: S1.text,
      replyParent: "e1",
      replyIndex: 2,
    });
    ledger.markSent("S1", 1000);
    ledger.observe(reader.poll(), 1016);
    assert.equal(ledger.record("S1")?.verdict, "accepted");

    ledger.markSent("S2", 2000);
    writeRound(loc, {
      index: 3,
      parent: "e2",
      text: S2.text,
      replyParent: "e3",
      replyIndex: 4,
    });
    ledger.observe(reader.poll(), 2020);

    assert.equal(
      ledger.record("S2")?.verdict,
      "accepted",
      "a follow-up must verify from the same file"
    );
    assert.equal(ledger.record("S2")?.accepted_event_id, "e3");
    assert.ok(
      !baseline.eventIds.includes("e3"),
      "the follow-up event id must be new relative to the baseline"
    );
  });

  it("acknowledges a POSITIONAL RESUME in the SAME conversation, without a new session file", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const resume: Stimulus = {
      at: 0,
      tag: "R1",
      text: "list what you changed earlier",
    };
    const { ledger, reader } = makeLedger(loc, [resume]);
    ledger.markSent("R1", 500);
    writeRound(loc, {
      index: 1,
      parent: "e0",
      text: resume.text,
      replyParent: "e1",
      replyIndex: 2,
    });
    ledger.observe(reader.poll(), 900);

    assert.equal(
      ledger.record("R1")?.verdict,
      "accepted",
      "a resume must verify in the same conversation"
    );
    assert.equal(ledger.record("R1")?.accepted_event_id, "e1");
    assert.equal(ledger.record("R1")?.settled_anchor, "e2");
  });

  it("does NOT accept on terminal redraw alone (the S4 false-positive shape)", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    appendUser({
      loc,
      index: 1,
      parent: "e0",
      text: "seed",
      hostInjected: true,
    });
    for (let i = 0; i < 6; i++) {
      appendNativeState({
        loc,
        anchorEventId: "e0",
        boundary: "tool_batch",
        messageCount: 2 + i,
        createdAt: "2026-10-06T12:00:58.000Z",
      });
    }
    ledger.observe(reader.poll(), 1818);
    const record = ledger.record("S1");

    assert.equal(
      record?.verdict,
      "pending" as Verdict,
      `byte growth plus tool batches must not read as accepted; got: ${JSON.stringify(record)}`
    );
    assert.equal(record?.accepted_event_id, null);
  });

  it("does NOT accept on sub-agent session activity (the S4 false-positive mechanism)", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    initSubagentStore(
      loc,
      "55a91052-0000-4000-8000-000000000001",
      "S1 first stimulus text"
    );
    initSubagentStore(
      loc,
      "def90f06-0000-4000-8000-000000000002",
      "S1 first stimulus text"
    );
    ledger.observe(reader.poll(), 113);

    assert.equal(
      ledger.record("S1")?.verdict,
      "pending" as Verdict,
      `sub-agent files carry the stimulus text but are not the measured conversation; got: ${JSON.stringify(ledger.record("S1"))}`
    );
    assert.equal(ledger.record("S1")?.accepted_event_id, null);
  });

  it("does NOT accept a host-injected echo of the stimulus text", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    appendUser({
      loc,
      index: 1,
      parent: "e0",
      text: S1.text,
      hostInjected: true,
    });
    appendNativeState({
      loc,
      anchorEventId: "e1",
      boundary: "input",
      messageCount: 2,
      createdAt: "2026-10-06T12:00:57.196Z",
    });
    ledger.observe(reader.poll(), 1016);
    const record = ledger.record("S1");

    assert.equal(
      record?.verdict,
      "pending" as Verdict,
      `host plumbing must never satisfy acceptance; got: ${JSON.stringify(record)}`
    );
    assert.ok(
      (record?.detail ?? "").includes("host_injected"),
      `the refusal must name the reason; got: ${record?.detail}`
    );
  });

  it("does not accept a user message whose text differs from the submitted stimulus", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    writeRound(loc, {
      index: 1,
      parent: "e0",
      text: "something else entirely",
      replyParent: "e1",
      replyIndex: 2,
    });
    ledger.observe(reader.poll(), 1016);

    assert.equal(ledger.record("S1")?.verdict, "pending" as Verdict);
  });
});

describe("acceptance — per-stimulus ledger", () => {
  it("keeps an outstanding verification when the next stimulus becomes due", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    ledger.markSent("S2", 2000);

    const records = ledger.records();
    assert.equal(
      records.length,
      2,
      "each stimulus owns its own record; the old driver had ONE slot"
    );
    assert.deepEqual(
      records.map((r) => r.tag),
      ["S1", "S2"]
    );
    assert.equal(records[0]?.sent_at_ms, 1000);
    assert.equal(records[1]?.sent_at_ms, 2000);
    assert.equal(records[0]?.verdict, "pending");
    assert.equal(records[1]?.verdict, "pending");
  });

  it("refuses a second Enter for an already-sent stimulus (no blind resend)", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);

    assert.equal(
      ledger.markSent("S1", 1000),
      true,
      "the first submit is allowed"
    );
    assert.equal(
      ledger.markSent("S1", 45000),
      false,
      `a 45s-later resend must be refused; got: ${JSON.stringify(ledger.record("S1"))}`
    );
    assert.equal(
      ledger.record("S1")?.sent_at_ms,
      1000,
      "sent_at must stay at the first submission"
    );

    writeRound(loc, {
      index: 1,
      parent: "e0",
      text: S1.text,
      replyParent: "e1",
      replyIndex: 2,
    });
    ledger.observe(reader.poll(), 1016);
    assert.equal(ledger.record("S1")?.verdict, "accepted");
    assert.equal(
      ledger.markSent("S1", 99000),
      false,
      "an accepted input is never submitted again"
    );
    assert.equal(ledger.record("S1")?.sent_at_ms, 1000);
  });

  it("classifies a busy refusal explicitly instead of discarding the stimulus", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger } = makeLedger(loc);
    ledger.markSent("S2", 2000);
    ledger.markRefused(
      "S2",
      7000,
      "round still running after the bounded settle wait"
    );

    const record = ledger.record("S2");
    assert.equal(record?.verdict, "refused" as Verdict);
    assert.equal(record?.accepted_at_ms, null);
    assert.ok(
      (record?.detail ?? "").includes("bounded settle wait"),
      `the refusal reason must be retained; got: ${record?.detail}`
    );
    assert.ok(
      ledger.records().some((r) => r.tag === "S2"),
      "a refused stimulus stays in the ledger"
    );
  });

  it("records the PRODUCTION-ORDER refusal, where the record was never sent", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger } = makeLedger(loc);
    // The only production caller refuses the stimulus the scheduler could NOT
    // submit (`decideDelivery` returns it from `nextUnsent`), so the record it
    // refuses is by construction one whose `sent_at_ms` is still null. The two
    // tests above both call `markSent` first, which is the branch production
    // never takes — so `refused` was unreachable and a busy round was recorded
    // as `pending` / "not submitted" instead.
    ledger.markRefused(
      "S1",
      7000,
      "still no settled round past the bounded settle wait"
    );

    const record = ledger.record("S1");
    assert.equal(
      record?.sent_at_ms,
      null,
      "the refused stimulus was never submitted"
    );
    assert.equal(
      record?.verdict,
      "refused" as Verdict,
      `a refusal must be recorded even with no send to hang it on; got: ${JSON.stringify(record)}`
    );
    assert.equal(record?.accepted_at_ms, null);
    assert.equal(record?.accepted_event_id, null);
    assert.ok(
      (record?.detail ?? "").includes("bounded settle wait"),
      `the refusal reason must be retained; got: ${record?.detail}`
    );
    assert.ok(
      ledger.records().some((r) => r.tag === "S1"),
      "a refused stimulus stays in the ledger rather than being discarded"
    );
  });

  it("never marks a refused stimulus sent, so it can never be blind-resent", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger } = makeLedger(loc);
    ledger.markRefused(
      "S1",
      7000,
      "still no settled round past the bounded settle wait"
    );

    assert.equal(
      ledger.markSent("S1", 90000),
      false,
      `a refusal is final; got: ${JSON.stringify(ledger.record("S1"))}`
    );
    assert.equal(
      ledger.record("S1")?.sent_at_ms,
      null,
      "nothing may be typed for a stimulus the ledger refused"
    );
    assert.equal(
      ledger.record("S1")?.verdict,
      "refused" as Verdict,
      "a later offer must not downgrade the refusal to pending"
    );
  });

  it("marks a stimulus timed out when no acceptance evidence arrives within its budget", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    ledger.markTimeout(
      "S1",
      31000,
      "no persisted user-message event within acceptTimeoutMs"
    );

    assert.equal(ledger.record("S1")?.verdict, "timeout" as Verdict);
    assert.equal(ledger.record("S1")?.accepted_event_id, null);
  });

  it("propagates an observer error as its own verdict, never as a timeout or a settle", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    ledger.markObserverError("malformed_line at line 12");

    assert.equal(ledger.record("S1")?.verdict, "observer-error" as Verdict);
    assert.equal(
      ledger.record("S1")?.settled_at_ms,
      null,
      "an observer error can never settle a round"
    );
    assert.equal(ledger.hasObserverError, true);
    assert.equal(
      ledger.lifecycleState(),
      "unproven" as const,
      "a broken observer proves nothing"
    );
  });

  it("refuses later submissions after an observer error without clearing the verdict", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    ledger.markObserverError("malformed_line at line 12");

    assert.equal(
      ledger.markSent("S2", 2000),
      false,
      "an observer failure makes every remaining stimulus undeliverable"
    );
    assert.equal(
      ledger.record("S2")?.sent_at_ms,
      null,
      "a stimulus after the fault must remain unsent"
    );
    assert.equal(
      ledger.record("S2")?.verdict,
      "observer-error" as Verdict,
      "a later send attempt must not overwrite the observer-error verdict"
    );
    assert.equal(
      ledger.record("S2")?.detail,
      "observer error: malformed_line at line 12",
      "the first observer failure remains available for diagnosis"
    );
    assert.equal(ledger.hasObserverError, true);
  });
});

describe("acceptance — the idle predicate comes from the persisted lifecycle", () => {
  it('is idle only after a `boundary:"terminal"` record is observed', () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    writeRound(loc, {
      index: 1,
      parent: "e0",
      text: S1.text,
      replyParent: "e1",
      replyIndex: 2,
    });
    ledger.observe(reader.poll(), 1016);

    assert.equal(
      ledger.lifecycleState(),
      "idle" as const,
      "a terminal boundary is the idle signal"
    );
    assert.equal(ledger.idleProven, true);
  });

  it("is NOT idle after sustained quiet with only tool_batch boundaries", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    appendUser({ loc, index: 1, parent: "e0", text: S1.text });
    appendNativeState({
      loc,
      anchorEventId: "e1",
      boundary: "input",
      messageCount: 2,
      createdAt: "2026-10-06T12:00:57.196Z",
    });
    for (let i = 0; i < 4; i++) {
      appendNativeState({
        loc,
        anchorEventId: "e1",
        boundary: "tool_batch",
        messageCount: 3 + i,
        createdAt: "2026-10-06T12:00:58.000Z",
      });
    }
    ledger.observe(reader.poll(), 900_000);

    assert.equal(
      ledger.lifecycleState(),
      "running" as const,
      "tool_batch is internal activity, not a settle"
    );
    assert.equal(
      ledger.idleProven,
      false,
      "9 minutes of quiet with no terminal boundary is NOT idle"
    );
    assert.equal(ledger.record("S1")?.settled_at_ms, null);
  });

  it("is unproven before any boundary is observed", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger } = makeLedger(loc);

    assert.equal(ledger.lifecycleState(), "unproven" as const);
    assert.equal(
      ledger.idleProven,
      false,
      "idle cannot be claimed from an empty observation"
    );
    assert.equal(
      ledger.busy,
      false,
      "an unproven lifecycle blocks no first submission"
    );
  });

  it("stays busy when one poll carries round N's terminal AND round N+1's input", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);
    // Round N returns control (terminal), and the NEXT round's input boundary
    // is published before the poll that carries both is folded in. The store
    // wrote them in THAT order, so the host is mid-round again: resolving the
    // pair by priority (terminal beats input) fabricates an idle state the
    // store never reached, and the runner would then submit into a busy
    // composer and could decide `/quit` mid-round.
    ledger.markSent("S1", 1000);
    const reply = appendAssistant({
      loc,
      index: 1,
      parent: "e0",
      text: "ack",
    });
    appendNativeState({
      loc,
      anchorEventId: reply.id,
      boundary: "terminal",
      messageCount: 2,
      createdAt: "2026-10-06T12:01:02.926Z",
    });
    ledger.markSent("S2", 2000);
    const next = appendUser({
      loc,
      index: 2,
      parent: reply.id,
      text: S2.text,
    });
    appendNativeState({
      loc,
      anchorEventId: next.id,
      boundary: "input",
      messageCount: 3,
      createdAt: "2026-10-06T12:01:20.000Z",
    });
    ledger.observe(reader.poll(), 2100);

    assert.equal(
      ledger.busy,
      true,
      "the LAST boundary in record order is `input`, so a round is in flight"
    );
    assert.equal(
      ledger.lifecycleState(),
      "running" as const,
      "a terminal boundary that a later input overtook is not idle"
    );
    assert.equal(
      ledger.idleProven,
      false,
      "idle may only be claimed from a terminal that nothing overtook"
    );
  });

  it("reports busy while the last boundary is an input or tool_batch publication", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    appendUser({ loc, index: 1, parent: "e0", text: S1.text });
    appendNativeState({
      loc,
      anchorEventId: "e1",
      boundary: "input",
      messageCount: 2,
      createdAt: "2026-10-06T12:00:57.196Z",
    });
    ledger.observe(reader.poll(), 1016);

    assert.equal(ledger.busy, true);
    assert.equal(
      ledger.record("S1")?.verdict,
      "accepted" as Verdict,
      "acceptance precedes settlement"
    );
    assert.equal(ledger.record("S1")?.settled_at_ms, null);
    assert.equal(ledger.allSettled(), false);
  });
});

describe("classifyAcceptance — pure verdict", () => {
  it("returns pending for an empty poll and accepted only with the full chain", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { ledger, reader } = makeLedger(loc);
    ledger.markSent("S1", 1000);
    writeRound(loc, {
      index: 1,
      parent: "e0",
      text: S1.text,
      replyParent: "e1",
      replyIndex: 2,
    });
    const withData = reader.poll();
    const empty = reader.poll();
    const record = ledger.record("S1")!;

    assert.equal(
      classifyAcceptance(record, empty, 1016).verdict,
      "pending" as Verdict
    );

    const verdict = classifyAcceptance(record, withData, 1016);
    assert.equal(verdict.verdict, "accepted" as Verdict);
    assert.equal(verdict.accepted_event_id, "e1");
    assert.equal(verdict.input_anchor, "e1");
    assert.equal(verdict.settled_anchor, "e2");
    assert.equal(verdict.settled_at_ms, 1016);
  });

  it("holds the record at pending while the message exists but the input boundary has not landed", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const { reader } = makeLedger(loc);
    appendUser({ loc, index: 1, parent: "e0", text: S1.text });
    const poll = reader.poll();
    const verdict = classifyAcceptance(pendingRecord(S1), poll, 1016);

    assert.equal(verdict.verdict, "pending" as Verdict);
    assert.equal(
      verdict.accepted_event_id,
      "e1",
      "the message was seen; the boundary has not"
    );
    assert.ok(
      (verdict.detail ?? "").includes("input_boundary"),
      `the wait must name the missing evidence; got: ${verdict.detail}`
    );
  });
});

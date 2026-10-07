/**
 * Contract tests for `scripts/eval/tui/session-store-reader.ts` (#1219).
 *
 * WHY: acceptance and idleness are decided from the PERSISTED session store,
 * and the store has four traps that each produced a wrong answer historically:
 *  - 176 of 386 user-role records are `hostInjected` host plumbing, so a text
 *    prefix match alone accepts an echo that the human never typed;
 *  - sub-agent transcripts are real `.jsonl` files under the measured
 *    conversation (the S4 false positive);
 *  - an incomplete trailing line is a normal mid-append state and must be
 *    waited on, while a malformed COMPLETE line is an OBSERVER ERROR — never a
 *    quiet terminal, which would read as "idle";
 *  - `operation_fact.turnId` is a UUID and `outcome.turnId` is a message event
 *    id, so keying on `turnId` alone conflates two namespaces.
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ObserverError,
  SessionTailReader,
  census,
  isInputBoundary,
  isRealUserMessage,
  isSubagentSessionPath,
  isTerminalBoundary,
  listSessionFiles,
  messageText,
  takeBaseline,
  validateWholeFile,
} from "../../../../scripts/eval/tui/session-store-reader.ts";
import {
  appendAssistant,
  appendNativeState,
  appendOperationFact,
  appendOutcome,
  appendPartial,
  appendRaw,
  appendUser,
  initStore,
  initSubagentStore,
  storeIsProductionValid,
  storePath,
  subagentPath,
  type FixtureLocation,
} from "./fixture.ts";

const roots: string[] = [];

function makeLoc(): FixtureLocation {
  const root = mkdtempSync(join(tmpdir(), "iknow-store-reader-"));
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

/** Append raw BYTES. A byte-level split inside a character cannot survive a
 *  trip through a UTF-8 string, so the fixture's `appendPartial` is unusable
 *  here and the file must be extended at the byte level. */
function appendBytes(loc: FixtureLocation, bytes: Buffer): void {
  const path = storePath(loc);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, bytes);
}

/** One production-shaped `message` line, as the bytes the store holds. */
function messageLineBytes(text: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      type: "message",
      id: "e1",
      parent: "e0",
      message: { role: "user", content: [{ type: "text", text }] },
      createdAt: "2026-10-06T12:00:56.459Z",
    })}\n`,
    "utf8"
  );
}

describe("store paths — sub-agent transcripts are not the measured conversation", () => {
  it("excludes every sub-agent path from the conversation file list", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    initSubagentStore(loc, "55a91052-0000-4000-8000-000000000001", "sub work");
    initSubagentStore(
      loc,
      "def90f06-0000-4000-8000-000000000002",
      "sub work 2"
    );

    const files = listSessionFiles(loc);

    assert.deepEqual(
      files,
      [storePath(loc)],
      `only the measured conversation may be listed; got: ${JSON.stringify(files)}`
    );
    assert.ok(
      isSubagentSessionPath(
        subagentPath(loc, "55a91052-0000-4000-8000-000000000001")
      ),
      "a path under <conv>/subagents/<uuid>/ must be recognized as a sub-agent transcript"
    );
    assert.ok(
      !isSubagentSessionPath(storePath(loc)),
      `the measured conversation must not be classified as a sub-agent transcript: ${storePath(loc)}`
    );
  });

  it("takes a baseline of an absent store without throwing (first input has no file yet)", () => {
    const loc = makeLoc();
    const baseline = takeBaseline(loc);

    assert.equal(baseline.byteOffset, 0);
    assert.deepEqual(baseline.eventIds, []);
    assert.equal(baseline.headId, null);
    assert.ok(
      !existsSync(storePath(loc)),
      "the baseline must not create the session file it measured"
    );
  });
});

describe("SessionTailReader — the hostInjected guard", () => {
  it("accepts a real user message and rejects a host-injected pseudo-user turn", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    appendUser({
      loc,
      index: 1,
      text: "seed",
      parent: "e0",
      hostInjected: true,
    });
    appendUser({ loc, index: 2, text: "second stimulus", parent: "e1" });
    const poll = reader.poll();

    const real = poll.messages.filter((m) => isRealUserMessage(m));
    assert.equal(
      real.length,
      1,
      `expected exactly one real user message; got: ${JSON.stringify(poll.messages.map(messageText))}`
    );
    assert.equal(messageText(real[0]!), "second stimulus");
    assert.equal(
      messageText(poll.messages.find((m) => m.id === "e1")!),
      "seed",
      "the host-injected turn is still a record; it is excluded from acceptance, not deleted"
    );
  });

  it("rejects a real user message whose id was already in the baseline", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const baseline = takeBaseline(loc);
    const reader = new SessionTailReader({ location: loc, baseline });

    assert.ok(
      baseline.eventIds.includes("e0"),
      `the baseline must hold e0; got: ${JSON.stringify(baseline.eventIds)}`
    );
    appendUser({ loc, index: 1, text: "brand new", parent: "e0" });
    const poll = reader.poll();
    const seen = new Set(baseline.eventIds);

    assert.equal(
      poll.messages.length,
      1,
      "only the post-baseline record is yielded"
    );
    assert.equal(
      isRealUserMessage(poll.messages[0]!, seen),
      true,
      "a new id relative to the baseline is accepted"
    );

    // The baseline record itself is still a real user message as a shape, but it
    // must not read as acceptance when its id is in the baseline set.
    const seeded = validateWholeFile(storePath(loc)).records.find(
      (r) => r.type === "message" && r.id === "e0"
    );
    assert.ok(
      seeded !== undefined,
      "the seeded e0 record must be readable from the file"
    );
    assert.equal(
      isRealUserMessage(seeded, seen),
      false,
      "an id that was already persisted at baseline time cannot be new acceptance"
    );
  });

  it("tolerates a record with `createdAt: null` (an abandoned-branch record)", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    appendUser({
      loc,
      index: 1,
      text: "null stamped",
      parent: "e0",
      createdAt: null,
    });
    const poll = reader.poll();

    assert.equal(poll.messages.length, 1);
    assert.equal(
      poll.error,
      null,
      `a null createdAt is legal; got: ${JSON.stringify(poll.error)}`
    );
    assert.equal(messageText(poll.messages[0]!), "null stamped");
  });
});

describe("SessionTailReader — boundary predicates", () => {
  it("separates the acceptance boundary from the idle boundary", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    appendUser({ loc, index: 1, text: "S1", parent: "e0" });
    appendNativeState({
      loc,
      anchorEventId: "e1",
      boundary: "input",
      messageCount: 2,
      createdAt: "2026-10-06T12:00:57.196Z",
    });
    appendNativeState({
      loc,
      anchorEventId: "e1",
      boundary: "tool_batch",
      messageCount: 2,
      createdAt: "2026-10-06T12:00:57.500Z",
    });
    appendAssistant({ loc, index: 2, text: "reply", parent: "e1" });
    appendNativeState({
      loc,
      anchorEventId: "e2",
      boundary: "terminal",
      messageCount: 3,
      createdAt: "2026-10-06T12:00:59.900Z",
    });
    appendOutcome({ loc, turnId: "e2", stopReason: "completed" });
    const poll = reader.poll();

    assert.deepEqual(poll.inputAnchors, ["e1"]);
    assert.deepEqual(
      poll.terminalAnchors,
      ["e2"],
      "a tool_batch boundary must never read as idle"
    );
    assert.equal(poll.headId, "e2");
    assert.equal(poll.outcomes.length, 1);
    assert.equal(poll.outcomes[0]!.turnId, "e2");
    assert.ok(
      poll.records.some((r) => isTerminalBoundary(r) && !isInputBoundary(r)),
      "the terminal record must satisfy only the idle predicate"
    );
  });

  it("keeps the two disjoint turnId namespaces apart in the census", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    appendUser({ loc, index: 1, text: "S1", parent: "e0" });
    appendOperationFact({
      loc,
      anchorEventId: "e1",
      turnId: "4ae5b136-1cb8-4f84-82cc-e9261909cd9e",
    });
    appendAssistant({ loc, index: 2, text: "reply", parent: "e1" });
    appendOutcome({ loc, turnId: "e2" });
    const poll = reader.poll();
    const counts = census(poll.records);

    assert.equal(counts.operation_fact, 1);
    assert.equal(counts.outcome, 1);
    const fact = poll.records.find((r) => r.type === "operation_fact");
    const outcome = poll.records.find((r) => r.type === "outcome");
    assert.ok(
      fact !== undefined && outcome !== undefined,
      "both record kinds must be retained"
    );
    assert.notEqual(
      fact.turnId,
      outcome.turnId,
      "the UUID fact turnId and the message-event outcome turnId must stay distinguishable"
    );
  });
});

describe("SessionTailReader — observer errors never degrade to idle", () => {
  it("throws ObserverError on a malformed COMPLETE line", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    appendRaw(loc, '{"type":"head","id":"e0"');

    const poll = reader.poll();
    assert.ok(
      poll.error instanceof ObserverError,
      `a malformed complete line must be an ObserverError; got: ${JSON.stringify(poll.error)}`
    );
    assert.equal(poll.error?.kind, "malformed_line");
    assert.equal(
      poll.terminalAnchors.length,
      0,
      "an observer error must not be observable as a settled round"
    );
    assert.throws(
      () => reader.poll(),
      ObserverError,
      "the error is sticky: a later poll must not silently pass"
    );
  });

  it("waits on an incomplete trailing line instead of erroring", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    appendPartial(loc, '{"type":"message","id":"e1","par');

    const poll = reader.poll();
    assert.equal(
      poll.error,
      null,
      `an incomplete trailing line is a normal mid-append state; got: ${JSON.stringify(poll.error)}`
    );
    assert.equal(
      poll.pendingTailBytes > 0,
      true,
      "the partial bytes must be retained for the next poll"
    );
    assert.equal(poll.messages.length, 0);
  });

  it("reads the completed line on the poll after the partial write", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    appendPartial(
      loc,
      '{"type":"message","id":"e1","parent":"e0","message":{"role":"user",'
    );
    assert.equal(reader.poll().messages.length, 0);
    appendPartial(
      loc,
      '"content":[{"type":"text","text":"S1"}]},"createdAt":"2026-10-06T12:00:56.459Z"}\n'
    );
    const poll = reader.poll();

    assert.equal(poll.error, null);
    assert.equal(messageText(poll.messages[0]!), "S1");
  });

  it("reports a structurally invalid record as an ObserverError, not a quiet store", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    appendRaw(
      loc,
      JSON.stringify({
        type: "message",
        id: "not-an-event-id",
        parent: "e0",
        message: { role: "user", content: [] },
      })
    );

    const poll = reader.poll();
    assert.ok(
      poll.error instanceof ObserverError,
      `expected an ObserverError for a bad event id; got: ${JSON.stringify(poll.error)}`
    );
    assert.equal(poll.error?.kind, "schema_invalid");
  });

  it("reports a read failure as an ObserverError (a directory in place of the store)", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const path = storePath(loc);
    rmSync(path, { force: true });
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });
    mkdirSync(path, { recursive: true });

    const poll = reader.poll();
    assert.ok(
      poll.error instanceof ObserverError,
      `expected an ObserverError on read failure; got: ${JSON.stringify(poll.error)}`
    );
    assert.equal(poll.error?.kind, "read_failed");
  });
});

describe("SessionTailReader — an absent store is not yet, not a fault", () => {
  it("polls an absent store without latching an observer error", () => {
    const loc = makeLoc();
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    // The product creates the conversation file LAZILY, on the first message,
    // and the harness polls before any stimulus is typed. That first poll finds
    // no file at all, which `takeBaseline` already models as a legal zero
    // baseline; latching it as a fatal observer error would abort the run and
    // make first-input acceptance unverifiable.
    const first = reader.poll();

    assert.equal(
      first.error,
      null,
      `an absent store is a pre-first-input state, not a fault; got: ${JSON.stringify(first.error)}`
    );
    assert.equal(
      first.exists,
      false,
      "the poll must report that no store file exists yet"
    );
    assert.equal(
      first.records.length,
      0,
      "there is nothing persisted to yield before the first message"
    );
    assert.equal(first.terminalAnchors.length, 0);

    const second = reader.poll();
    assert.equal(
      second.error,
      null,
      "absence must not latch: a repeated poll before the file appears stays clean"
    );
    assert.equal(second.exists, false);
  });

  it("reads the records of a store that appears after the first poll", () => {
    const loc = makeLoc();
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });
    assert.equal(reader.poll().exists, false, "the harness polls first");

    // Exactly what the product does on the first message: the file is created
    // with the accepted turn, and the acceptance boundary lands off-chain.
    initStore(loc, "first stimulus");
    appendNativeState({
      loc,
      anchorEventId: "e0",
      boundary: "input",
      messageCount: 1,
      createdAt: "2026-10-06T12:00:57.196Z",
    });
    const poll = reader.poll();

    assert.equal(
      poll.error,
      null,
      `a store that appears later must read normally; got: ${JSON.stringify(poll.error)}`
    );
    assert.equal(
      poll.exists,
      true,
      "the store exists once the writer has created it"
    );
    assert.equal(poll.messages.length, 1);
    assert.equal(messageText(poll.messages[0]!), "first stimulus");
    assert.deepEqual(
      poll.inputAnchors,
      ["e0"],
      "the lazily created store must still yield its acceptance boundary"
    );
  });

  it("still latches a real read failure, so the absence carve-out cannot swallow it", () => {
    const loc = makeLoc();
    const path = storePath(loc);
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });
    // EISDIR, not ENOENT: the path EXISTS and is unreadable as a file, which is
    // a broken observer rather than a conversation the writer has yet to create.
    mkdirSync(path, { recursive: true });

    const poll = reader.poll();
    assert.ok(
      poll.error instanceof ObserverError,
      `expected an ObserverError on a real read failure; got: ${JSON.stringify(poll.error)}`
    );
    assert.equal(poll.error?.kind, "read_failed");
    assert.throws(
      () => reader.poll(),
      ObserverError,
      "a real read failure stays latched: every later poll throws"
    );
  });
});

describe("SessionTailReader — a character split across two reads", () => {
  it("decodes a multi-byte character split at EOF in context, never as U+FFFD", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    // CJK message text is the normal case here, and the writer appends a line
    // without knowing where the reader will next read: the read boundary can
    // land INSIDE a character. The reader must then re-read the continuation
    // bytes, because a half-decoded character is a permanent, silent
    // corruption of the very text acceptance matches on.
    const line = messageLineBytes("你好");
    const textAt = line.indexOf(Buffer.from("你好", "utf8"));
    assert.ok(textAt > 0, "the CJK text must be locatable in the line");
    // 你 = E4 BD A0, 好 = E5 A5 BD: cut one byte into the final 好, so only E5
    // has landed and A5 BD are still to come.
    const cut = textAt + 4;

    appendBytes(loc, line.subarray(0, cut));
    const partial = reader.poll();

    assert.equal(
      partial.error,
      null,
      `an incomplete trailing line is a normal mid-append state; got: ${String(partial.error)}`
    );
    assert.equal(partial.messages.length, 0);
    assert.ok(
      partial.pendingTailBytes > 0,
      "the partial bytes must be retained for the next poll"
    );

    appendBytes(loc, line.subarray(cut));
    const complete = reader.poll();

    assert.equal(
      complete.error,
      null,
      `a character split across two reads must never become a malformed_line; got: ${String(complete.error)}`
    );
    assert.equal(
      complete.messages.length,
      1,
      `the completed line must be decoded exactly once; got: ${JSON.stringify(complete.messages.map(messageText))}`
    );
    const decoded = messageText(complete.messages[0]!);
    assert.equal(
      decoded,
      "你好",
      `the text must survive the split byte-for-byte; got: ${JSON.stringify(decoded)}`
    );
    assert.ok(
      !decoded.includes("\ufffd"),
      `a split character must never decode as U+FFFD; got: ${JSON.stringify(decoded)}`
    );
    assert.equal(
      complete.pendingTailBytes,
      0,
      "the whole line must have been ingested, tail included"
    );
  });

  it("keeps a split character out of a partially-read line without re-reading it", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const reader = new SessionTailReader({
      location: loc,
      baseline: takeBaseline(loc),
    });

    // Same split, but the rest never arrives: the line stays an incomplete
    // trailing line. Reading it twice (once per poll) would corrupt the text a
    // second time, so the count of decoded messages is the real assertion.
    const line = messageLineBytes("你好");
    const textAt = line.indexOf(Buffer.from("你好", "utf8"));
    appendBytes(loc, line.subarray(0, textAt + 4));

    const first = reader.poll();
    const second = reader.poll();

    assert.equal(first.error, null);
    assert.equal(second.error, null, String(second.error));
    assert.equal(first.messages.length, 0);
    assert.equal(
      second.messages.length,
      0,
      "an incomplete line is never decoded, let alone decoded twice"
    );
    assert.equal(
      second.pendingTailBytes,
      textAt + 4,
      "the retained tail must be the exact undecoded byte count"
    );
  });
});

describe("validateWholeFile — the retained store is production-valid", () => {
  it("accepts a fixture built through the production serializer and appends", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    appendUser({ loc, index: 1, text: "S1", parent: "e0" });
    appendNativeState({
      loc,
      anchorEventId: "e1",
      boundary: "input",
      messageCount: 2,
      createdAt: "2026-10-06T12:00:57.196Z",
    });
    appendAssistant({ loc, index: 2, text: "reply", parent: "e1" });
    appendNativeState({
      loc,
      anchorEventId: "e2",
      boundary: "terminal",
      messageCount: 3,
      createdAt: "2026-10-06T12:00:59.900Z",
    });
    appendOutcome({ loc, turnId: "e2" });

    const checked = storeIsProductionValid(storePath(loc));
    assert.ok(
      checked.ok,
      `the fixture must satisfy the production parser; got: ${checked.detail}`
    );
    const result = validateWholeFile(storePath(loc));
    assert.equal(
      result.error,
      null,
      `validateWholeFile must agree with parseSessionJsonl; got: ${JSON.stringify(result.error)}`
    );
    assert.equal(
      result.records.length,
      9,
      `the production parser yields every record after the header: 3 messages (the seeded e0 plus two) + 3 heads + 2 states + 1 outcome; got: ${result.records.length}`
    );
  });

  it("reports the byte offset of the last complete line for the baseline", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const baseline = takeBaseline(loc);

    assert.equal(baseline.byteOffset, statSync(storePath(loc)).size);
    assert.ok(
      baseline.lineCount >= 3,
      `header + message + head; got: ${baseline.lineCount}`
    );
    assert.deepEqual(baseline.eventIds, ["e0"]);
    assert.equal(baseline.headId, "e0");
  });

  it("does not advance the baseline offset past an incomplete trailing line", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    appendPartial(loc, '{"type":"head","id":"e0"}');

    const baseline = takeBaseline(loc);
    assert.ok(
      baseline.byteOffset < statSync(storePath(loc)).size,
      "the baseline offset must cover complete lines only, so the partial tail is re-read"
    );
  });

  it("keeps the sub-agent transcript out of the measured store file", () => {
    const loc = makeLoc();
    initStore(loc, "seed");
    const sub = initSubagentStore(
      loc,
      "55a91052-0000-4000-8000-000000000001",
      "sub"
    );

    assert.notEqual(sub, storePath(loc));
    assert.ok(
      !readFileSync(storePath(loc), "utf8").includes("sub"),
      "a sub-agent write must not land in the measured conversation"
    );
  });
});

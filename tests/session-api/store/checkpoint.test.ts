/**
 * T1 checkpoint data layer tests — turn boundary projection, persistence
 * predicate, checkpoint appender + rewindFile (pure functions). Mirrors the
 * `projectMessagesToTurns` turn-slice boundary in hub.ts (skips user messages
 * that carry tool_result blocks when projecting turn starts).
 *
 * Six-path coverage (per test.md): happy / failure / boundary / empty-invalid /
 * concurrency (where applicable) — authorization is not a concept in this pure
 * data layer; concurrency reduces to immutability verification
 * (appendCheckpoint must not mutate its inputs).
 *
 * #120 discipline carries over: sanitize never repairs messages; for the
 * derived `checkpoints` field we follow the same load-then-normalize boundary.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type {
  AnthropicNativeMessage,
  RunResult,
  StopReason,
  TokenUsage,
} from "../../../src/harness/index.ts";
import {
  CURRENT_SCHEMA_VERSION,
  extractTitle,
  sanitizeSessionFile,
  type CheckpointRecord,
  type InterruptReason,
  type SessionFileV1,
} from "../../../src/session-api/store/index.ts";
import {
  appendCheckpoint,
  decideCheckpointPersist,
  resolveRewindAnchor,
  shouldPersistCheckpoint,
  splitTurns,
  toInterruptReason,
  turnSliceEnd,
  withCheckpointAnchors,
} from "../../../src/session-api/store/index.ts";

// -- fixtures -----------------------------------------------------------------

const text = (t: string) => ({ type: "text" as const, text: t });
const toolUse = (id: string, name: string, input: unknown) =>
  ({
    type: "tool_use" as const,
    id,
    name,
    input,
  }) as const;
const toolResult = (tool_use_id: string, is_error?: boolean) =>
  ({
    type: "tool_result" as const,
    tool_use_id,
    content: "ok",
    ...(is_error !== undefined ? { is_error } : {}),
  }) as const;

const userMsg = (...texts: string[]): AnthropicNativeMessage => ({
  role: "user",
  content: texts.map((t) => text(t)),
});
const userToolResult = (id: string): AnthropicNativeMessage => ({
  role: "user",
  content: [toolResult(id)],
});
const assistantMsg = (
  blocks: ReadonlyArray<ReturnType<typeof text> | ReturnType<typeof toolUse>>
): AnthropicNativeMessage => ({
  role: "assistant",
  content: blocks as AnthropicNativeMessage["content"],
});
// system-interruption message helper (append-only; used as rewind-anchor test fixture)
const systemMsg = (body: string): AnthropicNativeMessage => ({
  role: "system",
  content: [{ type: "text", text: body }],
});

/** Anchor used to build a v3 SessionFileV1 in tests. Spread overrides fields. */
const baseFile = (): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: "conv-cp",
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  title: "",
  cwd: "",
  sanitized_at: "2026-01-01T00:00:00.000Z",
  checkpoints: [],
});

/** Minimal RunResult builder with sensible defaults. */
const buildResult = (opts: {
  readonly stopReason: StopReason;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly turnCount?: number;
  readonly lastUsage?: TokenUsage | null;
}): RunResult => ({
  finalText: null,
  messages: opts.messages,
  turnCount: opts.turnCount ?? 1,
  stopReason: opts.stopReason,
  lastUsage: opts.lastUsage ?? null,
});

const ISO = "2026-08-11T00:00:00.000Z";

// -- splitTurns (turn boundary projection) -------------------------------------

describe("splitTurns — turn boundary projection", () => {
  // happy path
  it("returns one slice per non-tool_result user message", () => {
    const messages = [userMsg("q1"), assistantMsg([text("a1")])];
    assert.deepEqual(
      splitTurns(messages).map((s) => ({ start: s.start, end: s.end })),
      [{ start: 0, end: 2 }]
    );
  });

  it("returns empty array when there are no messages", () => {
    assert.deepEqual(splitTurns([]), []);
  });

  it("skips tool_result user messages when delineating turns", () => {
    // [user(q1), assistant(tool_use t1), user(tool_result t1), assistant(text), user(q2), assistant(a2)]
    // turn0 = [0,4)  turn1 = [4,6)
    const messages = [
      userMsg("q1"),
      assistantMsg([toolUse("t1", "read_file", {})]),
      userToolResult("t1"),
      assistantMsg([text("done")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
    ];
    const slices = splitTurns(messages);
    assert.equal(slices.length, 2);
    assert.equal(slices[0]!.start, 0);
    assert.equal(slices[0]!.end, 4);
    assert.equal(slices[1]!.start, 4);
    assert.equal(slices[1]!.end, 6);
  });

  it("skips subagent drain user messages when delineating turns", () => {
    // [user(q1), assistant(a1), user(drain), assistant(ack), user(q2), assistant(a2)]
    // drain messages are not turn boundaries (same source rule as hub.ts
    // projectMessagesToTurns): turn0 = [0,4)  turn1 = [4,6)
    const messages = [
      userMsg("q1"),
      assistantMsg([text("a1")]),
      userMsg("## Sub-agent task_1 result: sum\n\nresult body"),
      assistantMsg([text("ack")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
    ];
    const slices = splitTurns(messages);
    assert.equal(slices.length, 2);
    assert.equal(slices[0]!.start, 0);
    assert.equal(slices[0]!.end, 4);
    assert.equal(slices[1]!.start, 4);
    assert.equal(slices[1]!.end, 6);
  });

  it("returns [] when only drain user messages exist (no real query)", () => {
    const messages = [
      userMsg("## Sub-agent task_1 result: sum\n\nresult body"),
      assistantMsg([text("ack")]),
    ];
    assert.equal(splitTurns(messages).length, 0);
  });

  it("groups multiple tool cycles inside a single turn", () => {
    // [user(q), assistant(tool_use t1), user(tool_result t1),
    //  assistant(tool_use t2), user(tool_result t2), assistant(text)]
    // All inside one turn (only one non-tool_result user message).
    const messages = [
      userMsg("q"),
      assistantMsg([toolUse("t1", "noop", {})]),
      userToolResult("t1"),
      assistantMsg([toolUse("t2", "noop", {})]),
      userToolResult("t2"),
      assistantMsg([text("final")]),
    ];
    assert.equal(splitTurns(messages).length, 1);
  });

  // boundary — tool_result group with no preceding query
  it("treats leading tool_result user messages as a preamble (own slice, not a turn)", () => {
    // [user(tool_result t1), assistant(text)] — malformed, but defined behavior.
    // No non-tool_result user message → no turns. We document splitTurns as
    // returning [] for this edge; rewindFile relies on turnSliceEnd + counts.
    const messages = [userToolResult("t1"), assistantMsg([text("orphan")])];
    assert.equal(splitTurns(messages).length, 0);
  });

  // empty/invalid input — only assistant messages, no queries
  it("returns [] when no non-tool_result user message exists", () => {
    const messages = [
      userToolResult("t1"),
      assistantMsg([text("a")]),
      assistantMsg([text("b")]),
    ];
    assert.equal(splitTurns(messages).length, 0);
  });

  // an interleaved system interruption message must not shift turn slices
  it("does not let an interleaved system message shift turn boundaries", () => {
    // Real interruption shape: user(q1) → assistant(tool_use) → user(tool_result) →
    // assistant(text), then append system("Interrupted by user."), then user(q2).
    // system is not a turn — splitTurns slices only on role==="user" minus tool_result.
    const messages = [
      userMsg("q1"),
      assistantMsg([toolUse("t1", "read_file", {})]),
      userToolResult("t1"),
      assistantMsg([text("done")]),
      systemMsg("Interrupted by user."),
      userMsg("q2"),
      assistantMsg([text("a2")]),
    ];
    const slices = splitTurns(messages);
    assert.equal(slices.length, 2);
    // turn0 should span past the system entry: start 0 → end 5 (system sits in the [4,5) gap, not part of slicing)
    assert.equal(slices[0]!.start, 0);
    assert.equal(slices[0]!.end, 5);
    assert.equal(slices[1]!.start, 5);
    assert.equal(slices[1]!.end, 7);
  });

  it("keeps the interrupt system message as the final element (append-only tail)", () => {
    // interruption happens after the last turn → system sits at the tail; slices contain only the existing turns
    const messages = [
      userMsg("q1"),
      assistantMsg([text("a1")]),
      systemMsg("Interrupted by user."),
    ];
    const slices = splitTurns(messages);
    assert.equal(slices.length, 1);
    assert.equal(slices[0]!.start, 0);
    // The only query starts at index 0 and its end extends to the tail (assistant + system
    // included), but turn slices are located by query only — system introduces no new turn.
    assert.equal(slices[0]!.end, 3);
    // system is the last element and belongs to no turn slice
    const last = messages[messages.length - 1]!;
    assert.equal(last.role, "system");
  });
});

describe("turnSliceEnd — exclusive end index of a turn", () => {
  it("returns the index of the next non-tool_result user message", () => {
    const messages = [
      userMsg("q1"),
      assistantMsg([text("a1")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
    ];
    assert.equal(turnSliceEnd(messages, 0), 2);
    assert.equal(turnSliceEnd(messages, 1), 4);
  });

  it("returns messages.length when the turn runs to the end", () => {
    const messages = [userMsg("q1"), assistantMsg([text("a1")])];
    assert.equal(turnSliceEnd(messages, 0), 2);
  });

  it("returns messages.length when turnIndex is beyond available turns (clamp)", () => {
    const messages = [userMsg("q1"), assistantMsg([text("a1")])];
    assert.equal(turnSliceEnd(messages, 5), 2);
  });

  it("returns 0 for a negative turnIndex (clamp)", () => {
    const messages = [userMsg("q1"), assistantMsg([text("a1")])];
    assert.equal(turnSliceEnd(messages, -1), 0);
  });

  // empty input
  it("returns 0 for empty messages + any turnIndex", () => {
    assert.equal(turnSliceEnd([], 0), 0);
    assert.equal(turnSliceEnd([], 3), 0);
  });
});

// -- shouldPersistCheckpoint (predicate matrix) --------------------------------

describe("shouldPersistCheckpoint — predicate matrix", () => {
  const prior: AnthropicNativeMessage[] = [];

  // cancelled + delta
  it("cancelled + delta>0 (new messages) → persist", () => {
    const result = buildResult({
      stopReason: "cancelled",
      messages: [userMsg("will be cancelled")], // delta 1 vs prior []
    });
    assert.equal(shouldPersistCheckpoint(result, prior), true);
  });

  it("cancelled + delta==0 (no new messages) → do NOT persist", () => {
    const result = buildResult({
      stopReason: "cancelled",
      messages: [], // delta 0 vs prior []
      turnCount: 0,
    });
    assert.equal(shouldPersistCheckpoint(result, prior), false);
  });

  // failure path — protocolError / emptyFinalResponse never persist (existing production ruling)
  it("protocolError → do NOT persist", () => {
    const result = buildResult({
      stopReason: "protocolError",
      messages: [],
    });
    assert.equal(shouldPersistCheckpoint(result, prior), false);
  });

  it("emptyFinalResponse → do NOT persist", () => {
    const result = buildResult({
      stopReason: "emptyFinalResponse",
      messages: [],
    });
    assert.equal(shouldPersistCheckpoint(result, prior), false);
  });

  // remaining stopReasons → persist
  it("completed → persist", () => {
    const result = buildResult({
      stopReason: "completed",
      messages: [userMsg("q"), assistantMsg([text("a")])],
    });
    assert.equal(shouldPersistCheckpoint(result, prior), true);
  });

  it("timeout → persist", () => {
    const result = buildResult({
      stopReason: "timeout",
      messages: [userMsg("q")],
      turnCount: 0,
    });
    assert.equal(shouldPersistCheckpoint(result, prior), true);
  });

  it("maxTurns → persist (predicate handles it for T2+ wiring)", () => {
    const result = buildResult({
      stopReason: "maxTurns",
      messages: [],
      turnCount: 0,
    });
    assert.equal(shouldPersistCheckpoint(result, prior), true);
  });

  it("nonSuccessStop → persist (continued current behavior)", () => {
    const result = buildResult({
      stopReason: "nonSuccessStop",
      messages: [userMsg("q"), assistantMsg([text("truncated")])],
    });
    assert.equal(shouldPersistCheckpoint(result, prior), true);
  });
});

// -- decideCheckpointPersist (T4 tri-state predicate) --------------------------
//
// Spec invariant 8 / SC4 (transport-continue-persist): protocolError /
// emptyFinalResponse persist the USER message(s) from this turn; the failed
// assistant turn is dropped. Replaces the boolean `shouldPersistCheckpoint`
// (amending the earlier ruling). Cancelled / timeout / completed / maxTurns /
// nonSuccessStop behavior is byte-stable.

describe("decideCheckpointPersist — tri-state predicate (T4)", () => {
  it("cancelled + delta>0 → full", () => {
    const result = buildResult({
      stopReason: "cancelled",
      messages: [userMsg("will be cancelled")], // delta 1 vs prior []
    });
    assert.deepEqual(decideCheckpointPersist(result, []), { kind: "full" });
  });

  it("cancelled + delta==0 → none", () => {
    const result = buildResult({
      stopReason: "cancelled",
      messages: [], // delta 0 vs prior []
      turnCount: 0,
    });
    assert.deepEqual(decideCheckpointPersist(result, []), { kind: "none" });
  });

  it("protocolError with no user delta → none (continue-mode zero delta)", () => {
    // /continue path: model prior starts from priorMessages, appendUserText=false,
    // engine fails before any commit → result.messages === priorMessages.
    const prior: AnthropicNativeMessage[] = [
      userMsg("q"),
      assistantMsg([text("a")]),
    ];
    const result = buildResult({
      stopReason: "protocolError",
      messages: prior, // delta 0
    });
    assert.deepEqual(decideCheckpointPersist(result, prior), { kind: "none" });
  });

  it("protocolError with user delta → partial_user_only (SC4)", () => {
    // postMessage path: engine encoded the user query into state before
    // failing. delta includes the user message; we keep it, drop assistant.
    const prior: AnthropicNativeMessage[] = [];
    const result = buildResult({
      stopReason: "protocolError",
      messages: [userMsg("hello")], // delta 1, user role
    });
    assert.deepEqual(decideCheckpointPersist(result, prior), {
      kind: "partial_user_only",
    });
  });

  it("emptyFinalResponse with user delta → partial_user_only (SC4)", () => {
    const prior: AnthropicNativeMessage[] = [];
    const result = buildResult({
      stopReason: "emptyFinalResponse",
      messages: [userMsg("hi")], // delta 1, user role
    });
    assert.deepEqual(decideCheckpointPersist(result, prior), {
      kind: "partial_user_only",
    });
  });

  it("protocolError with mixed user + assistant delta → partial_user_only (assistant dropped)", () => {
    // Defensive: if for any reason the engine appended an assistant turn
    // alongside the user delta before failing (rare; engine normally omits
    // the failed assistant per `整回合不进历史` — "the whole turn does not
    // enter history"), the predicate still picks
    // partial_user_only and the hub's splice filters out non-user roles.
    const prior: AnthropicNativeMessage[] = [];
    const result = buildResult({
      stopReason: "protocolError",
      messages: [userMsg("q"), assistantMsg([text("partial")])],
    });
    assert.deepEqual(decideCheckpointPersist(result, prior), {
      kind: "partial_user_only",
    });
  });

  it("protocolError with only a tool_result delta → none (no orphan tool_result)", () => {
    // A tool_result-only user message is a continuation, not a query. Writing
    // it without its assistant tool_use would orphan the pair on disk, so the
    // predicate (SSOT isTurnQuery) must not classify it as user delta.
    const prior: AnthropicNativeMessage[] = [userMsg("q")];
    const result = buildResult({
      stopReason: "protocolError",
      messages: [userMsg("q"), userToolResult("t1")],
    });
    assert.deepEqual(decideCheckpointPersist(result, prior), {
      kind: "none",
    });
  });

  it("protocolError with only a subagent drain delta → none (not a user query)", () => {
    // Drain summaries are user-role but not turn queries (isTurnQuery
    // excludes them). Persisting one alone would not be a user sentence.
    const prior: AnthropicNativeMessage[] = [userMsg("q")];
    const result = buildResult({
      stopReason: "protocolError",
      messages: [
        userMsg("q"),
        userMsg("## Sub-agent task_1 result: sum\n\nresult body"),
      ],
    });
    assert.deepEqual(decideCheckpointPersist(result, prior), {
      kind: "none",
    });
  });

  it("completed → full", () => {
    const result = buildResult({
      stopReason: "completed",
      messages: [userMsg("q"), assistantMsg([text("a")])],
    });
    assert.deepEqual(decideCheckpointPersist(result, []), { kind: "full" });
  });

  it("timeout → full (unchanged path)", () => {
    const result = buildResult({
      stopReason: "timeout",
      messages: [userMsg("q")],
      turnCount: 0,
    });
    assert.deepEqual(decideCheckpointPersist(result, []), { kind: "full" });
  });

  it("maxTurns → full", () => {
    const result = buildResult({
      stopReason: "maxTurns",
      messages: [],
      turnCount: 0,
    });
    assert.deepEqual(decideCheckpointPersist(result, []), { kind: "full" });
  });

  it("nonSuccessStop → full", () => {
    const result = buildResult({
      stopReason: "nonSuccessStop",
      messages: [userMsg("q"), assistantMsg([text("truncated")])],
    });
    assert.deepEqual(decideCheckpointPersist(result, []), { kind: "full" });
  });
});

// -- appendCheckpoint ---------------------------------------------------------

describe("appendCheckpoint — appends a record to session.checkpoints", () => {
  // happy path
  it("appends to an empty checkpoints list", () => {
    const session = baseFile();
    const record: CheckpointRecord = {
      turnIndex: 1,
      messagesCount: 2,
      interruptedAt: ISO,
      interruptReason: "cancelled",
    };
    const updated = appendCheckpoint(session, record);
    assert.equal(updated.checkpoints?.length, 1);
    assert.equal(updated.checkpoints?.[0], record);
  });

  it("appends without disturbing prior records (append-only)", () => {
    const session = {
      ...baseFile(),
      checkpoints: [
        {
          turnIndex: 1,
          messagesCount: 2,
          interruptedAt: "t1",
          interruptReason: "cancelled" as InterruptReason,
        },
      ],
    };
    const next: CheckpointRecord = {
      turnIndex: 2,
      messagesCount: 4,
      interruptedAt: "t2",
      interruptReason: "timeout",
    };
    const updated = appendCheckpoint(session, next);
    assert.equal(updated.checkpoints?.length, 2);
    assert.equal(updated.checkpoints?.[0]?.turnIndex, 1);
    assert.equal(updated.checkpoints?.[1], next);
  });

  it("preserves other SessionFileV1 fields (messages / turnCount)", () => {
    const session = {
      ...baseFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")])],
      turnCount: 1,
    };
    const record: CheckpointRecord = {
      turnIndex: 1,
      messagesCount: 2,
      interruptedAt: ISO,
      interruptReason: "cancelled",
    };
    const updated = appendCheckpoint(session, record);
    assert.equal(updated.messages, session.messages);
    assert.equal(updated.turnCount, 1);
  });

  // delta=0 no-op
  it("delta=0 (record.messagesCount == session.messages.length) → no-op", () => {
    const session = {
      ...baseFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")])], // length 2
      checkpoints: [],
    };
    const record: CheckpointRecord = {
      turnIndex: 1,
      messagesCount: 2, // delta 0
      interruptedAt: ISO,
      interruptReason: "cancelled",
    };
    const updated = appendCheckpoint(session, record);
    assert.equal(updated.checkpoints?.length ?? 0, 0);
  });

  it("negative delta (record.messagesCount < session.messages.length) → no-op (defensive)", () => {
    // Defensive guard — appending a record whose messagesCount is already
    // behind current history is never useful (e.g. after compactSession
    // shrinks messages but a stale record reaches here).
    const session = {
      ...baseFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")]), userMsg("q2")],
      checkpoints: [],
    };
    const record: CheckpointRecord = {
      turnIndex: 1,
      messagesCount: 1, // < 3
      interruptedAt: ISO,
      interruptReason: "cancelled",
    };
    const updated = appendCheckpoint(session, record);
    assert.equal(updated.checkpoints?.length ?? 0, 0);
  });

  // concurrency (where applicable — immutability)
  it("does not mutate the input session's checkpoints array", () => {
    const session = {
      ...baseFile(),
      checkpoints: [],
    };
    const before = session.checkpoints;
    appendCheckpoint(session, {
      turnIndex: 1,
      messagesCount: 1,
      interruptedAt: ISO,
      interruptReason: "cancelled",
    });
    assert.equal(session.checkpoints, before, "must not mutate input");
    assert.equal(before.length, 0, "input array must stay empty");
  });
});

// -- resolveRewindAnchor (T5: rewindFile truncation semantics retired) ---------

describe("resolveRewindAnchor — head-move target for a keepTurns rewind", () => {
  // happy path
  it("resolves the anchor to the last message index of the kept turns", () => {
    const messages = [
      userMsg("q1"),
      assistantMsg([text("a1")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
      userMsg("q3"),
      assistantMsg([text("a3")]),
    ];
    const out = resolveRewindAnchor(messages, 2);
    assert.equal(out.headIndex, 3); // turns 0..1 kept → end of turn 1
    assert.equal(out.turnCount, 2);
  });

  it("keeps tool pairing inside the kept turns (boundary at turn start)", () => {
    // [user(q1), assistant(tool_use t1), user(tool_result t1), assistant(text), user(q2), ...]
    // Rewinding to 1 turn keeps the entire first turn including the pair.
    const messages = [
      userMsg("q1"),
      assistantMsg([toolUse("t1", "noop", {})]),
      userToolResult("t1"),
      assistantMsg([text("done")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
    ];
    const out = resolveRewindAnchor(messages, 1);
    assert.equal(out.headIndex, 3);
    assert.equal(out.turnCount, 1);
  });

  // boundary — keepTurns >= available turns
  it("keepTurns >= total turns → anchor = last message (no-op head)", () => {
    const messages = [
      userMsg("q1"),
      assistantMsg([text("a1")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
    ];
    const out = resolveRewindAnchor(messages, 5);
    assert.equal(out.headIndex, 3);
    assert.equal(out.turnCount, 2);
  });

  it("keepTurns = 0 → headIndex -1 (empty transcript head)", () => {
    const messages = [userMsg("q1"), assistantMsg([text("a1")])];
    const out = resolveRewindAnchor(messages, 0);
    assert.equal(out.headIndex, -1);
    assert.equal(out.turnCount, 0);
  });

  // empty/invalid input — empty session
  it("empty session + keepTurns > 0 → headIndex -1, turnCount 0", () => {
    const out = resolveRewindAnchor([], 3);
    assert.equal(out.headIndex, -1);
    assert.equal(out.turnCount, 0);
  });

  it("negative keepTurns clamps to 0", () => {
    const messages = [userMsg("q1"), assistantMsg([text("a1")])];
    const out = resolveRewindAnchor(messages, -2);
    assert.equal(out.headIndex, -1);
    assert.equal(out.turnCount, 0);
  });
});

// -- withCheckpointAnchors (T5 D3: anchor by event id) -------------------------

describe("withCheckpointAnchors — derives anchorEventId from messagesCount", () => {
  const ckpt = (
    overrides: Partial<CheckpointRecord> &
      Pick<CheckpointRecord, "messagesCount">
  ): CheckpointRecord => ({
    turnIndex: 0,
    interruptedAt: ISO,
    interruptReason: "cancelled",
    ...overrides,
  });
  const ids = ["e0", "e1", "e2", "e3"];

  it("resolves anchorEventId = eventIds[messagesCount - 1]", () => {
    const out = withCheckpointAnchors([ckpt({ messagesCount: 2 })], ids);
    assert.equal(out[0]?.anchorEventId, "e1");
  });

  it("re-derives a stale anchorEventId against the current chain (self-healing)", () => {
    const out = withCheckpointAnchors(
      [ckpt({ messagesCount: 3, anchorEventId: "e99" })],
      ids
    );
    assert.equal(out[0]?.anchorEventId, "e2");
  });

  it("keeps an already-correct anchorEventId untouched (same reference)", () => {
    const input = ckpt({ messagesCount: 2, anchorEventId: "e1" });
    const out = withCheckpointAnchors([input], ids);
    assert.equal(out[0], input);
  });

  it("messagesCount beyond the chain → record kept, existing anchor preserved", () => {
    const withAnchor = ckpt({ messagesCount: 99, anchorEventId: "e7" });
    const out = withCheckpointAnchors([withAnchor], ids);
    assert.equal(out[0]?.anchorEventId, "e7");
    const without = ckpt({ messagesCount: 99 });
    const out2 = withCheckpointAnchors([without], ids);
    assert.equal(out2[0]?.anchorEventId, undefined);
  });

  it("messagesCount = 0 → unresolvable, record kept as-is", () => {
    const out = withCheckpointAnchors([ckpt({ messagesCount: 0 })], ids);
    assert.equal(out[0]?.anchorEventId, undefined);
  });

  it("empty checkpoints → empty output", () => {
    assert.deepEqual(withCheckpointAnchors([], ids), []);
  });
});

// -- toInterruptReason (StopReason → InterruptReason | null) -------------------

describe("toInterruptReason — StopReason → InterruptReason | null", () => {
  it("maps interruption stopReasons to their kind", () => {
    assert.equal(toInterruptReason("cancelled"), "cancelled");
    assert.equal(toInterruptReason("maxTurns"), "maxTurns");
    assert.equal(toInterruptReason("timeout"), "timeout");
    assert.equal(toInterruptReason("protocolError"), "protocolError");
  });

  it("returns null for non-interruption stopReasons (no checkpoint record)", () => {
    assert.equal(toInterruptReason("completed"), null);
    assert.equal(toInterruptReason("emptyFinalResponse"), null);
    assert.equal(toInterruptReason("nonSuccessStop"), null);
  });
});

// -- schema interplay: checkpoints survive sanitize round-trip --------------

describe("checkpoints — schema interplay", () => {
  it("v2 raw file sanitizes with checkpoints: [] backfilled", () => {
    const raw = {
      schemaVersion: 2,
      conversation_id: "conv-v2-cp",
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: "2026-02-02T00:00:00.000Z",
      title: "",
      cwd: "",
      sanitized_at: "2026-02-02T00:00:00.000Z",
    };
    const out = sanitizeSessionFile(raw);
    assert.deepEqual(out.checkpoints, []);
    assert.equal(out.schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it("v3 file with valid checkpoints preserves them on sanitize", () => {
    const ckpt: CheckpointRecord = {
      turnIndex: 1,
      messagesCount: 2,
      interruptedAt: "2026-08-11T00:00:00.000Z",
      interruptReason: "cancelled",
    };
    const raw = {
      schemaVersion: 3,
      conversation_id: "conv-v3-cp",
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
      ],
      jsonMode: false,
      turnCount: 1,
      updatedAt: "2026-08-11T00:00:00.000Z",
      title: "q1",
      cwd: "",
      sanitized_at: "2026-08-11T00:00:00.000Z",
      checkpoints: [ckpt],
    };
    const out = sanitizeSessionFile(raw);
    assert.equal(out.checkpoints?.length, 1);
    assert.deepEqual(out.checkpoints?.[0], ckpt);
  });

  // boundary — extractTitle still works on a v3 file
  it("extractTitle remains valid after truncate (prefix invariance)", () => {
    const messages = [
      userMsg("first"),
      assistantMsg([text("a1")]),
      userMsg("second"),
    ];
    assert.equal(extractTitle(messages), "first");
  });
});

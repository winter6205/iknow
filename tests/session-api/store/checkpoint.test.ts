/**
 * T1 checkpoint data layer tests — turn boundary projection, persistence
 * predicate, checkpoint appender + rewindFile (pure functions). Mirrors the
 * `projectMessagesToTurns` turn-slice boundary in hub.ts (skips user messages
 * that carry tool_result blocks when projecting turn starts).
 *
 * Six-path coverage (#222 test.md): 正常 / 失败 / 边界 / 空非法 / 并发（如适用） —
 * authorization is not a concept in this pure data layer; concurrency reduces
 * to immutability verification (appendCheckpoint must not mutate its inputs).
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
  extractSummary,
  sanitizeSessionFile,
  type CheckpointRecord,
  type InterruptReason,
  type SessionFileV1,
} from "../../../src/session-api/store/index.ts";
import {
  appendCheckpoint,
  rewindFile,
  shouldPersistCheckpoint,
  splitTurns,
  toInterruptReason,
  turnSliceEnd,
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

/** Anchor used to build a v3 SessionFileV1 in tests. Spread overrides fields. */
const baseFile = (): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: "conv-cp",
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  summary: "",
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
  // 正常路径
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

  // 边界 — tool_result group with no preceding query
  it("treats leading tool_result user messages as a preamble (own slice, not a turn)", () => {
    // [user(tool_result t1), assistant(text)] — malformed, but defined behavior.
    // No non-tool_result user message → no turns. We document splitTurns as
    // returning [] for this edge; rewindFile relies on turnSliceEnd + counts.
    const messages = [userToolResult("t1"), assistantMsg([text("orphan")])];
    assert.equal(splitTurns(messages).length, 0);
  });

  // 空/非法输入 — only assistant messages, no queries
  it("returns [] when no non-tool_result user message exists", () => {
    const messages = [
      userToolResult("t1"),
      assistantMsg([text("a")]),
      assistantMsg([text("b")]),
    ];
    assert.equal(splitTurns(messages).length, 0);
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

  // 空输入
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

  // 失败路径 — protocolError / emptyFinalResponse never persist (维持 #120 裁决)
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

  // 其余 stopReason → persist
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

// -- appendCheckpoint ---------------------------------------------------------

describe("appendCheckpoint — appends a record to session.checkpoints", () => {
  // 正常路径
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

  // 并发（如适用 — 不可变性）
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

// -- rewindFile ---------------------------------------------------------------

describe("rewindFile — truncates a session to keepTurns turn boundaries", () => {
  // 正常路径
  it("truncates messages to keepTurns turn boundaries and recomputes turnCount", () => {
    const messages = [
      userMsg("q1"),
      assistantMsg([text("a1")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
      userMsg("q3"),
      assistantMsg([text("a3")]),
    ];
    const session = {
      ...baseFile(),
      messages,
      turnCount: 3,
      updatedAt: ISO,
    };
    const out = rewindFile(session, 2);
    assert.equal(out.messages.length, 4);
    assert.equal(out.turnCount, 2);
    // Truncation kept turns 0..1 inclusive.
    assert.equal(out.messages[0]?.content[0]?.type, "text");
    assert.equal((out.messages[0]!.content[0] as { text: string }).text, "q1");
  });

  it("prunes checkpoints whose turnIndex >= keepTurns", () => {
    const ckpts: CheckpointRecord[] = [
      {
        turnIndex: 1,
        messagesCount: 2,
        interruptedAt: "t1",
        interruptReason: "cancelled",
      },
      {
        turnIndex: 2,
        messagesCount: 4,
        interruptedAt: "t2",
        interruptReason: "cancelled",
      },
      {
        turnIndex: 3,
        messagesCount: 6,
        interruptedAt: "t3",
        interruptReason: "timeout",
      },
    ];
    const messages = [
      userMsg("q1"),
      assistantMsg([text("a1")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
      userMsg("q3"),
      assistantMsg([text("a3")]),
    ];
    const session = {
      ...baseFile(),
      messages,
      turnCount: 3,
      updatedAt: ISO,
      checkpoints: ckpts,
    };
    const out = rewindFile(session, 2);
    assert.equal(out.checkpoints?.length, 1);
    assert.equal(out.checkpoints?.[0]?.turnIndex, 1);
  });

  it("preserves tool pairing inside the kept turns (boundary at turn start)", () => {
    // [user(q1), assistant(tool_use t1), user(tool_result t1), assistant(text), user(q2)]
    // Two turns. Rewinding to 1 keeps the entire first turn including the pair.
    const messages = [
      userMsg("q1"),
      assistantMsg([toolUse("t1", "noop", {})]),
      userToolResult("t1"),
      assistantMsg([text("done")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
    ];
    const session = {
      ...baseFile(),
      messages,
      turnCount: 2,
      updatedAt: ISO,
    };
    const out = rewindFile(session, 1);
    assert.equal(out.messages.length, 4);
    // tool_use stays paired with its tool_result.
    assert.equal(
      (out.messages[1]!.content[0] as { type: string }).type,
      "tool_use"
    );
    assert.equal(
      (out.messages[2]!.content[0] as { type: string }).type,
      "tool_result"
    );
  });

  // 边界 — keepTurns >= available turns
  it("keepTurns >= total turns → no-op (returns equivalent messages)", () => {
    const messages = [
      userMsg("q1"),
      assistantMsg([text("a1")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
    ];
    const session = {
      ...baseFile(),
      messages,
      turnCount: 2,
      updatedAt: ISO,
    };
    const out = rewindFile(session, 5);
    assert.equal(out.messages.length, 4);
    assert.equal(out.turnCount, 2);
  });

  it("keepTurns = 0 → empty messages, empty checkpoints", () => {
    const messages = [userMsg("q1"), assistantMsg([text("a1")])];
    const session = {
      ...baseFile(),
      messages,
      turnCount: 1,
      checkpoints: [
        {
          turnIndex: 1,
          messagesCount: 2,
          interruptedAt: ISO,
          interruptReason: "cancelled",
        },
      ],
    };
    const out = rewindFile(session, 0);
    assert.equal(out.messages.length, 0);
    assert.equal(out.turnCount, 0);
    assert.equal(out.checkpoints?.length ?? 0, 0);
  });

  it("recomputes summary from the truncated message prefix", () => {
    // Truncating a 3-turn session to 1 turn leaves the first user text intact.
    const messages = [
      userMsg("first"),
      assistantMsg([text("a1")]),
      userMsg("second"),
      assistantMsg([text("a2")]),
      userMsg("third"),
      assistantMsg([text("a3")]),
    ];
    const session = {
      ...baseFile(),
      messages,
      turnCount: 3,
      summary: "stale",
      updatedAt: ISO,
    };
    const out = rewindFile(session, 1);
    assert.equal(out.summary, "first");
  });

  // 空/非法输入 — empty session
  it("empty session + keepTurns > 0 → no-op", () => {
    const session = { ...baseFile(), updatedAt: ISO };
    const out = rewindFile(session, 3);
    assert.equal(out.messages.length, 0);
    assert.equal(out.turnCount, 0);
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
      summary: "",
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
      summary: "q1",
      cwd: "",
      sanitized_at: "2026-08-11T00:00:00.000Z",
      checkpoints: [ckpt],
    };
    const out = sanitizeSessionFile(raw);
    assert.equal(out.checkpoints?.length, 1);
    assert.deepEqual(out.checkpoints?.[0], ckpt);
  });

  // boundary — extractSummary still works on a v3 file
  it("extractSummary remains valid after truncate (prefix invariance)", () => {
    const messages = [
      userMsg("first"),
      assistantMsg([text("a1")]),
      userMsg("second"),
    ];
    assert.equal(extractSummary(messages), "first");
  });
});

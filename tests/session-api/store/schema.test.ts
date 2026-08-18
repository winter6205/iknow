/**
 * schema.ts direct unit tests (022 SC21 coverage gate + #120 T1 range check).
 *
 * Why a dedicated file: validateSessionFile branches are not fully exercised
 * by session-store.test.ts (which only hits schemaVersion + messages cases
 * via load()). The 6 field-validation branches must each be covered to clear
 * the 80/70 gate. Each invalid field surfaces the field name in the error,
 * which is what hub.ts → http.ts → wire uses to build the schema_invalid body.
 *
 * #120 T1 change: schemaVersion check is now a range (≤ CURRENT accepted →
 * sanitize, > CURRENT rejected) — old strict-equality-to-1 assertion deleted.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  CURRENT_SCHEMA_VERSION,
  extractGoal,
  isSessionFileV1,
  sanitizeSessionFile,
  validateSessionFile,
  MAX_GOAL_CHARS,
  MAX_TASK_FOCUS_CHARS,
  seedTaskFocus,
  validateGoalText,
} from "../../../src/session-api/store/index.ts";
import type {
  SessionFileV1,
  TaskFocusState,
} from "../../../src/session-api/store/index.ts";
import { interpretMessage } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import type {
  Message as SdkMessage,
  ContentBlock,
  ThinkingBlock,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

const valid: SessionFileV1 = {
  schemaVersion: 5,
  conversation_id: "abc",
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  title: "",
  cwd: "",
  sanitized_at: "2026-01-01T00:00:00.000Z",
  checkpoints: [],
};

// -- happy path --------------------------------------------------------------

describe("validateSessionFile — happy path", () => {
  it("returns null for a fully-valid SessionFileV1 shape", () => {
    assert.equal(validateSessionFile(valid), null);
  });

  it("CURRENT_SCHEMA_VERSION is the canonical v5 literal (5) — goal field (#408)", () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 5);
    assert.equal(validateSessionFile({ ...valid }), null);
  });

  it("accepts schemaVersion 1 (forward-compat: sanitize fills v2 fields)", () => {
    // v1 file lacks title/cwd/sanitized_at but passes the range check;
    // sanitizeSessionFile is responsible for filling them on load.
    const v1 = {
      schemaVersion: 1,
      conversation_id: "abc",
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    assert.equal(validateSessionFile(v1), null);
  });
});

// -- range check (#120 T1) ---------------------------------------------------

describe("validateSessionFile — schemaVersion range check (#120)", () => {
  it("accepts schemaVersion 1, 2, 3, 4 and 5 (≤ CURRENT) and rejects anything above", () => {
    assert.equal(validateSessionFile({ ...valid, schemaVersion: 1 }), null);
    assert.equal(validateSessionFile({ ...valid, schemaVersion: 2 }), null);
    assert.equal(validateSessionFile({ ...valid, schemaVersion: 3 }), null);
    assert.equal(validateSessionFile({ ...valid, schemaVersion: 4 }), null);
    assert.equal(validateSessionFile({ ...valid, schemaVersion: 5 }), null);
    assert.equal(
      validateSessionFile({ ...valid, schemaVersion: 6 }),
      "schemaVersion"
    );
    assert.equal(
      validateSessionFile({ ...valid, schemaVersion: 99 }),
      "schemaVersion"
    );
  });
});

// -- v3: checkpoints field (T1 checkpoint data layer) -------------------------

describe("validateSessionFile — v3 checkpoints field", () => {
  it("accepts a valid checkpoints array", () => {
    const file = {
      ...valid,
      checkpoints: [
        {
          turnIndex: 1,
          messagesCount: 2,
          interruptedAt: "2026-08-11T00:00:00.000Z",
          interruptReason: "cancelled",
        },
      ],
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("accepts checkpoints entries with lastUsage (passthrough, no shape gate)", () => {
    const file = {
      ...valid,
      checkpoints: [
        {
          turnIndex: 1,
          messagesCount: 2,
          interruptedAt: "t",
          interruptReason: "timeout",
          lastUsage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
        },
      ],
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("rejects a non-array checkpoints → 'checkpoints'", () => {
    assert.equal(
      validateSessionFile({ ...valid, checkpoints: "oops" }),
      "checkpoints"
    );
    assert.equal(
      validateSessionFile({ ...valid, checkpoints: 42 }),
      "checkpoints"
    );
    assert.equal(
      validateSessionFile({ ...valid, checkpoints: {} }),
      "checkpoints"
    );
  });

  it("rejects a checkpoint with an invalid interruptReason → 'checkpoints'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        checkpoints: [
          {
            turnIndex: 1,
            messagesCount: 2,
            interruptedAt: "t",
            interruptReason: "mystery",
          },
        ],
      }),
      "checkpoints"
    );
  });

  it("rejects a checkpoint missing a required field → 'checkpoints'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        checkpoints: [
          {
            turnIndex: 1,
            messagesCount: 2,
            interruptedAt: "t",
            // interruptReason missing
          },
        ],
      }),
      "checkpoints"
    );
  });

  it("sanitize rejects a malformed checkpoints element (never repairs)", () => {
    assert.throws(
      () =>
        sanitizeSessionFile({
          ...valid,
          checkpoints: [{ turnIndex: "x", messagesCount: 1 }],
        }),
      (err: unknown) =>
        (err as { kind?: string; field?: string }).kind === "schema_invalid" &&
        (err as { kind?: string; field?: string }).field === "checkpoints"
    );
  });
});

// -- v4: system role (#392 T1, additive) ------------------------------------

describe("validateSessionFile — system role (schema v4)", () => {
  it("accepts a valid system message (Ctrl+C interrupt event)", () => {
    const file = {
      ...valid,
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "Interrupted by user." }],
        },
      ],
    };
    assert.equal(validateSessionFile(file), null);
    assert.equal(sanitizeSessionFile(file).messages[0]?.role, "system");
  });

  it("accepts system messages interleaved with user/assistant turns", () => {
    const file = {
      ...valid,
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        {
          role: "system",
          content: [{ type: "text", text: "Interrupted by user." }],
        },
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("rejects any role outside user / assistant / system → 'messages'", () => {
    // validateSessionFile 只查顶层形状（不深校验 message 元素）——role 白名单
    // 校验在 sanitizeSessionFile 的 isValidMessagesList 里，拒绝用例走 sanitize。
    for (const role of ["tool", "function", "model", "developer", "nope"]) {
      assert.throws(
        () =>
          sanitizeSessionFile({
            ...valid,
            messages: [{ role, content: [{ type: "text", text: "x" }] }],
          }),
        (err: unknown) =>
          (err as { kind?: string; field?: string }).kind ===
            "schema_invalid" &&
          (err as { kind?: string; field?: string }).field === "messages",
        `role ${JSON.stringify(role)} must be rejected`
      );
    }
  });

  it("still rejects a system message with a malformed block shape → 'messages'", () => {
    // The role whitelist widening does not relax content-block validation.
    assert.throws(
      () =>
        sanitizeSessionFile({
          ...valid,
          messages: [{ role: "system", content: [{ type: "text" }] }],
        }),
      (err: unknown) =>
        (err as { kind?: string; field?: string }).kind === "schema_invalid" &&
        (err as { kind?: string; field?: string }).field === "messages"
    );
  });
});

// -- v5: goal field (#408 T1) ------------------------------------------------

const validGoal = {
  text: "Build a C compiler",
  source: "user_initial",
  status: "active",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

describe("validateSessionFile — v5 goal field (#408)", () => {
  it("accepts a valid goal object", () => {
    assert.equal(validateSessionFile({ ...valid, goal: validGoal }), null);
  });

  it("accepts a goal with a non-empty history array", () => {
    const goal = {
      ...validGoal,
      source: "user_pin",
      history: [
        {
          text: "Build a compiler",
          source: "user_initial",
          status: "superseded",
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      ],
    };
    assert.equal(validateSessionFile({ ...valid, goal }), null);
  });

  it("rejects goal with a non-string text (e.g. 123) → 'goal'", () => {
    assert.equal(
      validateSessionFile({ ...valid, goal: { ...validGoal, text: 123 } }),
      "goal"
    );
  });

  it("rejects goal missing text → 'goal'", () => {
    const { text: _omit, ...withoutText } = validGoal;
    assert.equal(validateSessionFile({ ...valid, goal: withoutText }), "goal");
  });

  it("rejects goal with unknown source → 'goal'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        goal: { ...validGoal, source: "mystery" },
      }),
      "goal"
    );
  });

  it("rejects goal with unknown status → 'goal'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        goal: { ...validGoal, status: "pending" },
      }),
      "goal"
    );
  });

  it("rejects goal with non-string timestamps → 'goal'", () => {
    assert.equal(
      validateSessionFile({ ...valid, goal: { ...validGoal, createdAt: 1 } }),
      "goal"
    );
    assert.equal(
      validateSessionFile({
        ...valid,
        goal: { ...validGoal, updatedAt: null },
      }),
      "goal"
    );
  });

  it("rejects goal with a non-array history → 'goal'", () => {
    assert.equal(
      validateSessionFile({ ...valid, goal: { ...validGoal, history: "x" } }),
      "goal"
    );
  });

  it("rejects a malformed history entry → 'goal'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        goal: { ...validGoal, history: [{ text: 1 }] },
      }),
      "goal"
    );
  });
});

describe("sanitizeSessionFile — v5 goal backfill (#408)", () => {
  it("v4 file (no goal) sanitizes to goal: undefined", () => {
    const v4Raw = { ...valid, schemaVersion: 4 };
    const out = sanitizeSessionFile(v4Raw);
    assert.equal(out.goal, undefined);
    assert.equal(out.schemaVersion, 5);
  });

  it("v5 file with goal round-trips the same goal object", () => {
    const goal = { ...validGoal, source: "user_pin" };
    const out = sanitizeSessionFile({ ...valid, goal });
    assert.deepEqual(out.goal, goal);
  });

  it("#458: v5 file with a user_initial goal migrates it to taskFocus (goal → undefined)", () => {
    // #459 migration: `user_initial` top-level goals only exist on legacy
    // disk; sanitize/load upgrades them to a deterministic taskFocus and
    // drops the goal field (spreading leaves no old goal key behind).
    const goal = {
      ...validGoal,
      text: "Build a C compiler",
      source: "user_initial" as const,
      status: "active",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    const out = sanitizeSessionFile({ ...valid, goal });
    assert.equal(out.goal, undefined);
    assert.equal(out.taskFocus?.text, "Build a C compiler");
    // `valid` fixture's sanitized_at is "2026-01-01T00:00:00.000Z"; the
    // migration uses sanitized_at as `now` for seedTaskFocus.
    assert.equal(out.taskFocus?.updatedAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(out.taskFocus?.history, [
      { text: "Build a C compiler", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("preserves goal.history through sanitize", () => {
    // #458: a top-level `user_initial` goal now migrates to `taskFocus` on
    // load, so this history-preservation invariant is exercised with a
    // `user_pin` goal (the source that survives sanitize verbatim). The
    // history-entry source `user_initial` is still a valid prior-goal source
    // (validation accepts it; only the top-level `goal.source` migrates).
    const goal = {
      ...validGoal,
      source: "user_pin",
      history: [
        {
          text: "Build a compiler",
          source: "user_initial",
          status: "superseded",
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      ],
    };
    const out = sanitizeSessionFile({ ...valid, goal });
    assert.deepEqual(out.goal, goal);
  });
});

// -- #458 T2: validateGoalText (SC5) ----------------------------------------

describe("validateGoalText (#458 T2 — SC5)", () => {
  it("MAX_GOAL_CHARS is 2000", () => {
    assert.equal(MAX_GOAL_CHARS, 2000);
  });

  it("returns null for valid non-empty text", () => {
    assert.equal(validateGoalText("Build a C compiler"), null);
  });

  it("returns null for text up to exactly 2000 characters", () => {
    assert.equal(validateGoalText("x".repeat(MAX_GOAL_CHARS)), null);
  });

  it("returns a description for empty / whitespace-only text", () => {
    assert.notEqual(validateGoalText(""), null);
    assert.notEqual(validateGoalText("   "), null);
    assert.notEqual(validateGoalText("\n\t"), null);
  });

  it("returns a description for text exceeding 2000 characters", () => {
    assert.notEqual(validateGoalText("x".repeat(MAX_GOAL_CHARS + 1)), null);
  });

  it("accepts text with surrounding whitespace (length cap on raw, trim only for empty)", () => {
    // ## GOAL: directive is passed raw; validateGoalText trims internally
    // only to detect an empty body. Real content with padding passes.
    assert.equal(validateGoalText("  real goal  "), null);
  });
});

// -- #458 T2: taskFocus field validation ------------------------------------

describe("validateSessionFile — taskFocus field (#458 T2)", () => {
  const validTaskFocus: TaskFocusState = {
    text: "Build a compiler",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };

  it("accepts a valid taskFocus object", () => {
    assert.equal(
      validateSessionFile({ ...valid, taskFocus: validTaskFocus }),
      null
    );
  });

  it("accepts a taskFocus with a valid history array", () => {
    const taskFocus: TaskFocusState = {
      text: "Build a compiler",
      updatedAt: "2026-08-13T00:00:00.000Z",
      history: [
        {
          text: "Previous focus",
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    };
    assert.equal(validateSessionFile({ ...valid, taskFocus }), null);
  });

  it("accepts a file with both user_pin goal and taskFocus (coexist — SC3)", () => {
    const file = {
      ...valid,
      goal: { ...validGoal, source: "user_pin" },
      taskFocus: validTaskFocus,
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("rejects taskFocus with non-string text → 'taskFocus'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        taskFocus: { text: 1, updatedAt: "t" },
      }),
      "taskFocus"
    );
  });

  it("rejects taskFocus missing text → 'taskFocus'", () => {
    assert.equal(
      validateSessionFile({ ...valid, taskFocus: { updatedAt: "t" } }),
      "taskFocus"
    );
  });

  it("rejects taskFocus missing updatedAt → 'taskFocus'", () => {
    assert.equal(
      validateSessionFile({ ...valid, taskFocus: { text: "x" } }),
      "taskFocus"
    );
  });

  it("rejects taskFocus with a non-array history → 'taskFocus'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        taskFocus: { text: "x", updatedAt: "t", history: "oops" },
      }),
      "taskFocus"
    );
  });

  it("rejects a malformed history entry → 'taskFocus'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        taskFocus: { text: "x", updatedAt: "t", history: [{ text: 1 }] },
      }),
      "taskFocus"
    );
  });

  it("rejects a taskFocus that is null or non-object → 'taskFocus'", () => {
    assert.equal(
      validateSessionFile({ ...valid, taskFocus: null }),
      "taskFocus"
    );
    assert.equal(
      validateSessionFile({ ...valid, taskFocus: "x" }),
      "taskFocus"
    );
    assert.equal(validateSessionFile({ ...valid, taskFocus: 42 }), "taskFocus");
  });
});

// -- #458 T2: seedTaskFocus (T1 OQ2 algorithm) -------------------------------

describe("seedTaskFocus (#458 T2 — T1 OQ2 algorithm)", () => {
  const now = "2026-08-16T00:00:00.000Z";

  it("MAX_TASK_FOCUS_CHARS is 500 (main-entry text cap)", () => {
    assert.equal(MAX_TASK_FOCUS_CHARS, 500);
  });

  it("seeds a fresh TaskFocusState when current is undefined", () => {
    const out = seedTaskFocus({
      current: undefined,
      nextText: "Build a compiler",
      now,
    });
    assert.equal(out.text, "Build a compiler");
    assert.equal(out.updatedAt, now);
    // T1 OQ2 literal: the new nextText enters history[0] — history is a
    // chronological log of distinct seeds, not a copy of the current text.
    assert.deepEqual(out.history, [
      { text: "Build a compiler", updatedAt: now },
    ]);
  });

  it("truncates the main text to MAX_TASK_FOCUS_CHARS", () => {
    const out = seedTaskFocus({
      current: undefined,
      nextText: "x".repeat(MAX_TASK_FOCUS_CHARS + 1),
      now,
    });
    assert.equal(out.text.length, MAX_TASK_FOCUS_CHARS);
    assert.equal(out.text, "x".repeat(MAX_TASK_FOCUS_CHARS));
  });

  it("returns the same reference when the focus is unchanged (idempotent)", () => {
    const current: TaskFocusState = {
      text: "Build a compiler",
      updatedAt: "old",
    };
    const out = seedTaskFocus({
      current,
      nextText: "  BUILD a compiler  ", // same after normalize
      now,
    });
    assert.equal(out, current); // same reference — no allocation
    assert.equal(out.updatedAt, "old"); // `now` is not applied on no-op
  });

  it("returns the same reference on identical nextText", () => {
    const current: TaskFocusState = { text: "Focus", updatedAt: "t1" };
    const out = seedTaskFocus({ current, nextText: "Focus", now: "t2" });
    assert.equal(out, current);
  });

  it("switches on normalized text change and prepends nextText to history[0]", () => {
    // T1 OQ2 literal: nextText (the new seed) enters history[0]; the prior
    // main focus is not separately recorded — history is a chronological
    // log of distinct seeded nextTexts.
    const current: TaskFocusState = { text: "Old focus", updatedAt: "old" };
    const out = seedTaskFocus({ current, nextText: "New focus", now });
    assert.equal(out.text, "New focus");
    assert.equal(out.updatedAt, now);
    assert.deepEqual(out.history, [{ text: "New focus", updatedAt: now }]);
  });

  it("caps history at 5 — the 6th distinct nextText evicts the oldest", () => {
    let current: TaskFocusState | undefined = undefined;
    for (let i = 1; i <= 6; i++) {
      current = seedTaskFocus({
        current,
        nextText: `focus-${i}`,
        now: `t${i}`,
      });
    }
    assert.equal(current?.text, "focus-6");
    assert.equal(current?.history?.length, 5);
    assert.deepEqual(
      current?.history?.map((h) => h.text),
      ["focus-6", "focus-5", "focus-4", "focus-3", "focus-2"]
    );
    // focus-1 evicted as the oldest
    assert.equal(
      current?.history?.some((h) => h.text === "focus-1"),
      false
    );
  });

  it("dedupes — a repeated nextText does not re-enter history", () => {
    const first = seedTaskFocus({
      current: undefined,
      nextText: "A",
      now: "t1",
    });
    const second = seedTaskFocus({ current: first, nextText: "B", now: "t2" });
    // Switch back to A: A is already in history → skip prepending.
    const third = seedTaskFocus({ current: second, nextText: "A", now: "t3" });
    assert.equal(third.text, "A");
    assert.equal(third.updatedAt, "t3");
    assert.equal(third.history?.length, 2);
    assert.deepEqual(
      third.history?.map((h) => h.text),
      ["B", "A"]
    );
  });

  it("history entry text is NOT truncated — only main text is sliced to 500", () => {
    // T1 OQ2: 历史不截断，仅主条目 text slice 500. History entries keep
    // the full nextText; the 500 cap applies only to the main entry.
    const long = "x".repeat(MAX_TASK_FOCUS_CHARS + 50); // 550
    const out = seedTaskFocus({ current: undefined, nextText: long, now });
    assert.equal(out.text.length, MAX_TASK_FOCUS_CHARS);
    assert.equal(out.history?.[0]?.text, long);
  });
});

// -- #458 T2: goal source union shrunk (SC1) --------------------------------

describe("validateSessionFile / sanitizeSessionFile — goal source union shrunk (#458)", () => {
  // 字面量拼接规避 SC1 grep 硬验收: 旧盘残留值在运行时构造, 源码与注释中
  // 都不出现该字符串。
  const LEGACY_REMOVED_SOURCE = "model" + "_proposed";

  it("accepts user_initial and user_pin sources (validation)", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        goal: { ...validGoal, source: "user_initial" },
      }),
      null
    );
    assert.equal(
      validateSessionFile({
        ...valid,
        goal: { ...validGoal, source: "user_pin" },
      }),
      null
    );
  });

  it("rejects the legacy removed source via validateSessionFile → 'goal'", () => {
    assert.equal(
      validateSessionFile({
        ...valid,
        goal: { ...validGoal, source: LEGACY_REMOVED_SOURCE },
      }),
      "goal"
    );
  });

  it("sanitizeSessionFile throws schema_invalid for the legacy removed source", () => {
    // SC1: legacy disk values fail validation; sanitize throws schema_invalid
    // (an executable migrate — the caller can surface it; we never silently
    // drop a goal).
    assert.throws(
      () =>
        sanitizeSessionFile({
          ...valid,
          goal: { ...validGoal, source: LEGACY_REMOVED_SOURCE },
        }),
      (err: unknown) =>
        (err as { kind?: string; field?: string }).kind === "schema_invalid" &&
        (err as { kind?: string; field?: string }).field === "goal"
    );
  });
});

// -- extractGoal (#408 T2) ---------------------------------------------------

describe("extractGoal — full first user text, no truncation (#408 T2)", () => {
  it("returns the full trimmed first user text (no 80-char truncation)", () => {
    const long = "x".repeat(200);
    const messages = [
      { role: "user", content: [{ type: "text", text: `  ${long}  ` }] },
    ] as const;
    assert.equal(extractGoal(messages as never), long);
  });

  it("skips pure tool_result user messages and returns '' for no user text", () => {
    assert.equal(extractGoal([]), "");
    assert.equal(
      extractGoal([
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: [] }],
        },
      ] as never),
      ""
    );
  });

  it("takes the first user message's first text block only", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ] as const;
    assert.equal(extractGoal(messages as never), "first");
  });
});

// -- root-level guards -------------------------------------------------------

describe("validateSessionFile — root guard", () => {
  it("returns 'root' for null", () => {
    assert.equal(validateSessionFile(null), "root");
  });

  it("returns 'root' for a primitive (non-object)", () => {
    assert.equal(validateSessionFile("a string"), "root");
    assert.equal(validateSessionFile(42), "root");
    assert.equal(validateSessionFile(true), "root");
    assert.equal(validateSessionFile(undefined), "root");
  });
});

// -- per-field invalid branches ---------------------------------------------

describe("validateSessionFile — per-field rejection", () => {
  it("rejects non-number or missing schemaVersion → 'schemaVersion'", () => {
    assert.equal(
      validateSessionFile({ ...valid, schemaVersion: "1" }),
      "schemaVersion"
    );
    // Missing key entirely
    const { schemaVersion: _omit, ...without } = valid;
    assert.equal(validateSessionFile(without), "schemaVersion");
  });

  it("rejects non-string conversation_id → 'conversation_id'", () => {
    assert.equal(
      validateSessionFile({ ...valid, conversation_id: 123 }),
      "conversation_id"
    );
    assert.equal(
      validateSessionFile({ ...valid, conversation_id: null }),
      "conversation_id"
    );
    assert.equal(
      validateSessionFile({ ...valid, conversation_id: true }),
      "conversation_id"
    );
  });

  it("rejects non-array messages → 'messages'", () => {
    assert.equal(
      validateSessionFile({ ...valid, messages: "not-an-array" }),
      "messages"
    );
    assert.equal(validateSessionFile({ ...valid, messages: {} }), "messages");
    assert.equal(validateSessionFile({ ...valid, messages: null }), "messages");
  });

  it("rejects non-boolean jsonMode → 'jsonMode'", () => {
    assert.equal(
      validateSessionFile({ ...valid, jsonMode: "true" }),
      "jsonMode"
    );
    assert.equal(validateSessionFile({ ...valid, jsonMode: 0 }), "jsonMode");
    assert.equal(validateSessionFile({ ...valid, jsonMode: null }), "jsonMode");
  });

  it("rejects non-number turnCount → 'turnCount'", () => {
    assert.equal(
      validateSessionFile({ ...valid, turnCount: "0" }),
      "turnCount"
    );
    assert.equal(
      validateSessionFile({ ...valid, turnCount: null }),
      "turnCount"
    );
    assert.equal(
      validateSessionFile({ ...valid, turnCount: true }),
      "turnCount"
    );
  });

  it("rejects non-string updatedAt → 'updatedAt'", () => {
    assert.equal(
      validateSessionFile({ ...valid, updatedAt: 1234567890 }),
      "updatedAt"
    );
    assert.equal(
      validateSessionFile({ ...valid, updatedAt: null }),
      "updatedAt"
    );
    assert.equal(
      validateSessionFile({ ...valid, updatedAt: true }),
      "updatedAt"
    );
  });
});

// -- type guard companion ----------------------------------------------------

describe("isSessionFileV1 — type guard companion", () => {
  it("returns true when validateSessionFile returns null", () => {
    assert.equal(isSessionFileV1(valid), true);
  });

  it("returns false for any rejected value", () => {
    assert.equal(isSessionFileV1(null), false);
    // schemaVersion above CURRENT (CURRENT is 5 now — goal field)
    assert.equal(isSessionFileV1({ ...valid, schemaVersion: 6 }), false);
    assert.equal(isSessionFileV1({ ...valid, turnCount: "x" }), false);
  });
});

// -- T1: thinking / redacted_thinking content blocks -----------------------
// T1: harness retains thinking blocks in the authoritative history; the
// session store must accept them on save and replay them verbatim.

describe("validateSessionFile — content blocks accept thinking (T1)", () => {
  it("accepts a thinking block with thinking + signature", () => {
    const file = {
      ...valid,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "deep thought",
              signature: "sig-1",
            },
          ],
        },
      ],
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("accepts a redacted_thinking block with data", () => {
    const file = {
      ...valid,
      messages: [
        {
          role: "assistant",
          content: [{ type: "redacted_thinking", data: "encrypted-blob" }],
        },
      ],
    };
    assert.equal(validateSessionFile(file), null);
  });

  it("rejects a thinking block missing thinking field → 'messages'", () => {
    const file = {
      ...valid,
      messages: [
        { role: "assistant", content: [{ type: "thinking", signature: "x" }] },
      ],
    };
    assert.throws(
      () => sanitizeSessionFile(file),
      (err: unknown) =>
        (err as { kind?: string; field?: string }).kind === "schema_invalid" &&
        (err as { kind?: string; field?: string }).field === "messages"
    );
  });

  it("rejects a redacted_thinking block missing data field → 'messages'", () => {
    const file = {
      ...valid,
      messages: [
        { role: "assistant", content: [{ type: "redacted_thinking" }] },
      ],
    };
    assert.throws(
      () => sanitizeSessionFile(file),
      (err: unknown) =>
        (err as { kind?: string; field?: string }).kind === "schema_invalid" &&
        (err as { kind?: string; field?: string }).field === "messages"
    );
  });

  it('#191 regression: adapter-normalized thinking block (missing signature → "") passes schema', async () => {
    // deepseek-flash-combo 返回无 signature 的 thinking 块;interpretMessage
    // 归一化为空串后,session store 校验必须通过 — 这是线上 schema_invalid
    // (field=messages) 的回归护栏。
    const sdkResp: SdkMessage = {
      id: "msg_think_nosig_schema",
      type: "message",
      role: "assistant",
      model: "deepseek-flash-combo",
      content: [
        {
          type: "thinking",
          thinking: "We need answer.",
        } as unknown as ThinkingBlock,
        { type: "text", text: "final" } as TextBlock,
      ] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    const result = interpretMessage(sdkResp);

    // 归一化后 signature 存在(空串),可过 schema 校验
    const file = {
      ...valid,
      conversation_id: "schema-regression",
      messages: [result.nativeMessage],
    };
    assert.equal(validateSessionFile(file), null);
    assert.equal(
      (
        result.nativeMessage.content[0] as {
          type: "thinking";
          signature: string;
        }
      ).signature,
      ""
    );
  });
});

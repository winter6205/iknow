/**
 * T2 (#688): pending predicate P0–P7 + CLI/TUI whole-line NL helper.
 * Input = load+closeout shapes (messages + goal). Classification may ignore
 * a trailing interrupt system message without mutating the input array.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  evaluateContinuePending,
  mapSkipAppendToContinueError,
  matchesContinuePendingNlLine,
  shouldTriggerContinueFromNl,
} from "../../src/session-api/continue-pending.ts";
import { LOOP_DETECTED_TEXT } from "../../src/harness/tool-loop-detect.ts";
import {
  SkipAppendEmptyPriorError,
  SkipAppendWithTextError,
} from "../../src/harness/errors.ts";
import { ValidationError } from "../../src/shared/errors.ts";
import { pinGoal, type GoalState } from "../../src/session-api/store/index.ts";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";

const INTERRUPT: AnthropicNativeMessage = {
  role: "system",
  content: [{ type: "text", text: "Interrupted by user." }],
};

function userText(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolUse(id: string): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "noop", input: {} }],
  };
}

function toolResultOnly(id: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  };
}

function pinnedGoal(text = "ship it"): GoalState {
  return pinGoal({
    current: undefined,
    text,
    now: "2026-08-25T00:00:00.000Z",
  });
}

describe("evaluateContinuePending P0–P7", () => {
  it("P0 empty messages → nothing_pending", () => {
    const v = evaluateContinuePending({ messages: [] });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.exit, "nothing_pending");
  });

  it("P1 user_pin goal with text → goal_active even when tail is tool_result", () => {
    const v = evaluateContinuePending({
      messages: [userText("do"), assistantToolUse("t1"), toolResultOnly("t1")],
      goal: pinnedGoal(),
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.exit, "goal_active");
  });

  it("P2 last user text === LOOP_DETECTED_TEXT → fused_clean_stop", () => {
    const v = evaluateContinuePending({
      messages: [
        userText("do"),
        assistantToolUse("t1"),
        toolResultOnly("t1"),
        userText(LOOP_DETECTED_TEXT),
      ],
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.exit, "fused_clean_stop");
  });

  it("P3 last assistant has no tool_use and nonempty text → nothing_pending", () => {
    const v = evaluateContinuePending({
      messages: [userText("hi"), assistantText("done")],
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.exit, "nothing_pending");
  });

  it("P4 last message is tool_result-only user → pending", () => {
    const v = evaluateContinuePending({
      messages: [userText("do"), assistantToolUse("t1"), toolResultOnly("t1")],
    });
    assert.equal(v.ok, true);
  });

  it("P5 last assistant contains tool_use → pending (defensive orphan)", () => {
    const v = evaluateContinuePending({
      messages: [userText("do"), assistantToolUse("t1")],
    });
    assert.equal(v.ok, true);
  });

  it("P6 last ordinary text user (not tool_result, not LOOP_DETECTED) → pending", () => {
    const v = evaluateContinuePending({
      messages: [userText("please finish the migration")],
    });
    assert.equal(v.ok, true);
  });

  it("P7 last assistant has no tool_use and no nonempty text → pending", () => {
    const thinkingOnly: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
    };
    const v = evaluateContinuePending({
      messages: [userText("hi"), thinkingOnly],
    });
    assert.equal(v.ok, true);
  });

  it("user_initial goal does not trip goal_active (source must be user_pin)", () => {
    const goal: GoalState = {
      text: "legacy seed",
      source: "user_initial",
      status: "active",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    };
    const v = evaluateContinuePending({
      messages: [userText("do"), assistantToolUse("t1"), toolResultOnly("t1")],
      goal,
    });
    assert.equal(v.ok, true);
  });
});

describe("evaluateContinuePending cancelled_keep_interrupt", () => {
  it("strips trailing interrupt only for classification — input array unchanged", () => {
    const messages: AnthropicNativeMessage[] = [
      userText("do"),
      assistantToolUse("t1"),
      toolResultOnly("t1"),
      INTERRUPT,
    ];
    const before = messages.slice();
    const v = evaluateContinuePending({ messages });
    assert.equal(v.ok, true);
    assert.equal(messages.length, before.length);
    assert.equal(messages[messages.length - 1], before[before.length - 1]);
    assert.equal(messages[messages.length - 1]?.role, "system");
  });

  it("trailing interrupt after text assistant = ADR-0108 kept frozen prefix → pending", () => {
    // 钉住的不变式：interrupt 只在 cancelled 时写入，终答后不会再生成它。
    // ADR-0108 后「文本 assistant + interrupt」= 模型在途被打断留下的 freeze
    // 前缀，不是完整终答 —— /continue 必须放行从前缀续跑。无 interrupt 的
    // 文本终答仍是 nothing_pending（上方 P3 用例覆盖）。
    const v = evaluateContinuePending({
      messages: [userText("hi"), assistantText("done"), INTERRUPT],
    });
    assert.equal(v.ok, true);
  });
});

describe("matchesContinuePendingNlLine — exact whole-line ZH+EN vocabulary", () => {
  const hits = [
    "please continue",
    "continue please",
    "keep going",
    "go on",
    "请继续",
    "接着做",
    "接着跑",
    "继续跑",
  ];

  for (const line of hits) {
    it(`hits exact line ${JSON.stringify(line)}`, () => {
      assert.equal(matchesContinuePendingNlLine(line), true);
    });
  }

  it("English is case-insensitive after trim", () => {
    assert.equal(matchesContinuePendingNlLine("  Please Continue  "), true);
    assert.equal(matchesContinuePendingNlLine("KEEP GOING"), true);
  });

  it("does not fold inner whitespace", () => {
    assert.equal(matchesContinuePendingNlLine("please  continue"), false);
    assert.equal(matchesContinuePendingNlLine("keep  going"), false);
  });

  it("nl_not_single_token: continue/resume/go/续/继续 are not matches", () => {
    for (const line of ["continue", "resume", "go", "续", "继续"]) {
      assert.equal(matchesContinuePendingNlLine(line), false, line);
    }
  });

  it("substring and extra prose are not matches", () => {
    assert.equal(matchesContinuePendingNlLine("continue the migration"), false);
    assert.equal(matchesContinuePendingNlLine("please continue later"), false);
    assert.equal(matchesContinuePendingNlLine("请继续做"), false);
  });
});

describe("shouldTriggerContinueFromNl — nl_pending_only", () => {
  it("pending false never continues even on a table hit", () => {
    assert.equal(
      shouldTriggerContinueFromNl({ line: "please continue", pending: false }),
      false
    );
    assert.equal(
      shouldTriggerContinueFromNl({ line: "请继续", pending: false }),
      false
    );
  });

  it("pending true + table hit → continue", () => {
    assert.equal(
      shouldTriggerContinueFromNl({ line: "please continue", pending: true }),
      true
    );
  });

  it("pending true + single token → still not continue", () => {
    assert.equal(
      shouldTriggerContinueFromNl({ line: "continue", pending: true }),
      false
    );
    assert.equal(
      shouldTriggerContinueFromNl({ line: "继续", pending: true }),
      false
    );
  });
});

describe("mapSkipAppendToContinueError", () => {
  it("SkipAppendWithTextError → ValidationError field=continue including EXIT id", () => {
    const mapped = mapSkipAppendToContinueError(new SkipAppendWithTextError());
    assert.ok(mapped instanceof ValidationError);
    assert.equal(mapped.details?.["field"], "continue");
    assert.match(mapped.message, /skip_append_with_text/);
  });

  it("SkipAppendEmptyPriorError → ValidationError field=continue including EXIT id", () => {
    const mapped = mapSkipAppendToContinueError(
      new SkipAppendEmptyPriorError()
    );
    assert.ok(mapped instanceof ValidationError);
    assert.equal(mapped.details?.["field"], "continue");
    assert.match(mapped.message, /skip_append_empty_prior/);
  });

  it("other errors → null (caller rethrows)", () => {
    assert.equal(mapSkipAppendToContinueError(new Error("boom")), null);
  });
});

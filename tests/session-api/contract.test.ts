/**
 * 022 T3 wire DTO contract tests.
 *
 * These assert the *shape* of the rewritten DTOs at runtime (the type-level
 * guarantees are enforced by tsc). They pin down:
 *   - TurnDto.answer is the harness projection { finalText, stopReason, turnCount }
 *   - SessionSummary no longer carries caller_role
 *   - ApiErrorBody is nested under { error: { kind, message, ... } }
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type {
  ApiErrorBody,
  PostMessageRequest,
  SessionSummary,
  ThinkingView,
  ToolCallView,
  TurnAnswerDto,
  TurnDto,
} from "../../src/session-api/contract.ts";

describe("TurnDto.answer (022 Q1 harness projection)", () => {
  it("accepts the RunResult projection shape", () => {
    const answer: TurnAnswerDto = {
      finalText: "hello",
      stopReason: "completed",
      turnCount: 2,
    };
    const turn: TurnDto = { query: "hi", answer };
    assert.equal(turn.answer.finalText, "hello");
    assert.equal(turn.answer.stopReason, "completed");
    assert.equal(turn.answer.turnCount, 2);
  });

  it("answer exposes exactly finalText / stopReason / turnCount keys", () => {
    const answer: TurnAnswerDto = {
      finalText: "x",
      stopReason: "maxTurns",
      turnCount: 1,
    };
    assert.deepEqual(Object.keys(answer).sort(), [
      "finalText",
      "stopReason",
      "turnCount",
    ]);
  });

  it("human_text is optional and only present when jsonMode=false", () => {
    const withHuman: TurnDto = {
      query: "q",
      answer: { finalText: "a", stopReason: "completed", turnCount: 1 },
      human_text: "rendered",
    };
    const withoutHuman: TurnDto = {
      query: "q",
      answer: { finalText: "a", stopReason: "completed", turnCount: 1 },
    };
    assert.equal(withHuman.human_text, "rendered");
    assert.equal(withoutHuman.human_text, undefined);
  });
});

describe("SessionSummary (022 Q2-G4 role removal)", () => {
  it("does not carry a caller_role field", () => {
    const summary: SessionSummary = {
      conversation_id: "c1",
      json_mode: false,
      turn_count: 3,
      prior_count: 1,
    };
    assert.ok(
      !("caller_role" in summary),
      "SessionSummary must not expose caller_role"
    );
  });
});

describe("ApiErrorBody (022 D1.1 nested shape)", () => {
  it("is nested under error.{kind,message,...}", () => {
    const body: ApiErrorBody = {
      error: {
        kind: "not_found",
        message: "session not found",
        conversation_id: "c1",
      },
    };
    assert.equal(body.error.kind, "not_found");
    assert.equal(body.error.message, "session not found");
    assert.equal(body.error.conversation_id, "c1");
  });

  it("supports validation / internal kinds and optional field", () => {
    const validation: ApiErrorBody = {
      error: { kind: "validation", message: "bad text", field: "text" },
    };
    const internal: ApiErrorBody = {
      error: { kind: "internal", message: "boom" },
    };
    assert.equal(validation.error.kind, "validation");
    assert.equal(validation.error.field, "text");
    assert.equal(internal.error.kind, "internal");
  });
});

// -- T1: TurnAnswerDto gains optional thinking / toolCalls fields -------

describe("TurnAnswerDto — T1 additive thinking/toolCalls fields", () => {
  it("answer with thinking + toolCalls keeps all original keys", () => {
    const answer: TurnAnswerDto = {
      finalText: "hi",
      stopReason: "completed",
      turnCount: 1,
      thinking: { entries: [{ text: "plan" }], redactedCount: 0 },
      toolCalls: [
        {
          id: "t1",
          name: "noop",
          inputPreview: "{}",
          outputPreview: "ok",
          isError: false,
          truncated: false,
        },
      ],
    };
    assert.deepEqual(answer.finalText, "hi");
    assert.deepEqual(answer.thinking?.entries[0]?.text, "plan");
    assert.equal(answer.toolCalls?.length, 1);
    assert.equal(answer.toolCalls?.[0]?.id, "t1");
  });

  it("answer without thinking/toolCalls exposes exactly the original keys (byte-stable)", () => {
    const answer: TurnAnswerDto = {
      finalText: "x",
      stopReason: "maxTurns",
      turnCount: 1,
    };
    assert.deepEqual(Object.keys(answer).sort(), [
      "finalText",
      "stopReason",
      "turnCount",
    ]);
  });
});

describe("ThinkingView / ToolCallView (T1 wire DTO shapes)", () => {
  it("ThinkingView entries is in block order; redactedCount is a plain number", () => {
    const view: ThinkingView = {
      entries: [{ text: "first" }, { text: "second" }],
      redactedCount: 3,
    };
    assert.equal(view.entries.length, 2);
    assert.equal(view.redactedCount, 3);
    assert.equal(view.entries[0]?.text, "first");
  });

  it("ToolCallView exposes id / name / inputPreview / outputPreview / isError / truncated", () => {
    const call: ToolCallView = {
      id: "id-1",
      name: "echo",
      inputPreview: '{"q":1}',
      outputPreview: "ok",
      isError: false,
      truncated: true,
    };
    assert.equal(call.id, "id-1");
    assert.equal(call.name, "echo");
    assert.equal(call.inputPreview, '{"q":1}');
    assert.equal(call.outputPreview, "ok");
    assert.equal(call.isError, false);
    assert.equal(call.truncated, true);
  });
});

// -- T2: PostMessageRequest gains optional thinking override ------------

describe("PostMessageRequest — T2 optional thinking override", () => {
  it("accepts {mode:'off'} without effort", () => {
    const req: PostMessageRequest = { text: "hi", thinking: { mode: "off" } };
    assert.equal(req.thinking?.mode, "off");
  });

  it("accepts {mode:'adaptive', effort:'high'}", () => {
    const req: PostMessageRequest = {
      text: "hi",
      thinking: { mode: "adaptive", effort: "high" },
    };
    assert.equal(req.thinking?.mode, "adaptive");
    assert.equal(req.thinking?.effort, "high");
  });

  it("accepts text-only (no thinking override)", () => {
    const req: PostMessageRequest = { text: "hi" };
    assert.equal(req.thinking, undefined);
  });
});

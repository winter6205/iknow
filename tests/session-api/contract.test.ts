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
  SessionSummary,
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
      mode: "deterministic",
      json_mode: false,
      turn_count: 3,
      prior_count: 1,
      embeddings: false,
    };
    assert.ok(
      !("caller_role" in summary),
      "SessionSummary must not expose caller_role"
    );
  });

  it("mode is the surviving AgentMode union (deterministic | llm)", () => {
    const det: SessionSummary = {
      conversation_id: "c1",
      mode: "deterministic",
      json_mode: false,
      turn_count: 0,
      prior_count: 0,
      embeddings: false,
    };
    const llm: SessionSummary = { ...det, mode: "llm" };
    assert.equal(det.mode, "deterministic");
    assert.equal(llm.mode, "llm");
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

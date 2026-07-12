import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { createSession } from "../src/agent-loop/session.ts";
import type { IknowAnswer } from "../src/shared/schema.ts";
import {
  createConversation,
  derivePriorsFromAnswer,
  recordTurn,
  resetConversation,
  formatAnswerHuman,
  formatAnswerJson,
} from "../src/interaction/index.ts";

function makeAnswer(
  overrides: Partial<IknowAnswer> &
    Pick<IknowAnswer, "text" | "source_spans" | "snapshot_id">,
): IknowAnswer {
  return {
    governance_status: "ok",
    tool_trace: ["kb_retrieve", "kb_verify_citation", "kb_governance"],
    tool_calls: [
      { tool: "kb_retrieve", args: {}, ordinal: 1 },
      { tool: "kb_verify_citation", args: {}, ordinal: 2 },
      { tool: "kb_governance", args: {}, ordinal: 3 },
    ],
    hops_used: 2,
    ...overrides,
  };
}

describe("interaction: derivePriorsFromAnswer", () => {
  it("returns unique chunk_ids in order and caps at 5", () => {
    const store = createSeededStore();
    const answer = makeAnswer({
      text: "multi span",
      snapshot_id: "snap-unique-test-aaaaaaaa",
      source_spans: [
        { chunk_id: "chunk-refund-30", quote: "q1" },
        { chunk_id: "chunk-refund-30", quote: "dup" },
        { chunk_id: "chunk-refund-60", quote: "q2" },
        { chunk_id: "chunk-onboard", quote: "q3" },
        { chunk_id: "chunk-leave", quote: "q4" },
        { chunk_id: "chunk-refund-30-flow", quote: "q5" },
        { chunk_id: "chunk-extra-should-drop", quote: "q6" },
      ],
    });

    const priors = derivePriorsFromAnswer(answer, store);
    assert.equal(priors.length, 5);
    assert.deepEqual(
      priors.map((p) => p.chunk_id),
      [
        "chunk-refund-30",
        "chunk-refund-60",
        "chunk-onboard",
        "chunk-leave",
        "chunk-refund-30-flow",
      ],
    );
    // store summary preferred over quote for known chunk
    assert.ok(priors[0]!.summary.includes("退款"));
    assert.notEqual(priors[0]!.summary, "q1");
  });

  it("falls back to quote slice ≤200 when store has no chunk", () => {
    const longQuote = "X".repeat(250);
    const answer = makeAnswer({
      text: "fallback",
      snapshot_id: "snap-fallback-bbbbbbbb",
      source_spans: [{ chunk_id: "missing-chunk", quote: longQuote }],
    });
    const priors = derivePriorsFromAnswer(answer, {
      tryGetChunk: () => undefined,
    });
    assert.equal(priors.length, 1);
    assert.equal(priors[0]!.chunk_id, "missing-chunk");
    assert.equal(priors[0]!.summary.length, 200);
    assert.equal(priors[0]!.summary, "X".repeat(200));
  });
});

describe("interaction: recordTurn / resetConversation", () => {
  it("updates last_priors and history_finals", () => {
    const store = createSeededStore();
    const session = createSession("employee");
    const state = createConversation(session);
    assert.ok(state.conversation_id.length > 0);
    assert.equal(state.turns.length, 0);

    const answer = makeAnswer({
      text: "客户可在收货后30天内申请全额退款。",
      snapshot_id: "snap-record-turn-cccccccc",
      source_spans: [
        {
          chunk_id: "chunk-refund-30",
          quote: "客户可在收货后30天内申请全额退款",
        },
      ],
      notes: ["ok"],
    });

    recordTurn(state, "退款政策是什么？", answer, store);

    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0]!.query, "退款政策是什么？");
    assert.equal(state.turns[0]!.answer.snapshot_id, answer.snapshot_id);
    assert.equal(state.last_priors.length, 1);
    assert.equal(state.last_priors[0]!.chunk_id, "chunk-refund-30");
    assert.deepEqual(state.history_finals, [
      { role: "user", content: "退款政策是什么？" },
      {
        role: "assistant",
        content: "客户可在收货后30天内申请全额退款。",
      },
    ]);

    const keptId = state.conversation_id;
    resetConversation(state);
    assert.equal(state.conversation_id, keptId);
    assert.equal(state.session.caller_role, "employee");
    assert.equal(state.turns.length, 0);
    assert.equal(state.last_priors.length, 0);
    assert.equal(state.history_finals.length, 0);
  });
});

describe("interaction: format", () => {
  it("formatAnswerHuman includes snapshot short and governance_status", () => {
    const fullSnap = "abcdef0123456789snapshotfull";
    const answer = makeAnswer({
      text: "答案正文",
      snapshot_id: fullSnap,
      governance_status: "ok",
      source_spans: [
        { chunk_id: "chunk-refund-30", quote: "30天内" },
      ],
      hops_used: 2,
      tool_trace: ["kb_retrieve", "kb_governance"],
      notes: ["note-one"],
    });

    const human = formatAnswerHuman(answer);
    assert.ok(human.includes("答案正文"));
    assert.ok(human.includes("治理: ok"));
    assert.ok(human.includes("snapshot:"));
    // short form present; full id not required in human line
    assert.ok(human.includes(fullSnap.slice(0, 12)));
    assert.ok(human.includes("chunk-refund-30"));
    assert.ok(human.includes("30天内"));
    assert.ok(human.includes("hops: 2"));
    assert.ok(human.includes("kb_retrieve"));
    assert.ok(human.includes("note-one"));

    // conceptual: required envelope fields not dropped from human view
    assert.match(human, /snapshot:\s+\S+/);
    assert.match(human, /治理:\s+\S+/);
  });

  it("formatAnswerJson keeps full snapshot_id and G2 fields", () => {
    const fullSnap = "full-snapshot-id-must-remain-in-json";
    const answer = makeAnswer({
      text: "json body",
      snapshot_id: fullSnap,
      governance_status: "stale",
      source_spans: [{ chunk_id: "c1" }],
    });
    const json = formatAnswerJson(answer);
    const parsed = JSON.parse(json) as IknowAnswer;
    assert.equal(parsed.snapshot_id, fullSnap);
    assert.equal(parsed.governance_status, "stale");
    assert.equal(parsed.source_spans.length, 1);
    assert.ok(Array.isArray(parsed.tool_calls));
    assert.ok(json.includes(fullSnap));
  });
});

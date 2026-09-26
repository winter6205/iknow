/**
 * tests/web/output-limit-notice.test.tsx
 *
 * spec `specs/model-output-truncation.md` SC8 / SC9 / SC11 — the Web client's
 * presentation of an output-limit-truncated turn. The hub projects one
 * deterministic English notice onto the wire (`TurnAnswerDto.outputLimitNotice`);
 * the Web renders that string verbatim and never re-computes the copy, so the
 * live turn and a reopened session cannot drift apart.
 *
 * Style mirrors tests/web/turns-to-messages.test.ts (pure projection) +
 * tests/web/agent-card-activity-order.test.tsx / message-list-notice.test.tsx
 * (renderToStaticMarkup; the web package has no test runner of its own).
 *
 * The wire notice string is a stand-in here on purpose: the client only ever
 * echoes whatever bytes the wire carries, so pinning it to the server constant
 * would couple the presentation layer to copy it must not know. The exact-bytes
 * tie to `OUTPUT_LIMIT_NOTICE` (SSOT) is pinned on the TUI side, which is where
 * the same constant is imported from contract.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  turnsToMessages,
  type ChatUiMessage,
} from "../../web/src/hooks/useSessionChat.ts";
import { StopNotice } from "../../web/src/components/StopNotice.tsx";
import { AgentCard } from "../../web/src/components/AgentCard.tsx";
import {
  STOP_REASON_LABELS,
  stopNoticeLine,
  stopReasonLabel,
} from "../../web/src/lib/stop-reason.ts";
import type { TurnAnswerDto, TurnDto } from "../../web/src/api/types.ts";

/** The wire's output-limit notice for a truncated turn (verbatim, deterministic). */
const WIRE_NOTICE =
  "The model response hit its output limit and did not finish, so this turn's answer is incomplete. Send a new instruction to continue.";
/** renderToStaticMarkup HTML-escapes the apostrophe in "turn's", so HTML
 *  includes-checks use an apostrophe-free fragment; exact-string checks stay on
 *  the raw (non-rendered) projection path. */
const WIRE_NOTICE_HTML = "hit its output limit and did not finish";
/** The generic nonSuccessStop Chinese label the notice must replace. */
const GENERIC_NON_SUCCESS_LABEL = STOP_REASON_LABELS.nonSuccessStop;

function turn(overrides: Partial<TurnAnswerDto> & { query?: string }): TurnDto {
  const { query = "hello", ...answer } = overrides;
  return {
    query,
    answer: {
      finalText: "",
      stopReason: "completed",
      turnCount: 1,
      ...answer,
    },
  };
}

function agentOf(msgs: ChatUiMessage[]): ChatUiMessage | undefined {
  return msgs.find((m) => m.role === "agent");
}

describe("StopNotice — output-limit notice replaces the generic label", () => {
  it("stopNoticeLine: a carried notice wins over the nonSuccessStop label", () => {
    assert.equal(stopNoticeLine("nonSuccessStop", WIRE_NOTICE), WIRE_NOTICE);
    assert.notEqual(
      stopNoticeLine("nonSuccessStop", WIRE_NOTICE),
      GENERIC_NON_SUCCESS_LABEL
    );
  });

  it("stopNoticeLine: no notice → the stop-reason label decides (unchanged)", () => {
    assert.equal(
      stopNoticeLine("nonSuccessStop", undefined),
      GENERIC_NON_SUCCESS_LABEL
    );
    assert.equal(
      stopNoticeLine("maxTurns", undefined),
      STOP_REASON_LABELS.maxTurns
    );
    assert.equal(stopNoticeLine("timeout", null), STOP_REASON_LABELS.timeout);
  });

  it("stopNoticeLine: completed / empty never render a label", () => {
    assert.equal(stopNoticeLine("completed", undefined), null);
    assert.equal(stopNoticeLine(undefined, undefined), null);
    assert.equal(stopNoticeLine("", ""), null);
  });

  it("renders the notice line, not the generic label, under a truncated answer", () => {
    const html = renderToStaticMarkup(
      <StopNotice
        stopReason="nonSuccessStop"
        outputLimitNotice={WIRE_NOTICE}
        turnCount={2}
      />
    );
    assert.ok(html.includes(WIRE_NOTICE_HTML), "notice line rendered verbatim");
    assert.ok(
      !html.includes(GENERIC_NON_SUCCESS_LABEL),
      "generic nonSuccessStop label must not leak"
    );
    // turnCount > 1 still shows alongside the notice.
    assert.ok(html.includes("2 轮"));
  });
});

describe("turnsToMessages — truncated turn keeps notice + committed text (SC8)", () => {
  it("carries the notice verbatim and the committed partial text as the body", () => {
    const msgs = turnsToMessages([
      turn({
        query: "write a long essay",
        finalText: "Here is the beginning of the essay: once upon a time",
        stopReason: "nonSuccessStop",
        outcome: {
          terminal: "known",
          stopReason: "nonSuccessStop",
          supplierDetail: "truncation",
        },
        outputLimitNotice: WIRE_NOTICE,
        turnCount: 4,
      }),
    ]);
    const agent = agentOf(msgs);
    assert.ok(agent, "agent message must be emitted");
    assert.equal(agent!.role, "agent");
    if (agent!.role === "agent") {
      // The committed partial assistant text survives verbatim as the body.
      assert.equal(
        agent!.text,
        "Here is the beginning of the essay: once upon a time"
      );
      // The notice is a projection carried on the answer, not message text.
      assert.equal(agent!.answer.outputLimitNotice, WIRE_NOTICE);
      assert.equal(agent!.answer.finalText, agent!.text);
    }
    // The notice is never folded into the message body text.
    assert.ok(!agent!.text.includes(WIRE_NOTICE));
    // Rendering the card shows BOTH the partial text and the incomplete notice.
    const html = renderToStaticMarkup(
      <AgentCard
        text={agent!.text}
        answer={(agent as { answer: TurnAnswerDto }).answer}
      />
    );
    assert.ok(html.includes("once upon a time"));
    assert.ok(html.includes(WIRE_NOTICE_HTML));
    assert.ok(!html.includes(GENERIC_NON_SUCCESS_LABEL));
  });
});

describe("live-turn shape vs reopened-turn shape → identical notice (SC8)", () => {
  // Both the live send (PostMessageResponse.turn.answer) and a reopened history
  // turn (GetSessionResponse.turns[i].answer) are TurnDto-shaped; the client
  // renders whatever the wire carries, so the two must project the same bytes.
  const truncatedAnswer: TurnAnswerDto = {
    finalText: "partial committed text",
    stopReason: "nonSuccessStop",
    outcome: {
      terminal: "known",
      stopReason: "nonSuccessStop",
      supplierDetail: "truncation",
    },
    outputLimitNotice: WIRE_NOTICE,
    turnCount: 3,
  };

  it("both shapes carry the same notice string and preserve the same body", () => {
    // Reopened history turn (goes through turnsToMessages).
    const reopened = turnsToMessages([{ query: "q", answer: truncatedAnswer }]);
    // Live turn answer (the hook builds the agent bubble from res.turn.answer
    // verbatim — same shape as a history turn's answer).
    const reopenedAgent = agentOf(reopened);
    assert.ok(reopenedAgent?.role === "agent");
    const reopenedNotice = stopNoticeLine(
      reopenedAgent.answer.stopReason,
      reopenedAgent.answer.outputLimitNotice
    );
    const liveNotice = stopNoticeLine(
      truncatedAnswer.stopReason,
      truncatedAnswer.outputLimitNotice
    );
    assert.equal(reopenedNotice, liveNotice);
    assert.equal(reopenedNotice, WIRE_NOTICE);
    assert.equal(reopenedAgent.text, truncatedAnswer.finalText);
  });

  it("renders byte-identical StopNotice DOM for the live and reopened answer", () => {
    const live = renderToStaticMarkup(
      <StopNotice
        stopReason={truncatedAnswer.stopReason}
        outputLimitNotice={truncatedAnswer.outputLimitNotice}
        turnCount={truncatedAnswer.turnCount}
      />
    );
    const reopenedTurns = turnsToMessages([
      { query: "q", answer: truncatedAnswer },
    ]);
    const reopenedAgent = agentOf(reopenedTurns);
    assert.ok(reopenedAgent?.role === "agent");
    const reopened = renderToStaticMarkup(
      <StopNotice
        stopReason={reopenedAgent.answer.stopReason}
        outputLimitNotice={reopenedAgent.answer.outputLimitNotice}
        turnCount={reopenedAgent.answer.turnCount}
      />
    );
    assert.equal(live, reopened);
    assert.ok(live.includes(WIRE_NOTICE_HTML));
  });
});

describe("unknown outcome → neither notice nor completed/incomplete label (SC11)", () => {
  it("stopNoticeLine renders nothing for an unknown-outcome answer", () => {
    // outcome {terminal:"unknown"} → the wire carries neither stopReason nor a
    // notice. The client must fail quiet: no label either way.
    assert.equal(stopNoticeLine(undefined, undefined), null);
  });

  it("StopNotice renders no label and no notice for an unknown outcome", () => {
    const html = renderToStaticMarkup(
      <StopNotice
        stopReason={undefined}
        outputLimitNotice={undefined}
        turnCount={1}
      />
    );
    assert.equal(html, "");
    for (const label of Object.values(STOP_REASON_LABELS)) {
      assert.ok(!html.includes(label), `no stop label may render: ${label}`);
    }
    assert.ok(!html.includes(WIRE_NOTICE_HTML));
  });

  it("a committed answer with an unknown outcome shows its text but no label", () => {
    const msgs = turnsToMessages([
      turn({
        query: "legacy history",
        finalText: "a committed answer",
        stopReason: undefined,
        outcome: { terminal: "unknown" },
      }),
    ]);
    const agent = agentOf(msgs);
    assert.ok(agent?.role === "agent");
    if (agent.role === "agent") {
      assert.equal(agent.text, "a committed answer");
      assert.equal(agent.answer.outputLimitNotice, undefined);
    }
    const html = renderToStaticMarkup(
      <StopNotice stopReason={undefined} turnCount={1} />
    );
    assert.equal(html, ""); // no completed / incomplete label at all
  });

  it("stopReasonLabel is unchanged for the label map (regression guard)", () => {
    assert.equal(stopReasonLabel("nonSuccessStop"), GENERIC_NON_SUCCESS_LABEL);
    assert.equal(stopReasonLabel("unknown"), null);
  });
});

describe("thinking-only truncation → no answer body, notice visible (SC9)", () => {
  it("keeps a notice-only turn (empty text, thinking) so the notice stays on screen", () => {
    const msgs = turnsToMessages([
      turn({
        query: "reason then truncate",
        finalText: "",
        stopReason: "nonSuccessStop",
        thinking: { entries: [{ text: "thinking …" }], redactedCount: 0 },
        outputLimitNotice: WIRE_NOTICE,
        turnCount: 1,
      }),
    ]);
    const agent = agentOf(msgs);
    assert.ok(agent, "notice-only turn must not be dropped");
    assert.equal(agent!.role, "agent");
    if (agent!.role === "agent") {
      assert.equal(agent!.text, ""); // no assistant answer body
      assert.equal(agent!.answer.outputLimitNotice, WIRE_NOTICE);
    }
    const html = renderToStaticMarkup(
      <AgentCard text="" answer={(agent as { answer: TurnAnswerDto }).answer} />
    );
    // The notice is visible; there is no committed body text to speak of.
    assert.ok(html.includes(WIRE_NOTICE_HTML));
    assert.ok(!html.includes(GENERIC_NON_SUCCESS_LABEL));
  });

  it("keeps even a text-less, thinking-less turn that carries only a notice", () => {
    const msgs = turnsToMessages([
      turn({
        query: "bare notice",
        finalText: "",
        stopReason: "nonSuccessStop",
        outputLimitNotice: WIRE_NOTICE,
        turnCount: 1,
      }),
    ]);
    assert.equal(msgs.filter((m) => m.role === "agent").length, 1);
  });

  it("still drops a turn with empty text, no thinking, no tools AND no notice", () => {
    const msgs = turnsToMessages([
      turn({
        query: "blank",
        finalText: "",
        stopReason: "emptyFinalResponse",
      }),
    ]);
    assert.equal(msgs.filter((m) => m.role === "agent").length, 0);
  });
});

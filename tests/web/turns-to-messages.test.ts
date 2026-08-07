/**
 * turnsToMessages pure-helper tests (H2 / code-review 双轴整改).
 *
 * Mirrors tests/web/stop-reason.test.ts style: vitest describe/it +
 * node:assert/strict, root vitest (node env). Only imports the pure function
 * (the module's react hook imports are module-level and never invoked here).
 *
 * Covers the H2 regression: a turn with empty finalText but tool_use and/or
 * thinking must still emit an agent message (previously the whole turn was
 * dropped by `if (t.answer.finalText.trim())`).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { turnsToMessages } from "../../web/src/hooks/useSessionChat.ts";
import type { TurnDto } from "../../web/src/api/types.ts";

function turn(overrides: Partial<TurnDto> & { query?: string }): TurnDto {
  return {
    query: "hello",
    answer: {
      finalText: "",
      stopReason: "completed",
      turnCount: 1,
    },
    ...overrides,
  };
}

describe("turnsToMessages — plain text turn", () => {
  it("emits user + agent messages for a non-empty finalText", () => {
    const msgs = turnsToMessages([
      turn({
        query: "q",
        answer: {
          finalText: "the answer",
          stopReason: "completed",
          turnCount: 1,
        },
      }),
    ]);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.role, "user");
    assert.equal(msgs[0]!.text, "q");
    assert.equal(msgs[1]!.role, "agent");
    assert.equal(msgs[1]!.text, "the answer");
  });

  it("skips empty user turns (no blank pill)", () => {
    const msgs = turnsToMessages([turn({ query: "   " })]);
    assert.equal(msgs.filter((m) => m.role === "user").length, 0);
  });
});

describe("turnsToMessages — empty finalText with thinking/toolCalls (H2)", () => {
  it("keeps a turn that has thinking but empty finalText", () => {
    const msgs = turnsToMessages([
      turn({
        query: "think",
        answer: {
          finalText: "",
          stopReason: "maxTurns",
          turnCount: 3,
          thinking: { entries: [{ text: "working on it" }], redactedCount: 0 },
        },
      }),
    ]);
    const agent = msgs.find((m) => m.role === "agent");
    assert.ok(agent, "agent message must be emitted");
    assert.equal(agent!.text, "");
    assert.equal(
      agent!.role === "agent" && agent.answer?.thinking?.entries[0]?.text,
      "working on it"
    );
  });

  it("keeps a turn that has toolCalls but empty finalText", () => {
    const msgs = turnsToMessages([
      turn({
        query: "use tool",
        answer: {
          finalText: "",
          stopReason: "maxTurns",
          turnCount: 2,
          toolCalls: [
            {
              id: "t1",
              name: "echo",
              inputPreview: "{}",
              outputPreview: "ok",
              isError: false,
              truncated: false,
            },
          ],
        },
      }),
    ]);
    const agent = msgs.find((m) => m.role === "agent");
    assert.ok(agent, "agent message must be emitted");
    assert.equal(agent!.text, "");
    assert.equal(agent!.role === "agent" && agent.answer?.toolCalls?.length, 1);
  });

  it("keeps a turn that has both thinking and toolCalls, empty finalText", () => {
    const msgs = turnsToMessages([
      turn({
        query: "both",
        answer: {
          finalText: "",
          stopReason: "timeout",
          turnCount: 5,
          thinking: { entries: [{ text: "a" }], redactedCount: 0 },
          toolCalls: [
            {
              id: "t1",
              name: "echo",
              inputPreview: "{}",
              outputPreview: "ok",
              isError: false,
              truncated: false,
            },
          ],
        },
      }),
    ]);
    assert.equal(msgs.filter((m) => m.role === "agent").length, 1);
  });

  it("keeps answer.lastUsage on the projected agent message", () => {
    const lastUsage = {
      inputTokens: 120,
      outputTokens: 30,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 90,
    };
    const msgs = turnsToMessages([
      turn({
        query: "usage",
        answer: {
          finalText: "done",
          stopReason: "completed",
          turnCount: 1,
          lastUsage,
        },
      }),
    ]);
    const agent = msgs.find((m) => m.role === "agent");
    assert.ok(agent, "agent message must be emitted");
    assert.deepEqual(
      agent!.role === "agent" && agent.answer.lastUsage,
      lastUsage
    );
  });

  it("still drops a turn with empty finalText AND no thinking AND no toolCalls", () => {
    const msgs = turnsToMessages([
      turn({
        query: "blank",
        answer: {
          finalText: "",
          stopReason: "emptyFinalResponse",
          turnCount: 1,
        },
      }),
    ]);
    assert.equal(msgs.filter((m) => m.role === "agent").length, 0);
  });

  it("drops a turn with empty toolCalls array AND no thinking AND empty finalText", () => {
    const msgs = turnsToMessages([
      turn({
        query: "empty calls",
        answer: {
          finalText: "",
          stopReason: "completed",
          turnCount: 1,
          toolCalls: [],
        },
      }),
    ]);
    assert.equal(msgs.filter((m) => m.role === "agent").length, 0);
  });
});

describe("turnsToMessages — whitespace-only finalText", () => {
  it("treats whitespace-only finalText as empty", () => {
    const msgs = turnsToMessages([
      turn({
        query: "ws",
        answer: { finalText: "   ", stopReason: "completed", turnCount: 1 },
      }),
    ]);
    assert.equal(msgs.filter((m) => m.role === "agent").length, 0);
  });
});

/**
 * tests/harness/turn-boundary.test.ts
 *
 * The turn-boundary rule lives in the harness layer so the harness can slice
 * by it without reaching up into session-api. Input classes: normal / failure
 * (non-query roles, continuation, host injection) / boundary (empty list,
 * out-of-range start) / missing (no query at all).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../src/harness/model-adapter/types.ts";
import {
  isTurnQuery,
  lastTurnQueryIndex,
  messageText,
  sliceTurnFrom,
} from "../../src/harness/turn-boundary.ts";
import { SUBAGENT_DRAIN_PREFIX } from "../../src/harness/subagent/host-drain.ts";
import { AGENT_STATUS_OPEN_TAG } from "../../src/harness/agent-status.ts";
import { IKNOW_GRAPH_MODE_ON_NOTIFICATION } from "../../src/harness/graph/notification.ts";
import { SKILL_INDEX_DELTA_PREFIX } from "../../src/harness/skill/index-delta.ts";

function msg(
  role: AnthropicNativeMessage["role"],
  content: readonly AnthropicContentBlock[]
): AnthropicNativeMessage {
  return { role, content } as AnthropicNativeMessage;
}

function userText(text: string): AnthropicNativeMessage {
  return msg("user", [{ type: "text", text }]);
}

function toolResultUser(id: string): AnthropicNativeMessage {
  return msg("user", [{ type: "tool_result", tool_use_id: id, content: "ok" }]);
}

function assistantText(text: string): AnthropicNativeMessage {
  return msg("assistant", [{ type: "text", text }]);
}

describe("messageText", () => {
  it("joins text blocks with a single space; non-text blocks ignored", () => {
    assert.equal(
      messageText(
        msg("user", [
          { type: "text", text: "a" },
          { type: "tool_result", tool_use_id: "t1", content: "skip" },
          { type: "text", text: "b" },
        ])
      ),
      "a b"
    );
  });

  it("no text block → empty string", () => {
    assert.equal(messageText(toolResultUser("t1")), "");
  });

  it("empty content → empty string", () => {
    assert.equal(messageText(msg("user", [])), "");
  });
});

describe("isTurnQuery — real query", () => {
  it("plain user text message is a query", () => {
    assert.equal(isTurnQuery(userText("refactor the gate")), true);
  });

  it("assistant message is never a query", () => {
    assert.equal(isTurnQuery(assistantText("done")), false);
  });

  it("user message carrying a tool_result block is a continuation, not a query", () => {
    assert.equal(
      isTurnQuery(
        msg("user", [
          { type: "text", text: "also some text" },
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ])
      ),
      false
    );
  });
});

describe("isTurnQuery — host-injected envelopes are never a query", () => {
  it("subagent drain summary", () => {
    assert.equal(
      isTurnQuery(
        userText(`${SUBAGENT_DRAIN_PREFIX}task_1 result: sum\n\nbody`)
      ),
      false
    );
  });

  it("agent_status bar", () => {
    assert.equal(
      isTurnQuery(
        userText(`${AGENT_STATUS_OPEN_TAG}\nlast_tool: idle\n</agent_status>`)
      ),
      false
    );
  });

  it("graph_mode notification", () => {
    assert.equal(
      isTurnQuery(userText(IKNOW_GRAPH_MODE_ON_NOTIFICATION)),
      false
    );
  });

  it("skill index delta listing", () => {
    assert.equal(
      isTurnQuery(
        userText(`${SKILL_INDEX_DELTA_PREFIX}\n- foo\n</available_skills>`)
      ),
      false
    );
  });

  it("leading whitespace before an injected envelope still hides it", () => {
    assert.equal(
      isTurnQuery(userText(`  ${AGENT_STATUS_OPEN_TAG}\nlast_tool: idle`)),
      false
    );
  });
});

describe("lastTurnQueryIndex", () => {
  it("empty history → -1", () => {
    assert.equal(lastTurnQueryIndex([]), -1);
  });

  it("no user query at all → -1", () => {
    assert.equal(
      lastTurnQueryIndex([assistantText("a"), toolResultUser("t1")]),
      -1
    );
  });

  it("boundary sits at the LAST real query when earlier user messages are tool_result continuations", () => {
    const messages = [
      userText("first task"),
      assistantText("working"),
      toolResultUser("t1"),
      toolResultUser("t2"),
      assistantText("halfway"),
      userText("second task"),
      assistantText("done"),
      toolResultUser("t3"),
    ];
    assert.equal(lastTurnQueryIndex(messages), 5);
  });

  it("host-injected user messages do not move the boundary", () => {
    const messages = [
      userText("real task"),
      assistantText("working"),
      userText(IKNOW_GRAPH_MODE_ON_NOTIFICATION),
    ];
    assert.equal(lastTurnQueryIndex(messages), 0);
  });
});

describe("sliceTurnFrom", () => {
  const messages = [
    userText("first"),
    assistantText("a1"),
    userText("second"),
    assistantText("a2"),
  ];

  it("start is inclusive and runs to the end", () => {
    assert.deepEqual(sliceTurnFrom(messages, 2), messages.slice(2));
  });

  it("negative start → empty (a missing query must not mean the whole history)", () => {
    assert.deepEqual(sliceTurnFrom(messages, -1), []);
  });

  it("out-of-range start → empty", () => {
    assert.deepEqual(sliceTurnFrom(messages, messages.length), []);
    assert.deepEqual(sliceTurnFrom(messages, messages.length + 40), []);
  });

  it("empty history → empty for any start", () => {
    assert.deepEqual(sliceTurnFrom([], 0), []);
    assert.deepEqual(sliceTurnFrom([], -1), []);
  });

  it("no query anywhere → empty slice, never the full history", () => {
    const history = [assistantText("a1"), toolResultUser("t1")];
    assert.deepEqual(sliceTurnFrom(history, lastTurnQueryIndex(history)), []);
  });
});

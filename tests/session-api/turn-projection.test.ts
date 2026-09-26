/**
 * Pure-function tests for turn-projection (T1).
 *
 * Boundary classes (per arthurpower:defensive-contract-validator):
 *   - empty:    empty input → undefined
 *   - normal:   mixed thinking + toolCalls projection, block order preserved
 *   - redacted: redacted_thinking → redactedCount, no entries
 *   - overflow: truncation at 2000 / 500 / 1500
 *   - mask:     mask applied before truncation
 *   - missing:  tool_use without matching tool_result → outputPreview="", isError=false
 *   - boundary: empty thinking text → skipped; no thinking at all → undefined
 *   - error:    tool_result.is_error=true → isError=true
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";
import { projectMessagesToTurns, type TurnOutcomeEvidence } from "../../src/session-api/hub.ts";
import type { SessionOutcomeRecord } from "../../src/session-api/store/index.ts";
import { OUTPUT_LIMIT_NOTICE } from "../../src/session-api/contract.ts";
import { SUBAGENT_DRAIN_PREFIX } from "../../src/harness/subagent/host-drain.ts";
import {
  IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
  IKNOW_GRAPH_MODE_ON_NOTIFICATION,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  isGraphModeText,
} from "../../src/harness/graph/notification.ts";
import {
  SKILL_INDEX_DELTA_PREFIX,
  isSkillIndexDeltaText,
} from "../../src/harness/skill/index-delta.ts";
import { buildAgentStatusText } from "../../src/harness/agent-status.ts";
import {
  MAX_THINKING_TEXT_CHARS,
  MAX_TOOL_INPUT_PREVIEW_CHARS,
  MAX_TOOL_OUTPUT_PREVIEW_CHARS,
  extractRecentUserTasks,
  isTaskExcerptText,
  isTurnQuery,
  messageText,
  projectThinkingView,
  projectToolCalls,
  shouldSeedTaskFocus,
  sumAssistantThinkingMsInRange,
  TASK_EXCERPT_PREFIX,
} from "../../src/session-api/turn-projection.ts";

// helpers ---------------------------------------------------------------

const identity = (s: string): string => s;
/** Replace any occurrence of `secret` with `***` for SC20 boundary checks. */
const maskSecret =
  (secret: string): ((s: string) => string) =>
  (s: string): string =>
    s.split(secret).join("***");

const assistant = (
  role: "user" | "assistant",
  blocks: ReadonlyArray<AnthropicNativeMessage["content"][number]>
): AnthropicNativeMessage => ({ role, content: blocks });

// -- boundary 1: empty ----------------------------------------------------

describe("boundary: empty input", () => {
  it("projectThinkingView([]) → undefined", () => {
    assert.equal(projectThinkingView([], identity), undefined);
  });

  it("projectToolCalls([]) → undefined", () => {
    assert.equal(projectToolCalls([], identity), undefined);
  });

  it("messages with no thinking/toolUse → both undefined", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "hi" }]),
      assistant("assistant", [{ type: "text", text: "hello" }]),
    ];
    assert.equal(projectThinkingView(messages, identity), undefined);
    assert.equal(projectToolCalls(messages, identity), undefined);
  });
});

// -- boundary 2: normal projection ---------------------------------------

describe("boundary: normal projection", () => {
  it("thinking entry text is masked-then-truncated; redacted counted separately", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: "deep thought", signature: "sig" },
        { type: "redacted_thinking", data: "encrypted-blob" },
        { type: "text", text: "final answer" },
      ]),
    ];
    const view = projectThinkingView(messages, identity);
    assert.deepEqual(view, {
      entries: [{ text: "deep thought" }],
      redactedCount: 1,
    });
  });

  it("thinking + toolCalls on the wire (block order across messages preserved)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "do stuff" }]),
      assistant("assistant", [
        { type: "thinking", thinking: "plan", signature: "s" },
        { type: "tool_use", id: "t1", name: "noop", input: { q: 1 } },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "ok" }],
        },
      ]),
      assistant("assistant", [
        { type: "thinking", thinking: "wrap", signature: "s2" },
        { type: "text", text: "done" },
      ]),
    ];
    const thinking = projectThinkingView(messages, identity);
    const toolCalls = projectToolCalls(messages, identity);
    assert.deepEqual(thinking, {
      entries: [{ text: "plan" }, { text: "wrap" }],
      redactedCount: 0,
    });
    assert.deepEqual(toolCalls, [
      {
        id: "t1",
        name: "noop",
        inputPreview: '{"q":1}',
        outputPreview: "ok",
        isError: false,
        truncated: false,
      },
    ]);
  });

  it("tool_result with is_error=true → isError propagated", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "x",
          is_error: true,
          content: [{ type: "text", text: "boom" }],
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    assert.equal(toolCalls?.length, 1);
    assert.equal(toolCalls?.[0]?.isError, true);
    assert.equal(toolCalls?.[0]?.outputPreview, "boom");
  });
});

// -- boundary 3: redacted alone ------------------------------------------

describe("boundary: redacted only (no entries)", () => {
  it("only redacted_thinking → ThinkingView with empty entries, redactedCount=N", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "redacted_thinking", data: "blob1" },
        { type: "redacted_thinking", data: "blob2" },
      ]),
    ];
    const view = projectThinkingView(messages, identity);
    assert.deepEqual(view, { entries: [], redactedCount: 2 });
  });
});

// -- boundary 4: overflow / truncation ----------------------------------

describe("boundary: overflow — truncation caps", () => {
  const overflowText = "x".repeat(MAX_THINKING_TEXT_CHARS + 100);
  const overflowInput = { pad: "y".repeat(MAX_TOOL_INPUT_PREVIEW_CHARS + 50) };
  const overflowOutput = "z".repeat(MAX_TOOL_OUTPUT_PREVIEW_CHARS + 50);

  it("thinking text truncated at MAX_THINKING_TEXT_CHARS with ellipsis", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: overflowText, signature: "s" },
      ]),
    ];
    const view = projectThinkingView(messages, identity);
    const text = view?.entries[0]?.text;
    assert.ok(text !== undefined);
    assert.equal(text.length, MAX_THINKING_TEXT_CHARS + 1); // + "…"
    assert.ok(text.endsWith("…"));
  });

  it("inputPreview truncated at MAX_TOOL_INPUT_PREVIEW_CHARS", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: overflowInput },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    const preview = toolCalls?.[0]?.inputPreview;
    assert.ok(preview !== undefined);
    assert.equal(preview.length, MAX_TOOL_INPUT_PREVIEW_CHARS + 1);
    assert.ok(preview.endsWith("…"));
  });

  it("outputPreview truncated and truncated=true when over cap", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "x",
          content: [{ type: "text", text: overflowOutput }],
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    const entry = toolCalls?.[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.truncated, true);
    assert.equal(entry.outputPreview.length, MAX_TOOL_OUTPUT_PREVIEW_CHARS + 1);
    assert.ok(entry.outputPreview.endsWith("…"));
  });

  it("short output is NOT truncated (truncated=false)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "x",
          content: [{ type: "text", text: "tiny" }],
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    assert.equal(toolCalls?.[0]?.truncated, false);
    assert.equal(toolCalls?.[0]?.outputPreview, "tiny");
  });
});

// -- boundary 5: mask applied before truncation --------------------------

describe("boundary: mask", () => {
  it("mask applied to thinking text before truncation", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        {
          type: "thinking",
          thinking: "secret-token-alpha-plan",
          signature: "s",
        },
      ]),
    ];
    const view = projectThinkingView(messages, maskSecret("secret-token"));
    assert.equal(view?.entries[0]?.text, "***-alpha-plan");
  });

  it("mask applied to outputPreview", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "x",
          content: [{ type: "text", text: "here is secret-token" }],
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, maskSecret("secret-token"));
    assert.equal(toolCalls?.[0]?.outputPreview, "here is ***");
  });

  it("mask applied to inputPreview", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        {
          type: "tool_use",
          id: "x",
          name: "noop",
          input: { token: "secret-token" },
        },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, maskSecret("secret-token"));
    assert.equal(toolCalls?.[0]?.inputPreview, '{"token":"***"}');
  });
});

// -- boundary 6: tool_result missing -------------------------------------

describe("boundary: missing tool_result", () => {
  it('tool_use without matching tool_result → outputPreview="", isError=false, truncated=false', () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "x", name: "noop", input: {} },
      ]),
    ];
    const toolCalls = projectToolCalls(messages, identity);
    assert.deepEqual(toolCalls, [
      {
        id: "x",
        name: "noop",
        inputPreview: "{}",
        outputPreview: "",
        isError: false,
        truncated: false,
      },
    ]);
  });
});

// -- boundary 7: empty thinking text skipped ----------------------------

describe("boundary: empty thinking text", () => {
  it("thinking block with empty text → no entry; if no other thinking → undefined", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "hi" },
      ]),
    ];
    assert.equal(projectThinkingView(messages, identity), undefined);
  });

  it("empty thinking + a redacted_thinking → ThinkingView (entries empty, redactedCount>0)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "redacted_thinking", data: "blob" },
      ]),
    ];
    const view = projectThinkingView(messages, identity);
    assert.deepEqual(view, { entries: [], redactedCount: 1 });
  });
});

// -- boundary 8: block order preservation -------------------------------

describe("boundary: block order across multiple assistant turns", () => {
  it("entries and toolCalls preserve order across multiple assistant messages", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "thinking", thinking: "first", signature: "s" },
      ]),
      assistant("assistant", [
        { type: "tool_use", id: "t1", name: "a", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "r1" }],
        },
      ]),
      assistant("assistant", [
        { type: "thinking", thinking: "second", signature: "s" },
      ]),
      assistant("assistant", [
        { type: "tool_use", id: "t2", name: "b", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: "r2" }],
        },
      ]),
    ];
    const thinking = projectThinkingView(messages, identity);
    const toolCalls = projectToolCalls(messages, identity);
    assert.deepEqual(
      thinking?.entries.map((e) => e.text),
      ["first", "second"]
    );
    assert.deepEqual(
      toolCalls?.map((c) => c.id),
      ["t1", "t2"]
    );
  });
});

// -- boundary 9: subagent drain user messages ---------------------------
// host-drain condenses completed sub-agent results into a
// `## Sub-agent <id> result: ...` user message appended to history; the display
// projection must neither expose it as a query nor let it cut the previous turn's slice.

describe("boundary: subagent drain messages in projectMessagesToTurns", () => {
  const drainText = "## Sub-agent task_1 result: sum\n\nresult body";
  const drainMsg = assistant("user", [{ type: "text", text: drainText }]);

  it("drain user message is not projected as a turn query", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "q1" }]),
      assistant("assistant", [{ type: "text", text: "a1" }]),
      drainMsg,
      assistant("assistant", [{ type: "text", text: "ack" }]),
      assistant("user", [{ type: "text", text: "q2" }]),
      assistant("assistant", [{ type: "text", text: "a2" }]),
    ];
    const turns = projectMessagesToTurns(messages);
    assert.deepEqual(
      turns.map((t) => t.query),
      ["q1", "q2"]
    );
    for (const t of turns) {
      assert.ok(!t.query.startsWith(SUBAGENT_DRAIN_PREFIX.trim()));
    }
  });

  it("drain message does not cut the preceding turn's slice", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "q1" }]),
      assistant("assistant", [
        { type: "tool_use", id: "t1", name: "noop", input: {} },
      ]),
      drainMsg,
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "ok" }],
        },
      ]),
      assistant("assistant", [{ type: "text", text: "final" }]),
      assistant("user", [{ type: "text", text: "q2" }]),
      assistant("assistant", [{ type: "text", text: "a2" }]),
    ];
    const turns = projectMessagesToTurns(messages);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.query, "q1");
    // slice not cut by the drain: tool_result still lands inside turn 1, pairing succeeds.
    assert.equal(turns[0]?.answer.toolCalls?.[0]?.outputPreview, "ok");
    assert.equal(turns[0]?.answer.finalText, "final");
    assert.equal(turns[1]?.query, "q2");
    assert.equal(turns[1]?.answer.finalText, "a2");
  });

  it("history containing only drain messages projects to []", () => {
    const messages: AnthropicNativeMessage[] = [
      drainMsg,
      assistant("assistant", [{ type: "text", text: "ack" }]),
    ];
    assert.deepEqual(projectMessagesToTurns(messages), []);
  });
});

// -- boundary 10: graph_mode presence user messages --------------------
// ADR-0081: while the graph is open, each run() starts with a short <graph_mode>
// presence line (after the turn's query, before the assistant reply). It is a
// host-injected envelope: it must neither open a new turn on the serve/web surface
// nor cut the previous turn's slice at its query — otherwise the real query's answer
// would be swallowed into the presence's turn.

describe("boundary: graph_mode presence in projectMessagesToTurns", () => {
  const presenceMsg = assistant("user", [
    { type: "text", text: IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION },
  ]);

  it("presence message is not projected as a turn query", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "q1" }]),
      presenceMsg,
      assistant("assistant", [{ type: "text", text: "a1" }]),
      assistant("user", [{ type: "text", text: "q2" }]),
      presenceMsg,
      assistant("assistant", [{ type: "text", text: "a2" }]),
    ];
    const turns = projectMessagesToTurns(messages);
    assert.deepEqual(
      turns.map((t) => t.query),
      ["q1", "q2"]
    );
  });

  it("presence message does not cut the preceding turn's slice", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "q1" }]),
      assistant("assistant", [
        { type: "tool_use", id: "t1", name: "noop", input: {} },
      ]),
      presenceMsg,
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "ok" }],
        },
      ]),
      assistant("assistant", [{ type: "text", text: "final" }]),
      assistant("user", [{ type: "text", text: "q2" }]),
      assistant("assistant", [{ type: "text", text: "a2" }]),
    ];
    const turns = projectMessagesToTurns(messages);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.query, "q1");
    // slice not cut by the presence line: tool_result still lands inside turn 1, pairing succeeds.
    assert.equal(turns[0]?.answer.toolCalls?.[0]?.outputPreview, "ok");
    assert.equal(turns[0]?.answer.finalText, "final");
    assert.equal(turns[1]?.query, "q2");
    assert.equal(turns[1]?.answer.finalText, "a2");
  });

  it("history containing only presence messages projects to []", () => {
    const messages: AnthropicNativeMessage[] = [
      presenceMsg,
      assistant("assistant", [{ type: "text", text: "ack" }]),
    ];
    assert.deepEqual(projectMessagesToTurns(messages), []);
  });
});

// -- shared turn-boundary helpers (hub.ts + store/checkpoint.ts SSOT) ----

describe("messageText — 文本块拼接（共享 helper）", () => {
  it("多个 text 块按空格连接", () => {
    const msg = assistant("user", [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    assert.equal(messageText(msg), "a b");
  });

  it("非 text 块被忽略；无 text 块 → 空串", () => {
    const msg = assistant("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "inner" }],
      },
    ]);
    assert.equal(messageText(msg), "");
  });
});

describe("isTurnQuery — turn 边界判定（共享 helper）", () => {
  it("普通 user 文本消息 → true", () => {
    assert.equal(
      isTurnQuery(assistant("user", [{ type: "text", text: "q" }])),
      true
    );
  });

  it("assistant 消息 → false", () => {
    assert.equal(
      isTurnQuery(assistant("assistant", [{ type: "text", text: "a" }])),
      false
    );
  });

  it("携带 tool_result 块的 user 消息 → false（续接非 query）", () => {
    assert.equal(
      isTurnQuery(
        assistant("user", [
          { type: "text", text: "q" },
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "ok" }],
          },
        ])
      ),
      false
    );
  });

  it("subagent drain summary user 消息 → false（host 注入非 query）", () => {
    assert.equal(
      isTurnQuery(
        assistant("user", [
          {
            type: "text",
            text: `${SUBAGENT_DRAIN_PREFIX}task_1 result: sum\n\nbody`,
          },
        ])
      ),
      false
    );
  });

  it("agent_status 栏 user 消息 → false（host 注入非 query）", () => {
    assert.equal(
      isTurnQuery(
        assistant("user", [
          {
            type: "text",
            text: "<agent_status>\nlast_tool: idle\n</agent_status>",
          },
        ])
      ),
      false
    );
  });

  // spec agent-status-instruction-echo SC4: after the bar additively grows
  // instruction / reconcile sections it still matches on the `<agent_status>` prefix — turn-boundary predicate unchanged.
  it("含 instruction/reconcile 段的新格式栏 → false；真实消息含该字样不误伤", () => {
    const bar = buildAgentStatusText({
      lastTool: "bash",
      openTodoLines: ["- [ ] 查新闻"],
      instruction: "pivot：改查天气",
      reconcile: true,
    });
    assert.equal(
      isTurnQuery(assistant("user", [{ type: "text", text: bar }])),
      false
    );
    assert.equal(
      isTurnQuery(
        assistant("user", [
          { type: "text", text: "instruction: 开头的真实问题" },
        ])
      ),
      true
    );
  });

  // The three graph presence notifications are all host-injected envelopes, not operator
  // keystrokes — the same "hidden injection" list as TUI's `isTuiHiddenUserMessage`. The
  // predicate must come from the producer itself (isGraphModeText); consumers must not write their own prefix check.
  it("graph_mode 三条现势通知 user 消息 → false（host 注入非 query）", () => {
    for (const text of [
      IKNOW_GRAPH_MODE_ON_NOTIFICATION,
      IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
      IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
    ]) {
      assert.equal(isGraphModeText(text), true, "生产者谓词必须命中自家常量");
      assert.equal(
        isTurnQuery(assistant("user", [{ type: "text", text }])),
        false
      );
    }
  });

  it("前导空白容忍（与 agent_status / TUI hidden 同款 trimStart）", () => {
    assert.equal(
      isTurnQuery(
        assistant("user", [
          {
            type: "text",
            text: `\n  ${IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION}`,
          },
        ])
      ),
      false
    );
  });

  it("正文里提到 <graph_mode> 但非行首 → 仍是 query（不误伤用户话）", () => {
    assert.equal(
      isTurnQuery(
        assistant("user", [
          { type: "text", text: "为什么 transcript 里有 <graph_mode> 标签？" },
        ])
      ),
      true
    );
  });

  // ADR-0098: the incremental listing is a host-injected envelope (the fifth kind), not
  // operator keystrokes — Web user bubble / turn boundary as above. The predicate must
  // come from the producer itself (isSkillIndexDeltaText); consumers must not write their
  // own prefix check (same shape as the graph_mode case: first pin that the producer's
  // predicate hits its own constant, then pin that the consumer side returns false).
  it("skill-index delta listing user 消息 → false（host 注入非 query）", () => {
    const listing = `${SKILL_INDEX_DELTA_PREFIX}\nalpha: Alpha skill\n</available_skills>`;
    assert.equal(
      isSkillIndexDeltaText(listing),
      true,
      "生产者谓词必须命中自家产物"
    );
    assert.equal(
      isTurnQuery(assistant("user", [{ type: "text", text: listing }])),
      false
    );
  });

  it("delta listing 前导空白 / 多行 → 仍 false（trimStart 同款）", () => {
    assert.equal(
      isTurnQuery(
        assistant("user", [
          {
            type: "text",
            text: `\n  ${SKILL_INDEX_DELTA_PREFIX}\nalpha: A\nzulu: Z\n</available_skills>`,
          },
        ])
      ),
      false
    );
  });

  it("正文里提到 <available_skills> 但非行首 → 仍是 query（不误伤用户话）", () => {
    assert.equal(
      isTurnQuery(
        assistant("user", [
          { type: "text", text: "为什么 transcript 里有 <available_skills>？" },
        ])
      ),
      true
    );
  });
});

// -- extractRecentUserTasks — pure task-excerpt function -------------------------
//
// Contract:
//   - iterate messages in reverse, taking at most 3 qualifying user-turn texts (trimmed);
//   - qualifying = isTurnQuery + shouldSeedTaskFocus (chit-chat filter) + non self-reference
//     (excerpt text carrying the TASK_EXCERPT_PREFIX is never re-extracted by the next round);
//   - 0 sentences -> []; assistant / tool_result / chit-chat / drain / whitespace are never taken;
//   - order: returns chronological (oldest -> newest), latest last.

describe("extractRecentUserTasks — task excerpt pure function (#604 T1)", () => {
  // empty ---------------------------------------------------------------
  it("empty messages → []", () => {
    assert.deepEqual(extractRecentUserTasks([]), []);
  });

  // negative ------------------------------------------------------------
  it("only greetings → [] (寒暄不过)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "你好" }]),
      assistant("user", [{ type: "text", text: "hello" }]),
      assistant("user", [{ type: "text", text: "thanks" }]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), []);
  });

  it("only tool_results (无 text user) → []", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        { type: "tool_use", id: "t1", name: "noop", input: {} },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "ok" }],
        },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: "fine" }],
        },
      ]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), []);
  });

  it("only assistant messages → []", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [{ type: "text", text: "hi" }]),
      assistant("assistant", [{ type: "text", text: "again" }]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), []);
  });

  // normal: 1 turn ------------------------------------------------------
  it("single qualifying user turn → [that turn, trimmed]", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "  please ship it  " }]),
      assistant("assistant", [{ type: "text", text: "ok" }]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), ["please ship it"]);
  });

  // normal: 3 turns chronological, latest last -------------------------
  it("3 qualifying turns → all 3, latest last (chronological order)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "first task" }]),
      assistant("assistant", [{ type: "text", text: "ok1" }]),
      assistant("user", [{ type: "text", text: "second task" }]),
      assistant("assistant", [{ type: "text", text: "ok2" }]),
      assistant("user", [{ type: "text", text: "third task" }]),
      assistant("assistant", [{ type: "text", text: "ok3" }]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), [
      "first task",
      "second task",
      "third task",
    ]);
  });

  // overflow limit: cap 3 (default) ------------------------------------
  it("5 qualifying turns → only the last 3 (latest last)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "turn-1" }]),
      assistant("user", [{ type: "text", text: "turn-2" }]),
      assistant("user", [{ type: "text", text: "turn-3" }]),
      assistant("user", [{ type: "text", text: "turn-4" }]),
      assistant("user", [{ type: "text", text: "turn-5" }]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), [
      "turn-3",
      "turn-4",
      "turn-5",
    ]);
  });

  // option limit: 1 ----------------------------------------------------
  it("option limit: 1 → only the most recent qualifying turn", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "older" }]),
      assistant("user", [{ type: "text", text: "newer" }]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages, { limit: 1 }), ["newer"]);
  });

  // whitespace-only / empty user text ----------------------------------
  it("whitespace-only user text → excluded", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "   \n\t  " }]),
      assistant("user", [{ type: "text", text: "real task" }]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), ["real task"]);
  });

  // subagent drain text ------------------------------------------------
  it("subagent drain text → excluded", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [
        {
          type: "text",
          text: `${SUBAGENT_DRAIN_PREFIX}task_1 result: sum\n\nbody`,
        },
      ]),
      assistant("user", [{ type: "text", text: "real follow-up" }]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), ["real follow-up"]);
  });

  // concurrent: self-reference isolation (TASK_EXCERPT_PREFIX) ---------
  it("previous round's excerpt text (TASK_EXCERPT_PREFIX 前缀) → excluded (self-reference)", () => {
    const excerpt = `${TASK_EXCERPT_PREFIX} — 2\n1. foo\n2. bar`;
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "real user task A" }]),
      assistant("user", [{ type: "text", text: excerpt }]),
      assistant("user", [{ type: "text", text: "real user task B" }]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), [
      "real user task A",
      "real user task B",
    ]);
  });

  it("leading whitespace before excerpt prefix still excluded", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "   recent user task X" }]),
      assistant("user", [
        { type: "text", text: `\n${TASK_EXCERPT_PREFIX} — 1\n1. old` },
      ]),
    ];
    assert.deepEqual(extractRecentUserTasks(messages), ["recent user task X"]);
  });
});

describe("isTaskExcerptText — TASK_EXCERPT_PREFIX 哨兵识别", () => {
  it("text starting with prefix → true", () => {
    assert.equal(isTaskExcerptText(`${TASK_EXCERPT_PREFIX} — 3`), true);
    assert.equal(
      isTaskExcerptText(`${TASK_EXCERPT_PREFIX} — 1\n1. some task`),
      true
    );
  });

  it("leading whitespace before prefix → still true (trimStart)", () => {
    assert.equal(isTaskExcerptText(`  ${TASK_EXCERPT_PREFIX} hi`), true);
    assert.equal(isTaskExcerptText(`\n${TASK_EXCERPT_PREFIX} hi`), true);
  });

  it("text without prefix → false", () => {
    assert.equal(isTaskExcerptText("hello world"), false);
    assert.equal(isTaskExcerptText(""), false);
    assert.equal(
      isTaskExcerptText(`prefix-not-the-same: ${TASK_EXCERPT_PREFIX}`),
      false
    );
  });
});

describe("shouldSeedTaskFocus — greeting filter (#605 T2 relocation)", () => {
  // #605 T2: predicate moved from `store/schema.ts` to
  // `turn-projection.ts` since the only remaining consumer is
  // `extractRecentUserTasks`. Algorithm is unchanged; these tests pin
  // the contract at its new home.

  it("rejects greetings that must not become a task excerpt entry", () => {
    assert.equal(shouldSeedTaskFocus("你好"), false);
    assert.equal(shouldSeedTaskFocus("hello"), false);
    assert.equal(shouldSeedTaskFocus("  Hi!  "), false);
    assert.equal(shouldSeedTaskFocus(""), false);
    assert.equal(shouldSeedTaskFocus("   "), false);
    assert.equal(shouldSeedTaskFocus("hey."), false);
    assert.equal(shouldSeedTaskFocus("thanks."), false);
  });

  it("accepts a real task sentence", () => {
    assert.equal(shouldSeedTaskFocus("Build a C compiler"), true);
    assert.equal(shouldSeedTaskFocus("你好，帮我写一个类型检查器"), true);
    assert.equal(shouldSeedTaskFocus("Refactor the loop engine"), true);
  });
});

// -- D2 (tui-display-consistency) wire surface: per-turn thinkingMs sum -----
//
// Mirrors src/tui/turn-activity.ts sumThinkingMsInRange semantics, but lands on the
// session-api / web wire — no cross-module import of the TUI fold-cluster sum. This group
// pins sumAssistantThinkingMsInRange over 8 input shapes + the two pass-through paths
// into TurnDto.answer.thinkingMs via projectMessagesToTurns (getSession and byte-stable absence).

describe("D2 wire surface — sumAssistantThinkingMsInRange", () => {
  // helper: build messages + thinkingMs parallel arrays with index-to-index correspondence
  const userMsg = assistant("user", [{ type: "text", text: "q" }]);
  const asstMsg = assistant("assistant", [{ type: "text", text: "a" }]);

  it("thinkingMs undefined → 0 (旧会话 / 整链缺席)", () => {
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [asstMsg],
        thinkingMs: undefined,
      }),
      0
    );
  });

  it("空 messages → 0", () => {
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [],
        thinkingMs: [1200, 800],
      }),
      0
    );
  });

  it("非 assistant 消息对应位置按 0 计入", () => {
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [userMsg],
        thinkingMs: [1200],
      }),
      0
    );
  });

  it("assistant 消息求和其位置 thinkingMs 值 (单 assistant)", () => {
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [asstMsg],
        thinkingMs: [1500],
      }),
      1500
    );
  });

  it("多 assistant 求和 (loop 多回合)", () => {
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [asstMsg, asstMsg, asstMsg],
        thinkingMs: [800, 1200, 600],
      }),
      2600
    );
  });

  it("null 元素按 0 计入 (非流式回合 / 该事件无 thinkingMs)", () => {
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [asstMsg, asstMsg, asstMsg],
        thinkingMs: [800, null, 1200],
      }),
      2000
    );
  });

  it("startIndex 偏移: 用 messages 切片起点对齐全局并行数组", () => {
    // messages slice = messages.slice(2, 5); thinkingMs is a file-level parallel array
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [asstMsg, asstMsg, asstMsg],
        thinkingMs: [100, 200, 800, 1200, 600, 5000],
        startIndex: 2,
      }),
      2600
    );
  });

  it("越界索引按 0 计入 (thinkingMs 数组短于 startIndex + messages.length)", () => {
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [asstMsg, asstMsg],
        thinkingMs: [1200],
        startIndex: 1,
      }),
      0
    );
  });

  it("非有限数 / <= 0 → 0 (防御, appendEvents 入口已过滤)", () => {
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [asstMsg, asstMsg, asstMsg],
        thinkingMs: [800, NaN, 0],
      }),
      800
    );
    assert.equal(
      sumAssistantThinkingMsInRange({
        messages: [asstMsg],
        thinkingMs: [Number.POSITIVE_INFINITY],
      }),
      0
    );
  });
});

describe("D2 wire surface — projectMessagesToTurns thinkingMs 透传", () => {
  // TUI folding and web wire share the same on-disk SSOT.
  // This group pins the two wirings of the TurnAnswerDto.thinkingMs (ms) field:
  //   1. file.thinkingMs summed then attached to answer (attached only when sum > 0, byte-stable)
  //   2. thinkingMs absent (old sessions) -> key not attached

  it("file.thinkingMs 求和到 answer.thinkingMs (多 assistant 求和)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "q1" }]),
      assistant("assistant", [{ type: "text", text: "a1" }]),
      assistant("user", [{ type: "text", text: "q2" }]),
      assistant("assistant", [{ type: "text", text: "a2" }]),
      assistant("assistant", [{ type: "text", text: "a3" }]),
    ];
    // one-to-one with messages: turn1 last assistant[1]=1500;
    // turn2 last two assistants[3]=800 + assistant[4]=1200 = 2000.
    const thinkingMs = [null, 1500, null, 800, 1200];
    const turns = projectMessagesToTurns(messages, thinkingMs);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.answer.thinkingMs, 1500);
    assert.equal(turns[1]?.answer.thinkingMs, 2000);
  });

  it("old session — thinkingMs undefined → answer.thinkingMs 字段缺席 (Postel)", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "q" }]),
      assistant("assistant", [{ type: "text", text: "a" }]),
    ];
    const turns = projectMessagesToTurns(messages, undefined);
    assert.equal("thinkingMs" in (turns[0]?.answer ?? {}), false);
    assert.deepEqual(Object.keys(turns[0]?.answer ?? {}).sort(), [
      "finalText",
      "stopReason",
      "turnCount",
    ]);
  });

  it("file.thinkingMs 越界 (并行数组短于 messages) → 按 0 计入,字段缺席", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "q" }]),
      assistant("assistant", [{ type: "text", text: "a" }]),
    ];
    const turns = projectMessagesToTurns(messages, []); // empty parallel array
    assert.equal("thinkingMs" in (turns[0]?.answer ?? {}), false);
  });

  it("thinkingMs=0 (该 turn slice 无 assistant) → 字段缺席, byte-stable", () => {
    // single user message with no following assistant -> no assistant in the turn slice -> sum=0
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "q" }]),
    ];
    const turns = projectMessagesToTurns(messages, [1200]);
    // a lone user message is still a turn (no assistant closing it, but it is a turn query)
    assert.equal(turns.length, 1);
    assert.equal("thinkingMs" in (turns[0]?.answer ?? {}), false);
  });
});

// -- ADR-0126 evidence path: key-set pins for the outcome fields --------------

describe("outcome evidence — answer key sets (byte-stable)", () => {
  const oneTurn = [
    assistant("user", [{ type: "text", text: "q" }]),
    assistant("assistant", [{ type: "text", text: "a" }]),
  ];
  const evidence = (
    outcomes: ReadonlyMap<string, SessionOutcomeRecord>
  ): TurnOutcomeEvidence => ({
    messageEventIds: ["e0", "e1"],
    outcomes,
  });

  it("known truncation outcome → stopReason + outcome + notice keys", () => {
    const turns = projectMessagesToTurns(
      oneTurn,
      undefined,
      null,
      evidence(
        new Map([
          [
            "e1",
            {
              type: "outcome",
              turnId: "e1",
              stopReason: "nonSuccessStop",
              supplierDetail: "truncation",
            },
          ],
        ])
      )
    );
    assert.deepEqual(Object.keys(turns[0]!.answer).sort(), [
      "finalText",
      "outcome",
      "outputLimitNotice",
      "stopReason",
      "turnCount",
    ]);
    assert.equal(turns[0]!.answer.outputLimitNotice, OUTPUT_LIMIT_NOTICE);
  });

  it("known non-truncation outcome → outcome + stopReason, no notice key", () => {
    const turns = projectMessagesToTurns(
      oneTurn,
      undefined,
      null,
      evidence(
        new Map([
          ["e1", { type: "outcome", turnId: "e1", stopReason: "completed" }],
        ])
      )
    );
    assert.deepEqual(Object.keys(turns[0]!.answer).sort(), [
      "finalText",
      "outcome",
      "stopReason",
      "turnCount",
    ]);
  });

  it("no outcome record → only the unknown view; stopReason and notice keys absent", () => {
    const turns = projectMessagesToTurns(
      oneTurn,
      undefined,
      null,
      evidence(new Map())
    );
    assert.deepEqual(Object.keys(turns[0]!.answer).sort(), [
      "finalText",
      "outcome",
      "turnCount",
    ]);
    assert.deepEqual(turns[0]!.answer.outcome, { terminal: "unknown" });
  });
});

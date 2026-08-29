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
import { projectMessagesToTurns } from "../../src/session-api/hub.ts";
import { SUBAGENT_DRAIN_PREFIX } from "../../src/harness/subagent/host-drain.ts";
import {
  MAX_THINKING_TEXT_CHARS,
  MAX_TOOL_INPUT_PREVIEW_CHARS,
  MAX_TOOL_OUTPUT_PREVIEW_CHARS,
  extractRecentUserTasks,
  isTaskExcerptText,
  isTurnQuery,
  messageText,
  projectActivity,
  projectThinkingView,
  projectToolCalls,
  shouldSeedTaskFocus,
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
  it("projectActivity([]) → []", () => {
    assert.deepEqual(projectActivity([], identity), []);
  });

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

describe("boundary: ordered activity", () => {
  it("preserves text → tool → text order and pairs the tool result", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [{ type: "text", text: "do this" }]),
      assistant("assistant", [
        { type: "text", text: "before" },
        { type: "tool_use", id: "t1", name: "bash", input: { cmd: "pwd" } },
        { type: "text", text: "after" },
      ]),
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "ok" }],
        },
      ]),
    ];
    assert.deepEqual(projectActivity(messages, identity), [
      { type: "text", text: "before" },
      {
        type: "tool",
        tool: {
          id: "t1",
          name: "bash",
          inputPreview: '{"cmd":"pwd"}',
          outputPreview: "ok",
          isError: false,
          truncated: false,
        },
      },
      { type: "text", text: "after" },
    ]);
    const turns = projectMessagesToTurns(messages);
    assert.deepEqual(turns[0]?.answer.activity, [
      { type: "text", text: "before" },
      {
        type: "tool",
        tool: {
          id: "t1",
          name: "bash",
          inputPreview: '{"cmd":"pwd"}',
          outputPreview: "ok",
          isError: false,
          truncated: false,
        },
      },
      { type: "text", text: "after" },
    ]);
    assert.equal(turns[0]?.answer.toolCalls?.length, 1);
    assert.equal(turns[0]?.answer.finalText, "before after");
  });

  it("skips malformed and unknown blocks without affecting valid activity", () => {
    const messages = [
      assistant("assistant", [
        { type: "text", text: "valid" },
        { type: "tool_use", id: "missing-name" } as never,
        { type: "unknown", text: "ignore me" } as never,
      ]),
    ];
    assert.deepEqual(projectActivity(messages, identity), [
      { type: "text", text: "valid" },
    ]);
  });

  it("ignores unpaired results and uses the first duplicate result", () => {
    const messages: AnthropicNativeMessage[] = [
      assistant("user", [
        {
          type: "tool_result",
          tool_use_id: "unknown",
          content: [{ type: "text", text: "ignore" }],
        },
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "first" }],
        },
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "second" }],
        },
      ]),
      assistant("assistant", [
        { type: "tool_use", id: "t1", name: "echo", input: {} },
        { type: "tool_use", id: "pending", name: "wait", input: {} },
      ]),
    ];
    const activity = projectActivity(messages, identity);
    assert.equal(activity.length, 2);
    assert.equal(activity[0]?.type, "tool");
    assert.equal(
      activity[0]?.type === "tool" && activity[0].tool.outputPreview,
      "first"
    );
    assert.equal(
      activity[1]?.type === "tool" && activity[1].tool.outputPreview,
      ""
    );
  });

  it("returns [] instead of throwing for malformed session data", () => {
    assert.doesNotThrow(() =>
      projectActivity([null as unknown as AnthropicNativeMessage], identity)
    );
    assert.doesNotThrow(() =>
      projectActivity(null as unknown as AnthropicNativeMessage[], identity)
    );
    assert.deepEqual(
      projectActivity([null as unknown as AnthropicNativeMessage], identity),
      []
    );
  });

  it("marks an unserializable tool input instead of hiding it as an empty preview", () => {
    const circularInput: Record<string, unknown> = {};
    circularInput.self = circularInput;
    const messages: AnthropicNativeMessage[] = [
      assistant("assistant", [
        {
          type: "tool_use",
          id: "circular",
          name: "inspect",
          input: circularInput,
        },
      ]),
    ];

    assert.deepEqual(projectActivity(messages, identity), [
      {
        type: "tool",
        tool: {
          id: "circular",
          name: "inspect",
          inputPreview: "// EXIT: tool input preview unavailable",
          outputPreview: "",
          isError: false,
          truncated: false,
        },
      },
    ]);
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
// host-drain 把 completed 子代理结果浓缩成 `## Sub-agent <id> result: ...`
// user message 拼入历史；显示投影既不得把它当 query 露出，也不得让它切断
// 前一个 turn 的 slice。

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
    // slice 未被 drain 切断：tool_result 仍落在 turn 1 内，配对成功。
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
});

// -- #604 T1: extractRecentUserTasks — 任务摘录纯函数 -------------------------
//
// 契约(plan T1 acceptance):
//   - 倒序遍历 messages,至多取 3 条合格 user-turn 原文(trim 后);
//   - 合格 = isTurnQuery + shouldSeedTaskFocus(寒暄过滤)+ 非 self-reference
//     (前缀 TASK_EXCERPT_PREFIX 的摘录文本本身不被下一轮抽到);
//   - 0 句 → []; assistant / tool_result / 寒暄 / drain / whitespace 一律不取;
//   - 顺序:返回 chronological(最早→最新),latest 在最后。

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

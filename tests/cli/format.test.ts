/**
 * CLI `src/cli/format.ts` projection tests.
 *
 * `formatRunHuman` / `formatRunJson` / `renderAssistantAnswer` consume harness
 * `RunResult` + `LoopTrace`. Imports go through `../../src/cli/format.ts`
 * directly (test files use the `.ts` extension per repo convention).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  formatRunHuman,
  formatRunJson,
  formatChatVerifyReport,
  formatVerifyReport,
  renderAssistantAnswer,
  renderThinkingSummary,
  THINKING_PREFIX,
  REDACTED_PLACEHOLDER,
} from "../../src/cli/format.ts";
import { deriveFinalText } from "../../src/harness/loop-engine.ts";
import { projectVerifyHumanView } from "../../src/session-api/verify-human-view.ts";
import {
  computeTotals,
  type AnthropicNativeMessage,
  type LoopTrace,
  type RunResult,
  type TurnTrace,
} from "../../src/harness/index.ts";

function mkResult(over: Partial<RunResult> = {}): RunResult {
  return {
    finalText: "hello",
    messages: [],
    turnCount: 1,
    stopReason: "completed",
    // RunResult.lastUsage is a required field; mkResult defaults to null (no usage
    // view).
    lastUsage: null,
    ...over,
  };
}

function mkTurn(opts: {
  toolNames: string[];
  over?: Partial<TurnTrace>;
}): TurnTrace {
  const { toolNames, over = {} } = opts;
  return {
    turnIndex: 0,
    supplierStop: "success",
    toolCalls: toolNames.map((n, i) => ({
      toolUseId: `t${i}`,
      toolName: n,
      kind: "ok" as const,
    })),
    durationMs: 5,
    cancelKind: "none",
    ...over,
  };
}

function mkTrace(turns: TurnTrace[] = []): LoopTrace {
  return { turns, totals: computeTotals(turns) };
}

describe("formatRunHuman", () => {
  it("renders finalText + status line for completed + 1 tool + 1 turn", () => {
    const out = formatRunHuman({
      result: mkResult({ finalText: "hello" }),
      trace: mkTrace([
        mkTurn({ toolNames: ["echo"], over: { durationMs: 5 } }),
      ]),
    });
    assert.ok(out.includes("hello"), "should contain finalText");
    assert.ok(out.includes("stop=completed"));
    assert.ok(out.includes("turns=1"));
    assert.ok(out.includes("tools=echo"));
    // Status line ends with `<digits>ms` (e.g. `5ms`).
    assert.match(out, /· \d+ms$/);
  });

  it("renders status line even when finalText is null (maxTurns)", () => {
    const out = formatRunHuman({
      result: mkResult({
        finalText: null,
        stopReason: "maxTurns",
        turnCount: 6,
      }),
      trace: mkTrace([]),
    });
    assert.ok(out.includes("stop=maxTurns"));
    assert.ok(
      !out.includes("hello"),
      "must not contain stale 'hello' finalText"
    );
    // status line still present, so tools=- is the fallback.
    assert.ok(out.includes("tools=-"));
  });

  it("zero turns → tools shows '-' placeholder", () => {
    const out = formatRunHuman({
      result: mkResult(),
      trace: mkTrace([]),
    });
    assert.ok(out.includes("tools=-"));
  });

  it("multi-turn multi-tool: dedup preserves first-occurrence order", () => {
    const out = formatRunHuman({
      result: mkResult(),
      trace: mkTrace([
        mkTurn({ toolNames: ["echo", "get_time"] }),
        mkTurn({ toolNames: ["echo"] }),
      ]),
    });
    assert.ok(
      out.includes("tools=echo,get_time"),
      "echo first (first turn), get_time deduped; got: " + out
    );
  });

  it("renders partial finalText for non-completed stopReason (timeout)", () => {
    const out = formatRunHuman({
      result: mkResult({ finalText: "partial", stopReason: "timeout" }),
      trace: mkTrace([mkTurn({ toolNames: [] })]),
    });
    assert.ok(out.includes("partial"));
    assert.ok(out.includes("stop=timeout"));
  });

  it("renders stop=fused for fused StopReason", () => {
    const out = formatRunHuman({
      result: mkResult({ finalText: null, stopReason: "fused" }),
      trace: mkTrace([]),
    });
    assert.ok(out.includes("stop=fused"));
  });

  // -- Ctrl+C interrupt feedback (interruptNote prefix) -----------------------

  it("cancelled + interruptNote=已保存 → 输出含 ⏹ 已打断 与 已保存", () => {
    const out = formatRunHuman({
      result: mkResult({
        finalText: "",
        stopReason: "cancelled",
        turnCount: 0,
      }),
      trace: mkTrace([]),
      interruptNote: "已保存",
    });
    assert.ok(out.includes("⏹ 已打断"), "note 前缀必须出现;got: " + out);
    assert.ok(out.includes("已保存"), "note 文案必须透传;got: " + out);
    assert.ok(out.includes("stop=cancelled"), "状态行仍在;got: " + out);
    // The prefix stands on its own line, with the status line right after it.
    assert.match(out, /⏹ 已打断，已保存\nstop=cancelled/);
  });

  it("cancelled + interruptNote=未落checkpoint → 输出含 ⏹ 已打断 与 未落", () => {
    const out = formatRunHuman({
      result: mkResult({
        finalText: "",
        stopReason: "cancelled",
        turnCount: 0,
      }),
      trace: mkTrace([]),
      interruptNote: "未落checkpoint",
    });
    assert.ok(out.includes("⏹ 已打断"));
    assert.ok(out.includes("未落checkpoint"));
    assert.match(out, /⏹ 已打断，未落checkpoint\nstop=cancelled/);
  });

  it("completed + 无 interruptNote → 输出不含 ⏹ 已打断(byte-stable)", () => {
    const out = formatRunHuman({
      result: mkResult({ finalText: "hello", stopReason: "completed" }),
      trace: mkTrace([]),
    });
    assert.ok(!out.includes("⏹ 已打断"), "非打断不得出现 note;got: " + out);
  });

  it("cancelled + interruptNote 缺席(旧链路)→ 无前缀,与打断前输出一致", () => {
    const out = formatRunHuman({
      result: mkResult({
        finalText: "",
        stopReason: "cancelled",
        turnCount: 0,
      }),
      trace: mkTrace([]),
    });
    assert.ok(!out.includes("⏹ 已打断"));
    assert.equal(out, "\n\nstop=cancelled · turns=0 · tools=- · 0ms");
  });
});

describe("formatRunJson", () => {
  it("emits the 4 top-level fields and omits messages", () => {
    const parsed = JSON.parse(
      formatRunJson({
        result: mkResult(),
        trace: mkTrace([mkTurn({ toolNames: ["echo"] })]),
      })
    );
    assert.strictEqual(parsed.finalText, "hello");
    assert.strictEqual(parsed.stopReason, "completed");
    assert.strictEqual(parsed.turnCount, 1);
    assert.ok(parsed.trace && typeof parsed.trace === "object");
    assert.ok(Array.isArray(parsed.trace.turns));
    assert.ok(parsed.trace.totals && typeof parsed.trace.totals === "object");
    assert.ok(
      !("messages" in parsed),
      "messages must NOT appear in JSON output"
    );
  });

  it("empty trace round-trips with turns.length === 0", () => {
    const parsed = JSON.parse(
      formatRunJson({
        result: mkResult({ finalText: null, stopReason: "maxTurns" }),
        trace: mkTrace([]),
      })
    );
    assert.strictEqual(parsed.trace.turns.length, 0);
    assert.strictEqual(parsed.finalText, null);
  });
});

/**
 * renderAssistantAnswer —— pure render function, the landing point of the
 * thinking visibility switch.
 *
 * Slice: the function reads the last assistant turn; the switch decides whether
 * thinking text is exposed; projection.texts / finalText / trace fields are
 * untouched; tool_use / tool_result blocks never enter the display channel.
 */
describe("renderAssistantAnswer (#152 T5 thinking visibility)", () => {
  function mkMessage(
    role: "user" | "assistant",
    blocks: AnthropicNativeMessage["content"]
  ): AnthropicNativeMessage {
    return { role, content: blocks };
  }

  it("showThinking=false (默认):只用 text blocks", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [
        { type: "thinking", thinking: "hush", signature: "sig_a" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "t1", name: "echo", input: { x: 1 } },
      ]),
    ];
    const out = renderAssistantAnswer({ messages: msgs, showThinking: false });
    assert.equal(out, "answer");
    assert.ok(!out.includes("hush"), "no thinking leak");
  });

  it("showThinking=true: thinking 文本前缀显示在 text 之前", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [
        {
          type: "thinking",
          thinking: "step-by-step reasoning",
          signature: "sig_b",
        },
        { type: "text", text: "answer" },
      ]),
    ];
    const out = renderAssistantAnswer({ messages: msgs, showThinking: true });
    // Pins the exact shape: THINKING_PREFIX + thinking text + "\n\n" + text, so the
    // prefix or separator cannot be changed silently.
    assert.equal(out, `${THINKING_PREFIX}step-by-step reasoning\n\nanswer`);
  });

  it("showThinking=true 但无 thinking 块:仅显示 text(无前缀噪声)", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [{ type: "text", text: "plain answer" }]),
    ];
    const out = renderAssistantAnswer({ messages: msgs, showThinking: true });
    assert.equal(out, "plain answer");
  });

  it("redacted_thinking 块:开关开启也只显示占位,不泄露 data", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [
        { type: "redacted_thinking", data: "ENCRYPTED_BLOB_DO_NOT_LEAK" },
        { type: "text", text: "answer" },
      ]),
    ];
    const outOn = renderAssistantAnswer({
      messages: msgs,
      showThinking: true,
    });
    assert.ok(
      !outOn.includes("ENCRYPTED_BLOB_DO_NOT_LEAK"),
      "redacted data must not leak to display"
    );
    // Pins the exact redacted_thinking placeholder shape: THINKING_PREFIX +
    // REDACTED_PLACEHOLDER + "\n\n" + text, so REDACTED_PLACEHOLDER cannot be
    // changed silently.
    assert.equal(outOn, `${THINKING_PREFIX}${REDACTED_PLACEHOLDER}\n\nanswer`);
    // Switch off: the redacted content is absent just the same.
    const outOff = renderAssistantAnswer({
      messages: msgs,
      showThinking: false,
    });
    assert.equal(outOff, "answer");
  });

  it("开关关闭时:多 text block 拼接与 finalText 派生一致", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [
        { type: "thinking", thinking: "never", signature: "sig_x" },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ];
    const out = renderAssistantAnswer({ messages: msgs, showThinking: false });
    assert.equal(out, "first\nsecond");
  });

  it("无 assistant 回合时:返回空字符串(不抛错)", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
    ];
    assert.equal(
      renderAssistantAnswer({ messages: msgs, showThinking: false }),
      ""
    );
    assert.equal(
      renderAssistantAnswer({ messages: msgs, showThinking: true }),
      ""
    );
  });

  it("多 assistant 回合:仅看最后一个", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q1" }]),
      mkMessage("assistant", [
        { type: "thinking", thinking: "EARLIER", signature: "sig_e" },
        { type: "text", text: "earlier answer" },
      ]),
      mkMessage("user", [{ type: "text", text: "q2" }]),
      mkMessage("assistant", [
        { type: "thinking", thinking: "FINAL", signature: "sig_f" },
        { type: "text", text: "final answer" },
      ]),
    ];
    assert.equal(
      renderAssistantAnswer({ messages: msgs, showThinking: false }),
      "final answer"
    );
    const outOn = renderAssistantAnswer({
      messages: msgs,
      showThinking: true,
    });
    // Pins the exact shape of the last assistant turn's thinking + text (including
    // THINKING_PREFIX).
    assert.equal(outOn, `${THINKING_PREFIX}FINAL\n\nfinal answer`);
    assert.ok(!outOn.includes("earlier answer"));
  });
});

describe("formatRunHuman — showThinking 开关 (#152 T5)", () => {
  it("默认 (showThinking 缺省):走 finalText,与原行为一致", () => {
    const out = formatRunHuman({
      result: mkResult({ finalText: "hello" }),
      trace: mkTrace([]),
    });
    // Pins finalText + the deterministic status line (mkTrace([]) -> 0ms, tools=-).
    assert.equal(out, "hello\n\nstop=completed · turns=1 · tools=- · 0ms");
  });

  it("showThinking=false 显式:走 finalText (与缺省同源)", () => {
    const out = formatRunHuman({
      result: mkResult({ finalText: "hello" }),
      trace: mkTrace([]),
      showThinking: false,
    });
    assert.equal(out, "hello\n\nstop=completed · turns=1 · tools=- · 0ms");
  });

  it("showThinking=true 走 renderAssistantAnswer 输出取代 finalText", () => {
    // messages carries a thinking block while finalText holds only the
    // concatenated text (the true switch shows the thinking separator prefix).
    const result = {
      finalText: "final answer text",
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "q" }],
        },
        {
          role: "assistant" as const,
          content: [
            {
              type: "thinking" as const,
              thinking: "Thinking visible now",
              signature: "sig",
            },
            { type: "text" as const, text: "final answer text" },
          ],
        },
      ],
      turnCount: 1,
      stopReason: "completed" as const,
      // lastUsage is a required RunResult field; this case does not test the token view, so default null.
      lastUsage: null,
    };
    const out = formatRunHuman({
      result,
      trace: mkTrace([]),
      showThinking: true,
    });
    // Pins: showThinking=true routes through renderAssistantAnswer (THINKING_PREFIX
    // + thinking + "\n\n" + text), followed by the deterministic status line.
    assert.equal(
      out,
      `思考（1 段）\n\nfinal answer text\n\nstop=completed · turns=1 · tools=- · 0ms`
    );
  });

  it("开关不影响 trace / finalText 等其他字段(只影响渲染面)", () => {
    // Implementation-level check: result.finalText and trace stay untouched (read-only — compare before/after).
    const result = mkResult({ finalText: "hello" });
    const trace = mkTrace([mkTurn({ toolNames: ["echo"] })]);
    const before = {
      finalText: result.finalText,
      traceLength: trace.turns.length,
    };
    formatRunHuman({ result, trace, showThinking: true });
    assert.equal(result.finalText, before.finalText);
    assert.equal(trace.turns.length, before.traceLength);
  });

  it("开关不影响 JSON 投影(formatRunJson 不接 showThinking 参数)", () => {
    // Defense: the JSON path still carries only finalText + trace, no thinking;
    // the display channel stays orthogonal to the machine-consumption channel.
    const parsed = JSON.parse(
      formatRunJson({
        result: mkResult({ finalText: "hello" }),
        trace: mkTrace([mkTurn({ toolNames: ["echo"] })]),
      })
    );
    assert.equal(parsed.finalText, "hello");
    assert.ok(
      !("messages" in parsed),
      "JSON projection must never carry messages regardless of any flag"
    );
  });
});

/**
 * Invariant regression tests for `renderAssistantAnswer({showThinking:false})`
 * (the display path) vs `deriveFinalText` (the authoritative `result.finalText`
 * derivation).
 *
 * They must agree away from the divergence boundary (last assistant message has
 * non-empty text); at the boundary (last assistant text empty, e.g. a pure
 * tool_use turn) they differ: renderAssistantAnswer stops at the last assistant
 * ("") while deriveFinalText scans past empty text to the previous assistant.
 *
 * Pin both current behaviors as a tripwire: any silent change to one side trips
 * here, forcing future contributors to decide consciously whether to sync the
 * other. The production path formatRunHuman(false) uses result.finalText
 * (deriveFinalText), so the divergence is only exposed by direct
 * renderAssistantAnswer(false) test calls.
 */
describe("renderAssistantAnswer(false) vs deriveFinalText 不变量 (#156 M2)", () => {
  function mkMessage(
    role: "user" | "assistant",
    blocks: AnthropicNativeMessage["content"]
  ): AnthropicNativeMessage {
    return { role, content: blocks };
  }

  it("最后一条 assistant 含非空 text:两者一致", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [{ type: "text", text: "real answer" }]),
    ];
    assert.equal(
      renderAssistantAnswer({ messages: msgs, showThinking: false }),
      "real answer"
    );
    assert.equal(deriveFinalText(msgs), "real answer");
  });

  it("多 text block 拼接:两者一致(单 \\n 拼接)", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ];
    assert.equal(
      renderAssistantAnswer({ messages: msgs, showThinking: false }),
      "first\nsecond"
    );
    assert.equal(deriveFinalText(msgs), "first\nsecond");
  });

  it("分歧边界:最后一条 assistant 空 text(纯 tool_use) -> 两者不同(tripwire)", () => {
    // renderAssistantAnswer stops at the last assistant (empty text -> "");
    // deriveFinalText scans past it back to the previous assistant -> "real answer".
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [{ type: "text", text: "real answer" }]),
      mkMessage("user", [{ type: "text", text: "tool result" }]),
      mkMessage("assistant", [
        { type: "tool_use", id: "t1", name: "echo", input: { x: 1 } },
      ]),
    ];
    assert.equal(
      renderAssistantAnswer({ messages: msgs, showThinking: false }),
      "",
      "renderAssistantAnswer 停在最后一条 assistant(空 text)"
    );
    assert.equal(
      deriveFinalText(msgs),
      "real answer",
      "deriveFinalText 越过空 text 回扫到前一条 assistant"
    );
  });

  it("无 assistant 回合:两者一致(null / 空字符串)", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
    ];
    assert.equal(
      renderAssistantAnswer({ messages: msgs, showThinking: false }),
      ""
    );
    assert.equal(deriveFinalText(msgs), null);
  });
});

/**
 * Display surface wired to `lastUsage` (ADR-0008 display path).
 *
 * Shape anchors (ADR-0008 Decision 2):
 * - Domain type `TokenUsage`: four camelCase fields — required `inputTokens` /
 *   `outputTokens` plus `cacheCreationInputTokens` / `cacheReadInputTokens: number | null`.
 * - `RunResult.lastUsage: TokenUsage | null` — required field; null = the run
 *   had no successful model call. Projection locked:
 *   - JSON: usage present → add the `lastUsage` key (camelCase four fields);
 *     null → key absent (same style as omitting messages, see format.ts design note).
 *   - Human: usage present → status line appends `tokens in/out: <in>/<out>`;
 *     null → nothing shown (cache hits stay out of the human view for now, minimal clarity).
 */
describe("formatRunJson — lastUsage (#160 T5)", () => {
  it("lastUsage 非 null:JSON 增 camelCase 四字段", () => {
    const parsed = JSON.parse(
      formatRunJson({
        result: mkResult({
          lastUsage: {
            inputTokens: 1234,
            outputTokens: 56,
            cacheCreationInputTokens: 7,
            cacheReadInputTokens: 89,
          },
        }),
        trace: mkTrace([]),
      })
    );
    // Pins the four camelCase fields; guards the JSON projection against reverting to snake_case.
    assert.deepEqual(parsed.lastUsage, {
      inputTokens: 1234,
      outputTokens: 56,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 89,
    });
  });

  it("lastUsage: null:JSON 无 lastUsage 键(与 messages 省略同风格)", () => {
    const parsed = JSON.parse(
      formatRunJson({
        result: mkResult({ lastUsage: null }),
        trace: mkTrace([]),
      })
    );
    assert.ok(
      !("lastUsage" in parsed),
      "lastUsage 键必须缺席(与 messages 省略同风格)"
    );
  });
});

describe("formatRunHuman — lastUsage token 读数 (#160 T5)", () => {
  it("有 lastUsage:状态行追加 `tokens in/out: <in>/<out>`,精确钉死完整形状", () => {
    const out = formatRunHuman({
      result: mkResult({
        finalText: "hello",
        lastUsage: {
          inputTokens: 1234,
          outputTokens: 56,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
      }),
      trace: mkTrace([]),
    });
    // Pins the full status line: ` · tokens in/out: <in>/<out>` appended after the existing `<ms>ms`.
    assert.equal(
      out,
      "hello\n\nstop=completed · turns=1 · tools=- · 0ms · tokens in/out: 1234/56"
    );
  });

  it("lastUsage: null:状态行不含 token 读数", () => {
    const out = formatRunHuman({
      result: mkResult({ finalText: "hello", lastUsage: null }),
      trace: mkTrace([]),
    });
    assert.ok(
      !out.includes("tokens"),
      "lastUsage = null 时人类展示不应带 token 读数:got " + out
    );
    // Pins the token-free status line (backward compatible with existing consumers).
    assert.equal(out, "hello\n\nstop=completed · turns=1 · tools=- · 0ms");
  });
});

/**
 * renderThinkingSummary — collapsed thinking summary line for the final answer
 * (the chat-side folded view of showThinking).
 *
 * Semantics: with showThinking=true the chat no longer expands full thinking;
 * it shows a summary line instead (a TTY has no fold interaction, so the summary
 * line IS the folded state), matching the TUI default. redacted_thinking counts
 * toward the encrypted count; no thinking blocks returns an empty string.
 */
describe("renderThinkingSummary (#T6 thinking 折叠摘要)", () => {
  function mkMessage(
    role: "user" | "assistant",
    blocks: AnthropicNativeMessage["content"]
  ): AnthropicNativeMessage {
    return { role, content: blocks };
  }

  it("有 thinking 块:返回 `思考（N 段）` 摘要", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [
        { type: "thinking", thinking: "a", signature: "s1" },
        { type: "thinking", thinking: "b", signature: "s2" },
        { type: "text", text: "answer" },
      ]),
    ];
    assert.equal(renderThinkingSummary(msgs), "思考（2 段）");
  });

  it("无 thinking 但含 redacted:返回 `思考（0 段 · 已加密 ×1）`", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [
        { type: "redacted_thinking", data: "BLOB" },
        { type: "text", text: "answer" },
      ]),
    ];
    assert.equal(renderThinkingSummary(msgs), "思考（0 段 · 已加密 ×1）");
  });

  it("thinking + redacted 混合:计数与加密计数都反映", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [
        { type: "thinking", thinking: "a", signature: "s1" },
        { type: "redacted_thinking", data: "BLOB" },
        { type: "text", text: "answer" },
      ]),
    ];
    assert.equal(renderThinkingSummary(msgs), "思考（1 段 · 已加密 ×1）");
  });

  it("多段 thinking + 多条 redacted:计数累积", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [
        { type: "thinking", thinking: "a", signature: "s1" },
        { type: "thinking", thinking: "b", signature: "s2" },
        { type: "redacted_thinking", data: "B1" },
        { type: "redacted_thinking", data: "B2" },
        { type: "text", text: "answer" },
      ]),
    ];
    assert.equal(renderThinkingSummary(msgs), "思考（2 段 · 已加密 ×2）");
  });

  it("最后一条助手无 thinking:返回空串", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
      mkMessage("assistant", [{ type: "text", text: "answer" }]),
    ];
    assert.equal(renderThinkingSummary(msgs), "");
  });

  it("无 assistant 回合:返回空串", () => {
    const msgs: AnthropicNativeMessage[] = [
      mkMessage("user", [{ type: "text", text: "q" }]),
    ];
    assert.equal(renderThinkingSummary(msgs), "");
  });
});

/**
 * formatVerifyReport — the passed success branch.
 *
 * The parameter union used to be failed/unstable/escalated only (failure-side
 * reports); once passed joined the wire, the chat-session.ts call site's type
 * widened naturally and needs a success label. abort/disabled never reach the
 * wire, so they get no branch.
 */
describe("formatVerifyReport — passed 成功态 (T2)", () => {
  it("passed → `[验证] 验证通过（N 轮）`", () => {
    assert.equal(formatVerifyReport("passed", 3), "[验证] 验证通过（3 轮）");
  });

  it("failed 文案不变 (backward-compat 回归锚)", () => {
    assert.match(formatVerifyReport("failed", 1), /^\[验证\] 验证未通过/);
  });
});

/**
 * The chat assembly must not print a green check for HITL small-talk passed.
 * formatVerifyReport("passed") still produces the label (for non-chat callers),
 * but formatChatVerifyReport stays silent on passed — pinning the existing
 * chat-session gate.
 */
describe("formatChatVerifyReport — chat 不印 passed 绿勾 (SC2)", () => {
  it("passed → undefined（不印 `[验证] 验证通过`）", () => {
    assert.equal(formatChatVerifyReport("passed", 1), undefined);
  });

  it("failed / unstable / escalated 仍印报告", () => {
    assert.match(
      formatChatVerifyReport("failed", 2) ?? "",
      /^\[验证\] 验证未通过/
    );
    assert.match(
      formatChatVerifyReport("unstable", 1) ?? "",
      /^\[验证\] 验证不稳定/
    );
    assert.match(
      formatChatVerifyReport("escalated", 4) ?? "",
      /^\[验证\] 验证耗尽/
    );
  });
});

/**
 * hub/TUI projection: HITL + INSUFFICIENT + hitl_skip_completion_judge must
 * never put passed (a human-readable green check) on the wire. The SUFFICIENT
 * short-circuit may still pass.
 */
describe("projectVerifyHumanView — HITL 闲聊不打绿勾 (SC2/SC5)", () => {
  it("HITL skip + INSUFFICIENT + passed → 字段缺席（无绿勾）", () => {
    assert.equal(
      projectVerifyHumanView({
        outcome: "passed",
        rounds: 1,
        records: [
          {
            reason: "hitl_skip_completion_judge",
            evidenceVerdict: "EVIDENCE_INSUFFICIENT",
          },
        ],
      }),
      undefined
    );
  });

  it("SC5 无声称点：同一 INSUFFICIENT + skip 形状 → 无绿勾", () => {
    assert.equal(
      projectVerifyHumanView({
        outcome: "passed",
        rounds: 1,
        records: [
          {
            reason: "hitl_skip_completion_judge",
            evidenceVerdict: "EVIDENCE_INSUFFICIENT",
          },
        ],
      }),
      undefined
    );
  });

  it("HITL skip + CONTRADICTED + passed → 字段缺席（无绿勾）", () => {
    assert.equal(
      projectVerifyHumanView({
        outcome: "passed",
        rounds: 1,
        records: [
          {
            reason: "hitl_skip_completion_judge",
            evidenceVerdict: "EVIDENCE_CONTRADICTED",
          },
        ],
      }),
      undefined
    );
  });

  it("HITL SUFFICIENT 短路（无 skip+INSUFFICIENT）→ 仍 passed", () => {
    assert.deepEqual(
      projectVerifyHumanView({
        outcome: "passed",
        rounds: 1,
        records: [{ reason: undefined, evidenceVerdict: undefined }],
      }),
      { outcome: "passed", rounds: 1 }
    );
  });

  it("failed 不受 skip 记录影响，仍上 wire", () => {
    assert.deepEqual(
      projectVerifyHumanView({
        outcome: "failed",
        rounds: 2,
        records: [
          {
            reason: "hitl_skip_completion_judge",
            evidenceVerdict: "EVIDENCE_INSUFFICIENT",
          },
        ],
      }),
      { outcome: "failed", rounds: 2 }
    );
  });
});

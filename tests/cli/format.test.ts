/**
 * CLI `src/cli/format.ts` projection tests (T2 acceptance).
 *
 * `formatRunHuman` / `formatRunJson` / `renderAssistantAnswer` consume harness
 * `RunResult` + `LoopTrace`, not the old `IknowAnswer`. Imports go through
 * `../../src/cli/format.ts` directly (test files use `.ts` extension per repo
 * convention).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  formatRunHuman,
  formatRunJson,
  renderAssistantAnswer,
  THINKING_PREFIX,
  REDACTED_PLACEHOLDER,
} from "../../src/cli/format.ts";
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
 * #152 T5:renderAssistantAnswer — 纯渲染函数,thinking 可见开关落点。
 *
 * 切片:此函数读 last assistant回合;开关决定是否暴露 thinking 文本;
 * projection.texts / finalText / trace 任何字段不动;
 * tool_use / tool_result 块不进展示通道。
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
    // 精确钉住完整形状:THINKING_PREFIX + thinking 文本 + "\n\n" + text 文本。
    // 防止 THINKING_PREFIX / 分隔符被静默修改。
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
    // 精确钉住 redacted_thinking 占位形状:THINKING_PREFIX + REDACTED_PLACEHOLDER
    // + "\n\n" + text。防止 REDACTED_PLACEHOLDER 常量被静默改动。
    assert.equal(outOn, `${THINKING_PREFIX}${REDACTED_PLACEHOLDER}\n\nanswer`);
    // 开关关闭:同样不出现 redacted 内容。
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
    // 精确钉住:last assistant 的 thinking + text 完整形状(含 THINKING_PREFIX)。
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
    // 精确钉住:走 finalText + 确定状态行(mkTrace([]) -> 0ms, tools=-)。
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
    // 构造一个 messages 含 thinking 块,但 finalText 只含 text 拼接过(true 开关下
    // 显示 thinking 区隔前缀)。
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
    };
    const out = formatRunHuman({
      result,
      trace: mkTrace([]),
      showThinking: true,
    });
    // 精确钉住:showThinking=true 走 renderAssistantAnswer(含 THINKING_PREFIX
    // + thinking + "\n\n" + text),后接确定状态行。
    assert.equal(
      out,
      `${THINKING_PREFIX}Thinking visible now\n\nfinal answer text\n\nstop=completed · turns=1 · tools=- · 0ms`
    );
  });

  it("开关不影响 trace / finalText 等其他字段(只影响渲染面)", () => {
    // 验证实现层:result.finalText 不被修改,trace 不被修改(只读 → 比较前后相等)。
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
    // 防御:JSON 路径仍只含 finalText + trace,不含 thinking(供后续票);
    // 显示通道与机器消费通道正交。
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

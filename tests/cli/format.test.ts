/**
 * CLI `src/cli/format.ts` projection tests (T2 acceptance).
 *
 * `formatRunHuman` / `formatRunJson` / `renderAssistantAnswer` consume harness
 * `RunResult` + `LoopTrace`. Imports go through `../../src/cli/format.ts`
 * directly (test files use `.ts` extension per repo convention).
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
    // #160 T4:RunResult.lastUsage 必填字段;mkResult 默认 null(无 usage 视图)。
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

  // -- B1: Ctrl+C 打断反馈（interruptNote 前缀） -------------------------------

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
    // 前缀独立成行,状态行紧随其后。
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
      // #160 T4:RunResult.lastUsage 必填字段;此用例未测 token 显示面,默认 null。
      lastUsage: null,
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
      `思考（1 段）\n\nfinal answer text\n\nstop=completed · turns=1 · tools=- · 0ms`
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

/**
 * #156 M2:off-path(`renderAssistantAnswer({showThinking:false})`)与
 * `deriveFinalText`(`result.finalText` 权威派生)的不变量回归测试。
 *
 * 两者在非分歧边界(最后一条 assistant 含非空 text)必须一致;
 * 在分歧边界(最后一条 assistant 空 text,如纯 tool_use 回合)行为有差异
 * (renderAssistantAnswer 停在最后一条 assistant -> "";deriveFinalText
 * 越过空 text 继续回扫 -> 前一条 assistant 的 text)。
 *
 * 此处显式钉住两者的当前行为,作为 tripwire:任一方被静默改动都会触发,
 * 强制未来贡献者在改其中一处时 conscious 决定是否同步另一处。
 * 生产路径 formatRunHuman(false) 走 result.finalText(deriveFinalText),
 * 故分歧仅在 renderAssistantAnswer(false) 直接测试调用暴露。
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
    // renderAssistantAnswer 停在最后一条 assistant(空 text -> "");
    // deriveFinalText 越过空 text 回扫到前一条 assistant -> "real answer"。
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
 * #160 T5:显示面接通 `lastUsage`(ADR-0008 显示路径)。
 *
 * 形状锚点(ADR-0008 Decision 2 + T1 Resolution):
 * - 域类型 `TokenUsage` 四字段 camelCase:`inputTokens` / `outputTokens` 必填
 *   + `cacheCreationInputTokens` / `cacheReadInputTokens: number | null`。
 * - `RunResult.lastUsage: TokenUsage | null` —— 必填字段,null = run 无成功
 *   模型调用。投影面锁死:
 *   - JSON:有 usage → 增 `lastUsage` 键(camelCase 四字段);null → 键缺席
 *     (与 messages 省略同风格,见 format.ts 设计注释)。
 *   - Human:有 usage → 状态行追加 `tokens in/out: <in>/<out>`;null → 不显示
 *     (cache 命中暂不进人类展示面,最小清晰原则)。
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
    // 钉死四字段 camelCase 形状;防止 JSON 投影被改回 snake_case。
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
    // 钉死完整状态行:既有 `<ms>ms` 之后追加 ` · tokens in/out: <in>/<out>`。
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
    // 钉死无 token 段的完整状态行(反向兼容既有消费者)。
    assert.equal(out, "hello\n\nstop=completed · turns=1 · tools=- · 0ms");
  });
});

/**
 * T6 (D5):renderThinkingSummary — 终稿 thinking 折叠摘要行(chat 端 showThinking
 * 的折叠态展示)。
 *
 * 语义:chat 端 showThinking=true 时不再展开 thinking 全文,改为显示摘要行
 * (TTY 无折叠交互,摘要行即"折叠态"),与 TUI 默认折叠一致。redacted_thinking
 * 计入「已加密」计数;无 thinking 块返回空串。
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
 * T2 (#458):formatVerifyReport — passed 成功态分支。
 *
 * 此前参数联合仅 failed/unstable/escalated(失败面报告);T2 把 passed
 * 纳入 wire 后, chat-session.ts:354 的调用点类型自然放宽, 需要成功
 * label。abort/disabled 不进 wire, 不加分支。
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
 * T3 (verify-claim-window SC2): chat 装配层不把 HITL 闲聊 passed 印成绿勾。
 * formatVerifyReport("passed") 仍可产出文案（给非 chat 调用方），但
 * formatChatVerifyReport 对 passed 静默 —— 钉住 chat-session 既有 gate。
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
 * T3 hub/TUI 投影: HITL + INSUFFICIENT + hitl_skip_completion_judge
 * 不得上 wire passed（人读绿勾）。SUFFICIENT 短路仍可 passed。
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

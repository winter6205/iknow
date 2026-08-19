/**
 * #467 step 2:full-compact — LLM 结构化摘要压缩(替代纯截断)单元测试。
 *
 * 覆盖 5 个导出函数(backlog 要求)+ 5 类边界(defensive contract):
 *   1. buildCompactPrompt —— 正常路径 + customInstructions 注入(trim 后空/非空)
 *   2. extractCompactSummary —— 有/无 <summary> 标签、analysis 剥离、空输入
 *   3. splitForCompaction —— 正常切分 + tool_use↔tool_result 配对补全 +
 *      无可压缩窗口(空 / ≤ keepRecent / slicedFrom=0)→ undefined
 *   4. buildCompactedMessages —— Summary 前导 + 可选 boundaryText(空串剔除)
 *   5. runFullCompact —— summarized / empty_response / timeout / adapter_failed /
 *      signal_aborted 全 variant 覆盖 + 超时 abort 真实取消
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildCompactPrompt,
  extractCompactSummary,
  splitForCompaction,
  buildCompactedMessages,
  runFullCompact,
} from "../../../src/harness/compress/full-compact.ts";
import { DEFAULT_KEEP_RECENT } from "../../../src/harness/compress/constant.ts";
import type { CompactAdapter } from "../../../src/harness/compress/full-compact.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  TokenUsage,
} from "../../../src/harness/model-adapter/types.ts";

const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

const toolUse = (id: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "lookup", input: {} }],
});

const toolResult = (id: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

function assistantTurn(
  opts: { texts?: string[]; usage?: TokenUsage } = {}
): AssistantTurnResult {
  const texts = opts.texts ?? [];
  const native: AnthropicNativeMessage = {
    role: "assistant",
    content: texts.map((t) => ({ type: "text", text: t })),
  };
  return {
    nativeMessage: native,
    projection: { nativeMessage: native, texts, toolCalls: [] },
    supplierStop: "success",
    needsTools: false,
    isEmptyFinalResponse: texts.length === 0,
    ...(opts.usage !== undefined && { usage: opts.usage }),
  };
}

/** 简易 CompactAdapter:记录调用次数,按脚本返回对应结果。 */
function makeAdapter(
  script: Array<
    | AssistantTurnResult
    | { readonly throw: Error }
    | { readonly delayMs: number; readonly then: AssistantTurnResult }
  >
): CompactAdapter & { readonly calls: { value: number } } {
  const calls = { value: 0 };
  return {
    calls,
    encodeUserText: (userText: string): AnthropicNativeMessage =>
      text(userText),
    step: async (): Promise<AssistantTurnResult> => {
      const entry = script[calls.value];
      calls.value += 1;
      if (entry === undefined) {
        throw new Error("Unexpected extra adapter.step call");
      }
      if ("throw" in entry) throw entry.throw;
      if ("delayMs" in entry) {
        await new Promise((r) => setTimeout(r, entry.delayMs));
        return entry.then;
      }
      return entry;
    },
  };
}

describe("buildCompactPrompt", () => {
  it("无 customInstructions → 不出现 Additional Instructions 段", () => {
    const prompt = buildCompactPrompt();
    assert.ok(prompt.includes("<analysis>"));
    assert.ok(prompt.includes("<summary>"));
    assert.ok(!prompt.includes("Additional Instructions:"));
  });

  it("customInstructions 非空 → 追加 Additional Instructions 段", () => {
    const prompt = buildCompactPrompt("Focus on the user's request.");
    assert.ok(
      prompt.includes(
        "\n\nAdditional Instructions:\nFocus on the user's request."
      )
    );
  });

  it("customInstructions 为空白 → 忽略(Postel)", () => {
    const prompt = buildCompactPrompt("   \n\t ");
    assert.ok(!prompt.includes("Additional Instructions:"));
  });

  it("安全保留指令固化在模板内(两个 security 追加)", () => {
    const prompt = buildCompactPrompt();
    // analysis 段 security 指令
    assert.ok(
      prompt.includes(
        "Note any security-relevant instructions or constraints the user stated"
      )
    );
    // section 6 security 指令
    assert.ok(
      prompt.includes("Preserve any security-relevant instructions verbatim")
    );
  });
});

describe("extractCompactSummary", () => {
  it("标准 <analysis> + <summary> → 只取 summary 内容,analysis 剥离", () => {
    const raw =
      "<analysis>scratchpad\ndetails</analysis>\n\n" +
      "<summary>\nPrimary request.\nErrors: fix A.\n</summary>";
    const out = extractCompactSummary(raw);
    assert.equal(out, "Primary request.\nErrors: fix A.");
  });

  it("无 <summary> 标签 → Postel:返回剥离 analysis 后的全文", () => {
    const raw = "<analysis>scratch</analysis>\nplain summary text without tags";
    const out = extractCompactSummary(raw);
    assert.equal(out, "plain summary text without tags");
  });

  it("空 / 仅空白 / 仅 analysis → undefined", () => {
    assert.equal(extractCompactSummary(""), undefined);
    assert.equal(extractCompactSummary("   \n  "), undefined);
    assert.equal(extractCompactSummary("<analysis>x</analysis>"), undefined);
  });

  it("连续空行折叠(3+ → 2)", () => {
    const out = extractCompactSummary("<summary>a\n\n\n\nb</summary>");
    assert.equal(out, "a\n\nb");
  });

  // #467 follow-up 回归:i467 real-LLM smoke 抓到 MiniMax-M3 真实模型把
  // `<analysis>` 文本写在 `<summary>` 块内(或未闭合)→ 旧实现只 pre-strip
  // 一次,scratchpad 文本泄漏进权威摘要。修复后对 base 再 strip 一次(含
  // unclosed tail),无论 model 把 analysis 写在 summary 块外还是块内都能
  // 干净剥离。
  it("<analysis> 写在 <summary> 块内也被剥离(真实模型 leak 修复)", () => {
    const raw =
      "<summary>\n" +
      "Primary request.\n" +
      "<analysis>\ninner scratchpad inside summary block\n</analysis>\n" +
      "More summary content.\n" +
      "</summary>";
    const out = extractCompactSummary(raw);
    assert.ok(out !== undefined);
    assert.ok(!out!.includes("<analysis>"), "analysis 标签不能泄漏进提取结果");
    assert.ok(
      !out!.includes("inner scratchpad"),
      "analysis 块内文本必须被剥离"
    );
    assert.ok(out!.includes("Primary request"));
    assert.ok(out!.includes("More summary content"));
  });

  it("<analysis> 未闭合(tail-only)也被剥离", () => {
    const raw = "<summary>\nPrimary request.\n<analysis>orphan";
    const out = extractCompactSummary(raw);
    assert.ok(out !== undefined);
    assert.ok(!out!.includes("<analysis>"));
    assert.ok(out!.includes("Primary request"));
  });
});

describe("splitForCompaction", () => {
  it("空数组 / ≤ keepRecent → undefined(无可压缩窗口)", () => {
    assert.equal(splitForCompaction([]), undefined);
    const short = Array.from({ length: DEFAULT_KEEP_RECENT - 1 }, (_, i) =>
      text(String(i))
    );
    assert.equal(splitForCompaction(short), undefined);
    const exact = Array.from({ length: DEFAULT_KEEP_RECENT }, (_, i) =>
      text(String(i))
    );
    assert.equal(splitForCompaction(exact), undefined);
  });

  it("正常切分:dropped = 前缀,kept = 尾部 DEFAULT_KEEP_RECENT 条", () => {
    const messages = Array.from({ length: 10 }, (_, i) => text(`m${i}`));
    const split = splitForCompaction(messages);
    assert.ok(split !== undefined);
    assert.equal(split.dropped.length, 10 - DEFAULT_KEEP_RECENT);
    assert.equal(split.kept.length, DEFAULT_KEEP_RECENT);
    assert.equal(split.dropped[0], messages[0]);
    assert.equal(split.kept[0], messages[10 - DEFAULT_KEEP_RECENT]);
  });

  it("tool_use 跨边界 → 向前补全配对,配对完整性守门(SC11)", () => {
    // 构造:丢弃区含调用,保留区首条是其 tool_result → 必须把 tool_use 并入 kept。
    const t1 = "call-1";
    const messages = [
      text("a"),
      text("b"),
      text("c"),
      toolUse(t1), // 这个 tool_use 落在丢弃区(slicedFrom=6 之前)
      text("d"),
      text("e"),
      toolResult(t1),
      text("f"),
      text("g"),
      text("h"),
    ];
    // length 10 > keepRecent 6 → 默认 earliestIndex = 4(idx4 = text d)。
    // tool_result(id=t1) 在 idx6 保留区内 → 回扫找出 tool_use(idx3) 并入 kept。
    const split = splitForCompaction(messages);
    assert.ok(split !== undefined);
    assert.ok(
      split.kept.some(
        (m) =>
          m.role === "assistant" &&
          m.content.some((b) => b.type === "tool_use" && b.id === t1)
      ),
      "tool_use 必须随其 tool_result 一起保留(SC11 配对)"
    );
    // kept 内所有 tool_use 都有配对 tool_result(守门不变式)。
    const keptUseIds = new Set<string>();
    const keptResultIds = new Set<string>();
    for (const m of split.kept) {
      for (const b of m.content) {
        if (b.type === "tool_use") keptUseIds.add(b.id);
        if (b.type === "tool_result") keptResultIds.add(b.tool_use_id);
      }
    }
    for (const id of keptUseIds) {
      assert.ok(keptResultIds.has(id), `tool_use ${id} 必须在 kept 内有配对`);
    }
  });

  it("dropped 冻结(shallow freeze),kept 复用 window 切片", () => {
    const messages = Array.from({ length: 10 }, (_, i) => text(`m${i}`));
    const split = splitForCompaction(messages);
    assert.ok(split !== undefined);
    assert.ok(Object.isFrozen(split.dropped), "dropped 数组应冻结");
  });
});

describe("buildCompactedMessages", () => {
  it("summary 前导 + kept;无 boundaryText → 无 attachment 消息", () => {
    const kept = [text("k1"), text("k2")];
    const out = buildCompactedMessages({ summaryText: "SUM", kept });
    assert.equal(out.length, 3);
    assert.equal(out[0]!.role, "user");
    const t = out[0]!.content[0];
    assert.equal(t.type, "text");
    assert.ok(
      t.type === "text" &&
        t.text.startsWith(
          "This session is being continued from a previous conversation"
        )
    );
    assert.ok(t.type === "text" && t.text.endsWith("\n\nSummary:\nSUM"));
  });

  it("boundaryText 提供 → summary 与 kept 之间插入 attachment user 消息", () => {
    const kept = [text("k1")];
    const out = buildCompactedMessages({
      summaryText: "SUM",
      kept,
      boundaryText: "focus@now",
    });
    assert.equal(out.length, 3);
    assert.deepStrictEqual(out[1], {
      role: "user",
      content: [{ type: "text", text: "focus@now" }],
    });
    assert.equal(out[2], kept[0]);
  });

  it("boundaryText 为空串 → 不插入 attachment(Postel)", () => {
    const kept = [text("k1")];
    const out = buildCompactedMessages({
      summaryText: "SUM",
      kept,
      boundaryText: "",
    });
    assert.equal(out.length, 2);
  });
});

describe("runFullCompact", () => {
  const dropped = Array.from({ length: 8 }, (_, i) => text(`m${i}`));

  it("summarized:非空摘要文本 + usage 透传", async () => {
    const usage: TokenUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    const adapter = makeAdapter([
      assistantTurn({
        texts: ["<analysis>x</analysis><summary>Y</summary>"],
        usage,
      }),
    ]);
    const out = await runFullCompact({ adapter, dropped });
    assert.equal(out.kind, "summarized");
    if (out.kind === "summarized") {
      assert.equal(out.text, "Y");
      assert.deepStrictEqual(out.usage, usage);
    }
    assert.equal(adapter.calls.value, 1);
  });

  it("empty_response:仅空白 / 空文本 → empty_response", async () => {
    const blank = makeAdapter([assistantTurn({ texts: ["   \n"] })]);
    const out1 = await runFullCompact({ adapter: blank, dropped });
    assert.equal(out1.kind, "empty_response");

    const empty = makeAdapter([assistantTurn({ texts: [] })]);
    const out2 = await runFullCompact({ adapter: empty, dropped });
    assert.equal(out2.kind, "empty_response");
  });

  it("adapter_failed:同步/异步 throw 都收敛为 adapter_failed", async () => {
    const syncThrow = makeAdapter([{ throw: new Error("sync boom") }]);
    const out1 = await runFullCompact({ adapter: syncThrow, dropped });
    assert.equal(out1.kind, "adapter_failed");
    if (out1.kind === "adapter_failed")
      assert.ok(out1.message.includes("sync boom"));

    const asyncThrow = makeAdapter([{ throw: new Error("async boom") }]);
    const out2 = await runFullCompact({ adapter: asyncThrow, dropped });
    assert.equal(out2.kind, "adapter_failed");
    if (out2.kind === "adapter_failed")
      assert.ok(out2.message.includes("async boom"));
  });

  it("adapter_failed:失败分支不泄漏注入的 timeout timer(review-fix Medium)", async () => {
    // 修复前:catch 分支设 adapterSettled=true 但不 clearTimeout,外部 finally
    // 因 !adapterSettled 为 false 而跳过清理 → 注入的 timeout timer 挂在
    // event loop。修复后:finally 块在 IIFE 内统一清 timer,失败路径不残留。
    // 注:timeoutMs 缺席时本来就不装 timer;此测试显式注入 timeoutMs=5000
    // 触发 timer,验证失败分支仍正确清理。
    const throwAdapter = makeAdapter([{ throw: new Error("boom") }]);
    const timersBefore = process
      .getActiveResourcesInfo()
      .filter((r) => r === "Timeout").length;
    const out = await runFullCompact({
      adapter: throwAdapter,
      dropped,
      timeoutMs: 5000,
    });
    assert.equal(out.kind, "adapter_failed");
    // 让 microtask 队列清空,确保任何 pending setTimeout 都已登记。
    await new Promise((r) => setTimeout(r, 0));
    const timersAfter = process
      .getActiveResourcesInfo()
      .filter((r) => r === "Timeout").length;
    assert.ok(
      timersAfter <= timersBefore,
      `失败分支不应残留注入的 timeout timer: before=${timersBefore}, after=${timersAfter}`
    );
  });

  it("signal_aborted:入口已 abort → 不调 adapter,直接 signal_aborted", async () => {
    let called = false;
    const events: string[] = [];
    const adapter: CompactAdapter = {
      encodeUserText: (userText: string): AnthropicNativeMessage =>
        text(userText),
      step: async (): Promise<AssistantTurnResult> => {
        called = true;
        return assistantTurn({ texts: ["x"] });
      },
    };
    const controller = new AbortController();
    controller.abort();
    const out = await runFullCompact({
      adapter,
      dropped,
      signal: controller.signal,
      onStream: (e) => events.push(e.type),
    });
    assert.equal(out.kind, "signal_aborted");
    assert.equal(called, false, "已 abort 时不得发起模型调用");
    // 入口已 abort:不发起模型调用 = 不 emit compaction_started。
    assert.deepEqual(events, []);
  });

  it("无默认 client-side 超时:timeoutMs 缺席 → 无 timer,adapter settle 即出 outcome(Claude Code 语义)", async () => {
    // 参考 Claude Code:压缩等模型自然完成,不设紧凑 timeout;上限 = SDK
    // 默认 HTTP timeout + 用户 signal。timeoutMs 缺席时不得装 timer ——
    // 验证:慢 adapter(80ms,超旧 25s 语义下会触发 timeout)返回 summarized,
    // 且全程无 Timeout 句柄被注册(getActiveResourcesInfo 增量 = 0)。
    const timersBefore = process
      .getActiveResourcesInfo()
      .filter((r) => r === "Timeout").length;
    const slowAdapter = makeAdapter([
      { delayMs: 80, then: assistantTurn({ texts: ["<summary>S</summary>"] }) },
    ]);
    const out = await runFullCompact({ adapter: slowAdapter, dropped });
    assert.equal(out.kind, "summarized");
    const timersAfter = process
      .getActiveResourcesInfo()
      .filter((r) => r === "Timeout").length;
    assert.ok(
      timersAfter <= timersBefore,
      `timeoutMs 缺席不得注册 timer: before=${timersBefore}, after=${timersAfter}`
    );
  });

  it("timeoutMs 显式注入仍生效(测试 / caller 显式注入缝保留)", async () => {
    let aborted = false;
    const adapter: CompactAdapter = {
      encodeUserText: (userText: string): AnthropicNativeMessage =>
        text(userText),
      step: async (_state, _request, signal) => {
        await new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        throw new Error("unreachable");
      },
    };
    const out = await runFullCompact({ adapter, dropped, timeoutMs: 30 });
    assert.equal(out.kind, "timeout");
    assert.ok(aborted, "注入 timeoutMs 必须 abort 真实 adapter 调用");
  });

  // #467 T4:wait 逻辑参考 Claude Code — 压缩生命周期事件透传。
  // 宿主层据此渲染 "Compacting…" 指示器 + 展示摘要生成进度
  // (adapter 流式臂的 text_delta 经 request.onStream 直透)。
  describe("wait logic 事件生命周期 (Claude Code UX)", () => {
    it("summarized:emits compaction_started + compaction_completed, observer 错误被吞咽", async () => {
      const events: { type: string; payload?: unknown }[] = [];
      const throwing = (): void => {
        throw new Error("observer crash");
      };
      const usage: TokenUsage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      };
      const adapter = makeAdapter([
        assistantTurn({
          texts: ["<analysis>x</analysis><summary>Y</summary>"],
          usage,
        }),
      ]);
      const out = await runFullCompact({
        adapter,
        dropped,
        onStream: (e) => {
          events.push({ type: e.type, payload: e });
          throwing(); // 必须不反流回压缩逻辑
        },
      });
      assert.equal(out.kind, "summarized");
      // compaction_started → compaction_completed 两事件;completed 携带
      // summaryLen + durationMs;started 携带 droppedCount。
      const types = events.map((e) => e.type);
      assert.deepEqual(types, ["compaction_started", "compaction_completed"]);
      const started = events[0]?.payload as {
        type: string;
        droppedCount: number;
      };
      assert.equal(started.droppedCount, dropped.length);
      const completed = events[1]?.payload as {
        type: string;
        summaryLen: number;
        durationMs: number;
      };
      assert.equal(completed.summaryLen, "Y".length);
      assert.ok(
        typeof completed.durationMs === "number" && completed.durationMs >= 0,
        "durationMs 是非负 number"
      );
    });

    it("adapter_failed:emits compaction_failed(reason = adapter_failed),吞咽观察者 throw", async () => {
      const events: { type: string; reason?: string }[] = [];
      const throwingObserver = (): void => {
        throw new Error("nope");
      };
      const adapter = makeAdapter([{ throw: new Error("boom") }]);
      const out = await runFullCompact({
        adapter,
        dropped,
        onStream: (e) => {
          events.push({
            type: e.type,
            reason: "reason" in e ? e.reason : undefined,
          });
          throwingObserver();
        },
      });
      assert.equal(out.kind, "adapter_failed");
      assert.deepEqual(
        events.map((e) => e.type),
        ["compaction_started", "compaction_failed"]
      );
      assert.equal(events[1]?.reason, "adapter_failed");
    });

    // #550 替换原「onStream → adapter.step request.onStream 直透」用例:
    // 直透会让压缩摘要 text_delta 泄漏进宿主主回答草稿(渲染污染 latent
    // bug,issue #550)。新契约 = 包装透传:text_delta 重映射为
    // compaction_text_delta,thinking_delta 吞咽,其余事件原样透传。
    // 覆盖不变或更强:旧用例只 assert 引用相等,新用例 assert 完整路由语义。
    it("onStream → adapter.step request.onStream 包装(text_delta → compaction_text_delta;thinking 吞咽)", async () => {
      const observed: Array<{ type: string; text?: string }> = [];
      const adapter: CompactAdapter = {
        encodeUserText: (userText: string): AnthropicNativeMessage =>
          text(userText),
        step: async (_state, request): Promise<AssistantTurnResult> => {
          // 模拟 adapter 在压缩上下文内的流式输出:摘要 text_delta +
          // thinking_delta(模型 scratchpad)+ 其他事件。
          request.onStream?.({ type: "text_delta", text: "摘要第一段" });
          request.onStream?.({ type: "thinking_delta", text: "内部思考" });
          request.onStream?.({ type: "text_delta", text: "摘要第二段" });
          return assistantTurn({
            texts: ["<analysis>x</analysis><summary>Y</summary>"],
          });
        },
      };
      await runFullCompact({
        adapter,
        dropped,
        onStream: (e) => {
          if (e.type === "text_delta" || e.type === "compaction_text_delta") {
            observed.push({ type: e.type, text: e.text });
          } else {
            observed.push({ type: e.type });
          }
        },
      });
      // 摘要 text_delta 全部重映射为 compaction_text_delta —— 宿主据此路由
      // 到独立压缩草稿,不进主回答区。
      assert.deepEqual(
        observed.filter((e) => e.type.includes("text")),
        [
          { type: "compaction_text_delta", text: "摘要第一段" },
          { type: "compaction_text_delta", text: "摘要第二段" },
        ]
      );
      // thinking_delta 吞咽(scratchpad 不暴露)+ 无裸 text_delta 泄漏。
      assert.ok(
        !observed.some((e) => e.type === "thinking_delta"),
        "压缩 thinking_delta 不得透到宿主"
      );
      assert.ok(
        !observed.some((e) => e.type === "text_delta"),
        "裸 text_delta 不得透到宿主(#550 渲染污染守门)"
      );
    });

    it("生命周期事件仍直发 opts.onStream(started/completed 不被 wrapper 二次包装)", async () => {
      const types: string[] = [];
      const adapter: CompactAdapter = {
        encodeUserText: (userText: string): AnthropicNativeMessage =>
          text(userText),
        step: async (): Promise<AssistantTurnResult> =>
          assistantTurn({
            texts: ["<summary>done</summary>"],
          }),
      };
      await runFullCompact({
        adapter,
        dropped,
        onStream: (e) => types.push(e.type),
      });
      assert.deepEqual(types, ["compaction_started", "compaction_completed"]);
    });

    it("中途 abort:opts.signal 中途 abort → signal_aborted,emit compaction_started 但不 emit completed/failed", async () => {
      // Claude Code 体感:压缩中 Esc/Ctrl+C = 立刻退出 + 会话原样。
      // runFullCompact 必须把中途取消映射为 signal_aborted(让 caller 决定
      // 不做 fallback 截断),且不发 compaction_completed / compaction_failed
      // —— completed 让宿主误以为成功,failed 让宿主误以为异常停。
      const events: string[] = [];
      const adapter: CompactAdapter = {
        encodeUserText: (userText: string): AnthropicNativeMessage =>
          text(userText),
        step: async (_state, _request, signal) => {
          // 挂起到 abort。
          await new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
          throw new Error("unreachable");
        },
      };
      const controller = new AbortController();
      // 关键时序:不先 await;先发起 runFullCompact(同步 emit compaction_started
      // 并把 adapter.step 挂起到 abort 监听),然后 controller.abort() 触发
      // composite signal → adapter 抛 AbortError → race resolved with
      // adapter_failed → opts.signal?.aborted 检查覆盖为 signal_aborted。
      const outPromise = runFullCompact({
        adapter,
        dropped,
        signal: controller.signal,
        timeoutMs: 5000,
        onStream: (e) => events.push(e.type),
      });
      // 让 microtask 跑一拍,确保 adapter.step 已注册 abort listener。
      await new Promise((r) => setTimeout(r, 0));
      controller.abort();
      const out = await outPromise;
      assert.equal(
        out.kind,
        "signal_aborted",
        "mid-flight user abort 必须映射为 signal_aborted(caller 走 keep-state 路径)"
      );
      // 事件序列:started(同步段)→ cancelled 终态收尾(宿主据此清除指示器);
      // completed / failed 不 emit——取消非失败(spec-reviewer 契约修复)。
      assert.deepEqual(events, ["compaction_started", "compaction_cancelled"]);
    });

    it("opts.onStream 未传 → 行为零变化(不抛,不影响 outcome)", async () => {
      const usage: TokenUsage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      };
      const adapter = makeAdapter([
        assistantTurn({
          texts: ["<analysis>x</analysis><summary>Z</summary>"],
          usage,
        }),
      ]);
      // 不传 onStream:必须不抛,outcome 仍是 summarized。
      const out = await runFullCompact({ adapter, dropped });
      assert.equal(out.kind, "summarized");
      if (out.kind === "summarized") {
        assert.equal(out.text, "Z");
      }
    });
  });
});

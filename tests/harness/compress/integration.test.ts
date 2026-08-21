/**
 * #119 T7: integration test — loop-engine compress 接线端到端。
 *
 * Spec: specs/119-compression-landing.md (SC7 / SC11 / SC12 / Q3 / Q4) +
 * plan T7 bullet。
 *
 * 用 stub model 构造固定回合的长对话(run() 不调真实 LLM),验证:
 *   a. deps.compress 缺席 → 行为零变化(不触发压缩,无边界占位符);
 *   b. deps.compress 就位 + 低阈值 → 触发 compactMessages,messages 变短,
 *      且 system 缝(deps.system)不受影响(SC12);
 *   c. 压缩后 tool_use↔tool_result 配对完整(SC11);
 *   d. turnCount 锚点:同一轮不重复触发,lastCompactTurn 守锚
 *      (极端长对话 + 低阈值 → 压缩 ≥1 次 ≤ N/2 次);
 *   e. deps.compress.thresholdTokens = undefined → 缺省推导 window-33000;
 *      极大 contextWindow → 不触发;极小 contextWindow → 触发。
 *
 * 不硬编码真实 LLM token value;只用 estimate 函数语义(constant 层) +
 * 自定义 threshold 模拟触发。
 *
 * #604 T1 (SC1-SC5): compact 边界渲染缝。`deps.boundaryAttachment` 可选闭包
 * 在 compact 触发时把渲染文本追加为一条 user 消息(放在 boundary placeholder
 * 之后)。两处 compact 调用点(reactive line 717 / proactive line 1339)共用
 * `applyCompactAttachment` helper:
 *   f. proactive compact + boundaryAttachment → messages[0]=placeholder,
 *      messages[1]=attachment user 消息,messages[2+]=保留尾部;
 *   g. boundaryAttachment 缺席 → 仅 placeholder(byte-stable);
 *   h. reactive compact 路径同样命中(共享 helper);
 *   i. 普通 turn(阈值未达)→ boundaryAttachment 不调用(no-op)。
 *
 * #604 取代 #458 T7 (SC11) — 边界渲染源从 taskFocus 字段(240+history+cap720)
 * 改为 hub 注入的 renderRecentUserTasksBoundary(取最近 ≤3 句合格用户任务原话)。
 * 本文件测试 deps.boundaryAttachment 缝本身(不动 hub 闭包),仍用合成 fixture
 * "focus@now\n---\nhist1" 验证 helper 调用 + 消息注入逻辑 — 与 #604 兼容。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { run } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import {
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
  estimateMessagesTokens,
} from "../../../src/harness/compress/index.ts";
import { PromptTooLongError } from "../../../src/harness/errors.ts";

// #467 step 2:compact 触发的"边界"消息可以是旧的纯截断占位符
// (COMPACTION_BOUNDARY_PLACEHOLDER)或新的 LLM 摘要轮(SUMMARY_PREAMBLE + 摘要
// 内容)。同一断言需要兼容两种形态 — 用 isCompactBoundaryMessage 判定。
// 保留对 placeholder 的兼容性以便老契约断言不破(blue-green 过渡)。
const SUMMARY_PREAMBLE_FRAGMENT =
  "This session is being continued from a previous conversation";
function isCompactBoundaryMessage(m: AnthropicNativeMessage): boolean {
  if (m.role !== "user") return false;
  return m.content.some(
    (b): b is { type: "text"; text: string } =>
      b.type === "text" &&
      (b.text === COMPACTION_BOUNDARY_PLACEHOLDER ||
        b.text.startsWith(SUMMARY_PREAMBLE_FRAGMENT))
  );
}
/** #467 step 2:LLM 摘要轮 user 消息(SUMMARY_PREAMBLE + 摘要内容)。 */
function isSummaryMessage(m: AnthropicNativeMessage | undefined): boolean {
  if (m === undefined || m.role !== "user") return false;
  return m.content.some(
    (b): b is { type: "text"; text: string } =>
      b.type === "text" && b.text.startsWith(SUMMARY_PREAMBLE_FRAGMENT)
  );
}
function textOf(m: AnthropicNativeMessage): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopAdapter } from "../../../src/harness/loop-engine.ts";
import { toAnthropicToolResults } from "../../../src/harness/tools/tool-result.ts";
import type { ToolExecutionResult } from "../../../src/harness/tools/types.ts";

/** 每回合 inflate 的文本量:让 estimate 在 ~5 回合内越过低阈值(≈1000)。 */
const BIG_TEXT = "payload ".repeat(40); // ~320 chars → ~80 tokens/回合
const TOOL_RESULT_TEXT = "tool-result-body ".repeat(60); // tool_result 也 inflate

const TURNS = 100;

/**
 * 构造 N 回合 tool-call 长对话 + 1 条 completed 收尾的脚本化 stub responses。
 * 每回合 assistant 携带大 text + 一个 tool_use;tool_result 由 executor 产出。
 */
function buildResponses(n: number) {
  const responses = [];
  for (let i = 0; i < n; i++) {
    responses.push(
      assistantResult({
        texts: [BIG_TEXT],
        toolCalls: [{ id: `call-${i}`, name: "noop", input: { i } }],
      })
    );
  }
  // 收尾:纯文本 completed(无 tool call)。
  responses.push(
    assistantResult({
      texts: ["completed"],
      toolCalls: [],
      supplierStop: "success",
    })
  );
  return responses;
}

/** 统计 messages 内 tool_use 块。 */
function toolUses(
  messages: ReadonlyArray<{
    readonly content: ReadonlyArray<AnthropicContentBlock>;
  }>
): ReadonlyArray<{ id: string }> {
  const out: { id: string }[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") out.push({ id: b.id });
    }
  }
  return out;
}

/** 统计 messages 内 tool_result 的 tool_use_id。 */
function toolResultIds(
  messages: ReadonlyArray<{
    readonly content: ReadonlyArray<AnthropicContentBlock>;
  }>
): ReadonlyArray<string> {
  const out: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_result") out.push(b.tool_use_id);
    }
  }
  return out;
}

/** 断言 completion 收尾消息仍保留(不可 mutate 尾部)。 */
function assertCompletionTail(
  messages: ReadonlyArray<{
    readonly content: ReadonlyArray<AnthropicContentBlock>;
  }>
): void {
  const last = messages[messages.length - 1]!;
  const text = last.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  assert.ok(
    text.includes("completed"),
    "final assistant message must survive compaction"
  );
}

describe("loop-engine compress 接线 (#119 T7)", () => {
  const noopTool = createStubTool({
    name: "noop",
    next: () => TOOL_RESULT_TEXT,
  });
  const registry = createRegistry([noopTool]);
  const executor = createExecutor(registry);

  it("deps.compress 缺席 → 行为零变化,run 不触发压缩", async () => {
    const model = createStubModel({ responses: buildResponses(3) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: 10,
    });
    assert.equal(result.stopReason, "completed");
    // 3 回合 tool-call:user + 3×(assistant+user tool_result) + assistant 收尾。
    assert.equal(result.messages.length, 1 + 3 * 2 + 1);
    // 无边界占位符 → 未压缩。
    const serialized = JSON.stringify(result.messages);
    assert.ok(
      !serialized.includes(COMPACTION_BOUNDARY_PLACEHOLDER),
      "compress 缺席时不得插入边界占位符"
    );
  });

  it("deps.compress 就位 + 低阈值 → 触发压缩,messages 变短,system 不受影响", async () => {
    let systemCalls = 0;
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      // SC12:system 缝独立于压缩;装配一个返回常量的 resolvers 验证不被触碰。
      system: async () => {
        systemCalls++;
        return "SYSTEM-PROMPT-CONST";
      },
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    });
    assert.equal(result.stopReason, "completed");
    // 压缩发生:边界消息出现(placeholder 或 LLM 摘要轮皆可,#467 step 2)。
    assert.ok(
      result.messages.some(isCompactBoundaryMessage),
      "低阈值 + 长对话必须触发压缩 (placeholder 或 summary)"
    );
    // 压缩后 messages 显著短于未压缩的 1+200+1=202 条。
    assert.ok(
      result.messages.length < 50,
      `压缩后 messages 应大幅变短,实际 ${result.messages.length}`
    );
    // system 缝照常被调用(压缩不干扰 system 注入)。
    assert.ok(systemCalls > 0, "deps.system 必须仍被调用");
    // 尾部 completed 保留。
    assertCompletionTail(result.messages);
  });

  it("压缩后 tool_use↔tool_result 配对完整 (SC11)", async () => {
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    });
    assert.equal(result.stopReason, "completed");
    const uses = toolUses(result.messages);
    const resultIds = new Set(toolResultIds(result.messages));
    for (const u of uses) {
      assert.ok(
        resultIds.has(u.id),
        `kept messages 内 tool_use ${u.id} 必须存在配对 tool_result (SC11)`
      );
    }
  });

  it("turnCount 锚点:同一轮不重复触发,长对话压缩次数 ≥1 且 ≤ N/2", async () => {
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    });
    assert.equal(result.stopReason, "completed");
    // 边界消息(placeholder 或 summary)出现次数 = 压缩次数(每次 compact 插入
    // 一条边界消息,#467 step 2 摘要轮也是边界消息)。
    const boundaryCount = result.messages.filter(
      isCompactBoundaryMessage
    ).length;
    assert.ok(boundaryCount >= 1, "至少触发一次压缩");
    assert.ok(
      boundaryCount <= Math.floor(TURNS / 2),
      `压缩次数 ${boundaryCount} 应 ≤ ${Math.floor(TURNS / 2)}(turnCount 锚点守约)`
    );
    // S10 freeze gate:压缩结果与 appendMessage 一样冻结每条 + content 块,
    // 后续回路修改应静默失败(strict mode)。
    assert.ok(Object.isFrozen(result.messages), "messages 数组应被冻结");
    for (const m of result.messages) {
      assert.ok(Object.isFrozen(m), `message ${m.role} 应被冻结`);
      assert.ok(Object.isFrozen(m.content), `${m.role}.content 应被冻结`);
    }
  });

  it("thresholdTokens=undefined → 缺省推导(window-33000);极大 window 不触发,极小 window 触发", async () => {
    // (a) 极大 contextWindow → 缺省阈值巨大 → 不触发。
    const bigModel = createStubModel({ responses: buildResponses(5) });
    const big = await run("hello", {
      adapter: bigModel,
      executor,
      registry,
      maxTurns: 10,
      compress: { contextWindow: 10_000_000, thresholdTokens: undefined },
    });
    assert.equal(big.result.stopReason, "completed");
    assert.ok(
      !JSON.stringify(big.result.messages).includes(
        COMPACTION_BOUNDARY_PLACEHOLDER
      ),
      "极大 contextWindow + 缺省阈值不得触发压缩"
    );

    // (b) 极小 contextWindow → 缺省阈值 window-33000 为负 → estimate ≥ 负恒真 → 触发。
    const smallModel = createStubModel({ responses: buildResponses(5) });
    const small = await run("hello", {
      adapter: smallModel,
      executor,
      registry,
      maxTurns: 10,
      compress: { contextWindow: 2000, thresholdTokens: undefined },
    });
    assert.equal(small.result.stopReason, "completed");
    assert.ok(
      small.result.messages.some(isCompactBoundaryMessage),
      "极小 contextWindow + 缺省阈值必须触发压缩 (placeholder 或 summary)"
    );

    // (c) 语义自检:estimate + 缺省阈值关系(纯函数,不依赖 LLM)。
    // 极小 window 的缺省阈值 window-33000 < 0,estimateMessagesTokens ≥ 1 恒 ≥ 阈值。
    const probe = estimateMessagesTokens([
      { role: "user", content: [{ type: "text", text: "x" }] },
    ]);
    assert.ok(probe >= 1);
  });
});

// -- #604 T1 (SC1-SC5): compact 边界 boundaryAttachment 渲染缝 ---------------

/** Construct a minimal prior-message array. */
const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

/**
 * #467 step 2:proactive compact → LLM 摘要成功路径专用 adapter。
 * 非 compact 步(tools 已传)按脚本消费;compact 摘要步(tools === undefined)
 * 返回 `<analysis>…</analysis><summary>SUMMARY-OVER-DROPPED</summary>`,
 * 让 runFullCompact 走 summarized 分支 → buildCompactedMessages 输出
 * `SUMMARY_PREAMBLE + 摘要内容` 的 user 消息在 messages[0]。
 */
function makeCompactSummaryAdapter(opts: {
  readonly responses: ReadonlyArray<AssistantTurnResult>;
}): LoopAdapter & { readonly compactSteps: { value: number } } {
  const queue = opts.responses.slice();
  const compactSteps = { value: 0 };
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    // 必须产出真实 tool_result 块:本 adapter 会跑完整 tool 回合,preserveToolPairs
    // 依赖 tool_result 块做配对守门。空数组会让 tool_use 悬空,splitForCompaction
    // 抛 "missing tool_result"(与 flaky adapter 不同,那里 compact 发生在首个
    // tool 回合前,从不带悬空 tool_use 进入 split)。
    encodeToolResults: (
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] => toAnthropicToolResults(results),
    step: async (
      state: LoopState,
      request: { readonly tools?: unknown }
    ): Promise<AssistantTurnResult> => {
      if (request.tools === undefined) {
        // 与 stub-model 同款判别:只有带 full-compact prompt 的 no-tools 步
        // 才算摘要步;收尾摘要(epilogue SUMMARY_PROMPT)会经正常 queue 消费。
        const lastUserText = [...state.messages]
          .reverse()
          .find((m) => m.role === "user")
          ?.content.filter(
            (b): b is { type: "text"; text: string } => b.type === "text"
          )
          .map((b) => b.text)
          .join("");
        if (
          lastUserText?.includes(
            "Your task is to create a detailed summary of the conversation so far"
          ) === true
        ) {
          compactSteps.value += 1;
          return assistantResult({
            texts: [
              "<analysis>scratch dropped detail</analysis>" +
                "<summary>SUMMARY-OVER-DROPPED</summary>",
            ],
            toolCalls: [],
            supplierStop: "success",
          });
        }
      }
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(
          "makeCompactSummaryAdapter: scripted responses exhausted"
        );
      }
      return next;
    },
    compactSteps,
  });
}

/**
 * Reactive path 触发器：first attempt throws PromptTooLongError, second
 * attempt returns success。模拟"压缩前模型拒绝 → reactive 触发压缩 →
 * 压缩后模型接受"。
 */
function makeFlakyAdapter(opts: {
  readonly retryText: string;
  readonly attemptCount: { value: number };
}) {
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (): AnthropicContentBlock[] => [],
    step: async (
      _state: LoopState,
      request: { readonly tools?: unknown; readonly onStream?: unknown }
    ): Promise<AssistantTurnResult> => {
      opts.attemptCount.value += 1;
      if (opts.attemptCount.value === 1) {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      // #467 step 2:full-compact 摘要轮步进无 tools(request.tools === undefined)。
      // 摘要步返回空文本 → runFullCompact 报 empty_response → 回退 placeholder,
      // 测试意图(验证 fallback 路径)保持;摘要成功路径由专门用例覆盖。
      if (request.tools === undefined) {
        return assistantResult({
          texts: [],
          toolCalls: [],
          supplierStop: "success",
        });
      }
      return assistantResult({
        texts: [opts.retryText],
        toolCalls: [],
        supplierStop: "success",
      });
    },
  });
}

describe("loop-engine compress boundaryAttachment (#604 T1 SC1-SC5)", () => {
  const noopTool = createStubTool({
    name: "noop",
    next: () => TOOL_RESULT_TEXT,
  });
  const registry = createRegistry([noopTool]);
  const executor = createExecutor(registry);

  it("proactive compact + boundaryAttachment → placeholder 后追加 attachment user 消息", async () => {
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
      boundaryAttachment: () => "focus@now\n---\nhist1",
    });
    assert.equal(result.stopReason, "completed");
    // SC11:#467 step 2:boundary 可能是 LLM 摘要轮或 placeholder; attachment user
    // 消息紧跟其后(buildCompactedMessages / fallback 都遵循此 layout)。
    assert.ok(
      isCompactBoundaryMessage(result.messages[0]!),
      "messages[0] must be compact boundary (placeholder 或 summary)"
    );
    assert.deepStrictEqual(result.messages[1], {
      role: "user",
      content: [{ type: "text", text: "focus@now\n---\nhist1" }],
    });
    // 保留尾部:最终 assistant 收尾仍在。
    assertCompletionTail(result.messages);
  });

  it("boundaryAttachment 缺席 → 仅 placeholder 无 attachment 消息", async () => {
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    });
    assert.equal(result.stopReason, "completed");
    // 边界消息出现(确认 compact 真触发):placeholder 或 LLM 摘要轮皆可。
    assert.ok(
      isCompactBoundaryMessage(result.messages[0]!),
      "messages[0] must be compact boundary (placeholder 或 summary)"
    );
    // messages[1] 不应是 attachment 文本;它要么是保留尾部要么是后续 assistant。
    const second = result.messages[1];
    assert.ok(second, "messages[1] must exist (kept tail or assistant)");
    const secondText = second.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    assert.ok(
      !secondText.includes("focus@now"),
      "messages[1] must NOT be attachment user message when boundaryAttachment absent"
    );
  });

  it("普通 turn(阈值未达)→ boundaryAttachment 不调用(no-op SC11)", async () => {
    let calls = 0;
    const model = createStubModel({ responses: buildResponses(3) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: 10,
      // 极大 contextWindow → 缺省阈值 window-33000 远超 estimate → 不触发。
      compress: { contextWindow: 10_000_000, thresholdTokens: undefined },
      boundaryAttachment: () => {
        calls++;
        return "focus@now\n---\nhist1";
      },
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(calls, 0, "阈值未达 → boundaryAttachment 不得被调用");
    const serialized = JSON.stringify(result.messages);
    assert.ok(
      !serialized.includes(COMPACTION_BOUNDARY_PLACEHOLDER),
      "阈值未达 → 不得触发 compact,无占位符"
    );
    assert.ok(
      !serialized.includes("focus@now"),
      "阈值未达 → 不得注入 attachment 文本"
    );
  });

  it("reactive compact + boundaryAttachment → placeholder 后追加 attachment(共享 helper)", async () => {
    // 12 条 prior + 1 user text → compactMessages 产出 placeholder + DEFAULT_KEEP_RECENT kept。
    const longPrior = Array.from({ length: 12 }, (_, i) =>
      text(`prior-${i} ${"z".repeat(20)}`)
    );
    const attemptCount = { value: 0 };
    const adapter = makeFlakyAdapter({
      retryText: "done after compact",
      attemptCount,
    });
    const { result } = await run(
      "Q",
      {
        adapter,
        executor,
        registry,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
        boundaryAttachment: () => "focus@now\n---\nhist1",
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    // #467 step 2:applyCompactAttachment 全程多一次 adapter 调用(runFullCompact
    // 摘要步 + PromptTooLongError 触发 + 重试成功),full-compact 失败 → fallback
    // placeholder,几何 (placeholder + attachment + kept + retry) 保持不变。
    assert.equal(
      attemptCount.value,
      3,
      "首次抛 PromptTooLongError → 摘要步 + 重试成功"
    );
    // SC11:placeholder + attachment + DEFAULT_KEEP_RECENT kept + 1 retry assistant。
    assert.equal(
      result.messages.length,
      1 + 1 + DEFAULT_KEEP_RECENT + 1,
      `expected 1 placeholder + 1 attachment + ${DEFAULT_KEEP_RECENT} kept + 1 assistant = ${
        1 + 1 + DEFAULT_KEEP_RECENT + 1
      }, got ${result.messages.length}`
    );
    assert.deepStrictEqual(result.messages[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });
    assert.deepStrictEqual(result.messages[1], {
      role: "user",
      content: [{ type: "text", text: "focus@now\n---\nhist1" }],
    });
    // 收尾为 retry 成功的 assistant 文本。
    const finalText = result.finalText;
    assert.ok(
      finalText !== null && finalText.includes("done after compact"),
      `final text must contain retry output, got ${finalText}`
    );
  });

  // -- #467 step 2:proactive compact → LLM 摘要成功注入 -------------------------

  it("proactive compact → 摘要成功 → messages[0] 为 SUMMARY_PREAMBLE + 摘要内容,attachment 紧随", async () => {
    // 12 条 prior:proactive 阈值拉低(1000)让首轮即触发 compact。adapter 在
    // compact 摘要步(tools === undefined)返回结构化摘要;其余按脚本消费。
    const longPrior = Array.from({ length: 12 }, (_, i) =>
      text(`prior-${i} ${"z".repeat(20)}`)
    );
    const adapter = makeCompactSummaryAdapter({
      responses: buildResponses(TURNS),
    });
    const { result } = await run(
      "hello",
      {
        adapter,
        executor,
        registry,
        maxTurns: TURNS + 1,
        compress: { contextWindow: 200_000, thresholdTokens: 1000 },
        boundaryAttachment: () => "focus@now\n---\nhist1",
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    // 摘要轮确实跑了 ≥1 次(runFullCompact summarized 分支多次级联触发,
    // lastCompactTurn 锚点不抑制 cascade)。该断言钉住"摘要成功路径被真实接通",
    // 旧 placeholder 路径仅 fallback 会跑 0 次。
    assert.ok(
      adapter.compactSteps.value >= 1,
      "摘要轮至少 1 次,否则 LLM 摘要成功路径未被触发"
    );

    // messages[0] = SUMMARY_PREAMBLE + 摘要内容(LLM 摘要成功路径)。
    assert.ok(
      isSummaryMessage(result.messages[0]!),
      "messages[0] 必须是 LLM 摘要轮 user 消息"
    );
    const firstText = textOf(result.messages[0]!);
    assert.ok(
      firstText.includes("SUMMARY-OVER-DROPPED"),
      "摘要内容进入 messages[0]"
    );
    // messages[1] = boundaryAttachment 渲染文本(与 fallback 路径几何一致)。
    assert.deepStrictEqual(result.messages[1], {
      role: "user",
      content: [{ type: "text", text: "focus@now\n---\nhist1" }],
    });
    // 保留尾部:最终 assistant 收尾仍在。
    assertCompletionTail(result.messages);
  });
});

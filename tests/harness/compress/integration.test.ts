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
  estimateMessagesTokens,
} from "../../../src/harness/compress/index.ts";
import type { AnthropicContentBlock } from "../../../src/harness/model-adapter/types.ts";

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
    // 压缩发生:边界占位符出现。
    const serialized = JSON.stringify(result.messages);
    assert.ok(
      serialized.includes(COMPACTION_BOUNDARY_PLACEHOLDER),
      "低阈值 + 长对话必须触发压缩"
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
    // 占位符出现次数 = 压缩次数(每次 compact 插入一条边界消息)。
    const placeholderCount = result.messages.filter((m) =>
      m.content.some(
        (b): b is { type: "text"; text: string } =>
          b.type === "text" && b.text === COMPACTION_BOUNDARY_PLACEHOLDER
      )
    ).length;
    assert.ok(placeholderCount >= 1, "至少触发一次压缩");
    assert.ok(
      placeholderCount <= Math.floor(TURNS / 2),
      `压缩次数 ${placeholderCount} 应 ≤ ${Math.floor(TURNS / 2)}(turnCount 锚点守约)`
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
      JSON.stringify(small.result.messages).includes(
        COMPACTION_BOUNDARY_PLACEHOLDER
      ),
      "极小 contextWindow + 缺省阈值必须触发压缩"
    );

    // (c) 语义自检:estimate + 缺省阈值关系(纯函数,不依赖 LLM)。
    // 极小 window 的缺省阈值 window-33000 < 0,estimateMessagesTokens ≥ 1 恒 ≥ 阈值。
    const probe = estimateMessagesTokens([
      { role: "user", content: [{ type: "text", text: "x" }] },
    ]);
    assert.ok(probe >= 1);
  });
});

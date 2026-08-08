/**
 * #119 T7 / plan T3: proactive + reactive 双保险共存测试。
 *
 * Q3 决议(proactive 估算触发)+ ADR-0013(reactive PromptTooLongError 触发)
 * 是双保险:共用 `compactMessages`,无阈值/优先级冲突。本文件聚焦"共存"
 * 语义,单侧功能(proactive 估算 / reactive 重试)分别由 index.test.ts 与
 * loop-engine.test.ts 覆盖,这里只断言三者的关系:
 *   a. proactive(估算触发)独立工作,不因 reactive 存在受影响;
 *   b. reactive(错误触发)独立工作,不因 proactive 存在受影响 ——
 *      高阈值阻断估算触发后,reactive 仍能压缩并重试成功(无阈值冲突);
 *   c. 两条路径复用同一个 `compactMessages`,产物形状一致(边界占位 +
 *      尾部 DEFAULT_KEEP_RECENT 条)。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  shouldAutoCompact,
  compactMessages,
  estimateMessagesTokens,
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
} from "../../../src/harness/compress/index.ts";
import { PromptTooLongError } from "../../../src/harness/errors.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";

const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

/**
 * Reactive 路径走通所需的最小 flaky adapter:
 *   - encodeUserText:与 stub-model 同形,把 prompt 编码为 native message;
 *   - encodeToolResults:空返回(无工具触发);
 *   - step:第一次抛 PromptTooLongError,第二次返回成功收尾,模拟
 *     "压缩前模型拒绝 → reactive 触发压缩 → 压缩后模型接受"。
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
      _request: unknown
    ): Promise<AssistantTurnResult> => {
      opts.attemptCount.value += 1;
      if (opts.attemptCount.value === 1) {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      return assistantResult({
        texts: [opts.retryText],
        toolCalls: [],
        supplierStop: "success",
      });
    },
  });
}

describe("compress 双保险共存 (proactive + reactive, ADR-0013)", () => {
  it("proactive 独立:估算触发不依赖 reactive 路径,压缩走 compactMessages", () => {
    // 估算足以越过阈值 → proactive 触发,不经 PromptTooLongError 也不经
    // reactive 入口。reactive 是否实现/装配都不改变 shouldAutoCompact 判定。
    const messages = Array.from({ length: 200 }, () =>
      text("a".repeat(40))
    );
    const estimate = estimateMessagesTokens(messages);
    assert.ok(estimate > 0);

    // 阈值 = estimate → 触发;threshold = estimate + 1 → 不触发。纯函数语义,
    // 与 reactive 入口存在与否完全解耦。
    assert.equal(
      shouldAutoCompact(messages, {
        contextWindow: 200_000,
        threshold: estimate,
      }),
      true
    );
    assert.equal(
      shouldAutoCompact(messages, {
        contextWindow: 200_000,
        threshold: estimate + 1,
      }),
      false
    );

    // proactive 触发的压缩产物 = 边界占位 + DEFAULT_KEEP_RECENT 尾部,
    // 结构与 compactMessages 直调结果一致,证明 proactive 路径复用同一函数。
    const compressed = compactMessages(messages);
    assert.notStrictEqual(compressed, messages);
    assert.deepStrictEqual(compressed[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });
    // 尾部恰好为 DEFAULT_KEEP_RECENT 条 + 1 占位;无 tool pair 扩展。
    assert.equal(compressed.length, 1 + DEFAULT_KEEP_RECENT);
    // 尾部最后一条与原始尾部最后一条完全一致(immutable tail preservation)。
    assert.deepStrictEqual(
      compressed[compressed.length - 1],
      messages[messages.length - 1]
    );
  });

  it("reactive 独立:proactive 阈值拉高(估算不触发)仍能压缩并重试成功", async () => {
    // 装配 12 条小 prior → estimate 远小于阈值 → proactive 估算触发不成立,
    // 此时唯一的压缩触发源只能是 reactive 错误路径(无阈值冲突)。
    const longPrior = Array.from({ length: 12 }, (_, i) =>
      text(`prior-${i}`)
    );
    const withQ: AnthropicNativeMessage[] = [
      ...longPrior,
      { role: "user", content: [{ type: "text", text: "Q" }] },
    ];
    const proactiveWouldFire = shouldAutoCompact(withQ, {
      contextWindow: 200_000,
      threshold: 10_000,
    });
    assert.equal(
      proactiveWouldFire,
      false,
      "前置断言:proactive 阈值 10000 >> estimate,估算触发不成立"
    );

    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const attemptCount = { value: 0 };
    const adapter = makeFlakyAdapter({
      retryText: "done after compact",
      attemptCount,
    });

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );

    // reactive 独立工作:1 throw → 压缩 → 重试 → 成功。
    assert.equal(result.stopReason, "completed");
    assert.equal(attemptCount.value, 2, "首次抛 PromptTooLongError,重试一次成功");
    // 压缩产物:边界占位 + DEFAULT_KEEP_RECENT 尾部 + 收尾 assistant。
    assert.equal(
      result.messages.length,
      1 + DEFAULT_KEEP_RECENT + 1,
      `expected reactive-compressed length 8, got ${result.messages.length}`
    );
    assert.deepStrictEqual(result.messages[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });
    assert.equal(result.finalText, "done after compact");
  });

  it("共用 compactMessages:proactive 与 reactive 压缩产物结构一致,无双叉逻辑", async () => {
    // 同一模块、同一函数:两条路径(shouldAutoCompact → compactMessages /
    // PromptTooLongError → compactMessages)的产物结构契约相同。
    // 这里在 proactive 侧直调 compactMessages,在 reactive 侧经 loop-engine
    // run 触发,断言两者的"压缩段"逐消息 deepEqual。
    const longPrior = Array.from({ length: 12 }, (_, i) =>
      text(`prior-${i}`)
    );
    const encodedQ: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "Q" }],
    };
    const preRunMessages: ReadonlyArray<AnthropicNativeMessage> = [
      ...longPrior,
      encodedQ,
    ];

    // proactive 侧预期压缩:compactMessages(preRunMessages) → 7 条
    // (边界占位 + DEFAULT_KEEP_RECENT 尾部;无 tool pair 扩展)。
    const proactiveCompact = compactMessages(preRunMessages);
    assert.equal(proactiveCompact.length, 1 + DEFAULT_KEEP_RECENT);
    assert.deepStrictEqual(proactiveCompact[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });

    // reactive 侧:同样的 12 条 prior + "Q",走 run 触发 PromptTooLongError 兜底。
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const attemptCount = { value: 0 };
    const adapter = makeFlakyAdapter({
      retryText: "ok",
      attemptCount,
    });
    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );

    // reactive 压缩段 = result.messages.slice(0, 1 + DEFAULT_KEEP_RECENT),
    // 应与 proactive 直调的 compactMessages 产物 deepEqual —— 双路径共用
    // 同一压缩函数,无双叉阈值与逻辑。
    const reactiveCompact = result.messages.slice(
      0,
      1 + DEFAULT_KEEP_RECENT
    );
    assert.deepStrictEqual(
      reactiveCompact,
      proactiveCompact,
      "proactive 与 reactive 压缩段必须 deepEqual(共用 compactMessages)"
    );
    // 最后一条为 retry 成功的 assistant 收尾,与压缩段独立。
    assert.equal(result.messages[result.messages.length - 1]?.role, "assistant");
  });
});

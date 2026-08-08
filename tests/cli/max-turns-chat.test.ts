/**
 * tests/cli/max-turns-chat.test.ts
 *
 * plan T6: chat REPL 适配 MaxTurnsExceeded throw + stop_summary 呈现。
 *
 * 场景:maxTurns=1 + scripted 两轮(tool-call 用掉第 1 轮 → 第 2 轮 step 入口
 * throw MaxTurnsExceeded)+ 摘要 epilogue 响应(摘要轮不计 maxTurns,但 stub
 * 会多调一次 adapter.step,故 script 必须提供足够多响应)。
 *
 * 断言:
 *   - processChatLine 返回 quit:false(REPL 继续,不退出);
 *   - stderr 含 "已达 maxTurns=1 轮上限";
 *   - output 含收尾摘要文本(stop_summary 经 onStream wrapper 捕获);
 *   - ctx.state.messages 未被替换(throw 路径不 append 任何 assistant 消息);
 *   - stop_summary 事件不向宿主 onStream 透传(避免预览 sink 双打印)。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { processChatLine } from "../../src/cli/chat-session.ts";
import type { ChatLineContext } from "../../src/cli/chat-session.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { assistantResult, makeState } from "./_fixtures.ts";
import type { HarnessStreamEvent } from "../../src/harness/index.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";

/** 构造 maxTurns=1 的 deps,executor 含 noop 工具,adapter 用 stub。 */
function makeMaxTurnsDeps(
  responses: Parameters<typeof createStubModel>[0]["responses"]
): LoopEngineDeps {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  const adapter = createStubModel({ responses });
  return { adapter, executor, registry, maxTurns: 1 };
}

function makeCtx(deps: LoopEngineDeps): ChatLineContext {
  return { deps, state: makeState() };
}

describe("processChatLine maxTurns (plan T6)", () => {
  it("maxTurns 超限 → stderr 通知 + output 收尾摘要 + quit:false + 不透传 stop_summary", async () => {
    const deps = makeMaxTurnsDeps([
      // 第 1 轮:tool-call,用掉预算 maxTurns=1 → 第 2 轮 step 入口 throw。
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
      }),
      // 第 2 轮:摘要 epilogue 的模型响应(loop-engine 在重抛前调
      // tryRunSummary,stub 会消费这条响应;摘要轮不计 maxTurns)。
      assistantResult({ texts: ["收尾摘要文本：已达上限"], toolCalls: [] }),
    ]);
    const ctx = makeCtx(deps);
    const received: HarnessStreamEvent[] = [];
    const r = await processChatLine({
      line: "do it",
      ctx,
      onStream: (e) => received.push(e),
    });
    assert.equal(r.quit, false);
    assert.equal(r.ranQuery, true);
    assert.match(r.stderr ?? "", /已达 maxTurns=1 轮上限/);
    assert.ok(r.output.includes("收尾摘要："), `output=${r.output}`);
    assert.ok(r.output.includes("收尾摘要文本：已达上限"));
    // 摘要事件未被透传给宿主 onStream(stop_summary 只进 output,不双打印)
    assert.ok(
      !received.some((e) => e.type === "stop_summary"),
      "stop_summary 不得透传给宿主回调"
    );
    // throw 路径不 append 消息(state.messages 保持初始空)
    assert.equal(ctx.state.messages.length, 0);
  });

  it("摘要缺失(epilogue 失败 / stub 响应耗尽)→ output 空、stderr 仍通知", async () => {
    // 只 script 1 轮 tool-call:摘要 epilogue 时 stub 响应耗尽 → tryRunSummary
    // catch-all 吞掉 → 无 stop_summary。
    const deps = makeMaxTurnsDeps([
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
      }),
    ]);
    const ctx = makeCtx(deps);
    const r = await processChatLine({ line: "do it", ctx });
    assert.equal(r.quit, false);
    assert.match(r.stderr ?? "", /已达 maxTurns=1 轮上限/);
    assert.equal(r.output, "", "摘要缺失时 output 应为空(无空头)");
  });
});

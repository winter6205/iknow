/**
 * tests/cli/max-turns-chat.test.ts
 *
 * Chat REPL adaptation to the MaxTurnsExceeded throw + stop_summary presentation.
 *
 * Scenario: maxTurns=1 + scripted two rounds (the tool-call uses round 1 → the
 * round-2 step entry throws MaxTurnsExceeded) + a summary epilogue response
 * (summary rounds don't count toward maxTurns, but the stub still calls
 * adapter.step one extra time, so the script must provide enough responses).
 *
 * Assertions:
 *   - processChatLine returns quit:false (the REPL continues, no exit);
 *   - stderr contains `已达 maxTurns=1 轮上限` ("reached the maxTurns=1 round limit");
 *   - output contains the closing summary text (stop_summary captured via the onStream wrapper);
 *   - ctx.state.messages is not replaced (the throw path appends no assistant message);
 *   - stop_summary events are not forwarded to the host onStream (avoids double-print in the preview sink).
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

/** Build deps with maxTurns=1; the executor has a noop tool, the adapter is a stub. */
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
      // Round 1: tool-call, consuming the maxTurns=1 budget → round-2 step entry throws.
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
      }),
      // Round 2: the summary epilogue's model response (loop-engine calls
      // tryRunSummary before rethrowing and the stub consumes this response;
      // summary rounds don't count toward maxTurns).
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
    // The summary event is not forwarded to the host onStream (stop_summary only reaches output, no double-print)
    assert.ok(
      !received.some((e) => e.type === "stop_summary"),
      "stop_summary 不得透传给宿主回调"
    );
    // The throw path appends no messages (state.messages stays initially empty)
    assert.equal(ctx.state.messages.length, 0);
  });

  it("摘要缺失(epilogue 失败 / stub 响应耗尽)→ output 空、stderr 仍通知", async () => {
    // Only round 1 (tool-call) is scripted: when the summary epilogue runs, the
    // stub is out of responses → tryRunSummary's catch-all swallows it → no stop_summary.
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

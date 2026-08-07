/**
 * #224 W5（S8 / D10）：discovered set 全链路 stub-model 集成测试。
 *
 * 核心交付验证：模型用 tool_search 检索一个 lazy 工具，从下一轮起该工具
 * 进入 adapter.step 的 request.tools（经 promptTools=reg.visibleSchemas 消费
 * discovered set），并可被成功调用。
 *
 * 装配（D10）：真 executor 链路 ——
 *   reg = createAciRegistry([tool_search, fake_nonlazy, fake_lazy])
 *   executor = createExecutor(reg.inner)
 *   stub-model responses = [turn1 tool_use(tool_search, names:["fake_lazy"]),
 *                           turn2 tool_use(fake_lazy),
 *                           turn3 final text]
 *   deps.promptTools = reg.visibleSchemas
 *
 * 断言：turn1 的 request.tools 不含 fake_lazy schema；turn2/3 的
 * request.tools 含 fake_lazy schema（discovered set 流动生效）；fake_lazy
 * 被真正调用；最终 stopReason === "completed"。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { run } from "../../../src/harness/loop-engine.ts";
import type {
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopEngineDeps } from "../../../src/harness/loop-engine.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";
import type { AciRegistry } from "../../../src/harness/aci/aci-registry.ts";
import { createAciRegistry } from "../../../src/harness/aci/aci-registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createToolSearchTool } from "../../../src/harness/aci/tools/tool-search.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { assistantResult } from "../../cli/_fixtures.ts";

/** 构造一个 ACI 假工具（非 lazy 或 lazy）。 */
function makeFake(name: string, lazy: boolean, ret: string): AciToolDef {
  return Object.freeze({
    name,
    description: `test fake tool ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: () => ret,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      ...(lazy ? { lazy: true } : {}),
    },
  });
}

describe("#224 S8: discovered set 全链路 stub-model", () => {
  it("tool_search 检索 lazy 工具 → 下一轮起 tools[] 含该工具 schema 且可调用", async () => {
    // a. fixtures
    const holder: { reg?: AciRegistry } = {};
    const toolSearch = createToolSearchTool({
      getRegistry: () => holder.reg!,
    });
    const fakeNonLazy = makeFake("fake_nonlazy", false, "ok-nl");
    let lazyCalled = false;
    const fakeLazy: AciToolDef = Object.freeze({
      name: "fake_lazy",
      description: "test fake lazy tool",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => {
        lazyCalled = true;
        return "ok-lz";
      },
      aci: {
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "fast" as const,
        lazy: true,
      },
    });
    const tools: AciToolDef[] = [toolSearch, fakeNonLazy, fakeLazy];
    const reg = createAciRegistry(tools);
    holder.reg = reg;

    // b. engine deps（真 executor + spy adapter 捕获 request.tools）
    const executor = createExecutor(reg.inner);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "d1", name: "tool_search", input: { names: ["fake_lazy"] } },
          ],
        }),
        assistantResult({
          texts: [],
          toolCalls: [{ id: "d2", name: "fake_lazy", input: {} }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const capturedTools: unknown[] = [];
    const spyAdapter = Object.freeze({
      ...model,
      step: async (
        state: LoopState,
        request: { tools?: unknown; system?: string }
      ): Promise<AssistantTurnResult> => {
        capturedTools.push(request.tools);
        return model.step(state, request);
      },
    });
    const deps: LoopEngineDeps = {
      adapter: spyAdapter,
      executor,
      registry: reg.inner,
      promptTools: reg.visibleSchemas,
      maxTurns: 4,
    };

    // c/d. run
    const { result } = await run("go", deps);

    // e. assertions
    assert.equal(result.stopReason, "completed");

    const namesOf = (tools: unknown): string[] =>
      (tools as ReadonlyArray<{ name: string }>).map((t) => t.name);

    assert.equal(capturedTools.length, 3, "three model steps expected");
    // turn1：tool_search + fake_nonlazy 已进 prompt，lazy 未发现 → 不含 fake_lazy
    assert.deepEqual(namesOf(capturedTools[0]), [
      "tool_search",
      "fake_nonlazy",
    ]);
    // turn2：discovered set 已标记 fake_lazy → tools[] 含它（插在末尾）
    assert.deepEqual(namesOf(capturedTools[1]), [
      "tool_search",
      "fake_nonlazy",
      "fake_lazy",
    ]);
    // turn3：与 turn2 相同（discovered set 持续生效）
    assert.deepEqual(namesOf(capturedTools[2]), [
      "tool_search",
      "fake_nonlazy",
      "fake_lazy",
    ]);

    // fake_lazy 的 handler 被真正调用（非仅 schema 出现）
    assert.equal(lazyCalled, true);

    // 最终文本确定这条 tool_call 结果被模型消费
    assert.equal(result.finalText, "done");
  });
});

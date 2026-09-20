/**
 * Discovered-set full-chain stub-model integration test.
 *
 * Core delivery being verified: the model retrieves a lazy tool via
 * tool_search; from the next turn on that tool appears in adapter.step's
 * request.tools (the discovered set is consumed via
 * promptTools=reg.visibleSchemas), and it can be called successfully.
 *
 * Assembly: real executor chain —
 *   reg = createAciRegistry([tool_search, fake_nonlazy, fake_lazy])
 *   executor = createExecutor(reg.inner)
 *   stub-model responses = [turn1 tool_use(tool_search, names:["fake_lazy"]),
 *                           turn2 tool_use(fake_lazy),
 *                           turn3 final text]
 *   deps.promptTools = reg.visibleSchemas
 *
 * Assertions: turn1's request.tools lacks the fake_lazy schema;
 * turn2/3's request.tools contain it (the discovered set flows through);
 * fake_lazy is actually invoked; final stopReason === "completed".
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

/** Build an ACI fake tool (non-lazy or lazy). */
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

    // b. engine deps (real executor + spy adapter capturing request.tools)
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
    // turn1: tool_search + fake_nonlazy are already in the prompt; the lazy
    // tool is undiscovered → fake_lazy absent
    assert.deepEqual(namesOf(capturedTools[0]), [
      "tool_search",
      "fake_nonlazy",
    ]);
    // turn2: the discovered set now marks fake_lazy → tools[] includes it (appended at the end)
    assert.deepEqual(namesOf(capturedTools[1]), [
      "tool_search",
      "fake_nonlazy",
      "fake_lazy",
    ]);
    // turn3: same as turn2 (discovered set persists)
    assert.deepEqual(namesOf(capturedTools[2]), [
      "tool_search",
      "fake_nonlazy",
      "fake_lazy",
    ]);

    // fake_lazy's handler was really invoked (not just its schema appearing)
    assert.equal(lazyCalled, true);

    // the final text proves the model consumed that tool_call result
    assert.equal(result.finalText, "done");
  });
});

/**
 * loop-engine loop detection: fuse stop reason, LOOP_DETECTED entry in
 * history, detection can be disabled.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { run } from "../../src/harness/loop-engine.ts";
import type { AssistantTurnResult } from "../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import { LOOP_DETECTED_TEXT } from "../../src/harness/tool-loop-detect.ts";

function failToolTurn(id: string): AssistantTurnResult {
  return assistantResult({
    texts: [],
    toolCalls: [{ id, name: "boom", input: { n: 1 } }],
  });
}

function repeatingFailModel(count: number) {
  const responses: AssistantTurnResult[] = [];
  for (let i = 0; i < count; i += 1) {
    responses.push(failToolTurn(`call_${i}`));
  }
  responses.push(
    assistantResult({
      texts: ["done"],
      toolCalls: [],
      supplierStop: "success",
    })
  );
  return createStubModel({ responses });
}

describe("loop engine tool-loop fuse", () => {
  it("R=5 same execution_failed → stopReason fused and LOOP_DETECTED in history", async () => {
    const boom = createStubTool({
      name: "boom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { n: { type: "number" } },
        required: ["n"],
      },
      next: () => {
        throw new Error("same boom");
      },
    });
    const registry = createRegistry([boom]);
    const executor = createExecutor(registry);
    const { result } = await run("go", {
      adapter: repeatingFailModel(8),
      executor,
      registry,
      maxTurns: 20,
    });
    assert.equal(result.stopReason, "fused");
    const texts = result.messages.flatMap((m) =>
      m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
    );
    assert.ok(
      texts.some((t) => t.includes("LOOP_DETECTED")),
      texts.join("\n")
    );
    assert.ok(texts.some((t) => t.includes(LOOP_DETECTED_TEXT)));
  });

  it("detectToolLoop false → does not fuse at R=5", async () => {
    const boom = createStubTool({
      name: "boom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { n: { type: "number" } },
        required: ["n"],
      },
      next: () => {
        throw new Error("same boom");
      },
    });
    const registry = createRegistry([boom]);
    const executor = createExecutor(registry);
    const { result } = await run("go", {
      adapter: repeatingFailModel(5),
      executor,
      registry,
      maxTurns: 20,
      detectToolLoop: false,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.finalText, "done");
  });

  it("next run(priorMessages) still contains LOOP_DETECTED envelope", async () => {
    const boom = createStubTool({
      name: "boom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { n: { type: "number" } },
        required: ["n"],
      },
      next: () => {
        throw new Error("same boom");
      },
    });
    const registry = createRegistry([boom]);
    const executor = createExecutor(registry);
    const first = await run("go", {
      adapter: repeatingFailModel(8),
      executor,
      registry,
      maxTurns: 20,
    });
    assert.equal(first.result.stopReason, "fused");
    const echo = createStubTool({
      name: "noop",
      next: () => ({}),
    });
    const registry2 = createRegistry([echo]);
    const second = await run(
      "continue",
      {
        adapter: createStubModel({
          responses: [
            assistantResult({
              texts: ["ack"],
              toolCalls: [],
              supplierStop: "success",
            }),
          ],
        }),
        executor: createExecutor(registry2),
        registry: registry2,
        maxTurns: 5,
      },
      undefined,
      { priorMessages: first.result.messages }
    );
    const blob = JSON.stringify(second.result.messages);
    assert.match(blob, /LOOP_DETECTED/);
    assert.equal(second.result.stopReason, "completed");
  });
});

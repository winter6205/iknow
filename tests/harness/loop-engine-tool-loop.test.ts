/**
 * loop-engine loop detection: fuse stop reason, LOOP_DETECTED entry in
 * history, detection can be disabled.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/harness/loop-engine.ts";
import type { AssistantTurnResult } from "../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import { createTodoWriteTool } from "../../src/harness/aci/tools/todo-write.ts";
import {
  LOOP_DETECT_REPEAT,
  LOOP_DETECTED_TEXT,
  VALIDATION_LOOP_DETECTED_TEXT,
} from "../../src/harness/tool-loop-detect.ts";

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

// ---------------------------------------------------------------------------
// Narrow validation-stall fuse integration: a stub model repeating
// ONE invalid todo_write call must be stopped by the validation fuse on the
// third phase, strictly earlier than the generic R=5 path, and the generic
// detector must keep its existing behavior for everything else.
// ---------------------------------------------------------------------------

function todoWriteCall(id: string, input: Record<string, unknown>) {
  return assistantResult({
    texts: [],
    toolCalls: [{ id, name: "todo_write", input }],
  });
}

function repeatingTodoWriteModel(
  input: Record<string, unknown>,
  count: number
) {
  const responses: AssistantTurnResult[] = [];
  for (let i = 0; i < count; i += 1) {
    responses.push(todoWriteCall(`tw_${i}`, input));
  }
  responses.push(
    assistantResult({ texts: ["done"], toolCalls: [], supplierStop: "success" })
  );
  return createStubModel({ responses });
}

function textsOf(result: {
  messages: ReadonlyArray<AnthropicNativeMessageLike>;
}): string[] {
  return result.messages.flatMap((m) =>
    m.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
  );
}

type AnthropicNativeMessageLike = {
  role: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
};

describe("narrow validation-stall fuse (todo_write)", () => {
  async function withTodoDir(fn: (todoDir: string) => Promise<void>) {
    const todoDir = await mkdtemp(join(tmpdir(), "loop-val-fuse-"));
    try {
      await fn(todoDir);
    } finally {
      await rm(todoDir, { recursive: true, force: true });
    }
  }

  it("same invalid todo_write ×3 → fused on the 3rd phase, before generic R=5", async () => {
    await withTodoDir(async (todoDir) => {
      const tool = createTodoWriteTool({ todoDir });
      const registry = createRegistry([tool]);
      const executor = createExecutor(registry);
      const { result } = await run("go", {
        adapter: repeatingTodoWriteModel(
          { mode: "update", id: "t9", item: "x" },
          LOOP_DETECT_REPEAT + 3
        ),
        executor,
        registry,
        maxTurns: 20,
      });
      assert.equal(result.stopReason, "fused");
      const texts = textsOf(result);
      assert.ok(
        texts.includes(VALIDATION_LOOP_DETECTED_TEXT),
        `validation envelope missing:\n${texts.join("\n")}`
      );
      // The stamp is the flag a differentiated host-injection UI identity keys on.
      const envelope = result.messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) =>
              b.type === "text" &&
              b.text.includes(VALIDATION_LOOP_DETECTED_TEXT)
          )
      );
      assert.ok(envelope !== undefined);
      assert.equal((envelope as { hostInjected?: true }).hostInjected, true);
      // Generic R=5 never answered: its text must not be in history.
      assert.ok(!texts.some((t) => t.includes(LOOP_DETECTED_TEXT)));
      // Exactly three assistant tool_use turns ran (third tripped the fuse).
      const toolUseTurns = result.messages.filter((m) =>
        m.content.some((b) => b.type === "tool_use")
      ).length;
      assert.equal(toolUseTurns, 3);
      // The invalid calls never reached the handler: no ledger on disk.
      assert.deepEqual(await readdir(todoDir), []);
    });
  });

  it("varying invalid arguments keep looping past 3 without the narrow fuse", async () => {
    await withTodoDir(async (todoDir) => {
      const tool = createTodoWriteTool({ todoDir });
      const registry = createRegistry([tool]);
      const executor = createExecutor(registry);
      const responses: AssistantTurnResult[] = [5, 6, 7, 8, 9].map((n) =>
        todoWriteCall(`tw_${n}`, { mode: "update", id: `t${n}`, item: "x" })
      );
      responses.push(
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        })
      );
      const { result } = await run("go", {
        adapter: createStubModel({ responses }),
        executor,
        registry,
        maxTurns: 20,
      });
      assert.equal(result.stopReason, "completed");
      assert.equal(result.finalText, "done");
    });
  });

  it("generic detector regression: identical execution_failed still needs R=5 and keeps LOOP_DETECTED_TEXT", async () => {
    await withTodoDir(async (todoDir) => {
      const tool = createTodoWriteTool({ todoDir });
      const registry = createRegistry([tool]);
      const executor = createExecutor(registry);
      const { result } = await run("go", {
        adapter: repeatingTodoWriteModel(
          { mode: "update", id: "t9", status: "completed" },
          LOOP_DETECT_REPEAT + 3
        ),
        executor,
        registry,
        maxTurns: 20,
      });
      assert.equal(result.stopReason, "fused");
      const texts = textsOf(result);
      assert.ok(texts.some((t) => t.includes(LOOP_DETECTED_TEXT)));
      assert.ok(!texts.includes(VALIDATION_LOOP_DETECTED_TEXT));
      const toolUseTurns = result.messages.filter((m) =>
        m.content.some((b) => b.type === "tool_use")
      ).length;
      assert.equal(toolUseTurns, LOOP_DETECT_REPEAT);
    });
  });
});

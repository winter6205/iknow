/**
 * Output-limit (supplier `max_tokens`) stop behavior in the Loop Engine.
 *
 * A truncated generation is terminal: no tool from that response runs, no
 * retry / continuation / closing-summary model call follows it. The stop
 * settles as `nonSuccessStop` with the normalized supplier-stop detail
 * `truncation`. Other abnormal stops keep their closing summary.
 *
 * The model is stubbed at the adapter boundary; the executor, registry, and
 * loop engine stay real (`.codex/rules/test.md`).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  run,
  type LoopAdapter,
  type LoopEngineDeps,
} from "../../src/harness/loop-engine.ts";
import { runWorkerOnce } from "../../src/harness/subagent/worker.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import type {
  ToolDef,
  ToolExecutionResult,
} from "../../src/harness/tools/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";

/** A counting wrapper at the adapter boundary: one `step` = one model call. */
function countingAdapter(
  inner: LoopAdapter,
  calls: number[] = []
): LoopAdapter & { readonly calls: number[] } {
  return Object.freeze({
    calls,
    streamMode: inner.streamMode,
    encodeUserText: (text: string) => inner.encodeUserText(text),
    encodeToolResults: (results: ReadonlyArray<ToolExecutionResult>) =>
      inner.encodeToolResults(results),
    async step(
      state: LoopState,
      request: {
        tools?: unknown;
        system?: string;
        onStream?: (event: HarnessStreamEvent) => void;
      },
      signal?: AbortSignal
    ): Promise<AssistantTurnResult> {
      calls.push(1);
      return inner.step(state, request, signal);
    },
  });
}

/** A real echo tool plus the number of times its handler actually ran. */
function countingEchoTool(): { tool: ToolDef; ran: number[] } {
  const ran: number[] = [];
  const tool = createStubTool({
    name: "echo",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    next: (input: unknown) => {
      ran.push(1);
      return input;
    },
  });
  return { tool, ran };
}

/** The tool-call-bearing truncation that ends the generation. */
function truncatedWithToolUse(): AssistantTurnResult {
  return assistantResult({
    texts: ["partial answer cut off"],
    toolCalls: [
      { id: "toolu_a", name: "echo", input: { value: "ping" } },
      { id: "toolu_b", name: "echo", input: { value: "pong" } },
    ],
    supplierStop: "truncation",
  });
}

function truncatedPlainText(): AssistantTurnResult {
  return assistantResult({
    texts: ["partial answer cut off"],
    toolCalls: [],
    supplierStop: "truncation",
  });
}

describe("output-limit stop SC6: the generation ends without tools or retries", () => {
  it("truncated response with tool_use executes no tool at all", async () => {
    const { tool, ran } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = countingAdapter(
      createStubModel({ responses: [truncatedWithToolUse()] })
    );

    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });

    assert.equal(result.stopReason, "nonSuccessStop");
    assert.deepEqual(ran, [], "the truncated response must not run any tool");
  });

  it("issues exactly one model call for the truncated generation", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = countingAdapter(
      createStubModel({ responses: [truncatedWithToolUse()] })
    );

    await run("go", { adapter, executor: exec, registry: reg, maxTurns: 5 });

    assert.equal(
      adapter.calls.length,
      1,
      "no continuation call may follow the truncated generation"
    );
  });

  it("plain-text truncation also settles after exactly one model call", async () => {
    const { tool, ran } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = countingAdapter(
      createStubModel({ responses: [truncatedPlainText()] })
    );

    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });

    assert.equal(result.stopReason, "nonSuccessStop");
    assert.equal(adapter.calls.length, 1);
    assert.deepEqual(ran, []);
  });

  it("settles as nonSuccessStop with the normalized detail truncation", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = countingAdapter(
      createStubModel({ responses: [truncatedWithToolUse()] })
    );

    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });

    assert.equal(result.stopReason, "nonSuccessStop");
    assert.equal(
      (result as { supplierDetail?: string }).supplierDetail,
      "truncation"
    );
  });

  it("carries no apiError and no transport-retry event (a truncation is not a fault)", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = countingAdapter(
      createStubModel({ responses: [truncatedWithToolUse()] })
    );
    const events: HarnessStreamEvent[] = [];

    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (event) => events.push(event) }
    );

    assert.equal(result.apiError, undefined);
    const retryish = events.filter(
      (e) => (e as { type: string }).type === "transport_retry"
    );
    assert.deepEqual(
      retryish,
      [],
      "transport retry must not fire on truncation"
    );
  });

  it("keeps the truncated assistant text committed and finalText null", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = countingAdapter(
      createStubModel({ responses: [truncatedWithToolUse()] })
    );

    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });

    assert.equal(result.finalText, null);
    const assistant = result.messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "the native assistant message stays in history");
    assert.equal(
      assistant!.content.filter((b) => b.type === "tool_use").length,
      2,
      "the native tool_use blocks are preserved verbatim"
    );
  });
});

describe("output-limit stop SC10: no closing summary for truncation", () => {
  it("emits no stop_summary and makes no summary call for truncation", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = countingAdapter(
      createStubModel({
        responses: [
          truncatedPlainText(),
          assistantResult({
            texts: ["summary that must never be requested"],
            toolCalls: [],
            supplierStop: "success",
          }),
        ],
      })
    );
    const events: HarnessStreamEvent[] = [];

    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (event) => events.push(event) }
    );

    assert.equal(result.stopReason, "nonSuccessStop");
    assert.equal(
      adapter.calls.length,
      1,
      "the summary round must not be called"
    );
    assert.equal(
      events.filter((e) => e.type === "stop_summary").length,
      0,
      "truncation must not emit stop_summary"
    );
  });

  it("emits no stop_summary for a truncation that carried tool_use blocks", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = countingAdapter(
      createStubModel({
        responses: [
          truncatedWithToolUse(),
          assistantResult({
            texts: ["summary that must never be requested"],
            toolCalls: [],
            supplierStop: "success",
          }),
        ],
      })
    );
    const events: HarnessStreamEvent[] = [];

    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (event) => events.push(event) }
    );

    assert.equal(result.stopReason, "nonSuccessStop");
    assert.equal(adapter.calls.length, 1);
    assert.equal(events.filter((e) => e.type === "stop_summary").length, 0);
  });

  it("refusal still settles nonSuccessStop WITH its closing summary (detail-scoped exemption)", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = countingAdapter(
      createStubModel({
        responses: [
          assistantResult({
            texts: ["cannot help with that"],
            toolCalls: [],
            supplierStop: "refusal",
          }),
          assistantResult({
            texts: ["summary after refusal"],
            toolCalls: [],
            supplierStop: "success",
          }),
        ],
      })
    );
    const events: HarnessStreamEvent[] = [];

    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (event) => events.push(event) }
    );

    assert.equal(result.stopReason, "nonSuccessStop");
    assert.equal(
      (result as { supplierDetail?: string }).supplierDetail,
      "refusal"
    );
    assert.equal(adapter.calls.length, 2, "refusal keeps its summary round");
    const summary = events.find((e) => e.type === "stop_summary");
    assert.ok(summary, "refusal must still emit stop_summary");
  });

  it("other abnormal stops keep the summary (protocolError control)", async () => {
    const { ProtocolError } = await import("../../src/harness/errors.ts");
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    let calls = 0;
    const adapter: LoopAdapter = Object.freeze({
      encodeUserText: (text: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text }],
      }),
      encodeToolResults: (): AnthropicContentBlock[] => [],
      step: async (): Promise<AssistantTurnResult> => {
        calls += 1;
        if (calls === 1) {
          throw new ProtocolError("synthetic protocol error");
        }
        return assistantResult({
          texts: ["summary after protocol error"],
          toolCalls: [],
          supplierStop: "success",
        });
      },
    });
    const events: HarnessStreamEvent[] = [];

    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (event) => events.push(event) }
    );

    assert.equal(result.stopReason, "protocolError");
    assert.equal(calls, 2, "protocolError keeps its summary round");
    assert.equal(events.filter((e) => e.type === "stop_summary").length, 1);
  });
});

describe("output-limit stop SC10 worker path: runWorkerOnce makes no summary call", () => {
  const baseEnvelope: WorkerEnvelope = {
    task: "task that truncates",
    sandboxRoot: "/tmp/sb",
  };

  function workerDeps(adapter: LoopAdapter): LoopEngineDeps {
    return {
      adapter,
      executor: undefined as never,
      registry: { list: () => [], get: () => undefined },
      system: () => undefined,
      promptTools: () => [],
    } as unknown as LoopEngineDeps;
  }

  it("truncated worker turn settles failed with exactly one model call", async () => {
    const adapter = countingAdapter(
      createStubModel({
        responses: [
          truncatedPlainText(),
          assistantResult({
            texts: ["worker summary that must not be requested"],
            toolCalls: [],
            supplierStop: "success",
          }),
        ],
      })
    );

    const envelope = await runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: workerDeps(adapter),
    });

    assert.equal(envelope.status, "failed");
    assert.equal(adapter.calls.length, 1, "no closing summary for truncation");
  });
});

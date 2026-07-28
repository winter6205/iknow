/**
 * T5–T10 Loop Engine fixture matrix S1–S11。
 * 017 T5 续段 S12–S17(signal / timeout / trace 守门)。
 *
 * 每条 fixture 一次确定性 run,行为由 stub-model + stub-tool 驱动。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { run, step } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import type { ToolDef } from "../../src/harness/tools/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createStubSignalTool } from "../../src/harness/stubs/stub-signal-tool.ts";

function makeNative(
  role: "user" | "assistant",
  text: string
): AnthropicNativeMessage {
  return { role, content: [{ type: "text", text }] };
}

function assistantResult(
  texts: string[],
  toolCalls: Array<{ id: string; name: string; input: unknown }> = [],
  supplierStop: "success" | "truncation" | "refusal" | "other" = "success"
): AssistantTurnResult {
  const blocks: AnthropicNativeMessage["content"] = [];
  for (const t of texts) blocks.push({ type: "text", text: t });
  for (const c of toolCalls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  const native: AnthropicNativeMessage = { role: "assistant", content: blocks };
  return {
    nativeMessage: native,
    projection: {
      nativeMessage: native,
      texts,
      toolCalls,
    },
    supplierStop,
    needsTools: toolCalls.length > 0,
    isEmptyFinalResponse:
      supplierStop === "success" &&
      texts.length === 0 &&
      toolCalls.length === 0,
  };
}

describe("loop engine S1: pure-text completion", () => {
  it("returns completed + turnCount=1 + [user, assistant(text)]", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult(["hi there"], [], "success"),
    ]);
    const { result } = await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 1);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.messages[1]!.role, "assistant");
    assert.equal(result.finalText, "hi there");
  });
});

describe("loop engine S2: single tool call closure", () => {
  it("emits 4 messages: user, assistant(tool_use), user(tool_result), assistant(text)", async () => {
    const echo = createStubTool({
      name: "echo",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      next: (input: unknown) => input,
    });
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult(
        [],
        [{ id: "t1", name: "echo", input: { value: "ping" } }]
      ),
      assistantResult(["done"], [], "success"),
    ]);
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 2);
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.messages[1]!.role, "assistant");
    assert.equal(result.messages[2]!.role, "user");
    assert.equal(result.messages[3]!.role, "assistant");
    // tool_result block carries matched identity
    const trBlocks = result.messages[2]!.content;
    assert.equal(trBlocks[0]!.type, "tool_result");
    assert.equal(
      (trBlocks[0] as { type: "tool_result"; tool_use_id: string }).tool_use_id,
      "t1"
    );
    assert.equal(result.finalText, "done");
  });
});

describe("loop engine S3: multi-tool-call serial", () => {
  it("executes N calls in order; N tool_use + N tool_result in single user msg", async () => {
    const echo = createStubTool({
      name: "echo",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      next: (input: unknown) => input,
    });
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult(
        [],
        [
          { id: "a", name: "echo", input: { value: "1" } },
          { id: "b", name: "echo", input: { value: "2" } },
          { id: "c", name: "echo", input: { value: "3" } },
        ]
      ),
      assistantResult(["done"], [], "success"),
    ]);
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.messages.length, 4);
    const assistantBlocks = result.messages[1]!.content;
    const toolUseIds = assistantBlocks
      .filter((b) => b.type === "tool_use")
      .map((b) => (b as { type: "tool_use"; id: string }).id);
    assert.deepEqual(toolUseIds, ["a", "b", "c"]);
    const resultBlocks = result.messages[2]!.content;
    const toolResultIds = resultBlocks
      .filter((b) => b.type === "tool_result")
      .map(
        (b) => (b as { type: "tool_result"; tool_use_id: string }).tool_use_id
      );
    assert.deepEqual(toolResultIds, ["a", "b", "c"]);
  });
});

describe("loop engine S4: tool failure surfaces in history", () => {
  it("failed tool call enters as is_error tool_result and model can recover", async () => {
    const strict = createStubTool({
      name: "strict",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { n: { type: "integer" } },
        required: ["n"],
      },
      next: () => ({ ok: true }),
    });
    const reg = createRegistry([strict]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult(
        [],
        [{ id: "f1", name: "strict", input: { n: "not-an-int" } }]
      ),
      assistantResult(["fixed"], [], "success"),
    ]);
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    const trBlock = result.messages[2]!.content[0]!;
    assert.equal(trBlock.type, "tool_result");
    const tr = trBlock as {
      type: "tool_result";
      is_error?: boolean;
      tool_use_id: string;
    };
    assert.equal(tr.is_error, true);
    assert.equal(tr.tool_use_id, "f1");
    assert.equal(result.finalText, "fixed");
  });
});

describe("loop engine S5: same-turn partial failure does not short-circuit", () => {
  it("3 calls, 2nd fails, 3rd still runs; 3 results all enter history", async () => {
    const echo = createStubTool({
      name: "echo",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      next: (input: unknown) => input,
    });
    const strict = createStubTool({
      name: "strict",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { n: { type: "integer" } },
        required: ["n"],
      },
      next: () => ({ ok: true }),
    });
    const reg = createRegistry([echo, strict]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult(
        [],
        [
          { id: "a", name: "echo", input: { value: "1" } },
          { id: "b", name: "strict", input: { n: "bad" } },
          { id: "c", name: "echo", input: { value: "3" } },
        ]
      ),
      assistantResult(["done"], [], "success"),
    ]);
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    const blocks = result.messages[2]!.content;
    assert.equal(blocks.length, 3);
    const r0 = blocks[0] as { type: "tool_result"; is_error?: boolean };
    const r1 = blocks[1] as { type: "tool_result"; is_error?: boolean };
    const r2 = blocks[2] as { type: "tool_result"; is_error?: boolean };
    assert.equal(r0.is_error, undefined);
    assert.equal(r1.is_error, true);
    assert.equal(r2.is_error, undefined);
  });
});

describe("loop engine S6: maxTurns hit", () => {
  it("loop stops at maxTurns, never invokes model again past the limit", async () => {
    const echo = createStubTool({
      name: "echo",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      next: (input: unknown) => input,
    });
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    // Each scripted response calls echo again -> infinite loop without cap.
    const infinite = Array.from({ length: 5 }, (_, i) =>
      assistantResult(
        [],
        [{ id: `t${i}`, name: "echo", input: { value: String(i) } }]
      )
    );
    const model = createStubModel(infinite);
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 3,
    });
    assert.equal(result.stopReason, "maxTurns");
    assert.equal(result.turnCount, 3);
  });
});

describe("loop engine S7: non-success stop (truncation/refusal)", () => {
  it("returns nonSuccessStop; finalText is null even if texts present", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult(["partial"], [], "truncation"),
    ]);
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "nonSuccessStop");
    assert.equal(result.finalText, null);
  });
});

describe("loop engine S8: empty final response", () => {
  it("returns emptyFinalResponse; assistant turn with no text/tool is not in history", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult([], [], "success"), // empty + isEmptyFinalResponse=true
    ]);
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "emptyFinalResponse");
    assert.equal(result.turnCount, 0);
    assert.equal(result.messages.length, 1); // only the user message
    assert.equal(result.messages[0]!.role, "user");
  });
});

describe("loop engine S9: protocol error turn", () => {
  it("ProtocolError surfaces as stopReason=protocolError; bad turn not appended; no tools executed", async () => {
    const { ProtocolError } = await import("../../src/harness/errors.ts");
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);

    // Executor spy: counts executeAll invocations and delegates to a real
    // executor. S9 严格要求:bad turn 不进历史,且不触发工具执行。
    let executorCallCount = 0;
    const realExec = createExecutor(reg);
    const executorSpy = Object.freeze({
      executeAll: async (
        calls: Parameters<typeof realExec.executeAll>[0]
      ): ReturnType<typeof realExec.executeAll> => {
        executorCallCount++;
        return realExec.executeAll(calls);
      },
    });

    // Adapter that throws ProtocolError on first step.
    const failingModel = Object.freeze({
      encodeUserText: (t: string) =>
        ({
          role: "user",
          content: [{ type: "text", text: t }],
        }) as AnthropicNativeMessage,
      encodeToolResults: (
        _rs: ReadonlyArray<unknown>
      ): ReturnType<typeof realExec.executeAll> extends never ? never : never =>
        // loop never reaches encode path on this model; signature only.
        undefined as never,
      step: async (
        _state: LoopState,
        _req: { tools?: unknown }
      ): Promise<AssistantTurnResult> => {
        throw new ProtocolError("synthetic protocol failure on first step");
      },
    });

    const { result } = await run("go", {
      adapter: failingModel,
      executor: executorSpy,
      registry: reg,
      maxTurns: 5,
    });

    assert.equal(result.stopReason, "protocolError");
    // Bad turn is NOT in history: only the initial user message remains.
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.turnCount, 0);
    assert.equal(result.finalText, null);
    // Executor was NEVER invoked on the bad-turn path.
    assert.equal(executorCallCount, 0);
  });
});

describe("loop engine S10: append-only immutable history", () => {
  it("messages array references never mutated in place; each step returns a new array", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([assistantResult(["hi"], [], "success")]);
    const { result } = await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    // Object.freeze at every level -> cannot mutate; run produced a frozen tree.
    assert.equal(Object.isFrozen(result.messages), true);
    for (const m of result.messages) {
      assert.equal(Object.isFrozen(m), true);
      assert.equal(Object.isFrozen(m.content), true);
    }
    // The assistant and user message arrays are distinct references.
    assert.notEqual(result.messages[0], result.messages[1]);
  });

  it("every content block is itself frozen (deep freeze prevents prop mutation)", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([assistantResult(["hi"], [], "success")]);
    const { result } = await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    // Each block of each message must be Object.frozen.
    for (const m of result.messages) {
      for (const b of m.content) {
        assert.equal(Object.isFrozen(b), true);
      }
    }
    // Strict-mode mutation attempt on block.text throws TypeError.
    const assistantTextBlock = result.messages[1]!.content[0]! as {
      type: "text";
      text: string;
    };
    assert.throws(() => {
      (assistantTextBlock as { text: string }).text = "tampered";
    }, TypeError);
  });
});

describe("loop engine step(): real state-machine transitions", () => {
  it("step() returns continue transition with tool calls", async () => {
    const echo = createStubTool({
      name: "echo",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      next: (input: unknown) => input,
    });
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult(
        [],
        [{ id: "t1", name: "echo", input: { value: "ping" } }]
      ),
    ]);
    const initial: LoopState = {
      messages: Object.freeze([
        {
          role: "user",
          content: [{ type: "text", text: "go" }],
        } as AnthropicNativeMessage,
      ]) as ReadonlyArray<AnthropicNativeMessage>,
      turnCount: 0,
    };
    const transition = await step(initial, {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(transition.kind, "continue");
    if (transition.kind !== "continue") return;
    // After step: messages has user + assistant(tool_use) + user(tool_result).
    assert.equal(transition.nextState.messages.length, 3);
    assert.equal(transition.nextState.messages[1]!.role, "assistant");
    assert.equal(transition.nextState.messages[2]!.role, "user");
    assert.equal(transition.nextState.turnCount, 1);
  });

  it("step() returns stop transition on maxTurns without calling adapter", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([assistantResult(["hi"], [], "success")]);
    const initial: LoopState = {
      messages: Object.freeze([
        {
          role: "user",
          content: [{ type: "text", text: "go" }],
        } as AnthropicNativeMessage,
      ]) as ReadonlyArray<AnthropicNativeMessage>,
      turnCount: 5, // already at maxTurns
    };
    const transition = await step(initial, {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(transition.kind, "stop");
    if (transition.kind !== "stop") return;
    assert.equal(transition.reason, "maxTurns");
    assert.equal(transition.finalState.messages.length, 1);
  });

  it("step() returns completed transition on pure text", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([assistantResult(["hello"], [], "success")]);
    const initial: LoopState = {
      messages: Object.freeze([
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        } as AnthropicNativeMessage,
      ]) as ReadonlyArray<AnthropicNativeMessage>,
      turnCount: 0,
    };
    const transition = await step(initial, {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(transition.kind, "stop");
    if (transition.kind !== "stop") return;
    assert.equal(transition.reason, "completed");
    assert.equal(transition.finalState.messages.length, 2);
    assert.equal(transition.finalState.turnCount, 1);
  });
});

describe("loop engine S11: cross-run isolation", () => {
  it("two consecutive run() calls do not leak messages between each other", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    // Two independent stub models so each run gets its own scripted response.
    const model1 = createStubModel([assistantResult(["first"], [], "success")]);
    const model2 = createStubModel([
      assistantResult(["second"], [], "success"),
    ]);
    const r1 = (
      await run("one", {
        adapter: model1,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      })
    ).result;
    const r2 = (
      await run("two", {
        adapter: model2,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      })
    ).result;
    assert.equal(r1.finalText, "first");
    assert.equal(r2.finalText, "second");
    assert.equal(r1.messages.length, 2);
    assert.equal(r2.messages.length, 2);
    // The user text for r2 should be 'two', not 'one'.
    assert.equal(
      (r1.messages[0]!.content[0] as { type: "text"; text: string }).text,
      "one"
    );
    assert.equal(
      (r2.messages[0]!.content[0] as { type: "text"; text: string }).text,
      "two"
    );
  });
});

describe("loop engine 017 S12–S17 (signal/timeout/trace)", () => {
  it("S12: signal abort during model in-flight -> cancelled; whole turn NOT in history", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    // Stub model with delay so we can race an abort.
    const model = createStubModel(
      [assistantResult(["never arrives"], [], "success")],
      { delayMs: 200 }
    );
    const controller = new AbortController();
    const p = run(
      "x",
      {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      },
      controller.signal
    );
    controller.abort();
    const { result, trace } = await p;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.turnCount, 0);
    // Only the seed user message is in history; whole turn not appended.
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.role, "user");
    // Trace has one turn entry (the cancelled model attempt) flagged.
    assert.equal(trace.turns.length, 1);
    const last = trace.turns[0]!;
    assert.equal(last.signalAborted, true);
    assert.equal(last.timeoutHit, false);
    assert.equal(last.toolCalls.length, 0);
  });

  it("S13: signal abort during tool execution -> cancelled; tool_result is execution_failed", async () => {
    // Stub model responds fast with a tool call.
    const sigTool = createStubSignalTool({ name: "slow", delayMs: 100 });
    const reg = createRegistry([sigTool]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult([], [{ id: "u1", name: "slow", input: { v: 1 } }]),
      assistantResult(["done"], [], "success"),
    ]);
    const controller = new AbortController();
    const p = run(
      "go",
      {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      },
      controller.signal
    );
    // Give the model a moment to return the tool call, then abort during
    // tool execution.
    setTimeout(() => controller.abort(), 10);
    const { result, trace } = await p;
    assert.equal(result.stopReason, "cancelled");
    // History grew: seed user + assistant(tool_use) + user(tool_result).
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[1]!.role, "assistant");
    assert.equal(result.messages[2]!.role, "user");
    // The tool_result encodes an execution_failed with "cancelled".
    const trBlock = result.messages[2]!.content[0]! as {
      type: "tool_result";
      is_error?: boolean;
      tool_use_id: string;
      content: unknown;
    };
    assert.equal(trBlock.is_error, true);
    assert.equal(trBlock.tool_use_id, "u1");
    // Trace turn: signalAborted=true; toolCalls entry kind=execution_failed.
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.signalAborted, true);
    assert.equal(last.toolCalls.length, 1);
    const entry = last.toolCalls[0]!;
    assert.equal(entry.kind, "execution_failed");
    assert.equal(entry.toolUseId, "u1");
    assert.equal(entry.message, "cancelled");
  });

  it("S14: model timeout -> stop timeout; whole turn NOT in history; trace.timeoutHit=true", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([assistantResult(["never"], [], "success")], {
      delayMs: 200,
    });
    const { result, trace } = await run("x", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 20,
    });
    assert.equal(result.stopReason, "timeout");
    assert.equal(result.turnCount, 0);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.role, "user");
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.timeoutHit, true);
    assert.equal(last.signalAborted, false);
  });

  it("S15: tool timeout -> stop timeout; tool_result is execution_failed timeout", async () => {
    const slow = createStubTool({
      name: "slow",
      next: () => ({ ok: true }),
    });
    const reg = createRegistry([slow]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult([], [{ id: "u1", name: "slow", input: {} }]),
      assistantResult(["done"], [], "success"),
    ]);
    // Tool handler that resolves slowly -> Executor Promise.race fires first.
    const slowHandler = createStubTool({
      name: "slow",
      next: () => ({ ok: true }),
    });
    // Replace the handler with a slow one via a fresh registry with the
    // custom-slow tool to ensure deterministic delay past toolTimeoutMs.
    const slowToolDef: ToolDef = Object.freeze({
      name: "slow",
      description: "stub slow",
      inputSchema: { type: "object" },
      handler: (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return { ok: true };
      }) as ToolDef["handler"],
    });
    const reg2 = createRegistry([slowToolDef]);
    const exec2 = createExecutor(reg2);
    const { result, trace } = await run("go", {
      adapter: model,
      executor: exec2,
      registry: reg2,
      maxTurns: 5,
      toolTimeoutMs: 20,
    });
    assert.equal(result.stopReason, "timeout");
    assert.equal(result.messages.length, 3);
    const trBlock = result.messages[2]!.content[0]! as {
      type: "tool_result";
      is_error?: boolean;
      tool_use_id: string;
      content: unknown;
    };
    assert.equal(trBlock.is_error, true);
    assert.equal(trBlock.tool_use_id, "u1");
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.timeoutHit, true);
    assert.equal(last.toolCalls.length, 1);
    assert.equal(last.toolCalls[0]!.kind, "execution_failed");
    assert.equal(last.toolCalls[0]!.message, "timeout");
  });

  it("S16: clean multi-turn run — trace shape, totals, no payload leak", async () => {
    const echo = createStubTool({
      name: "echo",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      next: (input: unknown) => input,
    });
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult(
        [],
        [{ id: "t1", name: "echo", input: { value: "ping" } }]
      ),
      assistantResult(["done"], [], "success"),
    ]);
    const { result, trace } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 2);
    assert.equal(trace.turns.length, result.turnCount);
    // Every turn has all fields.
    for (const t of trace.turns) {
      assert.equal(typeof t.turnIndex, "number");
      assert.ok(
        t.supplierStop === "success" ||
          t.supplierStop === "truncation" ||
          t.supplierStop === "refusal" ||
          t.supplierStop === "other"
      );
      assert.ok(Array.isArray(t.toolCalls));
      assert.equal(typeof t.durationMs, "number");
      assert.ok(t.durationMs >= 0);
      assert.equal(typeof t.timeoutHit, "boolean");
      assert.equal(typeof t.signalAborted, "boolean");
    }
    // Totals aggregation.
    const sumDuration = trace.turns.reduce((acc, t) => acc + t.durationMs, 0);
    assert.equal(trace.totals.totalDurationMs, sumDuration);
    const okCount = trace.turns.reduce(
      (acc, t) => acc + t.toolCalls.filter((c) => c.kind === "ok").length,
      0
    );
    assert.equal(trace.totals.toolErrorTotals.ok, okCount);
    // S16 payload guard: NO toolCalls entry has input/output/payload.
    for (const t of trace.turns) {
      for (const entry of t.toolCalls) {
        assert.equal("input" in entry, false);
        assert.equal("output" in entry, false);
        assert.equal("payload" in entry, false);
      }
    }
  });

  it("S17: ctx.signal reaches the handler end-to-end — abort during tool -> execution_failed cancelled", async () => {
    const sigTool = createStubSignalTool({ name: "blocking", delayMs: 100 });
    const reg = createRegistry([sigTool]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult([], [{ id: "u1", name: "blocking", input: {} }]),
    ]);
    const controller = new AbortController();
    const p = run(
      "go",
      {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    const { result, trace } = await p;
    assert.equal(result.stopReason, "cancelled");
    // Tool execution was aborted via ctx.signal: result is execution_failed.
    const trBlock = result.messages[2]!.content[0]! as {
      type: "tool_result";
      is_error?: boolean;
      tool_use_id: string;
    };
    assert.equal(trBlock.is_error, true);
    assert.equal(trBlock.tool_use_id, "u1");
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.signalAborted, true);
    assert.equal(last.toolCalls[0]!.kind, "execution_failed");
    assert.equal(last.toolCalls[0]!.message, "cancelled");
  });
});

describe("017 timeout boundary: non-positive modelTimeoutMs disables the race", () => {
  it("modelTimeoutMs=0 disables timeout race: pure-text run completes normally", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([assistantResult(["hi"], [], "success")]);
    const { result, trace } = await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 0,
    });
    assert.equal(result.stopReason, "completed");
    assert.notEqual(result.stopReason, "timeout");
    assert.equal(result.turnCount, 1);
    assert.equal(result.finalText, "hi");
    // Trace turn must NOT be marked as a timeout hit.
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.timeoutHit, false);
    assert.equal(last.signalAborted, false);
  });

  it("modelTimeoutMs=-1 disables timeout race: pure-text run completes normally", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([assistantResult(["ok"], [], "success")]);
    const { result, trace } = await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: -1,
    });
    assert.equal(result.stopReason, "completed");
    assert.notEqual(result.stopReason, "timeout");
    assert.equal(result.finalText, "ok");
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.timeoutHit, false);
  });
});

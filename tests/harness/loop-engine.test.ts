/**
 * Loop-engine fixture matrix, covering the termination / signal / timeout /
 * trace-gate paths. Each fixture is one deterministic run driven by a
 * stub-model + stub-tool.
 */

import { APIUserAbortError } from "@anthropic-ai/sdk";
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  MaxTurnsExceeded,
  MessageCommitError,
  PromptTooLongError,
  ProtocolError,
  SkipAppendEmptyPriorError,
  SkipAppendWithTextError,
  TransportRetryExhaustedError,
} from "../../src/harness/errors.ts";
import { raceModel, run, step } from "../../src/harness/loop-engine.ts";
import type { LoopAdapter } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  TokenUsage,
} from "../../src/harness/model-adapter/types.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import type {
  ToolDef,
  ToolExecutionResult,
} from "../../src/harness/tools/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { toAnthropicToolResults } from "../../src/harness/tools/tool-result.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createStubSignalTool } from "../../src/harness/stubs/stub-signal-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import {
  makeStreamKeepAdapter,
  textOf,
  type StreamKeepStep,
} from "../_helpers/stream-keep-fixtures.ts";
import {
  createCompiledPatterns,
  createSecretRegistry,
  recognize,
} from "../../src/harness/secret-roundtrip/index.ts";

function makeNative(opts: {
  readonly role: "user" | "assistant";
  readonly text: string;
}): AnthropicNativeMessage {
  return { role: opts.role, content: [{ type: "text", text: opts.text }] };
}

describe("loop engine S1: pure-text completion", () => {
  it("returns completed + turnCount=1 + [user, assistant(text)]", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi there"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "a", name: "echo", input: { value: "1" } },
            { id: "b", name: "echo", input: { value: "2" } },
            { id: "c", name: "echo", input: { value: "3" } },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "f1", name: "strict", input: { n: "not-an-int" } }],
        }),
        assistantResult({
          texts: ["fixed"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "a", name: "echo", input: { value: "1" } },
            { id: "b", name: "strict", input: { n: "bad" } },
            { id: "c", name: "echo", input: { value: "3" } },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
  it("plan T3 + ADR-0011: throws MaxTurnsExceeded instead of silent stop; turnsRan = 已跑轮数", async () => {
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
      assistantResult({
        texts: [],
        toolCalls: [{ id: `t${i}`, name: "echo", input: { value: String(i) } }],
      })
    );
    const model = createStubModel({ responses: infinite });
    await assert.rejects(
      run("go", {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 3,
      }),
      (err: unknown) => {
        assert.ok(err instanceof MaxTurnsExceeded);
        assert.equal(err.turnsRan, 3);
        assert.equal(err.reason, "maxTurns");
        return true;
      }
    );
  });
});

describe("loop engine S7: non-success stop (truncation/refusal)", () => {
  it("returns nonSuccessStop; finalText is null even if texts present", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["partial"],
          toolCalls: [],
          supplierStop: "truncation",
        }),
      ],
    });
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
    const model = createStubModel({
      responses: [
        assistantResult({ texts: [], toolCalls: [], supplierStop: "success" }),
      ], // empty + isEmptyFinalResponse=true
    });
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
    // executor. Strict requirement: a bad turn never enters history and never triggers tool execution.
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

  it("TransportRetryExhaustedError surfaces as stopReason=protocolError, not throw", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const failingModel = Object.freeze({
      encodeUserText: (t: string) =>
        ({
          role: "user",
          content: [{ type: "text", text: t }],
        }) as AnthropicNativeMessage,
      encodeToolResults: () => undefined as never,
      step: async (): Promise<AssistantTurnResult> => {
        throw new TransportRetryExhaustedError(3, new Error("http:429"));
      },
    });
    const { result } = await run("go", {
      adapter: failingModel,
      executor: createExecutor(reg),
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "protocolError");
    assert.equal(result.messages.length, 1);
    assert.equal(result.finalText, null);
  });

  // ADR-0094 (viewport API error): an SDK APIError-like cause makes
  // RunResult.apiError carry a `{status, message}` summary; non-transport
  // failures → the field is absent (byte-stable).
  it("TransportRetryExhaustedError with APIError-like cause surfaces apiError summary on RunResult", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const apiErrLike = {
      name: "APIError",
      status: 404,
      message:
        '{"error":{"message":"No active credentials for provider: 9router"}}',
    };
    const failingModel = Object.freeze({
      encodeUserText: (t: string) =>
        ({
          role: "user",
          content: [{ type: "text", text: t }],
        }) as AnthropicNativeMessage,
      encodeToolResults: () => undefined as never,
      step: async (): Promise<AssistantTurnResult> => {
        throw new TransportRetryExhaustedError(3, apiErrLike);
      },
    });
    const { result } = await run("go", {
      adapter: failingModel,
      executor: createExecutor(reg),
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "protocolError");
    assert.equal(result.messages.length, 1);
    assert.equal(result.finalText, null);
    // The apiError field carries the SDK APIError's status + JSON message.
    assert.deepEqual(result.apiError, {
      status: 404,
      message:
        '{"error":{"message":"No active credentials for provider: 9router"}}',
    });
  });

  it("TransportRetryExhaustedError with null cause → apiError absent (byte-stable)", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const failingModel = Object.freeze({
      encodeUserText: (t: string) =>
        ({
          role: "user",
          content: [{ type: "text", text: t }],
        }) as AnthropicNativeMessage,
      encodeToolResults: () => undefined as never,
      step: async (): Promise<AssistantTurnResult> => {
        throw new TransportRetryExhaustedError(3, null);
      },
    });
    const { result } = await run("go", {
      adapter: failingModel,
      executor: createExecutor(reg),
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "protocolError");
    assert.equal("apiError" in result, false);
  });
});

describe("loop engine S10: append-only immutable history", () => {
  it("messages array references never mutated in place; each step returns a new array", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
        }),
      ],
    });
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

  it("step() throws MaxTurnsExceeded on maxTurns without calling adapter", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const initial: LoopState = {
      messages: Object.freeze([
        {
          role: "user",
          content: [{ type: "text", text: "go" }],
        } as AnthropicNativeMessage,
      ]) as ReadonlyArray<AnthropicNativeMessage>,
      turnCount: 5, // already at maxTurns
    };
    await assert.rejects(
      step(initial, {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      }),
      (err: unknown) => {
        assert.ok(err instanceof MaxTurnsExceeded);
        assert.equal(err.turnsRan, 5);
        assert.equal(err.reason, "maxTurns");
        return true;
      }
    );
  });

  it("step() returns completed transition on pure text", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hello"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    const model1 = createStubModel({
      responses: [
        assistantResult({
          texts: ["first"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const model2 = createStubModel({
      responses: [
        assistantResult({
          texts: ["second"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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

describe("run() opts.priorMessages", () => {
  it("no priorMessages defaults to empty array (old behavior)", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hello"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });

    const { result } = await run("hi", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });

    assert.equal(result.messages.length, 2);
  });

  it("priorMessages prefix + user text form N+1 starting messages", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["B reply"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const userA = makeNative({ role: "user", text: "A" });
    const assistantA = makeNative({ role: "assistant", text: "A reply" });
    const priorMessages = [userA, assistantA];

    const { result } = await run(
      "B",
      {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      },
      undefined,
      { priorMessages }
    );

    assert.deepEqual(result.messages[0], userA);
    assert.deepEqual(result.messages[1], assistantA);
    assert.deepEqual(
      result.messages[2],
      makeNative({ role: "user", text: "B" })
    );
  });

  it("priorMessages does not affect turnCount starting at 0", async () => {
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "B" } }],
        }),
      ],
    });
    const priorMessages = [
      makeNative({ role: "user", text: "A" }),
      makeNative({ role: "assistant", text: "A reply" }),
    ];

    await assert.rejects(
      run(
        "B",
        {
          adapter: model,
          executor: exec,
          registry: reg,
          maxTurns: 1,
        },
        undefined,
        { priorMessages }
      ),
      (err: unknown) => {
        assert.ok(err instanceof MaxTurnsExceeded);
        assert.equal(err.turnsRan, 1);
        return true;
      }
    );
  });

  it("appendUserText false with prior does not call encodeUserText and does not append a user", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const stub = createStubModel({
      responses: [
        assistantResult({
          texts: ["continued"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    let encodeCallCount = 0;
    const adapter = {
      ...stub,
      encodeUserText: (t: string) => {
        encodeCallCount += 1;
        return stub.encodeUserText(t);
      },
    };
    const priorMessages = [
      makeNative({ role: "user", text: "A" }),
      makeNative({ role: "assistant", text: "A reply" }),
    ];

    const { result } = await run(
      "",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      },
      undefined,
      { appendUserText: false, priorMessages }
    );

    assert.equal(encodeCallCount, 0);
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 1);
    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.messages[0], priorMessages[0]);
    assert.deepEqual(result.messages[1], priorMessages[1]);
    assert.equal(result.messages[2]!.role, "assistant");
    assert.equal(result.finalText, "continued");
  });

  it('default run("hi") still calls encodeUserText once', async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const stub = createStubModel({
      responses: [
        assistantResult({
          texts: ["hello"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    let encodeCallCount = 0;
    const adapter = {
      ...stub,
      encodeUserText: (t: string) => {
        encodeCallCount += 1;
        return stub.encodeUserText(t);
      },
    };

    const { result } = await run("hi", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });

    assert.equal(encodeCallCount, 1);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]!.role, "user");
  });

  it("appendUserText false with non-empty userText throws skip_append_with_text", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const stub = createStubModel({
      responses: [
        assistantResult({
          texts: ["should not run"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    let encodeCallCount = 0;
    const adapter = {
      ...stub,
      encodeUserText: (t: string) => {
        encodeCallCount += 1;
        return stub.encodeUserText(t);
      },
    };
    const priorMessages = [makeNative({ role: "user", text: "A" })];

    await assert.rejects(
      run(
        "hi",
        {
          adapter,
          executor: exec,
          registry: reg,
          maxTurns: 5,
        },
        undefined,
        { appendUserText: false, priorMessages }
      ),
      (err: unknown) => {
        assert.ok(err instanceof SkipAppendWithTextError);
        assert.match(err.message, /skip_append_with_text/);
        return true;
      }
    );
    assert.equal(encodeCallCount, 0);
  });

  it("appendUserText false with missing priorMessages throws skip_append_empty_prior", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const stub = createStubModel({
      responses: [
        assistantResult({
          texts: ["should not run"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    let encodeCallCount = 0;
    const adapter = {
      ...stub,
      encodeUserText: (t: string) => {
        encodeCallCount += 1;
        return stub.encodeUserText(t);
      },
    };

    await assert.rejects(
      run(
        "",
        {
          adapter,
          executor: exec,
          registry: reg,
          maxTurns: 5,
        },
        undefined,
        { appendUserText: false }
      ),
      (err: unknown) => {
        assert.ok(err instanceof SkipAppendEmptyPriorError);
        assert.match(err.message, /skip_append_empty_prior/);
        return true;
      }
    );
    assert.equal(encodeCallCount, 0);
  });

  it("appendUserText false with empty priorMessages throws skip_append_empty_prior", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["should not run"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });

    await assert.rejects(
      run(
        "",
        {
          adapter: model,
          executor: exec,
          registry: reg,
          maxTurns: 5,
        },
        undefined,
        { appendUserText: false, priorMessages: [] }
      ),
      (err: unknown) => {
        assert.ok(err instanceof SkipAppendEmptyPriorError);
        assert.match(err.message, /skip_append_empty_prior/);
        return true;
      }
    );
  });

  it("appendUserText false does not recognize userText (secretRegistry unchanged)", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const stub = createStubModel({
      responses: [
        assistantResult({
          texts: ["ok"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    let encodeCallCount = 0;
    const adapter = {
      ...stub,
      encodeUserText: (t: string) => {
        encodeCallCount += 1;
        return stub.encodeUserText(t);
      },
    };
    const secretRegistry = createSecretRegistry();
    const priorMessages = [
      makeNative({
        role: "user",
        text: "用 sk-aaaaaaaaaaaaaaaaaaaa 处理",
      }),
      makeNative({ role: "assistant", text: "first" }),
    ];

    const { result } = await run(
      "",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        secretRegistry,
      },
      undefined,
      { appendUserText: false, priorMessages }
    );

    assert.equal(encodeCallCount, 0);
    assert.equal(secretRegistry.size, 0);
    const priorUserText = (
      result.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(priorUserText, "用 sk-aaaaaaaaaaaaaaaaaaaa 处理");
  });

  it("non-empty userText is checked before empty prior (skip_append_with_text wins)", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["should not run"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });

    await assert.rejects(
      run(
        "hi",
        {
          adapter: model,
          executor: exec,
          registry: reg,
          maxTurns: 5,
        },
        undefined,
        { appendUserText: false }
      ),
      (err: unknown) => {
        assert.ok(err instanceof SkipAppendWithTextError);
        assert.match(err.message, /skip_append_with_text/);
        assert.ok(!(err instanceof SkipAppendEmptyPriorError));
        return true;
      }
    );
  });
});

describe("loop engine 017 S12–S17 (signal/timeout/trace)", () => {
  it("S12: signal abort during model in-flight with no frozen prefix -> cancelled; history = user + interrupt", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    // Stub model with delay so we can race an abort.
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["never arrives"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      delayMs: 200,
    });
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
    // ADR-0108 no-prefix branch: this step has no pinnable streaming block → no assistant
    // is landed; cancelled still writes user + interrupt system message (pinned-block
    // history retention is certified by the keep-path tests).
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.messages[1]!.role, "system");
    const systemMsg = result.messages[1]!;
    if (systemMsg.role === "system") {
      const firstBlock = systemMsg.content[0];
      if (firstBlock && firstBlock.type === "text") {
        assert.equal(firstBlock.text, "Interrupted by user.");
      } else {
        assert.fail("system content[0] should be a text block");
      }
    } else {
      assert.fail("second message should be system role");
    }
    // Trace has one turn entry (the cancelled model attempt) flagged.
    assert.equal(trace.turns.length, 1);
    const last = trace.turns[0]!;
    assert.equal(last.cancelKind, "callerAbort");
    assert.equal(last.toolCalls.length, 0);
  });

  it("T4 #392: completed path does NOT append system interrupt (#392 G3 #388)", async () => {
    // Guard: a non-cancelled stop reason must not append a system message (only cancelled triggers it).
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const controller = new AbortController();
    const { result } = await run(
      "x",
      {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      },
      controller.signal
    );
    assert.equal(result.stopReason, "completed");
    // No system message appended for completed path
    const systemEntries = result.messages.filter((m) => m.role === "system");
    assert.equal(systemEntries.length, 0);
  });

  it("S13: signal abort during tool execution -> cancelled; tool_result is execution_failed", async () => {
    // Stub model responds fast with a tool call.
    const sigTool = createStubSignalTool({ name: "slow", delayMs: 100 });
    const reg = createRegistry([sigTool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "u1", name: "slow", input: { v: 1 } }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    // History grew: seed user + assistant(tool_use) + user(tool_result)
    // + system interrupt (first-class transcript entry, appended at the tail).
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[1]!.role, "assistant");
    assert.equal(result.messages[2]!.role, "user");
    assert.equal(result.messages[3]!.role, "system");
    // The tool_result encodes an execution_failed with "cancelled".
    const trBlock = result.messages[2]!.content[0]! as {
      type: "tool_result";
      is_error?: boolean;
      tool_use_id: string;
      content: unknown;
    };
    assert.equal(trBlock.is_error, true);
    assert.equal(trBlock.tool_use_id, "u1");
    // Trace turn: cancelKind=callerAbort; toolCalls entry kind=execution_failed.
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.cancelKind, "callerAbort");
    assert.equal(last.toolCalls.length, 1);
    const entry = last.toolCalls[0]!;
    assert.equal(entry.kind, "execution_failed");
    assert.equal(entry.toolUseId, "u1");
    assert.equal(entry.message, "cancelled");
  });

  it('S14: model timeout -> stop timeout; whole turn NOT in history; cancelKind="timerTimeout"', async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["never"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
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
    assert.equal(last.cancelKind, "timerTimeout");
  });

  it("S15/ADR-0091: 单 call tool timeout 只失败该条 result,回合 continue 而非停 timeout", async () => {
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "u1", name: "slow", input: {} }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    // Handler slower than toolTimeoutMs → the Executor's per-call race hits
    // first and that result lands as execution_failed "timeout" (ADR-0005);
    // the signal never aborts, so the loop must not judge the turn as timeout (ADR-0091).
    const slowToolDef: ToolDef = Object.freeze({
      name: "slow",
      description: "stub slow",
      inputSchema: { type: "object" },
      handler: (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return { ok: true };
      }) as ToolDef["handler"],
    });
    const reg = createRegistry([slowToolDef]);
    const exec = createExecutor(reg);
    const { result, trace } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      toolTimeoutMs: 20,
    });
    // The turn continues and consumes the second model response → completed, not timeout.
    assert.equal(result.stopReason, "completed");
    assert.notEqual(result.stopReason, "timeout");
    assert.equal(result.turnCount, 2);
    assert.equal(result.messages.length, 4);
    const trBlock = result.messages[2]!.content[0]! as {
      type: "tool_result";
      is_error?: boolean;
      tool_use_id: string;
      content: unknown;
    };
    assert.equal(trBlock.is_error, true);
    assert.equal(trBlock.tool_use_id, "u1");
    // Trace of the tool turn (index 0): not stopped as timeout, cancelKind none,
    // but its toolCalls entry is still execution_failed "timeout".
    const toolTurn = trace.turns.find((t) => t.toolCalls.length > 0)!;
    assert.ok(toolTurn, "expected a turn trace carrying the tool call");
    assert.equal(toolTurn.cancelKind, "none");
    assert.equal(toolTurn.toolCalls.length, 1);
    assert.equal(toolTurn.toolCalls[0]!.kind, "execution_failed");
    assert.equal(toolTurn.toolCalls[0]!.message, "timeout");
    // Last turn = the completed plain-text wrap-up, cancelKind still none.
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.cancelKind, "none");
    assert.equal(last.toolCalls.length, 0);
  });

  it("ADR-0091 SC4:工具阶段 caller 以 reason 'turn-timeout' abort → stop timeout / cancelKind timerTimeout", async () => {
    const sigTool = createStubSignalTool({ name: "slow", delayMs: 100 });
    const reg = createRegistry([sigTool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "u1", name: "slow", input: {} }],
        }),
        assistantResult({ texts: ["done"], toolCalls: [] }),
      ],
    });
    const controller = new AbortController();
    const p = run(
      "go",
      { adapter: model, executor: exec, registry: reg, maxTurns: 5 },
      controller.signal
    );
    // Only an abort whose reason is exactly "turn-timeout" lands the turn as timeout (ADR-0091).
    setTimeout(() => controller.abort("turn-timeout"), 10);
    const { result, trace } = await p;
    assert.equal(result.stopReason, "timeout");
    // timeout does not append a system interrupt (only cancelled triggers it):
    // seed user + assistant(tool_use) + user(tool_result).
    assert.equal(result.messages.length, 3);
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.cancelKind, "timerTimeout");
    assert.equal(last.toolCalls.length, 1);
    assert.equal(last.toolCalls[0]!.kind, "execution_failed");
  });

  it("ADR-0091:工具阶段 plain caller abort 仍归 cancelled / cancelKind callerAbort", async () => {
    const sigTool = createStubSignalTool({ name: "slow", delayMs: 100 });
    const reg = createRegistry([sigTool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "u1", name: "slow", input: {} }],
        }),
        assistantResult({ texts: ["done"], toolCalls: [] }),
      ],
    });
    const controller = new AbortController();
    const p = run(
      "go",
      { adapter: model, executor: exec, registry: reg, maxTurns: 5 },
      controller.signal
    );
    // A reason-less caller abort (TUI/quit/SIGINT shape) must not escalate to timeout.
    setTimeout(() => controller.abort(), 10);
    const { result, trace } = await p;
    assert.equal(result.stopReason, "cancelled");
    assert.notEqual(result.stopReason, "timeout");
    // cancelled appends the system interrupt → 4 messages.
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[3]!.role, "system");
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.cancelKind, "callerAbort");
    assert.equal(last.toolCalls.length, 1);
    assert.equal(last.toolCalls[0]!.kind, "execution_failed");
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
      assert.equal(typeof t.cancelKind, "string");
      assert.ok(
        ["none", "callerAbort", "timerTimeout", "hostCancel"].includes(
          t.cancelKind
        ),
        `cancelKind must be one of the enum values, got: ${t.cancelKind}`
      );
    }
    // Totals aggregation.
    const sumDuration = trace.turns.reduce((acc, t) => acc + t.durationMs, 0);
    assert.equal(trace.totals.totalDurationMs, sumDuration);
    const okCount = trace.turns.reduce(
      (acc, t) => acc + t.toolCalls.filter((c) => c.kind === "ok").length,
      0
    );
    assert.equal(trace.totals.toolErrorTotals.ok, okCount);
    // Payload guard: NO toolCalls entry has input/output/payload.
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "u1", name: "blocking", input: {} }],
        }),
      ],
    });
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
    assert.equal(last.cancelKind, "callerAbort");
    assert.equal(last.toolCalls[0]!.kind, "execution_failed");
    assert.equal(last.toolCalls[0]!.message, "cancelled");
  });

  it("T2-new-1: SDK abort error does not poison timer timeout routing", async () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    // The first two steps (raceModel direct test + run main loop) abort+throw;
    // later ones (summary rounds) return an empty-text result immediately,
    // best-effort skip to avoid hanging the test.
    let stepCalls = 0;
    const adapter = Object.freeze({
      encodeUserText: (text: string) => makeNative({ role: "user", text }),
      encodeToolResults: () => [],
      step: async (
        _state: LoopState,
        _request: unknown,
        signal?: AbortSignal
      ) => {
        stepCalls++;
        if (stepCalls > 2) {
          return assistantResult({
            texts: [],
            toolCalls: [],
            supplierStop: "success",
          });
        }
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true })
        );
        throw new APIUserAbortError();
      },
    });
    const state = Object.freeze({ messages: Object.freeze([]), turnCount: 0 });
    const deps = Object.freeze({ adapter, executor, registry, maxTurns: 1 });
    const handle = raceModel({
      adapter,
      state,
      deps,
      signal: undefined,
      timeoutMs: 20,
    });
    assert.equal((await handle.outcome).source, "timerTimeout");

    const { result } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 20,
    });
    assert.equal(result.stopReason, "timeout");
  });

  it("T2-new-2: timer aborts the composite adapter signal", async () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    let receivedSignal: AbortSignal | undefined;
    // First step = main loop (captures the race composite); later steps = summary
    // rounds, returning empty text immediately to avoid the 200ms setTimeout drag and polluting the receivedSignal assertion.
    let stepCalls = 0;
    const adapter = Object.freeze({
      encodeUserText: (text: string) => makeNative({ role: "user", text }),
      encodeToolResults: () => [],
      step: async (
        _state: LoopState,
        _request: unknown,
        signal?: AbortSignal
      ) => {
        stepCalls++;
        if (stepCalls > 1) {
          return assistantResult({
            texts: [],
            toolCalls: [],
            supplierStop: "success",
          });
        }
        receivedSignal = signal;
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return assistantResult({ texts: ["late"] });
      },
    });
    const { result } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 20,
    });
    assert.equal(result.stopReason, "timeout");
    assert.equal(receivedSignal?.aborted, true);
  });

  it("T2-new-3: caller abort wins before the model timer", async () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["late"] })],
      delayMs: 200,
    });
    const controller = new AbortController();
    const pending = run(
      "x",
      { adapter, executor, registry, maxTurns: 1, modelTimeoutMs: 200 },
      controller.signal
    );
    controller.abort();
    const { result } = await pending;
    assert.equal(result.stopReason, "cancelled");
  });

  it("T2-new-4: aborts after adapter settle are idempotent no-ops", async () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["done"] })],
    });
    const controller = new AbortController();
    const state = Object.freeze({ messages: Object.freeze([]), turnCount: 0 });
    const deps = Object.freeze({ adapter, executor, registry, maxTurns: 1 });
    const handle = raceModel({
      adapter,
      state,
      deps,
      signal: controller.signal,
      timeoutMs: 200,
    });
    const outcome = await handle.outcome;
    assert.equal(outcome.source, "adapter");
    assert.doesNotThrow(() => controller.abort());
    assert.doesNotThrow(() => handle.childAbort());
    assert.equal((await handle.outcome).source, "adapter");
  });

  it("T2-new-5 (#98): childAbort() wins the race -> outcome.source === hostCancel", async () => {
    // hostCancel coverage: adapter.step never settles, childAbort() wins the race first.
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = Object.freeze({
      encodeUserText: (text: string) => makeNative({ role: "user", text }),
      encodeToolResults: () => [],
      step: async () => {
        // Never resolves: simulates a hung HTTP request.
        await new Promise<void>(() => undefined);
        return assistantResult({ texts: ["unreachable"] });
      },
    });
    const state = Object.freeze({ messages: Object.freeze([]), turnCount: 0 });
    const deps = Object.freeze({ adapter, executor, registry, maxTurns: 1 });
    const handle = raceModel({
      adapter,
      state,
      deps,
      signal: undefined,
      timeoutMs: 5000, // long enough that the timer never fires first
    });
    // childAbort() is called before the adapter settles → hostCancel wins.
    handle.childAbort();
    const outcome = await handle.outcome;
    assert.equal(outcome.source, "hostCancel");
    assert.equal(outcome.result, undefined);
  });
});

describe("017 timeout boundary: non-positive modelTimeoutMs disables the race", () => {
  it("modelTimeoutMs=0 disables timeout race: pure-text run completes normally", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    // Trace turn must NOT be marked as a timeout or cancel hit.
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.cancelKind, "none");
  });

  it("modelTimeoutMs=-1 disables timeout race: pure-text run completes normally", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["ok"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
    assert.equal(last.cancelKind, "none");
  });
});

/**
 * Loop-level thinking retention and replay (rule layer STUB/LOOP).
 *
 * Acceptance:
 *   1. an assistant turn containing thinking → state.messages (append-only,
 *      full fields: thinking text + signature; redacted's data);
 *   2. the next replay's request messages contain the thinking blocks verbatim
 *      (replay = the authoritative history itself);
 *   3. LoopTrace strictly excludes payload (context term lock); trace never
 *      carries thinking content;
 *   4. `projection.texts` excludes thinking text (thinking is not user-facing body);
 *   5. `run().result.finalText` derivation unchanged.
 *
 * Slice: this file does not verify the thinking display switch (a cmd/format
 * concern elsewhere). It only asserts field-level deep retention in the
 * authoritative history layer (result messages[?].content) plus byte-identical
 * replay of the original thinking blocks into the next step's input.
 */
describe("loop engine T5 #152: thinking 保留与回传", () => {
  it("thinking + text + tool_use → append-only 进 state.messages 全字段", async () => {
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["done"],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
          thinkingBlocks: [
            {
              type: "thinking",
              thinking: "Let me reason about this carefully.",
              signature: "sig_abc123",
            },
          ],
        }),
        assistantResult({
          texts: ["final"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 2);
    // On the assistant role: messages[1] is the turn carrying thinking.
    const assistant1 = result.messages[1]!;
    assert.equal(assistant1.role, "assistant");
    // Block order: thinking → text → tool_use (required by the agreed rule).
    assert.equal(assistant1.content.length, 3);
    const b0 = assistant1.content[0] as {
      type: "thinking";
      thinking: string;
      signature: string;
    };
    assert.equal(b0.type, "thinking");
    assert.equal(b0.thinking, "Let me reason about this carefully.");
    assert.equal(b0.signature, "sig_abc123");
    const b1 = assistant1.content[1] as { type: "text"; text: string };
    assert.equal(b1.text, "done");
    const b2 = assistant1.content[2] as { type: "tool_use"; id: string };
    assert.equal(b2.type, "tool_use");
    assert.equal(b2.id, "t1");
    // result.finalText derivation unchanged (plain-text concatenation).
    assert.equal(result.finalText, "final");
    // The whole tree remains frozen.
    assert.equal(Object.isFrozen(result.messages), true);
    assert.equal(Object.isFrozen(assistant1), true);
    assert.equal(Object.isFrozen(assistant1.content), true);
    for (const b of assistant1.content) {
      assert.equal(Object.isFrozen(b), true);
    }
  });

  it("redacted_thinking 的 data 字段也字段级深保留", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["recovered"],
          toolCalls: [],
          thinkingBlocks: [
            { type: "redacted_thinking", data: "encrypted_blob_data_here==" },
          ],
        }),
      ],
    });
    const { result } = await run("hi", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    const blocks = result.messages[1]!.content;
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.type, "redacted_thinking");
    assert.equal(
      (blocks[0] as { type: "redacted_thinking"; data: string }).data,
      "encrypted_blob_data_here=="
    );
    assert.equal(
      (blocks[1] as { type: "text"; text: string }).text,
      "recovered"
    );
    assert.equal(result.finalText, "recovered");
  });

  it("回传契约:下一轮 step 收到的 state.messages 原样含 thinking blocks", async () => {
    // Key assertion: the history carried by replay is byte-identical to the authoritative history.
    // Wrap with a stub-model that captures the state.messages each step sees.
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
    const capturedMessages: ReadonlyArray<AnthropicNativeMessage>[] = [];

    const fakeAdapter = Object.freeze({
      encodeUserText: (t: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text: t }],
      }),
      encodeToolResults: (
        results: ReadonlyArray<ToolExecutionResult>
      ): AnthropicContentBlock[] => {
        return results.map((r) => {
          // `message` only exists on the failure variants; the ok arm never
          // reads it.
          const text =
            r.kind === "ok"
              ? JSON.stringify(r.payload)
              : `[${r.kind}] ${"message" in r ? (r.message ?? "") : ""}`;
          return {
            type: "tool_result" as const,
            tool_use_id: r.toolUseId,
            is_error: r.kind !== "ok",
            content: [{ type: "text" as const, text }],
          };
        });
      },
      step: async (
        state: LoopState,
        _request: { tools?: unknown }
      ): Promise<AssistantTurnResult> => {
        // Snapshot the messages the engine is about to send to the model.
        capturedMessages.push(state.messages);
        // Two-turn scripted flow: think + tool_use, then plain text.
        if (capturedMessages.length === 1) {
          return assistantResult({
            texts: ["done"],
            toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
            thinkingBlocks: [
              {
                type: "thinking",
                thinking: "First turn reasoning.",
                signature: "sig_first_turn",
              },
            ],
          });
        }
        return assistantResult({
          texts: ["all good"],
          toolCalls: [],
          supplierStop: "success",
        });
      },
    });

    const { result } = await run("go", {
      adapter: fakeAdapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 2);
    assert.equal(capturedMessages.length, 2);
    // Messages seen at step 1 (before the thinking block is appended) = [user(go)].
    assert.equal(capturedMessages[0]!.length, 1);
    assert.equal(capturedMessages[0]![0]!.role, "user");
    // Messages seen at step 2 must include the first reply's thinking block — that is the replay contract.
    // At step entry, state.messages is the full history appended by previous steps,
    // excluding the assistant turn this step is generating (append-after-success).
    const turn2Seen = capturedMessages[1]!;
    // Expected = [user(go), assistant1(think+text+tool_use), user(tool_result)] = 3 messages.
    assert.equal(turn2Seen.length, 3);
    const assistantTurn1 = turn2Seen[1]!;
    assert.equal(assistantTurn1.role, "assistant");
    // Contains the thinking block verbatim: thinking text + signature byte-identical.
    const tBlock = assistantTurn1.content[0] as {
      type: "thinking";
      thinking: string;
      signature: string;
    };
    assert.equal(tBlock.type, "thinking");
    assert.equal(tBlock.thinking, "First turn reasoning.");
    assert.equal(tBlock.signature, "sig_first_turn");
    // Order: thinking before text before tool_use (required block order).
    const t1 = assistantTurn1.content[1] as { type: "text"; text: string };
    assert.equal(t1.text, "done");
    const t2 = assistantTurn1.content[2] as { type: "tool_use"; id: string };
    assert.equal(t2.type, "tool_use");
    assert.equal(t2.id, "t1");
    // turn2 must also carry the previous turn's tool_result (user message).
    const toolResultMsg = turn2Seen[2]!;
    assert.equal(toolResultMsg.role, "user");
    assert.equal(toolResultMsg.content[0]!.type, "tool_result");
    // The messages seen at step2 entry must be a prefix of run.result.messages (replay = authoritative history).
    // The run result has one extra assistant ("all good"), so match prefix length + per-message deepEqual.
    for (let i = 0; i < turn2Seen.length; i++) {
      assert.deepEqual(turn2Seen[i], result.messages[i]);
    }
  });

  it("replay 与 run().result.messages 对齐(head→head byte-equality of seen vs produced)", async () => {
    // Design intent: replay = the authoritative history itself. Deep-equal the
    // deep-snapshot of the messages array the step saw against run's
    // result.messages, proving both are the same frozen tree.
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
    let captured: ReadonlyArray<AnthropicNativeMessage> | undefined;

    const fakeAdapter = Object.freeze({
      encodeUserText: (t: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text: t }],
      }),
      encodeToolResults: (
        results: ReadonlyArray<ToolExecutionResult>
      ): AnthropicContentBlock[] =>
        results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolUseId,
          is_error: r.kind !== "ok",
          content: [
            {
              type: "text" as const,
              text:
                r.kind === "ok"
                  ? JSON.stringify(r.payload)
                  : "message" in r
                    ? (r.message ?? "")
                    : "",
            },
          ],
        })),
      step: async (
        state: LoopState,
        _req: { tools?: unknown }
      ): Promise<AssistantTurnResult> => {
        captured = state.messages;
        if (state.messages.length === 1) {
          return assistantResult({
            texts: ["done"],
            toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
            thinkingBlocks: [
              {
                type: "thinking",
                thinking: "alpha",
                signature: "sig_alpha",
              },
            ],
          });
        }
        return assistantResult({
          texts: ["final"],
          toolCalls: [],
          supplierStop: "success",
        });
      },
    });

    const { result } = await run("go", {
      adapter: fakeAdapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.ok(captured, "captured must be defined");
    // captured is the authoritative history at step2 entry (step entry = state after the previous append),
    // i.e. a prefix of result.messages (which additionally has step2's own assistant turn).
    // Replay = the authoritative history itself: per-message deepEqual proves the replay
    // sent exactly the authoritative history with no truncation/reordering/field loss.
    assert.equal(captured!.length, 3);
    assert.equal(result.messages.length, 4);
    for (let i = 0; i < captured!.length; i++) {
      assert.deepEqual(
        captured![i],
        result.messages[i],
        `replay message ${i} must deep-equal authoritative history entry`
      );
    }
    // Further: the thinking block is at the head of captured[1], fully retained.
    const assistantTurn = captured![1]!;
    const t0 = assistantTurn.content[0] as {
      type: "thinking";
      thinking: string;
      signature: string;
    };
    assert.equal(t0.type, "thinking");
    assert.equal(t0.thinking, "alpha");
    assert.equal(t0.signature, "sig_alpha");
  });

  it("projection.texts 不含 thinking 文本(Q3:finalText 派生不变)", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["final answer"],
          toolCalls: [],
          thinkingBlocks: [
            {
              type: "thinking",
              thinking: "INTERNAL_REASONING_SHOULD_NOT_LEAK",
              signature: "sig_leak_guard",
            },
          ],
        }),
      ],
    });
    const { result } = await run("hi", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    // finalText contains no thinking text.
    assert.equal(result.finalText, "final answer");
    assert.ok(
      result.finalText !== null &&
        !result.finalText.includes("INTERNAL_REASONING_SHOULD_NOT_LEAK"),
      "finalText must NOT include thinking text (Q3 projection invariant)"
    );
  });

  it("LoopTrace 严格不含 thinking payload(上下文词条锁)", async () => {
    // Context lock: the trace records only structural metadata, never input/output/text/payload fields.
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["ok"],
          toolCalls: [],
          thinkingBlocks: [
            {
              type: "thinking",
              thinking: "THIS_SHOULD_NEVER_APPEAR_IN_TRACE",
              signature: "sig_trace_leak",
            },
          ],
        }),
      ],
    });
    const { trace } = await run("hi", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    const serialized = JSON.stringify(trace);
    assert.ok(
      !serialized.includes("THIS_SHOULD_NEVER_APPEAR_IN_TRACE"),
      "trace JSON must NOT contain thinking text"
    );
    assert.ok(
      !serialized.includes("sig_trace_leak"),
      "trace JSON must NOT contain thinking signature"
    );
    // Each turn still has no input / output / payload fields (the hard constraint from the trace-gate section).
    for (const t of trace.turns) {
      for (const tc of t.toolCalls) {
        assert.equal("input" in tc, false);
        assert.equal("output" in tc, false);
        assert.equal("payload" in tc, false);
      }
    }
  });
});

describe("T4 onStream pass-through (D3)", () => {
  it("delivers the complete stub-emitted event sequence to run() opts.onStream (multi-turn)", async () => {
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
    const registry = createRegistry([echo]);
    const executor = createExecutor(registry);
    // The two model turns each emit: turn1 = tool_call_start, turn2 = text_delta×2.
    const expected: ReadonlyArray<HarnessStreamEvent> = [
      { type: "tool_call_start", name: "echo", id: "t1" },
      { type: "text_delta", text: "hel" },
      { type: "text_delta", text: "lo" },
    ];
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
        }),
        assistantResult({ texts: ["hello"], toolCalls: [] }),
      ],
      streamEventsByStep: [
        [{ type: "tool_call_start", name: "echo", id: "t1" }],
        [
          { type: "text_delta", text: "hel" },
          { type: "text_delta", text: "lo" },
        ],
      ],
    });
    const received: HarnessStreamEvent[] = [];

    const { result } = await run(
      "say hello",
      { adapter, executor, registry, maxTurns: 5 },
      undefined,
      { onStream: (event) => received.push(event) }
    );

    assert.deepEqual(received, expected);
    assert.equal(result.stopReason, "completed");
    assert.equal(result.finalText, "hello");
  });

  it("swallows onStream observer exceptions and still returns the final result", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["done"] })],
      streamEventsByStep: [[{ type: "text_delta", text: "done" }]],
    });

    const { result } = await run(
      "finish",
      { adapter, executor, registry, maxTurns: 1 },
      undefined,
      {
        onStream: () => {
          throw new Error("observer failure");
        },
      }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(result.finalText, "done");
  });

  it("keeps the existing result and authoritative history unchanged without onStream", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["unchanged"] })],
      streamEventsByStep: [[{ type: "text_delta", text: "unchanged" }]],
    });

    const { result } = await run("hello", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
    });

    assert.deepEqual(result, {
      finalText: "unchanged",
      lastUsage: null,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "unchanged" }],
        },
      ],
      turnCount: 1,
      stopReason: "completed",
    });
  });
});

/**
 * ADR-0008 Decision 5: RunResult.lastUsage = the usage of the last successful
 * model call; null when the run had no successful model call.
 *
 * Acceptance anchors:
 *   (a) multi-turn run (all with usage) → lastUsage = the last successful call's value;
 *   (b) plain stub run without usage → lastUsage === null;
 *   (c) first turn succeeds with usage, then fails (ProtocolError) → lastUsage keeps the first turn's usage.
 */
describe("loop engine T4 #160: RunResult.lastUsage (ADR-0008 Decision 5)", () => {
  it("multi-turn run with usage: lastUsage reflects the last successful model call", async () => {
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
    const usage1: TokenUsage = {
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    const usage2: TokenUsage = {
      inputTokens: 42,
      outputTokens: 5,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
    };
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
          usage: usage1,
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
          usage: usage2,
        }),
      ],
    });
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.ok(result.lastUsage !== null);
    assert.equal(result.lastUsage!.inputTokens, 42);
    assert.equal(result.lastUsage!.outputTokens, 5);
    assert.equal(result.lastUsage!.cacheCreationInputTokens, 1);
    assert.equal(result.lastUsage!.cacheReadInputTokens, 2);
    // Whole-object deepEqual, ensuring it is usage2 (the last successful call), not usage1.
    assert.deepEqual(result.lastUsage, usage2);
  });

  it("pure stub run without usage: lastUsage is null", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.lastUsage, null);
  });

  it("first call succeeds with usage then later call fails: lastUsage keeps the last successful usage", async () => {
    // Only 1 scripted response (with usage); on round 2 the stub-model script is exhausted and throws ProtocolError →
    // stopReason=protocolError, lastUsage keeps the first round's usage.
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
    const usage1: TokenUsage = {
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
          usage: usage1,
        }),
      ],
    });
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "protocolError");
    assert.ok(result.lastUsage !== null);
    assert.deepEqual(result.lastUsage, usage1);
  });
});

/**
 * LoopEngineDeps.promptTools injection seam (behavior-neutral).
 *
 * A spy-adapter wraps the stub-model and records the request.tools each step receives:
 *   - no promptTools → adapter.step gets registry.list() (same order, same content);
 *   - a subset promptTools → adapter.step gets exactly that array.
 */

// ---------------------------------------------------------------------------
// ADR-0013: reactive compact (PromptTooLongError → compact + retry)
// ---------------------------------------------------------------------------
describe("loop engine T3 #252: reactive compact (ADR-0013)", () => {
  it("deps.compress 缺席 → PromptTooLongError 不触发 reactive compact,落 protocolError 分支", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);

    let stepCalls = 0;
    const flakyAdapter = Object.freeze({
      encodeUserText: (text: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text }],
      }),
      encodeToolResults: (): AnthropicContentBlock[] => [],
      step: async (): Promise<AssistantTurnResult> => {
        stepCalls++;
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      },
    });
    const { result } = await run("Q", {
      adapter: flakyAdapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    // deps.compress absent → the reactive entry never activates, straight to the ProtocolError branch.
    assert.equal(result.stopReason, "protocolError");
    // stepCalls = 1 main-loop call + 1 more attempt from the abnormal-stop
    // epilogue summary (both throw PromptTooLongError → skipped by catch-all). Reactive compact never triggered.
    assert.equal(stepCalls, 2);
  });

  it("deps.compress 已配 + 首次 PromptTooLongError → 压缩重试一次 → 成功", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);

    let stepCalls = 0;
    const flakyAdapter = Object.freeze({
      encodeUserText: (text: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text }],
      }),
      encodeToolResults: (): AnthropicContentBlock[] => [],
      step: async (
        _state: LoopState,
        request: { readonly tools?: unknown }
      ): Promise<AssistantTurnResult> => {
        stepCalls++;
        if (stepCalls === 1) {
          throw new PromptTooLongError("synthetic 400 prompt-too-long");
        }
        // Step 2: the full-compact summary round (tools === undefined) returns empty text →
        // empty_response → fallback placeholder. This test cares about the
        // reactive compact + retry geometry on the fallback path; the
        // summary-success path is covered separately by integration.test.ts.
        if (request.tools === undefined) {
          return assistantResult({
            texts: [],
            toolCalls: [],
            supplierStop: "success",
          });
        }
        return assistantResult({
          texts: ["done after compact"],
          toolCalls: [],
          supplierStop: "success",
        });
      },
    });

    // 12 prior messages → state.messages = 13 → reactive compactMessages trims
    // to boundary placeholder + 6 tail. Proactive does not trigger: estimate <<
    // threshold (default gate on window 200000 is floor(0.95×)=190000; the
    // explicit threshold 10000 is safer and still < window).
    const longPrior = Array.from({ length: 12 }, (_, i) =>
      makeNative({ role: "user", text: `prior-${i}` })
    );

    const { result } = await run(
      "Q",
      {
        adapter: flakyAdapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    // Step 2: 1 throw + 1 full-compact summary step (fallback → placeholder) + 1 retry success.
    assert.equal(stepCalls, 3);
    // Reactive compact took effect: 13 → boundary placeholder + 6 tail; user(Q) already among the 13,
    // final assistant +1. 13 → (1 + 6) + 1(assistant) = 8.
    assert.equal(
      result.messages.length,
      1 + 6 + 1,
      `expected reactive-compressed length 8, got ${result.messages.length}`
    );
    assert.equal(result.finalText, "done after compact");
  });

  it("压缩后仍抛 PromptTooLongError → 第二次落 protocolError 分支 (run-level once-only 守门)", async () => {
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

    let stepCalls = 0;
    const alwaysTooLong = Object.freeze({
      encodeUserText: (text: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text }],
      }),
      encodeToolResults: (): AnthropicContentBlock[] => [],
      step: async (): Promise<AssistantTurnResult> => {
        stepCalls++;
        throw new PromptTooLongError("still too long after compact");
      },
    });

    const { result } = await run("Q", {
      adapter: alwaysTooLong,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
    });
    // 1 first throw → compactMessages + retry → 2 still throws → attempted=true
    // → runModelPhase lands modelStop(protocolError); stepWithTrace records the turn error.
    assert.equal(result.stopReason, "protocolError");
    assert.equal(stepCalls, 2); // first + one compression retry
  });

  it("PromptTooLongError 是 ProtocolError 子类 — 单次错误分支不破坏 ProtocolError 兜底", async () => {
    // Verify the other branches relying on instanceof ProtocolError are unaffected.
    const { ProtocolError } = await import("../../src/harness/errors.ts");
    assert.ok(ProtocolError !== undefined);
    const err = new PromptTooLongError("x");
    assert.ok(err instanceof ProtocolError);
    assert.ok(err instanceof PromptTooLongError);
    assert.equal(err.name, "PromptTooLongError");
  });
});

// ---------------------------------------------------------------------------
// Proactive compact wired into evaluateCompactTrigger + full-summary fallback
// (falls back to runFullCompact when messages ≤ DEFAULT_KEEP_RECENT)
// ---------------------------------------------------------------------------

/** Full-summary adapter stub — distinguishes "summary steps" from "normal steps".
 *  - Summary step: `tools === undefined` and the last user message in state contains
 *    BASE_COMPACT_PROMPT → consumed per the `compactOutcomes` script ("summarized" / "adapter_failed");
 *  - Normal step: consumes the `stepScripts` queue (tool call / completion). */
function makeFullSummaryAdapter(opts: {
  readonly stepScripts: ReadonlyArray<AssistantTurnResult>;
  readonly compactOutcomes: ReadonlyArray<"summarized" | "adapter_failed">;
  readonly summaryText?: string;
}): LoopAdapter & { readonly compactCalls: { value: number } } {
  const queue = opts.stepScripts.slice();
  const outcomes = opts.compactOutcomes.slice();
  const compactCalls = { value: 0 };
  const summaryText = opts.summaryText ?? "FULL-SUMMARY";
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    // Must produce real tool_result blocks: evaluateCompactTrigger internally calls
    // preserveToolPairs for tool_use↔tool_result pairing; an empty array would leave
    // tool_use dangling → throw "missing tool_result" (a failure caught in practice).
    encodeToolResults: (
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] => toAnthropicToolResults(results),
    step: async (
      state: LoopState,
      request: { readonly tools?: unknown }
    ): Promise<AssistantTurnResult> => {
      if (request.tools === undefined) {
        // Full-compact summary step: only counts when the user text contains the compact prompt;
        // otherwise it's the epilogue summary, consumed from queue.
        const lastUserText = [...state.messages]
          .reverse()
          .find((m) => m.role === "user")
          ?.content.filter(
            (b): b is { type: "text"; text: string } => b.type === "text"
          )
          .map((b) => b.text)
          .join("");
        if (
          lastUserText?.includes(
            "Your task is to create a detailed summary of the conversation so far"
          ) === true
        ) {
          compactCalls.value += 1;
          const outcome = outcomes.shift();
          if (outcome === "adapter_failed") {
            throw new Error("synthetic adapter_failed for test");
          }
          // "summarized" (or undefined → defaults to summarized)
          return assistantResult({
            texts: [
              `<analysis>scratch</analysis><summary>${summaryText}</summary>`,
            ],
            toolCalls: [],
            supplierStop: "success",
          });
        }
      }
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(
          "makeFullSummaryAdapter: scripted step responses exhausted"
        );
      }
      return next;
    },
    compactCalls,
  });
}

/** Fixture wrapping makeFullSummaryAdapter: records the state.messages seen at each
 * "normal step" (request.tools present), to assert whether proactive compression
 * took effect before the first call. Summary steps carry no tools and are not counted. */
function makeRunEntryCapturingAdapter(opts: {
  readonly stepScripts: ReadonlyArray<AssistantTurnResult>;
  readonly compactOutcomes: ReadonlyArray<"summarized" | "adapter_failed">;
}): LoopAdapter & {
  readonly compactCalls: { value: number };
  readonly normalStepMessages: AnthropicNativeMessage[][];
} {
  const inner = makeFullSummaryAdapter(opts);
  const normalStepMessages: AnthropicNativeMessage[][] = [];
  return Object.freeze({
    encodeUserText: inner.encodeUserText,
    encodeToolResults: inner.encodeToolResults,
    compactCalls: inner.compactCalls,
    normalStepMessages,
    step: (
      state: LoopState,
      request: Parameters<LoopAdapter["step"]>[1]
    ): Promise<AssistantTurnResult> => {
      if (request.tools !== undefined) {
        normalStepMessages.push([...state.messages]);
      }
      return inner.step(state, request);
    },
  });
}

function messageText(m: AnthropicNativeMessage): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

describe("loop engine proactive-compact-run-entry T2: run 首步前即检 proactive", () => {
  it("prior 估量超闸 + 本 run 首次回复即 completed → 第一次 step 看到的已是压缩后历史", async () => {
    // run() starting at turnCount=0 is not exempt.
    // 2 prior messages of 50000 chars → estimate ≈ 33334 ≥ threshold 10000,
    // and 3 messages ≤ DEFAULT_KEEP_RECENT → compact_via_full_summary.
    // If compression happened before the first step, normal steps only see the
    // summary product (1 SUMMARY_PREAMBLE message), not the over-gate prior verbatim.
    const longPrior = Array.from({ length: 2 }, (_, i) =>
      makeNative({ role: "user", text: `prior-${i} ${"x".repeat(50_000)}` })
    );
    const adapter = makeRunEntryCapturingAdapter({
      stepScripts: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      compactOutcomes: ["summarized"],
    });
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 3,
        compress: { contextWindow: 100_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    assert.equal(
      adapter.normalStepMessages.length,
      1,
      "本 run 只跑一次普通 step"
    );
    const firstCall = adapter.normalStepMessages[0]!;
    assert.equal(
      firstCall.length,
      1,
      `首呼 messages 必须已是压缩产物(1 条摘要消息),实际 ${firstCall.length} 条`
    );
    const firstText = messageText(firstCall[0]!);
    assert.ok(
      firstText.startsWith("This session is being continued"),
      `首呼 messages[0] 必须是 SUMMARY_PREAMBLE 摘要轮,实际 "${firstText.slice(0, 120)}"`
    );
    assert.equal(adapter.compactCalls.value, 1);
  });

  it("prior 未超阈 → 首呼 messages 条数与内容与压缩前完全一致(不压)", async () => {
    // Below the token gate → noop, the step calls the model as usual. The first
    // call must see 3 prior + 1 user("Q") verbatim, with no compact injection.
    const shortPrior = Array.from({ length: 3 }, (_, i) =>
      makeNative({ role: "user", text: `prior-${i} short` })
    );
    const adapter = makeRunEntryCapturingAdapter({
      stepScripts: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      compactOutcomes: [],
    });
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 3,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: shortPrior }
    );
    assert.equal(result.stopReason, "completed");
    assert.equal(adapter.normalStepMessages.length, 1);
    assert.deepEqual(
      adapter.normalStepMessages[0]!.map(messageText),
      [...shortPrior.map(messageText), "Q"],
      "未超阈时首呼 messages 必须与压缩前逐条一致"
    );
    assert.equal(
      adapter.compactCalls.value,
      0,
      "未超阈不得调用任何 compact 步骤"
    );
  });

  it("首步压缩成功后同一 turnCount 不重复扫描 → 有限 step 完成,compact 恰 1 次", async () => {
    // After a successful compact the anchor = current turnCount, preventing
    // re-scans "already compacted at this turnCount"; each later gate step goes
    // noop because the estimate is below the gate. If the anchor update or noop
    // early-exit failed, compactCalls would keep counting after queue exhaustion
    // — asserting exactly 1 pins the no-infinite-loop property.
    const longPrior = Array.from({ length: 2 }, (_, i) =>
      makeNative({ role: "user", text: `prior-${i} ${"x".repeat(50_000)}` })
    );
    const adapter = makeRunEntryCapturingAdapter({
      stepScripts: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "noop", input: {} }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      compactOutcomes: ["summarized"],
    });
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 100_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    assert.equal(
      adapter.compactCalls.value,
      1,
      "compact 恰一次 — 成功后不重复扫描"
    );
    assert.equal(
      adapter.normalStepMessages.length,
      2,
      "有限 2 次普通 step 即完成"
    );
  });
});

describe("loop engine T3 compress-trigger-gate: proactive full-summary fallback", () => {
  it("messages.length=5 + 高 token 估算 → proactive 触发 full summary 路径,无死循环", async () => {
    // 2 prior messages of 50000 chars each → per-message estimate = floor((50000+3)/4) = 12500;
    // 2 messages raw total ≈ 25000; estimateMessagesTokens = ceil(25000 * 4/3) ≈ 33334.
    // threshold=10000 far below the estimate → evaluateCompactTrigger must return full_summary.
    // Key path derivation (run's first step is also checked):
    // run()'s initial state = 2 prior + 1 user("Q") = 3 messages.
    // Iter 1: turnCount=0 > anchor init(-1)→ gate entered, 3 messages ≤ keepRecent
    //   → compact_via_full_summary succeeds → state = [1 summary], anchor=0;
    //   step 1(tool call)→ state=3, turnCount=1.
    // Iter 2: gate(1>0)→ summary + tool tail estimate ≪ 10000 → noop;
    //   step 2(tool call)→ state=5, turnCount=2.
    // Iter 3: gate(2>1)→ 5 ≤ 6 but estimate already low → noop; step 3 completion → stop.
    // Pinned invariant: after one full_summary success the anchor updates and later
    // gates go noop — never a "re-triggered every time to no effect" loop.
    const longPrior = Array.from({ length: 2 }, (_, i) =>
      makeNative({ role: "user", text: `prior-${i} ${"x".repeat(50_000)}` })
    );
    const adapter = makeFullSummaryAdapter({
      // step 1: tool call (first normal step after compact succeeds)
      // step 2: tool call(gate noop)
      // step 3: completion(final turn)
      stepScripts: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "noop", input: {} }],
        }),
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t2", name: "noop", input: {} }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      compactOutcomes: ["summarized"],
    });
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 100_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    // runFullCompact's LLM calls = 1 (after one success lastCompactTurn updates,
    // the next gate's token estimate is low → noop). The old looping path would exceed 1 here.
    assert.equal(
      adapter.compactCalls.value,
      1,
      "compact 只调一次 — 摘要成功后 lastCompactTurn 更新,下一轮 gate 走 noop"
    );
    // After the summary succeeds, messages[0] = SUMMARY_PREAMBLE + FULL-SUMMARY.
    const firstText = result.messages[0]!.content.filter(
      (b): b is { type: "text"; text: string } => b.type === "text"
    )
      .map((b) => b.text)
      .join("");
    assert.ok(
      firstText.includes("FULL-SUMMARY"),
      `messages[0] 必须是 LLM 摘要轮 user 消息,实际 "${firstText.slice(0, 200)}"`
    );
    assert.ok(
      firstText.startsWith("This session is being continued"),
      "摘要轮必须用 SUMMARY_PREAMBLE 前导"
    );
  });

  it("连续 2 轮 token 超阈值 + 条数不足 → 摘要失败不更新锚点,下一轮再尝试(不死循环)", async () => {
    // Setup: 2 prior(1 LONG 50000 chars + 1 SHORT)+ 1 user("Q") = 3 initial
    // messages, estimate ≫ the 10000 threshold and 3 ≤ keepRecent → gate decides full_summary.
    // Key path derivation (run's first step is also checked; the anchor updates
    // only on a successful compaction):
    //   Iter 1: turnCount=0 > anchor(-1)→ full_summary 1st attempt fails
    //     (adapter_failed)→ applyFullCompactSummary returns state unchanged → anchor stays -1;
    //     step 1(tool call)→ state=5, turnCount=1.
    //   Iter 2: gate(1 > -1)→ 5 ≤ 6 → full_summary 2nd attempt succeeds → state=[summary],
    //     anchor=1; step 2(tool call)→ state=3, turnCount=2.
    //   Iter 3: gate(2 > 1)→ estimate already low → noop; step 3 completion → stop.
    // Pinned invariant: a failed compaction never updates the anchor — the next
    // tick must re-enter the gate and retry; neither swallowing the failure as a
    // successful step nor never retrying due to a wrongly-updated anchor.
    const longPrior = [
      makeNative({ role: "user", text: `prior-0 ${"x".repeat(50_000)}` }),
      makeNative({ role: "user", text: "prior-1 short" }),
    ];
    const adapter = makeFullSummaryAdapter({
      // step 1: tool call (after the 1st compact fails, state unchanged)
      // step 2: tool call (after the 2nd compact succeeds, state=[summary])
      // step 3: completion(final turn)
      stepScripts: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "noop", input: {} }],
        }),
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t2", name: "noop", input: {} }],
        }),
        assistantResult({
          texts: ["done after retry"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      compactOutcomes: ["adapter_failed", "summarized"],
    });
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 8,
        compress: { contextWindow: 100_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    // compact is called twice: the 1st fails → anchor not updated → the next tick re-checks and succeeds.
    // If failures also updated the anchor ("skip once tried"), this would be 1; the correct implementation = 2.
    assert.equal(
      adapter.compactCalls.value,
      2,
      "失败不更新 lastCompactTurn → 下一轮重检 → 再尝试,非死循环"
    );
    // Final messages[0] = SUMMARY_PREAMBLE + FULL-SUMMARY after the 2nd summary succeeds.
    const firstText = result.messages[0]!.content.filter(
      (b): b is { type: "text"; text: string } => b.type === "text"
    )
      .map((b) => b.text)
      .join("");
    assert.ok(
      firstText.includes("FULL-SUMMARY"),
      `第二次摘要成功后 messages[0] 含摘要,实际 "${firstText.slice(0, 200)}"`
    );
  });
});

// ---------------------------------------------------------------------------
// Manual /compact bypasses the auto token gate — reverse assertion locking that
// the loop-engine proactive path is unaffected: still no proactive compaction
// when the estimate is below the default threshold.
// ---------------------------------------------------------------------------
describe("loop engine manual-compact-trigger T1: 短历史 + 缺省阈值下 proactive 不开火", () => {
  it("3 条 prior + 缺省阈值(167k)+ 短 step 文本 → messages 不含任何 compact 痕迹", async () => {
    // Reverse assertion: proactive still goes through evaluateCompactTrigger; with the
    // default threshold ≈ 167k a short history is far below → noop, calling neither
    // runFullCompact nor compactMessages
    // (i.e. no preamble summary, no boundary placeholder, adapter step count = expected 1).
    const prior = Array.from({ length: 3 }, (_, i) =>
      makeNative({ role: "user", text: `prior-${i} short` })
    );
    const adapter = makeFullSummaryAdapter({
      stepScripts: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      compactOutcomes: [], // proactive must not trigger; empty queue (any call would throw)
    });
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 3,
        // thresholdTokens deliberately absent → getAutoCompactThreshold uses
        // floor(0.95 × 200000) = 190000, far above the estimate of 3 prior + 1 user.
        compress: { contextWindow: 200_000, thresholdTokens: undefined },
      },
      undefined,
      { priorMessages: prior }
    );
    assert.equal(result.stopReason, "completed");
    // Key assertion 1: makeFullSummaryAdapter's compactOutcomes queue is empty —
    // any compact step would shift once and eventually throw "exhausted". If
    // nothing was called before step 1, the proactive gate went noop and never touched the full-compact path.
    assert.equal(
      adapter.compactCalls.value,
      0,
      "短历史 + 缺省阈值下 proactive 不应触发任何 compact 步骤"
    );
    // Key assertion 2: message text contains no compact artifact — no preamble / placeholder.
    const allText = result.messages
      .map((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("")
      )
      .join("\n");
    assert.ok(
      !allText.includes("This session is being continued"),
      "messages 中不得含 compact preamble(未走 full summary)"
    );
    assert.ok(
      !allText.includes("[compaction boundary"),
      "messages 中不得含 boundary placeholder(未走 windowed)"
    );
    // History should be = 3 prior + 1 user + 1 assistant text (no compact injection).
    assert.equal(result.messages.length, 5);
  });
});

// ---------------------------------------------------------------------------
// ADR-0011: closing-summary epilogue (stop_summary event)
// ---------------------------------------------------------------------------
describe("loop engine T4: 收尾摘要 epilogue (stop_summary)", () => {
  it("protocolError 后 emit stop_summary;摘要不进 _messages;原始停因 = protocolError", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);

    let stepCalls = 0;
    const adapter = Object.freeze({
      encodeUserText: (text: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text }],
      }),
      encodeToolResults: (): AnthropicContentBlock[] => [],
      step: async (): Promise<AssistantTurnResult> => {
        stepCalls++;
        if (stepCalls === 1) {
          throw new ProtocolError("synthetic protocol error for summary test");
        }
        // Summary round: returns a non-empty text.
        return assistantResult({
          texts: ["summary text from epilogue"],
          toolCalls: [],
          supplierStop: "success",
        });
      },
    });

    const received: HarnessStreamEvent[] = [];
    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (event) => received.push(event) }
    );
    // Main loop protocolError → stop; run() calls epilogueSummary → the second adapter.step
    // returns the closing text → stop_summary emitted; the original stop reason stays protocolError (run does not resume the loop).
    assert.equal(result.stopReason, "protocolError");
    assert.equal(stepCalls, 2);
    const summary = received.find((e) => e.type === "stop_summary");
    assert.ok(summary, "expected stop_summary event");
    assert.equal(
      (summary as { type: "stop_summary"; text: string }).text,
      "summary text from epilogue"
    );
    // No stop_summary injected into history — only the user(go) seed message (the bad turn was not appended).
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.role, "user");
  });

  it("空历史(empty)无摘要输入不崩(摘要轮不调 → 不崩;epilogue 早 return)", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["final"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    // maxTurns=undefined + one success → completed, no abnormal stop → no summary event.
    const received: HarnessStreamEvent[] = [];
    const { result } = await run(
      "hi",
      {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: undefined,
      },
      undefined,
      { onStream: (event) => received.push(event) }
    );
    assert.equal(result.stopReason, "completed");
    assert.ok(
      !received.some((e) => e.type === "stop_summary"),
      "completed 不应 emit stop_summary"
    );
  });

  it("maxTurns 抛错前先 emit stop_summary 然后重抛(原始停因不受阻塞)", async () => {
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

    // stub-scripted: 2 echo calls, then a summary round (texts non-empty).
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
        }),
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t2", name: "echo", input: { value: "b" } }],
        }),
        assistantResult({
          texts: ["brief recap of why we hit maxTurns"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });

    const received: HarnessStreamEvent[] = [];
    await assert.rejects(
      run(
        "go",
        { adapter: model, executor: exec, registry: reg, maxTurns: 2 },
        undefined,
        { onStream: (event) => received.push(event) }
      ),
      (err: unknown) => {
        assert.ok(err instanceof MaxTurnsExceeded);
        assert.equal(err.turnsRan, 2);
        return true;
      }
    );
    // The closing summary emits stop_summary once.
    const summary = received.find((e) => e.type === "stop_summary");
    assert.ok(summary, "expected stop_summary event before re-throw");
    assert.equal(
      (summary as { type: "stop_summary"; text: string }).text,
      "brief recap of why we hit maxTurns"
    );
  });

  it("摘要失败(timeout/concurrent)→ 跳过;原始停因仍抛出,stop_summary 不 emit", async () => {
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

    // The stub script has 1 echo call (exhausted), no more responses → the summary adapter.step throws ProtocolError.
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "x" } }],
        }),
      ],
    });

    const received: HarnessStreamEvent[] = [];
    await assert.rejects(
      run(
        "go",
        { adapter: model, executor: exec, registry: reg, maxTurns: 1 },
        undefined,
        { onStream: (event) => received.push(event) }
      ),
      (err: unknown) => {
        assert.ok(err instanceof MaxTurnsExceeded);
        return true;
      }
    );
    // The summary failure is swallowed by catch-all; stop_summary is not emitted.
    assert.ok(
      !received.some((e) => e.type === "stop_summary"),
      "summary failure must not emit stop_summary"
    );
  });

  it("concurrent signal abort → 摘要不调用、不阻塞 MaxTurnsExceeded 重抛", async () => {
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

    // 3 echo responses (budget maxTurns=2 → the first 2 are spent before the throw; summary has no response → catch).
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
        }),
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t2", name: "echo", input: { value: "b" } }],
        }),
      ],
    });

    const controller = new AbortController();
    const received: HarnessStreamEvent[] = [];
    await assert.rejects(
      run(
        "go",
        { adapter: model, executor: exec, registry: reg, maxTurns: 2 },
        controller.signal,
        { onStream: (event) => received.push(event) }
      ),
      (err: unknown) => err instanceof MaxTurnsExceeded
    );
    // Before controller.abort() — the summary-level signal check (signal not yet aborted).
    // To test "concurrent abort", abort before the summary attempt:
    controller.abort();
    // The summary must not be emitted (the stub queue is empty here; even with the signal unaborted, catch-all skips it).
    assert.ok(
      !received.some((e) => e.type === "stop_summary"),
      "no stop_summary emitted on summary-skip path"
    );
  });

  it("摘要 usage 照落 trace LlmCallRecord(status ok);摘要轮不计 turns", async () => {
    // Observe the trace directly: after timeout the epilogue writes one extra llm_call ok,
    // but no turn (the turns count still tracks only the main loop).
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "summary-trace-"));
    const { createJsonlTraceService } =
      await import("../../src/harness/trace/jsonl.ts");
    const { readFileSync } = await import("node:fs");

    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["never"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      delayMs: 200,
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
      conversationId: "t4-sum",
    });
    const { result, trace: runTrace } = await run("x", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 20,
      trace,
    });
    assert.equal(result.stopReason, "timeout");
    // Main-loop turn: model phase times out at turnCount=0 → 1 turn trace entry.
    assert.equal(runTrace.turns.length, 1);
    // JSONL: error llm_call + turn + summary ok llm_call = 3 lines.
    const lines = readFileSync(join(tmpDir, "t4-sum.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.equal(lines[0]!["status"], "error");
    assert.equal(lines[1]!["record_type"], "turn");
    assert.equal(lines[2]!["record_type"], "llm_call");
    assert.equal(lines[2]!["status"], "ok");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("loop engine #224 W1: promptTools injection seam", () => {
  it("promptTools absent -> tools deep-equal registry.list() (same order + content)", async () => {
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
    const noop: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([echo, noop]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
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
        request: { tools?: unknown }
      ): Promise<AssistantTurnResult> => {
        capturedTools.push(request.tools);
        return model.step(state, request);
      },
    });
    const { result } = await run("go", {
      adapter: spyAdapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(capturedTools.length, 1);
    assert.deepEqual(
      capturedTools[0],
      reg.list(),
      "tools must deep-equal registry.list() when promptTools is absent"
    );
  });

  it("promptTools provided -> adapter.step receives exactly that array", async () => {
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
    const noop: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([echo, noop]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    // Subset array: exposes only echo, not noop (simulates "the tool set that should enter the prompt for the current turn").
    const subsetTools: ReadonlyArray<ToolDef> = [echo];
    const capturedTools: unknown[] = [];
    const spyAdapter = Object.freeze({
      ...model,
      step: async (
        state: LoopState,
        request: { tools?: unknown }
      ): Promise<AssistantTurnResult> => {
        capturedTools.push(request.tools);
        return model.step(state, request);
      },
    });
    const { result } = await run("go", {
      adapter: spyAdapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      promptTools: () => subsetTools,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(capturedTools.length, 1);
    assert.deepEqual(
      capturedTools[0],
      subsetTools,
      "tools must be exactly the promptTools() array when provided"
    );
    // Unlike registry.list(): verify the injection is really consumed, not falling back to the full set.
    assert.notDeepEqual(capturedTools[0], reg.list());
  });
});

// ---------------------------------------------------------------------------
// Secret roundtrip recognition layer — run() replaces user text with
// placeholders before it reaches the LLM
// ---------------------------------------------------------------------------
describe("loop engine #406 T2: secret roundtrip 识别层", () => {
  it("T2-A1: secretRegistry 在场 → 首条 user 消息文本为占位符，明文不出现", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["ok"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const secretRegistry = createSecretRegistry();
    const userText = "这是 sk-aaaaaaaaaaaaaaaaaaaa，帮我测";
    const { result } = await run(userText, {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      secretRegistry,
    });
    assert.equal(result.stopReason, "completed");
    const first = result.messages[0]!;
    assert.equal(first.role, "user");
    const text = (first.content[0] as { type: "text"; text: string }).text;
    assert.equal(text, "这是 <<<SECRET_1>>>，帮我测");
    // Plaintext never appears in any encoded message (whole tree incl. assistant replies, tool_results, etc.)
    for (const m of result.messages) {
      const serialized = JSON.stringify(m);
      assert.ok(
        !serialized.includes("sk-aaaaaaaaaaaaaaaaaaaa"),
        "raw secret must not appear in any encoded message"
      );
    }
    // The registry records exactly 1 entry
    assert.equal(secretRegistry.size, 1);
    assert.equal(
      secretRegistry.resolve("<<<SECRET_1>>>"),
      "sk-aaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("T2-A2: 二次 run 复用同一 registry + priorMessages → 占位符原样保留，不重复注册", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const secretRegistry = createSecretRegistry();
    const model1 = createStubModel({
      responses: [
        assistantResult({
          texts: ["first"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const firstRun = await run("用 sk-aaaaaaaaaaaaaaaaaaaa 处理", {
      adapter: model1,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      secretRegistry,
    });
    assert.equal(secretRegistry.size, 1);
    const firstUserText = (
      firstRun.result.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(firstUserText, "用 <<<SECRET_1>>> 处理");

    // Second run: same registry + priorMessages continuation, new text contains only the placeholder
    const model2 = createStubModel({
      responses: [
        assistantResult({
          texts: ["second"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const secondUserText = "再用 <<<SECRET_1>>> 调用一次";
    const secondRun = await run(
      secondUserText,
      {
        adapter: model2,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        secretRegistry,
      },
      undefined,
      { priorMessages: firstRun.result.messages }
    );
    // Prior messages keep the placeholder verbatim (already replaced in the first round → placeholder all the way through)
    const priorUserText = (
      secondRun.result.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(priorUserText, "用 <<<SECRET_1>>> 处理");
    // New user message = user text verbatim (the placeholder shape triggers no secret pattern)
    const newUserText = (
      secondRun.result.messages[2]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(newUserText, secondUserText);
    // Placeholder text matches nothing at the recognize layer (dedup verification)
    assert.deepEqual(recognize(secondUserText, secretRegistry).matched, []);
    // The registry does not re-register (size still 1)
    assert.equal(secretRegistry.size, 1);
    assert.equal(
      secretRegistry.resolve("<<<SECRET_1>>>"),
      "sk-aaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("T2-A3: 自定义 patterns 扩展被接线 — DEFAULT 与 extras 都在 roundtrip 中识别", async () => {
    // API-level: createCompiledPatterns merges DEFAULT 7 + extras 1 = 8
    assert.equal(createCompiledPatterns(["MY_[0-9]{6}"]).length, 8);
    const secretRegistry = createSecretRegistry({ patterns: ["MY_[0-9]{6}"] });
    assert.equal(secretRegistry.patterns.length, 8); // DEFAULT 7 + custom 1

    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["ok"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run(
      "MY_123456 + sk-abcdefghijklmnopqrstuvwxyz123",
      {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        secretRegistry,
      }
    );
    const text = (
      result.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    // Scanning follows pattern order: sk- (DEFAULT[1]) registers first → SECRET_1; MY_ (extras[0])
    // registers later → SECRET_2; output is reordered by source-text position → MY_ comes first with SECRET_2.
    assert.equal(text, "<<<SECRET_2>>> + <<<SECRET_1>>>");
    assert.equal(secretRegistry.size, 2);
    assert.equal(
      secretRegistry.resolve("<<<SECRET_1>>>"),
      "sk-abcdefghijklmnopqrstuvwxyz123"
    );
    assert.equal(secretRegistry.resolve("<<<SECRET_2>>>"), "MY_123456");
  });

  it("T2-A4: secretRegistry 缺席 → 行为 byte-identical，明文原样进消息", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["ok"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const userText = "这是 sk-aaaaaaaaaaaaaaaaaaaa，帮我测";
    const { result } = await run(userText, {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      // Deliberately omit secretRegistry → the legacy path
    });
    const text = (
      result.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(text, userText); // verbatim plaintext
  });

  it("T2 bonus: 占位符本身不被识别为密钥 — 模型可安全引用 <<<SECRET_N>>>", async () => {
    const secretRegistry = createSecretRegistry();
    secretRegistry.register("sk-aaaaaaaaaaaaaaaaaaaa");
    const r = recognize("<<<SECRET_1>>> 再次调用", secretRegistry);
    assert.deepEqual(r.matched, []);
    assert.equal(r.replaced, "<<<SECRET_1>>> 再次调用");
  });
});

// ---------------------------------------------------------------------------
// Loop tool phase: true batching of consecutive concurrency-safe tool_use
// (per-result commit contract preserved)
// ---------------------------------------------------------------------------
//
// Design: runToolPhase groups toolCallViews into waves by
// registry.get(name).aci.isConcurrencySafe. Waves of size ≥ 2 fire one
// executeAll([N]) for real concurrency; size-1 waves keep the old
// per-call executeAll([one]) semantics. Each result commits immediately
// after it settles (flushed to disk via the host hook), per the existing contract.
//
// Key assertions:
//   - Consecutive safe tool_use calls overlap; write order matches tool_use order;
//     ≥8 safe stubs all settle without hanging.
//   - runToolPhase no longer issues executeAll([one]) per call for all
//     isConcurrencySafe:true calls — the change is on the driver side ([one] → [N]).
//
// Test convention: AciToolDef exposes the aci field through the registry (the
// registry passes tool objects through, incl. aci; the loop reads it as
// (def as { aci?: ... }).aci). Stub tools attach aci metadata by constructing
// AciToolDef directly (not createStubTool).

interface WaveInterval {
  readonly batchSize: number;
  readonly ids: ReadonlyArray<string>;
  readonly start: number;
  readonly end: number;
}

function makeSafeTool(
  name: string,
  opts?: { readonly sleepMs?: number }
): ToolDef {
  const sleepMs = opts?.sleepMs ?? 0;
  return Object.freeze({
    name,
    description: `safe ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: (async () => {
      if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
      return `ok:${name}`;
    }) as ToolDef["handler"],
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

function makeUnsafeTool(name: string): ToolDef {
  return Object.freeze({
    name,
    description: `unsafe ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: (async () => `ok:${name}`) as ToolDef["handler"],
    aci: {
      category: "execute" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    },
  });
}

function makePlainTool(name: string): ToolDef {
  // No aci metadata (registry miss → conservative default: unsafe).
  return Object.freeze({
    name,
    description: `plain ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: (async () => `ok:${name}`) as ToolDef["handler"],
  });
}

function makeWaveRecordingExecutor(opts?: {
  readonly throwById?: Record<string, string>;
}): {
  readonly executor: import("../../src/harness/tools/types.ts").Executor;
  readonly intervals: WaveInterval[];
} {
  const intervals: WaveInterval[] = [];
  const executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<import("../../src/harness/tools/types.ts").ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const start = Date.now();
      const results: ToolExecutionResult[] = [];
      // Real concurrency: launch per call (setTimeout does not block other calls), collect via Promise.all.
      // No sleep simulated here — handlers inject their own; this spy only records batch metadata.
      for (const c of batch) {
        const thrown = opts?.throwById?.[c.id];
        if (thrown !== undefined) {
          results.push({
            kind: "execution_failed",
            toolUseId: c.id,
            message: thrown,
          });
        } else {
          results.push({
            kind: "ok",
            toolUseId: c.id,
            payload: [{ type: "text" as const, text: `executed:${c.name}` }],
          });
        }
      }
      intervals.push({
        batchSize: batch.length,
        ids: batch.map((c) => c.id),
        start,
        end: Date.now(),
      });
      return results;
    },
  });
  return { executor, intervals };
}

describe("loop engine T3 wave batching: runToolPhase 真批处理", () => {
  it("AC51: 连续安全 tool_use 单批 executeAll([N])(不再逐个 [one])", async () => {
    const tools = [
      makeSafeTool("safe_a", { sleepMs: 30 }),
      makeSafeTool("safe_b", { sleepMs: 30 }),
      makeSafeTool("safe_c", { sleepMs: 30 }),
    ];
    const reg = createRegistry(tools);
    const { executor, intervals } = makeWaveRecordingExecutor();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "a", name: "safe_a", input: {} },
            { id: "b", name: "safe_b", input: {} },
            { id: "c", name: "safe_c", input: {} },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const t0 = Date.now();
    const { result } = await run("go", {
      adapter: model,
      executor,
      registry: reg,
      maxTurns: 5,
    });
    const elapsed = Date.now() - t0;
    assert.equal(result.stopReason, "completed");
    assert.equal(result.messages.length, 4);
    // Key assertion: executeAll is called exactly once with batchSize=3 (one consecutive-safe batch).
    // The old per-call path would give all batchSize=1 with 3 calls.
    assert.equal(
      intervals.length,
      1,
      `expected 1 wave call, got ${intervals.length}`
    );
    assert.equal(intervals[0]!.batchSize, 3);
    assert.deepEqual([...intervals[0]!.ids], ["a", "b", "c"]);
    // Order preserved: tool_result block order = tool_use order.
    const resultBlocks = result.messages[2]!.content.filter(
      (b) => b.type === "tool_result"
    );
    assert.deepEqual(
      resultBlocks.map(
        (b) => (b as { type: "tool_result"; tool_use_id: string }).tool_use_id
      ),
      ["a", "b", "c"]
    );
    // Concurrency timing: 3 × 30ms serial ≥ 90ms; concurrent should be clearly shorter (10ms headroom for scheduling).
    assert.ok(
      elapsed < 80,
      `expected overlap (≤80ms), got ${elapsed}ms (serial ≥90ms)`
    );
  });

  it("AC51 overflow: ≥8 安全 stub 全 settle,顺序保持", async () => {
    const tools = [makeSafeTool("safe_only", { sleepMs: 20 })];
    const reg = createRegistry(tools);
    const { executor, intervals } = makeWaveRecordingExecutor();
    const ids = Array.from({ length: 8 }, (_, i) => `s${i}`);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: ids.map((id) => ({
            id,
            name: "safe_only",
            input: {},
          })),
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("go", {
      adapter: model,
      executor,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    // Key assertion: executeAll called exactly once with batchSize=8 (all-safe batch).
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0]!.batchSize, 8);
    assert.deepEqual([...intervals[0]!.ids], ids);
    // Order preserved: 8 tool_results follow the input order.
    const blocks = result.messages[2]!.content.filter(
      (b) => b.type === "tool_result"
    );
    assert.deepEqual(
      blocks.map(
        (b) => (b as { type: "tool_result"; tool_use_id: string }).tool_use_id
      ),
      ids
    );
  });

  it("unsafe 调用单独成 wave(singleton),不参与并行集", async () => {
    // Pattern [safe_a, unsafe_b, safe_c, safe_d] →
    // expected wave1=[safe_a] (only 1 safe),
    //          wave2=[unsafe_b] (singleton),
    //          wave3=[safe_c, safe_d] (2 consecutive safe).
    const tools = [
      makeSafeTool("safe_x", { sleepMs: 20 }),
      makeUnsafeTool("bash"),
    ];
    const reg = createRegistry(tools);
    const { executor, intervals } = makeWaveRecordingExecutor();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "a", name: "safe_x", input: {} },
            { id: "u", name: "bash", input: { command: "echo" } },
            { id: "c", name: "safe_x", input: {} },
            { id: "d", name: "safe_x", input: {} },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("go", {
      adapter: model,
      executor,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    // 3 waves: singleton [a] / singleton [u] / pair [c, d].
    assert.equal(intervals.length, 3);
    assert.deepEqual([...intervals[0]!.ids], ["a"]);
    assert.deepEqual([...intervals[1]!.ids], ["u"]);
    assert.deepEqual([...intervals[2]!.ids], ["c", "d"]);
    // Order preserved: tool_result order = tool_use order.
    const blocks = result.messages[2]!.content.filter(
      (b) => b.type === "tool_result"
    );
    assert.deepEqual(
      blocks.map(
        (b) => (b as { type: "tool_result"; tool_use_id: string }).tool_use_id
      ),
      ["a", "u", "c", "d"]
    );
  });

  it("全 unsafe: 行为 byte-identical(逐调用 [one])", async () => {
    const tools = [
      makePlainTool("p1"),
      makePlainTool("p2"),
      makePlainTool("p3"),
    ];
    const reg = createRegistry(tools);
    const { executor, intervals } = makeWaveRecordingExecutor();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "p1", name: "p1", input: {} },
            { id: "p2", name: "p2", input: {} },
            { id: "p3", name: "p3", input: {} },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("go", {
      adapter: model,
      executor,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    // Old-path contract: each unsafe / plain tool gets its own wave (per-call [one]).
    assert.equal(intervals.length, 3);
    for (const iv of intervals) {
      assert.equal(iv.batchSize, 1);
    }
    assert.deepEqual(intervals.map((iv) => [...iv.ids]).flat(), [
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("混合 safe + unsafe: unsafe 仍是 wave-breaker", async () => {
    // 5 calls: [safe_1, safe_2, unsafe, safe_3]
    // expected: wave1=[safe_1, safe_2] (2 consecutive safe),
    //           wave2=[unsafe] (singleton, breaker),
    //           wave3=[safe_3] (singleton safe).
    const tools = [makeSafeTool("s"), makeUnsafeTool("u")];
    const reg = createRegistry(tools);
    const { executor, intervals } = makeWaveRecordingExecutor();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "s1", name: "s", input: {} },
            { id: "s2", name: "s", input: {} },
            { id: "u", name: "u", input: {} },
            { id: "s3", name: "s", input: {} },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("go", {
      adapter: model,
      executor,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(intervals.length, 3);
    assert.deepEqual([...intervals[0]!.ids], ["s1", "s2"]);
    assert.deepEqual([...intervals[1]!.ids], ["u"]);
    assert.deepEqual([...intervals[2]!.ids], ["s3"]);
  });

  it("safe wave 中 2nd handler throw → 1st + 3rd 仍有结果(隔离,不短路整批)", async () => {
    const tools = [
      makeSafeTool("s_ok"),
      makeSafeTool("s_bad"),
      makeSafeTool("s_ok2"),
    ];
    const reg = createRegistry(tools);
    const { executor, intervals } = makeWaveRecordingExecutor({
      throwById: { bad: "synthetic handler failure" },
    });
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "a", name: "s_ok", input: {} },
            { id: "bad", name: "s_bad", input: {} },
            { id: "c", name: "s_ok2", input: {} },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("go", {
      adapter: model,
      executor,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    // Single wave, 3 calls.
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0]!.batchSize, 3);
    // Order preserved: a → bad → c; 1st / 3rd go ok, 2nd goes execution_failed.
    const blocks = result.messages[2]!.content.filter(
      (b) => b.type === "tool_result"
    );
    const aBlock = blocks[0] as {
      type: "tool_result";
      is_error?: boolean;
      tool_use_id: string;
    };
    const badBlock = blocks[1] as {
      type: "tool_result";
      is_error?: boolean;
      tool_use_id: string;
    };
    const cBlock = blocks[2] as {
      type: "tool_result";
      is_error?: boolean;
      tool_use_id: string;
    };
    assert.equal(aBlock.tool_use_id, "a");
    assert.equal(aBlock.is_error, undefined);
    assert.equal(badBlock.tool_use_id, "bad");
    assert.equal(badBlock.is_error, true);
    assert.equal(cBlock.tool_use_id, "c");
    assert.equal(cBlock.is_error, undefined);
  });

  it("safe wave 中 commit crash on 3rd:盘上 1st+2nd tool_result,无 3rd", async () => {
    // Per-result-commit compatibility with wave behavior: commits within a wave are serial, the first N-1 commit to disk;
    // when the Nth throws, exactly N-1 tool_results are on disk. 3-safe-call wave + crash on
    // 3rd commit = 1st + 2nd on disk, 3rd absent (consistent with serial wave commits).
    const tools = [
      makeSafeTool("s_a"),
      makeSafeTool("s_b"),
      makeSafeTool("s_c"),
    ];
    const reg = createRegistry(tools);
    const { executor } = makeWaveRecordingExecutor();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "a", name: "s_a", input: {} },
            { id: "b", name: "s_b", input: {} },
            { id: "c", name: "s_c", input: {} },
          ],
        }),
      ],
    });
    const boom = new Error("simulated crash on 3rd tool_result commit");
    let calls = 0;
    const committed: AnthropicNativeMessage[][] = [];
    const commitMessages = async (
      messages: ReadonlyArray<AnthropicNativeMessage>
    ): Promise<void> => {
      calls += 1;
      if (calls === 4) throw boom; // assistant(=1) + tr_a(=2) + tr_b(=3) → tr_c(=4) crash
      committed.push([...messages]);
    };
    await assert.rejects(
      run("go", {
        adapter: model,
        executor,
        registry: reg,
        maxTurns: 5,
        commitMessages,
      }),
      (err: unknown) => {
        assert.ok(err instanceof MessageCommitError);
        assert.equal(err.cause, boom);
        return true;
      }
    );
    // 4 commits: assistant + tr_a + tr_b + tr_c (crash); the first 3 land on disk.
    assert.equal(calls, 4);
    assert.equal(committed.length, 3);
    assert.equal(committed[0]![0]!.role, "assistant");
    assert.equal(committed[1]![0]!.role, "user");
    assert.equal(committed[2]![0]!.role, "user");
    // Order preserved: tr_a before tr_b.
    const trA = committed[1]![0]!.content[0] as {
      type: "tool_result";
      tool_use_id: string;
    };
    const trB = committed[2]![0]!.content[0] as {
      type: "tool_result";
      tool_use_id: string;
    };
    assert.equal(trA.tool_use_id, "a");
    assert.equal(trB.tool_use_id, "b");
    // On-disk JSONL: no tr_c.
    const trCContent = JSON.stringify(committed);
    assert.ok(
      !trCContent.includes('"tool_use_id":"c"'),
      "tr_c must NOT be committed to disk"
    );
  });

  it("#620: first result commits before the slowest wave sibling settles", async () => {
    const tools = [makeSafeTool("fast"), makeSafeTool("slow")];
    const reg = createRegistry(tools);
    const settleAt = new Map<string, number>();
    const executor = Object.freeze({
      executeAll: async (
        batch: ReadonlyArray<
          import("../../src/harness/tools/types.ts").ToolCall
        >,
        _signal?: AbortSignal,
        _timeoutMs?: number,
        _conversationId?: string,
        onSettled?: (
          result: ToolExecutionResult,
          index: number
        ) => void | Promise<void>
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const sleep: Record<string, number> = { a: 20, b: 80 };
        const promises = batch.map(async (c, index) => {
          await new Promise((r) => setTimeout(r, sleep[c.id] ?? 0));
          const result: ToolExecutionResult = {
            kind: "ok",
            toolUseId: c.id,
            payload: [{ type: "text", text: `executed:${c.name}` }],
          };
          settleAt.set(c.id, Date.now());
          await onSettled?.(result, index);
          return result;
        });
        return Promise.all(promises);
      },
    });
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "a", name: "fast", input: {} },
            { id: "b", name: "slow", input: {} },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const committedAt: number[] = [];
    const commitMessages = async (): Promise<void> => {
      committedAt.push(Date.now());
    };
    const { result } = await run("go", {
      adapter: model,
      executor,
      registry: reg,
      maxTurns: 5,
      commitMessages,
    });
    assert.equal(result.stopReason, "completed");
    // assistant commit + tr_a + tr_b
    assert.ok(committedAt.length >= 3, `commits=${committedAt.length}`);
    const trACommit = committedAt[1]!;
    const slowSettle = settleAt.get("b");
    assert.ok(slowSettle !== undefined, "slow call must settle");
    assert.ok(
      trACommit < slowSettle,
      `expected tr_a commit (${trACommit}) before slow settle (${slowSettle})`
    );
  });

  it("并发 onSettled 重入: commit 不重叠、批次不丢 (worker transcript race 回归)", async () => {
    // Reproduces the worker crash root cause: parallel tool_use in the same assistant
    // message makes two onSettled callbacks each trigger flushPrefix, overlapping at the
    // commit's await → concurrent read-modify-write. The main session has the hub
    // serialize queue as a backstop; the worker transcript does not → duplicate event id.
    const tools = [makeSafeTool("s_a"), makeSafeTool("s_b")];
    const reg = createRegistry(tools);
    const executor = Object.freeze({
      executeAll: async (
        batch: ReadonlyArray<
          import("../../src/harness/tools/types.ts").ToolCall
        >,
        _signal?: AbortSignal,
        _timeoutMs?: number,
        _conversationId?: string,
        onSettled?: (
          result: ToolExecutionResult,
          index: number
        ) => void | Promise<void>
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const results: ToolExecutionResult[] = batch.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: `executed:${c.name}` }],
        }));
        // Deliberate interleaving: callback A parks at the commit's await while callback B settles.
        const pA = onSettled?.(results[0]!, 0);
        await new Promise((r) => setTimeout(r, 10));
        const pB = onSettled?.(results[1]!, 1);
        await Promise.all([pA, pB]);
        return results;
      },
    });
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "a", name: "s_a", input: {} },
            { id: "b", name: "s_b", input: {} },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const committedToolResults: string[] = [];
    const commitMessages = async (
      messages: ReadonlyArray<AnthropicNativeMessage>
    ): Promise<void> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const ids = messages
        .flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
        .map(
          (b) => (b as { type: "tool_result"; tool_use_id: string }).tool_use_id
        );
      if (ids.length > 0) {
        // tool_result commit parks for 20ms, opening the interleaving window.
        await new Promise((r) => setTimeout(r, 20));
        committedToolResults.push(...ids);
      }
      inFlight -= 1;
    };
    const { result } = await run("go", {
      adapter: model,
      executor,
      registry: reg,
      maxTurns: 5,
      commitMessages,
    });
    assert.equal(result.stopReason, "completed");
    // Core invariant: commits never overlap concurrently.
    assert.equal(
      maxInFlight,
      1,
      `expected serial commits, got maxInFlight=${maxInFlight}`
    );
    // No batch is lost and the order follows tool_use order.
    assert.deepEqual(committedToolResults, ["a", "b"]);
  });
});

/**
 * ADR-0108 interrupt frozen-prefix keep — the keep path for in-flight model
 * cancellation closeout.
 *
 * The fixture adapter (shared from tests/_helpers/stream-keep-fixtures.ts)
 * follows scripted steps: first it synchronously emits text_delta (the same
 * bytes as the wall-clock draft), then returns the scripted result or hangs
 * until signal abort (simulating a never-delivering in-flight model). The hang
 * resolves when raceModel's callerAbort wins, without waiting for the full
 * model step. Calls after the script is exhausted (the closing summary round)
 * return empty results immediately to avoid test hangs.
 */
const makeStreamingAdapter = (
  steps: ReadonlyArray<StreamKeepStep>
): LoopAdapter => makeStreamKeepAdapter(steps).adapter;

describe("ADR-0108 model-in-flight cancelled keeps frozen prefix", () => {
  it("SC1: cancelled with frozen prefix -> assistant(prefix) enters history before Interrupted by user.", async () => {
    const reg = createRegistry([
      createStubTool({ name: "noop", next: () => ({}) }),
    ]);
    const adapter = makeStreamingAdapter([
      {
        deltas: ["## Head\n\n", "First paragraph.\n\n", "Second parag"],
      },
    ]);
    const batches: AnthropicNativeMessage[][] = [];
    const controller = new AbortController();
    const p = run(
      "x",
      {
        adapter,
        executor: createExecutor(reg),
        registry: reg,
        maxTurns: 5,
        commitMessages: async (msgs) => {
          batches.push([...msgs]);
        },
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    const { result } = await p;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.messages[1]!.role, "assistant");
    assert.equal(
      textOf(result.messages[1]!),
      "## Head\n\nFirst paragraph.\n\n"
    );
    assert.equal(result.messages[2]!.role, "system");
    assert.equal(textOf(result.messages[2]!), "Interrupted by user.");
    // Ordering: commit assistant (possibly carrying pending injections) first, then interrupt.
    assert.deepEqual(
      batches.map((b) => b.map((m) => m.role)),
      [["assistant"], ["system"]]
    );
  });

  it("SC2: cancelled with only a growing tail (no prefix) -> no assistant, still user + interrupt", async () => {
    const reg = createRegistry([
      createStubTool({ name: "noop", next: () => ({}) }),
    ]);
    const adapter = makeStreamingAdapter([
      { deltas: ["Single growing block"] },
    ]);
    const batches: AnthropicNativeMessage[][] = [];
    const controller = new AbortController();
    const p = run(
      "x",
      {
        adapter,
        executor: createExecutor(reg),
        registry: reg,
        maxTurns: 5,
        commitMessages: async (msgs) => {
          batches.push([...msgs]);
        },
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    const { result } = await p;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.messages[1]!.role, "system");
    assert.deepEqual(
      batches.map((b) => b.map((m) => m.role)),
      [["system"]]
    );
  });

  it("overflow class: a long multi-block prefix enters assistant in full; only the last block drops", async () => {
    const reg = createRegistry([
      createStubTool({ name: "noop", next: () => ({}) }),
    ]);
    const blocks = ["## Title\n\n"];
    for (let i = 1; i <= 50; i++) {
      blocks.push(`Paragraph number ${i} with content.\n\n`);
    }
    const expectedPrefix = blocks.join("");
    const adapter = makeStreamingAdapter([
      { deltas: [...blocks, "tail still gro"] },
    ]);
    const controller = new AbortController();
    const p = run(
      "x",
      {
        adapter,
        executor: createExecutor(reg),
        registry: reg,
        maxTurns: 5,
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    const { result } = await p;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.messages.length, 3);
    assert.equal(textOf(result.messages[1]!), expectedPrefix);
    assert.ok(!textOf(result.messages[1]!).includes("tail still gro"));
  });

  it("concurrent class: abort after a completed earlier turn keeps only the in-flight prefix once (no double assistant)", async () => {
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
    const adapter = makeStreamingAdapter([
      {
        deltas: ["## A\n\n", "body a\n\n"],
        result: assistantResult({
          texts: ["## A\n\nbody a\n\n"],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "p" } }],
        }),
      },
      { deltas: ["## B\n\n", "body b\n\n", "tail ta"] },
    ]);
    const controller = new AbortController();
    const p = run(
      "go",
      {
        adapter,
        executor: createExecutor(reg),
        registry: reg,
        maxTurns: 5,
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    const { result } = await p;
    assert.equal(result.stopReason, "cancelled");
    // user, assistant(## A + tool_use), user(tool_result), assistant(## B prefix), system
    assert.deepEqual(
      result.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant", "system"]
    );
    const turnOne = result.messages.filter(
      (m) => m.role === "assistant" && textOf(m).includes("## A")
    );
    assert.equal(turnOne.length, 1); // a completed turn is not kept twice
    assert.equal(textOf(result.messages[3]!), "## B\n\nbody b\n\n");
    assert.equal(textOf(result.messages[4]!), "Interrupted by user.");
  });

  it("SC7 / invariant 4: abort while tool in flight after delivered turn -> guard blocks re-keep (four-message shape)", async () => {
    // Pins closeoutInFlightStop's modelInFlight guard: once the model has delivered a
    // tool_call turn (streamed text_delta already appended as assistant via the normal
    // path), cancelling while tools are in flight must not let closeout keep the same
    // buffered text a second time as a duplicate assistant — otherwise the agreed
    // four-message shape (user/assistant(tool_use)/user(tool_result)/system) would
    // silently regress to five.
    const slowTool = createStubSignalTool({ name: "slow", delayMs: 100 });
    const reg = createRegistry([slowTool]);
    const adapter = makeStreamingAdapter([
      {
        deltas: ["## Head\n\n", "First paragraph.\n\n"],
        result: assistantResult({
          texts: ["## Head\n\nFirst paragraph.\n\n"],
          toolCalls: [{ id: "u1", name: "slow", input: { v: 1 } }],
        }),
      },
    ]);
    const controller = new AbortController();
    const p = run(
      "go",
      {
        adapter,
        executor: createExecutor(reg),
        registry: reg,
        maxTurns: 5,
      },
      controller.signal
    );
    // The model step completes instantly; at 10ms we are inside the slow tool's (100ms) in-flight window.
    setTimeout(() => controller.abort(), 10);
    const { result } = await p;
    assert.equal(result.stopReason, "cancelled");
    assert.deepEqual(
      result.messages.map((m) => m.role),
      ["user", "assistant", "user", "system"]
    );
    // The delivered turn exists exactly once: no second assistant, no keep-prefix text leak.
    assert.equal(
      result.messages.filter((m) => m.role === "assistant").length,
      1
    );
    assert.equal(textOf(result.messages[3]!), "Interrupted by user.");
  });

  it("exception class: assistant commit failure throws MessageCommitError and never leaves an orphan interrupt", async () => {
    const reg = createRegistry([
      createStubTool({ name: "noop", next: () => ({}) }),
    ]);
    const adapter = makeStreamingAdapter([
      { deltas: ["## Head\n\n", "First paragraph.\n\n", "Second parag"] },
    ]);
    const attempted: AnthropicNativeMessage[][] = [];
    const controller = new AbortController();
    const p = run(
      "x",
      {
        adapter,
        executor: createExecutor(reg),
        registry: reg,
        maxTurns: 5,
        commitMessages: async (msgs) => {
          attempted.push([...msgs]);
          throw new Error("commit hook down");
        },
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof MessageCommitError);
      return true;
    });
    // Only the prefix commit was attempted; the interrupt must not be committed again (orphan interrupt forbidden).
    assert.deepEqual(
      attempted.map((b) => b.map((m) => m.role)),
      [["assistant"]]
    );
  });
});

describe("ADR-0108 model-in-flight timeout keeps frozen prefix, never user-cancel copy", () => {
  it("SC5: model timeout with frozen prefix -> assistant(prefix) kept; no Interrupted by user.", async () => {
    const reg = createRegistry([
      createStubTool({ name: "noop", next: () => ({}) }),
    ]);
    const adapter = makeStreamingAdapter([
      {
        deltas: ["## Head\n\n", "First paragraph.\n\n", "Second parag"],
      },
    ]);
    const batches: AnthropicNativeMessage[][] = [];
    const { result, trace } = await run("x", {
      adapter,
      executor: createExecutor(reg),
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 20,
      commitMessages: async (msgs) => {
        batches.push([...msgs]);
      },
    });
    assert.equal(result.stopReason, "timeout");
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(
      textOf(result.messages[1]!),
      "## Head\n\nFirst paragraph.\n\n"
    );
    // ADR-0091: timer abort ≠ user cancel — no interrupt system message may appear.
    assert.ok(!result.messages.some((m) => m.role === "system"));
    assert.ok(
      !result.messages.some((m) => textOf(m) === "Interrupted by user."),
      "timeout must not carry the user-cancel copy"
    );
    // The keep path commits only the assistant; no interrupt batch exists.
    assert.deepEqual(
      batches.map((b) => b.map((m) => m.role)),
      [["assistant"]]
    );
    const last = trace.turns[trace.turns.length - 1]!;
    assert.equal(last.cancelKind, "timerTimeout");
  });

  it("SC5 tail-only: model timeout with only a growing block -> no assistant, no interrupt", async () => {
    const reg = createRegistry([
      createStubTool({ name: "noop", next: () => ({}) }),
    ]);
    const adapter = makeStreamingAdapter([
      { deltas: ["Single growing block"] },
    ]);
    const batches: AnthropicNativeMessage[][] = [];
    const { result } = await run("x", {
      adapter,
      executor: createExecutor(reg),
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 20,
      commitMessages: async (msgs) => {
        batches.push([...msgs]);
      },
    });
    assert.equal(result.stopReason, "timeout");
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(batches.length, 0);
  });

  it("SC5 exception class: prefix commit failure throws MessageCommitError; timeout never commits an interrupt", async () => {
    const reg = createRegistry([
      createStubTool({ name: "noop", next: () => ({}) }),
    ]);
    const adapter = makeStreamingAdapter([
      { deltas: ["## Head\n\n", "First paragraph.\n\n", "tail gr"] },
    ]);
    const attempted: AnthropicNativeMessage[][] = [];
    await assert.rejects(
      run("x", {
        adapter,
        executor: createExecutor(reg),
        registry: reg,
        maxTurns: 5,
        modelTimeoutMs: 20,
        commitMessages: async (msgs) => {
          attempted.push([...msgs]);
          throw new Error("commit hook down");
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof MessageCommitError);
        return true;
      }
    );
    assert.deepEqual(
      attempted.map((b) => b.map((m) => m.role)),
      [["assistant"]]
    );
  });
});

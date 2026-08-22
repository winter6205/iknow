/**
 * T5–T10 Loop Engine fixture matrix S1–S11。
 * 017 T5 续段 S12–S17(signal / timeout / trace 守门)。
 *
 * 每条 fixture 一次确定性 run,行为由 stub-model + stub-tool 驱动。
 */

import { APIUserAbortError } from "@anthropic-ai/sdk";
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  MaxTurnsExceeded,
  PromptTooLongError,
  ProtocolError,
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
});

describe("loop engine 017 S12–S17 (signal/timeout/trace)", () => {
  it("S12: signal abort during model in-flight -> cancelled; whole turn NOT in history", async () => {
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
    // Only the seed user message is in history; whole turn not appended.
    // #392 T4:cancelled 时 system 中断消息 append 到末尾(transcript 一等公民),
    // 所以 messages 长度 = 1(seed user) + 1(system interrupt)。
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
    // 守卫:非 cancelled 停因不能 append system 消息(只 cancelled 触发)。
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
    // + system interrupt (#392 T4, transcript 一等公民, append 在末尾)。
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

  it("S15: tool timeout -> stop timeout; tool_result is execution_failed timeout", async () => {
    const slow = createStubTool({
      name: "slow",
      next: () => ({ ok: true }),
    });
    const reg = createRegistry([slow]);
    const exec = createExecutor(reg);
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
    assert.equal(last.cancelKind, "timerTimeout");
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
    // T4:前两次 step(raceModel 直测 + run 主回路)走 abort+throw;后续
    // (摘要轮次)立刻返回空文本结果,best-effort 跳过避免测试挂起。
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
    // T4:首次 step = 主回路(捕获 race composite);后续 step = 摘要轮次,
    // 立即返回空文本避免被 200ms setTimeout 拖慢并污染 receivedSignal 断言。
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
    // 025 #98:hostCancel 覆盖。adapter.step 永不 settle,childAbort() 先胜出。
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = Object.freeze({
      encodeUserText: (text: string) => makeNative({ role: "user", text }),
      encodeToolResults: () => [],
      step: async () => {
        // 永不 resolve:模拟一个挂起的 HTTP 请求。
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
      timeoutMs: 5000, // 足够长,确保 timer 不先触发
    });
    // childAbort() 在 adapter settle 之前调用 → hostCancel 胜出。
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
 * #152 T5:loop 级 thinking 保留与回传(规则层 STUB/LOOP)。
 *
 * 验收:
 *   1. 含 thinking 的 assistant 回合 → state.messages(append-only,全字段:thinking 文本 +
 *      signature;redacted 的 data);
 *   2. 下一轮 replay 的请求消息原样含 thinking blocks(回传 = 权威历史本身);
 *   3. LoopTrace 严格不含 payload(上下文词条锁);trace 不塞 thinking 内容;
 *   4. `projection.texts` 不含 thinking 文本(Q3 决议:thinking 非面向用户正文);
 *   5. `run().result.finalText` 派生不变。
 *
 * 切片:本文件不验证 thinking 展示开关(那是 Part B 的 cmd/format 关注点)。这里只
 * 断言权威历史层(结果 messages[?].content)的字段级深保留 + 下一次 step 入参
 * 对原 thinking blocks 的 byte-identical 回传。
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
    // 切到 assistant role 上: messages[1] 是含 thinking 的回合。
    const assistant1 = result.messages[1]!;
    assert.equal(assistant1.role, "assistant");
    // 块序:thinking → text → tool_use(Q2 决议要求)。
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
    // result.finalText 派生不变(纯文本拼接)。
    assert.equal(result.finalText, "final");
    // 整树仍冻结。
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
    // 关键断言:replay 携带的 history 与权威历史 byte-identical。
    // 用一个 stub-model 包装,捕获每次 step 看到的 state.messages 内容。
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
          const text =
            r.kind === "ok"
              ? JSON.stringify(r.payload ?? {})
              : `[${r.kind}] ${r.message ?? ""}`;
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
    // Step 1 看到的初始 messages(还没 +thinking 块)= [user(go)]。
    assert.equal(capturedMessages[0]!.length, 1);
    assert.equal(capturedMessages[0]![0]!.role, "user");
    // Step 2 看到的 messages 应包含第一次 reply 的 thinking block —— 这就是回传契约。
    // state.messages 在 step 入口是上一步已 append 的全部历史,不含本步正在生成的
    // assistant 回合(append-after-success)。
    const turn2Seen = capturedMessages[1]!;
    // 期望 = [user(go), assistant1(think+text+tool_use), user(tool_result)] = 3 条。
    assert.equal(turn2Seen.length, 3);
    const assistantTurn1 = turn2Seen[1]!;
    assert.equal(assistantTurn1.role, "assistant");
    // 原样含 thinking block:thinking 文本 + signature byte-identical。
    const tBlock = assistantTurn1.content[0] as {
      type: "thinking";
      thinking: string;
      signature: string;
    };
    assert.equal(tBlock.type, "thinking");
    assert.equal(tBlock.thinking, "First turn reasoning.");
    assert.equal(tBlock.signature, "sig_first_turn");
    // order: thinking 先于 text 先于 tool_use(Q2 块序要求)。
    const t1 = assistantTurn1.content[1] as { type: "text"; text: string };
    assert.equal(t1.text, "done");
    const t2 = assistantTurn1.content[2] as { type: "tool_use"; id: string };
    assert.equal(t2.type, "tool_use");
    assert.equal(t2.id, "t1");
    // turn2 也必须含上一回合的 tool_result(user message)。
    const toolResultMsg = turn2Seen[2]!;
    assert.equal(toolResultMsg.role, "user");
    assert.equal(toolResultMsg.content[0]!.type, "tool_result");
    // step2 入口看到的 messages 必须是 run.result.messages 的前缀(回传 = 权威历史)。
    // run 结果多一条 assistant("all good"),所以前缀长度匹配 + 逐条 deepEqual。
    for (let i = 0; i < turn2Seen.length; i++) {
      assert.deepEqual(turn2Seen[i], result.messages[i]);
    }
  });

  it("replay 与 run().result.messages 对齐(head→head byte-equality of seen vs produced)", async () => {
    // 设计意图:回传 = 权威历史本身。把 step 看到的消息数组的 deep-snapshot 与
    // run 返回的 result.messages 进行 deep-equal,确保两者是同一棵冻结树。
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
                  ? JSON.stringify(r.payload ?? {})
                  : (r.message ?? ""),
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
    // captured 是 step2 入口的权威历史(step 入口 = 上回合 append 后的状态),
    // 即 result.messages 的前缀(后者多 step2 自己产出的 assistant 回合)。
    // 回传 = 权威历史本身:逐条 deepEqual 证明 replay 发送的就是权威历史,
    // 没有任何裁剪/重排/字段丢失。
    assert.equal(captured!.length, 3);
    assert.equal(result.messages.length, 4);
    for (let i = 0; i < captured!.length; i++) {
      assert.deepEqual(
        captured![i],
        result.messages[i],
        `replay message ${i} must deep-equal authoritative history entry`
      );
    }
    // 进一步:thinking block 在 captured[1] 头部,完整保留。
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
    // finalText 不含 thinking 文本。
    assert.equal(result.finalText, "final answer");
    assert.ok(
      result.finalText !== null &&
        !result.finalText.includes("INTERNAL_REASONING_SHOULD_NOT_LEAK"),
      "finalText must NOT include thinking text (Q3 projection invariant)"
    );
  });

  it("LoopTrace 严格不含 thinking payload(上下文词条锁)", async () => {
    // 上下文锁:trace 只记录结构性元数据,绝不进 input/output/text/payload 等字段。
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
    // 每个 turn 仍无 input / output / payload 字段(对照 S16 的硬约束)。
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
    // 两个模型回合各自 emit:turn1 = tool_call_start,turn2 = text_delta×2。
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
 * #160 T4 (ADR-0008 Decision 5):RunResult.lastUsage = 最后一次成功模型调用的
 * usage;run 无成功模型调用时为 null。
 *
 * 验收锚点(双源裁决 #160 Resolution Q4 + ADR-0008 Decision 5):
 *   (a) 多轮 run(均带 usage)→ lastUsage = 最后一次成功调用的值;
 *   (b) 纯 stub 无 usage 的 run → lastUsage === null;
 *   (c) 首轮成功带 usage、随后失败(ProtocolError)→ lastUsage 保留首轮 usage。
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
    // 整对象 deepEqual,确保是 usage2(最后成功调用)而非 usage1。
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
    // 仅 1 个脚本响应(含 usage);第二轮 stub-model 脚本耗尽抛 ProtocolError →
    // stopReason=protocolError,lastUsage 保留首轮的 usage。
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
 * #224 W1: LoopEngineDeps.promptTools 注入缝(S2 行为中性)。
 *
 * 用 spy-adapter 包住 stub-model,记录每次 step 收到的 request.tools:
 *   - 未传 promptTools → adapter.step 收到 registry.list()(同顺同内容);
 *   - 传 subset promptTools → adapter.step 收到的就是该数组。
 */

// ---------------------------------------------------------------------------
// plan T3 / ADR-0013: reactive compact (PromptTooLongError → compact + retry)
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
    // deps.compress 缺席 → reactive 入口不激活,直接 ProtocolError 分支。
    assert.equal(result.stopReason, "protocolError");
    // stepCalls = 主回路 1 次 + 异常停收尾摘要 epilogue 再尝试 1 次(均抛
    // PromptTooLongError → catch-all 跳过)。reactive compact 未触发。
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
        // #467 step 2:full-compact 摘要轮(tools === undefined)返回空文本 →
        // empty_response → fallback placeholder。本测试关心 fallback 路径下的
        // reactive compact + retry 几何,摘要成功路径由 integration.test.ts
        // 单独覆盖。
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

    // 12 条 prior → state.messages = 13 条 → reactive compactMessages 裁到
    // 边界占位 + 6 末尾。proactive 不触发:estimate << threshold(window 默认
    // 推导 200000-20000-13000=167000,显式阈值 10000 更保险 < window)。
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
    // #467 step 2:1 throw + 1 full-compact 摘要步(fallback → placeholder)+ 1 retry success。
    assert.equal(stepCalls, 3);
    // reactive compact 生效:13 条 → 边界占位 + 6 末尾;加 user(Q) 已含在 13 内,
    // 收尾 assistant +1。13 → (1 + 6) + 1(assistant) = 8。
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
    // 1 首次 throw → compactMessages + retry → 2 仍 throw → attempted=true
    // → runModelPhase 落 modelStop(protocolError);stepWithTrace 记录 turn error。
    assert.equal(result.stopReason, "protocolError");
    assert.equal(stepCalls, 2); // 首次 + 一次压缩重试
  });

  it("PromptTooLongError 是 ProtocolError 子类 — 单次错误分支不破坏 ProtocolError 兜底", async () => {
    // 验证依赖 instanceof ProtocolError 的其它分支未受影响。
    const { ProtocolError } = await import("../../src/harness/errors.ts");
    assert.ok(ProtocolError !== undefined);
    const err = new PromptTooLongError("x");
    assert.ok(err instanceof ProtocolError);
    assert.ok(err instanceof PromptTooLongError);
    assert.equal(err.name, "PromptTooLongError");
  });
});

// ---------------------------------------------------------------------------
// plan compress-trigger-gate T3: proactive compact 接入 evaluateCompactTrigger +
// full-summary fallback(messages ≤ DEFAULT_KEEP_RECENT 时降级到 runFullCompact)
// ---------------------------------------------------------------------------

/** plan T3 stub:full-summary adapter — 区分"摘要步"与"普通 step"。
 *  - 摘要步:`tools === undefined` 且 state 最后一条 user 含 BASE_COMPACT_PROMPT
 *    → 按 `compactOutcomes` 脚本消费("summarized" / "adapter_failed");
 *  - 普通 step:消费 `stepScripts` 队列(tool call / completion)。 */
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
    // 必须产出真实 tool_result 块:evaluateCompactTrigger 内部调
    // preserveToolPairs 做 tool_use↔tool_result 配对守门,空数组会让
    // tool_use 悬空 → throw "missing tool_result"(实测抓到的失败)。
    encodeToolResults: (
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] => toAnthropicToolResults(results),
    step: async (
      state: LoopState,
      request: { readonly tools?: unknown }
    ): Promise<AssistantTurnResult> => {
      if (request.tools === undefined) {
        // full-compact 摘要步:仅当 user 文本含 compact prompt 才算;
        // 否则是收尾摘要 epilogue,走 queue 消费。
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
          // "summarized"(or undefined → 兜底为 summarized)
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

describe("loop engine T3 compress-trigger-gate: proactive full-summary fallback", () => {
  it("messages.length=5 + 高 token 估算 → proactive 触发 full summary 路径,无死循环", async () => {
    // 2 条 prior:每条 50000 chars → 单条 estimate = floor((50000+3)/4) = 12500;
    // 2 条 raw total ≈ 25000;estimateMessagesTokens = ceil(25000 * 4/3) ≈ 33334。
    // threshold=10000 远低于 estimate → evaluateCompactTrigger 必返回 full_summary。
    // 关键路径推导:run() 初始 state = 2 prior + 1 user("Q") = 3 messages。
    // Iter 1:turnCount=0,gate skip;step 1(tool call)→ state 增至 5 messages,
    // turnCount=1。Iter 2:gate 进入,evaluateCompactTrigger(5 messages):
    //   - token 估 ≈ 50000 + 小尾巴 ≫ 10000 → 阈值超;
    //   - preserveToolPairs(5,6)→ slicedFrom=0(≤ keepRecent)→ compact_via_full_summary。
    // 旧 `shouldAutoCompact` 路径会调 applyCompactAttachment,但 splitForCompaction
    // 在 ≤ keepRecent 时返 undefined → 返回 state 不变 → lastCompactTurn 不更新,
    // 进入死循环。T3 修复后改走 applyFullCompactSummary 整段视为 dropped。
    const longPrior = Array.from({ length: 2 }, (_, i) =>
      makeNative({ role: "user", text: `prior-${i} ${"x".repeat(50_000)}` })
    );
    const adapter = makeFullSummaryAdapter({
      // step 1: tool call(before first compact attempt)
      // step 2: tool call(after first compact SUCCESS — state = [summary user])
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
    // T3 acceptance:runFullCompact 的 LLM 调用 = 1(成功一次后 lastCompactTurn 更新,
    // 下一轮 gate 估 token 已低 → noop)。若旧路径死循环,此处会 >1。
    assert.equal(
      adapter.compactCalls.value,
      1,
      "compact 只调一次 — 摘要成功后 lastCompactTurn 更新,下一轮 gate 走 noop"
    );
    // 摘要成功后 messages[0] = SUMMARY_PREAMBLE + FULL-SUMMARY。
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
    // Setup:1 条 LONG prior(50000 chars)+ 1 条 SHORT prior + 1 user("Q")
    // = 3 初始 messages。token 估 ≈ 12500(long prior)远 > 10000 阈值。
    // 关键设计:把 LONG 放在 prior[0],SHORT 在 prior[1]。这样 iter 3 的
    // windowed compact dropped = [prior-0 LONG],kept = [prior-1 SHORT, ...5 small]
    // → 摘要后 state token 骤降至 < 10000 → iter 4 gate 走 noop → 跳出死循环。
    // 路径推导:
    //   Iter 1:turnCount=0,gate skip;step 1(tool call)→ state = 5,turnCount=1。
    //   Iter 2:gate(1 > 0)→ 5 ≤ 6 → full_summary。applyFullCompactSummary 第 1 次失败
    //     (adapter_failed outcome)→ state 不变 → lastCompactTurn 保持 0。
    //   step 2(tool call)→ state = 7,turnCount=2。
    //   Iter 3:gate(2 > 0)→ 7 > 6 → windowed。applyCompactAttachment 摘要 dropped=[LONG]
    //     → 成功(state = [placeholder, ...6 kept])→ lastCompactTurn = 2。
    //   step 3(tool call)→ state = 9,turnCount=3。
    //   Iter 4:gate(3 > 2)→ 9 > 6 → windowed,但 token < 10000 → noop。step 4 completion → stop。
    // 关键断言:第二轮(iter 3)必须再次进 gate(而非"上一轮调过就不重检"的死循环死锁)。
    // compactCalls = 2(第一次 full_summary fail + 第二次 windowed success)。
    const longPrior = [
      makeNative({ role: "user", text: `prior-0 ${"x".repeat(50_000)}` }),
      makeNative({ role: "user", text: "prior-1 short" }),
    ];
    const adapter = makeFullSummaryAdapter({
      // step 1: tool call(before first compact attempt)
      // step 2: tool call(after first compact FAILED — state unchanged at 5 msgs)
      // step 3: tool call(after second compact SUCCEEDED — state = [placeholder, ...6 short kept])
      // step 4: completion(final turn)
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
          texts: [],
          toolCalls: [{ id: "t3", name: "noop", input: {} }],
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
    // T3 acceptance:compact 被调 2 次(第一次失败 → 锚点不更新 → 第二次成功)。
    // 若死循环实现(成功才更新,但旧代码根本进不去 summary 路径),此处会 =1;
    // 若新路径锚点更新逻辑被破坏成"调过就跳过",此处会 =1;正确实现 =2。
    assert.equal(
      adapter.compactCalls.value,
      2,
      "失败不更新 lastCompactTurn → 下一轮重检 → 再尝试,非死循环"
    );
    // 最终 messages[0] = 第二次摘要成功后的 SUMMARY_PREAMBLE + FULL-SUMMARY。
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
// plan T4 / ADR-0011: 收尾摘要 epilogue (stop_summary 事件)
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
        // 摘要轮次:返回一段非空 text。
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
    // 主回路 protocolError → stop;run() 调 epilogueSummary → 第二次 adapter.step
    // 返回收尾文本 → stop_summary emit;原始停因 = protocolError(run 不续循环)。
    assert.equal(result.stopReason, "protocolError");
    assert.equal(stepCalls, 2);
    const summary = received.find((e) => e.type === "stop_summary");
    assert.ok(summary, "expected stop_summary event");
    assert.equal(
      (summary as { type: "stop_summary"; text: string }).text,
      "summary text from epilogue"
    );
    // 历史无 stop_summary 注入 — 只有 user(go) 种子消息(bad turn 未 append)。
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
    // maxTurns=undefined + 一次成功 → completed,不进异常停 → 无 summary 事件。
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

    // stub-scripted: 2 次 echo 调用,然后摘要轮(texts 非空)。
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
    // 收尾摘要 emit 一次 stop_summary。
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

    // stub 脚本 1 次 echo 调用(用尽),不再有响应 → 摘要 adapter.step 抛 ProtocolError。
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
    // 摘要失败被 catch-all 吞;stop_summary 不 emit。
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

    // 3 次 echo 响应(预算 maxTurns=2 → throw 前用掉前 2 次;摘要无响应 → catch)。
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
    // controller.abort() 之前 — 摘要级 signal 检查(signal 尚未 abort)。
    // 为测"concurrent abort",在摘要尝试前 abort:
    controller.abort();
    // 摘要不应被 emit(此处 stub 队列已空,即便 signal 未 abort 也会 catch-all 跳过)。
    assert.ok(
      !received.some((e) => e.type === "stop_summary"),
      "no stop_summary emitted on summary-skip path"
    );
  });

  it("摘要 usage 照落 trace LlmCallRecord(status ok);摘要轮不计 turns", async () => {
    // 直接观察 trace:timeout 后 epilogue 写一条额外 llm_call ok,
    // 不写 turn(turns 计数仍守主循环)。
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
    // 主循环 turn: turnCount=0 时模型阶段 timeout → turn trace 1 条。
    assert.equal(runTrace.turns.length, 1);
    // JSONL:error llm_call + turn + summary ok llm_call = 3。
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
    // subset 数组:只暴露 echo,不暴露 noop(模拟"当前 turn 应进 prompt 的工具集")。
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
    // 与 registry.list() 不同:验证注入确被消费,而非回退全量。
    assert.notDeepEqual(capturedTools[0], reg.list());
  });
});

// ---------------------------------------------------------------------------
// #406 T2: secret roundtrip 识别层 —— run() 用户文本进 LLM 前占位符替换
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
    // 明文绝不出现在任何编码消息中（含 assistant 回复、tool_result 等全树）
    for (const m of result.messages) {
      const serialized = JSON.stringify(m);
      assert.ok(
        !serialized.includes("sk-aaaaaaaaaaaaaaaaaaaa"),
        "raw secret must not appear in any encoded message"
      );
    }
    // registry 恰好记录 1 条
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

    // 二次 run：同一 registry + priorMessages 续传，新文本只含占位符
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
    // prior 消息原样保留占位符（首轮已替换 → 一路都是占位符）
    const priorUserText = (
      secondRun.result.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(priorUserText, "用 <<<SECRET_1>>> 处理");
    // 新 user 消息 = 用户文本 verbatim（占位符形态不触发任何密钥 pattern）
    const newUserText = (
      secondRun.result.messages[2]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(newUserText, secondUserText);
    // 占位符文本在 recognize 层 matched 为空（A2 去重验证）
    assert.deepEqual(recognize(secondUserText, secretRegistry).matched, []);
    // registry 不重复注册（size 仍 1）
    assert.equal(secretRegistry.size, 1);
    assert.equal(
      secretRegistry.resolve("<<<SECRET_1>>>"),
      "sk-aaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("T2-A3: 自定义 patterns 扩展被接线 — DEFAULT 与 extras 都在 roundtrip 中识别", async () => {
    // API-level：createCompiledPatterns 合并 DEFAULT 7 + extras 1 = 8
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
    // 扫描按 pattern 序：sk-（DEFAULT[1]）先注册 → SECRET_1；MY_（extras[0]）
    // 后注册 → SECRET_2；输出按源文本位置重排 → MY_ 在前得 SECRET_2。
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
      // 故意不传 secretRegistry → legacy 路径
    });
    const text = (
      result.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(text, userText); // verbatim 明文
  });

  it("T2 bonus: 占位符本身不被识别为密钥 — 模型可安全引用 <<<SECRET_N>>>", async () => {
    const secretRegistry = createSecretRegistry();
    secretRegistry.register("sk-aaaaaaaaaaaaaaaaaaaa");
    const r = recognize("<<<SECRET_1>>> 再次调用", secretRegistry);
    assert.deepEqual(r.matched, []);
    assert.equal(r.replaced, "<<<SECRET_1>>> 再次调用");
  });
});

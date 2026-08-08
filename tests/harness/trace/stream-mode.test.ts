/**
 * #178 T5 (#147 D6) — trace `stream` boolean reflects the actual LLM call mode.
 *
 * Acceptance (§5 plan):
 *   - streaming arm  → trace JSONL `stream: true`;
 *   - non-streaming  → trace JSONL `stream: false` (regression guard).
 *
 * "Mode" 在 loop-engine 不可观测; 设计 B:adapter 通过只读 `streamMode?: boolean`
 * 属性向 loop-engine 申报所走的臂(loop-engine 在 stepWithTrace 内取一次,写入
 * recordLlmCall 两处 site)。Stub / offline / 非流式臂无 streamMode → 缺省 false。
 *
 * 流式臂端到端测试用最小 fake SDK client(只接 messages.stream;不依赖真实网络,
 * 也不用 T3 的重型 makeFakeStream —— 本文件按 DAMP 原则最小克隆)。error-site
 * 用例用永挂 finalMessage 触发 raceModel timerTimeout,证明 error 分支也按实际
 * 模式翻转(该分支无 AssistantTurnResult,AssistantTurnResult 字段方案天然覆盖不到)。
 */
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Message as SdkMessage } from "@anthropic-ai/sdk/resources/messages.js";
import { createRealAnthropicAdapter } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import { parseJsonl } from "./_fixtures.ts";

/**
 * Register-and-cleanup pattern: each test pushes its tmp dir into this array;
 * afterEach drains the array. Prevents tmp dir leak when assertions fail before
 * the inline rmSync would have run (the original 4 sites had no try/finally).
 */
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** 良构 SdkMessage(stream arm finalMessage 的终态载体)。 */
function wellShapedFinalMessage(text: string): SdkMessage {
  return {
    id: "msg_t5_stream",
    type: "message",
    role: "assistant",
    model: "claude-t5-test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as SdkMessage;
}

/**
 * 最小 fake SDK client:只实现 `messages.stream`。`finalMessage()` 立即 resolve
 * 良构消息;loop-engine 不透传 onStream,wireStreamEvents 提前返回,`on()` 永不
 * 被调用。
 */
function makeOneShotStreamClient(final: SdkMessage): unknown {
  return {
    messages: {
      create: (): Promise<SdkMessage> => {
        throw new Error("create must not be called in stream arm");
      },
      stream: (): {
        on: (...args: unknown[]) => unknown;
        finalMessage: () => Promise<SdkMessage>;
      } => ({
        on: (): unknown => undefined,
        finalMessage: (): Promise<SdkMessage> => Promise.resolve(final),
      }),
    },
  };
}

/** Error-site 用:finalMessage 永挂,让 raceModel 的 timerTimeout 胜出。 */
function makeHangingStreamClient(): unknown {
  return {
    messages: {
      create: (): Promise<SdkMessage> => {
        throw new Error("create must not be called in stream arm");
      },
      stream: (): {
        on: (...args: unknown[]) => unknown;
        finalMessage: () => Promise<SdkMessage>;
      } => ({
        on: (): unknown => undefined,
        // 永不 settle:raceModel timer 胜出时本 promise 未完成,adapter arm settle
        // 不触发,error site 走 timerTimeout 分支。
        finalMessage: (): Promise<SdkMessage> =>
          new Promise<SdkMessage>(() => {}),
      }),
    },
  };
}

describe("#178 T5: trace stream boolean reflects actual LLM call mode (D6)", () => {
  it("streaming arm → trace JSONL llm_call stream: true (end-to-end)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t5-"));
    tmpDirs.push(tmpDir);
    const client = makeOneShotStreamClient(wellShapedFinalMessage("hi"));
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-t5-test",
      maxTokens: 256,
      stream: true,
    });
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const { result } = await run("hello", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace: createJsonlTraceService({
        filePath: tmpDir,
        conversationId: "conv-t5-stream-ok",
      }),
    });
    assert.equal(result.stopReason, "completed");
    const lines = parseJsonl(join(tmpDir, "conv-t5-stream-ok.jsonl"));
    const llm = lines.find((l) => l["record_type"] === "llm_call");
    assert.ok(llm, "expected llm_call record");
    assert.equal(llm!["stream"], true);
  });

  it("stub model (no streamMode) → trace JSONL llm_call stream: false (regression guard)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t5-"));
    tmpDirs.push(tmpDir);
    const tool = createStubTool({ name: "noop", next: () => ({}) });
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
    await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace: createJsonlTraceService({
        filePath: tmpDir,
        conversationId: "conv-t5-stub-false",
      }),
    });
    const lines = parseJsonl(join(tmpDir, "conv-t5-stub-false.jsonl"));
    const llm = lines.find((l) => l["record_type"] === "llm_call");
    assert.ok(llm);
    assert.equal(llm!["stream"], false);
  });

  it("real adapter with stream=false → trace JSONL llm_call stream: false", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t5-"));
    tmpDirs.push(tmpDir);
    const final = wellShapedFinalMessage("ok");
    const client = {
      messages: {
        create: (): Promise<SdkMessage> => Promise.resolve(final),
        stream: (): never => {
          throw new Error("stream arm must not be called when stream=false");
        },
      },
    };
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-t5-test",
      maxTokens: 256,
      stream: false,
    });
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    await run("hello", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace: createJsonlTraceService({
        filePath: tmpDir,
        conversationId: "conv-t5-nonstream",
      }),
    });
    const lines = parseJsonl(join(tmpDir, "conv-t5-nonstream.jsonl"));
    const llm = lines.find((l) => l["record_type"] === "llm_call");
    assert.ok(llm);
    assert.equal(llm!["stream"], false);
  });

  it("streaming arm timeout (raceModel timerTimeout) → error record stream: true", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t5-"));
    tmpDirs.push(tmpDir);
    const client = makeHangingStreamClient();
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-t5-test",
      maxTokens: 256,
      stream: true,
    });
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const { result } = await run("hello", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 20,
      // plan T4:fake 流永挂 — 缩短摘要独立超时,避免 run() 被 15s default 拖住。
      summaryTimeoutMs: 20,
      trace: createJsonlTraceService({
        filePath: tmpDir,
        conversationId: "conv-t5-stream-timeout",
      }),
    });
    assert.equal(result.stopReason, "timeout");
    const lines = parseJsonl(join(tmpDir, "conv-t5-stream-timeout.jsonl"));
    const llm = lines.find((l) => l["record_type"] === "llm_call");
    assert.ok(llm);
    // error site 也按实际模式翻转:流式臂 in-flight 被 timer 终止 → 实际模式是
    // streaming,记录 stream: true。
    assert.equal(llm!["stream"], true);
    assert.equal(llm!["status"], "error");
  });
});

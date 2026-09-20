/**
 * Trace `stream` boolean reflects the actual LLM call mode.
 *
 * Expected:
 *   - streaming arm  → trace JSONL `stream: true`;
 *   - non-streaming  → trace JSONL `stream: false` (regression guard).
 *
 * The "mode" is not observable inside loop-engine; design B has the adapter
 * declare which arm it took via a read-only `streamMode?: boolean` property
 * (loop-engine reads it once in stepWithTrace and writes it at both
 * recordLlmCall sites). Stub / offline / non-streaming arms lack streamMode
 * → defaults to false.
 *
 * The streaming end-to-end test uses a minimal fake SDK client (only
 * messages.stream; no real network, and not the heavier makeFakeStream —
 * this file clones it minimally per the DAMP principle). The error-site case
 * hangs finalMessage forever so raceModel's timerTimeout wins, proving the
 * error branch also flips by actual mode (that branch has no
 * AssistantTurnResult, so an AssistantTurnResult-field design would
 * structurally miss it).
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

/** Well-formed SdkMessage (terminal payload returned by the stream arm's finalMessage). */
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
 * Minimal fake SDK client: implements only `messages.stream`. `finalMessage()`
 * resolves a well-formed message immediately; loop-engine never forwards
 * onStream, wireStreamEvents returns early, so `on()` is never called.
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

/** For the error site: finalMessage hangs forever so raceModel's timerTimeout wins. */
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
        // Never settles: when the raceModel timer wins this promise is still
        // pending, the adapter arm's settle does not fire, so the error site
        // takes the timerTimeout branch.
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
      // The fake stream hangs, so shorten the closing-summary timeout to keep
      // run() from being dragged by the 15s default.
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
    // The error site also flips by actual mode: the streaming arm is killed
    // mid-flight by the timer → the actual mode is streaming, recorded stream: true.
    assert.equal(llm!["stream"], true);
    assert.equal(llm!["status"], "error");
  });
});

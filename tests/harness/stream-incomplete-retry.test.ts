/**
 * ADR-0111 T3: `stream_incomplete` 接通既有重试机器的集成验收。
 *
 * 装配面是真实机器: 真 withTransportRetry + 真 loop-engine run() + 真
 * translateAnthropicTransportFault。stub 只做一件事 —— 每次 attempt 抛
 * adapter 边界产出的 `ModelStreamIncompleteError`(T2 翻译形态)。
 *
 * 认证的不变式:
 *  1. 不可见断流 → classifyFault retry → 既有预算(5 attempts)/退避表
 *     (1s/2s/4s/8s)/transport_retry 流事件全部由 withTransportRetry 承载
 *     (本体零改动),耗尽 → TransportRetryExhaustedError → loop 既有收口支
 *     → stopReason protocolError + apiError 在场,整 step 不进历史。
 *  2. 可见断流 → classifyFault none → :141 rethrow typed 错误 → loop
 *     `instanceof ProtocolError` 收口 → 同 stopReason + apiError;零重试。
 *  3. trace 双轨(test.md 契约): JsonlTraceService 事件序列 assert +
 *     NoopTraceService-vs-no-trace deepEqual 基线。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../../src/harness/loop-engine.ts";
import { ModelStreamIncompleteError } from "../../src/harness/errors.ts";
import { withTransportRetry } from "../../src/harness/model-adapter/with-transport-retry.ts";
import { translateAnthropicTransportFault } from "../../src/harness/model-adapter/anthropic-adapter.ts";
import type {
  ModelAdapter,
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import { parseJsonl } from "./trace/_fixtures.ts";

/** SDK 断流原文形态(T2 哨兵钉住的 `finalMessage()` reject 原因)。 */
const SDK_SHAPE_MESSAGE =
  "stream ended without producing a Message with role=assistant";

type RetryStub = ModelAdapter & { readonly calls: number };

/**
 * 前 `failures` 次 step 抛 ModelStreamIncompleteError,其后返回成功纯文本
 * (供 best-effort 收尾摘要轮消化,使调用计数保持精确)。
 */
function retryStub(opts: {
  readonly failures: number;
  readonly visible: boolean;
}): RetryStub {
  let calls = 0;
  const stub = {
    get calls() {
      return calls;
    },
    encodeUserText: (t: string) =>
      ({
        role: "user",
        content: [{ type: "text", text: t }],
      }) as AnthropicNativeMessage,
    encodeToolResults: () => undefined as never,
    step: async (): Promise<AssistantTurnResult> => {
      calls += 1;
      if (calls <= opts.failures) {
        throw new ModelStreamIncompleteError(
          opts.visible,
          new Error(SDK_SHAPE_MESSAGE)
        );
      }
      return assistantResult({
        texts: ["summary"],
        toolCalls: [],
        supplierStop: "success",
      });
    },
  };
  return stub as unknown as RetryStub;
}

function assemble(inner: RetryStub): {
  readonly adapter: ModelAdapter;
  readonly delays: number[];
} {
  const delays: number[] = [];
  const adapter = withTransportRetry(inner, {
    translate: translateAnthropicTransportFault,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { adapter, delays };
}

function tooling() {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const reg = createRegistry([tool]);
  return { registry: reg, executor: createExecutor(reg) };
}

describe("ADR-0111 T3: stream_incomplete 有界重试 → loop 干净收口", () => {
  it("不可见断流耗尽既有预算 → protocolError + apiError,不进历史;trace 序列含失败尝试", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "stream-exhaust-"));
    try {
      const inner = retryStub({ failures: 5, visible: false });
      const { adapter, delays } = assemble(inner);
      const streamEvents: unknown[] = [];
      const trace = createJsonlTraceService({
        filePath: tmpDir,
        conversationId: "stream-exhaust",
      });
      const { result } = await run(
        "go",
        { adapter, ...tooling(), maxTurns: 5, trace },
        undefined,
        { onStream: (e) => streamEvents.push(e) }
      );
      // 收口: 干净回合失败,不裸抛(run 正常返回)。
      assert.equal(result.stopReason, "protocolError");
      assert.equal(result.finalText, null);
      assert.equal(result.turnCount, 0);
      // 整 step 不提交: 权威历史只剩初始 user 消息。
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]!.role, "user");
      // apiError 在场(Decision 2(c) 不变式: 带 cause 的瞬时失败 ⇔ 挂摘要)。
      // 耗尽路径 cause = 最后一次 ModelStreamIncompleteError。
      assert.deepEqual(result.apiError, {
        message:
          "model stream ended without producing a complete assistant message",
      });
      // 有界重试 = 既有预算(5 attempts,第 5 次失败即耗尽)+ 既有退避表。
      assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
      // 调用计数: 主相 5 次断流 + 收尾摘要轮 1 次成功(不进主相预算)。
      assert.equal(inner.calls, 6);
      // transport_retry 流事件由既有机器发射,主相 4 次退避各一条。
      assert.deepEqual(
        streamEvents.filter(
          (e) =>
            typeof e === "object" &&
            e !== null &&
            (e as { type?: string }).type === "transport_retry"
        ),
        [1, 2, 3, 4].map((attempt) => ({
          type: "transport_retry",
          attempt,
          maxAttempts: 5,
          detail: "stream_incomplete",
        }))
      );
      // trace 双轨 assert ①: 事件序列 = 失败 llm_call → 失败 turn → 摘要 ok llm_call。
      const lines = parseJsonl(join(tmpDir, "stream-exhaust.jsonl"));
      const types = lines.map((l) => l["record_type"]);
      assert.deepEqual(types, ["llm_call", "turn", "llm_call"]);
      assert.equal(lines[0]!["status"], "error");
      const llmError = lines[0]!["error"] as { type: string };
      assert.equal(llmError.type, "protocolError");
      assert.equal(lines[1]!["decision"], "protocolError");
      assert.equal(lines[1]!["status"], "error");
      assert.equal(lines[2]!["status"], "ok");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("可见断流 → 零重试直抛 typed 错误,loop ProtocolError 支收口同形状", async () => {
    const inner = retryStub({ failures: 1, visible: true });
    const { adapter, delays } = assemble(inner);
    const streamEvents: unknown[] = [];
    const { result } = await run(
      "go",
      { adapter, ...tooling(), maxTurns: 5 },
      undefined,
      { onStream: (e) => streamEvents.push(e) }
    );
    assert.equal(result.stopReason, "protocolError");
    assert.equal(result.finalText, null);
    assert.equal(result.messages.length, 1);
    // 零重试: 主相 1 次 + 摘要轮 1 次,无退避、无 transport_retry
    // (stop_summary 是摘要轮既有事件,不属本 assert 面,故只过滤 transport_retry)。
    assert.equal(inner.calls, 2);
    assert.deepEqual(delays, []);
    assert.deepEqual(
      streamEvents.filter(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "transport_retry"
      ),
      []
    );
    // 直抛路径 cause = SDK 原文 → apiError 摘要即 SDK message(Decision 2(c))。
    assert.deepEqual(result.apiError, { message: SDK_SHAPE_MESSAGE });
  });

  it("不可见耗尽路径: NoopTraceService 与无 trace 的 RunResult 深等一致(基线)", async () => {
    const { adapter: adapterA, delays: delaysA } = assemble(
      retryStub({ failures: 5, visible: false })
    );
    const { result: resultA } = await run("go", {
      adapter: adapterA,
      ...tooling(),
      maxTurns: 5,
    });
    const { adapter: adapterB, delays: delaysB } = assemble(
      retryStub({ failures: 5, visible: false })
    );
    const { result: resultB } = await run("go", {
      adapter: adapterB,
      ...tooling(),
      maxTurns: 5,
      trace: createNoopTraceService(),
    });
    assert.equal(resultA.stopReason, "protocolError");
    assert.deepEqual(delaysB, delaysA);
    assert.deepEqual(resultB, resultA);
  });
});

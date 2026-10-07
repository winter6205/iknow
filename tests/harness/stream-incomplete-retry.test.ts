/**
 * ADR-0111: integration acceptance that `stream_incomplete` feeds the
 * existing transport-retry machine.
 *
 * Assembled from the real machinery: real withTransportRetry + real
 * loop-engine run() + real translateAnthropicTransportFault. The stub does
 * one thing only — throw the `ModelStreamIncompleteError` that the adapter
 * boundary produces on each attempt.
 *
 * Invariants certified:
 *  1. invisible stream break → classifyFault retry → existing budget
 *     (5 attempts) / backoff table (1s/2s/4s/8s) / transport_retry stream
 *     events, all carried by withTransportRetry untouched; exhaustion →
 *     TransportRetryExhaustedError → loop's existing convergence branch →
 *     stopReason protocolError + apiError present; the whole step stays out
 *     of history.
 *  2. visible stream break → classifyFault none → typed-error rethrow →
 *     loop's `instanceof ProtocolError` branch → same stopReason + apiError;
 *     zero retries.
 *  3. trace double-track (test.md contract): JsonlTraceService event-sequence
 *     assert + NoopTraceService-vs-no-trace deepEqual baseline.
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
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../src/harness/model-adapter/types.ts";
import type { LoopAdapter } from "../../src/harness/loop-engine.ts";
import type { ModelAdapter } from "../../src/harness/model-adapter/types.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";
import { toAnthropicToolResults } from "../../src/harness/tools/tool-result.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import { parseJsonl } from "./trace/_fixtures.ts";

/** Raw SDK stream-break shape: the `finalMessage()` rejection reason the sentinel test pins down. */
const SDK_SHAPE_MESSAGE =
  "stream ended without producing a Message with role=assistant";

type RetryStub = ModelAdapter & { readonly calls: number };

/**
 * First `failures` step calls throw ModelStreamIncompleteError, later ones
 * return plain-text success (consumed by the best-effort closing summary
 * turn, keeping the call count exact).
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
  readonly adapter: LoopAdapter;
  readonly delays: number[];
} {
  const delays: number[] = [];
  // `withTransportRetry` wraps only `step`; the loop engine needs the full
  // adapter contract, so the encoding half is supplied alongside it.
  const adapter: LoopAdapter = {
    ...withTransportRetry(inner, {
      translate: translateAnthropicTransportFault,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }),
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] => toAnthropicToolResults(results),
  };
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
      // Convergence: clean turn failure, no bare throw (run returns normally).
      assert.equal(result.stopReason, "protocolError");
      assert.equal(result.finalText, null);
      assert.equal(result.turnCount, 0);
      // The whole step stays uncommitted: authoritative history holds only the initial user message.
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]!.role, "user");
      // apiError present (ADR-0111 Decision 2(c): transient failure with cause ⇔ summary attached).
      // Exhaustion path cause = the last ModelStreamIncompleteError.
      assert.deepEqual(result.apiError, {
        message:
          "model stream ended without producing a complete assistant message",
      });
      // Bounded retry = existing budget (5 attempts, exhaustion on the 5th failure) + existing backoff table.
      assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
      // Call count: 5 stream breaks in the main phase + 1 success in the closing summary turn (not charged to the main budget).
      assert.equal(inner.calls, 6);
      // transport_retry stream events are emitted by the existing machine, one per backoff in the main phase.
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
      // Trace double-track assert: event sequence = failing llm_call → failing turn → summary ok llm_call.
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
    // Zero retries: 1 main-phase call + 1 summary-turn call, no backoff, no transport_retry
    // (stop_summary is an existing summary-turn event outside this assert surface, so only transport_retry is filtered).
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
    // Direct-throw path cause = raw SDK error → apiError summary is the SDK message (ADR-0111 Decision 2(c)).
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

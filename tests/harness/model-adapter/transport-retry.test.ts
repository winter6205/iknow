/**
 * #672 T2: ModelAdapter.step 传输重试装饰器。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { APIConnectionError } from "@anthropic-ai/sdk";
import {
  withTransportRetry,
  TransportRetryExhaustedError,
  TRANSPORT_BACKOFF_CAP_MS,
} from "../../../src/harness/model-adapter/with-transport-retry.ts";
import { translateAnthropicTransportFault } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import { PromptTooLongError } from "../../../src/harness/errors.ts";
import type { ModelAdapter } from "../../../src/harness/model-adapter/types.ts";
import type { FaultEvent } from "../../../src/harness/fault-class.ts";

const okResult = { role: "assistant" as const, content: [] };

function translate(err: unknown): FaultEvent {
  if (err instanceof PromptTooLongError) return { kind: "prompt_too_long" };
  if (err instanceof Error && err.message.startsWith("http:")) {
    const status = Number(err.message.slice("http:".length));
    return { kind: "llm_http", status };
  }
  if (err instanceof Error && err.message === "network") {
    return { kind: "llm_network" };
  }
  return { kind: "protocol_error" };
}

function abortErr(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

function stub(sequence: ReadonlyArray<unknown>): ModelAdapter & {
  readonly calls: number;
} {
  let calls = 0;
  const adapter = {
    get calls() {
      return calls;
    },
    step: async () => {
      const next = sequence[calls];
      calls += 1;
      if (next instanceof Error) throw next;
      return okResult as never;
    },
  };
  return adapter as ModelAdapter & { readonly calls: number };
}

describe("withTransportRetry", () => {
  it("empty: first success is delivered once with no extra step", async () => {
    const inner = stub([okResult]);
    const wrapped = withTransportRetry(inner, {
      translate,
      sleep: async () => undefined,
    });
    const a = await wrapped.step({} as never, {});
    const b = await wrapped.step({} as never, {});
    assert.equal(inner.calls, 2);
    assert.deepEqual(a, okResult);
    assert.deepEqual(b, okResult);
  });

  it("429 twice then success → one successful step result", async () => {
    const inner = stub([
      new Error("http:429"),
      new Error("http:429"),
      okResult,
    ]);
    const wrapped = withTransportRetry(inner, {
      translate,
      sleep: async () => undefined,
    });
    const result = await wrapped.step({} as never, {});
    assert.deepEqual(result, okResult);
    assert.equal(inner.calls, 3);
  });

  it("negative: PromptTooLongError is not retried (call count = 1)", async () => {
    const err = new PromptTooLongError("too long");
    const inner = stub([err]);
    const wrapped = withTransportRetry(inner, {
      translate,
      sleep: async () => {
        throw new Error("sleep must not run");
      },
    });
    await assert.rejects(
      () => wrapped.step({} as never, {}),
      (e: unknown) => e === err
    );
    assert.equal(inner.calls, 1);
  });

  it("overflow: exhausted 429 throws TransportRetryExhaustedError, not bare Error", async () => {
    const inner = stub([
      new Error("http:429"),
      new Error("http:503"),
      new Error("http:529"),
    ]);
    const wrapped = withTransportRetry(inner, {
      translate,
      maxAttempts: 3,
      sleep: async () => undefined,
    });
    await assert.rejects(
      () => wrapped.step({} as never, {}),
      (e: unknown) =>
        e instanceof TransportRetryExhaustedError &&
        e.attempts === 3 &&
        e.constructor !== Error
    );
    assert.equal(inner.calls, 3);
  });

  it("exception: abort during backoff is cancelled (AbortError), not bare Error", async () => {
    const inner = stub([new Error("http:429"), okResult]);
    const ac = new AbortController();
    const wrapped = withTransportRetry(inner, {
      translate,
      sleep: async (_ms, signal) => {
        ac.abort();
        if (signal?.aborted) throw abortErr();
        throw abortErr();
      },
    });
    await assert.rejects(
      () => wrapped.step({} as never, {}, ac.signal),
      (e: unknown) =>
        e instanceof DOMException &&
        e.name === "AbortError" &&
        !(e instanceof TransportRetryExhaustedError)
    );
    assert.equal(inner.calls, 1);
  });

  it("concurrent wraps do not share attempt counters", async () => {
    const a = stub([new Error("http:429"), okResult]);
    const b = stub([new Error("http:429"), okResult]);
    const wa = withTransportRetry(a, {
      translate,
      sleep: async () => undefined,
    });
    const wb = withTransportRetry(b, {
      translate,
      sleep: async () => undefined,
    });
    const [ra, rb] = await Promise.all([
      wa.step({} as never, {}),
      wb.step({} as never, {}),
    ]);
    assert.deepEqual(ra, okResult);
    assert.deepEqual(rb, okResult);
    assert.equal(a.calls, 2);
    assert.equal(b.calls, 2);
  });

  // Bug（2026-09-07）:重试此前完全静默,429/网络故障期间宿主无法显示
  // 「连接重试 1/5」类进度。每次退避重试前必须向 request.onStream 发
  // transport_retry 事件(attempt 从 1 计,成功路径不发)。
  // spec inv 4:事件里的 maxAttempts 与退避预算同源(TRANSPORT_MAX_ATTEMPTS),
  // 宿主可见的进度分母必须是实际生效的那份 SSOT。
  it("429 then success → onStream emits transport_retry 1/5 before backoff", async () => {
    const inner = stub([new Error("http:429"), okResult]);
    const wrapped = withTransportRetry(inner, {
      translate,
      sleep: async () => undefined,
    });
    const events: unknown[] = [];
    await wrapped.step({} as never, {
      onStream: (e) => events.push(e),
    });
    assert.equal(inner.calls, 2);
    assert.deepEqual(events, [
      {
        type: "transport_retry",
        attempt: 1,
        maxAttempts: 5,
        detail: "llm_http: 429",
      },
    ]);
  });

  it("first-attempt success → no transport_retry event", async () => {
    const inner = stub([okResult]);
    const wrapped = withTransportRetry(inner, {
      translate,
      sleep: async () => undefined,
    });
    const events: unknown[] = [];
    await wrapped.step({} as never, {
      onStream: (e) => events.push(e),
    });
    assert.deepEqual(events, []);
  });
});

/**
 * transport-continue-persist T1 / spec inv 4:
 * 秒级指数退避、有界尝试(5)、honor `retry-after`、非重试 4xx 不变。
 */
describe("withTransportRetry: spec inv 4 退避与预算", () => {
  it("默认预算 = 5 次尝试(第 5 次失败即耗尽,不再有第 6 次)", async () => {
    const inner = stub([
      new Error("http:429"),
      new Error("http:503"),
      new Error("http:529"),
      new Error("http:500"),
      new Error("http:502"),
    ]);
    const delays: number[] = [];
    const wrapped = withTransportRetry(inner, {
      translate,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await assert.rejects(
      () => wrapped.step({} as never, {}),
      (e: unknown) =>
        e instanceof TransportRetryExhaustedError && e.attempts === 5
    );
    assert.equal(inner.calls, 5);
    // 秒级指数:1s / 2s / 4s / 8s(4 次退避,5 次尝试)。
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
  });

  it("retry-after(秒)在场 → 退避不早于服务器给的时刻", async () => {
    const err = new Error("http:429");
    const inner = stub([err, okResult]);
    const delays: number[] = [];
    const wrapped = withTransportRetry(inner, {
      translate: () => ({ kind: "llm_http", status: 429, retryAfterMs: 3_000 }),
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const result = await wrapped.step({} as never, {});
    assert.deepEqual(result, okResult);
    assert.deepEqual(delays, [3_000]);
  });

  it("retry-after 长于退避上限 → 压到 cap(spec: 不无限等)", async () => {
    const inner = stub([new Error("http:503"), okResult]);
    const delays: number[] = [];
    const wrapped = withTransportRetry(inner, {
      translate: () => ({
        kind: "llm_http",
        status: 503,
        retryAfterMs: 600_000,
      }),
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await wrapped.step({} as never, {});
    assert.deepEqual(delays, [TRANSPORT_BACKOFF_CAP_MS]);
  });

  it("retry-after 短于退避表 → 用表值(不因短 header 提前重发)", async () => {
    const inner = stub([new Error("http:429"), okResult]);
    const delays: number[] = [];
    const wrapped = withTransportRetry(inner, {
      translate: () => ({ kind: "llm_http", status: 429, retryAfterMs: 100 }),
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await wrapped.step({} as never, {});
    assert.deepEqual(delays, [1_000]);
  });

  it("非重试 4xx(401/400)仍然一次即抛,不消耗退避", async () => {
    for (const status of [400, 401, 403, 404]) {
      const err = new Error(`http:${status}`);
      const inner = stub([err]);
      let slept = 0;
      const wrapped = withTransportRetry(inner, {
        translate,
        sleep: async () => {
          slept += 1;
        },
      });
      await assert.rejects(
        () => wrapped.step({} as never, {}),
        (e: unknown) => e === err
      );
      assert.equal(inner.calls, 1, `${status} 不得重试`);
      assert.equal(slept, 0, `${status} 不得退避`);
    }
  });

  it("translate 未命中(protocol_error)不重试 — 不得当成 user_cancel", async () => {
    const err = new Error("unclassified");
    const inner = stub([err]);
    const wrapped = withTransportRetry(inner, { translate });
    await assert.rejects(
      () => wrapped.step({} as never, {}),
      (e: unknown) => e === err
    );
    assert.equal(inner.calls, 1);
  });

  /**
   * spec inv 4 的「explicit network faults」格:真实 SDK 连接失败
   * (`APIConnectionError extends APIError`、`status === undefined`)必须经真
   * translator 落 retry 类 —— 否则 adapter 换了连接故障,重试路径整条不可达。
   */
  it("真实 SDK 连接故障经真 translator → 被重试(attempt > 1 且发 transport_retry)", async () => {
    const connErr = (): APIConnectionError =>
      new APIConnectionError({
        message: "Connection error.",
        cause: new TypeError("fetch failed"),
      });
    const inner = stub([connErr(), okResult]);
    const delays: number[] = [];
    const wrapped = withTransportRetry(inner, {
      translate: translateAnthropicTransportFault,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const events: unknown[] = [];
    const result = await wrapped.step({} as never, {
      onStream: (e) => events.push(e),
    });
    assert.deepEqual(result, okResult);
    assert.equal(inner.calls, 2);
    assert.deepEqual(delays, [1_000]);
    assert.deepEqual(events, [
      {
        type: "transport_retry",
        attempt: 1,
        maxAttempts: 5,
        detail: "llm_network",
      },
    ]);
  });

  it("连接故障耗尽预算 → TransportRetryExhaustedError(不裸抛连接错误)", async () => {
    const inner = stub([
      new APIConnectionError({ cause: new TypeError("fetch failed") }),
      new APIConnectionError({ cause: new TypeError("fetch failed") }),
      new APIConnectionError({ cause: new TypeError("fetch failed") }),
    ]);
    const wrapped = withTransportRetry(inner, {
      translate: translateAnthropicTransportFault,
      maxAttempts: 3,
      sleep: async () => undefined,
    });
    await assert.rejects(
      () => wrapped.step({} as never, {}),
      (e: unknown) =>
        e instanceof TransportRetryExhaustedError && e.attempts === 3
    );
    assert.equal(inner.calls, 3);
  });

  it("abort 在退避窗口内 → cancel,不再发起下一次 attempt", async () => {
    const inner = stub([new Error("http:429"), okResult]);
    const ac = new AbortController();
    const wrapped = withTransportRetry(inner, {
      translate,
      sleep: async () => {
        ac.abort();
        throw new DOMException("This operation was aborted", "AbortError");
      },
    });
    await assert.rejects(
      () => wrapped.step({} as never, {}, ac.signal),
      (e: unknown) =>
        e instanceof DOMException &&
        e.name === "AbortError" &&
        !(e instanceof TransportRetryExhaustedError)
    );
    assert.equal(inner.calls, 1);
  });
});

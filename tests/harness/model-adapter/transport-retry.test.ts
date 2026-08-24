/**
 * #672 T2: ModelAdapter.step 传输重试装饰器。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  withTransportRetry,
  TransportRetryExhaustedError,
} from "../../../src/harness/model-adapter/with-transport-retry.ts";
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
        !(e instanceof Error && e.name === "Error" && e.constructor === Error)
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
});

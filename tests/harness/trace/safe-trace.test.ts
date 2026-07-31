/**
 * safeTrace wrapper (T2, GH #64 ADR Decision 13)。
 *
 * 9 项契约:
 * 1. 成功 async fn → resolve 为其结果
 * 2. 成功 async fn (falsy/对象/0/"") → 原样回传
 * 3. async fn 抛 Error → resolve undefined
 * 4. async fn 抛非 Error → resolve undefined
 * 5. Promise.reject → resolve undefined
 * 6. Promise.reject 非 Error reason → resolve undefined
 * 7. 外部同步抛 (在 safeTrace 调用栈内) → assert.throws 捕获 (同步传播)
 * 8. 外部同步抛字符串 → 同步传播
 * 9. safeTrace 自身返回 Promise
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { safeTrace } from "../../../src/harness/trace/safe-trace.ts";

describe("safeTrace", () => {
  it("resolves to the async fn result on success", async () => {
    const result = await safeTrace(async () => 42);
    assert.equal(result, 42);
  });

  it("passes through falsy / 0 / empty string / object results unchanged", async () => {
    assert.equal(await safeTrace(async () => 0), 0);
    assert.equal(await safeTrace(async () => ""), "");
    assert.equal(await safeTrace(async () => null), null);
    const obj = { a: 1 };
    assert.strictEqual(await safeTrace(async () => obj), obj);
  });

  it("resolves undefined when the async fn throws an Error", async () => {
    const result = await safeTrace(async () => {
      throw new Error("boom");
    });
    assert.equal(result, undefined);
  });

  it("resolves undefined when the async fn throws a non-Error", async () => {
    const result = await safeTrace(async () => {
      throw "string-throw";
    });
    assert.equal(result, undefined);
  });

  it("resolves undefined when the returned Promise is rejected with Error", async () => {
    const result = await safeTrace(() => Promise.reject(new Error("rejected")));
    assert.equal(result, undefined);
  });

  it("resolves undefined when the returned Promise is rejected with a non-Error reason", async () => {
    const result = await safeTrace(() => Promise.reject("non-error reason"));
    assert.equal(result, undefined);
  });

  it("propagates a synchronous throw from inside the call stack of safeTrace (assert.throws)", () => {
    assert.throws(
      () =>
        safeTrace(() => {
          throw new Error("synchronous explosion");
        }),
      (err: unknown) =>
        err instanceof Error && err.message === "synchronous explosion"
    );
  });

  it("propagates a synchronous string throw (non-Error) from inside the call stack", () => {
    assert.throws(
      () =>
        safeTrace(() => {
          throw "sync-string";
        }),
      (err: unknown) => err === "sync-string"
    );
  });

  it("returns a Promise (itself thenable)", () => {
    const ret = safeTrace(async () => 1);
    assert.equal(typeof ret.then, "function");
    assert.equal(typeof ret.catch, "function");
  });
});

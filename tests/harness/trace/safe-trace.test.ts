/**
 * safeTrace wrapper contracts.
 *
 * Nine contracts:
 * 1. Successful async fn → resolves to its result
 * 2. Successful async fn (falsy / object / 0 / "") → result passed through as-is
 * 3. async fn throws Error → resolves undefined
 * 4. async fn throws non-Error → resolves undefined
 * 5. Promise.reject → resolves undefined
 * 6. Promise.reject with non-Error reason → resolves undefined
 * 7. External synchronous throw (inside safeTrace's call stack) → caught by assert.throws (propagates synchronously)
 * 8. External synchronous string throw → propagates synchronously
 * 9. safeTrace itself returns a Promise
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

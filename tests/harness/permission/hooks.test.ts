/**
 * New permission module — hooks.test.ts.
 *
 * - createNoOpHooks returns a frozen pair of no-op hooks.
 * - createHooksPair replaces one side; missing side falls back to no-op.
 * - A custom preToolUse that returns a decision short-circuits the executor.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createNoOpHooks,
  createHooksPair,
} from "../../../src/harness/permission/hooks.js";

describe("createNoOpHooks", () => {
  it("returns a frozen pair of no-op hooks", () => {
    const h = createNoOpHooks();
    assert.equal(h.preToolUse({ tool: "x", input: {} }), undefined);
    assert.equal(
      h.postToolUse({
        toolUseId: "u1",
        name: "x",
        input: {},
        kind: "ok",
      }),
      undefined
    );
    assert.equal(Object.isFrozen(h), true);
  });
});

describe("createHooksPair", () => {
  it("with no custom argument → matches no-op", () => {
    const h = createHooksPair();
    assert.equal(h.preToolUse({ tool: "x", input: {} }), undefined);
  });

  it("custom preToolUse overrides; missing postToolUse falls back", () => {
    const observed: Array<{ tool: string }> = [];
    const h = createHooksPair({
      preToolUse: ({ tool }) => {
        observed.push({ tool });
        return undefined;
      },
    });
    assert.equal(h.preToolUse({ tool: "t", input: {} }), undefined);
    assert.deepEqual(observed, [{ tool: "t" }]);
    // postToolUse is the no-op
    assert.equal(
      h.postToolUse({
        toolUseId: "u1",
        name: "t",
        input: {},
        kind: "ok",
      }),
      undefined
    );
  });

  it("custom preToolUse can short-circuit with a block (executor wraps as [hook_blocked])", async () => {
    const h = createHooksPair({
      preToolUse: () => ({ reason: "blocked by audit hook" }),
    });
    // #global-plugins T2：PreToolUseHook 返回类型放宽为含 Promise 的联合，
    // 断言前先 await（本 hook 同步返回，await 无代价）。
    const out = await h.preToolUse({
      tool: "write_file",
      input: { path: "x" },
    });
    assert.ok(out);
    assert.equal(out.reason, "blocked by audit hook");
  });
});

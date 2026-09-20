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
    // PreToolUseHook's return type was widened to a union including Promise;
    // await before asserting (this hook resolves synchronously, so await costs nothing).
    const out = await h.preToolUse({
      tool: "write_file",
      input: { path: "x" },
    });
    assert.ok(out);
    assert.equal(out.reason, "blocked by audit hook");
  });
});

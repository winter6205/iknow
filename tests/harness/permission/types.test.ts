/**
 * New permission module — basic shape tests for types.ts.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  DEFAULT_BY_CATEGORY,
  HARD_WALL_DENY_PREFIX,
} from "../../../src/harness/permission/policy.js";
import type {
  AskUser,
  PermissionDecision,
  PermissionOutcome,
  PreToolUseHook,
  PostToolUseHook,
} from "../../../src/harness/permission/types.js";

describe("types — basic shape", () => {
  it("PermissionDecision is the three-value union", () => {
    const decisions: PermissionDecision[] = ["allow", "deny", "ask"];
    assert.deepEqual(decisions.sort(), ["allow", "ask", "deny"]);
  });

  it("PermissionOutcome carries decision + reason", () => {
    const o: PermissionOutcome = { decision: "allow", reason: "x" };
    assert.equal(typeof o.decision, "string");
    assert.equal(typeof o.reason, "string");
  });

  it("DEFAULT_BY_CATEGORY ships Q4 verdicts", () => {
    assert.equal(DEFAULT_BY_CATEGORY["read-only"], "allow");
    assert.equal(DEFAULT_BY_CATEGORY.write, "ask");
    assert.equal(DEFAULT_BY_CATEGORY.execute, "ask");
    assert.equal(DEFAULT_BY_CATEGORY.collaborate, "ask");
    assert.equal(Object.isFrozen(DEFAULT_BY_CATEGORY), true);
  });

  it("HARD_WALL_DENY_PREFIX distinguishes source", () => {
    assert.ok(HARD_WALL_DENY_PREFIX.startsWith("["));
    assert.notEqual(HARD_WALL_DENY_PREFIX, "[permission_denied]");
    assert.notEqual(HARD_WALL_DENY_PREFIX, "[hook_blocked]");
    assert.notEqual(HARD_WALL_DENY_PREFIX, "[user_denied]");
  });

  it("AskUser signature accepts the (ctx) shape", () => {
    const ask: AskUser = async () => true;
    // smoke: invoking returns a Promise<boolean>
    const p = ask({ tool: "x", input: {}, summaryHint: "" });
    assert.ok(p instanceof Promise);
    p.then((v) => assert.equal(v, true));
  });

  it("PreToolUseHook is deny-only: undefined (pass) or PreHookBlock (block)", () => {
    const h: PreToolUseHook = () => undefined;
    assert.equal(h({ tool: "x", input: {} }), undefined);
    const h2: PreToolUseHook = () => ({ reason: "y" });
    assert.deepEqual(h2({ tool: "x", input: {} }), { reason: "y" });
  });

  it("PostToolUseHook can return undefined or void", () => {
    const h: PostToolUseHook = () => undefined;
    assert.equal(
      h({
        toolUseId: "u1",
        name: "x",
        input: {},
        kind: "ok",
      }),
      undefined
    );
  });
});

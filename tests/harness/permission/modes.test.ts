/**
 * Tests for PermissionMode (W2).
 *
 * Covers:
 *  - parsePermissionMode accepts canonical values + rejects anything else.
 *  - createPermissionModeContext starts at the given value, get reflects
 *    updates from set, and the context object itself is frozen.
 *  - asModeContext normalizes string vs context vs undefined.
 *  - checkPermission applies mode in the right order:
 *    hard-walls > layers > full_auto (allow) > plan (deny mutating) >
 *    category default. Mode never relaxes hard-walls.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  parsePermissionMode,
  createPermissionModeContext,
  asModeContext,
  modeLabel,
  nextShiftTabMode,
} from "../../../src/harness/permission/modes.js";
import {
  checkPermission,
  createPermissionPolicy,
  DEFAULT_BY_CATEGORY,
} from "../../../src/harness/permission/policy.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";

function fakeToolDef(
  name: string,
  category: AciToolDef["aci"]["category"]
): AciToolDef {
  return {
    name,
    description: "",
    inputSchema: { type: "object", properties: {} },
    handler: async () => "",
    aci: { category, isConcurrencySafe: false, interruptBehavior: "block" },
  };
}

describe("parsePermissionMode (W2)", () => {
  it("accepts canonical modes", () => {
    for (const m of PERMISSION_MODES) {
      assert.equal(parsePermissionMode(m), m);
      assert.equal(parsePermissionMode(m.toUpperCase()), m);
      assert.equal(parsePermissionMode(`  ${m}  `), m);
    }
  });

  it("rejects unknown values", () => {
    assert.equal(parsePermissionMode("auto"), undefined);
    assert.equal(parsePermissionMode(""), undefined);
    assert.equal(parsePermissionMode(undefined), undefined);
    assert.equal(parsePermissionMode(42), undefined);
    assert.equal(parsePermissionMode(null), undefined);
  });

  it("DEFAULT_PERMISSION_MODE is 'default'", () => {
    assert.equal(DEFAULT_PERMISSION_MODE, "default");
  });
});

describe("createPermissionModeContext (W2)", () => {
  it("starts at the given value", () => {
    const ctx = createPermissionModeContext("full_auto");
    assert.equal(ctx.get(), "full_auto");
  });

  it("defaults to 'default' when no initial value", () => {
    const ctx = createPermissionModeContext();
    assert.equal(ctx.get(), "default");
  });

  it("set mutates and get reflects", () => {
    const ctx = createPermissionModeContext("default");
    ctx.set("plan");
    assert.equal(ctx.get(), "plan");
    ctx.set("full_auto");
    assert.equal(ctx.get(), "full_auto");
    ctx.set("default");
    assert.equal(ctx.get(), "default");
  });

  it("context object is frozen (cannot reassign get/set)", () => {
    const ctx = createPermissionModeContext();
    assert.ok(Object.isFrozen(ctx));
  });
});

describe("modeLabel (W2 扩展)", () => {
  it("maps canonical modes to human-readable labels", () => {
    assert.equal(modeLabel("default"), "Default");
    assert.equal(modeLabel("plan"), "Plan Mode");
    assert.equal(modeLabel("full_auto"), "Auto");
  });
});

describe("nextShiftTabMode (W2 扩展)", () => {
  it("default → full_auto (opt-in auto)", () => {
    assert.equal(nextShiftTabMode("default"), "full_auto");
  });

  it("full_auto → default (handbrake)", () => {
    assert.equal(nextShiftTabMode("full_auto"), "default");
  });

  it("plan → full_auto (jumps straight to go-mode, never default)", () => {
    assert.equal(nextShiftTabMode("plan"), "full_auto");
  });
});

describe("asModeContext (W2)", () => {
  it("returns a default context for undefined", () => {
    const ctx = asModeContext(undefined);
    assert.equal(ctx.get(), "default");
  });

  it("returns a static-string-backed context for string input", () => {
    const ctx = asModeContext("full_auto");
    assert.equal(ctx.get(), "full_auto");
  });

  it("returns the same context when given a context", () => {
    const original = createPermissionModeContext("plan");
    const same = asModeContext(original);
    assert.strictEqual(same, original);
  });
});

describe("checkPermission mode integration (W2)", () => {
  function policyWithMode(
    mode: ReturnType<typeof createPermissionModeContext>
  ) {
    return createPermissionPolicy({ mode });
  }

  it("default mode + write → ask (preserves today)", () => {
    const policy = policyWithMode(createPermissionModeContext("default"));
    const outcome = checkPermission({
      def: fakeToolDef("write_file", "write"),
      input: { path: "a.ts", content: "x" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });
    assert.equal(outcome.decision, "ask");
  });

  it("full_auto + write → allow (mode fills the gap)", () => {
    const policy = policyWithMode(createPermissionModeContext("full_auto"));
    const outcome = checkPermission({
      def: fakeToolDef("write_file", "write"),
      input: { path: "a.ts", content: "x" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });
    assert.equal(outcome.decision, "allow");
    assert.match(outcome.reason, /full_auto/);
  });

  it("plan + write → deny (no ask)", () => {
    const policy = policyWithMode(createPermissionModeContext("plan"));
    const outcome = checkPermission({
      def: fakeToolDef("write_file", "write"),
      input: { path: "a.ts", content: "x" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });
    assert.equal(outcome.decision, "deny");
    assert.match(outcome.reason, /plan/);
  });

  it("plan + read-only → allow", () => {
    const policy = policyWithMode(createPermissionModeContext("plan"));
    const outcome = checkPermission({
      def: fakeToolDef("read_file", "read-only"),
      input: { path: "a.ts" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });
    assert.equal(outcome.decision, "allow");
  });

  it("full_auto does NOT relax hard-walls (sensitive path still deny)", () => {
    const policy = policyWithMode(createPermissionModeContext("full_auto"));
    const outcome = checkPermission({
      def: fakeToolDef("write_file", "write"),
      input: { path: "/home/user/.ssh/authorized_keys" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });
    assert.equal(outcome.decision, "deny");
    assert.match(outcome.reason, /hard_wall/);
  });

  it("mode flip is visible on the next checkPermission call (no rebuild)", () => {
    const policy = policyWithMode(createPermissionModeContext("default"));
    const def = fakeToolDef("bash", "execute");
    const input = { command: "echo hi" };

    const before = checkPermission({
      def,
      input,
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });
    assert.equal(before.decision, "ask");

    policy.mode.set("full_auto");

    const after = checkPermission({
      def,
      input,
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });
    assert.equal(after.decision, "allow");
    assert.match(after.reason, /full_auto/);
  });

  it("layered code rule beats mode (memory_save allow stays allow in plan)", () => {
    // memory_save has a code-built-in allow rule, so plan mode cannot downgrade
    // it via mode path because layer rules fire FIRST.
    const policy = policyWithMode(createPermissionModeContext("plan"));
    const outcome = checkPermission({
      def: fakeToolDef("memory_save", "write"),
      input: {},
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });
    assert.equal(outcome.decision, "allow");
    assert.match(outcome.reason, /memory_save/);
  });
});

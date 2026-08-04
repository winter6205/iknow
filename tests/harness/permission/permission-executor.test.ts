/**
 * New permission module — permission-executor.test.ts.
 *
 * 5-step chain:
 *   preToolUse → checkPermission → askUser → inner → postToolUse
 *
 * - recorded hook order is verified via a recorder HooksPair.
 * - hook_blocked prefix is verified.
 * - permission_denied prefix is verified (zero inner calls).
 * - user_denied prefix is verified when askUser returns false.
 * - construction with no askUser throws `ask_inlet_missing`.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createPermissionExecutor,
  createAciCatalog,
} from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import type {
  AciToolDef,
  AciCategory,
} from "../../../src/harness/aci/types.js";
import type {
  Executor,
  Registry,
  ToolCall,
  ToolExecutionResult,
  ToolDef,
} from "../../../src/harness/tools/types.js";
import type {
  PreToolUseHook,
  PostToolUseHook,
} from "../../../src/harness/permission/types.js";

interface MakeToolOpts {
  readonly name: string;
  readonly category: AciCategory;
}

function makeAciTool(opts: MakeToolOpts): AciToolDef {
  const { name, category } = opts;
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category,
      isConcurrencySafe: category === "read-only",
      interruptBehavior:
        category === "write" ? ("block" as const) : ("cancel" as const),
      timeoutTier: "default" as const,
    }),
  });
}

function makeRegistry(defs: AciToolDef[]): Registry {
  const all: ToolDef[] = defs;
  return Object.freeze({
    list: () => all,
    get: (name: string) => all.find((t) => t.name === name),
  });
}

function makeInnerSpy(): { executor: Executor; calls: ToolCall[][] } {
  const calls: ToolCall[][] = [];
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      calls.push([...batch]);
      return batch.map((c) => ({
        kind: "ok" as const,
        toolUseId: c.id,
        payload: [{ type: "text" as const, text: `executed:${c.name}` }],
      }));
    },
  });
  return { executor, calls };
}

interface Recorder {
  order: string[];
  pre?: PreToolUseHook;
  post?: PostToolUseHook;
}

function makeRecorder(): Recorder {
  const r: Recorder = { order: [] };
  r.pre = () => {
    r.order.push("pre");
    return undefined;
  };
  r.post = () => {
    r.order.push("post");
  };
  return r;
}

describe("createPermissionExecutor — construction", () => {
  it("throws with ask_inlet_missing if askUser is missing", () => {
    const reg = makeRegistry([
      makeAciTool({ name: "grep", category: "read-only" }),
    ]);
    assert.throws(
      () =>
        createPermissionExecutor({
          inner: makeInnerSpy().executor,
          registry: reg,
          policy: createPermissionPolicy(),
          // @ts-expect-error: intentional — check the runtime check
          askUser: undefined,
        }),
      /ask_inlet_missing/
    );
  });
});

describe("createPermissionExecutor — 5-step chain order", () => {
  it("on allow: pre → check (allow) → inner → post", async () => {
    const tool = makeAciTool({ name: "grep", category: "read-only" });
    const reg = makeRegistry([tool]);
    const rec = makeRecorder();
    const { executor: inner, calls } = makeInnerSpy();
    const policy = createPermissionPolicy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy,
      askUser: async () => true,
      preToolUse: rec.pre,
      postToolUse: rec.post,
    });
    const result = await ex.executeAll([
      { id: "u1", name: "grep", input: { pattern: "*.ts" } },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.kind, "ok");
    assert.deepEqual(rec.order, ["pre", "post"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0]!.name, "grep");
  });

  it("hook_blocked short-circuits with prefix; inner never called", async () => {
    const tool = makeAciTool({ name: "grep", category: "read-only" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const policy = createPermissionPolicy();
    const pre: PreToolUseHook = () => ({
      decision: "deny",
      reason: "audit-rejected",
    });
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy,
      askUser: async () => true,
      preToolUse: pre,
    });
    const result = await ex.executeAll([
      { id: "u1", name: "grep", input: { pattern: "*.ts" } },
    ]);
    assert.equal(result.length, 1);
    const r = result[0]!;
    assert.equal(r.kind, "execution_failed");
    if (r.kind === "execution_failed") {
      assert.ok(r.message.startsWith("[hook_blocked]"));
      assert.ok(r.message.includes("audit-rejected"));
    }
    assert.equal(calls.length, 0);
  });
});

describe("createPermissionExecutor — deny (hard-wall) zero side effect", () => {
  it("bash rm -rf → [permission_denied] + inner never called", async () => {
    const tool = makeAciTool({ name: "bash", category: "execute" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const policy = createPermissionPolicy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy,
      askUser: async () => true,
    });
    const result = await ex.executeAll([
      { id: "u1", name: "bash", input: { command: "rm -rf /" } },
    ]);
    const r = result[0]!;
    assert.equal(r.kind, "execution_failed");
    if (r.kind === "execution_failed") {
      assert.ok(r.message.startsWith("[permission_denied]"));
      assert.ok(r.message.includes("[hard_wall]"));
    }
    assert.equal(calls.length, 0);
  });
});

describe("createPermissionExecutor — ask path", () => {
  it("ask decision + approve → inner called", async () => {
    const tool = makeAciTool({ name: "edit_file", category: "write" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const policy = createPermissionPolicy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy,
      askUser: async () => true,
    });
    const result = await ex.executeAll([
      { id: "u1", name: "edit_file", input: { path: "x.ts" } },
    ]);
    assert.equal(result[0]!.kind, "ok");
    assert.equal(calls.length, 1);
  });

  it("ask decision + decline → [user_denied]; inner never called", async () => {
    const tool = makeAciTool({ name: "edit_file", category: "write" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const policy = createPermissionPolicy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy,
      askUser: async () => false,
    });
    const result = await ex.executeAll([
      { id: "u1", name: "edit_file", input: { path: "x.ts" } },
    ]);
    const r = result[0]!;
    assert.equal(r.kind, "execution_failed");
    if (r.kind === "execution_failed") {
      assert.ok(r.message.startsWith("[user_denied]"));
      assert.ok(r.message.includes("user declined"));
    }
    assert.equal(calls.length, 0);
  });
});

describe("createPermissionExecutor — unknown tool → delegate to inner", () => {
  it("catalog miss → inner called with same ToolCall", async () => {
    const reg = makeRegistry([]); // empty catalog
    const { executor: inner, calls } = makeInnerSpy();
    const policy = createPermissionPolicy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy,
      askUser: async () => true,
    });
    const result = await ex.executeAll([
      { id: "u1", name: "unknown_tool", input: {} },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.kind, "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0]!.name, "unknown_tool");
  });
});

describe("createAciCatalog", () => {
  it("returns a catalog backed by the registry", () => {
    const tool = makeAciTool({ name: "grep", category: "read-only" });
    const cat = createAciCatalog(makeRegistry([tool]));
    const got = cat.get("grep");
    assert.ok(got);
    assert.equal(got!.aci.category, "read-only");
    const all = cat.all();
    assert.equal(all.length, 1);
  });
});

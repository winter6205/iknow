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
  type HookErrorEvent,
} from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import { createExecutor } from "../../../src/harness/tools/executor.js";
import { createRegistry } from "../../../src/harness/tools/registry.js";
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
  AskUser,
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

  it("postToolUse 收到 meta(ok 变体) — side-channel 透传(#298)", async () => {
    const tool = makeAciTool({ name: "edit_file", category: "write" });
    const reg = makeRegistry([tool]);
    let capturedMeta: unknown;
    const post: PostToolUseHook = (result) => {
      capturedMeta = result.meta;
    };
    // inner returns an ok result carrying meta (mirrors the executor filling it from the handler envelope).
    const innerWithMeta: Executor = Object.freeze({
      executeAll: async (
        batch: ReadonlyArray<ToolCall>
      ): Promise<ReadonlyArray<ToolExecutionResult>> =>
        batch.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: "done" }],
          meta: { oldContent: "old\n", newContent: "new\n" },
        })),
    });
    const ex = createPermissionExecutor({
      inner: innerWithMeta,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
      postToolUse: post,
    });
    await ex.executeAll([
      { id: "u1", name: "edit_file", input: { path: "a.ts" } },
    ]);
    assert.deepEqual(capturedMeta, {
      oldContent: "old\n",
      newContent: "new\n",
    });
  });

  it("hook_blocked short-circuits with prefix; inner never called", async () => {
    const tool = makeAciTool({ name: "grep", category: "read-only" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const policy = createPermissionPolicy();
    const pre: PreToolUseHook = () => ({
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

describe("createPermissionExecutor — cancellable ask path", () => {
  it("aborting while AskUser waits returns the typed cancelled result immediately", async () => {
    const tool = makeAciTool({ name: "edit_file", category: "write" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const controller = new AbortController();
    const askUser: AskUser = (ctx) =>
      new Promise<boolean>((resolve) => {
        ctx.signal?.addEventListener("abort", () => resolve(false), {
          once: true,
        });
      });
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser,
    });

    const execution = ex.executeAll(
      [{ id: "u1", name: "edit_file", input: { path: "x.ts" } }],
      controller.signal
    );
    await Promise.resolve();
    controller.abort();

    const result = await Promise.race([
      execution,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("permission ask did not cancel")),
          100
        )
      ),
    ]);
    assert.equal(result[0]!.kind, "execution_failed");
    if (result[0]!.kind === "execution_failed") {
      assert.equal(result[0]!.message, "cancelled");
    }
    assert.equal(calls.length, 0);
  });

  it("ignores approval returned after caller abort", async () => {
    let handlerCalls = 0;
    const tool = Object.freeze({
      ...makeAciTool({ name: "edit_file", category: "write" }),
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      handler: async () => {
        handlerCalls += 1;
        return "must not execute";
      },
    });
    const registry = createRegistry([tool]);
    const controller = new AbortController();
    let resolvePromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });
    let lateApprove!: () => void;
    const askUser: AskUser = async () => {
      resolvePromptStarted();
      return new Promise<boolean>((resolve) => {
        lateApprove = () => resolve(true);
      });
    };
    const ex = createPermissionExecutor({
      inner: createExecutor(registry),
      registry,
      policy: createPermissionPolicy(),
      askUser,
    });

    const execution = ex.executeAll(
      [{ id: "u1", name: tool.name, input: { path: "x.ts" } }],
      controller.signal
    );
    await promptStarted;
    controller.abort();
    lateApprove();

    const result = (await execution)[0]!;
    assert.equal(handlerCalls, 0, "late approval must not reach the handler");
    assert.equal(result.kind, "execution_failed");
    if (result.kind === "execution_failed") {
      assert.equal(result.message, "cancelled");
    }
  });

  it("AskUser errors fail closed as a user denial instead of rejecting executeAll", async () => {
    const tool = makeAciTool({ name: "edit_file", category: "write" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => {
        throw new Error("approval inlet failed");
      },
    });

    const result = await ex.executeAll([
      { id: "u1", name: "edit_file", input: { path: "x.ts" } },
    ]);
    assert.equal(result[0]!.kind, "execution_failed");
    if (result[0]!.kind === "execution_failed") {
      assert.ok(result[0]!.message.startsWith("[user_denied]"));
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

describe("createPermissionExecutor — pre-hook exception → fail-closed", () => {
  it("pre throws → [hook_error] execution_failed, inner zero calls, loop continues", async () => {
    const tool = makeAciTool({ name: "grep", category: "read-only" });
    const reg = makeRegistry([
      tool,
      makeAciTool({ name: "glob", category: "read-only" }),
    ]);
    const { executor: inner, calls } = makeInnerSpy();
    const policy = createPermissionPolicy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy,
      askUser: async () => true,
      preToolUse: ({ tool: name }) => {
        if (name === "grep") throw new Error("pre-hook blew up");
        return undefined;
      },
    });
    const result = await ex.executeAll([
      { id: "u1", name: "grep", input: { pattern: "*.ts" } },
      { id: "u2", name: "glob", input: { pattern: "*.js" } },
    ]);
    assert.equal(result.length, 2);
    const first = result[0]!;
    assert.equal(first.kind, "execution_failed");
    if (first.kind === "execution_failed") {
      assert.ok(first.message.startsWith("[hook_error]"), first.message);
      assert.ok(first.message.includes("pre-hook threw"), first.message);
      assert.ok(first.message.includes("pre-hook blew up"), first.message);
    }
    // fail-closed: grep is blocked; inner only receives the later, normally released glob (no grep).
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0]!.name, "glob");
    // the loop continues: the second call is released and executes normally.
    const second = result[1]!;
    assert.equal(second.kind, "ok");
  });
});

describe("createPermissionExecutor — #global-plugins T2 异步钩子", () => {
  it("await 覆盖异步 pre：Promise<block> 仍拦下（不被当 truthy Promise 放行）", async () => {
    const tool = makeAciTool({ name: "grep", category: "read-only" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
      preToolUse: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { reason: "async plugin denied" };
      },
    });
    const result = await ex.executeAll([
      { id: "u1", name: "grep", input: { pattern: "*.ts" } },
    ]);
    const r = result[0]!;
    assert.equal(r.kind, "execution_failed");
    if (r.kind === "execution_failed") {
      assert.ok(r.message.startsWith("[hook_blocked]"));
      assert.ok(r.message.includes("async plugin denied"));
    }
    assert.equal(calls.length, 0, "block 后 inner 不得执行");
  });

  it("异步 pre 拒绝 → fail-closed（既有 try/catch 收 rejected promise）", async () => {
    const tool = makeAciTool({ name: "grep", category: "read-only" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const fired: HookErrorEvent[] = [];
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
      preToolUse: async () => {
        throw new Error("async pre exploded");
      },
      onHookError: (e) => fired.push(e),
    });
    const result = await ex.executeAll([
      { id: "u1", name: "grep", input: { pattern: "*.ts" } },
    ]);
    const r = result[0]!;
    assert.equal(r.kind, "execution_failed");
    if (r.kind === "execution_failed") {
      assert.ok(r.message.startsWith("[hook_error]"));
      assert.ok(r.message.includes("async pre exploded"));
    }
    assert.equal(calls.length, 0, "fail-closed：inner 不得执行");
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.phase, "pre");
  });

  it("异步 pre 放行（resolve undefined）→ 正常执行", async () => {
    const tool = makeAciTool({ name: "grep", category: "read-only" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
      preToolUse: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return undefined;
      },
    });
    const result = await ex.executeAll([
      { id: "u1", name: "grep", input: { pattern: "*.ts" } },
    ]);
    assert.equal(result[0]!.kind, "ok");
    assert.equal(calls.length, 1);
  });

  it("异步 post resolve → 结果不变且 post 已 await（顺序可观测）", async () => {
    const tool = makeAciTool({ name: "grep", category: "read-only" });
    const reg = makeRegistry([tool]);
    const { executor: inner } = makeInnerSpy();
    const observed: string[] = [];
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
      postToolUse: async () => {
        await new Promise((r) => setTimeout(r, 10));
        observed.push("post-done");
      },
    });
    const out = await ex.executeAll([
      { id: "u1", name: "grep", input: { pattern: "*.ts" } },
    ]);
    // await semantics: post has finished by the time executeAll returns (the
    // fire-and-forget relaxation keeps "post observed before the result returns"
    // and only funnels rejections into catch).
    assert.deepEqual(observed, ["post-done"]);
    assert.equal(out[0]!.kind, "ok");
  });

  it("异步 post 拒绝 → 结果不变 + onHookError(post)；不产生 unhandledRejection", async () => {
    const tool = makeAciTool({ name: "edit_file", category: "write" });
    const reg = makeRegistry([tool]);
    const { executor: inner } = makeInnerSpy();
    const fired: HookErrorEvent[] = [];
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const ex = createPermissionExecutor({
        inner,
        registry: reg,
        policy: createPermissionPolicy(),
        askUser: async () => true,
        postToolUse: async () => {
          throw new Error("async post exploded");
        },
        onHookError: (e) => fired.push(e),
      });
      const out = await ex.executeAll([
        { id: "u1", name: "edit_file", input: { path: "a.ts" } },
      ]);
      assert.equal(out[0]!.kind, "ok");
      assert.equal(fired.length, 1);
      assert.equal(fired[0]!.phase, "post");
      assert.ok(fired[0]!.message.includes("async post exploded"));
      // drain the microtask queue before asserting: no escaped rejected promise.
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(rejections, []);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("createPermissionExecutor — post-hook exception → fire-and-forget", () => {
  it("post throws → result identical to no-throw case; onHookError fired", async () => {
    const tool = makeAciTool({ name: "edit_file", category: "write" });
    const reg = makeRegistry([tool]);
    const policy = createPermissionPolicy();
    const call: ToolCall = {
      id: "u1",
      name: "edit_file",
      input: { path: "a.ts" },
    };

    const make = (
      post: PostToolUseHook | undefined,
      onHookError: (e: HookErrorEvent) => void
    ) => {
      const { executor: inner } = makeInnerSpy();
      return createPermissionExecutor({
        inner,
        registry: reg,
        policy,
        askUser: async () => true,
        postToolUse: post,
        onHookError,
      });
    };

    // baseline: post without throwing
    const baseline = await make(undefined, () => undefined).executeAll([call]);
    const baselineResult = baseline[0]!;
    assert.equal(baselineResult.kind, "ok");

    // post throws
    const fired: Array<HookErrorEvent> = [];
    const threw = await make(
      () => {
        throw new Error("post-hook blew up");
      },
      (e) => fired.push(e)
    ).executeAll([call]);
    assert.equal(threw[0]!.kind, baselineResult.kind);
    assert.deepEqual(threw[0], baselineResult);

    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.phase, "post");
    assert.equal(fired[0]!.tool, "edit_file");
    assert.ok(fired[0]!.message.includes("post-hook blew up"));
  });
});

describe("createPermissionExecutor — hook-error reason redaction", () => {
  it("pre message with sensitive + overlong error → excludes input original, ≤200 chars", async () => {
    const tool = makeAciTool({ name: "bash", category: "execute" });
    const reg = makeRegistry([tool]);
    const { executor: inner, calls } = makeInnerSpy();
    const policy = createPermissionPolicy();
    const ex = createPermissionExecutor({
      inner,
      registry: reg,
      policy,
      askUser: async () => true,
      preToolUse: ({ input }) => {
        // the error message embeds the raw input (incl. a secret) plus overlong padding
        throw new Error(`${JSON.stringify(input)} ${"x".repeat(500)}`);
      },
    });
    const input = { command: "cat id_rsa", apiKey: "sk-secret-abc" };
    const result = await ex.executeAll([{ id: "u1", name: "bash", input }]);
    const r = result[0]!;
    assert.equal(r.kind, "execution_failed");
    if (r.kind === "execution_failed") {
      // the assembled message is capped at 200 chars
      assert.ok(r.message.length <= 200, `message length ${r.message.length}`);
      // never echo raw input content back (the core of redaction)
      assert.ok(!r.message.includes("sk-secret-abc"), r.message);
      assert.ok(!r.message.includes("id_rsa"), r.message);
    }
    assert.equal(calls.length, 0);
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

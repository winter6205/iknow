/**
 * ACI 原型 Layer 0：aci-executor 单元测试。
 * 覆盖：deny 不调 inner（spy）/ allow 委托 / 顺序保持 / 未知工具交 inner。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createPermissionPolicy } from "../../../src/harness/aci/permission.ts";
import type {
  AciCatalog,
  AciToolDef,
  PermissionOutcome,
} from "../../../src/harness/aci/types.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";

function makeTool(name: string, category: "read-only" | "write" | "execute"): AciToolDef {
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: {
      category,
      isReadOnly: category === "read-only",
      isDestructive: category === "execute",
      isConcurrencySafe: category === "read-only",
      interruptBehavior: "cancel" as const,
    },
  });
}

function makeCatalog(tools: AciToolDef[]): AciCatalog {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return Object.freeze({
    get: (name: string) => byName.get(name),
    all: () => Object.freeze([...tools]) as ReadonlyArray<AciToolDef>,
  });
}

/** 记录每次 executeAll 调用的 spy Executor。 */
function makeSpyExecutor(): {
  executor: Executor;
  calls: ToolCall[][];
} {
  const calls: ToolCall[][] = [];
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>,
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

describe("createAciExecutor — deny 路径不调 inner", () => {
  it("execute + 危险命令 → execution_failed [permission_denied]，inner 零调用", async () => {
    const { executor: spy, calls } = makeSpyExecutor();
    const tool = makeTool("shell_exec", "execute");
    const catalog = makeCatalog([tool]);
    const aciExec = createAciExecutor(spy, catalog);

    const results = await aciExec.executeAll([
      { id: "u1", name: "shell_exec", input: { command: "rm -rf /" } },
    ]);

    assert.equal(results.length, 1);
    const r = results[0]!;
    assert.equal(r.kind, "execution_failed");
    if (r.kind === "execution_failed") {
      assert.equal(r.toolUseId, "u1");
      assert.ok(r.message.startsWith("[permission_denied]"));
      // allowlist-first: rm 不在白名单，reason 含 "command not in allowlist"
      assert.ok(
        r.message.includes("command not in allowlist"),
        `expected allowlist denial, got: ${r.message}`,
      );
    }
    // inner 从未被调用
    assert.equal(calls.length, 0);
  });
});

describe("createAciExecutor — allow 路径委托 inner", () => {
  it("read-only 工具 → 委托 inner，返回 ok", async () => {
    const { executor: spy, calls } = makeSpyExecutor();
    const tool = makeTool("fs_search", "read-only");
    const catalog = makeCatalog([tool]);
    const aciExec = createAciExecutor(spy, catalog);

    const results = await aciExec.executeAll([
      { id: "u1", name: "fs_search", input: { pattern: "*.ts" } },
    ]);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.kind, "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0]!.id, "u1");
  });

  it("execute + 安全命令 → 委托 inner", async () => {
    const { executor: spy, calls } = makeSpyExecutor();
    const tool = makeTool("shell_exec", "execute");
    const catalog = makeCatalog([tool]);
    const aciExec = createAciExecutor(spy, catalog);

    const results = await aciExec.executeAll([
      { id: "u2", name: "shell_exec", input: { command: "ls -la" } },
    ]);

    assert.equal(results[0]!.kind, "ok");
    assert.equal(calls.length, 1);
  });
});

describe("createAciExecutor — 顺序保持", () => {
  it("多个 call 按序执行，结果顺序与 calls 一致", async () => {
    const { executor: spy } = makeSpyExecutor();
    const tools = [makeTool("fs_search", "read-only"), makeTool("fs_edit", "write")];
    const catalog = makeCatalog(tools);
    const aciExec = createAciExecutor(spy, catalog);

    const results = await aciExec.executeAll([
      { id: "a", name: "fs_search", input: {} },
      { id: "b", name: "fs_edit", input: {} },
      { id: "c", name: "fs_search", input: {} },
    ]);

    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["a", "b", "c"],
    );
    assert.ok(results.every((r) => r.kind === "ok"));
  });

  it("混合 deny + allow：deny 不短路，后续 call 继续执行", async () => {
    const { executor: spy, calls } = makeSpyExecutor();
    const tools = [makeTool("shell_exec", "execute"), makeTool("fs_search", "read-only")];
    const catalog = makeCatalog(tools);
    const aciExec = createAciExecutor(spy, catalog);

    const results = await aciExec.executeAll([
      { id: "x", name: "shell_exec", input: { command: "rm -rf /" } },
      { id: "y", name: "fs_search", input: {} },
    ]);

    assert.equal(results.length, 2);
    assert.equal(results[0]!.kind, "execution_failed");
    assert.equal(results[1]!.kind, "ok");
    assert.equal(results[1]!.toolUseId, "y");
    // inner 只为 y 调用了一次
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0]!.id, "y");
  });
});

describe("createAciExecutor — 未知工具交 inner", () => {
  it("catalog 查不到 → 委托 inner（inner 产 tool_not_found）", async () => {
    const { executor: spy, calls } = makeSpyExecutor();
    const catalog = makeCatalog([]); // 空 catalog
    const aciExec = createAciExecutor(spy, catalog);

    const results = await aciExec.executeAll([
      { id: "u1", name: "nonexistent", input: {} },
    ]);

    // spy 返回 ok（模拟 inner 行为）；关键是 inner 被调用了
    assert.equal(results.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0]!.name, "nonexistent");
  });
});

describe("createAciExecutor — onDecision 钩子", () => {
  it("每次决策触发 onDecision，不影响决策结果", async () => {
    const { executor: spy } = makeSpyExecutor();
    const tool = makeTool("shell_exec", "execute");
    const catalog = makeCatalog([tool]);
    const decisions: Array<{ call: ToolCall; outcome: PermissionOutcome }> = [];
    const aciExec = createAciExecutor(spy, catalog, {
      onDecision: (call, outcome) => decisions.push({ call, outcome }),
    });

    await aciExec.executeAll([
      { id: "u1", name: "shell_exec", input: { command: "rm -rf /" } },
      { id: "u2", name: "shell_exec", input: { command: "ls" } },
    ]);

    assert.equal(decisions.length, 2);
    assert.equal(decisions[0]!.outcome.decision, "deny");
    assert.equal(decisions[1]!.outcome.decision, "allow");
  });
});

describe("createAciExecutor — 自定义 policy", () => {
  it("byName always_deny 覆盖 read-only 默认", async () => {
    const { executor: spy, calls } = makeSpyExecutor();
    const tool = makeTool("fs_search", "read-only");
    const catalog = makeCatalog([tool]);
    const policy = createPermissionPolicy({ byName: { fs_search: "always_deny" } });
    const aciExec = createAciExecutor(spy, catalog, { policy });

    const results = await aciExec.executeAll([
      { id: "u1", name: "fs_search", input: {} },
    ]);

    assert.equal(results[0]!.kind, "execution_failed");
    if (results[0]!.kind === "execution_failed") {
      assert.ok((results[0] as { message: string }).message.startsWith("[permission_denied]"));
    }
    assert.equal(calls.length, 0);
  });
});

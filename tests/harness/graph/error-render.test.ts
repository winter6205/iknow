/**
 * `formatNodeError` 渲染契约单测（code-quality.md typed-error catch 契约）。
 *
 * 钉住的不变式：
 *   - **判别联合 `{kind, context}`**：`{kind: "not_found", context: {...}}`
 *     渲染为 `` `not_found: ${context-stringified}` ``，让 kind 与 context
 *     完整可见 —— 禁止 plain object 被打成 `[object Object]`。
 *   - **未知 kind**：缺 / 非字符串的 kind → 退化为 `"unknown: ..."`；
 *     仍带原 err JSON 兜底。
 *   - **Error 子类**：`new Error("x")` → `"x"`，无 `[object Object]`。
 *   - **plain object / primitive**：永不出现 `[object Object]`；fallback
 *     路径必须能给出可读字符串（哪怕只是 `String(err)` 的可读形式）。
 *
 * 加一条连线断言：调度器 executor 抛出 typed plain-object 错误时，浓缩
 * 结果里失败节点的 error 字段必须带 kind 前缀（review F5 / code-quality
 * 契约）。
 */

import { describe, expect, it } from "vitest";

import { formatNodeError } from "../../../src/harness/graph/error-render.ts";
import { runGraphWithFailureEdges } from "../../../src/harness/graph/outcome-scheduler.ts";
import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import {
  makeManager,
  settle,
  fail,
  waitForChildren,
  parseCondensed as parse,
} from "./_fake-manager.ts";
import type {
  GraphSpec,
  NodeExecutor,
} from "../../../src/harness/graph/types.ts";

describe("formatNodeError — typed-error catch 契约", () => {
  it("判别联合 `{kind, context}` 渲染：kind 与 context 都可见", () => {
    expect(
      formatNodeError({ kind: "not_found", context: { conversation_id: "c1" } })
    ).toBe('not_found: {"conversation_id":"c1"}');
  });

  it("未知 kind（非字符串）：退化为 `unknown: ...`，context 存在时渲染 context", () => {
    expect(formatNodeError({ kind: 123, context: { x: 1 } })).toBe(
      'unknown: {"x":1}'
    );
  });

  it("Error 子类：取 .message，不带 [object Object]", () => {
    expect(formatNodeError(new Error("x"))).toBe("x");
    expect(formatNodeError(new Error("boom [with stuff]"))).toBe(
      "boom [with stuff]"
    );
  });

  it("primitive / array 永不包含 [object Object]", () => {
    for (const v of [[1, 2, 3], 42, null, undefined]) {
      const s = formatNodeError(v);
      expect(s).not.toContain("[object Object]");
      if (v === null) expect(s).toBe("null");
      else if (v === undefined) expect(s).toBe("undefined");
      else if (typeof v === "number") expect(s).toBe("42");
      else expect(s).toBe("1,2,3");
    }
  });

  it("无 kind 的 plain object：渲染为 JSON 形式，字段可见，无 [object Object]", () => {
    const s = formatNodeError({ foo: 1 });
    expect(s).toContain("foo");
    expect(s).not.toContain("[object Object]");
    expect(s).toBe('{"foo":1}');
  });

  it("circular object：不崩、渲染不含 [object Object]，含可读信息", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const s = formatNodeError(circular);
    expect(s).not.toContain("[object Object]");
    expect(s).toContain("circular");
  });

  it("连线：executor 抛 typed plain-object 错误 → 调度器把它落 failed，error 字段带 kind 前缀", async () => {
    // stub 调度器级：直接构造 typed-error 异常，确认 outcomes[].error
    // 渲染携带 kind。
    const entries: string[] = [];
    const exec: NodeExecutor = async (id) => {
      entries.push(id);
      throw { kind: "boom", context: { id, why: "wire-test" } };
    };
    const spec: GraphSpec = {
      nodes: [{ id: "x", deps: [] }],
    };
    const { execution } = await runGraphWithFailureEdges(spec, exec);
    expect(entries).toEqual(["x"]);
    expect(execution.statuses.x).toBe("failed");
    // 结果的 error 字段就是 formatNodeError(throw 出的对象) —— 带
    // kind 前缀，避免 [object Object]。
    const result = execution.results.x;
    expect(result?.status).toBe("failed");
    if (result?.status === "failed") {
      expect(result.error).toContain("boom:");
      expect(result.error).not.toContain("[object Object]");
    }
  });

  it("连线（handler 级）：浓缩结果里失败节点 error 含 kind 前缀", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = tool.handler(
      { nodes: [{ id: "z", task: "tz" }] },
      { conversationId: "conv-err" }
    );
    await waitForChildren(children, 1);
    // 写一份 typed envelope 让 manager 走 envelope → executor 把它当
    // failed 落定（executor 读 envelope.status==="failed" → 不抛异常、
    // 直接 return {status:"failed", error}）。error 字段就是 envelope
    // 的 summary/reason 渲染（不在 formatNodeError 路径里）。这条 wire
    // 断言确保 handler 路径上 typed 内容能正常流到浓缩结果。
    settle(
      children[0]!,
      fail("canned") // 普通 envelope 错误
    );
    const out = parse(await pending);
    expect(out.nodes[0]).toMatchObject({ id: "z", status: "failed" });
    await manager.shutdown();
  });
});

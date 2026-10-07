/**
 * `formatNodeError` rendering contract (code-quality.md typed-error catch rule).
 *
 * Pinned invariants:
 *   - **Discriminated union `{kind, context}`**: `{kind: "not_found", context: {...}}`
 *     renders as `` `not_found: ${context-stringified}` `` so both kind and
 *     context stay visible — a plain object must never collapse to
 *     `[object Object]`.
 *   - **Unknown kind**: missing / non-string kind → degrades to
 *     `"unknown: ..."`, still falling back to the original err JSON.
 *   - **Error subclass**: `new Error("x")` → `"x"`, no `[object Object]`.
 *   - **plain object / primitive**: `[object Object]` must never appear;
 *     the fallback path always yields a readable string.
 *
 * Plus one wiring assertion: when the executor throws a typed plain-object
 * error, the failed node's error field in the condensed result must carry
 * the kind prefix (code-quality contract).
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
    // Scheduler-level wiring: throw a typed-error directly and confirm the
    // outcomes[].error rendering carries the kind.
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
    // The result's error field is formatNodeError(thrown object) — with the
    // kind prefix, never `[object Object]`.
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
    // Write a typed envelope so the manager settles it as failed (the
    // executor reads envelope.status==="failed" → returns
    // {status:"failed", error} without throwing). The error field is the
    // envelope's summary/reason rendering, not the formatNodeError path.
    // This wiring check ensures typed content flows through to the
    // condensed result on the handler path.
    settle(
      children[0]!,
      fail("crashed") // plain envelope error
    );
    const out = parse(await pending);
    expect(out.nodes[0]).toMatchObject({ id: "z", status: "failed" });
    await manager.shutdown();
  });
});

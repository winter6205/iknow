/**
 * T2: ToolExecutionResult wire shape — typed envelope.
 *
 * 298 决策:ToolExecutionResult `ok` 变体新增可选 `meta` 侧信道,
 * 供 diff-preview 类工具在不改 payload(模型可见)的前提下携带
 * oldContent/newContent 给宿主消费。type-only;runtime executor 不动。
 *
 * 断言:
 *   1. `ok` + meta 可运行时读取;
 *   2. `ok` 无 meta 时 `result.meta === undefined`;
 *   3. kind 判别式收窄仍生效(payload 可读)。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ToolExecutionResult } from "../../../src/harness/tools/types.ts";

describe("ToolExecutionResult meta? envelope (T2)", () => {
  it("ok result carries optional meta oldContent/newContent", () => {
    const ok: ToolExecutionResult = {
      kind: "ok",
      toolUseId: "toolu_1",
      payload: [{ type: "text", text: "diff preview" }],
      meta: { oldContent: "x", newContent: "y" },
    };
    // 运行时读取:meta 是真实字段,不是类型幻觉
    assert.equal(ok.kind, "ok");
    assert.equal(ok.meta?.oldContent, "x");
    assert.equal(ok.meta?.newContent, "y");
  });

  it("ok result without meta yields undefined", () => {
    const ok: ToolExecutionResult = {
      kind: "ok",
      toolUseId: "toolu_2",
      payload: [{ type: "text", text: "no meta" }],
    };
    assert.equal(ok.meta, undefined);
  });

  it("kind discriminator narrowing still works", () => {
    const r: ToolExecutionResult = {
      kind: "ok",
      toolUseId: "toolu_3",
      payload: [{ type: "text", text: "narrowed" }],
    };
    if (r.kind === "ok") {
      // 判别式收窄后 payload 可读,且 meta 可安全可选访问
      assert.equal(r.payload[0].type, "text");
      assert.equal(r.meta, undefined);
    } else {
      assert.fail("expected kind === ok to narrow");
    }
  });

  it("meta is optional on the ok variant — missing property still typechecks", () => {
    // 编译期约束:缺 meta 的 ok 对象必须可赋值给 ToolExecutionResult
    const fromExecutor: ToolExecutionResult = {
      kind: "ok",
      toolUseId: "toolu_4",
      payload: [{ type: "text", text: "executor-shaped" }],
    } as ToolExecutionResult;
    assert.equal(fromExecutor.meta, undefined);
  });
});

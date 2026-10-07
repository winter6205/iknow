/**
 * ToolExecutionResult wire shape — typed envelope.
 *
 * Decision (ADR-0004 side-channel): the `ok` variant gains an optional `meta`
 * so diff-preview tools carry oldContent/newContent to the host without
 * changing the (model-visible) payload. Type-only; the runtime executor is
 * untouched.
 *
 * Assertions:
 *   1. `ok` + meta is readable at runtime;
 *   2. `ok` without meta yields `result.meta === undefined`;
 *   3. kind-discriminant narrowing still works (payload readable).
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
    // Runtime read: meta is a real field, not a type illusion
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
      // After discriminant narrowing payload is readable, and meta is safe optional access
      assert.equal(r.payload[0].type, "text");
      assert.equal(r.meta, undefined);
    } else {
      assert.fail("expected kind === ok to narrow");
    }
  });

  it("meta is optional on the ok variant — missing property still typechecks", () => {
    // Compile-time constraint: an ok object without meta must still be assignable to ToolExecutionResult
    const fromExecutor: ToolExecutionResult = {
      kind: "ok",
      toolUseId: "toolu_4",
      payload: [{ type: "text", text: "executor-shaped" }],
    };
    assert.equal(fromExecutor.kind === "ok" ? fromExecutor.meta : 1, undefined);
  });
});

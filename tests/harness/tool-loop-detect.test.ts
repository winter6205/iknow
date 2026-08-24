/**
 * #672 T3: 工具环检测纯函数 — empty / negative / overflow / concurrent 窗口 / fail-open。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  isStalledToolLoop,
  toolLoopEventFromCall,
  type ToolLoopEvent,
} from "../../src/harness/tool-loop-detect.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";

const fail = (msg: string): ToolExecutionResult => ({
  kind: "execution_failed",
  toolUseId: "x",
  message: msg,
});

const okText = (text: string): ToolExecutionResult => ({
  kind: "ok",
  toolUseId: "x",
  payload: [{ type: "text", text }],
});

function ev(
  name: string,
  input: unknown,
  result: ToolExecutionResult,
  phaseId: number
): ToolLoopEvent {
  return toolLoopEventFromCall(name, input, result, phaseId);
}

describe("isStalledToolLoop", () => {
  it("empty: no events → not stalled", () => {
    assert.equal(isStalledToolLoop([]), false);
  });

  it("negative: 4 identical execution_failed is below R=5", () => {
    const events = [0, 1, 2, 3].map((p) =>
      ev("bash", { command: "x" }, fail("boom"), p)
    );
    assert.equal(isStalledToolLoop(events), false);
  });

  it("R=5 identical execution_failed across 5 phases → stalled", () => {
    const events = [0, 1, 2, 3, 4].map((p) =>
      ev("bash", { command: "x" }, fail("boom"), p)
    );
    assert.equal(isStalledToolLoop(events), true);
  });

  it("overflow: 100 identical still stalled (closed trip)", () => {
    const events = Array.from({ length: 100 }, (_, p) =>
      ev("bash", { command: "x" }, fail("boom"), p)
    );
    assert.equal(isStalledToolLoop(events), true);
  });

  it("k=2 fail/read/fail… R=5 with stagnant result keys → stalled", () => {
    const events: ToolLoopEvent[] = [];
    for (let r = 0; r < 5; r += 1) {
      events.push(ev("edit", { path: "a.ts" }, fail("nope"), r));
      events.push(ev("read", { path: "a.ts" }, okText("same"), r));
    }
    assert.equal(isStalledToolLoop(events), true);
  });

  it("negative: same bash command but changing exit code is progress", () => {
    const events = [1, 1, 1, 1, 2].map((code, p) =>
      ev(
        "bash",
        { command: "test" },
        okText(JSON.stringify({ code, stdout: "" })),
        p
      )
    );
    assert.equal(isStalledToolLoop(events), false);
  });

  it("bash ok + nonzero is in (counts toward fuse)", () => {
    const events = [0, 1, 2, 3, 4].map((p) =>
      ev(
        "bash",
        { command: "false" },
        okText(JSON.stringify({ code: 1, stdout: "", stderr: "x" })),
        p
      )
    );
    assert.equal(isStalledToolLoop(events), true);
  });

  it("exception: unnormalizable MCP in the window → fail-open", () => {
    const bad = (phaseId: number): ToolLoopEvent => ({
      callKey: "mcp",
      resultKey: "x",
      normalizable: false,
      phaseId,
    });
    assert.equal(isStalledToolLoop([0, 1, 2, 3, 4].map(bad)), false);
  });

  it("concurrent: one wave of 8 identical calls shares phaseId → not stalled", () => {
    const wave = Array.from({ length: 8 }, () =>
      ev("echo", { n: 1 }, fail("e"), 0)
    );
    assert.equal(isStalledToolLoop(wave), false);
  });
});

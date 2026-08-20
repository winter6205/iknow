/**
 * tests/tui/live-tool-state.test.ts
 *
 * #578：unmatched post_tool_use 不得 append 幽灵 live 行（与 history
 * `[失败]` 双重渲染）。OpenTUI 合同：未匹配 id 与 unmatched
 * tool_input_delta 一样 return prev。archive/tui-ink 的 append + length 2
 * 合同已倒置。匹配 id 仍 in-place ok/failed。
 */
import { describe, expect, test } from "bun:test";
import {
  liveToolReduce,
  type LiveToolRun,
} from "../../src/tui/live-tool-state.js";

describe("liveToolReduce (#578 unmatched post_tool_use 不 append)", () => {
  test("empty prev + unmatched post_tool_use → return prev（不 append 幽灵行）", () => {
    const prev: ReadonlyArray<LiveToolRun> = [];
    const next = liveToolReduce(prev, {
      kind: "post_tool_use",
      id: "toolu_ghost",
      name: "write_file",
      input: {},
      ok: false,
      message: "validation_failed",
    });
    expect(next).toBe(prev);
    expect(next).toHaveLength(0);
  });

  test("id 不匹配的 post_tool_use → return prev（不 append，length 保持 1）", () => {
    const started: ReadonlyArray<LiveToolRun> = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_unknown",
      name: "noop",
    });
    const next = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "toolu_other",
      name: "noop",
      input: {},
      ok: true,
    });
    expect(next).toBe(started);
    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("running");
  });

  test("匹配 id 的 post_tool_use ok → in-place 转 ok", () => {
    const started: ReadonlyArray<LiveToolRun> = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "echo",
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "toolu_1",
      name: "echo",
      input: { value: "x" },
      ok: true,
      detail: "执行摘要",
    });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      id: "toolu_1",
      name: "echo",
      status: "ok",
      detail: "执行摘要",
    });
  });

  test("匹配 id 的 post_tool_use failed → in-place 转 failed", () => {
    const started: ReadonlyArray<LiveToolRun> = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_x",
      name: "bash",
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "toolu_x",
      name: "bash",
      input: { command: "ls" },
      ok: false,
      message: "exit 1",
      detail: "ls",
    });
    expect(done).toHaveLength(1);
    expect(done[0]?.status).toBe("failed");
    expect(done[0]?.message).toBe("exit 1");
  });
});

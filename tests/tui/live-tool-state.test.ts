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

describe("liveToolReduce (#589 成功只读离开 live 尾巴)", () => {
  test("start + ok read_file → live 数组为空", () => {
    const started = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-rf-ok",
      name: "read_file",
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "tu-rf-ok",
      name: "read_file",
      input: { path: "a.ts" },
      ok: true,
      detail: "读取 a.ts",
    });
    expect(done).toHaveLength(0);
  });

  test("start + ok grep → live 数组为空", () => {
    const started = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-grep-ok",
      name: "grep",
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "tu-grep-ok",
      name: "grep",
      input: { pattern: "foo" },
      ok: true,
      detail: "grep foo",
    });
    expect(done).toHaveLength(0);
  });

  test("start + ok glob → live 数组为空", () => {
    const started = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-glob-ok",
      name: "glob",
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "tu-glob-ok",
      name: "glob",
      input: { pattern: "*.ts" },
      ok: true,
      detail: "glob *.ts",
    });
    expect(done).toHaveLength(0);
  });

  test("failed read_file 留下；随后成功 read_file 离开", () => {
    const failStarted = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-rf-fail",
      name: "read_file",
    });
    const afterFail = liveToolReduce(failStarted, {
      kind: "post_tool_use",
      id: "tu-rf-fail",
      name: "read_file",
      input: { path: "missing.ts" },
      ok: false,
      message: "ENOENT",
      detail: "读取 missing.ts",
    });
    const okStarted = liveToolReduce(afterFail, {
      kind: "tool_call_start",
      id: "tu-rf-ok2",
      name: "read_file",
    });
    const afterOk = liveToolReduce(okStarted, {
      kind: "post_tool_use",
      id: "tu-rf-ok2",
      name: "read_file",
      input: { path: "b.ts" },
      ok: true,
      detail: "读取 b.ts",
    });
    expect(afterOk).toHaveLength(1);
    expect(afterOk[0]).toMatchObject({
      id: "tu-rf-fail",
      name: "read_file",
      status: "failed",
      message: "ENOENT",
    });
  });

  test("write_file ok 留下；随后成功 read_file 离开", () => {
    const writeStarted = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-wf-ok",
      name: "write_file",
    });
    const afterWrite = liveToolReduce(writeStarted, {
      kind: "post_tool_use",
      id: "tu-wf-ok",
      name: "write_file",
      input: { path: "a.ts", content: "x" },
      ok: true,
      detail: "写入 a.ts（1 行）",
    });
    const readStarted = liveToolReduce(afterWrite, {
      kind: "tool_call_start",
      id: "tu-rf-after-wf",
      name: "read_file",
    });
    const afterRead = liveToolReduce(readStarted, {
      kind: "post_tool_use",
      id: "tu-rf-after-wf",
      name: "read_file",
      input: { path: "a.ts" },
      ok: true,
      detail: "读取 a.ts",
    });
    expect(afterRead).toHaveLength(1);
    expect(afterRead[0]).toMatchObject({
      id: "tu-wf-ok",
      name: "write_file",
      status: "ok",
    });
  });

  test("完成只读不删除夹在中间的 running sibling", () => {
    const readStarted = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-rf-sib",
      name: "read_file",
    });
    const withSibling = liveToolReduce(readStarted, {
      kind: "tool_call_start",
      id: "tu-grep-run",
      name: "grep",
    });
    const afterReadOk = liveToolReduce(withSibling, {
      kind: "post_tool_use",
      id: "tu-rf-sib",
      name: "read_file",
      input: { path: "a.ts" },
      ok: true,
      detail: "读取 a.ts",
    });
    expect(afterReadOk).toHaveLength(1);
    expect(afterReadOk[0]).toMatchObject({
      id: "tu-grep-run",
      name: "grep",
      status: "running",
    });
  });
});

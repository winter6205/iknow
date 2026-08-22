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
  liveTailSlots,
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

describe("liveToolReduce draftEpoch（工具插在第 N 段草稿之后）", () => {
  test("tool_call_start 携带 draftEpoch: 1 → 条目记录该值", () => {
    const runs = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_late",
      name: "write_file",
      draftEpoch: 1,
    });
    expect(runs[0]?.draftEpoch).toBe(1);
  });

  test("tool_call_start 缺省 draftEpoch → 条目无标记（epoch 0，先于第一段草稿）", () => {
    const runs = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_early",
      name: "web_search",
    });
    expect(runs[0]?.draftEpoch).toBeUndefined();
  });

  test("post_tool_use 完成重建条目时保留 draftEpoch", () => {
    const started = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_late_keep",
      name: "write_file",
      draftEpoch: 2,
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "toolu_late_keep",
      name: "write_file",
      input: { path: "a.txt" },
      ok: true,
      detail: "写入 a.txt",
    });
    expect(done[0]?.status).toBe("ok");
    expect(done[0]?.draftEpoch).toBe(2);
  });
});

describe("liveTailSlots 按 epoch 交错工具与草稿段", () => {
  const run = (id: string, name: string, draftEpoch?: number): LiveToolRun => ({
    id,
    name,
    status: "running",
    input: undefined,
    ...(draftEpoch === undefined ? {} : { draftEpoch }),
  });

  test("empty：无工具无草稿 → 空槽", () => {
    expect(liveTailSlots([], [])).toEqual([]);
  });

  test("缺省 epoch 0 的工具在第一段草稿之上", () => {
    const slots = liveTailSlots([run("a", "web_search")], ["hello"]);
    expect(slots).toEqual([
      { kind: "tools", runs: [run("a", "web_search")] },
      { kind: "draft", text: "hello" },
    ]);
  });

  test("tool→text→tool→text：早工具 / 段0 / 晚工具 / 段1", () => {
    const early = run("a", "web_search");
    const late = run("b", "bash", 1);
    const slots = liveTailSlots([early, late], ["first", "second"]);
    expect(slots.map((s) => s.kind)).toEqual([
      "tools",
      "draft",
      "tools",
      "draft",
    ]);
    expect(slots[0]).toEqual({ kind: "tools", runs: [early] });
    expect(slots[1]).toEqual({ kind: "draft", text: "first" });
    expect(slots[2]).toEqual({ kind: "tools", runs: [late] });
    expect(slots[3]).toEqual({ kind: "draft", text: "second" });
  });

  test("negative：epoch 大于 segments.length → 工具挂在末尾，不丢弃", () => {
    const extra = run("z", "write_file", 3);
    const slots = liveTailSlots([extra], ["only"]);
    expect(slots).toEqual([
      { kind: "draft", text: "only" },
      { kind: "tools", runs: [extra] },
    ]);
  });

  test("exception：空草稿段跳过、缺字段不抛", () => {
    const early = run("a", "grep");
    expect(() => liveTailSlots([early], ["", "kept"])).not.toThrow();
    const slots = liveTailSlots([early], ["", "kept"]);
    expect(slots).toEqual([
      { kind: "tools", runs: [early] },
      { kind: "draft", text: "kept" },
    ]);
  });
});

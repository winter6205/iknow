/**
 * tests/tui/live-tool-state.test.ts
 *
 * T4 (#175): 工具实时状态 reducer 单测 — tool_call_start → running →
 * post_tool_use → ok/failed 两态时序 + 配对 / idempotent / format helpers。
 */
import { describe, expect, it } from "vitest";
import {
  activeToolNameOf,
  formatCompletedToolLine,
  formatRunningToolLine,
  liveToolReduce,
  type LiveToolRun,
} from "../../src/tui/live-tool-state.js";
import { formatLiveToolEvent } from "../../src/tui/tool-summary.js";

describe("liveToolReduce (T4 工具实时状态)", () => {
  it("tool_call_start 追加 running 条目", () => {
    const next = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "echo",
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "toolu_1",
      name: "echo",
      status: "running",
    });
  });

  it("同 id 重复 tool_call_start 视为 idempotent,不变更原数组", () => {
    const first = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "echo",
    });
    const second = liveToolReduce(first, {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "echo",
    });
    expect(second).toBe(first);
  });

  it("post_tool_use 命中 running → 转 ok 摘要,顺序与输入对齐", () => {
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
    expect(done[0]).toMatchObject({
      id: "toolu_1",
      name: "echo",
      status: "ok",
      detail: "执行摘要",
    });
  });

  it("post_tool_use 配对失败 → status=failed", () => {
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
    expect(done[0]?.status).toBe("failed");
    expect(done[0]?.message).toBe("exit 1");
  });

  it("post_tool_use 缺匹配 id → append 新条目(回放场景向后兼容)", () => {
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
    expect(next).toHaveLength(2);
    expect(next[1]?.status).toBe("ok");
  });

  it("冻结纪律:返回新冻结 array", () => {
    const a = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "echo",
    });
    const b = liveToolReduce(a, {
      kind: "post_tool_use",
      id: "toolu_1",
      name: "echo",
      input: {},
      ok: true,
    });
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b[0]!)).toBe(true);
  });
});

describe("activeToolNameOf (#279 项 4 活动工具名派生)", () => {
  it("空 runs → undefined（无工具运行）", () => {
    expect(activeToolNameOf([])).toBeUndefined();
  });

  it("tool start → 返回该工具名（显示）", () => {
    const runs = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "Bash",
    });
    expect(activeToolNameOf(runs)).toBe("Bash");
  });

  it("tool end（post_tool_use ok）→ undefined（隐藏）", () => {
    let runs = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "Bash",
    });
    runs = liveToolReduce(runs, {
      kind: "post_tool_use",
      id: "toolu_1",
      name: "Bash",
      input: { command: "ls" },
      ok: true,
      detail: "ls",
    });
    expect(activeToolNameOf(runs)).toBeUndefined();
  });

  it("tool end（failed）→ undefined（隐藏）", () => {
    let runs = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "Bash",
    });
    runs = liveToolReduce(runs, {
      kind: "post_tool_use",
      id: "toolu_1",
      name: "Bash",
      input: {},
      ok: false,
      message: "exit 1",
    });
    expect(activeToolNameOf(runs)).toBeUndefined();
  });

  it("前一个已完成 + 当前 running → 返回当前（末尾 running 优先）", () => {
    let runs = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "Read",
    });
    runs = liveToolReduce(runs, {
      kind: "post_tool_use",
      id: "toolu_1",
      name: "Read",
      input: {},
      ok: true,
    });
    runs = liveToolReduce(runs, {
      kind: "tool_call_start",
      id: "toolu_2",
      name: "Bash",
    });
    expect(activeToolNameOf(runs)).toBe("Bash");
  });
});

describe("formatRunningToolLine / formatCompletedToolLine", () => {
  it("running 渲染 [运行中] name", () => {
    const line = formatRunningToolLine({
      id: "toolu_1",
      name: "echo",
      status: "running",
      input: undefined,
    });
    expect(line).toBe("[运行中] echo");
  });

  it("ok 详情渲染 name · detail · ok", () => {
    const line = formatCompletedToolLine({
      id: "toolu_1",
      name: "bash",
      status: "ok",
      input: { command: "ls" },
      detail: "ls",
    });
    expect(line).toBe("bash · ls · ok");
  });

  it("failed 无详情降级 name · failed", () => {
    const line = formatCompletedToolLine({
      id: "toolu_1",
      name: "bash",
      status: "failed",
      input: {},
    });
    expect(line).toBe("bash · failed");
  });

  it("formatCompletedToolLine 字节等于 formatLiveToolEvent (detail 显式 override)", () => {
    // 锁定单源: completed 行 = liveToolEvent 行(以同一 precomputed detail 喂入).
    // 两条路径渲染必须字节一致, 否则 live-tool-state.ts 跑了模板字符串.
    const run: LiveToolRun = {
      id: "toolu_be_1",
      name: "read_file",
      status: "ok",
      input: { path: "a.ts" },
      detail: "读取 a.ts",
    };
    const fromCompleted = formatCompletedToolLine(run);
    const fromLive = formatLiveToolEvent({
      toolName: run.name,
      input: run.input,
      kind: "ok",
      detail: run.detail,
    });
    expect(fromCompleted).toBe(fromLive);
    expect(fromCompleted).toBe("read_file · 读取 a.ts · ok");
  });

  it("formatCompletedToolLine 在 empty detail 下也走单源", () => {
    const run: LiveToolRun = {
      id: "toolu_be_2",
      name: "bash",
      status: "failed",
      input: {},
    };
    const fromCompleted = formatCompletedToolLine(run);
    const fromLive = formatLiveToolEvent({
      toolName: run.name,
      input: run.input,
      kind: "failed",
      detail: "",
    });
    expect(fromCompleted).toBe(fromLive);
    expect(fromCompleted).toBe("bash · failed");
  });
});

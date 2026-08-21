/** @jsxImportSource @opentui/react */
/**
 * tests/tui/live-tool-preview.test.tsx
 *
 * #343 T4：live-tool-preview（OpenTUI 版）——工具运行行：
 *  - 运行态：仅 `[运行中] name` 状态行（1 行账）；
 *  - 完成态：摘要行 + 统一 diff 预览（hunk 头 + 行号）；
 *  - 运行态 → 完成态切换：reducer 事件驱动，帧从 `[运行中]` 变为摘要 + diff；
 *  - 行账 parity：渲染行数 === liveToolPreviewRows。
 *
 * T5 (tui-render-optimization)：tool_input_delta 增量消费 —
 *  - reducer 累积 partialJson 到 running 条目 partialInput；
 *  - running 渲染 `[运行中] bash · <partial 摘要>`（parse 成功走
 *    summarizeToolCall，不完整 JSON 原样截断显示）；
 *  - post_tool_use 完成用完整 input 覆盖并清除 partialInput。
 */
import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { visualWidth } from "../../src/tui/tool-summary.js";
import {
  liveToolPreviewBox,
  liveToolPreviewRows,
  liveToolPreviewTextLines,
} from "../../src/tui/live-tool-preview.js";
import {
  formatRunningToolLine,
  liveToolReduce,
  type LiveToolRun,
} from "../../src/tui/live-tool-state.js";

/** 轮询式帧等待（同 list-view-scroll 注释）。 */
async function untilFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  pred: (frame: string) => boolean,
  ms = 3000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 15));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

const editRun: LiveToolRun = {
  id: "tu-1",
  name: "edit_file",
  status: "ok",
  input: { path: "a.ts", old_str: "old", new_str: "new" },
  detail: "编辑 a.ts：old → new",
  oldContent: "line1\nline2\nold\nline4\nline5\n",
  newContent: "line1\nline2\nnew\nline4\nline5\n",
};

async function renderBox(run: LiveToolRun, cols: number) {
  const setup = await testRender(<>{liveToolPreviewBox(run, cols)}</>, {
    width: cols,
    height: 30,
  });
  await setup.renderOnce();
  return setup;
}

describe("liveToolPreviewBox（live 工具 tail 渲染）", () => {
  test("cols=80 完成态：摘要行 + hunk 头 + 双列行号", async () => {
    const setup = await renderBox(editRun, 80);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("edit_file · 编辑 a.ts：old → new · ok");
    expect(frame).toContain("@@ -1,5 +1,5 @@");
    expect(frame).toMatch(/3\s+│\s+-old/);
    expect(frame).toMatch(/3\s+│\s+\+new/);
    await setup.renderer.destroy();
  });

  test("cols=60：单列行号", async () => {
    const setup = await renderBox(editRun, 60);
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/3\s+│\s+-old/);
    expect(frame).toContain("@@ -1,5 +1,5 @@");
    await setup.renderer.destroy();
  });

  test("cols=32：折叠为仅 add，无 del / hunk 头", async () => {
    const setup = await renderBox(editRun, 32);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("+new");
    expect(frame).not.toContain("-old");
    expect(frame).not.toContain("@@");
    await setup.renderer.destroy();
  });

  test("渲染行数与行账一致（parity）", async () => {
    const setup = await renderBox(editRun, 80);
    const frame = setup.captureCharFrame();
    const rendered = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(rendered.length).toBe(liveToolPreviewRows(editRun, 80));
    await setup.renderer.destroy();
  });

  test("running 状态：仅状态行，无预览（1 行账）", async () => {
    const running: LiveToolRun = {
      id: "tu-2",
      name: "bash",
      status: "running",
      input: {},
    };
    const setup = await renderBox(running, 80);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[运行中] bash");
    expect(frame).not.toContain("@@");
    expect(liveToolPreviewRows(running, 80)).toBe(1);
    await setup.renderer.destroy();
  });
});

describe("liveToolPreviewTextLines（flat 行）", () => {
  test("已完成 write_file 新文件：状态行 + 截断代码（非整文件绿 diff）", () => {
    const run: LiveToolRun = {
      id: "r",
      name: "write_file",
      status: "ok",
      input: { path: "a.ts", content: "x" },
      detail: "写入 a.ts（1 行）",
      oldContent: "",
      newContent: "hello\n",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows[0]).toBe("write_file · 写入 a.ts（1 行） · ok");
    expect(rows).toContain("hello");
    expect(rows.some((r) => r.includes("+hello"))).toBe(false);
    expect(rows.length).toBe(liveToolPreviewRows(run, 80));
  });

  test("已完成 write_file 超长：窗内代码 + 还有 N 行，无全文", () => {
    const content = Array.from({ length: 20 }, (_, i) => `body-${i}`).join(
      "\n"
    );
    const run: LiveToolRun = {
      id: "r",
      name: "write_file",
      status: "ok",
      input: { path: "a.ts", content },
      detail: "写入 a.ts（20 行）",
      oldContent: "",
      newContent: content,
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows).toContain("body-0");
    expect(rows.some((r) => r.includes("body-19"))).toBe(false);
    expect(rows.some((r) => r.includes("还有") && r.includes("行"))).toBe(true);
  });

  test("已完成 overwrite/edit：截断 diff 可见", () => {
    const run: LiveToolRun = {
      id: "r",
      name: "edit_file",
      status: "ok",
      input: { path: "a.ts", old_str: "old", new_str: "new" },
      detail: "编辑 a.ts：old → new",
      oldContent: "line1\nline2\nold\nline4\nline5\n",
      newContent: "line1\nline2\nnew\nline4\nline5\n",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows.some((r) => r.includes("-old"))).toBe(true);
    expect(rows.some((r) => r.includes("+new"))).toBe(true);
  });
});

describe("运行态 → 完成态切换（reducer 驱动）", () => {
  function SwitchHarness() {
    const [runs, setRuns] = useState<ReadonlyArray<LiveToolRun>>(() =>
      liveToolReduce([], {
        kind: "tool_call_start",
        id: "tu-9",
        name: "write_file",
      })
    );
    useKeyboard((e) => {
      if (e.name === "return") {
        setRuns((prev) =>
          liveToolReduce(prev, {
            kind: "post_tool_use",
            id: "tu-9",
            name: "write_file",
            input: { path: "a.ts", content: "hello" },
            ok: true,
            detail: "写入 a.ts（1 行）",
            oldContent: "",
            newContent: "hello\n",
          })
        );
      }
    });
    const run = runs[0];
    if (run === undefined) return null;
    return <>{liveToolPreviewBox(run, 80)}</>;
  }

  test("初始运行行；Enter（完成事件）后切换为摘要 + diff", async () => {
    const setup = await testRender(<SwitchHarness />, {
      width: 80,
      height: 20,
      exitOnCtrlC: false,
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("[运行中] write_file");
    setup.mockInput.pressEnter();
    const frame = await untilFrame(setup, (f) =>
      f.includes("write_file · 写入 a.ts（1 行） · ok")
    );
    expect(frame).not.toContain("[运行中]");
    expect(frame).toContain("hello");
    expect(frame).not.toContain("+hello");
    await setup.renderer.destroy();
  });
});

describe("T5: tool_input_delta 增量累积（reducer）", () => {
  test("partial 拼接累积到 running 条目 partialInput（顺序保留）", () => {
    const started = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-1",
      name: "bash",
    });
    const after1 = liveToolReduce(started, {
      kind: "tool_input_delta",
      id: "tu-1",
      partialJson: '{"com',
    });
    const after2 = liveToolReduce(after1, {
      kind: "tool_input_delta",
      id: "tu-1",
      partialJson: 'mand":"ls"}',
    });
    expect(after2).toHaveLength(1);
    expect(after2[0]?.status).toBe("running");
    expect(after2[0]?.partialInput).toBe('{"command":"ls"}');
  });

  test("未匹配 id / 非 running 条目 → 忽略（defensive）", () => {
    const started = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-1",
      name: "bash",
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "tu-1",
      name: "bash",
      input: { command: "ls" },
      ok: true,
    });
    // 完成态条目收到增量 → 忽略（非 running）。
    const afterDone = liveToolReduce(done, {
      kind: "tool_input_delta",
      id: "tu-1",
      partialJson: '{"command":"ls"}',
    });
    expect(afterDone[0]?.partialInput).toBeUndefined();
    // 完全未匹配的 id → 原样返回。
    const ghost = liveToolReduce(started, {
      kind: "tool_input_delta",
      id: "no-such-id",
      partialJson: "{}",
    });
    expect(ghost).toBe(started);
  });

  test("post_tool_use 完成 → 完整 input 覆盖并清除 partialInput", () => {
    const started = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-1",
      name: "bash",
    });
    const withPartial = liveToolReduce(started, {
      kind: "tool_input_delta",
      id: "tu-1",
      partialJson: '{"command":"l',
    });
    const done = liveToolReduce(withPartial, {
      kind: "post_tool_use",
      id: "tu-1",
      name: "bash",
      input: { command: "ls" },
      ok: true,
    });
    expect(done[0]?.status).toBe("ok");
    expect(done[0]?.input).toEqual({ command: "ls" });
    expect(done[0]?.partialInput).toBeUndefined();
  });

  test("多个运行中条目按 id 各自累积，顺序不漂移", () => {
    const s1 = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-1",
      name: "bash",
    });
    const s2 = liveToolReduce(s1, {
      kind: "tool_call_start",
      id: "tu-2",
      name: "read_file",
    });
    // 后发的事件可属于较早的条目（按 id 配对而非 FIFO 位置）。
    const m1 = liveToolReduce(s2, {
      kind: "tool_input_delta",
      id: "tu-1",
      partialJson: '{"command":"',
    });
    const m2 = liveToolReduce(m1, {
      kind: "tool_input_delta",
      id: "tu-2",
      partialJson: '{"path":"a',
    });
    expect(m2.map((r) => r.id)).toEqual(["tu-1", "tu-2"]);
    expect(m2[0]?.partialInput).toBe('{"command":"');
    expect(m2[1]?.partialInput).toBe('{"path":"a');
  });
});

describe("T5: running 态 partial 摘要渲染", () => {
  test("partial parse 成功 → `[运行中] bash · <摘要>`（含 ls）", () => {
    const run: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "running",
      input: undefined,
      partialInput: '{"command":"ls"}',
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows[0]).toContain("[运行中] bash");
    expect(rows[0]).toContain("ls");
    expect(rows[0]).not.toContain("[运行中] bash · {"); // parse 成功走摘要
  });

  test('partial 不完整 JSON → 原样截断显示（含 `{"co`）', () => {
    const run: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "running",
      input: undefined,
      partialInput: '{"co',
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows[0]).toContain('{"co');
  });

  test("partialInput 空 / undefined → 保持 `[运行中] name` 基础行", () => {
    const empty: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "running",
      input: undefined,
      partialInput: "",
    };
    expect(liveToolPreviewTextLines(empty, 80)[0]).toBe("[运行中] bash");
    const none: LiveToolRun = {
      id: "tu-2",
      name: "bash",
      status: "running",
      input: undefined,
    };
    expect(liveToolPreviewTextLines(none, 80)[0]).toBe("[运行中] bash");
  });

  test("行账 parity：partial 渲染仍是 1 行", () => {
    const run: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "running",
      input: undefined,
      partialInput: '{"command":"npm test -- --long-flag"}',
    };
    expect(liveToolPreviewRows(run, 80)).toBe(1);
    expect(liveToolPreviewTextLines(run, 80).length).toBe(1);
  });

  test("窄终端：partial 摘要视觉宽度收口（单行不折）", () => {
    const run: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "running",
      input: undefined,
      partialInput: `{"command":"${"x".repeat(300)}"}`,
    };
    const line = liveToolPreviewTextLines(run, 30)[0] ?? "";
    // 视觉宽度收口契约：完整行（含 [运行中] 前缀 + 分隔符）≤ 终端列宽。
    expect(line.length).toBeGreaterThan(0);
    expect(visualWidth(line)).toBeLessThanOrEqual(30);
  });

  test("running write_file + 完整 partial：1 行且不出现 content 正文", () => {
    const run: LiveToolRun = {
      id: "tu-1",
      name: "write_file",
      status: "running",
      input: undefined,
      partialInput: '{"path":"a.ts","content":"SHOULD_NOT_STREAM"}',
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("[运行中] write_file");
    expect(rows.join("\n")).not.toContain("SHOULD_NOT_STREAM");
  });

  test("running write_file 不完整 JSON：1 行且不流式画出 content 片段", () => {
    const run: LiveToolRun = {
      id: "tu-1",
      name: "write_file",
      status: "running",
      input: undefined,
      partialInput: '{"path":"a.ts","content":"SHOULD_NOT',
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows).toHaveLength(1);
    expect(rows.join("\n")).not.toContain("SHOULD_NOT");
  });

  test("box 渲染：partial 出现在 liveToolPreviewBox 帧", async () => {
    const run: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "running",
      input: undefined,
      partialInput: '{"command":"git status"}',
    };
    const setup = await renderBox(run, 80);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[运行中] bash");
    expect(frame).toContain("git status");
    await setup.renderer.destroy();
  });
});

describe("formatRunningToolLine: 子代理工具专属运行行", () => {
  test("spawn_subagent run → `▣ 派发子代理中…`", () => {
    const run: LiveToolRun = {
      id: "tu-spawn",
      name: "spawn_subagent",
      status: "running",
      input: undefined,
    };
    expect(formatRunningToolLine(run)).toBe("▣ 派发子代理中…");
  });

  test("subagent_result run → `▣ 轮询子代理中…`", () => {
    const run: LiveToolRun = {
      id: "tu-poll",
      name: "subagent_result",
      status: "running",
      input: undefined,
    };
    expect(formatRunningToolLine(run)).toBe("▣ 轮询子代理中…");
  });

  test("bash run 回归 → `[运行中] bash`（普通工具形态不受影响）", () => {
    const run: LiveToolRun = {
      id: "tu-bash",
      name: "bash",
      status: "running",
      input: undefined,
    };
    expect(formatRunningToolLine(run)).toBe("[运行中] bash");
  });
});

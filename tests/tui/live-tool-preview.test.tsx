/** @jsxImportSource @opentui/react */
/**
 * tests/tui/live-tool-preview.test.tsx
 *
 * #343 T4：live-tool-preview（OpenTUI 版）——工具运行行：
 *  - 运行态：仅 `[运行中] name` 状态行（1 行账）；
 *  - 完成态：摘要行 + 统一 diff 预览（hunk 头 + 行号）；
 *  - 运行态 → 完成态切换：reducer 事件驱动，帧从 `[运行中]` 变为摘要 + diff；
 *  - 行账 parity：渲染行数 === liveToolPreviewRows。
 */
import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import {
  liveToolPreviewBox,
  liveToolPreviewRows,
  liveToolPreviewTextLines,
} from "../../src/tui/live-tool-preview.js";
import {
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
  test("已完成：状态行 + 可见 diff 行", () => {
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
    expect(rows.some((r) => r.includes("+hello"))).toBe(true);
    expect(rows.length).toBe(liveToolPreviewRows(run, 80));
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
    expect(frame).toContain("+hello");
    await setup.renderer.destroy();
  });
});

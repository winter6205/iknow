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
import { RGBA } from "@opentui/core";
import {
  completedToolPreview,
  visualWidth,
} from "../../src/tui/tool-summary.js";
import { completedToolPreviewTextLines } from "../../src/tui/completed-tool-preview-view.js";
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
import { tuiPalette } from "../../src/tui/theme.js";

function rgbaEq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

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
    // #tui-render-overhaul T3:成功态无 [完成] 前缀。
    expect(frame).toContain("edit_file · 编辑 a.ts：old → new");
    expect(frame.includes("[完成]")).toBe(false);
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

  test("write_file 新文件代码预览：c4 codeBlockBg + syntaxKeyword", async () => {
    const run: LiveToolRun = {
      id: "wf-c4",
      name: "write_file",
      status: "ok",
      input: { path: "a.ts", content: "export const x = 1;\n" },
      detail: "写入 a.ts（1 行）",
      oldContent: "",
      newContent: "export const x = 1;\n",
    };
    const setup = await renderBox(run, 80);
    const expectedBg = RGBA.fromHex(tuiPalette.codeBlockBg);
    const expectedKw = RGBA.fromHex(tuiPalette.syntaxKeyword);
    const { lines } = setup.captureSpans();
    let sawBg = false;
    let sawKw = false;
    for (const line of lines) {
      for (const span of line.spans) {
        if (rgbaEq(span.bg, expectedBg)) sawBg = true;
        if (span.text === "export" && rgbaEq(span.fg, expectedKw)) sawKw = true;
      }
    }
    expect(sawBg).toBe(true);
    expect(sawKw).toBe(true);
    const frame = setup.captureCharFrame();
    const rendered = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(rendered.length).toBe(liveToolPreviewRows(run, 80));
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
    // #tui-render-overhaul T3:成功态无 [完成] 前缀。
    expect(rows[0]).toBe("write_file · 写入 a.ts（1 行）");
    expect(rows[0]?.includes("[完成]")).toBe(false);
    expect(rows).toContain("hello");
    expect(rows.some((r) => r.includes("+hello"))).toBe(false);
    expect(rows.length).toBe(liveToolPreviewRows(run, 80));
  });

  test("完成态预览行去掉状态行后与共用 view 文本同源", () => {
    const run: LiveToolRun = {
      id: "r",
      name: "write_file",
      status: "ok",
      input: { path: "a.ts", content: "hello\nworld\n" },
      detail: "写入 a.ts（2 行）",
      oldContent: "",
      newContent: "hello\nworld\n",
    };
    const preview = completedToolPreview(run.name, run.input, {
      oldContent: run.oldContent,
      newContent: run.newContent,
    });
    expect([...liveToolPreviewTextLines(run, 80)].slice(1)).toEqual(
      completedToolPreviewTextLines(preview, 80)
    );
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
    // #tui-render-overhaul T3:成功态无 [完成] 前缀。
    const frame = await untilFrame(
      setup,
      (f) =>
        f.includes("write_file · 写入 a.ts（1 行）") && !f.includes("[完成]")
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

  test("running edit_file + 完整 JSON：1 行且帧/文本不含 new_str", async () => {
    const distinctive = "NEWTKN99";
    const run: LiveToolRun = {
      id: "tu-edit-run",
      name: "edit_file",
      status: "running",
      input: undefined,
      partialInput: JSON.stringify({
        path: "a.ts",
        old_str: "old-token",
        new_str: distinctive,
      }),
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows).toHaveLength(1);
    expect(rows.join("\n")).not.toContain(distinctive);
    const setup = await renderBox(run, 80);
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain(distinctive);
    await setup.renderer.destroy();
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

describe("formatRunningToolLine: 子代理工具运行行（plans T7 钉死不再 `▣ 派发子代理中…`）", () => {
  test("spawn_subagent run → 仅返 detail（无 `▣` glyph）", () => {
    const run: LiveToolRun = {
      id: "tu-spawn",
      name: "spawn_subagent",
      status: "running",
      input: undefined,
    };
    const line = formatRunningToolLine(run);
    expect(line).toBe("派发子代理：?");
    expect(line.includes("▣")).toBe(false);
  });

  test("subagent_result run → 仅返 detail（无 `▣` glyph）", () => {
    const run: LiveToolRun = {
      id: "tu-poll",
      name: "subagent_result",
      status: "running",
      input: undefined,
    };
    const line = formatRunningToolLine(run);
    expect(line).toBe("轮询 ?");
    expect(line.includes("▣")).toBe(false);
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

describe("liveToolPreviewTextLines (#589 贴底尾巴不含成功只读完成行)", () => {
  function reduceTail(
    events: ReadonlyArray<Parameters<typeof liveToolReduce>[1]>
  ): ReadonlyArray<LiveToolRun> {
    let runs: ReadonlyArray<LiveToolRun> = [];
    for (const event of events) {
      runs = liveToolReduce(runs, event);
    }
    return runs;
  }

  function previewLines(runs: ReadonlyArray<LiveToolRun>): string {
    return runs
      .flatMap((run) => [...liveToolPreviewTextLines(run, 80)])
      .join("\n");
  }

  test("20 条 read_file ok + failed grep + 1 running：无完成读文案，失败行与运行中仍在", () => {
    const events: Parameters<typeof liveToolReduce>[1][] = [];
    for (let i = 0; i < 20; i++) {
      const id = `tu-rf-${String(i).padStart(2, "0")}`;
      const marker = `MARKER_READ_OK_${i}`;
      events.push({
        kind: "tool_call_start",
        id,
        name: "read_file",
      });
      events.push({
        kind: "post_tool_use",
        id,
        name: "read_file",
        input: { path: `${marker}.ts` },
        ok: true,
        detail: `读取 ${marker}.ts`,
      });
    }
    events.push({ kind: "tool_call_start", id: "tu-grep-fail", name: "grep" });
    events.push({
      kind: "post_tool_use",
      id: "tu-grep-fail",
      name: "grep",
      input: { pattern: "GREP_FAIL_MARKER" },
      ok: false,
      message: "no matches",
      detail: "GREP_FAIL_MARKER",
    });
    events.push({
      kind: "tool_call_start",
      id: "tu-running",
      name: "read_file",
    });
    const text = previewLines(reduceTail(events));
    expect(text).toContain("[运行中] read_file");
    expect(text).toContain("GREP_FAIL_MARKER");
    expect(text).not.toContain("MARKER_READ_OK_");
    expect(text).not.toMatch(/read_file · .* · ok/);
  });

  test("SC4 live 失败件：一行短错误截断长回执，不堆 dim ⎿ 多行", () => {
    // D5（spec specs/tui-tool-settled-appearance.md）：live 失败件同样走
    // 一行短错误 —— message 长回执被 clipErrorLine 截成单行，且不再画
    // dim ⎿ stderr 预览（失败件 resultPreviewOf 恒 empty）。
    const run: LiveToolRun = {
      id: "tu-bash-fail-live2",
      name: "bash",
      status: "failed",
      input: { command: "false" },
      detail: "false",
      message:
        "[worktree_isolation] workspace mutation blocked: bash in this session. " +
        "workspace mutation blocked: worktree isolation is ON and this session " +
        "is not yet bound to a task worktree. Call the create-task-worktree ACI",
      stderr: "boom-1\nboom-2\nboom-3",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    // 标题行 + 恰 1 行错误 = 2 行账。
    expect(rows.length).toBe(2);
    expect(rows[0]).toBe("[失败] bash · false");
    // 一行短错误：以 … 截断（长回执收进单行）。
    expect(rows[1]!.startsWith("[worktree_isolation]")).toBe(true);
    expect(rows[1]!.endsWith("…")).toBe(true);
    // 不堆 stderr 长文。
    expect(rows.some((r) => r.includes("⎿"))).toBe(false);
    expect(rows.some((r) => r.includes("boom-"))).toBe(false);
  });
});

// -- #693 T4 D4:live 路径 bash / skill 结果预览 ---------------------------

describe("liveToolPreviewTextLines / liveToolPreviewBox: live bash 结果预览", () => {
  test("完成态 bash + stdout 旁路：尾部 5 行 dim 预览 + 溢出", () => {
    const stdout = Array.from({ length: 8 }, (_, i) => `out-${i}`).join("\n");
    const run: LiveToolRun = {
      id: "tu-bash-live",
      name: "bash",
      status: "ok",
      input: { command: "ls" },
      detail: "ls",
      stdout,
    };
    const rows = liveToolPreviewTextLines(run, 80);
    // 首行：完成态摘要（#tui-render-overhaul T3:无 [完成] 前缀）
    expect(rows[0]).toBe("bash · ls");
    expect(rows[0]?.includes("[完成]")).toBe(false);
    // 尾 5 行带 ⎿ 前缀
    expect(rows).toContain("⎿ out-3");
    expect(rows).toContain("⎿ out-7");
    // 早于尾窗的不出现
    expect(rows.some((r) => r.includes("⎿ out-0"))).toBe(false);
    // 溢出 +N 行
    expect(rows.some((r) => r.includes("… +") && r.includes("行"))).toBe(true);
  });

  test("完成态 bash 失败（status=failed）:不画 stderr 预览（D5 一行短错误）", () => {
    // D5（spec specs/tui-tool-settled-appearance.md）：失败件核置
    // showPreview 假 —— 失败只有一行截断短错误，无 dim ⎿ 预览块。
    const run: LiveToolRun = {
      id: "tu-bash-fail-live",
      name: "bash",
      status: "failed",
      input: { command: "false" },
      detail: "false",
      stderr: "boom-1\nboom-2",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows[0]).toBe("[失败] bash · false");
    expect(rows.some((r) => r.includes("⎿"))).toBe(false);
    expect(rows.some((r) => r.includes("boom-"))).toBe(false);
  });

  test("完成态 bash 空 stdout/全空白：仅状态行,无 ⎿", () => {
    const run: LiveToolRun = {
      id: "tu-bash-empty",
      name: "bash",
      status: "ok",
      input: { command: "x" },
      detail: "x",
      stdout: "   \n\t\n  ",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    // #tui-render-overhaul T3:成功态无 [完成] 前缀。
    expect(rows[0]).toBe("bash · x");
    expect(rows[0]?.includes("[完成]")).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.includes("⎿"))).toBe(false);
  });

  test("完成态 bash ANSI 透传:SGR 序列在 ⎿ 行内原样保留", () => {
    const run: LiveToolRun = {
      id: "tu-bash-ansi-live",
      name: "bash",
      status: "ok",
      input: { command: "git status" },
      detail: "git status",
      stdout: "\x1b[31mERROR\x1b[0m line",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows.some((r) => r.includes("ERROR") && r.includes("⎿"))).toBe(true);
  });

  test("live box 帧：bash 尾部预览 ⎿ 行出现", async () => {
    const run: LiveToolRun = {
      id: "tu-bash-box",
      name: "bash",
      status: "ok",
      input: { command: "ls" },
      detail: "ls",
      stdout: "file-a\nfile-b\nfile-c",
    };
    const setup = await renderBox(run, 80);
    const frame = setup.captureCharFrame();
    // #tui-render-overhaul T3:成功态无 [完成] 前缀。
    expect(frame).toContain("bash · ls");
    expect(frame.includes("[完成]")).toBe(false);
    expect(frame).toContain("⎿ file-a");
    expect(frame).toContain("⎿ file-c");
    await setup.renderer.destroy();
  });

  test("running 态 bash:不画 ⎿ 预览（结果预览与状态行都不在 running 时挂）", () => {
    const run: LiveToolRun = {
      id: "tu-bash-runn",
      name: "bash",
      status: "running",
      input: { command: "ls" },
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows[0]).toBe("[运行中] bash · ls");
    expect(rows.some((r) => r.includes("⎿"))).toBe(false);
    expect(liveToolPreviewRows(run, 80)).toBe(1);
  });

  test("完成态 skill：单行 resultText 显示 1 行", () => {
    const run: LiveToolRun = {
      id: "tu-skill-live",
      name: "skill",
      status: "ok",
      input: { name: "demo" },
      detail: "skill demo",
      // live 路径：skill 无旁路 → resultText 也缺 → 实际为 empty
      // （live previewer 走 resultText，未挂旁路）。
    };
    const rows = liveToolPreviewTextLines(run, 80);
    // 缺 resultText → 不画 ⎿
    expect(rows.some((r) => r.includes("⎿"))).toBe(false);
  });

  test("SC5 live accent 成功：skill 完成行走 accent 色（非 dim）", async () => {
    const run: LiveToolRun = {
      id: "tu-skill-accent",
      name: "skill",
      status: "ok",
      input: { name: "demo" },
      detail: "skill demo",
    };
    const setup = await renderBox(run, 80);
    const expectedAccent = RGBA.fromHex(tuiPalette.accent);
    const { lines } = setup.captureSpans();
    let sawAccent = false;
    for (const line of lines) {
      for (const span of line.spans) {
        if (span.text.includes("skill demo") && rgbaEq(span.fg, expectedAccent))
          sawAccent = true;
      }
    }
    expect(sawAccent).toBe(true);
    await setup.renderer.destroy();
  });

  test("SC5 live accent 成功：dim 不染 accent 完成行", async () => {
    const run: LiveToolRun = {
      id: "tu-ctw-accent",
      name: "create-task-worktree",
      status: "ok",
      input: {},
      detail: "创建任务工作树",
    };
    const setup = await renderBox(run, 80);
    const expectedDim = RGBA.fromHex(tuiPalette.dim);
    const { lines } = setup.captureSpans();
    for (const line of lines) {
      for (const span of line.spans) {
        if (span.text.includes("创建任务工作树")) {
          expect(rgbaEq(span.fg, expectedDim)).toBe(false);
        }
      }
    }
    await setup.renderer.destroy();
  });
});

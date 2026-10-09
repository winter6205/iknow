/** @jsxImportSource @opentui/react */
/**
 * tests/tui/live-tool-preview.test.tsx
 *
 * live-tool-preview (OpenTUI edition) — tool running lines:
 *  - running state: only the "running" status line for the tool name (1-line budget);
 *  - completed state: summary line + unified diff preview (hunk header + line numbers);
 *  - running → completed switch: reducer-event-driven, the frame goes from
 *    the running marker to summary + diff;
 *  - line-budget parity: rendered line count === liveToolPreviewRows.
 *
 * tool_input_delta incremental consumption:
 *  - the reducer accumulates partialJson into the running entry's partialInput;
 *  - running renders the running marker + `bash · <partial summary>` (successful parse goes
 *    through summarizeToolCall; incomplete JSON is truncated verbatim);
 *  - post_tool_use completion overwrites with the full input and clears partialInput.
 */
import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import { completedToolPreview } from "../../src/tui/tool-summary.js";
import { completedToolPreviewTextLines } from "../../src/tui/completed-tool-preview-view.js";
import {
  liveToolPreviewBox,
  liveToolPreviewRows,
  liveToolPreviewTextLines,
  liveToolRunsBox,
  filterLiveToolRunsAgainstSpawnCards,
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

/** Polling frame waiter (same as the list-view-scroll comment). */
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
    // Success state carries no [完成] ("[done]") prefix.
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
    // Running process line — even before input arrives (detail empty) the shell
    // process line stands; it never degrades to a bare tool name or a dangling ` ·`.
    expect(frame).toContain("Running 1 shell command…");
    expect(frame.includes("[运行中]")).toBe(false);
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
      detail: "Wrote a.ts (1 lines)",
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
      detail: "Wrote a.ts (1 lines)",
      oldContent: "",
      newContent: "hello\n",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    // Success state carries no [完成] ("[done]") prefix.
    expect(rows[0]).toBe("write_file · Wrote a.ts (1 lines)");
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
      detail: "Wrote a.ts (2 lines)",
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
      detail: "Wrote a.ts (20 lines)",
      oldContent: "",
      newContent: content,
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows).toContain("body-0");
    expect(rows.some((r) => r.includes("body-19"))).toBe(false);
    // CONTEXT `write create preview`: overflow text is English `+N more lines`.
    expect(rows.some((r) => r.includes("+10 more lines"))).toBe(true);
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
    // Running state = start + the first input deltas: the write_file process
    // line needs the streamed input to show a path (authoritative input is
    // delivered only once, on the completion event).
    const [runs, setRuns] = useState<ReadonlyArray<LiveToolRun>>(() =>
      liveToolReduce(
        liveToolReduce([], {
          kind: "tool_call_start",
          id: "tu-9",
          name: "write_file",
        }),
        {
          kind: "tool_input_delta",
          id: "tu-9",
          partialJson: '{"path":"a.ts"}',
        }
      )
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
            detail: "Wrote a.ts (1 lines)",
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
    // Running is an English process line (write_file with path → `Wrote
    // <path>`; line count is untrustworthy until content arrives, so
    // half-streamed input never shows it), no `[运行中]` ("running") brackets.
    const runningFrame = setup.captureCharFrame();
    expect(runningFrame).toContain("write_file · Wrote a.ts");
    expect(runningFrame.includes("[运行中]")).toBe(false);
    setup.mockInput.pressEnter();
    // Success state carries no [完成] ("[done]") prefix.
    const frame = await untilFrame(
      setup,
      (f) =>
        f.includes("write_file · Wrote a.ts (1 lines)") && !f.includes("[完成]")
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
    // A completed entry receiving a delta → ignored (not running).
    const afterDone = liveToolReduce(done, {
      kind: "tool_input_delta",
      id: "tu-1",
      partialJson: '{"command":"ls"}',
    });
    expect(afterDone[0]?.partialInput).toBeUndefined();
    // Unmatched id → returned as-is.
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
    // Later events may belong to earlier entries (pairing by id, not FIFO position).
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
  test("partial parse 成功 → `Running 1 shell command… · <摘要>`（含 ls）", () => {
    const run: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "running",
      input: undefined,
      partialInput: '{"command":"ls"}',
    };
    const rows = liveToolPreviewTextLines(run, 80);
    // Running bash process line = `Running 1 shell command… · <command>`.
    expect(rows[0]).toContain("Running 1 shell command…");
    expect(rows[0]).toContain("ls");
    expect(rows[0]).not.toContain(" · {"); // parse success → summarized
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

  test("partialInput 空 / undefined → 保持基础过程行（bash 只余 shell 前缀）", () => {
    const empty: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "running",
      input: undefined,
      partialInput: "",
    };
    expect(liveToolPreviewTextLines(empty, 80)[0]).toBe(
      "Running 1 shell command…"
    );
    const none: LiveToolRun = {
      id: "tu-2",
      name: "bash",
      status: "running",
      input: undefined,
    };
    expect(liveToolPreviewTextLines(none, 80)[0]).toBe(
      "Running 1 shell command…"
    );
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

  test("窄终端：partial 摘要视觉宽度收口（始终恰好 1 行，不折行）", () => {
    const run: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "running",
      input: undefined,
      partialInput: `{"command":"${"x".repeat(300)}"}`,
    };
    const rows = liveToolPreviewTextLines(run, 30);
    // Single-line contract: however narrow the terminal or how long the
    // command, the process line occupies exactly 1 row (line-budget parity:
    // `liveToolPreviewRows` must also be 1). Truncation is by visual width;
    // long commands end with `…` instead of wrapping to a second line — that
    // is the real "no wrap" invariant. Width clamping is guaranteed by
    // tool-summary's clipDetail budget (regression covered by the running
    // prefix cases in tool-summary.test.ts).
    expect(rows.length).toBe(1);
    expect(liveToolPreviewRows(run, 30)).toBe(1);
    const line = rows[0] ?? "";
    expect(line.startsWith("Running 1 shell command…")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
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
    expect(rows[0]).toContain("write_file · Wrote a.ts");
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
    expect(frame).toContain("Running 1 shell command…");
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
    expect(line).toBe("general-purpose running");
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
    expect(line).toBe("Poll ?");
    expect(line.includes("▣")).toBe(false);
  });

  test("bash run 回归 → `Running 1 shell command…`（普通工具形态）", () => {
    const run: LiveToolRun = {
      id: "tu-bash",
      name: "bash",
      status: "running",
      input: undefined,
    };
    expect(formatRunningToolLine(run)).toBe("Running 1 shell command…");
  });
});

describe("filterLiveToolRunsAgainstSpawnCards", () => {
  test("已有 join 卡时丢掉未 join 的 spawn running 行", () => {
    const joined: LiveToolRun = {
      id: "tu-w3",
      name: "spawn_subagent",
      status: "running",
      input: undefined,
    };
    const ghost: LiveToolRun = {
      id: "tu-ghost",
      name: "spawn_subagent",
      status: "running",
      input: undefined,
    };
    const cards = new Map([
      [
        "tu-w3",
        {
          titleLine: "general-purpose",
          detailLine: "ROLE: implementation worker W3",
          done: false,
        },
      ],
    ]);
    const visible = filterLiveToolRunsAgainstSpawnCards([joined, ghost], cards);
    expect(visible.map((r) => r.id)).toEqual(["tu-w3"]);
  });

  test("没有任何 join 卡时仍保留第一条 spawn running 行", () => {
    const first: LiveToolRun = {
      id: "tu-only",
      name: "spawn_subagent",
      status: "running",
      input: undefined,
    };
    expect(
      filterLiveToolRunsAgainstSpawnCards([first], new Map()).map((r) => r.id)
    ).toEqual(["tu-only"]);
  });
});

describe("liveToolPreviewTextLines (T5 收类落定后不再占逐条面)", () => {
  function reduceTail(
    events: ReadonlyArray<Parameters<typeof liveToolReduce>[1]>
  ): ReadonlyArray<LiveToolRun> {
    let runs: ReadonlyArray<LiveToolRun> = [];
    for (const event of events) {
      runs = liveToolReduce(runs, event);
    }
    return runs;
  }

  /** Per-entry preview for the consumer side (ChatView running surface) —
   * after `splitLiveActivityRuns`' running/idle split was retired, the
   * per-entry surface = all live runs in original order (failed, collected,
   * keep), and the `liveTailSlots` consumer decides which enter the
   * unanchored block. This test's "no completed-read copy / failed line still
   * there / running line still there" asserts ask only about **lines** —
   * completed collected entries once vanished from the per-entry surface when
   * `splitLiveActivityRuns` extracted them into groups; under the new
   * contract the per-entry surface keeps all runs and filtering happens only
   * in unanchored-block derivation (`deriveActivityBlocks`). */
  function previewLines(runs: ReadonlyArray<LiveToolRun>): string {
    return runs
      .flatMap((run) => [...liveToolPreviewTextLines(run, 80)])
      .join("\n");
  }

  test("20 条 read_file ok + failed grep + 1 running：完成读逐条仍在，失败行与运行中仍在", () => {
    // The reducer **no longer deletes** completed collected-class entries
    // (direct delete + history-id filtering stacked into a double delete,
    // leaving nowhere to place them on the frame). The visibility gate moved
    // to the consumer side.
    //
    // Since specs/tui-activity-block.md: completed collected entries
    // (read_file ok) are no longer extracted by `splitLiveActivityRuns` — the
    // per-entry surface keeps all runs in order; their "no double paint" is
    // guaranteed by `liveTailSlots`' retract filter (no tail tool cards
    // appended), with the unanchored block carrying the `read_file × N` count
    // line. This test only checks the single-entry render shape of
    // `liveToolPreviewTextLines`: completed collected entries still go through
    // the same preview channel (detail line visible), failed entries keep
    // `[失败]` ("failed"), running entries keep the "Read ?" placeholder.
    // Group-count / block-title assertions live in the activity-block tests.
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
    const runs = reduceTail(events);
    const text = previewLines(runs);
    // read_file running process line (detail slot).
    expect(text).toContain("read_file · Read ?");
    // Failures cut across: the error line stays on the per-entry surface
    // (never group-counted).
    expect(text).toContain("GREP_FAIL_MARKER");
    // Completed collected entries also go through the same preview channel
    // (detail line visible) — no longer extracted by
    // `splitLiveActivityRuns`. Both reducer and single-entry render keep full
    // information; the consumer side (`liveTailSlots` + `appendLiveBlocks`)
    // applies the retract filter to decide tail vs unanchored block.
    expect(text).toContain("MARKER_READ_OK_");
  });

  test("SC4 live 失败件：一行短错误截断长回执，不堆 dim 预览多行", () => {
    // Live failed entries also render one short error line — the long
    // message receipt is clipped to a single line by clipErrorLine, and no
    // dim stderr preview is drawn (failed entries' resultPreviewOf is always
    // empty).
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
    // title line + exactly 1 error line = 2-line budget.
    expect(rows.length).toBe(2);
    expect(rows[0]).toBe("[失败] bash · false");
    // One short error line: clipped with … (long receipt fits one line).
    expect(rows[1]!.startsWith("[worktree_isolation]")).toBe(true);
    expect(rows[1]!.endsWith("…")).toBe(true);
    // No stacked stderr body.
    expect(rows.some((r) => r.includes("> "))).toBe(false);
    expect(rows.some((r) => r.includes("boom-"))).toBe(false);
  });
});

// -- live-path bash / skill result preview ---------------------------------

describe("liveToolPreviewTextLines / liveToolPreviewBox: live bash 结果预览", () => {
  test("完成态 bash + stdout 旁路：尾部 result preview 窗 + 溢出", () => {
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
    // First line: completion summary (no [完成] ("[done]") prefix).
    expect(rows[0]).toBe("bash · ls");
    expect(rows[0]?.includes("[完成]")).toBe(false);
    // Tail 3 lines carry a │ gutter and no longer start with `>` (SSOT =
    // docs/CONTEXT.md **result preview**: bash tail is at most 3 lines).
    expect(rows).toContain("│ out-5");
    expect(rows).toContain("│ out-7");
    expect(rows.some((r) => r.startsWith("> "))).toBe(false);
    // Anything earlier than the tail window does not appear
    expect(rows.some((r) => r.includes("│ out-0"))).toBe(false);
    expect(rows.some((r) => r.includes("│ out-4"))).toBe(false);
    // Overflow +N line (no `>` / `> `)
    const overflow = rows.find((r) => r.includes("… +") && r.includes("行"));
    expect(overflow).toBeDefined();
    expect(overflow!.includes(">")).toBe(false);
    expect(overflow!.startsWith("> ")).toBe(false);
  });

  test("相邻 live keep 卡之间空一行（卡间距节奏 = 历史 MessageBlocks 同款）", async () => {
    // Adjacent keep-class title cards (history MessageBlocks and the live
    // tail) get one blank line between them. History-side MessageBlocks are
    // already guaranteed by withBlockSpacing; this test pins the card spacing
    // of the live-runs container.
    const runs: ReadonlyArray<LiveToolRun> = [
      {
        id: "gap-1",
        name: "bash",
        status: "ok",
        input: { command: "one" },
        detail: "one",
        stdout: "GAP_FIRST_OUT",
      },
      {
        id: "gap-2",
        name: "bash",
        status: "ok",
        input: { command: "two" },
        detail: "two",
        stdout: "GAP_SECOND_OUT",
      },
    ];
    const setup = await testRender(
      <box flexDirection="column" width={80}>
        {liveToolRunsBox(runs, 80)}
      </box>,
      { width: 80, height: 12, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    const firstTitle = lines.findIndex((l) => l.includes("bash · one"));
    const secondTitle = lines.findIndex((l) => l.includes("bash · two"));
    expect(firstTitle).toBeGreaterThanOrEqual(0);
    expect(secondTitle).toBeGreaterThanOrEqual(0);
    // Exactly one blank line between the two cards (first card's body is not
    // adjacent to the second card's title).
    expect(secondTitle - firstTitle).toBeGreaterThanOrEqual(3);
    const between = lines.slice(firstTitle + 1, secondTitle);
    expect(between.some((l) => l.trim().length === 0)).toBe(true);
    expect(between.filter((l) => l.trim().length === 0).length).toBe(1);
    await setup.renderer.destroy();
  });

  test("单张 live keep 卡不因卡间距凭空多出顶部空行（首卡无 gap）", async () => {
    const run: LiveToolRun = {
      id: "gap-solo",
      name: "bash",
      status: "ok",
      input: { command: "solo" },
      detail: "solo",
      stdout: "SOLO_OUT",
    };
    const setup = await testRender(
      <box flexDirection="column" width={80}>
        {liveToolRunsBox([run], 80)}
      </box>,
      { width: 80, height: 10, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const first = setup.captureCharFrame().split("\n")[0] ?? "";
    expect(first).toContain("bash · solo");
    await setup.renderer.destroy();
  });

  test("完成态 bash 失败（status=failed）:不画 stderr 预览（D5 一行短错误）", () => {
    // Failed entries set showPreview false — a failure renders only one
    // truncated short-error line, no dim preview block.
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
    expect(rows.some((r) => r.includes("> "))).toBe(false);
    expect(rows.some((r) => r.includes("boom-"))).toBe(false);
  });

  test("完成态 bash 空 stdout/全空白：仅状态行,无预览前缀行", () => {
    const run: LiveToolRun = {
      id: "tu-bash-empty",
      name: "bash",
      status: "ok",
      input: { command: "x" },
      detail: "x",
      stdout: "   \n\t\n  ",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    // Success state carries no [完成] ("[done]") prefix.
    expect(rows[0]).toBe("bash · x");
    expect(rows[0]?.includes("[完成]")).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.includes("> "))).toBe(false);
  });

  test("完成态 bash ANSI 透传:SGR 序列在前缀行内原样保留", () => {
    const run: LiveToolRun = {
      id: "tu-bash-ansi-live",
      name: "bash",
      status: "ok",
      input: { command: "git status" },
      detail: "git status",
      stdout: "\x1b[31mERROR\x1b[0m line",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows.some((r) => r.includes("ERROR") && r.includes("│ "))).toBe(
      true
    );
  });

  test("live box 帧：bash 尾部预览 │ gutter 行出现", async () => {
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
    // Success state carries no [完成] ("[done]") prefix.
    expect(frame).toContain("bash · ls");
    expect(frame.includes("[完成]")).toBe(false);
    expect(frame).toContain("│ file-a");
    expect(frame).toContain("│ file-c");
    expect(frame).not.toContain("> file-a");
    await setup.renderer.destroy();
  });

  test("running 态 bash:不画预览前缀行（结果预览与状态行都不在 running 时挂）", () => {
    const run: LiveToolRun = {
      id: "tu-bash-runn",
      name: "bash",
      status: "running",
      input: { command: "ls" },
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows[0]).toBe("Running 1 shell command… · ls");
    expect(rows.some((r) => r.includes("> "))).toBe(false);
    expect(liveToolPreviewRows(run, 80)).toBe(1);
  });

  test("完成态 skill：单行 resultText 显示 1 行", () => {
    const run: LiveToolRun = {
      id: "tu-skill-live",
      name: "skill",
      status: "ok",
      input: { name: "demo" },
      detail: "skill demo",
      // live path: skill has no side-channel → resultText absent too →
      // effectively empty (the live previewer reads resultText, no
      // side-channel attached).
    };
    const rows = liveToolPreviewTextLines(run, 80);
    // resultText absent → no preview prefix lines drawn
    expect(rows.some((r) => r.includes("> "))).toBe(false);
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
      name: "create-worktree",
      status: "ok",
      input: { name: "demo-tree" },
      detail: "demo-tree",
    };
    const setup = await renderBox(run, 80);
    const expectedDim = RGBA.fromHex(tuiPalette.dim);
    const { lines } = setup.captureSpans();
    // The completed line draws the precomputed detail (exactly what app.tsx's
    // post_tool_use path stores from `summarizeToolCall`); the registry text
    // behind it is pinned in tests/cli/chat-stream-preview.test.ts (k). The
    // rendered detail must actually appear on the frame, or the color
    // assertion spins vacuously (old-name assertions broke after the rename —
    // pin the actually visible text here).
    let sawLine = false;
    for (const line of lines) {
      for (const span of line.spans) {
        if (span.text.includes("create-worktree · demo-tree")) {
          sawLine = true;
          expect(rgbaEq(span.fg, expectedDim)).toBe(false);
        }
      }
    }
    expect(sawLine).toBe(true);
    await setup.renderer.destroy();
  });

  test("SC5 live running：树名未到齐 → 裸注册名，不出现 `· ?`", () => {
    // The running projection goes through the registry (summarizePartialInput →
    // runningSummary), so this pins the streaming half of the same contract:
    // the "?" placeholder appears only once the call settled. While the input
    // is still arriving the line stays the bare registered name.
    const notYet: LiveToolRun = {
      id: "tu-ctw-notyet",
      name: "create-worktree",
      status: "running",
      input: undefined,
      partialInput: "{}",
    };
    expect(liveToolPreviewTextLines(notYet, 80)[0]).toBe("create-worktree");
    const arrived: LiveToolRun = {
      ...notYet,
      id: "tu-ctw-arrived",
      partialInput: '{"name":"demo-tree"}',
    };
    expect(liveToolPreviewTextLines(arrived, 80)[0]).toBe(
      "create-worktree · demo-tree"
    );
  });
});

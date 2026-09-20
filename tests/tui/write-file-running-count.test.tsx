/** @jsxImportSource @opentui/react */
/**
 * tests/tui/write-file-running-count.test.tsx
 *
 * Invariant: the write_file running line shows a line count only when it is
 * **known**.
 *  - While running, if `content` is not yet a non-empty string (missing /
 *    empty / partial not formed) → draw only `Wrote <path>`; `(0 lines)` must
 *    never appear — a mid-stream 0 is a false count;
 *  - in a settled state (ok / failed) an empty file is a real 0 lines and
 *    still shows `(0 lines)`;
 *  - while running, the `content` body must not stream into the status line or
 *    CodeBlock (no body streaming within the turn).
 *
 * Five input classes: empty / negative / overflow / concurrent / exception.
 */
import { describe, expect, test } from "bun:test";
import {
  completedToolPreview,
  formatToolStatusLine,
  summarizePartialInput,
  summarizeToolCall,
  TOOL_PREVIEW_WINDOW,
} from "../../src/tui/tool-summary.js";
import {
  liveToolPreviewRows,
  liveToolPreviewTextLines,
} from "../../src/tui/live-tool-preview.js";
import {
  formatRunningToolLine,
  type LiveToolRun,
} from "../../src/tui/live-tool-state.js";

/** A running write_file entry (partialInput omitted = no deltas received yet). */
function runningWrite(id: string, partialInput?: string): LiveToolRun {
  return {
    id,
    name: "write_file",
    status: "running",
    input: undefined,
    ...(partialInput === undefined ? {} : { partialInput }),
  };
}

const FALSE_ZERO = "(0 lines)";

describe("write_file 运行行：empty（无 partial JSON）", () => {
  test("无增量 → 裸过程行 `write_file`，不出现假 0 行", () => {
    const rows = liveToolPreviewTextLines(runningWrite("tu-empty"), 80);
    expect(rows).toEqual(["write_file"]);
    expect(rows[0]).not.toContain(FALSE_ZERO);
  });

  test("formatRunningToolLine 同源 → 无 `Wrote ?` 占位计数", () => {
    const line = formatRunningToolLine(runningWrite("tu-empty"));
    expect(line).toBe("write_file");
    expect(line).not.toContain(FALSE_ZERO);
  });

  test("空 partial 串 → 摘要空串（调用方回落基础运行行）", () => {
    expect(summarizePartialInput("write_file", "", 80)).toBe("");
  });
});

describe("write_file 运行行：negative（content 缺失 / 空串）", () => {
  test("partial 仅 path → `Wrote path`，无行数", () => {
    const rows = liveToolPreviewTextLines(
      runningWrite("tu-path", '{"path":"a.ts"}'),
      80
    );
    expect(rows).toEqual(["write_file · Wrote a.ts"]);
    expect(rows[0]).not.toContain("行）");
  });

  test("partial 含空 content → 仍只有 path，无 0 行", () => {
    const rows = liveToolPreviewTextLines(
      runningWrite("tu-empty-content", '{"path":"a.ts","content":""}'),
      80
    );
    expect(rows).toEqual(["write_file · Wrote a.ts"]);
    expect(rows[0]).not.toContain(FALSE_ZERO);
  });

  test("历史运行态（tool_result 未到）同样只画 path", () => {
    expect(
      formatToolStatusLine({
        toolName: "write_file",
        input: { path: "a.ts", content: "" },
        status: "running",
        cols: 80,
      })
    ).toBe("write_file · Wrote a.ts");
  });

  test("运行中 content 非 string（未成形）→ 只画 path", () => {
    expect(
      summarizeToolCall("write_file", { path: "a.ts" }, 80, { running: true })
        .detail
    ).toBe("Wrote a.ts");
  });

  test("落定态空文件仍显示 0 行（真实的空文件，不是未知）", () => {
    expect(
      formatToolStatusLine({
        toolName: "write_file",
        input: { path: "a.ts", content: "" },
        status: "ok",
        cols: 80,
      })
    ).toBe("write_file · Wrote a.ts (0 lines)");
    expect(
      summarizeToolCall("write_file", { path: "a.ts", content: "" }).detail
    ).toBe("Wrote a.ts (0 lines)");
  });
});

describe("write_file 运行行：overflow（大内容）", () => {
  const big = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");

  test("count 已知 → 显示真实行数，仍是 1 行且无正文", () => {
    const run = runningWrite(
      "tu-big",
      JSON.stringify({ path: "a.ts", content: big })
    );
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows).toHaveLength(1);
    expect(liveToolPreviewRows(run, 80)).toBe(1);
    expect(rows[0]).toContain("Wrote a.ts (500 lines)");
    expect(rows.join("\n")).not.toContain("line-1");
  });

  test("completed 6 行预览不变（本轮不动落定态预览窗）", () => {
    const preview = completedToolPreview("write_file", {
      path: "a.ts",
      content: big,
    });
    expect(preview.kind).toBe("code");
    if (preview.kind !== "code") return;
    expect(preview.lines).toHaveLength(TOOL_PREVIEW_WINDOW);
    expect(preview.hiddenLineCount).toBe(500 - TOOL_PREVIEW_WINDOW);
  });
});

describe("write_file 运行行：concurrent（两个 run 的 count 隔离）", () => {
  test("同帧两条 running：各自 count 互不串味，重算稳定", () => {
    const known = runningWrite(
      "tu-a",
      JSON.stringify({ path: "a.ts", content: "l1\nl2\nl3" })
    );
    const unknown = runningWrite("tu-b", '{"path":"b.ts","content":"');

    const knownLine = liveToolPreviewTextLines(known, 80)[0] ?? "";
    const unknownLine = liveToolPreviewTextLines(unknown, 80)[0] ?? "";

    expect(knownLine).toBe("write_file · Wrote a.ts (3 lines)");
    expect(unknownLine).toBe("write_file");
    expect(unknownLine).not.toContain("3 行");
    expect(unknownLine).not.toContain(FALSE_ZERO);

    // Interleaved recompute: pure functions, no shared mutable state.
    expect(liveToolPreviewTextLines(unknown, 80)[0]).toBe(unknownLine);
    expect(liveToolPreviewTextLines(known, 80)[0]).toBe(knownLine);
  });
});

describe("write_file 运行行：exception（不完整 JSON）", () => {
  test("截断 JSON → 运行行不变，无 raw dump、无假 0 行", () => {
    const rows = liveToolPreviewTextLines(
      runningWrite("tu-bad", '{"path":"a.ts","content":"SHOULD_NOT'),
      80
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe("write_file");
    const joined = rows.join("\n");
    expect(joined).not.toContain("SHOULD_NOT");
    expect(joined).not.toContain('{"path"');
    expect(joined).not.toContain(FALSE_ZERO);
  });

  test("primitive / 非 object partial 不抛，且不伪造行数", () => {
    for (const partial of ["null", "123", "true", "["]) {
      const rows = liveToolPreviewTextLines(
        runningWrite(`tu-${partial}`, partial),
        80
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toContain(FALSE_ZERO);
    }
  });

  test("summarizePartialInput 直驱：运行语义不产假 0 行", () => {
    expect(summarizePartialInput("write_file", '{"path":"a.ts"}', 80)).toBe(
      "Wrote a.ts"
    );
    expect(
      summarizePartialInput("write_file", '{"path":"a.ts","content":""}', 80)
    ).toBe("Wrote a.ts");
  });
});

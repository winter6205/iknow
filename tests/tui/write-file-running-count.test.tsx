/** @jsxImportSource @opentui/react */
/**
 * tests/tui/write-file-running-count.test.tsx
 *
 * 不变式：write_file 运行行的行数只在**已知**时出现。
 *  - 运行中 `content` 还不是非空 string（缺失 / 空串 / partial 未成形）→
 *    只画 `写入 <path>`，绝不出现 `（0 行）`——流式中途的 0 是假计数；
 *  - 落定态（ok / failed）的空文件是真实的 0 行，仍显示 `（0 行）`；
 *  - 运行中不把 `content` 正文流进状态行或 CodeBlock（该轮不做正文流式）。
 *
 * 五类边界：empty / negative / overflow / concurrent / exception。
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

/** 运行中的 write_file 条目（partialInput 缺省 = 尚未收到任何增量）。 */
function runningWrite(id: string, partialInput?: string): LiveToolRun {
  return {
    id,
    name: "write_file",
    status: "running",
    input: undefined,
    ...(partialInput === undefined ? {} : { partialInput }),
  };
}

const FALSE_ZERO = "（0 行）";

describe("write_file 运行行：empty（无 partial JSON）", () => {
  test("无增量 → `[运行中] write_file`，不出现假 0 行", () => {
    const rows = liveToolPreviewTextLines(runningWrite("tu-empty"), 80);
    expect(rows).toEqual(["[运行中] write_file"]);
    expect(rows[0]).not.toContain(FALSE_ZERO);
  });

  test("formatRunningToolLine 同源 → 无 `写入 ?（0 行）` 占位计数", () => {
    const line = formatRunningToolLine(runningWrite("tu-empty"));
    expect(line).toBe("[运行中] write_file");
    expect(line).not.toContain(FALSE_ZERO);
  });

  test("空 partial 串 → 摘要空串（调用方回落基础运行行）", () => {
    expect(summarizePartialInput("write_file", "", 80)).toBe("");
  });
});

describe("write_file 运行行：negative（content 缺失 / 空串）", () => {
  test("partial 仅 path → `写入 path`，无行数", () => {
    const rows = liveToolPreviewTextLines(
      runningWrite("tu-path", '{"path":"a.ts"}'),
      80
    );
    expect(rows).toEqual(["[运行中] write_file · 写入 a.ts"]);
    expect(rows[0]).not.toContain("行）");
  });

  test("partial 含空 content → 仍只有 path，无 0 行", () => {
    const rows = liveToolPreviewTextLines(
      runningWrite("tu-empty-content", '{"path":"a.ts","content":""}'),
      80
    );
    expect(rows).toEqual(["[运行中] write_file · 写入 a.ts"]);
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
    ).toBe("[运行中] write_file · 写入 a.ts");
  });

  test("运行中 content 非 string（未成形）→ 只画 path", () => {
    expect(
      summarizeToolCall("write_file", { path: "a.ts" }, 80, { running: true })
        .detail
    ).toBe("写入 a.ts");
  });

  test("落定态空文件仍显示 0 行（真实的空文件，不是未知）", () => {
    expect(
      formatToolStatusLine({
        toolName: "write_file",
        input: { path: "a.ts", content: "" },
        status: "ok",
        cols: 80,
      })
    ).toBe("write_file · 写入 a.ts（0 行）");
    expect(
      summarizeToolCall("write_file", { path: "a.ts", content: "" }).detail
    ).toBe("写入 a.ts（0 行）");
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
    expect(rows[0]).toContain("写入 a.ts（500 行）");
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

    expect(knownLine).toBe("[运行中] write_file · 写入 a.ts（3 行）");
    expect(unknownLine).toBe("[运行中] write_file");
    expect(unknownLine).not.toContain("3 行");
    expect(unknownLine).not.toContain(FALSE_ZERO);

    // 交错重算：纯函数，无共享可变边界。
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
    expect(rows[0]).toBe("[运行中] write_file");
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
      "写入 a.ts"
    );
    expect(
      summarizePartialInput("write_file", '{"path":"a.ts","content":""}', 80)
    ).toBe("写入 a.ts");
  });
});

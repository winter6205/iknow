/** @jsxImportSource @opentui/react */
/**
 * tests/tui/shell-parity.test.tsx
 *
 * Streaming and history must render the same content with the same body start
 * column and identical tool status-line literals (killing the inconsistency:
 * live `bash · pwd · ok` vs history `[完成] bash · pwd`).
 *
 * Acceptance path:
 *  - drive message-blocks directly on a "bash + text" assistant segment → history frame;
 *  - drive live-tool-preview directly on the equivalent completed bash entry (same
 *    run.input / detail) → live completion frame;
 *  - in both frames: tool status-line literals agree (before and after unshelling), and
 *    the body start column inside the shell aligns.
 *
 * Note: this is the minimal acceptance check; full ChatView end-to-end is covered by
 * chat-view-scroll.test.tsx / chat-view-thinking-tool-fold.test.tsx.
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { MessageBlocks } from "../../src/tui/message-blocks.js";
import { liveToolPreviewBox } from "../../src/tui/live-tool-preview.js";
import { MessageShell } from "../../src/tui/message-shell.js";
import type { LiveToolRun } from "../../src/tui/live-tool-state.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const COLS = 80;

describe("SC1 流式/历史 工具状态行字面量一致（spec T1 D7）", () => {
  test("bash ok：liveToolPreviewBox 完成行 与 MessageBlocks 历史 行 字面量相同", async () => {
    const liveRun: LiveToolRun = {
      id: "tu-1",
      name: "bash",
      status: "ok",
      input: { command: "pwd" },
      detail: "pwd",
    };
    const liveSetup = await testRender(
      <>{liveToolPreviewBox(liveRun, COLS)}</>,
      {
        width: COLS,
        height: 20,
        exitOnCtrlC: false,
      }
    );
    await liveSetup.waitForVisualIdle();
    const liveFrame = liveSetup.captureCharFrame();
    await liveSetup.renderer.destroy();

    const historyMsg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "bash",
          input: { command: "pwd" },
        },
      ],
    };
    const histSetup = await testRender(
      <MessageBlocks
        message={historyMsg}
        cols={COLS}
        statusMap={new Map([["tu-1", false]])}
      />,
      { width: COLS, height: 20, exitOnCtrlC: false }
    );
    await histSetup.waitForVisualIdle();
    const histFrame = histSetup.captureCharFrame();
    await histSetup.renderer.destroy();

    // success state has no `[完成]` ("completed") prefix; both sides produce `bash · pwd`.
    expect(histFrame).toContain("bash · pwd");
    expect(liveFrame).toContain("bash · pwd");
    expect(histFrame.includes("[完成]")).toBe(false);
    expect(liveFrame.includes("[完成]")).toBe(false);
    // the live completion line no longer carries the ` · ok` suffix (the inconsistency removed here).
    expect(liveFrame.includes("pwd · ok")).toBe(false);
  });

  test("bash failed：liveToolPreviewBox 完成行 与 MessageBlocks 历史 [失败] 行 字面量相同", async () => {
    const liveRun: LiveToolRun = {
      id: "tu-2",
      name: "bash",
      status: "failed",
      input: { command: "false" },
      detail: "false",
      message: "exit 1",
    };
    const liveSetup = await testRender(
      <>{liveToolPreviewBox(liveRun, COLS)}</>,
      {
        width: COLS,
        height: 20,
        exitOnCtrlC: false,
      }
    );
    await liveSetup.waitForVisualIdle();
    const liveFrame = liveSetup.captureCharFrame();
    await liveSetup.renderer.destroy();

    const historyMsg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-2",
          name: "bash",
          input: { command: "false" },
        },
      ],
    };
    const histSetup = await testRender(
      <MessageBlocks
        message={historyMsg}
        cols={COLS}
        statusMap={new Map([["tu-2", true]])}
      />,
      { width: COLS, height: 20, exitOnCtrlC: false }
    );
    await histSetup.waitForVisualIdle();
    const histFrame = histSetup.captureCharFrame();
    await histSetup.renderer.destroy();

    expect(histFrame).toContain("[失败] bash · false");
    expect(liveFrame).toContain("[失败] bash · false");
    expect(liveFrame.includes("false · failed")).toBe(false);
  });

  test("外壳统一：MessageShell 流式草稿 与 MessageBlocks assistant 同正文起始列", async () => {
    // load the same markdown body into MessageShell (streaming draft shell) and
    // MessageBlocks (assistant branch) separately; assert both shells start the body at the same column.
    const text = "正文起始列一致性测试";
    const draftSetup = await testRender(
      <MessageShell>
        <text>{text}</text>
      </MessageShell>,
      { width: COLS, height: 10, exitOnCtrlC: false }
    );
    await draftSetup.waitForVisualIdle();
    const draftFrame = draftSetup.captureCharFrame();
    const draftIdx = draftFrame.indexOf(text);
    expect(draftIdx).toBeGreaterThanOrEqual(0);
    await draftSetup.renderer.destroy();

    const histSetup = await testRender(
      <MessageBlocks
        message={{
          role: "assistant",
          content: [{ type: "text", text }],
        }}
        cols={COLS}
        statusMap={new Map()}
      />,
      { width: COLS, height: 10, exitOnCtrlC: false }
    );
    await histSetup.waitForVisualIdle();
    const histFrame = histSetup.captureCharFrame();
    const histIdx = histFrame.indexOf(text);
    expect(histIdx).toBeGreaterThanOrEqual(0);
    await histSetup.renderer.destroy();

    // both shells start the body at the same column: with paddingX={1} both are col 1 (0-based first column).
    // numeric comparison basis: find the first line's character offset as line number + column (length of blank before the first non-space char).
    function lineCol(
      frame: string,
      needle: string
    ): { line: number; col: number } {
      const lines = frame.split("\n");
      const lineIdx = lines.findIndex((l) => l.includes(needle));
      const line = lines[lineIdx] ?? "";
      const col = line.indexOf(needle);
      return { line: lineIdx, col };
    }
    expect(lineCol(draftFrame, text)).toEqual(lineCol(histFrame, text));
  });
});

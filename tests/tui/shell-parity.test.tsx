/** @jsxImportSource @opentui/react */
/**
 * tests/tui/shell-parity.test.tsx
 *
 * #693 T1 D1/D7 SC1：流式与历史渲染同一段内容时，正文起始列相同、
 * 工具状态行字面量相同（消除 spec 列出的不一致：live `bash · pwd · ok`
 * vs 历史 `[完成] bash · pwd`）。
 *
 * 验收路径：
 *  - 直接驱动 message-blocks 渲染一段「bash + text」assistant 内容，
 *    拿到历史帧；
 *  - 直接驱动 live-tool-preview 渲染等价的 bash 完成条目（run.input /
 *    detail 与上同），拿到 live 完成帧；
 *  - 两帧中：工具状态行字面量一致（去壳前后），shell 内正文起始列
 *    对齐。
 *
 * 注：本用例是 spec SC1 的最小化验收，全 ChatView 端到端由
 * chat-view-scroll.test.tsx / chat-view-thinking-tool-fold.test.tsx 覆盖。
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

    // #tui-render-overhaul T3:成功态无 [完成] 前缀,两侧都产 `bash · pwd`。
    expect(histFrame).toContain("bash · pwd");
    expect(liveFrame).toContain("bash · pwd");
    expect(histFrame.includes("[完成]")).toBe(false);
    expect(liveFrame.includes("[完成]")).toBe(false);
    // live 完成行不再有尾缀 ` · ok`（这是 D7 消除的不一致）。
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
    // 同一段 markdown 正文分别装入 MessageShell（流式草稿壳）和
    // MessageBlocks（assistant 分支），断言两壳内正文起始列相同。
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

    // 两壳内正文起始列相同：paddingX={1} 后均为 col 1（首列起算 0 时是 col 1）。
    // 数字比较口径：找首行的字符偏移，按行号 + 列号（首个非空字符前的空白长度）。
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

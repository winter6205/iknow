/** @jsxImportSource @opentui/react */
/**
 * tests/tui/copy-paste-block.test.tsx
 *
 * #343 v3 follow-up：right-up 复制与终端 paste-byte 互斥回归测试。
 *
 * 根因（用户实测，2026-08-21）：iTerm2 / WezTerm / kitty 等终端在 mouse
 * right-up 时**自动**把"系统剪贴板当前内容"paste 到 stdin；OSC52 写剪贴板与
 * 终端发起 paste 是同一刻触发的两条独立链路 —— paste 字节里的内容是 OSC52
 * 覆盖前的旧系统剪贴板内容（不是当前选区），通过 usePaste 写进输入框。表现
 * 为"右键复制生效 + 右键粘贴把上一次复制别处的旧内容贴到输入框"。
 *
 * 修复：right-up 触发 doCopy 后设置 `pasteArmedUntilRef = Date.now() + 250`，
 * usePaste 收到 PasteEvent 时若在 arm 窗口内 → preventDefault 吞掉，不进
 * setInputValue。窗口外（用户主动 Cmd+V）保持原行为不变。
 *
 * 覆盖：
 *  1. arm 窗口内的 paste 被吞（right-up 复制 → 立即 paste → inputValue 不增）；
 *  2. arm 窗口外的 paste 不受影响（right-up 后等 300ms → paste → 正常进入）；
 *  3. 没有 right-up 的 paste 直接生效（与本修复正交，回归保护）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { MouseButtons } from "@opentui/core/testing";
import { TuiHarness } from "./_fixtures.js";

const COLS = 80;
const ROWS = 24;

let tmpDataDir: string;
beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "iknow-paste-block-"));
});
afterEach(() => {
  try {
    rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function fakeSelection(text: string): {
  getSelectedText(): string;
  touchedRenderables: unknown[];
} {
  return { getSelectedText: () => text, touchedRenderables: [] };
}

async function renderApp() {
  const setup = await testRender(<TuiHarness dataDir={tmpDataDir} />, {
    width: COLS,
    height: ROWS,
    exitOnCtrlC: false,
  });
  await setup.waitForVisualIdle();
  return setup;
}

/** 读取 PromptInput 当前输入框文本（PromptInput 是受控组件，inputValue 是 SSOT）。
 *  通过 setup.renderer 上 PromptInput 的内部 textarea getter 拿当前值。
 *  这里我们换一种思路：直接读 PromptInput 的 onChange prop 拦截，记录初始
 *  inputValue 增长 —— 通过 setInputValue 增量比对。
 *
 *  实测最简单 —— 让用户先 right-up 复制某段，然后发 paste，断言 frame 内的
 *  notice 文案 + 输入框视觉变化。但 frame 截图不可靠读输入框文本，故走更
 *  直接的路径：注入 paste，断言 inputValue（受控）通过 setInputValue(prev =>
 *  prev + text) 后被加了多少 —— 我们的代码里 inputValue 只通过 paste 增长。
 */
describe("right-click 复制与 paste 互斥（#343 v3）", () => {
  test("arm 窗口内的 paste 被吞：right-up 复制后立即发 paste，inputValue 不增长", async () => {
    const setup = await renderApp();
    const selectedText = "选中的当前文本";
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = fakeSelection(selectedText);

    // 1) right-up 触发复制 → arm 250ms 窗口
    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();
    // 复制 doCopy 是同步（OSC52 写字节），立即走完 → arm 已置

    // 2) arm 窗口内立刻发 paste（终端 right-up 的 paste byte 模拟）
    await setup.mockInput.pasteBracketedText(
      "旧剪贴板的内容（不应该进输入框）"
    );
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 50));
    await setup.waitForVisualIdle();

    // 3) 期望：notice 显示"已复制"，输入框无 paste 内容（不被旧内容污染）
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/已复制|已写入/);
    // 断言：frame 不应包含粘贴的"旧剪贴板的内容…"字样（输入框不增长）
    expect(frame).not.toContain("旧剪贴板的内容");

    setup.renderer.destroy();
  });

  test("arm 窗口外的 paste 不受影响：right-up 复制后等 300ms 再 paste，inputValue 增长", async () => {
    const setup = await renderApp();
    const selectedText = "选中的当前文本";
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = fakeSelection(selectedText);

    // 1) right-up 触发复制 → arm 250ms
    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();

    // 2) 等过 arm 窗口
    await new Promise((r) => setTimeout(r, 300));
    await setup.waitForVisualIdle();

    // 3) 此时发 paste 应正常进入输入框
    await setup.mockInput.pasteBracketedText("用户主动粘贴");
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 30));
    await setup.waitForVisualIdle();

    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/已复制|已写入/);
    // 输入框现在应有"用户主动粘贴"
    expect(frame).toContain("用户主动粘贴");

    setup.renderer.destroy();
  });

  test("未触发 right-up 直接 paste：粘贴正常进入输入框", async () => {
    const setup = await renderApp();

    // 无 right-up 直接发 paste —— 应正常进入输入框
    await setup.mockInput.pasteBracketedText("纯粘贴文本");
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 30));
    await setup.waitForVisualIdle();

    const frame = setup.captureCharFrame();
    // 不应有 "已复制 / 已写入"（没有触发复制）
    expect(frame).not.toMatch(/已复制|已写入/);
    // 输入框应有"纯粘贴文本"
    expect(frame).toContain("纯粘贴文本");

    setup.renderer.destroy();
  });

  test("Ctrl+C：有选区时复制（打断已迁 Esc，无打断副作用）", async () => {
    const setup = await renderApp();
    const selectedText = "ctrl+c 复制的文本";
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = fakeSelection(selectedText);

    // 先触发 left-drag-RELEASE（selection 事件）→ cachedSelectionTextRef 填充；
    // 与 v2 同源。fakeSelection 没 isDragging 等字段，但 useSelectionHandler
    // 只调 selection.getSelectedText()，单测不需要触发拖选——直接用现有
    // cachedSelectionTextRef 模拟：通过 emit("selection", ...) 触发一次。
    setup.renderer.emit("selection", fakeSelection(selectedText));
    await setup.waitForVisualIdle();

    // 按 Ctrl+C：选区非空 → 复制（Ctrl+C 纯复制语义，不触发打断）
    setup.mockInput.pressCtrlC();
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 50));
    await setup.waitForVisualIdle();

    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/已复制|已写入/);

    setup.renderer.destroy();
  });

  test("Ctrl+C：无选区时提示复制用法（不再指向打断）", async () => {
    const setup = await renderApp();
    // 显式置空 currentSelection + cachedSelectionTextRef（默认就是空）
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = null;

    setup.mockInput.pressCtrlC();
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 30));
    await setup.waitForVisualIdle();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("无选区");
    expect(frame).toContain("Ctrl+C");

    setup.renderer.destroy();
  });
});

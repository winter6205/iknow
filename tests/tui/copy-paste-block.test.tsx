/** @jsxImportSource @opentui/react */
/**
 * tests/tui/copy-paste-block.test.tsx
 *
 * Right-up copy vs terminal paste-byte race, regression.
 *
 * Root cause (user-observed): on mouse right-up, terminals such as
 * iTerm2 / WezTerm / kitty automatically paste the current system clipboard
 * into stdin. The OSC52 clipboard write and the terminal-initiated paste are
 * two independent paths firing at the same instant — the paste bytes carry
 * the OLD system clipboard (pre-OSC52 overwrite), not the current selection,
 * and usePaste writes it into the input box. Symptom: "right-click copy
 * works + right-click pastes some stale content copied elsewhere into the
 * input".
 *
 * Fix: after right-up triggers doCopy, set `pasteArmedUntilRef =
 * Date.now() + 250`; when usePaste receives a PasteEvent inside the arm
 * window → preventDefault and swallow it, never reaching setInputValue.
 * Outside the window (user-initiated Cmd+V) the old behavior is unchanged.
 *
 * Coverage:
 *  1. paste inside the arm window is swallowed (right-up copy → immediate
 *     paste → inputValue does not grow);
 *  2. paste outside the arm window is unaffected (right-up, wait 300ms →
 *     paste → goes through normally);
 *  3. paste without any right-up works directly (orthogonal to this fix,
 *     regression guard).
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

/** PromptInput is a controlled component, so inputValue is the SSOT for the
 *  input text. We could read it via the internal textarea getter on
 *  setup.renderer, but here we take a simpler, more direct route: inject a
 *  paste and assert on what the controlled inputValue grew by (through
 *  setInputValue(prev => prev + text)). Frame screenshots cannot reliably read
 *  input-box text, and in our code inputValue only grows via paste, so
 *  asserting the frame does or does not contain the pasted string is enough.
 */
describe("right-click 复制与 paste 互斥（#343 v3）", () => {
  test("arm 窗口内的 paste 被吞：right-up 复制后立即发 paste，inputValue 不增长", async () => {
    const setup = await renderApp();
    const selectedText = "选中的当前文本";
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = fakeSelection(selectedText);

    // 1) right-up triggers copy → arms the 250ms window
    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();
    // doCopy is synchronous (OSC52 writes bytes) and completes immediately → arm is set

    // 2) send a paste right inside the arm window (simulates the terminal's right-up paste byte)
    await setup.mockInput.pasteBracketedText(
      "旧剪贴板的内容（不应该进输入框）"
    );
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 50));
    await setup.waitForVisualIdle();

    // 3) expect: notice shows `已复制` ("copied"); the input box has no paste content (not polluted by stale content)
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/已复制|已写入/);
    // assert: the frame must not contain the pasted `旧剪贴板的内容` text (inputValue does not grow)
    expect(frame).not.toContain("旧剪贴板的内容");

    setup.renderer.destroy();
  });

  test("arm 窗口外的 paste 不受影响：right-up 复制后等 300ms 再 paste，inputValue 增长", async () => {
    const setup = await renderApp();
    const selectedText = "选中的当前文本";
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = fakeSelection(selectedText);

    // 1) right-up triggers copy → arms 250ms
    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();

    // 2) wait past the arm window
    await new Promise((r) => setTimeout(r, 300));
    await setup.waitForVisualIdle();

    // 3) a paste now should enter the input box normally
    await setup.mockInput.pasteBracketedText("用户主动粘贴");
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 30));
    await setup.waitForVisualIdle();

    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/已复制|已写入/);
    // the input box should now contain `用户主动粘贴`
    expect(frame).toContain("用户主动粘贴");

    setup.renderer.destroy();
  });

  test("未触发 right-up 直接 paste：粘贴正常进入输入框", async () => {
    const setup = await renderApp();

    // paste sent directly with no right-up — should enter the input box normally
    await setup.mockInput.pasteBracketedText("纯粘贴文本");
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 30));
    await setup.waitForVisualIdle();

    const frame = setup.captureCharFrame();
    // no `已复制` / `已写入` (copy was not triggered)
    expect(frame).not.toMatch(/已复制|已写入/);
    // the input box should contain `纯粘贴文本`
    expect(frame).toContain("纯粘贴文本");

    setup.renderer.destroy();
  });

  test("Ctrl+C：有选区时复制（打断已迁 Esc，无打断副作用）", async () => {
    const setup = await renderApp();
    const selectedText = "ctrl+c 复制的文本";
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = fakeSelection(selectedText);

    // Emit a left-drag-RELEASE (selection event) first to fill
    // cachedSelectionTextRef. fakeSelection lacks isDragging and other fields,
    // but useSelectionHandler only calls selection.getSelectedText(), so the
    // unit test does not need a real drag — emit("selection", ...) is enough.
    setup.renderer.emit("selection", fakeSelection(selectedText));
    await setup.waitForVisualIdle();

    // Press Ctrl+C: non-empty selection → copy (pure-copy semantics, no interrupt side effect)
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
    // Explicitly null currentSelection + cachedSelectionTextRef (empty by default anyway)
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

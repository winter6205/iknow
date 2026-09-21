/** @jsxImportSource @opentui/react */
/**
 * tests/tui/copy-flow.test.tsx
 *
 * Right-click copy contract regressions: OpenTUI selection plus the native
 * fallback chain:
 *  - `copyToClipboard` unit: empty text / PATH=nonexistent degrades to a file
 *    write / success returns the method used;
 *  - mouse-drag (renderer "selection" event) no longer auto-copies;
 *  - right-button down+up → copies the current selection → notice shows
 *    `已复制（N 字）` ("copied (N chars)") / `已写入…` ("written…") /
 *    `选中区域为空` ("selection is empty");
 *  - CJK double-width: selection text passes through verbatim (OpenTUI's
 *    built-in parser handles it).
 *
 * Async discipline: setup.waitForVisualIdle() is the only async wait entry.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { MouseButtons } from "@opentui/core/testing";
import { TuiHarness } from "./_fixtures.js";
import { copyToClipboard } from "../../src/tui/clipboard.js";

const COLS = 80;
const ROWS = 24;

/** Temp dataDir: for copyToClipboard fallback file-write assertions. */
let tmpDataDir: string;
beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "iknow-copy-"));
});
afterEach(() => {
  try {
    rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("copyToClipboard（原生 fallback 链）", () => {
  test("空文本 → kind:empty（不写文件、不 spawn）", async () => {
    const result = await copyToClipboard("", { dataDir: tmpDataDir });
    expect(result.kind).toBe("empty");
  });

  test("PATH=/nonexistent 时退化写 <dataDir>/last_copy.txt", async () => {
    const text = "fallback 测试文本";
    const result = await copyToClipboard(text, {
      dataDir: tmpDataDir,
      env: { PATH: "/nonexistent" } as NodeJS.ProcessEnv,
    });
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.path).toBe(join(tmpDataDir, "last_copy.txt"));
      expect(result.bytes).toBe(Buffer.byteLength(text, "utf8"));
      const written = readFileSync(result.path, "utf8");
      expect(written).toBe(text);
    }
  });

  test("多字节 UTF-8 文本（CJK）bytes 计 lengthByBytes 不是 char count", async () => {
    const text = "你好世界";
    const result = await copyToClipboard(text, {
      dataDir: tmpDataDir,
      env: { PATH: "/nonexistent" } as NodeJS.ProcessEnv,
    });
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.bytes).toBe(Buffer.byteLength(text, "utf8"));
      expect(result.bytes).toBe(12);
    }
  });
});

/**
 * Fake Selection object (duck-types getSelectedText + touchedRenderables),
 * written directly into renderer.currentSelection to drive the right-click
 * copy handler.
 */
function fakeSelection(text: string): {
  getSelectedText(): string;
  touchedRenderables: unknown[];
} {
  return { getSelectedText: () => text, touchedRenderables: [] };
}

async function renderApp() {
  const setup = await testRender(<TuiHarness />, {
    width: COLS,
    height: ROWS,
    exitOnCtrlC: false,
  });
  await setup.waitForVisualIdle();
  return setup;
}

describe("TuiApp 右键复制（#343 B1）", () => {
  test("拖选（selection 事件）不再自动复制，无 notice", async () => {
    const setup = await renderApp();
    setup.renderer.emit(
      "selection",
      fakeSelection("auto-copy should not happen")
    );
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 50));
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).not.toMatch(/已复制|已写入|选中区域为空|复制失败/);
    await setup.renderer.destroy();
  });

  test("完整右键（down+up）：down 保留选区 → up 复制成功（fallback 写文件）", async () => {
    const setup = await renderApp();
    const text = "full right click";
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = fakeSelection(text);
    // Real right-click sequence: down (selection preserved via onMouseDown
    // preventDefault) + up.
    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 50));
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/已复制|已写入/);
    await setup.renderer.destroy();
  });

  test("右键 up：空选区 →「选中区域为空。」notice", async () => {
    const setup = await renderApp();
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = fakeSelection("");
    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 20));
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("选中区域为空");
    await setup.renderer.destroy();
  });

  test("右键 up：无选区（null）→「无选区：先按住鼠标左键拖选文本。」notice", async () => {
    const setup = await renderApp();
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = null;
    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 20));
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("无选区：先按住鼠标左键拖选文本。");
    await setup.renderer.destroy();
  });

  test("右键 up：CJK 选区文本原样透传", async () => {
    const setup = await renderApp();
    const text = "中文测试 — 你好世界";
    (
      setup.renderer as unknown as { currentSelection: unknown }
    ).currentSelection = fakeSelection(text);
    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();
    await new Promise((r) => setTimeout(r, 50));
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/已复制|已写入/);
    await setup.renderer.destroy();
  });
});

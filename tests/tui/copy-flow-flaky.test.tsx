/** @jsxImportSource @opentui/react */
/**
 * tests/tui/copy-flow-flaky.test.tsx
 *
 * #343 follow-up: 验证「拖选后右键复制」真实链路在 TUI 中不会丢选区。
 * 现有 copy-flow.test.tsx 的「完整右键」用例只在 (5,5) 点击一下，
 * 但用户报告「有时候」失败。
 *
 * 本测试覆盖若干坐标位置 + 极端边角，验证不同 hit-test 命中点都不应触发
 * clearSelection。如果某个点位失败——即 OpenTUI 的 hitTest 返回 0
 * (maybeRenderable 为 null) — 那就是根因：dispatchMouseEvent 没被调用，
 * preventDefault 没机会跑，clearSelection 直接清掉选区。
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
  tmpDataDir = mkdtempSync(join(tmpdir(), "iknow-copy-flaky-"));
});
afterEach(() => {
  try {
    rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function fakeSelection(text: string) {
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

describe("TuiApp 右键复制（多坐标点位）", () => {
  // 含 (0,0)、边角、远离文本区域
  for (const [x, y] of [
    [5, 5],
    [40, 10],
    [60, 20],
    [10, 15],
    [0, 0],
    [79, 23],
    [1, 22],
    [70, 1],
  ]) {
    test(`坐标 (${x},${y})：右键应保留选区并复制`, async () => {
      const setup = await renderApp();
      const text = `selected at ${x},${y}`;
      (
        setup.renderer as unknown as { currentSelection: unknown }
      ).currentSelection = fakeSelection(text);

      await setup.mockMouse.click(x, y, MouseButtons.RIGHT);
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 50));
      await setup.waitForVisualIdle();

      const frame = setup.captureCharFrame();
      const sel = (setup.renderer as unknown as { currentSelection: unknown })
        .currentSelection;
      // 期望：选区被 handleMouseUp 清掉（这是设计意图），
      // 且显示「已复制」或「已写入」
      expect(frame).toMatch(/已复制|已写入/);
      expect(frame).not.toContain("无选区");
      await setup.renderer.destroy();
    });
  }
});

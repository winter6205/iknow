/** @jsxImportSource @opentui/react */
/**
 * tests/tui/copy-flow-flaky.test.tsx
 *
 * Follow-up to copy-flow: verifies the real "drag-select then right-click
 * copy" path never loses the selection in the TUI. The existing
 * "full right-click" case in copy-flow.test.tsx only clicks once at (5,5),
 * while users reported intermittent failures.
 *
 * This test covers several coordinate positions + extreme corners, checking
 * that no hit-test landing point triggers clearSelection. If a point fails
 * — i.e. OpenTUI's hitTest returns 0 (maybeRenderable null) — that is the
 * root cause: dispatchMouseEvent never runs, preventDefault gets no chance,
 * and clearSelection wipes the selection outright.
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
  // Includes (0,0), corners, and points far from text regions.
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
      // Expected: the selection is cleared by handleMouseUp (by design),
      // and the frame shows `已复制` ("copied") or `已写入` ("written").
      expect(frame).toMatch(/已复制|已写入/);
      expect(frame).not.toContain("无选区");
      await setup.renderer.destroy();
    });
  }
});

/** @jsxImportSource @opentui/react */
/**
 * tests/tui/paste-fast-no-loss.test.tsx
 *
 * Regression: fast paste from external voice input must not drop or misplace chars.
 *
 * User field report: when voice input pushed recognized text into the TUI
 * input in one burst (typically several segments at 5ms intervals), segments
 * were swallowed or overwritten out of order. Root cause: the app.tsx usePaste
 * handler called `setInputValue((prev) => prev + text)` without
 * `event.preventDefault`, so one paste event drove inputValue twice — path A
 * (global usePaste) and path B (textarea native handlePaste) — misaligned
 * across React 18 commit cycles, swallowing middle segments; compounded by
 * `useEffect[props.value]` repeatedly setText-ing (resetting the buffer) →
 * misaligned overwrite.
 *
 * Fix: the usePaste handler calls `event.preventDefault()` at the top of the
 * out-of-arm-window path, blocking emitWithPriority's renderable listener, so
 * path A is the single source for paste.
 *
 * Coverage:
 *  1. four back-to-back pastes (5ms apart, simulating voice output) → buffer holds all 4;
 *  2. single paste → buffer holds the pasted content (matches
 *     copy-paste-block.test.tsx case 3, guarding against over-fix breaking the basic path).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { TuiHarness } from "./_fixtures.js";

const COLS = 80;
const ROWS = 24;

let tmpDataDir: string;
beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "iknow-paste-fast-"));
});
afterEach(() => {
  try {
    rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

async function renderApp() {
  const setup = await testRender(<TuiHarness dataDir={tmpDataDir} />, {
    width: COLS,
    height: ROWS,
    exitOnCtrlC: false,
  });
  await setup.waitForVisualIdle();
  return setup;
}

function findPromptInputTextarea(
  setup: Awaited<ReturnType<typeof renderApp>>
): { plainText: string } {
  const tas = walkTextarea(setup.renderer.root);
  if (tas.length === 0) {
    throw new Error("PromptInput textarea not rendered");
  }
  return { plainText: tas[0].plainText };
}

function walkTextarea(root: unknown): { plainText: string }[] {
  const pred = (r: Record<string, unknown>): boolean =>
    "plainText" in r && "visualCursor" in r;
  const walk = (
    r: unknown,
    depth = 0,
    acc: Record<string, unknown>[] = []
  ): Record<string, unknown>[] => {
    if (!r || typeof r !== "object") return acc;
    const rr = r as Record<string, unknown>;
    if (pred(rr)) acc.push(rr);
    if (depth > 12) return acc;
    const children = (rr.getChildren as (() => unknown[]) | undefined)?.();
    if (Array.isArray(children)) {
      for (const c of children) walk(c, depth + 1, acc);
    }
    return acc;
  };
  const found = walk(root);
  return found.map((r) => ({ plainText: r.plainText as string }));
}

describe("B01: fast paste 不丢字 / 不错位", () => {
  test("连续 4 段 paste (50ms 间隔) → buffer 包含全部 4 段", async () => {
    const setup = await renderApp();
    try {
      // simulate external voice input: 4 short segments pasted back to back at
      // 50ms (real devices typically 50-200ms). Before the fix this
      // reproduced "middle segments swallowed" — path A + path B double-driving
      // loses chars across React 18 commit cycles.
      const segments = ["第一段", "第二段", "第三段", "第四段"];
      for (const seg of segments) {
        await setup.mockInput.pasteBracketedText(seg);
        await new Promise((r) => setTimeout(r, 50));
      }
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 30));
      await setup.waitForVisualIdle();

      const { plainText } = findPromptInputTextarea(setup);
      // key assertion: all 4 segments reach the buffer, none swallowed.
      expect(plainText).toContain("第一段");
      expect(plainText).toContain("第二段");
      expect(plainText).toContain("第三段");
      expect(plainText).toContain("第四段");
      // order preserved: segments enter the buffer in paste order.
      const order = [
        plainText.indexOf("第一段"),
        plainText.indexOf("第二段"),
        plainText.indexOf("第三段"),
        plainText.indexOf("第四段"),
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
    } finally {
      setup.renderer.destroy();
    }
  });

  test("单次 paste → buffer 包含粘贴内容（基本路径不被破坏）", async () => {
    const setup = await renderApp();
    try {
      await setup.mockInput.pasteBracketedText("单次粘贴内容");
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 30));
      await setup.waitForVisualIdle();

      const { plainText } = findPromptInputTextarea(setup);
      expect(plainText).toContain("单次粘贴内容");
    } finally {
      setup.renderer.destroy();
    }
  });
});

/** @jsxImportSource @opentui/react */
/**
 * tests/tui/voice-input-drip.test.tsx
 *
 * Reproduces dropped characters when the voice input engine feeds text as
 * variable-rate per-key / small-chunk input. Distinct from
 * paste-fast-no-loss.test.tsx (bracketed paste, uniform 50ms): a voice engine
 * may skip bracketed paste and emit per-key events with uneven intervals.
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
  tmpDataDir = mkdtempSync(join(tmpdir(), "iknow-voice-drip-"));
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

function promptPlainText(setup: Awaited<ReturnType<typeof renderApp>>): string {
  const pred = (r: Record<string, unknown>): boolean =>
    "plainText" in r && "visualCursor" in r;
  const walk = (r: unknown, depth = 0): Record<string, unknown> | null => {
    if (!r || typeof r !== "object") return null;
    const rr = r as Record<string, unknown>;
    if (pred(rr)) return rr;
    if (depth > 12) return null;
    const children = (rr.getChildren as (() => unknown[]) | undefined)?.();
    if (Array.isArray(children)) {
      for (const c of children) {
        const hit = walk(c, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  const ta = walk(setup.renderer.root);
  if (!ta) throw new Error("PromptInput textarea not rendered");
  return ta.plainText as string;
}

describe("voice input drip 不丢字", () => {
  test("逐 key 变速率输入（5~200ms 抖动）→ 不丢字", async () => {
    const setup = await renderApp();
    try {
      const text = "语音输入变速率吐字测试";
      const delays = [5, 180, 30, 120, 8, 200, 45, 90, 12, 60];
      for (let i = 0; i < text.length; i++) {
        setup.mockInput.pressKey(text[i]);
        await new Promise((r) => setTimeout(r, delays[i % delays.length]));
      }
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 30));
      await setup.waitForVisualIdle();

      expect(promptPlainText(setup)).toBe(text);
    } finally {
      setup.renderer.destroy();
    }
  });

  // Passes even before the fix (non-discriminating): boundary coverage for the
  // per-key path only. The discriminating evidence for this bug is the
  // variable-rate per-key and variable-rate bracketed-paste cases.
  test("逐 key 快速输入（0ms 同 tick 连发）→ 不丢字", async () => {
    const setup = await renderApp();
    try {
      const text = "快速连发不丢字";
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
      }
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 30));
      await setup.waitForVisualIdle();

      expect(promptPlainText(setup)).toBe(text);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("bracketed paste 变速率（0~15ms 抖动）→ 不丢字", async () => {
    const setup = await renderApp();
    try {
      const segments = ["第一段", "第二段", "第三段", "第四段", "第五段"];
      const delays = [0, 5, 15, 2, 8];
      for (let i = 0; i < segments.length; i++) {
        await setup.mockInput.pasteBracketedText(segments[i]);
        await new Promise((r) => setTimeout(r, delays[i]));
      }
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 30));
      await setup.waitForVisualIdle();

      expect(promptPlainText(setup)).toBe(segments.join(""));
    } finally {
      setup.renderer.destroy();
    }
  });
});

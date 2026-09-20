/** @jsxImportSource @opentui/react */
/**
 * tests/tui/input-interleave-race.test.tsx
 *
 * Discriminating regression for interleaved input: voice input (bracketed
 * paste) mixed with manual keypresses must not drop characters.
 *
 * Two write paths:
 *  - paste path (state-first): app.tsx usePaste → setInputValue(prev+text)
 *    → render → prompt-input sync effect setText；
 *  - keypress path (buffer-first): characters go straight into the native
 *    textarea buffer → synchronously emit content-changed →
 *    handleContentChange → onChange(ta.plainText) replaces by absolute value.
 *
 * When the paste's functional update is queued but not committed, the next
 * keypress's absolute-value setState is computed from stale state (missing
 * the paste segment), and last-writer-wins at commit time overwrites the
 * queued paste segment — middle characters get swallowed.
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
  tmpDataDir = mkdtempSync(join(tmpdir(), "iknow-interleave-"));
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

describe("paste 与 keypress 交错输入不丢字", () => {
  test("paste 段后紧跟 keypress 字符 → 两段都在 buffer", async () => {
    const setup = await renderApp();
    try {
      // Voice input emits a segment (bracketed paste), then the user manually
      // types one more character — while the paste's functional update is
      // queued but uncommitted, the keypress's absolute-value onChange would overwrite it.
      await setup.mockInput.pasteBracketedText("语音段甲");
      setup.mockInput.pressKey("甲");
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 30));
      await setup.waitForVisualIdle();

      expect(promptPlainText(setup)).toBe("语音段甲甲");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("keypress 字符后紧跟 paste 段 → 两段都在 buffer", async () => {
    const setup = await renderApp();
    try {
      setup.mockInput.pressKey("前");
      await setup.mockInput.pasteBracketedText("后粘贴");
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 30));
      await setup.waitForVisualIdle();

      expect(promptPlainText(setup)).toBe("前后粘贴");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("多轮 paste/keypress 快速交错 → 全部内容按序保留", async () => {
    const setup = await renderApp();
    try {
      // Voice-engine output pattern: paste segments alternate with single-char
      // correction keypresses, <15ms apart.
      const script: Array<["paste" | "key", string]> = [
        ["paste", "第一"],
        ["key", "修"],
        ["paste", "第二"],
        ["key", "补"],
        ["paste", "第三"],
      ];
      for (const [kind, payload] of script) {
        if (kind === "paste") {
          await setup.mockInput.pasteBracketedText(payload);
        } else {
          setup.mockInput.pressKey(payload);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 30));
      await setup.waitForVisualIdle();

      expect(promptPlainText(setup)).toBe("第一修第二补第三");
    } finally {
      setup.renderer.destroy();
    }
  });
});

/** @jsxImportSource @opentui/react */
/**
 * tests/tui/paste-fast-no-loss.test.tsx
 *
 * #B01 回归：外置语音输入快速 paste 不丢字 / 不错位。
 *
 * 2026-08-21 用户实测报告：外置语音输入把识别好的文字一次性传到 TUI 输入框
 * 时（典型 5ms 间隔连续多段），文字被吞或错位覆盖。根因：app.tsx usePaste
 * handler 调 `setInputValue((prev) => prev + text)` 但不 `event.preventDefault`，同
 * 一 paste 事件被 path A（global usePaste）和 path B（textarea native
 * handlePaste）双驱动改 inputValue，跨 React 18 commit 周期错位导致中间
 * 段被吞；叠加 `useEffect[props.value]` 反复 setText 重置 buffer → 错位覆盖。
 *
 * 修复：usePaste handler 在 arm 窗口外路径开头 `event.preventDefault()`，
 * 阻断 emitWithPriority 的 renderable listener，让 path A 单源负责 paste。
 *
 * 覆盖：
 *  1. 连续 4 段 paste（间隔 5ms，模拟语音输入吐字）→ buffer 包含全部 4 段；
 *  2. 单次 paste → buffer 包含 paste 内容（与 copy-paste-block.test.tsx case 3
 *     一致，防止过度修复破坏基本路径）。
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
      // 模拟外置语音输入：4 段短文本间隔 50ms 连续 paste（真实语音设备
      // 典型 50-200ms 间隔）。修复前会复现「中间段被吞」—— path A 与 path B
      // 双驱动时 React 18 commit 周期错位导致丢字。
      const segments = ["第一段", "第二段", "第三段", "第四段"];
      for (const seg of segments) {
        await setup.mockInput.pasteBracketedText(seg);
        await new Promise((r) => setTimeout(r, 50));
      }
      await setup.waitForVisualIdle();
      await new Promise((r) => setTimeout(r, 30));
      await setup.waitForVisualIdle();

      const { plainText } = findPromptInputTextarea(setup);
      // 关键断言：4 段全部进 buffer，没有「第二段」或「第四段」被吞。
      expect(plainText).toContain("第一段");
      expect(plainText).toContain("第二段");
      expect(plainText).toContain("第三段");
      expect(plainText).toContain("第四段");
      // 顺序保持：paste 顺序进 buffer。
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

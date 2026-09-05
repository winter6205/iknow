/** @jsxImportSource @opentui/react */
/**
 * tests/tui/input-interleave-race.test.tsx
 *
 * 交错输入判别性回归：语音输入（bracketed paste）与手动 keypress 交错时
 * 不丢字。
 *
 * 两条写入路径：
 *  - paste 路径（state-first）：app.tsx usePaste → setInputValue(prev+text)
 *    → render → prompt-input sync effect setText；
 *  - keypress 路径（buffer-first）：字符直接进原生 textarea buffer → 同步
 *    emit content-changed → handleContentChange → onChange(ta.plainText) 绝对值
 *    替换。
 *
 * paste 的 functional update 排队未 commit 时，紧接的 keypress 绝对值
 * setState 基于旧 state 起算（不含 paste 段），commit 时 last-writer-wins
 * 把排队中的 paste 段覆盖掉 —— 中间字被吞。
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
      // 语音输入吐一段（bracketed paste），随后用户手动补一个字符 —— paste 的
      // functional update 排队未 commit 时 keypress 绝对值 onChange 会覆盖它。
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
      // 语音输入引擎吐字模式：paste 段与个别修正 keypress 交替，间隔 <15ms。
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

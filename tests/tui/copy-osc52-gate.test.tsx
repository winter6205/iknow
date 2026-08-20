/** @jsxImportSource @opentui/react */
/**
 * tests/tui/copy-osc52-gate.test.tsx
 *
 * #343 follow-up: 当 OpenTUI 检测到 OSC52 不被终端支持时，不应盲信
 * `copyToClipboardOSC52` 返回 true；否则会显示「已复制」但剪贴板为空。
 *
 * 用户报告：「有时候点右键不复制」—— 候选根因：终端禁用 OSC52（安全策略）
 * 但 OpenTUI 返回 true，doCopy 直接返回 kind:ok、method:pbcopy，跳过原生
 * fallback 链（pbcopy/wl-copy/xclip/xsel/last_copy.txt）。
 *
 * 修复：在调用 OSC52 之前先问 renderer.isOsc52Supported()；false 则直接走
 * 完整 fallback。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { MouseButtons } from "@opentui/core/testing";
import { TuiHarness } from "./_fixtures.js";

const COLS = 80;
const ROWS = 24;

let tmpDataDir: string;
beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "iknow-osc52-"));
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

describe("OSC52 终端支持门控", () => {
  test("isOsc52Supported=false 时，OSC52 假装成功也应走 fallback 链", async () => {
    const setup = await testRender(<TuiHarness dataDir={tmpDataDir} />, {
      width: COLS,
      height: ROWS,
      exitOnCtrlC: false,
    });
    await setup.waitForVisualIdle();

    const r = setup.renderer as unknown as {
      currentSelection: unknown;
      isOsc52Supported(): boolean;
      copyToClipboardOSC52(text: string): boolean;
    };
    r.currentSelection = fakeSelection("OSC52 fake success but unsupported");

    // 假设：终端不支持 OSC52，但 copyToClipboardOSC52 仍返回 true
    // （zig 端只管写字节，不管终端真收到没）。
    const realSupported = r.isOsc52Supported();
    const realCopy = r.copyToClipboardOSC52;
    let osc52Calls = 0;
    (r as unknown as { isOsc52Supported: () => boolean }).isOsc52Supported =
      () => false;
    (
      r as unknown as { copyToClipboardOSC52: (t: string) => boolean }
    ).copyToClipboardOSC52 = (text: string) => {
      osc52Calls += 1;
      // 模拟 OSC52 字节写成功但终端忽略
      return realCopy.call(setup.renderer, text);
    };

    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();
    await new Promise((res) => setTimeout(res, 50));
    await setup.waitForVisualIdle();

    const frame = setup.captureCharFrame();

    // 期望：不应把"OSC52=true"当真；应走到 fallback 链。
    // 在 test 环境 PATH 无 binary，最后会落到 last_copy.txt 写文件。
    expect(osc52Calls).toBe(0); // ← 关键：isOsc52Supported=false 时不应调 OSC52
    expect(frame).toMatch(/已复制|已写入/);

    const fallbackPath = join(tmpDataDir, "last_copy.txt");
    if (frame.includes("已写入")) {
      // 写文件 fallback 命中
      expect(existsSync(fallbackPath)).toBe(true);
      expect(readFileSync(fallbackPath, "utf8")).toBe(
        "OSC52 fake success but unsupported"
      );
    }

    // 还原
    (r as unknown as { isOsc52Supported: () => boolean }).isOsc52Supported =
      () => realSupported;
    (
      r as unknown as { copyToClipboardOSC52: (t: string) => boolean }
    ).copyToClipboardOSC52 = realCopy;

    await setup.renderer.destroy();
  });
});

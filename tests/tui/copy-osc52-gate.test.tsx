/** @jsxImportSource @opentui/react */
/**
 * tests/tui/copy-osc52-gate.test.tsx
 *
 * When OpenTUI detects that the terminal does not support OSC52, we must not
 * blindly trust a `true` return from `copyToClipboardOSC52` — otherwise the UI
 * shows `已复制` ("copied") while the clipboard stays empty.
 *
 * User report: "sometimes right-click does not copy". Candidate root cause:
 * the terminal disables OSC52 (security policy) yet OpenTUI still returns
 * true, so doCopy returns kind:ok / method:pbcopy and skips the native
 * fallback chain (pbcopy/wl-copy/xclip/xsel/last_copy.txt).
 *
 * Fix: ask renderer.isOsc52Supported() before calling OSC52; if false, go
 * straight to the full fallback.
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

    // Premise: the terminal does not support OSC52, yet copyToClipboardOSC52
    // still returns true (the zig side only writes bytes, it cannot know
    // whether the terminal actually received them).
    const realSupported = r.isOsc52Supported();
    const realCopy = r.copyToClipboardOSC52;
    let osc52Calls = 0;
    (r as unknown as { isOsc52Supported: () => boolean }).isOsc52Supported =
      () => false;
    (
      r as unknown as { copyToClipboardOSC52: (t: string) => boolean }
    ).copyToClipboardOSC52 = (text: string) => {
      osc52Calls += 1;
      // Simulate OSC52 bytes written successfully but ignored by the terminal
      return realCopy.call(setup.renderer, text);
    };

    await setup.mockMouse.click(5, 5, MouseButtons.RIGHT);
    await setup.waitForVisualIdle();
    await new Promise((res) => setTimeout(res, 50));
    await setup.waitForVisualIdle();

    const frame = setup.captureCharFrame();

    // Expectation: "OSC52=true" must not be taken at face value; the fallback
    // chain must run. In the test env PATH has no clipboard binary, so it
    // ends at the last_copy.txt file write.
    expect(osc52Calls).toBe(0); // ← key: OSC52 must not be called when isOsc52Supported=false
    expect(frame).toMatch(/已复制|已写入/);

    const fallbackPath = join(tmpDataDir, "last_copy.txt");
    if (frame.includes("已写入")) {
      // file-write fallback hit
      expect(existsSync(fallbackPath)).toBe(true);
      expect(readFileSync(fallbackPath, "utf8")).toBe(
        "OSC52 fake success but unsupported"
      );
    }

    // restore
    (r as unknown as { isOsc52Supported: () => boolean }).isOsc52Supported =
      () => realSupported;
    (
      r as unknown as { copyToClipboardOSC52: (t: string) => boolean }
    ).copyToClipboardOSC52 = realCopy;

    await setup.renderer.destroy();
  });
});

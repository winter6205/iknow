/** @jsxImportSource @opentui/react */
/**
 * tests/tui/composer-ctrl-c.test.tsx
 *
 * Ctrl+C priority chain in the composer (src/tui/app.tsx handleCtrlCCopy):
 *   1. live composer selection → copied, draft kept;
 *   2. renderer (transcript) selection cache → copied, draft kept;
 *   3. no selection + non-empty draft → the whole draft goes (buffer text AND
 *      the folded attachment payloads) and the notice arm does not run;
 *   4. empty draft → the existing copy-usage notice.
 *
 * Rung 1 vs rung 2 is decided by *which text* lands in the clipboard: the two
 * selections carry different lengths, and the copy notice quotes the length
 * (`已复制（method，N 字）` / `文本已写入 …（N bytes）` depending on host
 * clipboard availability), so the assertion holds on either branch.
 *
 * "Attachments really gone" is proven through the draft contract, not through
 * internals: after the clear, re-inserting the very same `[paste#1 …]` label
 * text stays inert text (Ctrl+G does not unfold it) because the payload table
 * was forgotten — a label the table does not know is ordinary text.
 *
 * One extra case pins *which* value rung 3 reads: the synchronous composer
 * mirror rather than the render-lagged state (see the `gate:` test below).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import {
  emptyClipboardImageReader,
  findComposerTextArea,
} from "./_fixtures.js";

/** Renderer "selection" event payload duck-type (same shape as copy-flow). */
function fakeSelection(text: string): {
  getSelectedText(): string;
  touchedRenderables: unknown[];
} {
  return { getSelectedText: () => text, touchedRenderables: [] };
}

const LABEL = "[paste#1 · 4 lines · 7 chars]";
// Distinctly longer than the 2-char composer selection, so a copied length of
// 2 can only have come from the editor arm.
const TRANSCRIPT = "TRANSCRIPT-SELECTION-0123456789abcdef";

interface TaSnapshot {
  text: string;
  textLen: number;
}

/** The composer's live buffer plus its selection, read off the render tree. */
function composer(setup: TestRendererSetup): {
  text: string;
  textLen: number;
  selected: string;
} {
  const ta = findComposerTextArea(setup);
  if (!ta) throw new Error("composer textarea is not mounted");
  return {
    text: ta.plainText,
    textLen: ta.plainText.length,
    selected: ta.hasSelection() ? ta.getSelectedText() : "",
  };
}

async function settle(setup: TestRendererSetup, ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await setup.renderOnce();
}

/**
 * One-shot tap on the composer textarea's own content-change callback: run
 * `after` in the same task as the composer's `onChange` report, before React
 * flushes the state that report queued. The wired handler is restored on the
 * first fire, so later edits (including the clear this test asserts on) are
 * reported normally.
 */
function tapComposerReport(setup: TestRendererSetup, after: () => void): void {
  const ta = findComposerTextArea(setup);
  if (!ta) throw new Error("composer textarea is not mounted");
  const original = ta.onContentChange;
  let fired = false;
  ta.onContentChange = (event: unknown) => {
    original?.(event);
    if (fired) return;
    fired = true;
    ta.onContentChange = original;
    after();
  };
}

async function waitUntil(
  setup: TestRendererSetup,
  pred: (snap: TaSnapshot) => boolean,
  label: string,
  timeoutMs = 2000
): Promise<TaSnapshot> {
  const start = Date.now();
  let last: TaSnapshot = { text: "", textLen: -1 };
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
    await setup.renderOnce();
    const c = composer(setup);
    last = { text: c.text, textLen: c.textLen };
    if (pred(last)) return last;
  }
  throw new Error(`waitUntil timeout (${label}): ${JSON.stringify(last)}`);
}

async function mount(): Promise<{
  setup: TestRendererSetup;
  destroy: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-ctrlc-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: [] })]),
    inflight: createInflightRegistry(),
  });
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      // A single-line paste asks the clipboard whether its text was an image
      // copy's flavor. Answer "no bitmap": the paste keeps its own text (it is
      // inserted before the probe ever answers) and nothing here reaches the
      // real host reader.
      clipboardImageReader={emptyClipboardImageReader}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    {
      width: 80,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 300));
  await setup.waitForVisualIdle();
  return {
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
  };
}

/** Plant a transcript-selection cache the way the renderer event does. */
function plantTranscriptSelection(setup: TestRendererSetup, text: string) {
  (
    setup.renderer as unknown as { currentSelection: unknown }
  ).currentSelection = fakeSelection(text);
  setup.renderer.emit("selection", fakeSelection(text));
}

/** The copy notice quotes the copied length in 字 or bytes (host-dependent). */
function frameShowsCopiedLength(frame: string, n: number): boolean {
  return new RegExp(`，${n} 字）|（${n} bytes）`).test(frame);
}

describe("Ctrl+C 优先级链（composer 选区 → 渲染选区 → 整份草稿 → 空草稿提示）", () => {
  test("rung 1: 编辑器选区单独存在 → 复制选区，草稿不清空", async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("hello", 0);
      await settle(app.setup);
      expect(composer(app.setup).textLen).toBe(5);

      app.setup.mockInput.pressArrow("left", { shift: true });
      app.setup.mockInput.pressArrow("left", { shift: true });
      await settle(app.setup);
      expect(composer(app.setup).selected).toBe("lo");

      app.setup.mockInput.pressKey("c", { ctrl: true });
      await settle(app.setup);
      const frame = app.setup.captureCharFrame();
      expect(frameShowsCopiedLength(frame, 2)).toBe(true);
      // Copy never touches the draft.
      expect(composer(app.setup).text).toBe("hello");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("rung 2: 仅渲染层选区 → 复制它，草稿不清空", async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("keep me", 0);
      await settle(app.setup);
      plantTranscriptSelection(app.setup, TRANSCRIPT);
      await settle(app.setup);
      expect(composer(app.setup).selected).toBe("");

      app.setup.mockInput.pressKey("c", { ctrl: true });
      await settle(app.setup);
      const frame = app.setup.captureCharFrame();
      expect(frameShowsCopiedLength(frame, TRANSCRIPT.length)).toBe(true);
      expect(composer(app.setup).text).toBe("keep me");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("rung 3: 两种选区同时存在 → 编辑器选区优先", async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("hello", 0);
      await settle(app.setup);
      app.setup.mockInput.pressArrow("left", { shift: true });
      app.setup.mockInput.pressArrow("left", { shift: true });
      await settle(app.setup);
      expect(composer(app.setup).selected).toBe("lo");

      // Stale-cache hazard the ordering exists for: the transcript selection
      // outlives the focus change, so it must lose even when planted last.
      plantTranscriptSelection(app.setup, TRANSCRIPT);
      await settle(app.setup);

      app.setup.mockInput.pressKey("c", { ctrl: true });
      await settle(app.setup);
      const frame = app.setup.captureCharFrame();
      expect(frameShowsCopiedLength(frame, 2)).toBe(true);
      expect(frameShowsCopiedLength(frame, TRANSCRIPT.length)).toBe(false);
      expect(composer(app.setup).text).toBe("hello");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("rung 4: 无选区 + 非空草稿 → 文本与折叠附件一起清空，不再走提示", async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("ab", 0);
      await settle(app.setup);
      await app.setup.mockInput.pasteBracketedText("历\n史\n回\n退");
      const folded = await waitUntil(
        app.setup,
        (s) => s.textLen === 2 + LABEL.length,
        "多行 paste 折叠为摘要"
      );
      expect(folded.text).toBe(`ab${LABEL}`);

      app.setup.mockInput.pressKey("c", { ctrl: true });
      const cleared = await waitUntil(
        app.setup,
        (s) => s.textLen === 0,
        "Ctrl+C 清空整份草稿"
      );
      expect(cleared.text).toBe("");
      // The clear arm consumed the key: no copy-usage notice was shown.
      expect(app.setup.captureCharFrame()).not.toContain("无选区");

      // Attachment authority is gone with it: the same label text is now just
      // text — Ctrl+G cannot unfold a payload the draft no longer holds.
      await app.setup.mockInput.pasteBracketedText(LABEL);
      const retyped = await waitUntil(
        app.setup,
        (s) => s.textLen === LABEL.length,
        "重新键入同名摘要标签"
      );
      expect(retyped.text).toBe(LABEL);
      app.setup.mockInput.pressKey("g", { ctrl: true });
      await settle(app.setup);
      expect(composer(app.setup).text).toBe(LABEL);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  /**
   * Gate source: rung 3 reads the synchronous composer mirror
   * (`composerValueRef`, src/tui/app.tsx), not the render-lagged `inputValue`.
   *
   * The window is real but NOT reachable by two plain `pressKey` calls in one
   * task: the keystroke's buffer write is synchronous while its content report
   * — which is what fills BOTH the mirror and the state — is drained one frame
   * later, so a back-to-back `a` + Ctrl+C sees an empty mirror too. What the app
   * can genuinely see is the reported text already in the mirror while the
   * render that owns the Ctrl+C closure still holds the previous empty value
   * (the same staleness the restore gate at app.tsx uses the mirror for). The
   * tap presses Ctrl+C from inside the composer's own content-change callback,
   * after `onChange` has run and before React has flushed.
   */
  test("gate: 草稿已上报而渲染未落地 → Ctrl+C 读镜像清空，不误报无选区", async () => {
    const app = await mount();
    try {
      tapComposerReport(app.setup, () => {
        app.setup.mockInput.pressKey("c", { ctrl: true });
      });
      app.setup.mockInput.pressKey("a");
      await settle(app.setup);
      expect(composer(app.setup).textLen).toBe(0);
      expect(app.setup.captureCharFrame()).not.toContain("无选区");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("rung 5: 空草稿 + 无选区 → 保持既有的复制用法提示", async () => {
    const app = await mount();
    try {
      app.setup.mockInput.pressKey("c", { ctrl: true });
      await settle(app.setup);
      expect(app.setup.captureCharFrame()).toContain(
        "无选区：先按住鼠标左键拖选文本"
      );
      expect(composer(app.setup).textLen).toBe(0);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("boundary: 只有空白的草稿 → 按空草稿处理，保留原提示", async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("   ", 0);
      await settle(app.setup);
      expect(composer(app.setup).textLen).toBe(3);

      app.setup.mockInput.pressKey("c", { ctrl: true });
      await settle(app.setup);
      expect(app.setup.captureCharFrame()).toContain(
        "无选区：先按住鼠标左键拖选文本"
      );
      // Whitespace-only is "empty" by the same rule submit/history apply to it.
      expect(composer(app.setup).textLen).toBe(3);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("repeat: 连按 Ctrl+C → 第二次落到空草稿提示，不重复清空", async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("draft", 0);
      await settle(app.setup);
      app.setup.mockInput.pressKey("c", { ctrl: true });
      await waitUntil(app.setup, (sn) => sn.textLen === 0, "第一次清空");
      app.setup.mockInput.pressKey("c", { ctrl: true });
      await settle(app.setup);
      expect(app.setup.captureCharFrame()).toContain(
        "无选区：先按住鼠标左键拖选文本"
      );
      expect(composer(app.setup).textLen).toBe(0);
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

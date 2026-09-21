/** @jsxImportSource @opentui/react */
/**
 * tests/tui/keyboard.test.tsx
 *
 * Keyboard / paste wiring regression tests, covering the OpenTUI
 * `useKeyboard` + `usePaste` protocols:
 *  - plain keys (press key "a") flow through the input state machine;
 *    early phases did not consume them — assert only no-crash + stable frame;
 *  - modifier combos: ctrl+c is routed inside the useKeyboard handler to its
 *    own handler (Ctrl+C → notice);
 *  - bracketed paste: mockInput.pasteBracketedText(text) → usePaste fires →
 *    controlled inputValue updates → the input box shows the text (no longer
 *    the `输入消息…` "type a message…" placeholder).
 *  - Kitty protocol: testRender defaults to kittyKeyboard: true, enabling the
 *    Kitty parsing path (built into OpenTUI); protocol bytes are not tested.
 *
 * Async discipline: setup.waitForVisualIdle() is the only async wait entry point.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import {
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { captureStderr } from "../_helpers/capture-stderr.ts";
import { TuiHarness } from "./_fixtures.js";

const COLS = 80;
const ROWS = 30;

async function renderApp() {
  const setup = await testRender(<TuiHarness />, {
    width: COLS,
    height: ROWS,
    exitOnCtrlC: false,
    consoleMode: "disabled",
  });
  await setup.waitForVisualIdle();
  return setup;
}

async function renderAppWithInitialSession(
  initialSession: TuiSessionState
): Promise<Awaited<ReturnType<typeof testRender>>> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-kbd-initial-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: [] })]),
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: Awaited<ReturnType<typeof testRender>> | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={permissionMode}
      sessionGrants={sessionGrants}
      initialSession={initialSession}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    {
      width: COLS,
      height: ROWS,
      exitOnCtrlC: false,
      consoleMode: "disabled",
    }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  return setup;
}

/**
 * Key-event landing + render stabilization: mockInput bytes parse
 * asynchronously through stdin, and OpenTUI may dispatch multiple events in
 * one render batch for rapid keypresses — wait visualIdle first, add a small
 * delay for state updates to land, then wait idle again to converge. The
 * unified wait entry for keyboard-style tests (avoids scattering copies).
 */
async function settle(
  setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> {
  await setup.waitForVisualIdle();
  await new Promise((r) => setTimeout(r, 20));
  await setup.waitForVisualIdle();
}

/**
 * Conditional frame polling (while a picker panel is open its animation keeps
 * running, so waitForVisualIdle never goes idle — poll with renderOnce +
 * captureCharFrame, same shape as thinking-picker.test.tsx's untilFrame).
 * Returns the frame once the predicate matches.
 */
async function waitFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  pred: (frame: string) => boolean,
  ms = 8000,
  label = ""
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`waitFrame timeout (${label}):\n${setup.captureCharFrame()}`);
}

/** Multiline-input wiring: full mount (TuiApp + bridge + stub deps, single-round reply).
 *  Optional width: narrow-terminal scenario (narrower than COLS, but must be ≥ the app-layer cols floor of 40). */
async function renderMultilineApp(opts: { readonly width?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-multiline-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: ["多行回复"] })]),
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: Awaited<ReturnType<typeof testRender>> | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={permissionMode}
      sessionGrants={sessionGrants}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    {
      width: opts.width ?? COLS,
      height: ROWS,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      // Shift+Enter must carry the shift modifier — via the kitty protocol
      // (encodeKittySequence encodes [13;2u = shift+return); the shift
      // modifier is lost in legacy mode.
      kittyKeyboard: true,
    }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return { setup, bridge };
}

/** Multiline typeText: skips the "/" pre-warm (which would trigger slash candidates), types char by char directly. */
async function typeMultilineText(
  setup: Awaited<ReturnType<typeof testRender>>,
  text: string
): Promise<void> {
  for (const ch of text) {
    setup.mockInput.pressKey(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
}

/** Full mount + one turn containing a thinking block: for Ctrl+O toggle visibility assertions. */
async function renderAppWithThinking() {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-kbd-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([
      assistantResult({
        texts: ["正式回答"],
        thinkingBlocks: [{ type: "thinking", thinking: "链上推理" }],
      }),
    ]),
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: Awaited<ReturnType<typeof testRender>> | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={permissionMode}
      sessionGrants={sessionGrants}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  // Submit one message through a full turn (including the thinking block).
  setup.mockInput.pressKey("/");
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
  for (let i = 0; i < 5; i++) {
    setup.mockInput.pressBackspace();
    await new Promise((r) => setTimeout(r, 30));
  }
  for (const ch of "请推理") {
    setup.mockInput.pressKey(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  // Wait for the turn to persist → message render includes the thinking fold line.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    if (bridge.inflight.ids().size === 0) break;
  }
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return { setup };
}

test("首帧渲染：占位「输入消息…」可见，notice 区域为空", async () => {
  const setup = await renderApp();
  const frame = setup.captureCharFrame();
  // Input box (PromptInput) border visible + placeholder present (now a Chinese placeholder).
  expect(frame).toContain("╭");
  expect(frame).toContain("输入消息");
  await setup.renderer.destroy();
});

test("普通键（pressKey 'a'）：T6 PromptInput 消费，渲染仍稳定不崩", async () => {
  const setup = await renderApp();
  // PromptInput character insertion: a enters inputValue → the input box shows it.
  setup.mockInput.pressKey("a");
  await settle(setup);
  expect(() => setup.captureCharFrame()).not.toThrow();
  // The "a" character is visible in the input box (replacing the placeholder; border/padding put visual space between "❯" and "a").
  const frame = setup.captureCharFrame();
  expect(frame).toMatch(/❯.*a/);
  await setup.renderer.destroy();
});

test("修饰键 ctrl+c：useKeyboard handler 分流到复制分支（无选区 → 复制提示，stderr 零输出）", async () => {
  // Zero stderr output is the core regression guard: disposition logs used to be raw
  // process.stderr.write, drawing raw bytes into the alternate-screen input box area
  // and looking like "prompt injection into the input box".
  const stderr = captureStderr();
  const setup = await renderApp();
  try {
    setup.mockInput.pressCtrlC();
    await settle(setup);
    const frame = setup.captureCharFrame();
    // No selection → copy hint `无选区：先按住鼠标左键拖选文本，再按 Ctrl+C 复制。` ("no selection: drag-select with the left mouse button first, then Ctrl+C to copy")
    // ("no selection: drag-select text with the left mouse button first, then Ctrl+C to copy")
    expect(frame).toContain("无选区");
    // Idle copy = no side effects: nothing written to stderr (incl. OpenTUI's diagnostic stream).
    expect(stderr.lines.join("")).toBe("");
  } finally {
    await setup.renderer.destroy();
    stderr.restore();
  }
});

test("Esc：canInterrupt 为真但 controller 缺席时静默无副作用", async () => {
  // Invariant: running-fg but the aborter was already removed (turn-finally wrap-up
  // race) → no crash, no friendly fire, no output. Observation surface = frame +
  // stderr (the controller_missing disposition log was deleted).
  const stderr = captureStderr();
  const initialSession = Object.freeze({
    ...createDraftSession(),
    runState: "running-fg" as const,
  });
  const setup = await renderAppWithInitialSession(initialSession);
  try {
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(() => setup.captureCharFrame()).not.toThrow();
    expect(stderr.lines.join("")).toBe("");
  } finally {
    await setup.renderer.destroy();
    stderr.restore();
  }
});

test("其他修饰键（shift+tab、meta+c）：不触发复制/打断分支，无 notice", async () => {
  const setup = await renderApp();
  // shift+tab: keys outside the input state machine are swallowed and produce no notice.
  setup.mockInput.pressTab({ shift: true });
  await settle(setup);
  const frame = setup.captureCharFrame();
  // Neither the copy hint nor an interrupt notice should appear
  expect(frame).not.toContain("无选区");
  await setup.renderer.destroy();
});

test("bracketed paste：pasteBracketedText → 输入框显示粘贴文本", async () => {
  const setup = await renderApp();
  const text = "粘贴的文本";
  await setup.mockInput.pasteBracketedText(text);
  await settle(setup);
  const frame = setup.captureCharFrame();
  // The pasted text should appear in the input box (replacing the input-message placeholder).
  expect(frame).toContain(text);
  await setup.renderer.destroy();
});

test("bracketed paste CJK：UTF-8 多字节文本正确解码（不破编码）", async () => {
  const setup = await renderApp();
  const cjk = "粘贴中文 — 你好世界";
  await setup.mockInput.pasteBracketedText(cjk);
  await settle(setup);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("粘贴中文");
  expect(frame).toContain("你好世界");
  await setup.renderer.destroy();
});

test("pressEnter：T6 PromptInput 提交空输入 no-op，渲染稳定不崩", async () => {
  const setup = await renderApp();
  setup.mockInput.pressEnter();
  await setup.waitForVisualIdle();
  expect(() => setup.captureCharFrame()).not.toThrow();
  await setup.renderer.destroy();
});

test("pressEscape：T5 不消费，渲染稳定不崩（modal 关闭归 T6）", async () => {
  const setup = await renderApp();
  setup.mockInput.pressEscape();
  await setup.waitForVisualIdle();
  expect(() => setup.captureCharFrame()).not.toThrow();
  await setup.renderer.destroy();
});

test("pressArrow(方向键)：不崩不消费", async () => {
  const setup = await renderApp();
  setup.mockInput.pressArrow("up");
  await setup.waitForVisualIdle();
  setup.mockInput.pressArrow("down");
  await setup.waitForVisualIdle();
  setup.mockInput.pressArrow("left");
  await setup.waitForVisualIdle();
  setup.mockInput.pressArrow("right");
  await setup.waitForVisualIdle();
  expect(() => setup.captureCharFrame()).not.toThrow();
  await setup.renderer.destroy();
});

test("pressBackspace：T6 PromptInput 消费，输入框删除最后一个字符", async () => {
  const setup = await renderApp();
  // Paste text first, then backspace: PromptInput handles backspace, deleting one character.
  await setup.mockInput.pasteBracketedText("to-keep");
  await settle(setup);
  setup.mockInput.pressBackspace();
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // The last character "p" is deleted, leaving "to-kee"
  expect(frame).toContain("to-kee");
  await setup.renderer.destroy();
});

test("Ctrl+O：toggle 思考面板（折叠→展开→折叠）", async () => {
  // Needs an assistant reply with a thinking block: collapsed state hides the full
  // thinking text, expanded state shows it. Use the full mount (TuiApp + bridge) for
  // one turn, then Ctrl+O twice to assert visibility flips.
  const { setup } = await renderAppWithThinking();
  // Collapsed: full thinking text not visible; without seconds, the thinking-fold marker is not drawn.
  let frame = setup.captureCharFrame();
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame).not.toContain("链上推理");
  // First Ctrl+O → expand (toggleThinking false → true): full thinking text visible.
  setup.mockInput.pressKey("o", { ctrl: true });
  await settle(setup);
  frame = setup.captureCharFrame();
  expect(frame).toContain("链上推理");
  // Second Ctrl+O → collapse (true → false): full thinking text hidden again.
  setup.mockInput.pressKey("o", { ctrl: true });
  await settle(setup);
  frame = setup.captureCharFrame();
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame).not.toContain("链上推理");
  await setup.renderer.destroy();
});

/** /effort-only wiring: TuiApp mount with pre-warm typing. */
async function renderEffortApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-effort-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: [] })]),
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: Awaited<ReturnType<typeof testRender>> | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={permissionMode}
      sessionGrants={sessionGrants}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  return setup;
}

/** Pre-warm typing (matching app.test.tsx / renderAppWithThinking: press a
 *  harmless key first to start the mockInput parser, Backspace it away, then
 *  type for real — avoids the first character being swallowed). */
async function typeEffortText(
  setup: Awaited<ReturnType<typeof testRender>>,
  text: string
): Promise<void> {
  setup.mockInput.pressKey("/");
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
  for (let i = 0; i < 5; i++) {
    setup.mockInput.pressBackspace();
    await new Promise((r) => setTimeout(r, 30));
  }
  for (const ch of text) {
    setup.mockInput.pressKey(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
}

describe("/effort 思考强度调整", () => {
  test("/effort high → 打开档位面板并直接固定 high；Enter 不关闭；Esc 保存退出", async () => {
    const setup = await renderEffortApp();
    await typeEffortText(setup, "/effort high");
    setup.mockInput.pressEnter();
    // Once the panel is open its animation persists → poll with waitFrame (waitForVisualIdle never goes idle).
    const frame = await waitFrame(
      setup,
      (f) => f.includes("思考强度"),
      8000,
      "panel-open"
    );
    // /effort high → level panel opens (seed focus=fixed=high → ▸ high ◂).
    expect(frame).toContain("▸ high ◂");
    // No more "思考档位设为 …（已启用）" ("thinking level set to … (enabled)") notice.
    expect(frame).not.toContain("思考档位");

    // Enter: commits the level (focus already fixed to high); the panel stays open (core new assertion).
    setup.mockInput.pressEnter();
    const afterEnter = await waitFrame(
      setup,
      (f) => f.includes("思考强度"),
      8000,
      "after-enter"
    );
    expect(afterEnter).toContain("思考强度");

    // Esc: save and exit (writes thinkingEffort=high + implicit enabled), panel closes.
    setup.mockInput.pressEscape();
    await waitFrame(setup, (f) => !f.includes("思考强度"), 8000, "saved-exit");
    await setup.renderer.destroy();
  });

  test("/effort auto → notice 含可用档位列表 + 状态不变", async () => {
    const setup = await renderEffortApp();
    await typeEffortText(setup, "/effort auto");
    setup.mockInput.pressEnter();
    await settle(setup);
    const frame = setup.captureCharFrame();
    // Invalid level → lists available levels (low medium high xhigh max) + usage.
    expect(frame).toContain("low");
    expect(frame).toContain("high");
    expect(frame).toContain("xhigh");
    expect(frame).toContain("max");
    expect(frame).toContain("/effort <level>");
    await setup.renderer.destroy();
  });

  test("/effort 无参（当前 auto）→ 打开档位面板呈自适应态（不提示可用档位）", async () => {
    const setup = await renderEffortApp();
    await typeEffortText(setup, "/effort");
    setup.mockInput.pressEnter();
    // No argument → open the level panel (title `思考强度` "thinking intensity" visible),
    // no longer via notice; current thinkingEffort="" → panel shows adaptive state
    // (AUTO · adaptive state, no level cursor).
    const frame = await waitFrame(
      setup,
      (f) => f.includes("思考强度"),
      8000,
      "panel-open"
    );
    expect(frame).not.toContain("/effort <level>"); // no available-levels hint
    expect(frame).toContain("自适应");
    expect(frame).toContain("AUTO");
    await setup.renderer.destroy();
  });
});

test("同一 tick 快速连发两个字符：输入框同时含两字", async () => {
  const setup = await renderApp();
  // No intermediate await, simulating same-tick bursts; the native input onInput
  // reports the full string, eliminating the old "first char eaten" race at the root.
  setup.mockInput.pressKey("你");
  setup.mockInput.pressKey("好");
  await settle(setup);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("❯");
  expect(frame).toContain("你好");
  await setup.renderer.destroy();
});

test("bracketed paste 不双写：粘贴文本只出现一次", async () => {
  const setup = await renderApp();
  const text = "粘贴测试";
  await setup.mockInput.pasteBracketedText(text);
  await settle(setup);
  const frame = setup.captureCharFrame();
  expect(frame).toContain(text);
  expect(frame).not.toContain(text + text);
  await setup.renderer.destroy();
});

test("T8 Shift+Enter：换行不提交，输入框保留两行文本", async () => {
  const { setup } = await renderMultilineApp();
  await typeMultilineText(setup, "第一行");
  setup.mockInput.pressEnter({ shift: true });
  await settle(setup);
  await typeMultilineText(setup, "第二行");
  // Not submitted: both text lines remain visible in the frame (Shift+Enter only inserts a newline, never submits).
  const frame = setup.captureCharFrame();
  expect(frame).toContain("第一行");
  expect(frame).toContain("第二行");
  await setup.renderer.destroy();
});

test("T8 Enter：提交多行文本 → 消息落盘含换行", async () => {
  const { setup, bridge } = await renderMultilineApp();
  await typeMultilineText(setup, "第一行");
  setup.mockInput.pressEnter({ shift: true });
  await settle(setup);
  await typeMultilineText(setup, "第二行");
  setup.mockInput.pressEnter();
  // Wait for the turn to persist → the session title contains the two newline-separated lines.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    if (bridge.inflight.ids().size === 0) break;
  }
  const list = await bridge.listSessions();
  expect(list.length).toBe(1);
  expect(list[0]!.title).toBe("第一行\n第二行");
  await setup.renderer.destroy();
});

describe("T8 回归：程序写入后光标重置（Backspace no-op / 前插）", () => {
  /**
   * Root cause (multiline-input migration regression, prompt-input.tsx
   * controlled sync effect): `ta.setText()` fully resets the buffer and moves
   * the cursor to offset 0 — the old `<input>` value setter's built-in
   * `cursorOffset = newValue.length` restoration step was lost in migration.
   * After programmatic writes (↑ history recall / Tab completion / rewind
   * backfill): Backspace at offset 0 is a native no-op ("cannot delete"), and
   * further typing prepends at the start ("cursor jumps to the first char").
   *
   * Observation technique: the message stream renders the full user text
   * (transcript copy) and the input box renders another copy — distinguish
   * them by the change of the in-frame occurrence count (transcript copy is
   * constant, input-box copy changes with editing); for append scenarios use
   * the exclusive substring "end-of-line immediately followed by the new
   * char" (the transcript has no such char after the line end).
   */

  /** Occurrence count of a substring in the frame (separates transcript copy from input-box copy). */
  function countOccurrences(frame: string, needle: string): number {
    let count = 0;
    let idx = frame.indexOf(needle);
    while (idx !== -1) {
      count++;
      idx = frame.indexOf(needle, idx + 1);
    }
    return count;
  }

  /** Wait for the turn to persist (inflight drained), same polling as the Enter-submit case above. */
  async function waitTurnDone(
    setup: Awaited<ReturnType<typeof testRender>>,
    bridge: ReturnType<typeof createTuiBridge>
  ): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      await setup.renderOnce();
      if (bridge.inflight.ids().size === 0) return;
    }
    throw new Error("waitTurnDone timeout: inflight 未清空");
  }

  test("多行召回后 Backspace 删掉末字符（不是 offset 0 处 no-op）", async () => {
    const { setup, bridge } = await renderMultilineApp();
    await typeMultilineText(setup, "第一行");
    setup.mockInput.pressEnter({ shift: true });
    await settle(setup);
    await typeMultilineText(setup, "第二行");
    setup.mockInput.pressEnter();
    await waitTurnDone(setup, bridge);
    // After submit the input box clears: the placeholder (input-message hint or /help) becomes visible again.
    await waitFrame(setup, (f) => f.includes("输入消息"), 8000, "cleared");
    // ↑ recall: placeholder disappears (input box restores the full multiline text; cursor position doesn't affect the frame).
    setup.mockInput.pressArrow("up");
    await waitFrame(setup, (f) => !f.includes("输入消息"), 8000, "recall");
    // Baseline: transcript 1 copy + input box 1 copy (≥2 also guards against a vacuous "recall failed" pass).
    const before = countOccurrences(setup.captureCharFrame(), "第二行");
    expect(before).toBeGreaterThanOrEqual(2);
    // Backspace: cursor should be at the end → deletes the final character, the input-box copy disappears (count -1).
    // Before the fix setText reset the cursor to offset 0 → native backspace no-op, count unchanged.
    setup.mockInput.pressBackspace();
    await waitFrame(
      setup,
      (f) => countOccurrences(f, "第二行") === before - 1,
      8000,
      "backspace-deletes-last-char"
    );
    await setup.renderer.destroy();
  }, 30_000);

  test("多行召回后输入字符追加到末尾（不前插到开头）", async () => {
    const { setup, bridge } = await renderMultilineApp();
    await typeMultilineText(setup, "第一行");
    setup.mockInput.pressEnter({ shift: true });
    await settle(setup);
    await typeMultilineText(setup, "第二行");
    setup.mockInput.pressEnter();
    await waitTurnDone(setup, bridge);
    await waitFrame(setup, (f) => f.includes("输入消息"), 8000, "cleared");
    setup.mockInput.pressArrow("up");
    await waitFrame(setup, (f) => !f.includes("输入消息"), 8000, "recall");
    // Type X: cursor at the end → X appends after the recalled second line. The transcript copy
    // has no X after the line end, so the "second-line + X" form can only come from the input
    // box's append position; before the fix X prepended to the first line instead.
    setup.mockInput.pressKey("X");
    await waitFrame(setup, (f) => f.includes("第二行X"), 8000, "append-at-end");
    expect(setup.captureCharFrame()).not.toContain("X第一行");
    await setup.renderer.destroy();
  }, 30_000);

  test("窄终端 CJK：wrap 超长中文行召回后 Backspace 删掉末字符（setCursor 视觉列 clamp 到真实行尾）", async () => {
    // Regression: cursor restoration after prompt-input setText is the load-bearing
    // "narrow-terminal CJK" case — before the fix, a naive `cursorOffset = value.length`
    // in visual-column terms (CJK counts as 2 columns) placed the cursor mid-line, so
    // Backspace deleted the wrong char. Here width=44 (narrow but above the app-layer
    // cols floor of 40 → input box inner width 38) verifies setCursor's out-of-range
    // auto-clamp to the real line end. 24 Chinese chars = 48 visual columns > 38 →
    // wraps to 2 lines, exercising the wrap-aware ↑ history recall + last-line
    // cursor-restoration path.
    const { setup, bridge } = await renderMultilineApp({ width: 44 });
    const wrapped = "我是一段超过窄终端列宽需要折行的中文输入内容显示";
    await typeMultilineText(setup, wrapped);
    setup.mockInput.pressEnter();
    await waitTurnDone(setup, bridge);
    await waitFrame(setup, (f) => f.includes("输入消息"), 8000, "cleared");
    // ↑ recalls the wrapped long line (wrap-aware out-of-range decision → history recall).
    setup.mockInput.pressArrow("up");
    await waitFrame(setup, (f) => !f.includes("输入消息"), 8000, "recall");
    const before = countOccurrences(
      setup.captureCharFrame(),
      wrapped.slice(-2)
    );
    // Backspace should delete the last char (cursor clamped at the last line's end); a
    // cursor parked mid-line deletes the wrong char → the last-two-chars count stays the
    // same → waitFrame times out.
    setup.mockInput.pressBackspace();
    await waitFrame(
      setup,
      (f) => countOccurrences(f, wrapped.slice(-2)) === before - 1,
      8000,
      "narrow-cjk-backspace-deletes-last-char"
    );
    await setup.renderer.destroy();
  }, 30_000);

  test("单行召回后 Backspace 删掉 'o'（hello → hell，简单场景回归护栏）", async () => {
    const { setup, bridge } = await renderMultilineApp();
    await typeMultilineText(setup, "hello");
    setup.mockInput.pressEnter();
    await waitTurnDone(setup, bridge);
    await waitFrame(setup, (f) => f.includes("输入消息"), 8000, "cleared");
    setup.mockInput.pressArrow("up");
    await waitFrame(setup, (f) => !f.includes("输入消息"), 8000, "recall");
    const before = countOccurrences(setup.captureCharFrame(), "hello");
    expect(before).toBeGreaterThanOrEqual(2);
    // Backspace: deletes the trailing 'o' → the input box becomes "hell", "hello" count -1 (transcript copy retained).
    setup.mockInput.pressBackspace();
    await waitFrame(
      setup,
      (f) => countOccurrences(f, "hello") === before - 1,
      8000,
      "backspace-deletes-o"
    );
    await setup.renderer.destroy();
  }, 30_000);
});

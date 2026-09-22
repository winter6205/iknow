/** @jsxImportSource @opentui/react */
/**
 * tests/tui/esc-session-foreground.test.tsx — app-layer wiring test for the
 * session-foreground handoff interrupt contract:
 * Esc = **everything foreground** in the current session (parent `running-fg`
 * turn + all foreground subagents of this session); while foreground work is
 * live, interrupt wins over the double-Esc fallback check; background
 * `wait:false` work and other sessions are untouched. Esc took over interrupt
 * from Ctrl+C (Ctrl+C is now selection-copy only; the copy cases stay in this
 * file as the control).
 *
 * Layering:
 *   - Fan-out semantics (conversationId / foreground / live / return value)
 *     SSOT lives in
 *     tests/session-api/hub-abort-session-foreground.test.ts (real SessionHub +
 *     fake manager);
 *   - this file pins the app's **key→call** mapping and **ordering**: Esc must
 *     invoke `bridge.abortSessionForegroundWork(thisSession)` and abort the
 *     parent aborter at the same time; with foreground work live, interrupt
 *     must not fall through to the double-Esc picker; with no foreground work,
 *     Ctrl+C selection-copy behavior is unchanged.
 *   - The observability surface for "no copy" is the **copy-channel call seam**
 *     (mountApp's OSC52/fallback seam, same as
 *     tests/tui/copy-osc52-gate.test.tsx), not the notice text: while a
 *     foreground turn runs, turn teardown overwrites the copy notice with
 *     `已打断…` ("interrupted…"), so the frame never shows `已复制` ("copied") —
 *     using it as the judge proves nothing (green even if copy really
 *     happened). The seam's falsifiability is pinned by the positive-control
 *     case (Ctrl+C + selection → count = 1).
 *   - The downstream half of "abort really reaches the wait chain"
 *     (SubAgentAbortError rejecting waitFor) lives in
 *     tests/tui/wait-cancel-abort.test.tsx.
 *
 * Why a fake bridge: the proposition here is "which key calls whom, in what
 * order"; the real manager's SIGTERM→SIGKILL and hub filtering already have
 * their own coverage (see above). The fake bridge only swaps the outlets for
 * observable counters/strings; all other fields mirror the product TuiBridge.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import type { TuiBridge } from "../../src/tui/hub-bridge.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import {
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import { captureStderr } from "../_helpers/capture-stderr.ts";

const COLS = 80;
const ROWS = 30;
const CONVERSATION_ID = "conv-fg-c";

interface ForegroundRig {
  readonly setup: TestRendererSetup;
  readonly abortCalls: string[];
  readonly abortSessionCalls: string[];
  readonly wakeCalls: string[];
  /** Fan-out return value injected by the coordinator: "does this session have in-flight foreground subagents". */
  readonly abortedByFanOut: string[];
  /** postMessage call count (proof a real turn started). */
  readonly postCount: () => number;
  /**
   * How many times the copy channel was traversed: one count per `doCopy`
   * outlet (OSC52 hit / native fallback). A **render-independent**
   * observability surface — see the `mountApp` seam notes.
   */
  readonly copyCalls: () => number;
  readonly stderr: ReturnType<typeof captureStderr>;
  readonly dispose: () => Promise<void>;
}

function makeSessionFile(dataDir: string): SessionFileV1 {
  return {
    id: CONVERSATION_ID,
    workspaceRoot: dataDir,
    messages: [],
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
  };
}

interface MountOptions {
  readonly session: TuiSessionState;
  /** Fan-out return value (real hub shape = live foreground taskId of this session). */
  readonly fanOutResult?: ReadonlyArray<string>;
  /** Observation outlet: projection of the real manager's listSubagents (unused when this test sends no keys). */
  readonly subagents?: ReadonlyArray<SubagentInfo>;
}

async function mountApp(opts: MountOptions): Promise<ForegroundRig> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-ctrl-c-fg-"));
  const file = makeSessionFile(dataDir);
  const abortCalls: string[] = [];
  let posts = 0;
  const abortSessionCalls: string[] = [];
  const wakeCalls: string[] = [];
  const abortedByFanOut = [...(opts.fanOutResult ?? [])];
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? CONVERSATION_ID,
    // Never resolves: the turn stays in running-fg and the parent aborter
    // remains registered (after abort the promise settles via the abort
    // signal; this test only observes whether the abort was issued).
    postMessage: ({ signal }) =>
      new Promise((_resolve, reject) => {
        posts += 1;
        signal?.addEventListener("abort", () => {
          abortCalls.push(CONVERSATION_ID);
          reject(new Error("aborted"));
        });
      }),
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async () => ({ file }),
    listRewindTargets: async () => [],
    inflight: createInflightRegistry(),
    contextWindow: 200_000,
    getCapacity: () => 15,
    listSubagents: () => opts.subagents ?? [],
    abortSubagentTask: () => true,
    abortSessionForegroundWork: (conversationId) => {
      abortSessionCalls.push(conversationId);
      return abortedByFanOut;
    },
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async (conversationId) => {
      wakeCalls.push(conversationId);
    },
  };
  const stderr = captureStderr();
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
      initialSession={opts.session}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  // attachSession goes through bridge.ensureSession(conversationId) against the
  // real store: an id means the session file exists, so it lands as active after
  // the first frame. initialSession's runState is driven below by a real
  // suspended turn — not forged by injection.
  await setup.waitForVisualIdle();

  // ── copy-channel seam (observation point = call site, not the notice) ─────
  // This file's propositions include "Ctrl+C must not copy while foreground is
  // live". The notice is not a valid judge: turn teardown calls
  // `setNotice({lines:["已打断…"]})` ("interrupted…"), overwriting the copy
  // notice, so "no `已复制` ('copied') on the frame" is vacuously true in the
  // running-fg cases — green even if copy really happened. Same seam shape as
  // tests/tui/copy-osc52-gate.test.tsx: on the real renderer, replace both
  // `doCopy` outlets (OSC52 and native fallback); any call increments. The
  // counter is render-order independent and cannot be masked by setNotice.
  const r = setup.renderer as unknown as {
    isOsc52Supported(): boolean;
    copyToClipboardOSC52(text: string): boolean;
  };
  const realOsc52Copy = r.copyToClipboardOSC52;
  let copyCalls = 0;
  (r as unknown as { isOsc52Supported: () => boolean }).isOsc52Supported = () =>
    true;
  (
    r as unknown as { copyToClipboardOSC52: (t: string) => boolean }
  ).copyToClipboardOSC52 = (text: string) => {
    copyCalls += 1;
    return realOsc52Copy.call(setup.renderer, text);
  };

  return {
    setup,
    postCount: () => posts,
    abortCalls,
    abortSessionCalls,
    wakeCalls,
    abortedByFanOut,
    copyCalls: () => copyCalls,
    stderr,
    dispose: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      stderr.restore();
    },
  };
}

function fakeSelection(text: string): {
  getSelectedText(): string;
  touchedRenderables: unknown[];
} {
  return { getSelectedText: () => text, touchedRenderables: [] };
}

/** An existing stored session (draft sessions have conversationId undefined → fan-out has no session to pass). */
function session(): TuiSessionState {
  return Object.freeze({
    ...createDraftSession(),
    conversationId: CONVERSATION_ID,
  });
}

/** Send a message key-by-key to start a real turn (burst sends drop keys: mockInput parses stdin asynchronously). */
async function sendMessage(
  setup: TestRendererSetup,
  text: string
): Promise<void> {
  for (const ch of text) {
    setup.mockInput.pressKey(ch);
    await new Promise((r) => setTimeout(r, 60));
  }
  setup.mockInput.pressEnter();
}

/** Conditional polling (key landing and React commit both lag). */
async function until(
  cond: () => boolean,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`until timeout: ${label}`);
}

async function settle(setup: TestRendererSetup): Promise<void> {
  await setup.waitForVisualIdle();
  await new Promise((r) => setTimeout(r, 30));
  await setup.waitForVisualIdle();
}

/**
 * Suspend a real turn: bridge.postMessage never settles (simulating an
 * in-flight foreground turn), so the parent aborter is registered and
 * `canInterrupt(active)` is true.
 *
 * Both waits are mandatory:
 *  1. postMessage called = turn started (input landed / session stored);
 *  2. the live seconds segment on the mode line appears in the frame
 *     (` · Xs`, incremented by the 1Hz tick once runState flips to
 *     running-fg via turnStarted) — only when runState really entered React
 *     state does Esc take the foreground-interrupt arm; without this wait the
 *     key may arrive before the commit and take the idle branch (abort never
 *     issued = vacuously green).
 */
async function startPendingTurn(app: ForegroundRig): Promise<void> {
  await sendMessage(app.setup, "hi");
  await until(
    () => app.postCount() > 0,
    8000,
    "turn 未启动（postMessage 未调）"
  );
  await until(
    () => /· \d+s/.test(app.setup.captureCharFrame()),
    8000,
    "会话未进入 running-fg（mode 行无实时秒数）"
  );
}

describe("Esc = 当前会话前台一切（Locked sentence 3 / T5，2026-09-18 键位迁移）", () => {
  test("running-fg：父 aborter 触发 + 本会话扇出被调用一次", async () => {
    const app = await mountApp({ session: session(), fanOutResult: ["t-fg"] });
    try {
      await startPendingTurn(app);
      app.setup.mockInput.pressEscape();
      await until(() => app.abortCalls.length > 0, 8000, "父 turn 未被 abort");

      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID]);
      expect(app.abortCalls).toEqual([CONVERSATION_ID]);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("父 idle + 前景子代理 live：扇出被调用，且不落双 Esc picker", async () => {
    const app = await mountApp({
      session: session(),
      fanOutResult: ["t-late"],
    });
    try {
      // No turn running: parent runState stays idle; only the hub side has in-flight foreground subagents.
      app.setup.mockInput.pressEscape();
      await until(() => app.abortSessionCalls.length > 0, 8000, "扇出未被调用");

      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID]);
      // No parent aborter (no in-flight postMessage) → no crash, no false alarm.
      expect(app.abortCalls).toEqual([]);
      await settle(app.setup);
      // The interrupt arm beats the double-Esc fallback check: picker never opened (no title row).
      expect(app.setup.captureCharFrame()).not.toContain("回退到更早的回合");
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("父 idle + 前景子代理 live + 有选区：仍然打断，不复制", async () => {
    // The ordering clause also holds once the parent is idle: foreground work
    // lives in subagents, and Esc still means interrupt. The judgment must come
    // from the fresh fan-out answer (pulled live from the hub), never the TUI's
    // 1Hz projection — this test simulates the hub's fresh answer via fanOutResult.
    const app = await mountApp({
      session: session(),
      fanOutResult: ["t-late"],
    });
    try {
      const selectedText = "父 idle 时的选区";
      (
        app.setup.renderer as unknown as { currentSelection: unknown }
      ).currentSelection = fakeSelection(selectedText);
      app.setup.renderer.emit("selection", fakeSelection(selectedText));
      await settle(app.setup);

      app.setup.mockInput.pressEscape();
      await until(() => app.abortSessionCalls.length > 0, 8000, "扇出未被调用");

      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID]);
      await settle(app.setup);
      // Zero copy-channel calls = Esc has no copy semantics (copy belongs to Ctrl+C only).
      expect(app.copyCalls()).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("running-fg + 有选区：打断优先（Esc 无复制臂），不复制", async () => {
    const app = await mountApp({ session: session(), fanOutResult: ["t-fg"] });
    try {
      await startPendingTurn(app);
      const selectedText = "被选中的正文";
      (
        app.setup.renderer as unknown as { currentSelection: unknown }
      ).currentSelection = fakeSelection(selectedText);
      app.setup.renderer.emit("selection", fakeSelection(selectedText));
      await settle(app.setup);

      app.setup.mockInput.pressEscape();
      await until(() => app.abortCalls.length > 0, 8000, "父 turn 未被 abort");

      expect(app.abortCalls).toEqual([CONVERSATION_ID]);
      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID]);
      await settle(app.setup);
      // Zero copy-channel calls = Esc has no copy arm (same judge surface as the old Ctrl+C "interrupt-first" rule).
      expect(app.copyCalls()).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("running-fg + 扇出空返回：仍以父 turn 为前台活 → 打断", async () => {
    // The ordering rule must be "canInterrupt(parent) OR non-empty fan-out", not
    // fan-out alone. This test forces the fan-out empty (no subagent to stop)
    // while in running-fg — an implementation trusting only the fan-out return
    // would fall into the double-Esc fallback here and miss aborting the parent turn.
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      await startPendingTurn(app);
      app.setup.mockInput.pressEscape();
      await until(() => app.abortCalls.length > 0, 8000, "父 turn 未被 abort");

      expect(app.abortCalls).toEqual([CONVERSATION_ID]);
      await settle(app.setup);
      expect(app.copyCalls()).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("Ctrl+C 复制臂保留：有选区复制（seam 阳性对照），打断不误触", async () => {
    // After the key migration Ctrl+C only copies: selection → copy, never interrupt.
    // The same seam must count > 0 when a copy really happens; without this
    // positive control, a broken seam (e.g. doCopy changed outlets) would make
    // "zero calls" eternally green.
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      const selectedText = "阳性对照：这段必须被复制";
      (
        app.setup.renderer as unknown as { currentSelection: unknown }
      ).currentSelection = fakeSelection(selectedText);
      app.setup.renderer.emit("selection", fakeSelection(selectedText));
      await settle(app.setup);

      app.setup.mockInput.pressCtrlC();
      await until(() => app.copyCalls() > 0, 8000, "复制通道未被调用");

      expect(app.copyCalls()).toBe(1);
      expect(app.abortCalls).toEqual([]);
      expect(app.abortSessionCalls).toEqual([]);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("idle + 无前景子代理 + 有选区：Ctrl+C 复制行为不变（回归）", async () => {
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      const selectedText = "idle 会话的选区";
      (
        app.setup.renderer as unknown as { currentSelection: unknown }
      ).currentSelection = fakeSelection(selectedText);
      app.setup.renderer.emit("selection", fakeSelection(selectedText));
      await settle(app.setup);

      app.setup.mockInput.pressCtrlC();
      await settle(app.setup);

      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/已复制|已写入/);
      expect(app.copyCalls()).toBe(1);
      expect(app.abortCalls).toEqual([]);
      expect(app.abortSessionCalls).toEqual([]);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("idle + 无选区 + Ctrl+C：提示复制用法（不再指向打断）", async () => {
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      app.setup.mockInput.pressCtrlC();
      await until(
        () => app.setup.captureCharFrame().includes("无选区"),
        8000,
        "复制提示未出现"
      );

      expect(app.abortSessionCalls).toEqual([]);
      expect(app.abortCalls).toEqual([]);
      expect(app.stderr.lines.join("")).toBe("");
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("双 Esc 回退（idle）：第二击在窗口内 → 走到 openRewindPicker", async () => {
    // Input-contract gate gap: the app-level "double Esc → picker" path
    // previously had only the isDoubleEsc pure-function coverage
    // (tests/tui/rewind.test.ts), no end-to-end wiring case. This test pins:
    // both presses land on the idle arm (timestamp recorded / window hit) →
    // openRewindPicker is called. The fake bridge has no anchors
    // (listRewindTargets → []) → the L0 empty-state notice reaches the screen;
    // it is openRewindPicker's exclusive outlet, enough to prove the double-Esc
    // path ran. Each Esc press first idles through the fan-out (read-only hub
    // enumeration; empty and side-effect-free when idle).
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      app.setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 100));
      app.setup.mockInput.pressEscape();
      await until(
        () =>
          app.setup.captureCharFrame().includes("Nothing to rewind to yet."),
        8000,
        "rewind 空态 notice 未出现"
      );

      expect(app.abortCalls).toEqual([]);
      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID, CONVERSATION_ID]);
    } finally {
      await app.dispose();
    }
  }, 30_000);
});

/** @jsxImportSource @opentui/react */
/**
 * tests/tui/settle-store-only.test.tsx
 *
 * From specs/interrupt-frozen-prefix-keep.md invariant 2 + the "TUI settle" row of its
 * input-contract table (also ADR-0108).
 *
 * Pinned invariant: the SSOT is the closeout (store), not the TUI overlay.
 *   1. overlay empty, store holds the frozen prefix → after settle the wall shows the store
 *      (prefix visible);
 *   2. the overlay's leftover draft (tailRaw, already dropped by the harness) must never
 *      overwrite the store — after settle the wall never shows the tail drawn during streaming;
 *   3. `finally` unloading the draft (app.tsx draft.reset/setStreamDraft(null)) happens before
 *      `turnFinished` swaps the snapshot (loadSessionFile): the final frame follows the
 *      snapshot, and the unloaded draft is never written back into history (no leftover tail
 *      even after the delayed-refresh window).
 *   4. no-prefix disk (store has only user+interrupt) → the settled wall draws no fake assistant.
 *
 * Assembly follows the fake-bridge discipline of interrupt-notice.test.tsx: this file only
 * certifies the app-layer settle wall-render mapping (overlay unmount + snapshot takeover);
 * the harness closeout's prefix commit itself is pinned by tests/harness, decoupled from here.
 * During streaming we first assert the tail **was** on screen, so the post-settle not.toContain is not vacuous.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import type { TuiBridge, TuiPostResult } from "../../src/tui/hub-bridge.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

/** tail marker drawn during streaming but absent from the store (tailRaw stand-in). Pure ASCII:
 *  pangu on the wall inserts spaces between CJK and Latin, a mixed marker would break includes assertions. */
const TAIL_MARK = "GrowingTailX9";
/** the pinned prefix harness closeout already committed to the store (prefixRaw stand-in). */
const PREFIX_TEXT = "KeptPrefixA7 pinned block";

async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

interface SettleBridgeOptions {
  /** whether the store (loadSessionFile) holds assistant(prefix):
   *  true = shape with user + assistant(prefix) + interrupt;
   *  false = shape with user + interrupt, no assistant. */
  readonly persistPrefix: boolean;
  /** loadSessionFile delay: widens the race window where "finally unloads draft" precedes "snapshot swap". */
  readonly loadDelayMs?: number;
}

/**
 * fake bridge: during postMessage it pushes text_delta via onStream (prefix + tail in two
 * chunks, same source as the real draft accumulation path), then writes to disk in closeout
 * shape — the store contains only the prefix, the tail is dropped by the harness.
 * cancelled + interrupted=true.
 */
function settleBridge(opts: SettleBridgeOptions): TuiBridge {
  const inflight = createInflightRegistry();
  const now = new Date().toISOString();
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-settle",
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: now,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "打断前的问题" }],
      },
      ...(opts.persistPrefix
        ? [
            {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: PREFIX_TEXT }],
            },
          ]
        : []),
      {
        role: "system" as const,
        content: [{ type: "text" as const, text: "Interrupted by user." }],
      },
    ],
    jsonMode: false,
    turnCount: 1,
    updatedAt: now,
    checkpoints: [],
  };
  const reply: TuiPostResult = {
    conversationId: "conv-settle",
    finalText: "",
    stopReason: "cancelled",
    turnCount: 1,
    jsonMode: false,
    lastUsage: null,
    interrupted: true,
  };
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-settle",
    postMessage: async ({ onStream }) => {
      inflight.mark("conv-settle");
      try {
        const emit = (event: HarnessStreamEvent): void => {
          onStream?.(event);
        };
        emit({ type: "text_delta", text: PREFIX_TEXT });
        // let the running frame render at least once (the tail going on screen depends on this window).
        await new Promise((r) => setTimeout(r, 80));
        emit({ type: "text_delta", text: `\n\n${TAIL_MARK}` });
        await new Promise((r) => setTimeout(r, 250));
        return reply;
      } finally {
        inflight.unmark("conv-settle");
      }
    },
    listSessions: async () => [],
    loadSessionFile: async () => {
      if (opts.loadDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.loadDelayMs));
      }
      return file;
    },
    compactSession: async () => ({ compacted: false }),
    continueSession: async () => {
      throw new Error("continueSession unused in settle tests");
    },
    rewindSession: async (id) => {
      void id;
      return { file };
    },
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    getCapacity: () => 15,
    listSubagents: () => [],
    abortSessionForegroundWork: () => [],
  };
  return bridge;
}

async function mount(opts: SettleBridgeOptions): Promise<{
  setup: TestRendererSetup;
  destroy: () => Promise<void>;
  typeText: (text: string) => Promise<void>;
  pressEnter: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-settle-"));
  const bridge = settleBridge(opts);
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: TestRendererSetup | undefined;
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
    { width: 90, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  return {
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
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
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

describe("TUI settle 只画 store（spec invariant 2 / T5）", () => {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  afterEach(() => {
    rejections.length = 0;
  });

  test("cancelled 有 prefix：流式画过残尾 → settle 后墙 = store（prefix+interrupt，无残尾）", async () => {
    const app = await mount({ persistPrefix: true, loadDelayMs: 300 });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    // precondition: the tail really was on the overlay (otherwise the post-settle not.toContain is a vacuous assertion).
    await untilFrame(app.setup, (f) => f.includes(TAIL_MARK));
    // settle: the interrupted-with-checkpoint notice appears → draft unload + snapshot swap are both done.
    await untilFrame(app.setup, (f) => f.includes("已打断，checkpoint 已保存"));

    const frame = app.setup.captureCharFrame();
    // the wall shows the store: both the prefix body and the interrupt line are visible.
    expect(frame).toContain(PREFIX_TEXT);
    expect(frame).toContain("Interrupted by user.");
    // the overlay's leftover draft neither overwrites the store nor writes back into history.
    expect(frame).not.toContain(TAIL_MARK);

    // re-check with the widened race window: snapshot arrives 300ms late, draft unload precedes it —
    // the snapshot wins and the unloaded draft never revives in later frames.
    await new Promise((r) => setTimeout(r, 600));
    await app.setup.renderOnce();
    const settled = app.setup.captureCharFrame();
    expect(settled).toContain(PREFIX_TEXT);
    expect(settled).not.toContain(TAIL_MARK);

    await new Promise((r) => setTimeout(r, 300));
    expect(rejections).toHaveLength(0);
    await app.destroy();
  }, 30_000);

  test("cancelled 无 prefix：settle 后墙只有 user+interrupt，不画假 assistant", async () => {
    const app = await mount({ persistPrefix: false });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes(TAIL_MARK));
    await untilFrame(app.setup, (f) => f.includes("已打断，checkpoint 已保存"));

    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("Interrupted by user.");
    expect(frame).not.toContain(TAIL_MARK);
    expect(frame).not.toContain(PREFIX_TEXT);

    await new Promise((r) => setTimeout(r, 300));
    expect(rejections).toHaveLength(0);
    await app.destroy();
  }, 30_000);

  // afterAll rather than a pseudo-test: the hook still runs when an earlier case crashes, keeping
  // the listener from leaking into later test files in the same process.
  afterAll(() => {
    process.off("unhandledRejection", listener);
  });
});

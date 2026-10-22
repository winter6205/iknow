/** @jsxImportSource @opentui/react */
/**
 * While a turn is running, Enter parks the draft. Up on an empty composer
 * writes the newest unread draft back. The idle gap, including one Esc
 * forced by aborting the live turn, sends the oldest draft without another
 * Enter.
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
  type TuiBridge,
  type TuiPostResult,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import {
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import { emptyClipboardImageReader } from "./_fixtures.js";
import { composerText } from "./_fixtures.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

const COLS = 80;
const ROWS = 30;
const CONVERSATION_ID = "conv-gap";

type Script =
  | { readonly kind: "reply" }
  | { readonly kind: "in-flight" }
  | { readonly kind: "abortable" }
  | { readonly kind: "hold" };

interface SubmittedTurn {
  readonly text: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleFrame(setup: TestRendererSetup): Promise<void> {
  await sleep(120);
  await setup.renderOnce();
  await setup.waitForVisualIdle();
}

async function until(
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 8000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error(`until timeout: ${label}`);
}

function sessionFile(id: string): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    conversation_id: id,
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: now,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    checkpoints: [],
  };
}

interface FakeBridgeCalls {
  readonly ensureSessionInputs: Array<string | undefined>;
  readonly postedConversationIds: string[];
}

interface FakeBridgeOptions {
  readonly submits: SubmittedTurn[];
  readonly settlements: TuiPostResult[];
  readonly script: Script[];
  readonly releaseHold: { current: (() => void) | undefined };
  readonly calls: FakeBridgeCalls;
  readonly distinctDraftIds: boolean;
}

function fakeBridge({
  submits,
  settlements,
  script,
  releaseHold,
  calls,
  distinctDraftIds,
}: FakeBridgeOptions): TuiBridge {
  const reply: TuiPostResult = {
    conversationId: CONVERSATION_ID,
    finalText: "",
    stopReason: "completed",
    turnCount: 1,
    jsonMode: false,
    lastUsage: null,
  };
  const cancelled: TuiPostResult = {
    ...reply,
    stopReason: "cancelled",
    interrupted: true,
  };
  let allocatedDraftIds = 0;
  return {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => {
      calls.ensureSessionInputs.push(id);
      if (id !== undefined) return id;
      if (!distinctDraftIds) return CONVERSATION_ID;
      allocatedDraftIds += 1;
      return `conv-gap-created-${allocatedDraftIds}`;
    },
    postMessage: async (opts) => {
      submits.push({ text: opts.text });
      calls.postedConversationIds.push(opts.conversationId);
      const step = script[submits.length - 1] ?? { kind: "reply" };
      if (step.kind === "abortable") {
        return new Promise<TuiPostResult>((resolve) => {
          const finish = (): void => {
            settlements.push(cancelled);
            resolve(cancelled);
          };
          if (opts.signal === undefined) {
            throw new Error("postMessage was called without an abort signal");
          }
          if (opts.signal.aborted) {
            finish();
            return;
          }
          opts.signal.addEventListener("abort", finish, { once: true });
        });
      }
      if (step.kind === "in-flight")
        return new Promise<TuiPostResult>(() => {});
      if (step.kind === "hold") {
        await new Promise<void>((resolve) => {
          releaseHold.current = resolve;
        });
      }
      return { ...reply, conversationId: opts.conversationId };
    },
    listSessions: async () => [],
    loadSessionFile: async (id) => sessionFile(id),
    openSession: async () => {
      throw new Error("unused");
    },
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async (id) => ({ file: sessionFile(id) }),
    listRewindTargets: async () => [],
    inflight: createInflightRegistry(),
    contextWindow: 200_000,
    listLiveBackgroundTasks: () => [],
    listSubagents: () => [],
    abortSubagentTask: () => false,
    abortSessionForegroundWork: () => [],
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
  };
}

interface DrivenApp {
  readonly submits: SubmittedTurn[];
  readonly settlements: TuiPostResult[];
  readonly ensureSessionInputs: Array<string | undefined>;
  readonly postedConversationIds: string[];
  readonly enters: () => number;
  readonly release: () => void;
  readonly type: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressUp: () => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  /** A turn that ends outside a key event still needs a frame before the gap drains. */
  readonly pump: () => Promise<void>;
  readonly text: () => string | null;
  readonly frame: () => string;
  readonly destroy: () => Promise<void>;
}

interface MountOptions {
  readonly distinctDraftIds?: boolean;
  readonly initialSession?: TuiSessionState;
}

async function mountApp(
  script: Script[],
  options: MountOptions = {}
): Promise<DrivenApp> {
  const submits: SubmittedTurn[] = [];
  const settlements: TuiPostResult[] = [];
  const ensureSessionInputs: Array<string | undefined> = [];
  const postedConversationIds: string[] = [];
  let enters = 0;
  const releaseHold: { current: (() => void) | undefined } = {
    current: undefined,
  };
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-gap-"));
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={fakeBridge({
        submits,
        settlements,
        script,
        releaseHold,
        calls: { ensureSessionInputs, postedConversationIds },
        distinctDraftIds: options.distinctDraftIds ?? false,
      })}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      clipboardImageReader={emptyClipboardImageReader}
      initialSession={options.initialSession}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed) {
          setupRef.renderer.destroy();
        }
      }}
    />,
    {
      width: COLS,
      height: ROWS,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    }
  );
  setupRef = setup;
  await sleep(300);
  await setup.waitForVisualIdle();
  return {
    submits,
    settlements,
    ensureSessionInputs,
    postedConversationIds,
    enters: () => enters,
    release: () => releaseHold.current?.(),
    type: async (text) => {
      await setup.mockInput.typeText(text);
      await settleFrame(setup);
    },
    pressEnter: async () => {
      enters += 1;
      setup.mockInput.pressEnter();
      await settleFrame(setup);
    },
    pressUp: async () => {
      setup.mockInput.pressArrow("up");
      await settleFrame(setup);
    },
    pressEscape: async () => {
      setup.mockInput.pressEscape();
      await settleFrame(setup);
    },
    pump: () => settleFrame(setup),
    text: () => composerText(setup),
    frame: () => setup.captureCharFrame(),
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
  };
}

async function queueWhileRunning(
  app: DrivenApp,
  first: string,
  next: string
): Promise<void> {
  await app.type(first);
  await app.pressEnter();
  await until(() => app.submits.length === 1, "first submit in flight");
  await app.type(next);
  await app.pressEnter();
  await until(
    () =>
      app.frame().includes("queued 1") && app.frame().includes(`next: ${next}`),
    "queue line"
  );
}

describe("turn gap input", () => {
  test("Enter while running queues; Up writes the draft back unsent", async () => {
    const app = await mountApp([{ kind: "in-flight" }]);
    try {
      await queueWhileRunning(app, "first", "second");
      expect(app.text()).toBe("");
      expect(app.frame()).toContain("queued 1");
      expect(app.frame()).toContain("next: second");
      expect(app.submits).toHaveLength(1);
      await app.pressUp();
      await until(
        () => app.text() === "second" && !app.frame().includes("queued"),
        "recalled queued draft"
      );
      // "first" is already in history. Up must put the queued draft back.
      expect(app.text()).toBe("second");
      expect(app.frame().includes("next:")).toBe(false);
      expect(app.submits).toHaveLength(1);
      expect(app.submits[0]?.text).toBe("first");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("Up recalls the newest queued draft and leaves the oldest waiting", async () => {
    const app = await mountApp([{ kind: "in-flight" }]);
    try {
      await queueWhileRunning(app, "first", "second");
      await app.type("third");
      await app.pressEnter();
      await until(
        () =>
          app.frame().includes("queued 2") &&
          app.frame().includes("next: second"),
        "two queued"
      );
      await app.pressUp();
      await until(() => app.text() === "third", "recalled newest");
      expect(app.text()).toBe("third");
      expect(app.frame()).toContain("queued 1");
      expect(app.frame()).not.toContain("queued 2");
      expect(app.frame()).toContain("next: second");
      expect(app.submits).toHaveLength(1);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("Esc aborts the live turn and submits the queued draft", async () => {
    const app = await mountApp([{ kind: "abortable" }, { kind: "reply" }]);
    try {
      await queueWhileRunning(app, "first", "second");
      const enters = app.enters();
      await app.pressEscape();
      await until(async () => {
        await app.pump();
        return app.submits.length >= 2 && app.settlements.length === 1;
      }, "queued draft submitted");
      expect(app.enters()).toBe(enters);
      expect(app.settlements[0]?.stopReason).toBe("cancelled");
      expect(app.settlements[0]?.interrupted).toBe(true);
      expect(app.submits[0]?.text).toBe("first");
      expect(app.submits[1]?.text).toBe("second");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("the idle gap sends queued drafts oldest first", async () => {
    const app = await mountApp([
      { kind: "hold" },
      { kind: "reply" },
      { kind: "reply" },
    ]);
    try {
      await queueWhileRunning(app, "first", "second");
      await app.type("third");
      await app.pressEnter();
      await until(() => app.frame().includes("queued 2"), "two waiting");
      expect(app.submits.length).toBe(1);
      app.release();
      await until(async () => {
        await app.pump();
        return app.submits.length === 3;
      }, "both queued drafts sent");
      expect(app.submits.map((item) => item.text)).toEqual([
        "first",
        "second",
        "third",
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("a queued turn preserves the newly created draft session shown by /info", async () => {
    const app = await mountApp([{ kind: "hold" }, { kind: "reply" }], {
      distinctDraftIds: true,
    });
    try {
      await queueWhileRunning(app, "first", "second");
      expect(app.ensureSessionInputs).toEqual([undefined]);

      app.release();
      await until(async () => {
        await app.pump();
        return app.postedConversationIds.length === 2;
      }, "queued turn posted");
      expect(app.ensureSessionInputs).toEqual([
        undefined,
        "conv-gap-created-1",
      ]);
      expect(app.postedConversationIds).toEqual([
        "conv-gap-created-1",
        "conv-gap-created-1",
      ]);

      await app.type("/info");
      await app.pressEnter();
      await until(
        () =>
          app.frame().includes("tokens") && app.frame().includes("runState"),
        "/info rendered"
      );
      expect(app.frame()).toContain("conversation_id: conv-gap-created-1");
      expect(app.frame()).not.toContain("conv-gap-created-2");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("queued turns from an attached session keep that session id", async () => {
    const conversationId = "conv-gap-attached";
    const app = await mountApp([{ kind: "hold" }, { kind: "reply" }], {
      distinctDraftIds: true,
      initialSession: Object.freeze({
        ...createDraftSession(),
        conversationId,
      }),
    });
    try {
      await queueWhileRunning(app, "first", "second");
      app.release();
      await until(async () => {
        await app.pump();
        return app.postedConversationIds.length === 2;
      }, "queued turn posted");

      expect(app.ensureSessionInputs).toEqual([conversationId, conversationId]);
      expect(app.postedConversationIds).toEqual([
        conversationId,
        conversationId,
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

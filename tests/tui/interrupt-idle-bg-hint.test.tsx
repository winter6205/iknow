/** @jsxImportSource @opentui/react */
/**
 * tests/tui/interrupt-idle-bg-hint.test.tsx — app-layer contract for #1081
 * (interrupt → idle + background residual hint):
 *
 *   T1: with a live `wait:false` background worker projected, Esc aborts the
 *       parent turn only; the parent returns to idle, input is unlocked
 *       (no 「请等本轮结束」), and no chrome paints the worker as the parent's
 *       「运行中」. abortSessionForegroundWork keeps background workers out of
 *       its set (the fake models the hub-side criterion: foreground===true).
 *   T2: while live background workers remain after the parent went idle, the
 *       transcript tail shows a dim English count line
 *       (`N background subagent(s) running`); it disappears when no live
 *       background remains. The line is tail chrome, not a model message.
 *   T3: a terminal notice published while the parent turn is active stays
 *       pending (isIdle gate); after the interrupt returns the parent to
 *       idle, the existing mailbox wake pulls the parent into running-fg to
 *       consume the drain (wakeFromSubagent), and the parent can go idle
 *       again — wake is never starved by the interrupt path, and there is no
 *       second wake channel.
 *
 * Layering: fan-out filtering SSOT is
 * tests/session-api/hub-abort-session-foreground.test.ts (real hub); here the
 * fake bridge mirrors the criterion so the app wiring can be observed. The
 * wake unit semantics live in tests/subagent/host-wake.test.ts; this file
 * pins the app.tsx end-to-end seam (subscribe capture, flush on the
 * runState transition after interrupt).
 */
import { describe, expect, test } from "bun:test";
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
import {
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";
import type { SubAgentTerminalNotice } from "../../src/harness/subagent/mailbox.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import { captureStderr } from "../_helpers/capture-stderr.ts";

const COLS = 80;
const ROWS = 30;
const CONV = "conv-1081";

interface Rig {
  readonly setup: TestRendererSetup;
  readonly tasks: SubagentInfo[];
  readonly abortCalls: string[];
  readonly abortSessionCalls: string[];
  readonly wakeCalls: string[];
  /** postMessage call count (user-turn proof, wake turns excluded). */
  readonly postCount: () => number;
  /** Fire a terminal notice through the captured subscribeSubagentTerminal seam. */
  readonly publishNotice: (notice: SubAgentTerminalNotice) => void;
  readonly dispose: () => Promise<void>;
}

function makeSessionFile(dataDir: string): SessionFileV1 {
  return {
    conversation_id: CONV,
    workspaceRoot: dataDir,
    messages: [],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
  };
}

function bgTask(taskId: string): SubagentInfo {
  return {
    taskId,
    state: "running",
    taskPreview: `worker ${taskId}`,
    startedAt: "2026-09-19T00:00:00.000Z",
    conversationId: CONV,
  };
}

async function mountApp(initialTasks: SubagentInfo[]): Promise<Rig> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-1081-"));
  const file = makeSessionFile(dataDir);
  const tasks = [...initialTasks];
  const abortCalls: string[] = [];
  const abortSessionCalls: string[] = [];
  const wakeCalls: string[] = [];
  let posts = 0;
  const subscribers: Array<(notice: SubAgentTerminalNotice) => void> = [];
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? CONV,
    // First turn suspends until aborted; the real hub **resolves** an
    // interrupt with `stopReason:"cancelled"` + `interrupted` (it does not
    // reject), so the app takes its cancelled-teardown lane, not protocolError.
    postMessage: ({ signal }) => {
      posts += 1;
      const turnCount = posts;
      if (posts === 1) {
        return new Promise<TuiPostResult>((resolve) => {
          signal?.addEventListener("abort", () => {
            abortCalls.push(CONV);
            resolve({
              conversationId: CONV,
              finalText: "",
              stopReason: "cancelled",
              turnCount,
              jsonMode: false,
              lastUsage: null,
              interrupted: false,
            });
          });
        });
      }
      const resp: TuiPostResult = {
        conversationId: CONV,
        finalText: "",
        stopReason: "completed",
        turnCount: posts,
        jsonMode: false,
        lastUsage: null,
      };
      return Promise.resolve(resp);
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async () => file,
    listRewindTargets: async () => [],
    inflight: createInflightRegistry(),
    contextWindow: 200_000,
    getCapacity: () => 15,
    // Fresh array per call, like the real projection: the app's 1Hz poll feeds
    // React state and a stable reference would bail out the re-render.
    listSubagents: () => [...tasks],
    abortSubagentTask: () => true,
    // Mirrors the hub-side criterion: only foreground===true live rows of
    // this session are aborted; background (`wait:false`) rows untouched.
    abortSessionForegroundWork: (conversationId) => {
      abortSessionCalls.push(conversationId);
      const aborted: string[] = [];
      for (let i = tasks.length - 1; i >= 0; i -= 1) {
        const t = tasks[i];
        if (
          t.foreground === true &&
          t.conversationId === conversationId &&
          (t.state === "starting" || t.state === "running")
        ) {
          aborted.push(t.taskId);
          tasks.splice(i, 1);
        }
      }
      return aborted;
    },
    subscribeSubagentTerminal: (subscriber) => {
      subscribers.push(subscriber);
      return () => {};
    },
    wakeFromSubagent: async (conversationId) => {
      wakeCalls.push(conversationId);
      // The parent drains the terminal envelope and runs a silent turn, so
      // the real hub returns a full PostMessageResponse (undefined only when
      // nothing drained — never the case here). The app's cancelled/teardown
      // lane then takes turnFinished → idle from this defined resp.
      const resp: TuiPostResult = {
        conversationId: CONV,
        finalText: "",
        stopReason: "completed",
        turnCount: posts + 100,
        jsonMode: false,
        lastUsage: null,
      };
      return resp;
    },
  };
  const session: TuiSessionState = Object.freeze({
    ...createDraftSession(),
    conversationId: CONV,
  });
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
      initialSession={session}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await setup.waitForVisualIdle();
  return {
    setup,
    tasks,
    abortCalls,
    abortSessionCalls,
    wakeCalls,
    postCount: () => posts,
    publishNotice: (notice) => {
      for (const s of subscribers) s(notice);
    },
    dispose: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      stderr.restore();
    },
  };
}

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

/** Start the suspending first turn and wait until runState really flipped
 *  to running-fg (mode-line live seconds, same gate as esc tests). */
async function startPendingTurn(app: Rig): Promise<void> {
  await sendMessage(app.setup, "hi");
  await until(() => app.postCount() > 0, 8000, "turn 未启动");
  await until(
    () => /· \d+s/.test(app.setup.captureCharFrame()),
    8000,
    "会话未进入 running-fg"
  );
}

/** Esc-interrupt the pending first turn and wait for the idle landing
 *  (spinner gone from the frame). */
async function interruptToIdle(app: Rig): Promise<void> {
  app.setup.mockInput.pressEscape();
  await until(() => app.abortCalls.length > 0, 8000, "父 turn 未被 abort");
  await until(
    () => !app.setup.captureCharFrame().includes("运行中"),
    8000,
    "打断后仍显示运行中 chrome"
  );
}

describe("1081 T1: Esc → parent idle, chrome only binds running-fg", () => {
  test("打断只停父 turn：后景工人不杀、输入解锁、无「请等本轮结束」", async () => {
    const app = await mountApp([bgTask("bg1")]);
    try {
      await startPendingTurn(app);
      await interruptToIdle(app);

      expect(app.abortSessionCalls).toEqual([CONV]);
      // The wait:false worker survived the interrupt (hub-side criterion).
      expect(app.tasks.map((t) => t.taskId)).toEqual(["bg1"]);

      // Idle: a new message starts a real turn without the lock notice.
      await sendMessage(app.setup, "next");
      await until(() => app.postCount() >= 2, 8000, "打断后输入未解锁");
      await settle(app.setup);
      const frame = app.setup.captureCharFrame();
      expect(frame).not.toContain("请等本轮结束");
      // No parent 「运行中」 chrome while idle with a live background worker.
      expect(frame).not.toContain("运行中");
    } finally {
      await app.dispose();
    }
  }, 30_000);
});

describe("1081 T2: transcript-tail dim English count line", () => {
  test("打断后仍有 live 后景：末尾可见单数英文计数行", async () => {
    const app = await mountApp([bgTask("bg1")]);
    try {
      await startPendingTurn(app);
      await interruptToIdle(app);
      await until(
        () =>
          app.setup
            .captureCharFrame()
            .includes("1 background subagent running"),
        8000,
        "计数行未出现"
      );
      // Not a model message: never rendered as a bubble / Chinese label.
      expect(app.setup.captureCharFrame()).not.toContain("运行中");
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("后景全部终态后计数行消失；无后景会话不出现该行", async () => {
    const app = await mountApp([bgTask("bg1"), bgTask("bg2")]);
    try {
      await startPendingTurn(app);
      await interruptToIdle(app);
      await until(
        () =>
          app.setup
            .captureCharFrame()
            .includes("2 background subagents running"),
        8000,
        "复数计数行未出现"
      );
      const endedAt = new Date().toISOString();
      app.tasks.splice(0, app.tasks.length, {
        ...app.tasks[0],
        state: "completed",
        endedAt,
      });
      await until(
        () => !app.setup.captureCharFrame().includes("background subagent"),
        8000,
        "终态后计数行未消失"
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("从未 spawn 后景：idle 会话不显示计数行", async () => {
    const app = await mountApp([]);
    try {
      await settle(app.setup);
      expect(app.setup.captureCharFrame()).not.toContain("background subagent");
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("他会话的 live 后景不计入本会话计数行（per-session scope）", async () => {
    const app = await mountApp([
      bgTask("bg1"),
      { ...bgTask("bg-other"), conversationId: "conv-other-tab" },
    ]);
    try {
      await startPendingTurn(app);
      await interruptToIdle(app);
      await until(
        () =>
          app.setup
            .captureCharFrame()
            .includes("1 background subagent running"),
        8000,
        "本会话计数行未出现"
      );
      expect(app.setup.captureCharFrame()).not.toContain(
        "2 background subagents running"
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);
});

describe("1081 T3: mailbox wake survives the interrupt", () => {
  test("turn 中到达的终态通知挂起；打断后 wake 收信封并能再 idle", async () => {
    const app = await mountApp([bgTask("bg1")]);
    try {
      await startPendingTurn(app);
      app.publishNotice({
        taskId: "bg1",
        conversationId: CONV,
        status: "completed",
        summary: "done",
        result: "ok",
      });
      // isIdle gate: no wake while the parent turn is still running.
      await new Promise((r) => setTimeout(r, 200));
      expect(app.wakeCalls).toEqual([]);

      await interruptToIdle(app);
      // The runState transition flushes the pending notice → existing
      // mailbox wake → parent enters running-fg to eat the drain.
      await until(() => app.wakeCalls.length > 0, 8000, "wake 未被触发");
      expect(app.wakeCalls).toEqual([CONV]);

      // The wake turn settles → idle again → input accepted.
      await until(
        () => !app.setup.captureCharFrame().includes("运行中"),
        8000,
        "wake 后未回到 idle"
      );
      await sendMessage(app.setup, "after-wake");
      await until(() => app.postCount() >= 2, 8000, "wake 后输入未解锁");
      await settle(app.setup);
      expect(app.setup.captureCharFrame()).not.toContain("请等本轮结束");
    } finally {
      await app.dispose();
    }
  }, 30_000);
});

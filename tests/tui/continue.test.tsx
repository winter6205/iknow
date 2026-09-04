/** @jsxImportSource @opentui/react */
/**
 * T4 (#690): TUI /continue + pending NL + busy-guard。
 *
 * bun:test。真实 store + conversationId；谓词 SSOT = load，不是 lastStopReason。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import { continueNoticeFor } from "../../src/tui/continue-notice.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { attachSession } from "../../src/tui/session-state.js";
import type { TuiSessionState } from "../../src/tui/session-state.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/session-api/store/schema.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import type { LoopEngineDeps } from "../../src/harness/index.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { captureStderr } from "../_helpers/capture-stderr.ts";

async function untilFrame(
  setup: TestRendererSetup,
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
  throw new Error(`untilFrame timeout ${label}:\n${setup.captureCharFrame()}`);
}

async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function pendingMessages(): AnthropicNativeMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "do" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  ];
}

function sessionFile(
  id: string,
  messages: ReadonlyArray<AnthropicNativeMessage>,
  workspaceRoot: string
): SessionFileV1 {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "do",
    cwd: workspaceRoot,
    // de87ff07 起 unbound session 拒绝执行（requireBoundRoot）：种子 session
    // 必须带 workspaceRoot，否则 /continue 与 pending NL 在执行前置即被拒。
    workspaceRoot,
    sanitized_at: new Date().toISOString(),
    messages: [...messages],
    jsonMode: false,
    turnCount: 1,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  };
}

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressCtrlC: () => Promise<void>;
}

async function mountContinueApp(opts: {
  readonly responses: Parameters<typeof makeDeps>[0];
  readonly deps?: LoopEngineDeps;
  readonly wrapBridge?: (inner: TuiBridge) => TuiBridge;
  readonly traceOut?: string;
  readonly seedPending?: boolean;
  readonly lastStopReason?: TuiSessionState["lastStopReason"];
  readonly seedCleanAssistant?: boolean;
}): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-continue-"));
  const inflight = createInflightRegistry();
  const inner = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: opts.deps ?? makeDeps(opts.responses),
    inflight,
    ...(opts.traceOut ? { traceOut: opts.traceOut } : {}),
  });
  let initialSession: TuiSessionState | undefined;
  if (opts.seedPending === true || opts.seedCleanAssistant === true) {
    const id = await inner.ensureSession(undefined);
    const messages = opts.seedCleanAssistant
      ? ([
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ] as AnthropicNativeMessage[])
      : pendingMessages();
    await inner.store.save({
      id,
      file: sessionFile(id, messages, dataDir),
    });
    const file = await inner.loadSessionFile(id);
    initialSession = {
      ...attachSession(file),
      lastStopReason: opts.lastStopReason,
    };
  }
  const bridge = opts.wrapBridge ? opts.wrapBridge(inner) : inner;
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
      {...(initialSession ? { initialSession } : {})}
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
    }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      // mockInput 走 stdin 异步解析；连发过快会丢键（实测 /continue → /onine
      // → 未知命令，untilFrame 永远等不到 nothing_pending）。
      const inputLanded = (frame: string): boolean =>
        frame.includes(`❯ ${text}`) || frame.includes(`❯ ${text} `);
      const clear = async (): Promise<void> => {
        for (let i = 0; i < 24; i++) {
          setup.mockInput.pressBackspace();
        }
        await new Promise((r) => setTimeout(r, 40));
        await setup.renderOnce();
      };
      const typeOnce = async (): Promise<void> => {
        for (const ch of text) {
          setup.mockInput.pressKey(ch);
          await new Promise((r) => setTimeout(r, 40));
          await setup.renderOnce();
        }
        await new Promise((r) => setTimeout(r, 80));
        await setup.renderOnce();
      };
      setup.mockInput.pressKey("/");
      await new Promise((r) => setTimeout(r, 80));
      await setup.renderOnce();
      await clear();
      await typeOnce();
      const start = Date.now();
      while (!inputLanded(setup.captureCharFrame())) {
        if (Date.now() - start > 4000) {
          throw new Error(
            `typeText did not land ${JSON.stringify(text)}:\n${setup.captureCharFrame()}`
          );
        }
        await clear();
        await typeOnce();
      }
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressCtrlC: async () => {
      setup.mockInput.pressKey("c", { ctrl: true });
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

describe("TUI /continue slash", () => {
  test("empty: draft /continue → nothing_pending；不建档", async () => {
    const app = await mountContinueApp({ responses: [] });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/continue");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes(continueNoticeFor("nothing_pending")[0]!),
      8000,
      "nothing-pending"
    );
    const list = await app.bridge.listSessions();
    expect(list.length).toBe(0);
    await app.destroy();
  }, 30_000);

  test("args: /continue now → usage EXIT；不当新任务句", async () => {
    const postCalls = { n: 0 };
    const app = await mountContinueApp({
      responses: [assistantResult({ texts: ["should-not-append"] })],
      wrapBridge: (inner) => ({
        ...inner,
        postMessage: async (opts) => {
          postCalls.n += 1;
          return inner.postMessage(opts);
        },
      }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/continue now");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes(continueNoticeFor("usage")[0]!),
      8000,
      "usage"
    );
    expect(postCalls.n).toBe(0);
    expect((await app.bridge.listSessions()).length).toBe(0);
    await app.destroy();
  }, 30_000);

  test("negative: 已交还会话 /continue → nothing_pending；不 postMessage fallback", async () => {
    const postCalls = { n: 0 };
    const continueCalls = { n: 0 };
    const app = await mountContinueApp({
      responses: [assistantResult({ texts: ["should-not-run"] })],
      seedCleanAssistant: true,
      wrapBridge: (inner) => ({
        ...inner,
        postMessage: async (opts) => {
          postCalls.n += 1;
          return inner.postMessage(opts);
        },
        continueSession: async (id, opts) => {
          continueCalls.n += 1;
          return inner.continueSession(id, opts);
        },
      }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/continue");
    await app.pressEnter();
    await until(() => continueCalls.n >= 1, 8000, "continue-called");
    await untilFrame(
      app.setup,
      (f) => {
        const needle = continueNoticeFor("nothing_pending")[0]!;
        return (
          f.includes(needle) ||
          f.replace(/\s+/g, "").includes(needle.replace(/\s+/g, ""))
        );
      },
      8000,
      "nothing-pending-clean"
    );
    expect(postCalls.n).toBe(0);
    expect(continueCalls.n).toBe(1);
    const sessions = await app.bridge.listSessions();
    const file = await app.bridge.loadSessionFile(sessions[0]!.conversation_id);
    const userTexts = file.messages.flatMap((m) =>
      m.role === "user"
        ? m.content
            .filter(
              (b): b is { type: "text"; text: string } => b.type === "text"
            )
            .map((b) => b.text)
        : []
    );
    expect(userTexts).not.toContain("/continue");
    await app.destroy();
  }, 30_000);

  test("pending slash：lastStopReason=completed 但盘上 P4 → continue skip-append", async () => {
    const innerDeps = makeDeps([assistantResult({ texts: ["continued-ok"] })]);
    let encodeCount = 0;
    const deps: LoopEngineDeps = {
      ...innerDeps,
      adapter: {
        ...innerDeps.adapter,
        encodeUserText: (t) => {
          encodeCount += 1;
          return innerDeps.adapter.encodeUserText(t);
        },
      },
    };
    const app = await mountContinueApp({
      responses: [],
      deps,
      seedPending: true,
      lastStopReason: "completed",
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/continue");
    await app.pressEnter();
    await until(
      () => app.bridge.inflight.ids().size === 0,
      8000,
      "continue-done"
    );
    await untilFrame(app.setup, (f) => f.includes("continued-ok"), 8000, "ans");
    expect(encodeCount).toBe(0);
    const sessions = await app.bridge.listSessions();
    const file = await app.bridge.loadSessionFile(sessions[0]!.conversation_id);
    const userTexts = file.messages.flatMap((m) =>
      m.role === "user"
        ? m.content
            .filter(
              (b): b is { type: "text"; text: string } => b.type === "text"
            )
            .map((b) => b.text)
        : []
    );
    expect(userTexts).not.toContain("/continue");
    expect(userTexts).toContain("do");
    await app.destroy();
  }, 30_000);
});

describe("TUI pending NL", () => {
  test("hit: please continue 在 pending 时 skip-append", async () => {
    const innerDeps = makeDeps([assistantResult({ texts: ["nl-continued"] })]);
    let encodeCount = 0;
    const deps: LoopEngineDeps = {
      ...innerDeps,
      adapter: {
        ...innerDeps.adapter,
        encodeUserText: (t) => {
          encodeCount += 1;
          return innerDeps.adapter.encodeUserText(t);
        },
      },
    };
    const app = await mountContinueApp({
      responses: [],
      deps,
      seedPending: true,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("please continue");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "nl-done");
    await untilFrame(app.setup, (f) => f.includes("nl-continued"), 8000, "ans");
    expect(encodeCount).toBe(0);
    const sessions = await app.bridge.listSessions();
    const file = await app.bridge.loadSessionFile(sessions[0]!.conversation_id);
    const userTexts = file.messages.flatMap((m) =>
      m.role === "user"
        ? m.content
            .filter(
              (b): b is { type: "text"; text: string } => b.type === "text"
            )
            .map((b) => b.text)
        : []
    );
    expect(userTexts).not.toContain("please continue");
    await app.destroy();
  }, 30_000);

  test("nl_not_single_token: pending 时整行 continue 仍 append", async () => {
    const innerDeps = makeDeps([assistantResult({ texts: ["appended"] })]);
    let encodeCount = 0;
    const deps: LoopEngineDeps = {
      ...innerDeps,
      adapter: {
        ...innerDeps.adapter,
        encodeUserText: (t) => {
          encodeCount += 1;
          return innerDeps.adapter.encodeUserText(t);
        },
      },
    };
    const app = await mountContinueApp({
      responses: [],
      deps,
      seedPending: true,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("continue");
    await app.pressEnter();
    await until(
      () => app.bridge.inflight.ids().size === 0,
      8000,
      "append-done"
    );
    await untilFrame(app.setup, (f) => f.includes("appended"), 8000, "ans");
    expect(encodeCount).toBeGreaterThan(0);
    const sessions = await app.bridge.listSessions();
    const file = await app.bridge.loadSessionFile(sessions[0]!.conversation_id);
    const userTexts = file.messages.flatMap((m) =>
      m.role === "user"
        ? m.content
            .filter(
              (b): b is { type: "text"; text: string } => b.type === "text"
            )
            .map((b) => b.text)
        : []
    );
    expect(userTexts).toContain("continue");
    await app.destroy();
  }, 30_000);

  test("nl_pending_only: 不 pending 时 please continue → 普通 query", async () => {
    const innerDeps = makeDeps([assistantResult({ texts: ["new-task"] })]);
    let encodeCount = 0;
    const deps: LoopEngineDeps = {
      ...innerDeps,
      adapter: {
        ...innerDeps.adapter,
        encodeUserText: (t) => {
          encodeCount += 1;
          return innerDeps.adapter.encodeUserText(t);
        },
      },
    };
    const app = await mountContinueApp({
      responses: [],
      deps,
      seedCleanAssistant: true,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("please continue");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "query-done");
    await untilFrame(app.setup, (f) => f.includes("new-task"), 8000, "ans");
    expect(encodeCount).toBeGreaterThan(0);
    const sessions = await app.bridge.listSessions();
    const file = await app.bridge.loadSessionFile(sessions[0]!.conversation_id);
    const userTexts = file.messages.flatMap((m) =>
      m.role === "user"
        ? m.content
            .filter(
              (b): b is { type: "text"; text: string } => b.type === "text"
            )
            .map((b) => b.text)
        : []
    );
    expect(userTexts).toContain("please continue");
    await app.destroy();
  }, 30_000);

  test("overflow: 非精确 NL（continue the migration）不 continue（走 sendTurn）", async () => {
    const line = "continue the migration";
    const innerDeps = makeDeps([assistantResult({ texts: ["long-query"] })]);
    let encodeCount = 0;
    const deps: LoopEngineDeps = {
      ...innerDeps,
      adapter: {
        ...innerDeps.adapter,
        encodeUserText: (t) => {
          encodeCount += 1;
          return innerDeps.adapter.encodeUserText(t);
        },
      },
    };
    const app = await mountContinueApp({
      responses: [],
      deps,
      seedPending: true,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText(line);
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "long-done");
    expect(encodeCount).toBeGreaterThan(0);
    await app.destroy();
  }, 30_000);
});

describe("TUI /continue busy-guard + Ctrl+C", () => {
  test("concurrent: in-flight turn /continue → busy_stop_first，原 turn 不被 abort", async () => {
    const continueCalls = { n: 0 };
    const app = await mountContinueApp({
      responses: [assistantResult({ texts: ["slow-done"] })],
      deps: makeDeps([assistantResult({ texts: ["slow-done"] })], {
        delayMs: 2500,
      }),
      wrapBridge: (inner) => ({
        ...inner,
        continueSession: async (id, opts) => {
          continueCalls.n += 1;
          return inner.continueSession(id, opts);
        },
      }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("go");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 1, 8000, "turn-start");
    await app.typeText("/continue");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes(continueNoticeFor("busy_stop_first")[0]!),
      8000,
      "busy"
    );
    expect(continueCalls.n).toBe(0);
    expect(app.bridge.inflight.ids().size).toBe(1);
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-end");
    await untilFrame(app.setup, (f) => f.includes("slow-done"), 8000, "orig");
    await app.destroy();
  }, 30_000);

  test("concurrent: compact in-flight /continue → busy_stop_first，不 abort compact", async () => {
    const continueCalls = { n: 0 };
    const abortCalls = { n: 0 };
    let releaseCompact!: () => void;
    const compactHang = new Promise<void>((r) => {
      releaseCompact = r;
    });
    const app = await mountContinueApp({
      responses: [assistantResult({ texts: ["hi"] })],
      wrapBridge: (inner) => ({
        ...inner,
        compactSession: async (id, opts) => {
          opts?.signal?.addEventListener("abort", () => {
            abortCalls.n += 1;
          });
          await compactHang;
          return inner.compactSession(id, opts);
        },
        continueSession: async (id, opts) => {
          continueCalls.n += 1;
          return inner.continueSession(id, opts);
        },
      }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("hi");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "seed");
    await app.typeText("/compact");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("正在压缩"),
      8000,
      "compacting"
    );
    await app.typeText("/continue");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes(continueNoticeFor("busy_stop_first")[0]!),
      8000,
      "busy-compact"
    );
    expect(continueCalls.n).toBe(0);
    expect(abortCalls.n).toBe(0);
    releaseCompact();
    await app.destroy();
  }, 30_000);

  test("Ctrl+C 仍打断前台 turn（continue 不是 abort 通道）", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "iknow-tui-ctrl-c-trace-"));
    const traceOut = join(traceDir, "trace.jsonl");
    const stderr = captureStderr();
    const app = await mountContinueApp({
      responses: [assistantResult({ texts: ["never"] })],
      deps: makeDeps([assistantResult({ texts: ["never"] })], {
        delayMs: 4000,
      }),
      traceOut,
    });
    try {
      await untilFrame(app.setup, (f) => f.includes("Version"));
      await app.typeText("go");
      await app.pressEnter();
      await until(() => app.bridge.inflight.ids().size === 1, 8000, "running");
      await app.pressCtrlC();
      await until(() => app.bridge.inflight.ids().size === 0, 8000, "aborted");
      await untilFrame(
        app.setup,
        (f) => f.includes("已打断"),
        8000,
        "interrupt-notice"
      );
      expect(stderr.lines.join("")).toContain(
        '"event":"ctrl_c","disposition":"abort_dispatched"'
      );
      const traceFiles = readdirSync(traceOut).filter((name) =>
        name.endsWith(".jsonl")
      );
      expect(traceFiles).toHaveLength(1);
      const records = readFileSync(join(traceOut, traceFiles[0]!), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              record_type?: string;
              decision?: string;
            }
        );
      expect(
        records.find((record) => record.record_type === "turn")?.decision
      ).toBe("cancelled");
    } finally {
      await app.destroy();
      stderr.restore();
    }
  }, 30_000);
});

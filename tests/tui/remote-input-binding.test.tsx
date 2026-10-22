/** @jsxImportSource @opentui/react */
/**
 * tests/tui/remote-input-binding.test.tsx
 *
 * App-side remote bindings (spec specs/remote-sync.md §4.3, plan task 5):
 * the TUI app binds the seat input port to the functions its keyboard already
 * uses, keeps remote messages on the same send / gap-queue / approval / abort
 * paths, publishes the active projection state and accepts a seat notice sink.
 *
 * Harness: real `createTuiBridge` over a temp data dir (no repository data /
 * session files). The input port itself is a typed fake — the real port has
 * its own test. Turns are held by a gated model adapter (latch), never by
 * timing assumptions.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createTuiAskUserBridge,
  type TuiAskUserBridge,
} from "../../src/tui/ask-user.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import {
  createRemoteInputPort,
  type RemoteInputBindings,
  type RemoteInputPort,
} from "../../src/tui/remote/input-port.js";
import {
  createSeatProjector,
  type ProjectionActiveState,
} from "../../src/tui/remote/projector.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import {
  createSessionGrants,
  type SessionGrants,
} from "../../src/harness/permission/session-grants.js";
import { createStubModel } from "../../src/harness/stubs/stub-model.js";
import type { LoopAdapter, LoopEngineDeps } from "../../src/harness/index.js";
import type { SeatEvent } from "../../src/remote-api/protocol.js";
import type { HubEvent } from "../../src/session-api/hub.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { composerText, emptyClipboardImageReader } from "./_fixtures.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Frame wait: state updates outside a key event need a render pass. */
async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000,
  label = ""
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await sleep(30);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(
    `untilFrame timeout (${label}):\n${setup.captureCharFrame()}`
  );
}

async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await sleep(25);
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A loop adapter whose N-th model call waits on the N-th latch. `signal`
 * abort rejects with the same DOMException shape the stub model uses, so an
 * abort ends the turn exactly like Esc's abort path. The stub model is spread
 * in to keep encodeUserText / streamMode available to the engine.
 */
function gatedDeps(opts: {
  readonly gates: ReadonlyArray<Promise<void>>;
  readonly texts: ReadonlyArray<string>;
  readonly onStep?: (index: number) => void;
}): LoopEngineDeps {
  const base = createStubModel({ responses: [] });
  let stepIndex = 0;
  const adapter: LoopAdapter = {
    ...base,
    step: async (_state, _request, signal) => {
      const index = stepIndex;
      stepIndex += 1;
      opts.onStep?.(index);
      await waitGate(opts.gates[index] ?? Promise.resolve(), signal);
      const text = opts.texts[index] ?? `reply-${index + 1}`;
      return assistantResult({ texts: [text] });
    },
  };
  return { ...makeDeps([]), adapter };
}

function waitGate(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (): void => {
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    if (signal?.aborted === true) {
      fail();
      return;
    }
    signal?.addEventListener("abort", fail, { once: true });
    void gate.then(() => {
      signal?.removeEventListener("abort", fail);
      resolve();
    });
  });
}

interface TestPort {
  readonly port: RemoteInputPort;
  readonly bindCalls: () => number;
  readonly unbindCalls: () => number;
  readonly bindings: () => RemoteInputBindings | undefined;
}

function fakePort(): TestPort {
  let binds = 0;
  let unbinds = 0;
  let current: RemoteInputBindings | undefined;
  const port: RemoteInputPort = {
    bind: (bindings) => {
      binds += 1;
      current = bindings;
      return () => {
        unbinds += 1;
        if (current === bindings) current = undefined;
      };
    },
    sendMessage: async () => ({
      ok: false,
      code: "not_ready",
      message: "fake port",
    }),
    answerApproval: async () => ({
      ok: false,
      code: "not_ready",
      message: "fake port",
    }),
    abort: async () => ({
      ok: false,
      code: "not_ready",
      message: "fake port",
    }),
  };
  return {
    port,
    bindCalls: () => binds,
    unbindCalls: () => unbinds,
    bindings: () => current,
  };
}

/** The real port behind the app's bindings, so the result mapping is exercised
 *  end to end (the fake above only records binding calls). */
function realPort(): TestPort {
  const inner = createRemoteInputPort();
  let binds = 0;
  let unbinds = 0;
  let current: RemoteInputBindings | undefined;
  const port: RemoteInputPort = {
    bind: (bindings) => {
      binds += 1;
      current = bindings;
      const unbind = inner.bind(bindings);
      return () => {
        unbinds += 1;
        if (current === bindings) current = undefined;
        unbind();
      };
    },
    sendMessage: (text, conversationId) =>
      inner.sendMessage(text, conversationId),
    answerApproval: (toolUseId, answer) =>
      inner.answerApproval(toolUseId, answer),
    abort: () => inner.abort(),
  };
  return {
    port,
    bindCalls: () => binds,
    unbindCalls: () => unbinds,
    bindings: () => current,
  };
}

interface MountOptions {
  readonly deps?: LoopEngineDeps;
  readonly port?: TestPort;
  readonly wrapBridge?: (bridge: TuiBridge) => TuiBridge;
  readonly projections?: Array<ProjectionActiveState | undefined>;
  /** When set, a real seat projector watches this app and pushes its events
   *  here; `onProjectionActive` feeds it exactly as run.tsx does. */
  readonly projectorEvents?: SeatEvent[];
  readonly noticeSink?: (show: (line: string) => void) => () => void;
}

interface MountedApp {
  readonly setup: TestRendererSetup;
  readonly port: TestPort;
  readonly bridge: TuiBridge;
  readonly askBridge: TuiAskUserBridge;
  readonly sessionGrants: SessionGrants;
  readonly events: HubEvent[];
  readonly bindings: RemoteInputBindings;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly destroy: () => Promise<void>;
}

async function mountRemote(options: MountOptions = {}): Promise<MountedApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-remote-"));
  const baseBridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: options.deps ?? makeDeps([]),
    inflight: createInflightRegistry(),
  });
  const bridge = options.wrapBridge?.(baseBridge) ?? baseBridge;
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  const port = options.port ?? fakePort();
  const events: HubEvent[] = [];
  const unsubscribeEvents = bridge.hub.subscribeEvents((event) => {
    events.push(event);
  });
  const projections = options.projections;
  const projectorEvents = options.projectorEvents;
  const projector =
    projectorEvents === undefined
      ? undefined
      : createSeatProjector({
          instanceId: "tui-remote-binding-test",
          hub: bridge.hub,
          askBridge,
          toolEventSink,
          loadTranscript: (conversationId) =>
            bridge.loadSessionFile(conversationId),
        });
  projector?.start();
  projector?.subscribeLive((event) => projectorEvents?.push(event));
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
      clipboardImageReader={emptyClipboardImageReader}
      remoteInputPort={port.port}
      onProjectionActive={(state) => {
        projections?.push(state);
        projector?.setActive(state);
      }}
      onRemoteNoticeSink={options.noticeSink}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed) {
          setupRef.renderer.destroy();
        }
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
  await untilFrame(setup, (f) => f.includes("Version"), 8000, "startup");
  await until(() => port.bindings() !== undefined, 8000, "remote input bind");
  const bindings = port.bindings();
  if (bindings === undefined) throw new Error("remote input port not bound");
  const typeText = async (text: string): Promise<void> => {
    setup.mockInput.pressKey("/");
    await untilFrame(
      setup,
      () => composerText(setup) === "/",
      8000,
      "slash-open"
    );
    for (let i = 0; i < 5; i++) {
      setup.mockInput.pressBackspace();
    }
    await untilFrame(
      setup,
      () => composerText(setup) === "",
      8000,
      "slash-clear"
    );
    for (const ch of text) {
      setup.mockInput.pressKey(ch);
    }
    await untilFrame(
      setup,
      () => composerText(setup) === text,
      8000,
      "typed-draft"
    );
  };
  return {
    setup,
    port,
    bridge,
    askBridge,
    sessionGrants,
    events,
    bindings,
    typeText,
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await setup.renderOnce();
      await setup.waitForVisualIdle();
    },
    destroy: async () => {
      unsubscribeEvents();
      if (!setup.renderer.isDestroyed) await setup.renderer.destroy();
      // React 19 flushes the unmount act on a later tick; the cleanup
      // assertions read effects, so wait for the binding cleanup to land.
      await until(
        () => port.bindings() === undefined,
        4000,
        "remote input unbind"
      );
      projector?.stop();
    },
  };
}

describe("remote input port binding", () => {
  test("mount 绑定 port（draft 会话 id 为 null），unmount 解绑", async () => {
    const port = fakePort();
    const app = await mountRemote({ port });
    expect(port.bindCalls()).toBe(1);
    expect(app.bindings.getActiveConversationId()).toBeNull();
    await app.destroy();
    expect(port.unbindCalls()).toBe(1);
    expect(port.bindings()).toBeUndefined();
  });

  test("空闲远程消息 → transcript 用户行 + composer 不动 + 远程 notice + origin remote", async () => {
    const app = await mountRemote({
      deps: makeDeps([assistantResult({ texts: ["答复"] })]),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"), 8000, "startup");
    await app.typeText("草稿");
    expect(composerText(app.setup)).toBe("草稿");

    const status = await app.bindings.sendMessage("远程消息", "remote");
    expect(status).toBe("sent");

    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("远程消息") && f.includes("远程输入：消息已发送"),
      8000,
      "remote-echo"
    );
    expect(frame).toContain("远程消息");
    expect(composerText(app.setup)).toBe("草稿");

    await until(
      () =>
        app.events.some(
          (event) =>
            event.kind === "user_message" &&
            event.text === "远程消息" &&
            event.origin === "remote"
        ),
      8000,
      "remote user_message origin"
    );
    const remoteEvent = app.events.find(
      (event) => event.kind === "user_message" && event.text === "远程消息"
    );
    expect(remoteEvent?.kind).toBe("user_message");
    if (remoteEvent?.kind === "user_message") {
      expect(app.bindings.getActiveConversationId()).toBe(
        remoteEvent.conversationId
      );
    }
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await app.destroy();
  }, 30_000);
});

describe("remote send refusal", () => {
  test("ensureSession 失败 → port 失败，无 transcript 行 / 队列项，composer 不动", async () => {
    const port = realPort();
    const app = await mountRemote({
      port,
      wrapBridge: (base) => ({
        ...base,
        ensureSession: async () => {
          throw new Error("synthetic ensure-session failure");
        },
      }),
    });
    await app.typeText("草稿");
    expect(composerText(app.setup)).toBe("草稿");

    expect(await port.port.sendMessage("远程失败消息")).toEqual({
      ok: false,
      code: "bad_request",
      message: "send_message failed in the TUI binding",
    });
    expect(await app.bindings.sendMessage("远程失败消息二", "remote")).toEqual({
      failed: true,
    });

    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("建档失败"),
      8000,
      "ensure-failure notice"
    );
    expect(frame).not.toContain("远程失败消息");
    expect(frame).not.toContain("queued 1");
    expect(composerText(app.setup)).toBe("草稿");
    expect(app.events.filter((event) => event.kind === "user_message")).toEqual(
      []
    );
    expect(app.bridge.inflight.ids().size).toBe(0);
    await app.destroy();
  }, 30_000);
});

describe("remote send during a live turn", () => {
  test("返回 queued，进入 gap 队列，边界处以 origin remote 运行", async () => {
    const gate = deferred();
    const firstStep = deferred();
    const app = await mountRemote({
      deps: gatedDeps({
        gates: [gate.promise],
        texts: ["答复一", "答复二"],
        onStep: (index) => {
          if (index === 0) firstStep.resolve();
        },
      }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"), 8000, "startup");

    await app.typeText("本地消息");
    await app.pressEnter();
    await firstStep.promise;
    expect(composerText(app.setup)).toBe("");

    const status = await app.bindings.sendMessage("远程消息", "remote");
    expect(status).toBe("queued");
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("queued 1") && f.includes("远程消息"),
      8000,
      "queued-line"
    );
    expect(frame).toContain("远程输入：消息已排队");
    expect(composerText(app.setup)).toBe("");

    gate.resolve();
    await until(
      () =>
        app.events.some(
          (event) =>
            event.kind === "user_message" &&
            event.text === "远程消息" &&
            event.origin === "remote"
        ),
      8000,
      "drained remote user_message origin"
    );
    await until(
      () => app.bridge.inflight.ids().size === 0,
      8000,
      "second turn done"
    );
    await untilFrame(app.setup, (f) => f.includes("答复二"), 8000, "reply-2");
    await app.destroy();
  }, 30_000);
});

describe("remote approval answers", () => {
  test("按 toolUseId 命中 pending ask；always 写入同一 tui-always grant；二次/未知 → not_pending", async () => {
    const app = await mountRemote();
    const ask = app.askBridge.ask({
      tool: "bash",
      input: { command: "ls" },
      summaryHint: "ls",
      toolUseId: "toolu_remote_1",
    });
    await until(
      () =>
        app.askBridge
          .pendingAll()
          .some((pending) => pending.toolUseId === "toolu_remote_1"),
      8000,
      "ask pending"
    );

    const outcome = await app.bindings.answerApproval(
      "toolu_remote_1",
      "always",
      "remote"
    );
    expect(outcome).toBe("ok");
    expect(await ask).toEqual({ kind: "approved" });
    expect(app.sessionGrants.list().map((rule) => rule.id)).toContain(
      "tui-always-bash"
    );

    expect(
      await app.bindings.answerApproval("toolu_remote_1", "once", "remote")
    ).toBe("not_pending");
    expect(
      await app.bindings.answerApproval("toolu_missing", "once", "remote")
    ).toBe("not_pending");
    await app.destroy();
  }, 30_000);
});

describe("remote abort", () => {
  test("进行中的 turn 返回 interrupted true 并像 Esc 一样停止前台 turn", async () => {
    const gate = deferred();
    const firstStep = deferred();
    const foregroundAborts: string[] = [];
    const app = await mountRemote({
      deps: gatedDeps({
        gates: [gate.promise],
        texts: ["答复"],
        onStep: (index) => {
          if (index === 0) firstStep.resolve();
        },
      }),
      wrapBridge: (base) => ({
        ...base,
        abortSessionForegroundWork: (conversationId) => {
          foregroundAborts.push(conversationId);
          return base.abortSessionForegroundWork(conversationId);
        },
      }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"), 8000, "startup");

    expect(await app.bindings.abort()).toEqual({ interrupted: false });
    expect(foregroundAborts).toHaveLength(0);

    await app.typeText("本地消息");
    await app.pressEnter();
    await firstStep.promise;

    expect(await app.bindings.abort()).toEqual({ interrupted: true });
    await until(
      () => app.bridge.inflight.ids().size === 0,
      8000,
      "aborted turn settled"
    );
    expect(foregroundAborts.length).toBeGreaterThan(0);
    const ended = app.events.find((event) => event.kind === "turn_ended");
    expect(ended?.kind).toBe("turn_ended");
    if (ended?.kind === "turn_ended") {
      expect(ended.outcome.terminal).toBe("known");
      if (ended.outcome.terminal === "known") {
        expect(ended.outcome.stopReason).toBe("cancelled");
      }
    }
    await app.destroy();
  }, 30_000);
});

describe("projection active publishing", () => {
  test("active conversation / running / queued 变化发布，unmount 发 undefined", async () => {
    const gate = deferred();
    const firstStep = deferred();
    const projections: Array<ProjectionActiveState | undefined> = [];
    const app = await mountRemote({
      deps: gatedDeps({
        gates: [gate.promise],
        texts: ["答复一", "答复二"],
        onStep: (index) => {
          if (index === 0) firstStep.resolve();
        },
      }),
      projections,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"), 8000, "startup");
    await until(
      () => projections.length > 0,
      4000,
      "initial projection publish"
    );
    expect(projections[0]).toEqual({
      conversationId: null,
      running: false,
      queued: 0,
    });

    expect(await app.bindings.sendMessage("启动", "remote")).toBe("sent");
    await firstStep.promise;
    await until(
      () =>
        projections.some(
          (state) => state !== undefined && state.conversationId !== null
        ),
      8000,
      "active conversation published"
    );
    await until(
      () =>
        projections.some(
          (state) => state !== undefined && state.running === true
        ),
      8000,
      "running published"
    );

    expect(await app.bindings.sendMessage("排队", "remote")).toBe("queued");
    await until(
      () =>
        projections.some((state) => state !== undefined && state.queued === 1),
      8000,
      "queued published"
    );

    gate.resolve();
    await until(
      () => app.bridge.inflight.ids().size === 0,
      8000,
      "turns settled"
    );
    await until(
      () => {
        const last = projections[projections.length - 1];
        return (
          last !== undefined && last.running === false && last.queued === 0
        );
      },
      8000,
      "idle projection published"
    );

    await app.destroy();
    expect(projections[projections.length - 1]).toBeUndefined();
  }, 30_000);
});

describe("seat projector ordering", () => {
  test("草稿建档先切换 active，再转发该会话的 user_message / turn_started / turn_ended", async () => {
    const projectorEvents: SeatEvent[] = [];
    const gate = deferred();
    const firstStep = deferred();
    const app = await mountRemote({
      deps: gatedDeps({
        gates: [gate.promise],
        texts: ["答复"],
        onStep: (index) => {
          if (index === 0) firstStep.resolve();
        },
      }),
      projectorEvents,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"), 8000, "startup");
    // The mount effect publishes the draft baseline; the projector records it
    // as the starting point, not as a switch, so nothing is emitted yet.
    expect(projectorEvents).toEqual([]);

    expect(await app.bindings.sendMessage("远程启动", "remote")).toBe("sent");
    await firstStep.promise;

    const hubUser = app.events.find(
      (event) => event.kind === "user_message" && event.text === "远程启动"
    );
    expect(hubUser?.kind).toBe("user_message");
    if (hubUser?.kind !== "user_message") throw new Error("no user_message");
    const conversationId = hubUser.conversationId;

    // The live defect: the projector was still on the draft when the hub
    // published the turn's first events, so it dropped them and emitted
    // active_changed afterwards. The switch must land before them.
    const projected = projectorEvents.map((event) => event.event);
    const activeIndex = projected.findIndex(
      (event) => event.kind === "active_changed"
    );
    const userIndex = projected.findIndex(
      (event) => event.kind === "user_message" && event.text === "远程启动"
    );
    const startIndex = projected.findIndex(
      (event) => event.kind === "turn_started"
    );
    expect(activeIndex).toBe(0);
    expect(projected[activeIndex]).toEqual({
      kind: "active_changed",
      conversationId,
    });
    expect(userIndex).toBeGreaterThan(activeIndex);
    expect(projected[userIndex]).toEqual({
      kind: "user_message",
      text: "远程启动",
      origin: "remote",
    });
    expect(startIndex).toBeGreaterThan(userIndex);
    expect(projectorEvents[startIndex]?.conversationId).toBe(conversationId);

    await untilFrame(
      app.setup,
      (f) => f.includes("远程启动"),
      8000,
      "remote echo"
    );
    expect(await app.bindings.abort()).toEqual({ interrupted: true });
    await until(
      () => app.bridge.inflight.ids().size === 0,
      8000,
      "aborted turn settled"
    );
    await until(
      () => projectorEvents.some((event) => event.event.kind === "turn_ended"),
      8000,
      "turn_ended projected"
    );
    const endedIndex = projectorEvents.findIndex(
      (event) => event.event.kind === "turn_ended"
    );
    expect(endedIndex).toBeGreaterThan(startIndex);
    expect(projectorEvents[endedIndex]?.conversationId).toBe(conversationId);
    const ended = projectorEvents[endedIndex]?.event;
    if (ended?.kind === "turn_ended") {
      expect(ended.status).toBe("cancelled");
    }
    await app.destroy();
  }, 30_000);
});

describe("remote notice sink", () => {
  test("sink 行出现在 notice lane，unmount 执行 cleanup", async () => {
    let cleaned = false;
    const app = await mountRemote({
      noticeSink: (show) => {
        show("远程输入：座位通知");
        return () => {
          cleaned = true;
        };
      },
    });
    await untilFrame(
      app.setup,
      (f) => f.includes("远程输入：座位通知"),
      8000,
      "sink notice"
    );
    expect(cleaned).toBe(false);
    await app.destroy();
    expect(cleaned).toBe(true);
  }, 30_000);
});

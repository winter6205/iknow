/** @jsxImportSource @opentui/react */
/**
 * tests/tui/model-command-session-route.test.tsx
 *
 * ADR-0145: a conversation owns its model route; `settings.llm.model` is only
 * the DEFAULT for conversations started later.
 *
 * What this file pins (the TUI side only — the hub's own route resolution and
 * isolation are the sibling task's):
 *  - the act: the CURRENT conversation's route is set FIRST (the hub's
 *    `setSessionModel`), then the default is written; a route that does not
 *    resolve changes nothing (the default is NOT written either);
 *  - a draft (no conversation yet) has no route to set — the default write
 *    still happens (the draft's first turn inherits it);
 *  - the display follows the CURRENT conversation's route: the status bar,
 *    `/info`'s Model row and the `/model` cursor;
 *  - switching conversations switches the displayed route.
 *
 * Real bridge/hub + stub deps (makeDeps) + real TUI renderer — the same
 * harness pattern as model-command.test.tsx, extended with an initial session
 * (so a conversation can own a route before any turn ran).
 */
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  TuiApp,
  createToolEventSink,
  type TuiAppProps,
} from "../../src/tui/app.js";
import {
  createEnvDisplayStore,
  type EnvDisplaySeed,
} from "../../src/tui/env-display-store.js";
import type { DefaultThinkingShape } from "../../src/tui/thinking-gate.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { attachSession } from "../../src/tui/session-state.js";
import { persistModelAct } from "../../src/tui/persist-model-act.js";
import { loadIknowEnv, type IknowEnv } from "../../src/config/env.js";
import type { IknowSettingsLlmProvider } from "../../src/config/settings.js";
import {
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
  type SessionFileV1,
} from "../../src/session-api/store/index.js";
import { makeDeps, assistantResult } from "../cli/_fixtures.ts";
import type { LoopEngineDeps } from "../../src/harness/index.js";

/** thinking baseline: off + no tier (same shape as the old absent `props.defaultThinking`). */
const BASELINE_OFF: DefaultThinkingShape = { mode: "off", effort: "" };

/** Two synthetic providers — four routes, so every display assertion can name
 *  exactly which route it sees (the conversation's own, the default, or the
 *  one just picked). */
const PROVIDERS: ReadonlyArray<IknowSettingsLlmProvider> = [
  {
    id: "prov-a",
    baseUrl: "https://example.invalid/prov-a",
    apiKeyEnv: "IKNOW_TEST_PROV_A_KEY",
    models: [
      { id: "model-1", name: "Model One" },
      { id: "model-2", name: "Model Two" },
    ],
  },
  {
    id: "prov-b",
    baseUrl: "https://example.invalid/prov-b",
    apiKeyEnv: "IKNOW_TEST_PROV_B_KEY",
    models: [
      { id: "model-3", name: "Model Three" },
      { id: "model-4", name: "Model Four" },
    ],
  },
];

/** The route conversation A owns (picker entry 1). */
const ROUTE_A = "prov-a/model-2";
/** The route conversation B owns (picker entry 2). */
const ROUTE_B = "prov-b/model-3";
/** The default for conversations started later (picker entry 0). */
const ROUTE_DEFAULT = "prov-a/model-1";
/** The route A picks in the picker (entry 3) — distinct from all three above. */
const ROUTE_PICKED = "prov-b/model-4";

const CONV_A = "conv-A";
const CONV_B = "conv-B";

/** The reason the default write fails with (the settings file is read-only). */
const WRITE_FAILURE_REASON = "settings.json 不可写";

/** The api-key env vars of the synthetic providers (the env loader resolves
 *  the default route's key from the provider's apiKeyEnv). */
const PROV_A_KEY_ENV = "IKNOW_TEST_PROV_A_KEY";
const PROV_B_KEY_ENV = "IKNOW_TEST_PROV_B_KEY";

/** The typed error the hub throws for a route that does not resolve (a plain
 *  object, not an Error — the typed-error catch contract). */
const ROUTE_ERROR = {
  kind: "provider_model_not_registered" as const,
  model: "prov-x/model-9",
};
const ROUTE_ERROR_TEXT =
  "provider_model_not_registered: prov-x/model-9 (not in llm.providers)";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function sessionFile(
  id: string,
  model: string | undefined,
  workspaceRoot: string,
  title = ""
): SessionFileV1 {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title,
    cwd: workspaceRoot,
    sanitized_at: "2026-01-01T00:00:00.000Z",
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    checkpoints: [],
    nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
    workspaceRoot,
    ...(model !== undefined ? { model } : {}),
  };
}

interface Mounted {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => void;
  readonly dataDir: string;
  /** Publish point for the host-env-derived display snapshot (the default model). */
  readonly store: ReturnType<typeof createEnvDisplayStore>;
  readonly publish: (seed: EnvDisplaySeed) => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  readonly pressSpace: () => Promise<void>;
  readonly pressArrow: (dir: "up" | "down") => Promise<void>;
}

/** The hub's env: `llm.model` is the tier a NEW conversation starts with
 *  (ADR-0145 §2) — the route the hub stamps on the conversation it creates.
 *  Built through the production loader with an injected settings object, so
 *  the route registry travels with the env. */
function hubEnv(cwd: string, defaultRoute: string): IknowEnv {
  return loadIknowEnv(cwd, {
    llm: { model: defaultRoute, providers: [...PROVIDERS] },
  });
}

/** Mount the real TUI app over a real bridge on a temp dir (same harness
 *  pattern as model-command.test.tsx; extended with an initial session so a
 *  conversation can own a route before any turn ran). */
async function mountAsync(opts: {
  readonly dataDir?: string;
  readonly providers?: ReadonlyArray<IknowSettingsLlmProvider>;
  readonly env?: EnvDisplaySeed;
  readonly onPersistModel?: TuiAppProps["onPersistModel"];
  readonly initialSession?: TuiAppProps["initialSession"];
  /** The hub's env source (the tier a new conversation starts with). */
  readonly hubEnvProvider?: () => IknowEnv;
  /** The harness deps (the stub model answers the turn). */
  readonly deps?: LoopEngineDeps;
}): Promise<Mounted> {
  const dataDir =
    opts.dataDir ?? mkdtempSync(join(tmpdir(), "iknow-tui-route-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: opts.deps ?? makeDeps([]),
    inflight: createInflightRegistry(),
    ...(opts.hubEnvProvider !== undefined
      ? { envProvider: opts.hubEnvProvider }
      : {}),
  });
  const store = createEnvDisplayStore(
    opts.env ?? { model: undefined, defaultThinking: undefined }
  );
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
      envDisplay={store}
      {...(opts.providers !== undefined ? { providers: opts.providers } : {})}
      {...(opts.onPersistModel !== undefined
        ? { onPersistModel: opts.onPersistModel }
        : {})}
      {...(opts.initialSession !== undefined
        ? { initialSession: opts.initialSession }
        : {})}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    {
      width: 90,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
    }
  );
  setupRef = setup;
  await sleep(500);
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    dataDir,
    store,
    publish: async (seed) => {
      await act(async () => {
        store.publish(seed);
      });
      await setup.renderOnce();
    },
    typeText: async (text: string) => {
      setup.mockInput.pressKey("/");
      await sleep(100);
      await setup.renderOnce();
      for (let i = 0; i < 5; i++) {
        setup.mockInput.pressBackspace();
        await sleep(30);
      }
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await sleep(30);
      }
      await sleep(100);
      await setup.renderOnce();
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await sleep(100);
      await setup.renderOnce();
    },
    pressEscape: async () => {
      setup.mockInput.pressEscape();
      await sleep(100);
      await setup.renderOnce();
    },
    pressSpace: async () => {
      setup.mockInput.pressKey(" ");
      await sleep(100);
      await setup.renderOnce();
    },
    pressArrow: async (dir) => {
      setup.mockInput.pressArrow(dir);
      await sleep(100);
      await setup.renderOnce();
    },
  };
}

async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000,
  label = ""
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await sleep(50);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(
    `untilFrame timeout (${label}):\n${setup.captureCharFrame()}`
  );
}

/** The status-bar line (the one carrying the "ctx" marker). */
function statusBarLine(frame: string): string {
  const line = frame.split("\n").find((l) => l.includes("ctx"));
  if (line === undefined) {
    throw new Error(`no status bar line in frame:\n${frame}`);
  }
  return line;
}

/** Open the /model picker and move the cursor `steps` entries down. */
async function pickRoute(app: Mounted, steps: number): Promise<void> {
  await app.typeText("/model");
  await app.pressEnter();
  await untilFrame(
    app.setup,
    (f) => f.includes("prov-a/model-1"),
    8000,
    "/model picker opens"
  );
  for (let i = 0; i < steps; i++) {
    await app.pressArrow("down");
  }
  await app.pressEnter();
}

describe("/model act 的顺序与失败语义（ADR-0145 §5）", () => {
  test("先设置本会话的路由，再写默认值", async () => {
    const order: string[] = [];
    const res = await persistModelAct({
      conversationId: CONV_A,
      route: ROUTE_PICKED,
      setSessionModel: async (id, route) => {
        order.push(`route:${id}:${route}`);
      },
      writeDefault: async () => {
        order.push("default");
        return { ok: true as const };
      },
    });
    expect(res).toEqual({ ok: true });
    expect(order).toEqual([`route:${CONV_A}:${ROUTE_PICKED}`, "default"]);
  });

  test("路由解析失败 → 默认值不写，结果 stage=route", async () => {
    let defaultWritten = false;
    const res = await persistModelAct({
      conversationId: CONV_A,
      route: "prov-x/model-9",
      setSessionModel: async () => {
        throw ROUTE_ERROR;
      },
      writeDefault: async () => {
        defaultWritten = true;
        return { ok: true as const };
      },
    });
    expect(defaultWritten).toBe(false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("route");
    expect(res.reason).toBe(ROUTE_ERROR_TEXT);
  });

  test("draft（无会话）→ 跳过路由设置，默认值照写", async () => {
    const order: string[] = [];
    const res = await persistModelAct({
      conversationId: undefined,
      route: ROUTE_PICKED,
      setSessionModel: async (id, route) => {
        order.push(`route:${id}:${route}`);
      },
      writeDefault: async () => {
        order.push("default");
        return { ok: true as const };
      },
    });
    expect(res).toEqual({ ok: true });
    expect(order).toEqual(["default"]);
  });

  test("默认值写失败 → 路由已生效（会话保留新路由），结果 stage=write", async () => {
    const routeCalls: Array<{ id: string; route: string }> = [];
    const res = await persistModelAct({
      conversationId: CONV_A,
      route: ROUTE_PICKED,
      setSessionModel: async (id, route) => {
        routeCalls.push({ id, route });
      },
      writeDefault: async () => ({
        ok: false as const,
        stage: "write" as const,
        reason: WRITE_FAILURE_REASON,
      }),
    });
    // Step 1 ran first: the conversation's route WAS set, so the conversation
    // keeps the new route (spec §4: "2 fails after 1 → C keeps its new route").
    expect(routeCalls).toEqual([{ id: CONV_A, route: ROUTE_PICKED }]);
    // The act reports the default-write failure (not a route failure).
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("write");
    expect(res.reason).toBe(WRITE_FAILURE_REASON);
  });
});

describe("/model 跟随当前会话的路由（ADR-0145）", () => {
  test("状态栏 / /info / 选择器光标显示会话自己的路由，而不是默认值", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-route-"));
    const app = await mountAsync({
      dataDir,
      providers: PROVIDERS,
      env: { model: ROUTE_DEFAULT, defaultThinking: BASELINE_OFF },
      initialSession: attachSession(sessionFile(CONV_A, ROUTE_A, dataDir)),
    });
    try {
      const frame = await untilFrame(
        app.setup,
        (f) => f.includes("Model Two"),
        8000,
        "status bar shows the conversation's own route"
      );
      // The status bar shows the conversation's own route ("Model Two"), not
      // the default the env store carries ("Model One").
      expect(statusBarLine(frame)).toContain("Model Two");
      expect(statusBarLine(frame)).not.toContain("Model One");

      // /info's Model row is the conversation's route.
      await app.typeText("/info");
      await app.pressEnter();
      const infoFrame = await untilFrame(
        app.setup,
        (f) => f.includes("Model:"),
        8000,
        "/info shows the Model row"
      );
      expect(infoFrame).toContain(`Model: ${ROUTE_A}`);
      expect(infoFrame).not.toContain(`Model: ${ROUTE_DEFAULT}`);

      // The /model cursor seeds on the conversation's own entry.
      await app.pressEscape();
      await app.typeText("/model");
      await app.pressEnter();
      const pickerFrame = await untilFrame(
        app.setup,
        (f) => f.includes(ROUTE_A),
        8000,
        "/model picker opens"
      );
      const focused = pickerFrame.split("\n").find((l) => l.includes("▸"));
      expect(focused).toContain(ROUTE_A);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("选中 → 先调 hub.setSessionModel(A, route) 再写默认值；显示立即跟随", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-route-"));
    const order: string[] = [];
    const hubCalls: Array<{ id: string; route: string }> = [];
    const defaultWrites: string[] = [];
    let bridgeRef: TuiBridge | undefined;
    // The host's act (run.tsx's wiring) against the REAL hub: the hub's route
    // setter is spied, so the test pins the TUI's plumbing (the active
    // conversation's id + the order), not the hub's own resolution.
    const onPersistModel: NonNullable<TuiAppProps["onPersistModel"]> = (
      patch,
      conversationId
    ) =>
      persistModelAct({
        conversationId,
        route: patch.model,
        setSessionModel: async (id, route) => {
          if (bridgeRef === undefined) throw new Error("bridge not ready");
          await bridgeRef.hub.setSessionModel(id, route);
        },
        writeDefault: async () => {
          order.push("default");
          defaultWrites.push(patch.model);
          return { ok: true as const };
        },
      });
    const app = await mountAsync({
      dataDir,
      providers: PROVIDERS,
      env: { model: ROUTE_DEFAULT, defaultThinking: BASELINE_OFF },
      initialSession: attachSession(sessionFile(CONV_A, ROUTE_A, dataDir)),
      onPersistModel,
    });
    bridgeRef = app.bridge;
    // Spy on the hub's route setter (the hub's own resolution is the sibling
    // task's; here only the call itself is observed).
    app.bridge.hub.setSessionModel = async (
      id: string,
      route: string
    ): Promise<void> => {
      order.push(`route:${id}`);
      hubCalls.push({ id, route });
    };
    try {
      await untilFrame(
        app.setup,
        (f) => f.includes("Model Two"),
        8000,
        "status bar shows the conversation's own route"
      );
      // Entry 3 (prov-b/model-4): the cursor starts on the conversation's own
      // entry (1), so three ↓ land on the fourth row.
      await pickRoute(app, 3);

      // The hub's route setter got the ACTIVE conversation's id, and it ran
      // BEFORE the default write.
      expect(hubCalls).toEqual([{ id: CONV_A, route: ROUTE_PICKED }]);
      expect(order).toEqual([`route:${CONV_A}`, "default"]);
      expect(defaultWrites).toEqual([ROUTE_PICKED]);

      // The display follows the new route right away — no env publish needed.
      const frame = await untilFrame(
        app.setup,
        (f) => f.includes("Model Four"),
        8000,
        "status bar follows the picked route"
      );
      expect(statusBarLine(frame)).toContain("Model Four");
      expect(statusBarLine(frame)).not.toContain("Model Two");

      await app.typeText("/info");
      await app.pressEnter();
      const infoFrame = await untilFrame(
        app.setup,
        (f) => f.includes("Model:"),
        8000,
        "/info shows the Model row"
      );
      expect(infoFrame).toContain(`Model: ${ROUTE_PICKED}`);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("切换会话后显示切换到的会话自己的路由", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-route-"));
    const app = await mountAsync({
      dataDir,
      providers: PROVIDERS,
      env: { model: ROUTE_DEFAULT, defaultThinking: BASELINE_OFF },
      initialSession: attachSession(sessionFile(CONV_A, ROUTE_A, dataDir)),
    });
    try {
      await untilFrame(
        app.setup,
        (f) => f.includes("Model Two"),
        8000,
        "status bar shows the conversation's own route"
      );

      // Seed conversation B in the store (with its own route) so the list can
      // open it.
      await app.bridge.store.save({
        id: CONV_B,
        file: sessionFile(CONV_B, ROUTE_B, dataDir, "seeded question"),
      });
      await app.bridge.store.appendEvents({
        id: CONV_B,
        events: [
          {
            role: "user",
            content: [{ type: "text", text: "seeded question" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "seeded answer" }],
          },
        ],
      });

      await app.typeText("/sessions");
      await app.pressEnter();
      await untilFrame(
        app.setup,
        (f) => f.includes("seeded question"),
        8000,
        "/sessions list shows the seeded session"
      );
      // Row 0 is "new session"; ↓ moves onto the first session (B), Enter
      // opens it.
      await app.pressArrow("down");
      await app.pressEnter();

      const frame = await untilFrame(
        app.setup,
        (f) => f.includes("Model Three"),
        8000,
        "status bar follows the opened conversation"
      );
      expect(statusBarLine(frame)).toContain("Model Three");
      expect(statusBarLine(frame)).not.toContain("Model Two");

      await app.typeText("/info");
      await app.pressEnter();
      const infoFrame = await untilFrame(
        app.setup,
        (f) => f.includes("Model:"),
        8000,
        "/info shows the Model row"
      );
      expect(infoFrame).toContain(`Model: ${ROUTE_B}`);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("路由解析失败 → 默认值不写，提示未切换，仍显示旧路由", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-route-"));
    const order: string[] = [];
    const defaultWrites: string[] = [];
    let bridgeRef: TuiBridge | undefined;
    const onPersistModel: NonNullable<TuiAppProps["onPersistModel"]> = (
      patch,
      conversationId
    ) =>
      persistModelAct({
        conversationId,
        route: patch.model,
        setSessionModel: async (id, route) => {
          if (bridgeRef === undefined) throw new Error("bridge not ready");
          await bridgeRef.hub.setSessionModel(id, route);
        },
        writeDefault: async () => {
          order.push("default");
          defaultWrites.push(patch.model);
          return { ok: true as const };
        },
      });
    const app = await mountAsync({
      dataDir,
      providers: PROVIDERS,
      env: { model: ROUTE_DEFAULT, defaultThinking: BASELINE_OFF },
      initialSession: attachSession(sessionFile(CONV_A, ROUTE_A, dataDir)),
      onPersistModel,
    });
    bridgeRef = app.bridge;
    // The hub's route setter rejects with the typed error (a route that does
    // not resolve) — the hub changes nothing.
    app.bridge.hub.setSessionModel = async (): Promise<void> => {
      throw ROUTE_ERROR;
    };
    try {
      await untilFrame(
        app.setup,
        (f) => f.includes("Model Two"),
        8000,
        "status bar shows the conversation's own route"
      );
      await pickRoute(app, 2);

      const frame = await untilFrame(
        app.setup,
        (f) => f.includes("not switched"),
        8000,
        "the route failure notice shows"
      );
      expect(frame).toContain(ROUTE_ERROR_TEXT);
      expect(frame).not.toContain("Model switched (this session)");
      // The default was NOT written (the route did not resolve).
      expect(defaultWrites).toEqual([]);
      expect(order).toEqual([]);
      // The conversation kept its old route.
      expect(statusBarLine(frame)).toContain("Model Two");
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("默认值写失败 → 提示报写失败，会话保留新路由（显示跟随新路由）", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-route-"));
    const hubCalls: Array<{ id: string; route: string }> = [];
    let bridgeRef: TuiBridge | undefined;
    const onPersistModel: NonNullable<TuiAppProps["onPersistModel"]> = (
      patch,
      conversationId
    ) =>
      persistModelAct({
        conversationId,
        route: patch.model,
        setSessionModel: async (id, route) => {
          if (bridgeRef === undefined) throw new Error("bridge not ready");
          await bridgeRef.hub.setSessionModel(id, route);
        },
        writeDefault: async () => ({
          ok: false as const,
          stage: "write" as const,
          reason: WRITE_FAILURE_REASON,
        }),
      });
    const app = await mountAsync({
      dataDir,
      providers: PROVIDERS,
      env: { model: ROUTE_DEFAULT, defaultThinking: BASELINE_OFF },
      initialSession: attachSession(sessionFile(CONV_A, ROUTE_A, dataDir)),
      onPersistModel,
    });
    bridgeRef = app.bridge;
    // The hub's route setter is spied (the hub's own resolution is the
    // sibling task's; here only the call itself is observed).
    app.bridge.hub.setSessionModel = async (
      id: string,
      route: string
    ): Promise<void> => {
      hubCalls.push({ id, route });
    };
    try {
      await untilFrame(
        app.setup,
        (f) => f.includes("Model Two"),
        8000,
        "status bar shows the conversation's own route"
      );
      await pickRoute(app, 3);

      // The route WAS set (the act's first step ran before the default write
      // failed) — the conversation keeps the new route.
      expect(hubCalls).toEqual([{ id: CONV_A, route: ROUTE_PICKED }]);

      // The act reports the default-write failure...
      const frame = await untilFrame(
        app.setup,
        (f) => f.includes("failed to write settings.json"),
        8000,
        "the write failure notice shows"
      );
      expect(frame).toContain("Model switched (this session), but");
      expect(frame).toContain(WRITE_FAILURE_REASON);
      // ...and the display follows the route the conversation KEEPS.
      expect(statusBarLine(frame)).toContain("Model Four");
      expect(statusBarLine(frame)).not.toContain("Model Two");
    } finally {
      app.destroy();
    }
  }, 30_000);
});

describe("TUI 从 hub 学会话自己的路由（ADR-0145）", () => {
  test("TUI 内新建的会话：显示它自己的路由，默认值移动后仍然跟随", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-route-"));
    const envCwd = mkdtempSync(join(tmpdir(), "iknow-tui-route-env-"));
    process.env[PROV_A_KEY_ENV] = "test-key-a";
    process.env[PROV_B_KEY_ENV] = "test-key-b";
    const app = await mountAsync({
      dataDir,
      providers: PROVIDERS,
      // The display snapshot carries the DEFAULT (Model One)...
      env: { model: ROUTE_DEFAULT, defaultThinking: BASELINE_OFF },
      // ...while the hub's tier — the route a NEW conversation starts with — is
      // Model Two. The conversation the draft becomes owns THAT route, so the
      // display must follow it instead of the default.
      hubEnvProvider: () => hubEnv(envCwd, ROUTE_A),
      // A hanging stub answer: the turn is still running when the assertion
      // lands, so the route can only come from the TUI's own state (the hub's
      // route it learned at the remap) — not from a finished turn's file. The
      // turn is aborted in the teardown.
      deps: makeDeps([assistantResult({ texts: ["ok"] })], { delayMs: 60_000 }),
    });
    try {
      // Before the first message there is no conversation yet → the default.
      const draft = await untilFrame(
        app.setup,
        (f) => f.includes("Model One"),
        8000,
        "the draft shows the default"
      );
      expect(statusBarLine(draft)).toContain("Model One");

      // The first message materializes the conversation: the hub stamps its
      // route, and the TUI must learn that route from the hub.
      await app.typeText("hello");
      await app.pressEnter();
      const owned = await untilFrame(
        app.setup,
        (f) => f.includes("Model Two"),
        8000,
        "the conversation shows its own route"
      );
      expect(statusBarLine(owned)).toContain("Model Two");
      expect(statusBarLine(owned)).not.toContain("Model One");

      // The default moves (another conversation's /model act writes
      // settings.json): the conversation keeps ITS route, so does the display.
      await app.publish({
        model: ROUTE_PICKED,
        defaultThinking: BASELINE_OFF,
      });
      const moved = await untilFrame(
        app.setup,
        (f) => f.includes("Model Two"),
        8000,
        "the conversation keeps its own route"
      );
      expect(statusBarLine(moved)).toContain("Model Two");
      expect(statusBarLine(moved)).not.toContain("Model Four");

      // /info's Model row is the conversation's own route too.
      await app.typeText("/info");
      await app.pressEnter();
      const infoFrame = await untilFrame(
        app.setup,
        (f) => f.includes("Model:"),
        8000,
        "/info shows the Model row"
      );
      expect(infoFrame).toContain(`Model: ${ROUTE_A}`);
      expect(infoFrame).not.toContain(`Model: ${ROUTE_PICKED}`);
    } finally {
      // Abort the hanging turn (its stub answer never arrives), then tear down.
      await app.pressEscape();
      app.destroy();
      delete process.env[PROV_A_KEY_ENV];
      delete process.env[PROV_B_KEY_ENV];
    }
  }, 30_000);
});

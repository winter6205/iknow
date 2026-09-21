/** @jsxImportSource @opentui/react */
/**
 * Graph mode at the TUI entry: `/graph` and Shift+Tab are equivalent paths.
 *
 * Three layers:
 *   1. vocabulary: `/graph` joins the TUI's own slash vocabulary
 *      (parse / candidates / help rows);
 *   2. application: `/graph on|off` and Shift+Tab flip the **same** holder —
 *      the test injects the holder and reads it directly, proving the two
 *      paths don't keep separate state;
 *   3. status line: in Graph mode the mode row shows Graph (the pre-entry
 *      permission is never rewritten).
 *
 * The render layer drives via testRender as in app.test.tsx (bun:test),
 * because what must be proven is exactly the real path: "the user types this
 * line / presses this key in the TUI".
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { buildTuiDeps } from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { createGraphAssembly } from "../../src/harness/graph/assembly.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";
import {
  createGraphModeContext,
  type GraphModeContext,
} from "../../src/harness/graph/mode.js";
import {
  helpLines,
  parseTuiInput,
  slashSuggestions,
} from "../../src/tui/slash.js";
import type { PermissionModeContext } from "../../src/harness/permission/modes.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

/** buildTuiDeps reads only the env field (same minimal bundle as tests/tui/deps-tools.test.ts). */
function makeTuiBundle(): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-sentinel-graph",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
  return { env } as unknown as RuntimeBundle;
}

describe("TUI 词表：/graph", () => {
  test("parseTuiInput 认 /graph（带参也命中同一命令）", () => {
    expect(parseTuiInput("/graph")).toEqual({
      kind: "command",
      command: "graph",
    });
    expect(parseTuiInput("/graph on")).toEqual({
      kind: "command",
      command: "graph",
    });
  });

  test('"/g" 前缀候选命中 graph', () => {
    expect(slashSuggestions("/g")).toEqual([
      { kind: "command", command: "graph" },
    ]);
  });

  test("helpLines 列出 /graph", () => {
    expect(helpLines().join("\n")).toContain("/graph");
  });
});

describe("TUI 装配：holder → 装配快照 → hub round", () => {
  test("buildTuiDeps 带 graphMode → 透出 graphAssembly（露不露 run_graph 由它的快照决定）", async () => {
    const root = mkdtempSync(join(tmpdir(), "iknow-tui-graph-deps-"));
    try {
      const mode = createGraphModeContext();
      const built = await buildTuiDeps(makeTuiBundle(), {
        askUser: createNoAskUser(),
        userHome: join(root, "home"),
        cwd: root,
        graphMode: mode,
      });
      expect(built.graphAssembly).toBeDefined();
      // Assembled while off → this round's snapshot is off; flipping on only takes effect at the next beginRound.
      expect(built.graphAssembly!.enabled()).toBe(false);
      mode.setEnabled(true);
      expect(built.graphAssembly!.enabled()).toBe(false);
      expect(built.graphAssembly!.beginRound()).toBe(true);
      if (built.shutdown) await built.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("bridge 把 graphAssembly 交给 hub：每条 postMessage 拍一次快照", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-graph-bridge-"));
    const mode = createGraphModeContext();
    const graphAssembly = createGraphAssembly(mode);
    const bridge = createTuiBridge({
      dataDir,
      workspaceRoot: dataDir,
      deps: makeDeps([
        assistantResult({ texts: ["one"] }),
        assistantResult({ texts: ["two"] }),
      ]),
      inflight: createInflightRegistry(),
      graphAssembly,
    });
    const id = await bridge.ensureSession(undefined);

    mode.setEnabled(true);
    await bridge.postMessage({ conversationId: id, text: "first" });
    expect(graphAssembly.enabled()).toBe(true);

    mode.setEnabled(false);
    await bridge.postMessage({ conversationId: id, text: "second" });
    expect(graphAssembly.enabled()).toBe(false);
  }, 30_000);
});

interface DrivenApp {
  readonly setup: TestRendererSetup;
  readonly destroy: () => void;
  readonly typeText: (text: string) => Promise<void>;
  readonly typeQuery: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressTab: () => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  readonly pressShiftTab: () => Promise<void>;
  readonly pressCtrlC: () => Promise<void>;
}

async function mountApp(opts: {
  readonly permissionMode: PermissionModeContext;
  readonly graphMode: GraphModeContext;
  readonly streamEventsByStep?: ReadonlyArray<
    ReadonlyArray<HarnessStreamEvent>
  >;
}): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-graph-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: ["ok"] })], {
      streamEventsByStep: opts.streamEventsByStep,
    }),
    inflight: createInflightRegistry(),
  });
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={opts.permissionMode}
      graphMode={opts.graphMode}
      sessionGrants={createSessionGrants()}
    />,
    {
      width: 80,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    }
  );
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    setup,
    destroy: () => {
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
    typeQuery: async (text: string) => {
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 150));
      await setup.renderOnce();
    },
    pressTab: async () => {
      setup.mockInput.pressTab();
      await new Promise((r) => setTimeout(r, 150));
      await setup.renderOnce();
    },
    pressEscape: async () => {
      setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 150));
      await setup.renderOnce();
    },
    pressShiftTab: async () => {
      setup.mockInput.pressTab({ shift: true });
      await new Promise((r) => setTimeout(r, 150));
      await setup.renderOnce();
    },
    pressCtrlC: async () => {
      setup.mockInput.pressKey("c", { ctrl: true });
      await new Promise((r) => setTimeout(r, 150));
      await setup.renderOnce();
    },
  };
}

describe("TUI `/graph` 与 Shift+Tab 翻同一 holder（SC3）", () => {
  test("/graph on 开、/graph off 关；期间 permission 不动", async () => {
    const permissionMode = createPermissionModeContext("default");
    const graphMode = createGraphModeContext();
    const app = await mountApp({ permissionMode, graphMode });
    try {
      await app.typeText("/graph on");
      await app.pressEnter();
      expect(graphMode.get().enabled).toBe(true);
      expect(permissionMode.get()).toBe("default");

      await app.typeText("/graph off");
      await app.pressEnter();
      expect(graphMode.get().enabled).toBe(false);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("graph 状态按 Ctrl+C：chrome focus 与 view open 都显示标准复制提示", async () => {
    const permissionMode = createPermissionModeContext("default");
    const graphMode = createGraphModeContext();
    const snapshot = {
      waveIndex: 0,
      nodes: [{ id: "node-a", deps: [], status: "done" as const }],
    };
    const app = await mountApp({
      permissionMode,
      graphMode,
      streamEventsByStep: [[{ type: "graph_progress", snapshot }]],
    });
    try {
      await app.typeText("/graph on");
      await app.pressEnter();
      await app.typeQuery("go");
      await app.pressEnter();
      for (let i = 0; i < 20; i++) {
        if (app.setup.captureCharFrame().includes("graph 1/1")) break;
        await new Promise((r) => setTimeout(r, 50));
        await app.setup.renderOnce();
      }
      await new Promise((r) => setTimeout(r, 1000));
      await app.setup.renderOnce();
      await app.pressTab();
      expect(app.setup.captureCharFrame()).toContain("> graph");
      await app.pressCtrlC();
      expect(app.setup.captureCharFrame()).toContain("无选区");

      await app.pressEnter();
      expect(app.setup.captureCharFrame()).toContain("node-a");
      await app.pressCtrlC();
      await app.pressEscape();
      expect(app.setup.captureCharFrame()).toContain("无选区");
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("Shift+Tab 三态轮 Default → Auto → Graph → Default（同一 holder）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const graphMode = createGraphModeContext();
    const app = await mountApp({ permissionMode, graphMode });
    try {
      await app.pressShiftTab();
      expect(permissionMode.get()).toBe("full_auto");
      expect(graphMode.get().enabled).toBe(false);

      await app.pressShiftTab();
      // Entering Graph: orchestration on, authorization frozen at full_auto from before entry.
      expect(graphMode.get().enabled).toBe(true);
      expect(permissionMode.get()).toBe("full_auto");
      expect(app.setup.captureCharFrame()).toContain("Graph");

      await app.pressShiftTab();
      expect(graphMode.get().enabled).toBe(false);
      expect(permissionMode.get()).toBe("default");
    } finally {
      app.destroy();
    }
  }, 30_000);
});

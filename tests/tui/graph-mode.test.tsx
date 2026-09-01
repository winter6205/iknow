/** @jsxImportSource @opentui/react */
/**
 * D-α V1 graph mode T5 — TUI 入口的 `/graph` 与 Shift+Tab（spec SC3 斜杠对等）。
 *
 * 三层：
 *   1. 词表层：`/graph` 进 TUI 自建 slash 词表（parse / 候选 / help 行）；
 *   2. 应用层：`/graph on|off` 与 Shift+Tab 翻的是**同一个** holder ——
 *      测试注入 holder 后直接读它，证明两条路径不是各自一份状态；
 *   3. 状态行：Graph 时模式行显示 Graph（进入前的 permission 不被改写）。
 *
 * 渲染层用 app.test.tsx 同款 testRender 驱动（bun:test），因为要证的正是
 * 「用户在 TUI 里敲这一行 / 按这个键」这条真实路径。
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

/** buildTuiDeps 只读 env 字段（与 tests/tui/deps-tools.test.ts 同款最小 bundle）。 */
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
      // 关着装配 → 本 round 快照关；翻开后要下一次 beginRound 才生效。
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
  readonly pressEnter: () => Promise<void>;
  readonly pressShiftTab: () => Promise<void>;
}

async function mountApp(opts: {
  readonly permissionMode: PermissionModeContext;
  readonly graphMode: GraphModeContext;
}): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-graph-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
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
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 150));
      await setup.renderOnce();
    },
    pressShiftTab: async () => {
      setup.mockInput.pressTab({ shift: true });
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

  test("Shift+Tab 三态轮 Default → Auto → Graph → Default（同一 holder）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const graphMode = createGraphModeContext();
    const app = await mountApp({ permissionMode, graphMode });
    try {
      await app.pressShiftTab();
      expect(permissionMode.get()).toBe("full_auto");
      expect(graphMode.get().enabled).toBe(false);

      await app.pressShiftTab();
      // 进 Graph：编排开，授权冻结在进入前的 full_auto。
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

/** @jsxImportSource @opentui/react */
/**
 * tests/tui/chrome-footer-order.test.tsx
 *
 * Regression: the first line below the input box is always the ContextBar
 * (model + ctx usage bar); then session location (path · branch), then the
 * subagent task preview, then the graph. JSX order = visual order (root
 * container flexDirection="column").
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  BOTTOM_MARGIN_ROWS,
  TuiApp,
  createToolEventSink,
} from "../../src/tui/app.js";
import type { TuiBridge, TuiPostResult } from "../../src/tui/hub-bridge.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";
import { sessionLocationLines } from "../../src/tui/environment-pane.js";

const TASK_PREVIEW = "查找文档";

function makeSubagent(overrides: Partial<SubagentInfo>): SubagentInfo {
  return {
    taskId: "t-footer-1",
    state: "running",
    taskPreview: TASK_PREVIEW,
    startedAt: new Date().toISOString(),
    role: "general-purpose",
    ...overrides,
  };
}

function fakeBridge(subagents: ReadonlyArray<SubagentInfo>): TuiBridge {
  const inflight = createInflightRegistry();
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-footer",
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  };
  const reply: TuiPostResult = {
    conversationId: "conv-footer",
    finalText: "",
    stopReason: "completed",
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
  };
  return {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-footer",
    postMessage: async () => {
      inflight.mark("conv-footer");
      try {
        return reply;
      } finally {
        inflight.unmark("conv-footer");
      }
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    openSession: async () => {
      throw new Error("unused: no session is opened here");
    },
    abortSubagentTask: () => false,
    abortSessionForegroundWork: () => [],
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async (_conversationId, _head) => ({ file }),
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => subagents,
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
  };
}

describe("TuiApp chrome footer 顺序（ContextBar 紧贴输入框之下）", () => {
  test("有活子代理时：ContextBar → 路径行 → 子代理任务预览", async () => {
    const bridge = fakeBridge([makeSubagent({ state: "running" })]);
    let setupRef: TestRendererSetup | undefined;
    const setup = await testRender(
      <TuiApp
        bridge={bridge}
        askBridge={createTuiAskUserBridge()}
        toolEventSink={createToolEventSink()}
        cwd="/tmp/proj"
        dataDir="/tmp/proj"
        permissionMode={createPermissionModeContext("default")}
        sessionGrants={createSessionGrants()}
      />,
      { width: 80, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
    );
    setupRef = setup;
    try {
      await new Promise((r) => setTimeout(r, 500));
      await setup.waitForVisualIdle();
      const lines = setup
        .captureCharFrame()
        .split("\n")
        .map((l) => l.trim());

      const inputIdx = lines.findIndex((l) => l.includes("❯"));
      expect(inputIdx).toBeGreaterThanOrEqual(0);

      const ctxIdx = lines.findIndex(
        (l, i) => i > inputIdx && l.includes("ctx ") && l.includes("%")
      );
      expect(ctxIdx).toBeGreaterThan(inputIdx);

      const locationText = sessionLocationLines({
        projectRoot: "/tmp/proj",
        cols: 80,
      })[0]?.text;
      expect(locationText).toBeDefined();
      const locIdx = lines.findIndex(
        (l, i) => i > ctxIdx && l === locationText
      );
      expect(locIdx).toBeGreaterThan(ctxIdx);

      const panelIdx = lines.findIndex(
        (l, i) => i > ctxIdx && l.includes(TASK_PREVIEW)
      );
      expect(panelIdx).toBeGreaterThan(locIdx);
    } finally {
      if (setupRef && !setupRef.renderer.isDestroyed)
        setupRef.renderer.destroy();
    }
  }, 20_000);

  /**
   * Frame-level row ledger pin. chromeReserveRows is a pure sum, so an
   * arithmetic re-baseline cannot catch a row that is booked but never
   * rendered below the prompt — that was the old `ask slot` term (askLine
   * renders inside the ChatView scrollbox), which cost the input box two
   * rows of vertical position. These assertions read the rendered frame, so
   * any future unclaimed reserve row moves the prompt up and widens the
   * bottom gap, failing both cases.
   */
  test("底部行号契约：prompt 行号固定，屏底留白恒等于 BOTTOM_MARGIN_ROWS", async () => {
    const height = 30;
    const bridge = fakeBridge([]);
    let setupRef: TestRendererSetup | undefined;
    const setup = await testRender(
      <TuiApp
        bridge={bridge}
        askBridge={createTuiAskUserBridge()}
        toolEventSink={createToolEventSink()}
        cwd="/tmp/proj"
        dataDir="/tmp/proj"
        permissionMode={createPermissionModeContext("default")}
        sessionGrants={createSessionGrants()}
      />,
      { width: 80, height, exitOnCtrlC: false, consoleMode: "disabled" }
    );
    setupRef = setup;
    try {
      await new Promise((r) => setTimeout(r, 500));
      await setup.waitForVisualIdle();
      const raw = setup.captureCharFrame().split("\n");
      const lines = (raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw).map(
        (l) => l.trimEnd()
      );
      expect(lines.length).toBe(height);

      // Booked chrome below the transcript: margin 1 + mode 1 + input 3
      // (borders included) + ContextBar 1 + location 1 = 7 rows, so the
      // prompt content line sits height-5 rows down.
      const promptIdx = lines.findIndex((l) => l.includes("❯"));
      expect(promptIdx).toBe(height - 5);

      let lastChromeRow = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i] !== "") {
          lastChromeRow = i;
          break;
        }
      }
      expect(height - 1 - lastChromeRow).toBe(BOTTOM_MARGIN_ROWS);
    } finally {
      if (setupRef && !setupRef.renderer.isDestroyed)
        setupRef.renderer.destroy();
    }
  }, 20_000);
});

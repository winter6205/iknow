/** @jsxImportSource @opentui/react */
/**
 * tests/tui/chrome-footer-order.test.tsx
 *
 * 回归：输入框之下第一行永远是 ContextBar（model + ctx 用量条）；子代理任务
 * 列表与其它 chrome 信息必须排在 ContextBar 之后。JSX 顺序 = 视觉顺序
 * （根容器 flexDirection="column"）。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import type { TuiBridge, TuiPostResult } from "../../src/tui/hub-bridge.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

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
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async (_conversationId, _head) => file,
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => subagents,
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
  };
}

describe("TuiApp chrome footer 顺序（ContextBar 紧贴输入框之下）", () => {
  test("ContextBar 行在 SubagentPanel 行之上（输入框 ❯ 之上为 identity strip）", async () => {
    const bridge = fakeBridge([makeSubagent({ state: "running" })]);
    let setupRef: TestRendererSetup | undefined;
    const setup = await testRender(
      <TuiApp
        bridge={bridge}
        askBridge={createTuiAskUserBridge()}
        toolEventSink={createToolEventSink()}
        cwd="/tmp/proj"
        dataDir="/tmp/proj"
        model="claude-test-model"
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

      const panelIdx = lines.findIndex(
        (l, i) => i > ctxIdx && l.includes(TASK_PREVIEW)
      );
      expect(panelIdx).toBeGreaterThan(ctxIdx);
    } finally {
      if (setupRef && !setupRef.renderer.isDestroyed)
        setupRef.renderer.destroy();
    }
  }, 20_000);
});

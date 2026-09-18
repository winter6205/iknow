/** @jsxImportSource @opentui/react */
// ARCHIVED (2026-09-17, T3 plans/tui-subagent-transcript-live.md Superseded)：
// 本文件认证的旧合同 = 身份条必须紧贴 prompt 上方（T7 回归）；该不变式随
// `SubagentIdentityStrip` 拆除永久消失 —— 两行已改画在会话 transcript 里
// 派它的那张 spawn 卡上，prompt 上方不再有该条。替代覆盖见
// tests/tui/subagent-card-lines.test.ts（卡级两行投影）+
// tests/tui/subagent-two-line-budget.test.tsx（prompt 侧行账归零、两行在两宿主）。
/**
 * tests/tui/identity-strip-position.test.tsx
 *
 * plans/tui-chrome-interaction.md T7 回归：identity strip 必须
 * immediately above the prompt。JSX 顺序 = 视觉顺序（根容器
 * flexDirection="column"），此前实现把 strip 放在 PromptInput 之后 →
 * 实际渲染在输入框下方，与 plan 相悖（spec review High）。本测试用最小
 * fake bridge 挂载 TuiApp，按行序断言 strip 行在输入框行**上方**，钉死
 * 相对位置，防再次回退。
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

function makeSubagent(overrides: Partial<SubagentInfo>): SubagentInfo {
  return {
    taskId: "t-strip-1",
    state: "running",
    taskPreview: "",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeBridge(subagents: ReadonlyArray<SubagentInfo>): TuiBridge {
  const inflight = createInflightRegistry();
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-strip",
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
    conversationId: "conv-strip",
    finalText: "",
    stopReason: "completed",
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
  };
  return {
    hub: undefined as never, // 本测不消费 hub
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-strip",
    postMessage: async () => {
      inflight.mark("conv-strip");
      try {
        return reply;
      } finally {
        inflight.unmark("conv-strip");
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

describe("SubagentIdentityStrip 在 TuiApp 中的位置（immediately above prompt）", () => {
  test("strip 行位于输入框行上方（JSX 顺序 = 视觉顺序）", async () => {
    const bridge = fakeBridge([
      makeSubagent({ state: "running", role: "general-purpose" }),
    ]);
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
      const stripIdx = lines.findIndex((l) =>
        l.includes("general-purpose running...")
      );
      expect(stripIdx).toBeGreaterThanOrEqual(0);
      // 输入框（❯ 占位/内容行）必须在 strip 行**之后**。
      const inputIdx = lines.findIndex(
        (l, i) => i > stripIdx && l.includes("❯")
      );
      expect(inputIdx).toBeGreaterThan(stripIdx);
    } finally {
      if (setupRef && !setupRef.renderer.isDestroyed)
        setupRef.renderer.destroy();
    }
  }, 20_000);
});

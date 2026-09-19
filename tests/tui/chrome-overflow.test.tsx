/** @jsxImportSource @opentui/react */
/**
 * tests/tui/chrome-overflow.test.tsx
 *
 * #1044 布局越界回归：底部 chrome（输入框 / ContextBar / 位置行 / 子代理
 * 面板）均无显式高度、opentui 默认 flexShrink=1 —— 面板行不入账时总高超出
 * 终端，Yoga 把负空间按比例摊给底部 chrome，输入框内容行被压进边框
 * （live 子代理 ≥7 必现，与终端高无关）。
 *
 * 修复（候选 C）：面板行数入账（panelRows = 折叠后行数，上限
 * SUBAGENT_PANEL_MAX_ROWS）→ 输入框随子代理增加正常上移、始终完整显示，
 * 且上移有界（不再回归 47faa754 修掉的「每加一个子代理上移一行」的无界形态）。
 *
 * 断言指标（探针 v3 转正）：
 *   - inputRows = ctx 行号 − mode 行号 − 1（输入框完好 = 3）；
 *   - promptRow 收敛：n 超过折叠边界后不再随 n 变化（有界上移）。
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
import { SUBAGENT_PANEL_MAX_ROWS } from "../../src/tui/subagent-panel.js";

function makeSubagent(i: number): SubagentInfo {
  return {
    taskId: `t-overflow-${i}`,
    state: "running",
    taskPreview: `任务预览文本-${i}`,
    startedAt: new Date().toISOString(),
    role: `role-${i}`,
  };
}

function fakeBridge(subagents: ReadonlyArray<SubagentInfo>): TuiBridge {
  const inflight = createInflightRegistry();
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-overflow",
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
    conversationId: "conv-overflow",
    finalText: "",
    stopReason: "completed",
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
  };
  return {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-overflow",
    postMessage: async () => {
      inflight.mark("conv-overflow");
      try {
        return reply;
      } finally {
        inflight.unmark("conv-overflow");
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
    rewindSession: async () => file,
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => subagents,
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
  };
}

async function frameFor(
  n: number,
  height: number
): Promise<{ frame: string; setup: TestRendererSetup }> {
  const bridge = fakeBridge(
    Array.from({ length: n }, (_, i) => makeSubagent(i))
  );
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
  await new Promise((r) => setTimeout(r, 350));
  await setup.waitForVisualIdle();
  return { frame: setup.captureCharFrame(), setup };
}

/** 输入框完好行数：mode 行与 ctx 行之间的距离 − 1（健康 = 3：上边框+内容+下边框）。 */
function inputRowCount(frame: string): number {
  const lines = frame.split("\n");
  const modeIdx = lines.findIndex((l) => l.includes("mode: Default"));
  const ctxIdx = lines.findIndex((l) => l.includes("ctx ") && l.includes("%"));
  if (modeIdx < 0 || ctxIdx < 0) return -1;
  return ctxIdx - modeIdx - 1;
}

/** 输入框提示符所在行（用于「上移有界」断言）；找不到 → -1。 */
function promptRowIndex(frame: string): number {
  return frame.split("\n").findIndex((l) => l.includes("❯"));
}

describe("chrome-overflow（#1044）：底部 chrome 比例压缩回归", () => {
  test("live 子代理 0..12 × H=30/H=20：输入框恒 3 行完整", async () => {
    for (const height of [30, 20]) {
      for (let n = 0; n <= 12; n++) {
        const { frame, setup } = await frameFor(n, height);
        const rows = inputRowCount(frame);
        expect(rows).toBe(3);
        if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      }
    }
  }, 240_000);

  test("输入框上移有界：n 越过折叠边界后 promptRow 收敛不再下移", async () => {
    const boundary = SUBAGENT_PANEL_MAX_ROWS;
    const height = 30;
    const rows: number[] = [];
    for (let n = 0; n <= boundary + 4; n++) {
      const { frame, setup } = await frameFor(n, height);
      rows.push(promptRowIndex(frame));
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
    // 折叠边界之后 promptRow 恒定（面板行账封顶，ChatView 不再变矮）。
    const tail = rows.slice(boundary);
    expect(new Set(tail).size).toBe(1);
    // 且整体单调不增（上移有方向性：只往上或不动）。
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]).toBeLessThanOrEqual(rows[i - 1]);
    }
  }, 240_000);

  test("超限帧含折叠行 `… +N`（面板行账与渲染高度一致性的直接证据）", async () => {
    const { frame, setup } = await frameFor(9, 30);
    const hidden = 9 - (SUBAGENT_PANEL_MAX_ROWS - 1);
    expect(frame).toContain(`… +${hidden}`);
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }, 60_000);
});

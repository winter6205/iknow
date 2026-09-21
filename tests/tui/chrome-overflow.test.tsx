/** @jsxImportSource @opentui/react */
/**
 * tests/tui/chrome-overflow.test.tsx
 *
 * Layout-overflow regression: the bottom chrome (input box / ContextBar /
 * location line / subagent panel) has no explicit height and opentui
 * defaults to flexShrink=1 — when panel rows go unaccounted the total
 * exceeds the terminal, Yoga distributes the negative space proportionally
 * to the bottom chrome, and the input box's content row gets crushed into
 * its border (always reproducible with >=7 live subagents, independent of
 * terminal height).
 *
 * Fix: account the panel row count (panelRows = collapsed rows, capped at
 * SUBAGENT_PANEL_MAX_ROWS) → the input box shifts up normally as subagents
 * grow, always displays intact, and the shift is bounded (no regression to
 * the unbounded "one row up per added subagent" shape).
 *
 * Assertion metrics:
 *   - inputRows = ctx line number − mode line number − 1 (intact box = 3);
 *   - promptRow convergence: past the collapse boundary it stops changing
 *     with n (bounded shift-up).
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
    rewindSession: async () => ({ file }),
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

/** Intact input-box row count: distance between the mode line and the ctx
 *  line − 1 (healthy = 3: top border + content + bottom border). */
function inputRowCount(frame: string): number {
  const lines = frame.split("\n");
  const modeIdx = lines.findIndex((l) => l.includes("mode: Default"));
  const ctxIdx = lines.findIndex((l) => l.includes("ctx ") && l.includes("%"));
  if (modeIdx < 0 || ctxIdx < 0) return -1;
  return ctxIdx - modeIdx - 1;
}

/** Line of the input prompt (for the bounded-shift-up assertion); -1 when
 *  not found. */
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
    // Past the collapse boundary promptRow stays constant (panel row
    // account caps out, ChatView stops shrinking).
    const tail = rows.slice(boundary);
    expect(new Set(tail).size).toBe(1);
    // And overall monotonically non-increasing (the shift has direction: up
    // or nowhere).
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

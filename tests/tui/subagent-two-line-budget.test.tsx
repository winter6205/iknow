/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-two-line-budget.test.tsx
 *
 * spec Slice D / SC14（`specs/agent-control-surface.md`）/ plan task 8 的行账
 * 回归：会话消息内的两行投影（`SubagentIdentityStrip`）画在输入框**上方**，
 * 其行数必须进 `chromeReserveRows` 预算；不入账时 chrome 总高超出 rows，
 * Yoga 会把每个两行块压成一行 —— 表现为同一行内文本重叠
 * （实测帧：`查找文档running...` / `第二件事purpose running...`），
 * 且 `SubagentPanel` 的聚焦行被挤出帧外，导致 Ctrl+X 打到错误的行。
 *
 * 本测钉两件事：
 *   1) 行账 delta = live 子代理数 × 2（纯函数，无渲染）；
 *   2) app 帧内每个 live 子代理恰好占两行、块内两行文本不重叠（渲染，
 *      即 1) 的回归守卫 —— 只改 1) 不改渲染也会红）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import {
  TuiApp,
  chromeReserveRows,
  createToolEventSink,
} from "../../src/tui/app.js";
import type { TuiBridge, TuiPostResult } from "../../src/tui/hub-bridge.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { subagentMessageRowCount } from "../../src/tui/subagent-message-lines.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

function makeSubagent(overrides: Partial<SubagentInfo>): SubagentInfo {
  return {
    taskId: "task-a",
    state: "running",
    taskPreview: "查找文档",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function baseBudget(): number {
  return chromeReserveRows({
    noticeRows: 0,
    inputHintRows: 0,
    bgLine: false,
    inputRows: 1,
  });
}

describe("subagentRows 行账（chromeReserveRows 入账）", () => {
  test("case 1：无 live → 缺省 0，预算与 baseline 相同", () => {
    const base = baseBudget();
    const explicitZero = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      subagentRows: 0,
    });
    expect(explicitZero).toBe(base);
  });

  test("case 2：1 个 live → delta 2（两行/块，SSOT 派生不写死数字）", () => {
    const rows = subagentMessageRowCount([makeSubagent({ state: "running" })]);
    expect(rows).toBe(2);
    const withSub = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      subagentRows: rows,
    });
    expect(withSub - baseBudget()).toBe(rows);
  });

  test("case 3：终态子代理不入账（与投影同源口径）", () => {
    const rows = subagentMessageRowCount([
      makeSubagent({ state: "completed", endedAt: new Date().toISOString() }),
      makeSubagent({ state: "failed", endedAt: new Date().toISOString() }),
    ]);
    expect(rows).toBe(0);
  });
});

describe("两行投影在 app 帧内不被压行（渲染回归）", () => {
  async function mountApp(): Promise<string> {
    const current: ReadonlyArray<SubagentInfo> = [
      makeSubagent({ taskId: "task-a", role: "explore" }),
      makeSubagent({
        taskId: "task-b",
        role: "general-purpose",
        taskPreview: "第二件事",
      }),
    ];
    const inflight = createInflightRegistry();
    const file: SessionFileV1 = {
      schemaVersion: 3,
      conversation_id: "conv-budget",
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
      conversationId: "conv-budget",
      finalText: "",
      stopReason: "completed",
      turnCount: 0,
      jsonMode: false,
      lastUsage: null,
    };
    const bridge: TuiBridge = {
      hub: undefined as never,
      store: undefined as never,
      ensureSession: async (id) => id ?? "conv-budget",
      postMessage: async () => reply,
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
      listSubagents: () => current,
      abortSubagentTask: () => true,
      subscribeSubagentTerminal: () => () => undefined,
      wakeFromSubagent: async () => undefined,
    };
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-two-line-budget-"));
    const setup = await testRender(
      <TuiApp
        bridge={bridge}
        askBridge={createTuiAskUserBridge()}
        toolEventSink={createToolEventSink()}
        cwd="/tmp/proj"
        dataDir={dataDir}
        permissionMode={createPermissionModeContext("default")}
        sessionGrants={createSessionGrants()}
      />,
      { width: 80, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
    );
    await setup.waitForVisualIdle();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    return frame;
  }

  test("2 live → 帧内 4 行，role 行与 preview 行互不重叠", async () => {
    const lines = (await mountApp()).split("\n").map((l) => l.trim());
    // 每个 live 子代理两行；被压行时帧里只会出现 2 行且文本粘连
    // （`查找文档running...`）。
    expect(lines).toContain("explore running...");
    expect(lines).toContain("查找文档");
    expect(lines).toContain("general-purpose running...");
    expect(lines).toContain("第二件事");
    // 粘连形态必须不存在（压行的直接指纹）。
    expect(
      lines.some(
        (l) => l.includes("running...") && !/^[^\s]+ running\.\.\.$/.test(l)
      )
    ).toBe(false);
  }, 30_000);
});

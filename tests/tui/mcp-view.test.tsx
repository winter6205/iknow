/** @jsxImportSource @opentui/react */
/**
 * tests/tui/mcp-view.test.tsx
 *
 * Unit tests for the MCP server dashboard (McpView). Same shape as
 * list-view-scroll.test.tsx — testRender + mockInput driving the keyboard contract:
 *  - list rendering: 3 server states (connected/failed/disabled) + tool
 *    counts + ↑↓ cursor + Enter switches to detail；
 *  - detail: tool short names with the mcp__server__ prefix stripped +
 *    description rendering (empty description falls back to `(空)` "(empty)";
 *    when tools exceed the viewport, a trailing `… N more tools` line)；
 *  - reload trigger: pressing r in list or detail mode → onReload called once + reloading state；
 *  - empty state: empty statuses → empty hint + reload hint；
 *  - Esc back calls onBack once.
 *
 * No app-level /mcp end-to-end integration here (fixture wiring is
 * insufficient; McpView unit tests cover rendering + keyboard contract,
 * integration deferred to E2E / manual testing).
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  McpView,
  mcpStateColor,
  type McpToolEntry,
} from "../../src/tui/mcp-view.js";
import { tuiPalette } from "../../src/tui/theme.js";
import type { McpServerStatus } from "../../src/harness/mcp/manager.js";
import type { AciToolDef } from "../../src/harness/aci/types.js";

/** Polling frame waiter (mockInput bytes parse asynchronously through stdin; same as the list-view tests). */
async function untilFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  pred: (frame: string) => boolean,
  ms = 3000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 15));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

function makeStatus(
  name: string,
  state: McpServerStatus["state"],
  source: McpServerStatus["source"] = "user",
  error?: string
): McpServerStatus {
  return { name, state, source, ...(error !== undefined ? { error } : {}) };
}

function makeTool(
  server: string,
  toolName: string,
  description: string
): McpToolEntry {
  return {
    server,
    tool: Object.freeze({
      name: `mcp__${server}__${toolName}`,
      description,
      inputSchema: { type: "object", properties: {} },
      handler: async () => "ok",
    }) as AciToolDef,
  };
}

const statuses: ReadonlyArray<McpServerStatus> = [
  makeStatus("fileserver", "connected"),
  makeStatus("db", "failed"),
  makeStatus("legacy", "disabled"),
];

const tools: ReadonlyArray<McpToolEntry> = [
  makeTool("fileserver", "read", "读取文件"),
  makeTool("fileserver", "write", "写入文件"),
  makeTool("db", "query", "数据库查询"),
];

function renderMcp(opts: {
  statuses?: ReadonlyArray<McpServerStatus>;
  tools?: ReadonlyArray<McpToolEntry>;
  rows?: number;
  onReload?: () => void;
  onBack?: () => void;
}) {
  return testRender(
    <McpView
      statuses={opts.statuses ?? statuses}
      tools={opts.tools ?? tools}
      cols={100}
      rows={opts.rows ?? 12}
      onReload={opts.onReload ?? (() => {})}
      onBack={opts.onBack ?? (() => {})}
    />,
    { width: 100, height: 30, exitOnCtrlC: false }
  );
}

test("mcpStateColor：connected 绿 / failed 红 / pending 暗黄 / disabled 灰", () => {
  expect(mcpStateColor(tuiPalette, "connected")).toBe(tuiPalette.add);
  expect(mcpStateColor(tuiPalette, "failed")).toBe(tuiPalette.error);
  expect(mcpStateColor(tuiPalette, "pending")).toBe(tuiPalette.running);
  expect(mcpStateColor(tuiPalette, "disabled")).toBe(tuiPalette.dim);
});

test("列表渲染：3 server 状态 + 工具数 + source 标记", async () => {
  const setup = await renderMcp({});
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("MCP 服务看板");
  expect(frame).toContain("fileserver");
  expect(frame).toContain("connected");
  expect(frame).toContain("2 工具");
  expect(frame).toContain("db");
  expect(frame).toContain("failed");
  expect(frame).toContain("1 工具");
  expect(frame).toContain("legacy");
  expect(frame).toContain("disabled");
  expect(frame).toContain("user");
  await setup.renderer.destroy();
});

test("↑↓ 移动 cursor；Enter 进入 detail", async () => {
  let opened = false;
  const setup = await renderMcp({});
  await setup.renderOnce();
  // Initial cursor=0 → first row carries `>`.
  let frame = setup.captureCharFrame();
  expect(frame).toContain("> fileserver");
  // ↓ moves to db.
  setup.mockInput.pressArrow("down");
  frame = await untilFrame(setup, (f) => f.includes("> db"));
  expect(frame).not.toContain("> fileserver");
  // Enter → detail (cursor is on db → db detail, including db's tool rows).
  setup.mockInput.pressEnter();
  frame = await untilFrame(setup, (f) => f.includes("db · failed"));
  expect(frame).toContain("query · 数据库查询");
  expect(opened).toBe(false);
  await setup.renderer.destroy();
});

test("详情：剥离 mcp__server__ 前缀的工具名 + description 渲染", async () => {
  const setup = await renderMcp({});
  await setup.renderOnce();
  // Initial cursor is on fileserver (index 0); Enter opens detail.
  setup.mockInput.pressEnter();
  const frame = await untilFrame(setup, (f) =>
    f.includes("fileserver · connected")
  );
  // Tool names have the `mcp__<server>__` prefix stripped → short names only.
  expect(frame).toContain("read · 读取文件");
  expect(frame).toContain("write · 写入文件");
  // The full name must not appear anymore (avoids line redundancy).
  expect(frame).not.toContain("mcp__fileserver__read");
  expect(frame).not.toContain("mcp__fileserver__write");
  // db's tools must not show up in fileserver's detail.
  expect(frame).not.toContain("query");
  expect(frame).not.toContain("数据库查询");
  await setup.renderer.destroy();
});

test("reload 触发：按 r → onReload 调用 1 次 + reloading 状态出现", async () => {
  let reloadCount = 0;
  const setup = await renderMcp({
    onReload: () => {
      reloadCount += 1;
    },
  });
  await setup.renderOnce();
  setup.mockInput.pressKey("r");
  const frame = await untilFrame(setup, (f) =>
    f.includes("reload in progress")
  );
  expect(reloadCount).toBe(1);
  expect(frame).toContain("reload in progress");
  // The reloading flag clears after a ~200ms delay.
  await untilFrame(setup, (f) => !f.includes("reload in progress"), 3000);
  await setup.renderer.destroy();
});

test("空状态：statuses 空 → 空提示 + reload 提示", async () => {
  const setup = await renderMcp({ statuses: [], tools: [] });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("无 MCP 服务");
  expect(frame).toContain(".iknow/mcp.json");
  await setup.renderer.destroy();
});

test("Esc 返回 onBack 调用 1 次（列表模式直接返回 chat）", async () => {
  let backCount = 0;
  const setup = await renderMcp({
    onBack: () => {
      backCount += 1;
    },
  });
  await setup.renderOnce();
  setup.mockInput.pressEscape();
  await untilFrame(setup, () => backCount === 1);
  expect(backCount).toBe(1);
  await setup.renderer.destroy();
});

test("详情模式 Esc 先回列表，再 Esc 回 chat（onBack 仅第二次触发）", async () => {
  let backCount = 0;
  const setup = await renderMcp({
    onBack: () => {
      backCount += 1;
    },
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  await untilFrame(setup, (f) => f.includes("fileserver · connected"));
  // First Esc → back to the list.
  setup.mockInput.pressEscape();
  await untilFrame(setup, (f) => f.includes("> fileserver"));
  expect(backCount).toBe(0);
  // Second Esc → back to chat.
  setup.mockInput.pressEscape();
  await untilFrame(setup, () => backCount === 1);
  expect(backCount).toBe(1);
  await setup.renderer.destroy();
});

test("详情模式 r 触发 reload（onReload 1 次 + reloading 提示）", async () => {
  let reloadCount = 0;
  const setup = await renderMcp({
    onReload: () => {
      reloadCount += 1;
    },
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  await untilFrame(setup, (f) => f.includes("fileserver · connected"));
  // Still in detail mode (tool short-name rows visible) when r is pressed → reload fires.
  setup.mockInput.pressKey("r");
  const frame = await untilFrame(setup, (f) =>
    f.includes("reload in progress")
  );
  expect(reloadCount).toBe(1);
  expect(frame).toContain("reload in progress");
  // Detail tool rows remain (r does not change mode).
  expect(frame).toContain("read · 读取文件");
  // The reloading flag clears after a ~200ms delay.
  await untilFrame(setup, (f) => !f.includes("reload in progress"), 3000);
  await setup.renderer.destroy();
});

test("详情：description 空回退 `(空)`", async () => {
  const setup = await renderMcp({
    tools: [makeTool("fileserver", "bare", "")],
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  const frame = await untilFrame(setup, (f) =>
    f.includes("fileserver · connected")
  );
  expect(frame).toContain("bare · (空)");
  await setup.renderer.destroy();
});

test("详情：工具超视口末尾 `… N more tools` 提示行", async () => {
  const manyTools: ReadonlyArray<McpToolEntry> = Array.from(
    { length: 8 },
    (_, i) => makeTool("fileserver", `tool${i}`, `第 ${i} 个工具`)
  );
  const setup = await renderMcp({
    statuses: [makeStatus("fileserver", "connected")],
    tools: manyTools,
    rows: 7,
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  // rows=7 → viewHeight=3 → maxToolRows=2: only 2 tool short names + a remainder hint.
  const frame = await untilFrame(setup, (f) =>
    f.includes("fileserver · connected")
  );
  expect(frame).toContain("tool0 · 第 0 个工具");
  expect(frame).toContain("tool1 · 第 1 个工具");
  expect(frame).toContain("… 6 more tools");
  // Tool short names inside the viewport use stripped names, without the mcp__ prefix.
  expect(frame).not.toContain("mcp__fileserver__tool0");
  await setup.renderer.destroy();
});


test("列表行：#378 failed + error 渲染 error 首行（connect timeout 可见）", async () => {
  const setup = await renderMcp({
    statuses: [makeStatus("db", "failed", "user", "connect timeout")],
    tools: [],
  });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("db");
  expect(frame).toContain("failed");
  expect(frame).toContain("connect timeout");
  await setup.renderer.destroy();
});

test("列表行：#378 failed 无 error → 与现状字节一致（仅 state，无 error 区）", async () => {
  const setup = await renderMcp({
    statuses: [makeStatus("db", "failed")],
    tools: [],
  });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // Equivalence with existing assertions: no trailing error text on the row (error area not rendered).
  expect(frame).not.toMatch(/failed[^\n]*error/);
  await setup.renderer.destroy();
});

test("列表行：#378 connected / pending / disabled → 不显 error 区", async () => {
  const setup = await renderMcp({
    statuses: [
      makeStatus("fileserver", "connected", "user", "stale error"),
      makeStatus("db", "pending"),
      makeStatus("legacy", "disabled", "project"),
    ],
    tools: [],
  });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).not.toContain("stale error");
  await setup.renderer.destroy();
});

test("详情：#378 failed + error 多行按 \n 拆行渲染", async () => {
  const setup = await renderMcp({
    statuses: [makeStatus("db", "failed", "user", "connect timeout\nconnection closed by server")],
    tools: [],
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  const frame = await untilFrame(setup, (f) => f.includes("db · failed"));
  expect(frame).toContain("connect timeout");
  expect(frame).toContain("connection closed by server");
  await setup.renderer.destroy();
});

test("详情：#378 connected → 无 error 区", async () => {
  const setup = await renderMcp({
    statuses: [makeStatus("fileserver", "connected", "user", "stale error")],
    tools: [],
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  const frame = await untilFrame(setup, (f) => f.includes("fileserver · connected"));
  expect(frame).not.toContain("stale error");
  await setup.renderer.destroy();
});


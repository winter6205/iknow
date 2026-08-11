/** @jsxImportSource @opentui/react */
/**
 * tests/tui/mcp-view.test.tsx
 *
 * #361 Phase D：MCP 服务看板（McpView）单测。参考 list-view-scroll.test.tsx
 * 形态 — testRender + mockInput 驱动键盘契约：
 *  - 列表渲染：3 server 状态（connected/failed/disabled）+ 工具数 + ↑↓
 *    cursor + Enter 切 detail；
 *  - 详情：剥离 mcp__server__ 前缀的工具短名 + description 渲染（空
 *    description 回退 `(空)`；工具超视口末尾 `… N more tools`）；
 *  - reload 触发：列表与详情模式按 r → onReload 调用 1 次 + reloading 状态；
 *  - 空状态：statuses 空 → 空提示 + reload 提示；
 *  - Esc 返回 onBack 调用 1 次。
 *
 * 不测 app 端到端 /mcp 集成（fixture 装配不足；McpView 单独测覆盖渲染 +
 * 键盘契约，集成留 E2E / 手测）。
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

/** 轮询式帧等待（mockInput 字节经 stdin 异步解析；与 list-view 测试同款）。 */
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
  // 初始 cursor=0 → 首行带 `>`。
  let frame = setup.captureCharFrame();
  expect(frame).toContain("> fileserver");
  // ↓ 到 db。
  setup.mockInput.pressArrow("down");
  frame = await untilFrame(setup, (f) => f.includes("> db"));
  expect(frame).not.toContain("> fileserver");
  // Enter → detail（cursor 已在 db → db 详情，含 db 工具行）。
  setup.mockInput.pressEnter();
  frame = await untilFrame(setup, (f) => f.includes("db · failed"));
  expect(frame).toContain("query · 数据库查询");
  expect(opened).toBe(false);
  await setup.renderer.destroy();
});

test("详情：剥离 mcp__server__ 前缀的工具名 + description 渲染", async () => {
  const setup = await renderMcp({});
  await setup.renderOnce();
  // 初始 cursor 在 fileserver（index 0），Enter 进详情。
  setup.mockInput.pressEnter();
  const frame = await untilFrame(setup, (f) =>
    f.includes("fileserver · connected")
  );
  // 工具名剥离 `mcp__<server>__` 前缀 → 只显示短名。
  expect(frame).toContain("read · 读取文件");
  expect(frame).toContain("write · 写入文件");
  // 全名不应再出现（避免行内冗余）。
  expect(frame).not.toContain("mcp__fileserver__read");
  expect(frame).not.toContain("mcp__fileserver__write");
  // db 的工具不应出现在 fileserver 详情。
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
  // ~200ms 延迟后 reloading 清位。
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
  // 第一次 Esc → 回列表。
  setup.mockInput.pressEscape();
  await untilFrame(setup, (f) => f.includes("> fileserver"));
  expect(backCount).toBe(0);
  // 第二次 Esc → 回 chat。
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
  // 仍在详情模式（工具短名行可见）时按 r → reload 生效。
  setup.mockInput.pressKey("r");
  const frame = await untilFrame(setup, (f) =>
    f.includes("reload in progress")
  );
  expect(reloadCount).toBe(1);
  expect(frame).toContain("reload in progress");
  // 详情工具行仍在（r 不改变模式）。
  expect(frame).toContain("read · 读取文件");
  // ~200ms 延迟后 reloading 清位。
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
  // rows=7 → viewHeight=3 → maxToolRows=2：只显示 2 个工具短名 + 余量提示。
  const frame = await untilFrame(setup, (f) =>
    f.includes("fileserver · connected")
  );
  expect(frame).toContain("tool0 · 第 0 个工具");
  expect(frame).toContain("tool1 · 第 1 个工具");
  expect(frame).toContain("… 6 more tools");
  // 视口内工具短名用剥离后的名字，不带 mcp__ 前缀。
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
  // 既有断言等价性：行内无 error 尾随文本（不渲染 error 区）。
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


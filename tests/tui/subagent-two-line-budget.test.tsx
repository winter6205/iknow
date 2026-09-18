/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-two-line-budget.test.tsx
 *
 * specs/tui-subagent-transcript-live.md 锁句 1–3 的行账 + 渲染回归：两行改画
 * 在会话 transcript 里的 `spawn_subagent` 卡上（滚动区），prompt 上方身份条
 * 拆除 —— **live 子代理存在与否都不再进 chrome 行账**（`subagentRowBudget`
 * 恒 0，`chromeReserveRows.subagentRows` 缺省即不占行）。
 *
 * 此前本测钉的是相反命题（strip 画在输入框上方、每 live 子代理入账 2 行）；
 * 位置合同被取代后主体消失，本测重写为「不再占 prompt 行账 + 卡上两行不
 * 粘连」。粘连是这个回归的原始指纹（Yoga 把两行块压成一行 →
 * `查找文档explore running...`），与承载位置无关，故保留该断言并钉在两个
 * 真实宿主上：
 *   - `SubagentCardView`（历史卡 + live 卡共用的渲染面）；
 *   - `liveToolPreviewBox`（live tail 宿主，带 card 投影）。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { RGBA } from "@opentui/core";
import { chromeReserveRows, subagentRowBudget } from "../../src/tui/app.js";
import { SubagentCardView } from "../../src/tui/subagent-card-view.js";
import { liveToolPreviewBox } from "../../src/tui/live-tool-preview.js";
import type { LiveToolRun } from "../../src/tui/live-tool-state.js";
import {
  projectSubagentCardLines,
  subagentCardLinesMap,
} from "../../src/tui/subagent-message-lines.js";
import { tuiPalette } from "../../src/tui/theme.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

const T0 = Date.parse("2026-09-07T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

let fixtureCounter = 0;
function makeSubagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  fixtureCounter += 1;
  return {
    taskId: `t-budget-${fixtureCounter}`,
    state: "running",
    taskPreview: "查找文档",
    startedAt: iso(-1000),
    toolUseId: `toolu_budget_${fixtureCounter}`,
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

function spanWithText(
  setup: TestRendererSetup,
  text: string
): { text: string; fg: RGBA } | undefined {
  for (const line of setup.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) return { text: span.text, fg: span.fg };
    }
  }
  return undefined;
}

function rgbaEq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

// ============================================================================
// 1) 行账：prompt 上方不再为子代理预留行（锁句 3）
// ============================================================================

describe("subagentRows 行账（锁句 3：prompt 上方不再占行）", () => {
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

  test("case 2：live 数不改变 chrome 预算（行账与 live 解耦，恒 0）", () => {
    // 两行已画在 transcript 卡上（滚动区）——chrome 预算不得随 live 数增长，
    // 否则 prompt 上方会凭空多出空行（旧合同的反向回归闸）。
    for (const subagents of [
      [makeSubagent({ state: "starting" })],
      [makeSubagent({ state: "running" }), makeSubagent()],
    ]) {
      const rows = subagentRowBudget("chat", subagents);
      expect(rows).toBe(0);
      const withSub = chromeReserveRows({
        noticeRows: 0,
        inputHintRows: 0,
        bgLine: false,
        inputRows: 1,
        subagentRows: rows,
      });
      expect(withSub - baseBudget()).toBe(0);
    }
  });

  test("case 3：非 chat 视图同样 0（列表 / MCP / 图视图无该条）", () => {
    const live = [makeSubagent({ state: "running" })];
    expect(subagentRowBudget("list", live)).toBe(0);
    expect(subagentRowBudget("mcp", live)).toBe(0);
  });
});

// ============================================================================
// 2) 卡上两行：形状、颜色、不粘连（锁句 1–2）
// ============================================================================

async function renderCard(card: {
  readonly roleLine: string;
  readonly detailLine: string;
  readonly doneLine?: string;
  readonly done: boolean;
}): Promise<TestRendererSetup> {
  const setup = await testRender(<SubagentCardView card={card} />, {
    width: 80,
    height: 5,
  });
  await setup.renderOnce();
  return setup;
}

describe("SubagentCardView（两行渲染面）", () => {
  test("live：两行逐字、第 2 行紧随第 1 行、互不粘连", async () => {
    const card = projectSubagentCardLines(
      [makeSubagent({ role: "explore", toolUseId: "toolu_live" })],
      "toolu_live",
      80
    );
    expect(card).not.toBeNull();
    const setup = await renderCard(card!);
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines).toContain("explore running...");
    expect(lines).toContain("查找文档");
    expect(lines.indexOf("查找文档")).toBe(
      lines.indexOf("explore running...") + 1
    );
    // 粘连形态必须不存在（压行的直接指纹）：身份行不得与任何其它文本同排。
    expect(
      lines.some(
        (l) => l.includes("running...") && !/^\S+( \S+)* running\.\.\.$/.test(l)
      )
    ).toBe(false);
    await setup.renderer.destroy();
  });

  test("live：第 2 行 fg = palette.dim，且 ≠ 第 1 行 fg", async () => {
    const card = projectSubagentCardLines(
      [makeSubagent({ role: "explore", toolUseId: "toolu_dim" })],
      "toolu_dim",
      80
    );
    const setup = await renderCard(card!);
    const roleSpan = spanWithText(setup, "explore running...");
    const detailSpan = spanWithText(setup, "查找文档");
    expect(roleSpan).toBeDefined();
    expect(detailSpan).toBeDefined();
    expect(rgbaEq(detailSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    expect(rgbaEq(roleSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(false);
    await setup.renderer.destroy();
  });

  test("completed：概述留下 + 其下绿 `✓ Done`，第 1 行不再带 running...", async () => {
    const card = subagentCardLinesMap(
      [
        makeSubagent({
          state: "completed",
          role: "explore",
          taskPreview: "查找文档",
          toolUseId: "toolu_done",
          endedAt: iso(500),
        }),
      ],
      80
    ).get("toolu_done");
    expect(card).toBeDefined();
    const setup = await renderCard(card!);
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .map((l) => l.trim());
    // 概述必须在场（被字面 `done` 顶掉是 reopen 的直接动因）。
    expect(lines).toContain("查找文档");
    expect(lines).toContain("✓ Done");
    expect(lines).toContain("explore");
    expect(lines.some((l) => l.includes("running..."))).toBe(false);
    // 顺序：概述在前，完成标记紧随其下。
    expect(lines.indexOf("✓ Done")).toBe(lines.indexOf("查找文档") + 1);
    const doneSpan = spanWithText(setup, "✓ Done");
    expect(doneSpan).toBeDefined();
    expect(rgbaEq(doneSpan!.fg, RGBA.fromHex(tuiPalette.add))).toBe(true);
    // 概述行仍是 dim（完成态不改它的着色，绿只属于完成标记）。
    const previewSpan = spanWithText(setup, "查找文档");
    expect(rgbaEq(previewSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    await setup.renderer.destroy();
  });

  test("无 emoji 断言：卡渲染文本不含 U+1F300–U+1FAFF（几何字形纪律）", async () => {
    // 旧身份条测试（已归档）在宿主上钉过这条；两行换了宿主后由本测接棒 ——
    // 渲染面不得**自行引入** emoji 装饰（spec #146:86 几何字形：面板用
    // ● / ✓，卡的完成标记 `✓ Done` 同用几何 ✓，落在这个区间之外）。输入取
    // 纯文本，故帧里任何 emoji 都只可能来自渲染面自己加的字形。
    const card = subagentCardLinesMap(
      [
        makeSubagent({
          role: "explore",
          taskPreview: "查找文档并整理结果",
          toolUseId: "toolu_emoji",
        }),
      ],
      80
    ).get("toolu_emoji");
    expect(card).toBeDefined();
    const setup = await renderCard(card!);
    const frame = setup.captureCharFrame();
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(frame)).toBe(false);
    await setup.renderer.destroy();
  });
});

// ============================================================================
// 3) live tail 宿主：card 命中 → 走两行；失败 → 走既有 failure overlay
// ============================================================================

function spawnRun(overrides: Partial<LiveToolRun> = {}): LiveToolRun {
  return {
    id: "toolu_tail",
    name: "spawn_subagent",
    status: "running",
    input: { task: "查一下", subagent_type: "explore" },
    ...overrides,
  };
}

async function renderLiveBox(
  run: LiveToolRun,
  card?: Parameters<typeof liveToolPreviewBox>[2]
): Promise<TestRendererSetup> {
  const setup = await testRender(<>{liveToolPreviewBox(run, 80, card)}</>, {
    width: 80,
    height: 6,
  });
  await setup.renderOnce();
  return setup;
}

describe("liveToolPreviewBox — spawn 卡的两行宿主", () => {
  test("card 命中 → 卡上两行（身份 + dim 预览），不再走单行标题", async () => {
    const card = projectSubagentCardLines(
      [makeSubagent({ role: "explore", toolUseId: "toolu_tail" })],
      "toolu_tail",
      80
    );
    const setup = await renderLiveBox(spawnRun(), card);
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .map((l) => l.trim());
    expect(lines).toContain("explore running...");
    expect(lines).toContain("查找文档");
    await setup.renderer.destroy();
  });

  test("card 缺省（无关联键）→ 回落既有单行标题（不改 tool-line 模板）", async () => {
    const setup = await renderLiveBox(spawnRun());
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .map((l) => l.trim());
    // 既有 detail-only 文案（dotless，来自 formatToolStatusLine）仍在。
    expect(
      lines.some((l) => l.includes("explore running") && !l.includes("..."))
    ).toBe(true);
    await setup.renderer.destroy();
  });

  test("failed 卡不吃 card 投影：走既有 failure overlay（锁句 5）", async () => {
    const card = projectSubagentCardLines(
      [makeSubagent({ role: "explore", toolUseId: "toolu_tail" })],
      "toolu_tail",
      80
    );
    const setup = await renderLiveBox(
      spawnRun({ status: "failed", detail: "boom" }),
      card
    );
    const frame = setup.captureCharFrame();
    // 失败横切优先：不画绿 done / dim 预览行。
    expect(frame.includes("done")).toBe(false);
    expect(frame).toBeDefined();
    await setup.renderer.destroy();
  });
});

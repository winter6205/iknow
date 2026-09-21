/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-two-line-budget.test.tsx
 *
 * Line-budget + render regression for lock clauses 1–3 of
 * specs/tui-subagent-transcript-live.md: the two lines now render on the
 * `spawn_subagent` card inside the session transcript (scroll region); the
 * identity strip above the prompt was removed — **whether or not live
 * subagents exist they no longer enter the chrome line budget**
 * (`subagentRowBudget` is constant 0; omitting `chromeReserveRows.subagentRows`
 * reserves nothing).
 *
 * This test formerly pinned the opposite proposition (strip above the input
 * box, 2 budgeted rows per live subagent); once the placement contract was
 * superseded that subject vanished, so it was rewritten to "no prompt line
 * budget + the card's two lines never weld together". Welding is the original
 * fingerprint of this regression (Yoga squashing the two-line block into one →
 * `查找文档explore running...`), independent of placement, so that assertion is
 * kept and pinned on two real hosts:
 *   - `SubagentCardView` (render surface shared by history and live cards);
 *   - `liveToolPreviewBox` (live-tail host, with card projection).
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
// 1) Line budget: no rows reserved above the prompt for subagents (lock clause 3)
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
    // The two lines are on the transcript card now (scroll region) — the chrome
    // budget must not grow with the live count, or blank rows appear above the
    // prompt (the reverse-regression gate of the old contract).
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
// 2) Two lines on the card: shape, color, no welding (lock clauses 1–2)
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
    // The welded form must not exist (direct fingerprint of line squashing):
    // the identity line may not share a row with any other text.
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
    // Summary must be present (being pushed out by the literal `done` is what
    // triggered the reopen).
    expect(lines).toContain("查找文档");
    expect(lines).toContain("✓ Done");
    expect(lines).toContain("explore");
    expect(lines.some((l) => l.includes("running..."))).toBe(false);
    // Order: summary first, completion marker directly below it.
    expect(lines.indexOf("✓ Done")).toBe(lines.indexOf("查找文档") + 1);
    const doneSpan = spanWithText(setup, "✓ Done");
    expect(doneSpan).toBeDefined();
    expect(rgbaEq(doneSpan!.fg, RGBA.fromHex(tuiPalette.add))).toBe(true);
    // The summary line stays dim (completion does not recolor it; green belongs
    // to the completion marker only).
    const previewSpan = spanWithText(setup, "查找文档");
    expect(rgbaEq(previewSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    await setup.renderer.destroy();
  });

  test("无 emoji 断言：卡渲染文本不含 U+1F300–U+1FAFF（几何字形纪律）", async () => {
    // The archived identity-strip test pinned this on the old host; after the
    // two lines changed hosts this test takes over — the render surface must
    // not **introduce** emoji decoration on its own (spec geometric-glyph
    // discipline: panel uses ● / ✓, the card's `✓ Done` marker likewise uses
    // geometric ✓, outside this range). Inputs are plain text, so any emoji in
    // the frame could only come from glyphs the render surface added itself.
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
// 3) live-tail host: card hit → two lines; failure → existing failure overlay
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
    // Existing detail-only text (dotless, from formatToolStatusLine) is still there.
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
    // Failure overlay takes precedence: no green done / dim preview lines.
    expect(frame.includes("done")).toBe(false);
    expect(frame).toBeDefined();
    await setup.renderer.destroy();
  });
});

/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-two-line-budget.test.tsx
 *
 * Line-budget + render regression for the spawn card in the session
 * transcript (scroll region). The identity strip above the prompt was removed
 * earlier and stays out of the chrome budget (`subagentRowBudget` is constant
 * 0); this file pins that plus the card's physical two lines per
 * specs/subagent-card-title.md: line 1 the operator title, line 2 the
 * activity slot (`name · argument summary` of the tool issued most recently
 * while live, dim; the literal `✓ Done` once completed) — no `running...`
 * suffix, no `taskPreview` row. Formerly this
 * file asserted the superseded three-line shape (`{role} running...` + dim
 * preview + `✓ Done`); re-pinned at the new contract's truth, keeping the
 * original regression fingerprint: the two lines must never weld together
 * (Yoga squashing the block into one row). Hosts pinned:
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
// 2) Two lines on the card: title + activity slot, color, no welding
// ============================================================================

async function renderCard(
  card: Parameters<typeof SubagentCardView>[0]["card"]
): Promise<TestRendererSetup> {
  const setup = await testRender(<SubagentCardView card={card} />, {
    width: 80,
    height: 5,
  });
  await setup.renderOnce();
  return setup;
}

function frameLines(setup: TestRendererSetup): string[] {
  return setup
    .captureCharFrame()
    .split("\n")
    .map((l) => l.trim());
}

describe("SubagentCardView（两行渲染面）", () => {
  test("live：第1行 title、第2行紧随其后的 dim 最近发出的工具名，互不粘连、无 running...", async () => {
    // Fixture note (unchanged under T2): `Bash` is not a registry key (the
    // registered name is lowercase `bash`), so this slot stays the bare
    // unknown-tool name. The summarized shape has its own case below.
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "explore",
          toolUseId: "toolu_live",
          title: "整理报告",
          activity: { toolName: "Bash", toolInput: {} },
        }),
      ],
      "toolu_live",
      80
    );
    expect(card).not.toBeNull();
    const setup = await renderCard(card!);
    const lines = frameLines(setup).filter((l) => l.length > 0);
    expect(lines).toContain("整理报告");
    expect(lines).toContain("Bash");
    expect(lines.indexOf("Bash")).toBe(lines.indexOf("整理报告") + 1);
    expect(lines.some((l) => l.includes("running"))).toBe(false);
    // The welded form must not exist (direct fingerprint of line squashing):
    // the title line may not share a row with any other text.
    expect(
      lines.some((l) => l.includes("整理报告") && l.includes("Bash"))
    ).toBe(false);
    await setup.renderer.destroy();
  });

  test("live：第 2 行 fg = palette.dim，且 ≠ 第 1 行 fg", async () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "explore",
          toolUseId: "toolu_dim",
          activity: { toolName: "Bash", toolInput: {} },
        }),
      ],
      "toolu_dim",
      80
    );
    const setup = await renderCard(card!);
    const titleSpan = spanWithText(setup, "explore");
    const detailSpan = spanWithText(setup, "Bash");
    expect(titleSpan).toBeDefined();
    expect(detailSpan).toBeDefined();
    expect(rgbaEq(detailSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    expect(rgbaEq(titleSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(false);
    await setup.renderer.destroy();
  });

  test("live：槽位带 `工具名 · 参数摘要` 时仍是 dim 的一行，不粘连、无 running", async () => {
    // The slot text itself is the pure projection's contract
    // (tests/tui/subagent-card-lines.test.ts). What this case owns is the render
    // surface: a longer line 2 must stay dim, must stay exactly one row below the
    // title, and must not be decorated with a running label or an emoji.
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "explore",
          toolUseId: "toolu_sum",
          title: "整理报告",
          activity: {
            toolName: "read_file",
            toolInput: { path: "src/a.ts" },
          },
        }),
      ],
      "toolu_sum",
      80
    );
    expect(card).not.toBeNull();
    expect(card!.detailLine).toBe("read_file · Read src/a.ts");
    const setup = await renderCard(card!);
    const lines = frameLines(setup).filter((l) => l.length > 0);
    // Exactly two rows, in order — the summary adds no third row.
    expect(lines).toEqual(["整理报告", "read_file · Read src/a.ts"]);
    expect(lines.indexOf("read_file · Read src/a.ts")).toBe(
      lines.indexOf("整理报告") + 1
    );
    expect(lines.some((l) => l.includes("running"))).toBe(false);
    // No welding (the original regression fingerprint of this file).
    expect(
      lines.some((l) => l.includes("整理报告") && l.includes("read_file"))
    ).toBe(false);
    const titleSpan = spanWithText(setup, "整理报告");
    const detailSpan = spanWithText(setup, "read_file · Read src/a.ts");
    expect(titleSpan).toBeDefined();
    expect(detailSpan).toBeDefined();
    expect(rgbaEq(detailSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    expect(rgbaEq(titleSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(false);
    // Summary bytes come from the worker's recorded input: still no emoji.
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(setup.captureCharFrame())).toBe(false);
    await setup.renderer.destroy();
  });

  test("空槽位（activity 缺席 / null）→ 仍占一行，卡片不塌缩", async () => {
    for (const activity of [undefined, null] as const) {
      const card = projectSubagentCardLines(
        [
          makeSubagent({
            role: "explore",
            toolUseId: "toolu_slot",
            ...(activity === undefined ? {} : { activity }),
          }),
        ],
        "toolu_slot",
        80
      );
      const setup = await renderCard(card!);
      const lines = frameLines(setup).filter((l) => l.length > 0);
      expect(lines).toEqual(["explore"]);
      await setup.renderer.destroy();
    }
  });

  test("completed：第1行与 live 逐字相同 + 其下绿 `✓ Done`；无工具名 / 无 taskPreview 行", async () => {
    const subagents = [
      makeSubagent({
        state: "completed",
        role: "explore",
        title: "整理报告",
        taskPreview: "查找文档",
        toolUseId: "toolu_done",
        endedAt: iso(500),
        // A retained call must not survive into the done card.
        activity: { toolName: "Bash", toolInput: {} },
      }),
    ];
    const map = subagentCardLinesMap(subagents, 80);
    const card = map.get("toolu_done");
    expect(card).toBeDefined();
    expect(card!.titleLine).toBe("整理报告");
    expect(card!.detailLine).toBe("✓ Done");
    const setup = await renderCard(card!);
    const lines = frameLines(setup).filter((l) => l.length > 0);
    expect(lines).toContain("整理报告");
    expect(lines).toContain("✓ Done");
    expect(lines.some((l) => l.includes("running"))).toBe(false);
    expect(lines.some((l) => l.includes("Bash"))).toBe(false);
    // SC7: taskPreview stays off the card (it lives in SubagentPanel).
    expect(lines.some((l) => l.includes("查找文档"))).toBe(false);
    // Order: title first, completion marker directly below it.
    expect(lines.indexOf("✓ Done")).toBe(lines.indexOf("整理报告") + 1);
    const doneSpan = spanWithText(setup, "✓ Done");
    expect(doneSpan).toBeDefined();
    expect(rgbaEq(doneSpan!.fg, RGBA.fromHex(tuiPalette.add))).toBe(true);
    // The title line keeps the default text color (completion does not
    // recolor it; green belongs to the completion marker only).
    const titleSpan = spanWithText(setup, "整理报告");
    expect(rgbaEq(titleSpan!.fg, RGBA.fromHex(tuiPalette.add))).toBe(false);
    expect(rgbaEq(titleSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(false);
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
          toolUseId: "toolu_emoji",
          title: "查找文档并整理结果",
          activity: { toolName: "Read", toolInput: {} },
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
  test("card 命中 → 卡上两行（title + dim 最近发出的工具名），不再走单行标题", async () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "explore",
          toolUseId: "toolu_tail",
          title: "整理报告",
          activity: { toolName: "Bash", toolInput: {} },
        }),
      ],
      "toolu_tail",
      80
    );
    const setup = await renderLiveBox(spawnRun(), card);
    const lines = frameLines(setup).filter((l) => l.length > 0);
    expect(lines).toContain("整理报告");
    expect(lines).toContain("Bash");
    expect(lines.some((l) => l.includes("running"))).toBe(false);
    await setup.renderer.destroy();
  });

  test("card 缺省（无关联键）→ 回落既有单行标题（不改 tool-line 模板）", async () => {
    const setup = await renderLiveBox(spawnRun());
    const lines = frameLines(setup);
    // Existing detail-only text (dotless, from formatToolStatusLine) is still there.
    expect(
      lines.some((l) => l.includes("explore running") && !l.includes("..."))
    ).toBe(true);
    await setup.renderer.destroy();
  });

  test("failed 卡不吃 card 投影：走既有 failure overlay（SC5）", async () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "explore",
          toolUseId: "toolu_tail",
          title: "整理报告",
          activity: { toolName: "Bash", toolInput: {} },
        }),
      ],
      "toolu_tail",
      80
    );
    const setup = await renderLiveBox(
      spawnRun({ status: "failed", detail: "boom" }),
      card
    );
    const frame = setup.captureCharFrame();
    // Failure overlay takes precedence: no green done / activity-name lines.
    expect(frame.includes("done")).toBe(false);
    expect(frame).toBeDefined();
    await setup.renderer.destroy();
  });
});

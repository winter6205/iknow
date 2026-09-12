/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-message-lines.test.tsx
 *
 * spec Slice D / SC14（`specs/agent-control-surface.md`）/ plan task 8 ——
 * 会话消息内「每个活子代理两行」投影的单元 + 渲染测：
 *   第 1 行 `{role} running...`，第 2 行 dim 为最新内容（taskPreview）。
 *
 * 覆盖 5 类边界（empty / negative / overflow / concurrent / exception）：
 *   - empty：`[]` / 仅 completed / 仅 failed → 0 行（host 渲染 null）；
 *   - negative：缺 role → catalog fallback（永不输出「子代理」）；空
 *     taskPreview → detail 行空串（host 渲染空行占位，两行账不变）；
 *   - overflow：两行各自按 cols 视觉宽度截断（CJK-safe），永不换行；
 *   - concurrent：纯函数两次同输入同输出；不同数组不串；
 *   - exception：非法 ISO / 缺 endedAt 不影响本投影（不读时间字段）。
 *
 * 渲染层（OpenTUI）：`SubagentIdentityStrip` 是 host —— 0 行 → null；
 * 1 个 live → 两行文本；第 2 行 fg = dim 且 ≠ 第 1 行 fg（dim 标记）；
 * 2 个 live → 4 行且块顺序 = live 顺序。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  IDENTITY_FALLBACK_ROLE,
  projectSubagentMessageLines,
  resolveIdentityRole,
  subagentMessageRowCount,
} from "../../src/tui/subagent-message-lines.js";
import { SubagentIdentityStrip } from "../../src/tui/subagent-identity-strip.js";
import { tuiPalette } from "../../src/tui/theme.js";
import { visualWidth } from "../../src/tui/tool-summary.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

// 固定基准时间：fixture 的 ISO 偏移相对 T0 计算，不依赖真实 Date.now。
const T0 = Date.parse("2026-09-07T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

let fixtureCounter = 0;
function makeSubagent(overrides: Partial<SubagentInfo>): SubagentInfo {
  fixtureCounter += 1;
  return {
    taskId: `t-msg-${fixtureCounter}`,
    state: "running",
    taskPreview: "查找文档",
    startedAt: iso(-1000),
    ...overrides,
  };
}

function rgbaEq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** 按文本取 span（首命中）。 */
function spanWithText(
  setup: TestRendererSetup,
  needle: string
): { text: string; fg: RGBA; bg: RGBA } | undefined {
  for (const line of setup.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span;
    }
  }
  return undefined;
}

/** 非空行文本（renderer 行序 = 视觉顺序）。 */
function nonEmptyLines(setup: TestRendererSetup): ReadonlyArray<string> {
  return setup
    .captureCharFrame()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ============================================================================
// 纯函数：projectSubagentMessageLines
// ============================================================================

describe("projectSubagentMessageLines — empty（无 live → 0 行）", () => {
  test("subagents=[] → []", () => {
    expect(projectSubagentMessageLines([], 80)).toEqual([]);
  });

  test("仅 completed / failed → []（终态归面板，不进消息两行）", () => {
    expect(
      projectSubagentMessageLines(
        [
          makeSubagent({ state: "completed", endedAt: iso(-1000) }),
          makeSubagent({ state: "failed", endedAt: iso(-500) }),
        ],
        80
      )
    ).toEqual([]);
  });

  test("行账：无 live → 0；2 live → 4", () => {
    expect(subagentMessageRowCount([])).toBe(0);
    expect(
      subagentMessageRowCount([
        makeSubagent({ state: "completed", endedAt: iso(-1000) }),
      ])
    ).toBe(0);
    expect(
      subagentMessageRowCount([
        makeSubagent({ state: "running" }),
        makeSubagent({ state: "starting" }),
      ])
    ).toBe(4);
  });
});

describe("projectSubagentMessageLines — negative（role fallback / 空 preview）", () => {
  test("缺 role → catalog fallback general-purpose", () => {
    const lines = projectSubagentMessageLines(
      [makeSubagent({ role: undefined })],
      80
    );
    expect(lines[0]?.roleLine).toBe(`${IDENTITY_FALLBACK_ROLE} running...`);
  });

  test("role 空串 / 纯空白 → catalog fallback；非空 → trim 后原样", () => {
    expect(
      projectSubagentMessageLines([makeSubagent({ role: "  " })], 80)[0]
        ?.roleLine
    ).toBe("general-purpose running...");
    expect(
      projectSubagentMessageLines([makeSubagent({ role: " explore " })], 80)[0]
        ?.roleLine
    ).toBe("explore running...");
    // 与 strip 的 role 解析同源（同一函数，不双写规则）
    expect(resolveIdentityRole(makeSubagent({ role: "" }))).toBe(
      IDENTITY_FALLBACK_ROLE
    );
  });

  test("钉死约束：任何输入都不输出「子代理」", () => {
    for (const c of [
      {},
      { role: undefined },
      { role: "" },
      { role: "   " },
    ] as ReadonlyArray<Partial<SubagentInfo>>) {
      const lines = projectSubagentMessageLines([makeSubagent(c)], 80);
      expect(lines[0]?.roleLine).not.toContain("子代理");
    }
  });

  test("空 taskPreview → detailLine 空串（host 渲染空行占位，两行账不变）", () => {
    const lines = projectSubagentMessageLines(
      [makeSubagent({ taskPreview: "" })],
      80
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detailLine).toBe("");
    expect(subagentMessageRowCount([makeSubagent({ taskPreview: "" })])).toBe(
      2
    );
  });

  test("纯空白 taskPreview → 折叠为空串（clipOneLineVisual 同款口径）", () => {
    expect(
      projectSubagentMessageLines(
        [makeSubagent({ taskPreview: "   \t " })],
        80
      )[0]?.detailLine
    ).toBe("");
  });
});

describe("projectSubagentMessageLines — 两行形状与状态覆盖", () => {
  test("starting / running 都算 live（两行），role 原样", () => {
    const lines = projectSubagentMessageLines(
      [
        makeSubagent({ state: "starting", role: "explore" }),
        makeSubagent({ state: "running", role: "general-purpose" }),
      ],
      80
    );
    expect(lines.map((l) => l.roleLine)).toEqual([
      "explore running...",
      "general-purpose running...",
    ]);
    expect(lines.map((l) => l.detailLine)).toEqual(["查找文档", "查找文档"]);
  });

  test("顺序 = 入参顺序（与 SubagentPanel 的 live 前缀同序）", () => {
    const lines = projectSubagentMessageLines(
      [
        makeSubagent({ state: "running", taskPreview: "第一个" }),
        makeSubagent({ state: "running", taskPreview: "第二个" }),
        makeSubagent({ state: "completed", taskPreview: "已完成" }),
      ],
      80
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.detailLine).toBe("第一个");
    expect(lines[1]?.detailLine).toBe("第二个");
  });

  test("concurrent：同输入两次投影同输出", () => {
    const subs = [makeSubagent({ role: "explore" })];
    expect(projectSubagentMessageLines(subs, 80)).toEqual(
      projectSubagentMessageLines(subs, 80)
    );
  });
});

describe("projectSubagentMessageLines — overflow（cols 视觉宽度截断）", () => {
  test("超长 role + 窄列 → 两行视觉宽度 ≤ cols，且无换行", () => {
    const lines = projectSubagentMessageLines(
      [
        makeSubagent({
          role: "a".repeat(100),
          taskPreview: "b".repeat(100),
        }),
      ],
      20
    );
    expect(visualWidth(lines[0]!.roleLine)).toBeLessThanOrEqual(20);
    expect(visualWidth(lines[0]!.detailLine)).toBeLessThanOrEqual(20);
    expect(lines[0]!.roleLine.includes("\n")).toBe(false);
    expect(lines[0]!.detailLine.includes("\n")).toBe(false);
  });

  test("CJK taskPreview 窄列 → 按视觉宽度（CJK 占 2 列）截断", () => {
    const lines = projectSubagentMessageLines(
      [makeSubagent({ taskPreview: "查找文档并且继续往下列出更多内容" })],
      12
    );
    expect(visualWidth(lines[0]!.detailLine)).toBeLessThanOrEqual(12);
  });

  test("cols = 1 退化 → 每行 ≤ 1 列（永不越界）", () => {
    const lines = projectSubagentMessageLines(
      [makeSubagent({ role: "explore", taskPreview: "查找文档" })],
      1
    );
    expect(visualWidth(lines[0]!.roleLine)).toBeLessThanOrEqual(1);
    expect(visualWidth(lines[0]!.detailLine)).toBeLessThanOrEqual(1);
  });
});

describe("projectSubagentMessageLines — exception（不读时间字段）", () => {
  test("非法 startedAt / 缺 endedAt 不影响投影", () => {
    const lines = projectSubagentMessageLines(
      [
        makeSubagent({
          role: "explore",
          startedAt: "not-a-date",
          taskPreview: "查",
        }),
      ],
      80
    );
    expect(lines[0]?.roleLine).toBe("explore running...");
    expect(lines[0]?.detailLine).toBe("查");
  });
});

// ============================================================================
// 渲染（OpenTUI）— host = SubagentIdentityStrip
// ============================================================================

async function renderStrip(props: {
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly cols?: number;
}): Promise<TestRendererSetup> {
  const cols = props.cols ?? 80;
  const setup = await testRender(
    <SubagentIdentityStrip subagents={props.subagents} cols={cols} />,
    { width: cols, height: 6 }
  );
  await setup.renderOnce();
  return setup;
}

describe("SubagentIdentityStrip（会话消息内两行）渲染", () => {
  test("empty：0 live → 帧内无 running... / 无 taskPreview", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({
          state: "completed",
          taskPreview: "已完成任务",
          endedAt: iso(-1000),
        }),
      ],
    });
    const frame = setup.captureCharFrame();
    expect(frame.includes("running...")).toBe(false);
    expect(frame.includes("已完成任务")).toBe(false);
    await setup.renderer.destroy();
  });

  test("1 live → 两行：role 行 + taskPreview 行，且 preview 行紧随其后", async () => {
    const setup = await renderStrip({
      subagents: [makeSubagent({ role: "explore", taskPreview: "查找文档" })],
    });
    const lines = nonEmptyLines(setup);
    expect(lines).toContain("explore running...");
    expect(lines).toContain("查找文档");
    expect(lines.indexOf("查找文档")).toBe(
      lines.indexOf("explore running...") + 1
    );
    await setup.renderer.destroy();
  });

  test("dim 标记：第 2 行 fg = palette.dim，且 ≠ 第 1 行 fg", async () => {
    const setup = await renderStrip({
      subagents: [makeSubagent({ role: "explore", taskPreview: "查找文档" })],
    });
    const roleSpan = spanWithText(setup, "explore running...");
    const detailSpan = spanWithText(setup, "查找文档");
    expect(roleSpan).toBeDefined();
    expect(detailSpan).toBeDefined();
    expect(rgbaEq(detailSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    expect(rgbaEq(roleSpan!.fg, RGBA.fromHex(tuiPalette.dim))).toBe(false);
    await setup.renderer.destroy();
  });

  test("2 live → 4 行，块顺序 = live 顺序（role2 在 role1 的 preview 之后）", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({ role: "explore", taskPreview: "第一个任务" }),
        makeSubagent({ role: "general-purpose", taskPreview: "第二个任务" }),
      ],
    });
    const lines = nonEmptyLines(setup);
    expect(lines).toEqual([
      "explore running...",
      "第一个任务",
      "general-purpose running...",
      "第二个任务",
    ]);
    await setup.renderer.destroy();
  });

  test("non-live 混入 → 只渲染 live 两行（completed / failed 不出现）", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({
          state: "running",
          role: "explore",
          taskPreview: "活着",
        }),
        makeSubagent({
          state: "completed",
          role: "general-purpose",
          taskPreview: "已完成的预览",
          endedAt: iso(-1000),
        }),
        makeSubagent({
          state: "failed",
          role: "general-purpose",
          taskPreview: "失败预览",
          endedAt: iso(-500),
        }),
      ],
    });
    const lines = nonEmptyLines(setup);
    expect(lines).toEqual(["explore running...", "活着"]);
    await setup.renderer.destroy();
  });

  test("空 taskPreview → 仍占两行（role 行 + 空行占位）", async () => {
    const setup = await renderStrip({
      subagents: [makeSubagent({ role: "explore", taskPreview: "" })],
    });
    const lines = nonEmptyLines(setup);
    expect(lines).toEqual(["explore running..."]);
    // 占位行不是空帧：role 行之下还有一个（空格）行，高度账不塌陷。
    const frameLines = setup.captureCharFrame().split("\n");
    const roleIdx = frameLines.findIndex((l) =>
      l.includes("explore running...")
    );
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(frameLines.length).toBeGreaterThan(roleIdx + 1);
    await setup.renderer.destroy();
  });

  test("无 emoji 断言：渲染帧不含 U+1F300–U+1FAFF", async () => {
    const setup = await renderStrip({
      subagents: [makeSubagent({ role: "explore", taskPreview: "查找文档" })],
    });
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(setup.captureCharFrame())).toBe(false);
    await setup.renderer.destroy();
  });
});

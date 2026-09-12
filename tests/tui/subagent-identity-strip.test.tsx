/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-identity-strip.test.tsx
 *
 * plans/tui-chrome-interaction.md T7 + spec Slice D / SC14
 * （`specs/agent-control-surface.md`）：subagent identity strip 单元 + 渲染测试。
 * 该条即 SC14「会话消息内两行」的 host（immediately above the prompt）。
 *
 * 覆盖 5 类边界：
 *   1) empty：subagents=[] → 0 行（null）；含 completed/failed 但无 live → 0 行。
 *   2) negative：role 缺席 / 空串 / 纯空白 → 永不输出「子代理」字面值，
 *      永远 catalog fallback `general-purpose`（钉死）。
 *   3) overflow：长 role 名 + 多 live → 两行各自按 cols 视觉宽度截断（永不换行）。
 *   4) concurrent：active 会话切换时（两组 subagents 数组）→ 单次投影取调用
 *      时刻的入参，无历史残留，无串态（连续两次不同输入 → 不同输出）。
 *   5) exception：缺 taskPreview / 非法 ISO / endedAt 不影响本投影（identity
 *      strip 不读时间字段）。
 *
 * 渲染层（OpenTUI）：组件 `<SubagentIdentityStrip>` 走 testRender，验证：
 *   - 0 行 subagents → 渲染 null（无 <text> 节点）；
 *   - 1 个 live → 两行文本（role 行 + dim taskPreview 行），行高账 = 2；
 *   - 2 个 live → 4 行且块顺序 = live 顺序；
 *   - 无 emoji（U+1F300–U+1FAFF 守卫，与 subagent-panel.test.tsx 同纪律）;
 *   - 窄列 overflow：多 live 在 cols=12 下仍逐行渲染（永不越界换行）。
 *
 * 逐行形状 / dim 标记 / 空 preview 占位的更强断言在
 * tests/tui/subagent-message-lines.test.tsx（投影 SSOT 测试）；本文件钉 strip
 * 作为 host 的接线与 T7 原有约束（role fallback、无 emoji、行账）。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  SubagentIdentityStrip,
  identityStripVisualWidth,
} from "../../src/tui/subagent-identity-strip.js";
// role 解析 / 两行投影 / 行账的 SSOT 在 subagent-message-lines.ts（strip 只挂
// JSX）；T7 既有的 fallback 断言原样保留，仅改指向 SSOT 模块。
import {
  IDENTITY_FALLBACK_ROLE,
  projectSubagentMessageLines,
  resolveIdentityRole,
  subagentMessageRowCount,
} from "../../src/tui/subagent-message-lines.js";
import { visualWidth } from "../../src/tui/tool-summary.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

// ============================================================================
// Fixtures
// ============================================================================

const T0 = Date.parse("2026-09-07T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

let fixtureCounter = 0;
function makeSubagent(overrides: Partial<SubagentInfo>): SubagentInfo {
  fixtureCounter += 1;
  return {
    taskId: `t-${fixtureCounter}`,
    state: "running",
    taskPreview: "查找文档",
    startedAt: iso(-1000),
    ...overrides,
  };
}

// ============================================================================
// 纯函数：resolveIdentityRole
// ============================================================================

describe("resolveIdentityRole — negative 边界（永不输出「子代理」字面值）", () => {
  test("role 缺席 → catalog fallback general-purpose", () => {
    expect(resolveIdentityRole(makeSubagent({ state: "running" }))).toBe(
      IDENTITY_FALLBACK_ROLE
    );
  });

  test("role 空串 → catalog fallback general-purpose", () => {
    expect(
      resolveIdentityRole(makeSubagent({ role: "", state: "running" }))
    ).toBe(IDENTITY_FALLBACK_ROLE);
  });

  test("role 纯空白 → catalog fallback general-purpose", () => {
    expect(
      resolveIdentityRole(makeSubagent({ role: "   \t  ", state: "running" }))
    ).toBe(IDENTITY_FALLBACK_ROLE);
  });

  test("role 非空 → trim 后原样（不强制 catalog fallback）", () => {
    expect(
      resolveIdentityRole(makeSubagent({ role: "explore", state: "running" }))
    ).toBe("explore");
    expect(
      resolveIdentityRole(
        makeSubagent({ role: "  general-purpose  ", state: "running" })
      )
    ).toBe("general-purpose");
  });

  test("钉死约束：resolveIdentityRole 任何输入都不返回「子代理」", () => {
    const cases: ReadonlyArray<Partial<SubagentInfo>> = [
      {},
      { role: undefined },
      { role: "" },
      { role: "   " },
    ];
    for (const c of cases) {
      expect(resolveIdentityRole(makeSubagent(c))).not.toBe("子代理");
    }
  });
});

// ============================================================================
// 投影纯函数：projectSubagentMessageLines + subagentMessageRowCount
// ============================================================================

describe("projectSubagentMessageLines — empty / negative / concurrent", () => {
  test("empty: subagents=[] → 0 行", () => {
    expect(projectSubagentMessageLines([], 80)).toEqual([]);
  });

  test("empty: 仅有 completed / failed → 0 行（终态归面板）", () => {
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

  test("1 个 live starting → role 行 '{role} running...' + detail 行", () => {
    const lines = projectSubagentMessageLines(
      [makeSubagent({ state: "starting", role: "explore" })],
      80
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.roleLine).toBe("explore running...");
    expect(lines[0]?.detailLine).toBe("查找文档");
  });

  test("2 个 live → 2 块（顺序 = 入参顺序），role 原样", () => {
    const lines = projectSubagentMessageLines(
      [
        makeSubagent({ state: "running", role: "general-purpose" }),
        makeSubagent({
          taskId: "t-2",
          state: "starting",
          role: "explore",
        }),
      ],
      80
    );
    expect(lines.map((l) => l.roleLine)).toEqual([
      "general-purpose running...",
      "explore running...",
    ]);
  });

  test("3 个 live，缺 role → catalog fallback（永不输出「子代理」）", () => {
    const lines = projectSubagentMessageLines(
      [
        makeSubagent({ role: "explore" }),
        makeSubagent({ taskId: "t-2", role: "" }),
        makeSubagent({ taskId: "t-3" }),
      ],
      80
    );
    expect(lines.map((l) => l.roleLine)).toEqual([
      "explore running...",
      "general-purpose running...",
      "general-purpose running...",
    ]);
    for (const l of lines) expect(l.roleLine).not.toContain("子代理");
  });

  test("subagentMessageRowCount（strip 行账 SSOT）：empty → 0；每 live 2 行", () => {
    expect(subagentMessageRowCount([])).toBe(0);
    expect(
      subagentMessageRowCount([makeSubagent({ state: "completed" })])
    ).toBe(0);
    expect(
      subagentMessageRowCount([
        makeSubagent({ state: "running", role: "explore" }),
      ])
    ).toBe(2);
    expect(
      subagentMessageRowCount([
        makeSubagent({ state: "running", role: "explore" }),
        makeSubagent({ taskId: "t-2", state: "starting", role: "explore" }),
      ])
    ).toBe(4);
  });
});

describe("projectSubagentMessageLines — overflow（按 cols 视觉宽度截断）", () => {
  test("超长 role 名 + 窄列 → 两行视觉宽度 ≤ cols", () => {
    const lines = projectSubagentMessageLines(
      [
        makeSubagent({
          state: "running",
          role: "a".repeat(100), // 100 字符 role
          taskPreview: "b".repeat(100),
        }),
      ],
      20
    );
    expect(identityStripVisualWidth(lines[0]!.roleLine)).toBeLessThanOrEqual(
      20
    );
    expect(identityStripVisualWidth(lines[0]!.detailLine)).toBeLessThanOrEqual(
      20
    );
    expect(lines[0]!.roleLine.length).toBeLessThanOrEqual(20);
  });

  test("多 live + 窄列 → 每行单行（永不换行），视觉宽度 ≤ cols", () => {
    const lines = projectSubagentMessageLines(
      [
        makeSubagent({ state: "running", role: "explore" }),
        makeSubagent({
          taskId: "t-2",
          state: "running",
          role: "general-purpose",
        }),
        makeSubagent({ taskId: "t-3", state: "running", role: "explore" }),
        makeSubagent({
          taskId: "t-4",
          state: "running",
          role: "general-purpose",
        }),
      ],
      30
    );
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      expect(l.roleLine.includes("\n")).toBe(false);
      expect(l.detailLine.includes("\n")).toBe(false);
      expect(visualWidth(l.roleLine)).toBeLessThanOrEqual(30);
      expect(visualWidth(l.detailLine)).toBeLessThanOrEqual(30);
    }
  });

  test("cols = 1 退化：超长 role → 截断为单字符宽度（永不越界）", () => {
    const lines = projectSubagentMessageLines(
      [makeSubagent({ role: "explore" })],
      1
    );
    expect(identityStripVisualWidth(lines[0]!.roleLine)).toBeLessThanOrEqual(1);
    expect(identityStripVisualWidth(lines[0]!.detailLine)).toBeLessThanOrEqual(
      1
    );
  });
});

describe("projectSubagentMessageLines — exception / concurrent", () => {
  test("exception：subagent 含非法 ISO / 缺 taskPreview 不影响本投影", () => {
    const lines = projectSubagentMessageLines(
      [
        makeSubagent({
          state: "running",
          role: "explore",
          startedAt: "not-a-date",
          taskPreview: "",
        }),
      ],
      80
    );
    expect(lines[0]?.roleLine).toBe("explore running...");
    expect(lines[0]?.detailLine).toBe("");
  });

  test("concurrent：两次连续投影同输入 → 同输出（纯函数）", () => {
    const subs = [
      makeSubagent({ state: "running", role: "explore" }),
      makeSubagent({
        taskId: "t-2",
        state: "starting",
        role: "general-purpose",
      }),
    ];
    expect(projectSubagentMessageLines(subs, 80)).toEqual(
      projectSubagentMessageLines(subs, 80)
    );
  });

  test("concurrent：两组 subagents 数组不串（每次取调用时刻入参）", () => {
    const groupA = [makeSubagent({ role: "explore" })];
    const groupB = [
      makeSubagent({ taskId: "t-2", role: "general-purpose" }),
      makeSubagent({ taskId: "t-3", role: "explore" }),
    ];
    const a = projectSubagentMessageLines(groupA, 80);
    const b = projectSubagentMessageLines(groupB, 80);
    expect(a.map((l) => l.roleLine)).toEqual(["explore running..."]);
    expect(b.map((l) => l.roleLine)).toEqual([
      "general-purpose running...",
      "explore running...",
    ]);
    // 切换后再投 A → 仍 A，不串
    expect(projectSubagentMessageLines(groupA, 80)).toEqual(a);
  });
});

// ============================================================================
// 渲染（OpenTUI）— 组件空 / 1 live / 2 live / 无 emoji / 窄列
// ============================================================================

async function renderStrip(props: {
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly cols: number;
}): Promise<TestRendererSetup> {
  const setup = await testRender(
    <SubagentIdentityStrip subagents={props.subagents} cols={props.cols} />,
    { width: props.cols, height: 6 }
  );
  await setup.renderOnce();
  return setup;
}

/** 非空行文本（renderer 行序 = 视觉顺序）。 */
function nonEmptyLines(setup: TestRendererSetup): ReadonlyArray<string> {
  return setup
    .captureCharFrame()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("SubagentIdentityStrip 渲染（OpenTUI）", () => {
  test("empty: 0 live 子代理 → 帧内无 running... 字面值", async () => {
    const setup = await renderStrip({
      subagents: [makeSubagent({ state: "completed", endedAt: iso(-1000) })],
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    expect(frame.includes("running")).toBe(false);
    await setup.renderer.destroy();
  });

  test("1 live starting → 含 `running...`（角色 catalog id）+ preview 行", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({
          state: "starting",
          role: "explore",
          taskPreview: "查一下",
        }),
      ],
      cols: 80,
    });
    const lines = nonEmptyLines(setup);
    expect(lines).toContain("explore running...");
    expect(lines).toContain("查一下");
    await setup.renderer.destroy();
  });

  test("2 live → 4 行，块顺序 = live 顺序", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({
          state: "running",
          role: "general-purpose",
          taskPreview: "第一件",
        }),
        makeSubagent({
          taskId: "t-2",
          state: "starting",
          role: "explore",
          taskPreview: "第二件",
        }),
      ],
      cols: 80,
    });
    expect(nonEmptyLines(setup)).toEqual([
      "general-purpose running...",
      "第一件",
      "explore running...",
      "第二件",
    ]);
    await setup.renderer.destroy();
  });

  test("钉死约束：渲染帧不含「子代理」字面值", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({ state: "running" }), // role 缺席 → fallback
        makeSubagent({ taskId: "t-2", state: "starting", role: "" }),
      ],
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("子代理");
    expect(frame).toContain("general-purpose running...");
    await setup.renderer.destroy();
  });

  test("无 emoji 断言：渲染帧不含 U+1F300–U+1FAFF", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({ state: "running", role: "explore" }),
        makeSubagent({
          taskId: "t-2",
          state: "running",
          role: "general-purpose",
        }),
      ],
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    const emojiRegex = /[\u{1F300}-\u{1FAFF}]/u;
    expect(emojiRegex.test(frame)).toBe(false);
    await setup.renderer.destroy();
  });

  test("窄列 overflow：cols=12 多 live → 每块两行、宽度不越界", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({
          state: "running",
          role: "general-purpose",
          taskPreview: "第一件事的描述",
        }),
        makeSubagent({
          taskId: "t-2",
          state: "running",
          role: "explore",
          taskPreview: "第二件事的描述",
        }),
      ],
      cols: 12,
    });
    const frame = setup.captureCharFrame();
    const lines = nonEmptyLines(setup);
    // 2 live × 2 行 = 4 个非空行（role 行必非空；preview 截断后仍非空）。
    expect(lines).toHaveLength(4);
    for (const l of frame.split("\n")) {
      expect(visualWidth(l)).toBeLessThanOrEqual(12);
    }
    await setup.renderer.destroy();
  });
});

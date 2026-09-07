/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-identity-strip.test.tsx
 *
 * plans/tui-chrome-interaction.md T7：subagent identity strip 单元 + 渲染测试。
 *
 * 覆盖 5 类边界：
 *   1) empty：subagents=[] → 0 行（null）；含 completed/failed 但无 live → 0 行。
 *   2) negative：role 缺席 / 空串 / 纯空白 → 永不输出「子代理」字面值，
 *      永远 catalog fallback `general-purpose`（钉死）。
 *   3) overflow：长 role 名 + 多 live → 按 cols 视觉宽度截断（永不换行）。
 *   4) concurrent：active 会话切换时（两组 subagents 数组）→ 单次投影取调用
 *      时刻的入参，无历史残留，无串态（连续两次不同输入 → 不同输出）。
 *   5) exception：缺 taskPreview / 非法 ISO / endedAt 不影响本投影（identity
 *      strip 不读 taskPreview / 时间字段）。
 *
 * 渲染层（OpenTUI）：组件 `<SubagentIdentityStrip>` 走 testRender，验证：
 *   - 0 行 subagents → 渲染 null（无 <text> 节点）；
 *   - 1 个 live → 渲染一行 dim 文本（含 `running...`）；
 *   - 2 个 live → 一行内含两个 role（`· ` 连接）；
 *   - 无 emoji（U+1F300–U+1FAFF 守卫，与 subagent-panel.test.tsx 同纪律）。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  IDENTITY_FALLBACK_ROLE,
  SubagentIdentityStrip,
  identityStripVisualWidth,
  projectIdentityStripLine,
  resolveIdentityRole,
  subagentIdentityStripRows,
} from "../../src/tui/subagent-identity-strip.js";
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
// 纯函数：projectIdentityStripLine + subagentIdentityStripRows
// ============================================================================

describe("projectIdentityStripLine — empty / negative / concurrent", () => {
  test("empty: subagents=[] → ''", () => {
    expect(projectIdentityStripLine([], 80)).toBe("");
  });

  test("empty: 仅有 completed / failed → ''", () => {
    expect(
      projectIdentityStripLine(
        [
          makeSubagent({ state: "completed", endedAt: iso(-1000) }),
          makeSubagent({ state: "failed", endedAt: iso(-500) }),
        ],
        80
      )
    ).toBe("");
  });

  test("1 个 live starting → '{role} running...'", () => {
    expect(
      projectIdentityStripLine(
        [makeSubagent({ state: "starting", role: "explore" })],
        80
      )
    ).toBe("explore running...");
  });

  test("2 个 live → '{role1} running... · {role2} running...'", () => {
    expect(
      projectIdentityStripLine(
        [
          makeSubagent({ state: "running", role: "general-purpose" }),
          makeSubagent({
            taskId: "t-2",
            state: "starting",
            role: "explore",
          }),
        ],
        80
      )
    ).toBe("general-purpose running... · explore running...");
  });

  test("3 个 live，缺 role → catalog fallback（永不输出「子代理」）", () => {
    const line = projectIdentityStripLine(
      [
        makeSubagent({ role: "explore" }),
        makeSubagent({ taskId: "t-2", role: "" }),
        makeSubagent({ taskId: "t-3" }),
      ],
      80
    );
    expect(line).toBe(
      "explore running... · general-purpose running... · general-purpose running..."
    );
    expect(line).not.toContain("子代理");
  });

  test("subagentIdentityStripRows：empty → 0；含 live → 1", () => {
    expect(subagentIdentityStripRows([])).toBe(0);
    expect(
      subagentIdentityStripRows([makeSubagent({ state: "completed" })])
    ).toBe(0);
    expect(
      subagentIdentityStripRows([
        makeSubagent({ state: "running", role: "explore" }),
      ])
    ).toBe(1);
  });
});

describe("projectIdentityStripLine — overflow（按 cols 视觉宽度截断）", () => {
  test("超长 role 名 + 窄列 → 按 cols 截断，视觉宽度 ≤ cols", () => {
    const line = projectIdentityStripLine(
      [
        makeSubagent({
          state: "running",
          role: "a".repeat(100), // 100 字符 role
        }),
      ],
      20
    );
    expect(identityStripVisualWidth(line)).toBeLessThanOrEqual(20);
    expect(line.length).toBeLessThanOrEqual(20);
  });

  test("多 live + 窄列 → 仍单行（永不换行），视觉宽度 ≤ cols", () => {
    const line = projectIdentityStripLine(
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
    expect(line.includes("\n")).toBe(false);
    expect(identityStripVisualWidth(line)).toBeLessThanOrEqual(30);
  });

  test("cols = 1 退化：超长 role → 截断为单字符宽度（永不越界）", () => {
    const line = projectIdentityStripLine(
      [makeSubagent({ role: "explore" })],
      1
    );
    expect(identityStripVisualWidth(line)).toBeLessThanOrEqual(1);
  });
});

describe("projectIdentityStripLine — exception / concurrent", () => {
  test("exception：subagent 含非法 ISO / 缺 taskPreview 不影响本投影", () => {
    const line = projectIdentityStripLine(
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
    expect(line).toBe("explore running...");
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
    const a = projectIdentityStripLine(subs, 80);
    const b = projectIdentityStripLine(subs, 80);
    expect(a).toBe(b);
  });

  test("concurrent：两组 subagents 数组不串（每次取调用时刻入参）", () => {
    const groupA = [makeSubagent({ role: "explore" })];
    const groupB = [
      makeSubagent({ taskId: "t-2", role: "general-purpose" }),
      makeSubagent({ taskId: "t-3", role: "explore" }),
    ];
    const a = projectIdentityStripLine(groupA, 80);
    const b = projectIdentityStripLine(groupB, 80);
    expect(a).toBe("explore running...");
    expect(b).toBe("general-purpose running... · explore running...");
    // 切换后再投 A → 仍 A，不串
    expect(projectIdentityStripLine(groupA, 80)).toBe(a);
  });
});

// ============================================================================
// 渲染（OpenTUI）— 组件空 / 1 live / 2 live / 无 emoji
// ============================================================================

async function renderStrip(props: {
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly cols: number;
}) {
  const setup = await testRender(
    <SubagentIdentityStrip subagents={props.subagents} cols={props.cols} />,
    { width: props.cols, height: 4 }
  );
  await setup.renderOnce();
  return setup;
}

describe("SubagentIdentityStrip 渲染（OpenTUI）", () => {
  test("empty: 0 live 子代理 → 帧内无 running... 字面值", async () => {
    const setup = await renderStrip({
      subagents: [makeSubagent({ state: "completed", endedAt: iso(-1000) })],
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    expect(frame.includes("running")).toBe(false);
  });

  test("1 live starting → 含 `running...`（角色 catalog id）", async () => {
    const setup = await renderStrip({
      subagents: [makeSubagent({ state: "starting", role: "explore" })],
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("explore running...");
  });

  test("2 live → 同帧含两个角色 + `·` 分隔", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({ state: "running", role: "general-purpose" }),
        makeSubagent({
          taskId: "t-2",
          state: "starting",
          role: "explore",
        }),
      ],
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("general-purpose running...");
    expect(frame).toContain("·");
    expect(frame).toContain("explore running...");
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
  });

  test("窄列 overflow：cols=12 → 帧单行（不含换行）", async () => {
    const setup = await renderStrip({
      subagents: [
        makeSubagent({ state: "running", role: "general-purpose" }),
        makeSubagent({ taskId: "t-2", state: "running", role: "explore" }),
      ],
      cols: 12,
    });
    const frame = setup.captureCharFrame();
    // 单行：行末不应有显式换行污染
    expect(frame.split("\n").filter((l) => l.trim().length > 0).length).toBe(1);
  });
});

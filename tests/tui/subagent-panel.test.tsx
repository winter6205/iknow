/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-panel.test.tsx
 *
 * #358 T3 / TUI 子代理状态面板测试。
 *
 * 覆盖：
 *   1. 可见性 9 类（空 / 1 running / starting / failed ≤30s / failed >30s /
 *      全 completed ≤5s / 全 completed >5s / 4 active 折叠 / 窄列 / 无 emoji）；
 *   2. 纯函数边界（elapsedSec 非法 ISO / 空串 / 整秒差）。
 *   3. 秒→字符串格式边界（`formatRunDuration`，run-stats.ts SSOT）已并入
 *      `tests/tui/run-stats.test.ts` 的 formatRunDuration describe（与 mode
 *      行 / Crunched 行共享同一纯函数，测试收敛到一处）。
 *
 * 时间戳用相对 T0 构造 ISO 串（不依赖真实 Date.now），保证确定性。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  SubagentPanel,
  elapsedSec,
  projectSubagentLines,
} from "../../src/tui/subagent-panel.js";
import { visualWidth } from "../../src/tui/tool-summary.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

// 固定基准时间：所有 fixture 的 ISO 偏移相对 T0 计算。
const T0 = Date.parse("2026-08-18T10:00:00.000Z");

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

async function renderPanel(props: {
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly cols: number;
  readonly nowMs: number;
}) {
  const setup = await testRender(
    <SubagentPanel
      subagents={props.subagents}
      cols={props.cols}
      nowMs={props.nowMs}
    />,
    { width: props.cols, height: 12 }
  );
  await setup.renderOnce();
  return setup;
}

// ============================================================================
// 纯函数：elapsedSec
// ============================================================================

describe("elapsedSec startedAt 防御", () => {
  test("非法 ISO 串 / 空串 → 0", () => {
    expect(elapsedSec("not-a-date", T0)).toBe(0);
    expect(elapsedSec("", T0)).toBe(0);
  });

  test("合法 ISO → 整秒差", () => {
    expect(elapsedSec(iso(-2500), T0)).toBe(2);
    expect(elapsedSec(iso(0), T0)).toBe(0);
    // nowMs 早于 startedAt（时钟漂移 / future-dated 启动） → 0 兜底
    expect(elapsedSec(iso(1000), T0 - 5_000)).toBe(0);
  });
});

// ============================================================================
// 纯函数：projectSubagentLines（不挂载 OpenTUI）
// ============================================================================

describe("projectSubagentLines 可见性 + 折叠", () => {
  test("空数组 → []", () => {
    expect(projectSubagentLines([], T0, 80)).toEqual([]);
  });

  test("running / starting 各 1 → 两条活动行（无折叠 footer）", () => {
    const subs = [
      makeSubagent({
        state: "starting",
        taskPreview: "启动中",
        startedAt: iso(0),
      }),
      makeSubagent({
        taskId: "t-x",
        state: "running",
        taskPreview: "查找",
        startedAt: iso(-3000),
      }),
    ];
    const lines = projectSubagentLines(subs, T0, 80);
    expect(lines).toHaveLength(2);
    const startingLine = lines.find((l) => l.icon === "○");
    const runningLine = lines.find((l) => l.icon === "●");
    expect(startingLine?.text).toContain("启动中");
    expect(runningLine?.text).toContain("查找");
    expect(runningLine?.text).toContain("3s");
  });

  test("failed ≤30s → 含 ✗；failed >30s → 忽略", () => {
    const recent = makeSubagent({
      state: "failed",
      endedAt: iso(-5_000),
      reason: "timeout",
    });
    const expired = makeSubagent({
      taskId: "t-x",
      state: "failed",
      endedAt: iso(-40_000),
      reason: "timeout",
    });
    const lines = projectSubagentLines([recent, expired], T0, 80);
    expect(lines.some((l) => l.icon === "✗")).toBe(true);
    // 只有 1 条 failed 可见（≤30s）；footer 不该出现（live 行 < 3）
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("timeout");
  });

  test("全 completed 且 ≤5s → 单行 `✓ N 完成`", () => {
    const subs = [
      makeSubagent({ state: "completed", endedAt: iso(-2_000) }),
      makeSubagent({
        taskId: "t-x",
        state: "completed",
        endedAt: iso(-3_000),
      }),
    ];
    const lines = projectSubagentLines(subs, T0, 80);
    expect(lines).toEqual([
      expect.objectContaining({ icon: "✓", text: "✓ 2 完成" }),
    ]);
  });

  test("completed >5s → []（无活跃 + 无未过期 failed）", () => {
    const expired = makeSubagent({
      state: "completed",
      endedAt: iso(-10_000),
    });
    expect(projectSubagentLines([expired], T0, 80)).toEqual([]);
  });

  test("4 个活动 + 0 failed → 前 3 行 + `… 另有 1 个子代理`", () => {
    const subs = Array.from({ length: 4 }, (_, i) =>
      makeSubagent({
        taskId: `t-bulk-${i}`,
        state: "running",
        taskPreview: `任务${i}`,
      })
    );
    const lines = projectSubagentLines(subs, T0, 80);
    expect(lines).toHaveLength(4);
    expect(lines[3]?.icon).toBe("…");
    expect(lines[3]?.text).toBe("… 另有 1 个子代理");
    // 前 3 行应包含 taskPreview（顺序 = 输入顺序）
    expect(lines[0]?.text).toContain("任务0");
    expect(lines[1]?.text).toContain("任务1");
    expect(lines[2]?.text).toContain("任务2");
  });

  test("未过期 failed 计入活跃行并折叠（live>3 → 4 行 + footer）", () => {
    // 折叠只取输入序前 3 条：failed 放最前 → 前 3 含 ✗ 行。
    const subs = [
      makeSubagent({
        taskId: "t-fail",
        state: "failed",
        endedAt: iso(-5_000),
        reason: "crashed",
      }),
      makeSubagent({ state: "running", taskPreview: "a" }),
      makeSubagent({ taskId: "t-2", state: "running", taskPreview: "b" }),
      makeSubagent({ taskId: "t-3", state: "running", taskPreview: "c" }),
    ];
    const lines = projectSubagentLines(subs, T0, 80);
    expect(lines).toHaveLength(4);
    expect(lines[0]?.icon).toBe("✗");
    expect(lines[0]?.text).toContain("crashed");
    expect(lines[3]?.icon).toBe("…");
    expect(lines[3]?.text).toBe("… 另有 1 个子代理");
  });

  test("未过期 failed 与 1 running（合计 <3）→ 无 footer", () => {
    const subs = [
      makeSubagent({ state: "running", taskPreview: "a" }),
      makeSubagent({
        taskId: "t-fail",
        state: "failed",
        endedAt: iso(-5_000),
        reason: "crashed",
      }),
    ];
    const lines = projectSubagentLines(subs, T0, 80);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.icon === "…")).toBe(false);
  });

  test("窄列 cols<40 → 不显示 taskPreview，行含 子代理", () => {
    const subs = [
      makeSubagent({
        state: "running",
        taskPreview: "一个非常非常长的任务预览描述信息应该被截断",
        startedAt: iso(-5_000),
      }),
      makeSubagent({
        taskId: "t-fail",
        state: "failed",
        endedAt: iso(-3_000),
        reason: "timeout",
      }),
    ];
    const lines = projectSubagentLines(subs, T0, 30);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toContain("子代理");
    expect(lines[0]?.text).not.toContain("一个非常非常长");
    expect(lines[0]?.text).toContain("5s");
    expect(lines[1]?.text).toContain("子代理");
    expect(lines[1]?.text).toContain("timeout");
  });

  test("宽列 failed reason 按视觉宽度裁剪（CJK 长 reason 不溢出单行）", () => {
    const reasonStr =
      "失败原因很长的中文文本用来验证按视觉宽度裁剪的需求".repeat(2);
    const subs = [
      makeSubagent({
        state: "failed",
        endedAt: iso(-5_000),
        reason: reasonStr,
      }),
    ];
    const lines = projectSubagentLines(subs, T0, 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.icon).toBe("✗");
    // 完整行视觉宽度 ≤ cols（visualWidth 口径，不再有 CJK 溢出）
    expect(visualWidth(lines[0]?.text ?? "")).toBeLessThanOrEqual(80);
    // 短 reason 不受影响（原样保留）
    const short = projectSubagentLines(
      [
        makeSubagent({
          taskId: "t-short",
          state: "failed",
          endedAt: iso(-5_000),
          reason: "timeout",
        }),
      ],
      T0,
      80
    );
    expect(short[0]?.text).toContain("timeout");
  });

  test("窄列 failed reason 按窄列预算裁剪（cols-11）", () => {
    const longReason = "一个很长的失败原因字符串在窄列下应该按预算截断".repeat(
      2
    );
    const lines = projectSubagentLines(
      [
        makeSubagent({
          state: "failed",
          endedAt: iso(-5_000),
          reason: longReason,
        }),
      ],
      T0,
      30
    );
    expect(lines).toHaveLength(1);
    expect(visualWidth(lines[0]?.text ?? "")).toBeLessThanOrEqual(30);
  });
});

// ============================================================================
// 渲染（testRender + captureCharFrame）
// ============================================================================

describe("SubagentPanel 渲染（OpenTUI）", () => {
  test("空数组 → 渲染空（frame 无 ● / ✓）", async () => {
    const setup = await renderPanel({
      subagents: [],
      cols: 80,
      nowMs: T0,
    });
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("●");
    expect(frame).not.toContain("✓");
    await setup.renderer.destroy();
  });

  test("1 running → 单行含 ● + taskPreview + Ns", async () => {
    const sa = makeSubagent({
      taskId: "t-r1",
      state: "running",
      taskPreview: "查找文档",
      startedAt: iso(-5_000),
    });
    const setup = await renderPanel({
      subagents: [sa],
      cols: 80,
      nowMs: T0,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("●");
    expect(frame).toContain("查找文档");
    expect(frame).toContain("5s");
    await setup.renderer.destroy();
  });

  test("starting → ○ 前缀", async () => {
    const sa = makeSubagent({
      taskId: "t-s1",
      state: "starting",
      taskPreview: "等待中",
    });
    const setup = await renderPanel({
      subagents: [sa],
      cols: 80,
      nowMs: T0,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("○");
    expect(frame).toContain("等待中");
    expect(frame).not.toContain("●");
    await setup.renderer.destroy();
  });

  test("failed ≤30s → ✗ + reason；failed >30s → 不渲染 ✗", async () => {
    const recentFailed = makeSubagent({
      taskId: "t-f1",
      state: "failed",
      endedAt: iso(-10_000),
      reason: "timeout",
      taskPreview: "查找",
    });
    const setup = await renderPanel({
      subagents: [recentFailed],
      cols: 80,
      nowMs: T0,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("✗");
    expect(frame).toContain("timeout");
    await setup.renderer.destroy();

    const expiredFailed = makeSubagent({
      taskId: "t-f2",
      state: "failed",
      endedAt: iso(-40_000),
      reason: "timeout",
      taskPreview: "查找",
    });
    const setup2 = await renderPanel({
      subagents: [expiredFailed],
      cols: 80,
      nowMs: T0,
    });
    const frame2 = setup2.captureCharFrame();
    expect(frame2).not.toContain("✗");
    await setup2.renderer.destroy();
  });

  test("全 completed ≤5s → `✓ N 完成`；>5s → 渲染空", async () => {
    const recentDone = [
      makeSubagent({ state: "completed", endedAt: iso(-2_000) }),
      makeSubagent({
        taskId: "t-c2",
        state: "completed",
        endedAt: iso(-3_500),
      }),
    ];
    const setup = await renderPanel({
      subagents: recentDone,
      cols: 80,
      nowMs: T0,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("✓ 2 完成");
    await setup.renderer.destroy();

    const expiredDone = makeSubagent({
      state: "completed",
      endedAt: iso(-10_000),
    });
    const setup2 = await renderPanel({
      subagents: [expiredDone],
      cols: 80,
      nowMs: T0,
    });
    const frame2 = setup2.captureCharFrame();
    expect(frame2).not.toContain("✓");
    await setup2.renderer.destroy();
  });

  test("4 个 running → 前 3 行 + footer `… 另有 1 个子代理`", async () => {
    const subs = Array.from({ length: 4 }, (_, i) =>
      makeSubagent({
        taskId: `t-fold-${i}`,
        state: "running",
        taskPreview: `任务${i}`,
      })
    );
    const setup = await renderPanel({
      subagents: subs,
      cols: 80,
      nowMs: T0,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("另有 1 个子代理");
    expect(frame).toContain("任务0");
    expect(frame).toContain("任务1");
    expect(frame).toContain("任务2");
    // 第 4 个 taskPreview 不该渲染（被 footer 折叠）
    expect(frame).not.toContain("任务3");
    await setup.renderer.destroy();
  });

  test("窄列 cols=30 → 含 `子代理`、不含 taskPreview 长字符串", async () => {
    const sa = makeSubagent({
      taskId: "t-narrow",
      state: "running",
      taskPreview: "一个非常非常长的任务预览描述信息应该被截断",
      startedAt: iso(-5_000),
    });
    const setup = await renderPanel({
      subagents: [sa],
      cols: 30,
      nowMs: T0,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("子代理");
    expect(frame).toContain("5s");
    expect(frame).not.toContain("一个非常非常长");
    await setup.renderer.destroy();
  });

  test("无 emoji 断言：渲染文本不含 U+1F300–U+1FAFF", async () => {
    const subs = [
      makeSubagent({
        taskId: "t-mix-1",
        state: "running",
        taskPreview: "运行中",
      }),
      makeSubagent({
        taskId: "t-mix-2",
        state: "failed",
        endedAt: iso(-3_000),
        reason: "timeout",
        taskPreview: "失败任务",
      }),
      makeSubagent({
        taskId: "t-mix-3",
        state: "completed",
        endedAt: iso(-1_500),
      }),
    ];
    const setup = await renderPanel({
      subagents: subs,
      cols: 80,
      nowMs: T0,
    });
    const frame = setup.captureCharFrame();
    const emojiRegex = /[\u{1F300}-\u{1FAFF}]/u;
    expect(
      emojiRegex.test(frame),
      `frame 含 emoji: ${frame.slice(0, 200)}`
    ).toBe(false);
    await setup.renderer.destroy();
  });
});

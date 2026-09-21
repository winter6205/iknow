/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-panel.test.tsx
 *
 * TUI subagent status panel tests.
 *
 * Coverage:
 *   1. visibility, 9 classes (empty / 1 running / starting / failed ≤30s /
 *      failed >30s / all completed ≤5s / all completed >5s / 4 active without
 *      folding / narrow cols / no emoji);
 *   2. pure-function edges (elapsedSec illegal ISO / empty string / whole-second diff).
 *   3. second→string format edges (`formatRunDuration`, run-stats.ts SSOT) have
 *      been merged into the formatRunDuration describe in
 *      `tests/tui/run-stats.test.ts` (shared pure function with the mode line /
 *      Crunched line; tests converge in one place).
 *
 * Timestamps build ISO strings relative to T0 (no reliance on real Date.now)
 * for determinism.
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  SubagentPanel,
  elapsedSec,
  projectSubagentLines,
  visibleLiveRowCount,
  SUBAGENT_PANEL_MAX_ROWS,
} from "../../src/tui/subagent-panel.js";
import { visualWidth } from "../../src/tui/tool-summary.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

// Fixed baseline time: all fixtures compute ISO offsets relative to T0.
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
// Pure function: elapsedSec
// ============================================================================

describe("elapsedSec startedAt 防御", () => {
  test("非法 ISO 串 / 空串 → 0", () => {
    expect(elapsedSec("not-a-date", T0)).toBe(0);
    expect(elapsedSec("", T0)).toBe(0);
  });

  test("合法 ISO → 整秒差", () => {
    expect(elapsedSec(iso(-2500), T0)).toBe(2);
    expect(elapsedSec(iso(0), T0)).toBe(0);
    // nowMs earlier than startedAt (clock drift / future-dated start) → clamp to 0
    expect(elapsedSec(iso(1000), T0 - 5_000)).toBe(0);
  });
});

// ============================================================================
// Pure function: projectSubagentLines (no OpenTUI mount)
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
    // Only 1 failed row visible (≤30s); no footer expected (live rows < 3)
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

  test("running 行首含 role 名称", () => {
    const lines = projectSubagentLines(
      [
        makeSubagent({
          role: "explore",
          taskPreview: "查找文档",
          startedAt: iso(-1000),
        }),
      ],
      T0,
      80
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text.startsWith("● explore ")).toBe(true);
    expect(lines[0]?.text).toContain("查找文档");
  });

  test("缺 role → 行首回落「子代理」", () => {
    const lines = projectSubagentLines(
      [makeSubagent({ taskPreview: "查找" })],
      T0,
      80
    );
    expect(lines[0]?.text).toMatch(/^● 子代理 /);
  });

  test("4 个活动 → 4 行全量、无折叠 footer", () => {
    const subs = Array.from({ length: 4 }, (_, i) =>
      makeSubagent({
        taskId: `t-bulk-${i}`,
        state: "running",
        taskPreview: `任务${i}`,
      })
    );
    const lines = projectSubagentLines(subs, T0, 80);
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.icon === "…")).toBe(false);
    expect(lines[0]?.text).toContain("任务0");
    expect(lines[1]?.text).toContain("任务1");
    expect(lines[2]?.text).toContain("任务2");
    expect(lines[3]?.text).toContain("任务3");
  });

  test("未过期 failed 计入活跃行（live>3 仍全量，无 footer）", () => {
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
    expect(lines[3]?.icon).toBe("●");
    expect(lines.some((l) => l.icon === "…")).toBe(false);
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
    // Full line visual width ≤ cols (visualWidth metric; no more CJK overflow)
    expect(visualWidth(lines[0]?.text ?? "")).toBeLessThanOrEqual(80);
    // Short reasons are untouched (kept verbatim)
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
// Rendering (testRender + captureCharFrame)
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

  test("4 个 running → 四行全量，行首含名称，无折叠 footer", async () => {
    const subs = Array.from({ length: 4 }, (_, i) =>
      makeSubagent({
        taskId: `t-fold-${i}`,
        state: "running",
        role: "explore",
        taskPreview: `任务${i}`,
      })
    );
    const setup = await renderPanel({
      subagents: subs,
      cols: 80,
      nowMs: T0,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("explore");
    expect(frame).toContain("任务0");
    expect(frame).toContain("任务1");
    expect(frame).toContain("任务2");
    expect(frame).toContain("任务3");
    expect(frame).not.toContain("另有");
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

// ============================================================================
// Focused row expands taskPreview (chrome-focus reducer wiring)
// ============================================================================

describe("projectSubagentLines focusedRow — T7 子代理行聚焦展开", () => {
  test("空 focusedRow → 全部行原截断（前缀不变）", () => {
    const sa = makeSubagent({
      taskId: "t-f1",
      state: "running",
      taskPreview: "abcdefghijklmnopqrstuvwxyz".repeat(5),
    });
    const lines = projectSubagentLines([sa], T0, 60, undefined);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text.startsWith("> ")).toBe(false);
    expect(lines[0]!.text.startsWith("● ")).toBe(true);
  });

  test("聚焦 row=0 → 该行 taskPreview 不截断 + `> ` 前缀", () => {
    const longPreview = "这是完整任务描述：" + "完整内容".repeat(40);
    const sa = makeSubagent({
      taskId: "t-f2",
      state: "running",
      taskPreview: longPreview,
    });
    const lines = projectSubagentLines([sa], T0, 80, 0);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text.startsWith("> ")).toBe(true);
    // Expanded: the original taskPreview is fully present (cols visual width
    // still backstops, but a long preview far exceeds cols; this assertion
    // pins the "expand" behavior — with cols=80 the expanded line contains
    // the original preview).
    expect(lines[0]!.text).toContain("完整内容");
  });

  test("聚焦 row=1 → 仅第二行展开，第一行仍截断", () => {
    const longPreview = "x".repeat(50);
    const sa0 = makeSubagent({
      taskId: "t-f3a",
      state: "running",
      taskPreview: longPreview,
    });
    const sa1 = makeSubagent({
      taskId: "t-f3b",
      state: "starting",
      taskPreview: longPreview,
    });
    const lines = projectSubagentLines([sa0, sa1], T0, 40, 1);
    expect(lines.length).toBe(2);
    expect(lines[0]!.text.startsWith("> ")).toBe(false);
    expect(lines[1]!.text.startsWith("> ")).toBe(true);
  });

  test("focusedRow 越界 → 等价未聚焦（无前缀，全部原截断）", () => {
    const longPreview = "abcdefghij".repeat(20);
    const subs = [
      makeSubagent({
        taskId: "t-f4a",
        state: "running",
        taskPreview: longPreview,
      }),
      makeSubagent({
        taskId: "t-f4b",
        state: "running",
        taskPreview: longPreview,
      }),
    ];
    const lines = projectSubagentLines(subs, T0, 40, 99);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.text.startsWith("> ")).toBe(false);
    }
  });

  test("focusedRow 指向 failed 行 → failed 行不展开（仅 live 行参与）", () => {
    const sa0 = makeSubagent({
      taskId: "t-f5a",
      state: "running",
      taskPreview: "running task",
    });
    const sa1 = makeSubagent({
      taskId: "t-f5b",
      state: "failed",
      endedAt: iso(-1000),
      taskPreview: "failed task",
    });
    // focusedRow=1 points at the failed row; per plan only live rows take
    // focus → no expansion.
    const lines = projectSubagentLines([sa0, sa1], T0, 80, 1);
    expect(lines.length).toBe(2);
    // Line 0 (live running) is not focused
    expect(lines[0]!.text.startsWith("> ")).toBe(false);
    // Line 1 (failed) does not participate in focus
    expect(lines[1]!.text.startsWith("> ")).toBe(false);
  });

  test("钉死约束：focusedRow 展开不破坏单行布局（不换行）", () => {
    const sa = makeSubagent({
      taskId: "t-f6",
      state: "running",
      taskPreview: "z".repeat(200),
    });
    const lines = projectSubagentLines([sa], T0, 30, 0);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text.includes("\n")).toBe(false);
  });
});

describe("SubagentPanel focusedRow 渲染（OpenTUI）", () => {
  test("聚焦行加 `> ` 前缀；非聚焦行不加", async () => {
    const sa0 = makeSubagent({
      taskId: "t-r1a",
      state: "running",
      taskPreview: "第一个子代理任务预览内容完整在场很长很长很长很长",
    });
    const sa1 = makeSubagent({
      taskId: "t-r1b",
      state: "starting",
      taskPreview: "第二个",
    });
    const setup = await testRender(
      <SubagentPanel
        subagents={[sa0, sa1]}
        cols={80}
        nowMs={T0}
        focusedRow={1}
      />,
      { width: 80, height: 8 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    // Second line carries `> `
    expect(frame).toContain("> ○");
    // Find both lines: first line has no `> ` prefix
    const lines = frame
      .split("\n")
      .filter((l) => l.includes("子代理") || l.includes("> "));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // At least one line without `> ` (with focusedRow=1, row=0 keeps no prefix)
    expect(lines.some((l) => !l.trimStart().startsWith(">"))).toBe(true);
    await setup.renderer.destroy();
  });

  test("无 focusedRow → 帧内无 `> ` 前缀", async () => {
    const sa = makeSubagent({
      taskId: "t-r2",
      state: "running",
      taskPreview: "task preview",
    });
    const setup = await testRender(
      <SubagentPanel subagents={[sa]} cols={80} nowMs={T0} />,
      { width: 80, height: 6 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("> ");
    await setup.renderer.destroy();
  });
});

// ============================================================================
// maxRows folding + visible-row ceiling for the focus ring
// ============================================================================

describe("projectSubagentLines maxRows 折叠（#1044）", () => {
  function liveN(n: number): SubagentInfo[] {
    return Array.from({ length: n }, (_, i) =>
      makeSubagent({
        taskId: `t-max-${i}`,
        state: "running",
        taskPreview: `任务-${i}`,
        startedAt: iso(-1000),
      })
    );
  }

  test("未超限 / 恰好等于 / undefined → 原样返回（不含折叠行）", () => {
    for (const [n, maxRows] of [
      [3, 5],
      [5, 5],
      [3, undefined],
    ] as const) {
      const lines = projectSubagentLines(liveN(n), T0, 80, undefined, maxRows);
      expect(lines).toHaveLength(n);
      expect(lines.some((l) => l.icon === "…")).toBe(false);
    }
  });

  test("超限 → 截到 maxRows，末行 `… +N`，N = 被隐藏行数", () => {
    // 8 live, maxRows=5 → first 4 lines verbatim + fold line (hides 8-4=4)
    const lines = projectSubagentLines(liveN(8), T0, 80, undefined, 5);
    expect(lines).toHaveLength(5);
    expect(lines[4]?.text).toBe("… +4");
    // First 4 lines are still live lines; focus semantics survive the fold
    expect(
      lines.slice(0, 4).every((l) => l.icon === "●" || l.icon === "○")
    ).toBe(true);
    expect(lines.slice(0, 4).every((l) => l.text.includes("任务-"))).toBe(true);
  });

  test("maxRows ≤ 0 → 不折叠（防御：非法值不吞行）", () => {
    const lines = projectSubagentLines(liveN(3), T0, 80, undefined, 0);
    expect(lines).toHaveLength(3);
  });
});

describe("visibleLiveRowCount（#1044 焦点环上界）", () => {
  test("未超限 → 等于 live 行数；超限 → maxRows-1", () => {
    expect(visibleLiveRowCount([], T0, 80, 5)).toBe(0);
    expect(visibleLiveRowCount([makeSubagent({})], T0, 80, 5)).toBe(1);
    const many = Array.from({ length: 9 }, (_, i) =>
      makeSubagent({ taskId: `t-v-${i}`, state: "running" })
    );
    expect(visibleLiveRowCount(many, T0, 80, 5)).toBe(4);
  });

  test("completed / 过期 failed 不计入（与面板可见性同口径）", () => {
    const subs = [
      makeSubagent({ state: "running" }),
      makeSubagent({ state: "completed", endedAt: iso(-1000) }),
      makeSubagent({ state: "failed", endedAt: iso(-60_000) }), // >30s window
    ];
    expect(visibleLiveRowCount(subs, T0, 80, 5)).toBe(1);
  });

  test("缺省 maxRows = SUBAGENT_PANEL_MAX_ROWS（组件与行账同源）", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeSubagent({ taskId: `t-d-${i}`, state: "running" })
    );
    expect(visibleLiveRowCount(many, T0, 80)).toBe(SUBAGENT_PANEL_MAX_ROWS - 1);
  });

  test("窗口内 failed 行穿插占可见槽位 → 不虚报（焦点不落隐藏行）", () => {
    // Pins the counterexample: the min(live, maxRows-1) formula would return 4
    // — after folding [✗, ●, ●, ●, ●], the visible first 4 lines are
    // [✗, ●, ●, ●], so only 3 live rows are actually visible.
    const subs = [
      makeSubagent({ state: "failed", endedAt: iso(-5_000), reason: "boom" }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeSubagent({ taskId: `t-il-${i}`, state: "running" })
      ),
    ];
    expect(visibleLiveRowCount(subs, T0, 80, 5)).toBe(3);
    // Same per-line accounting as the render projection: visible ●/○ count is
    // always equal.
    const projected = projectSubagentLines(subs, T0, 80, undefined, 5);
    expect(
      projected.filter((l) => l.icon === "●" || l.icon === "○").length
    ).toBe(visibleLiveRowCount(subs, T0, 80, 5));
  });

  test("failed 穿插但未超限 → 全可见，live 计数不缩水", () => {
    const subs = [
      makeSubagent({ state: "failed", endedAt: iso(-5_000), reason: "boom" }),
      ...Array.from({ length: 3 }, (_, i) =>
        makeSubagent({ taskId: `t-in-${i}`, state: "running" })
      ),
    ];
    expect(visibleLiveRowCount(subs, T0, 80, 5)).toBe(3);
  });
});

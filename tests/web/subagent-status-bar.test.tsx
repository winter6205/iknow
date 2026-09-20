/**
 * SubagentStatusBar render asserts — empty → null; four-state badges + preview/summary/reason.
 *
 * renderToStaticMarkup (same pattern as tests/web/context-usage-strip.test.tsx; the
 * web package ships no test framework, root vitest runs in node env). The component
 * is props-only, purely presentational.
 *
 * Acceptance covered: component tests green, and state transitions (running →
 * done / failed) are visible via the four-state badges + content.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SubagentStatusBar,
  visibleSubagents,
} from "../../web/src/components/SubagentStatusBar.tsx";
import type { SubagentStatus } from "../../web/src/api/types.ts";

/** Build a SubagentStatus; only fields under test are listed explicitly, the rest take defaults. */
function item(
  partial: Partial<SubagentStatus> & Pick<SubagentStatus, "state">
): SubagentStatus {
  return {
    taskId: partial.taskId ?? "t1",
    state: partial.state,
    taskPreview: partial.taskPreview ?? "task preview",
    startedAt: partial.startedAt ?? "2026-08-18T03:00:00.000Z",
    ...(partial.endedAt !== undefined ? { endedAt: partial.endedAt } : {}),
    ...(partial.summary !== undefined ? { summary: partial.summary } : {}),
    ...(partial.reason !== undefined ? { reason: partial.reason } : {}),
  };
}

describe("SubagentStatusBar — empty render", () => {
  it("zero subagents → 渲染空字符串（不打扰 idle 会话）", () => {
    const html = renderToStaticMarkup(<SubagentStatusBar subagents={[]} />);
    assert.equal(html, "");
  });
});

describe("SubagentStatusBar — 四态徽标", () => {
  it("running → 渲染 taskPreview + 运行中 label + data-state hook", () => {
    const html = renderToStaticMarkup(
      <SubagentStatusBar
        subagents={[item({ state: "running", taskPreview: "修复 flaky test" })]}
      />
    );
    assert.ok(html.includes("运行中"), "must include 运行中 badge");
    assert.ok(html.includes("修复 flaky test"), "must include taskPreview");
    assert.ok(
      html.includes('data-state="running"'),
      "must expose data-state for CSS hooks"
    );
  });

  it("starting → 渲染 启动中 label", () => {
    const html = renderToStaticMarkup(
      <SubagentStatusBar
        subagents={[item({ state: "starting", taskPreview: "初始化" })]}
      />
    );
    assert.ok(html.includes("启动中"));
    assert.ok(html.includes('data-state="starting"'));
  });

  it("completed → 渲染 summary + 已完成 label", () => {
    const html = renderToStaticMarkup(
      <SubagentStatusBar
        subagents={[
          item({
            state: "completed",
            taskPreview: "build summary",
            summary: "60s 跑完",
          }),
        ]}
      />
    );
    assert.ok(html.includes("已完成"));
    assert.ok(html.includes("60s 跑完"), "completed must surface summary");
    assert.ok(html.includes('data-state="completed"'));
  });

  it("failed → 渲染 reason + 失败 label（summary 仍有则一并展示）", () => {
    const html = renderToStaticMarkup(
      <SubagentStatusBar
        subagents={[
          item({
            state: "failed",
            taskPreview: "depth gate",
            reason: "timeout",
            summary: "1200s 未完成",
          }),
        ]}
      />
    );
    assert.ok(html.includes("失败"));
    assert.ok(html.includes("timeout"), "failed must surface reason");
    assert.ok(
      html.includes("1200s 未完成"),
      "failed must also surface summary"
    );
    assert.ok(html.includes('data-state="failed"'));
  });

  it("multi-item render: 全部在场（running + completed + failed），key 不冲突", () => {
    const html = renderToStaticMarkup(
      <SubagentStatusBar
        subagents={[
          item({ state: "running", taskId: "a", taskPreview: "任务甲" }),
          item({
            state: "completed",
            taskId: "b",
            taskPreview: "任务乙",
            summary: "done",
          }),
          item({
            state: "failed",
            taskId: "c",
            taskPreview: "任务丙",
            reason: "timeout",
          }),
        ]}
      />
    );
    assert.ok(html.includes("任务甲"));
    assert.ok(html.includes("任务乙"));
    assert.ok(html.includes("任务丙"));
    assert.ok(html.includes("运行中"));
    assert.ok(html.includes("已完成"));
    assert.ok(html.includes("失败"));
    // each of the three data-states appears once
    assert.ok(html.includes('data-state="running"'));
    assert.ok(html.includes('data-state="completed"'));
    assert.ok(html.includes('data-state="failed"'));
  });

  it("空 taskPreview 兜底：显示「子代理」占位（保持布局不塌）", () => {
    const html = renderToStaticMarkup(
      <SubagentStatusBar
        subagents={[item({ state: "running", taskPreview: "" })]}
      />
    );
    assert.ok(html.includes("子代理"));
    assert.ok(html.includes("运行中"));
  });
});

describe("SubagentStatusBar — 终态截断（visibleSubagents）", () => {
  function terminal(id: string, state: "completed" | "failed"): SubagentStatus {
    return item({ state, taskId: id, taskPreview: `任务-${id}` });
  }

  it("终态 ≤5 条 → 全保留", () => {
    const list = ["t1", "t2", "t3", "t4", "t5"].map((id) =>
      terminal(id, "completed")
    );
    assert.deepEqual(
      visibleSubagents(list).map((s) => s.taskId),
      ["t1", "t2", "t3", "t4", "t5"]
    );
  });

  it("终态 7 条 → 只保留最近 5 条（列表序尾部），相对顺序不变", () => {
    const list = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"].map((id) =>
      terminal(id, id === "t3" ? "failed" : "completed")
    );
    assert.deepEqual(
      visibleSubagents(list).map((s) => s.taskId),
      ["t3", "t4", "t5", "t6", "t7"]
    );
  });

  it("活跃条目（starting/running）不受截断影响，与保留的终态按原序交错", () => {
    const list: SubagentStatus[] = [
      terminal("t1", "completed"),
      item({ state: "running", taskId: "r1", taskPreview: "活跃甲" }),
      terminal("t2", "completed"),
      terminal("t3", "completed"),
      terminal("t4", "failed"),
      terminal("t5", "completed"),
      terminal("t6", "completed"),
      item({ state: "starting", taskId: "s1", taskPreview: "活跃乙" }),
    ];
    // 6 terminal entries → drop the earliest t1; running/starting all kept.
    assert.deepEqual(
      visibleSubagents(list).map((s) => s.taskId),
      ["r1", "t2", "t3", "t4", "t5", "t6", "s1"]
    );
  });

  it("组件渲染走同一过滤：超量终态只渲染最近 5 条", () => {
    const list = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) =>
      terminal(id, "completed")
    );
    const html = renderToStaticMarkup(<SubagentStatusBar subagents={list} />);
    assert.ok(!html.includes("任务-t1"), "最早终态条目被截断");
    assert.ok(html.includes("任务-t2"));
    assert.ok(html.includes("任务-t6"));
    assert.equal(
      (html.match(/data-state="completed"/g) ?? []).length,
      5
    );
  });
});

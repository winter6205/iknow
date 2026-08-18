/**
 * #358 T8: SubagentStatusBar 渲染断言 — 空 → null，四态徽标 + preview/summary/reason。
 *
 * renderToStaticMarkup (tests/web/context-usage-strip.test.tsx 同款；web 包
 * 不带测试框架，root vitest 跑 node env)。组件 props-only，纯展示。
 *
 * SC8 acceptance 1：组件测试绿；SC8 acceptance 3：状态变化可见 (running →
 * 完成 / 失败) 在四态徽标 + 内容双重覆盖。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubagentStatusBar } from "../../web/src/components/SubagentStatusBar.tsx";
import type { SubagentStatus } from "../../web/src/api/types.ts";

/** 构造一个 SubagentStatus，只显式列出覆盖到的字段，其余走默认值。 */
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
    // 三种 data-state 各出现一次
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

/**
 * T4 (#690): /continue EXIT copy + client busy-guard 纯函数。
 *
 * bun:test（tests/tui 不进 vitest 默认收集）。
 */
import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../src/shared/errors.js";
import {
  continueExitFromError,
  continueNoticeFor,
  pendingFromLoadedSession,
  tuiContinueBusy,
} from "../../src/tui/continue-notice.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

describe("tuiContinueBusy — busy_stop_first（镜像 /compact：runState 或 compacting）", () => {
  test("idle 且未 compact → 不 busy", () => {
    expect(tuiContinueBusy({ runState: "idle", compacting: false })).toBe(
      false
    );
  });

  test("running-fg → busy（不 abort 原 turn）", () => {
    expect(tuiContinueBusy({ runState: "running-fg", compacting: false })).toBe(
      true
    );
  });

  test("running-bg → busy", () => {
    expect(tuiContinueBusy({ runState: "running-bg", compacting: false })).toBe(
      true
    );
  });

  test("idle 但 compacting → busy（compact 期间 runState 仍 idle）", () => {
    expect(tuiContinueBusy({ runState: "idle", compacting: true })).toBe(true);
  });
});

describe("continueNoticeFor — 命名 EXIT 文案（锁语义）", () => {
  test("busy_stop_first", () => {
    expect(continueNoticeFor("busy_stop_first")).toEqual([
      "当前会话正在运行；续跑等本轮结束后再执行。",
    ]);
  });

  test("usage", () => {
    expect(continueNoticeFor("usage")).toEqual([
      "用法：/continue（不接受参数）",
    ]);
  });

  test("nothing_pending", () => {
    expect(continueNoticeFor("nothing_pending")).toEqual([
      "当前没有未完成的工具环可续跑。",
    ]);
  });

  test("goal_active", () => {
    expect(continueNoticeFor("goal_active")).toEqual([
      "当前有钉着的 goal；先 /goal clear 再续跑。",
    ]);
  });

  test("fused_clean_stop", () => {
    expect(continueNoticeFor("fused_clean_stop")).toEqual([
      "已因循环检测干净停止，不能续跑。",
    ]);
  });
});

describe("continueExitFromError — continue_http_no_fallback 只认 field=continue", () => {
  test("ValidationError field=continue + nothing_pending 前缀 → 命名 EXIT", () => {
    const err = new ValidationError(
      "nothing_pending: cannot continue this session",
      {
        field: "continue",
      }
    );
    expect(continueExitFromError(err)).toBe("nothing_pending");
  });

  test("非 continue field → undefined（不吞其它校验）", () => {
    const err = new ValidationError("workspace unbound", {
      field: "workspaceRoot",
    });
    expect(continueExitFromError(err)).toBeUndefined();
  });

  test("plain Error → undefined", () => {
    expect(continueExitFromError(new Error("boom"))).toBeUndefined();
  });
});

describe("pendingFromLoadedSession — SSOT = load 后 messages+goal，不是 lastStopReason", () => {
  const toolResultTail: ReadonlyArray<AnthropicNativeMessage> = [
    { role: "user", content: [{ type: "text", text: "do" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  ];

  test("P4 tool_result 尾 → pending true（即使调用方同时持有 lastStopReason=completed）", () => {
    expect(
      pendingFromLoadedSession({
        messages: toolResultTail,
        lastStopReason: "completed",
      })
    ).toBe(true);
  });

  test("空 messages → pending false", () => {
    expect(pendingFromLoadedSession({ messages: [] })).toBe(false);
  });

  test("text-only assistant 尾 → pending false", () => {
    expect(
      pendingFromLoadedSession({
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
        lastStopReason: "maxTurns",
      })
    ).toBe(false);
  });
});

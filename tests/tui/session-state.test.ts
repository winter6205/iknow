/**
 * tests/tui/session-state.test.ts
 *
 * #146 状态机转换表（Q1a 裁决）全组合：
 *  - 任何会话态可自由切换；running-fg 被切走 → running-bg；
 *  - 切回 running-bg → running-fg；idle 不变；
 *  - Ctrl+C 仅 running-fg 可打断（canInterrupt）；
 *  - turnFinished 落回 idle + 消息整体冻结替换（ReadonlyArray 纪律）。
 */
import { describe, expect, it } from "vitest";
import {
  attachSession,
  canInterrupt,
  createDraftSession,
  sessionSummary,
  switchedAwayFrom,
  switchedTo,
  turnFinished,
  turnStarted,
  userMessageEchoed,
} from "../../src/tui/session-state.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const msg = (
  text: string,
  role: "user" | "assistant" = "user"
): AnthropicNativeMessage => ({
  role,
  content: [{ type: "text", text }],
});

function sampleFile(overrides?: Partial<SessionFileV1>): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    conversation_id: "conv-1",
    messages: [msg("你好"), msg("你好，有什么可以帮你？", "assistant")],
    jsonMode: false,
    turnCount: 1,
    updatedAt: now,
    summary: "你好",
    cwd: "/tmp/proj",
    sanitized_at: now,
    ...overrides,
  };
}

describe("session-state: draft / attach", () => {
  it("createDraftSession：未建档、空消息、idle、冻结", () => {
    const draft = createDraftSession();
    expect(draft.conversationId).toBeUndefined();
    expect(draft.messages).toHaveLength(0);
    expect(draft.runState).toBe("idle");
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.messages)).toBe(true);
  });

  it("attachSession：从文件恢复（消息冻结拷贝，不与源共享引用）", () => {
    const file = sampleFile();
    const attached = attachSession(file);
    expect(attached.conversationId).toBe("conv-1");
    expect(attached.messages).toHaveLength(2);
    expect(attached.turnCount).toBe(1);
    expect(attached.runState).toBe("idle");
    expect(Object.isFrozen(attached.messages)).toBe(true);
    expect(attached.messages).not.toBe(file.messages);
  });

  it("sessionSummary：首条 user 文本（#120 SSOT extractSummary）", () => {
    expect(sessionSummary([msg("第一个问题"), msg("回答", "assistant")])).toBe(
      "第一个问题"
    );
    expect(sessionSummary([])).toBe("");
  });
});

describe("session-state: 三态转换表（Q1a）", () => {
  it("turnStarted：idle → running-fg；非 idle 保持原状态", () => {
    const draft = createDraftSession();
    const started = turnStarted(draft);
    expect(started.runState).toBe("running-fg");
    // 重复起跑（调用方 bug）不抛错、不变
    expect(turnStarted(started)).toBe(started);
  });

  it("switchedAwayFrom：running-fg → running-bg（后台继续执行）", () => {
    const running = turnStarted(createDraftSession());
    expect(switchedAwayFrom(running).runState).toBe("running-bg");
  });

  it("switchedAwayFrom：idle 会话切走不变", () => {
    const idle = createDraftSession();
    expect(switchedAwayFrom(idle)).toBe(idle);
  });

  it("switchedTo：running-bg → running-fg；idle 不变", () => {
    const bg = switchedAwayFrom(turnStarted(createDraftSession()));
    expect(switchedTo(bg).runState).toBe("running-fg");
    const idle = createDraftSession();
    expect(switchedTo(idle)).toBe(idle);
  });

  it("canInterrupt：仅 running-fg 可打断（Ctrl+C 作用域 Q1a）", () => {
    const draft = createDraftSession();
    expect(canInterrupt(draft)).toBe(false);
    const fg = turnStarted(draft);
    expect(canInterrupt(fg)).toBe(true);
    const bg = switchedAwayFrom(fg);
    expect(canInterrupt(bg)).toBe(false);
  });

  it("turnFinished：落回 idle + 消息/turnCount/updatedAt 整体替换", () => {
    const started = turnStarted(createDraftSession());
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("问"),
      msg("答", "assistant"),
    ];
    const done = turnFinished(started, {
      conversationId: "conv-9",
      messages,
      turnCount: 1,
      updatedAt: "2026-08-05T00:00:00.000Z",
      jsonMode: false,
      stopReason: "completed",
    });
    expect(done.runState).toBe("idle");
    expect(done.conversationId).toBe("conv-9");
    expect(done.messages).toHaveLength(2);
    expect(done.lastStopReason).toBe("completed");
    expect(Object.isFrozen(done.messages)).toBe(true);
  });

  it("turnFinished：cancelled 也落回 idle（hub DROP_REASONS 不落盘由 hub 保证）", () => {
    const started = turnStarted(createDraftSession());
    const done = turnFinished(started, {
      conversationId: "conv-9",
      messages: [],
      turnCount: 0,
      updatedAt: "",
      jsonMode: false,
      stopReason: "cancelled",
    });
    expect(done.runState).toBe("idle");
    expect(done.lastStopReason).toBe("cancelled");
  });
});

describe("session-state: userMessageEchoed (T2 即时回显)", () => {
  it("正常追加：messages 末尾新增 user text 消息，其余字段不变", () => {
    const draft = createDraftSession();
    const echoed = userMessageEchoed(draft, "你好");
    expect(echoed.messages).toHaveLength(1);
    expect(echoed.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "你好" }],
    });
    // 其余会话字段原样保留。
    expect(echoed.conversationId).toBe(draft.conversationId);
    expect(echoed.turnCount).toBe(draft.turnCount);
    expect(echoed.runState).toBe(draft.runState);
  });

  it("空文本不追加（返回原状态）", () => {
    const draft = createDraftSession();
    expect(userMessageEchoed(draft, "")).toBe(draft);
    expect(userMessageEchoed(draft, "   ")).toBe(draft);
    expect(draft.messages).toHaveLength(0);
  });

  it("冻结纪律：返回新冻结状态，不 mutate 原状态", () => {
    const draft = createDraftSession();
    const echoed = userMessageEchoed(draft, "冻结测试");
    expect(Object.isFrozen(echoed)).toBe(true);
    expect(Object.isFrozen(echoed.messages)).toBe(true);
    expect(Object.isFrozen(echoed.messages[0]!)).toBe(true);
    // 原状态未被突变。
    expect(draft.messages).toHaveLength(0);
  });

  it("在既有消息后追加（不覆盖历史）", () => {
    const started = turnStarted(createDraftSession());
    const first = userMessageEchoed(started, "第一条");
    const second = userMessageEchoed(first, "第二条");
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "第二条" }],
    });
  });
});

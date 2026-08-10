/**
 * tests/tui/session-state.test.ts
 *
 * #146 状态机转换表（Q1a 裁决）全组合：
 *  - 任何会话态可自由切换；running-fg 被切走 → running-bg；
 *  - 切回 running-bg → running-fg；idle 不变；
 *  - Ctrl+C 仅 running-fg 可打断（canInterrupt）；
 *  - turnFinished 落回 idle + 消息整体冻结替换（ReadonlyArray 纪律）。
 *
 * T3：TuiSessionState / TurnFinishedInput 增 lastUsage 字段（上下文用量显示）。
 * 字段缺席（init）= null；turnFinished 把 hub 回执透传；Object.freeze 纪律保持。
 */
import { describe, expect, it } from "vitest";
import {
  attachSession,
  canInterrupt,
  createDraftSession,
  sessionCompacted,
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

  it("createDraftSession：lastUsage 初值 null（无首轮 usage）", () => {
    expect(createDraftSession().lastUsage).toBeNull();
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

  it("attachSession：lastUsage 初值 null（lastUsage 只来自运行时回执，不从文件读）", () => {
    expect(attachSession(sampleFile()).lastUsage).toBeNull();
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
      lastUsage: null,
    });
    expect(done.runState).toBe("idle");
    expect(done.lastStopReason).toBe("cancelled");
  });
});

describe("session-state: lastUsage（T3，上下文用量显示）", () => {
  it("turnFinished 传 lastUsage → state.lastUsage 命中 + 冻结纪律保持", () => {
    const lastUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    };
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("问"),
      msg("答", "assistant"),
    ];
    const done = turnFinished(createDraftSession(), {
      conversationId: "conv-t3",
      messages,
      turnCount: 1,
      updatedAt: "2026-08-05T00:00:00.000Z",
      jsonMode: false,
      stopReason: "completed",
      lastUsage,
    });
    expect(done.lastUsage).toEqual(lastUsage);
    expect(Object.isFrozen(done)).toBe(true);
    expect(Object.isFrozen(done.messages)).toBe(true);
  });

  it("turnFinished 无 lastUsage（null）→ state.lastUsage 为 null", () => {
    const done = turnFinished(createDraftSession(), {
      conversationId: "conv-t3",
      messages: [],
      turnCount: 0,
      updatedAt: "",
      jsonMode: false,
      stopReason: "completed",
      lastUsage: null,
    });
    expect(done.lastUsage).toBeNull();
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

describe("session-state: sessionCompacted（/compact 落盘后刷新）", () => {
  const compactedMessages: ReadonlyArray<AnthropicNativeMessage> = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "[compaction boundary — earlier messages cleared]",
        },
      ],
    },
    msg("尾部消息"),
  ];

  it("压缩后：消息/turnCount/updatedAt 替换，runState 归 idle", () => {
    const lastUsage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    // 构造一个已跑过 turn、持有 lastUsage 的 idle 会话。
    const afterTurn = turnFinished(turnStarted(createDraftSession()), {
      conversationId: "conv-1",
      messages: [msg("问"), msg("答", "assistant")],
      turnCount: 1,
      updatedAt: "2026-08-05T00:00:00.000Z",
      jsonMode: false,
      stopReason: "completed",
      lastUsage,
    });
    const compacted = sessionCompacted(afterTurn, {
      messages: compactedMessages,
      turnCount: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
      jsonMode: false,
    });
    expect(compacted.runState).toBe("idle");
    expect(compacted.messages).toHaveLength(2);
    expect(compacted.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "[compaction boundary — earlier messages cleared]",
        },
      ],
    });
    expect(compacted.updatedAt).toBe("2026-08-06T00:00:00.000Z");
    // 关键语义：压缩不是 turn，lastUsage / lastStopReason 保留。
    expect(compacted.lastUsage).toEqual(lastUsage);
    expect(compacted.lastStopReason).toBe("completed");
    expect(Object.isFrozen(compacted.messages)).toBe(true);
  });

  it("非 idle（running-fg）→ 保持原状态（与 turnStarted 同护栏语义）", () => {
    const running = turnStarted(createDraftSession());
    const result = sessionCompacted(running, {
      messages: compactedMessages,
      turnCount: 99,
      updatedAt: "2026-08-06T00:00:00.000Z",
      jsonMode: false,
    });
    expect(result).toBe(running); // 原对象引用，无替换
  });
});

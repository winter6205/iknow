/**
 * tests/tui/rewind.test.ts
 *
 * checkpoint-rewind tests: slash vocabulary / sessionRewound reducer /
 * bridge.rewindSession integration / double-Esc debounce / rewind-picker pure functions.
 *
 * Driven by bun:test (tests/tui runs under bun). Integration cases isolate
 * SessionStore via mkdtemp (never write the real ~/.iknow).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDoubleEsc,
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import {
  attachSession,
  sessionRewound,
  turnFinished,
  turnStarted,
} from "../../src/tui/session-state.js";
import { resolveRewindAnchor } from "../../src/session-api/store/checkpoint.js";
import {
  buildRewindTargets,
  codeRestoreNoticeLines,
  reduceRewindKey,
  rewindModalRows,
  rewindPickerContent,
  type RewindTarget,
} from "../../src/tui/rewind-picker.js";
import { makeDeps } from "../cli/_fixtures.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import { resolveProjectSessionDir } from "../../src/session-api/store/session-store.js";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.js";
import { resolveConversationDir } from "../../src/session-api/store/session-store.js";
import { parseTuiInput } from "../../src/tui/slash.js";
import type { ModalKeyEvent } from "../../src/tui/modal.js";

// -- fixtures -----------------------------------------------------------------

const text = (t: string) => ({ type: "text" as const, text: t });
const toolUse = (id: string, name: string, input: unknown) =>
  ({
    type: "tool_use" as const,
    id,
    name,
    input,
  }) as const;
const toolResult = (tool_use_id: string, is_error?: boolean) =>
  ({
    type: "tool_result" as const,
    tool_use_id,
    content: "ok",
    ...(is_error !== undefined ? { is_error } : {}),
  }) as const;

const userMsg = (...texts: string[]): AnthropicNativeMessage => ({
  role: "user",
  content: texts.map((t) => text(t)),
});
const userToolResult = (id: string): AnthropicNativeMessage => ({
  role: "user",
  content: [toolResult(id)],
});
const assistantMsg = (
  blocks: ReadonlyArray<ReturnType<typeof text> | ReturnType<typeof toolUse>>
): AnthropicNativeMessage => ({
  role: "assistant",
  content: blocks as AnthropicNativeMessage["content"],
});

/** 3-turn session (turn0/1 with tool pairing) + 2 checkpoints, seeds integration cases. */
function sampleFile(overrides?: Partial<SessionFileV1>): SessionFileV1 {
  return {
    schemaVersion: 3,
    conversation_id: "conv-rewind",
    messages: [
      userMsg("q1"),
      assistantMsg([toolUse("t1", "read_file", {})]),
      userToolResult("t1"),
      assistantMsg([text("done")]),
      userMsg("q2"),
      assistantMsg([text("a2")]),
      userMsg("q3"),
      assistantMsg([text("a3")]),
    ],
    jsonMode: false,
    turnCount: 3,
    updatedAt: "2026-08-11T00:00:00.000Z",
    title: "stale-title",
    cwd: "",
    sanitized_at: "2026-08-11T00:00:00.000Z",
    checkpoints: [
      {
        turnIndex: 1,
        messagesCount: 4,
        interruptedAt: "2026-08-11T00:00:00.000Z",
        interruptReason: "cancelled",
      },
      {
        turnIndex: 2,
        messagesCount: 6,
        interruptedAt: "2026-08-11T00:00:01.000Z",
        interruptReason: "timeout",
      },
      {
        turnIndex: 3,
        messagesCount: 8,
        interruptedAt: "2026-08-11T00:00:02.000Z",
        interruptReason: "cancelled",
      },
    ],
    ...overrides,
  } as SessionFileV1;
}

const ISO = "2026-08-11T00:00:00.000Z";

// -- slash vocabulary ---------------------------------------------------------

describe("slash: /rewind 词表四触点", () => {
  test("/rewind → command rewind", () => {
    expect(parseTuiInput("/rewind")).toEqual({
      kind: "command",
      command: "rewind",
    });
  });

  test("大小写与前后空白容忍", () => {
    expect(parseTuiInput("  /REWIND  ")).toEqual({
      kind: "command",
      command: "rewind",
    });
  });

  test("/rewindx → unknown（不误命中前缀）", () => {
    expect(parseTuiInput("/rewindx")).toEqual({
      kind: "unknown",
      raw: "/rewindx",
    });
  });

  test("/help 覆盖 /rewind 且无 emoji", async () => {
    const { helpLines } = await import("../../src/tui/slash.js");
    const joined = helpLines().join("\n");
    expect(joined).toContain("/rewind");
    expect(joined).toContain("回退到更早的回合");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });

  test('"/r" 前缀候选含 rewind', async () => {
    const { slashSuggestions } = await import("../../src/tui/slash.js");
    // slashSuggestions returns SlashCandidate discriminated-union objects.
    expect(slashSuggestions("/r")).toContainEqual({
      kind: "command",
      command: "rewind",
    });
  });
});

// -- sessionRewound reducer ---------------------------------------------------

describe("sessionRewound（/rewind 落盘后刷新）", () => {
  const lastUsage = {
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };

  function idleAfterTurn() {
    return turnFinished(turnStarted({} as never), {
      conversationId: "conv-1",
      messages: [userMsg("问"), assistantMsg([text("答")])],
      turnCount: 3,
      updatedAt: "2026-08-05T00:00:00.000Z",
      jsonMode: false,
      stopReason: "completed",
      lastUsage,
    } as never);
  }

  test("回退后：消息/turnCount/updatedAt 整体替换，runState 归 idle", () => {
    const session = idleAfterTurn();
    const rewound = sessionRewound(session, {
      messages: [userMsg("q1"), assistantMsg([text("a1")])],
      turnCount: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
      jsonMode: false,
    });
    expect(rewound.runState).toBe("idle");
    expect(rewound.messages).toHaveLength(2);
    expect(rewound.messages[0]).toEqual(userMsg("q1"));
    expect(rewound.turnCount).toBe(1);
    expect(rewound.updatedAt).toBe("2026-08-06T00:00:00.000Z");
    expect(rewound.jsonMode).toBe(false);
    expect(Object.isFrozen(rewound.messages)).toBe(true);
  });

  test("回退不是 turn：lastUsage / lastStopReason 保留", () => {
    const session = idleAfterTurn();
    const rewound = sessionRewound(session, {
      messages: [userMsg("q1")],
      turnCount: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
      jsonMode: false,
    });
    expect(rewound.lastUsage).toEqual(lastUsage);
    expect(rewound.lastStopReason).toBe("completed");
  });

  test("非 idle（running-fg）→ 保持原状态（护栏语义，不抛错）", () => {
    const running = turnStarted({} as never);
    const result = sessionRewound(running, {
      messages: [],
      turnCount: 0,
      updatedAt: "",
      jsonMode: false,
    });
    expect(result).toBe(running);
  });

  test("keepTurns=0 回退后：messages=[] turnCount=0 runState=idle", () => {
    // rewinding a 1-turn session to the start truncates the file to empty → UI reflects an empty session (not a no-op).
    const session = attachSession({
      ...sampleFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")])],
      turnCount: 1,
    });
    const rewound = sessionRewound(session, {
      messages: [],
      turnCount: 0,
      updatedAt: "2026-08-06T00:00:00.000Z",
      jsonMode: false,
    });
    expect(rewound.runState).toBe("idle");
    expect(rewound.messages).toHaveLength(0);
    expect(rewound.turnCount).toBe(0);
  });
});

// -- buildRewindTargets / reduceRewindKey (picker pure functions) --------------

describe("buildRewindTargets（L3 锚点投影）", () => {
  test("空会话 / 无完成 turn → 空数组（L0 空态）", () => {
    expect(buildRewindTargets({ ...sampleFile(), messages: [] })).toEqual([]);
    // assistant-only messages (no query opener) → 0 turns
    expect(
      buildRewindTargets({
        ...sampleFile(),
        messages: [assistantMsg([text("orphan")])],
      })
    ).toEqual([]);
  });

  test("turnCount=1：选 q1 = 回到这句之前（head=null + fillInput）", () => {
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")])],
      turnCount: 1,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      head: null,
      userMessageText: "q1",
      fullText: "q1",
      fillInput: true,
    });
  });

  test("只单条 user 消息无 reply → 也列 keepTurns=0", () => {
    // a single user message (no assistant reply) still gives 1 turn start; the
    // keepTurns=0 anchor is listed as usual (full text refills the input box).
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1")],
      turnCount: 1,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.fullText).toBe("q1");
  });

  test("空 messages turnCount=0 → 真 L0 空态", () => {
    // no user message → splitTurns empty → empty array (host takes the L0 empty state, zero store IO).
    expect(
      buildRewindTargets({ ...sampleFile(), messages: [], turnCount: 0 })
    ).toEqual([]);
  });

  test("2-turn 会话 → [q1 之前, q2 之前]；head 是该句 parent，fillInput 全开", () => {
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")]), userMsg("q2")],
      turnCount: 2,
    });
    expect(targets.map((t) => t.head)).toEqual([null, "e1"]);
    expect(targets[0]).toMatchObject({
      head: null,
      anchorTurnIndex: 0,
      userMessageText: "q1",
      fullText: "q1",
      fillInput: true,
      anchoredAt: "",
    });
    expect(targets[1]).toMatchObject({
      head: "e1",
      anchorTurnIndex: 1,
      userMessageText: "q2",
      fullText: "q2",
      fillInput: true,
    });
  });

  test("3-turn 会话 → 每条用户消息一行，head=parent（不含这句本身）", () => {
    const targets = buildRewindTargets(sampleFile());
    expect(targets.map((t) => t.head)).toEqual([null, "e3", "e5"]);
    expect(targets.map((t) => t.userMessageText)).toEqual(["q1", "q2", "q3"]);
    expect(targets.every((t) => t.fillInput)).toBe(true);
    expect(targets.some((t) => t.head === "e6")).toBe(false);
    expect(targets.some((t) => t.head === "e7")).toBe(false);
  });

  test("锚点文本 strip + 截 80（同 extractTitle 语义）；fullText 不截断", () => {
    const long = "x".repeat(100);
    const file = {
      ...sampleFile(),
      messages: [
        userMsg("q1"),
        assistantMsg([text("a1")]),
        userMsg(long),
        assistantMsg([text("a2")]),
      ],
      turnCount: 2,
    };
    const targets = buildRewindTargets(file);
    expect(targets[1]!.userMessageText).toHaveLength(80);
    expect(targets[1]!.fullText).toHaveLength(100);
  });

  test("与 checkpoints 按 turnIndex 合取 anchoredAt；无快照 → 空串", () => {
    const targets = buildRewindTargets(sampleFile());
    expect(targets[1]!.anchoredAt).toBe("2026-08-11T00:00:00.000Z");
    expect(targets[2]!.anchoredAt).toBe("2026-08-11T00:00:01.000Z");
    expect(targets[0]!.anchoredAt).toBe("");
  });

  test("悬空 tool_result-only user 消息不开新 turn（splitTurns 语义）", () => {
    // [q1, t-orphan tool_result]: a tool_result-only user message is a
    // continuation, not a query → splitTurns yields 1 turn → only the
    // keepTurns=0 anchor is listed (label=q1).
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1"), userToolResult("t-orphan")],
      turnCount: 1,
    });
    expect(targets).toHaveLength(1);
    expect(targets.map((t) => t.head)).toEqual([null]);
    expect(targets[0]).toMatchObject({
      head: null,
      userMessageText: "q1",
      fillInput: true,
    });
  });

  test("keepTurns=0 锚点 anchoredAt 合取 turnIndex=0 快照", () => {
    // when the start anchor (turnIndex=0) matches a checkpoints snapshot,
    // anchoredAt is non-empty — same conjunctive rule as i≥1 anchors, no longer always "".
    const targets = buildRewindTargets({
      ...sampleFile(),
      checkpoints: [
        {
          turnIndex: 0,
          messagesCount: 1,
          interruptedAt: ISO,
          interruptReason: "cancelled",
        },
      ],
    });
    expect(targets[0]!.anchoredAt).toBe(ISO);
  });

  test("非-checkpoint 锚点在 messageCreatedAt 有值 → fallback 到入账时刻（非空 anchoredAt）", () => {
    // files loaded after appendEvents stamping: messageCreatedAt maps 1:1 to
    // messages. Anchors without a checkpoint snapshot show the message's
    // recorded time, no longer always "".
    const file = {
      ...sampleFile(),
      messageCreatedAt: [
        "2026-08-20T10:00:00.000Z", // q1 (turn 0 start, index 0)
        null, // assistant tool_use
        null, // tool_result
        null, // assistant done
        "2026-08-20T11:00:00.000Z", // q2 (turn 1 start, index 4)
        null, // a2
        "2026-08-20T12:00:00.000Z", // q3 (turn 2 start, index 6)
        null, // a3
      ] as ReadonlyArray<string | null>,
      // no checkpoints at all: everything takes the fallback leg.
      checkpoints: [],
    };
    const targets = buildRewindTargets(file);
    expect(targets.map((t) => t.head)).toEqual([null, "e3", "e5"]);
    expect(targets[0]!.anchoredAt).toBe("2026-08-20T10:00:00.000Z");
    expect(targets[1]!.anchoredAt).toBe("2026-08-20T11:00:00.000Z");
    expect(targets[2]!.anchoredAt).toBe("2026-08-20T12:00:00.000Z");
  });

  test("checkpoint 优先于 messageCreatedAt（两段 fallback 第一段命中即返回）", () => {
    // same anchor has both checkpoint.interruptedAt and messageCreatedAt:
    // the interruption time shows, not overwritten by the recorded time.
    const file = {
      ...sampleFile(),
      messageCreatedAt: [
        "2026-08-20T10:00:00.000Z",
        null,
        null,
        null,
        "2026-08-20T11:00:00.000Z",
        null,
        "2026-08-20T12:00:00.000Z",
        null,
      ] as ReadonlyArray<string | null>,
      checkpoints: [
        {
          turnIndex: 2,
          messagesCount: 8,
          interruptedAt: "2026-08-11T09:30:00.000Z",
          interruptReason: "cancelled" as const,
        },
      ],
    };
    const targets = buildRewindTargets(file);
    expect(targets[0]!.anchoredAt).toBe("2026-08-20T10:00:00.000Z");
    expect(targets[1]!.anchoredAt).toBe("2026-08-20T11:00:00.000Z");
    // turnIndex 2 matches a checkpoint → interruptedAt wins.
    expect(targets[2]!.anchoredAt).toBe("2026-08-11T09:30:00.000Z");
  });

  test('messageCreatedAt 缺席（旧文件）→ 非-checkpoint 锚点仍为 ""（现状不退化）', () => {
    // old files lack the messageCreatedAt key: fallback reads undefined → "",
    // fmtAnchored renders an empty string — exactly the pre-stamping behavior.
    const targets = buildRewindTargets({ ...sampleFile(), checkpoints: [] });
    expect(targets.map((t) => t.head)).toEqual([null, "e3", "e5"]);
    for (const t of targets) {
      expect(t.anchoredAt).toBe("");
    }
  });
});

describe("reduceRewindKey（选择器键路由）", () => {
  const targets: ReadonlyArray<RewindTarget> = [
    {
      head: null,
      userMessageText: "q1",
      fullText: "q1",
      anchorTurnIndex: 0,
      anchoredAt: "",
      fillInput: true,
    },
    {
      head: "e3",
      userMessageText: "q2",
      fullText: "q2",
      anchorTurnIndex: 1,
      anchoredAt: ISO,
      fillInput: true,
    },
    {
      head: "e5",
      userMessageText: "q3",
      fullText: "q3",
      anchorTurnIndex: 2,
      anchoredAt: "",
      fillInput: true,
    },
  ];
  const noKey = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    tab: false,
    space: false,
    return: false,
    escape: false,
    ctrl: false,
    meta: false,
  };
  const key = (patch: Partial<ModalKeyEvent["key"]>): ModalKeyEvent => ({
    input: "",
    key: { ...noKey, ...patch },
  });

  test("选择态：↑/↓ clamp 移动；Enter → confirm；Esc → cancel", () => {
    expect(
      reduceRewindKey(key({ upArrow: true }), {
        targets,
        selectedIndex: 0,
        confirming: false,
        confirmIndex: 0,
      })
    ).toEqual({ type: "move", index: 0 });
    expect(
      reduceRewindKey(key({ downArrow: true }), {
        targets,
        selectedIndex: 0,
        confirming: false,
        confirmIndex: 0,
      })
    ).toEqual({ type: "move", index: 1 });
    expect(
      reduceRewindKey(key({ downArrow: true }), {
        targets,
        selectedIndex: 2,
        confirming: false,
        confirmIndex: 0,
      })
    ).toEqual({ type: "move", index: 2 });
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 1,
        confirming: false,
        confirmIndex: 0,
      })
    ).toEqual({ type: "confirm" });
    expect(
      reduceRewindKey(key({ escape: true }), {
        targets,
        selectedIndex: 1,
        confirming: false,
        confirmIndex: 0,
      })
    ).toEqual({ type: "cancel" });
  });

  test("确认态：Enter 执行高亮动作（head + restoreCode 来自所选行）", () => {
    // Row 0 rewinds the transcript and restores code; row 1 rewinds only; the
    // boolean is what hub.rewindSession receives (ADR-0121), so a mis-wired row
    // is a product-visible difference, not a cosmetic one.
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
        confirmIndex: 0,
      })
    ).toEqual({ type: "execute", head: "e3", restoreCode: true });
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
        confirmIndex: 1,
      })
    ).toEqual({ type: "execute", head: "e3", restoreCode: false });
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 0,
        confirming: true,
        confirmIndex: 0,
      })
    ).toEqual({ type: "execute", head: null, restoreCode: true });
    expect(
      reduceRewindKey(key({ escape: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
        confirmIndex: 0,
      })
    ).toEqual({ type: "cancel" });
  });

  test("确认态：取消行 Enter → cancel（不留下 head）", () => {
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
        confirmIndex: 2,
      })
    ).toEqual({ type: "cancel" });
  });

  test("确认态：↑/↓ 在三个动作间移动并 clamp 于首尾", () => {
    expect(
      reduceRewindKey(key({ upArrow: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
        confirmIndex: 0,
      })
    ).toEqual({ type: "move", index: 0 });
    expect(
      reduceRewindKey(key({ downArrow: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
        confirmIndex: 0,
      })
    ).toEqual({ type: "move", index: 1 });
    expect(
      reduceRewindKey(key({ downArrow: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
        confirmIndex: 2,
      })
    ).toEqual({ type: "move", index: 2 });
  });

  test("确认态：锚点消失（越界）时正行动作 ignore，取消行仍可用", () => {
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 9,
        confirming: true,
        confirmIndex: 0,
      })
    ).toEqual({ type: "ignore" });
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 9,
        confirming: true,
        confirmIndex: 2,
      })
    ).toEqual({ type: "cancel" });
  });

  test("ctrl/meta 组合键 → ignore", () => {
    expect(
      reduceRewindKey(
        { input: "y", key: { ...noKey, ctrl: true } },
        {
          targets,
          selectedIndex: 0,
          confirming: false,
          confirmIndex: 0,
        }
      )
    ).toEqual({ type: "ignore" });
  });
});

// -- rewindPickerContent (picker render shape — pins ground-truth parity) ------

describe("rewindPickerContent（picker 渲染形状）", () => {
  test("3-turn 会话：选项 label = 锚点用户消息真实文本（不再用「保留前 N 轮」抽象标签）", () => {
    const targets = buildRewindTargets(sampleFile());
    const content = rewindPickerContent(targets, 0, false);
    // 3 user messages, one option each; the main label must be the real text
    expect(content.options.map((o) => o.label)).toEqual(["q1", "q2", "q3"]);
    // no "rewind to session start" or "keep previous…" literals
    for (const opt of content.options) {
      expect(opt.label).not.toContain("回到会话起点");
      expect(opt.label).not.toMatch(/保留前/);
    }
  });

  test("确认态 head=null：desc 引用「首条用户消息」+「之前」+ 账本保留", () => {
    const targets = buildRewindTargets(sampleFile());
    const content = rewindPickerContent(targets, 0, true);
    expect(content.title).toBe("确认回退？");
    expect(content.description).toContain("恢复到");
    expect(content.description).toContain("之前");
    expect(content.description).toContain("账本");
    expect(content.description).not.toContain("不可恢复");
    expect(content.options.map((o) => o.value)).toEqual([
      "restore_code",
      "transcript_only",
      "cancel",
    ]);
  });

  test("确认态三选一：恢复代码 / 仅回退对话 / 取消都在屏上（spec Does）", () => {
    const targets = buildRewindTargets(sampleFile());
    const content = rewindPickerContent(targets, 1, true);
    expect(content.options.map((o) => o.label)).toEqual([
      "回退对话并恢复代码",
      "仅回退对话",
      "取消",
    ]);
    // Two positive rows plus cancel is the whole point of the confirm step; the
    // hint must teach ↑/↓, otherwise the second action is unreachable by keyboard.
    expect(content.options).toHaveLength(3);
    expect(content.hint).toContain("↑↓");
  });

  test("确认态有 head：desc 引用锚点消息 + 之前（Claude Code before-this-message）", () => {
    const targets = buildRewindTargets(sampleFile());
    const content = rewindPickerContent(targets, 1, true);
    expect(content.description).toContain("q2");
    expect(content.description).toContain("之前");
    expect(content.description).not.toContain("祖先链含");
  });

  test("1-turn 会话 keepTurns=0 锚点照常渲染（label = 首条消息 q1）", () => {
    // turnCount=1 still lists keepTurns=0 (a real truncate-to-empty rewind); the
    // picker renders normally, no longer via the "empty array → L0 empty state" branch.
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1")],
      turnCount: 1,
    });
    const content = rewindPickerContent(targets, 0, false);
    expect(content.options.map((o) => o.label)).toEqual(["q1"]);
  });

  test("label 截 40（userMessageText 截 80 后再截 40）", () => {
    // 2-turn file whose first message is 200 chars: userMessageText truncates to 80, picker label truncates again to 40.
    const long = "x".repeat(200);
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg(long), assistantMsg([text("a1")]), userMsg("q2")],
      turnCount: 2,
    });
    const content = rewindPickerContent(targets, 0, false);
    expect(content.options[0]!.label).toHaveLength(40);
    expect(targets[0]!.userMessageText).toHaveLength(80);
  });
});

// -- rewindModalRows (row accounting for both picker states) ------------------

describe("rewindModalRows（确认态按三动作计行）", () => {
  test("确认态行数不随锚点条数增长；选择态仍按锚点计行", () => {
    const one = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1")],
      turnCount: 1,
    });
    const three = buildRewindTargets(sampleFile());
    expect(three).toHaveLength(3);
    const confirmRows = rewindModalRows(three, 200, 1, true, 1);
    expect(rewindModalRows(one, 200, 0, true, 0)).toBe(confirmRows);
    // The select state counts anchors, so a one-anchor list is a shorter budget
    // than the three fixed actions — that difference is what this pins.
    expect(rewindModalRows(one, 200, 0, false, 0)).toBeLessThan(confirmRows);
  });

  test("高亮第几行只改前缀形状，不改行数", () => {
    const targets = buildRewindTargets(sampleFile());
    expect(rewindModalRows(targets, 200, 0, true, 2)).toBe(
      rewindModalRows(targets, 200, 0, true, 0)
    );
  });

  test("窄终端：动作行折行，行数大于宽终端（与渲染同源）", () => {
    const targets = buildRewindTargets(sampleFile());
    expect(rewindModalRows(targets, 24, 0, true, 0)).toBeGreaterThan(
      rewindModalRows(targets, 200, 0, true, 0)
    );
  });
});

// -- codeRestoreNoticeLines (restore report → notice lines) -------------------

describe("codeRestoreNoticeLines（恢复报告 → notice 行）", () => {
  test("写回 N 个文件 → 计数行，无跳过时仅此一行", () => {
    expect(
      codeRestoreNoticeLines({
        restored: ["src/a.ts", "src/b.ts"],
        skipped: [],
      })
    ).toEqual(["代码恢复：写回 2 个文件。"]);
  });

  test("drift 与 root_identity 各自成行，同因路径并列", () => {
    expect(
      codeRestoreNoticeLines({
        restored: ["src/a.ts"],
        skipped: [
          { relPath: "src/b.ts", reason: "drift" },
          { relPath: "src/c.ts", reason: "drift" },
          { relPath: "src/d.ts", reason: "root_identity" },
        ],
      })
    ).toEqual([
      "代码恢复：写回 1 个文件。",
      "未恢复（文件已被后续改动）：src/b.ts、src/c.ts",
      "未恢复（工作区根已变化）：src/d.ts",
    ]);
  });

  test("cross_transcript 独立成行：路径属于多条转录本时不写回", () => {
    expect(
      codeRestoreNoticeLines({
        restored: ["src/a.ts"],
        skipped: [{ relPath: "src/b.ts", reason: "cross_transcript" }],
      })
    ).toEqual([
      "代码恢复：写回 1 个文件。",
      "未恢复（多条转录本改过该文件）：src/b.ts",
    ]);
  });

  test("空报告也是明确结果：说明没有可写回的前像", () => {
    expect(codeRestoreNoticeLines({ restored: [], skipped: [] })).toEqual([
      "代码恢复：被放弃的回合没有可写回的前像。",
    ]);
  });
});

// -- double-Esc debounce (pure function) --------------------------------------

describe("isDoubleEsc（1000ms debounce 窗口）", () => {
  test("间隔 999ms → 命中（≤ 窗口）", () => {
    expect(isDoubleEsc(0, 999)).toBe(true);
  });

  test("间隔 1000ms → 命中（边界含等号：now - last <= 1000）", () => {
    expect(isDoubleEsc(0, 1000)).toBe(true);
  });

  test("间隔 1001ms → 不命中（> 窗口）", () => {
    expect(isDoubleEsc(0, 1001)).toBe(false);
  });

  test("无上次 Esc（undefined 语义由调用方保证）— 大间隔不命中", () => {
    expect(isDoubleEsc(0, 10_000)).toBe(false);
  });
});

// -- bridge.rewindSession integration (tmpdir pool, mirrors checkpoint.test.ts) -

describe("bridge.rewindSession（hub.rewindSession 移 head → store.load 读回）", () => {
  let baseDir: string;

  // T1 (session-folder-consolidation): the bridge derives its store root as
  // `deriveProjectIdentityRoot({ cwd: workspaceRoot })` (hub-bridge.ts) — the
  // seed must hit the SAME project dir, and the file must live inside the
  // `<conversationId>/` session folder (store.load's discovery root).
  let projectDir: string;
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-rewind-"));
    projectDir = resolveProjectSessionDir(
      baseDir,
      deriveProjectIdentityRoot({ cwd: baseDir })
    );
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function seedFile(file: SessionFileV1): Promise<void> {
    const dir = resolveConversationDir({
      projectDir,
      conversationId: file.conversation_id,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${file.conversation_id}.json`),
      JSON.stringify(file, null, 2),
      "utf8"
    );
  }

  function makeBridge() {
    return createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
  }

  test("resolveRewindAnchor（available=1 边界）keepTurns=0 → 空 transcript 头（非 no-op）", () => {
    // available=1 with keepTurns=0 differs from available → real rewind to start:
    // headIndex=-1 (head becomes null), turnCount=0 — not a no-op.
    const out = resolveRewindAnchor(
      [userMsg("q1"), assistantMsg([text("a1")])],
      0
    );
    expect(out.headIndex).toBe(-1);
    expect(out.turnCount).toBe(0);
  });

  test("turn-boundary preservation：截断到 turn 起点", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const { file: out } = await bridge.rewindSession(
      "conv-rewind",
      "e3",
      false
    );
    // turn0 ends at index 4 (tool pairing complete).
    expect(out.messages.length).toBe(4);
    expect(out.messages[0]!.content[0]!.type).toBe("text");
    // readable back from disk (same file).
    const reloaded = await bridge.loadSessionFile("conv-rewind");
    expect(reloaded.messages.length).toBe(4);
  });

  test("bridge.rewindSession（1-turn 文件）keepTurns=0 → 真实截空落盘", async () => {
    // integration path: 1-turn session rewound to start → on disk messages=[]/turnCount=0/checkpoints=[].
    await seedFile({
      ...sampleFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")])],
      turnCount: 1,
    });
    const bridge = makeBridge();
    const { file: out } = await bridge.rewindSession(
      "conv-rewind",
      null,
      false
    );
    expect(out.messages).toHaveLength(0);
    expect(out.turnCount).toBe(0);
    expect(out.checkpoints).toEqual([]);
    // readable back from disk (same cut-off file seen through another entry point).
    const reloaded = await bridge.loadSessionFile("conv-rewind");
    expect(reloaded.messages).toHaveLength(0);
    expect(reloaded.turnCount).toBe(0);
  });

  test("tool-pair intact：回退后 tool_use 与 tool_result 保持配对", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const { file: out } = await bridge.rewindSession(
      "conv-rewind",
      "e3",
      false
    );
    expect((out.messages[1]!.content[0] as { type: string }).type).toBe(
      "tool_use"
    );
    expect((out.messages[2]!.content[0] as { type: string }).type).toBe(
      "tool_result"
    );
  });

  test("turnCount === keepTurns；checkpoints 剪枝（turnIndex ≥ keepTurns 全清）", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const { file: out } = await bridge.rewindSession(
      "conv-rewind",
      "e5",
      false
    );
    expect(out.turnCount).toBe(2);
    expect(out.checkpoints).toEqual([
      {
        turnIndex: 1,
        messagesCount: 4,
        interruptedAt: "2026-08-11T00:00:00.000Z",
        interruptReason: "cancelled",
        // surviving snapshot re-anchors by event id (messagesCount 4 → 4th item on chain = e3).
        anchorEventId: "e3",
      },
    ]);
  });

  test("title 从截断前缀重算", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const { file: out } = await bridge.rewindSession(
      "conv-rewind",
      "e3",
      false
    );
    expect(out.title).toBe("q1");
  });

  test("head 已是当前链尾 → no-op", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const { file: out } = await bridge.rewindSession(
      "conv-rewind",
      "e7",
      false
    );
    expect(out.messages.length).toBe(8);
    expect(out.turnCount).toBe(3);
  });

  test("keepTurns=0 → 空消息 + 空 checkpoints（回到会话起点）", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const { file: out } = await bridge.rewindSession(
      "conv-rewind",
      null,
      false
    );
    expect(out.messages).toHaveLength(0);
    expect(out.turnCount).toBe(0);
    expect(out.checkpoints).toEqual([]);
  });

  test("空会话 + keepTurns>0 → no-op（不崩）", async () => {
    // empty session = messages:[] and turnCount=0; rewindFile clamps to target=available=0,
    // target === available takes the no-op branch (same shape as checkpoint.test.ts cases).
    await seedFile({ ...sampleFile(), messages: [], turnCount: 0 });
    const bridge = makeBridge();
    const { file: out } = await bridge.rewindSession(
      "conv-rewind",
      null,
      false
    );
    expect(out.messages).toHaveLength(0);
    expect(out.turnCount).toBe(0);
  });

  test("错误路径：load parse_failed → typed kind 透传（不新造）", async () => {
    const dir = resolveConversationDir({
      projectDir,
      conversationId: "conv-bad",
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "conv-bad.json"), "{garbage", "utf8");
    const bridge = makeBridge();
    await expect(
      bridge.rewindSession("conv-bad", null, false)
    ).rejects.toMatchObject({
      kind: "parse_failed",
    });
  });

  test("错误路径：load not_found → typed kind 透传", async () => {
    const bridge = makeBridge();
    await expect(
      bridge.rewindSession("no-such-id", null, false)
    ).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  test("错误路径：save write_failed → typed kind 透传（不新造）", async () => {
    await seedFile(sampleFile());
    // occupy the `${id}.jsonl.tmp` path with a directory of that name → persistHeadMove's writeFile
    // fails → write_failed. The authoritative JSONL goes through `${id}.jsonl.tmp`;
    // the authoritative file lives inside the `<projectDir>/<id>/` session folder.
    const dir = resolveConversationDir({
      projectDir,
      conversationId: "conv-rewind",
    });
    await mkdir(join(dir, "conv-rewind.jsonl.tmp"), { recursive: true });
    const bridge = makeBridge();
    await expect(
      bridge.rewindSession("conv-rewind", "e3", false)
    ).rejects.toMatchObject({
      kind: "write_failed",
    });
  });

  test("rewind 后下一轮从新低基准续号（turnCount 契约，chat-session.ts:472）", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    await bridge.rewindSession("conv-rewind", "e3", false);
    const file = await bridge.loadSessionFile("conv-rewind");
    expect(file.turnCount).toBe(1);
  });

  test("restoreCode=false → 报告字段缺席；true → hub 的 codeRestore 原样带出", async () => {
    // The bridge's only job here is to forward the boolean and surface the hub's
    // report; whether files really went back is pinned by
    // tests/session-api/hub-rewind-code-restore.test.ts.
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const plain = await bridge.rewindSession("conv-rewind", "e3", false);
    expect(plain.codeRestore).toBeUndefined();
    expect(plain.file.turnCount).toBe(1);

    await seedFile(sampleFile());
    const restored = await bridge.rewindSession("conv-rewind", "e5", true);
    // No preimage was ever captured for this fixture, so the hub reports zero ops.
    expect(restored.codeRestore).toEqual({ restored: [], skipped: [] });
  });
});

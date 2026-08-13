/**
 * tests/tui/rewind.test.ts
 *
 * T6 (checkpoint-rewind) 测试：slash 词表 / sessionRewound reducer /
 * bridge.rewindSession 集成 / 双 Esc debounce / rewind-picker 纯函数。
 *
 * bun:test 驱动（D2 裁决：tests/tui 由 bun 驱动）。集成用例用 mkdtemp 隔离
 * SessionStore（绝不写真实 ~/.iknow）。
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
import { rewindFile } from "../../src/session-api/store/checkpoint.js";
import {
  buildRewindTargets,
  reduceRewindKey,
  rewindPickerContent,
  type RewindTarget,
} from "../../src/tui/rewind-picker.js";
import { makeDeps } from "../cli/_fixtures.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import type {
  CheckpointRecord,
  SessionFileV1,
} from "../../src/session-api/store/schema.js";
import { resolveProjectSessionDir } from "../../src/session-api/store/session-store.js";
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

/** 3-turn 会话（turn0/1 带 tool 配对）+ 2 条 checkpoint，供集成用例播种。 */
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
    summary: "stale-summary",
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

// -- slash 词表 ---------------------------------------------------------------

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
    // #337 Phase C: slashSuggestions 返回 SlashCandidate 判别联合对象。
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
    // 1-turn 会话回退到起点：盘上截空 → UI 整体反射为空会话（非 no-op）。
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

// -- buildRewindTargets / reduceRewindKey（picker 纯函数） ----------------------

describe("buildRewindTargets（L3 锚点投影）", () => {
  test("空会话 / 无完成 turn → 空数组（L0 空态）", () => {
    expect(buildRewindTargets({ ...sampleFile(), messages: [] })).toEqual([]);
    // 只有 assistant 消息（无 query 起始）→ 0 turn
    expect(
      buildRewindTargets({
        ...sampleFile(),
        messages: [assistantMsg([text("orphan")])],
      })
    ).toEqual([]);
  });

  test("turnCount=1 列出 keepTurns=0 锚点（真实回退，不是 no-op）", () => {
    // 1-turn 会话：keepTurns=0「首条用户消息之前」是真实回退（rewindFile
    // 截空 msgs=[]/turnCount=0），必须列出，不能因为与 available 相近被吞。
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")])],
      turnCount: 1,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      keepTurns: 0,
      userMessageText: "q1",
      fullText: "q1",
    });
  });

  test("只单条 user 消息无 reply → 也列 keepTurns=0", () => {
    // 仅一条用户消息（无 assistant 回复）仍有 1 个 turn 起点，keepTurns=0
    // 锚点照常列出（完整文本填入输入框）。
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1")],
      turnCount: 1,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.fullText).toBe("q1");
  });

  test("空 messages turnCount=0 → 真 L0 空态", () => {
    // 无 user 消息 → splitTurns 空 → 空数组（宿主走 L0 空态，零 store IO）。
    expect(
      buildRewindTargets({ ...sampleFile(), messages: [], turnCount: 0 })
    ).toEqual([]);
  });

  test("2-turn 会话 → [首条消息之前, q2 之前]（available=2 边界）", () => {
    // available=2 ≥ 2：起点锚点合法；i=1（q2 之前）也与当前 turn 不同——只有
    // 索引 == total 才与当前重合，所以两个锚点都列出。
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")]), userMsg("q2")],
      turnCount: 2,
    });
    expect(targets.map((t) => t.keepTurns)).toEqual([0, 1]);
    expect(targets[0]).toMatchObject({
      keepTurns: 0,
      anchorTurnIndex: 0,
      userMessageText: "q1",
      fullText: "q1",
      anchoredAt: "",
    });
    expect(targets[1]).toMatchObject({
      keepTurns: 1,
      anchorTurnIndex: 1,
      userMessageText: "q2",
      fullText: "q2",
    });
  });

  test("3-turn 会话 → [回到首条消息之前, 保留到 q2 之前, 保留到 q3 之前]；当前 turn(3) 不列出", () => {
    const targets = buildRewindTargets(sampleFile());
    expect(targets.map((t) => t.keepTurns)).toEqual([0, 1, 2]);
    // 起点锚点 = 首条用户消息（"q1"），不再是「回到会话起点」抽象标签。
    expect(targets[0]).toMatchObject({
      keepTurns: 0,
      anchorTurnIndex: 0,
      userMessageText: "q1",
      fullText: "q1",
      anchoredAt: "",
    });
    expect(targets[1]).toMatchObject({
      keepTurns: 1,
      anchorTurnIndex: 1,
      userMessageText: "q2",
      fullText: "q2",
    });
    expect(targets[2]).toMatchObject({
      keepTurns: 2,
      userMessageText: "q3",
      fullText: "q3",
    });
    // 回退到当前 turn(=3) 不在列表（fallback 规则 3：no-op 自然不可达）。
    expect(targets.some((t) => t.keepTurns === 3)).toBe(false);
  });

  test("锚点文本 strip + 截 80（同 extractSummary 语义）；fullText 不截断", () => {
    const long = "x".repeat(100);
    const file = {
      ...sampleFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")]), userMsg(long)],
      turnCount: 2,
    };
    const targets = buildRewindTargets(file);
    // 展示用文本截 80。
    expect(targets[1]!.userMessageText).toHaveLength(80);
    // 填回输入框的完整文本不截断（用户要修改重发时拿的是原文）。
    expect(targets[1]!.fullText).toHaveLength(100);
  });

  test("与 checkpoints 按 turnIndex 合取 anchoredAt；无快照 → 空串", () => {
    const targets = buildRewindTargets(sampleFile());
    expect(targets[1]!.anchoredAt).toBe("2026-08-11T00:00:00.000Z");
    expect(targets[2]!.anchoredAt).toBe("2026-08-11T00:00:01.000Z");
    // 起点条目无快照。
    expect(targets[0]!.anchoredAt).toBe("");
  });

  test("悬空 tool_result-only user 消息不开新 turn（splitTurns 语义）", () => {
    // [q1, t-orphan tool_result]：tool_result-only user 消息是 continuation 不是
    // query → splitTurns 只有 1 个 turn → 只列 keepTurns=0 锚点（label=q1）。
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1"), userToolResult("t-orphan")],
      turnCount: 1,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      keepTurns: 0,
      userMessageText: "q1",
    });
  });

  test("keepTurns=0 锚点 anchoredAt 合取 turnIndex=0 快照", () => {
    // 起点锚点（turnIndex=0）命中 checkpoints 快照时 anchoredAt 非空——
    // 与 i≥1 的锚点同规则合取，不再恒为 ""。
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
});

describe("reduceRewindKey（选择器键路由）", () => {
  const targets: ReadonlyArray<RewindTarget> = [
    {
      keepTurns: 0,
      userMessageText: "q1",
      fullText: "q1",
      anchorTurnIndex: 0,
      anchoredAt: "",
    },
    {
      keepTurns: 1,
      userMessageText: "q2",
      fullText: "q2",
      anchorTurnIndex: 1,
      anchoredAt: ISO,
    },
    {
      keepTurns: 2,
      userMessageText: "q3",
      fullText: "q3",
      anchorTurnIndex: 2,
      anchoredAt: "",
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
      })
    ).toEqual({ type: "move", index: 0 });
    expect(
      reduceRewindKey(key({ downArrow: true }), {
        targets,
        selectedIndex: 0,
        confirming: false,
      })
    ).toEqual({ type: "move", index: 1 });
    expect(
      reduceRewindKey(key({ downArrow: true }), {
        targets,
        selectedIndex: 2,
        confirming: false,
      })
    ).toEqual({ type: "move", index: 2 });
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 1,
        confirming: false,
      })
    ).toEqual({ type: "confirm" });
    expect(
      reduceRewindKey(key({ escape: true }), {
        targets,
        selectedIndex: 1,
        confirming: false,
      })
    ).toEqual({ type: "cancel" });
  });

  test("确认态：Enter → execute（携带 keepTurns）；Esc → cancel", () => {
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
      })
    ).toEqual({ type: "execute", keepTurns: 1 });
    expect(
      reduceRewindKey(key({ return: true }), {
        targets,
        selectedIndex: 0,
        confirming: true,
      })
    ).toEqual({ type: "execute", keepTurns: 0 });
    expect(
      reduceRewindKey(key({ escape: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
      })
    ).toEqual({ type: "cancel" });
  });

  test("确认态 ↑/↓ 不移动（Enter 落在当前选中锚点）", () => {
    expect(
      reduceRewindKey(key({ downArrow: true }), {
        targets,
        selectedIndex: 1,
        confirming: true,
      })
    ).toEqual({ type: "ignore" });
  });

  test("ctrl/meta 组合键 → ignore", () => {
    expect(
      reduceRewindKey(
        { input: "y", key: { ...noKey, ctrl: true } },
        {
          targets,
          selectedIndex: 0,
          confirming: false,
        }
      )
    ).toEqual({ type: "ignore" });
  });
});

// -- rewindPickerContent（picker 渲染形状 — 锁真值 parity） -------------------

describe("rewindPickerContent（picker 渲染形状）", () => {
  test("3-turn 会话：选项 label = 锚点用户消息真实文本（不再用「保留前 N 轮」抽象标签）", () => {
    const targets = buildRewindTargets(sampleFile());
    const content = rewindPickerContent(targets, 0, false);
    // 3 个锚点（首条消息之前 + q2 之前 + q3 之前），主 label 必须是真实文本
    expect(content.options.map((o) => o.label)).toEqual(["q1", "q2", "q3"]);
    // 不含「回到会话起点」或「保留前」字面
    for (const opt of content.options) {
      expect(opt.label).not.toContain("回到会话起点");
      expect(opt.label).not.toMatch(/保留前/);
    }
  });

  test("确认态 keepTurns=0：desc 引用「首条用户消息」+「之前」+「不可恢复」", () => {
    const targets = buildRewindTargets(sampleFile());
    const content = rewindPickerContent(targets, 0, true);
    expect(content.title).toBe("确认回退？");
    expect(content.description).toContain("恢复到");
    expect(content.description).toContain("之前");
    expect(content.description).toContain("不可恢复");
    // options 固定 [execute / cancel]
    expect(content.options.map((o) => o.value)).toEqual(["execute", "cancel"]);
  });

  test("确认态 keepTurns>0：desc 引用锚点消息内容（q2）", () => {
    const targets = buildRewindTargets(sampleFile());
    // targets[1] = {keepTurns:1, userMessageText:"q2"}
    const content = rewindPickerContent(targets, 1, true);
    expect(content.description).toContain("恢复到");
    expect(content.description).toContain("q2");
    expect(content.description).toContain("之前");
  });

  test("1-turn 会话 keepTurns=0 锚点照常渲染（label = 首条消息 q1）", () => {
    // turnCount=1 也列出 keepTurns=0（真实截空回退），picker 正常渲染，
    // 不再走「空数组 → L0 空态」分支。
    const targets = buildRewindTargets({
      ...sampleFile(),
      messages: [userMsg("q1")],
      turnCount: 1,
    });
    const content = rewindPickerContent(targets, 0, false);
    expect(content.options.map((o) => o.label)).toEqual(["q1"]);
  });

  test("label 截 40（userMessageText 截 80 后再截 40）", () => {
    // 2-turn 文件首条消息 200 字：userMessageText 截到 80，picker label 再截 40。
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

// -- 双 Esc debounce（纯函数） --------------------------------------------------

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

// -- bridge.rewindSession 集成（tmpdir 池，镜像 checkpoint.test.ts 七条） ------

describe("bridge.rewindSession（load → rewindFile → save → 返回更新文件）", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-rewind-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function seedFile(file: SessionFileV1): Promise<void> {
    const dir = resolveProjectSessionDir(baseDir, process.cwd());
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
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
  }

  test("rewindFile（available=1 边界）keepTurns=0 真实截空（非 no-op）", () => {
    // available=1 时 keepTurns=0 与 available 不等 → 走截断分支（checkpoint.ts:180），
    // messages 截空、turnCount=0、checkpoints 全清 —— 不是 no-op。
    const out = rewindFile(
      {
        ...sampleFile(),
        messages: [userMsg("q1"), assistantMsg([text("a1")])],
        turnCount: 1,
        checkpoints: [
          {
            turnIndex: 1,
            messagesCount: 2,
            interruptedAt: ISO,
            interruptReason: "cancelled",
          },
        ],
      },
      0
    );
    expect(out.messages).toHaveLength(0);
    expect(out.turnCount).toBe(0);
    expect(out.checkpoints).toEqual([]);
  });

  test("turn-boundary preservation：截断到 turn 起点", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const out = await bridge.rewindSession("conv-rewind", 1);
    // turn0 结束于索引 4（tool 配对完整）。
    expect(out.messages.length).toBe(4);
    expect(out.messages[0]!.content[0]!.type).toBe("text");
    // 落盘可读回（同一文件）。
    const reloaded = await bridge.loadSessionFile("conv-rewind");
    expect(reloaded.messages.length).toBe(4);
  });

  test("bridge.rewindSession（1-turn 文件）keepTurns=0 → 真实截空落盘", async () => {
    // 集成路径：1-turn 会话回退到起点 → 盘上 messages=[]/turnCount=0/checkpoints=[]。
    await seedFile({
      ...sampleFile(),
      messages: [userMsg("q1"), assistantMsg([text("a1")])],
      turnCount: 1,
    });
    const bridge = makeBridge();
    const out = await bridge.rewindSession("conv-rewind", 0);
    expect(out.messages).toHaveLength(0);
    expect(out.turnCount).toBe(0);
    expect(out.checkpoints).toEqual([]);
    // 落盘可读回（同一切口读到截空文件）。
    const reloaded = await bridge.loadSessionFile("conv-rewind");
    expect(reloaded.messages).toHaveLength(0);
    expect(reloaded.turnCount).toBe(0);
  });

  test("tool-pair intact：回退后 tool_use 与 tool_result 保持配对", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const out = await bridge.rewindSession("conv-rewind", 1);
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
    const out = await bridge.rewindSession("conv-rewind", 2);
    expect(out.turnCount).toBe(2);
    expect(out.checkpoints).toEqual([
      {
        turnIndex: 1,
        messagesCount: 4,
        interruptedAt: "2026-08-11T00:00:00.000Z",
        interruptReason: "cancelled",
      },
    ]);
  });

  test("summary 从截断前缀重算", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const out = await bridge.rewindSession("conv-rewind", 1);
    expect(out.summary).toBe("q1");
  });

  test("keepTurns 越界（≥ available）→ no-op 等价（钳制）", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const out = await bridge.rewindSession("conv-rewind", 99);
    expect(out.messages.length).toBe(8);
    expect(out.turnCount).toBe(3);
  });

  test("keepTurns=0 → 空消息 + 空 checkpoints（回到会话起点）", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    const out = await bridge.rewindSession("conv-rewind", 0);
    expect(out.messages).toHaveLength(0);
    expect(out.turnCount).toBe(0);
    expect(out.checkpoints).toEqual([]);
  });

  test("空会话 + keepTurns>0 → no-op（不崩）", async () => {
    // 空会话 = messages:[] 且 turnCount=0；rewindFile 钳制到 target=available=0，
    // target === available 走 no-op 分支（mirror checkpoint.test.ts 用例）。
    await seedFile({ ...sampleFile(), messages: [], turnCount: 0 });
    const bridge = makeBridge();
    const out = await bridge.rewindSession("conv-rewind", 3);
    expect(out.messages).toHaveLength(0);
    expect(out.turnCount).toBe(0);
  });

  test("错误路径：load parse_failed → typed kind 透传（不新造）", async () => {
    const dir = resolveProjectSessionDir(baseDir, process.cwd());
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "conv-bad.json"), "{garbage", "utf8");
    const bridge = makeBridge();
    await expect(bridge.rewindSession("conv-bad", 1)).rejects.toMatchObject({
      kind: "parse_failed",
    });
  });

  test("错误路径：load not_found → typed kind 透传", async () => {
    const bridge = makeBridge();
    await expect(bridge.rewindSession("no-such-id", 1)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  test("错误路径：save write_failed → typed kind 透传（不新造）", async () => {
    await seedFile(sampleFile());
    // 用同名目录占住 `${id}.json.tmp` 路径 → save 的 writeFile 失败 → write_failed。
    const dir = resolveProjectSessionDir(baseDir, process.cwd());
    await mkdir(join(dir, "conv-rewind.json.tmp"), { recursive: true });
    const bridge = makeBridge();
    await expect(bridge.rewindSession("conv-rewind", 1)).rejects.toMatchObject({
      kind: "write_failed",
    });
  });

  test("rewind 后下一轮从新低基准续号（turnCount 契约，chat-session.ts:472）", async () => {
    await seedFile(sampleFile());
    const bridge = makeBridge();
    await bridge.rewindSession("conv-rewind", 1);
    const file = await bridge.loadSessionFile("conv-rewind");
    expect(file.turnCount).toBe(1);
  });
});

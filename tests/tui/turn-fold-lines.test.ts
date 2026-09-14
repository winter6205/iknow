/**
 * tests/tui/turn-fold-lines.test.ts
 *
 * #986 + plans/issue-986-chatview-split.md：turn/fold 派生纯函数模块
 * （src/tui/turn-fold-lines.ts）5 类边界：empty / negative / overflow /
 * concurrent / exception。
 *
 * 同 `tests/tui/turn-activity.test.ts` 体例（describe / expect / test，
 * bun:test），数据构造助手与 turn-activity.test.ts 对齐（user /
 * assistantTools / assistantText / toolResult）。
 */
import { describe, expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import { orderedTurnActivitySegments } from "../../src/tui/turn-activity.js";
import {
  buildFoldLinesBySegmentIndex,
  findLastToolSegmentIndex,
  firstPartThinkingBlocks,
  makeThinkingMsAtVisibleFromSource,
  pickMessageSegments,
  renderInContentOrder,
  segmentActivityBlocks,
  shouldShowLiveThinkingPanel,
  type ThinkingMsAtVisible,
} from "../../src/tui/turn-fold-lines.js";

// ── 数据构造（与 tests/tui/turn-activity.test.ts 对齐）─────────────

function user(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolResult(id: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  };
}

function assistantTools(
  names: ReadonlyArray<string>,
  text?: string
): AnthropicNativeMessage {
  const content: AnthropicNativeMessage["content"] = names.map((name, i) => ({
    type: "tool_use" as const,
    id: `tu-${name}-${String(i)}`,
    name,
    input: {},
  }));
  if (text !== undefined) content.push({ type: "text", text });
  return { role: "assistant", content };
}

function assistantText(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function segmentsOf(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  visibleMsgs = messages
): ReturnType<typeof orderedTurnActivitySegments> {
  return orderedTurnActivitySegments(visibleMsgs, 0);
}

const emptyMsAt: ThinkingMsAtVisible = () => 0;
const passThroughMsAt: ThinkingMsAtVisible = (i) => i * 1000;

// ── buildFoldLinesBySegmentIndex（empty） ───────────────────────────

describe("buildFoldLinesBySegmentIndex（empty）", () => {
  test("空 messages / 空 activitySegments → 全空 + fallbackApplied false", () => {
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: [],
      thinkingMsAtVisible: emptyMsAt,
      running: false,
      lastToolSegmentIndex: -1,
      liveCompletedCounts: [],
    });
    expect(result.foldLinesBySegmentIndex.size).toBe(0);
    expect(result.drawnThinkingForMessageIndex.size).toBe(0);
    expect(result.shownThinkingMsValues.size).toBe(0);
    expect(result.fallbackApplied).toBe(false);
  });

  test("只有 user 消息（无 assistant 活动）→ 空 fold", () => {
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: segmentsOf([user("hi")]),
      thinkingMsAtVisible: emptyMsAt,
      running: true,
      lastToolSegmentIndex: -1,
      liveCompletedCounts: [],
    });
    expect(result.foldLinesBySegmentIndex.size).toBe(0);
    expect(result.fallbackApplied).toBe(false);
  });
});

// ── buildFoldLinesBySegmentIndex（negative / 缺席 thinkingMs）────

describe("buildFoldLinesBySegmentIndex（negative）", () => {
  test("thinkingMs 缺席（undefined）→ 折叠行只有计数段、无时长段", () => {
    const msgs = [user("q"), assistantTools(["read_file", "read_file"])];
    const segs = segmentsOf(msgs);
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: segs,
      thinkingMsAtVisible: emptyMsAt, // 无 ms
      running: false,
      lastToolSegmentIndex: findLastToolSegmentIndex(segs),
      liveCompletedCounts: [],
    });
    expect(result.foldLinesBySegmentIndex.size).toBe(1);
    const lines = result.foldLinesBySegmentIndex.get(0) ?? [];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toBe("read_file × 2");
    // 无秒数 → drawnThinkingForMessageIndex 不含此 message
    expect(result.drawnThinkingForMessageIndex.has(1)).toBe(false);
    expect(result.shownThinkingMsValues.size).toBe(0);
  });

  test("索引越界（thinkingMs 长度不够）→ 安全兜底 0，不抛", () => {
    const msgs = [user("q"), assistantTools(["read_file"])];
    const segs = segmentsOf(msgs);
    // passThroughMsAt(99) 会读 sourceIndex 99（thinkingMs[99]）→ 越界。
    const thinkingMsAt: ThinkingMsAtVisible = (i) => {
      // 只 anchor 在 messageIndex 1，强制给一个越界查询：thinkingMs.length=1
      const safeArr = [1234];
      return safeArr[i] ?? 0;
    };
    expect(() =>
      buildFoldLinesBySegmentIndex({
        activitySegments: segs,
        thinkingMsAtVisible: thinkingMsAt,
        running: false,
        lastToolSegmentIndex: findLastToolSegmentIndex(segs),
        liveCompletedCounts: [],
      })
    ).not.toThrow();
  });

  test("负数 / NaN / 非有限 thinkingMs → 按 0 计入，不入 shownThinkingMsValues", () => {
    const msgs = [user("q"), assistantTools(["read_file"])];
    const segs = segmentsOf(msgs);
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: segs,
      thinkingMsAtVisible: () => -500, // 负数
      running: false,
      lastToolSegmentIndex: findLastToolSegmentIndex(segs),
      liveCompletedCounts: [],
    });
    expect(result.shownThinkingMsValues.size).toBe(0);
    expect(result.drawnThinkingForMessageIndex.has(1)).toBe(false);
    // 折叠行只画计数（无秒数）
    expect(result.foldLinesBySegmentIndex.get(0)?.[0]).toBe("read_file × 1");
  });
});

// ── buildFoldLinesBySegmentIndex（overflow） ──────────────────────

describe("buildFoldLinesBySegmentIndex（overflow）", () => {
  test("40 个工具名 + 200 个 bash：折叠行包含计数、不抛", () => {
    const names = Array.from({ length: 40 }, (_, i) => `tool_${String(i)}`);
    const extra = Array.from({ length: 200 }, () => "bash");
    const msgs = [user("q"), assistantTools([...names, ...extra])];
    const segs = segmentsOf(msgs);
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: segs,
      thinkingMsAtVisible: emptyMsAt,
      running: false,
      lastToolSegmentIndex: findLastToolSegmentIndex(segs),
      liveCompletedCounts: [],
    });
    expect(result.foldLinesBySegmentIndex.size).toBe(1);
    const lines = result.foldLinesBySegmentIndex.get(0) ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBeDefined();
    expect(lines[0]!.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("bash × 200");
    expect(lines[0]).toContain("tool_0 × 1");
  });

  test("同一 assistant 拆出多簇（tool → text → tool）：第一簇 12s、后续簇按 0", () => {
    const msgs: AnthropicNativeMessage[] = [
      user("q"),
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "先想",
            signature: "s",
          },
          { type: "tool_use", id: "tu-1", name: "read_file", input: {} },
          { type: "text", text: "中间总结" },
          { type: "tool_use", id: "tu-2", name: "read_file", input: {} },
        ],
      },
      toolResult("tu-1"),
      toolResult("tu-2"),
    ];
    const segs = segmentsOf(msgs);
    const lastToolIndex = findLastToolSegmentIndex(segs);
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: segs,
      // anchor 1：12s；第二簇（anchor 同 1）去重后按 0 计
      thinkingMsAtVisible: () => 12_000,
      running: false,
      lastToolSegmentIndex: lastToolIndex,
      liveCompletedCounts: [],
    });
    expect(result.foldLinesBySegmentIndex.size).toBeGreaterThanOrEqual(2);
    const firstLine = result.foldLinesBySegmentIndex.get(0)?.[0];
    const secondLine = result.foldLinesBySegmentIndex.get(lastToolIndex)?.[0];
    expect(firstLine).toContain("Thought for 12s");
    expect(firstLine).toContain("read_file × 1");
    // 第二簇同 anchor → 去重后只剩计数行
    expect(secondLine).toBe("read_file × 1");
    // drawnThinkingForMessageIndex 只记一次
    expect(result.drawnThinkingForMessageIndex.size).toBe(1);
  });

  test("overflow anchorMsgs 越界 + length 0 → drawnThinkingForMessageIndex 空", () => {
    const msgs = [user("q"), assistantTools(["read_file", "grep"])];
    const segs = segmentsOf(msgs);
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: segs,
      thinkingMsAtVisible: () => 30_000,
      running: false,
      lastToolSegmentIndex: findLastToolSegmentIndex(segs),
      liveCompletedCounts: [],
    });
    // anchor messageIndex 1 在 visible 索引内，正常计秒
    expect(result.foldLinesBySegmentIndex.get(0)?.[0]).toContain(
      "Thought for 30s"
    );
    expect(result.drawnThinkingForMessageIndex.has(1)).toBe(true);
    expect(result.shownThinkingMsValues.has(30_000)).toBe(true);
  });
});

// ── buildFoldLinesBySegmentIndex（concurrent：多次独立调用无共享） ──

describe("buildFoldLinesBySegmentIndex（concurrent：多次独立调用无共享状态）", () => {
  test("两次独立调用返回独立 Map/Set（无 mutable 共享）", () => {
    const msgs = [user("q"), assistantTools(["read_file"])];
    const segs = segmentsOf(msgs);
    const base = {
      activitySegments: segs,
      thinkingMsAtVisible: () => 5_000 as number,
      running: false,
      lastToolSegmentIndex: findLastToolSegmentIndex(segs),
      liveCompletedCounts: [],
    };
    const a = buildFoldLinesBySegmentIndex(base);
    const b = buildFoldLinesBySegmentIndex(base);
    // 各自有完整 fold 行
    expect(a.foldLinesBySegmentIndex.size).toBe(1);
    expect(b.foldLinesBySegmentIndex.size).toBe(1);
    // 改 a 不影响 b（不同 Map 实例）
    a.foldLinesBySegmentIndex.set(99, ["INJECTED"]);
    expect(b.foldLinesBySegmentIndex.has(99)).toBe(false);
    // 改 a.drawnThinkingForMessageIndex 不影响 b
    a.drawnThinkingForMessageIndex.add(123);
    expect(b.drawnThinkingForMessageIndex.has(123)).toBe(false);
  });

  test("同 inputs 多次调用返回等价 fold 行", () => {
    const msgs = [user("q"), assistantTools(["read_file", "grep"])];
    const segs = segmentsOf(msgs);
    const base = {
      activitySegments: segs,
      thinkingMsAtVisible: () => 7_500 as number,
      running: false,
      lastToolSegmentIndex: findLastToolSegmentIndex(segs),
      liveCompletedCounts: [],
    };
    const a = buildFoldLinesBySegmentIndex(base);
    const b = buildFoldLinesBySegmentIndex(base);
    expect([...a.foldLinesBySegmentIndex]).toEqual([
      ...b.foldLinesBySegmentIndex,
    ]);
    expect([...a.shownThinkingMsValues]).toEqual([...b.shownThinkingMsValues]);
  });
});

// ── buildFoldLinesBySegmentIndex（exception / 异常形态）────────────

describe("buildFoldLinesBySegmentIndex（exception）", () => {
  test("thinkingMsAtVisible 抛错 → 向上传播，不静默吞掉（fail-closed）", () => {
    // 直接构造一个非空 segments（合法的 tools 段，使函数进入 pushFoldLineForSegment
    // 体并真实调用 thinkingMsAtVisible —— 即真正的异常源，不是 dead malformed）。
    const segs = [
      {
        kind: "tools" as const,
        messageIndex: 0,
        contentBlockIndex: 0,
        entries: [{ name: "read_file", count: 1 }],
      },
    ];
    const throwing: ThinkingMsAtVisible = () => {
      throw new Error("downstream failure");
    };
    expect(() =>
      buildFoldLinesBySegmentIndex({
        activitySegments: segs,
        thinkingMsAtVisible: throwing,
        running: false,
        lastToolSegmentIndex: 0,
        liveCompletedCounts: [],
      })
    ).toThrow();
  });

  test("orderedTurnActivitySegments 兜底：非法 assistant content getter 抛错 → 不抛错（segmentsOf 兜底）", () => {
    // 兜底点在 orderedTurnActivitySegments（turn-activity.ts 内部 try/catch），
    // 非法形态不应污染 buildFoldLinesBySegmentIndex 的入参；这是 fail-closed 的
    // 上一层保护，本测试独立验证。
    const malformed = {
      role: "assistant",
      get content(): never {
        throw new Error("malformed content");
      },
    } as unknown as AnthropicNativeMessage;
    expect(() => segmentsOf([malformed])).not.toThrow();
  });

  test("liveCompletedCounts 触发 fallback：把折叠行挂到 last text 段", () => {
    const msgs = [user("q"), assistantText("先回答一下")];
    const segs = segmentsOf(msgs);
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: segs,
      thinkingMsAtVisible: () => 8_000,
      running: true, // running 不压 fallback（per-segment 闸门解耦）
      lastToolSegmentIndex: -1,
      liveCompletedCounts: [{ name: "read_file", count: 2 }],
    });
    expect(result.fallbackApplied).toBe(true);
    // fallback 挂在 text 段（segmentIndex 0）
    expect(result.foldLinesBySegmentIndex.size).toBe(1);
    const line = result.foldLinesBySegmentIndex.get(0)?.[0];
    expect(line).toContain("read_file × 2");
  });

  test("无 text 段 + liveCompletedCounts → fallback 不命中（返回 false）", () => {
    // 无 assistant 消息 → activitySegments 空
    const msgs = [user("q")];
    const segs = segmentsOf(msgs);
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: segs,
      thinkingMsAtVisible: emptyMsAt,
      running: true,
      lastToolSegmentIndex: -1,
      liveCompletedCounts: [{ name: "read_file", count: 1 }],
    });
    expect(result.fallbackApplied).toBe(false);
    expect(result.foldLinesBySegmentIndex.size).toBe(0);
  });

  test("fallback 闸门拒绝（counts==0）→ 不写行", () => {
    const msgs = [user("q"), assistantText("hello")];
    const segs = segmentsOf(msgs);
    const result = buildFoldLinesBySegmentIndex({
      activitySegments: segs,
      thinkingMsAtVisible: () => 0, // 无秒数
      running: false,
      lastToolSegmentIndex: -1,
      liveCompletedCounts: [{ name: "read_file", count: 0 }], // 0 件 → 闸门拒
    });
    expect(result.fallbackApplied).toBe(false);
    expect(result.foldLinesBySegmentIndex.size).toBe(0);
  });
});

// ── shouldShowLiveThinkingPanel（open unit 让位判定）───────────────

describe("shouldShowLiveThinkingPanel（boundary：无草稿 / 非 running）", () => {
  test("empty：thinkingDraft 空 → 无 panel（无草稿不画）", () => {
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "",
        toolRunning: false,
      })
    ).toBe(false);
  });

  test("negative：非 running（idle）→ panel 消失（流式面板只在 turn 进行中）", () => {
    expect(
      shouldShowLiveThinkingPanel({
        running: false,
        thinkingDraft: "思考中",
        toolRunning: false,
      })
    ).toBe(false);
  });

  test("overflow：长草稿仍 true（判定与文本长度无关）", () => {
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "x".repeat(10_000),
        toolRunning: false,
      })
    ).toBe(true);
  });

  test("concurrent：已画 unit fold 不是关闭信号（有折叠 + 有草稿 + 无工具 running → 仍 true）", () => {
    // docs/CONTEXT.md open unit _Avoid_：「已画折叠不是关 thinking panel 的
    // 信号」。本判定不看 foldLinesBySegmentIndex —— 只由草稿非空 + 无工具
    // running 决定。
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "第二段思考流式进行中",
        toolRunning: false,
      })
    ).toBe(true);
  });

  test("exception：工具 running → panel 让位（CONTEXT live activity group）", () => {
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "思考中",
        toolRunning: true,
      })
    ).toBe(false);
  });
});

// ── pickMessageSegments / renderInContentOrder ──────────────────────

describe("pickMessageSegments / renderInContentOrder", () => {
  const segs = orderedTurnActivitySegments(
    [
      user("q"),
      assistantText("text-1"),
      assistantTools(["bash"]),
      toolResult("tu-bash-0"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu-2", name: "bash", input: {} },
          { type: "text", text: "text-2" },
          { type: "tool_use", id: "tu-3", name: "bash", input: {} },
        ],
      },
      toolResult("tu-2"),
      toolResult("tu-3"),
    ],
    0
  );

  test("pickMessageSegments 按 messageIndex 筛子集", () => {
    const picked = pickMessageSegments(segs, 4);
    expect(picked).toHaveLength(3);
    expect(picked.every((p) => p.segment.messageIndex === 4)).toBe(true);
  });

  test("renderInContentOrder：多段 + 任一段有 fold 行 → true", () => {
    const foldMap = new Map<number, ReadonlyArray<string>>([[2, ["bash × 2"]]]);
    expect(renderInContentOrder(pickMessageSegments(segs, 4), foldMap)).toBe(
      true
    );
  });

  test("renderInContentOrder：多段 + 无 fold 行 → false", () => {
    const foldMap = new Map<number, ReadonlyArray<string>>();
    expect(renderInContentOrder(pickMessageSegments(segs, 4), foldMap)).toBe(
      false
    );
  });

  test("renderInContentOrder：单段 → 永远 false", () => {
    const foldMap = new Map<number, ReadonlyArray<string>>([[0, ["x"]]]);
    const picked = pickMessageSegments(segs, 1);
    expect(picked).toHaveLength(1);
    expect(renderInContentOrder(picked, foldMap)).toBe(false);
  });
});

// ── findLastToolSegmentIndex ─────────────────

describe("findLastToolSegmentIndex", () => {
  test("空 segments → -1", () => {
    expect(findLastToolSegmentIndex([])).toBe(-1);
  });

  test("倒序：tools 段在前", () => {
    const segs = orderedTurnActivitySegments(
      [
        user("q"),
        assistantTools(["read_file"]),
        toolResult("tu-read_file-0"),
        assistantText("总结"),
      ],
      0
    );
    expect(findLastToolSegmentIndex(segs)).toBe(0);
  });
});

// ── makeThinkingMsAtVisibleFromSource ──────────────────────────────

describe("makeThinkingMsAtVisibleFromSource", () => {
  test("thinkingMs undefined → 全 0", () => {
    const fn = makeThinkingMsAtVisibleFromSource(undefined, [0, 1, 2]);
    expect(fn(0)).toBe(0);
    expect(fn(5)).toBe(0);
  });

  test("thinkingMs 含 null / 越界 → 0（与 sumThinkingMsInRange 兜底一致）", () => {
    const fn = makeThinkingMsAtVisibleFromSource([null, 1500], [0, 1]);
    expect(fn(0)).toBe(0);
    expect(fn(1)).toBe(1500);
    expect(fn(99)).toBe(0); // sourceIndexOfVisible 缺席 → fallback 0
  });

  test("sourceIndexOfVisible 缺席（undefined）→ 视作 visibleIndex 兜底", () => {
    const fn = makeThinkingMsAtVisibleFromSource([1000, 2000, 3000], [0]);
    expect(fn(0)).toBe(1000);
    // visibleIndex=5 越界 sourceIndexOfVisible（length=1），fallback 到
    // visibleIndex 5 → thinkingMs[5] 越界 → 0（与 sumThinkingMsInRange 同兜底）。
    expect(fn(5)).toBe(0);
  });
});

// ── segmentActivityBlocks / firstPartThinkingBlocks ────────────────

describe("segmentActivityBlocks / firstPartThinkingBlocks", () => {
  test("text segment → 单段 text block", () => {
    const message = assistantText("hello");
    const seg = {
      kind: "text" as const,
      messageIndex: 0,
      contentBlockIndex: 0,
    };
    expect(
      segmentActivityBlocks(message, seg, 0, message.content.length)
    ).toEqual(message.content);
  });

  test("tools segment → blockIndex..endIndex 的 tool_use 过滤", () => {
    const message: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "before" },
        { type: "tool_use", id: "tu-1", name: "bash", input: {} },
        { type: "text", text: "between" },
        { type: "tool_use", id: "tu-2", name: "grep", input: {} },
        { type: "tool_use", id: "tu-3", name: "read_file", input: {} },
      ],
    };
    const seg = {
      kind: "tools" as const,
      messageIndex: 0,
      contentBlockIndex: 1,
      entries: [],
    };
    const blocks = segmentActivityBlocks(message, seg, 1, 4);
    // filter tool_use：去掉中间的 text 块，只剩 tool_use × 2
    expect(blocks.map((b) => b.type)).toEqual(["tool_use", "tool_use"]);
  });

  test("firstPartThinkingBlocks：thinking + redacted_thinking", () => {
    const message: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x", signature: "s" },
        { type: "redacted_thinking", data: "y" },
        { type: "text", text: "body" },
        { type: "tool_use", id: "tu-1", name: "bash", input: {} },
      ],
    };
    const blocks = firstPartThinkingBlocks(message);
    expect(blocks.map((b) => b.type)).toEqual([
      "thinking",
      "redacted_thinking",
    ]);
  });
});

// ── segmentActivityBlocks 越界保护 ────────────────────────────────

describe("segmentActivityBlocks（exception / 越界）", () => {
  test("text segment + blockIndex 越界 → 返回空数组（不是 undefined）", () => {
    const message = assistantText("only one block");
    const seg = {
      kind: "text" as const,
      messageIndex: 0,
      contentBlockIndex: 99, // 越界
    };
    const blocks = segmentActivityBlocks(message, seg, 99, 99);
    expect(blocks).toEqual([]);
  });
});

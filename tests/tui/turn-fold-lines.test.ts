/**
 * tests/tui/turn-fold-lines.test.ts
 *
 * The old unit-fold derivations (`buildFoldLinesBySegmentIndex` etc.) were
 * retired with the activity-block single-tense change (specs/tui-activity-block.md);
 * their exhaustive cases live in `archive/tests/tui/turn-fold-lines.test.ts`.
 * This file keeps coverage for the **still-live exports** only — they have
 * production callers (`message-row.tsx` / `chat-view.tsx`) and must not lose
 * tests along with the old shape.
 *
 * Same style as `tests/tui/turn-activity.test.ts` (bun:test, shared data helpers).
 */
import { describe, expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import { orderedTurnActivitySegments } from "../../src/tui/turn-activity.js";
import {
  firstPartThinkingBlocks,
  makeThinkingMsAtVisibleFromSource,
  pickMessageSegments,
  renderInContentOrder,
  segmentActivityBlocks,
  shouldShowLiveThinkingPanel,
} from "../../src/tui/turn-fold-lines.js";

// ── Data helpers (aligned with tests/tui/turn-activity.test.ts) ────────────

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
  const content: Array<AnthropicNativeMessage["content"][number]> = names.map(
    (name, i) => ({
      type: "tool_use" as const,
      id: `tu-${name}-${String(i)}`,
      name,
      input: {},
    })
  );
  if (text !== undefined) content.push({ type: "text", text });
  return { role: "assistant", content };
}

function assistantText(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

// ── Coverage for still-live exports ───────────────────────────────

describe("shouldShowLiveThinkingPanel（boundary：无草稿 / 非 running）", () => {
  test("empty：thinkingDraft 空 → 无 panel（无草稿不画）", () => {
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "",
      })
    ).toBe(false);
  });

  test("negative：非 running（idle）→ panel 消失（流式面板只在 turn 进行中）", () => {
    expect(
      shouldShowLiveThinkingPanel({
        running: false,
        thinkingDraft: "思考中",
      })
    ).toBe(false);
  });

  test("overflow：长草稿仍 true（判定与文本长度无关）", () => {
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "x".repeat(10_000),
      })
    ).toBe(true);
  });

  test("concurrent：已画 unit fold 不是关闭信号（有折叠 + 有草稿 → 仍 true）", () => {
    // docs/CONTEXT.md "open unit" _Avoid_: a drawn fold is not a signal to
    // close the thinking panel.
    // The toolRunning gate was later retired — this check looks only at
    // running + draft length, independent of tool running state.
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "第二段思考流式进行中",
      })
    ).toBe(true);
  });

  test("locked-sentence-7：tool running 不再让位思考", () => {
    // The "any tool running closes thinking" gate was deleted. Thinking-slot
    // sovereignty = the burst is not yet closed (draft non-empty); tool running
    // no longer affects this check. The production path goes through the
    // `liveThinking` field (`draftMasked.length > 0`); this function only
    // carries the pure-function semantics documentation.
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "思考中",
      })
    ).toBe(true);
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

// ── makeThinkingMsAtVisibleFromSource ─────────────────

describe("makeThinkingMsAtVisibleFromSource", () => {
  test("thinkingMs undefined → 全 0", () => {
    const fn = makeThinkingMsAtVisibleFromSource(undefined, [0, 1, 2]);
    expect(fn(0)).toBe(0);
    expect(fn(5)).toBe(0);
  });

  test("thinkingMs 含 null / 越界 → 0（越界 / 非法值兜底一致）", () => {
    const fn = makeThinkingMsAtVisibleFromSource([null, 1500], [0, 1]);
    expect(fn(0)).toBe(0);
    expect(fn(1)).toBe(1500);
    expect(fn(99)).toBe(0); // no mapping for the index → fallback 0
  });

  test("sourceIndexOfVisible 缺席（undefined）→ 视作 visibleIndex 兜底", () => {
    const fn = makeThinkingMsAtVisibleFromSource([1000, 2000, 3000], [0]);
    expect(fn(0)).toBe(1000);
    // visibleIndex=5 is out of range for sourceIndexOfVisible (length=1), so it
    // falls back to visibleIndex 5 → thinkingMs[5] out of range → 0 (same
    // fallback as sumThinkingMsInRange).
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
    // keep only tool_use blocks in range, dropping the interleaved text block
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

// ── segmentActivityBlocks out-of-range guards ─────────────────────

describe("segmentActivityBlocks（exception / 越界）", () => {
  test("text segment + blockIndex 越界 → 返回空数组（不是 undefined）", () => {
    const message = assistantText("only one block");
    const seg = {
      kind: "text" as const,
      messageIndex: 0,
      contentBlockIndex: 99, // out of range
    };
    const blocks = segmentActivityBlocks(message, seg, 99, 99);
    expect(blocks).toEqual([]);
  });
});

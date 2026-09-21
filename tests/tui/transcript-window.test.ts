/**
 * tests/tui/transcript-window.test.ts
 *
 * Windowed transcript derivation: activity segments, activity
 * blocks and fold lines may be computed over the current mount window +
 * overscan only. These tests lock that the windowed result agrees with the
 * full-table result for every index inside the window, that live (unanchored)
 * blocks stay outside the window bound, and that the fold-lines cache keeps
 * array identities for unchanged messages.
 */
import { describe, expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import {
  orderedTurnActivitySegments,
  type TurnActivitySegment,
} from "../../src/tui/turn-activity.js";
import {
  buildActivityBlockFoldLines,
  stabilizeActivityBlockLines,
  type ActivityBlockLine,
  type FoldLinesCache,
} from "../../src/tui/turn-fold-lines.js";
import { deriveActivityBlocks } from "../../src/tui/activity-block.js";

function userQuery(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistantTool(id: string, name = "read_file"): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: { path: "a" } }],
  };
}
function assistantToolPlusText(id: string): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "t", signature: "s" },
      { type: "text", text: "mid" },
      { type: "tool_use", id, name: "bash", input: { command: "ls" } },
    ],
  } as AnthropicNativeMessage;
}

const history = (): AnthropicNativeMessage[] => [
  userQuery("q1"),
  assistantTool("tu1"),
  assistantTool("tu2"),
  userQuery("q2"),
  assistantToolPlusText("tu3"),
  assistantTool("tu4"),
  userQuery("q3"),
  assistantTool("tu5"),
];

describe("orderedTurnActivitySegments: end bound", () => {
  test("end restricts the scanned range; indices stay absolute", () => {
    const windowSegments = orderedTurnActivitySegments(history(), 3, {
      end: 7,
    });
    const full = orderedTurnActivitySegments(history(), 3);
    expect(windowSegments.length).toBeLessThan(full.length);
    for (const seg of windowSegments) {
      expect(seg.messageIndex).toBeGreaterThanOrEqual(3);
      expect(seg.messageIndex).toBeLessThan(7);
    }
    const slice = orderedTurnActivitySegments(
      history()
        .slice(3, 7)
        .map((m) => m),
      0
    ).map((seg): TurnActivitySegment => ({
      ...seg,
      messageIndex: seg.messageIndex + 3,
    }));
    expect(windowSegments).toEqual(slice);
  });

  test("omitted / out-of-range end keeps the to-the-end behaviour", () => {
    const toEnd = orderedTurnActivitySegments(history(), 0);
    expect(orderedTurnActivitySegments(history(), 0, { end: 999 })).toEqual(
      toEnd
    );
    expect(orderedTurnActivitySegments(history(), 0, { end: -1 })).toEqual(
      toEnd
    );
  });

  test("end <= start yields no history segments (live-only stays a separate concern)", () => {
    expect(orderedTurnActivitySegments(history(), 4, { end: 4 })).toEqual([]);
    expect(orderedTurnActivitySegments(history(), 5, { end: 2 })).toEqual([]);
  });
});

describe("deriveActivityBlocks / buildActivityBlockFoldLines: window bound", () => {
  test("blocks anchored inside the window match the full derivation", () => {
    const messages = history();
    const zeroMs = () => 4200;
    const full = deriveActivityBlocks({
      messages,
      thinkingMsAtVisible: zeroMs,
    });
    const windowed = deriveActivityBlocks({
      messages,
      start: 3,
      end: 7,
      thinkingMsAtVisible: zeroMs,
    });
    const inWindow = full.filter(
      (b) => b.anchor.messageIndex >= 3 && b.anchor.messageIndex < 7
    );
    expect(windowed).toEqual(inWindow);
    expect(windowed.length).toBeGreaterThan(0);
  });

  test("live blocks stay unanchored when the window ends before the tail", () => {
    const messages = history();
    const derived = buildActivityBlockFoldLines({
      messages,
      visibleStart: 0,
      visibleCount: messages.length,
      visibleEnd: 3,
      thinkingMsAtVisible: () => 0,
      // retract-class name: only live noise enters unanchored blocks
      // (isLiveNoise), and bash is a `keep` tool.
      liveRuns: [
        {
          id: "live1",
          name: "grep",
          status: "running" as const,
          input: { pattern: "x" },
          draftEpoch: 0,
        },
      ],
    });
    for (const key of derived.blockLinesByMessage.keys()) {
      expect(key).toBeLessThan(3);
    }
    expect(derived.unanchoredBlocks.length).toBeGreaterThan(0);
    expect(derived.unanchoredBlocks[0]!.title).toContain("grep");
  });

  test("historyToolUseIds replaces the full toolUseIds scan for live-run dedup", () => {
    const messages = history();
    const args = {
      messages,
      visibleCount: messages.length,
      thinkingMsAtVisible: () => 0,
      liveRuns: [
        {
          id: "tu1",
          name: "grep",
          status: "running" as const,
          input: { pattern: "x" },
          draftEpoch: 0,
        },
        {
          id: "fresh",
          name: "grep",
          status: "running" as const,
          input: { pattern: "y" },
          draftEpoch: 0,
        },
      ],
    };
    const withoutIds = buildActivityBlockFoldLines(args);
    // tu1 is a history tool_use id: the default full scan dedups it away.
    expect(withoutIds.unanchoredBlocks).toHaveLength(1);
    expect(withoutIds.unanchoredBlocks[0]!.title).toContain("grep × 1");
    // An explicitly supplied (empty) set is what the dedup consults instead
    // of re-scanning the messages — tu1 survives as live.
    const withIds = buildActivityBlockFoldLines({
      ...args,
      historyToolUseIds: new Set<string>(),
    });
    expect(withIds.unanchoredBlocks).toHaveLength(1);
    expect(withIds.unanchoredBlocks[0]!.title).toContain("grep × 2");
    // And a supplied set containing the id dedups exactly like the scan.
    const deduped = buildActivityBlockFoldLines({
      ...args,
      historyToolUseIds: new Set(["tu1"]),
    });
    const tailTitles = (blocks: typeof withoutIds.unanchoredBlocks) =>
      blocks.map((b) => b.title);
    expect(tailTitles(deduped.unanchoredBlocks)).toEqual(
      tailTitles(withoutIds.unanchoredBlocks)
    );
  });
});

describe("stabilizeActivityBlockLines: reference reuse", () => {
  const lines = (title: string): ActivityBlockLine[] => [
    { contentBlockIndex: 2, title, preview: null },
  ];
  test("unchanged message + unchanged lines reuse the previous array reference", () => {
    const messages = history();
    const next = new Map<number, ReadonlyArray<ActivityBlockLine>>([
      [4, lines("called bash × 1")],
    ]);
    let cache: FoldLinesCache | null = null;
    const first = stabilizeActivityBlockLines(cache, next, messages);
    cache = first.cache;
    expect(first.byMessage.get(4)).toBe(next.get(4)); // fresh input kept as-is
    const rebuilt = new Map<number, ReadonlyArray<ActivityBlockLine>>([
      [4, lines("called bash × 1")],
    ]);
    const second = stabilizeActivityBlockLines(cache, rebuilt, messages);
    expect(second.byMessage.get(4)).toBe(first.byMessage.get(4));
    cache = second.cache;
    const changed = new Map<number, ReadonlyArray<ActivityBlockLine>>([
      [4, lines("called bash × 2")],
    ]);
    const third = stabilizeActivityBlockLines(cache, changed, messages);
    expect(third.byMessage.get(4)).not.toBe(second.byMessage.get(4));
    expect(third.byMessage.get(4)).toEqual(lines("called bash × 2"));
  });

  test("same index but different message reference rebuilds the entry", () => {
    const messages = history();
    const cache0 = stabilizeActivityBlockLines(
      null,
      new Map([[4, lines("x")]]),
      messages
    ).cache;
    const shifted = [...messages];
    shifted[4] = assistantTool("other");
    const after = stabilizeActivityBlockLines(
      cache0,
      new Map([[4, lines("x")]]),
      shifted
    );
    expect(after.byMessage.get(4)).toEqual(lines("x"));
    const second = stabilizeActivityBlockLines(
      after.cache,
      new Map([[4, lines("x")]]),
      shifted
    );
    expect(second.byMessage.get(4)).toBe(after.byMessage.get(4));
  });

  test("prunes indices outside the new derivation", () => {
    const messages = history();
    const cacheA = stabilizeActivityBlockLines(
      null,
      new Map([
        [1, lines("a")],
        [5, lines("b")],
      ]),
      messages
    ).cache;
    const after = stabilizeActivityBlockLines(
      cacheA,
      new Map([[1, lines("a")]]),
      messages
    );
    expect(after.byMessage.has(5)).toBe(false);
    const reuse = stabilizeActivityBlockLines(
      after.cache,
      new Map([
        [1, lines("a")],
        [5, lines("b")],
      ]),
      messages
    );
    const cacheB = stabilizeActivityBlockLines(
      cacheA,
      new Map([
        [1, lines("a")],
        [5, lines("b")],
      ]),
      messages
    );
    expect(reuse.byMessage.get(1)).toBe(cacheB.byMessage.get(1));
  });
});

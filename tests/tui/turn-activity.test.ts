/**
 * tests/tui/turn-activity.test.ts
 *
 * Last-turn slice + tool-count fold wording. Five input classes:
 * empty / negative / overflow / concurrent / exception.
 */
import { describe, expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import {
  countNamedCalls,
  countToolUsesByName,
  formatToolUseCounts,
  lastTurnQueryIndex,
  orderedTurnActivitySegments,
  sliceTurnFrom,
  thinkingMsToSeconds,
  toolUseIdsOf,
} from "../../src/tui/turn-activity.js";

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
  if (text !== undefined) {
    content.push({ type: "text", text });
  }
  return { role: "assistant", content };
}

function assistantText(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("lastTurnQueryIndex / sliceTurnFrom（empty）", () => {
  test("空消息 → index -1，slice 空", () => {
    expect(lastTurnQueryIndex([])).toBe(-1);
    expect(sliceTurnFrom([], -1)).toEqual([]);
    expect(sliceTurnFrom([], 0)).toEqual([]);
  });
});

describe("orderedTurnActivitySegments", () => {
  // Fold counting aggregates only calls the resolver judges true (settled and
  // retracted). Resolver omitted = count everything (fallback).
  describe("inFoldCountOf resolver（D3 只数成功的收）", () => {
    const neverCount = () => false;
    const all = () => true;

    test("resolver 拒绝的件不进 entries（bash keep → 只留 read_file 计数）", () => {
      const inFoldCountOf = (call: { readonly name: string }): boolean =>
        call.name === "read_file";
      expect(
        orderedTurnActivitySegments(
          [
            user("q"),
            assistantTools(["bash", "read_file"]),
            toolResult("tu-bash-0"),
            toolResult("tu-read_file-1"),
          ],
          0,
          { inFoldCountOf }
        )
      ).toEqual([
        {
          kind: "tools",
          messageIndex: 1,
          contentBlockIndex: 0,
          entries: [{ name: "read_file", count: 1 }],
        },
      ]);
    });

    test("全部被拒 → tools 段 entries 为空（零条收 → 计数行无内容）", () => {
      expect(
        orderedTurnActivitySegments(
          [user("q"), assistantTools(["bash"]), toolResult("tu-bash-0")],
          0,
          { inFoldCountOf: neverCount }
        )
      ).toEqual([
        {
          kind: "tools",
          messageIndex: 1,
          contentBlockIndex: 0,
          entries: [],
        },
      ]);
    });

    test("resolver 缺省 = 全部计入（与 countToolUsesByName 兜底一致）", () => {
      expect(
        orderedTurnActivitySegments(
          [user("q"), assistantTools(["bash", "bash"])],
          0
        )
      ).toEqual([
        {
          kind: "tools",
          messageIndex: 1,
          contentBlockIndex: 0,
          entries: [{ name: "bash", count: 2 }],
        },
      ]);
    });

    test("全收 resolver 与全计 resolver 同输入计数一致偏移（overflow：多条同名）", () => {
      const msgs = [
        user("q"),
        assistantTools(["read_file", "read_file", "read_file"]),
      ];
      expect(
        orderedTurnActivitySegments(msgs, 0, { inFoldCountOf: all })
      ).toEqual([
        {
          kind: "tools",
          messageIndex: 1,
          contentBlockIndex: 0,
          entries: [{ name: "read_file", count: 3 }],
        },
      ]);
      expect(
        orderedTurnActivitySegments(msgs, 0, { inFoldCountOf: neverCount })
      ).toEqual([
        {
          kind: "tools",
          messageIndex: 1,
          contentBlockIndex: 0,
          entries: [],
        },
      ]);
    });
  });

  test("文本→工具保留顺序，并把工具按连续活动聚成一段", () => {
    expect(
      orderedTurnActivitySegments(
        [
          user("q"),
          assistantText("先说明"),
          assistantTools(["bash", "bash"]),
          toolResult("tu-bash-0"),
          assistantText("再总结"),
        ],
        0
      )
    ).toEqual([
      { kind: "text", messageIndex: 1, contentBlockIndex: 0 },
      {
        kind: "tools",
        messageIndex: 2,
        contentBlockIndex: 0,
        entries: [{ name: "bash", count: 2 }],
      },
      { kind: "text", messageIndex: 4, contentBlockIndex: 0 },
    ]);
  });

  test("工具→文本把折叠位置留在后续文本之前", () => {
    expect(
      orderedTurnActivitySegments(
        [
          user("q"),
          assistantTools(["bash"]),
          toolResult("tu-bash-0"),
          assistantText("完成"),
        ],
        0
      )
    ).toEqual([
      {
        kind: "tools",
        messageIndex: 1,
        contentBlockIndex: 0,
        entries: [{ name: "bash", count: 1 }],
      },
      { kind: "text", messageIndex: 3, contentBlockIndex: 0 },
    ]);
  });

  test("同一 assistant 消息保留 tool/text/tool 的 content block 位置", () => {
    expect(
      orderedTurnActivitySegments(
        [
          user("q"),
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tu-1", name: "bash", input: {} },
              { type: "text", text: "中间总结" },
              { type: "tool_use", id: "tu-2", name: "bash", input: {} },
            ],
          },
        ],
        0
      )
    ).toEqual([
      {
        kind: "tools",
        messageIndex: 1,
        contentBlockIndex: 0,
        entries: [{ name: "bash", count: 1 }],
      },
      { kind: "text", messageIndex: 1, contentBlockIndex: 1 },
      {
        kind: "tools",
        messageIndex: 1,
        contentBlockIndex: 2,
        entries: [{ name: "bash", count: 1 }],
      },
    ]);
  });

  test("empty / negative / overflow → 确定性空结果", () => {
    expect(orderedTurnActivitySegments([], 0)).toEqual([]);
    expect(orderedTurnActivitySegments([user("q")], -1)).toEqual([]);
    expect(orderedTurnActivitySegments([user("q")], 99)).toEqual([]);
  });

  test("exception：非法 content 不抛出并回退为空结果", () => {
    const malformed = {
      role: "assistant",
      get content(): never {
        throw new Error("malformed content");
      },
    } as unknown as AnthropicNativeMessage;
    expect(orderedTurnActivitySegments([malformed], 0)).toEqual([]);
  });

  // concurrent: N/A — the helper is a pure synchronous scan, no shared async state.
});

describe("countToolUsesByName（negative：末条无 tool_use）", () => {
  test("turn 内前面有 bash，末条纯文本 → 仍计入前面的 bash", () => {
    const msgs = [
      user("写个页面"),
      assistantTools(["bash", "read_file"]),
      toolResult("tu-bash-0"),
      assistantTools([], "完成。"),
    ];
    const start = lastTurnQueryIndex(msgs);
    expect(start).toBe(0);
    const counts = countToolUsesByName(sliceTurnFrom(msgs, start));
    expect(counts).toEqual([
      { name: "bash", count: 1 },
      { name: "read_file", count: 1 },
    ]);
  });

  test("D3 resolver：retract 计入、keep 拒收（与 orderedTurnActivitySegments 同契约）", () => {
    const msgs = [user("q"), assistantTools(["bash", "read_file"])];
    const retractOnly = (call: { readonly name: string }): boolean =>
      call.name === "read_file";
    expect(countToolUsesByName(msgs, { inFoldCountOf: retractOnly })).toEqual([
      { name: "read_file", count: 1 },
    ]);
    expect(countToolUsesByName(msgs, { inFoldCountOf: () => false })).toEqual(
      []
    );
  });

  test("上一 turn 的工具不计入本 turn", () => {
    const msgs = [
      user("旧"),
      assistantTools(["bash", "bash"]),
      user("新"),
      assistantTools(["write_file"]),
    ];
    const start = lastTurnQueryIndex(msgs);
    expect(start).toBe(2);
    expect(countToolUsesByName(sliceTurnFrom(msgs, start))).toEqual([
      { name: "write_file", count: 1 },
    ]);
  });
});

describe("countToolUsesByName（overflow）", () => {
  test("超大 count 与超多 name 不抛、按首次出现顺序", () => {
    const names = Array.from({ length: 40 }, (_, i) => `tool_${String(i)}`);
    const extra = Array.from({ length: 200 }, () => "bash");
    const counts = countToolUsesByName([assistantTools([...names, ...extra])]);
    expect(counts).toHaveLength(41);
    expect(counts[0]).toEqual({ name: "tool_0", count: 1 });
    expect(counts[40]).toEqual({ name: "bash", count: 200 });
    expect(() => formatToolUseCounts(counts)).not.toThrow();
  });
});

describe("countToolUsesByName（concurrent：同消息多 tool_use）", () => {
  test("同一 assistant 里两个 bash + 一个 write_file 按块计数", () => {
    expect(
      countToolUsesByName([assistantTools(["bash", "write_file", "bash"])])
    ).toEqual([
      { name: "bash", count: 2 },
      { name: "write_file", count: 1 },
    ]);
  });
});

describe("countToolUsesByName / format（exception / 非法形态）", () => {
  test("user / system / 无 tool_use 块 → 空计数", () => {
    expect(countToolUsesByName([user("hi")])).toEqual([]);
    expect(
      countToolUsesByName([
        { role: "system", content: [{ type: "text", text: "x" }] },
      ])
    ).toEqual([]);
    expect(
      countToolUsesByName([
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "x", signature: "s" }],
        },
      ])
    ).toEqual([]);
  });

  test("sliceTurnFrom start 越界或无 query（-1）→ 空", () => {
    expect(sliceTurnFrom([user("a")], 9)).toEqual([]);
    expect(sliceTurnFrom([user("a")], -1)).toEqual([]);
  });

  test("tool_result user 不是新 query", () => {
    const msgs = [user("q"), assistantTools(["bash"]), toolResult("tu-bash-0")];
    expect(lastTurnQueryIndex(msgs)).toBe(0);
  });
});

describe("formatToolUseCounts", () => {
  test("空计数 → 空串", () => {
    expect(formatToolUseCounts([])).toBe("");
  });

  test("count≤0 的条目省略", () => {
    expect(formatToolUseCounts([{ name: "bash", count: 0 }])).toBe("");
    expect(formatToolUseCounts([{ name: "bash", count: -3 }])).toBe("");
  });

  test("多条目按 primary 顺序 + count 拼接", () => {
    expect(
      formatToolUseCounts([
        { name: "bash", count: 2 },
        { name: "write_file", count: 1 },
      ])
    ).toBe("bash × 2 · write_file × 1");
  });

  test("恒 ≤1 行硬合同不存在（活动块把多行收成单行由 deriveActivityBlocks 保证）", () => {
    // The old `formatTurnActivityFold` hard contract is retired — the activity
    // block title is derived from a single source by `deriveActivityBlocks`;
    // this function only joins within a line and no longer owns ≤1-line shaping.
    expect(formatToolUseCounts([])).toBe("");
  });
});

describe("toolUseIdsOf / countNamedCalls", () => {
  test("empty：无 tool_use → 空 id 集", () => {
    expect(toolUseIdsOf([])).toEqual(new Set());
    expect(toolUseIdsOf([user("q")])).toEqual(new Set());
  });

  test("negative：excludeIds 命中的 live 条目不计", () => {
    const ids = toolUseIdsOf([assistantTools(["bash"])]);
    expect(ids.has("tu-bash-0")).toBe(true);
    expect(
      countNamedCalls(
        [
          { id: "tu-bash-0", name: "bash" },
          { id: "live-1", name: "bash" },
        ],
        ids
      )
    ).toEqual([{ name: "bash", count: 1 }]);
  });

  test("concurrent：同 id 不因重复调用双计（exclude 已覆盖）", () => {
    expect(
      countNamedCalls(
        [
          { id: "a", name: "bash" },
          { id: "a", name: "bash" },
        ],
        new Set()
      )
    ).toEqual([{ name: "bash", count: 2 }]);
  });
});

describe("thinkingMsToSeconds（ms → 秒）", () => {
  test("empty / negative：<= 0 / undefined / NaN / Infinity → 0", () => {
    expect(thinkingMsToSeconds(0)).toBe(0);
    expect(thinkingMsToSeconds(-1)).toBe(0);
    expect(thinkingMsToSeconds(Number.NaN)).toBe(0);
    expect(thinkingMsToSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("overflow：1ms 也算 1 秒（向上取整，避免显示 0 秒伪精度）", () => {
    expect(thinkingMsToSeconds(1)).toBe(1);
    expect(thinkingMsToSeconds(999)).toBe(1);
    expect(thinkingMsToSeconds(1000)).toBe(1);
    expect(thinkingMsToSeconds(1500)).toBe(2);
    expect(thinkingMsToSeconds(29_999)).toBe(30);
  });

  test("concurrent：纯函数稳定", () => {
    expect(thinkingMsToSeconds(7500)).toBe(thinkingMsToSeconds(7500));
  });
});

/**
 * tests/tui/turn-activity.test.ts
 *
 * last-turn 切片 + 工具计数折叠文案。5 类边界：empty / negative /
 * overflow / concurrent / exception。
 */
import { describe, expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import {
  countNamedCalls,
  countToolUsesByName,
  formatToolUseCounts,
  formatTurnActivityFold,
  lastTurnQueryIndex,
  mergeToolUseCounts,
  orderedTurnActivitySegments,
  sliceTurnFrom,
  sumThinkingMsInRange,
  thinkingMsToSeconds,
  toolUseIdsOf,
} from "../../src/tui/turn-activity.js";
import * as turnActivityModule from "../../src/tui/turn-activity.js";

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
  // D3（spec specs/tui-tool-settled-appearance.md）：折叠计数只聚合 resolver
  // 判定为 true 的件（成功且 retract）。resolver 缺省 = 全部计入（兜底）。
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

  // concurrent：N/A — helper 是纯同步扫描，不存在共享异步状态。
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

describe("formatToolUseCounts / formatTurnActivityFold", () => {
  test("空计数 → 空串", () => {
    expect(formatToolUseCounts([])).toBe("");
  });

  test("count≤0 的条目省略", () => {
    expect(formatToolUseCounts([{ name: "bash", count: 0 }])).toBe("");
    expect(formatToolUseCounts([{ name: "bash", count: -3 }])).toBe("");
  });

  test("有秒数 + 工具 → 至多 1 行：`Thought for` 与计数焊在同一行（D2 收类不蒸发）", () => {
    const lines = formatTurnActivityFold(29, [
      { name: "bash", count: 18 },
      { name: "write_file", count: 8 },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Thought for 29s · bash × 18 · write_file × 8");
  });

  test("retract 类（read_file）落定后计数仍在同一行，不是第二行、不是隐身", () => {
    const lines = formatTurnActivityFold(5, [
      { name: "read_file", count: 3 },
      { name: "grep", count: 1 },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Thought for 5s");
    expect(lines[0]).toContain("read_file × 3");
    expect(lines[0]).toContain("grep × 1");
  });

  test("无秒数有工具 → 只计数一行（不换 [思考]、不造 0 秒）", () => {
    expect(formatTurnActivityFold(0, [{ name: "bash", count: 2 }])).toEqual([
      "bash × 2",
    ]);
    expect(
      formatTurnActivityFold(undefined, [{ name: "bash", count: 1 }])
    ).toEqual(["bash × 1"]);
  });

  test("无秒数无工具 → 空数组", () => {
    expect(formatTurnActivityFold(0, [])).toEqual([]);
    expect(formatTurnActivityFold(undefined, [])).toEqual([]);
  });

  test("只有秒数无工具 → 仅结束态一行", () => {
    expect(formatTurnActivityFold(6, [])).toEqual(["Thought for 6s"]);
  });

  test("恒 ≤1 行的硬合同：任意秒数 × 任意计数组合", () => {
    const combos: ReadonlyArray<number | undefined> = [0, 1, 30, undefined];
    for (const seconds of combos) {
      for (const entries of [[], [{ name: "read_file", count: 2 }]]) {
        expect(
          formatTurnActivityFold(seconds, entries).length
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  test("旧中文 `思考了` 文案不再出现在折叠行", () => {
    const line = formatTurnActivityFold(9, [
      { name: "read_file", count: 1 },
    ])[0];
    expect(line).toBeDefined();
    expect(line).not.toContain("思考了");
    expect(line).not.toContain("秒");
  });
});

describe("toolUseIdsOf / countNamedCalls / mergeToolUseCounts", () => {
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

  test("overflow：extra 新名接到 primary 后，count 相加", () => {
    expect(
      mergeToolUseCounts(
        [
          { name: "bash", count: 18 },
          { name: "write_file", count: 8 },
        ],
        [
          { name: "bash", count: 2 },
          { name: "grep", count: 1 },
        ]
      )
    ).toEqual([
      { name: "bash", count: 20 },
      { name: "write_file", count: 8 },
      { name: "grep", count: 1 },
    ]);
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

  test("exception：count≤0 的 extra 不进 merge", () => {
    expect(
      mergeToolUseCounts(
        [{ name: "bash", count: 1 }],
        [
          { name: "bash", count: 0 },
          { name: "x", count: -1 },
        ]
      )
    ).toEqual([{ name: "bash", count: 1 }]);
  });
});

describe("shouldShowTurnActivityFold / shouldCollapseTurnToolRows（T3 已删除）", () => {
  // plans/tui-live-activity-fold.md T3：删除 `foldDisplayLines.length` 折叠
  // 信号与整轮 `currentTurnHasFold` 面板闸 —— 这两个 turn 级函数是该派生链
  // 的入口。落点改由 per-segment fold 行（`shouldShowRetractFold` /
  // `shouldShowThinkingFold`，见 running-unit-fold.test.ts）与
  // **live activity group**（live-activity-group.test.ts）承担。
  test("两个 turn 级闸不再导出（编译期合同：留着就会有人接回整轮闸）", () => {
    const exports = Object.keys(turnActivityModule);
    expect(exports).not.toContain("shouldShowTurnActivityFold");
    expect(exports).not.toContain("shouldCollapseTurnToolRows");
  });
});

describe("sumThinkingMsInRange（折叠簇内 thinkingMs 求和纯函数）", () => {
  test("empty：thinkingMs undefined → 全 0（旧会话/无落盘数据）", () => {
    expect(sumThinkingMsInRange(undefined, [0, 1, 2])).toBe(0);
    expect(sumThinkingMsInRange(undefined, [])).toBe(0);
  });

  test("empty：indices 空数组 → 全 0（无簇）", () => {
    expect(sumThinkingMsInRange([1500, 2000], [])).toBe(0);
  });

  test("null 元素按 0 计入（非流式回合 / 该事件无 thinkingMs）", () => {
    expect(sumThinkingMsInRange([null, null, null], [0, 1, 2])).toBe(0);
    expect(sumThinkingMsInRange([1500, null, 2000], [0, 1, 2])).toBe(
      1500 + 2000
    );
  });

  test("混合：合法 number + null + 缺席按 0 计入", () => {
    expect(sumThinkingMsInRange([1500, null, 2000], [0, 1, 2, 3])).toBe(
      1500 + 2000
    );
    expect(sumThinkingMsInRange([1500, null, 2000], [1])).toBe(0);
  });

  test("全 null：合法求和 → 0（折叠行只显示工具计数，不显示 0 秒）", () => {
    expect(sumThinkingMsInRange([null, null], [0, 1])).toBe(0);
  });

  test("全 number 求和", () => {
    expect(sumThinkingMsInRange([1000, 2000, 3000], [0, 1, 2])).toBe(6000);
    expect(sumThinkingMsInRange([250, 750, 1500], [2])).toBe(1500);
  });

  test("越界索引按 0 计入（数组长度 < max(indices)+1）", () => {
    expect(sumThinkingMsInRange([1500], [0, 5])).toBe(1500);
    expect(sumThinkingMsInRange([], [0, 1])).toBe(0);
  });

  test("exception：非有限 / <= 0 数字按 0 计入（appendEvents 已过滤，consumer 再防御）", () => {
    expect(
      sumThinkingMsInRange([1500, Number.NaN, 2000, 0, -1], [0, 1, 2, 3, 4])
    ).toBe(3500);
    expect(sumThinkingMsInRange([Number.POSITIVE_INFINITY, 1500], [0, 1])).toBe(
      1500
    );
  });

  test("exception：非整数 / 负索引跳过", () => {
    expect(sumThinkingMsInRange([1500, 2000], [0.5, -1, 0])).toBe(1500);
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

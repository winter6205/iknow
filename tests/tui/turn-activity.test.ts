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
  sliceTurnFrom,
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

describe("lastTurnQueryIndex / sliceTurnFrom（empty）", () => {
  test("空消息 → index -1，slice 空", () => {
    expect(lastTurnQueryIndex([])).toBe(-1);
    expect(sliceTurnFrom([], -1)).toEqual([]);
    expect(sliceTurnFrom([], 0)).toEqual([]);
  });
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

  test("有秒数 + 工具", () => {
    expect(
      formatTurnActivityFold(29, [
        { name: "bash", count: 18 },
        { name: "write_file", count: 8 },
      ])
    ).toBe("思考了 29 秒 · bash × 18 · write_file × 8");
  });

  test("无秒数有工具 → 只计数（不换 [思考]、不造 0 秒）", () => {
    expect(formatTurnActivityFold(0, [{ name: "bash", count: 2 }])).toBe(
      "bash × 2"
    );
    expect(
      formatTurnActivityFold(undefined, [{ name: "bash", count: 1 }])
    ).toBe("bash × 1");
  });

  test("无秒数无工具 → 空串", () => {
    expect(formatTurnActivityFold(0, [])).toBe("");
    expect(formatTurnActivityFold(undefined, [])).toBe("");
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

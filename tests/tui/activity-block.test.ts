/**
 * tests/tui/activity-block.test.ts
 *
 * specs/tui-activity-block.md S2–S7 / S9 / S10：过程块纯派生
 * （messages + 未提交 live runs → activity blocks）的夹具。
 * 5 类边界：empty / negative / overflow / concurrent / exception。
 *
 * 数据构造助手与 tests/tui/turn-activity.test.ts 对齐（user / toolResult /
 * assistant 内容块）。失败判定不另造分类表：走真实 `toolResultStatusMap` +
 * `deriveSlot` 复刻 ChatView 的 `inFoldCountOf`（同一 SSOT），这样夹具断言的
 * 就是生产接线会看到的形态。
 */
import { describe, expect, test } from "bun:test";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../src/harness/model-adapter/types.js";
import {
  deriveActivityBlocks,
  type ActivityBlock,
  type ActivityBlockInput,
} from "../../src/tui/activity-block.js";
import {
  formatRunningToolLine,
  type LiveToolRun,
  type LiveToolStatus,
} from "../../src/tui/live-tool-state.js";
import { deriveSlot, isLiveNoise } from "../../src/tui/tool-settled.js";
// 注：未直接用 deriveSlot，保留 import 仅为该文件原有调用；下面已用
// isLiveNoise 统一走 live-signal revision #3/#4 入口。
import { toolResultStatusMap } from "../../src/tui/tool-summary.js";

// ── 数据构造（与 tests/tui/turn-activity.test.ts 对齐）─────────────

function user(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolResult(id: string, isError = false): AnthropicNativeMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: "ok",
        ...(isError ? { is_error: true } : {}),
      },
    ],
  };
}

function thinkingBlock(text = "想一下"): AnthropicContentBlock {
  return { type: "thinking", thinking: text, signature: "sig" };
}

function textBlock(text: string): AnthropicContentBlock {
  return { type: "text", text };
}

function toolUseBlock(
  id: string,
  name: string,
  input: unknown = {}
): AnthropicContentBlock {
  return { type: "tool_use", id, name, input };
}

function assistant(
  content: ReadonlyArray<AnthropicContentBlock>
): AnthropicNativeMessage {
  return { role: "assistant", content };
}

function liveRun(
  id: string,
  name: string,
  status: LiveToolStatus,
  input: unknown = {}
): LiveToolRun {
  return { id, name, status, input };
}

/** ChatView `inFoldCountOf` 的同源复刻：只数 live noise；失败 / web_* 排除。 */
function chatViewResolver(
  messages: ReadonlyArray<AnthropicNativeMessage>
): (call: Readonly<{ id: string; name: string }>) => boolean {
  const statusMap = toolResultStatusMap(messages);
  return (call) => {
    if (!isLiveNoise(call.name)) return false;
    if (!statusMap.has(call.id)) return true; // 未配对 = running
    return statusMap.get(call.id) !== true; // 失败横切
  };
}

interface Fixture {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  /** visible 下标 → thinkingMs（缺省 0）。 */
  readonly thinkingMs?: ReadonlyArray<number>;
  readonly start?: number;
  readonly liveThinking?: boolean;
  readonly liveRuns?: ReadonlyArray<LiveToolRun>;
  /** 缺省 = ChatView 同源 resolver（需要 tool_result 配对才计数）。 */
  readonly inFoldCountOf?: (
    call: Readonly<{ id: string; name: string }>
  ) => boolean;
}

function derive(fixture: Fixture): ReadonlyArray<ActivityBlock> {
  const thinkingMs = fixture.thinkingMs ?? [];
  const input: ActivityBlockInput = {
    messages: fixture.messages,
    start: fixture.start,
    thinkingMsAtVisible: (visibleIndex) => thinkingMs[visibleIndex] ?? 0,
    liveThinking: fixture.liveThinking,
    liveRuns: fixture.liveRuns,
    inFoldCountOf: fixture.inFoldCountOf ?? chatViewResolver(fixture.messages),
  };
  return deriveActivityBlocks(input);
}

function titles(blocks: ReadonlyArray<ActivityBlock>): ReadonlyArray<string> {
  return blocks.map((block) => block.title);
}

const MS_5S = 5000;
const MS_3S = 3000;

// ── empty ─────────────────────────────────────────────────────────

describe("deriveActivityBlocks（empty）", () => {
  test("空 messages、无 live → 空块列表", () => {
    expect(derive({ messages: [] })).toEqual([]);
  });

  test("S10-1 无思考无工具（纯正文）→ 不画块", () => {
    expect(
      derive({ messages: [user("q"), assistant([textBlock("hi")])] })
    ).toEqual([]);
  });

  test("user / tool_result 消息本身不产块", () => {
    expect(derive({ messages: [user("q"), toolResult("t1")] })).toEqual([]);
  });
});

// ── S2 焊：思考 + 相邻安静工具 ─────────────────────────────────────

describe("S2 焊成立（思考 + 相邻安静工具）", () => {
  test("思考后直接安静工具 → 时长与 called 焊在同一标题", () => {
    const messages = [
      user("q"),
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1"),
    ];
    const blocks = derive({ messages, thinkingMs: [0, MS_5S, 0] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("Thought for 5s, called read_file × 1");
    expect(blocks[0]?.anchor).toEqual({
      messageIndex: 1,
      contentBlockIndex: 0,
    });
    expect(blocks[0]?.slot).toEqual({ kind: "none" });
    expect(blocks[0]?.live).toBe(false);
  });

  test("多工具焊一行：`, ` 接时长段、` · ` 接计数段", () => {
    const messages = [
      user("q"),
      assistant([
        thinkingBlock(),
        toolUseBlock("t1", "read_file"),
        toolUseBlock("t2", "grep"),
        toolUseBlock("t3", "grep"),
      ]),
      toolResult("t1"),
      toolResult("t2"),
      toolResult("t3"),
    ];
    const blocks = derive({ messages, thinkingMs: [0, MS_5S, 0, 0, 0] });
    expect(titles(blocks)).toEqual([
      "Thought for 5s, called read_file × 1 · grep × 2",
    ]);
  });

  test("无秒数 → 只画 calling/called 段（不补前导 `, `）", () => {
    const messages = [
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1"),
    ];
    expect(titles(derive({ messages }))).toEqual(["called read_file × 1"]);
  });
});

// ── S3 切开：中间有正文 ───────────────────────────────────────────

describe("S3 切开成立（正文夹在思考与安静工具之间）", () => {
  test("思考 → 正文 → 安静工具 → `Thought for` / 正文 / `called` 三段分离", () => {
    const messages = [
      user("q"),
      assistant([
        thinkingBlock(),
        textBlock("正文段落"),
        toolUseBlock("t1", "read_file"),
      ]),
      toolResult("t1"),
    ];
    const blocks = derive({ messages, thinkingMs: [0, MS_5S, 0] });
    expect(blocks.map((block) => [block.title, block.anchor])).toEqual([
      ["Thought for 5s", { messageIndex: 1, contentBlockIndex: 0 }],
      ["called read_file × 1", { messageIndex: 1, contentBlockIndex: 2 }],
    ]);
    // 正文本身不进任何标题（正文由渲染层原位画）。
    for (const title of titles(blocks)) {
      expect(title).not.toContain("正文段落");
    }
  });

  test("同一消息被正文切成两簇 → 每簇自成一块，计数不写回时长块", () => {
    const messages = [
      assistant([
        thinkingBlock(),
        toolUseBlock("t1", "read_file"),
        textBlock("中间正文"),
        toolUseBlock("t2", "grep"),
      ]),
      toolResult("t1"),
      toolResult("t2"),
    ];
    const blocks = derive({ messages, thinkingMs: [MS_5S] });
    expect(
      blocks.map((block) => [block.title, block.anchor.contentBlockIndex])
    ).toEqual([
      ["Thought for 5s, called read_file × 1", 0],
      ["called grep × 1", 3],
    ]);
  });
});

// ── S4 calling → called ───────────────────────────────────────────

describe("S4 calling → called 转移", () => {
  test("live 安静工具 running → calling + dim 预览槽", () => {
    const run = liveRun("t1", "read_file", "running", { path: "a.ts" });
    const blocks = derive({ messages: [user("q")], liveRuns: [run] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("calling read_file × 1");
    expect(blocks[0]?.anchor).toEqual({
      messageIndex: 1,
      contentBlockIndex: 0,
    });
    // 预览文本由 formatRunningToolLine 单源产出（不在此另拼模板串）。
    expect(blocks[0]?.slot).toEqual({
      kind: "tool-preview",
      text: formatRunningToolLine(run),
    });
    expect(blocks[0]?.live).toBe(true);
  });

  test("全结束 → called 且预览槽收掉（live 收）", () => {
    const blocks = derive({
      messages: [user("q")],
      liveRuns: [liveRun("t1", "read_file", "ok", { path: "a.ts" })],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("called read_file × 1");
    expect(blocks[0]?.slot).toEqual({ kind: "none" });
    expect(blocks[0]?.live).toBe(false);
  });

  test("多工具 calling：计数按首现顺序、预览取最后一条 running", () => {
    const runs = [
      liveRun("t1", "read_file", "running"),
      liveRun("t2", "grep", "ok"),
      liveRun("t3", "grep", "running"),
    ];
    const blocks = derive({ messages: [user("q")], liveRuns: runs });
    expect(blocks[0]?.title).toBe("calling read_file × 1 · grep × 2");
    expect(blocks[0]?.slot).toEqual({
      kind: "tool-preview",
      text: formatRunningToolLine(runs[2] as LiveToolRun),
    });
    expect(blocks[0]?.live).toBe(true);
  });

  test("历史簇仍有 running 件（id 命中）→ 该块 calling + 预览槽", () => {
    const messages = [
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
    ];
    const blocks = derive({
      messages,
      thinkingMs: [MS_5S],
      inFoldCountOf: () => true,
      liveRuns: [liveRun("t1", "read_file", "running", { path: "a.ts" })],
    });
    expect(blocks.map((block) => block.title)).toEqual([
      "Thought for 5s, calling read_file × 1",
    ]);
    expect(blocks[0]?.slot.kind).toBe("tool-preview");
    expect(blocks[0]?.live).toBe(true);
  });

  test("同一批件：live running 时不出现 called 行（无双画）", () => {
    const messages = [user("q")];
    const running = derive({
      messages,
      liveRuns: [liveRun("t1", "read_file", "running")],
    });
    expect(titles(running)).toEqual(["calling read_file × 1"]);
    const settled = derive({
      messages,
      liveRuns: [liveRun("t1", "read_file", "ok")],
    });
    expect(titles(settled)).toEqual(["called read_file × 1"]);
  });
});

// ── S5 新消息开新块 ───────────────────────────────────────────────

describe("S5 新消息开新块", () => {
  test("两条 assistant → 两块；第二条不改第一块计数", () => {
    const messages = [
      user("q1"),
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1"),
      user("q2"),
      assistant([thinkingBlock(), toolUseBlock("t2", "grep")]),
      toolResult("t2"),
    ];
    const blocks = derive({ messages, thinkingMs: [0, MS_5S, 0, 0, MS_3S, 0] });
    expect(
      blocks.map((block) => [block.title, block.anchor.messageIndex])
    ).toEqual([
      ["Thought for 5s, called read_file × 1", 1],
      ["Thought for 3s, called grep × 1", 4],
    ]);
  });

  test("并发：已冻历史块 + 下一块思考槽并存，互不改写", () => {
    const messages = [
      user("q1"),
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1"),
    ];
    const blocks = derive({
      messages,
      thinkingMs: [0, MS_5S, 0],
      liveThinking: true,
    });
    expect(blocks.map((block) => block.title)).toEqual([
      "Thought for 5s, called read_file × 1",
      "Thinking…",
    ]);
    expect(blocks[1]?.anchor).toEqual({
      messageIndex: 3,
      contentBlockIndex: 0,
    });
    expect(blocks[1]?.slot).toEqual({ kind: "thinking" });
    expect(blocks[1]?.live).toBe(true);
  });

  test("下一次思考只开新块：新块不改上一块的计数", () => {
    const messages = [
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1"),
    ];
    const before = titles(derive({ messages, thinkingMs: [MS_5S, 0] }));
    const after = titles(
      derive({ messages, thinkingMs: [MS_5S, 0], liveThinking: true })
    );
    expect(after.slice(0, before.length)).toEqual([...before]);
    expect(after).toHaveLength(before.length + 1);
  });
});

// ── S6 失败件不进块计数 ───────────────────────────────────────────

describe("S6 失败件不进块计数", () => {
  test("失败安静工具不计数：只留时长段", () => {
    const messages = [
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1", true),
    ];
    const blocks = derive({ messages, thinkingMs: [MS_5S] });
    expect(titles(blocks)).toEqual(["Thought for 5s"]);
    expect(blocks[0]?.slot).toEqual({ kind: "none" });
  });

  test("失败件同时把焊接切开：两侧安静簇各自成块，失败名不进任何标题", () => {
    const messages = [
      assistant([
        thinkingBlock(),
        toolUseBlock("t1", "read_file"),
        toolUseBlock("t2", "grep"),
        toolUseBlock("t3", "glob"),
      ]),
      toolResult("t1"),
      toolResult("t2", true),
      toolResult("t3"),
    ];
    const blocks = derive({ messages, thinkingMs: [MS_5S] });
    expect(
      blocks.map((block) => [block.title, block.anchor.contentBlockIndex])
    ).toEqual([
      ["Thought for 5s, called read_file × 1", 0],
      ["called glob × 1", 3],
    ]);
    for (const title of titles(blocks)) expect(title).not.toContain("grep");
  });

  test("live 失败件不占 dim 预览槽（failure overlay 横切）", () => {
    const blocks = derive({
      messages: [user("q")],
      liveRuns: [liveRun("t1", "read_file", "failed")],
    });
    expect(blocks).toEqual([]);
  });
});

// ── live-signal revision：live noise / live signal 划分（specs/tui-activity-block.md
//  live-signal revision #3/#4/#5/#8）───────────────────────────────────────

describe("live-signal revision：weldable = live noise only", () => {
  test("live web_search running → 不画 'calling web_search × 1' 块（live signal 实卡）", () => {
    // spec revision #4：web_search / web_fetch 永不进 `calling`/`called`。
    const blocks = derive({
      messages: [user("q")],
      liveRuns: [liveRun("t1", "web_search", "running", { query: "hi" })],
    });
    expect(titles(blocks)).toEqual([]);
  });

  test("live grep running → 'calling grep × 1' 块 + tool-preview 槽", () => {
    // spec revision #3：grep 是 live noise，进 unanchored 块。
    const run = liveRun("t1", "grep", "running", { pattern: "foo" });
    const blocks = derive({ messages: [user("q")], liveRuns: [run] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("calling grep × 1");
    expect(blocks[0]?.slot).toEqual({
      kind: "tool-preview",
      text: formatRunningToolLine(run),
    });
  });

  test("live 簇 grep + web_search 同段 → web_search 不在 title 计数", () => {
    // spec revision #4：web_search 不进计数 → 块标题只列 noise 名。
    const blocks = derive({
      messages: [user("q")],
      liveRuns: [
        liveRun("t1", "grep", "running"),
        liveRun("t2", "web_search", "running", { query: "hi" }),
      ],
    });
    expect(titles(blocks)).toEqual(["calling grep × 1"]);
  });

  test("history 已落 grep（tool_result 配对）+ 仍 running → 'calling grep' 进块", () => {
    // 历史 tool_use 已进 transcript，但 liveRuns 同 id 仍 running →
    // 块由 history 累积 + resolveLiveRunning 命中（id 匹配）→ calling。
    // 用 `inFoldCountOf: () => true` 复刻 ChatView 生产解析器在 unpaired
    // 路径下走 `isLiveNoise`（grep 仍属 noise → 真）的语义。
    const messages = [
      user("q"),
      assistant([thinkingBlock(), toolUseBlock("t1", "grep")]),
    ];
    const blocks = derive({
      messages,
      thinkingMs: [0, MS_5S],
      liveRuns: [liveRun("t1", "grep", "running", { pattern: "foo" })],
      inFoldCountOf: (call) => isLiveNoise(call.name),
    });
    expect(titles(blocks)).toEqual(["Thought for 5s, calling grep × 1"]);
    expect(blocks[0]?.live).toBe(true);
  });

  test("history 失败 grep（tool_result is_error）→ 不进块计数（仍走 failure overlay）", () => {
    // 失败件 = 横切，spec S4 / failure overlay。S6 已锁「失败安静工具不计数」。
    const messages = [
      user("q"),
      assistant([thinkingBlock(), toolUseBlock("t1", "grep")]),
      toolResult("t1", true),
    ];
    const blocks = derive({ messages, thinkingMs: [0, MS_5S, 0] });
    expect(titles(blocks)).toEqual(["Thought for 5s"]);
  });

  test("history web_search 落定 → 不进块计数（live-signal 实卡路径）", () => {
    // live-signal revision #4：web_search 永不进 `calling`/`called` ——
    // 即使已配对（settled）也走实卡。块由 thinking 撑起，标题仅时长；
    // 实卡标题 `Search <query>` 在 MessageBlocks 抽出（不属块）。
    const messages = [
      user("q"),
      assistant([thinkingBlock(), toolUseBlock("t1", "web_search")]),
      toolResult("t1"),
    ];
    const blocks = derive({ messages, thinkingMs: [0, MS_5S, 0] });
    expect(titles(blocks)).toEqual(["Thought for 5s"]);
  });

  test("history unpaired web_search 仍在跑 → 不进块（live noise 谓词挡 live）", () => {
    // live noise 谓词在 ChatView `inFoldCountOf` 端只服务「unpaired」
    // 分支：statusMap 没该 id → 走 `isLiveNoise` → web_search 假 →
    // 不进 `calling`。本测试用 `inFoldCountOf` 走 `isLiveNoise` 同源
    // （不复刻 `chatViewResolver`，否则仍走旧 `settledClassOf`）。
    const messages = [
      user("q"),
      assistant([thinkingBlock(), toolUseBlock("t1", "web_search")]),
    ];
    const blocks = derive({
      messages,
      thinkingMs: [0, MS_5S],
      liveRuns: [liveRun("t1", "web_search", "running", { query: "hi" })],
      inFoldCountOf: (call) => isLiveNoise(call.name),
    });
    // 无 noise 工具 → 块由 thinking 段撑起，标题仅时长；无 calling 计数。
    expect(titles(blocks)).toEqual(["Thought for 5s"]);
  });
});

// ── S7 keep / accent 仍块外 ───────────────────────────────────────

describe("S7 keep / accent 仍是块外实卡（只作隔开因素）", () => {
  test("keep（bash）隔开焊接，自身不进块", () => {
    const messages = [
      assistant([
        thinkingBlock(),
        toolUseBlock("t1", "bash"),
        toolUseBlock("t2", "read_file"),
      ]),
      toolResult("t1"),
      toolResult("t2"),
    ];
    const blocks = derive({ messages, thinkingMs: [MS_5S] });
    expect(
      blocks.map((block) => [block.title, block.anchor.contentBlockIndex])
    ).toEqual([
      ["Thought for 5s", 0],
      ["called read_file × 1", 2],
    ]);
    for (const title of titles(blocks)) expect(title).not.toContain("bash");
  });

  test("accent（skill）同样隔开且不进块", () => {
    const messages = [
      assistant([
        thinkingBlock(),
        toolUseBlock("t1", "skill"),
        toolUseBlock("t2", "read_file"),
      ]),
      toolResult("t1"),
      toolResult("t2"),
    ];
    const blocks = derive({ messages, thinkingMs: [MS_5S] });
    expect(blocks.map((block) => block.title)).toEqual([
      "Thought for 5s",
      "called read_file × 1",
    ]);
    for (const title of titles(blocks)) expect(title).not.toContain("skill");
  });
});

// ── S9 槽位交接 ───────────────────────────────────────────────────

describe("S9 槽位交接：思考让位", () => {
  test("思考在流 → 槽归思考、标题 Thinking…", () => {
    const blocks = derive({ messages: [user("q")], liveThinking: true });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("Thinking…");
    expect(blocks[0]?.slot).toEqual({ kind: "thinking" });
    expect(blocks[0]?.live).toBe(true);
  });

  test("思考阶段结束（text_delta / tool_call_start）→ 正文离槽、时长留标题", () => {
    const messages = [
      assistant([thinkingBlock(), textBlock("正文")]),
      toolResult("t1"),
    ];
    const blocks = derive({ messages, thinkingMs: [MS_5S] });
    expect(blocks.map((block) => block.title)).toEqual(["Thought for 5s"]);
    expect(blocks[0]?.slot).toEqual({ kind: "none" });
    expect(blocks[0]?.live).toBe(false);
  });

  test("liveThinking + 非 history noise run → 本批顺序 noise 在前、思考块在后", () => {
    // Thinking-at-bottom revision（plans/tui-thinking-at-bottom.md 锁句 1–2）：
    // 同一 burst 内 `appendLiveBlocks` 把 noise 簇先 push、思考块后 push。
    // 还在流的思考段是本批最底；它驱动的那批动作若已出现则位于它上面。
    const run = liveRun("tu-g-burst", "grep", "running", { pattern: "foo" });
    const blocks = derive({
      messages: [user("q")],
      liveRuns: [run],
      liveThinking: true,
    });
    // 思考块 LAST：noise（calling grep × 1）在前，Thinking… 在后。
    expect(blocks.map((block) => block.title)).toEqual([
      "calling grep × 1",
      "Thinking…",
    ]);
    expect(blocks[1]?.slot).toEqual({ kind: "thinking" });
    expect(blocks[1]?.live).toBe(true);
  });
});

// ── S10 边界四类 ──────────────────────────────────────────────────

describe("S10 边界四类", () => {
  test("无思考无工具 → 无块", () => {
    expect(derive({ messages: [assistant([textBlock("只是正文")])] })).toEqual(
      []
    );
  });

  test("思考后无工具直接正文 → 只时长块", () => {
    const messages = [assistant([thinkingBlock(), textBlock("正文")])];
    expect(titles(derive({ messages, thinkingMs: [MS_5S] }))).toEqual([
      "Thought for 5s",
    ]);
  });

  test("思考后直接安静工具（无正文）→ 焊一块", () => {
    const messages = [
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1"),
    ];
    expect(titles(derive({ messages, thinkingMs: [MS_5S] }))).toEqual([
      "Thought for 5s, called read_file × 1",
    ]);
  });

  test("正文夹在思考与安静工具之间 → 切开成两块", () => {
    const messages = [
      assistant([
        thinkingBlock(),
        textBlock("正文"),
        toolUseBlock("t1", "read_file"),
      ]),
      toolResult("t1"),
    ];
    expect(titles(derive({ messages, thinkingMs: [MS_5S] }))).toEqual([
      "Thought for 5s",
      "called read_file × 1",
    ]);
  });

  test("缺省 inFoldCountOf（未注册名缺省 retract）也画块", () => {
    const messages = [
      assistant([thinkingBlock(), toolUseBlock("t1", "some_new_tool")]),
    ];
    // `derive` 默认走 `chatViewResolver`（要求 tool_result 配对）。本用例
    // 验证「未注册名也走 retract」—— 直接调 `deriveActivityBlocks`，让模块
    // 自带的 `inFoldCountOf` 缺省（alwaysInFold）兜底。
    expect(
      deriveActivityBlocks({
        messages,
        thinkingMsAtVisible: () => MS_5S,
      }).map((block) => block.title)
    ).toEqual(["Thought for 5s, called some_new_tool × 1"]);
  });
});

// ── negative / overflow / exception ───────────────────────────────

describe("边界：negative / overflow / exception", () => {
  test("start 负数 / NaN → 按 0 起算（不吞历史块）", () => {
    const messages = [
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1"),
    ];
    const expected = ["Thought for 5s, called read_file × 1"];
    expect(
      titles(derive({ messages, thinkingMs: [MS_5S], start: -1 }))
    ).toEqual(expected);
    expect(
      titles(derive({ messages, thinkingMs: [MS_5S], start: NaN }))
    ).toEqual(expected);
  });

  test("start 越界 → 只留 live 块（不把历史当当前活动）", () => {
    const messages = [
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1"),
    ];
    const blocks = derive({
      messages,
      thinkingMs: [MS_5S],
      start: messages.length + 5,
      liveThinking: true,
    });
    expect(blocks.map((block) => block.title)).toEqual(["Thinking…"]);
    expect(blocks[0]?.anchor.messageIndex).toBe(messages.length);
  });

  test("start = 首个可见 assistant → 之前的块不产出", () => {
    const messages = [
      assistant([thinkingBlock(), toolUseBlock("t1", "read_file")]),
      toolResult("t1"),
      user("q2"),
      assistant([thinkingBlock(), toolUseBlock("t2", "grep")]),
      toolResult("t2"),
    ];
    const blocks = derive({
      messages,
      thinkingMs: [MS_5S, 0, 0, MS_3S, 0],
      start: 3,
    });
    expect(blocks.map((block) => block.anchor.messageIndex)).toEqual([3]);
  });

  test("异常消息形态（content 含 null）→ 拒绝画块而非抛错", () => {
    const malformed = {
      role: "assistant",
      content: [null],
    } as unknown as AnthropicNativeMessage;
    expect(
      deriveActivityBlocks({
        messages: [malformed],
        thinkingMsAtVisible: () => MS_5S,
      })
    ).toEqual([]);
  });

  test("content 非数组 → 拒绝画块（同 orderedTurnActivitySegments 纪律）", () => {
    const malformed = {
      role: "assistant",
      content: "not-an-array",
    } as unknown as AnthropicNativeMessage;
    expect(
      deriveActivityBlocks({
        messages: [malformed],
        thinkingMsAtVisible: () => MS_5S,
      })
    ).toEqual([]);
  });
});

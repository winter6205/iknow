/** @jsxImportSource @opentui/react */
/**
 * tests/tui/t6-text-splits-weld.test.tsx
 *
 * T6 (plans/tui-activity-block.md T6 + specs/tui-activity-block.md S3/S7)：
 * 思考→正文→安静工具：`Thought for` 与正文与 `called name × N` 三段分离，
 * 工具计数不写回思考行；下一条 assistant 的 `Thinking…` 出现在已冻 stub
 * 之下且不修改上一块计数。
 *
 * 验收点：
 *  1. 同消息：思考→正文→安静工具 → 三段独立块（每块自己的标题），`called`
 *     不写到思考行的标题。
 *  2. 跨消息：第二条 assistant 的思考流（live draft）出现在上一块的
 *     `called` 之下，且不改上一块计数。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ChatView } from "../../src/tui/chat-view.js";
import {
  attachSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { LiveToolRun } from "../../src/tui/live-tool-state.js";

const COLS = 80;
const ROWS = 40;

function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>,
  opts: {
    readonly thinkingMs?: ReadonlyArray<number | null>;
    readonly runState?: "idle" | "running-fg";
  } = {}
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "t6-text-splits-weld",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-09-15T00:00:00.000Z",
    jsonMode: false,
    title: "t6-text-splits-weld",
    cwd: "/tmp",
    sanitized_at: "2026-09-15T00:00:00.000Z",
    ...(opts.thinkingMs !== undefined ? { thinkingMs: opts.thinkingMs } : {}),
  };
  const base = attachSession(file);
  return opts.runState !== undefined
    ? { ...base, runState: opts.runState }
    : base;
}

describe("T6 同消息内正文切开：思考 + 正文 + 安静工具 = 三段", () => {
  test("思考 → 正文 → 安静工具：标题三段分离，called 不写回思考标题", async () => {
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "查一下" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先想", signature: "s1" },
          { type: "text", text: "中间正文" },
          {
            type: "tool_use",
            id: "tu-r1",
            name: "read_file",
            input: { path: "x.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-r1",
            content: "ok",
            is_error: false,
          },
        ],
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, {
          thinkingMs: [null, 8000, null],
        })}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={[]}
        thinkingExpanded={false}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n").map((l) => l.trim());
    // 第一段块标题：思考 → `Thought for 8s`（不写 read_file）
    const thinkIdx = lines.findIndex((l) => l === "Thought for 8s");
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    expect(lines[thinkIdx]).not.toContain("read_file");
    // 正文存在
    expect(frame).toContain("中间正文");
    // 第二段块标题：`called read_file × 1`（独立，不与思考合并）
    const readIdx = lines.findIndex((l) => l.includes("called read_file × 1"));
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThan(thinkIdx);
    // 不存在合并形 `Thought for 8s · read_file × 1`
    expect(frame).not.toContain("Thought for 8s · read_file × 1");
    expect(frame).not.toContain("Thought for 8s, called read_file");
    await setup.renderer.destroy();
  });
});

describe("T6 思考 + 正文 + 噪音（grep）切开：grep 计数不写回 Thought for 标题", () => {
  test("思考 → 正文 → grep（noise）：grep 走独立 called 行，不与思考焊接", async () => {
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "查一下" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先想", signature: "s1" },
          { type: "text", text: "中间正文" },
          {
            type: "tool_use",
            id: "tu-g1",
            name: "grep",
            input: { path: "src", pattern: "TODO" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-g1",
            content: "found 3 matches",
            is_error: false,
          },
        ],
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, {
          thinkingMs: [null, 9000, null],
        })}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={[]}
        thinkingExpanded={false}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n").map((l) => l.trim());
    // 思考段：`Thought for 9s`（独立标题，不含 grep）
    const thinkIdx = lines.findIndex((l) => l === "Thought for 9s");
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    expect(lines[thinkIdx]).not.toContain("grep");
    // 正文存在
    expect(frame).toContain("中间正文");
    // grep 段：`called grep × 1`（独立、不与思考行合并）
    const grepIdx = lines.findIndex((l) => l.includes("called grep × 1"));
    expect(grepIdx).toBeGreaterThanOrEqual(0);
    expect(grepIdx).toBeGreaterThan(thinkIdx);
    // 不存在合并形 `Thought for 9s · grep × 1`
    expect(frame).not.toContain("Thought for 9s · grep × 1");
    expect(frame).not.toContain("Thought for 9s, called grep");
    await setup.renderer.destroy();
  });

  test("思考 → web_search（signal）→ grep（noise）：标题按锚点插进内容顺序", async () => {
    // Thinking-at-bottom revision 锁句 4：落定后的上下顺序与时间线一致
    // （`Thought for` → 该段工具 → 正文 / 下一块），标题按过程块锚点
    // （contentBlockIndex）插进内容顺序，不整包甩在消息尾巴。web_search
    // 是 live signal 实卡（specs live-signal revision #4），落定卡画在
    // 思考标题之下；grep 仍走独立 called 行且在 search 卡之后。
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "查一下" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先想", signature: "s1" },
          {
            type: "tool_use",
            id: "tu-w1",
            name: "web_search",
            input: { query: "iknow tui" },
          },
          {
            type: "tool_use",
            id: "tu-g1",
            name: "grep",
            input: { path: "src", pattern: "TODO" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-w1",
            content: "search results",
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "tu-g1",
            content: "found 3 matches",
            is_error: false,
          },
        ],
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, {
          thinkingMs: [null, 6500, null],
        })}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={[]}
        thinkingExpanded={false}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n").map((l) => l.trim());
    // 思考段：`Thought for Ns`（独立标题，**绝不**含 web_search）
    const thinkIdx = lines.findIndex((l) => /^Thought for \d+s$/.test(l));
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    // 标题纯度：`Thought for` 行不含 web_search
    expect(lines[thinkIdx]).not.toContain("web_search");
    // web_search 走实卡（`Search <query>`），独立成行；按锚点顺序画在
    // 思考标题之下（锁句 4：标题插在内容锚点，不甩到消息尾）。
    expect(frame).toContain("Search iknow tui");
    const searchIdx = lines.findIndex((l) => l.includes("Search iknow tui"));
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(searchIdx).toBeGreaterThan(thinkIdx);
    // 不存在把 web_search 焊上思考标题的合并形
    const thinkLine = lines[thinkIdx];
    expect(thinkLine).not.toContain("web_search");
    expect(thinkLine).not.toContain("grep");
    expect(frame).not.toContain("called web_search");
    // grep 仍走独立 called 行，在 search 卡之后（内容顺序）
    const grepIdx = lines.findIndex((l) => l.includes("called grep × 1"));
    expect(grepIdx).toBeGreaterThanOrEqual(0);
    expect(grepIdx).toBeGreaterThan(searchIdx);
    await setup.renderer.destroy();
  });
});

describe("T6 跨消息：下一条 assistant 的思考流出现在已冻 stub 之下", () => {
  test("asst-1 settled + asst-2 live 思考：asst-2 的 Thinking… 在 asst-1 块标题之下", async () => {
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想1", signature: "s1" },
          {
            type: "tool_use",
            id: "tu-r1",
            name: "read_file",
            input: { path: "a.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-r1",
            content: "ok",
            is_error: false,
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, {
          thinkingMs: [null, 7000, null, null],
          runState: "running-fg",
        })}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={[]}
        thinkingExpanded={false}
        thinkingDraftMasked={"新思考行-A\n新思考行-B\n新思考行-C"}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n").map((l) => l.trim());
    // asst-1 块标题（已冻 stub）
    const stubIdx = lines.findIndex((l) =>
      l.includes("Thought for 7s, called read_file × 1")
    );
    expect(stubIdx).toBeGreaterThanOrEqual(0);
    // asst-2 thinking 摘要 Thinking… 在 stub 之下
    const thinkingIdx = lines.findIndex((l) => l.startsWith("Thinking"));
    expect(thinkingIdx).toBeGreaterThan(stubIdx);
    // 不修改 asst-1 块标题计数（仍 called read_file × 1，不变 × 2）
    expect(lines.filter((l) => /Thought for 7s/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /called read_file/.test(l))).toHaveLength(1);
    await setup.renderer.destroy();
  });
});

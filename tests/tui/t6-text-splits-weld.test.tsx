/** @jsxImportSource @opentui/react */
/**
 * tests/tui/t6-text-splits-weld.test.tsx
 *
 * Per specs/tui-activity-block.md S3/S7: thinking→text→quiet tool →
 * `Thought for`, the text, and `called name × N` stay three separate blocks;
 * the tool count never writes back onto the thinking line; the next
 * assistant's `Thinking…` appears below the frozen stub without modifying the
 * previous block's count.
 *
 * Acceptance points:
 *  1. Same message: thinking→text→quiet tool → three independent blocks (each
 *     with its own title); `called` never lands on the thinking title.
 *  2. Cross-message: the second assistant's thinking stream (live draft)
 *     appears below the previous block's `called`, without changing its count.
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
    // Block 1 title: thinking → `Thought for 8s` (no read_file)
    const thinkIdx = lines.findIndex((l) => l === "Thought for 8s");
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    expect(lines[thinkIdx]).not.toContain("read_file");
    // Text present
    expect(frame).toContain("中间正文");
    // Block 2 title: `called read_file × 1` (independent, not merged with thinking)
    const readIdx = lines.findIndex((l) => l.includes("called read_file × 1"));
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThan(thinkIdx);
    // No merged form `Thought for 8s · read_file × 1`
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
    // Thinking segment: `Thought for 9s` (standalone title, no grep)
    const thinkIdx = lines.findIndex((l) => l === "Thought for 9s");
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    expect(lines[thinkIdx]).not.toContain("grep");
    // Text present
    expect(frame).toContain("中间正文");
    // grep segment: `called grep × 1` (independent, not merged with the thinking line)
    const grepIdx = lines.findIndex((l) => l.includes("called grep × 1"));
    expect(grepIdx).toBeGreaterThanOrEqual(0);
    expect(grepIdx).toBeGreaterThan(thinkIdx);
    // No merged form `Thought for 9s · grep × 1`
    expect(frame).not.toContain("Thought for 9s · grep × 1");
    expect(frame).not.toContain("Thought for 9s, called grep");
    await setup.renderer.destroy();
  });

  test("思考 → web_search（signal）→ grep（noise）：标题按锚点插进内容顺序", async () => {
    // Thinking-at-bottom revision lock clause 4: after settling, vertical
    // order matches the timeline (`Thought for` → that segment's tools → text /
    // next block); titles are inserted by block anchor (contentBlockIndex)
    // rather than dumped at the message tail. web_search is a live-signal real
    // card (spec live-signal clause 4); its settled card draws under the
    // thinking title; grep stays an independent called line after the search card.
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
    // Thinking segment: `Thought for Ns` (standalone title, **never** contains web_search)
    const thinkIdx = lines.findIndex((l) => /^Thought for \d+s$/.test(l));
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    // Title purity: the `Thought for` line has no web_search
    expect(lines[thinkIdx]).not.toContain("web_search");
    // web_search renders as a real card (`Search <query>`) on its own line; by
    // anchor order it draws under the thinking title (lock clause 4: titles sit
    // at content anchors, never dumped at the message tail).
    expect(frame).toContain("Search iknow tui");
    const searchIdx = lines.findIndex((l) => l.includes("Search iknow tui"));
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(searchIdx).toBeGreaterThan(thinkIdx);
    // No merged form welding web_search onto the thinking title
    const thinkLine = lines[thinkIdx];
    expect(thinkLine).not.toContain("web_search");
    expect(thinkLine).not.toContain("grep");
    expect(frame).not.toContain("called web_search");
    // grep stays an independent called line, after the search card (content order)
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
    // asst-1 block title (frozen stub)
    const stubIdx = lines.findIndex((l) =>
      l.includes("Thought for 7s, called read_file × 1")
    );
    expect(stubIdx).toBeGreaterThanOrEqual(0);
    // asst-2's thinking summary Thinking… sits below the stub
    const thinkingIdx = lines.findIndex((l) => l.startsWith("Thinking"));
    expect(thinkingIdx).toBeGreaterThan(stubIdx);
    // asst-1 block title count unchanged (still called read_file × 1, not × 2)
    expect(lines.filter((l) => /Thought for 7s/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /called read_file/.test(l))).toHaveLength(1);
    await setup.renderer.destroy();
  });
});

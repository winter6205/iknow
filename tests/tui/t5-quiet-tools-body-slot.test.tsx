/** @jsxImportSource @opentui/react */
/**
 * tests/tui/t5-quiet-tools-body-slot.test.tsx
 *
 * Per specs/tui-activity-block.md S2–S4: adjacent quiet tools → on-screen
 * title = `Thought for Ns, calling name × N` (without thinking, just
 * `calling name × N`) + **one dim current-preview line** (the text of slot
 * kind="tool-preview"); all settled → preview gone, title `called name × N`;
 * keep / failed never enter the block count.
 *
 * Thinking-at-bottom revision (lock clauses 1–3): in the cross-segment case
 * (live noise already in history) `calling read_file × 1` is a history message
 * block (`renderBlockTitles` path), while `Thinking…` goes through the
 * unanchored thinking shell (after askLine, before Spinner) — screen order =
 * `calling ` line above, `Thinking…` below it. `Thinking…` still appears
 * exactly once (the old contract's phenomenon of thinking never being pinned
 * above the tool card no longer exists).
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
import { formatRunningToolLine } from "../../src/tui/live-tool-state.js";

const COLS = 80;
const ROWS = 36;

function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>,
  thinkingMs: ReadonlyArray<number | null>,
  runState: TuiSessionState["runState"] = "idle"
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "t5-quiet-slot",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-09-15T00:00:00.000Z",
    jsonMode: false,
    title: "t5-quiet-slot",
    cwd: "/tmp",
    sanitized_at: "2026-09-15T00:00:00.000Z",
    thinkingMs,
  };
  return { ...attachSession(file), runState };
}

describe("T5 安静工具 settled：called + 预览消失", () => {
  test("history 里的相邻 quiet tool 已完成 → 标题 `called name × N` 不含 dim 预览", async () => {
    // 12s thinking + read_file (retract / quiet) already settled
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "读一下", signature: "s1" },
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
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, [null, 12000, null])}
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
    // Title = `Thought for 12s, called read_file × 1`
    expect(frame).toContain("Thought for 12s, called read_file × 1");
    // No dim preview once settled
    const lines = frame.split("\n").map((l) => l.trim());
    const titleIdx = lines.findIndex((l) => l.includes("called read_file × 1"));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    // The next line must not be a preview (settled read_file has no preview slot)
    const next = lines[titleIdx + 1] ?? "";
    expect(next).not.toMatch(/⎿|│/);
    await setup.renderer.destroy();
  });
});

describe("T5 live running 安静工具：calling + 一行 dim 预览", () => {
  test("live run.status=running noise (grep) → 标题 `calling grep × 1` + 预览槽", async () => {
    // Spec live-signal revision clause 3: grep is still live noise → enters the
    // unanchored block (block title + preview slot). This test pins "noise
    // still takes the original calling path".
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "搜一下" }] },
    ];
    const liveRuns: ReadonlyArray<LiveToolRun> = [
      {
        id: "tu-g1",
        name: "grep",
        status: "running",
        input: { pattern: "foo" },
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, [null])}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={liveRuns}
        thinkingExpanded={false}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // Noise still takes the calling path.
    expect(frame).toContain("calling grep × 1");
    const expectedPreview = formatRunningToolLine(liveRuns[0]!);
    expect(frame).toContain(expectedPreview);
    await setup.renderer.destroy();
  });

  test("live run.status=running web_search → 'Search' 实卡一行 dim，NOT 在块标题里", async () => {
    // Spec live-signal revision clause 4: web_search / web_fetch render as real
    // cards — the block title must not contain `calling web_search`, but the
    // tail card line produced by `formatRunningToolLine` (with
    // `Search <query>`) should be visible.
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "搜一下" }] },
    ];
    const liveRuns: ReadonlyArray<LiveToolRun> = [
      {
        id: "tu-w1",
        name: "web_search",
        status: "running",
        input: { query: "今天的AI新闻" },
        detail: "搜索 今天的AI新闻",
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, [null])}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={liveRuns}
        thinkingExpanded={false}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // Block title has no web_search count (spec live-signal clause 4).
    expect(frame.includes("calling web_search")).toBe(false);
    expect(frame.includes("called web_search")).toBe(false);
    // Tail card = `formatRunningToolLine` output (one dim line with `Search <query>`).
    const expectedPreview = formatRunningToolLine(liveRuns[0]!);
    expect(frame).toContain(expectedPreview);
    expect(frame).toContain("Search");
    await setup.renderer.destroy();
  });
});

describe("T5 keep 工具块外实卡：不进块计数", () => {
  test("bash（keep）+ 思考 → 标题只 `Thought for Ns`，不出现 `bash`", async () => {
    // bash is keep class → not welded into the block → the block title carries
    // only the thinking duration; bash renders as a real card outside the block.
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "跑 ls" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "列目录", signature: "s1" },
          {
            type: "tool_use",
            id: "tu-b1",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-b1",
            content: "a.txt\nb.txt",
            is_error: false,
          },
        ],
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, [null, 9000, null])}
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
    expect(frame).toContain("Thought for 9s");
    // bash keep never enters the block → no `bash × N` count line
    expect(frame).not.toContain("bash × ");
    expect(frame.includes("called bash")).toBe(false);
    expect(frame.includes("calling bash")).toBe(false);
    await setup.renderer.destroy();
  });
});

describe("live 收类已进 history 仍须 calling + 细节行", () => {
  test("assistant 已含 tool_use、live 仍 running → calling + 预览、`Thinking…` 唯一一份且在历史块之下", async () => {
    // Thinking-at-bottom revision: in this scenario the noise is already in
    // history (live run id hits a history tool_use → excluded by
    // `appendLiveBlocks` dedupe) — `calling read_file × 1` is a history message
    // block (`renderBlockTitles` path), `Thinking…` goes through the
    // unanchored thinking shell (after askLine, before Spinner). Exactly one
    // `Thinking…` on screen and not above `calling read_file × 1` (split by
    // TranscriptTail): screen order = history block title above, `Thinking…`
    // below. The draft `THINK-DRAFT-PEEK-WINDOW` renders through the
    // `thinkingPeekLines` collapsed preview window.
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "读 a.ts" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先读文件", signature: "s1" },
          {
            type: "tool_use",
            id: "tu-r-live",
            name: "read_file",
            input: { path: "a.ts" },
          },
        ],
      },
    ];
    const liveRuns: ReadonlyArray<LiveToolRun> = [
      {
        id: "tu-r-live",
        name: "read_file",
        status: "running",
        input: { path: "a.ts" },
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, [null, 8000], "running-fg")}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={liveRuns}
        thinkingExpanded={false}
        thinkingDraftMasked={"THINK-DRAFT-PEEK-WINDOW"}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("calling read_file × 1");
    expect(frame.includes("called read_file")).toBe(false);
    expect(frame).toContain(formatRunningToolLine(liveRuns[0]!));
    // Thinking-at-bottom revision: exactly one `Thinking…`, never above the
    // history block title — screen-order contract (call block → askLine →
    // thinking → Spinner).
    const thinkingCount = frame.split("Thinking…").length - 1;
    expect(thinkingCount).toBe(1);
    expect(frame.indexOf("Thinking…")).toBeGreaterThan(
      frame.indexOf("calling read_file × 1")
    );
    // Draft goes through the `thinkingPeekLines` collapsed preview — sentinel text visible.
    expect(frame).toContain("THINK-DRAFT-PEEK-WINDOW");
    await setup.renderer.destroy();
  });
});

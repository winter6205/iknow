/** @jsxImportSource @opentui/react */
/**
 * tests/tui/t5-quiet-tools-body-slot.test.tsx
 *
 * T5 (plans/tui-activity-block.md T5 + specs/tui-activity-block.md S2–S4)：
 * 相邻安静工具 → 屏上标题 = `Thought for Ns, calling name × N`（无思考则
 * 只有 `calling name × N`）+ **一行 dim 当前预览**（slot kind="tool-preview"
 * 的 text）；全结束 → 预览消失、标题 `called name × N`；keep / 失败不进
 * 块计数。
 *
 * Thinking-at-bottom revision（plans/tui-thinking-at-bottom.md 锁句 1–3）：
 * 跨段用例（live noise 已进 history）里 `calling read_file × 1` 是历史
 * 消息块（`renderBlockTitles` 路径），`Thinking…` 走 unanchored thinking
 * 壳（askLine 之后、Spinner 之前）—— 屏序 = `calling ` 行之上、`Thinking…`
 * 在它之下。屏上 `Thinking…` 仍仅出现一次（旧合同要求思考不被钉在工具
 * 卡上方的现象不复存在）。
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
    // 思考 12s + read_file（retract / 安静）已 settled
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
    // 标题 = `Thought for 12s, called read_file × 1`
    expect(frame).toContain("Thought for 12s, called read_file × 1");
    // settled 时不再画 dim 预览
    const lines = frame.split("\n").map((l) => l.trim());
    const titleIdx = lines.findIndex((l) => l.includes("called read_file × 1"));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    // 紧下一行不应是预览（read_file settled 没有 preview slot）
    const next = lines[titleIdx + 1] ?? "";
    expect(next).not.toMatch(/⎿|│/);
    await setup.renderer.destroy();
  });
});

describe("T5 live running 安静工具：calling + 一行 dim 预览", () => {
  test("live run.status=running noise (grep) → 标题 `calling grep × 1` + 预览槽", async () => {
    // specs live-signal revision #3：grep 仍属 live noise → 进 unanchored
    // 块（块标题 + 预览槽）。本测试钉「noise 仍走原 calling 路径」。
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
    // noise 仍走 calling 路径。
    expect(frame).toContain("calling grep × 1");
    const expectedPreview = formatRunningToolLine(liveRuns[0]!);
    expect(frame).toContain(expectedPreview);
    await setup.renderer.destroy();
  });

  test("live run.status=running web_search → 'Search' 实卡一行 dim，NOT 在块标题里", async () => {
    // specs live-signal revision #4：web_search / web_fetch 走实卡 —
    // 块标题不出现 `calling web_search`，但 `formatRunningToolLine` 产出的
    // tail 卡行（含 `Search <query>`）应可见。
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
    // 块标题不出现 web_search 计数（spec live-signal #4）。
    expect(frame.includes("calling web_search")).toBe(false);
    expect(frame.includes("called web_search")).toBe(false);
    // tail 卡 = `formatRunningToolLine` 输出（含 `Search <query>` 一行 dim）。
    const expectedPreview = formatRunningToolLine(liveRuns[0]!);
    expect(frame).toContain(expectedPreview);
    expect(frame).toContain("Search");
    await setup.renderer.destroy();
  });
});

describe("T5 keep 工具块外实卡：不进块计数", () => {
  test("bash（keep）+ 思考 → 标题只 `Thought for Ns`，不出现 `bash`", async () => {
    // bash 是 keep class → 不焊入块 → 块标题只贴思考时长，bash 走块外实卡。
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
    // bash keep 不进块 → `bash × N` 这种计数行不出现
    expect(frame).not.toContain("bash × ");
    expect(frame.includes("called bash")).toBe(false);
    expect(frame.includes("calling bash")).toBe(false);
    await setup.renderer.destroy();
  });
});

describe("live 收类已进 history 仍须 calling + 细节行", () => {
  test("assistant 已含 tool_use、live 仍 running → calling + 预览、`Thinking…` 唯一一份且在历史块之下", async () => {
    // Thinking-at-bottom revision：本场景 noise 已进 history（live run
    // id 命中历史 tool_use → `appendLiveBlocks` dedupe 排除）—— `calling
    // read_file × 1` 是历史消息块（`renderBlockTitles` 路径），`Thinking…`
    // 走 unanchored thinking 壳（askLine 之后、Spinner 之前）。屏上
    // `Thinking…` 仅一份且不在 `calling read_file × 1` 之上（已被
    // TranscriptTail 拆开）：屏序 = 历史块标题之上、`Thinking…` 在下。
    // 草稿 `THINK-DRAFT-PEEK-WINDOW` 走 `thinkingPeekLines` 折叠预览窗口。
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
    // Thinking-at-bottom revision：`Thinking…` 唯一一份，且不在历史块
    // 标题之上 —— 屏序合同（call 块 → askLine → 思考 → Spinner）。
    const thinkingCount = frame.split("Thinking…").length - 1;
    expect(thinkingCount).toBe(1);
    expect(frame.indexOf("Thinking…")).toBeGreaterThan(
      frame.indexOf("calling read_file × 1")
    );
    // 草稿走 `thinkingPeekLines` 折叠预览窗口 —— 哨兵文本可见。
    expect(frame).toContain("THINK-DRAFT-PEEK-WINDOW");
    await setup.renderer.destroy();
  });
});

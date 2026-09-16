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
 * 验收点：
 *  1. settled 块（运行中已结束）→ 标题 `called name × N`、预览消失。
 *  2. live 块（仍有 run.status === "running"）→ 标题 `calling name × N`、
 *     一行 dim 预览（`formatRunningToolLine` 输出）出现在标题之下。
 *  3. keep 工具（bash）不焊入块计数 → 标题里不出现 `bash`。
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
  thinkingMs: ReadonlyArray<number | null>
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
  return attachSession(file);
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
  test("live run.status=running → 标题 `calling name × N` + 预览槽 formatRunningToolLine", async () => {
    // 已落定的 history（read_file 完成）+ live 阶段的 running web_search
    // → 第二块为 live 块：标题 `called read_file × 1`（历史已 settle），
    // 第三块（live anchor 在 messages.length 处）以 unanchoredBlocks 进 tail
    // 路径 —— 本测试只验证 unanchored 渲染路径（tail 不在本切片范围）。
    // 改为：纯 live 场景（messages 全 settled，liveToolRuns 给一个 running）。
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
    // live 块标题 = `calling web_search × 1`
    expect(frame).toContain("calling web_search × 1");
    // 一行 dim 预览（formatRunningToolLine 输出含 `⎿` 或 `Searching`）
    const expectedPreview = formatRunningToolLine(liveRuns[0]!);
    expect(frame).toContain(expectedPreview);
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

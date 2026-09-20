/** @jsxImportSource @opentui/react */
/**
 * tests/tui/thinking-fold-placement.test.tsx
 *
 * Invariant (docs/CONTEXT.md `unit fold`, operator correction): thinking folds
 * **in place per segment** — a thinking segment completes → folds into one
 * `Thought for <duration>` line at its own position → then text or tools;
 * the next thinking segment within the same user task folds another line.
 * Seconds come from the corresponding assistant message's own thinkingMs
 * (per-message parallel array), never merged across segments:
 *  (a) each segment with seconds draws its own `Thought for <duration>`;
 *      segments without seconds draw no such line and never fall back to
 *      `[思考]` ("[thinking]") (only the tool-count line, if retract is present);
 *  (b) the final assistant's seconds must not be pasted onto an earlier
 *      segment / trailing tool cluster (the old thinking-fold-placement
 *      fallback was a misreading and has been deleted);
 *  (c) multiple tool clusters (tool → text → tool) inside one assistant
 *      message share the same thinkingMs → no duplicate within the message
 *      (dedup unit = repeated display within one message, not "at most once
 *      per turn");
 *  (d) per-message ThinkingSummary and the fold line must not draw the same
 *      seconds twice;
 *  (e) while the turn is still running, the earlier segment's settled tool
 *      fold line survives after the next thinking segment begins.
 *
 * Data ground truth: loop-engine passes `turnResult.thinkingMs` once per
 * assistant commit point (src/harness/loop-engine.ts:2021-2025); the
 * thinkingMs parallel array is index-aligned with messages — each assistant
 * message independently owns its thinking duration; history sessions rebuild
 * the same parallel array via session-api/store/jsonl.
 */
import { expect, test } from "bun:test";
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
const ROWS = 36;

function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>,
  thinkingMs: ReadonlyArray<number | null>,
  runState: "idle" | "running-fg" = "idle"
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "thinking-fold-placement",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-09-08T00:00:00.000Z",
    jsonMode: false,
    title: "thinking-fold-placement",
    cwd: "/tmp",
    sanitized_at: "2026-09-08T00:00:00.000Z",
    thinkingMs,
  };
  return runState === "idle"
    ? attachSession(file)
    : { ...attachSession(file), runState };
}

test("两轮思考→工具:跨消息不合并,每条 assistant 自有块 + 各自 Thought for <自己的 ms>", async () => {
  // Invariant (specs/tui-activity-block.md S5 "new message opens new block" +
  // the decision-table rewrite entry): tool clusters no longer merge across
  // messages — each assistant owns its process block; asst-1's own thinkingMs
  // stays in its own block title; asst-final's thinkingMs must not bleed into
  // asst-1; bash keep still never folds in (counter-proposition: keep is not counted).
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "多步任务" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "中段思考-1", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "最终思考", signature: "s2" },
        {
          type: "tool_use",
          id: "tu-2",
          name: "bash",
          input: { command: "pwd" },
        },
        { type: "text", text: "完成总结" },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-2", content: "ok" }],
    },
  ];
  // messages: user(0) asst-1(1) tool_result(2) asst-final(3) tool_result(4)
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    12000, // asst-1's own 12s
    null,
    30000, // asst-final's own 30s
    null,
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // (1) asst-1 block = `Thought for 12s, called read_file × 1` (welded:
  //     thinking + adjacent read_file retract, no text / keep / failure between).
  const think12Idx = lines.findIndex((l) => l.includes("Thought for 12s"));
  expect(think12Idx).toBeGreaterThanOrEqual(0);
  expect(lines[think12Idx]).toContain("read_file × 1");
  // (2) asst-final block = `Thought for 30s` (thinking followed by bash keep;
  //     keep does not weld in; duration-only segment).
  const think30Idx = lines.findIndex((l) => l.includes("Thought for 30s"));
  expect(think30Idx).toBeGreaterThanOrEqual(0);
  expect(think30Idx).toBeGreaterThan(think12Idx);
  // (3) bash keep never enters the fold count → no `bash × N` line allowed.
  expect(lines.findIndex((line) => line.includes("bash × "))).toBe(-1);
  // (4) 「完成总结」("summary done") appears near asst-final (asst-final's own
  //     text); per spec the block title is pinned at the message end (after
  //     MessageBlocks), so the summary line may come before or after the 30s
  //     line, but must share the asst-final region (after think12).
  const summaryIdx = lines.findIndex((line) => line.includes("完成总结"));
  expect(summaryIdx).toBeGreaterThan(think12Idx);
  expect(summaryIdx).not.toBe(-1);
  // (5) Seconds stay in their own segments: 12s appears once in asst-1, 30s once in asst-final.
  expect(lines.filter((l) => /Thought for \d+s/.test(l))).toHaveLength(2);
  await setup.renderer.destroy();
});

test("多段各自持有 thinkingMs:时长按各自 anchor 严格归属,不串位不重复", async () => {
  // Invariants (a)(d): thinkingMs is a persisted per-message parallel array;
  // each assistant message independently owns its ms. Under the cross-message
  // tool-cluster projection (anchor moves to the latest assistant), the
  // cluster fold line takes the anchor's own duration (25s); the earlier
  // segment (asst-1)'s 12s is carried in place by its per-message
  // ThinkingSummary — 12s must not be pasted onto the final cluster, 25s must
  // not drift to asst-1's position; each appears once, ordered like the messages.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考1", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-a",
          name: "read_file",
          input: { path: "a" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-a", content: "ok" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考2", signature: "s2" },
        {
          type: "tool_use",
          id: "tu-b",
          name: "bash",
          input: { command: "ls" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-b", content: "ok" }],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    12000, // asst-1: 12s
    null,
    25000, // asst-2: 25s
    null,
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // (1) `Thought for 12s` and `Thought for 25s` each appear once, in message order.
  //     New contract: each assistant owns its block, no cross-message merging.
  const think12Idx = lines.findIndex((line) =>
    line.includes("Thought for 12s")
  );
  const think25Idx = lines.findIndex((line) =>
    line.includes("Thought for 25s")
  );
  expect(think12Idx).toBeGreaterThanOrEqual(0);
  expect(think25Idx).toBeGreaterThanOrEqual(0);
  expect(think12Idx).toBeLessThan(think25Idx);
  // (2) Exactly two duration lines (once per segment, no duplicates; no Chinese residue).
  expect(lines.filter((l) => /Thought for \d+s/.test(l))).toHaveLength(2);
  expect(frame.includes("思考了")).toBe(false);
  // (3) asst-1's read_file retract welds onto asst-1's own block title
  //     (`Thought for 12s, called read_file × 1`); bash keep stays out of the block.
  const readIdx = lines.findIndex((line) => line.includes("read_file × 1"));
  expect(readIdx).toBeGreaterThanOrEqual(0);
  expect(lines[readIdx]).toContain("Thought for 12s");
  expect(lines.findIndex((line) => line.includes("bash × "))).toBe(-1);
  await setup.renderer.destroy();
});

test("final 仅有 text:其思考时长由 per-message ThinkingSummary 原位承担,不外挂到前段折叠行", async () => {
  // Invariant (b): final contains only text (no tool_use) → no final-side
  // tools cluster; the earlier read_file cluster, by its own anchor (no ms),
  // draws only the count line. Final's 30s displays in place in its own
  // message block (per-message ThinkingSummary), never pasted onto the
  // earlier read_file fold line (leftover of the old fallback), and never
  // lost — so the earlier count line carries **no** duration segment (the two
  // lines never weld).
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考", signature: "s" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "read_file",
          input: { path: "a" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: JSON.stringify({ code: 0, stdout: "body", stderr: "" }),
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "最终总结思考", signature: "s2" },
        { type: "text", text: "完成" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, null, null, 30000];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // (1) `Thought for 30s` exactly once, value = final's own thinkingMs.
  const thinkLines = lines.filter((l) => /Thought for \d+s/.test(l));
  expect(thinkLines).toHaveLength(1);
  expect(thinkLines[0]).toContain("Thought for 30s");
  // (2) The earlier fold line is count-only (final's duration not welded); the duration line comes after it.
  const readCountIdx = lines.findIndex((line) =>
    line.includes("read_file × 1")
  );
  const thinkIdx = lines.findIndex((line) => line.includes("Thought for 30s"));
  expect(readCountIdx).toBeGreaterThanOrEqual(0);
  expect(thinkIdx).toBeGreaterThan(readCountIdx);
  expect(lines[readCountIdx]).not.toContain("Thought for");
  // (3) No `[思考]` ("[thinking]") fallback.
  expect(frame.includes("[思考]")).toBe(false);
  await setup.renderer.destroy();
});

test("hidden agent_status 插在 tool_result 与 final 之间：thinkingMs 按盘上消息下标取值,各段秒数不丢", async () => {
  // Invariant (a): session.thinkingMs is index-aligned with messages; when
  // ChatView uses a filtered visibleIndex it must map back to the on-disk
  // index, otherwise final's 30s reads the status slot's null and
  // `Thought for` vanishes. The earlier fold line (no ms) draws the count
  // line only; final's duration displays in place.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读文件", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<agent_status>\nlast_tool: read_file\n</agent_status>",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "最终总结思考", signature: "s2" },
        { type: "text", text: "完成总结" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    null,
    null,
    null,
    30000,
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("完成总结");
  expect(frame).toContain("Thought for 30s");
  expect(frame).toContain("read_file × 1");
  expect(frame.includes("先读文件")).toBe(false);
  await setup.renderer.destroy();
});

test("hidden agent_status + 仅 keep 工具：无 retract 计数行时,仍要画出 `Thought for`", async () => {
  // Invariant (a): bash is keep → not in the fold count; final's 12s is
  // carried in place by the per-message ThinkingSummary (with an index-mapping
  // bug the whole line vanishes).
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "跑一下", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-bash",
          name: "bash",
          input: { command: "pwd" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-bash", content: "ok" }],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<agent_status>\nlast_tool: bash\n</agent_status>",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "收尾", signature: "s2" },
        { type: "text", text: "目录如下" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    null,
    null,
    null,
    12000,
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("目录如下");
  expect(frame).toContain("bash");
  expect(frame).toContain("Thought for 12s");
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});

test("running 中间态:前段已落定的工具折叠行,在后段思考开始后仍在", async () => {
  // Invariant (e): within one user task, asst-1's read_file cluster has already
  // settled and folded its count line; when the next thinking segment starts
  // streaming (live thinking draft non-empty), the earlier fold line must not
  // be swallowed by the running gate or the live panel — completed units fold
  // as usual, each segment draws its own.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读文件", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-rd",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-rd", content: "ok" }],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, 8000, null];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs, "running-fg")}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={[]}
      thinkingExpanded={false}
      thinkingDraftMasked="第二段思考流式进行中"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // The earlier segment's settled fold line is still there (retract count).
  expect(frame).toContain("read_file × 1");
  // No `[思考]` fallback; the earlier thinking body (folded) stays unfolded.
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame.includes("先读文件")).toBe(false);
  await setup.renderer.destroy();
});

test("多段渲染 (content-order)：text 段无 fold 行但 message 的 thinkingMs 已被 tools 段 fold 行覆盖 → text 段不重复画 ThinkingSummary", async () => {
  // Invariant (d) hardened for content-order: one assistant splits into
  // multiple segments (text → tools); once the tools segment's fold line
  // already shows `Thought for Ns · read_file × 1`, the text segment
  // (partIndex===0, carries thinkingSeconds) must **not** draw another
  // standalone `Thought for Ns`. When message-row.tsx was split, it hardcoded
  // `messageThinkingMs` to 0 for TurnFoldSegment, disabling the
  // `shownThinkingMsValues.has(...)` clause in the content-order branch → the
  // text segment's ThinkingSummary stopped deduping → two `Thought for Ns`
  // lines on screen (one fold line, one summary).
  //
  // Fixture: the assistant itself carries `thinking + text + tool_use(read_file)`,
  // tool_result follows. activitySegments = [text(0), tools(1)] →
  // renderInContentOrder takes the content-order branch → text segment is
  // partIndex 0 (carries thinkingSeconds), tools segment is partIndex 1 (does not).
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想一下", signature: "s" },
        { type: "text", text: "先说结论" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "read_file",
          input: { path: "a" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, 12000, null];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // (1) `Thought for 12s` appears exactly once: welded on the same line of
  //     the tools-segment fold line (`Thought for 12s · read_file × 1`); the
  //     text segment's ThinkingSummary must be hidden (in message-row.tsx's
  //     TurnFoldSegment, hideSegmentThinking runs
  //     `messageThinkingMs > 0 && shownThinkingMsValues.has(...)`).
  const thinkLines = lines.filter((l) => /Thought for \d+s/.test(l));
  expect(thinkLines).toHaveLength(1);
  expect(thinkLines[0]).toContain("Thought for 12s");
  // (2) The read_file count line must be present (on the content-order path the fold line hangs on the tools segment).
  expect(frame).toContain("read_file × 1");
  // (3) The text segment body is still there (hideThinking removes only ThinkingSummary, never the text block).
  expect(frame).toContain("先说结论");
  await setup.renderer.destroy();
});

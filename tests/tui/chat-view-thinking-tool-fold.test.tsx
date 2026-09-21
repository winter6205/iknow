/** @jsxImportSource @opentui/react */
/**
 * Settled-state folding:
 *  - the fold count line aggregates only successful retract entries
 *    (inFoldCount === true);
 *  - keep (bash / write / edit) keeps title + preview; accent / failed get a
 *    standalone title line;
 *  - zero retract entries → no tool-count line (the thinking-seconds line
 *    may stand alone);
 *  - running retract entries are carried by the unanchored activity block
 *    (`deriveActivityBlocks` single source: `calling name × N` title + one
 *    dim preview slot); keep / accent / failed entries still keep their
 *    per-entry titles (real cards outside the block);
 *  - fold-cluster thinking seconds = the persisted thinkingMs of that
 *    message (converted via `thinkingMsToSeconds`, never summed across
 *    messages).
 *
 * Rendering consumes only deriveSlot's slot — message-blocks self-manages
 * title / preview / fold; ChatView no longer passes combined switches.
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
  thinkingMs?: ReadonlyArray<number | null>
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "think-tool-fold",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-08-28T00:00:00.000Z",
    jsonMode: false,
    ...(thinkingMs !== undefined ? { thinkingMs } : {}),
  };
  return attachSession(file);
}

function bashTurn(
  id: string,
  thinking: string,
  command: string
): ReadonlyArray<AnthropicNativeMessage> {
  return [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking, signature: `sig-${id}` },
        {
          type: "tool_use",
          id,
          name: "bash",
          input: { command },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
    },
  ];
}

function toolResultMessage(id: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  };
}

/** Mirrors a user screenshot: one query + several think→bash turns + a final
 *  thinking-then-answer message. */
function interleavedThinkingToolMessages(): AnthropicNativeMessage[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "发子代理，让他在归内文件夹写一个神圣礼堂的HTML",
        },
      ],
    },
    ...bashTurn("tu-1", "先看项目根", "ls -la /home/winner/projects/iknow/"),
    ...bashTurn("tu-2", "再看 src", "ls /home/winner/projects/iknow/src/"),
    ...bashTurn("tu-3", "再看 web", "ls /home/winner/projects/iknow/web/"),
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "没找到归内目录，准备回答",
          signature: "sig-final",
        },
        {
          type: "text",
          text: "「归内」我没找到对应的目录",
        },
      ],
    },
  ];
}

/** thinkingMs is 1:1 with messages. null = no thinkingMs at that position;
 *  number(ms) = that assistant turn's thinking duration. The three bashTurns'
 *  thinkingMs sit at index 1, 3, 5 (the final assistant's thinking at
 *  index 7). */
function thinkingMsForInterleaved(
  values: ReadonlyArray<number | null>
): ReadonlyArray<number | null> {
  // messages: [user(0), asst-1(1), user-result(2), asst-2(3), user-result(4),
  //            asst-3(5), user-result(6), asst-final(7)]
  // values align with assistant messageIndex: values[0] → index 1,
  // values[1] → index 3, values[2] → index 5, values[3] → index 7.
  const anchors = [1, 3, 5, 7] as const;
  const out: Array<number | null> = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  for (const [idx, v] of values.entries()) {
    if (v === undefined) continue;
    const anchor = anchors[idx];
    if (anchor === undefined) continue;
    out[anchor] = v;
  }
  return out;
}

test("idle：思考秒数 + 多轮 bash keep → 标题留、零条收无计数行", async () => {
  // bash is keep-class: once settled its title lines stay per-entry; this
  // turn has zero retract entries → no tool-count line. The thinking-seconds
  // line still renders per cluster from persisted thinkingMs.
  const setup = await testRender(
    <ChatView
      session={sessionWith(
        interleavedThinkingToolMessages(),
        thinkingMsForInterleaved([9000, 9000, 9000, 2000])
      )}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // keep title lines visible per entry (successful bash): no `[完成]`
  // ("done") prefix.
  expect(frame).toContain("bash · ");
  // Zero retract entries → no tool-count line.
  expect(frame.includes("× ")).toBe(false);
  // Invariant: success state has no `[完成]` ("done") prefix.
  expect(frame.includes("[完成]")).toBe(false);
  // The thinking-seconds line is still there (cluster thinkingMs; the thinking
  // line may stand alone).
  expect(frame).toContain("Thought for 2s");
  expect(frame.includes("[思考]")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：两轮 bash keep → 两轮各自标题留，零条收无计数行（spec D3 全轮生效）", async () => {
  // Two rounds: each has a user query + assistant(thinking + bash) +
  // tool_result user.
  // thinkingMs = [null, 4000, null, 6000, null] (assistant thinking 4s / 6s).
  // The bash keep title stays in both rounds; zero retract → no count line.
  const messages: AnthropicNativeMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "第一轮提问" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一轮思考", signature: "s1" },
        { type: "tool_use", id: "tu-1", name: "bash", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
    },
    { role: "user", content: [{ type: "text", text: "第二轮提问" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第二轮思考", signature: "s2" },
        { type: "tool_use", id: "tu-2", name: "bash", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-2", content: "ok" }],
    },
  ];
  // messages length 6: asst-1 at index 1, asst-2 at index 4.
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    4000,
    null,
    null,
    6000,
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
  // Each round gets its own thinking-seconds line with its own thinkingMs.
  expect(frame).toContain("Thought for 4s");
  expect(frame).toContain("Thought for 6s");
  // keep titles stay in both rounds (applies to all rounds; old-round titles
  // never vanish): success state has no `[完成]` ("done") prefix; a bash
  // title line starts with `bash` (just `bash` when detail is empty,
  // `bash · ...` otherwise). Count bare `bash` title lines (excluding `× `
  // count lines and seconds lines).
  const bashLines = frame
    .split("\n")
    .filter(
      (l) =>
        /^\s*bash(\s|$)/.test(l) && !l.includes("× ") && !l.includes("思考")
    );
  expect(bashLines.length).toBe(2);
  // Zero retract entries → no tool-count line.
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：单工具无 thinkingMs（落盘缺席） → bash keep 标题留、无计数行", async () => {
  // bash is keep-class: rounds without seconds draw no thinking line (no
  // persisted thinkingMs) but keep their title line — the fold count only
  // counts retract entries, bash is not in it.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu-solo", name: "bash", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-solo", content: "ok" }],
    },
  ];
  // All-null thinkingMs (simulates a legacy file / no persisted thinkingMs).
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, null, null])}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // Success state has no `[完成]` ("done") prefix; a bash title line starts
  // with `bash` (just `bash` when detail is empty, `bash · ...` otherwise).
  expect(frame).toContain("bash");
  expect(frame.includes("× ")).toBe(false);
  expect(frame.includes("[完成]")).toBe(false);
  // No seconds → no `Thought for` line.
  expect(frame.includes("Thought for")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：旧会话无 thinkingMs（整链缺席） → bash keep 标题留、无秒数行", async () => {
  // Legacy session: the file carries no thinkingMs (SessionFileV1.thinkingMs
  // undefined). attachSession passes undefined through → session.thinkingMs =
  // undefined → missing thinkingMs counts as 0 → no seconds line; the keep
  // title line stays.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x", signature: "s" },
        { type: "tool_use", id: "tu-legacy", name: "bash", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-legacy", content: "ok" },
      ],
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // Success state has no `[完成]` ("done") prefix; a bash title line starts
  // with `bash`.
  expect(frame).toContain("bash");
  expect(frame.includes("× ")).toBe(false);
  expect(frame.includes("[完成]")).toBe(false);
  expect(frame.includes("Thought for")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：文本→工具时，keep 标题出现在前置文本之后", async () => {
  // The bash keep title renders after the preceding text, in content order
  // (slot consumption, no count line).
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "text", text: "先说明" }] },
    ...bashTurn("tu-after-text", "思考工具", "pwd"),
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, null, 29000, null])}
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
  const textIdx = lines.findIndex((line) => line.includes("先说明"));
  // No `[完成]` ("done") prefix in success state → match the bash title line.
  const titleIdx = lines.findIndex((line) => /^\s*bash\b/.test(line));
  expect(textIdx).toBeGreaterThanOrEqual(0);
  expect(titleIdx).toBeGreaterThan(textIdx);
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：工具→文本时，keep 标题出现在后续文本之前", async () => {
  // The bash keep title renders before the following text, in content order.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    ...bashTurn("tu-before-text", "先调用工具", "pwd"),
    {
      role: "assistant",
      content: [{ type: "text", text: "后续总结" }],
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, 29000, null, null])}
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
  // No `[完成]` ("done") prefix in success state → match the bash title line.
  const titleIdx = lines.findIndex((line) => /^\s*bash\b/.test(line));
  const textIdx = lines.findIndex((line) => line.includes("后续总结"));
  expect(titleIdx).toBeGreaterThanOrEqual(0);
  expect(textIdx).toBeGreaterThanOrEqual(0);
  expect(titleIdx).toBeLessThan(textIdx);
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：同一 assistant 消息内按 tool/text 位置渲染 keep 标题", async () => {
  const renderCase = async (
    content: AnthropicNativeMessage["content"],
    thinkingMsValue: number,
    text: string
  ) => {
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content },
      ...content
        .filter(
          (
            block
          ): block is Extract<
            AnthropicNativeMessage["content"][number],
            { type: "tool_use" }
          > => block.type === "tool_use"
        )
        .map((block) => toolResultMessage(block.id)),
    ];
    // assistant at index 1 → thinkingMs[1] = value.
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, [null, thinkingMsValue, null, null])}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        thinkingExpanded={false}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const lines = setup.captureCharFrame().split("\n");
    const textIdx = lines.findIndex((line) => line.includes(text));
    // No `[完成]` ("done") prefix in success state → match bash title lines.
    const titleIndices = lines.flatMap((line, index) =>
      /^\s*bash\b/.test(line) ? [index] : []
    );
    return { setup, textIdx, titleIndices };
  };

  // tool_then_text: tool before text within one assistant → keep title
  // before the text. Rendering consumes slots in content-block order — the
  // title sits exactly where the tool_use block is.
  const toolThenText = await renderCase(
    [
      { type: "tool_use", id: "tu-same-1", name: "bash", input: {} },
      { type: "text", text: "tool-text 总结" },
    ],
    29000,
    "tool-text 总结"
  );
  expect(toolThenText.titleIndices).toHaveLength(1);
  expect(toolThenText.titleIndices[0]).toBeLessThan(toolThenText.textIdx);
  await toolThenText.setup.renderer.destroy();

  const toolTextTool = await renderCase(
    [
      { type: "tool_use", id: "tu-same-2", name: "bash", input: {} },
      { type: "text", text: "tool-text-tool 总结" },
      { type: "tool_use", id: "tu-same-3", name: "bash", input: {} },
    ],
    29000,
    "tool-text-tool 总结"
  );
  expect(toolTextTool.titleIndices).toHaveLength(2);
  expect(toolTextTool.titleIndices[0]).toBeLessThan(toolTextTool.textIdx);
  expect(toolTextTool.titleIndices[1]).toBeGreaterThan(toolTextTool.textIdx);
  await toolTextTool.setup.renderer.destroy();
});

test("idle：同一 assistant 消息拆成两个 tools 簇 → `Thought for` 不重复画（同消息去重）", async () => {
  // CONTEXT.md unit fold: one thinking stretch → one duration line; the
  // dedup unit is repetition inside the same message. tool → text → tool
  // inside one assistant message splits into two tools clusters whose anchor
  // is the same messageIndex → same cluster duration → without dedup the same
  // duration would be painted twice. Different assistant messages never
  // swallow each other (see thinking-fold-placement.test.tsx: each segment
  // draws its own).
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一段思考", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-m1",
          name: "bash",
          input: { command: "pwd" },
        },
        { type: "text", text: "中段说明" },
        {
          type: "tool_use",
          id: "tu-m2",
          name: "bash",
          input: { command: "ls" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-m1", content: "ok" },
        { type: "tool_result", tool_use_id: "tu-m2", content: "ok" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, 29000, null];
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
  const foldSecondsLines = frame
    .split("\n")
    .filter((l) => /Thought for \d+s/.test(l));
  expect(foldSecondsLines).toHaveLength(1);
  await setup.renderer.destroy();
});

test("idle：无秒数（thinkingMs 全 null）→ 无 `Thought for` 行、无 [思考] 回落、无思考正文", async () => {
  // CONTEXT.md unit fold: no seconds (thinkingMs absent / non-finite) → draw
  // no such line, no fallback to `[思考]` ("thinking"), and no thinking body
  // (folded state stays collapsed).
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "不该被看见的思考正文", signature: "s1" },
        { type: "text", text: "回答正文" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, null, null];
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
  expect(frame.includes("Thought for")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame.includes("不该被看见的思考正文")).toBe(false);
  // The answer body stays visible as usual.
  expect(frame).toContain("回答正文");
  await setup.renderer.destroy();
});

test("idle：Ctrl+O 展开 → 思考正文可见", async () => {
  // CONTEXT.md unit fold: the thinking body is collapsed by default; Ctrl+O
  // reveals the thinking plaintext regardless of persisted thinkingMs.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "展开后可见的思考正文", signature: "s1" },
        { type: "text", text: "回答正文" },
      ],
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, null, null])}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={true}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("展开后可见的思考正文");
  expect(frame).toContain("回答正文");
  await setup.renderer.destroy();
});

test("idle：无历史 activity 时已完成 live retract 工具收出 tail（keep 留标题）", async () => {
  // Completed retract (read_file) folds into the count and leaves the tail;
  // keep (bash) holds its own title — the tail must not show the live
  // completion form with a `· ok` suffix. The count line anchors after the
  // nearest text segment (draft segment).
  const setup = await testRender(
    <ChatView
      session={sessionWith([
        {
          role: "user",
          content: [{ type: "text", text: "q" }],
        },
      ])}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={[
        {
          id: "tu-live-completed",
          name: "read_file",
          status: "ok",
          input: { path: "a.ts" },
          detail: "Read a.ts",
        },
        {
          id: "tu-live-bash",
          name: "bash",
          status: "ok",
          input: { command: "pwd" },
          detail: "pwd",
        },
      ]}
      draftsMasked="回答草稿"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // Retract entries collapse: no live completion form. (The count line's
  // anchor is a history text segment; with no history activity there is no
  // anchorable segment — the count line's absence is an existing boundary,
  // covered by the history-path test.)
  expect(frame).not.toContain("Read a.ts · ok");
  // The keep entry's title stays (live completion row uses the same SSOT
  // form): success state has no `[完成]` ("done") prefix.
  expect(frame).toContain("bash · pwd");
  expect(frame.includes("[完成]")).toBe(false);
  await setup.renderer.destroy();
});

test("T3 live 尾巴：相邻两张 keep 卡之间空一行", async () => {
  // Adjacent keep-class title cards (history MessageBlocks and the live
  // tail) get one blank line between them; this test pins the card spacing
  // on the full ChatView frame.
  const runs: ReadonlyArray<LiveToolRun> = [
    {
      id: "t3-live-1",
      name: "bash",
      status: "ok",
      input: { command: "cmd-alpha" },
      detail: "cmd-alpha",
      stdout: "ALPHA_OUT",
    },
    {
      id: "t3-live-2",
      name: "bash",
      status: "ok",
      input: { command: "cmd-beta" },
      detail: "cmd-beta",
      stdout: "BETA_OUT",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith([
        { role: "user", content: [{ type: "text", text: "q" }] },
      ])}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={runs}
      draftsMasked="草稿"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const lines = setup.captureCharFrame().split("\n");
  const first = lines.findIndex((l) => l.includes("bash · cmd-alpha"));
  const second = lines.findIndex((l) => l.includes("bash · cmd-beta"));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
  // Exactly 1 blank line between the two cards (the first card's stdout row
  // must not touch the second card's title).
  const between = lines.slice(first + 1, second);
  expect(between.filter((l) => l.trim().length === 0)).toHaveLength(1);
  await setup.renderer.destroy();
});

test("idle：SC3 一轮成功 read_file + 成功 bash → bash 标题留、read 收进计数", async () => {
  // Successful read_file (retract) → no title, no preview, folded into the
  // count `read_file × 1`; successful bash (keep) → title stays + collapsed
  // result preview, not counted.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读再跑", signature: "s" },
        {
          type: "tool_use",
          id: "tu-rd",
          name: "read_file",
          input: { path: "a.ts" },
        },
        {
          type: "tool_use",
          id: "tu-sh",
          name: "bash",
          input: { command: "pwd" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-rd", content: "file body" },
        {
          type: "tool_result",
          tool_use_id: "tu-sh",
          content: JSON.stringify({ code: 0, stdout: "/tmp\n", stderr: "" }),
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "完成。" }],
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("bash · pwd");
  expect(frame).toContain("│ /tmp");
  expect(frame.includes("[完成]")).toBe(false);
  // read_file retract: no title, no preview.
  expect(frame.includes("read_file ·")).toBe(false);
  expect(frame).toContain("read_file × 1");
  // bash is not in the fold count.
  expect(frame.includes("bash × ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：SC4 失败 retract 工具 → 标题 + 一行短错误可见，不进折叠计数", async () => {
  // Failure overrides the success classification across the cut — a failed
  // read_file gets a standalone title line (`[失败]`, "failed") + one short
  // error line; the fold count line must not include failed entries
  // (`read_file ×` absent).
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读配置", signature: "s" },
        {
          type: "tool_use",
          id: "tu-rd-fail",
          name: "read_file",
          input: { path: "missing.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-rd-fail",
          content: "ENOENT: no such file or directory",
          is_error: true,
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "读不到，换路子。" }],
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // Failed entry: red title stays + one short error line present.
  expect(frame).toContain("[失败] read_file");
  expect(frame).toContain("ENOENT");
  // Failed entries never join the fold count line.
  expect(frame.includes("read_file ×")).toBe(false);
  await setup.renderer.destroy();
});

test("running-fg：live 单条 bash 走细节槽（不聚合），历史成功 bash 标题仍可见", async () => {
  // Per CONTEXT `live activity group`: the running surface does not
  // prematurely fold live entries into a turn count line (`bash × N`
  // absent); a single keep bash stays below the >=2 aggregation threshold →
  // it is itself the detail-slot card (command visible); settled-history keep
  // bash titles still stay per-entry as before.
  // The `thinkingFrozenSeconds` side channel was removed — during running
  // there is no frozen `Thought for` branch; the streaming panel always shows
  // `Thinking…` (see `thinking-peek.test.tsx`).
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-live",
      name: "bash",
      status: "running",
      input: { command: "memory_recall" },
    },
  ];
  const setup = await testRender(
    <ChatView
      session={{
        ...sessionWith(interleavedThinkingToolMessages()),
        runState: "running-fg",
      }}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
      thinkingDraftMasked="继续在找归内目录"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // Per specs/tui-activity-block.md S4/S6: live bash is keep-class
  // (`deriveSlot(name)` = KEEP_WITH_PREVIEW) and does not enter the
  // unanchored activity block (avoids double-painting with the tail tool
  // card) — it goes through the tail `liveToolRunsBox` and renders the
  // preview line `Running 1 shell command… · <command>`. Live assertion: the
  // old `bash × N` fold count / `calling bash × 1` block title must not
  // appear.
  expect(frame.includes("bash ×")).toBe(false);
  expect(frame.includes("calling bash ×")).toBe(false);
  expect(frame).toContain("Running 1 shell command…");
  // No stacked completion card.
  expect(frame.includes("bash · Recall")).toBe(false);
  // Successful bash titles in history messages stay visible per entry
  // (settled history belongs to the unit-fold surface); with no `[完成]`
  // ("done") prefix, match `bash ·` lines.
  expect(frame.split("\n").some((l) => l.includes("bash ·"))).toBe(true);
  await setup.renderer.destroy();
});

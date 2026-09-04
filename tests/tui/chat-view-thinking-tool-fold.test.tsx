/** @jsxImportSource @opentui/react */
/**
 * D3（spec specs/tui-tool-settled-appearance.md）落定态折叠：
 *  - 折叠计数行只聚合成功且 retract 的件（inFoldCount === true）；
 *  - keep（bash / write / edit）标题 + 预览留；accent / 失败出独立标题行；
 *  - 零条收 → 无工具计数行（思考秒数行可单独在）；
 *  - running 态逐条可见（行为不变）；
 *  - 折叠簇思考秒数 = 落盘 thinkingMs（纯函数 sumThinkingMsInRange）。
 *
 * 渲染只消费 deriveSlot 的 slot（D7）——message-blocks 按标题/预览/收三类
 * 自治，ChatView 不再传组合开关。
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

/** 用户截图同构：一轮提问 + 多轮「思考 → bash」+ 末条思考后回答。 */
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

/** thinkingMs 与 messages 一一对应。null = 该位置无 thinkingMs;
 *  number(ms) = 该 assistant 回合的思考时长。三个 bashTurn 的 thinkingMs 落在
 *  index 1, 3, 5(final assistant 的思考在 index 7)。 */
function thinkingMsForInterleaved(
  values: ReadonlyArray<number | null>
): ReadonlyArray<number | null> {
  // messages: [user(0), asst-1(1), user-result(2), asst-2(3), user-result(4),
  //            asst-3(5), user-result(6), asst-final(7)]
  // values 顺序与 assistant messageIndex 对齐:values[0] → index 1,values[1]
  // → index 3,values[2] → index 5,values[3] → index 7。
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
  // bash 是 keep 类：落定后标题行逐条留（D4 足迹）；本 turn 零 retract
  // 条目 → 无工具计数行（D3）。思考秒数行仍按簇落盘 thinkingMs 画。
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
  // keep 标题行逐条可见（bash 成功）。
  expect(frame).toContain("[完成] bash");
  // 零条收 → 无工具计数行。
  expect(frame.includes("× ")).toBe(false);
  // 思考秒数行仍在（簇 thinkingMs 求和，思考行可单独在）。
  expect(frame).toContain("思考了 2 秒");
  expect(frame.includes("[思考]")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：两轮 bash keep → 两轮各自标题留，零条收无计数行（spec D3 全轮生效）", async () => {
  // 两轮:每轮一条 user query + assistant(thinking + bash)+ tool_result user。
  // thinkingMs = [null, 4000, null, 6000, null] (assistant 思考 4s / 6s)。
  // bash keep 标题在两轮各留一条；零 retract → 无计数行。
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
  // messages 长度 6:asst-1 在 index 1、asst-2 在 index 4。
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
  // 两轮各自出思考秒数行:各带独立 thinkingMs。
  expect(frame).toContain("思考了 4 秒");
  expect(frame).toContain("思考了 6 秒");
  // keep 标题两轮各留（全轮生效，旧轮标题不消失）。
  expect(frame.split("[完成] bash").length - 1).toBe(2);
  // 零条收 → 无工具计数行。
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：单工具无 thinkingMs（落盘缺席） → bash keep 标题留、无计数行", async () => {
  // bash 是 keep 类：无秒数轮次思考行不画（无落盘 thinkingMs），标题行
  // 独立留 —— 折叠计数行只数 retract，bash 不进。
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
  // 全 null thinkingMs(模拟 legacy 文件 / 无落盘 thinkingMs)。
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
  expect(frame).toContain("[完成] bash");
  expect(frame.includes("× ")).toBe(false);
  // 无秒数 → 不显示 `思考了` 行。
  expect(frame.includes("思考了 ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：旧会话无 thinkingMs（整链缺席） → bash keep 标题留、无秒数行", async () => {
  // 旧会话:文件不携带 thinkingMs(SessionFileV1.thinkingMs undefined)。
  // attachSession 透传 undefined → session.thinkingMs = undefined →
  // sumThinkingMsInRange 按 0 计入 → 无秒数行；keep 标题行留。
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
  expect(frame).toContain("[完成] bash");
  expect(frame.includes("× ")).toBe(false);
  expect(frame.includes("思考了 ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：文本→工具时，keep 标题出现在前置文本之后", async () => {
  // bash keep 标题按 content 顺序渲染在文本之后（slot 消费，无计数行）。
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
  const titleIdx = lines.findIndex((line) => line.includes("[完成] bash"));
  expect(textIdx).toBeGreaterThanOrEqual(0);
  expect(titleIdx).toBeGreaterThan(textIdx);
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：工具→文本时，keep 标题出现在后续文本之前", async () => {
  // bash keep 标题按 content 顺序渲染在文本之前。
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
  const titleIdx = lines.findIndex((line) => line.includes("[完成] bash"));
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
    // assistant 在 index 1 → thinkingMs[1] = value。
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
    const titleIndices = lines.flatMap((line, index) =>
      line.includes("[完成] bash") ? [index] : []
    );
    return { setup, textIdx, titleIndices };
  };

  // tool_then_text:同一 assistant 内先 tool 后 text → keep 标题在 text 前。
  // D7:渲染按 content 块顺序消费 slot —— 标题位置即 tool_use 块位置。
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

test("idle：无历史 activity 时已完成 live retract 工具收出 tail（keep 留标题）", async () => {
  // D3:已完成 retract（read_file）进折叠计数、离开尾巴；keep（bash）
  // 标题独立留 —— tail 里不出现 live 完成形态 `· ok` 尾缀。
  // 计数行锚在最近 text 段（草稿段）之后。
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
          detail: "读取 a.ts",
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
  // retract 件收起：不出现 live 完成形态（计数行锚点在历史 text 段，
  // 无历史 activity 时无可锚段 —— 计数行缺席属既有边界，SC3 历史路径覆盖）。
  expect(frame).not.toContain("读取 a.ts · ok");
  // keep 件标题留（live 完成行同 SSOT 形态）。
  expect(frame).toContain("[完成] bash · pwd");
  await setup.renderer.destroy();
});

test("idle：SC3 一轮成功 read_file + 成功 bash → bash 标题留、read 收进计数", async () => {
  // spec SC3：成功 read_file（retract）→ 无标题、无 ⎿ 预览、进折叠计数
  // `read_file × 1`；成功 bash（keep）→ 标题（及预览）留，不进计数。
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
  // bash keep：标题留、成功预览（⎿）留。
  expect(frame).toContain("[完成] bash · pwd");
  expect(frame).toContain("⎿ /tmp");
  // read_file retract：无标题、无预览。
  expect(frame.includes("read_file ·")).toBe(false);
  expect(frame).toContain("read_file × 1");
  // bash 不进折叠计数。
  expect(frame.includes("bash × ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：SC4 失败 retract 工具 → 标题 + 一行短错误可见，不进折叠计数", async () => {
  // spec SC4 / D5：失败横切覆盖成功分类 —— 失败 read_file 出独立标题行
  // （[失败]）+ 一行短错误；折叠计数行不得把失败件计入（`read_file ×` 缺席）。
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
  // 失败件：红标题留 + 一行短错误在场。
  expect(frame).toContain("[失败] read_file");
  expect(frame).toContain("ENOENT");
  // 失败不进折叠计数行（计数行不含该失败件）。
  expect(frame.includes("read_file ×")).toBe(false);
  await setup.renderer.destroy();
});

test("running-fg：不提前收成 turn 摘要,历史 [完成] 仍可见", async () => {
  // D3:running 态仍逐条工具可见(行为不变);折叠行不出现。
  // spec D3 删除了 `thinkingFrozenSeconds` 副通道 —— running 期间不再有
  // 冻结「思考了 N 秒」分支,流式面板恒 `思考中…`(测试 `thinking-peek.test.tsx`)。
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-live",
      name: "bash",
      status: "ok",
      input: { command: "memory_recall" },
      detail: "记忆 召回",
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
  // running 态:折叠行不出现(running 闸)。
  expect(frame.includes("bash ×")).toBe(false);
  // 历史消息的 `[完成]` 行仍可见(running 态逐条)。
  expect(frame.includes("[完成]")).toBe(true);
  await setup.renderer.destroy();
});

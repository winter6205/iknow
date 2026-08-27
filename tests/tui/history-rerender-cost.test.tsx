/** @jsxImportSource @opentui/react */
/**
 * tests/tui/history-rerender-cost.test.tsx
 *
 * 「聊几轮之后 TUI 变卡」的回归闸（诊断证据见 scripts/tui-perf-probe.tsx）。
 *
 * 症状：一次流式增量 / 一次与 ChatView props 无关的父状态更新，都会把
 * **全部已挂载历史消息** 重新走一遍 markdown 渲染 —— 24 轮历史下单次更新
 * 触发约 96 次 `marked.lexer`，成本 O(历史体量)。
 *
 * 本文件的断言口径（唯一 instrumentation）：patch `marked.lexer` 统计调用，
 * 并按 src 文本区分「历史消息正文」与「流式草稿」。历史正文的 lexer 调用数
 * 就是「有多少历史消息被重新解析」，与视口挂载条数无关，故对
 * `selectViewportMountWindow` 的切片策略免疫。
 *
 * 异步等待纪律沿用 chat-view-scroll.test.tsx：`waitForVisualIdle()` 是唯一
 * 异步等待入口，React 状态更新一律 act 包裹。
 */
import { afterAll, expect, test } from "bun:test";
import { act, useEffect, useMemo, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { marked } from "marked";
import { ChatView } from "../../src/tui/chat-view.js";
import {
  attachSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../src/harness/model-adapter/types.js";

const COLS = 120;
const ROWS = 40;
const TURNS = 24;

// ── marked.lexer 计数（历史正文 vs 其它文本分开计）────────────────────
//
// 历史正文用本文件专属后缀，避免与同进程其它测试文件共用 markdown 缓存时
// 相互污染计数。

const HISTORY_TAG = "history-rerender-cost";
/** 每个用例一份专属正文：markdown 解析缓存是模块级的，共用正文会让「首次
 *  挂载必须真的解析过历史」的空转守卫被上一个用例的缓存命中打掉。 */
const historyTexts = new Set<string>();
let historyLexCalls = 0;
let totalLexCalls = 0;

type LexerFn = typeof marked.lexer;
const originalLexer = marked.lexer.bind(marked) as LexerFn;
(marked as unknown as { lexer: LexerFn }).lexer = ((
  src: string,
  opts?: unknown
) => {
  totalLexCalls += 1;
  if (typeof src === "string" && historyTexts.has(src)) historyLexCalls += 1;
  return (originalLexer as (s: string, o?: unknown) => unknown)(
    src,
    opts
  ) as ReturnType<LexerFn>;
}) as LexerFn;

afterAll(() => {
  (marked as unknown as { lexer: LexerFn }).lexer = originalLexer;
});

function resetLexCounters(): void {
  historyLexCalls = 0;
  totalLexCalls = 0;
}

// ── 会话构造：一轮 = user 提问 + assistant（thinking + 工具 + markdown）+ tool_result ──

function assistantBody(nonce: string, turn: number): string {
  return `这是第 ${turn} 轮的结论（${HISTORY_TAG} / ${nonce}）。

## 结论

- 第一点：调用链在 \`chat-view.tsx\` 收口，滚动交给 scrollbox。
- 第二点：**每条消息** 都会重新走一遍 markdown 渲染。

\`\`\`ts
export function selectViewportMountWindow(messages, opts) {
  const heights = messages.map((_, i) => opts.heights?.[i] ?? 4);
  return heights.reduce((sum, h) => sum + h, 0);
}
\`\`\`

后续继续验证第 ${turn} 轮的假设。`;
}

function assistantLead(nonce: string, turn: number): string {
  return `先看一下第 ${turn} 轮涉及的文件（${HISTORY_TAG} / ${nonce}）。`;
}

function turnMessages(nonce: string, turn: number): AnthropicNativeMessage[] {
  const idA = `toolu_${nonce}_${turn}_a`;
  const idB = `toolu_${nonce}_${turn}_b`;
  const lead = assistantLead(nonce, turn);
  const body = assistantBody(nonce, turn);
  historyTexts.add(lead);
  historyTexts.add(body);
  const assistantContent: AnthropicContentBlock[] = [
    {
      type: "thinking",
      thinking: `第 ${turn} 轮的内部推理草稿。`,
      signature: "sig",
    } as unknown as AnthropicContentBlock,
    { type: "text", text: lead },
    {
      type: "tool_use",
      id: idA,
      name: "bash",
      input: { command: `rg -n "selectViewportMountWindow" src/tui` },
    } as unknown as AnthropicContentBlock,
    {
      type: "tool_use",
      id: idB,
      name: "read_file",
      input: { path: "src/tui/chat-view.tsx", offset: turn * 10 },
    } as unknown as AnthropicContentBlock,
    { type: "text", text: body },
  ];
  return [
    {
      role: "user",
      content: [{ type: "text", text: `第 ${turn} 轮提问：解释挂载策略。` }],
    },
    { role: "assistant", content: assistantContent },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: idA,
          content: [{ type: "text", text: "src/tui/chat-view.tsx:236" }],
        } as unknown as AnthropicContentBlock,
        {
          type: "tool_result",
          tool_use_id: idB,
          content: [{ type: "text", text: "ok" }],
        } as unknown as AnthropicContentBlock,
      ],
    },
  ];
}

function sessionWithTurns(nonce: string, turns: number): TuiSessionState {
  const messages: AnthropicNativeMessage[] = [];
  for (let k = 0; k < turns; k++) messages.push(...turnMessages(nonce, k));
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: `${nonce}-session`,
    messages,
    turnCount: turns,
    updatedAt: "2026-08-27T00:00:00.000Z",
    jsonMode: false,
  };
  return attachSession(file);
}

// ── harness：模拟「只有流式草稿在变」与「只有无关父状态在变」两种更新 ──

interface HarnessApi {
  /** 流式增量：改 draftSegments（ChatView 唯一变化的 prop）。 */
  setDraft(text: string): void;
  /** 输入框按键 / 1Hz tick：只改与 ChatView props 无关的父状态。 */
  bumpUnrelated(): void;
  /** 终端 resize：改 cols（历史消息必然重渲染，memo 拦不住）。 */
  setCols(cols: number): void;
}

function Harness(props: {
  readonly session: TuiSessionState;
  readonly register: (api: HarnessApi) => void;
}): ReturnType<typeof ChatView> {
  const [draft, setDraft] = useState("");
  const [, setUnrelated] = useState(0);
  const [cols, setCols] = useState(COLS);
  // app.tsx 侧 draftSegments 是 state（引用稳定）；harness 同样稳定，否则
  // useDeferredValue 每次父渲染都多跑一遍，污染 parent 模式计数。
  const segments = useMemo(() => (draft === "" ? [] : [draft]), [draft]);
  useEffect(() => {
    props.register({
      setDraft,
      bumpUnrelated: () => setUnrelated((n) => n + 1),
      setCols,
    });
  }, []);
  return (
    <ChatView
      session={props.session}
      cols={cols}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={[]}
      draftSegments={segments}
    />
  );
}

async function mountChat(nonce: string): Promise<{
  readonly setup: Awaited<ReturnType<typeof testRender>>;
  readonly api: HarnessApi;
}> {
  const holder: { api: HarnessApi | null } = { api: null };
  const setup = await testRender(
    <Harness
      session={sessionWithTurns(nonce, TURNS)}
      register={(api) => {
        holder.api = api;
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  if (holder.api === null) throw new Error("harness api not registered");
  return { setup, api: holder.api };
}

test("流式增量：24 轮历史挂载后，已挂载历史消息不再重跑 markdown lexer", async () => {
  resetLexCounters();
  const { setup, api } = await mountChat("stream");
  // 首次挂载必须真的解析过历史，否则本用例为空转。
  expect(historyLexCalls).toBeGreaterThan(0);

  // 预热一次增量，让 itemHeights 量测收敛后再计数。
  await act(async () => {
    api.setDraft("流式草稿第一段。");
  });
  await setup.waitForVisualIdle();

  resetLexCounters();
  await act(async () => {
    api.setDraft("流式草稿第一段。流式草稿第二段。");
  });
  await setup.waitForVisualIdle();

  expect(historyLexCalls).toBe(0);
  await setup.renderer.destroy();
});

test("无关父状态更新（按键 / tick）：不触发任何 markdown lexer", async () => {
  resetLexCounters();
  const { setup, api } = await mountChat("parent");
  expect(historyLexCalls).toBeGreaterThan(0);

  await act(async () => {
    api.bumpUnrelated();
  });
  await setup.waitForVisualIdle();

  resetLexCounters();
  await act(async () => {
    api.bumpUnrelated();
  });
  await setup.waitForVisualIdle();

  expect(historyLexCalls).toBe(0);
  expect(totalLexCalls).toBe(0);
  await setup.renderer.destroy();
});

test("终端 resize（cols 变化）：历史消息重新排版，但正文不重跑 markdown lexer", async () => {
  resetLexCounters();
  const { setup, api } = await mountChat("resize");
  expect(historyLexCalls).toBeGreaterThan(0);

  // resize 让每条历史消息的 cols prop 都变化 —— memo 必然失效，只有按 text
  // 记忆的解析结果能挡住重解析（markdown 解析与宽度无关，换行由渲染层做）。
  resetLexCounters();
  await act(async () => {
    api.setCols(COLS - 20);
  });
  await setup.waitForVisualIdle();

  expect(historyLexCalls).toBe(0);
  await setup.renderer.destroy();
});

test("历史消息重新挂载（滚出视口再滚回）：同一段正文不重跑 markdown lexer", async () => {
  resetLexCounters();
  const first = await mountChat("remount");
  expect(historyLexCalls).toBeGreaterThan(0);
  await first.setup.renderer.destroy();

  // 视口挂载会把滚出去的消息整棵卸载，回滚时组件重新 mount —— 组件内的
  // useMemo 记忆随之丢失，只有跨实例的解析缓存能挡住重解析。
  resetLexCounters();
  const second = await mountChat("remount");

  expect(historyLexCalls).toBe(0);
  await second.setup.renderer.destroy();
});

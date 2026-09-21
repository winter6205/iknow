/** @jsxImportSource @opentui/react */
/**
 * tests/tui/history-rerender-cost.test.tsx
 *
 * Regression gate for "the TUI gets laggy after a few turns" (diagnostic
 * evidence in scripts/tui-perf-probe.tsx).
 *
 * Symptom: one streaming delta / one parent-state update unrelated to ChatView
 * props re-runs markdown rendering over **all mounted history messages** — with
 * 24 turns of history a single update fires ~96 `marked.lexer` calls, cost
 * O(history size).
 *
 * Assertion metric here (the only instrumentation): patch `marked.lexer` to
 * count calls, distinguishing "history message bodies" from "streaming draft"
 * by src text. The lexer-call count on history bodies equals "how many history
 * messages got re-parsed", independent of how many rows the viewport mounts, so
 * it is immune to `selectViewportMountWindow`'s slicing strategy.
 *
 * Async-wait discipline follows chat-view-scroll.test.tsx:
 * `waitForVisualIdle()` is the only async wait entry; React state updates are
 * always wrapped in act.
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

// ── marked.lexer counting (history bodies vs other text, counted separately) ──
//
// History bodies carry a suffix unique to this file so that sharing the module
// markdown cache with other test files in the same process can't cross-pollute
// the counts.

const HISTORY_TAG = "history-rerender-cost";
/** One dedicated body per case: the markdown parse cache is module-level, so a
 *  shared body would let a previous case's cache hit defeat the "first mount
 *  must really parse the history" no-op guard. */
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

// ── session construction: one turn = user ask + assistant (thinking + tool + markdown) + tool_result ──

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

// ── harness: simulates the two update kinds — "only the streaming draft changes" and "only unrelated parent state changes" ──

interface HarnessApi {
  /** Streaming delta: changes draftSegments (the only ChatView prop that varies). */
  setDraft(text: string): void;
  /** Input keystrokes / 1Hz tick: changes only parent state unrelated to ChatView props. */
  bumpUnrelated(): void;
  /** Terminal resize: changes cols (history messages must re-render; memo can't stop it). */
  setCols(cols: number): void;
}

function Harness(props: {
  readonly session: TuiSessionState;
  readonly register: (api: HarnessApi) => void;
}): ReturnType<typeof ChatView> {
  const [draft, setDraft] = useState("");
  const [, setUnrelated] = useState(0);
  const [cols, setCols] = useState(COLS);
  // In app.tsx draftSegments is state (stable reference); the harness must stay
  // equally stable, otherwise useDeferredValue re-runs on every parent render
  // and pollutes the parent-mode counts.
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
  // First mount must really parse the history, else this case spins vacuously.
  expect(historyLexCalls).toBeGreaterThan(0);

  // Warm up with one delta so itemHeights measurement converges before counting.
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

  // Resize changes the cols prop of every history message — memo is guaranteed
  // to miss; only text-keyed parse results can block re-parsing (markdown
  // parsing is width-independent; wrapping happens in the render layer).
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

  // Viewport mounting unmounts scrolled-out messages wholesale and remounts
  // them on scroll-back — per-component useMemo memory is lost, so only a
  // cross-instance parse cache can block re-parsing.
  resetLexCounters();
  const second = await mountChat("remount");

  expect(historyLexCalls).toBe(0);
  await second.setup.renderer.destroy();
});

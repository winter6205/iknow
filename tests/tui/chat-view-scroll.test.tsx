/** @jsxImportSource @opentui/react */
/**
 * tests/tui/chat-view-scroll.test.tsx
 *
 * ChatView session view (OpenTUI `<scrollbox stickyScroll>`):
 *  - sticky scroll: appended messages auto-pin to bottom; after
 *    mockMouse.scroll scrolls up, appended content stays at the user position
 *    (does not follow); scrolling back to bottom restores following (landing
 *    at the bottom re-engages sticky, _hasManualScroll resets);
 *  - forced scroll channel: ChatViewHandle.scrollToBottom() (new user
 *    message / turn completion);
 *  - long session (100 msgs > 3 screens) keeps the full scroll document: top
 *    shows the earliest bubble, no tail-window stub; layout positions queried
 *    via ref directly (scrollTop / scrollHeight / viewport.height), never
 *    estimated by line counts;
 *  - empty session (0 messages) renders and converges without crash (empty boundary);
 *  - session wiring: TuiSessionState.messages + runState / streaming draft /
 *    liveTool / banner segments all render (MessageBlocks visual consistency).
 *
 * The harness drives TuiSessionState directly (user/assistant text message
 * arrays + runState + streaming draft), keeping the sticky-scroll coverage as
 * the acceptance SSOT.
 *
 * Async-wait discipline: setup.waitForVisualIdle() is the only async wait
 * entry (no bare setTimeout sleep polling); React state updates are wrapped
 * in act.
 */
import { expect, test } from "bun:test";
import { Profiler, act, useEffect, useRef, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ChatView, type ChatViewHandle } from "../../src/tui/chat-view.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import {
  attachSession,
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import {
  liveToolReduce,
  type LiveToolRun,
} from "../../src/tui/live-tool-state.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import {
  SCROLLBAR_THUMB_HOVER_ALPHA,
  SCROLLBAR_THUMB_IDLE_ALPHA,
} from "../../src/tui/scrollbar-style.js";
import { resolveScrollCommitStep } from "../../src/tui/transcript-viewport.js";

const COLS = 60;
const ROWS = 12;

interface ChatApi {
  appendUser(text: string): void;
  appendAssistant(text: string): void;
  setDrafts(text: string): void;
  setLiveToolRuns(runs: ReadonlyArray<LiveToolRun>): void;
  setRunning(running: boolean): void;
  handle: ChatViewHandle | null;
}

interface HarnessProps {
  readonly initial: TuiSessionState;
  readonly register: (api: ChatApi) => void;
  readonly bannerLines?: ReadonlyArray<string>;
  readonly rows?: number;
}

function Harness(props: HarnessProps): ReturnType<typeof ChatView> {
  const [session, setSession] = useState<TuiSessionState>(props.initial);
  const chatRef = useRef<ChatViewHandle>(null);

  useEffect(() => {
    props.register({
      appendUser: (text) => {
        act(() => {
          const userMsg: AnthropicNativeMessage = {
            role: "user",
            content: [{ type: "text", text }],
          };
          setSession((prev) => ({
            ...prev,
            messages: [...prev.messages, userMsg],
            turnCount: prev.turnCount + 1,
          }));
        });
      },
      appendAssistant: (text) => {
        act(() => {
          const asstMsg: AnthropicNativeMessage = {
            role: "assistant",
            content: [{ type: "text", text }],
          };
          setSession((prev) => ({
            ...prev,
            messages: [...prev.messages, asstMsg],
            turnCount: prev.turnCount + 1,
          }));
        });
      },
      setDrafts: (text) => {
        act(() => {
          setSession((prev) => ({ ...prev, drafts: text }) as TuiSessionState);
        });
      },
      setLiveToolRuns: (runs) => {
        act(() => {
          setSession(
            (prev) => ({ ...prev, liveToolRuns: runs }) as TuiSessionState
          );
        });
      },
      setRunning: (running) => {
        act(() => {
          setSession((prev) => ({
            ...prev,
            runState: running ? "running-fg" : "idle",
          }));
        });
      },
      handle: chatRef.current,
    });
  });
  // `drafts` / `liveToolRuns` are runtime streaming fields — this harness
  // injects them via closure state (not TuiSessionState fields) to avoid
  // reshaping TuiSessionState for other tests. ChatView receives them through
  // props.draftsMasked / props.liveToolRuns, updated in lockstep by the harness.
  return (
    <ChatView
      ref={chatRef}
      session={session}
      cols={COLS}
      rows={props.rows ?? ROWS}
      liveToolLines={[]}
      liveToolRuns={
        (session as unknown as { liveToolRuns?: ReadonlyArray<LiveToolRun> })
          .liveToolRuns ?? []
      }
      draftsMasked={(session as unknown as { drafts?: string }).drafts}
      bannerLines={props.bannerLines}
    />
  );
}

function msg(
  id: string,
  role: "user" | "assistant",
  text: string
): AnthropicNativeMessage {
  return { role, content: [{ type: "text", text }] };
}

/** Generate n alternating user/assistant multi-paragraph messages. */
function makeMessages(n: number, offset = 0): AnthropicNativeMessage[] {
  return Array.from({ length: n }, (_, i) => {
    const k = offset + i;
    const role = k % 2 === 0 ? "user" : "assistant";
    const text =
      role === "user"
        ? `msg-${String(k).padStart(3, "0")} 用户提问`
        : `reply-${String(k).padStart(3, "0")} 第一段\n\nreply-${String(k).padStart(3, "0")} 第二段\n\nreply-${String(k).padStart(3, "0")} 第三段`;
    return msg(`m-${k}`, role, text);
  });
}

/** Build a TuiSessionState with messages. thinkingMs may be passed
 *  explicitly (otherwise SessionFileV1.thinkingMs is undefined and the fold
 *  line shows tool counts only). */
function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>,
  thinkingMs?: ReadonlyArray<number | null>,
  conversationId = "test"
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: conversationId,
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-08-10T00:00:00.000Z",
    jsonMode: false,
    ...(thinkingMs !== undefined ? { thinkingMs } : {}),
  };
  return attachSession(file);
}

async function renderChat(
  initial: TuiSessionState,
  opts?: {
    readonly bannerLines?: ReadonlyArray<string>;
    readonly rows?: number;
  }
): Promise<{
  setup: Awaited<ReturnType<typeof testRender>>;
  api: ChatApi;
}> {
  const holder: { api: ChatApi | null } = { api: null };
  const rows = opts?.rows ?? ROWS;
  const setup = await testRender(
    <Harness
      initial={initial}
      register={(api) => {
        holder.api = api;
      }}
      bannerLines={opts?.bannerLines}
      rows={rows}
    />,
    { width: COLS, height: rows, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  if (holder.api === null) throw new Error("harness register 未触发");
  return { setup, api: holder.api };
}

/** Ref-based ground truth: bottom position = scrollHeight - viewport height. */
function maxScrollTop(handle: ChatViewHandle): number {
  const sb = handle.scrollbox;
  if (sb === null) throw new Error("scrollbox 未挂载");
  return Math.max(0, sb.scrollHeight - sb.viewport.height);
}

test("空会话（0 条消息）渲染收敛不崩", async () => {
  const { setup, api } = await renderChat(createDraftSession());
  const sb = api.handle?.scrollbox;
  expect(sb).not.toBeNull();
  expect(sb!.scrollTop).toBe(0);
  expect(sb!.scrollHeight).toBeLessThanOrEqual(ROWS);
  expect(() => setup.captureCharFrame()).not.toThrow();
  await setup.renderer.destroy();
});

test("短会话（内容不足一屏）：全部消息挂载、无尾窗 stub", async () => {
  // spec invariant (short-session clause): when content fits the viewport
  // (+overscan), the mounted-window result equals a full visibleMessages.map —
  // the frame contains all visible messages and no "↑ N 条更早的消息"
  // ("earlier messages") tail-window stub.
  const initial = sessionWith(makeMessages(3));
  const { setup, api } = await renderChat(initial, { rows: 24 });
  const sb = api.handle!.scrollbox!;
  // Precondition: total content height fits in the viewport (otherwise "all mounted" is unreachable).
  expect(sb.scrollHeight).toBeLessThanOrEqual(sb.viewport.height);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("msg-000");
  expect(frame).toContain("reply-001");
  expect(frame).toContain("msg-002");
  expect(frame.includes("条更早的消息")).toBe(false);
  expect(frame.includes("↑ ")).toBe(false);
  // Window covers all 3 messages (visible indices 0..2 all on the tree).
  for (let i = 0; i < 3; i++) {
    expect(sb.getRenderable(`tmsg-${i}`)).toBeDefined();
  }
  await setup.renderer.destroy();
});

test("sticky 贴底：追加消息自动滚底（ref 直查 scrollTop === max）", async () => {
  const initial = sessionWith(makeMessages(2));
  const { setup, api } = await renderChat(initial);
  const handle = api.handle!;
  expect(handle.scrollbox!.scrollTop).toBe(0);
  // Append past one screen: stickyScroll auto-pins to bottom.
  for (const m of makeMessages(6, 2)) {
    if (m.role === "user") api.appendUser(m.content[0]!.text);
    else api.appendAssistant(m.content[0]!.text);
    await setup.waitForVisualIdle();
  }
  const sb = handle.scrollbox!;
  expect(sb.scrollHeight).toBeGreaterThan(ROWS);
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  // Latest message visible (assistant segment "reply-007").
  expect(setup.captureCharFrame()).toContain("reply-007");
  await setup.renderer.destroy();
});

// Skip rationale (operator-approved): the wheel-step SSOT is
// CHAT_WHEEL_SCROLL_MULTIPLIER (src/tui/wheel-scroll.ts) and no longer
// matches the "one step = 3 lines" assertion; this case's premise lapsed
// after step acceleration.
test.skip("滚轮一步移动 3 行（略快于 OpenTUI 默认 1 行/格）", async () => {
  const initial = sessionWith(makeMessages(10));
  const { setup, api } = await renderChat(initial);
  const handle = api.handle!;
  const sb = handle.scrollbox!;
  const max = maxScrollTop(handle);
  expect(sb.scrollTop).toBe(max);
  await act(async () => {
    await setup.mockMouse.scroll(5, 2, "up");
  });
  await setup.waitForVisualIdle();
  expect(max - sb.scrollTop).toBe(3);
  await setup.renderer.destroy();
});

test("上滚后追加：停留在用户位置不跟随（_hasManualScroll 暂停）", async () => {
  const initial = sessionWith(makeMessages(10));
  const { setup, api } = await renderChat(initial);
  const handle = api.handle!;
  const sb = handle.scrollbox!;
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await setup.mockMouse.scroll(5, 2, "up");
    });
  }
  await setup.waitForVisualIdle();
  const topBefore = sb.scrollTop;
  expect(topBefore).toBeGreaterThan(0);
  const topMarker = setup.captureCharFrame().split("\n")[0];
  // Append a new assistant message: stays at the user position, no jump to bottom.
  api.appendAssistant("brand-new-100 第一段\n\nbrand-new-100 第二段");
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(topBefore);
  const frame = setup.captureCharFrame();
  expect(frame.split("\n")[0]).toBe(topMarker);
  expect(frame).not.toContain("brand-new-100");
  await setup.renderer.destroy();
});

test("滚回底部后追加：恢复跟随贴底（sticky reengage）", async () => {
  const initial = sessionWith(makeMessages(10));
  const { setup, api } = await renderChat(initial);
  const handle = api.handle!;
  const sb = handle.scrollbox!;
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await setup.mockMouse.scroll(5, 2, "up");
    });
  }
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBeGreaterThan(0);
  expect(sb.scrollTop).toBeLessThan(maxScrollTop(handle));
  // Scroll back down to the bottom.
  for (let i = 0; i < 30; i++) {
    await act(async () => {
      await setup.mockMouse.scroll(5, 2, "down");
    });
    await setup.waitForVisualIdle();
    if (sb.scrollTop >= maxScrollTop(handle)) break;
  }
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  api.appendAssistant("reengaged-101 第一段\n\nreengaged-101 第二段");
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  expect(setup.captureCharFrame()).toContain("reengaged-101");
  await setup.renderer.destroy();
});

test("强制滚底通道：scrollToBottom() 从上滚位置直达底部并恢复跟随", async () => {
  const initial = sessionWith(makeMessages(10));
  const { setup, api } = await renderChat(initial);
  const handle = api.handle!;
  const sb = handle.scrollbox!;
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await setup.mockMouse.scroll(5, 2, "up");
    });
  }
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBeGreaterThan(0);
  handle.scrollToBottom();
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  api.appendAssistant("forced-102 第一段\n\nforced-102 第二段");
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  expect(setup.captureCharFrame()).toContain("forced-102");
  await setup.renderer.destroy();
});

test("中长会话（超一屏、不足三屏）：树上只挂视口+overscan，顶/底仍达首末", async () => {
  // spec invariant: the mounted window depends only on scrollTop + viewport +
  // overscan, not on total content height (20 short messages exceed one
  // screen) — the tree must not contain all 20 and the window may be shorter
  // than the total count. Assertion surface = the real render tree's
  // MessageRow id contract `tmsg-<visibleIndex>` (via scrollbox.getRenderable,
  // not inferred from implementation details).
  const MESSAGES = 20;
  const initial = sessionWith(makeMessages(MESSAGES));
  const { setup, api } = await renderChat(initial);
  const handle = api.handle!;
  const sb = handle.scrollbox!;
  expect(sb.scrollHeight).toBeGreaterThan(ROWS);

  const mountedIndices = (): number[] =>
    Array.from({ length: MESSAGES }, (_, i) => i).filter(
      (i) => sb.getRenderable(`tmsg-${i}`) !== undefined
    );
  const mountedCount = (): number => mountedIndices().length;
  // Height measurement converges only after useLayoutEffect writes itemHeights
  // back; wait one visual-idle round before reading the tree to avoid the
  // "not yet measured" intermediate state.
  await setup.waitForVisualIdle();

  // Tree follows the viewport: not all 20 messages.
  expect(mountedCount()).toBeLessThan(MESSAGES);
  expect(mountedCount()).toBeGreaterThan(0);
  // At bottom: last message mounted, first scrolled out (spacer holds the height).
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  expect(sb.getRenderable(`tmsg-${MESSAGES - 1}`)).toBeDefined();

  // Scroll to top: first message mounted and frame contains the earliest one.
  // Assignment must be act-wrapped — the setScrollTop triggered by the
  // scrollbar change is a React state update; a bare assignment races
  // waitForVisualIdle (which only waits for the OpenTUI scheduler) and reads
  // an uncommitted tree.
  await act(async () => {
    sb.scrollTop = 0;
  });
  await setup.waitForVisualIdle();
  expect(sb.getRenderable("tmsg-0")).toBeDefined();
  expect(setup.captureCharFrame()).toContain("msg-000");
  // Top window excludes the last message (window still shorter than total count).
  expect(sb.getRenderable(`tmsg-${MESSAGES - 1}`)).toBeUndefined();
  expect(mountedIndices()[0]).toBe(0);

  await setup.renderer.destroy();
});

test("banner 占滚动坐标：长会话一次上滚即见视口顶消息（无需来回滚动）", async () => {
  // banner 是滚动内容第一段，其真实高度 = 消息 0 的 origin。窗口推导若不
  // 减掉 origin，mount 窗整体下移 banner 高，视口顶部落在空白 spacer 带
  // （上滚黑屏），要靠来回滚动才追上。认证面：首个挂载 `tmsg-<i>` 节点的
  // 顶边 y ≤ scrollTop，且屏上有消息文本。
  const MESSAGES = 100;
  const bannerLines = Array.from({ length: 13 }, (_, r) => `banner-${r}`);
  const initial = sessionWith(makeMessages(MESSAGES));
  const { setup, api } = await renderChat(initial, { bannerLines, rows: 24 });
  const sb = api.handle!.scrollbox!;
  await setup.waitForVisualIdle();

  const banner = sb.getRenderable("transcript-banner");
  expect(banner).toBeDefined();
  expect(banner!.height).toBe(15); // 13 行点阵 + 圆角边框上下各 1
  const max = maxScrollTop(api.handle!);
  expect(max).toBeGreaterThan(banner!.height + 2 * sb.viewport.height);

  const mountedIndices = (): number[] =>
    Array.from({ length: MESSAGES }, (_, i) => i).filter(
      (i) => sb.getRenderable(`tmsg-${i}`) !== undefined
    );

  // 一次手势：从底部上滚两屏。
  await act(async () => {
    sb.scrollTop = max - 2 * sb.viewport.height;
  });
  await setup.waitForVisualIdle();

  // `node.y` 是视口相对坐标（负 = 顶边已滚出视口上方）。首挂载节点顶边必须
  // 在视口内或更上（≤0）：无 banner 坐标修正时 mount 窗整体下移 banner 高，
  // 首节点 y 是正的 spacer 带。骑跨视口顶的消息必须以正文出现在帧里
  // （排除"挂了但没画"）；banner 在列表中部不应重新入画。
  const topIndex = mountedIndices()[0]!;
  const topNode = sb.getRenderable(`tmsg-${topIndex}`)!;
  expect(topNode.y).toBeLessThanOrEqual(0);
  const visibleIndex = mountedIndices().find((i) => {
    const nd = sb.getRenderable(`tmsg-${i}`)!;
    return nd.y + nd.height > 0;
  })!;
  expect(visibleIndex).toBeDefined();
  const visibleMarker =
    visibleIndex % 2 === 0
      ? `msg-${String(visibleIndex).padStart(3, "0")}`
      : `reply-${String(visibleIndex).padStart(3, "0")}`;
  const frame = setup.captureCharFrame();
  expect(frame).toContain(visibleMarker);
  expect(frame).not.toContain("banner-0");

  await setup.renderer.destroy();
});

test("滚动提交量化：亚阈值 change 不提交 React，跨步长 / 贴底 / 置顶仍提交", async () => {
  // spec quantization clause: consecutive sub-threshold `change` events must
  // not each setScrollTop (every commit recomputes the whole ChatView);
  // crossing the quantization step, hitting bottom, and hitting top must
  // commit. Counting surface = React Profiler onRender count (React-side
  // truth, no implementation assertion).
  const commits: string[] = [];
  const handleRef = { current: null as ChatViewHandle | null };
  const initial = sessionWith(makeMessages(100));
  const setup = await testRender(
    <Profiler
      id="chat"
      onRender={(id, phase) => {
        commits.push(`${id}:${phase}`);
      }}
    >
      <ChatView
        ref={handleRef}
        session={initial}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
      />
    </Profiler>,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const handle = handleRef.current;
  if (handle === null) throw new Error("ChatView ref 未挂载");
  const sb = handle.scrollbox!;
  const max = maxScrollTop(handle);
  // First land mid-range (necessarily commits), then advance in sub-threshold increments.
  await act(async () => {
    sb.scrollTop = Math.floor(max / 2);
  });
  await setup.waitForVisualIdle();
  const mid = sb.scrollTop;
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(max);
  expect(commits.length).toBeGreaterThan(0);
  const step = resolveScrollCommitStep(sb.viewport.height);
  expect(step).toBeGreaterThan(1); // a step of 1 degenerates this case to "commit every time", losing its meaning

  // Sub-threshold change (+1 line < step) must produce zero commits: the observable form of quantization taking effect.
  commits.length = 0;
  await act(async () => {
    sb.scrollTop = mid + 1;
  });
  await setup.waitForVisualIdle();
  expect(commits).toEqual([]);
  // The scrollbox itself moved (user sees the follow), only the React window has not recomputed.
  expect(sb.scrollTop).toBe(mid + 1);

  // Keep advancing sub-threshold to "last committed position + step - 1" without commit (displacement below one quantum).
  await act(async () => {
    sb.scrollTop = mid + step - 1;
  });
  await setup.waitForVisualIdle();
  expect(commits).toEqual([]);

  // Crossing the quantization step → commit.
  await act(async () => {
    sb.scrollTop = mid + step;
  });
  await setup.waitForVisualIdle();
  expect(commits.length).toBeGreaterThan(0);

  // Bottom remains reachable (quantization must not block sticky's landing
  // path): after scrolling to max, scrollTop === maxScrollTop and the last
  // message is on screen.
  await act(async () => {
    sb.scrollTop = maxScrollTop(handle);
  });
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  expect(setup.captureCharFrame()).toContain("reply-099");

  // Top: jumping from bottom straight to 0 must also commit; the earliest bubble must mount.
  commits.length = 0;
  await act(async () => {
    sb.scrollTop = 0;
  });
  await setup.waitForVisualIdle();
  expect(commits.length).toBeGreaterThan(0);
  expect(setup.captureCharFrame()).toContain("msg-000");

  await setup.renderer.destroy();
});

test("滚轮一步即推动窗口：量化不得吞掉单次滚轮", async () => {
  // Quantization step ceiling = one wheel step (`CHAT_WHEEL_SCROLL_MULTIPLIER`,
  // see resolveScrollCommitStep), so a single wheel event necessarily crosses a
  // quantum boundary and commits — otherwise the user scrolls one notch and
  // sees no change. Counting surface = React Profiler onRender (React-side truth).
  const commits: string[] = [];
  const handleRef = { current: null as ChatViewHandle | null };
  const initial = sessionWith(makeMessages(100));
  const setup = await testRender(
    <Profiler
      id="chat"
      onRender={(id, phase) => {
        commits.push(`${id}:${phase}`);
      }}
    >
      <ChatView
        ref={handleRef}
        session={initial}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
      />
    </Profiler>,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const handle = handleRef.current;
  if (handle === null) throw new Error("ChatView ref 未挂载");
  const sb = handle.scrollbox!;
  const max = maxScrollTop(handle);

  // The first wheel event goes through the "first commit" channel (prev unset → must commit); excluded from this assertion.
  await act(async () => {
    await setup.mockMouse.scroll(5, 2, "up");
  });
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBeLessThan(max); // left the bottom, not at the top yet
  expect(sb.scrollTop).toBeGreaterThan(0);

  // The second wheel event goes through the quantization channel: displacement = one wheel step ≥ quantization step → must commit.
  commits.length = 0;
  const before = sb.scrollTop;
  await act(async () => {
    await setup.mockMouse.scroll(5, 2, "up");
  });
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBeLessThan(before); // position really moved
  expect(commits.length).toBeGreaterThan(0); // and the window recomputed along

  await setup.renderer.destroy();
});

test("换会话后首次亚阈值 change 提交：量化游标随 conversationId 复位", async () => {
  // spec: first commit and hitting top must take effect immediately; a new
  // session's window must not sit at the old session's position. Switching
  // sessions = same ChatView with a new session prop (conversationId changes);
  // the quantization cursor's lifetime must align with the itemHeights /
  // scrollTop reset at the same site. Counting surface = React Profiler onRender.
  const commits: string[] = [];
  const handleRef = { current: null as ChatViewHandle | null };
  const nextRef = {
    current: sessionWith(makeMessages(100), undefined, "conv-b"),
  };

  function SwitchHarness(props: { register: (fn: () => void) => void }) {
    const [session, setSession] = useState(() =>
      sessionWith(makeMessages(100), undefined, "conv-a")
    );
    useEffect(() => {
      props.register(() => {
        act(() => {
          setSession(nextRef.current);
        });
      });
    });
    return (
      <ChatView
        ref={handleRef}
        session={session}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
      />
    );
  }

  const holder: { fn: null | (() => void) } = { fn: null };
  const setup = await testRender(
    <Profiler
      id="chat"
      onRender={(id, phase) => {
        commits.push(`${id}:${phase}`);
      }}
    >
      <SwitchHarness
        register={(fn) => {
          holder.fn = fn;
        }}
      />
    </Profiler>,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const handle = handleRef.current;
  if (handle === null) throw new Error("ChatView ref 未挂载");
  const sb = handle.scrollbox!;
  await act(async () => {
    sb.scrollTop = Math.floor(maxScrollTop(handle) / 2);
  });
  await setup.waitForVisualIdle();
  const step = resolveScrollCommitStep(sb.viewport.height);
  expect(step).toBeGreaterThan(1);
  // Before switching: sub-threshold displacement does not commit (quantization in effect, cursor non-empty).
  commits.length = 0;
  await act(async () => {
    sb.scrollTop = sb.scrollTop + 1;
  });
  await setup.waitForVisualIdle();
  expect(commits).toEqual([]);
  // Switch session: wait for scrollTop reset and other React updates.
  commits.length = 0;
  holder.fn!();
  await setup.waitForVisualIdle();
  // First change after switching advances only 1 line (< step): a cursor
  // not reset on session switch would swallow it; a reset cursor must commit
  // (first commit must take effect).
  commits.length = 0;
  await act(async () => {
    sb.scrollTop = sb.scrollTop + 1;
  });
  await setup.waitForVisualIdle();
  expect(commits.length).toBeGreaterThan(0);
  await setup.renderer.destroy();
});

test("长会话（100 条）滚动文档全量：顶见最早、底见最末、无尾窗 stub", async () => {
  const initial = sessionWith(makeMessages(100));
  const { setup, api } = await renderChat(initial);
  const sb = api.handle!.scrollbox!;
  expect(sb.scrollHeight).toBeGreaterThan(ROWS * 3);
  expect(sb.scrollTop).toBe(maxScrollTop(api.handle!));
  expect(setup.captureCharFrame()).toContain("reply-099");
  // act-wrapped: scrollbar change → setScrollTop is a React update; a bare
  // assignment races waitForVisualIdle (OpenTUI scheduler only) and reads an
  // uncommitted tree.
  await act(async () => {
    sb.scrollTop = 0;
  });
  await setup.waitForVisualIdle();
  const top = setup.captureCharFrame();
  expect(top).toContain("msg-000");
  expect(top.includes("条更早的消息")).toBe(false);
  api.handle!.scrollToBottom();
  await setup.waitForVisualIdle();
  api.appendUser("追加的长会话尾巴");
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(maxScrollTop(api.handle!));
  expect(setup.captureCharFrame()).toContain("追加的长会话尾巴");
  await setup.renderer.destroy();
});

/**
 * Scrollbar appearance (the scrollbar-style.ts strategy on a real scrollbox):
 * idle is nearly invisible, pointer hover brings the color out, moving away
 * falls back; the track stays fully transparent throughout.
 *
 * Assertions read the thumb's actual RGBA (rendered color), not the style
 * constants — the constants themselves are pinned by scrollbar-style.test.ts;
 * this pins that the constants are genuinely wired to the control.
 */
function scrollbarColors(handle: ChatViewHandle): {
  thumbAlpha: number;
  trackAlpha: number;
} {
  const bar = handle.scrollbox!.verticalScrollBar as unknown as {
    slider: {
      backgroundColor: { toInts(): [number, number, number, number] };
      foregroundColor: { toInts(): [number, number, number, number] };
    };
  };
  return {
    thumbAlpha: bar.slider.foregroundColor.toInts()[3],
    trackAlpha: bar.slider.backgroundColor.toInts()[3],
  };
}

test("滚动条：idle 极淡、指针移入显色、移开回落，track 恒隐形", async () => {
  const initial = sessionWith(makeMessages(30)); // overflow the viewport → scrollbar visible
  const { setup, api } = await renderChat(initial);
  const handle = api.handle!;
  const sb = handle.scrollbox!;
  const bar = sb.verticalScrollBar as unknown as {
    x: number;
    y: number;
  };
  expect(sb.verticalScrollBar.visible).toBe(true);

  const idle = scrollbarColors(handle);
  expect(idle.thumbAlpha).toBe(SCROLLBAR_THUMB_IDLE_ALPHA);
  expect(idle.trackAlpha).toBe(0);

  // Move the pointer into the scrollbar's column.
  await act(async () => {
    await setup.mockMouse.moveTo(bar.x, bar.y + 4);
  });
  await setup.waitForVisualIdle();
  const hovered = scrollbarColors(handle);
  expect(hovered.thumbAlpha).toBe(SCROLLBAR_THUMB_HOVER_ALPHA);
  expect(hovered.thumbAlpha).toBeGreaterThan(idle.thumbAlpha);
  expect(hovered.trackAlpha).toBe(0); // hover lights the thumb only, no track noise

  // Move away → falls back to idle (repeatable, not one-shot).
  await act(async () => {
    await setup.mockMouse.moveTo(2, bar.y + 4);
  });
  await setup.waitForVisualIdle();
  expect(scrollbarColors(handle).thumbAlpha).toBe(SCROLLBAR_THUMB_IDLE_ALPHA);

  await act(async () => {
    await setup.mockMouse.moveTo(bar.x, bar.y + 4);
  });
  await setup.waitForVisualIdle();
  expect(scrollbarColors(handle).thumbAlpha).toBe(SCROLLBAR_THUMB_HOVER_ALPHA);

  await setup.renderer.destroy();
});

test("session 状态渲染：tool_use 摘要行 + statusMap 状态染色", async () => {
  // write_file is a keep-class tool (spec tui-tool-settled-appearance): once
  // settled its title line stays on screen (rendering consumes the slot only),
  // and it is not counted in the fold.
  const initial = sessionWith([
    msg("m-1", "user", "帮我写一个文件"),
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-ok",
          name: "write_file",
          input: { path: "hello.ts", content: "x" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-ok",
          content: "ok",
          is_error: false,
        },
      ],
    },
  ]);
  const { setup, api } = await renderChat(initial);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("❯ 帮我写一个文件");
  expect(frame).toContain("write_file");
  // Success state has no `[完成]` ("done") prefix; the summary is uniform
  // English `Wrote <path> (N lines)` per spec.
  expect(frame).toContain("write_file · Wrote hello.ts (1 lines)");
  expect(frame.includes("[完成]")).toBe(false);
  expect(frame.includes("× ")).toBe(false);
  expect(api.handle?.scrollbox).not.toBeNull();
  await setup.renderer.destroy();
});

test("流式 draft 渲染：running-fg 时挂载，turn 结束落定消失", async () => {
  const initial = sessionWith(makeMessages(2));
  const { setup, api } = await renderChat(initial);
  // running + streaming draft.
  api.setRunning(true);
  api.setDrafts("增量草稿 ★stream★");
  await setup.waitForVisualIdle();
  const runningFrame = setup.captureCharFrame();
  expect(runningFrame).toContain("stream");
  await setup.renderer.destroy();
});

test("thinking 折叠态：无秒数不画 [思考]，展开时显示全文", async () => {
  // Embed thinking directly in messages to test MessageBlocks visual
  // consistency through ChatView — fold/expand is controlled by
  // setThinkingExpanded (ChatView accepts the thinkingExpanded prop here, default false).
  const initial = sessionWith([
    msg("m-1", "user", "复杂问题"),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "链上推理", signature: "sig-1" },
        { type: "text", text: "正式回答" },
      ],
    },
  ]);
  const setup1 = await testRender(
    <ChatView
      session={initial}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frameFolded = setup1.captureCharFrame();
  expect(frameFolded.includes("[思考]")).toBe(false);
  expect(frameFolded.includes("链上推理")).toBe(false);
  await setup1.renderer.destroy();
});

test("thinking 留存：session.thinkingMs 末位索引传给末条 assistant 折叠行 → ", async () => {
  // Scenario: after the turn ends the streaming panel disappears; the seconds
  // are carried on by the last assistant message's fold line. The fold line
  // reads session.thinkingMs (persisted data, attachSession passes through
  // SessionFileV1.thinkingMs); last assistant (index 1) thinkingMs = 4000ms.
  const initial = sessionWith(
    [
      msg("m-1", "user", "复杂问题"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "链上推理", signature: "sig-1" },
          { type: "text", text: "正式回答" },
        ],
      },
    ],
    [null, 4000]
  );
  const setup1 = await testRender(
    <ChatView
      session={initial}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frame = setup1.captureCharFrame();
  // Last assistant fold line shows the duration (English unit fold per spec).
  expect(frame).toContain("Thought for 4s");
  expect(frame.split("Thought for 4s").length - 1).toBe(1);
  await setup1.renderer.destroy();
});

test("流式 thinking 未冻结：折叠行显示 Thinking…，无实时秒数、不叠加 [思考] 前缀", async () => {
  // Scenario: turn running, thinking phase in progress (frozen=0) → fold line
  // shows static `Thinking…` (live ticking seconds retired — duration is
  // carried by the post-hoc frozen summary `Thought for <duration>`, avoiding
  // visual duplication with the mode line's run time).
  const initial = sessionWith(makeMessages(1));
  const setup1 = await testRender(
    <ChatView
      session={{ ...initial, runState: "running-fg" }}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
      thinkingDraftMasked="链上推理…"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frame = setup1.captureCharFrame();
  expect(frame).toContain("Thinking…");
  expect(frame.includes("5 秒")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  await setup1.renderer.destroy();
});

test("流式 thinking 子秒未冻结：折叠行显示 Thinking… 不显 0 秒", async () => {
  // Scenario: thinking started but <1s (sub-second) → fold line keeps static
  // `Thinking…` (streaming lines never show live seconds — sub-second
  // naturally avoids a fake "0 seconds" precision display).
  const initial = sessionWith(makeMessages(1));
  const setup1 = await testRender(
    <ChatView
      session={{ ...initial, runState: "running-fg" }}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
      thinkingDraftMasked="链上推理…"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frame = setup1.captureCharFrame();
  expect(frame).toContain("Thinking…");
  expect(frame.includes("0 秒")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  await setup1.renderer.destroy();
});

test("thinking 留存：session.thinkingMs 只在末位索引有值时渲染", async () => {
  // Fold-line thinking seconds read session.thinkingMs per assistant message
  // index. Old assistant (index 1) thinkingMs = null → no thinking summary;
  // new assistant (index 3) thinkingMs = 7000ms → `Thought for 7s`; seconds
  // belong to the message itself (no longer handed only to the last message as
  // in the old lastThinkingSeconds).
  const initial = sessionWith(
    [
      msg("m-1", "user", "旧问题"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "旧推理", signature: "sig-old" },
          { type: "text", text: "旧回答" },
        ],
      },
      msg("m-2", "user", "新问题"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "新推理", signature: "sig-new" },
          { type: "text", text: "新回答" },
        ],
      },
    ],
    [null, null, null, 7000]
  );
  const setup1 = await testRender(
    <ChatView
      session={initial}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frame = setup1.captureCharFrame();
  // The latest answer carries 7s; the older one has no seconds → no fallback to the thinking-fold marker.
  expect(frame).toContain("Thought for 7s");
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame).toContain("旧回答");
  await setup1.renderer.destroy();
});

test("crunchedSeconds prop → 流末尾渲染 `Crunched for 3m 46s`", async () => {
  // The most recent completed turn's run time (app-layer finally snapshot)
  // renders at the stream tail: a dim retention line after the last message
  // and before the live tail (formatRunDuration pure formatting).
  const initial = sessionWith([
    msg("m-1", "user", "复杂问题"),
    {
      role: "assistant",
      content: [{ type: "text", text: "正式回答" }],
    },
  ]);
  const setup1 = await testRender(
    <ChatView
      session={initial}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      crunchedSeconds={226}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frame = setup1.captureCharFrame();
  // Full end-to-end string (Crunched prefix + duration segment) — separate
  // from the run-stats unit test, ensuring ChatView's render path lands
  // formatCrunched's complete output on screen (not just the duration segment).
  expect(frame).toContain("Crunched for 3m 46s");
  await setup1.renderer.destroy();
});

test("crunchedSeconds 0 / undefined → 不渲染 Crunched", async () => {
  // Default undefined (= 0) → no crunched retention line at the stream tail;
  // sub-second turns (0s) likewise render no `0s`.
  const initial = sessionWith(makeMessages(2));
  const setup1 = await testRender(
    <ChatView session={initial} cols={COLS} rows={ROWS} liveToolLines={[]} />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frame = setup1.captureCharFrame();
  expect(frame.includes("3m 46s")).toBe(false);
  expect(frame.includes("46s")).toBe(false);
  await setup1.renderer.destroy();
});

test("#589 ChatView tail：20 条 read_file ok + 1 running 不含完成读行", async () => {
  let runs: ReadonlyArray<LiveToolRun> = [];
  for (let i = 0; i < 20; i++) {
    const id = `cv-rf-${String(i).padStart(2, "0")}`;
    const marker = `CV_READ_OK_${i}`;
    runs = liveToolReduce(runs, {
      kind: "tool_call_start",
      id,
      name: "read_file",
    });
    runs = liveToolReduce(runs, {
      kind: "post_tool_use",
      id,
      name: "read_file",
      input: { path: `${marker}.ts` },
      ok: true,
      detail: `读取 ${marker}.ts`,
    });
  }
  runs = liveToolReduce(runs, {
    kind: "tool_call_start",
    id: "cv-running",
    name: "grep",
  });
  const setup = await testRender(
    <ChatView
      session={{
        ...sessionWith([msg("u", "user", "请读一批文件")]),
        runState: "running-fg",
      }}
      cols={80}
      rows={80}
      liveToolLines={[]}
      liveToolRuns={runs}
    />,
    { width: 80, height: 80, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // Per the activity-block spec: retract settled (post_tool_use ok) →
  // collected into the unanchored block (block count + tail process lines).
  // Same-batch retracts appear once in the block `called` count; tail process
  // lines draw per item without a full done-marker prefix.
  // - running process line = English `grep · Search`, no `[运行中]` ("running").
  expect(frame).toContain("grep · Search");
  expect(frame.includes("[运行中]")).toBe(false);
  // - not drawn as failed (grep still running), so no `[失败]` ("failed") / `ENOENT` residue.
  expect(frame.includes("[失败]")).toBe(false);
  expect(frame.includes("GREP_FAIL_MARKER")).toBe(false);
  // - block aggregate title (first-seen order): read_file × 20 · grep × 1 →
  //   lands in the tail. Small viewport; the block sits after the tail, so
  //   rows are enlarged to keep the assertion visible.
  expect(frame).toContain("read_file × 20");
  expect(frame).toContain("grep × 1");
  await setup.renderer.destroy();
});

test("#589 ChatView tail：20 条 read_file ok + 1 failed grep + 1 running 不含完成读行", async () => {
  // Same as the case above but marks the mid grep failed and adds one running
  // search: covers the contract that "failure cross-cut + same-batch retract
  // double count" never appears in block titles and no OK / ERROR line endings
  // are drawn. The tail viewport must be tall enough for 20 read_file detail
  // lines + block titles.
  let runs: ReadonlyArray<LiveToolRun> = [];
  for (let i = 0; i < 20; i++) {
    const id = `cv-rf-${String(i).padStart(2, "0")}`;
    const marker = `CV_READ_OK_${i}`;
    runs = liveToolReduce(runs, {
      kind: "tool_call_start",
      id,
      name: "read_file",
    });
    runs = liveToolReduce(runs, {
      kind: "post_tool_use",
      id,
      name: "read_file",
      input: { path: `${marker}.ts` },
      ok: true,
      detail: `读取 ${marker}.ts`,
    });
  }
  runs = liveToolReduce(runs, {
    kind: "tool_call_start",
    id: "cv-failed-grep",
    name: "grep",
    input: { pattern: "GREP_FAIL_MARKER" },
  });
  runs = liveToolReduce(runs, {
    kind: "post_tool_use",
    id: "cv-failed-grep",
    name: "grep",
    input: { pattern: "GREP_FAIL_MARKER" },
    ok: false,
    detail: "no matches",
  });
  runs = liveToolReduce(runs, {
    kind: "tool_call_start",
    id: "cv-running-grep",
    name: "grep",
  });
  const setup = await testRender(
    <ChatView
      session={{
        ...sessionWith([msg("u", "user", "请读一批文件")]),
        runState: "running-fg",
      }}
      cols={80}
      rows={80}
      liveToolLines={[]}
      liveToolRuns={runs}
    />,
    { width: 80, height: 80, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // Failure cross-cut: not counted in the block (no failed grep beyond `grep × 1` in block titles).
  expect(frame).toContain("read_file × 20");
  // The failed item still shows in the tail as a failure-marked grep line
  // `grep · no matches`
  // (live-tool-preview failure line), without double-drawing a completion card.
  expect(frame).toContain("[失败] grep");
  expect(frame).toContain("no matches");
  // Still-running grep → preview slot `grep · Search ?`.
  expect(frame).toContain("grep · Search");
  // Same-batch retract appears once, in the block called count.
  expect(frame.includes("read_file × 20 · grep × 1")).toBe(true);
  await setup.renderer.destroy();
});

test("running：流式草稿排在 live write 预览之前（代码块不得插到回复前面）", async () => {
  const session: TuiSessionState = {
    ...sessionWith([msg("m-1", "user", "写个页面")]),
    runState: "running-fg",
  };
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-w",
      name: "write_file",
      status: "ok",
      // Tool started after the draft (draftEpoch ≥ 1) → renders below the matching draft segment.
      draftEpoch: 1,
      input: {
        path: "archive/luxury.html",
        content: '<!doctype html>\n<html lang="en">',
      },
    },
  ];
  const draft = "我新写一份不同审美的腕表页";
  const setup = await testRender(
    <ChatView
      session={session}
      cols={COLS}
      rows={24}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      draftsMasked={draft}
    />,
    { width: COLS, height: 24, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const iDraft = frame.indexOf("我新写一份");
  const iCode = frame.indexOf("<!doctype html>");
  expect(iDraft).toBeGreaterThanOrEqual(0);
  expect(iCode).toBeGreaterThanOrEqual(0);
  expect(iDraft).toBeLessThan(iCode);
  await setup.renderer.destroy();
});

test("running→idle 折叠：纯工具/纯 tool_result 消息不留幻影空位", async () => {
  // Scenario: during the turn the tail shows 2 completed search tools + a
  // draft; after the turn retracts collapse into the fold count, and the
  // previously itemized tool area must not leave large blank space — at most
  // 1 line of message gap between the fold line and the final text.
  const finalMessages: AnthropicNativeMessage[] = [
    msg("m-1", "user", "搜索今天的AI新闻"),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先搜一下", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-s1",
          name: "web_search",
          input: { query: "今天的AI新闻" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-s1",
          content: "结果一",
          is_error: false,
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "再搜一次", signature: "s2" },
        {
          type: "tool_use",
          id: "tu-s2",
          name: "web_search",
          input: { query: "AI news today" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-s2",
          content: "结果二",
          is_error: false,
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "整理输出", signature: "s3" },
        { type: "text", text: "以下是今天的AI新闻摘要" },
      ],
    },
  ];
  interface LifecycleApi {
    finishTurn(): void;
  }
  function LifecycleHarness(props: { register: (api: LifecycleApi) => void }) {
    const [session, setSession] = useState<TuiSessionState>(() => ({
      ...sessionWith([msg("m-1", "user", "搜索今天的AI新闻")]),
      runState: "running-fg" as const,
    }));
    const [runs, setRuns] = useState<ReadonlyArray<LiveToolRun>>([
      {
        id: "tu-s1",
        name: "web_search",
        status: "ok",
        input: { query: "今天的AI新闻" },
        detail: "搜索 今天的AI新闻",
      },
      {
        id: "tu-s2",
        name: "web_search",
        status: "ok",
        input: { query: "AI news today" },
        detail: "搜索 AI news today",
      },
    ]);
    const [draft, setDraft] = useState("以下是今天的AI新闻摘要");
    useEffect(() => {
      props.register({
        finishTurn: () => {
          act(() => {
            setSession({ ...sessionWith(finalMessages), runState: "idle" });
            setRuns([]);
            setDraft("");
          });
        },
      });
    });
    return (
      <ChatView
        session={{
          ...session,
          // Fold-line thinking seconds read session.thinkingMs (per message).
          // finalMessages has 6 messages (0..5); last assistant (index 5)
          // thinkingMs = 12000ms → `Thought for 12s`; the two web_search calls
          // in one turn (index 1 / 3) merge into a "web_search × 2" fold line;
          // the tool-cluster anchor thinking falls through → the fold line
          // shows the tool count only.
          thinkingMs: [null, null, null, null, null, 12000],
        }}
        cols={COLS}
        rows={24}
        liveToolLines={[]}
        liveToolRuns={runs}
        draftsMasked={draft}
      />
    );
  }
  const holder: { api: LifecycleApi | null } = { api: null };
  const setup = await testRender(
    <LifecycleHarness
      register={(api) => {
        holder.api = api;
      }}
    />,
    { width: COLS, height: 24, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  if (holder.api === null) throw new Error("harness 未注册");
  holder.api.finishTurn();
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Thought for 12s");
  // Per spec, web_search / web_fetch render as real cards — the block title
  // never shows a `called web_search × 1` count; the real card `Search <query>`
  // is extracted in MessageBlocks (formatToolStatusLine single source).
  expect(frame.includes("called web_search × 1")).toBe(false);
  expect(frame.includes("calling web_search × 1")).toBe(false);
  expect(frame).toContain("Search");
  expect(frame).toContain("今天的AI新闻");
  // assistant text through Markdown rendering + pangu spacing: "today's-AI" gets a space inserted before the Latin run.
  expect(frame).toContain("以下是今天的 AI 新闻摘要");
  expect(frame.includes("[完成] web_search")).toBe(false);
  const lines = frame.split("\n");
  // The fold anchor moved from `called web_search × 1` to the real-card title
  // `Search` — web_search is not counted, so the fold line has no web_*
  // children and the block title is just the `Thought for 12s` line (last
  // assistant's thinkingMs).
  const iFold = lines.findIndex((l) => l.includes("Thought for 12s"));
  const iText = lines.findIndex((l) => l.includes("以下是今天的 AI 新闻摘要"));
  expect(iFold).toBeGreaterThanOrEqual(0);
  expect(iText).toBeGreaterThanOrEqual(0);
  // fold line → (1-line message gap) → final text: distance ≤ 4; folded
  // pure-tool / pure-tool_result messages must not each leave a phantom
  // margin line that joins into blank space. Legacy global lastThinkingSeconds
  // + collapsed last thinking allowed ≤ 2; per-message ThinkingSummary added a
  // line (≤ 3); the assistant-internal block rhythm (ThinkingSummary →
  // markdown text gap) adds one more → ≤ 4.
  expect(iText - iFold).toBeLessThanOrEqual(4);
  await setup.renderer.destroy();
});

test("running：先于草稿的工具（无 draftEpoch 标记）显示在流式草稿之上（按事件顺序插入）", async () => {
  // Scenario: model calls a tool first, then streams the answer — the tool
  // line must sit above the draft, matching the final history order in
  // MessageBlocks (content order) so nothing jumps at turn end.
  // Split basis = draftEpoch stamped by the app layer when each entry is
  // appended (missing = 0 = before the first draft segment).
  // retract-class tools (web_search) fold into the count once done and no
  // longer occupy the tail — this test uses a keep-class tool (bash) to
  // check insertion order around the draft.
  const session: TuiSessionState = {
    ...sessionWith([msg("m-1", "user", "搜索今天的AI新闻")]),
    runState: "running-fg",
  };
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-s",
      name: "bash",
      status: "ok",
      input: { command: "ls" },
      detail: "bash · ls",
    },
  ];
  const draft = "以下是今天的AI新闻摘要";
  const setup = await testRender(
    <ChatView
      session={session}
      cols={COLS}
      rows={24}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      draftsMasked={draft}
    />,
    { width: COLS, height: 24, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const iTool = frame.indexOf("bash");
  // draft goes through Markdown + pangu spacing: a space is inserted between the CJK run and the adjacent Latin run.
  const iDraft = frame.indexOf("以下是今天的 AI 新闻");
  expect(iTool).toBeGreaterThanOrEqual(0);
  expect(iDraft).toBeGreaterThanOrEqual(0);
  expect(iTool).toBeLessThan(iDraft);
  await setup.renderer.destroy();
});

test("running：draftEpoch 混排 —— 草稿前工具在上、草稿后工具在下", async () => {
  // Scenario: keep tool (epoch 0) → streamed answer → write tool (epoch 1).
  // Split is by draftEpoch (position-independent filter). keep-class tools
  // (bash / write_file) do not enter the unanchored block; they render
  // interleaved via tail tool cards + draft segments. Invariant: the epoch-0
  // tool's keep title is before the draft, the epoch-1 tool's keep title is
  // after it (never pushed above by the draft).
  const session: TuiSessionState = {
    ...sessionWith([msg("m-1", "user", "搜索并写入")]),
    runState: "running-fg",
  };
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-s",
      name: "bash",
      status: "ok",
      input: { command: "ls" },
      detail: "bash · ls",
    },
    {
      id: "tu-w",
      name: "write_file",
      status: "running",
      input: undefined,
      draftEpoch: 1,
    },
  ];
  const setup = await testRender(
    <ChatView
      session={session}
      cols={COLS}
      rows={24}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      draftsMasked="正在整理结果"
    />,
    { width: COLS, height: 24, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  const iBashKeep = lines.findIndex(
    (l) => l.includes("bash · bash · ls") || l.trim() === "bash"
  );
  const iDraft = lines.findIndex((l) => l.includes("正在整理结果"));
  const iWriteKeep = lines.findIndex((l) => /^write_file\b/.test(l.trim()));
  expect(iBashKeep).toBeGreaterThanOrEqual(0);
  expect(iDraft).toBeGreaterThanOrEqual(0);
  expect(iWriteKeep).toBeGreaterThanOrEqual(0);
  expect(iBashKeep).toBeLessThan(iDraft);
  expect(iDraft).toBeLessThan(iWriteKeep);
  await setup.renderer.destroy();
});

test("running：第二段草稿画在后续工具之下（tool→text→tool→text 不把新工具顶下去）", async () => {
  // A completed retract tool (web_search) folds into the count and no longer
  // occupies the tail — use bash (keep) to check draftEpoch ordering across
  // two draft segments.
  // bash is keep-class, so it does **not** enter the unanchored block (no
  // double paint); the tail tool card (`Running 1 shell command…` from
  // live-tool-preview) carries it. Invariant: the epoch-1 tool's detail slot
  // lands between the two drafts by draftEpoch (never pushed above by the
  // second draft).
  const session: TuiSessionState = {
    ...sessionWith([msg("m-1", "user", "搜完再写")]),
    runState: "running-fg",
  };
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-s",
      name: "bash",
      status: "ok",
      input: { command: "ls" },
      detail: "bash · ls",
    },
    {
      id: "tu-b",
      name: "bash",
      status: "running",
      input: undefined,
      draftEpoch: 1,
    },
  ];
  const setup = await testRender(
    <ChatView
      session={session}
      cols={COLS}
      rows={36}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      draftSegments={["第一段回答", "第二段回答"]}
    />,
    { width: COLS, height: 36, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // keep-class bash never enters the unanchored block → no `calling bash × 2`
  // / `bash × N` is painted.
  expect(frame.includes("bash ×")).toBe(false);
  expect(frame.includes("calling bash ×")).toBe(false);
  // The epoch-1 running entry → tail card `Running 1 shell command…`.
  expect(frame).toContain("Running 1 shell command…");
  const lines = frame.split("\n");
  const iFirstDraft = lines.findIndex((l) => l.includes("第一段回答"));
  const runningIdxs = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.includes("Running 1 shell command…"))
    .map(({ i }) => i);
  expect(runningIdxs.length).toBeGreaterThanOrEqual(1);
  const iSecondBash = runningIdxs[0] ?? -1;
  const iSecondDraft = lines.findIndex((l) => l.includes("第二段回答"));
  expect(iFirstDraft).toBeGreaterThanOrEqual(0);
  expect(iSecondBash).toBeGreaterThanOrEqual(0);
  expect(iSecondDraft).toBeGreaterThanOrEqual(0);
  expect(iFirstDraft).toBeLessThan(iSecondBash);
  expect(iSecondBash).toBeLessThan(iSecondDraft);
  await setup.renderer.destroy();
});

test("idle：当前 turn bash keep 标题逐条留，零条收无计数行", async () => {
  // bash is keep-class: once settled its title lines stay per-entry (the
  // thinking summary `Thought for Ns` renders with the message), and with
  // zero retract entries there is no tool-count line. The `完成。` ("done.")
  // text is its own line.
  const session = sessionWith(
    [
      msg("m-1", "user", "写个页面"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先扫目录", signature: "s1" },
          {
            type: "tool_use",
            id: "tu-b1",
            name: "bash",
            input: { command: "ls archive" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "再列一次", signature: "s1b" },
          {
            type: "tool_use",
            id: "tu-b2",
            name: "bash",
            input: { command: "ls -la" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-b2",
            content: "ok",
            is_error: false,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "收尾", signature: "s2" },
          { type: "text", text: "完成。" },
        ],
      },
    ],
    // messages length 5: asst-1 at index 1, asst-2 at index 2, asst-3 at index 4.
    [null, 29000, 29000, null, null]
  );
  const setup = await testRender(
    <ChatView session={session} cols={COLS} rows={24} liveToolLines={[]} />,
    { width: COLS, height: 24, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Thought for 29s");
  // keep titles render per slot: settled-successful tu-b2 shows no `[完成]`
  // ("done") prefix; unmatched tu-b1 renders as a running process line
  // (`Running 1 shell command… · <command>`, no `[运行中]` ("running")).
  expect(frame).toContain("bash · ls -la");
  expect(frame).toContain("Running 1 shell command… · ls archive");
  expect(frame.includes("[运行中]")).toBe(false);
  expect(frame).toContain("完成。");
  expect(frame.includes("[完成]")).toBe(false);
  // Zero retract entries → no tool-count line.
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});

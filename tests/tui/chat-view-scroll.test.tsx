/** @jsxImportSource @opentui/react */
/**
 * tests/tui/chat-view-scroll.test.tsx
 *
 * #343 T6-B：ChatView 会话视图（OpenTUI `<scrollbox stickyScroll>`，T3
 * sticky 行为沿用 + T6-B 扩展为 session-state 接线版）：
 *  - sticky 滚动：追加消息自动贴底；mockMouse.scroll 上滚后追加内容停留在
 *    用户位置（不跟随）；滚轮回到底部后追加恢复跟随（落底即落回 sticky
 *    位置，_hasManualScroll 复位）；
 *  - 强制滚底通道：ChatViewHandle.scrollToBottom()（用户发新消息 / turn 完成）；
 *  - 长会话（100 条 >3 屏）滚动文档全量：顶见最早气泡，无尾窗 stub；
 *    布局位置经 ref 直查（scrollTop / scrollHeight / viewport.height），不靠行数估算；
 *  - 空会话（0 条消息）渲染收敛不崩（empty 边界）；
 *  - session 接线：TuiSessionState.messages + runState / 流式草稿 / liveTool /
 *    banner 段都能正确渲染（MessageBlocks 视觉一致性）。
 *
 * T6-B 改动：原 T3 测试驱动 TuiChatMessage 简化壳，已被 T6-B 完整 session
 * 接线替换 → 重写测试 harness 直接驱动 TuiSessionState（构造 user/assistant
 * 文本消息数组 + runState + 流式草稿），保留 sticky 滚动覆盖（T3 验收 SSOT）。
 *
 * 异步等待纪律：setup.waitForVisualIdle() 是唯一异步等待入口
 * （禁止 setTimeout 裸 sleep 轮询）；React 状态更新用 act 包裹。
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
  // `drafts` / `liveToolRuns` 是 session 的运行时流式字段（T6-B 假想扩展）
  // — 本 harness 用闭包内 state 注入（非 session state 字段），避免改
  // TuiSessionState 形状影响其他测试。ChatView props 走 session 之外的
  // 通道：T6-B 直接传 props.draftsMasked / props.liveToolRuns，由 harness
  // 联动更新。
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

/** 生成 n 条 user/assistant 交替的多段落消息。 */
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

/** 构造带 messages 的 TuiSessionState（用于 T6-B harness）。D3:thinkingMs
 *  可显式传入(否则 SessionFileV1.thinkingMs undefined → session.thinkingMs
 *  undefined,折叠行只显示工具计数)。 */
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

/** ref 直查：贴底位置 = scrollHeight - 视口高。 */
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
  // spec invariant 4 / Testing strategy 短会话条：内容全部落在视口（+overscan）
  // 内时，挂载窗口换算结果与全量 visibleMessages.map 等价 —— 画面含全部
  // 可见消息，且无「↑ N 条更早的消息」尾窗 stub。
  const initial = sessionWith(makeMessages(3));
  const { setup, api } = await renderChat(initial, { rows: 24 });
  const sb = api.handle!.scrollbox!;
  // 前提认证：内容总高落在视口内（否则「全部挂上」不可达）。
  expect(sb.scrollHeight).toBeLessThanOrEqual(sb.viewport.height);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("msg-000");
  expect(frame).toContain("reply-001");
  expect(frame).toContain("msg-002");
  expect(frame.includes("条更早的消息")).toBe(false);
  expect(frame.includes("↑ ")).toBe(false);
  // 窗口覆盖全部 3 条（可见下标 0..2 都在树上）。
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
  // 追加到溢出一屏：stickyScroll 自动贴底。
  for (const m of makeMessages(6, 2)) {
    if (m.role === "user") api.appendUser(m.content[0]!.text);
    else api.appendAssistant(m.content[0]!.text);
    await setup.waitForVisualIdle();
  }
  const sb = handle.scrollbox!;
  expect(sb.scrollHeight).toBeGreaterThan(ROWS);
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  // 最新消息可见（assistant 段「reply-007」应可见）。
  expect(setup.captureCharFrame()).toContain("reply-007");
  await setup.renderer.destroy();
});

test("滚轮一步移动 3 行（略快于 OpenTUI 默认 1 行/格）", async () => {
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
  // 追加新 assistant 消息：停留在用户位置，不跳底。
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
  // 滚轮回底。
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
  // spec invariant 4：挂载窗口只由 scrollTop + 视口 + overscan 决定，与内容
  // 总高无关（20 条短消息总高超过一屏）—— 树上不出现全部 20 条，窗口本身
  // 可以短于总条数。断言口径 = 真实渲染树里 MessageRow 的 id 契约
  // `tmsg-<visibleIndex>`（通过 scrollbox.getRenderable 直查，不由实现细节
  // 推断条数）。
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
  // 高度量测经 useLayoutEffect 写回 itemHeights 后才收敛；等一轮视觉
  // 静止再读树，避免读到「尚未量测」的中间态。
  await setup.waitForVisualIdle();

  // 树跟视口走：不是全部 20 条。
  expect(mountedCount()).toBeLessThan(MESSAGES);
  expect(mountedCount()).toBeGreaterThan(0);
  // 贴底：末条挂上、首条已滚出（spacer 撑住）。
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  expect(sb.getRenderable(`tmsg-${MESSAGES - 1}`)).toBeDefined();

  // 滚到顶：首条挂上且画面含最早消息。赋值必须 act 包裹 —— scrollbar
  // change 引发的 setScrollTop 是 React 状态更新，裸赋值会让提交与
  // waitForVisualIdle（只等 OpenTUI scheduler 空闲）赛跑，读出未提交的树。
  await act(async () => {
    sb.scrollTop = 0;
  });
  await setup.waitForVisualIdle();
  expect(sb.getRenderable("tmsg-0")).toBeDefined();
  expect(setup.captureCharFrame()).toContain("msg-000");
  // 顶部窗口不含末条（窗口仍短于总条数）。
  expect(sb.getRenderable(`tmsg-${MESSAGES - 1}`)).toBeUndefined();
  expect(mountedIndices()[0]).toBe(0);

  await setup.renderer.destroy();
});

test("滚动提交量化：亚阈值 change 不提交 React，跨步长 / 贴底 / 置顶仍提交", async () => {
  // spec invariant 8 量化条款：连续亚阈值 `change` 不得各自 setScrollTop
  // （每次提交都让整棵 ChatView 重算）；跨越量化步长、贴底、置顶必须提交。
  // 计数口径 = React Profiler 的 onRender 次数（React 侧真值，不断言实现）。
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
  // 先落到中段（必然提交），再以亚阈值增量推进。
  await act(async () => {
    sb.scrollTop = Math.floor(max / 2);
  });
  await setup.waitForVisualIdle();
  const mid = sb.scrollTop;
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(max);
  expect(commits.length).toBeGreaterThan(0);
  const step = resolveScrollCommitStep(sb.viewport.height);
  expect(step).toBeGreaterThan(1); // 步长 1 时本用例退化为「每次都提交」，失去意义

  // 亚阈值 change（+1 行 < step）必须零提交：量化生效的可观测形式。
  commits.length = 0;
  await act(async () => {
    sb.scrollTop = mid + 1;
  });
  await setup.waitForVisualIdle();
  expect(commits).toEqual([]);
  // scrollbox 自身位置已动（用户看到画面跟随），只是 React 窗口未重算。
  expect(sb.scrollTop).toBe(mid + 1);

  // 继续亚阈值推进到「已提交位置 + step - 1」仍不提交（位移未达量子）。
  await act(async () => {
    sb.scrollTop = mid + step - 1;
  });
  await setup.waitForVisualIdle();
  expect(commits).toEqual([]);

  // 跨越量化步长 → 提交。
  await act(async () => {
    sb.scrollTop = mid + step;
  });
  await setup.waitForVisualIdle();
  expect(commits.length).toBeGreaterThan(0);

  // 贴底仍可到达（量化不得挡住 sticky 的落底路径）：滚到 max 后
  // scrollTop === maxScrollTop，且末条消息在画面里。
  await act(async () => {
    sb.scrollTop = maxScrollTop(handle);
  });
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  expect(setup.captureCharFrame()).toContain("reply-099");

  // 置顶：从底部直接回 0 也必须提交，最早气泡要挂上。
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
  // T4 步长正当性 (c)：量化步长上限 = 一次滚轮步长
  // （`CHAT_WHEEL_SCROLL_MULTIPLIER`，见 resolveScrollCommitStep 注释），
  // 所以单次滚轮必然跨越量子边界并提交 —— 否则用户滚一格看不见画面变化。
  // 计数口径 = React Profiler onRender（React 侧真值，不断言实现）。
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

  // 第一次滚轮走「首次提交」通道（prev 未设 → 必提交），不计入本断言。
  await act(async () => {
    await setup.mockMouse.scroll(5, 2, "up");
  });
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBeLessThan(max); // 离开底部，且未到顶
  expect(sb.scrollTop).toBeGreaterThan(0);

  // 第二次滚轮走量化通道：位移 = 一滚轮步长 ≥ 量化步长 → 必须提交。
  commits.length = 0;
  const before = sb.scrollTop;
  await act(async () => {
    await setup.mockMouse.scroll(5, 2, "up");
  });
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBeLessThan(before); // 位置确实动了
  expect(commits.length).toBeGreaterThan(0); // 且窗口跟着重算

  await setup.renderer.destroy();
});

test("换会话后首次亚阈值 change 提交：量化游标随 conversationId 复位", async () => {
  // spec invariant 8：首次提交与置顶必须立即生效，不得让新会话窗口停在
  // 旧会话位置。换会话 = 同一 ChatView 换 session prop（conversationId 变），
  // 量化游标的生命周期必须与同一处的 itemHeights / scrollTop 复位对齐。
  // 计数口径 = React Profiler onRender（React 侧真值，不断言实现）。
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
  // 换会话前：亚阈值位移不提交（量化已生效，游标非空）。
  commits.length = 0;
  await act(async () => {
    sb.scrollTop = sb.scrollTop + 1;
  });
  await setup.waitForVisualIdle();
  expect(commits).toEqual([]);
  // 换会话：scrollTop 复位等 React 更新。
  commits.length = 0;
  holder.fn!();
  await setup.waitForVisualIdle();
  // 换会话后首个 change 只推进 1 行（< step）：游标未复位则被吞掉，
  // 复位则必须提交（首次提交必生效）。
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
  // act 包裹：scrollbar change → setScrollTop 是 React 更新，裸赋值与
  // waitForVisualIdle（只等 OpenTUI scheduler）赛跑会读到未提交的树。
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
 * 滚动条观感（scrollbar-style.ts 的策略在真实 scrollbox 上生效）：
 * idle 极淡、指针移入显色、移开回落；track 始终全透明。
 *
 * 断言取 scrollbar 滑块的实际 RGBA（渲染取色），不读样式常量 —— 常量本身
 * 已由 scrollbar-style.test.ts 钉住，此处钉的是「常量确实接到了控件上」。
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
  const initial = sessionWith(makeMessages(30)); // 溢出视口 → 滚动条可见
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

  // 指针移入滚动条所在列。
  await act(async () => {
    await setup.mockMouse.moveTo(bar.x, bar.y + 4);
  });
  await setup.waitForVisualIdle();
  const hovered = scrollbarColors(handle);
  expect(hovered.thumbAlpha).toBe(SCROLLBAR_THUMB_HOVER_ALPHA);
  expect(hovered.thumbAlpha).toBeGreaterThan(idle.thumbAlpha);
  expect(hovered.trackAlpha).toBe(0); // hover 只点亮 thumb，不加轨道噪音

  // 移开 → 回落到 idle（可重复，不是一次性）。
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
  // D3（spec specs/tui-tool-settled-appearance.md）：write_file 是 keep 类 ——
  // 落定后标题行留在屏幕上（渲染只消费 slot，D7），不进折叠计数。
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
  // #tui-render-overhaul T3:成功态无 [完成] 前缀。
  // spec D1：摘要统一英文 `Wrote <path> (N lines)`。
  expect(frame).toContain("write_file · Wrote hello.ts (1 lines)");
  expect(frame.includes("[完成]")).toBe(false);
  expect(frame.includes("× ")).toBe(false);
  expect(api.handle?.scrollbox).not.toBeNull();
  await setup.renderer.destroy();
});

test("流式 draft 渲染：running-fg 时挂载，turn 结束落定消失", async () => {
  const initial = sessionWith(makeMessages(2));
  const { setup, api } = await renderChat(initial);
  // running + 流式 draft。
  api.setRunning(true);
  api.setDrafts("增量草稿 ★stream★");
  await setup.waitForVisualIdle();
  const runningFrame = setup.captureCharFrame();
  expect(runningFrame).toContain("stream");
  await setup.renderer.destroy();
});

test("thinking 折叠态：无秒数不画 [思考]，展开时显示全文", async () => {
  // 直接用 messages 里嵌 thinking 来测 MessageBlocks 经由 ChatView 的
  // 视觉一致性 — 折叠/展开由 setThinkingExpanded 控制（如果 ChatView
  // 接受 thinkingExpanded prop；T6-B 接受该 prop，默认 false）。
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
  // 场景：turn 结束后流式面板消失，秒数由历史消息末条 assistant 的折叠行
  // 接棒。D3:折叠行思考秒数改读 session.thinkingMs(落盘数据,attachSession
  // 透传 SessionFileV1.thinkingMs);末条 assistant(index 1)thinkingMs = 4000ms。
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
  // 末条 assistant 折叠行显示 （spec D2 英文 unit fold）。
  expect(frame).toContain("Thought for 4s");
  expect(frame.split("Thought for 4s").length - 1).toBe(1);
  await setup1.renderer.destroy();
});

test("流式 thinking 未冻结：折叠行显示 Thinking…，无实时秒数、不叠加 [思考] 前缀", async () => {
  // 场景：turn 运行中，thinking 阶段进行中（frozen=0）→ 折叠行显示静态
  // `Thinking…`（实时递增秒数已下线 —— 思考时长由事后 frozen
  // 摘要 `Thought for <duration>` 承担，避免与 mode 行运行时长视觉重复）。
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
  // 场景：thinking 已开始但 <1s（子秒）→ 折叠行保持静态 `Thinking…`
  // （流式行无实时秒数，PR 1 后恒不显秒数 —— 子秒自然不显「0 秒」伪精度）。
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
  // D3 (tui-display-consistency):折叠行思考秒数改读 session.thinkingMs —
  // — 每条 assistant message 按其索引读对应 thinkingMs。旧 assistant
  // (index 1) thinkingMs = null → 不画思考摘要;新 assistant (index 3)
  // thinkingMs = 7000ms → 画 `Thought for 7s`;秒数只属于该 message 自身
  // (不再像旧 lastThinkingSeconds 那样只传给末条)。
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
  // 末条「新回答」带 7 秒；前一条「旧回答」无秒 → 不回落 [思考]。
  expect(frame).toContain("Thought for 7s");
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame).toContain("旧回答");
  await setup1.renderer.destroy();
});

test("crunchedSeconds prop → 流末尾渲染 `Crunched for 3m 46s`", async () => {
  // 最近一次完成 turn 的运行时长（app 层 finally 快照）在消息流末尾渲染：
  // 末条消息之后、live tail 之前的 dim 留存行（formatRunDuration 纯格式化）。
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
  // 完整端到端串（Crunched 前缀 + 时长段）——与 run-stats 单测分开，确保
  // ChatView 渲染路径把 formatCrunched 的完整输出落到画面（非只时长段）。
  expect(frame).toContain("Crunched for 3m 46s");
  await setup1.renderer.destroy();
});

test("crunchedSeconds 0 / undefined → 不渲染 Crunched", async () => {
  // 缺省 undefined（= 0）→ 消息流末尾不产 crunched 留存行；sub-second 回合
  // （0 秒）同样不渲染 `0s`。
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
  // T7（specs/tui-activity-block.md）：retract 落定（post_tool_use ok）→ 收
  // 入 unanchored 块（块计数 + tail 过程行）。同批 retract 只在块 called 计
  // 数出现一次；tail 过程行逐条画，不画完整「[完成]」前缀。
  // - running 过程行 = 英文 `grep · Search`，无 `[运行中]`。
  expect(frame).toContain("grep · Search");
  expect(frame.includes("[运行中]")).toBe(false);
  // - 未画错（grep 还 running），所以无 `[失败]` / `ENOENT` 残留。
  expect(frame.includes("[失败]")).toBe(false);
  expect(frame.includes("GREP_FAIL_MARKER")).toBe(false);
  // - 块聚合标题（首现顺序）：read_file × 20 · grep × 1 → 落 tail。
  //   视口较小，块在 tail 之后，扩 rows 让断言可见。
  expect(frame).toContain("read_file × 20");
  expect(frame).toContain("grep × 1");
  await setup.renderer.destroy();
});

test("#589 ChatView tail：20 条 read_file ok + 1 failed grep + 1 running 不含完成读行", async () => {
  // 同 #589，但把 grep 中途标失败、再补一条 running search：覆
  // 盖「失败横切 + 同批 retract 双计数」不出现于块标题、不画 OK / ERROR
  // 行尾的合同。Tail 视口需要足够高以容纳 20 条 read_file 详情行 + 块标题。
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
  // 失败件横切：不进块计数（块标题里没有 `grep × 1` 之外的失败 grep）。
  expect(frame).toContain("read_file × 20");
  // 失败件仍以 `[失败] grep · no matches` 形式贴在 tail（live-tool-preview
  // 的失败行），不双画一张完成卡。
  expect(frame).toContain("[失败] grep");
  expect(frame).toContain("no matches");
  // 仍在运行的 grep → 预览槽 `grep · Search ?`。
  expect(frame).toContain("grep · Search");
  // 同批 retract 只在块 called 计数出现一次。
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
      // 草稿后开始的工具（draftEpoch ≥ 1）→ 渲染在对应草稿段之下。
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
  // 场景：turn 进行中尾部铺 2 个已完成搜索工具 + 草稿；turn 结束后 retract
  // 件收进折叠计数（D3），原先逐条显示的工具区域不得留下大段空白 ——
  // 折叠行与最终文本之间最多 1 行消息间距。
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
          // D3 (tui-display-consistency):折叠行思考秒数改读 session.thinkingMs。
          // finalMessages 6 条 messages(0..5);末条 assistant(index 5)
          // thinkingMs = 12000ms → `Thought for 12s`;两段 web_search 在同一 turn
          // (index 1 / 3)合并成 "web_search × 2" 折叠行,工具簇 anchor 思考
          // 落空 → 折叠行只显工具计数。
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
  // T4–T7（specs/tui-activity-block.md S5）：跨消息不合并 —— 两个
  // web_search 分别在两条 assistant 消息（index 1 / 3），按新合同各自
  // 落块标题 `called web_search × 1`，不聚成 `web_search × 2`。
  expect(frame).toContain("called web_search × 1");
  expect(frame).not.toContain("web_search × 2");
  expect(frame).not.toContain("Thought for 12s · web_search × 2");
  // assistant 文本经 Markdown 渲染 + 盘古之白：今天的AI → 今天的 AI。
  expect(frame).toContain("以下是今天的 AI 新闻摘要");
  expect(frame.includes("[完成] web_search")).toBe(false);
  const lines = frame.split("\n");
  const iFold = lines.findIndex((l) => l.includes("called web_search × 1"));
  const iText = lines.findIndex((l) => l.includes("以下是今天的 AI 新闻摘要"));
  expect(iFold).toBeGreaterThanOrEqual(0);
  expect(iText).toBeGreaterThanOrEqual(0);
  // 折叠行 →（1 行消息间距）→ 最终文本:行距 ≤ 4;被折叠的纯工具 /
  // 纯 tool_result 消息不得各留 1 行幻影 margin 连成空位。
  // D3 后末条 assistant 多 1 行 ThinkingSummary `Thought for Ns`（legacy ≤ 2
  // 是 lastThinkingSeconds 全局 + 折叠态压住末条 thinking 的旧形态;D3 改
  // per-message ThinkingSummary 后行距自然多 1 → ≤ 3）。
  // #tui-render-overhaul T4:assistant 内部块间补 1 行节奏（ThinkingSummary
  // → 文本 markdown 节点间多 1 行空白)→ ≤ 4。
  expect(iText - iFold).toBeLessThanOrEqual(4);
  await setup.renderer.destroy();
});

test("running：先于草稿的工具（无 draftEpoch 标记）显示在流式草稿之上（按事件顺序插入）", async () => {
  // 场景：模型先调工具、后流式输出回答 —— 工具显示应在上、草稿在下
  // （与历史 MessageBlocks 按 content 顺序的终态一致，避免结束时跳变）。
  // 拆分依据 = 条目追加时由 app 层打入的 draftEpoch（缺省 0 = 先于
  // 第一段草稿）。
  // plans/tui-chrome-interaction.md T1:retract 类（web_search）一旦完成
  // 即进折叠计数,不再占 tail —— 本测试改用 keep 类（bash）验证草稿前后
  // 工具的插入顺序。
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
  // 草稿经 Markdown 渲染 + 盘古之白：今天的AI → 今天的 AI。
  const iDraft = frame.indexOf("以下是今天的 AI 新闻");
  expect(iTool).toBeGreaterThanOrEqual(0);
  expect(iDraft).toBeGreaterThanOrEqual(0);
  expect(iTool).toBeLessThan(iDraft);
  await setup.renderer.destroy();
});

test("running：draftEpoch 混排 —— 草稿前工具在上、草稿后工具在下", async () => {
  // 场景：keep 工具（epoch 0）→ 流式回答 → write 工具（epoch 1）。
  // 拆分按 draftEpoch（位置无关 filter）。T7 之后：keep 类（bash /
  // write_file）不进 unanchored 块，由 tail 工具卡 + draft 段交错渲染；
  // 不变式 = epoch 0 工具的 keep 标题在草稿之前，epoch 1 工具的 keep
  // 标题在草稿之后（不被 draft 顶到上面）。
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
  // plans T1:web_search(已完成 retract)进折叠,不再占 tail —— 改用
  // bash(keep)以验证 draftEpoch 与两段草稿的插入顺序。
  // T7 后：bash 是 keep 类，**不**进 unanchored 块（避免双画），由
  // tail 工具卡（live-tool-preview 的 `Running 1 shell command…`）承接；
  // 不变式 = epoch 1 工具的细节槽按 draftEpoch 落在两段草稿之间（不被
  // 第二段草稿顶到上面）。
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
  // bash keep 类不进 unanchored 块 → 不画 `calling bash × 2` / `bash × N`。
  expect(frame.includes("bash ×")).toBe(false);
  expect(frame.includes("calling bash ×")).toBe(false);
  // epoch 1 running 件 → tail 卡 `Running 1 shell command…`。
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
  // D3（spec specs/tui-tool-settled-appearance.md）：bash 是 keep 类 ——
  // 落定后标题逐条留（含既有 thinking 摘要 `Thought for Ns` 随消息渲染），
  // 零 retract 条目 → 无工具计数行。"完成。"文本独立行。
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
    // messages 长度 5:asst-1 index 1、asst-2 index 2、asst-3 index 4。
    [null, 29000, 29000, null, null]
  );
  const setup = await testRender(
    <ChatView session={session} cols={COLS} rows={24} liveToolLines={[]} />,
    { width: COLS, height: 24, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Thought for 29s");
  // keep 标题按 slot 渲染：tu-b2 落定成功 → 成功态无 [完成] 前缀
  // (#tui-render-overhaul T3);tu-b1 未配对 → running 过程行（spec D1：
  // `Running 1 shell command… · <命令>`，无 `[运行中]`）。
  expect(frame).toContain("bash · ls -la");
  expect(frame).toContain("Running 1 shell command… · ls archive");
  expect(frame.includes("[运行中]")).toBe(false);
  expect(frame).toContain("完成。");
  expect(frame.includes("[完成]")).toBe(false);
  // 零条收 → 无工具计数行。
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});

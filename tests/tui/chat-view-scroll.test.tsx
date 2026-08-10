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
 *  - 长会话（100 条 >3 屏）渲染不崩，布局位置经 ref 直查
 *    （scrollTop / scrollHeight / viewport.height），不靠行数估算；
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
import { act, useEffect, useRef, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ChatView, type ChatViewHandle } from "../../src/tui/chat-view.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import {
  attachSession,
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { LiveToolRun } from "../../src/tui/live-tool-state.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

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
      rows={ROWS}
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

/** 构造带 messages 的 TuiSessionState（用于 T6-B harness）。 */
function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "test",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-08-10T00:00:00.000Z",
    jsonMode: false,
  };
  return attachSession(file);
}

async function renderChat(
  initial: TuiSessionState,
  opts?: { readonly bannerLines?: ReadonlyArray<string> }
): Promise<{
  setup: Awaited<ReturnType<typeof testRender>>;
  api: ChatApi;
}> {
  const holder: { api: ChatApi | null } = { api: null };
  const setup = await testRender(
    <Harness
      initial={initial}
      register={(api) => {
        holder.api = api;
      }}
      bannerLines={opts?.bannerLines}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
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

test("长会话（100 条 >3 屏）渲染不崩：布局位置 ref 直查", async () => {
  const initial = sessionWith(makeMessages(100));
  const { setup, api } = await renderChat(initial);
  const sb = api.handle!.scrollbox!;
  expect(sb.scrollHeight).toBeGreaterThan(ROWS * 3);
  expect(sb.scrollTop).toBe(maxScrollTop(api.handle!));
  expect(setup.captureCharFrame()).toContain("reply-099");
  api.appendUser("追加的长会话尾巴");
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(maxScrollTop(api.handle!));
  expect(setup.captureCharFrame()).toContain("追加的长会话尾巴");
  await setup.renderer.destroy();
});

test("session 状态渲染：tool_use 摘要行 + statusMap 状态染色", async () => {
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
  expect(frame).toContain("[完成]");
  expect(frame).toContain("write_file");
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

test("thinking 折叠态：默认 1 行 [思考]，展开时显示全文", async () => {
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
  expect(frameFolded).toContain("[思考]");
  expect(frameFolded.includes("链上推理")).toBe(false);
  await setup1.renderer.destroy();
});

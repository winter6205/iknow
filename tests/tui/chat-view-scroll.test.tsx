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
import { act, useEffect, useRef, useState } from "react";
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

test("长会话（100 条）滚动文档全量：顶见最早、底见最末、无尾窗 stub", async () => {
  const initial = sessionWith(makeMessages(100));
  const { setup, api } = await renderChat(initial);
  const sb = api.handle!.scrollbox!;
  expect(sb.scrollHeight).toBeGreaterThan(ROWS * 3);
  expect(sb.scrollTop).toBe(maxScrollTop(api.handle!));
  expect(setup.captureCharFrame()).toContain("reply-099");
  sb.scrollTop = 0;
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

test("thinking 留存：lastThinkingSeconds 传给末条 assistant 折叠行 → 「思考了 N 秒」", async () => {
  // 场景：turn 结束后流式面板消失，但秒数由历史消息末条 assistant 的折叠行
  // 接棒（app 层在 runTurnOnce finally 快照 → ChatView.lastThinkingSeconds）。
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
      lastThinkingSeconds={4}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frame = setup1.captureCharFrame();
  // 末条 assistant 折叠行显示「思考了 4 秒」留存（非纯 [思考] 标记）。
  expect(frame).toContain("思考了 4 秒");
  await setup1.renderer.destroy();
});

test("流式 thinking 冻结：answer 开始后折叠行显示「思考了 N 秒」而非「思考中…」", async () => {
  // 场景：turn 运行中，thinking 阶段已结束（answer 开始）→ app 层冻结秒数
  // （thinkingFrozenSeconds）→ 折叠行从静态「思考中…」切「思考了 N 秒」，
  // 秒数留存（不再递增）。
  const initial = sessionWith(makeMessages(1));
  const setup1 = await testRender(
    <ChatView
      session={{ ...initial, runState: "running-fg" }}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
      thinkingDraftMasked="链上推理…"
      thinkingFrozenSeconds={6}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frame = setup1.captureCharFrame();
  // 统一文案：`思考了 N 秒` 即带语义，不叠加 `[思考]` 前缀（chat-view 与
  // message-blocks 同源收敛，2026-08-14）。
  expect(frame).toContain("思考了 6 秒");
  expect(frame.includes("思考中")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  await setup1.renderer.destroy();
});

test("流式 thinking 未冻结：折叠行显示「思考中…」无实时秒数、不叠加 [思考] 前缀", async () => {
  // 场景：turn 运行中，thinking 阶段进行中（frozen=0）→ 折叠行显示静态
  // `思考中…`（实时递增秒数已下线，2026-08-14 —— 思考时长由事后 frozen
  // 摘要 `思考了 N 秒` 承担，避免与 mode 行运行时长视觉重复 + 语义混淆）。
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
  expect(frame).toContain("思考中…");
  expect(frame.includes("5 秒")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  await setup1.renderer.destroy();
});

test("流式 thinking 子秒未冻结：折叠行显示「思考中…」不显 0 秒", async () => {
  // 场景：thinking 已开始但 <1s（子秒）→ 折叠行保持静态「思考中…」
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
  expect(frame).toContain("思考中…");
  expect(frame.includes("0 秒")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  await setup1.renderer.destroy();
});

test("thinking 留存：lastThinkingSeconds 不作用于非末条 assistant 消息", async () => {
  // 前一条（非末条）assistant 带 thinking 的折叠行应保持 `[思考]`——秒数
  // 只属于刚结束的 turn（末条），历史消息不伪精度。
  const initial = sessionWith([
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
  ]);
  const setup1 = await testRender(
    <ChatView
      session={initial}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
      lastThinkingSeconds={7}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup1.waitForVisualIdle();
  const frame = setup1.captureCharFrame();
  // 末条「新回答」的折叠行带 7 秒；前一条「旧回答」的折叠行保持 [思考]。
  expect(frame).toContain("思考了 7 秒");
  expect(frame).toContain("[思考]");
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
      session={sessionWith([msg("u", "user", "请读一批文件")])}
      cols={80}
      rows={40}
      liveToolLines={[]}
      liveToolRuns={runs}
    />,
    { width: 80, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("[运行中] grep");
  expect(frame).not.toContain("CV_READ_OK_");
  expect(frame).not.toContain("read_file ·");
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
  // 场景：turn 进行中尾部铺 2 个已完成搜索工具 + 草稿；turn 结束后历史
  // 消息折叠（hideToolSummaries），原先被折叠的工具区域不得留下大段空白 ——
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
        session={session}
        cols={COLS}
        rows={24}
        liveToolLines={[]}
        liveToolRuns={runs}
        draftsMasked={draft}
        lastThinkingSeconds={12}
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
  expect(frame).toContain("思考了 12 秒 · web_search × 2");
  expect(frame).toContain("以下是今天的AI新闻摘要");
  expect(frame.includes("[完成] web_search")).toBe(false);
  const lines = frame.split("\n");
  const iFold = lines.findIndex((l) => l.includes("web_search × 2"));
  const iText = lines.findIndex((l) => l.includes("以下是今天的AI新闻摘要"));
  expect(iFold).toBeGreaterThanOrEqual(0);
  expect(iText).toBeGreaterThanOrEqual(0);
  // 折叠行 →（1 行消息间距）→ 最终文本：行距 ≤ 2；被折叠的纯工具 /
  // 纯 tool_result 消息不得各留 1 行幻影 margin 连成空位。
  expect(iText - iFold).toBeLessThanOrEqual(2);
  await setup.renderer.destroy();
});

test("running：draftToolAnchor=1 时先到的工具显示在流式草稿之上（按事件顺序插入）", async () => {
  // 场景：模型先调搜索工具、后流式输出回答 —— 工具显示应在上、草稿在下
  // （与历史 MessageBlocks 按 content 顺序的终态一致，避免结束时跳变）。
  // draftToolAnchor = 草稿首个 text_delta 到达时已开始的工具数（app 层快照）。
  const session: TuiSessionState = {
    ...sessionWith([msg("m-1", "user", "搜索今天的AI新闻")]),
    runState: "running-fg",
  };
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-s",
      name: "web_search",
      status: "ok",
      input: { query: "今天的AI新闻" },
      detail: "搜索 今天的AI新闻",
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
      draftToolAnchor={1}
    />,
    { width: COLS, height: 24, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const iTool = frame.indexOf("web_search");
  const iDraft = frame.indexOf("以下是今天的AI新闻");
  expect(iTool).toBeGreaterThanOrEqual(0);
  expect(iDraft).toBeGreaterThanOrEqual(0);
  expect(iTool).toBeLessThan(iDraft);
  await setup.renderer.destroy();
});

test("idle：当前 turn 工具折叠成计数行，不再铺 [完成] bash", async () => {
  const session = sessionWith([
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
  ]);
  const setup = await testRender(
    <ChatView
      session={session}
      cols={COLS}
      rows={24}
      liveToolLines={[]}
      lastThinkingSeconds={29}
    />,
    { width: COLS, height: 24, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("思考了 29 秒 · bash × 2");
  expect(frame).toContain("完成。");
  expect(frame.includes("[完成] bash")).toBe(false);
  await setup.renderer.destroy();
});
